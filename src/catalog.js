// 加载并校验展区目录资料：展区、展位、展品、样机、价格版本、可售批次、讲解场次、提货点。
// 校验通过后目录在使用期间不可变，运行期状态放在 state 中。
import { fail } from './errors.js';

const SALE_TYPES = new Set(['display-only', 'in-stock', 'presale']);
const BATCH_TYPES = new Set(['in-stock', 'presale']);
const SESSION_KINDS = new Set(['talk', 'experience']);

function indexById(list, label) {
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !item.id) fail('catalog-invalid', `${label}缺少有效 id`);
    if (map.has(item.id)) fail('catalog-invalid', `${label} id 重复: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function loadCatalog(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const keys = ['zones', 'booths', 'exhibits', 'demoUnits', 'priceVersions', 'batches', 'sessions', 'pickupPoints'];
  for (const key of keys) {
    if (!Array.isArray(data[key])) fail('catalog-invalid', `展区资料缺少 ${key}`);
  }

  const zones = indexById(data.zones, '展区');
  const booths = indexById(data.booths, '展位');
  const exhibits = indexById(data.exhibits, '展品');
  const demoUnits = indexById(data.demoUnits, '样机');
  const priceVersions = indexById(data.priceVersions, '价格版本');
  const batches = indexById(data.batches, '可售批次');
  const sessions = indexById(data.sessions, '讲解场次');
  const pickupPoints = indexById(data.pickupPoints, '提货点');

  for (const booth of booths.values()) {
    if (!zones.has(booth.zoneId)) fail('catalog-invalid', `展位 ${booth.id} 指向未知展区`);
    if (typeof booth.exhibitorId !== 'string' || !booth.exhibitorId) fail('catalog-invalid', `展位 ${booth.id} 缺少展商`);
  }
  for (const exhibit of exhibits.values()) {
    if (!booths.has(exhibit.boothId)) fail('catalog-invalid', `展品 ${exhibit.id} 指向未知展位`);
    if (!SALE_TYPES.has(exhibit.saleType)) fail('catalog-invalid', `展品 ${exhibit.id} 销售方式无效`);
    if (typeof exhibit.modelId !== 'string' || !exhibit.modelId) fail('catalog-invalid', `展品 ${exhibit.id} 缺少型号`);
  }
  for (const unit of demoUnits.values()) {
    if (!exhibits.has(unit.exhibitId)) fail('catalog-invalid', `样机 ${unit.id} 指向未知展品`);
  }
  for (const pv of priceVersions.values()) {
    if (!exhibits.has(pv.exhibitId)) fail('catalog-invalid', `价格版本 ${pv.id} 指向未知展品`);
    if (!Number.isInteger(pv.amountFen) || pv.amountFen < 0) fail('catalog-invalid', `价格版本 ${pv.id} 金额无效`);
    if (Number.isNaN(Date.parse(pv.effectiveFrom))) fail('catalog-invalid', `价格版本 ${pv.id} 生效时间无效`);
  }
  for (const batch of batches.values()) {
    const exhibit = exhibits.get(batch.exhibitId);
    if (!exhibit) fail('catalog-invalid', `批次 ${batch.id} 指向未知展品`);
    if (!BATCH_TYPES.has(batch.type)) fail('catalog-invalid', `批次 ${batch.id} 类型无效`);
    if (batch.type !== exhibit.saleType) fail('catalog-invalid', `批次 ${batch.id} 类型与展品 ${exhibit.id} 销售方式不一致`);
    if (!priceVersions.has(batch.priceVersionId)) fail('catalog-invalid', `批次 ${batch.id} 指向未知价格版本`);
    if (!Number.isInteger(batch.quantity) || batch.quantity < 0) fail('catalog-invalid', `批次 ${batch.id} 数量无效`);
  }
  for (const session of sessions.values()) {
    if (!booths.has(session.boothId)) fail('catalog-invalid', `场次 ${session.id} 指向未知展位`);
    if (session.exhibitId && !exhibits.has(session.exhibitId)) fail('catalog-invalid', `场次 ${session.id} 指向未知展品`);
    if (session.demoUnitId && !demoUnits.has(session.demoUnitId)) fail('catalog-invalid', `场次 ${session.id} 指向未知样机`);
    if (!SESSION_KINDS.has(session.kind)) fail('catalog-invalid', `场次 ${session.id} 类型无效`);
    if (!Number.isInteger(session.capacity) || session.capacity < 1) fail('catalog-invalid', `场次 ${session.id} 容量无效`);
    if (Number.isNaN(Date.parse(session.startsAt))) fail('catalog-invalid', `场次 ${session.id} 开始时间无效`);
    if (!Number.isInteger(session.durationMin) || session.durationMin < 1) fail('catalog-invalid', `场次 ${session.id} 时长无效`);
  }
  for (const point of pickupPoints.values()) {
    if (!zones.has(point.zoneId)) fail('catalog-invalid', `提货点 ${point.id} 指向未知展区`);
  }

  const versionsByExhibit = new Map();
  for (const pv of priceVersions.values()) {
    const list = versionsByExhibit.get(pv.exhibitId) ?? [];
    list.push(pv);
    versionsByExhibit.set(pv.exhibitId, list);
  }
  for (const list of versionsByExhibit.values()) {
    list.sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom));
  }

  return {
    zones,
    booths,
    exhibits,
    demoUnits,
    priceVersions,
    batches,
    sessions,
    pickupPoints,
    // 某时刻生效的价格版本；尚未生效时返回 null。
    currentPriceVersion(exhibitId, at) {
      const list = versionsByExhibit.get(exhibitId) ?? [];
      const time = Date.parse(at);
      let found = null;
      for (const pv of list) {
        if (Date.parse(pv.effectiveFrom) <= time) found = pv;
      }
      return found;
    },
  };
}
