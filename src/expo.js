// 展区资料读取与基础校验：展区、展位、展品、场次、可售批次、提货点、观众。
//
// 展品 disposition 表示展位上实际摆放的单元：
//   model 模型 / prototype 样机 / display-only 仅展示品 —— 一律不可直接销售；
// 可售性只由 batches 决定，批次 kind 区分 spot 现货 与 presale 预售。
// 这样"样机被当现货卖"在数据层就不成立。

export const DISPOSITIONS = ['model', 'prototype', 'display-only'];
export const SALE_KINDS = ['spot', 'presale'];
export const SESSION_STATUS = ['scheduled', 'delayed', 'cancelled', 'closed'];

function asArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`展区资料缺少必要字段：${label}`);
  return value;
}

function index(list, key, label) {
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item.id !== 'string') throw new Error(`${label}缺少 id`);
    if (map.has(item.id)) throw new Error(`${label}标识重复：${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function parseExpo(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  for (const field of ['domain', 'version', 'openingDay', 'zones', 'booths', 'exhibits', 'sessions', 'batches', 'pickupPoints', 'visitors']) {
    if (value[field] === undefined) throw new Error(`展区资料缺少必要字段：${field}`);
  }
  if (value.domain !== 'expo-public-experience') throw new Error('领域标识不匹配');

  const zones = index(asArray(value.zones, 'zones'), 'id', '展区');
  const exhibitors = index(asArray(value.exhibitors ?? [], 'exhibitors'), 'id', '展商');
  const pickupPoints = index(asArray(value.pickupPoints, 'pickupPoints'), 'id', '提货点');
  const booths = index(asArray(value.booths, 'booths'), 'id', '展位');
  const exhibits = index(asArray(value.exhibits, 'exhibits'), 'id', '展品');
  const sessions = index(asArray(value.sessions, 'sessions'), 'id', '讲解场次');
  const batches = index(asArray(value.batches, 'batches'), 'id', '可售批次');
  const visitors = index(asArray(value.visitors, 'visitors'), 'id', '观众');

  for (const booth of booths.values()) {
    if (!zones.has(booth.zoneId)) throw new Error(`展位 ${booth.id} 所属展区不存在`);
    if (!exhibitors.has(booth.exhibitorId)) throw new Error(`展位 ${booth.id} 所属展商不存在`);
  }
  for (const exhibit of exhibits.values()) {
    const booth = booths.get(exhibit.boothId);
    if (!booth) throw new Error(`展品 ${exhibit.id} 所属展位不存在`);
    if (!DISPOSITIONS.includes(exhibit.disposition)) throw new Error(`展品 ${exhibit.id} 状态非法`);
    if (exhibit.sellable) {
      for (const v of exhibit.priceVersions ?? []) {
        if (typeof v.version !== 'string' || typeof v.price !== 'number' || v.price < 0) {
          throw new Error(`展品 ${exhibit.id} 价格版本非法`);
        }
      }
      for (const kind of exhibit.saleKinds ?? []) {
        if (!SALE_KINDS.includes(kind)) throw new Error(`展品 ${exhibit.id} 销售类型非法：${kind}`);
      }
    } else if ((exhibit.saleKinds?.length ?? 0) > 0) {
      throw new Error(`展品 ${exhibit.id} 标记不可售却配置了销售类型`);
    }
    exhibit._zoneId = booth.zoneId;
  }
  for (const session of sessions.values()) {
    const booth = booths.get(session.boothId);
    const exhibit = exhibits.get(session.exhibitId);
    if (!booth || !exhibit) throw new Error(`场次 ${session.id} 关联展位/展品不存在`);
    if (exhibit.boothId !== session.boothId) throw new Error(`场次 ${session.id} 与展品不在同一展位`);
    if (!SESSION_STATUS.includes(session.status)) throw new Error(`场次 ${session.status} 状态非法`);
    if (typeof session.capacity !== 'number' || session.capacity <= 0) throw new Error(`场次 ${session.id} 容量非法`);
    session._startMs = Date.parse(session.start);
    if (Number.isNaN(session._startMs)) throw new Error(`场次 ${session.id} 开始时间非法`);
    session._durationMin = exhibit.experience?.durationMin ?? 0;
  }
  for (const batch of batches.values()) {
    const exhibit = exhibits.get(batch.exhibitId);
    if (!exhibit) throw new Error(`批次 ${batch.id} 关联展品不存在`);
    if (!SALE_KINDS.includes(batch.kind)) throw new Error(`批次 ${batch.kind} 类型非法`);
    if (!exhibit.sellable || !(exhibit.saleKinds ?? []).includes(batch.kind)) {
      throw new Error(`批次 ${batch.id} 对应展品不允许该销售类型`);
    }
    if (!exhibit.priceVersions.some((v) => v.version === batch.priceVersion)) {
      throw new Error(`批次 ${batch.id} 绑定的价格版本不存在`);
    }
    const point = pickupPoints.get(batch.pickupPointId);
    if (!point) throw new Error(`批次 ${batch.id} 提货点不存在`);
    if (point.zoneId !== exhibits.get(batch.exhibitId)._zoneId) {
      throw new Error(`批次 ${batch.id} 跨展区绑定提货点，跨区提货必须在订单上显式改写`);
    }
    if (batch.remaining > batch.quantity || batch.remaining < 0) throw new Error(`批次 ${batch.id} 库存非法`);
  }
  for (const visitor of visitors.values()) {
    visitor.consents ??= {};
  }

  return {
    raw: value,
    zones, exhibitors, pickupPoints, booths, exhibits, sessions, batches, visitors,
  };
}

export function priceOf(exhibit, version) {
  const pv = (exhibit.priceVersions ?? []).find((v) => v.version === version);
  if (!pv) throw new Error(`价格版本不存在：${version}`);
  return pv;
}

export function sessionEndMs(session) {
  return session._startMs + session._durationMin * 60_000;
}
