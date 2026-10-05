/**
 * What a metered model request was for.
 *
 * Hidden knowledge: until this vocabulary existed the usage ledger could say
 * who spent and on which run, never on what. Ten days of production (1,816
 * requests, 2026-09-19) could not separate memory extraction, the routing
 * classifier and run titles from the kernel's own calls, and the six
 * specialist engines never reached the ledger at all — so no auxiliary-model
 * change could be shown to save anything. Every caller of the model gateway now
 * names one of these, and `evimed_usage.model_requests.purpose` holds it under
 * a CHECK derived from this list.
 *
 * Closed on purpose: a purpose is a report column, and a free string would
 * split one cost across spellings. A caller that names none is recorded as
 * `other` — bookkeeping never fails a model call.
 */

/** @typedef {'kernel'|'memory-extraction'|'routing'|'title'|'engine'|'capsule-scan'|'channel-intent'|'source-understanding'|'learning'|'autopilot'|'frontier'|'review'|'geo'|'vcr'|'web-search'|'evolution'|'evidence'|'evidence-upkeep'|'other'} UsagePurpose */

/** Every purpose, in report order. `frontier` is the frontier feed reading
 *  the literature for everyone (screening, editing, the daily issue): one
 *  line of its own, charged to the operator's internal `evimed-frontier`
 *  project and governed by the module's own daily budget, so what the feed
 *  costs is never folded into a researcher's spend. `review` is the
 *  independent reviewer the control plane calls on a researcher's delivery
 *  (a model of another family, never the kernel's): charged to the run it
 *  reviewed, so a report's price includes its review. `geo` is 「循证 GEO」's
 *  own model calls outside a run — parsing and judging measured answers —
 *  held by the module's own daily budget like `frontier`, never by a
 *  researcher's caps. `web-search` is the web-search gateway's own model call
 *  — Bailian's web search rides on a Qwen request whose prompt the retrieved
 *  pages are billed into — made for a researcher's run and charged to it like
 *  the kernel's calls, caps included. `autopilot` is the one decision a
 *  scheduled research agenda makes before each episode — what the next
 *  episode should do, from the progress so far — made on a researcher's own
 *  agenda and charged to them like the episode it chooses for, caps included;
 *  a line of its own so what choosing costs is never folded into what
 *  researching costs. `evidence` is the platform's own evidence programme
 *  (2026-10-05, evidence-flywheel plan §5.1, B7): the topic selector and the
 *  agendas the publisher account runs in its internal `evimed-evidence`
 *  project, held by the programme's own daily budget like `frontier` and
 *  never by anyone's caps. `evidence-upkeep` is the other half of the same
 *  money: the AI upkeep of a zone that is not the platform's — what keeping
 *  a researcher's own evidence zone current costs — made on that account's
 *  behalf, booked to it, counted against its caps and charged to it through
 *  the research allowance like a run's model calls. The platform's budget
 *  pays for official zones only; until 2026-10-05 any account's zone ran on
 *  the frontier budget (plan §3.3). */
export const USAGE_PURPOSES = /** @type {readonly UsagePurpose[]} */ (Object.freeze([
  'kernel',
  'memory-extraction',
  'routing',
  'title',
  'engine',
  'capsule-scan',
  'channel-intent',
  'source-understanding',
  'learning',
  'autopilot',
  'frontier',
  'review',
  'geo',
  'vcr',
  'web-search',
  'evolution',
  'evidence',
  'evidence-upkeep',
  'other',
]))

/** Chinese row labels for the cost report. */
export const USAGE_PURPOSE_LABELS_ZH = /** @type {Readonly<Record<UsagePurpose, string>>} */ (Object.freeze({
  kernel: '研究运行',
  'memory-extraction': '记忆提取',
  routing: '路由分类',
  title: '运行标题',
  engine: '专科引擎',
  'capsule-scan': '胶囊扫描',
  'channel-intent': '渠道意图',
  'source-understanding': '资料理解',
  learning: '学习做法',
  autopilot: '主动科研规划',
  frontier: '前沿动态',
  review: '成果审查',
  geo: '循证 GEO',
  vcr: '虚拟临研',
  'web-search': '联网搜索',
  evolution: '循证进化',
  evidence: '证据中心',
  'evidence-upkeep': '证据专区维护',
  other: '其他',
}))

/** @param {unknown} value @returns {value is UsagePurpose} */
export function isUsagePurpose(value) {
  return typeof value === 'string' && USAGE_PURPOSES.includes(/** @type {UsagePurpose} */ (value))
}

/** The purpose to record: the caller's, when it names one of the set, else
 *  `other`. Each caller's own test pins the purpose it passes, which is where
 *  a misspelling is caught, not here in the middle of a model call.
 *  @param {unknown} value @returns {UsagePurpose} */
export function usagePurpose(value) {
  return isUsagePurpose(value) ? value : 'other'
}

/**
 * The purpose of a request a runtime makes, from the run it belongs to.
 *
 * Everything the kernel does is `kernel` — a delegated review or screening
 * child, a method distillation, a compaction summary are the kernel working
 * for a run. Source understanding is the exception because it is not a
 * researcher's run: it is what ingesting a document into the knowledge base
 * costs, dispatched by the source pipeline, and a report that folded it into
 * `kernel` would hide the price of the knowledge base inside the price of
 * research.
 *
 * Learning is the second exception, for the same reason and one more: the
 * loop's own runs — distilling a method, relating methods, the paired
 * evaluation that can retire one — are not a researcher's work, and the
 * learning caps must be able to count exactly them. Until 2026-09-21 they were
 * `kernel`, so a learning cap could only be compared with everything the
 * account spent: a researcher's own day of research used the learning budget
 * up, and every lesson from that day was refused (production, 2026-09-20: three
 * of three distillations, `usage_budget_exceeded`).
 *
 * Every input here is something the control plane's own code writes into the
 * run: the capability it bound (`effectiveAgentId`, drawn from the registry —
 * the public dispatch route refuses an internal capability) and the route
 * reason its dispatcher stamped. Nothing the browser can type decides a
 * purpose. Until 2026-10-05 the dispatch id did: `POST /api/agent-runs/dispatch`
 * takes `dispatchId` from the caller, so an id spelled `evolution_…` or
 * `methodeval_…` booked an ordinary run outside the account's caps and, under
 * research billing, waived its charge. A dispatch id is an identity for
 * replay, never a classification; a dispatcher that wants a platform purpose
 * says so with a route reason from `PLATFORM_ROUTE_PURPOSES`.
 *
 * @param {{ effectiveAgentId?: string | null, effectiveRouteReason?: string | null } | null | undefined} run
 * @returns {UsagePurpose}
 */
export function usagePurposeOfRun(run) {
  const reason = String(run?.effectiveRouteReason ?? '')
  if (Object.hasOwn(PLATFORM_ROUTE_PURPOSES, reason)) return PLATFORM_ROUTE_PURPOSES[reason]
  const agent = String(run?.effectiveAgentId ?? '')
  if (['evolution-scout', 'tool-builder'].includes(agent)) return 'evolution'
  if (agent === 'source-understanding') return 'source-understanding'
  if (LEARNING_AGENT_IDS.includes(agent)) return 'learning'
  return 'kernel'
}

/**
 * Whether a run's spend is the researcher's to pay. The answer is the run's
 * purpose and nothing else: a run is chargeable exactly when it is the kernel
 * working on a researcher's question, whoever started it and whatever the
 * caller said about it.
 *
 * It is not `isResearcherOwnedWork`, which answers a different question — is
 * this a lesson, an interest signal — and rightly lets a caller say that a
 * run is an evaluation harness's (`automated`). That statement is typed by the
 * caller of the public dispatch route, so reading it for the charge made
 * `{"automated": true}` a way to research for nothing under research billing.
 * Managed work (GEO, proactive, 虚拟临研) is chargeable as it always was: it
 * is kernel work.
 * @param {{ effectiveAgentId?: string | null, effectiveRouteReason?: string | null } | null | undefined} run
 * @returns {boolean}
 */
export function isChargeableResearchRun(run) {
  return Boolean(run) && usagePurposeOfRun(run) === 'kernel'
}

/**
 * Work performed for a researcher includes their managed GEO and proactive
 * workflows. Platform evaluations and the learning loop's own jobs do not.
 * Callers still enforce project ownership and exclude internal projects.
 * This is a research-signal question (a lesson, an interest), not a money one:
 * `automated` is the caller's own statement that a harness started the run, and
 * it is honoured here so a harness's traffic teaches nothing. What a run costs
 * its account is `isChargeableResearchRun`.
 * @param {{ automated?: boolean, effectiveRouteReason?: string | null,
 * effectiveAgentId?: string | null } | null | undefined} run
 * @returns {boolean}
 */
export function isResearcherOwnedWork(run) {
  if (!run || usagePurposeOfRun(run) !== 'kernel') return false
  const route = String(run.effectiveRouteReason ?? '')
  const managedResearch = route.startsWith('geo:') || route.startsWith('autopilot:') || route.startsWith('vcr:')
  return run.automated !== true || managedResearch
}

/** The learning loop's two internal capabilities. */
export const LEARNING_AGENT_IDS = Object.freeze(['method-distillation', 'method-relations'])

/**
 * Route reasons only the control plane writes, for work it dispatches on its
 * own account, and the purpose each books. The public dispatch route computes
 * its own reasons (`choice:`, `matched:`, `llm:`, `unrouted:`, `session-binding`)
 * and never takes one from the caller, so none of these can be produced from a
 * browser. A new platform dispatcher adds its reason here and stamps it.
 *  - `platform-evolution`: 「循证进化」's development and evaluation runs.
 *  - `platform-learning`: a paired-evaluation cell — an ordinary capability run
 *    the learning loop makes of its own to measure a method.
 */
export const PLATFORM_ROUTE_PURPOSES = Object.freeze(/** @type {Record<string, UsagePurpose>} */ ({
  'platform-evolution': 'evolution',
  'platform-learning': 'learning',
}))

/**
 * What every paired-evaluation dispatch id starts with. An identifier the
 * evaluation mints for its own cells and looks them up by; it classifies
 * nothing, because the dispatch route takes a dispatch id from its caller.
 */
export const LEARNING_EVALUATION_DISPATCH_PREFIX = 'methodeval_'
