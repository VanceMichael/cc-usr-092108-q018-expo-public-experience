import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExpoEngine } from '../src/engine.js';

const RAW = await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
const T = (hhmm) => `2026-09-26T${hhmm}:00+08:00`;

function engineWithVisitor(id = 'v-1', age = 30) {
  const engine = ExpoEngine.load(RAW);
  engine.registerVisitor({ requestId: `rv-${id}`, visitorId: id, age });
  return engine;
}

test('仅展示的模型与样机不能下单', () => {
  const engine = engineWithVisitor();
  const record = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-rocket-model', at: T('10:00') });
  assert.equal(record.priceVersionId, null);
  assert.throws(
    () => engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: record.id, qty: 1 }], at: T('10:01') }),
    { code: 'not-for-sale' },
  );
});

test('订单绑定接触时的型号与价格版本，调价不影响已接触订单', () => {
  const engine = engineWithVisitor();
  const early = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  assert.equal(early.priceVersionId, 'pv-glasses-1');
  const order = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: early.id, qty: 1 }], at: T('12:30') });
  const line = order.lines[0];
  assert.equal(line.modelId, 'glasses-pro-2026');
  assert.equal(line.priceVersionId, 'pv-glasses-1');
  assert.equal(line.unitAmountFen, 129900);
  assert.equal(line.batchId, 'batch-glasses-spot-1');

  const late = engine.touch({ requestId: 't-2', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('12:31') });
  assert.equal(late.priceVersionId, 'pv-glasses-2');
  const order2 = engine.createOrder({ requestId: 'o-2', visitorId: 'v-1', lines: [{ touchId: late.id, qty: 1 }], at: T('12:32') });
  assert.equal(order2.lines[0].priceVersionId, 'pv-glasses-2');
  assert.equal(order2.lines[0].unitAmountFen, 139900);
  assert.equal(order2.lines[0].batchId, 'batch-glasses-spot-2');
});

test('他人的接触记录不能用于下单，同一记录不能重复下单', () => {
  const engine = engineWithVisitor();
  engine.registerVisitor({ requestId: 'rv-2', visitorId: 'v-2', age: 25 });
  const record = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  assert.throws(
    () => engine.createOrder({ requestId: 'o-1', visitorId: 'v-2', lines: [{ touchId: record.id, qty: 1 }], at: T('10:01') }),
    { code: 'touch-mismatch' },
  );
  engine.createOrder({ requestId: 'o-2', visitorId: 'v-1', lines: [{ touchId: record.id, qty: 1 }], at: T('10:02') });
  assert.throws(
    () => engine.createOrder({ requestId: 'o-3', visitorId: 'v-1', lines: [{ touchId: record.id, qty: 1 }], at: T('10:03') }),
    { code: 'touch-consumed' },
  );
});

test('现货批次按价格版本扣减，售罄后拒绝下单', () => {
  const engine = engineWithVisitor();
  engine.registerVisitor({ requestId: 'rv-2', visitorId: 'v-2', age: 25 });
  const t1 = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: t1.id, qty: 2 }], at: T('10:01') });
  assert.equal(engine.getBatch('batch-glasses-spot-1').allocated, 2);
  const t2 = engine.touch({ requestId: 't-2', visitorId: 'v-2', exhibitId: 'ex-glasses', at: T('10:02') });
  assert.throws(
    () => engine.createOrder({ requestId: 'o-2', visitorId: 'v-2', lines: [{ touchId: t2.id, qty: 1 }], at: T('10:03') }),
    { code: 'batch-unavailable' },
  );
});

test('跨展位合并付款一次生效，各展商分别对账', () => {
  const engine = engineWithVisitor();
  const tg = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  const tm = engine.touch({ requestId: 't-2', visitorId: 'v-1', exhibitId: 'ex-meteo', at: T('10:05') });
  const o1 = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: tg.id, qty: 1 }], at: T('10:06') });
  const o2 = engine.createOrder({ requestId: 'o-2', visitorId: 'v-1', lines: [{ touchId: tm.id, qty: 1 }], at: T('10:07') });
  const payment = engine.pay({ requestId: 'p-1', orderIds: [o1.id, o2.id], at: T('10:08') });
  assert.equal(payment.totalFen, 129900 + 459900);
  assert.equal(engine.getOrder(o1.id).status, 'paid');
  assert.equal(engine.getOrder(o2.id).status, 'paid');
  assert.equal(engine.statement('exh-glasses').netFen, 129900);
  assert.equal(engine.statement('exh-meteo').netFen, 459900);

  assert.throws(
    () => engine.pay({ requestId: 'p-2', orderIds: [o1.id, o2.id], at: T('10:09') }),
    { code: 'order-not-pending' },
  );
});

test('退款释放批次且幂等，重复退款返回同一结果', () => {
  const engine = engineWithVisitor();
  const record = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  const order = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: record.id, qty: 1 }], at: T('10:01') });
  engine.pay({ requestId: 'p-1', orderIds: [order.id], at: T('10:02') });
  assert.equal(engine.getBatch('batch-glasses-spot-1').allocated, 1);

  const first = engine.refund({ requestId: 'rf-1', orderId: order.id, at: T('10:03') });
  assert.deepEqual(first, { orderId: order.id, refundedFen: 129900 });
  assert.equal(engine.getOrder(order.id).status, 'refunded');
  assert.equal(engine.getBatch('batch-glasses-spot-1').allocated, 0);

  const again = engine.refund({ requestId: 'rf-1', orderId: order.id, at: T('10:03') });
  assert.deepEqual(again, first);
  assert.equal(engine.getBatch('batch-glasses-spot-1').allocated, 0);
  assert.throws(
    () => engine.refund({ requestId: 'rf-2', orderId: order.id, at: T('10:04') }),
    { code: 'order-not-paid' },
  );
});

test('跨区提货写错被拒绝，正确提货点完成履约', () => {
  const engine = engineWithVisitor();
  const record = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  const order = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: record.id, qty: 1 }], at: T('10:01') });
  engine.pay({ requestId: 'p-1', orderIds: [order.id], at: T('10:02') });
  assert.throws(
    () => engine.assignPickup({ requestId: 'pk-1', orderId: order.id, pickupPointId: 'pk-member', at: T('10:03') }),
    { code: 'pickup-zone-mismatch' },
  );
  const task = engine.assignPickup({ requestId: 'pk-2', orderId: order.id, pickupPointId: 'pk-ai', at: T('10:04') });
  assert.equal(task.status, 'pending');
  engine.completePickup({ requestId: 'pk-3', taskId: task.id, at: T('10:05') });
  assert.equal(engine.getOrder(order.id).status, 'fulfilled');
});

test('跨区订单分点提货，已提货部分不可退款', () => {
  const engine = engineWithVisitor();
  const tg = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  const tm = engine.touch({ requestId: 't-2', visitorId: 'v-1', exhibitId: 'ex-meteo', at: T('10:01') });
  const order = engine.createOrder({
    requestId: 'o-1',
    visitorId: 'v-1',
    lines: [{ touchId: tg.id, qty: 1 }, { touchId: tm.id, qty: 1 }],
    at: T('10:02'),
  });
  engine.pay({ requestId: 'p-1', orderIds: [order.id], at: T('10:03') });
  const taskAi = engine.assignPickup({ requestId: 'pk-1', orderId: order.id, pickupPointId: 'pk-ai', at: T('10:04') });
  assert.deepEqual(taskAi.exhibitIds, ['ex-glasses']);
  engine.completePickup({ requestId: 'pk-2', taskId: taskAi.id, at: T('10:05') });
  assert.equal(engine.getOrder(order.id).status, 'paid');
  assert.throws(
    () => engine.refund({ requestId: 'rf-1', orderId: order.id, at: T('10:06') }),
    { code: 'already-fulfilled' },
  );
  const taskMember = engine.assignPickup({ requestId: 'pk-3', orderId: order.id, pickupPointId: 'pk-member', at: T('10:07') });
  engine.completePickup({ requestId: 'pk-4', taskId: taskMember.id, at: T('10:08') });
  assert.equal(engine.getOrder(order.id).status, 'fulfilled');
});

test('闭馆清场：未核销时段过期、未支付订单取消，已支付与待提货保留', () => {
  const engine = engineWithVisitor();
  engine.registerVisitor({ requestId: 'rv-2', visitorId: 'v-2', age: 25 });
  engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('16:00') });
  const t1 = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('16:01') });
  const pending = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: t1.id, qty: 1 }], at: T('16:02') });
  const t2 = engine.touch({ requestId: 't-2', visitorId: 'v-2', exhibitId: 'ex-watch', at: T('16:03') });
  const paid = engine.createOrder({ requestId: 'o-2', visitorId: 'v-2', lines: [{ touchId: t2.id, qty: 1 }], at: T('16:04') });
  engine.pay({ requestId: 'p-1', orderIds: [paid.id], at: T('16:05') });
  const task = engine.assignPickup({ requestId: 'pk-1', orderId: paid.id, pickupPointId: 'pk-ai', at: T('16:06') });

  const result = engine.clearVenue({ requestId: 'cv-1', at: T('18:00') });
  assert.deepEqual(result, { at: T('18:00'), expiredReservations: 1, cancelledOrders: 1, finishedSessions: 5 });
  assert.equal(engine.getReservation('rsv-1').status, 'expired');
  assert.equal(engine.getReservation('rsv-1').releaseReason, 'clearing');
  assert.equal(engine.getOrder(pending.id).status, 'cancelled');
  assert.equal(engine.getBatch('batch-glasses-spot-1').allocated, 0);
  assert.equal(engine.getOrder(paid.id).status, 'paid');
  assert.equal(engine.getPickupTask(task.id).status, 'pending');
  assert.equal(engine.dispatch().zones.every((z) => z.occupancy === 0), true);
});
