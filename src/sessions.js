// 讲解与体验场次：扫码占位、授权核验、到场核验、设备停用与改期的公平顺延。
import { fail } from './errors.js';
import { activeReservationOf, activeCount, requireVisitor } from './state.js';

const AUTH_TYPES = new Set(['guardian-consent', 'health-data-consent']);
const SESSION_STATUS_LABEL = { postponed: '已改期', finished: '已结束', cancelled: '已取消' };

export function registerVisitor(state, { visitorId, age }) {
  if (typeof visitorId !== 'string' || !visitorId) fail('visitor-invalid', '观众标识无效');
  if (!Number.isInteger(age) || age < 0) fail('visitor-invalid', '观众年龄无效');
  const visitor = { id: visitorId, age, isMinor: age < 18 };
  state.visitors.set(visitorId, visitor);
  return visitor;
}

export function grantAuthorization(state, { visitorId, type, at = null }) {
  requireVisitor(state, visitorId);
  if (!AUTH_TYPES.has(type)) fail('auth-invalid', `未知授权类型 ${type}`);
  let set = state.auths.get(visitorId);
  if (!set) {
    set = new Set();
    state.auths.set(visitorId, set);
  }
  set.add(type);
  return { visitorId, type, at };
}

// 扫码占位：每人只持有一个有效时段，新扫码顶替旧时段；同一场次重复扫码返回原时段。
export function scanSession(state, { visitorId, sessionId, at }) {
  const visitor = requireVisitor(state, visitorId);
  const session = state.sessions.get(sessionId);
  if (!session) fail('session-unknown', `场次 ${sessionId} 不存在`);
  if (session.status !== 'scheduled') {
    fail('session-not-open', `场次 ${sessionId} ${SESSION_STATUS_LABEL[session.status] ?? '不可预约'}`);
  }
  if (session.demoUnitId) {
    const unit = state.demoUnits.get(session.demoUnitId);
    if (unit && unit.status !== 'enabled') fail('equipment-down', `样机 ${unit.id} 已停用，场次等待顺延`);
  }
  const existing = activeReservationOf(state, visitorId);
  if (existing && existing.sessionId === sessionId) return existing;
  if (session.kind === 'experience') {
    const auths = state.auths.get(visitorId) ?? new Set();
    if (visitor.isMinor && !auths.has('guardian-consent')) {
      fail('guardian-consent-required', '未成年人参加体验需先核验监护人授权');
    }
    if (session.collectsHealthData && !auths.has('health-data-consent')) {
      fail('health-consent-required', '采集健康数据的体验需先核验授权');
    }
  }
  // 断网补传的旧扫码不能顶替已生效的更新时段。
  if (existing && Date.parse(at) < Date.parse(existing.createdAt)) {
    fail('superseded-by-newer', '该观众已持有更新的有效时段');
  }
  if (activeCount(state, sessionId) >= session.capacity) fail('session-full', `场次 ${sessionId} 已满`);
  if (existing) {
    existing.status = 'released';
    existing.releaseReason = 'superseded';
  }
  const reservation = {
    id: `rsv-${++state.counters.reservation}`,
    seq: state.counters.reservation,
    visitorId,
    sessionId,
    status: 'active',
    createdAt: at,
    arrivedAt: null,
    releaseReason: null,
  };
  state.reservations.set(reservation.id, reservation);
  return reservation;
}

export function arrive(state, { reservationId, at }) {
  const reservation = state.reservations.get(reservationId);
  if (!reservation) fail('reservation-unknown', `时段 ${reservationId} 不存在`);
  if (reservation.status !== 'active') fail('reservation-not-active', `时段 ${reservationId} 已失效`);
  reservation.arrivedAt = at;
  return reservation;
}

export function completeExperience(state, { reservationId, at }) {
  const reservation = state.reservations.get(reservationId);
  if (!reservation) fail('reservation-unknown', `时段 ${reservationId} 不存在`);
  if (reservation.status !== 'active') fail('reservation-not-active', `时段 ${reservationId} 已失效`);
  if (!reservation.arrivedAt) fail('not-arrived', '未到场核验不能记为已体验');
  reservation.status = 'used';
  reservation.usedAt = at;
  return reservation;
}

// 改期/停用顺延：已到场者优先，其余按占位先后，依次填满更晚的同展品场次，
// 容纳不下的进入按 delayMin 生成的顺延场次，相对顺序保持不变。
export function postponeSession(state, { sessionId, delayMin = 30, reason = 'rescheduled', at }) {
  const session = state.sessions.get(sessionId);
  if (!session) fail('session-unknown', `场次 ${sessionId} 不存在`);
  if (session.status !== 'scheduled') fail('session-not-open', `场次 ${sessionId} 不可顺延`);
  session.status = 'postponed';
  session.postponeReason = reason;

  const affected = [...state.reservations.values()]
    .filter((r) => r.sessionId === sessionId && r.status === 'active')
    .sort((a, b) => (a.arrivedAt ? 0 : 1) - (b.arrivedAt ? 0 : 1) || a.seq - b.seq);

  const moves = [];
  if (affected.length) {
    const startsAt = Date.parse(session.startsAt);
    const targets = [...state.sessions.values()]
      .filter((s) => s.id !== sessionId && s.status === 'scheduled' && Date.parse(s.startsAt) > startsAt)
      .filter((s) => (session.exhibitId ? s.exhibitId === session.exhibitId : s.boothId === session.boothId))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    let successor = null;
    for (const reservation of affected) {
      let target = targets.find((s) => activeCount(state, s.id) < s.capacity);
      if (!target) {
        if (!successor) {
          successor = {
            ...session,
            id: `${sessionId}-post-${++state.counters.session}`,
            startsAt: new Date(startsAt + delayMin * 60000).toISOString(),
            status: 'scheduled',
            postponeReason: undefined,
          };
          state.sessions.set(successor.id, successor);
        }
        target = successor;
      }
      reservation.status = 'moved';
      reservation.movedTo = target.id;
      const next = {
        id: `rsv-${++state.counters.reservation}`,
        seq: state.counters.reservation,
        visitorId: reservation.visitorId,
        sessionId: target.id,
        status: 'active',
        createdAt: at,
        arrivedAt: reservation.arrivedAt,
        releaseReason: null,
      };
      state.reservations.set(next.id, next);
      moves.push({ from: reservation.id, to: next.id, sessionId: target.id, visitorId: reservation.visitorId });
    }
  }
  return { sessionId, reason, moves };
}

// 设备停用：绑定该样机的全部待开场次按同一规则顺延。
export function disableDemoUnit(state, { unitId, delayMin = 30, at }) {
  const unit = state.demoUnits.get(unitId);
  if (!unit) fail('unit-unknown', `样机 ${unitId} 不存在`);
  unit.status = 'disabled';
  const sessionIds = [...state.sessions.values()]
    .filter((s) => s.demoUnitId === unitId && s.status === 'scheduled')
    .map((s) => s.id);
  const postponed = sessionIds.map((id) => postponeSession(state, { sessionId: id, delayMin, reason: 'equipment-down', at }));
  return { unitId, status: 'disabled', postponed };
}

export function enableDemoUnit(state, { unitId }) {
  const unit = state.demoUnits.get(unitId);
  if (!unit) fail('unit-unknown', `样机 ${unitId} 不存在`);
  unit.status = 'enabled';
  return { unitId, status: 'enabled' };
}
