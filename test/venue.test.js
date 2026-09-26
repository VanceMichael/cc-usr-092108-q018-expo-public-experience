import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExpoEngine } from '../src/engine.js';

const RAW = await readFile(new URL('../fixtures/expo.json', import.meta.url), 'utf8');
const T = (hhmm) => `2026-09-26T${hhmm}:00+08:00`;

function makeEngine() {
  const engine = ExpoEngine.load(RAW);
  for (const id of ['v-1', 'v-2', 'v-3']) {
    engine.registerVisitor({ requestId: `rv-${id}`, visitorId: id, age: 30 });
  }
  return engine;
}

test('展区容量满员后拒绝进入，离场后放行', () => {
  const engine = makeEngine();
  engine.enterZone({ requestId: 'e-1', visitorId: 'v-1', zoneId: 'zone-ai', at: T('10:00') });
  engine.enterZone({ requestId: 'e-2', visitorId: 'v-2', zoneId: 'zone-ai', at: T('10:01') });
  assert.throws(
    () => engine.enterZone({ requestId: 'e-3', visitorId: 'v-3', zoneId: 'zone-ai', at: T('10:02') }),
    { code: 'zone-full' },
  );
  engine.exitZone({ requestId: 'e-4', visitorId: 'v-1', at: T('10:03') });
  engine.enterZone({ requestId: 'e-5', visitorId: 'v-3', zoneId: 'zone-ai', at: T('10:04') });
  const zone = engine.dispatch().zones.find((z) => z.zoneId === 'zone-ai');
  assert.equal(zone.occupancy, 2);
  assert.equal(zone.capacity, 2);
});

test('重复进入同一展区不重复计数', () => {
  const engine = makeEngine();
  engine.enterZone({ requestId: 'e-1', visitorId: 'v-1', zoneId: 'zone-ai', at: T('10:00') });
  engine.enterZone({ requestId: 'e-2', visitorId: 'v-1', zoneId: 'zone-ai', at: T('10:01') });
  assert.equal(engine.dispatch().zones.find((z) => z.zoneId === 'zone-ai').occupancy, 1);
});

test('调度按容量与排队估算等待时间，围观不占容量', () => {
  const engine = makeEngine();
  engine.scanSession({ requestId: 's-1', visitorId: 'v-1', sessionId: 'ses-glasses-1000', at: T('09:40') });
  engine.scanSession({ requestId: 's-2', visitorId: 'v-2', sessionId: 'ses-glasses-1000', at: T('09:41') });
  engine.touch({ requestId: 't-1', visitorId: 'v-3', exhibitId: 'ex-glasses', at: T('09:42') });
  engine.touch({ requestId: 't-2', visitorId: 'v-3', exhibitId: 'ex-watch', at: T('09:43') });

  const view = engine.dispatch();
  const zone = view.zones.find((z) => z.zoneId === 'zone-ai');
  assert.equal(zone.occupancy, 0);
  const glasses = zone.sessions.find((s) => s.sessionId === 'ses-glasses-1000');
  assert.equal(glasses.queue, 2);
  assert.equal(glasses.estimatedWaitMin, 20);
  const watch = zone.sessions.find((s) => s.sessionId === 'ses-watch-1030');
  assert.equal(watch.queue, 0);
  assert.equal(watch.estimatedWaitMin, 0);
});
