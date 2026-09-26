// 协调产品门面：统一入口、requestId 幂等、事件日志、断网同步与恢复。
import { loadCatalog } from './catalog.js';
import { createState, activeReservationOf } from './state.js';
import { fail } from './errors.js';
import * as sessions from './sessions.js';
import * as orders from './orders.js';
import * as venue from './venue.js';
import { statement } from './ledger.js';

const OPS = {
  registerVisitor: sessions.registerVisitor,
  grantAuthorization: sessions.grantAuthorization,
  scanSession: sessions.scanSession,
  arrive: sessions.arrive,
  completeExperience: sessions.completeExperience,
  postponeSession: sessions.postponeSession,
  disableDemoUnit: sessions.disableDemoUnit,
  enableDemoUnit: sessions.enableDemoUnit,
  touch: orders.touch,
  createOrder: orders.createOrder,
  pay: orders.pay,
  refund: orders.refund,
  assignPickup: orders.assignPickup,
  completePickup: orders.completePickup,
  enterZone: venue.enterZone,
  exitZone: venue.exitZone,
  clearVenue: venue.clearVenue,
};

export class ExpoEngine {
  constructor(catalog) {
    this.catalog = catalog;
    this.state = createState(catalog);
    for (const name of Object.keys(OPS)) {
      this[name] = (payload) => this.#apply(name, payload);
    }
  }

  static load(raw) {
    return new ExpoEngine(loadCatalog(raw));
  }

  // 从事件日志恢复现场：重复 requestId 的事件只生效一次，结果与在线执行一致。
  static recover(source, events) {
    const catalog = typeof source === 'string' ? loadCatalog(source) : source;
    const engine = new ExpoEngine(catalog);
    for (const event of events) {
      if (event?.payload?.requestId && engine.state.results.has(event.payload.requestId)) continue;
      engine.#apply(event.type, event.payload);
    }
    return engine;
  }

  #apply(type, payload) {
    const op = OPS[type];
    if (!op) fail('op-unknown', `未知操作 ${type}`);
    if (!payload || typeof payload.requestId !== 'string' || !payload.requestId) {
      fail('request-id-required', '每次操作必须携带 requestId 以保证幂等');
    }
    if (this.state.results.has(payload.requestId)) {
      return structuredClone(this.state.results.get(payload.requestId));
    }
    const result = op(this.state, payload);
    const snapshot = structuredClone(result);
    this.state.events.push({
      seq: this.state.events.length + 1,
      type,
      payload: structuredClone(payload),
      result: snapshot,
    });
    this.state.results.set(payload.requestId, snapshot);
    return structuredClone(snapshot);
  }

  // 断网期间手持设备积压的事件：按发生时间（同刻按设备与序号）排序落账，
  // 已处理的确认重复，与现场状态冲突的给出拒绝原因，不产生第二份结果。
  syncOffline(batch) {
    const at = (event) => (event?.payload?.at ? Date.parse(event.payload.at) : 0);
    const sorted = [...batch].sort((a, b) =>
      at(a) - at(b) ||
      String(a.deviceId ?? '').localeCompare(String(b.deviceId ?? '')) ||
      (a.localSeq ?? 0) - (b.localSeq ?? 0));
    const outcomes = [];
    for (const event of sorted) {
      const requestId = event?.payload?.requestId ?? null;
      if (requestId && this.state.results.has(requestId)) {
        outcomes.push({ requestId, status: 'duplicate', result: structuredClone(this.state.results.get(requestId)) });
        continue;
      }
      try {
        const result = this.#apply(event.type, event.payload);
        outcomes.push({ requestId, status: 'applied', result });
      } catch (error) {
        outcomes.push({ requestId, status: 'rejected', code: error.code ?? 'error', message: error.message });
      }
    }
    return outcomes;
  }

  exportEvents() {
    return structuredClone(this.state.events);
  }

  getReservation(id) {
    return structuredClone(this.state.reservations.get(id) ?? null);
  }

  getOrder(id) {
    return structuredClone(this.state.orders.get(id) ?? null);
  }

  getSession(id) {
    return structuredClone(this.state.sessions.get(id) ?? null);
  }

  getBatch(id) {
    return structuredClone(this.state.batches.get(id) ?? null);
  }

  getPickupTask(id) {
    return structuredClone(this.state.pickupTasks.get(id) ?? null);
  }

  activeReservationOf(visitorId) {
    const found = activeReservationOf(this.state, visitorId);
    return found ? structuredClone(found) : null;
  }

  statement(exhibitorId) {
    return statement(this.state, exhibitorId);
  }

  dispatch() {
    return venue.dispatch(this.state);
  }
}
