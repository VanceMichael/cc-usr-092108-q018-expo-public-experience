// 展商对账：只按真实完成的体验与真实成交结算，围观与排队不计入。
export function statement(state, exhibitorId) {
  const boothIds = new Set(
    [...state.catalog.booths.values()].filter((b) => b.exhibitorId === exhibitorId).map((b) => b.id),
  );

  let experiencesCompleted = 0;
  for (const reservation of state.reservations.values()) {
    if (reservation.status !== 'used') continue;
    const session = state.sessions.get(reservation.sessionId);
    if (session && boothIds.has(session.boothId)) experiencesCompleted += 1;
  }

  const settledOrders = [];
  const refundedOrders = [];
  for (const order of state.orders.values()) {
    const mine = order.lines.filter((l) => l.exhibitorId === exhibitorId);
    if (!mine.length) continue;
    const amountFen = mine.reduce((sum, l) => sum + l.unitAmountFen * l.qty, 0);
    if (order.status === 'paid' || order.status === 'fulfilled') {
      settledOrders.push({ orderId: order.id, amountFen });
    } else if (order.status === 'refunded') {
      refundedOrders.push({ orderId: order.id, amountFen });
    }
  }

  const exhibitIds = new Set(
    [...state.catalog.exhibits.values()].filter((e) => boothIds.has(e.boothId)).map((e) => e.id),
  );
  let touches = 0;
  for (const record of state.touches.values()) {
    if (exhibitIds.has(record.exhibitId)) touches += 1;
  }
  let activeReservations = 0;
  for (const reservation of state.reservations.values()) {
    if (reservation.status !== 'active') continue;
    const session = state.sessions.get(reservation.sessionId);
    if (session && boothIds.has(session.boothId)) activeReservations += 1;
  }

  const settledFen = settledOrders.reduce((sum, o) => sum + o.amountFen, 0);
  const refundedFen = refundedOrders.reduce((sum, o) => sum + o.amountFen, 0);
  return {
    exhibitorId,
    experiencesCompleted,
    settledOrders,
    refundedOrders,
    netFen: settledFen - refundedFen,
    // 围观接触与排队占位只是现场热度，不作为结算依据。
    nonSettlement: { touches, activeReservations },
  };
}
