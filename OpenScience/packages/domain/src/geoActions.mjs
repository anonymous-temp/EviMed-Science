/**
 * 「循证 GEO」's action read model, once (rectification 2026-10-14, plan §4 item 1, audit C §2.5).
 *
 * The chain from a question group to what was done about it and what came of it is in the platform's tables a stretch at a time —
 * the strategy's gaps, the articles bound to a group, the orders and the links the brand published, the direct citations, the
 * group-scope metric rows, the net effect — and the pages used to draw it by artefact type. This module is the one place that joins
 * it: pure functions over rows the caller read, no I/O, so the actions page, the project's conversation (`geo_read actions`), the
 * weekly report and the orchestrator's scheduler read the same verdicts.
 *
 * Hidden knowledge:
 *
 * - **The model writes the language, the code computes every number.** What an action is for (a gap's judgment, its expected points,
 *   why a source), and how far it can be promised to move, are a run's words (`strategy.actions[]`, the gaps); the baseline, the
 *   reading now, k of n, the tier's target, the net effect and its band, the status and the staleness are derived here. A number a
 *   run typed is never shown as one: the target is the chosen tier's row for the group's pool, as the orchestrator has always chosen
 *   its batches by.
 * - **A group is never given a percentage it cannot support.** Per group per round there are about a dozen answers, under the
 *   platform's own floor of {@link GEO_MIN_CELL_SAMPLES}. A group's reading is `k of n` and a state; `geoGroupReading` has no
 *   `rate` below the floor (its return type says so), and "did it work" is judged only on the arms — pilot groups together against
 *   control groups together, over rounds with the same engines and groups (`NET` rows, written by the measurement package).
 * - **A control group has no action.** It is measured and never worked on (writing for it takes it out of the control arm).
 * - **The status is the furthest stage reached**, and two words are flags: `stale` (the latest publication is eight weeks old and
 *   nothing cited any — the criterion the orchestrator uses, per article, to put a group in the next batch, `geoPlacementStale`)
 *   and `skipped` (a person's reversible word). The order of the stages is `GEO_ACTION_STATUSES`.
 * - **A key survives what rewrites around it**: a new strategy version with the same gap, and a question set copied under new
 *   group ids (a group keeps its name; `aliasIds` carry the ids it had), find the same choice. The key's first word is the kind the
 *   action was born with; `kind` itself becomes `correct_error` when a group is already at its target and errors are open.
 *
 * @module geoActions
 */

import {
  GEO_ACTION_PROMISES,
  GEO_ARTICLE_CHANNELS,
  GEO_ARTICLE_LAYERS,
  GEO_ENGINES,
  GEO_GAP_CLASSES,
  GEO_MIN_CELL_SAMPLES,
  GEO_POOLS,
  GEO_SEVERITIES,
  GEO_STEPS,
  GEO_URGENT_SEVERITIES,
  GEO_VIEW_METRIC_IDS,
} from './geoVocabulary.mjs'
import { GEO_METRICS, geoConstant, geoMetricDefinition, pythonRound } from './geoMetrics.mjs'

/** Weeks a published action is waited on before it is called stale: published, never cited. */
export const GEO_STALE_PLACEMENT_WEEKS = 8
/** The most measured questions an action lists. */
export const GEO_ACTION_QUESTIONS = 5
/** The most sources an action lists. */
export const GEO_ACTION_SOURCES = 5
/** The most points of a series an action carries. */
export const GEO_ACTION_SERIES_POINTS = 12

const WEEK_MS = 7 * 86_400_000
/** The rounds that measure the whole question set: a group's reading now is read from these only. */
const HEADLINE_KINDS = Object.freeze(['baseline', 'weekly', 'single_step'])
/** What an action that belongs to no group (a project-wide gap) is judged on: the index and mention over P2 and P3, the headline targets. */
const PROJECT_ACTION_METRICS = Object.freeze(['M-19', 'M-01S'])
/** The error states that still ask for work. */
const OPEN_ERROR_STATUSES = Object.freeze(['open', 'acting', 'awaiting_remeasure'])
/** Order states in which an article is being placed, and in which it is published. */
const PLACED_ORDER_STATES = Object.freeze(['planned', 'reserved', 'submitted', 'accepted', 'unknown', 'problem'])
const PUBLISHED_ORDER_STATES = Object.freeze(['published', 'verified', 'settled'])
const MENTION_PROMISES = Object.freeze(['enter_mention', 'raise_mention'])
/** The statuses in which nothing has been placed yet. */
const NOT_ACTED_STATUSES = Object.freeze(['proposed', 'writing', 'ready'])
const ACTED_STATUSES = Object.freeze(['placed', 'live', 'cited', 'verified', 'stale'])

// ------------------------------------------------------------------ small readers

/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
/** @param {unknown} value @returns {string | null} */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : [])
/** @param {unknown} value @returns {Record<string, any>} */
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value @returns {number | null} */
const instant = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
/** @param {string} value */
const bareDomain = (value) => value.trim().toLowerCase().replace(/^www\./, '')
/** @param {number} left @param {number} right */
const compareNumbers = (left, right) => (left === right ? 0 : left < right ? -1 : 1)

// ------------------------------------------------------------------ the rules

/**
 * One group's reading of one metric: k of n, and — only from {@link GEO_MIN_CELL_SAMPLES} answers on — a rate. Under the floor the
 * reading has no `rate` field at all, so a layer that wants to print a percentage has nothing to print.
 *
 * @param {{ k?: number | null, n?: number | null, floor?: number } | null | undefined} cell
 * @returns {{ k: number, n: number, state: 'enough', rate: number } | { k: number, n: number, state: 'thin' } | { k: null, n: null, state: 'absent' }}
 */
export function geoGroupReading(cell) {
  const k = finite(cell?.k)
  const n = finite(cell?.n)
  const floor = finite(cell?.floor) ?? GEO_MIN_CELL_SAMPLES
  if (k == null || n == null || n <= 0) return { k: null, n: null, state: 'absent' }
  if (n < floor) return { k, n, state: 'thin' }
  return { k, n, state: 'enough', rate: pythonRound((k / n) * 100, 2) }
}

/**
 * Whether a published thing is stale: published at least `weeks` weeks ago and never cited. The orchestrator's rule for putting a
 * group into its next batch ("a placed article was never cited after eight weeks"), written once; the action's `stale` status reads
 * the same function over the same facts.
 *
 * @param {{ publishedAt: unknown, now: unknown, cited: boolean, weeks?: number }} input
 */
export function geoPlacementStale({ publishedAt, now, cited, weeks = GEO_STALE_PLACEMENT_WEEKS }) {
  if (cited) return false
  const at = instant(publishedAt)
  const current = instant(now)
  if (at == null || current == null) return false
  return at < current - weeks * WEEK_MS
}

/**
 * The metrics a pool's actions are judged on: the owner's table (`net_effect.metrics_by_pool`), never a model's choice.
 * @param {string | null | undefined} pool
 * @returns {string[]}
 */
export function geoExpectedMetrics(pool) {
  const byPool = /** @type {Record<string, string[]>} */ (GEO_METRICS.net_effect.metrics_by_pool)
  return pool && pool !== 'index' && Object.hasOwn(byPool, pool) ? [...byPool[pool]] : []
}

/**
 * @typedef {object} GeoTargetRow
 * @property {string} tier @property {string} metricId @property {string} pool
 * @property {number | null} [baseline] @property {number | null} [target] @property {number | null} [horizonWeeks]
 * @property {number | null} [placements] @property {number | null} [budgetCny] @property {string} [dataType]
 */

/**
 * The target of a pool for the chosen tier: that pool's row of the named metrics, else the project-wide row (`pool` all). What an
 * action is expected to reach, and what the orchestrator measures a group's shortfall against — the same lookup.
 *
 * @param {readonly GeoTargetRow[] | null | undefined} rows @param {{ tier: string, pool: string | null | undefined, metricIds: readonly string[] }} where
 * @returns {GeoTargetRow | null}
 */
export function geoPoolTarget(rows, { tier, pool, metricIds }) {
  const wanted = list(rows).filter((row) => row && row.tier === tier && metricIds.includes(row.metricId))
  return wanted.find((row) => row.pool === pool) ?? wanted.find((row) => row.pool === 'all') ?? null
}

/**
 * Whether a group is short of its pool's target, and on what it was judged: the group's own reading when that reading is a
 * measurement (`ok`), else the pool's as the proxy — the orchestrator's rule. A group with neither is not called short.
 *
 * @param {{ own?: { value: number | null, status: string } | null, proxy?: { value: number | null, status: string } | null, goal: number | null | undefined }} input
 * @returns {{ short: boolean, basis: 'group' | 'pool' | null }}
 */
export function geoGroupShort({ own = null, proxy = null, goal }) {
  const target = finite(goal)
  if (target == null) return { short: false, basis: null }
  const ownValue = own && own.status === 'ok' ? finite(own.value) : null
  if (ownValue != null) return { short: ownValue < target, basis: 'group' }
  const proxyValue = proxy && proxy.status === 'ok' ? finite(proxy.value) : null
  if (proxyValue != null) return { short: proxyValue < target, basis: 'pool' }
  return { short: false, basis: null }
}

// ------------------------------------------------------------------ keys

/**
 * An action's key: the kind it was born with, its group and what it answers — a gap class, an error id or a metric id. Letters,
 * digits and `_ - :` only.
 * @param {{ kind: string, groupId?: string | null, ref: string }} parts
 */
export function geoActionKey({ kind, groupId = null, ref }) {
  return `${kind}:${groupId || '-'}:${ref}`
}

/**
 * A key taken apart; null when it is not the shape of one.
 * @param {unknown} key
 * @returns {{ kind: string, groupId: string | null, ref: string } | null}
 */
export function parseGeoActionKey(key) {
  if (typeof key !== 'string' || key.length > 240) return null
  const match = /^(correct_error|fill_gap|win_cluster|maintain):([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,100})$/.exec(key)
  if (!match) return null
  return { kind: match[1], groupId: match[2] === '-' ? null : match[2], ref: match[3] }
}

/**
 * A short stable key for a text (a client to-do): FNV-1a over its words with the spacing folded, as eight hex digits. Not a secret
 * and not a signature — only a name that does not move while the words do not.
 * @param {string} value
 */
export function geoTextKey(value) {
  let hash = 0x811c9dc5
  const folded = String(value ?? '').replace(/\s+/g, ' ').trim()
  for (let index = 0; index < folded.length; index += 1) {
    hash ^= folded.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * What a person's two words — set an action aside, send it to another source — do to the platform's choosers, read from the derived
 * actions so that the page and the choosers cannot differ: the orchestrator's batches and the market's plans take their verdicts from
 * here and decide nothing of their own. A person's word is a preference and a stop for new work; it never touches an engineering
 * check (the gate, the budget, the outlet's conditions).
 *
 * - `skippedGroupIds`: groups that have at least one content action (`fill_gap`, `win_cluster`, `maintain`) and every one of them is
 *   skipped — no new batch is written for them. A group whose other actions are open is not set aside; a skipped `correct_error`
 *   never sets a group aside (its errors are the errors').
 * - `skippedArticleIds`: articles that at least one action lists and every action that lists them is skipped for — not planned for
 *   a placement, and a plan already made for them is withdrawn.
 * - `skippedErrorIds`: errors named by `correct_error` actions of which every one is skipped — not given to a correction batch.
 * - `preferredByArticle`: article id → the domains the person sent an open (not skipped) action that lists the article to.
 *
 * @param {ReadonlyArray<Record<string, any>> | null | undefined} actions the `actions` of {@link deriveGeoActions}
 * @param {{ groups?: ReadonlyArray<{ id: string, aliasIds?: readonly string[] }> | null }} [options]
 *   `groups`: the ids a group had in earlier set versions are added to `skippedGroupIds`, so a chooser reading an older set finds it
 */
export function geoChoiceEffects(actions, { groups = null } = {}) {
  /** @param {Map<string, { total: number, skipped: number }>} map @param {string} id @param {boolean} skipped */
  const count = (map, id, skipped) => {
    const entry = map.get(id) ?? { total: 0, skipped: 0 }
    entry.total += 1
    if (skipped) entry.skipped += 1
    map.set(id, entry)
  }
  /** @type {Map<string, { total: number, skipped: number }>} */
  const contentByGroup = new Map()
  /** @type {Map<string, { total: number, skipped: number }>} */
  const byArticle = new Map()
  /** @type {Map<string, { total: number, skipped: number }>} */
  const byError = new Map()
  /** @type {Map<string, Set<string>>} */
  const preferred = new Map()
  for (const action of list(actions)) {
    if (!action || typeof action !== 'object') continue
    const skipped = action.status === 'skipped'
    const born = parseGeoActionKey(action.key)?.kind ?? text(action.kind)
    const groupId = text(action.group?.id)
    if (groupId && born !== 'correct_error') count(contentByGroup, groupId, skipped)
    const articleIds = list(action.articleIds).map(String).filter(Boolean)
    for (const id of articleIds) count(byArticle, id, skipped)
    if (born === 'correct_error') for (const id of list(action.need?.errorIds).map(String).filter(Boolean)) count(byError, id, skipped)
    const swapped = text(action.choice?.sourceDomain)
    if (swapped && !skipped) {
      for (const id of articleIds) preferred.set(id, (preferred.get(id) ?? new Set()).add(bareDomain(swapped)))
    }
  }
  /** @param {Map<string, { total: number, skipped: number }>} map */
  const wholly = (map) => new Set([...map].filter(([, entry]) => entry.total > 0 && entry.skipped === entry.total).map(([id]) => id))
  const skippedGroupIds = wholly(contentByGroup)
  for (const group of list(groups)) {
    if (group && skippedGroupIds.has(String(group.id))) for (const id of list(group.aliasIds)) skippedGroupIds.add(String(id))
  }
  return {
    skippedGroupIds,
    skippedArticleIds: wholly(byArticle),
    skippedErrorIds: wholly(byError),
    preferredByArticle: new Map([...preferred].map(([id, domains]) => [id, [...domains]])),
  }
}

// ------------------------------------------------------------------ the read model

/**
 * @typedef {object} GeoActionGroup
 * @property {string} id @property {string | null} name @property {string | null} pool
 * @property {string | null} [journeyStage] @property {number | null} [journeyStageNo] @property {number | null} [weight]
 * @property {boolean} [isControl] @property {readonly string[]} [aliasIds] the ids this group had in earlier set versions
 * @property {Array<{ id: string, text: string, isMeasured?: boolean, retiredAt?: string | null }>} [questions]
 *
 * @typedef {object} GeoReadingRow
 * @property {string} groupId @property {string} metricId @property {string | null} [roundId] @property {string | null} [date]
 * @property {string | null} [kind] @property {number | null} k @property {number | null} n @property {number | null} [value]
 * @property {string} [status] @property {string | null} [coverage]
 *
 * @typedef {object} GeoActionInput
 * @property {unknown} now @property {string} tier @property {readonly string[]} engines
 * @property {readonly GeoActionGroup[]} groups the latest question set's groups
 * @property {{ version?: number | null, gaps?: any[] | null, expectations?: any[] | null, actions?: any[] | null } | null} [strategy]
 * @property {{ rows: readonly GeoTargetRow[], version?: number | null } | null} [targets]
 * @property {readonly GeoReadingRow[]} [readings] group-scope rows over the project's rounds
 * @property {ReadonlyArray<{ pool: string, metricId: string, value: number | null, status: string }>} [poolReadings] the latest pool rows (the proxy)
 * @property {ReadonlyArray<Record<string, any>>} [errors]
 * @property {ReadonlyArray<Record<string, any>>} [articles]
 * @property {ReadonlyArray<Record<string, any>>} [orders]
 * @property {ReadonlyArray<Record<string, any>>} [ownedLinks]
 * @property {ReadonlyArray<{ articleId: string, engine: string | null, questionId?: string | null, firstSeen?: string | null }>} [cited]
 * @property {ReadonlyArray<{ key: string, state: string, groups?: string[], errors?: string[] }>} [batches] content batches the orchestrator dispatched
 * @property {ReadonlyArray<{ key: string, skipped?: boolean, sourceDomain?: string | null, updatedAt?: string | null }>} [choices]
 * @property {Record<string, ReadonlyArray<Record<string, any>>>} [candidates] sources the group could go to, by group id
 * @property {Record<string, { netEffect: number | null, verdict: string | null, noiseBand: number | null, comparable: boolean, roundId?: string | null }>} [arms]
 *   the net effect rows by `<pool>|<metric>` (`all|M-19` for the index)
 */

/** @param {GeoActionGroup} group */
const idsOf = (group) => [group.id, ...list(group.aliasIds).map(String)]

/**
 * A reading in the form the page reads: the metric, k of n, the state, and the round it is of.
 * @param {GeoReadingRow | null | undefined} row
 */
function readingOf(row) {
  if (!row) return null
  return { metricId: String(row.metricId), ...geoGroupReading({ k: row.k, n: row.n }), roundId: text(row.roundId), date: text(row.date),
    coverage: text(row.coverage) }
}

/** @param {string} engine @param {ReadonlyArray<Record<string, any>>} expectations */
function ceilingOf(engine, expectations) {
  const entry = expectations.find((item) => item && item.engine === engine)
  return text(entry?.ceiling)
}

/**
 * The words of a model-written action entry, read defensively: the platform stores what a run wrote and reads it here.
 * @param {any} entry
 */
export function geoActionEntry(entry) {
  const value = record(entry)
  const what = value.what && typeof value.what === 'object' ? record(value.what) : null
  return {
    gapId: text(value.gapId),
    groupId: text(value.groupId),
    group: text(value.group),
    gapClass: text(value.gapClass ?? value.class),
    errorIds: list(value.errorIds).map(String).filter(Boolean),
    kind: text(value.kind),
    what: what ? { layer: text(what.layer), title: text(what.title), channel: text(what.channel) } : null,
    engines: list(value.engines).map(String).filter(Boolean),
    sources: list(value.sources).filter((source) => source && typeof source === 'object').map((source) => {
      const domain = text(record(source).domain)
      return { domain: domain ? bareDomain(domain) : null, why: text(record(source).why) }
    }).filter((source) => source.domain),
    promise: text(value.promise),
    basis: text(value.basis),
    reason: text(value.reason),
    metricId: text(value.metricId),
    target: finite(value.target),
  }
}

/**
 * The sources an action lists: the person's swapped one first, then the outlets it was placed in, then the model's choice and the
 * candidates' own order — at most {@link GEO_ACTION_SOURCES}, each once. A source is an address (`domain`) or, for the brand's own
 * channel, a platform (`channel`, no domain): the person publishes there and pastes the link.
 *
 * @param {ReadonlyArray<Record<string, any>>} candidates @param {{ swapped: string | null,
 *   placed: ReadonlyArray<{ domain: string, orderId: string | null, name?: string | null, price?: number | null }>,
 *   modelSources: ReadonlyArray<{ domain: string | null, why: string | null }> }} choice
 */
function rankedSources(candidates, { swapped, placed, modelSources }) {
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map()
  for (const candidate of candidates) {
    const raw = text(candidate?.domain)
    const domain = raw ? bareDomain(raw) : null
    const channel = text(candidate?.channel)
    const key = domain ?? (channel ? `channel:${channel}` : null)
    if (key && !byKey.has(key)) byKey.set(key, { ...candidate, domain })
  }
  /** @type {string[]} */
  const order = []
  const take = (/** @type {string | null | undefined} */ key) => { if (key && !order.includes(key)) order.push(key) }
  take(swapped ? bareDomain(swapped) : null)
  for (const entry of placed) take(entry.domain)
  for (const entry of modelSources) take(entry.domain)
  for (const key of byKey.keys()) take(key)
  return order.slice(0, GEO_ACTION_SOURCES).map((key) => {
    const domain = key.startsWith('channel:') ? null : key
    const placedAs = domain ? placed.find((entry) => entry.domain === domain) : undefined
    // An outlet the platform placed at is a placement whatever else is known of it: its own name and price fill what the lists lack.
    const known = byKey.get(key) ?? { domain: key }
    const candidate = placedAs
      ? { ...known, name: known.name ?? placedAs.name, price: known.price ?? placedAs.price, route: 'market', origin: known.origin ?? 'placed' }
      : known
    const swappedTo = swapped ? bareDomain(swapped) : null
    return {
      domain,
      channel: text(candidate.channel),
      name: text(candidate.name),
      kind: text(candidate.kind),
      layer: text(candidate.layer),
      why: domain ? modelSources.find((entry) => entry.domain === domain)?.why ?? null : null,
      citedFor: record(candidate.citedFor),
      conditions: record(candidate.conditions),
      price: finite(candidate.price),
      available: candidate.available === true ? true : candidate.available === false ? false : null,
      unavailableBecause: list(candidate.unavailableBecause).map(String),
      route: text(candidate.route),
      origin: text(candidate.origin),
      chosen: placedAs ? 'placed' : domain && swappedTo === domain ? 'swapped' : 'recommended',
      orderId: placedAs?.orderId ?? null,
      articleIds: list(candidate.articleIds).map(String),
    }
  })
}

/**
 * Derive every action of a project from the rows the caller read.
 *
 * @param {GeoActionInput} input
 */
export function deriveGeoActions(input) {
  const now = instant(input.now) ?? Date.now()
  const tier = String(input.tier ?? '2')
  const projectEngines = list(input.engines).map(String)
  const groups = list(input.groups)
  const strategy = record(input.strategy)
  const gaps = list(strategy.gaps).filter((gap) => gap && typeof gap === 'object')
  const expectations = list(strategy.expectations)
  const modelEntries = list(strategy.actions).filter((entry) => entry && typeof entry === 'object').map(geoActionEntry)
  const targetRows = list(input.targets?.rows)
  /** The rows that are rows: the derivation reads the platform's tables and a hand-written input alike, and never throws on the odd one. @param {unknown} rows */
  const rowsOf = (rows) => list(rows).filter((row) => row && typeof row === 'object')
  const readings = rowsOf(input.readings).slice().sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? ''))
    || String(left.roundId ?? '').localeCompare(String(right.roundId ?? '')))
  const errors = rowsOf(input.errors)
  const articles = rowsOf(input.articles).filter((article) => article.status !== 'withdrawn')
  const orders = rowsOf(input.orders)
  const ownedLinks = rowsOf(input.ownedLinks).filter((link) => link.status !== 'retired')
  const cited = rowsOf(input.cited)
  const batches = rowsOf(input.batches)
  const choices = rowsOf(input.choices)
  const candidates = record(input.candidates)
  const arms = record(input.arms)
  const poolReadings = list(input.poolReadings)

  /** @type {Map<string, GeoActionGroup>} */
  const groupById = new Map()
  /** @type {Map<string, GeoActionGroup>} */
  const groupByName = new Map()
  for (const group of groups) {
    for (const id of idsOf(group)) groupById.set(id, group)
    const name = text(group.name)
    if (name && !groupByName.has(name)) groupByName.set(name, group)
  }
  /** The current group a stored id or a written name means. @param {unknown} id @param {unknown} [name] */
  const groupFor = (id, name = null) => {
    const byId = typeof id === 'string' ? groupById.get(id) : undefined
    if (byId) return byId
    const written = text(name) ?? (typeof id === 'string' ? text(id) : null)
    return written ? groupByName.get(written) ?? null : null
  }

  /** The choice of a key, also under the keys the group had with its earlier ids. @param {string} key @param {GeoActionGroup | null} group */
  const choiceOf = (key, group) => {
    const parsed = parseGeoActionKey(key)
    const keys = new Set([key])
    if (parsed && group) for (const id of idsOf(group)) keys.add(geoActionKey({ kind: parsed.kind, groupId: id, ref: parsed.ref }))
    return choices.find((choice) => keys.has(choice.key)) ?? null
  }

  // ---- facts by group
  /** @param {GeoActionGroup} group */
  const articlesOf = (group) => articles.filter((article) => article.groupId && idsOf(group).includes(String(article.groupId)) && article.layer !== 'correction')
  /** @param {ReadonlyArray<Record<string, any>>} forArticles */
  const factsOf = (forArticles) => {
    const ids = new Set(forArticles.map((article) => String(article.id)))
    return {
      orders: orders.filter((order) => order.articleId && ids.has(String(order.articleId))),
      links: ownedLinks.filter((link) => link.articleId && ids.has(String(link.articleId))),
      citations: cited.filter((entry) => ids.has(String(entry.articleId))),
    }
  }
  /** The reading rows of a group's metric, oldest first. @param {GeoActionGroup} group @param {string} metricId */
  const seriesOf = (group, metricId) => {
    const ids = new Set(idsOf(group))
    return readings.filter((row) => row.metricId === metricId && ids.has(String(row.groupId)))
  }
  /** @param {GeoReadingRow[]} rows */
  const headlineOf = (rows) => rows.filter((row) => !row.kind || HEADLINE_KINDS.includes(String(row.kind)))
  /** The latest pool-level row of a metric (the proxy). @param {string | null} pool @param {string} metricId */
  const poolRow = (pool, metricId) => poolReadings.find((row) => row.pool === pool && row.metricId === metricId) ?? null

  /**
   * The status of an action from the facts behind it.
   * @param {{ articles: ReadonlyArray<Record<string, any>>, orders: ReadonlyArray<Record<string, any>>, links: ReadonlyArray<Record<string, any>>,
   *   citations: ReadonlyArray<Record<string, any>>, inBatch: boolean, errorsClosed: boolean, reached: boolean | null, armUp: boolean,
   *   skipped: boolean }} facts
   */
  const statusOf = (facts) => {
    if (facts.skipped) return 'skipped'
    const publishedAt = [
      ...facts.orders.filter((order) => PUBLISHED_ORDER_STATES.includes(String(order.state))).map((order) => instant(order.publishedAt ?? order.updatedAt)),
      ...facts.links.map((link) => instant(link.publishedAt)),
    ].filter((value) => value != null)
    const live = publishedAt.length > 0
    const isCited = facts.citations.length > 0
    // Published, never cited, and the latest publication is eight weeks old: a new publication starts the wait again.
    if (live && !isCited && geoPlacementStale({ publishedAt: Math.max(.../** @type {number[]} */ (publishedAt)), now, cited: false })) return 'stale'
    if (isCited && (facts.reached === true || facts.armUp)) return 'verified'
    if (facts.errorsClosed) return 'verified'
    if (isCited) return 'cited'
    if (live) return 'live'
    if (facts.orders.some((order) => PLACED_ORDER_STATES.includes(String(order.state))) || facts.articles.some((article) => article.status === 'placed')) return 'placed'
    if (facts.articles.some((article) => article.status === 'publishable')) return 'ready'
    if (facts.articles.length || facts.inBatch) return 'writing'
    return 'proposed'
  }

  /**
   * Engines an action is promised on: the run's, else those whose measured behaviour allows the promise.
   * @param {string} promise @param {string[]} given
   */
  const enginesFor = (promise, given) => {
    const named = given.filter((engine) => projectEngines.includes(engine))
    if (named.length) return named
    const mention = MENTION_PROMISES.includes(promise)
    return projectEngines.filter((engine) => {
      const ceiling = ceilingOf(engine, expectations)
      if (ceiling == null) return true
      return mention ? ceiling === 'mention_and_accuracy' : ceiling !== 'undetermined'
    })
  }

  /** @type {Array<Record<string, any>>} */
  const actions = []
  /** @type {Array<{ code: string, gapId?: string | null, message: string }>} */
  const issues = []
  /** @type {Array<{ gapId: string | null, groupId: string | null, reason: string }>} */
  const noAction = []
  /** @type {Set<number>} */
  const usedEntries = new Set()
  /** @type {Set<string>} */
  const takenKeys = new Set()

  /** @param {string} key */
  const uniqueKey = (key) => {
    let candidate = key
    for (let attempt = 2; takenKeys.has(candidate); attempt += 1) candidate = `${key}_${attempt}`
    takenKeys.add(candidate)
    return candidate
  }

  /**
   * One action of a group.
   * @param {{ born: string, group: GeoActionGroup | null, ref: string, gap?: Record<string, any> | null, errorRows?: Array<Record<string, any>>,
   *   entry?: ReturnType<typeof geoActionEntry> | null, extraMetricIds?: string[], extraChecks?: Array<Record<string, any>> }} spec
   */
  const build = ({ born, group, ref, gap = null, errorRows = [], entry = null, extraMetricIds = [], extraChecks = [] }) => {
    const key = uniqueKey(geoActionKey({ kind: born, groupId: group?.id ?? null, ref }))
    const pool = text(group?.pool)
    // An action of no group is the project's: judged on the headline metrics, against the tier's project-wide row.
    const metricIds = group ? geoExpectedMetrics(pool) : [...PROJECT_ACTION_METRICS]
    /** @type {Array<Record<string, any>>} */
    const checks = [...extraChecks]
    // ---- the metric and the target (the owner's table and the chosen tier's row, never a run's number)
    const wantedMetric = entry?.metricId ?? null
    if (wantedMetric && !metricIds.includes(wantedMetric)) checks.push({ code: 'metric_not_in_pool', metricId: wantedMetric, pool })
    const withTarget = metricIds.find((metricId) => geoPoolTarget(targetRows, { tier, pool, metricIds: [metricId] }))
    const primaryMetricId = (wantedMetric && metricIds.includes(wantedMetric) ? wantedMetric : null) ?? withTarget ?? metricIds[0] ?? null
    const targetRow = primaryMetricId ? geoPoolTarget(targetRows, { tier, pool, metricIds: [primaryMetricId] }) : null
    const target = finite(targetRow?.target)
    if (entry && entry.target != null && !entry.basis) checks.push({ code: 'target_without_basis', target: entry.target })
    if (entry && entry.target != null && primaryMetricId === 'M-06') {
      const hardLine = Number(geoConstant('ACCURACY_HARD_LINE')) * 100
      if (entry.target < hardLine) checks.push({ code: 'accuracy_below_hard_line', target: entry.target, hardLine })
    }
    // ---- readings
    const series = group && primaryMetricId ? seriesOf(group, primaryMetricId) : []
    const headline = headlineOf(series)
    const latest = headline[headline.length - 1] ?? null
    const from = readingOf(latest)
    const baseline = readingOf(headline[0] ?? null)
    const direction = primaryMetricId ? geoMetricDefinition(primaryMetricId)?.direction ?? 'up' : 'up'
    const ownValue = from && from.state === 'enough' && (latest?.status ?? 'ok') === 'ok' ? finite(latest?.value) ?? from.rate : null
    /** @type {boolean | null} */
    const reached = target == null || ownValue == null ? null : direction === 'down' ? ownValue <= target : ownValue >= target
    // ---- promise
    const defaultPromise = (() => {
      if (reached === true) return 'coverage_complete'
      if (pool === 'P4') return gap && gap.class !== 'wrong' ? 'coverage_complete' : 'hold'
      if (pool === 'P1' && primaryMetricId === 'M-06') return 'accuracy_to_target'
      if (from && from.state !== 'absent' && from.k === 0) return 'enter_mention'
      if (from && from.state !== 'absent') return 'raise_mention'
      return 'enter_mention'
    })()
    let promise = defaultPromise
    if (entry?.promise) {
      if (GEO_ACTION_PROMISES.includes(/** @type {any} */ (entry.promise))) promise = entry.promise
      else checks.push({ code: 'promise_unknown', promise: entry.promise })
    }
    // ---- engines
    const engines = enginesFor(promise, entry?.engines ?? [])
    for (const engine of entry?.engines ?? []) {
      if (!projectEngines.includes(engine)) checks.push({ code: 'engine_not_in_project', engine })
    }
    if (MENTION_PROMISES.includes(promise)) {
      for (const engine of engines) {
        const ceiling = ceilingOf(engine, expectations)
        if (ceiling && ceiling !== 'mention_and_accuracy') checks.push({ code: 'promise_above_ceiling', engine, ceiling })
      }
    }
    // ---- the facts behind it
    const errorIds = errorRows.map((row) => String(row.id))
    const correctionIds = new Set(errorRows.flatMap((row) => list(row.materials).map((material) => text(record(material).articleId)).filter(Boolean)))
    const forArticles = born === 'correct_error' ? articles.filter((article) => correctionIds.has(String(article.id))) : group ? articlesOf(group) : []
    const facts = factsOf(forArticles)
    const inBatch = batches.some((item) => ['pending', 'claimed', 'running'].includes(String(item.state))
      && ((group && list(item.groups).some((id) => idsOf(group).includes(String(id)))) || errorIds.some((id) => list(item.errors).includes(id))))
    const errorsClosed = errorRows.length > 0 && errorRows.every((row) => row.status === 'closed') && correctionIds.size > 0
    const armKey = pool && primaryMetricId ? `${pool}|${primaryMetricId}` : null
    const poolArm = armKey ? arms[armKey] ?? null : null
    const arm = poolArm ?? arms[`all|${GEO_VIEW_METRIC_IDS.gvi}`] ?? null
    // A verdict needs the pool's own net effect: the index of the whole project moving says nothing of this action.
    const armUp = Boolean(poolArm && poolArm.comparable && poolArm.verdict === 'up')
    const choice = choiceOf(key, group)
    const status = statusOf({ articles: forArticles, orders: facts.orders, links: facts.links, citations: facts.citations, inBatch,
      errorsClosed, reached, armUp, skipped: choice?.skipped === true })
    // ---- the what and the sources
    const latestArticle = [...forArticles].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0] ?? null
    const channel = entry?.what?.channel && GEO_ARTICLE_CHANNELS.includes(/** @type {any} */ (entry.what.channel)) ? entry.what.channel : text(latestArticle?.channel)
    const layer = entry?.what?.layer && GEO_ARTICLE_LAYERS.includes(/** @type {any} */ (entry.what.layer)) ? entry.what.layer : text(latestArticle?.layer)
    const placed = facts.orders.filter((order) => [...PLACED_ORDER_STATES, ...PUBLISHED_ORDER_STATES].includes(String(order.state)) && text(order.domain))
      .map((order) => ({ domain: bareDomain(String(order.domain)), orderId: String(order.id), name: text(order.mediaName),
        price: finite(order.settledCny) ?? finite(order.priceCny) }))
    const sources = rankedSources(list(group ? candidates[group.id] : null), { swapped: text(choice?.sourceDomain), placed, modelSources: entry?.sources ?? [] })
    // ---- what happened
    const citedBy = facts.citations.map((item) => ({ engine: text(item.engine), questionId: text(item.questionId), askedAt: text(item.firstSeen), articleId: text(item.articleId) }))
      .sort((left, right) => String(left.askedAt ?? '').localeCompare(String(right.askedAt ?? '')))
    const openErrors = errorRows.filter((row) => OPEN_ERROR_STATUSES.includes(String(row.status)))
    const expectedPoints = list(gap?.expectedPoints).filter((point) => point && typeof point === 'object').map((point) => ({
      id: text(point.pointId ?? point.id), kind: text(point.kind), statement: text(point.statement),
      claimIds: list(point.refs).map((reference) => text(record(reference).id)).filter(Boolean),
    })).filter((point) => point.statement)
    /** @type {Array<Record<string, any>>} */
    const evidence = []
    for (const metricId of [...new Set([primaryMetricId, ...extraMetricIds].filter(Boolean))]) {
      const reading = group ? readingOf(headlineOf(seriesOf(group, /** @type {string} */ (metricId))).at(-1) ?? null) : null
      if (reading) evidence.push({ kind: 'reading', ...reading, groupId: group?.id ?? null })
    }
    for (const row of errorRows.slice(0, 8)) {
      evidence.push({ kind: 'error', errorId: String(row.id), engine: text(row.engine), severity: text(row.severity), statement: text(row.statement), status: text(row.status) })
    }
    const kind = reached === true && openErrors.length && born !== 'correct_error' ? 'correct_error' : born === 'correct_error' ? 'correct_error' : born
    const rank = finite(gap?.rank) ?? finite(gap?.priority)
    const measured = group ? list(group.questions).filter((question) => question && question.isMeasured !== false && !question.retiredAt)
      .slice(0, GEO_ACTION_QUESTIONS).map((question) => ({ id: String(question.id), text: String(question.text) })) : []
    actions.push({
      key,
      kind,
      group: group ? { id: group.id, name: text(group.name), pool, journeyStage: text(group.journeyStage), journeyStageNo: finite(group.journeyStageNo),
        weight: finite(group.weight), isControl: group.isControl === true } : null,
      questions: measured,
      need: {
        gapId: text(gap?.gapId ?? gap?.id) ?? entry?.gapId ?? null,
        gapClass: text(gap?.class) ?? entry?.gapClass ?? null,
        errorIds,
        judgment: text(gap?.judgment) ?? text(gap?.text),
        evidence,
        expectedPoints,
        rank,
        consequence: gap?.consequence && typeof gap.consequence === 'object' ? { band: text(gap.consequence.band), basis: text(gap.consequence.basis) } : null,
        safetyPinned: gap?.safetyPinned === true,
        handoff: text(gap?.handoff ?? gap?.handoffTo),
      },
      what: { layer, title: entry?.what?.title ?? text(latestArticle?.title), channel, channelNote: channel ? null : text(latestArticle?.channelNote) },
      engines,
      sources,
      expected: {
        metricIds,
        primaryMetricId,
        promise,
        from,
        baseline,
        target,
        reached,
        dataType: 'forecast',
        horizonWeeks: finite(targetRow?.horizonWeeks),
        tier,
        basis: { tier, metricId: primaryMetricId, pool, targetsVersion: finite(input.targets?.version), source: targetRow ? 'targets' : 'none', note: entry?.basis ?? null },
        closes: { errors: openErrors.length, points: expectedPoints.length },
      },
      status,
      articleIds: forArticles.map((article) => String(article.id)),
      orderIds: facts.orders.map((order) => String(order.id)),
      ownedLinkIds: facts.links.map((link) => String(link.id)),
      observed: {
        citedBy,
        series: series.slice(-GEO_ACTION_SERIES_POINTS).map((row) => ({ round: text(row.roundId), date: text(row.date), kind: text(row.kind),
          ...geoGroupReading({ k: row.k, n: row.n }), coverage: text(row.coverage) })),
        arm: arm ? { netEffect: finite(arm.netEffect), verdict: text(arm.verdict), noiseBand: finite(arm.noiseBand), comparable: arm.comparable === true,
          scope: poolArm ? 'pool' : 'project', pool: poolArm ? pool : null } : null,
      },
      choice: choice ? { skipped: choice.skipped === true, sourceDomain: text(choice.sourceDomain), updatedAt: text(choice.updatedAt) } : null,
      checks,
      reason: entry?.reason ?? null,
      rank,
    })
  }

  /**
   * The model's entry for a gap, an error or a group, taken once.
   * @param {{ gapId?: string | null, group: GeoActionGroup | null, gapClass?: string | null, errorIds?: string[], bare?: boolean }} want
   */
  const entryFor = ({ gapId = null, group, gapClass = null, errorIds = [], bare = false }) => {
    const index = modelEntries.findIndex((entry, position) => {
      if (usedEntries.has(position)) return false
      if (bare) return !entry.gapId && !entry.gapClass && !entry.errorIds.length && Boolean(group) && groupFor(entry.groupId, entry.group)?.id === group?.id
        && (!entry.kind || entry.kind === 'win_cluster')
      if (gapId && entry.gapId === gapId) return true
      if (errorIds.length && !entry.gapClass && entry.errorIds.some((id) => errorIds.includes(id))) return true
      return Boolean(group && gapClass && entry.gapClass === gapClass && groupFor(entry.groupId, entry.group)?.id === group.id)
    })
    if (index < 0) return null
    usedEntries.add(index)
    return modelEntries[index]
  }

  // ---- control groups: no action, listed
  const control = groups.filter((group) => group.isControl === true)
    .map((group) => ({ id: group.id, name: text(group.name), pool: text(group.pool), articles: articlesOf(group).length }))

  // ---- errors by group and claim fingerprint
  /** @type {Map<string, Array<Record<string, any>>>} */
  const errorsByClaim = new Map()
  for (const row of errors) {
    if (!row || !text(row.id)) continue
    const group = groupFor(row.groupId)
    const claim = text(row.fingerprint) ?? String(row.id)
    const mapKey = `${group?.id ?? '-'}\u0000${claim}`
    const rows = errorsByClaim.get(mapKey) ?? []
    rows.push(row)
    errorsByClaim.set(mapKey, rows)
  }
  /** @param {GeoActionGroup} group */
  const errorsOfGroup = (group) => [...errorsByClaim.entries()].filter(([mapKey]) => mapKey.startsWith(`${group.id}\u0000`)).flatMap(([, rows]) => rows)
  /** Error ids a gap names, as the run wrote them. @param {Record<string, any>} gap */
  const gapErrorIds = (gap) => new Set([...list(record(gap.evidence).errors), ...list(gap.ecErrorRefs), ...list(gap.errorIds)].map(String))
  /** @type {Set<string>} */
  const claimedErrors = new Set()

  // ---- gaps -> fill_gap / correct_error
  /** @type {Set<string>} */
  const gapGroups = new Set()
  let gapsWithoutEntry = 0
  for (const gap of gaps) {
    const gapId = text(gap.gapId ?? gap.id)
    const group = groupFor(gap.groupId, gap.group ?? gap.groupName)
    const handoff = text(gap.handoff ?? gap.handoffTo)
    const gapClass = text(gap.class)
    if (!group) {
      // A gap that names no group (a project-wide one: no authoritative source anywhere) or one the latest question set does not
      // have is the project's: listed with no group and noted, so nothing a run wrote is out of sight.
      const written = text(gap.groupId) ?? text(gap.group ?? gap.groupName)
      if (handoff === 'monitor_only') {
        noAction.push({ gapId, groupId: null, reason: 'monitor_only' })
        continue
      }
      const wrongGap = gapClass === 'wrong' || handoff === 'EC'
      const named = gapErrorIds(gap)
      const rowsOfNamed = errors.filter((row) => row && typeof row === 'object' && named.has(String(row.id)))
      for (const row of rowsOfNamed) claimedErrors.add(String(row.id))
      const projectEntry = entryFor({ gapId, group: null, gapClass, errorIds: rowsOfNamed.map((row) => String(row.id)) })
      if (projectEntry && projectEntry.what === null && projectEntry.reason && !projectEntry.promise && !projectEntry.engines.length) {
        noAction.push({ gapId, groupId: null, reason: projectEntry.reason })
        continue
      }
      if (!projectEntry) gapsWithoutEntry += 1
      build({ born: wrongGap ? 'correct_error' : 'fill_gap', group: null,
        ref: (gapId ?? gapClass ?? 'gap').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'gap',
        gap, errorRows: rowsOfNamed, entry: projectEntry, extraChecks: written ? [{ code: 'group_unknown', group: written }] : [] })
      continue
    }
    if (group.isControl === true || handoff === 'monitor_only') {
      noAction.push({ gapId, groupId: group.id, reason: group.isControl === true ? 'control_group' : 'monitor_only' })
      continue
    }
    const isErrorGap = gapClass === 'wrong' || handoff === 'EC'
    const named = [...gapErrorIds(gap)]
    const groupErrors = errorsOfGroup(group)
    // An error the gap names stands for its claim: every engine that tells it is the gap's.
    const namedClaims = new Set(groupErrors.filter((row) => named.includes(String(row.id))).map((row) => text(row.fingerprint) ?? String(row.id)))
    const ofNamed = groupErrors.filter((row) => named.includes(String(row.id)) || namedClaims.has(text(row.fingerprint) ?? String(row.id)))
    const rows = isErrorGap ? (ofNamed.length ? ofNamed : groupErrors) : ofNamed
    for (const row of rows) claimedErrors.add(String(row.id))
    const entry = entryFor({ gapId, group, gapClass, errorIds: rows.map((row) => String(row.id)) })
    if (entry && entry.what === null && entry.reason && !entry.promise && !entry.engines.length) {
      noAction.push({ gapId, groupId: group.id, reason: entry.reason })
      continue
    }
    if (!entry) gapsWithoutEntry += 1
    gapGroups.add(group.id)
    build({ born: isErrorGap ? 'correct_error' : 'fill_gap', group,
      ref: gapClass && GEO_GAP_CLASSES.includes(/** @type {any} */ (gapClass)) ? gapClass : (gapId ?? 'gap').replace(/[^A-Za-z0-9_-]/g, '_'),
      gap, errorRows: rows, entry })
  }

  // ---- errors no gap claimed: one action per claim and group
  for (const rows of errorsByClaim.values()) {
    if (rows.every((row) => claimedErrors.has(String(row.id)))) continue
    if (!rows.some((row) => OPEN_ERROR_STATUSES.includes(String(row.status))) && !rows.some((row) => list(row.materials).length)) continue
    const group = groupFor(rows[0].groupId)
    if (group?.isControl === true) continue
    const earliest = [...rows].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || String(left.id).localeCompare(String(right.id)))[0]
    const entry = entryFor({ group, errorIds: rows.map((row) => String(row.id)) })
    build({ born: 'correct_error', group, ref: String(earliest.id), errorRows: rows, entry })
  }

  // ---- win_cluster / maintain: a group by its mention reading against the pool's target (the orchestrator's own rule)
  for (const group of groups) {
    if (group.isControl === true) continue
    const pool = text(group.pool)
    const goal = finite(geoPoolTarget(targetRows, { tier, pool, metricIds: ['M-01', 'M-01S'] })?.target)
    const latest = headlineOf(seriesOf(group, 'M-01')).at(-1) ?? null
    const proxy = poolRow(pool, 'M-01')
    const short = geoGroupShort({
      own: latest ? { value: finite(latest.value), status: String(latest.status ?? 'ok') } : null,
      proxy: proxy ? { value: finite(proxy.value), status: proxy.status } : null,
      goal,
    })
    if (gapGroups.has(group.id)) continue
    if (short.short) {
      build({ born: 'win_cluster', group, ref: 'M-01', entry: entryFor({ group, bare: true }), extraMetricIds: ['M-01'] })
    } else if (short.basis !== null) {
      const facts = factsOf(articlesOf(group))
      const live = facts.orders.some((order) => PUBLISHED_ORDER_STATES.includes(String(order.state))) || facts.links.length > 0
      if (live) build({ born: 'maintain', group, ref: 'M-01', extraMetricIds: ['M-01'] })
    }
  }

  // ---- what the model wrote that matches nothing
  const unmatched = modelEntries.filter((_entry, index) => !usedEntries.has(index)).filter((entry) => !(entry.what === null && entry.reason))
    .map((entry) => ({ gapId: entry.gapId, groupId: entry.groupId, gapClass: entry.gapClass, errorIds: entry.errorIds }))

  // ---- order: a person's skip last, then the run's rank, then the group's weight
  const rankOf = (/** @type {Record<string, any>} */ action) => (action.rank == null ? Number.POSITIVE_INFINITY : action.rank)
  actions.sort((left, right) => (Number(left.status === 'skipped') - Number(right.status === 'skipped'))
    || compareNumbers(rankOf(left), rankOf(right))
    || ((finite(right.group?.weight) ?? 0) - (finite(left.group?.weight) ?? 0))
    || String(left.key).localeCompare(String(right.key)))

  // ---- the summary a page leads with
  /** @type {Record<string, number>} */
  const byStatus = {}
  /** @type {Record<string, number>} */
  const byKind = {}
  for (const action of actions) {
    byStatus[action.status] = (byStatus[action.status] ?? 0) + 1
    byKind[action.kind] = (byKind[action.kind] ?? 0) + 1
  }
  const actedGroups = new Set(actions.filter((action) => ACTED_STATUSES.includes(action.status) && action.group).map((action) => action.group.id))
  const waitingGapGroups = new Set(actions.filter((action) => action.kind !== 'maintain' && NOT_ACTED_STATUSES.includes(action.status)
    && (action.need.gapClass || action.need.errorIds.length) && action.group && !actedGroups.has(action.group.id)).map((action) => action.group.id))
  const indexArm = arms[`all|${GEO_VIEW_METRIC_IDS.gvi}`] ?? Object.values(arms)[0] ?? null
  const headline = {
    actedGroups: actedGroups.size,
    gapGroupsNotActedOn: waitingGapGroups.size,
    arm: indexArm ? { netEffect: finite(indexArm.netEffect), verdict: text(indexArm.verdict), noiseBand: finite(indexArm.noiseBand), comparable: indexArm.comparable === true } : null,
  }
  return {
    actions,
    control,
    noAction,
    unmatched,
    issues,
    counts: { total: actions.length, byKind, byStatus, gapsWithoutEntry },
    headline: { ...headline, sentence: geoActionSentence(headline) },
  }
}

/**
 * The one sentence an actions page leads with, assembled from the numbers: what the groups worked on did against the control
 * groups, only when the two are comparable, and how many groups with a gap are still waiting for work.
 *
 * @param {{ actedGroups: number, gapGroupsNotActedOn: number, arm: { netEffect: number | null, verdict: string | null, noiseBand: number | null, comparable: boolean } | null }} headline
 */
export function geoActionSentence(headline) {
  const parts = []
  const arm = headline.arm
  const band = arm?.noiseBand != null ? `（波动 ±${pythonRound(arm.noiseBand, 1)}）` : ''
  if (headline.actedGroups > 0 && arm) {
    const size = arm.netEffect != null ? pythonRound(Math.abs(arm.netEffect), 1) : null
    if (!arm.comparable || arm.netEffect == null) parts.push('还不能和对照群比较：测量范围不同或样本不足')
    else if (arm.verdict === 'up') parts.push(`已行动的问句群比对照多涨 ${size} 个点${band}`)
    else if (arm.verdict === 'down') parts.push(`已行动的问句群比对照少 ${size} 个点${band}`)
    else parts.push(`已行动的问句群与对照相比没有超出波动${band}`)
  } else if (headline.actedGroups > 0) {
    parts.push(`${headline.actedGroups} 个问句群已经行动，还没有可比较的对照结果`)
  }
  if (headline.gapGroupsNotActedOn > 0) parts.push(`另有 ${headline.gapGroupsNotActedOn} 个群的缺口还没有行动`)
  return parts.join('；')
}

// ------------------------------------------------------------------ errors by claim

/**
 * The project's errors grouped by the claim they contradict — one row per claim with the engines that say it, not one per claim ×
 * engine. The error rows keep their shape beside this.
 *
 * @param {ReadonlyArray<Record<string, any>>} errors rows as the diagnosis lists them (`fingerprint` names the claim)
 */
export function geoErrorsByClaim(errors) {
  const statusRank = ['open', 'acting', 'awaiting_remeasure', 'closed']
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byClaim = new Map()
  for (const row of list(errors)) {
    const key = text(row?.fingerprint) ?? text(row?.claimId) ?? text(row?.id)
    if (!key) continue
    const rows = byClaim.get(key) ?? []
    rows.push(row)
    byClaim.set(key, rows)
  }
  const severityRank = (/** @type {string | null} */ severity) => (severity ? GEO_SEVERITIES.indexOf(/** @type {any} */ (severity)) : -1)
  return [...byClaim.entries()].map(([fingerprint, rows]) => {
    const severity = rows.map((row) => text(row.severity)).filter(Boolean).sort((left, right) => severityRank(right) - severityRank(left))[0] ?? null
    const status = rows.map((row) => String(row.status)).sort((left, right) => statusRank.indexOf(left) - statusRank.indexOf(right))[0] ?? 'open'
    // The answer opened for the claim is the most severe live one's: its row leads.
    const lead = [...rows].sort((left, right) => (severityRank(text(right.severity)) - severityRank(text(left.severity)))
      || (statusRank.indexOf(String(left.status)) - statusRank.indexOf(String(right.status))))[0]
    return {
      fingerprint,
      claimId: text(lead.claimId),
      statement: text(lead.statement) ?? text(rows.find((row) => text(row.statement))?.statement),
      engines: [...new Set(rows.map((row) => text(row.engine)).filter(Boolean))],
      count: rows.length,
      severity,
      status,
      errorIds: rows.map((row) => String(row.id)),
      snapshotId: text(lead.firstSnapshotId) ?? text(lead.snapshotId),
      citedSources: rows.map((row) => record(row.citedSource)).filter((source) => text(source.attribute) || text(source.domain)),
      actions: [...new Set(rows.map((row) => text(row.action)).filter(Boolean))],
      urgent: rows.some((row) => GEO_URGENT_SEVERITIES.includes(/** @type {any} */ (row.severity)) && row.status !== 'closed'),
    }
  }).sort((left, right) => (severityRank(right.severity) - severityRank(left.severity)) || (statusRank.indexOf(left.status) - statusRank.indexOf(right.status))
    || right.count - left.count)
}

// ------------------------------------------------------------------ what a person is asked

/**
 * @typedef {object} GeoNeedsYouInput
 * @property {{ id: string, budget?: unknown, steps?: Record<string, any> }} project
 * @property {boolean} marketConfigured
 * @property {boolean} [canReview] the reader may release a safety stop
 * @property {ReadonlyArray<Record<string, any>>} [articles]
 * @property {ReadonlyArray<Record<string, any>>} [errors]
 * @property {readonly string[]} [clientActions] the strategy's layout `clientActions`
 * @property {ReadonlyArray<{ key: string, skipped?: boolean }>} [choices]
 */

/**
 * The few things a project really asks of its person: a budget not yet decided, articles waiting for a look, the most severe
 * errors with their correction entry, the strategy's client to-dos, a step waiting on credits or one that failed. A step that is
 * done is not here — this is a to-do list, never a log.
 *
 * @param {GeoNeedsYouInput} input
 * @returns {Array<Record<string, any>>}
 */
export function geoNeedsYou(input) {
  /** @type {Array<Record<string, any>>} */
  const items = []
  const project = input.project
  const articles = list(input.articles).filter((article) => article && article.status !== 'withdrawn')
  const steps = record(project.steps)
  const publishable = articles.filter((article) => article.status === 'publishable').length
  if (input.marketConfigured && !project.budget && (publishable > 0 || record(steps.content).status === 'done')) {
    items.push({ kind: 'set_budget', key: 'budget', verb: 'set', object: { type: 'budget', id: project.id }, target: { tab: 'actions', section: 'budget' } })
  }
  const stops = articles.filter((article) => article.safety === 'open')
  if (stops.length && input.canReview !== false) {
    items.push({ kind: 'release_articles', key: 'release', verb: 'review', object: { type: 'articles', ids: stops.slice(0, 5).map((article) => String(article.id)) },
      count: stops.length, target: { tab: 'actions', section: 'review' } })
  }
  const severityRank = (/** @type {unknown} */ severity) => GEO_SEVERITIES.indexOf(/** @type {any} */ (severity))
  const severe = list(input.errors).filter((row) => row && row.status === 'open' && GEO_URGENT_SEVERITIES.includes(/** @type {any} */ (row.severity)))
    .sort((left, right) => (severityRank(right.severity) - severityRank(left.severity)) || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
  /** @type {Set<string>} */
  const seen = new Set()
  for (const row of severe) {
    if (seen.size >= 2) break
    const claim = text(row.fingerprint) ?? String(row.id)
    if (seen.has(claim)) continue
    seen.add(claim)
    items.push({ kind: 'correct_severe_error', key: `error:${row.id}`, verb: 'correct', object: { type: 'error', id: String(row.id) },
      severity: text(row.severity), engine: text(row.engine), statement: text(row.statement), groupId: text(row.groupId),
      target: { tab: 'accuracy', errorId: String(row.id), snapshotId: text(row.snapshotId) } })
  }
  const skipped = new Set(list(input.choices).filter((choice) => choice.skipped).map((choice) => String(choice.key)))
  for (const clientAction of list(input.clientActions)) {
    const value = text(clientAction)
    if (!value) continue
    const key = `client:${geoTextKey(value)}`
    if (skipped.has(key)) continue
    items.push({ kind: 'client_action', key, verb: 'do', object: { type: 'client_action' }, text: value, target: { tab: 'plan', section: 'client_actions' } })
  }
  for (const step of GEO_STEPS) {
    const value = record(steps[step])
    if (text(value.waiting)) {
      items.push({ kind: 'credits_waiting', key: `waiting:${step}`, verb: 'top_up', object: { type: 'step', id: step }, waiting: text(value.waiting),
        note: text(value.note), target: { tab: 'overview' } })
    } else if (value.status === 'failed') {
      items.push({ kind: 'step_failed', key: `failed:${step}`, verb: 'retry', object: { type: 'step', id: step }, target: { tab: 'overview', step } })
    }
  }
  return items
}

// ------------------------------------------------------------------ one check of a run's own file

/**
 * What a strategy file says about its own actions, as notices (never a refusal): a gap nobody answers, an expected metric outside
 * the pool's table, a target number without its basis, a promise outside the vocabulary. The write returns these to the run that
 * wrote it (it is still in its turn), and the evaluation grades a stored run with the same function.
 *
 * @param {{ gaps?: any[] | null, actions?: any[] | null }} strategy
 * @returns {Array<{ code: string, gapId?: string | null, index?: number, message: string }>}
 */
export function geoActionNotices(strategy) {
  /** @type {Array<{ code: string, gapId?: string | null, index?: number, message: string }>} */
  const notices = []
  const gaps = list(strategy?.gaps).filter((gap) => gap && typeof gap === 'object')
  const entries = list(strategy?.actions).filter((entry) => entry && typeof entry === 'object').map(geoActionEntry)
  for (const gap of gaps) {
    const gapId = text(gap.gapId ?? gap.id)
    const handoff = text(gap.handoff ?? gap.handoffTo)
    if (handoff === 'monitor_only') continue
    const answered = entries.some((entry) => (gapId && entry.gapId === gapId)
      || (entry.gapClass && entry.gapClass === text(gap.class) && (entry.groupId === text(gap.groupId) || entry.group === text(gap.group ?? gap.groupName))))
    if (!answered) {
      notices.push({ code: 'gap_without_action', gapId,
        message: `Gap ${gapId ?? '(no id)'} has no entry in actions[]: write the action that answers it, or an entry with only a reason for doing nothing.` })
    }
  }
  entries.forEach((entry, index) => {
    if (entry.promise && !GEO_ACTION_PROMISES.includes(/** @type {any} */ (entry.promise))) {
      notices.push({ code: 'promise_unknown', index, message: `actions[${index}].promise is one of: ${GEO_ACTION_PROMISES.join(', ')}.` })
    }
    if (entry.metricId) {
      const gap = gaps.find((item) => entry.gapId && text(item.gapId ?? item.id) === entry.gapId)
      const pool = text(gap?.pool)
      if (pool && GEO_POOLS.includes(/** @type {any} */ (pool)) && !geoExpectedMetrics(pool).includes(entry.metricId)) {
        notices.push({ code: 'metric_not_in_pool', index,
          message: `actions[${index}].metricId ${entry.metricId} is not one of pool ${pool}'s metrics: ${geoExpectedMetrics(pool).join(', ')}.` })
      }
    }
    if (entry.target != null && !entry.basis) {
      notices.push({ code: 'target_without_basis', index,
        message: `actions[${index}] carries a target number without its basis; the platform's target comes from the tier's table — write the basis or leave the number out.` })
    }
    for (const engine of entry.engines) {
      if (!GEO_ENGINES.includes(/** @type {any} */ (engine))) {
        notices.push({ code: 'engine_not_in_project', index, message: `actions[${index}].engines names ${engine}, which is not an engine.` })
      }
    }
  })
  return notices
}

// ------------------------------------------------------------------ the rail's one count per step

/**
 * The rail's short count for a step, from counts the caller read; null when there is nothing to count.
 * @param {string} step @param {Record<string, number | null | undefined>} counts
 * @returns {{ text: string, count: number, unit: string } | null}
 */
export function geoStepSummary(step, counts) {
  /** @type {Record<string, [string, string]>} */
  const shape = {
    evidence: ['claims', '条结论'],
    journey: ['stages', '个阶段'],
    questions: ['groups', '个群'],
    diagnosis: ['answers', '条回答'],
    sources: ['sources', '个信源'],
    content: ['articles', '篇稿件'],
    distribution: ['published', '篇已发布'],
    monitoring: ['rounds', '轮测量'],
  }
  const entry = shape[step]
  if (!entry) return null
  const count = finite(counts?.[entry[0]])
  if (count == null || count <= 0) return null
  return { text: `${count} ${entry[1]}`, count, unit: entry[0] }
}

/** The metric ids the actions read, named once for the callers that ask the database for them. */
export const GEO_ACTION_READ_METRICS = Object.freeze([...new Set(['M-01', ...Object.entries(GEO_METRICS.net_effect.metrics_by_pool)
  .filter(([pool]) => pool !== 'index').flatMap(([, metrics]) => /** @type {string[]} */ (metrics))])])
