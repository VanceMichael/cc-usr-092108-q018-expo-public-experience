import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExpoEngine } from '../src/engine.js';

const RAW = await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
const T = (hhmm) => `2026-09-26T${hhmm}:00+08:00`;
const makeEngine = () => ExpoEngine.load(RAW);
const adult = (engine, id, req) => engine.registerVisitor({ requestId: req, visitorId: id, age: 30 });

test('每位观众同一时刻只持有一个有效时段', () => {
  const engine = makeEngine();
  adult(engine, 'v-1', 'rv-1');
  const first = engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  const second = engine.scanSession({ requestId: 's-2', visitorId: 'v-1', sessionId: 'ses-rocket-talk', at: T('09:50') });
  assert.equal(engine.getReservation(first.id).status, 'released');
  assert.equal(engine.getReservation(first.id).releaseReason, 'superseded');
  assert.equal(engine.activeReservationOf('v-1').id, second.id);
});

test('重复扫码返回同一结果，同一场次不重复占位', () => {
  const engine = makeEngine();
  adult(engine, 'v-1', 'rv-1');
  const first = engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  const again = engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  assert.deepEqual(again, first);
  const sameSession = engine.scanSession({ requestId: 's-2', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:41') });
  assert.equal(sameSession.id, first.id);
  const zone = engine.dispatch().zones.find((z) => z.zoneId === 'zone-ai');
  assert.equal(zone.sessions.find((s) => s.sessionId === 'ses-glasses-1000').queue, 1);
  assert.equal(engine.exportEvents().filter((e) => e.type === 'scanSession').length, 2);
});

test('未成年人参加体验需先核验监护人授权', () => {
  const engine = makeEngine();
  engine.registerVisitor({ requestId: 'rv-1', visitorId: 'kid-1', age: 12 });
  assert.throws(
    () => engine.scanSession({ requestId: 's-1', visitorId: 'kid-1', sessionId: 'ses-glasses-1000', at: T('09:40') }),
    { code: 'guardian-consent-required' },
  );
  engine.grantAuthorization({ requestId: 'au-1', visitorId: 'kid-1', type: 'guardian-consent', at: T('09:41') });
  const reservation = engine.scanSession({ requestId: 's-2', visitorId: 'kid-1', sessionId: 'ses-glasses-1000', at: T('09:42') });
  assert.equal(reservation.status, 'active');
});

test('采集健康数据的体验需先核验授权，未成年人两类授权都要', () => {
  const engine = makeEngine();
  adult(engine, 'v-1', 'rv-1');
  assert.throws(
    () => engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-watch-1030', at: T('09:40') }),
    { code: 'health-consent-required' },
  );
  engine.grantAuthorization({ requestId: 'au-1', visitorId: 'v-1', type: 'health-data-consent', at: T('09:41') });
  assert.equal(engine.scanSession({ requestId: 's-2', visitorId: 'v-1', sessionId: 'ses-watch-1030', at: T('09:42') }).status, 'active');

  engine.registerVisitor({ requestId: 'rv-2', visitorId: 'kid-1', age: 12 });
  engine.grantAuthorization({ requestId: 'au-2', visitorId: 'kid-1', type: 'guardian-consent', at: T('09:43') });
  assert.throws(
    () => engine.scanSession({ requestId: 's-3', visitorId: 'kid-1', sessionId: 'ses-watch-1030', at: T('09:44') }),
    { code: 'health-consent-required' },
  );
});

test('设备停用后按现场进度公平顺延：已到场优先，其余保持先后', () => {
  const engine = makeEngine();
  adult(engine, 'v-a', 'rv-a');
  adult(engine, 'v-b', 'rv-b');
  adult(engine, 'v-c', 'rv-c');
  engine.scanSession({ requestId: 's-a', visitorId: 'v-a', sessionId: 'ses-glasses-1000', at: T('09:30') });
  engine.scanSession({ requestId: 's-b', visitorId: 'v-b', sessionId: 'ses-glasses-1000', at: T('09:31') });
  engine.arrive({ requestId: 'ar-b', reservationId: 'rsv-2', at: T('09:50') });
  engine.scanSession({ requestId: 's-c', visitorId: 'v-c', sessionId: 'ses-glasses-1000', at: T('09:32') });

  const result = engine.disableDemoUnit({ requestId: 'du-1', unitId: 'du-glasses-1', delayMin: 40, at: T('09:55') });
  assert.equal(result.postponed.length, 1);
  assert.equal(result.postponed[0].sessionId, 'ses-glasses-1000');

  const moves = result.postponed[0].moves;
  assert.deepEqual(moves.map((m) => m.visitorId), ['v-b', 'v-a', 'v-c']);
  assert.equal(moves[0].sessionId, 'ses-glasses-1100');
  assert.equal(moves[1].sessionId, 'ses-glasses-1000-post-1');
  assert.equal(moves[2].sessionId, 'ses-glasses-1000-post-1');

  const successor = engine.getSession('ses-glasses-1000-post-1');
  assert.equal(Date.parse(successor.startsAt), Date.parse(T('10:40')));
  assert.equal(engine.getSession('ses-glasses-1000').status, 'postponed');
  assert.equal(engine.getReservation('rsv-1').status, 'moved');
  assert.equal(engine.activeReservationOf('v-b').sessionId, 'ses-glasses-1100');
  assert.throws(
    () => engine.scanSession({ requestId: 's-x', visitorId: 'v-a', sessionId: 'ses-glasses-1000', at: T('10:00') }),
    { code: 'session-not-open' },
  );
});

test('讲解改期顺延保持原有先后', () => {
  const engine = makeEngine();
  adult(engine, 'v-1', 'rv-1');
  adult(engine, 'v-2', 'rv-2');
  engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-rocket-talk', at: T('09:40') });
  engine.scanSession({ requestId: 's-2', visitorId: 'v-2', sessionId: 'ses-rocket-talk', at: T('09:41') });
  const result = engine.postponeSession({ requestId: 'pp-1', sessionId: 'ses-rocket-talk', delayMin: 60, at: T('10:00') });
  assert.deepEqual(result.moves.map((m) => m.visitorId), ['v-1', 'v-2']);
  assert.equal(result.moves[0].sessionId, 'ses-rocket-talk-post-1');
  assert.equal(Date.parse(engine.getSession('ses-rocket-talk-post-1').startsAt), Date.parse(T('11:30')));
});

test('断网补传：重复扫码确认一致，过期扫码不顶替更新时段', () => {
  const engine = makeEngine();
  adult(engine, 'v-1', 'rv-1');
  adult(engine, 'v-2', 'rv-2');
  engine.scanSession({ requestId: 's-online', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('10:05') });

  const outcomes = engine.syncOffline([
    { deviceId: 'handheld-7', localSeq: 2, type: 'scanSession', payload: { requestId: 's-online', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('10:05') } },
    { deviceId: 'handheld-7', localSeq: 1, type: 'scanSession', payload: { requestId: 's-off-1', visitorId: 'v-1', sessionId: 'ses-rocket-talk', at: T('09:58') } },
    { deviceId: 'handheld-8', localSeq: 1, type: 'scanSession', payload: { requestId: 's-off-2', visitorId: 'v-2', sessionId: 'ses-glasses-1000', at: T('10:06') } },
  ]);
  const byId = new Map(outcomes.map((o) => [o.requestId, o]));
  assert.equal(byId.get('s-off-1').status, 'rejected');
  assert.equal(byId.get('s-off-1').code, 'superseded-by-newer');
  assert.equal(byId.get('s-online').status, 'duplicate');
  assert.equal(byId.get('s-online').result.id, 'rsv-1');
  assert.equal(byId.get('s-off-2').status, 'applied');
  assert.equal(engine.activeReservationOf('v-1').sessionId, 'ses-glasses-1000');
  assert.equal(engine.activeReservationOf('v-2').sessionId, 'ses-glasses-1000');
});
