// 场馆调度：展区容量、等待时间估算与闭馆清场。
import { fail } from './errors.js';
import { activeCount, requireVisitor } from './state.js';

export function enterZone(state, { visitorId, zoneId, at }) {
  requireVisitor(state, visitorId);
  const zone = state.catalog.zones.get(zoneId);
  if (!zone) fail('zone-unknown', `展区 ${zoneId} 不存在`);
  if (state.presence.get(visitorId) === zoneId) return { visitorId, zoneId, at };
  const occupancy = [...state.presence.values()].filter((z) => z === zoneId).length;
  if (occupancy >= zone.capacity) fail('zone-full', `展区 ${zone.name} 已达容量上限`);
  state.presence.set(visitorId, zoneId);
  return { visitorId, zoneId, at };
}

export function exitZone(state, { visitorId, at }) {
  const zoneId = state.presence.get(visitorId) ?? null;
  state.presence.delete(visitorId);
  return { visitorId, zoneId, at };
}

// 闭馆清场：未核销时段过期、未支付订单取消并释放批次；
// 已支付订单与待提货单保留，可继续提货或退款。
export function clearVenue(state, { at }) {
  let expiredReservations = 0;
  let cancelledOrders = 0;
  let finishedSessions = 0;
  for (const reservation of state.reservations.values()) {
    if (reservation.status === 'active') {
      reservation.status = 'expired';
      reservation.releaseReason = 'clearing';
      expiredReservations += 1;
    }
  }
  for (const order of state.orders.values()) {
    if (order.status === 'pending') {
      order.status = 'cancelled';
      for (const line of order.lines) state.batches.get(line.batchId).allocated -= line.qty;
      cancelledOrders += 1;
    }
  }
  for (const session of state.sessions.values()) {
    if (session.status === 'scheduled' && Date.parse(session.startsAt) <= Date.parse(at)) {
      session.status = 'finished';
      finishedSessions += 1;
    }
  }
  state.presence.clear();
  return { at, expiredReservations, cancelledOrders, finishedSessions };
}

// 调度视图：各展区容量占用与各场次排队、预计等待时间，只统计真实在场与占位。
export function dispatch(state) {
  const zones = [...state.catalog.zones.values()].map((zone) => {
    const occupancy = [...state.presence.values()].filter((z) => z === zone.id).length;
    const boothIds = new Set(
      [...state.catalog.booths.values()].filter((b) => b.zoneId === zone.id).map((b) => b.id),
    );
    const sessions = [...state.sessions.values()]
      .filter((s) => s.status === 'scheduled' && boothIds.has(s.boothId))
      .map((s) => {
        const queue = activeCount(state, s.id);
        return {
          sessionId: s.id,
          startsAt: s.startsAt,
          queue,
          capacity: s.capacity,
          estimatedWaitMin: Math.ceil(queue / s.capacity) * s.durationMin,
        };
      })
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    return { zoneId: zone.id, occupancy, capacity: zone.capacity, sessions };
  });
  return { zones };
}
