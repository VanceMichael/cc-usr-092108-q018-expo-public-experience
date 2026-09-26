// 订单与提货：接触留痕、型号与价格版本绑定、批次扣减、合并付款、退款、分展区提货。
import { fail } from './errors.js';
import { requireVisitor } from './state.js';

// 接触留痕：记录观众在何时接触了哪个型号、当时生效的价格版本。
export function touch(state, { visitorId, exhibitId, at }) {
  requireVisitor(state, visitorId);
  const exhibit = state.catalog.exhibits.get(exhibitId);
  if (!exhibit) fail('exhibit-unknown', `展品 ${exhibitId} 不存在`);
  const pv = state.catalog.currentPriceVersion(exhibitId, at);
  const record = {
    id: `tch-${++state.counters.touch}`,
    visitorId,
    exhibitId,
    modelId: exhibit.modelId,
    priceVersionId: pv ? pv.id : null,
    at,
    consumed: false,
  };
  state.touches.set(record.id, record);
  return record;
}

// 下单：每条明细必须引用本人未消耗的接触记录，型号与价格版本以接触时为准。
export function createOrder(state, { visitorId, lines, at }) {
  requireVisitor(state, visitorId);
  if (!Array.isArray(lines) || !lines.length) fail('order-invalid', '订单缺少明细');
  const resolved = lines.map(({ touchId, qty }) => {
    const record = state.touches.get(touchId);
    if (!record) fail('touch-unknown', `接触记录 ${touchId} 不存在`);
    if (record.visitorId !== visitorId) fail('touch-mismatch', '订单必须绑定本人接触的型号与价格版本');
    if (record.consumed) fail('touch-consumed', `接触记录 ${touchId} 已用于其它订单`);
    if (!Number.isInteger(qty) || qty < 1) fail('order-invalid', '购买数量无效');
    const exhibit = state.catalog.exhibits.get(record.exhibitId);
    if (exhibit.saleType === 'display-only') {
      fail('not-for-sale', `${exhibit.name} 为仅展示品，模型与样机不出售`);
    }
    if (!record.priceVersionId) fail('price-unavailable', `${exhibit.name} 在接触时没有有效价格版本`);
    const batch = [...state.batches.values()].find((b) =>
      b.exhibitId === exhibit.id &&
      b.type === exhibit.saleType &&
      b.priceVersionId === record.priceVersionId &&
      b.quantity - b.allocated >= qty);
    if (!batch) fail('batch-unavailable', `${exhibit.name} 对应价格版本的可售批次不足`);
    const booth = state.catalog.booths.get(exhibit.boothId);
    const pv = state.catalog.priceVersions.get(record.priceVersionId);
    return {
      exhibitId: exhibit.id,
      modelId: record.modelId,
      priceVersionId: record.priceVersionId,
      saleType: exhibit.saleType,
      qty,
      unitAmountFen: pv.amountFen,
      batchId: batch.id,
      boothId: booth.id,
      zoneId: booth.zoneId,
      exhibitorId: booth.exhibitorId,
      pickupTaskId: null,
      _record: record,
      _batch: batch,
    };
  });
  for (const line of resolved) {
    line._batch.allocated += line.qty;
    line._record.consumed = true;
    delete line._record;
    delete line._batch;
  }
  const order = {
    id: `ord-${++state.counters.order}`,
    visitorId,
    lines: resolved,
    status: 'pending',
    totalFen: resolved.reduce((sum, l) => sum + l.unitAmountFen * l.qty, 0),
    createdAt: at,
  };
  state.orders.set(order.id, order);
  return order;
}

// 合并付款：可跨展位一次支付多笔订单，全部校验通过才生效。
export function pay(state, { orderIds, at }) {
  if (!Array.isArray(orderIds) || !orderIds.length) fail('payment-invalid', '付款缺少订单');
  const orders = orderIds.map((id) => {
    const order = state.orders.get(id);
    if (!order) fail('order-unknown', `订单 ${id} 不存在`);
    if (order.status !== 'pending') fail('order-not-pending', `订单 ${id} 不在待支付状态`);
    return order;
  });
  const payment = {
    id: `pay-${++state.counters.payment}`,
    orderIds: [...orderIds],
    totalFen: orders.reduce((sum, o) => sum + o.totalFen, 0),
    at,
  };
  for (const order of orders) {
    order.status = 'paid';
    order.paidAt = at;
    order.paymentId = payment.id;
  }
  state.payments.set(payment.id, payment);
  return payment;
}

// 退款：释放批次占用，已提货的订单不可退。
export function refund(state, { orderId, at }) {
  const order = state.orders.get(orderId);
  if (!order) fail('order-unknown', `订单 ${orderId} 不存在`);
  if (order.status !== 'paid') fail('order-not-paid', `订单 ${orderId} 不在可退款状态`);
  for (const line of order.lines) {
    const task = line.pickupTaskId ? state.pickupTasks.get(line.pickupTaskId) : null;
    if (task && task.status === 'done') fail('already-fulfilled', '已提货的订单不能退款');
  }
  for (const line of order.lines) {
    state.batches.get(line.batchId).allocated -= line.qty;
    const task = line.pickupTaskId ? state.pickupTasks.get(line.pickupTaskId) : null;
    if (task && task.status === 'pending') task.status = 'void';
  }
  order.status = 'refunded';
  order.refundedAt = at;
  return { orderId, refundedFen: order.totalFen };
}

// 安排提货：提货点必须与商品所在展区一致，跨区订单需分点各提各的。
export function assignPickup(state, { orderId, pickupPointId, at }) {
  const order = state.orders.get(orderId);
  if (!order) fail('order-unknown', `订单 ${orderId} 不存在`);
  if (order.status !== 'paid') fail('order-not-paid', '未支付订单不能安排提货');
  const point = state.catalog.pickupPoints.get(pickupPointId);
  if (!point) fail('pickup-unknown', `提货点 ${pickupPointId} 不存在`);
  const matched = order.lines.filter((l) => l.zoneId === point.zoneId && !l.pickupTaskId);
  if (!matched.length) fail('pickup-zone-mismatch', `提货点 ${pickupPointId} 与订单商品所在展区不一致`);
  const task = {
    id: `pkg-${++state.counters.pickup}`,
    orderId,
    pickupPointId,
    exhibitIds: matched.map((l) => l.exhibitId),
    status: 'pending',
    createdAt: at,
  };
  state.pickupTasks.set(task.id, task);
  for (const line of matched) line.pickupTaskId = task.id;
  return task;
}

export function completePickup(state, { taskId, at }) {
  const task = state.pickupTasks.get(taskId);
  if (!task) fail('pickup-unknown', `提货单 ${taskId} 不存在`);
  if (task.status !== 'pending') fail('pickup-not-pending', `提货单 ${taskId} 不在待提货状态`);
  task.status = 'done';
  task.doneAt = at;
  const order = state.orders.get(task.orderId);
  const fulfilled = order.lines.every((line) => {
    const t = line.pickupTaskId ? state.pickupTasks.get(line.pickupTaskId) : null;
    return t && t.status === 'done';
  });
  if (fulfilled) order.status = 'fulfilled';
  return task;
}
