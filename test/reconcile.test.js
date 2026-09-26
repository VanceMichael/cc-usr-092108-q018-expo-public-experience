import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExpoEngine } from '../src/engine.js';

const RAW = await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
const T = (hhmm) => `2026-09-26T${hhmm}:00+08:00`;

test('展商只按真实体验与成交对账，围观与排队不计入', () => {
  const engine = ExpoEngine.load(RAW);
  for (const id of ['v-1', 'v-2', 'v-3']) {
    engine.registerVisitor({ requestId: `rv-${id}`, visitorId: id, age: 30 });
  }
  // v-1 完成一次真实体验
  engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  engine.arrive({ requestId: 'ar-1', reservationId: 'rsv-1', at: T('09:55') });
  engine.completeExperience({ requestId: 'cp-1', reservationId: 'rsv-1', at: T('10:20') });
  // v-2 只排队未体验
  engine.scanSession({ requestId: 's-2', visitorId: 'v-2', sessionId: 'ses-glasses-1000', at: T('09:41') });
  // v-1 成交一笔，v-2 成交后退款，v-3 围观并下单未支付
  const t1 = engine.touch({ requestId: 't-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:00') });
  const o1 = engine.createOrder({ requestId: 'o-1', visitorId: 'v-1', lines: [{ touchId: t1.id, qty: 1 }], at: T('10:01') });
  engine.pay({ requestId: 'p-1', orderIds: [o1.id], at: T('10:02') });
  const t2 = engine.touch({ requestId: 't-2', visitorId: 'v-2', exhibitId: 'ex-glasses', at: T('10:03') });
  const o2 = engine.createOrder({ requestId: 'o-2', visitorId: 'v-2', lines: [{ touchId: t2.id, qty: 1 }], at: T('10:04') });
  engine.pay({ requestId: 'p-2', orderIds: [o2.id], at: T('10:05') });
  engine.refund({ requestId: 'rf-1', orderId: o2.id, at: T('10:06') });
  const t3 = engine.touch({ requestId: 't-3', visitorId: 'v-3', exhibitId: 'ex-glasses', at: T('10:07') });
  engine.createOrder({ requestId: 'o-3', visitorId: 'v-3', lines: [{ touchId: t3.id, qty: 1 }], at: T('10:08') });

  const statement = engine.statement('exh-glasses');
  assert.equal(statement.experiencesCompleted, 1);
  assert.deepEqual(statement.settledOrders, [{ orderId: o1.id, amountFen: 129900 }]);
  assert.deepEqual(statement.refundedOrders, [{ orderId: o2.id, amountFen: 129900 }]);
  assert.equal(statement.netFen, 0);
  assert.equal(statement.nonSettlement.touches, 3);
  assert.equal(statement.nonSettlement.activeReservations, 1);
});
