// An in-memory GeoMarketStore. It enforces the same bounds and validators the
// SQL store does — imported from it, not restated — because a double that
// accepts what the database refuses hides the failure until production (a
// limit-blind double once hid a 400 on every 主动科研 load). The scenarios in
// geoMarketScenarios.mjs run against this double and against PostgreSQL alike.
import {
  ARTICLE_STATUSES,
  EPSILON_CNY,
  GEO_ORDER_ARTICLE_LIVE_STATES,
  articleLiveError,
  dailyReserved,
  projectMoney,
  GEO_MARKET_STORE_LIMITS,

  MEDIA_TYPES,
  ORDER_STATES,
  TOPUP_STATUSES,
  assertAmount,
  assertAt,
  assertDetail,
  assertLedgerRow,
  assertLimit,
  assertOffset,
  assertOneOf,
  assertOrderPatch,
  orderedId,
} from "../../src/geoMarketStore.mjs";
import { HttpError } from "../../src/security.mjs";

const clone = (/** @type {any} */ value) => (value == null ? value : structuredClone(value));
const byTime = (/** @type {string} */ a, /** @type {string} */ b) => (Date.parse(a) - Date.parse(b));
/** @param {string} message */
const storeError = (message) => new HttpError(400, "geo_market_store_invalid", message);

export class GeoMarketStoreDouble {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {Map<string, any>} */ this.projects = new Map();
    /** @type {Map<string, any>} */ this.groups = new Map();
    /** @type {Map<string, any>} */ this.articles = new Map();
    /** @type {any[]} */ this.sources = [];
    /** @type {any[]} */ this.targets = [];
    /** @type {Map<string, any>} */ this.media = new Map();
    /** @type {Map<string, any>} */ this.outcomes = new Map();
    /** @type {Map<string, any>} */ this.orders = new Map();
    /** @type {any[]} */ this.events = [];
    /** @type {any[]} */ this.ledger = [];
    /** @type {Map<string, any>} */ this.topups = new Map();
    /** @type {Map<string, any>} */ this.reconciliations = new Map();
    /** @type {Set<string>} projects whose market lock is held */ this.locks = new Set();
  }

  async ready() {}

  // ------------------------------------------------------------- seeding

  /** @param {Record<string, any>} project */
  async seedProject(project) {
    this.projects.set(project.id, {
      id: project.id, userId: project.userId, projectId: project.projectId ?? `p_${project.id}`, product: project.product ?? {},
      competitors: project.competitors ?? [], engines: project.engines ?? ["deepseek", "doubao"], tier: project.tier ?? "2",
      budget: project.budget ?? null, status: project.status ?? "active", deletedAt: null, createdAt: project.createdAt ?? new Date().toISOString(),
    });
  }

  /** @param {Record<string, any>} group */
  async seedGroup(group) {
    this.groups.set(group.id, { ...group, isControl: Boolean(group.isControl) });
  }

  /** @param {Record<string, any>} article */
  async seedArticle(article) {
    this.articles.set(article.id, {
      id: article.id, userId: article.userId, geoProjectId: article.geoProjectId, runId: null, deliverableId: null, path: article.path ?? null,
      layer: article.layer ?? "popular", title: article.title ?? "", groupId: article.groupId ?? null, claimIds: [],
      gate: article.gate ?? "passed", safety: article.safety ?? "clear", contentSha256: article.contentSha256 ?? null, protectedSha256: null,
      status: article.status ?? "publishable", createdAt: article.createdAt ?? new Date().toISOString(),
    });
  }

  /** @param {Record<string, any>} source */
  async seedSource(source) {
    this.sources.push({
      geoProjectId: source.geoProjectId, domain: source.domain, name: source.name ?? "", layer: source.layer ?? null,
      icpMatches: source.icpMatches ?? null, newsIndexed: source.newsIndexed ?? null, medicalVertical: source.medicalVertical ?? null,
      impostor: Boolean(source.impostor), blacklistReason: source.blacklistReason ?? null, cited: source.cited ?? {},
    });
  }

  /** @param {Record<string, any>} target */
  async seedTarget(target) {
    this.targets.push({ ...target });
  }

  // --------------------------------------------------------------- media

  /** @param {string} mediaType @param {string[]} resourceIds */
  async getMediaRows(mediaType, resourceIds) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    const ids = [...new Set(resourceIds.map(String))];
    if (ids.length > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many media keys in one lookup.");
    return ids.map((id) => this.media.get(`${mediaType}:${id}`)).filter(Boolean).map(clone);
  }

  /** @param {any[]} rows */
  async upsertMediaRows(rows) {
    if (rows.length > GEO_MARKET_STORE_LIMITS.mediaBatchMax) throw storeError("Too many media rows in one upsert.");
    for (const row of rows) {
      assertOneOf(row.mediaType, MEDIA_TYPES, "media type");
      if ((row.priceHistory ?? []).length > GEO_MARKET_STORE_LIMITS.priceHistoryMax) throw storeError("A media row keeps a bounded price history.");
      const key = `${row.mediaType}:${row.resourceId}`;
      const existing = this.media.get(key);
      this.media.set(key, {
        resourceId: String(row.resourceId), mediaType: row.mediaType, name: row.name ?? "", domain: row.domain ?? null,
        domainVerified: row.domainVerified ?? null, icpOwner: row.icpOwner ?? null, fields: clone(row.fields ?? {}),
        priceCny: row.priceCny ?? null, publishRate: row.publishRate ?? null, publishSeconds: row.publishSeconds ?? null,
        remarks: row.remarks ?? "", caseLink: row.caseLink ?? null, flags: { ...(existing?.flags ?? {}), ...clone(row.flags ?? {}) },
        available: Boolean(row.available), blacklisted: Boolean(row.blacklisted), blacklistReason: row.blacklistReason ?? null,
        priceHistory: clone(row.priceHistory ?? []), syncedAt: assertAt(row.syncedAt),
      });
    }
    return rows.length;
  }

  /** @param {string} mediaType @param {string} before */
  async markUnseenMediaUnavailable(mediaType, before) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    const cutoff = Date.parse(assertAt(before));
    let count = 0;
    for (const row of this.media.values()) {
      if (row.mediaType === mediaType && (row.syncedAt == null || Date.parse(row.syncedAt) < cutoff) && row.available !== false) {
        row.available = false;
        count += 1;
      }
    }
    return count;
  }

  /** @param {{ maxPriceCny: number, limit: number }} options */
  async listCandidateMedia({ maxPriceCny, limit }) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.candidatesMax);
    const max = assertAmount(maxPriceCny);
    return [...this.media.values()]
      .filter((row) => row.available && !row.blacklisted && row.priceCny != null && row.priceCny <= max)
      .sort((a, b) => (a.mediaType + a.resourceId < b.mediaType + b.resourceId ? -1 : a.mediaType === b.mediaType && a.resourceId === b.resourceId ? 0 : 1))
      .slice(0, limit)
      .map(clone);
  }

  /** @param {{ mediaType: string, resourceId: string, domainVerified?: boolean | null, flags?: Record<string, any>, blacklisted?: boolean, blacklistReason?: string | null }} update */
  async updateMediaFlags({ mediaType, resourceId, domainVerified, flags = {}, blacklisted, blacklistReason }) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    assertDetail(flags);
    const row = this.media.get(`${mediaType}:${resourceId}`);
    if (!row) return false;
    row.flags = { ...(row.flags ?? {}), ...clone(flags) };
    if (domainVerified !== undefined) row.domainVerified = domainVerified;
    if (blacklisted != null) { row.blacklisted = blacklisted; row.blacklistReason = blacklistReason ?? null; }
    return true;
  }

  /** @param {string} mediaType @param {string} resourceId @param {string} key */
  async incrementMediaFlag(mediaType, resourceId, key) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    if (!/^[a-zA-Z]{1,40}$/.test(key)) throw storeError("A flag counter is named by letters.");
    const row = this.media.get(`${mediaType}:${resourceId}`);
    if (!row) return null;
    row.flags = { ...(row.flags ?? {}), [key]: Number(row.flags?.[key] ?? 0) + 1 };
    return row.flags[key];
  }

  /** @param {Array<{ mediaType: string, resourceId: string }>} keys */
  async getMediaOutcomes(keys) {
    if (keys.length > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many media keys in one lookup.");
    const wanted = new Set(keys.map((key) => `${key.mediaType}:${key.resourceId}`));
    return [...this.outcomes.values()].filter((row) => wanted.has(`${row.mediaType}:${row.resourceId}`)).map(clone);
  }

  /** @param {{ mediaType: string, resourceId: string, engine: string, placed?: number, cited?: number, at: string }} change */
  async incrementMediaOutcome({ mediaType, resourceId, engine, placed = 0, cited = 0, at }) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    if (!/^[a-z]{2,20}$/.test(engine)) throw storeError("An engine is named by lower-case letters.");
    if (![placed, cited].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000)) throw storeError("Outcome increments are small whole numbers.");
    const key = `${mediaType}:${resourceId}:${engine}`;
    const row = this.outcomes.get(key) ?? { mediaType, resourceId: String(resourceId), engine, placed: 0, cited: 0 };
    row.placed += placed;
    row.cited += cited;
    row.updatedAt = assertAt(at);
    this.outcomes.set(key, row);
  }

  // ------------------------------------------------- projects and content

  /** @param {{ geoProjectId: string, userId?: string }} key */
  async getProject({ geoProjectId, userId }) {
    const project = this.projects.get(String(geoProjectId));
    if (!project || project.deletedAt || (userId != null && project.userId !== userId)) return null;
    return clone(project);
  }

  /** @param {number} limit @param {{ activeOnly?: boolean }} [options] */
  async listBudgetedProjects(limit, { activeOnly = true } = {}) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    return [...this.projects.values()]
      .filter((project) => project.budget && !project.deletedAt && (!activeOnly || project.status === "active"))
      .sort((a, b) => byTime(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1))
      .slice(0, limit).map(clone);
  }

  /** @param {{ geoProjectId: string, userId: string, budget: Record<string, any>, ledgerRow: Record<string, any>, at: string }} change */
  async setProjectBudget({ geoProjectId, userId, budget, ledgerRow, at }) {
    const when = assertAt(at);
    const row = assertLedgerRow({ ...ledgerRow, kind: "budget_set", userId, geoProjectId }, when);
    const project = this.projects.get(String(geoProjectId));
    if (!project || project.userId !== userId || project.deletedAt) return null;
    project.budget = clone(budget);
    this.ledger.push(row);
    return clone(project);
  }

  /** @param {any} article */
  #articleView(article) {
    const group = article.groupId ? this.groups.get(article.groupId) : null;
    return { ...clone(article), isControl: Boolean(group && group.geoProjectId === article.geoProjectId && group.isControl) };
  }

  /** @param {string} geoProjectId @param {number} limit */
  async listPlaceableArticles(geoProjectId, limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    return [...this.articles.values()]
      .filter((article) => article.geoProjectId === geoProjectId && ["publishable", "placed", "published"].includes(article.status))
      .sort((a, b) => byTime(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1))
      .slice(0, limit).map((article) => this.#articleView(article));
  }

  /** @param {string[]} ids */
  async getArticles(ids) {
    const unique = [...new Set(ids.map(String))];
    if (unique.length > GEO_MARKET_STORE_LIMITS.listMax) throw storeError("Too many articles in one lookup.");
    return unique.map((id) => this.articles.get(id)).filter(Boolean).map((article) => this.#articleView(article));
  }

  /** @param {string} articleId @param {string[]} from @param {string} to @param {string} at */
  async advanceArticleStatus(articleId, from, to, at) {
    assertOneOf(to, ARTICLE_STATUSES, "article status");
    for (const state of from) assertOneOf(state, ARTICLE_STATUSES, "article status");
    assertAt(at);
    const article = this.articles.get(String(articleId));
    if (!article || !from.includes(article.status)) return false;
    article.status = to;
    return true;
  }

  /** @param {string} geoProjectId @param {string[]} domains */
  async getSources(geoProjectId, domains) {
    const unique = new Set(domains.map(String));
    if (unique.size > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many domains in one lookup.");
    return this.sources.filter((source) => source.geoProjectId === geoProjectId && unique.has(source.domain)).map(clone);
  }

  /** @param {string} geoProjectId @param {string} tier */
  async suggestedBudget(geoProjectId, tier) {
    const mine = this.targets.filter((target) => target.geoProjectId === geoProjectId);
    if (!mine.length) return null;
    const version = Math.max(...mine.map((target) => target.version));
    const values = mine.filter((target) => target.version === version && target.tier === tier && target.budgetCny != null).map((target) => Number(target.budgetCny));
    return values.length ? Math.max(...values) : null;
  }

  // -------------------------------------------------------------- orders

  /** @param {any} order */
  #orderView(order) {
    const events = this.events.filter((event) => event.orderId === order.id);
    const first = (/** @type {(event: any) => boolean} */ test) => events.filter(test).map((event) => event.at).sort(byTime)[0] ?? null;
    const last = (/** @type {(event: any) => boolean} */ test) => events.filter(test).map((event) => event.at).sort(byTime).at(-1) ?? null;
    return {
      ...clone(order),
      sentAt: last((event) => event.detail?.phase === "send_started"),
      submittedAt: first((event) => event.toState === "submitted" && event.fromState !== "submitted"),
      acceptedAt: first((event) => event.toState === "accepted" && event.fromState !== "accepted"),
      publishedAt: first((event) => event.toState === "published" && event.fromState !== "published"),
      stateAt: last((event) => event.toState === order.state && event.fromState !== event.toState),
      stateReason: events.filter((event) => event.toState === order.state && event.fromState !== event.toState)
        .sort((a, b) => byTime(a.at, b.at) || (a.id < b.id ? -1 : 1)).at(-1)?.detail?.reason ?? null,
      refundSeenAt: first((event) => event.detail?.phase === "refund_seen"),
    };
  }

  /** The partial unique index: one order per article in a live state. @param {string} articleId @param {string} state @param {string} [exceptId] */
  #checkArticleLive(articleId, state, exceptId) {
    if (!GEO_ORDER_ARTICLE_LIVE_STATES.includes(state)) return;
    for (const other of this.orders.values()) {
      if (other.id !== exceptId && other.articleId === articleId && GEO_ORDER_ARTICLE_LIVE_STATES.includes(other.state)) throw articleLiveError();
    }
  }

  /** @param {string} orderId @param {{ at: string, dayStart: string, reserveDetail?: Record<string, any>, sendDetail: Record<string, any>, patch?: Record<string, any> }} move */
  async reserveForSend(orderId, { at, dayStart, reserveDetail = {}, sendDetail, patch = {} }) {
    const when = assertAt(at);
    const since = assertAt(dayStart);
    assertDetail(reserveDetail);
    assertDetail(sendDetail);
    assertOrderPatch(patch);
    const order = this.orders.get(String(orderId));
    if (!order || order.state !== "planned") return null;
    const project = this.projects.get(order.geoProjectId);
    if (!project || project.deletedAt) return { refused: "project_missing" };
    const money = projectMoney(project, await this.ledgerSums({ geoProjectId: order.geoProjectId }));
    if (money.availableCny == null || money.availableCny + EPSILON_CNY < order.reserveCny) return { refused: "budget_exhausted" };
    if (money.dailyCny != null && dailyReserved(await this.ledgerSums({ geoProjectId: order.geoProjectId, since })) + order.reserveCny > money.dailyCny + EPSILON_CNY) {
      return { refused: "daily_cap_reached" };
    }
    Object.assign(order, clone(patch), { state: "reserved", updatedAt: when });
    this.events.push({ id: orderedId("ge_"), orderId: order.id, at: when, fromState: "planned", toState: "reserved", detail: clone(reserveDetail) });
    this.events.push({ id: orderedId("ge_"), orderId: order.id, at: when, fromState: "reserved", toState: "reserved", detail: { ...clone(sendDetail), phase: "send_started" } });
    this.ledger.push(assertLedgerRow({ kind: "reserve", amountCny: order.reserveCny, userId: order.userId, geoProjectId: order.geoProjectId, orderId: order.id }, when));
    return { order: this.#orderView(order) };
  }

  /** @template T @param {string} geoProjectId @param {() => Promise<T>} operation */
  async withProjectLock(geoProjectId, operation) {
    if (this.locks.has(geoProjectId)) return { locked: false };
    this.locks.add(geoProjectId);
    try {
      return { locked: true, value: await operation() };
    } finally {
      this.locks.delete(geoProjectId);
    }
  }

  /** @param {Array<Record<string, any>>} orders @param {string} at */
  async insertOrders(orders, at) {
    if (orders.length > GEO_MARKET_STORE_LIMITS.ordersBatchMax) throw storeError("Too many orders in one insert.");
    const when = assertAt(at);
    const rows = orders.map((order) => ({
      id: order.id ?? orderedId("go_"), userId: String(order.userId), geoProjectId: String(order.geoProjectId), articleId: String(order.articleId),
      mediaType: assertOneOf(order.mediaType, MEDIA_TYPES, "media type"), resourceId: String(order.resourceId),
      priceCny: assertAmount(order.priceCny), reserveCny: assertAmount(order.reserveCny), detail: assertDetail(order.detail ?? {}),
    }));
    // One transaction: every row is checked before any is written.
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.articleId)) throw articleLiveError();
      seen.add(row.articleId);
      this.#checkArticleLive(row.articleId, "planned");
    }
    const created = [];
    for (const row of rows) {
      if (this.orders.has(row.id)) throw storeError("duplicate key value violates unique constraint");
      const order = {
        id: row.id, userId: row.userId, geoProjectId: row.geoProjectId, articleId: row.articleId, mediaType: row.mediaType, resourceId: row.resourceId,
        vendorOrderNid: null, state: "planned", reserveCny: row.reserveCny, priceCny: row.priceCny, settledCny: null, bodySha256: null,
        publishedUrl: null, checks: [], appeal: null, createdAt: when, updatedAt: when,
      };
      this.orders.set(order.id, order);
      this.events.push({ id: orderedId("ge_"), orderId: order.id, at: when, fromState: null, toState: "planned", detail: clone(row.detail) });
      created.push(this.#orderView(order));
    }
    return created;
  }

  /** @param {Record<string, any>} patch */
  #checkNidUnique(patch, orderId) {
    if (patch.vendorOrderNid == null) return;
    for (const other of this.orders.values()) {
      if (other.id !== orderId && other.vendorOrderNid === patch.vendorOrderNid) throw storeError("duplicate key value violates unique constraint");
    }
  }

  /** @param {string} orderId @param {{ from: string[], to: string, at: string, patch?: Record<string, any>, detail?: Record<string, any>, ledger?: any[] }} move */
  async transitionOrder(orderId, { from, to, at, patch = {}, detail = {}, ledger = [] }) {
    const when = assertAt(at);
    assertOneOf(to, ORDER_STATES, "order state");
    for (const state of from) assertOneOf(state, ORDER_STATES, "order state");
    assertOrderPatch(patch);
    assertDetail(detail);
    if (ledger.length > GEO_MARKET_STORE_LIMITS.ledgerRowsMax) throw storeError("Too many ledger rows for one transition.");
    const rows = ledger.map((row) => assertLedgerRow({ ...row, orderId }, when));
    const order = this.orders.get(String(orderId));
    if (!order || !from.includes(order.state)) return null;
    this.#checkNidUnique(patch, order.id);
    this.#checkArticleLive(order.articleId, to, order.id);
    const fromState = order.state;
    Object.assign(order, clone(patch), { state: to, updatedAt: when });
    this.events.push({ id: orderedId("ge_"), orderId: order.id, at: when, fromState, toState: to, detail: clone(detail) });
    this.ledger.push(...rows.map((row) => ({ ...row, userId: row.userId ?? null })));
    return this.#orderView(order);
  }

  /** @param {string} orderId @param {{ at: string, detail: Record<string, any>, patch?: Record<string, any>, expectState?: string }} note */
  async annotateOrder(orderId, { at, detail, patch = {}, expectState }) {
    const when = assertAt(at);
    assertDetail(detail);
    assertOrderPatch(patch);
    if (expectState != null) assertOneOf(expectState, ORDER_STATES, "order state");
    for (const key of ["vendorOrderNid", "reserveCny", "settledCny"]) {
      if (Object.hasOwn(patch, key)) throw storeError(`An annotation cannot set ${key}.`);
    }
    const order = this.orders.get(String(orderId));
    if (!order || (expectState != null && order.state !== expectState)) return null;
    Object.assign(order, clone(patch), { updatedAt: when });
    const event = { id: orderedId("ge_"), orderId: order.id, at: when, fromState: order.state, toState: order.state, detail: clone(detail) };
    this.events.push(event);
    return clone(event);
  }

  /** @param {string} orderId */
  async getOrder(orderId) {
    const order = this.orders.get(String(orderId));
    return order ? this.#orderView(order) : null;
  }

  /** @param {Record<string, any>} filter */
  async listOrders(filter) {
    const limit = assertLimit(filter.limit, GEO_MARKET_STORE_LIMITS.listMax);
    const offset = assertOffset(filter.offset ?? 0);
    for (const state of filter.states ?? []) assertOneOf(state, ORDER_STATES, "order state");
    const createdSince = filter.createdSince == null ? null : Date.parse(assertAt(filter.createdSince));
    const updatedSince = filter.updatedSince == null ? null : Date.parse(assertAt(filter.updatedSince));
    const rows = [...this.orders.values()].filter((order) => (filter.geoProjectId == null || order.geoProjectId === String(filter.geoProjectId))
      && (filter.userId == null || order.userId === String(filter.userId))
      && (!filter.states || filter.states.includes(order.state))
      && (!filter.ids || filter.ids.map(String).includes(order.id))
      && (!filter.articleIds || filter.articleIds.map(String).includes(order.articleId))
      && (filter.hasVendorNid !== true || order.vendorOrderNid != null)
      && (filter.hasVendorNid !== false || order.vendorOrderNid == null)
      && (filter.mediaType == null || order.mediaType === filter.mediaType)
      && (filter.resourceId == null || order.resourceId === String(filter.resourceId))
      && (filter.publishedUrl == null || order.publishedUrl === String(filter.publishedUrl))
      && (createdSince == null || Date.parse(order.createdAt) >= createdSince)
      && (updatedSince == null || Date.parse(order.updatedAt) >= updatedSince));
    rows.sort((a, b) => byTime(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (filter.newestFirst) rows.reverse();
    return rows.slice(offset, offset + limit).map((order) => this.#orderView(order));
  }

  /** @param {string} orderId @param {number} limit */
  async listOrderEvents(orderId, limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    return this.events.filter((event) => event.orderId === String(orderId))
      .sort((a, b) => byTime(a.at, b.at) || (a.id < b.id ? -1 : 1)).slice(0, limit).map(clone);
  }

  // -------------------------------------------------------------- ledger

  /** @param {{ geoProjectId: string, since?: string }} filter */
  async ledgerSums({ geoProjectId, since }) {
    const cutoff = since == null ? null : Date.parse(assertAt(since));
    /** @type {Map<string, { orderId: string | null, kind: string, amountCny: number, count: number }>} */
    const sums = new Map();
    for (const row of this.ledger) {
      if (row.geoProjectId !== String(geoProjectId) || (cutoff != null && Date.parse(row.createdAt) < cutoff)) continue;
      const key = `${row.orderId}\u0000${row.kind}`;
      const entry = sums.get(key) ?? { orderId: row.orderId ?? null, kind: row.kind, amountCny: 0, count: 0 };
      entry.amountCny = Math.round((entry.amountCny + row.amountCny) * 100) / 100;
      entry.count += 1;
      sums.set(key, entry);
    }
    return [...sums.values()];
  }

  /** @param {Array<Record<string, any>>} rows @param {string} at */
  async insertPlatformLedgerRows(rows, at) {
    if (rows.length > GEO_MARKET_STORE_LIMITS.ledgerRowsMax) throw storeError("Too many ledger rows in one write.");
    const checked = rows.map((row) => assertLedgerRow({ ...row, userId: null, geoProjectId: null, orderId: null }, assertAt(at)));
    this.ledger.push(...checked);
    return checked.length;
  }

  /** @param {string} since */
  async platformFlowsSince(since) {
    const cutoff = Date.parse(assertAt(since));
    const after = (/** @type {string} */ at) => Date.parse(at) > cutoff;
    const max = GEO_MARKET_STORE_LIMITS.flowsMax;
    const sorted = [...this.events].sort((a, b) => byTime(a.at, b.at));
    return {
      charges: sorted.filter((event) => event.toState === "submitted" && event.fromState !== "submitted" && after(event.at))
        .slice(0, max).map((event) => ({ orderId: event.orderId, amountCny: Number(this.orders.get(event.orderId)?.priceCny ?? 0), at: event.at })),
      refunds: sorted.filter((event) => event.toState === "refunded" && event.fromState !== "refunded" && after(event.at))
        .slice(0, max).map((event) => ({ orderId: event.orderId, amountCny: Number(event.detail?.amountCny ?? 0), at: event.at })),
      topups: [...this.topups.values()].filter((topup) => topup.status === "confirmed" && topup.confirmedAt && after(topup.confirmedAt))
        .sort((a, b) => byTime(a.confirmedAt, b.confirmedAt)).slice(0, max).map((topup) => ({ id: topup.id, amountCny: Number(topup.amountCny ?? 0), at: topup.confirmedAt })),
      adjustments: this.ledger.filter((row) => row.kind === "adjustment" && row.geoProjectId == null && row.orderId == null && after(row.createdAt))
        .sort((a, b) => byTime(a.createdAt, b.createdAt)).slice(0, max).map((row) => ({ id: row.id, amountCny: row.amountCny, at: row.createdAt })),
    };
  }

  // ------------------------------------------------------------ top-ups

  /** @param {{ id?: string, amountCny: number, balanceBefore: number, at: string, note?: string }} request */
  async insertTopup({ id = orderedId("gt_"), amountCny, balanceBefore, at, note }) {
    const when = assertAt(at);
    const amount = assertAmount(amountCny);
    const ledger = assertLedgerRow({ kind: "topup_request", amountCny: amount, note: `topup ${id}` }, when);
    const topup = { id, amountCny: amount, status: "requested", balanceBefore: assertAmount(balanceBefore), balanceAfter: null,
      requestedAt: when, confirmedAt: null, note: note ?? null };
    this.topups.set(id, topup);
    this.ledger.push(ledger);
    return clone(topup);
  }

  /** @param {string} id @param {{ from: string, to: string, at: string, amountCny?: number, balanceAfter?: number, note?: string }} change */
  async updateTopup(id, { from, to, at, amountCny, balanceAfter, note }) {
    assertOneOf(from, TOPUP_STATUSES, "top-up status");
    assertOneOf(to, TOPUP_STATUSES, "top-up status");
    const when = assertAt(at);
    const topup = this.topups.get(String(id));
    if (!topup || topup.status !== from) return null;
    topup.status = to;
    if (amountCny != null) topup.amountCny = assertAmount(amountCny);
    if (balanceAfter != null) topup.balanceAfter = assertAmount(balanceAfter);
    if (to === "confirmed") topup.confirmedAt = when;
    if (note != null) topup.note = String(note).slice(0, 2_000);
    if (to === "confirmed") this.ledger.push(assertLedgerRow({ kind: "topup_confirmed", amountCny: topup.amountCny, note: `topup ${id}` }, when));
    return clone(topup);
  }

  /** @param {string} id @param {string} note */
  async noteTopup(id, note) {
    const topup = this.topups.get(String(id));
    if (!topup) return null;
    topup.note = String(note).slice(0, 2_000);
    return clone(topup);
  }

  /** @param {{ status?: string, limit: number }} filter */
  async listTopups({ status, limit }) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    if (status != null) assertOneOf(status, TOPUP_STATUSES, "top-up status");
    return [...this.topups.values()].filter((topup) => status == null || topup.status === status)
      .sort((a, b) => byTime(b.requestedAt, a.requestedAt) || (a.id < b.id ? -1 : 1)).slice(0, limit).map(clone);
  }

  /** @param {string} id */
  async getTopup(id) {
    return clone(this.topups.get(String(id)) ?? null);
  }

  // ---------------------------------------------------- reconciliations

  async latestReconciliation() {
    const days = [...this.reconciliations.keys()].sort();
    return days.length ? clone(this.reconciliations.get(days.at(-1))) : null;
  }

  /** @param {number} limit */
  async listReconciliations(limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    return [...this.reconciliations.keys()].sort().reverse().slice(0, limit).map((day) => clone(this.reconciliations.get(day)));
  }

  /** @param {Record<string, any>} row */
  async upsertReconciliation({ day, ours, vendor, balance, diff, status, details, at }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw storeError("A reconciliation day is YYYY-MM-DD.");
    assertOneOf(status, ["ok", "mismatch"], "reconciliation status");
    assertDetail(details);
    const row = { day: String(day), ours: assertAmount(ours), vendor: assertAmount(vendor), balance: assertAmount(balance), diff: assertAmount(diff),
      status, details: clone(details), createdAt: assertAt(at) };
    this.reconciliations.set(row.day, row);
    return clone(row);
  }

  /** @param {string} day @param {Record<string, any>} patch */
  async patchReconciliationDetails(day, patch) {
    assertDetail(patch);
    const row = this.reconciliations.get(String(day));
    if (!row) return null;
    row.details = { ...(row.details ?? {}), ...clone(patch) };
    return clone(row);
  }
}


