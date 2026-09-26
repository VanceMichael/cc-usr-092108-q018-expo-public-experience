// 运行期可变状态与共享查询。目录资料保持不可变，所有现场变化都落在这里。
import { fail } from './errors.js';

export function createState(catalog) {
  return {
    catalog,
    counters: { reservation: 0, touch: 0, order: 0, payment: 0, pickup: 0, session: 0 },
    visitors: new Map(),
    auths: new Map(),
    sessions: new Map([...catalog.sessions].map(([id, s]) => [id, { ...s, status: 'scheduled' }])),
    demoUnits: new Map([...catalog.demoUnits].map(([id, u]) => [id, { ...u, status: u.status ?? 'enabled' }])),
    batches: new Map([...catalog.batches].map(([id, b]) => [id, { ...b, allocated: 0 }])),
    reservations: new Map(),
    touches: new Map(),
    orders: new Map(),
    payments: new Map(),
    pickupTasks: new Map(),
    presence: new Map(),
    events: [],
    results: new Map(),
  };
}

export function requireVisitor(state, visitorId) {
  const visitor = state.visitors.get(visitorId);
  if (!visitor) fail('visitor-unknown', `观众 ${visitorId} 未登记`);
  return visitor;
}

// 每位观众同一时刻至多一个 status 为 active 的时段。
export function activeReservationOf(state, visitorId) {
  for (const r of state.reservations.values()) {
    if (r.visitorId === visitorId && r.status === 'active') return r;
  }
  return null;
}

export function activeCount(state, sessionId) {
  let count = 0;
  for (const r of state.reservations.values()) {
    if (r.sessionId === sessionId && r.status === 'active') count += 1;
  }
  return count;
}
