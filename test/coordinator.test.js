import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExpo } from '../src/expo.js';
import { Coordinator, CoordError } from '../src/coordinator.js';

const load = async () => parseExpo(await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8'));
const expectError = (code, fn) => assert.throws(fn, (e) => e instanceof CoordError && e.code === code);

test('展区资料：三展区与样机/现货/预售/模型区分清晰', async () => {
  const d = await load();
  assert.equal(d.zones.size, 3);
  assert.equal(d.exhibits.get('X-FS-MODEL').disposition, 'model');
  assert.equal(d.exhibits.get('X-MS-STATION').sellable, false);
  // 展位上的样机与可售批次分离：样机本身不存在于批次中
  for (const b of d.batches.values()) {
    assert.ok(['spot', 'presale'].includes(b.kind));
  }
  assert.ok(d.raw.aiCatalogTotal > 500);
});

test('扫码：每人只能持有一个有效时段；重复扫码幂等', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:05:00+08:00');
  const first = c.dispatch({ id: 'cmd-1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930' });
  assert.equal(first.status, 'reserved');
  // 同一命令重放（断网重复提交）返回首次结果，不产生第二个时段
  const replay = c.dispatch({ id: 'cmd-1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930' });
  assert.deepEqual(replay, first);
  // 再扫别的展位被拒绝
  expectError('ALREADY_HOLDS_SLOT', () =>
    c.dispatch({ id: 'cmd-2', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI3-0950' }));
});

test('排队：超容量候位，取消后 FIFO 公平递补', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:05:00+08:00');
  // S-FS-0930 容量 6：6 人确认，第 7 人候位
  for (let i = 1; i <= 6; i++) {
    const r = c.dispatch({ id: `r${i}`, type: 'reserve', visitorId: `V-100${i}`, sessionId: 'S-FS-0930' });
    assert.equal(r.status, 'reserved');
  }
  const seventh = c.dispatch({ id: 'r7', type: 'reserve', visitorId: 'V-1007', sessionId: 'S-FS-0930' });
  assert.equal(seventh.status, 'waitlisted');
  // 队首取消，候位者按顺序递补（不是后来者插队）
  const slot1 = c.slots.get('T-r1');
  c.dispatch({ id: 'c1', type: 'cancelSlot', slotId: slot1.id });
  assert.equal(c.slots.get('T-r7').status, 'reserved');
  // 取消后该观众可以再约别的场次
  const other = c.dispatch({ id: 'r1b', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930' });
  assert.equal(other.status, 'reserved');
});

test('授权：未成年人无监护授权、健康数据无授权，先核验', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:05:00+08:00');
  // V-1003 未成年人且无监护授权 -> 机器人体验拒绝
  expectError('GUARDIAN_CONSENT_REQUIRED', () =>
    c.dispatch({ id: 'm1', type: 'reserve', visitorId: 'V-1003', sessionId: 'S-AI1-1100' }));
  // V-1002 有监护授权 -> 通过
  assert.equal(
    c.dispatch({ id: 'm2', type: 'reserve', visitorId: 'V-1002', sessionId: 'S-AI1-1100' }).status,
    'reserved'
  );
  // V-1005 无健康授权 -> 健康手表拒绝；V-1004 已授权 -> 通过
  expectError('HEALTH_CONSENT_REQUIRED', () =>
    c.dispatch({ id: 'h1', type: 'reserve', visitorId: 'V-1005', sessionId: 'S-AI2-1000' }));
  assert.equal(
    c.dispatch({ id: 'h2', type: 'reserve', visitorId: 'V-1004', sessionId: 'S-AI2-1000' }).status,
    'reserved'
  );
});

test('设备停用与讲解改期：排队保留、恢复后 FIFO 顺延入场', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:05:00+08:00');
  c.dispatch({ id: 'q1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-TH-1000' });
  // 设备停用，已确认时段不能入场
  c.dispatch({ id: 'down', type: 'setDevice', sessionId: 'S-TH-1000', down: true, reason: '气象站传感器检修' });
  const slot = c.slots.get('T-q1');
  expectError('DEVICE_DOWN', () => c.dispatch({ id: 'a1', type: 'admit', slotId: slot.id }));
  // 讲解改期到 10:20，队列与顺序不变
  const p = c.dispatch({ id: 'pp', type: 'postponeSession', sessionId: 'S-TH-1000', resumeAt: '2026-09-26T10:20:00+08:00' });
  assert.equal(p.status, 'delayed');
  assert.equal(c.slots.get('T-q1').status, 'reserved');
  // 设备恢复后按原顺序入场，不丢号
  c.dispatch({ id: 'up', type: 'setDevice', sessionId: 'S-TH-1000', down: false });
  assert.equal(c.dispatch({ id: 'a2', type: 'admit', slotId: slot.id }).status, 'admitted');
});

test('订单：绑定观众接触的型号与价格版本；样机/仅展示品不能下单', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
  const o = c.dispatch({
    id: 'o1', type: 'createOrder', visitorId: 'V-1001',
    items: [{ batchId: 'BAT-L1-SPOT', quantity: 1 }],
  });
  assert.equal(o.total, 2999);
  const item = c.orders.get(o.orderId).items[0];
  assert.equal(item.modelCode, 'ZIBAN-L1-2026');
  assert.equal(item.priceVersion, 'PV-OPEN');
  assert.equal(item.kind, 'spot');
  // 样机/模型根本没有批次：伪造批次下单直接失败
  expectError('UNKNOWN_BATCH', () =>
    c.dispatch({ id: 'oX', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-FAKE-MODEL' }] }));
});

test('跨展位合并付款：一笔支付覆盖多展位，对账按展商拆分', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
  const o1 = c.dispatch({ id: 'o1', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-SPOT' }] }).orderId;
  const o2 = c.dispatch({ id: 'o2', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-GLASS-SPOT' }] }).orderId;
  const pay = c.dispatch({ id: 'pay1', type: 'pay', orderIds: [o1, o2] });
  assert.equal(pay.amount, 2999 + 2499);
  const rows = c.reconcile();
  const zhiban = rows.find((r) => r.exhibitorId === 'E-AI-01');
  const lingmou = rows.find((r) => r.exhibitorId === 'E-AI-03');
  assert.equal(zhiban.netReceivable, 2999);
  assert.equal(lingmou.netReceivable, 2499);
});

test('提货：默认点核验；跨区提货写错被拒，显式改写到真实点可提', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
  const orderId = c.dispatch({ id: 'o1', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-SPOT' }] }).orderId;
  c.dispatch({ id: 'p1', type: 'pay', orderIds: [orderId] });
  // 跑错提货点（未来空间服务处）
  expectError('WRONG_PICKUP_POINT', () =>
    c.dispatch({ id: 'pu-wrong', type: 'pickup', orderId, pickupPointId: 'P-FS' }));
  // 下单时显式跨区改写到成员国服务台，提货即按改写点核验
  const o2 = c.dispatch({
    id: 'o2', type: 'createOrder', visitorId: 'V-1001',
    items: [{ batchId: 'BAT-GLASS-SPOT', pickupPointId: 'P-MS' }],
  }).orderId;
  c.dispatch({ id: 'p2', type: 'pay', orderIds: [o2] });
  const picked = c.dispatch({ id: 'pu2', type: 'pickup', orderId: o2, pickupPointId: 'P-MS' });
  assert.equal(picked.status, 'picked_up');
  assert.equal(c.orders.get(o2).items[0].crossZone, true);
});

test('退款：未提货可退、库存退回；重复退款幂等；已提货不退', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
  const before = c.stock.get('BAT-L1-SPOT').remaining;
  const orderId = c.dispatch({ id: 'o1', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-SPOT' }] }).orderId;
  c.dispatch({ id: 'pay1', type: 'pay', orderIds: [orderId] });
  assert.equal(c.stock.get('BAT-L1-SPOT').remaining, before - 1);
  const r1 = c.dispatch({ id: 'rf1', type: 'refund', orderId });
  assert.equal(r1.status, 'refunded');
  assert.equal(c.stock.get('BAT-L1-SPOT').remaining, before);
  // 幂等：重复退款不重复回库存
  const r2 = c.dispatch({ id: 'rf1', type: 'refund', orderId });
  assert.deepEqual(r2, r1);
  assert.equal(c.stock.get('BAT-L1-SPOT').remaining, before);
  // 已提货订单不退
  const o2 = c.dispatch({ id: 'o2', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-GLASS-SPOT' }] }).orderId;
  c.dispatch({ id: 'pay2', type: 'pay', orderIds: [o2] });
  c.dispatch({ id: 'pu2', type: 'pickup', orderId: o2, pickupPointId: 'P-AI' });
  expectError('ALREADY_PICKED_UP', () => c.dispatch({ id: 'rf2', type: 'refund', orderId: o2 }));
});

test('断网核验：排队命令离线缓存，恢复后重放结果一致', () => {
  const d1 = parseExpoFixture();
  const d2 = parseExpoFixture();
  const commands = [
    { id: 'n1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930', at: '2026-09-26T09:05:00+08:00' },
    { id: 'n2', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-SPOT' }], at: '2026-09-26T09:06:00+08:00' },
    { id: 'n3', type: 'pay', orderIds: ['O-n2'], at: '2026-09-26T09:07:00+08:00' },
  ];
  // 网络两次抖动，同一批命令提交两遍
  const live = Coordinator.replay(d1, [...commands, ...commands]);
  const recovered = Coordinator.replay(d2, commands);
  assert.equal(live.orders.size, 1);
  assert.equal(recovered.orders.size, 1);
  assert.equal(live.stock.get('BAT-L1-SPOT').remaining, recovered.stock.get('BAT-L1-SPOT').remaining);
  assert.equal(live.reconcile()[0].netReceivable, recovered.reconcile()[0].netReceivable);
  assert.deepEqual(signature(live), signature(recovered));
});

test('清场：未支付释放、已付未提保留、未入场取消，结果可重放', () => {
  const d1 = parseExpoFixture();
  const d2 = parseExpoFixture();
  const build = (d) => {
    const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
    c.dispatch({ id: 's1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930' });
    c.dispatch({ id: 's2', type: 'reserve', visitorId: 'V-1002', sessionId: 'S-AI1-0930' });
    c.dispatch({ id: 'ad', type: 'admit', slotId: 'T-s1' });
    const paid = c.dispatch({ id: 'o1', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-SPOT' }] }).orderId;
    c.dispatch({ id: 'pay1', type: 'pay', orderIds: [paid] });
    c.dispatch({ id: 'o2', type: 'createOrder', visitorId: 'V-1002', items: [{ batchId: 'BAT-WATCH-SPOT' }] }); // 不付款
    return c;
  };
  const a = build(d1);
  const b = build(d2);
  const sa = a.dispatch({ id: 'clear', type: 'clearVenue', at: '2026-09-26T17:00:00+08:00' });
  const sb = b.dispatch({ id: 'clear', type: 'clearVenue', at: '2026-09-26T17:00:00+08:00' });
  assert.deepEqual(sa, sb);
  assert.equal(sa.ordersCancelled, 1);
  assert.equal(sa.stockReleased, 1);
  assert.equal(sa.awaitingPickup.length, 1);
  // 未付款的手表库存完整退回
  assert.equal(a.stock.get('BAT-WATCH-SPOT').remaining, 8);
});

test('场馆调度：容量/等待时间驱动限流，围观人数不冒充订单', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:05:00+08:00');
  for (let i = 1; i <= 6; i++) c.dispatch({ id: `fs${i}`, type: 'reserve', visitorId: `V-100${i}`, sessionId: 'S-FS-0930' });
  c.dispatch({ id: 'fs7', type: 'reserve', visitorId: 'V-1007', sessionId: 'S-FS-0930' }); // 候位
  c.dispatch({ id: 'look', type: 'reportOnlookers', boothId: 'B-FS-01', count: 200 }); // 200 人围观
  const view = c.venueView().find((v) => v.boothId === 'B-FS-01');
  assert.equal(view.confirmed, 6);
  assert.equal(view.waiting, 1);
  assert.ok(view.estimatedWaitMin > 0);
  assert.equal(view.onlookers, 200);
  // 围观 200 人不产生任何成交或体验
  const rows = c.reconcile();
  const fs = rows.find((r) => r.exhibitorId === 'E-FS-01');
  assert.equal(fs.soldAmount, 0);
  assert.equal(fs.experiences, 0);
});

test('展商对账：只认真实入场与真实成交', () => {
  const d = parseExpoFixture();
  const c = new Coordinator(d, '2026-09-26T09:10:00+08:00');
  c.dispatch({ id: 's1', type: 'reserve', visitorId: 'V-1001', sessionId: 'S-AI1-0930' });
  c.dispatch({ id: 'ad1', type: 'admit', slotId: 'T-s1' });
  c.dispatch({ id: 'fs1', type: 'finishSession', sessionId: 'S-AI1-0930' });
  const orderId = c.dispatch({ id: 'o1', type: 'createOrder', visitorId: 'V-1001', items: [{ batchId: 'BAT-L1-PRE', quantity: 2 }] }).orderId;
  c.dispatch({ id: 'pay1', type: 'pay', orderIds: [orderId] });
  c.dispatch({ id: 'rf1', type: 'refund', orderId });
  const r = c.reconcile().find((x) => x.exhibitorId === 'E-AI-01');
  assert.equal(r.experiences, 1); // 真实入场 1 人次
  assert.equal(r.soldAmount, 5998);
  assert.equal(r.refundedAmount, 5998);
  assert.equal(r.netReceivable, 0); // 已退款不形成应收
});

// 测试用轻量夹具（避免重复异步读盘）。
import { readFileSync } from 'node:fs';
function parseExpoFixture() {
  const raw = readFileSync(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
  return parseExpo(raw);
}
function signature(c) {
  return {
    slots: [...c.slots.values()].map((s) => [s.id, s.status]).sort(),
    orders: [...c.orders.values()].map((o) => [o.id, o.status, o.total]).sort(),
    stock: [...c.stock.entries()].map(([k, v]) => [k, v.remaining, v.held]).sort(),
  };
}
