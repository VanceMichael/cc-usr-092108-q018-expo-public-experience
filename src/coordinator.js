// 公众开放日体验与提货协调核心。
//
// 一致性策略：所有写操作都是带幂等键的命令（cmd.id）。断网期间前端排队的命令
// 在恢复后按原顺序重放：重复命令返回首次结果，绝不产生重复预约/扣款/占库存。
// Coordinator 可由命令日志完整重建（snapshot + replay 结果一致）。

import { priceOf } from './expo.js';

const t = (at) => (typeof at === 'string' ? Date.parse(at) : at);

export class CoordError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Coordinator {
  constructor(data, now = '2026-09-26T09:00:00+08:00') {
    this.data = data;
    this.clock = t(now);
    this.journal = [];
    this.applied = new Map(); // cmdId -> 结果（幂等重放）

    this.slots = new Map(); // slotId -> slot
    this.activeByVisitor = new Map(); // visitorId -> slotId（有效时段唯一）
    this.queues = new Map(); // sessionId -> [slotId]（预约先后，公平顺序）
    this.deviceDown = new Map(); // sessionId -> {since, reason}
    this.onlookers = new Map(); // boothId -> 人数（围观，仅调度用）

    this.orders = new Map();
    this.payments = new Map();
    this.stock = new Map(); // batchId -> {remaining, held}
    for (const b of data.batches.values()) {
      this.stock.set(b.id, { remaining: b.remaining, held: 0 });
    }
  }

  // ---------- 命令总线 ----------
  dispatch(cmd) {
    if (!cmd || typeof cmd.id !== 'string') throw new CoordError('BAD_COMMAND', '命令缺少幂等键');
    if (this.applied.has(cmd.id)) return this.applied.get(cmd.id);
    if (cmd.at !== undefined) this.clock = t(cmd.at);
    const result = this._handle(cmd);
    this.journal.push(cmd);
    this.applied.set(cmd.id, result);
    return result;
  }

  // 断网恢复：用同一批命令在新实例上重放，必须得到完全一致的状态。
  static replay(data, commands, now) {
    const c = new Coordinator(data, now);
    for (const cmd of commands) c.dispatch(cmd);
    return c;
  }

  _handle(cmd) {
    switch (cmd.type) {
      case 'reserve': return this._reserve(cmd);
      case 'cancelSlot': return this._cancelSlot(cmd);
      case 'admit': return this._admit(cmd);
      case 'finishSession': return this._finishSession(cmd);
      case 'postponeSession': return this._postponeSession(cmd);
      case 'setDevice': return this._setDevice(cmd);
      case 'reportOnlookers': return this._reportOnlookers(cmd);
      case 'createOrder': return this._createOrder(cmd);
      case 'pay': return this._pay(cmd);
      case 'refund': return this._refund(cmd);
      case 'pickup': return this._pickup(cmd);
      case 'clearVenue': return this._clearVenue(cmd);
      default: throw new CoordError('BAD_COMMAND', `未知命令：${cmd.type}`);
    }
  }

  // ---------- 授权核验 ----------
  _authorize(visitor, requirements) {
    for (const req of requirements ?? []) {
      if (req === 'minor-guardian' && visitor.minor && !visitor.consents?.guardian) {
        throw new CoordError('GUARDIAN_CONSENT_REQUIRED', '未成年人体验需监护人授权');
      }
      if (req === 'health-data' && !visitor.consents?.health) {
        throw new CoordError('HEALTH_CONSENT_REQUIRED', '采集健康数据的体验需先核验授权');
      }
    }
  }

  _visitor(id) {
    const v = this.data.visitors.get(id);
    if (!v) throw new CoordError('UNKNOWN_VISITOR', `观众不存在：${id}`);
    return v;
  }

  // ---------- 扫码预约：每人全局仅一个有效时段 ----------
  _reserve(cmd) {
    const visitor = this._visitor(cmd.visitorId);
    const session = this.data.sessions.get(cmd.sessionId);
    if (!session) throw new CoordError('UNKNOWN_SESSION', '讲解场次不存在');
    const exhibit = this.data.exhibits.get(session.exhibitId);
    this._authorize(visitor, exhibit.experience?.requirements);

    if (session.status === 'cancelled' || session.status === 'closed') {
      throw new CoordError('SESSION_UNAVAILABLE', '场次已取消或结束');
    }
    // 设备停用/顺延期间仍可扫码入队，恢复后按 FIFO 入场（公平顺延），只是暂不能入场。
    if (this.clock >= session._startMs) {
      throw new CoordError('SESSION_STARTED', '场次已开始，停止预约');
    }

    const currentId = this.activeByVisitor.get(visitor.id);
    if (currentId) {
      const current = this.slots.get(currentId);
      if (current.status === 'reserved' || current.status === 'admitted' || current.status === 'waitlisted') {
        throw new CoordError('ALREADY_HOLDS_SLOT', '每人只能持有一个有效时段，请先结束或取消当前时段');
      }
    }

    const queue = this.queues.get(session.id) ?? [];
    this.queues.set(session.id, queue);
    const slot = {
      id: `T-${cmd.id}`,
      visitorId: visitor.id,
      sessionId: session.id,
      boothId: session.boothId,
      seq: queue.length,
      status: 'reserved',
      createdAt: this.clock,
      admittedAt: null,
    };
    queue.push(slot.id);
    this.slots.set(slot.id, slot);
    this._confirmCapacity(session);
    // 候位同样占用"一个有效时段"，防止一个人同时在多个展位排队。
    this.activeByVisitor.set(visitor.id, slot.id);
    return { slotId: slot.id, status: slot.status, queuePosition: slot.seq + 1 };
  }

  _activeCount(session) {
    const q = this.queues.get(session.id) ?? [];
    return q.filter((id) => ['reserved', 'admitted'].includes(this.slots.get(id)?.status)).length;
  }

  // 按预约先后确认/递补：取消、改期都不改变 FIFO 顺序。
  _confirmCapacity(session) {
    const q = this.queues.get(session.id) ?? [];
    let active = 0;
    for (const id of q) {
      const s = this.slots.get(id);
      if (s.status === 'cancelled') continue;
      if (active < session.capacity) {
        if (s.status === 'waitlisted') s.status = 'reserved';
        active += 1;
      } else if (s.status === 'reserved') {
        s.status = 'waitlisted';
      }
    }
  }

  _cancelSlot(cmd) {
    const slot = this.slots.get(cmd.slotId);
    if (!slot) throw new CoordError('UNKNOWN_SLOT', '时段不存在');
    if (slot.status === 'cancelled') return { slotId: slot.id, status: 'cancelled' };
    if (slot.status === 'admitted') throw new CoordError('ALREADY_ADMITTED', '已入场时段需由场次结束释放');
    const session = this.data.sessions.get(slot.sessionId);
    slot.status = 'cancelled';
    if (this.activeByVisitor.get(slot.visitorId) === slot.id) this.activeByVisitor.delete(slot.visitorId);
    this._confirmCapacity(session);
    return { slotId: slot.id, status: 'cancelled' };
  }

  _admit(cmd) {
    const slot = this.slots.get(cmd.slotId);
    if (!slot) throw new CoordError('UNKNOWN_SLOT', '时段不存在');
    const session = this.data.sessions.get(slot.sessionId);
    const exhibit = this.data.exhibits.get(session.exhibitId);
    // 入场时再次核验（授权可能在排队期间被撤回）。
    this._authorize(this._visitor(slot.visitorId), exhibit.experience?.requirements);
    if (slot.status !== 'reserved') throw new CoordError('NOT_CONFIRMED', '时段未确认，不能入场');
    if (this.deviceDown.has(session.id)) throw new CoordError('DEVICE_DOWN', '设备停用，体验顺延');
    if (session.status === 'closed' || session.status === 'cancelled') {
      throw new CoordError('SESSION_UNAVAILABLE', '场次不可入场');
    }
    slot.status = 'admitted';
    slot.admittedAt = this.clock;
    return { slotId: slot.id, status: 'admitted', admittedAt: slot.admittedAt };
  }

  // 设备停用 / 讲解改期：按现场进度顺延，预约顺序不变。
  _setDevice(cmd) {
    const session = this.data.sessions.get(cmd.sessionId);
    if (!session) throw new CoordError('UNKNOWN_SESSION', '场次不存在');
    if (cmd.down) {
      this.deviceDown.set(session.id, { since: this.clock, reason: cmd.reason ?? '设备停用' });
      if (session.status === 'scheduled') session.status = 'delayed';
    } else {
      this.deviceDown.delete(session.id);
      if (session.status === 'delayed' && !cmd.keepDelayed) session.status = 'scheduled';
    }
    return { sessionId: session.id, deviceDown: cmd.down, status: session.status };
  }

  _postponeSession(cmd) {
    const session = this.data.sessions.get(cmd.sessionId);
    if (!session) throw new CoordError('UNKNOWN_SESSION', '场次不存在');
    const resumeAt = t(cmd.resumeAt);
    if (resumeAt < session._startMs) throw new CoordError('BAD_TIME', '顺延时间不能早于原时间');
    session._startMs = resumeAt;
    session.start = new Date(resumeAt).toISOString();
    session.status = 'delayed';
    if (cmd.deviceRecovered) this.deviceDown.delete(session.id);
    // FIFO 队列原样保留，仅重新确认容量；任何人不插队。
    this._confirmCapacity(session);
    return { sessionId: session.id, start: session.start, status: session.status, queue: (this.queues.get(session.id) ?? []).length };
  }

  _finishSession(cmd) {
    const session = this.data.sessions.get(cmd.sessionId);
    if (!session) throw new CoordError('UNKNOWN_SESSION', '场次不存在');
    session.status = 'closed';
    const q = this.queues.get(session.id) ?? [];
    for (const id of q) {
      const s = this.slots.get(id);
      if (s.status === 'cancelled') continue;
      if (s.status === 'admitted') {
        s.status = 'completed'; // 只有真实入场才算体验
      } else {
        s.status = 'cancelled'; // 已预约未入场，闭场时取消并释放
      }
      if (this.activeByVisitor.get(s.visitorId) === id) this.activeByVisitor.delete(s.visitorId);
    }
    return { sessionId: session.id, status: 'closed' };
  }

  _reportOnlookers(cmd) {
    if (!this.data.booths.has(cmd.boothId)) throw new CoordError('UNKNOWN_BOOTH', '展位不存在');
    this.onlookers.set(cmd.boothId, cmd.count); // 仅用于调度，绝不计入体验或订单
    return { boothId: cmd.boothId, onlookers: cmd.count };
  }

  // ---------- 订单：型号与价格版本快照绑定 ----------
  _snapshotItem(req) {
    const batch = this.data.batches.get(req.batchId);
    if (!batch) throw new CoordError('UNKNOWN_BATCH', '可售批次不存在');
    const exhibit = this.data.exhibits.get(batch.exhibitId);
    const booth = this.data.booths.get(exhibit.boothId);
    const pv = priceOf(exhibit, batch.priceVersion);
    const qty = req.quantity ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) throw new CoordError('BAD_QUANTITY', '数量非法');

    // 提货点：默认随批次；跨区改写必须显式指定且点真实存在（防止写错）。
    let pickupPointId = batch.pickupPointId;
    if (req.pickupPointId) {
      const point = this.data.pickupPoints.get(req.pickupPointId);
      if (!point) throw new CoordError('UNKNOWN_PICKUP_POINT', '提货点不存在');
      pickupPointId = point.id;
    }
    return {
      batchId: batch.id,
      exhibitId: exhibit.id,
      boothId: booth.id,
      exhibitorId: booth.exhibitorId,
      modelCode: exhibit.modelCode, // 观众接触的型号
      name: exhibit.name,
      kind: batch.kind, // spot 现货 / presale 预售
      priceVersion: pv.version,
      price: pv.price, // 成交价快照
      currency: pv.currency,
      quantity: qty,
      amount: pv.price * qty,
      pickupPointId,
      crossZone: this.data.pickupPoints.get(pickupPointId).zoneId !== booth.zoneId,
    };
  }

  _createOrder(cmd) {
    const visitor = this._visitor(cmd.visitorId);
    if (!Array.isArray(cmd.items) || cmd.items.length === 0) throw new CoordError('EMPTY_ORDER', '订单为空');
    const items = cmd.items.map((req) => this._snapshotItem(req));

    // 先校验库存再占用（批内原子：任一项不足则整单失败）。
    for (const it of items) {
      const stock = this.stock.get(it.batchId);
      if (stock.remaining - stock.held < it.quantity) {
        throw new CoordError('OUT_OF_STOCK', `批次库存不足：${it.batchId}`);
      }
    }
    for (const it of items) this.stock.get(it.batchId).held += it.quantity;

    const order = {
      id: `O-${cmd.id}`,
      visitorId: visitor.id,
      items,
      status: 'awaiting_payment',
      paymentId: null,
      createdAt: this.clock,
      total: items.reduce((s, it) => s + it.amount, 0),
    };
    this.orders.set(order.id, order);
    return { orderId: order.id, status: order.status, total: order.total, items };
  }

  // 跨展位合并付款：一笔支付可覆盖多个展位的订单，对账时按展商拆分。
  _pay(cmd) {
    const ids = cmd.orderIds ?? [];
    if (ids.length === 0) throw new CoordError('EMPTY_PAYMENT', '支付缺少订单');
    const orders = ids.map((oid) => {
      const order = this.orders.get(oid);
      if (!order) throw new CoordError('UNKNOWN_ORDER', `订单不存在：${oid}`);
      return order;
    });
    for (const o of orders) {
      if (o.status !== 'awaiting_payment') throw new CoordError('ORDER_NOT_PAYABLE', `订单状态不可支付：${o.id}`);
    }
    const amount = orders.reduce((s, o) => s + o.total, 0);
    const payment = {
      id: `P-${cmd.id}`,
      orderIds: orders.map((o) => o.id),
      amount,
      status: 'paid',
      paidAt: this.clock,
      refunded: 0,
    };
    for (const o of orders) {
      o.status = 'paid';
      o.paymentId = payment.id;
      for (const it of o.items) {
        const stock = this.stock.get(it.batchId);
        stock.remaining -= it.quantity; // 占用转实扣
        stock.held -= it.quantity;
      }
    }
    this.payments.set(payment.id, payment);
    return { paymentId: payment.id, amount, status: 'paid', orderIds: payment.orderIds };
  }

  // 退款：未提货可整笔或逐单退，库存退回，幂等。
  _refund(cmd) {
    let orders;
    let payment;
    if (cmd.paymentId) {
      payment = this.payments.get(cmd.paymentId);
      if (!payment) throw new CoordError('UNKNOWN_PAYMENT', '支付不存在');
      orders = payment.orderIds.map((id) => this.orders.get(id));
    } else {
      const order = this.orders.get(cmd.orderId);
      if (!order) throw new CoordError('UNKNOWN_ORDER', '订单不存在');
      if (!order.paymentId) throw new CoordError('NOT_PAID', '订单未支付');
      payment = this.payments.get(order.paymentId);
      orders = [order];
    }
    // 合并支付可能横跨多展位：已提货的不可线上退，未提货的可部分退。
    const refundable = orders.filter((o) => o.status !== 'refunded' && o.status !== 'picked_up');
    const skipped = orders.filter((o) => o.status === 'picked_up').map((o) => o.id);
    for (const o of refundable) {
      if (o.status !== 'paid') throw new CoordError('NOT_REFUNDABLE', `订单不可退：${o.status}`);
    }
    if (refundable.length === 0) throw new CoordError('ALREADY_PICKED_UP', '关联订单均已提货，不能线上退款');
    let refundAmount = 0;
    for (const o of refundable) {
      o.status = 'refunded';
      refundAmount += o.total;
      for (const it of o.items) {
        const stock = this.stock.get(it.batchId);
        stock.remaining += it.quantity; // 现货退回可再售
      }
    }
    payment.refunded += refundAmount;
    if (payment.refunded >= payment.amount) payment.status = 'refunded';
    else payment.status = 'partially_refunded';
    return { paymentId: payment.id, refunded: payment.refunded, status: payment.status, skipped };
  }

  _pickup(cmd) {
    const order = this.orders.get(cmd.orderId);
    if (!order) throw new CoordError('UNKNOWN_ORDER', '订单不存在');
    if (order.status !== 'paid') throw new CoordError('NOT_PAID', '订单未支付或已处理');
    // 逐件按订单绑定的提货点核验，跨区合并单到指定点统一提。
    for (const it of order.items) {
      if (it.pickupPointId !== cmd.pickupPointId) {
        throw new CoordError('WRONG_PICKUP_POINT', `商品须在 ${it.pickupPointId} 提货：${it.modelCode}`);
      }
    }
    order.status = 'picked_up';
    order.pickedUpAt = this.clock;
    return { orderId: order.id, status: 'picked_up', pickupPointId: cmd.pickupPointId };
  }

  // 闭馆清场：未支付单释放、未入场预约取消、已付未提保留待提。结果确定且可重放。
  _clearVenue(cmd) {
    const summary = { sessionsClosed: [], slotsCancelled: 0, ordersCancelled: 0, stockReleased: 0, awaitingPickup: [] };
    for (const session of [...this.data.sessions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (session.status !== 'closed') {
        session.status = 'closed';
        summary.sessionsClosed.push(session.id);
      }
      for (const id of this.queues.get(session.id) ?? []) {
        const s = this.slots.get(id);
        if (s.status !== 'cancelled' && s.status !== 'completed' && s.status !== 'admitted') {
          s.status = 'cancelled';
          summary.slotsCancelled += 1;
          if (this.activeByVisitor.get(s.visitorId) === id) this.activeByVisitor.delete(s.visitorId);
        } else if (s.status === 'admitted') {
          s.status = 'completed';
          if (this.activeByVisitor.get(s.visitorId) === id) this.activeByVisitor.delete(s.visitorId);
        }
      }
    }
    for (const order of [...this.orders.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (order.status === 'awaiting_payment') {
        for (const it of order.items) {
          this.stock.get(it.batchId).held -= it.quantity;
          summary.stockReleased += it.quantity;
        }
        order.status = 'cancelled';
        summary.ordersCancelled += 1;
      } else if (order.status === 'paid') {
        summary.awaitingPickup.push({ orderId: order.id, pickupPointId: order.items[0].pickupPointId });
      }
    }
    return summary;
  }

  // ---------- 场馆调度视图：容量与等待时间；围观单列、不冒充订单 ----------
  venueView() {
    const booths = [];
    for (const booth of this.data.booths.values()) {
      const sessions = [...this.data.sessions.values()].filter((s) => s.boothId === booth.id);
      let confirmed = 0;
      let waiting = 0;
      let waitMin = 0;
      for (const s of sessions) {
        const exhibit = this.data.exhibits.get(s.exhibitId);
        const perGroup = Math.max(1, exhibit.experience?.perGroup ?? 1);
        const dur = exhibit.experience?.durationMin ?? 0;
        let sessionWaiting = 0;
        for (const id of this.queues.get(s.id) ?? []) {
          const slot = this.slots.get(id);
          if (slot.status === 'reserved' || slot.status === 'admitted') confirmed += 1;
          if (slot.status === 'waitlisted') {
            waiting += 1;
            sessionWaiting += 1;
          }
        }
        waitMin = Math.max(waitMin, Math.ceil(sessionWaiting / perGroup) * dur);
      }
      booths.push({
        boothId: booth.id,
        name: booth.name,
        capacity: booth.capacity,
        confirmed,
        waiting,
        estimatedWaitMin: waitMin,
        deviceDown: sessions.some((s) => this.deviceDown.has(s.id)),
        onlookers: this.onlookers.get(booth.id) ?? 0,
        onlookersNote: '围观人数仅供限流调度，不计入体验或成交',
      });
    }
    return booths;
  }

  // ---------- 展商对账：只认真实体感与真实成交 ----------
  reconcile() {
    const rows = new Map();
    // 所有展商均出现在对账表：无体验无成交即为零，杜绝"查无此行"式隐瞒。
    for (const exhibitor of this.data.exhibitors.values()) {
      rows.set(exhibitor.id, {
        exhibitorId: exhibitor.id,
        experiences: 0,
        experiencedVisitors: new Set(),
        soldAmount: 0,
        refundedAmount: 0,
        pickedUpUnits: 0,
        netReceivable: 0,
      });
    }
    const row = (exhibitorId) => rows.get(exhibitorId);
    for (const slot of this.slots.values()) {
      if (slot.status === 'admitted' || (slot.status === 'completed' && slot.admittedAt)) {
        const session = this.data.sessions.get(slot.sessionId);
        const booth = this.data.booths.get(session.boothId);
        const r = row(booth.exhibitorId);
        r.experiences += 1;
        r.experiencedVisitors.add(slot.visitorId);
      }
    }
    for (const order of this.orders.values()) {
      if (order.status === 'awaiting_payment' || order.status === 'cancelled') continue;
      for (const it of order.items) {
        const r = row(it.exhibitorId);
        r.soldAmount += it.amount; // 成交毛额（含后退）
        if (order.status === 'refunded') {
          r.refundedAmount += it.amount;
        } else {
          r.netReceivable += it.amount;
          if (order.status === 'picked_up') r.pickedUpUnits += it.quantity;
        }
      }
    }
    return [...rows.values()].map((r) => ({
      ...r,
      experiencedVisitors: r.experiencedVisitors.size,
      netReceivable: r.soldAmount - r.refundedAmount,
    })).sort((a, b) => a.exhibitorId.localeCompare(b.exhibitorId));
  }
}
