import { HttpError } from "./security.mjs";
import { APPEAL_REASONS, MEDIA_FIELD_TYPES, MEDIA_TYPES } from "./mediaMarketClient.mjs";
import { compareProtectedSpans, extractProtectedSpans, htmlToText, markdownToHtml, sha256Hex, splitLeadingTitle } from "./geoMarketText.mjs";

/**
 * 「循证 GEO」 distribution: the media marketplace loop (build spec §5, §7).
 * The AI may propose; this module places orders, and only under rules written
 * here in code (ruling 7: money is code, never the model).
 *
 * The loop, one tick function per step (the worker calls them; each is
 * `(deps) => Promise<counts>`):
 *
 *   tickCatalogue  sync both catalogues, name the categories, derive each
 *                  outlet's domain from its case link and verify it by reading
 *                  the case page (resolves, and stays on that domain)
 *   tickOrders     plan placements for publishable articles within budget,
 *                  reserve price × 1.10, send each exactly once
 *   tickPoll       read the vendor's status of every open order, map it, and
 *                  release a refund only when is_refund=1 and the balance moved
 *   tickVerify     at +1 h, +24 h, +48 h after publication read the page and
 *                  compare its protected spans with what was sent; settle when
 *                  it matches, appeal when it does not
 *   tickReconcile  our orders ↔ the vendor's order info ↔ the balance, daily;
 *                  an identity break stops new orders and alerts an operator
 *   tickTopups     request a top-up when the balance falls under three days of
 *                  projected spend, never above the operator's cap
 *
 * Money, in the project's ledger (`available = budget − reserved − settled +
 * refunded`):
 *   reserve  at submit: price × 1.10 (the vendor settles "at the actual price")
 *   settle   at verified: the vendor's final price, and the rest of the
 *            reserve released in the same write; above the reserve → problem,
 *            never paid automatically
 *   release  a reserve given back: send refused or never left this host, a
 *            refund confirmed before settlement, the remainder at settlement
 *   refund   money the vendor returned after settlement
 * so `reserved = Σreserve − Σrelease − Σsettle`.
 *
 * The vendor's balance is checked against the same flows: from the last
 * reconciliation's anchor, expected = anchor − orders accepted (charged) +
 * refunds confirmed + top-ups confirmed ± adjustments. A refund flag is
 * believed when the balance holds that much more than expected; a residual
 * the open orders cannot explain is an identity break. The vendor's charge
 * point is taken to be `send` (prepaid balance) — a question for the vendor.
 *
 * Hidden knowledge:
 * - No idempotency key and no order listing: a send whose outcome is unknown
 *   leaves the order `unknown` for an operator, and blocks that outlet (for
 *   every project — it is one account) until resolved. It is never resent.
 * - An outlet admitted once is re-checked at send time: articles get withdrawn
 *   or a safety finding opens, outlets change price or get blacklisted.
 * - The blacklist rules and remark flags below are closed patterns over the
 *   vendor's own boilerplate remarks, kept as a data table with ids so each
 *   exclusion names its rule (plan §7.1). They exclude outlets; they never
 *   judge an article's prose.
 *
 * @module geoMarket
 */

/** Every constant the market enforces; the plan's numbers, in one place. */
export const MARKET_RULES = Object.freeze({
  reserveMargin: 0.10,
  autoSelectMaxPriceCny: 2_000,
  sameDomainMaxPerWindow: 2,
  sameDomainWindowDays: 30,
  unacceptedWindowHours: 24,
  unpublishedWindowDays: 10,
  autoConfirmHours: 72,
  verifyCheckpointsHours: Object.freeze([1, 24, 48]),
  afterSaleDays: 35,
  lowWaterDays: 3,
  targetWaterDays: 14,
  refundEscalationDays: 3,
  domainRecheckDays: 30,
  domainChecksPerSync: 60,
  catalogPageSize: 100,
  catalogMaxPages: 2_000,
  sendsPerTick: 10,
  verifyPerTick: 20,
  projectsPerTick: 50,
  placementsPerArticle: 1,
  maxFailedPlacementsPerArticle: 3,
  coveragePriceBandCny: Object.freeze([55, 130]),
  epsilonCny: 0.01,
  pageReadTimeoutMs: 60_000,
  categoryCacheMs: 24 * 3_600_000,
});

/** The vendor's order status → our state. A status not here is never guessed. */
export const VENDOR_STATUS_MAP = Object.freeze({
  version: "open-platform-api-2026-09-25",
  map: Object.freeze({ 0: "submitted", 1: "accepted", 2: "published", 4: "rejected", 9: "problem" }),
});

/** Every move an order may make; `transition` refuses any other. */
export const ORDER_TRANSITIONS = Object.freeze({
  planned: Object.freeze(["reserved", "cancelled"]),
  // → planned: the send provably never left this host (refused connection,
  // rate limit, a key file gone); the reserve is released and it goes again.
  reserved: Object.freeze(["submitted", "unknown", "cancelled", "planned"]),
  submitted: Object.freeze(["accepted", "published", "rejected", "cancelled", "problem", "refunded"]),
  accepted: Object.freeze(["published", "rejected", "problem", "refunded"]),
  published: Object.freeze(["verified", "problem", "refunded"]),
  verified: Object.freeze(["settled", "problem", "refunded"]),
  settled: Object.freeze(["problem", "refunded"]),
  unknown: Object.freeze(["submitted", "cancelled"]),
  rejected: Object.freeze(["refunded", "problem", "lost"]),
  cancelled: Object.freeze(["refunded", "problem", "lost"]),
  problem: Object.freeze(["verified", "refunded", "lost"]),
  refunded: Object.freeze([]),
  lost: Object.freeze([]),
});

/**
 * A plan withdrawn before anything was reserved for it (its outlet or its
 * article stopped qualifying, or the user dropped it): no attempt was made,
 * so it neither counts against the article nor excludes its outlet.
 * @param {any} order
 */
function neverAttempted(order) {
  return order.state === "cancelled" && !order.vendorOrderNid && !order.bodySha256;
}

/** Orders that still stand for their article (a new placement waits for them). */
const LIVE_STATES = Object.freeze(["planned", "reserved", "submitted", "accepted", "published", "verified", "settled", "unknown", "problem"]);
/** Orders that count against the same-domain cap. */
const DOMAIN_CAP_STATES = Object.freeze(["planned", "reserved", "submitted", "accepted", "published", "verified", "settled", "unknown", "problem", "lost"]);
/** Orders whose vendor status is still worth reading. */
const POLL_STATES = Object.freeze(["submitted", "accepted", "published", "verified", "settled", "problem", "rejected", "cancelled"]);
/** Problem reasons a later passing check may clear. */
const VERIFICATION_PROBLEMS = new Set(["text_changed", "domain_mismatch", "unreachable"]);

/**
 * Exclusion rules over the vendor's catalogue text (title, remarks, category
 * names). Each is a closed pattern the vendor's boilerplate uses.
 */
export const MARKET_BLACKLIST_RULES = Object.freeze([
  // 「医疗不发」「医疗金融不发」「处方药等内容不发」: the outlet refuses medical content.
  Object.freeze({ id: "refuses_medical", fields: Object.freeze(["remarks", "categories"]),
    pattern: /(?:医疗|医药|药品|处方药)[^，。；,;！!]{0,8}不(?:发|接|收|做)|不(?:发|接|收|做)[^，。；,;！!]{0,6}(?:医疗|医药|药品|处方药)/u }),
  // 「(医疗排名)」 slots hosted on user communities.
  Object.freeze({ id: "community_ranking_slot", fields: Object.freeze(["title", "remarks"]), pattern: /[（(]\s*医疗排名\s*[)）]|医疗排名类/u }),
  // 「可带网址、二维码任何联系方式」: evidence articles never carry contact details, and an outlet that invites them is a marketing slot.
  Object.freeze({ id: "contact_allowed", fields: Object.freeze(["remarks"]),
    pattern: /(?:可|能|允许)(?:带|留|放|加)[^，。；,;]{0,12}(?:联系方式|二维码|电话|微信|网址)/u }),
]);

/** Remark patterns recorded as outlet flags (they inform the score, they exclude nothing). */
const REMARK_FLAGS = Object.freeze({
  silentEdits: /(?:修改|改稿|改动|删改)[^，。；,;]{0,4}不通知|修改严重/u,
  indexingPromise: /包收录/u,
  indexingDisclaimed: /收录不包|不包收录/u,
  weekendYes: /(?:周末|节假日)[^，。；,;]{0,4}(?:可|正常)/u,
  weekendNo: /(?:周末|节假日)[^，。；,;]{0,4}不(?:发|出)/u,
  linkMonth: /(?:链接|时效)[^，。；,;]{0,6}(?:一个月|1个月|30天)/u,
});

/** Category names meaning a medical or health channel, and news-source indexing (closed vocabularies). */
const MEDICAL_CATEGORY_WORDS = Object.freeze(["健康", "医疗", "医药", "医学", "养生"]);
const NEWS_SOURCE_CATEGORY_WORDS = Object.freeze(["新闻源", "百度新闻", "资讯源"]);

/** Multi-label public suffixes a Chinese outlet's domain may sit under. */
const MULTI_LABEL_SUFFIXES = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "mil.cn",
  "bj.cn", "sh.cn", "tj.cn", "cq.cn", "he.cn", "sx.cn", "nm.cn", "ln.cn", "jl.cn", "hl.cn", "js.cn", "zj.cn", "ah.cn", "fj.cn",
  "jx.cn", "sd.cn", "ha.cn", "hb.cn", "hn.cn", "gd.cn", "gx.cn", "hi.cn", "sc.cn", "gz.cn", "yn.cn", "xz.cn", "sn.cn", "gs.cn",
  "qh.cn", "nx.cn", "xj.cn", "com.hk", "org.hk", "gov.hk", "edu.hk", "com.tw", "org.tw", "com.mo",
  "co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "com.sg",
]);

/** @param {string} status @param {string} code @param {string} message */
function marketFailure(status, code, message) {
  return new HttpError(Number(status), code, message);
}

const round2 = (/** @type {number} */ value) => Math.round(value * 100) / 100;
const mediaKey = (/** @type {string} */ mediaType, /** @type {string} */ resourceId) => `${mediaType}:${resourceId}`;

/** The reserve an order of this price holds. @param {number} priceCny */
export function reserveFor(priceCny) {
  return round2(priceCny * (1 + MARKET_RULES.reserveMargin));
}

/**
 * A host's registrable domain (eTLD+1, with the multi-label suffixes above),
 * or null for an IP address or a single label.
 * @param {string | null | undefined} host
 */
export function registrableDomain(host) {
  const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!name || /^[\d.]+$/.test(name) || name.includes(":") || !/^[a-z0-9.-]+$/.test(name)) return null;
  const labels = name.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  return lastTwo;
}

/** @param {string | null | undefined} url */
function hostOf(url) {
  try { return url ? new URL(url).hostname.toLowerCase() : null; } catch { return null; }
}

// ------------------------------------------------------------------ time

/** @param {Date} date @param {string} timeZone */
function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** The calendar day `date` falls on in `timeZone`, as YYYY-MM-DD. @param {Date} date @param {string} timeZone */
export function zonedDay(date, timeZone) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant a zoned day starts. @param {Date} date @param {string} timeZone */
export function zonedDayStart(date, timeZone) {
  const { hour, minute, second } = zonedParts(date, timeZone);
  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000 + date.getUTCMilliseconds();
  return new Date(date.getTime() - elapsed);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- context

/**
 * @typedef {object} MarketDeps
 * @property {any} store a `GeoMarketStore` (or its double)
 * @property {any} [market] a `MediaMarketClient`; absent or unconfigured = no network call
 * @property {{ read: (url: string, options?: { signal?: AbortSignal }) => Promise<{ receipt: any, text: string }> } | null} [webReader]
 * @property {(article: any, project: any) => Promise<{ title?: string, markdown?: string, html?: string }>} [articleBody]
 *   the article's reviewed body (the file behind `articles.path`)
 * @property {(event: Record<string, any>) => Promise<unknown> | unknown} [notify] a user-facing notice (the safety kind)
 * @property {(event: Record<string, any>) => Promise<unknown> | unknown} [alertOperator] an operator alert (money, balance, unknown orders)
 * @property {Record<string, any>} [config] `mediaMarketBalanceCapCny`
 * @property {() => Date} [now]
 * @property {string} [timeZone] default Asia/Shanghai
 */

/** @param {MarketDeps} deps */
function context(deps) {
  if (!deps?.store) throw new TypeError("The market needs its store.");
  const clock = deps.now ?? (() => new Date());
  return {
    store: deps.store,
    market: deps.market ?? null,
    configured: deps.market?.configured === true,
    webReader: deps.webReader ?? null,
    articleBody: deps.articleBody ?? null,
    notify: deps.notify ?? null,
    alertOperator: deps.alertOperator ?? null,
    config: deps.config ?? {},
    timeZone: deps.timeZone ?? "Asia/Shanghai",
    now: () => new Date(clock().getTime()),
  };
}

/** A hook that must never take the loop down with it. @param {Function | null} hook @param {Record<string, any>} event */
async function fire(hook, event) {
  if (!hook) return false;
  try { await hook(event); return true; } catch { return false; }
}

/** @param {any} store @param {Record<string, any>} filter @param {number} [max] */
async function listAllOrders(store, filter, max = 5_000) {
  const rows = [];
  for (let offset = 0; offset < max; offset += 500) {
    const page = await store.listOrders({ ...filter, limit: 500, offset });
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

/**
 * Move an order, refusing a move the table does not allow (a programming
 * error, not a runtime condition). `null` when another writer moved it first.
 * @param {ReturnType<typeof context>} ctx @param {any} order @param {string} to
 * @param {{ detail?: Record<string, any>, patch?: Record<string, any>, ledger?: Array<Record<string, any>> }} [change]
 */
async function transition(ctx, order, to, { detail = {}, patch = {}, ledger = [] } = {}) {
  const allowed = ORDER_TRANSITIONS[/** @type {keyof typeof ORDER_TRANSITIONS} */ (order.state)] ?? [];
  if (!allowed.includes(to)) throw new Error(`An order may not move from ${order.state} to ${to}.`);
  return ctx.store.transitionOrder(order.id, {
    from: [order.state], to, at: ctx.now().toISOString(), detail, patch,
    ledger: ledger.map((row) => ({ ...row, userId: order.userId, geoProjectId: order.geoProjectId })),
  });
}

/** Whether a reserved order's send began after it was reserved (in flight, or interrupted). @param {any} order */
function sendInFlight(order) {
  return order.state === "reserved" && order.sentAt != null && (order.stateAt == null || Date.parse(order.sentAt) >= Date.parse(order.stateAt));
}

/** The reserve an order still holds by its state (what the ledger must agree with). @param {any} order */
function heldReserve(order) {
  switch (order.state) {
    case "reserved": case "submitted": case "accepted": case "published": case "verified": case "unknown": case "rejected":
      return order.reserveCny ?? 0;
    case "problem":
      return order.settledCny == null ? order.reserveCny ?? 0 : 0;
    case "cancelled":
      return order.vendorOrderNid ? order.reserveCny ?? 0 : 0;
    default:
      return 0;
  }
}

// ------------------------------------------------------ catalogue parsing

/**
 * What an outlet's own text says: the blacklist verdict and the flags. The
 * main category (`field_1`, 「媒体分类」) decides whether it is a medical
 * channel; any category may say it is a news source.
 * @param {{ title: string, remarks: string, mainCategoryTitles: string[], categoryTitles: string[] }} text
 */
export function catalogueVerdict({ title, remarks, mainCategoryTitles, categoryTitles }) {
  const fields = { title: String(title ?? ""), remarks: String(remarks ?? ""), categories: categoryTitles.join(" ") };
  const rule = MARKET_BLACKLIST_RULES.find((candidate) => candidate.fields.some((field) => candidate.pattern.test(fields[/** @type {keyof typeof fields} */ (field)])));
  const both = `${fields.title} ${fields.remarks}`;
  const weekend = REMARK_FLAGS.weekendNo.test(both) ? false : REMARK_FLAGS.weekendYes.test(both) ? true : null;
  return {
    blacklisted: Boolean(rule),
    blacklistReason: rule?.id ?? null,
    flags: {
      silentEdits: REMARK_FLAGS.silentEdits.test(both),
      indexingPromise: REMARK_FLAGS.indexingPromise.test(both) && !REMARK_FLAGS.indexingDisclaimed.test(both),
      linkDays: REMARK_FLAGS.linkMonth.test(both) ? 30 : null,
      weekend,
      medicalRefused: rule?.id === "refuses_medical",
      contactAllowed: rule?.id === "contact_allowed",
      medicalCategory: mainCategoryTitles.some((name) => MEDICAL_CATEGORY_WORDS.some((word) => name.includes(word))),
      newsSourceCategory: categoryTitles.some((name) => NEWS_SOURCE_CATEGORY_WORDS.some((word) => name.includes(word))),
    },
  };
}

/**
 * One catalogue row as the platform stores it.
 * @param {ReturnType<typeof import("./mediaMarketClient.mjs").normalizeMediaRow> & {}} raw
 * @param {"website" | "wemedia"} mediaType
 * @param {Map<string, Map<string, string>>} categories field type → id → title
 * @param {any | undefined} existing the stored row, if any
 * @param {string} syncedAt
 */
export function catalogueRow(raw, mediaType, categories, existing, syncedAt) {
  /** @type {Record<string, { ids: string[], titles: string[] }>} */
  const fields = {};
  const titles = [];
  for (const field of MEDIA_FIELD_TYPES) {
    const ids = raw.fields[field] ?? [];
    if (!ids.length) continue;
    const named = ids.map((id) => categories.get(field)?.get(id) ?? null).filter((name) => typeof name === "string");
    fields[field] = { ids, titles: named };
    titles.push(...named);
  }
  const verdict = catalogueVerdict({ title: raw.title, remarks: raw.remarks, mainCategoryTitles: fields.field_1?.titles ?? [], categoryTitles: titles });
  const host = hostOf(raw.caseLink);
  const domain = registrableDomain(host);
  const learnedBlacklist = Number(existing?.flags?.editIncidents ?? 0) >= 3;
  const priceHistory = [...(existing?.priceHistory ?? [])];
  if (existing && existing.priceCny !== raw.priceCny) {
    priceHistory.push({ at: syncedAt, from: existing.priceCny, to: raw.priceCny });
  }
  return {
    resourceId: raw.resourceId,
    mediaType,
    name: raw.title,
    domain,
    // A new domain is unverified until its case page is read again.
    domainVerified: existing && existing.domain === domain ? existing.domainVerified : null,
    icpOwner: existing?.icpOwner ?? null,
    fields,
    priceCny: raw.priceCny,
    publishRate: raw.publishRate,
    publishSeconds: raw.publishSeconds,
    remarks: raw.remarks,
    caseLink: raw.caseLink,
    flags: { ...verdict.flags, host, categories: titles.slice(0, 30), pcWeight: raw.pcWeight, wapWeight: raw.wapWeight },
    available: raw.available,
    blacklisted: verdict.blacklisted || learnedBlacklist,
    blacklistReason: verdict.blacklistReason ?? (learnedBlacklist ? "repeated_text_changes" : null),
    priceHistory: priceHistory.slice(-50),
    syncedAt,
  };
}

// --------------------------------------------------------------- admission

/**
 * Why an article may not be placed at all (empty = it may).
 * @param {any} article
 */
export function articleProblems(article) {
  const problems = [];
  if (!article) return ["article_missing"];
  if (!["publishable", "placed", "published"].includes(article.status)) problems.push("article_not_publishable");
  if (article.isControl) problems.push("control_group_article");
  if (article.safety !== "clear" && article.safety !== "released") problems.push(article.safety === "open" ? "safety_open" : "safety_unreviewed");
  if (article.gate === "failed") problems.push("gate_failed");
  if (!/^[a-f0-9]{64}$/.test(String(article.contentSha256 ?? ""))) problems.push("article_unhashed");
  if (article.layer === "card") problems.push("owned_layer_only");
  return problems;
}

/**
 * Why an outlet may not carry an article (empty = admitted): the three
 * conditions, the blacklist, the price cap, the same-domain cap, an unknown
 * order on the outlet.
 * @param {any} media
 * @param {{ source?: any, domainCount?: number, outletBlocked?: boolean }} context
 */
export function outletProblems(media, { source = null, domainCount = 0, outletBlocked = false } = {}) {
  const problems = [];
  if (!media.available) problems.push("media_unavailable");
  if (media.blacklisted) problems.push(`blacklisted:${media.blacklistReason ?? "rule"}`);
  if (media.flags?.medicalRefused) problems.push("refuses_medical");
  if (media.priceCny == null) problems.push("price_unknown");
  else if (media.priceCny > MARKET_RULES.autoSelectMaxPriceCny) problems.push("price_above_auto_cap");
  if (!media.domain) problems.push("domain_unknown");
  else if (media.domainVerified !== true) problems.push("domain_unverified");
  if (source?.icpMatches === false) problems.push("icp_mismatch");
  if (source?.impostor || source?.blacklistReason) problems.push("impostor");
  const newsIndexed = source?.newsIndexed === false ? false : source?.newsIndexed === true || media.flags?.newsSourceCategory === true;
  if (!newsIndexed) problems.push("not_news_indexed");
  const medical = source?.medicalVertical === false ? false : source?.medicalVertical === true || media.flags?.medicalCategory === true;
  if (!medical) problems.push("not_medical");
  if (domainCount >= MARKET_RULES.sameDomainMaxPerWindow) problems.push("domain_cap_reached");
  if (outletBlocked) problems.push("outlet_unknown_order");
  return problems;
}

/** An article layer's price fit, 0–1. @param {string | null} layer @param {number} price */
function layerFit(layer, price) {
  const [low, high] = MARKET_RULES.coveragePriceBandCny;
  if (layer === "deep") return price >= 300 ? 1 : price >= high ? 0.6 : 0.3;
  if (price >= low && price <= high) return 1;
  if (price >= 20 && price <= 300) return 0.6;
  return 0.2;
}

/**
 * An admitted outlet's score for one article: cited by the project's engines
 * (our own outcomes, then the project's source table), layer fit, price,
 * publish rate and speed, less what we observed going wrong.
 * @param {any} media
 * @param {{ article: any, engines: string[], outcomes: Array<{ engine: string, placed: number, cited: number }>, source?: any }} input
 */
export function scoreOutlet(media, { article, engines, outcomes, source = null }) {
  const wanted = new Set(engines);
  let placed = 0;
  let cited = 0;
  for (const row of outcomes) {
    if (!wanted.has(row.engine)) continue;
    placed += row.placed;
    cited += row.cited;
  }
  const outcomeRate = placed ? Math.min(1, cited / (placed + 1)) : 0;
  let sourceCited = 0;
  for (const [engine, pools] of Object.entries(source?.cited ?? {})) {
    if (!wanted.has(engine) || !pools || typeof pools !== "object") continue;
    for (const count of Object.values(pools)) sourceCited += Number(count) || 0;
  }
  const citedScore = 0.6 * outcomeRate + 0.4 * Math.min(1, sourceCited / 10);
  const price = Number(media.priceCny ?? MARKET_RULES.autoSelectMaxPriceCny);
  const priceScore = Math.max(0, 1 - price / MARKET_RULES.autoSelectMaxPriceCny);
  const publishRate = media.publishRate == null ? 0.5 : Math.min(1, media.publishRate / 100);
  const speed = media.publishSeconds == null ? 0.5 : 1 / (1 + media.publishSeconds / 86_400);
  const penalty = 0.15 * Number(media.flags?.editIncidents ?? 0) + (media.flags?.silentEdits ? 0.05 : 0);
  return round2(1000 * (0.40 * citedScore + 0.20 * layerFit(article?.layer ?? null, price) + 0.15 * priceScore
    + 0.15 * publishRate + 0.10 * speed - penalty)) / 1000;
}

/** The project's registered drug names: the spans a published page must keep. @param {any} project */
export function drugTerms(project) {
  const product = project?.product ?? {};
  const terms = [product.brandName, product.genericName, ...(Array.isArray(product.aliases) ? product.aliases : [])];
  for (const competitor of Array.isArray(project?.competitors) ? project.competitors : []) terms.push(competitor?.brandName, competitor?.genericName);
  return [...new Set(terms.filter((term) => typeof term === "string" && term.trim().length >= 2).map((term) => term.trim()))];
}

// ------------------------------------------------------------ money view

/**
 * A project's money from its ledger sums.
 * @param {any} project @param {Array<{ orderId: string | null, kind: string, amountCny: number }>} sums
 */
export function projectMoney(project, sums) {
  let reserve = 0;
  let release = 0;
  let settle = 0;
  let refund = 0;
  for (const row of sums) {
    if (row.kind === "reserve") reserve += row.amountCny;
    else if (row.kind === "release") release += row.amountCny;
    else if (row.kind === "settle") settle += row.amountCny;
    else if (row.kind === "refund") refund += row.amountCny;
  }
  const budget = project?.budget?.totalCny == null ? null : Number(project.budget.totalCny);
  const reserved = round2(reserve - release - settle);
  return {
    budgetCny: budget,
    dailyCny: project?.budget?.dailyCny == null ? null : Number(project.budget.dailyCny),
    reservedCny: reserved,
    settledCny: round2(settle),
    refundedCny: round2(refund),
    spentCny: round2(settle - refund),
    availableCny: budget == null ? null : round2(budget - reserved - settle + refund),
  };
}

/**
 * Where a project's ledger and its orders disagree: every order's outstanding
 * reserve must equal what its state holds, its settlement must equal the
 * ledger's, and no refund may exceed what was settled.
 * @param {any[]} orders @param {Array<{ orderId: string | null, kind: string, amountCny: number }>} sums
 */
export function projectIdentityBreaks(orders, sums) {
  /** @type {Map<string, { reserve: number, release: number, settle: number, refund: number }>} */
  const byOrder = new Map();
  for (const row of sums) {
    if (!row.orderId || row.kind === "budget_set") continue;
    const entry = byOrder.get(row.orderId) ?? { reserve: 0, release: 0, settle: 0, refund: 0 };
    if (row.kind in entry) entry[/** @type {"reserve"} */ (row.kind)] += row.amountCny;
    byOrder.set(row.orderId, entry);
  }
  const breaks = [];
  const known = new Set();
  const eps = MARKET_RULES.epsilonCny;
  for (const order of orders) {
    known.add(order.id);
    const money = byOrder.get(order.id) ?? { reserve: 0, release: 0, settle: 0, refund: 0 };
    const outstanding = round2(money.reserve - money.release - money.settle);
    const expected = round2(heldReserve(order));
    if (Math.abs(outstanding - expected) > eps) breaks.push({ orderId: order.id, problem: "reserve_mismatch", ledger: outstanding, expected });
    const settled = order.settledCny ?? 0;
    if (Math.abs(round2(money.settle) - round2(settled)) > eps) breaks.push({ orderId: order.id, problem: "settle_mismatch", ledger: round2(money.settle), expected: settled });
    if (money.refund - money.settle > eps) breaks.push({ orderId: order.id, problem: "refund_above_settle" });
  }
  for (const orderId of byOrder.keys()) {
    if (!known.has(orderId)) breaks.push({ orderId, problem: "ledger_without_order" });
  }
  return breaks;
}

// ----------------------------------------------------- vendor balance model

/** @param {any} row a reconciliation row */
function anchorOf(row) {
  return {
    day: row.day,
    balance: Number(row.details?.anchorBalance ?? row.balance),
    at: String(row.details?.observedAt ?? row.createdAt),
  };
}

/** The balance the vendor should hold now, from an anchor and the flows since. @param {ReturnType<typeof context>} ctx @param {{ balance: number, at: string }} anchor */
async function expectedBalance(ctx, anchor) {
  const flows = await ctx.store.platformFlowsSince(anchor.at);
  const sum = (/** @type {Array<{ amountCny: number }>} */ rows) => rows.reduce((total, row) => total + row.amountCny, 0);
  return {
    expected: round2(anchor.balance - sum(flows.charges) + sum(flows.refunds) + sum(flows.topups) + sum(flows.adjustments)),
    flows: {
      charges: { count: flows.charges.length, amountCny: round2(sum(flows.charges)) },
      refunds: { count: flows.refunds.length, amountCny: round2(sum(flows.refunds)) },
      topups: { count: flows.topups.length, amountCny: round2(sum(flows.topups)) },
      adjustments: { count: flows.adjustments.length, amountCny: round2(sum(flows.adjustments)) },
    },
  };
}

/**
 * The anchor every balance expectation starts from; the first one is taken
 * before the first order is ever sent, so every charge is counted after it.
 * @param {ReturnType<typeof context>} ctx
 */
async function ensureAnchor(ctx) {
  const latest = await ctx.store.latestReconciliation();
  if (latest) return anchorOf(latest);
  const { money, powerCount } = await ctx.market.balance();
  const now = ctx.now();
  // Nothing has moved money before the opening, so it may sit a millisecond
  // early: a charge written in the same millisecond still falls after it.
  const observedAt = new Date(now.getTime() - 1).toISOString();
  const row = await ctx.store.upsertReconciliation({
    day: zonedDay(now, ctx.timeZone), ours: money, vendor: money, balance: money, diff: 0, status: "ok",
    details: { kind: "opening", observedAt, anchorBalance: money, powerCount }, at: now.toISOString(),
  });
  return anchorOf(row);
}

/** Whether new orders are stopped: the latest reconciliation broke and no operator cleared it. @param {ReturnType<typeof context>} ctx */
async function stopState(ctx) {
  const latest = await ctx.store.latestReconciliation();
  if (latest?.status === "mismatch" && !latest.details?.clearedAt) return { stopped: true, day: latest.day };
  return { stopped: false, day: latest?.day ?? null };
}

// ---------------------------------------------------------------- catalogue

const categoryCache = new WeakMap();

/** @param {ReturnType<typeof context>} ctx @param {"website" | "wemedia"} mediaType */
async function loadCategories(ctx, mediaType) {
  const cached = categoryCache.get(ctx.market)?.[mediaType];
  if (cached && ctx.now().getTime() - cached.at < MARKET_RULES.categoryCacheMs) return cached.map;
  /** @type {Map<string, Map<string, string>>} */
  const map = new Map();
  for (const field of MEDIA_FIELD_TYPES) {
    try {
      const rows = await ctx.market.fields(mediaType, field);
      map.set(field, new Map(rows.map((row) => [row.id, row.title])));
    } catch {
      // A field the vendor does not name leaves its ids unnamed; the sync goes on.
    }
  }
  const entry = categoryCache.get(ctx.market) ?? {};
  entry[mediaType] = { at: ctx.now().getTime(), map };
  categoryCache.set(ctx.market, entry);
  return map;
}

/**
 * Read an outlet's case page: verified when it resolves and the page stays on
 * the domain its case link names.
 * @param {ReturnType<typeof context>} ctx @param {any} media
 */
async function checkDomain(ctx, media) {
  const checkedAt = ctx.now().toISOString();
  if (!media.caseLink || !media.domain) return { domainVerified: false, flags: { domainCheckedAt: checkedAt, domainCheck: "no_case_link" } };
  try {
    const read = await /** @type {any} */ (ctx.webReader).read(media.caseLink, { signal: AbortSignal.timeout(MARKET_RULES.pageReadTimeoutMs) });
    const finalHost = hostOf(read?.receipt?.finalUrl ?? media.caseLink);
    const matches = registrableDomain(finalHost) === media.domain;
    return { domainVerified: matches, flags: { domainCheckedAt: checkedAt, domainCheck: matches ? "ok" : "left_domain", domainFinalHost: finalHost } };
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    return { domainVerified: false, flags: { domainCheckedAt: checkedAt, domainCheck: "unreachable", domainCheckError: typeof code === "string" ? code : "failed" } };
  }
}

/**
 * Sync both catalogues, then verify the domains of outlets that could be
 * placed (a bounded number per sync, medical categories first).
 * @param {MarketDeps} deps
 */
export async function tickCatalogue(deps) {
  const ctx = context(deps);
  if (!ctx.configured) return { skipped: "market_unconfigured" };
  const counts = { rows: 0, pages: 0, invalid: 0, blacklisted: 0, priceChanges: 0, unavailable: 0, complete: /** @type {Record<string, boolean>} */ ({}),
    domainChecks: 0, domainsVerified: 0, errors: /** @type {string[]} */ ([]) };
  for (const mediaType of MEDIA_TYPES) {
    const categories = await loadCategories(ctx, /** @type {"website" | "wemedia"} */ (mediaType));
    const started = ctx.now().toISOString();
    let complete = false;
    try {
      for (let page = 1; page <= MARKET_RULES.catalogMaxPages; page += 1) {
        const before = ctx.market.counters?.invalidRows ?? 0;
        const { rows, received } = await ctx.market.mediaList(mediaType, { page, pageSize: MARKET_RULES.catalogPageSize });
        counts.pages += 1;
        counts.invalid += (ctx.market.counters?.invalidRows ?? 0) - before;
        if (!received) { complete = true; break; }
        const existing = new Map((await ctx.store.getMediaRows(mediaType, rows.map((row) => row.resourceId))).map((row) => [row.resourceId, row]));
        const syncedAt = ctx.now().toISOString();
        const mapped = rows.map((row) => catalogueRow(row, /** @type {"website" | "wemedia"} */ (mediaType), categories, existing.get(row.resourceId), syncedAt));
        for (const row of mapped) {
          if (row.blacklisted) counts.blacklisted += 1;
          const stored = existing.get(row.resourceId);
          if (stored && stored.priceCny !== row.priceCny) counts.priceChanges += 1;
        }
        await ctx.store.upsertMediaRows(mapped);
        counts.rows += mapped.length;
        if (received < MARKET_RULES.catalogPageSize) { complete = true; break; }
      }
    } catch (error) {
      counts.errors.push(`${mediaType}:${/** @type {any} */ (error)?.code ?? "failed"}`);
    }
    counts.complete[mediaType] = complete;
    // Only a sync that saw every page may say what is gone.
    if (complete) counts.unavailable += await ctx.store.markUnseenMediaUnavailable(mediaType, started);
  }
  if (ctx.webReader) {
    const recheckBefore = ctx.now().getTime() - MARKET_RULES.domainRecheckDays * DAY;
    const due = (await ctx.store.listCandidateMedia({ maxPriceCny: MARKET_RULES.autoSelectMaxPriceCny, limit: 5_000 }))
      .filter((media) => !media.flags?.medicalRefused && (media.domainVerified == null || !media.flags?.domainCheckedAt
        || Date.parse(media.flags.domainCheckedAt) < recheckBefore))
      .sort((a, b) => Number(Boolean(b.flags?.medicalCategory)) - Number(Boolean(a.flags?.medicalCategory)))
      .slice(0, MARKET_RULES.domainChecksPerSync);
    for (const media of due) {
      const verdict = await checkDomain(ctx, media);
      await ctx.store.updateMediaFlags({ mediaType: media.mediaType, resourceId: media.resourceId, domainVerified: verdict.domainVerified, flags: verdict.flags });
      counts.domainChecks += 1;
      if (verdict.domainVerified) counts.domainsVerified += 1;
    }
  }
  return counts;
}

// ------------------------------------------------------------------ orders

/** @param {ReturnType<typeof context>} ctx */
async function blockedOutlets(ctx) {
  const unknown = await ctx.store.listOrders({ states: ["unknown"], limit: 500 });
  return new Set(unknown.map((order) => mediaKey(order.mediaType, order.resourceId)));
}

/** @param {ReturnType<typeof context>} ctx @param {string[]} domains @param {string} geoProjectId */
async function sourcesByDomain(ctx, geoProjectId, domains) {
  /** @type {Map<string, any>} */
  const map = new Map();
  const unique = [...new Set(domains.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 1_000) {
    for (const source of await ctx.store.getSources(geoProjectId, unique.slice(index, index + 1_000))) map.set(source.domain, source);
  }
  return map;
}

/** @param {Map<string, any>} sources @param {any} media */
function sourceFor(sources, media) {
  return sources.get(media.domain) ?? sources.get(media.flags?.host ?? "") ?? null;
}

/**
 * The project's orders counted against the same-domain cap: planned or placed
 * in the last 30 days, per outlet domain.
 * @param {ReturnType<typeof context>} ctx @param {string} geoProjectId @param {Map<string, any>} mediaByKey
 */
async function domainUsage(ctx, geoProjectId, mediaByKey) {
  const since = new Date(ctx.now().getTime() - MARKET_RULES.sameDomainWindowDays * DAY).toISOString();
  const orders = await listAllOrders(ctx.store, { geoProjectId, states: [...DOMAIN_CAP_STATES], createdSince: since });
  const missing = orders.filter((order) => !mediaByKey.has(mediaKey(order.mediaType, order.resourceId)));
  for (const mediaType of MEDIA_TYPES) {
    const ids = missing.filter((order) => order.mediaType === mediaType).map((order) => order.resourceId);
    for (let index = 0; index < ids.length; index += 1_000) {
      for (const media of await ctx.store.getMediaRows(mediaType, ids.slice(index, index + 1_000))) mediaByKey.set(mediaKey(media.mediaType, media.resourceId), media);
    }
  }
  /** @type {Map<string, number>} */
  const usage = new Map();
  for (const order of orders) {
    const domain = mediaByKey.get(mediaKey(order.mediaType, order.resourceId))?.domain;
    if (domain) usage.set(domain, (usage.get(domain) ?? 0) + 1);
  }
  return { usage, orders };
}

/** What today's reserves already hold for a project. @param {ReturnType<typeof context>} ctx @param {string} geoProjectId */
async function reservedToday(ctx, geoProjectId) {
  const since = zonedDayStart(ctx.now(), ctx.timeZone).toISOString();
  const sums = await ctx.store.ledgerSums({ geoProjectId, since });
  return round2(sums.filter((row) => row.kind === "reserve").reduce((total, row) => total + row.amountCny, 0));
}

/**
 * Plan placements for one project's publishable articles: one outlet per
 * article that has no live order, the best-scoring admitted outlet whose
 * reserve fits what the budget has left.
 * @param {ReturnType<typeof context>} ctx @param {any} project @param {any[]} candidates
 * @param {Set<string>} blocked @param {Record<string, any>} counts
 */
async function planProject(ctx, project, candidates, blocked, counts) {
  const articles = await ctx.store.listPlaceableArticles(project.id, 200);
  if (!articles.length) return;
  const mediaByKey = new Map(candidates.map((media) => [mediaKey(media.mediaType, media.resourceId), media]));
  const { usage, orders: recent } = await domainUsage(ctx, project.id, mediaByKey);
  const articleOrders = await listAllOrders(ctx.store, { geoProjectId: project.id, articleIds: articles.map((article) => article.id) }, 2_000);
  const money = projectMoney(project, await ctx.store.ledgerSums({ geoProjectId: project.id }));
  const plannedReserve = articleOrders.filter((order) => order.state === "planned").reduce((total, order) => total + (order.reserveCny ?? 0), 0);
  let room = round2((money.availableCny ?? 0) - plannedReserve);
  const hard = candidates.filter((media) => media.available && !media.blacklisted && !media.flags?.medicalRefused
    && media.domainVerified === true && media.priceCny != null && media.priceCny <= MARKET_RULES.autoSelectMaxPriceCny);
  const sources = await sourcesByDomain(ctx, project.id, hard.flatMap((media) => [media.domain, media.flags?.host]));
  const outcomes = new Map();
  for (let index = 0; index < hard.length; index += 1_000) {
    for (const row of await ctx.store.getMediaOutcomes(hard.slice(index, index + 1_000).map((media) => ({ mediaType: media.mediaType, resourceId: media.resourceId })))) {
      const key = mediaKey(row.mediaType, row.resourceId);
      outcomes.set(key, [...(outcomes.get(key) ?? []), row]);
    }
  }
  const plans = [];
  const ordered = [...articles].sort((a, b) => Number(b.layer === "correction") - Number(a.layer === "correction"));
  for (const article of ordered) {
    const mine = articleOrders.filter((order) => order.articleId === article.id && !neverAttempted(order));
    const live = mine.filter((order) => LIVE_STATES.includes(order.state));
    const failed = mine.filter((order) => !LIVE_STATES.includes(order.state));
    if (live.length >= MARKET_RULES.placementsPerArticle) continue;
    if (failed.length >= MARKET_RULES.maxFailedPlacementsPerArticle) { counts.skipped.article_attempts_exhausted = (counts.skipped.article_attempts_exhausted ?? 0) + 1; continue; }
    const problems = articleProblems(article);
    if (problems.length) { for (const problem of problems) counts.skipped[problem] = (counts.skipped[problem] ?? 0) + 1; continue; }
    const excluded = new Set(mine.map((order) => mediaKey(order.mediaType, order.resourceId)));
    const ranked = hard
      .filter((media) => !excluded.has(mediaKey(media.mediaType, media.resourceId)))
      .filter((media) => outletProblems(media, {
        source: sourceFor(sources, media),
        domainCount: usage.get(media.domain) ?? 0,
        outletBlocked: blocked.has(mediaKey(media.mediaType, media.resourceId)),
      }).length === 0)
      // A second article on a domain the project already used counts about
      // half (the owner's reference: 第二篇只算半篇效果), so reuse is discounted.
      .map((media) => ({ media, score: scoreOutlet(media, {
        article, engines: project.engines ?? [], outcomes: outcomes.get(mediaKey(media.mediaType, media.resourceId)) ?? [], source: sourceFor(sources, media),
      }) / (1 + (usage.get(media.domain) ?? 0)) }))
      .sort((a, b) => b.score - a.score || (a.media.priceCny ?? 0) - (b.media.priceCny ?? 0));
    const pick = ranked.find(({ media }) => reserveFor(media.priceCny) <= room + MARKET_RULES.epsilonCny);
    if (!pick) { counts.skipped[ranked.length ? "budget_exhausted" : "no_admitted_outlet"] = (counts.skipped[ranked.length ? "budget_exhausted" : "no_admitted_outlet"] ?? 0) + 1; continue; }
    const reserve = reserveFor(pick.media.priceCny);
    room = round2(room - reserve);
    usage.set(pick.media.domain, (usage.get(pick.media.domain) ?? 0) + 1);
    plans.push({
      userId: project.userId, geoProjectId: project.id, articleId: article.id, mediaType: pick.media.mediaType, resourceId: pick.media.resourceId,
      priceCny: pick.media.priceCny, reserveCny: reserve,
      detail: { score: pick.score, domain: pick.media.domain, layer: article.layer, recentOrders: recent.length },
    });
  }
  for (let index = 0; index < plans.length; index += 100) {
    counts.planned += (await ctx.store.insertOrders(plans.slice(index, index + 100), ctx.now().toISOString())).length;
  }
}

/**
 * Plans whose article stopped being placeable, or whose outlet stopped being
 * admissible, are withdrawn before anything is reserved for them.
 * @param {ReturnType<typeof context>} ctx @param {any} project @param {Map<string, any>} candidatesByKey @param {Record<string, any>} counts
 */
async function withdrawStalePlans(ctx, project, candidatesByKey, counts) {
  const planned = await listAllOrders(ctx.store, { geoProjectId: project.id, states: ["planned"] }, 2_000);
  if (!planned.length) return;
  const articles = new Map((await ctx.store.getArticles(planned.map((order) => order.articleId))).map((article) => [article.id, article]));
  for (const order of planned) {
    const media = candidatesByKey.get(mediaKey(order.mediaType, order.resourceId));
    const articleIssues = articleProblems(articles.get(order.articleId));
    const reason = articleIssues[0] ?? (!media ? "outlet_withdrawn" : media.priceCny !== order.priceCny ? "price_changed" : null);
    if (!reason) continue;
    if (await transition(ctx, order, "cancelled", { detail: { reason: `plan_withdrawn:${reason}` } })) counts.withdrawn += 1;
  }
}

/**
 * A send that started and never recorded its outcome (the process died in
 * between) is `unknown`: it may have reached the vendor.
 * @param {ReturnType<typeof context>} ctx
 */
async function recoverInterruptedSends(ctx) {
  const reserved = await ctx.store.listOrders({ states: ["reserved"], limit: 500 });
  let recovered = 0;
  for (const order of reserved.filter(sendInFlight)) {
    if (await transition(ctx, order, "unknown", { detail: { reason: "send_interrupted" } })) {
      recovered += 1;
      await fire(ctx.alertOperator, { type: "order_unknown", orderId: order.id, reason: "send_interrupted", idempotencyKey: `geo:order:${order.id}:unknown` });
    }
  }
  return recovered;
}

/**
 * Reserve, then send one planned order exactly once.
 * @param {ReturnType<typeof context>} ctx @param {any} project @param {any} order
 * @param {{ balance: number, blocked: Set<string>, candidatesByKey: Map<string, any> }} state
 * @returns {Promise<string>} what happened, for the counts
 */
async function placeOrder(ctx, project, order, state) {
  /** A plan that no longer qualifies is withdrawn, and the next tick plans afresh. @param {string} reason */
  const withdraw = async (reason) => {
    await transition(ctx, order, "cancelled", { detail: { reason: `plan_withdrawn:${reason}` } });
    return reason;
  };
  const [article] = await ctx.store.getArticles([order.articleId]);
  if (articleProblems(article).length) return withdraw("article_not_placeable");
  const media = state.candidatesByKey.get(mediaKey(order.mediaType, order.resourceId));
  if (!media || media.priceCny !== order.priceCny) return withdraw("outlet_changed");
  if (state.blocked.has(mediaKey(order.mediaType, order.resourceId))) return withdraw("outlet_unknown_order");
  const sources = await sourcesByDomain(ctx, project.id, [media.domain, media.flags?.host]);
  const { usage } = await domainUsage(ctx, project.id, new Map([[mediaKey(media.mediaType, media.resourceId), media]]));
  // This plan is itself counted in the usage; the cap applies to the others.
  const others = (usage.get(media.domain) ?? 0) - 1;
  if (outletProblems(media, { source: sourceFor(sources, media), domainCount: others }).length) return withdraw("outlet_not_admitted");
  const money = projectMoney(project, await ctx.store.ledgerSums({ geoProjectId: project.id }));
  if ((money.availableCny ?? 0) + MARKET_RULES.epsilonCny < order.reserveCny) return "budget_exhausted";
  if (money.dailyCny != null && (await reservedToday(ctx, project.id)) + order.reserveCny > money.dailyCny + MARKET_RULES.epsilonCny) return "daily_cap_reached";
  if (state.balance + MARKET_RULES.epsilonCny < order.priceCny) return "insufficient_platform_balance";
  if (!ctx.articleBody) return "article_body_unavailable";
  let body;
  try { body = await ctx.articleBody(article, project); } catch { return "article_body_unavailable"; }
  const source = typeof body?.markdown === "string" ? body.markdown : typeof body?.html === "string" ? body.html : null;
  if (source == null) return "article_body_unavailable";
  // What goes out must be what passed review (decision 7: the post-rewrite hash).
  if (sha256Hex(source) !== article.contentSha256) return "article_changed_since_review";
  const split = typeof body.markdown === "string" ? splitLeadingTitle(body.markdown) : null;
  const contentHtml = split ? markdownToHtml(split.body) : String(body.html);
  const title = String(body.title || split?.title || article.title || "").trim().slice(0, 200);
  if (!title) return "article_untitled";
  const spans = extractProtectedSpans(htmlToText(contentHtml), { terms: drugTerms(project) });
  const bodySha256 = sha256Hex(contentHtml);
  const reserved = await transition(ctx, order, "reserved", {
    detail: { reserveCny: order.reserveCny, priceCny: order.priceCny, chargeAt: "submit" },
    patch: { bodySha256 },
    ledger: [{ kind: "reserve", amountCny: order.reserveCny }],
  });
  if (!reserved) return "conflict";
  // Written (and committed) before the network call: a crash after this line
  // leaves an order that recovery turns `unknown`, never one that is sent twice.
  await ctx.store.annotateOrder(order.id, {
    at: ctx.now().toISOString(),
    detail: { phase: "send_started", title, bodySha256, spans, spanCount: spans.length, terms: drugTerms(project).slice(0, 50) },
  });
  const current = await ctx.store.getOrder(order.id);
  try {
    const { orderNid } = await ctx.market.send(order.mediaType, {
      resourceId: order.resourceId, title, contentHtml, thirdId: order.id,
      remark: "医学稿件：请勿改动数字、药名、剂量、引用与链接。",
    });
    await transition(ctx, current, "submitted", { patch: { vendorOrderNid: orderNid }, detail: { vendorOrderNid: orderNid, mappingVersion: VENDOR_STATUS_MAP.version } });
    await ctx.store.advanceArticleStatus(article.id, ["publishable"], "placed", ctx.now().toISOString());
    state.balance = round2(state.balance - order.priceCny);
    return "submitted";
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === "media_market_refused") {
      await transition(ctx, current, "cancelled", {
        detail: { reason: "send_refused", vendorMessage: /** @type {any} */ (error).vendorMessage ?? "" },
        ledger: [{ kind: "release", amountCny: order.reserveCny, note: "send refused" }],
      });
      return "refused";
    }
    if (["media_market_unreachable", "media_market_rate_limited", "media_market_unauthorized", "media_market_http_error",
      "media_market_unconfigured", "media_market_request_invalid"].includes(code)) {
      // Provably not created: the reserve goes back and the plan waits for the next tick.
      await transition(ctx, current, "planned", {
        detail: { reason: "send_not_delivered", code },
        ledger: [{ kind: "release", amountCny: order.reserveCny, note: "send not delivered" }],
      });
      if (code === "media_market_unauthorized") await fire(ctx.alertOperator, { type: "market_unauthorized", idempotencyKey: `geo:market:unauthorized:${zonedDay(ctx.now(), ctx.timeZone)}` });
      return "not_delivered";
    }
    // Anything else may have reached the vendor: never resend.
    await transition(ctx, current, "unknown", { detail: { reason: code ?? "send_outcome_unknown" } });
    state.blocked.add(mediaKey(order.mediaType, order.resourceId));
    await fire(ctx.alertOperator, { type: "order_unknown", orderId: order.id, reason: code ?? "send_outcome_unknown", idempotencyKey: `geo:order:${order.id}:unknown` });
    return "unknown";
  }
}

/**
 * Plan and place: for every active project with a budget, plan placements
 * for its publishable articles, then (market configured, orders not stopped)
 * reserve and send up to `sendsPerTick` of them.
 * @param {MarketDeps} deps
 */
export async function tickOrders(deps) {
  const ctx = context(deps);
  /** @type {{ projects: number, planned: number, withdrawn: number, recovered: number, submitted: number, unknown: number, refused: number,
   *   notDelivered: number, skipped: Record<string, number> }} */
  const counts = { projects: 0, planned: 0, withdrawn: 0, recovered: 0, submitted: 0, unknown: 0, refused: 0, notDelivered: 0, skipped: {} };
  const skip = (/** @type {string} */ reason) => { counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1; };
  const projects = await ctx.store.listBudgetedProjects(MARKET_RULES.projectsPerTick);
  if (!projects.length) return counts;
  if (ctx.configured) counts.recovered = await recoverInterruptedSends(ctx);
  const candidates = await ctx.store.listCandidateMedia({ maxPriceCny: MARKET_RULES.autoSelectMaxPriceCny, limit: 5_000 });
  const candidatesByKey = new Map(candidates.map((media) => [mediaKey(media.mediaType, media.resourceId), media]));
  const blocked = await blockedOutlets(ctx);
  const stop = ctx.configured ? await stopState(ctx) : { stopped: false };
  /** @type {number | null} */
  let balance = null;
  let sends = 0;
  for (const project of projects) {
    counts.projects += 1;
    await withdrawStalePlans(ctx, project, candidatesByKey, counts);
    await planProject(ctx, project, candidates, blocked, counts);
    if (!ctx.configured) { skip("market_unconfigured"); continue; }
    if (stop.stopped) { skip("orders_stopped"); continue; }
    const planned = await ctx.store.listOrders({ geoProjectId: project.id, states: ["planned"], limit: MARKET_RULES.sendsPerTick });
    for (const order of planned) {
      if (sends >= MARKET_RULES.sendsPerTick) break;
      if (balance == null) {
        try {
          await ensureAnchor(ctx);
          balance = (await ctx.market.balance()).money;
        } catch { skip("balance_unavailable"); break; }
      }
      const state = { balance: /** @type {number} */ (balance), blocked, candidatesByKey };
      const outcome = await placeOrder(ctx, project, order, state);
      balance = state.balance;
      if (["submitted", "unknown", "refused", "not_delivered"].includes(outcome)) sends += 1;
      if (outcome === "submitted") counts.submitted += 1;
      else if (outcome === "unknown") counts.unknown += 1;
      else if (outcome === "refused") counts.refused += 1;
      else if (outcome === "not_delivered") counts.notDelivered += 1;
      else skip(outcome);
    }
  }
  return counts;
}

// --------------------------------------------------------------------- poll

/**
 * Apply one vendor row to one order. Returns the order as it now stands.
 * @param {ReturnType<typeof context>} ctx @param {any} order @param {ReturnType<typeof import("./mediaMarketClient.mjs").normalizeOrderRow> & {}} info
 * @param {Record<string, number>} counts
 */
async function applyVendorStatus(ctx, order, info, counts) {
  let current = order;
  if (info.priceCny != null && current.priceCny != null && Math.abs(info.priceCny - current.priceCny) > MARKET_RULES.epsilonCny) {
    await ctx.store.annotateOrder(current.id, { at: ctx.now().toISOString(), detail: { phase: "price_changed", from: current.priceCny, to: info.priceCny }, patch: { priceCny: info.priceCny } });
    current = { ...current, priceCny: info.priceCny };
  }
  const mapped = info.status == null ? undefined : VENDOR_STATUS_MAP.map[/** @type {keyof typeof VENDOR_STATUS_MAP.map} */ (info.status)];
  const move = async (/** @type {string} */ to, /** @type {Record<string, any>} */ detail = {}, /** @type {Record<string, any>} */ patch = {}) => {
    const moved = await transition(ctx, current, to, { detail: { vendorStatus: info.status, mappingVersion: VENDOR_STATUS_MAP.version, ...detail }, patch });
    if (moved) { counts.transitions += 1; current = moved; }
  };
  const vendorNotes = { rejectionInfo: info.rejectionInfo || undefined, refundInfo: info.refundInfo || undefined, rewriteInfo: info.rewriteInfo || undefined };
  if (mapped === undefined) {
    // A status the mapping does not know is a question for a human, not a guess.
    if (current.state !== "problem" && ORDER_TRANSITIONS[/** @type {keyof typeof ORDER_TRANSITIONS} */ (current.state)]?.includes("problem")) {
      await move("problem", { reason: "unmapped_vendor_status" });
      counts.unmapped += 1;
    }
    return current;
  }
  if (mapped === "submitted") {
    if (["accepted", "published", "verified", "settled"].includes(current.state)) await move("problem", { reason: "vendor_status_regressed" });
  } else if (mapped === "accepted") {
    if (current.state === "submitted") await move("accepted", vendorNotes);
    else if (current.state === "cancelled") await move("problem", { reason: "cancel_not_honoured" });
  } else if (mapped === "published") {
    if (["submitted", "accepted"].includes(current.state) && info.orderUrl) {
      await move("published", { orderUrl: info.orderUrl }, { publishedUrl: info.orderUrl });
    } else if (["published", "verified", "settled"].includes(current.state) && info.orderUrl && info.orderUrl !== current.publishedUrl) {
      await ctx.store.annotateOrder(current.id, { at: ctx.now().toISOString(), detail: { phase: "url_changed", from: current.publishedUrl, to: info.orderUrl }, patch: { publishedUrl: info.orderUrl } });
      current = { ...current, publishedUrl: info.orderUrl };
    } else if (current.state === "cancelled") {
      await move("problem", { reason: "cancel_not_honoured" });
    }
  } else if (mapped === "rejected") {
    if (["submitted", "accepted"].includes(current.state)) await move("rejected", vendorNotes);
    else if (["published", "verified", "settled"].includes(current.state)) await move("problem", { reason: "withdrawn_by_outlet", ...vendorNotes });
  } else if (mapped === "problem") {
    if (["submitted", "accepted", "published", "verified", "settled", "rejected", "cancelled"].includes(current.state)) await move("problem", { reason: "vendor_after_sale", ...vendorNotes });
  }
  return current;
}

/**
 * Release refunds the vendor flagged, as far as the balance shows the money.
 * @param {ReturnType<typeof context>} ctx @param {Array<{ order: any, amountCny: number }>} queue @param {Record<string, number>} counts
 */
async function confirmRefunds(ctx, queue, counts) {
  if (!queue.length) return;
  const anchor = await ensureAnchor(ctx);
  const { money } = await ctx.market.balance();
  const { expected } = await expectedBalance(ctx, anchor);
  let surplus = round2(money - expected);
  const now = ctx.now();
  for (const { order, amountCny } of queue) {
    if (surplus + MARKET_RULES.epsilonCny >= amountCny) {
      const ledger = order.settledCny != null
        ? [{ kind: "refund", amountCny: round2(Math.min(amountCny, order.settledCny)) }]
        : heldReserve(order) > 0 ? [{ kind: "release", amountCny: heldReserve(order), note: "refund confirmed" }] : [];
      const moved = await transition(ctx, order, "refunded", { detail: { amountCny, evidence: "is_refund_and_balance", surplusBefore: surplus }, ledger });
      if (moved) {
        surplus = round2(surplus - amountCny);
        counts.refunds += 1;
      }
      continue;
    }
    counts.pendingRefunds += 1;
    const events = await ctx.store.listOrderEvents(order.id, 500);
    const seen = events.find((event) => event.detail?.phase === "refund_seen");
    if (!seen) {
      await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "refund_seen", amountCny, surplus } });
    } else if (now.getTime() - Date.parse(seen.at) > MARKET_RULES.refundEscalationDays * DAY && !events.some((event) => event.detail?.phase === "refund_escalated")) {
      await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "refund_escalated", amountCny, surplus } });
      await fire(ctx.alertOperator, { type: "refund_not_in_balance", orderId: order.id, amountCny, idempotencyKey: `geo:order:${order.id}:refund_escalated` });
    }
  }
}

/**
 * Read the vendor's status of every order it may still change, map it, and
 * act on the windows: unaccepted for 24 h → withdraw; accepted but not
 * published for 10 days → a problem for an operator.
 * @param {MarketDeps} deps
 */
export async function tickPoll(deps) {
  const ctx = context(deps);
  if (!ctx.configured) return { skipped: "market_unconfigured" };
  const counts = { polled: 0, transitions: 0, missing: 0, unmapped: 0, refunds: 0, pendingRefunds: 0, withdrawn: 0, windowProblems: 0, recovered: 0, errors: 0 };
  counts.recovered = await recoverInterruptedSends(ctx);
  const now = ctx.now();
  const afterSale = now.getTime() - MARKET_RULES.afterSaleDays * DAY;
  const orders = (await listAllOrders(ctx.store, { states: [...POLL_STATES], hasVendorNid: true }))
    .filter((order) => order.state !== "settled" || Date.parse(order.stateAt ?? order.updatedAt) >= afterSale);
  /** @type {Array<{ order: any, amountCny: number }>} */
  const refundQueue = [];
  for (const mediaType of MEDIA_TYPES) {
    const mine = orders.filter((order) => order.mediaType === mediaType);
    for (let index = 0; index < mine.length; index += 50) {
      const batch = mine.slice(index, index + 50);
      let rows;
      try { rows = await ctx.market.orderInfo(mediaType, batch.map((order) => order.vendorOrderNid)); } catch { counts.errors += 1; continue; }
      const byNid = new Map(rows.map((row) => [row.orderNid, row]));
      for (const order of batch) {
        counts.polled += 1;
        const info = byNid.get(order.vendorOrderNid);
        if (!info) { counts.missing += 1; continue; }
        const current = await applyVendorStatus(ctx, order, info, counts);
        if (info.isRefund && !["refunded", "lost"].includes(current.state)) {
          refundQueue.push({ order: current, amountCny: info.priceCny ?? current.priceCny ?? 0 });
        }
      }
    }
  }
  try { await confirmRefunds(ctx, refundQueue, counts); } catch { counts.errors += 1; }
  // Windows.
  const events = async (/** @type {any} */ order) => ctx.store.listOrderEvents(order.id, 500);
  // Withdrawn or rejected, and no refund in sight after the escalation window:
  // the reserve stays held (no money is assumed back) and an operator is told once.
  const awaiting = await ctx.store.listOrders({ states: ["rejected", "cancelled"], hasVendorNid: true, limit: 500 });
  for (const order of awaiting) {
    if (!order.stateAt || now.getTime() - Date.parse(order.stateAt) <= MARKET_RULES.refundEscalationDays * DAY) continue;
    if ((await events(order)).some((event) => event.detail?.phase === "refund_escalated")) continue;
    await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "refund_escalated", reason: "no_refund_flag" } });
    await fire(ctx.alertOperator, { type: "refund_overdue", orderId: order.id, idempotencyKey: `geo:order:${order.id}:refund_escalated` });
  }
  const stale = await ctx.store.listOrders({ states: ["submitted", "accepted"], limit: 500 });
  for (const order of stale) {
    if (order.state === "submitted" && order.submittedAt && now.getTime() - Date.parse(order.submittedAt) > MARKET_RULES.unacceptedWindowHours * HOUR) {
      if ((await events(order)).some((event) => event.detail?.phase === "auto_cancel")) continue;
      let outcome = "cancelled";
      try { await ctx.market.cancelOrder(order.mediaType, order.vendorOrderNid); } catch (error) { outcome = /** @type {any} */ (error)?.code ?? "failed"; }
      await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "auto_cancel", window: "unaccepted_24h", outcome } });
      if (outcome === "cancelled" && await transition(ctx, order, "cancelled", { detail: { reason: "unaccepted_24h" } })) counts.withdrawn += 1;
    } else if (order.state === "accepted" && order.acceptedAt && now.getTime() - Date.parse(order.acceptedAt) > MARKET_RULES.unpublishedWindowDays * DAY) {
      let outcome = "cancelled";
      try { await ctx.market.cancelOrder(order.mediaType, order.vendorOrderNid); } catch (error) { outcome = /** @type {any} */ (error)?.code ?? "failed"; }
      if (await transition(ctx, order, "problem", { detail: { reason: "unpublished_10d", cancel: outcome } })) {
        counts.windowProblems += 1;
        await fire(ctx.alertOperator, { type: "order_unpublished", orderId: order.id, idempotencyKey: `geo:order:${order.id}:unpublished` });
      }
    }
  }
  return counts;
}

// ------------------------------------------------------------------ verify

/** The latest checkpoint due and not yet done, or null. @param {any} order @param {Date} now */
export function dueCheckpoint(order, now) {
  if (!order.publishedAt || !order.publishedUrl) return null;
  const published = Date.parse(order.publishedAt);
  const done = new Set((order.checks ?? []).map((check) => check.checkpoint));
  let due = null;
  for (const hours of MARKET_RULES.verifyCheckpointsHours) {
    if (now.getTime() >= published + hours * HOUR && !done.has(`${hours}h`)) due = `${hours}h`;
  }
  // A later checkpoint done means the earlier ones are past.
  if (due && [...done].some((label) => Number.parseInt(label, 10) > Number.parseInt(due, 10))) return null;
  return due;
}

/**
 * File one appeal, once per reason per order.
 * @param {ReturnType<typeof context>} ctx @param {any} order @param {"text_changed" | "domain_mismatch" | "unreachable"} reason
 * @param {string} info @param {string} checkpoint
 */
async function fileAppeal(ctx, order, reason, info, checkpoint) {
  if (order.appeal?.reason === reason && order.appeal?.result === "filed") return order.appeal;
  const titleId = reason === "unreachable" ? APPEAL_REASONS.linkUnreachable : APPEAL_REASONS.resultMismatch;
  const windowClosed = ctx.now().getTime() > Date.parse(order.publishedAt) + MARKET_RULES.autoConfirmHours * HOUR;
  const appeal = { reason, titleId, checkpoint, filedAt: ctx.now().toISOString(), windowClosed, result: "filed", vendorMessage: "" };
  try {
    const answer = await ctx.market.appeal(order.mediaType, order.vendorOrderNid, { titleId, info });
    appeal.vendorMessage = answer.msg ?? "";
  } catch (error) {
    appeal.result = /** @type {any} */ (error)?.code === "media_market_refused" ? "refused" : "failed";
    appeal.vendorMessage = /** @type {any} */ (error)?.vendorMessage ?? "";
  }
  return appeal;
}

/**
 * Settle a verified order at the vendor's final price, releasing the rest of
 * the reserve in the same write; a price above the reserve is a problem.
 * @param {ReturnType<typeof context>} ctx @param {any} order
 */
async function settleOrder(ctx, order) {
  const price = order.priceCny ?? 0;
  if (order.settledCny != null) return transition(ctx, order, "settled", { detail: { reason: "already_settled" } });
  if (price > (order.reserveCny ?? 0) + MARKET_RULES.epsilonCny) {
    const moved = await transition(ctx, order, "problem", { detail: { reason: "price_above_reserve", priceCny: price, reserveCny: order.reserveCny } });
    await fire(ctx.alertOperator, { type: "price_above_reserve", orderId: order.id, priceCny: price, reserveCny: order.reserveCny, idempotencyKey: `geo:order:${order.id}:price` });
    return moved;
  }
  const remainder = round2((order.reserveCny ?? 0) - price);
  return transition(ctx, order, "settled", {
    patch: { settledCny: price },
    detail: { priceCny: price },
    ledger: [{ kind: "settle", amountCny: price }, ...(remainder > 0 ? [{ kind: "release", amountCny: remainder, note: "settlement remainder" }] : [])],
  });
}

/**
 * Check one published order at one checkpoint.
 * @param {ReturnType<typeof context>} ctx @param {any} order @param {string} checkpoint @param {Record<string, number>} counts
 */
async function verifyOrder(ctx, order, checkpoint, counts) {
  const now = ctx.now();
  const events = await ctx.store.listOrderEvents(order.id, 500);
  const sent = [...events].reverse().find((event) => event.detail?.phase === "send_started");
  const spans = Array.isArray(sent?.detail?.spans) ? sent.detail.spans : [];
  const [media] = await ctx.store.getMediaRows(order.mediaType, [order.resourceId]);
  /** @type {Record<string, any>} */
  const check = { checkpoint, at: now.toISOString(), url: order.publishedUrl };
  try {
    const read = await /** @type {any} */ (ctx.webReader).read(order.publishedUrl, { signal: AbortSignal.timeout(MARKET_RULES.pageReadTimeoutMs) });
    const finalUrl = read?.receipt?.finalUrl ?? order.publishedUrl;
    const comparison = compareProtectedSpans(spans, String(read?.text ?? ""));
    Object.assign(check, {
      reachable: true, httpStatus: read?.receipt?.status ?? null, finalUrl,
      domainMatch: Boolean(media?.domain) && registrableDomain(hostOf(finalUrl)) === media.domain,
      protectedTotal: comparison.protectedTotal, protectedMatched: comparison.protectedMatched, missing: comparison.missing.slice(0, 20),
      fetchedSha256: read?.receipt?.sha256 ?? null,
    });
  } catch (error) {
    Object.assign(check, { reachable: false, errorCode: /** @type {any} */ (error)?.code ?? "failed" });
  }
  const checks = [...(order.checks ?? []).filter((item) => item.checkpoint !== checkpoint), check].slice(-20);
  counts.checked += 1;
  /** @type {"text_changed" | "domain_mismatch" | "unreachable" | null} */
  let failure = null;
  if (!check.reachable) failure = checkpoint === "1h" ? null : "unreachable";
  else if (!check.domainMatch) failure = "domain_mismatch";
  else if (check.missing.length) failure = "text_changed";
  const lastProblem = [...events].reverse().find((event) => event.toState === "problem" && event.fromState !== "problem");
  if (!check.reachable && !failure) {
    // At +1 h a page may simply not be live yet: noted, judged at +24 h.
    await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "check", check }, patch: { checks } });
    return;
  }
  if (failure) {
    counts.failed += 1;
    const info = failure === "text_changed"
      ? `发布正文与交稿不一致：${check.missing.slice(0, 8).map((item) => `「${item.text}」`).join("、")}`.slice(0, 900)
      : failure === "domain_mismatch" ? `发布链接不在该媒体的域名 ${media?.domain ?? ""} 上：${check.finalUrl ?? order.publishedUrl}` : "时效内链接打不开";
    const appeal = await fileAppeal(ctx, order, failure, info, checkpoint);
    if (appeal.result === "filed") counts.appeals += 1;
    const firstTime = !(order.state === "problem" && lastProblem?.detail?.reason === failure);
    if (order.state === "problem") {
      await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "check", check, reason: failure }, patch: { checks, appeal } });
    } else {
      await transition(ctx, order, "problem", { detail: { reason: failure, checkpoint }, patch: { checks, appeal } });
    }
    if (failure === "domain_mismatch" && firstTime) {
      await fire(ctx.alertOperator, { type: "published_off_domain", orderId: order.id, url: check.finalUrl ?? order.publishedUrl,
        idempotencyKey: `geo:order:${order.id}:off_domain` });
    }
    if (failure === "text_changed" && firstTime) {
      const incidents = await ctx.store.incrementMediaFlag(order.mediaType, order.resourceId, "editIncidents");
      if (Number(incidents) >= 3) {
        await ctx.store.updateMediaFlags({ mediaType: order.mediaType, resourceId: order.resourceId, blacklisted: true, blacklistReason: "repeated_text_changes" });
      }
      await fire(ctx.notify, {
        kind: "safety", type: "published_text_changed", userId: order.userId, geoProjectId: order.geoProjectId, orderId: order.id,
        articleId: order.articleId, mediaName: media?.name ?? "", publishedUrl: order.publishedUrl,
        changed: check.missing.slice(0, 5).map((item) => item.text), idempotencyKey: `geo:order:${order.id}:text_changed`,
      });
    }
    return;
  }
  counts.passed += 1;
  if (order.state === "published" || (order.state === "problem" && VERIFICATION_PROBLEMS.has(lastProblem?.detail?.reason))) {
    const firstVerification = !events.some((event) => event.toState === "verified" && event.fromState !== "verified");
    const verified = await transition(ctx, order, "verified", { detail: { checkpoint }, patch: { checks } });
    if (!verified) return;
    if (firstVerification) {
      const project = await ctx.store.getProject({ geoProjectId: order.geoProjectId });
      for (const engine of project?.engines ?? []) {
        await ctx.store.incrementMediaOutcome({ mediaType: order.mediaType, resourceId: order.resourceId, engine, placed: 1, at: now.toISOString() });
      }
      await ctx.store.advanceArticleStatus(order.articleId, ["publishable", "placed"], "published", now.toISOString());
    }
    const settled = await settleOrder(ctx, verified);
    if (settled?.state === "settled") counts.settled += 1;
    return;
  }
  await ctx.store.annotateOrder(order.id, { at: now.toISOString(), detail: { phase: "check", check }, patch: { checks } });
}

/**
 * Post-publication checks at +1 h, +24 h and +48 h, through the platform's
 * web reader: the page is on the outlet's domain, reachable, and carries every
 * protected span that was sent, byte for byte.
 * @param {MarketDeps} deps
 */
export async function tickVerify(deps) {
  const ctx = context(deps);
  const counts = { due: 0, checked: 0, passed: 0, failed: 0, appeals: 0, settled: 0 };
  if (!ctx.webReader) return { ...counts, skipped: "web_reader_unavailable" };
  const now = ctx.now();
  // Checkpoints end at +48 h; a week of slack covers a verifier that was down.
  const orders = await listAllOrders(ctx.store, { states: ["published", "verified", "settled", "problem"], hasVendorNid: true,
    updatedSince: new Date(now.getTime() - 7 * DAY).toISOString() });
  const due = orders.map((order) => ({ order, checkpoint: dueCheckpoint(order, now) })).filter((item) => item.checkpoint);
  counts.due = due.length;
  for (const { order, checkpoint } of due.slice(0, MARKET_RULES.verifyPerTick)) {
    await verifyOrder(ctx, order, /** @type {string} */ (checkpoint), counts);
  }
  return counts;
}

// --------------------------------------------------------------- reconcile

/**
 * The subset of `items` whose amounts sum to `target` (within a cent), or
 * null. Exhaustive up to twelve items, greedy beyond.
 * @param {Array<{ orderId: string, amountCny: number }>} items @param {number} target
 */
function subsetSum(items, target) {
  const eps = MARKET_RULES.epsilonCny;
  if (Math.abs(target) <= eps) return [];
  if (items.length <= 12) {
    for (let mask = 1; mask < 1 << items.length; mask += 1) {
      const chosen = items.filter((_, index) => mask & (1 << index));
      if (Math.abs(chosen.reduce((total, item) => total + item.amountCny, 0) - target) <= eps) return chosen;
    }
    return null;
  }
  const chosen = [];
  let left = target;
  for (const item of [...items].sort((a, b) => b.amountCny - a.amountCny)) {
    if (item.amountCny <= left + eps) { chosen.push(item); left -= item.amountCny; }
  }
  return Math.abs(left) <= eps ? chosen : null;
}

/**
 * The daily three-way reconciliation: our orders ↔ the vendor's order info ↔
 * the balance, and every project's ledger ↔ its orders. A residual the open
 * orders cannot explain, or a project whose ledger disagrees with its orders,
 * is a mismatch: new orders stop until an operator clears it.
 * @param {MarketDeps} deps
 */
export async function tickReconcile(deps) {
  const ctx = context(deps);
  if (!ctx.configured) return { skipped: "market_unconfigured" };
  const now = ctx.now();
  const day = zonedDay(now, ctx.timeZone);
  const latest = await ctx.store.latestReconciliation();
  if (!latest) {
    const anchor = await ensureAnchor(ctx);
    return { status: "ok", opening: true, day: anchor.day, balance: anchor.balance };
  }
  const anchor = anchorOf(latest);
  // Our orders against the vendor's view of them.
  const counts = { polled: 0, transitions: 0, missing: 0, unmapped: 0, refunds: 0, pendingRefunds: 0, errors: 0 };
  const recent = now.getTime() - 2 * DAY;
  const orders = (await listAllOrders(ctx.store, { hasVendorNid: true }))
    .filter((order) => POLL_STATES.includes(order.state) || Date.parse(order.updatedAt) >= recent);
  const missing = [];
  const priceMismatch = [];
  /** @type {Array<{ order: any, amountCny: number }>} */
  const refundQueue = [];
  for (const mediaType of MEDIA_TYPES) {
    const mine = orders.filter((order) => order.mediaType === mediaType);
    for (let index = 0; index < mine.length; index += 50) {
      const batch = mine.slice(index, index + 50);
      let rows;
      try { rows = await ctx.market.orderInfo(mediaType, batch.map((order) => order.vendorOrderNid)); } catch { counts.errors += 1; continue; }
      const byNid = new Map(rows.map((row) => [row.orderNid, row]));
      for (const order of batch) {
        counts.polled += 1;
        const info = byNid.get(order.vendorOrderNid);
        if (!info) { missing.push(order.id); continue; }
        if (info.priceCny != null && order.priceCny != null && Math.abs(info.priceCny - order.priceCny) > MARKET_RULES.epsilonCny) {
          priceMismatch.push({ orderId: order.id, ours: order.priceCny, vendor: info.priceCny });
        }
        const current = POLL_STATES.includes(order.state) ? await applyVendorStatus(ctx, order, info, counts) : order;
        if (info.isRefund && !["refunded", "lost"].includes(current.state)) refundQueue.push({ order: current, amountCny: info.priceCny ?? current.priceCny ?? 0 });
      }
    }
  }
  await confirmRefunds(ctx, refundQueue, counts);
  // The balance against what the flows since the anchor say it should be.
  const { money, powerCount } = await ctx.market.balance();
  const { expected, flows } = await expectedBalance(ctx, anchor);
  const diff = round2(money - expected);
  let explainedDebits = [];
  let explainedCredits = [];
  if (Math.abs(diff) > MARKET_RULES.epsilonCny) {
    const open = await listAllOrders(ctx.store, { states: ["unknown", "reserved", "rejected", "cancelled"] });
    const debits = open.filter((order) => order.state === "unknown" || sendInFlight(order)).map((order) => ({ orderId: order.id, amountCny: order.priceCny ?? 0 }));
    const credits = open.filter((order) => ["rejected", "cancelled"].includes(order.state) && order.vendorOrderNid)
      .map((order) => ({ orderId: order.id, amountCny: order.priceCny ?? 0 }));
    if (diff < 0) explainedDebits = subsetSum(debits, -diff) ?? [];
    else explainedCredits = subsetSum(credits, diff) ?? [];
  }
  const debitSum = explainedDebits.reduce((total, item) => total + item.amountCny, 0);
  const creditSum = explainedCredits.reduce((total, item) => total + item.amountCny, 0);
  const residual = round2(diff + debitSum - creditSum);
  // Every project's ledger against its orders.
  const projectBreaks = [];
  for (const project of await ctx.store.listBudgetedProjects(500, { activeOnly: false })) {
    const breaks = projectIdentityBreaks(await listAllOrders(ctx.store, { geoProjectId: project.id }, 20_000), await ctx.store.ledgerSums({ geoProjectId: project.id }));
    for (const item of breaks) projectBreaks.push({ geoProjectId: project.id, ...item });
  }
  const balanced = Math.abs(residual) <= MARKET_RULES.epsilonCny && !projectBreaks.length;
  // A stop lasts until an operator clears it: the next run starts from the
  // observed balance and would otherwise find nothing wrong and lift it.
  const carried = latest.status === "mismatch" && !latest.details?.clearedAt;
  const status = balanced && !carried ? "ok" : "mismatch";
  const details = {
    kind: "daily",
    carriedFrom: carried ? latest.day : null,
    observedAt: now.toISOString(),
    // The next expectation starts from the balance with the open orders the
    // residual was explained by taken back out, so their flows count when they land.
    anchorBalance: balanced ? round2(money + debitSum - creditSum) : money,
    previousAnchor: anchor,
    flows,
    residual,
    explainedDebits: explainedDebits.slice(0, 50),
    explainedCredits: explainedCredits.slice(0, 50),
    orders: { checked: counts.polled, transitions: counts.transitions, missing: missing.slice(0, 50), priceMismatch: priceMismatch.slice(0, 50),
      refunds: counts.refunds, pendingRefunds: counts.pendingRefunds, errors: counts.errors },
    projectBreaks: projectBreaks.slice(0, 50),
    powerCount,
    stopNewOrders: status === "mismatch",
  };
  await ctx.store.upsertReconciliation({ day, ours: expected, vendor: money, balance: money, diff, status, details, at: now.toISOString() });
  if (!balanced) {
    await fire(ctx.alertOperator, { type: "reconciliation_mismatch", day, diff, residual, projectBreaks: projectBreaks.length, idempotencyKey: `geo:market:reconcile:${day}` });
  }
  if (missing.length) {
    await fire(ctx.alertOperator, { type: "orders_missing_at_vendor", day, orderIds: missing.slice(0, 20), idempotencyKey: `geo:market:missing:${day}` });
  }
  return { status, day, diff, residual, balance: money, expected, projectBreaks: projectBreaks.length, missing: missing.length, priceMismatch: priceMismatch.length };
}

// ------------------------------------------------------------------ top-ups

/**
 * Whether a top-up's money is in the balance: the balance holds at least its
 * amount more than it would have without it, counting every flow since it was
 * requested.
 * @param {ReturnType<typeof context>} ctx @param {any} topup @param {number} balance @param {number} amountCny
 */
async function topupArrived(ctx, topup, balance, amountCny) {
  const { expected } = await expectedBalance(ctx, { balance: topup.balanceBefore ?? 0, at: topup.requestedAt });
  return round2(balance - expected) + MARKET_RULES.epsilonCny >= amountCny;
}

/** Spend the next days are expected to need: the last week's average plus the queue. @param {ReturnType<typeof context>} ctx */
async function projectedDailySpend(ctx) {
  const now = ctx.now();
  const flows = await ctx.store.platformFlowsSince(new Date(now.getTime() - 7 * DAY).toISOString());
  const weekly = flows.charges.reduce((total, row) => total + row.amountCny, 0) / 7;
  const queued = (await listAllOrders(ctx.store, { states: ["planned", "reserved"] }, 2_000)).reduce((total, order) => total + (order.priceCny ?? 0), 0);
  return round2(weekly + queued / MARKET_RULES.lowWaterDays);
}

/**
 * Hourly: confirm requested top-ups whose money arrived, and request one when
 * the balance is under three days of projected spend — up to fourteen days,
 * never above the operator's cap. No cap configured, no request.
 * @param {MarketDeps} deps
 */
export async function tickTopups(deps) {
  const ctx = context(deps);
  if (!ctx.configured) return { skipped: "market_unconfigured" };
  const counts = { confirmed: 0, requested: 0, open: 0, balance: /** @type {number | null} */ (null), projectedDailyCny: 0, note: /** @type {string | null} */ (null) };
  await ensureAnchor(ctx);
  const { money } = await ctx.market.balance();
  counts.balance = money;
  const open = await ctx.store.listTopups({ status: "requested", limit: 50 });
  for (const topup of open) {
    if (await topupArrived(ctx, topup, money, topup.amountCny ?? 0)) {
      if (await ctx.store.updateTopup(topup.id, { from: "requested", to: "confirmed", at: ctx.now().toISOString(), balanceAfter: money })) counts.confirmed += 1;
    } else {
      counts.open += 1;
    }
  }
  const cap = ctx.config.mediaMarketBalanceCapCny == null ? null : Number(ctx.config.mediaMarketBalanceCapCny);
  if (cap == null || !Number.isFinite(cap)) { counts.note = "balance_cap_unset"; return counts; }
  if (counts.open) return counts;
  const daily = await projectedDailySpend(ctx);
  counts.projectedDailyCny = daily;
  if (daily <= 0 || money >= MARKET_RULES.lowWaterDays * daily) return counts;
  const amount = Math.ceil(Math.min(MARKET_RULES.targetWaterDays * daily - money, cap - money));
  if (amount <= 0) { counts.note = "balance_at_cap"; return counts; }
  const topup = await ctx.store.insertTopup({ amountCny: amount, balanceBefore: money, at: ctx.now().toISOString(),
    note: `projected ${daily}/day; balance ${money}; cap ${cap}` });
  counts.requested += 1;
  await fire(ctx.alertOperator, { type: "topup_requested", topupId: topup.id, amountCny: amount, balance: money, idempotencyKey: `geo:market:topup:${topup.id}` });
  return counts;
}

// ------------------------------------------------------------- route hooks

/** @param {unknown} value */
function parseMoney(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? round2(number) : NaN;
}

/**
 * Set a project's distribution budget: the one human stop on spending. A zero
 * total stops new orders; what is already placed runs its course.
 * @param {MarketDeps} deps @param {{ userId: string, geoProjectId: string, totalCny: unknown, dailyCny: unknown }} input
 */
export async function setBudget(deps, { userId, geoProjectId, totalCny, dailyCny }) {
  const ctx = context(deps);
  const total = parseMoney(totalCny);
  const daily = parseMoney(dailyCny);
  if (!(total >= 0 && total <= 10_000_000) || !(daily >= 0 && daily <= 10_000_000) || (total > 0 && daily > total) || (total > 0 && daily === 0)) {
    throw marketFailure("400", "geo_budget_invalid", "The budget needs a total and a daily cap from 0 to 10,000,000, the daily cap not above the total.");
  }
  const at = ctx.now().toISOString();
  const budget = { totalCny: total, dailyCny: daily, setAt: at };
  const project = await ctx.store.setProjectBudget({ geoProjectId, userId, budget, at,
    ledgerRow: { amountCny: total, note: JSON.stringify({ dailyCny: daily }) } });
  if (!project) throw marketFailure("404", "geo_project_not_found", "No such GEO project.");
  return { budget: { totalCny: total, dailyCny: daily } };
}

/**
 * The 投放 tab (build spec §3).
 * @param {MarketDeps} deps @param {{ userId: string, geoProjectId: string }} input
 */
export async function getDistribution(deps, { userId, geoProjectId }) {
  const ctx = context(deps);
  const project = await ctx.store.getProject({ geoProjectId, userId });
  if (!project) throw marketFailure("404", "geo_project_not_found", "No such GEO project.");
  const view = projectMoney(project, await ctx.store.ledgerSums({ geoProjectId: project.id }));
  const orders = await ctx.store.listOrders({ geoProjectId: project.id, userId, limit: 200, newestFirst: true });
  const articles = new Map((await ctx.store.getArticles(orders.map((order) => order.articleId))).map((article) => [article.id, article]));
  /** @type {Map<string, any>} */
  const media = new Map();
  for (const mediaType of MEDIA_TYPES) {
    const ids = orders.filter((order) => order.mediaType === mediaType).map((order) => order.resourceId);
    for (const row of await ctx.store.getMediaRows(mediaType, ids)) media.set(mediaKey(row.mediaType, row.resourceId), row);
  }
  return {
    budget: project.budget ? { totalCny: view.budgetCny, dailyCny: view.dailyCny } : null,
    spentCny: view.spentCny,
    reservedCny: view.reservedCny,
    suggestedBudgetCny: await ctx.store.suggestedBudget(project.id, project.tier),
    market: { configured: ctx.configured },
    orders: orders.map((order) => {
      const outlet = media.get(mediaKey(order.mediaType, order.resourceId));
      const article = articles.get(order.articleId);
      return {
        id: order.id,
        articleTitle: article?.title ?? "",
        media: outlet?.name ?? "",
        domain: outlet?.domain ?? null,
        layer: article?.layer ?? null,
        state: order.state,
        priceCny: order.settledCny ?? order.priceCny,
        publishedUrl: order.publishedUrl,
        checks: (order.checks ?? []).map((check) => ({ checkpoint: check.checkpoint, at: check.at, reachable: check.reachable ?? null,
          domainMatch: check.domainMatch ?? null, protectedTotal: check.protectedTotal ?? null, protectedMatched: check.protectedMatched ?? null })),
        updatedAt: order.updatedAt,
      };
    }),
  };
}

/**
 * 撤单: only before the outlet accepted. A planned order is simply dropped; a
 * sent one is withdrawn at the vendor, and its reserve stays held until the
 * refund shows in the balance.
 * @param {MarketDeps} deps @param {{ userId: string, geoProjectId: string, orderId: string }} input
 */
export async function cancelOrder(deps, { userId, geoProjectId, orderId }) {
  const ctx = context(deps);
  const order = await ctx.store.getOrder(orderId);
  if (!order || order.userId !== userId || order.geoProjectId !== geoProjectId) throw marketFailure("404", "geo_order_not_found", "No such order.");
  if (order.state === "planned") {
    const moved = await transition(ctx, order, "cancelled", { detail: { reason: "user_cancelled" } });
    if (!moved) throw marketFailure("409", "geo_order_not_cancellable", "The order moved on while it was being cancelled.");
    return { id: moved.id, state: moved.state };
  }
  if (order.state === "reserved") {
    if (sendInFlight(order)) throw marketFailure("409", "geo_order_in_flight", "The order is being sent; it can be cancelled once the outlet has it.");
    const moved = await transition(ctx, order, "cancelled", { detail: { reason: "user_cancelled" }, ledger: [{ kind: "release", amountCny: order.reserveCny ?? 0 }] });
    if (!moved) throw marketFailure("409", "geo_order_not_cancellable", "The order moved on while it was being cancelled.");
    return { id: moved.id, state: moved.state };
  }
  if (order.state !== "submitted") throw marketFailure("409", "geo_order_not_cancellable", "The outlet has already taken this order.");
  if (!ctx.configured) throw marketFailure("503", "media_market_unconfigured", "The media marketplace is not configured.");
  try {
    await ctx.market.cancelOrder(order.mediaType, order.vendorOrderNid);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "media_market_refused") throw marketFailure("409", "geo_order_not_cancellable", "The outlet has already taken this order.");
    throw error;
  }
  const moved = await transition(ctx, order, "cancelled", { detail: { reason: "user_cancelled" } });
  return { id: order.id, state: moved?.state ?? (await ctx.store.getOrder(order.id))?.state ?? order.state };
}

/**
 * Operator: an after-sale that will not be recovered (appeal refused, window
 * missed). Money the vendor kept is spent: settled at its price, the rest of
 * the reserve released, in the same write.
 * @param {MarketDeps} deps @param {{ orderId: string, operatorId: string, reason: string }} input
 */
export async function markOrderLost(deps, { orderId, operatorId, reason }) {
  const ctx = context(deps);
  const order = await ctx.store.getOrder(orderId);
  if (!order || !["problem", "rejected", "cancelled"].includes(order.state) || !order.vendorOrderNid) {
    throw marketFailure("404", "geo_order_not_found", "No order by that id may be written off.");
  }
  const detail = { reason: String(reason ?? "").slice(0, 300) || "written_off", resolvedBy: operatorId };
  if (order.settledCny != null) {
    const moved = await transition(ctx, order, "lost", { detail });
    return { id: order.id, state: moved?.state ?? order.state };
  }
  const reserve = order.reserveCny ?? 0;
  const spent = round2(Math.min(order.priceCny ?? reserve, reserve));
  const moved = await transition(ctx, order, "lost", {
    detail, patch: { settledCny: spent },
    ledger: [{ kind: "settle", amountCny: spent, note: "written off" }, ...(reserve - spent > 0 ? [{ kind: "release", amountCny: round2(reserve - spent) }] : [])],
  });
  return { id: order.id, state: moved?.state ?? order.state };
}

/**
 * Operator: settle an `unknown` order either way — the vendor has it (its
 * order number, checked against the vendor), or it was never created.
 * @param {MarketDeps} deps @param {{ orderId: string, operatorId: string, created: boolean, vendorOrderNid?: string }} input
 */
export async function resolveUnknownOrder(deps, { orderId, operatorId, created, vendorOrderNid }) {
  const ctx = context(deps);
  const order = await ctx.store.getOrder(orderId);
  if (!order || order.state !== "unknown") throw marketFailure("404", "geo_order_not_found", "No unknown order by that id.");
  if (created) {
    if (!ctx.configured) throw marketFailure("503", "media_market_unconfigured", "The media marketplace is not configured.");
    const nid = String(vendorOrderNid ?? "");
    const [info] = await ctx.market.orderInfo(order.mediaType, [nid]);
    if (!info || (info.resourceId && info.resourceId !== order.resourceId)) {
      throw marketFailure("409", "geo_order_not_found_at_vendor", "The vendor does not have that order for this outlet.");
    }
    const moved = await transition(ctx, order, "submitted", { patch: { vendorOrderNid: nid }, detail: { resolvedBy: operatorId, vendorOrderNid: nid } });
    return { id: order.id, state: moved?.state ?? order.state };
  }
  const moved = await transition(ctx, order, "cancelled", {
    detail: { resolvedBy: operatorId, reason: "not_created" }, ledger: [{ kind: "release", amountCny: order.reserveCny ?? 0, note: "never created" }],
  });
  return { id: order.id, state: moved?.state ?? order.state };
}

/**
 * Operator: the balance shows the top-up paid (or not yet — then the
 * operator's word is noted and the hourly tick confirms it when it lands).
 * @param {MarketDeps} deps @param {{ topupId: string, operatorId: string, amountCny?: number }} input
 */
export async function confirmTopup(deps, { topupId, operatorId, amountCny }) {
  const ctx = context(deps);
  const topup = await ctx.store.getTopup(topupId);
  if (!topup) throw marketFailure("404", "geo_topup_not_found", "No such top-up request.");
  if (topup.status !== "requested") throw marketFailure("409", "geo_topup_not_pending", "This top-up is no longer waiting.");
  if (!ctx.configured) throw marketFailure("503", "media_market_unconfigured", "The media marketplace is not configured.");
  const amount = amountCny == null ? topup.amountCny ?? 0 : parseMoney(amountCny);
  if (!(amount > 0)) throw marketFailure("400", "geo_topup_invalid", "The paid amount must be above zero.");
  const { money: balance } = await ctx.market.balance();
  const at = ctx.now().toISOString();
  if (await topupArrived(ctx, topup, balance, amount)) {
    const confirmed = await ctx.store.updateTopup(topup.id, { from: "requested", to: "confirmed", at, amountCny: amount, balanceAfter: balance,
      note: `${topup.note ?? ""} · confirmed by ${operatorId}`.trim() });
    return { id: topup.id, status: confirmed?.status ?? "confirmed", balance };
  }
  await ctx.store.noteTopup(topup.id, `${topup.note ?? ""} · ${operatorId} marked paid ${amount} at ${at}`.trim());
  return { id: topup.id, status: "awaiting_balance", balance };
}

/**
 * Operator: clear a reconciliation stop after looking at it.
 * @param {MarketDeps} deps @param {{ operatorId: string, note?: string }} input
 */
export async function clearStop(deps, { operatorId, note }) {
  const ctx = context(deps);
  const latest = await ctx.store.latestReconciliation();
  if (!latest || latest.status !== "mismatch") return { cleared: false };
  await ctx.store.patchReconciliationDetails(latest.day, { clearedAt: ctx.now().toISOString(), clearedBy: operatorId, clearNote: String(note ?? "").slice(0, 500) });
  return { cleared: true, day: latest.day };
}

/**
 * Operator: the market as a whole (GET /api/geo/market).
 * @param {MarketDeps} deps
 */
export async function marketStatus(deps) {
  const ctx = context(deps);
  /** @type {{ money: number, powerCount: number | null } | null} */
  let balance = null;
  /** @type {string | null} */
  let balanceError = null;
  if (ctx.configured) {
    try { balance = await ctx.market.balance(); } catch (error) { balanceError = /** @type {any} */ (error)?.code ?? "failed"; }
  }
  const stop = await stopState(ctx);
  const cap = ctx.config.mediaMarketBalanceCapCny ?? null;
  const unknown = await ctx.store.listOrders({ states: ["unknown"], limit: 100 });
  const problems = await ctx.store.listOrders({ states: ["problem"], limit: 100 });
  const notes = [];
  if (!ctx.configured) notes.push("market_unconfigured");
  if (cap == null) notes.push("balance_cap_unset");
  if (stop.stopped) notes.push("orders_stopped");
  return {
    configured: ctx.configured,
    balance,
    balanceError,
    balanceCapCny: cap,
    stopNewOrders: stop,
    lastReconciliation: await ctx.store.latestReconciliation(),
    topups: await ctx.store.listTopups({ limit: 10 }),
    unknownOrders: unknown.map((order) => ({ id: order.id, geoProjectId: order.geoProjectId, mediaType: order.mediaType, resourceId: order.resourceId,
      priceCny: order.priceCny, reserveCny: order.reserveCny, sentAt: order.sentAt })),
    problemOrders: problems.length,
    notes,
    client: ctx.market?.status?.() ?? null,
  };
}

/**
 * The readiness line for the `geo` check: what the market can and cannot do.
 * @param {Record<string, any>} config @param {{ configured?: boolean } | null} market
 */
export function geoMarketReadiness(config, market) {
  const notes = [];
  if (!market?.configured) notes.push("media_market_unconfigured");
  if (config?.mediaMarketBalanceCapCny == null) notes.push("balance_cap_unset_no_topup_requests");
  return { configured: market?.configured === true, notes };
}

/**
 * The monitoring package reports an article URL cited by an engine. Counted
 * once per order and engine; the answer says whether this was the first time
 * (for 「第一次被 AI 引用」).
 * @param {MarketDeps} deps @param {{ orderId?: string, url?: string, engine: string }} input
 */
export async function noteCitation(deps, { orderId, url, engine }) {
  const ctx = context(deps);
  if (!/^[a-z]{2,20}$/.test(String(engine ?? ""))) throw marketFailure("400", "geo_engine_invalid", "Unknown engine.");
  let order = orderId ? await ctx.store.getOrder(orderId) : null;
  if (!order && url) {
    const candidates = [String(url), String(url).replace(/#.*$/, ""), String(url).replace(/#.*$/, "").replace(/\/$/, "")];
    for (const candidate of [...new Set(candidates)]) {
      [order] = await ctx.store.listOrders({ publishedUrl: candidate, limit: 1 });
      if (order) break;
    }
  }
  if (!order) return { matched: false };
  const events = await ctx.store.listOrderEvents(order.id, 500);
  const cited = events.filter((event) => event.detail?.phase === "cited");
  if (cited.some((event) => event.detail?.engine === engine)) return { matched: true, first: false, orderId: order.id, articleId: order.articleId };
  await ctx.store.annotateOrder(order.id, { at: ctx.now().toISOString(), detail: { phase: "cited", engine } });
  await ctx.store.incrementMediaOutcome({ mediaType: order.mediaType, resourceId: order.resourceId, engine, cited: 1, at: ctx.now().toISOString() });
  return { matched: true, first: true, firstForOrder: cited.length === 0, orderId: order.id, articleId: order.articleId };
}
