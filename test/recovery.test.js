import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExpoEngine } from '../src/engine.js';

const RAW = await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
const T = (hhmm) => `2026-09-26T${hhmm}:00+08:00`;

function scenario() {
  const engine = ExpoEngine.load(RAW);
  engine.registerVisitor({ requestId: 'rv-1', visitorId: 'v-1', age: 30 });
  engine.registerVisitor({ requestId: 'rv-2', visitorId: 'v-2', age: 12 });
  engine.grantAuthorization({ requestId: 'au-1', visitorId: 'v-2', type: 'guardian-consent', at: T('09:00') });
  engine.scanSession({ requestId: 'sc-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  engine.scanSession({ requestId: 'sc-2', visitorId: 'v-2', sessionId: 'ses-rocket-talk', at: T('09:41') });
  engine.arrive({ requestId: 'ar-1', reservationId: 'rsv-1', at: T('09:55') });
  engine.completeExperience({ requestId: 'cp-1', reservationId: 'rsv-1', at: T('10:20') });
  engine.postponeSession({ requestId: 'pp-1', sessionId: 'ses-rocket-talk', delayMin: 60, at: T('10:25') });
  engine.touch({ requestId: 'tc-1', visitorId: 'v-1', exhibitId: 'ex-glasses', at: T('10:30') });
  engine.createOrder({ requestId: 'or-1', visitorId: 'v-1', lines: [{ touchId: 'tch-1', qty: 1 }], at: T('10:31') });
  engine.pay({ requestId: 'pa-1', orderIds: ['ord-1'], at: T('10:32') });
  engine.assignPickup({ requestId: 'pk-1', orderId: 'ord-1', pickupPointId: 'pk-ai', at: T('10:33') });
  engine.enterZone({ requestId: 'ez-1', visitorId: 'v-1', zoneId: 'zone-ai', at: T('10:34') });
  return engine;
}

test('事件日志重放后现场状态一致', () => {
  const online = scenario();
  const recovered = ExpoEngine.recover(RAW, online.exportEvents());
  assert.deepEqual(recovered.getOrder('ord-1'), online.getOrder('ord-1'));
  assert.deepEqual(recovered.getReservation('rsv-1'), online.getReservation('rsv-1'));
  assert.deepEqual(recovered.getReservation('rsv-3'), online.getReservation('rsv-3'));
  assert.deepEqual(recovered.getBatch('batch-glasses-spot-1'), online.getBatch('batch-glasses-spot-1'));
  assert.deepEqual(recovered.getPickupTask('pkg-1'), online.getPickupTask('pkg-1'));
  assert.deepEqual(recovered.statement('exh-glasses'), online.statement('exh-glasses'));
  assert.deepEqual(recovered.dispatch(), online.dispatch());
});

test('日志中的重复事件只生效一次', () => {
  const online = scenario();
  const events = online.exportEvents();
  const duplicated = [...events, events.find((e) => e.type === 'scanSession'), events.find((e) => e.type === 'pay')];
  const recovered = ExpoEngine.recover(RAW, duplicated);
  assert.deepEqual(recovered.getOrder('ord-1'), online.getOrder('ord-1'));
  assert.deepEqual(recovered.getReservation('rsv-1'), online.getReservation('rsv-1'));
  assert.deepEqual(recovered.statement('exh-glasses'), online.statement('exh-glasses'));
});

test('断网设备积压事件同步后与在线结果一致', () => {
  const online = scenario();
  const events = online.exportEvents();
  const offline = ExpoEngine.load(RAW);
  const outcomes = offline.syncOffline(events.map((e, i) => ({ deviceId: 'handheld-1', localSeq: i, type: e.type, payload: e.payload })));
  assert.equal(outcomes.every((o) => o.status === 'applied'), true);
  assert.deepEqual(offline.getOrder('ord-1'), online.getOrder('ord-1'));
  assert.deepEqual(offline.getReservation('rsv-3'), online.getReservation('rsv-3'));
  assert.deepEqual(offline.statement('exh-glasses'), online.statement('exh-glasses'));
  assert.deepEqual(offline.dispatch(), online.dispatch());
});
