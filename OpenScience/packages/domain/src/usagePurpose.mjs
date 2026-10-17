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

/** @typedef {'kernel'|'memory-extraction'|'routing'|'title'|'task-type'|'engine'|'capsule-scan'|'channel-intent'|'source-understanding'|'knowledge'|'learning'|'autopilot'|'frontier'|'review'|'geo'|'vcr'|'web-search'|'evolution'|'evidence'|'evidence-upkeep'|'other'} UsagePurpose */

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
 *  the frontier budget (plan §3.3). `knowledge` is the model calls
 *  OpenViking's Compile makes while it writes a project's knowledge pages and
 *  knowledge graph: no run of ours makes them, so the model gateway books
 *  them by the bearer the engine's Compile agent carries, to the platform's
 *  internal `evimed-openviking` project and under the engine's own daily
 *  budget. What a compile used of its account's `knowledge` caps is counted
 *  separately, by the page service, from the tokens each task reports.
 *  `task-type` is the one small call that says what kind of work a finished
 *  conversation was (writing, a spreadsheet, code, …) so the memory map's
 *  「在做什么」 radar can be drawn for any account, not only for the ones that
 *  used a named capability: made on the researcher's own conversation, counted
 *  against their caps like a run title, and held by its own daily bound. */
export const USAGE_PURPOSES = /** @type {readonly UsagePurpose[]} */ (Object.freeze([
  'kernel',
  'memory-extraction',
  'routing',
  'title',
  'task-type',
  'engine',
  'capsule-scan',
  'channel-intent',
  'source-understanding',
  'knowledge',
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
  'task-type': '任务类型判断',
  engine: '专科引擎',
  'capsule-scan': '胶囊扫描',
  'channel-intent': '渠道意图',
  'source-understanding': '资料理解',
  knowledge: '知识页编译',
  learning: '学习做法',
  autopilot: '定时任务规划',
  frontier: '前沿动态',
  review: '成果审查',
  geo: '循证 GEO',
  vcr: '虚拟临床研究',
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
  if (isEvidenceProgrammeRouteReason(reason)) return 'evidence'
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
 * Managed work (GEO, proactive, 虚拟临床研究) is chargeable as it always was: it
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
  // The independent re-check of a scheduled task's claim is the platform's own work on the researcher's behalf, paid from the
  // task's budget but never something they asked or did: it teaches nothing and is no interest of theirs.
  if (isVerificationRun(run)) return false
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
 *  - `platform-learning`: a run the learning loop dispatched on its own account.
 *    Only the paired evaluation of a method wrote it, and that was deleted on
 *    2026-10-10; it stays so that a ledger row it wrote still books as learning
 *    and not as a researcher's research.
 */
export const PLATFORM_ROUTE_PURPOSES = Object.freeze(/** @type {Record<string, UsagePurpose>} */ ({
  'platform-evolution': 'evolution',
  'platform-learning': 'learning',
}))

/**
 * The route reasons of the platform's own evidence programme (evidence-flywheel plan §5.1, F01, 2026-10-05): the
 * episodes of an agenda the publisher account runs in its internal `evimed-evidence` project, and the independent
 * verifications of their claims. They keep the `autopilot:` family's prefix on purpose — the completion fold, the
 * usage keys of a bounded runtime and the dispatch recovery all recognise an autopilot run by it — and add the one word
 * that makes the run the platform's: `usagePurposeOfRun` reads these as `evidence`, so none of the programme's
 * model spend is a researcher's to pay or counts against anyone's caps, and `isChargeableResearchRun` is false for it.
 * Only the control plane's own dispatcher (`server.mjs`, for an agenda owned by the publisher in that project) writes
 * them; the public dispatch route computes its own reasons and never takes one from a caller.
 */
export const EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX = 'autopilot:evidence:'
export const EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON = 'autopilot-verify:evidence'

/**
 * What the control plane stamps on the independent re-check of one claim of a scheduled execution (`dispatchVerification` in
 * `server.mjs`): a run of its own in a scratch workspace and a bounded runtime, with the claim and its sources as its whole
 * question. Deliberately not an `autopilot:` reason (the completion fold reads that prefix as an episode). The platform's own
 * programme stamps `EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON` on its own. Both are written by the control plane alone.
 */
export const AUTOPILOT_VERIFICATION_ROUTE_REASON = 'autopilot-verify'

/**
 * Whether a route reason is that of a verification run, of either kind.
 * @param {unknown} reason @returns {boolean}
 */
export function isVerificationRouteReason(reason) {
  const text = String(reason ?? '')
  return text === AUTOPILOT_VERIFICATION_ROUTE_REASON || text === EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON
}

/**
 * Whether a run is a verification run, decided by the route reason the control plane wrote and never by its title or its text.
 * @param {{ effectiveRouteReason?: string | null } | null | undefined} run @returns {boolean}
 */
export function isVerificationRun(run) {
  return isVerificationRouteReason(run?.effectiveRouteReason)
}

/**
 * The route-reason prefixes of a module's own programme steps: a run the module's orchestrator dispatched into the study's project
 * (`vcr:definition`, `vcr:export-study_package`, …). Written by the control plane's dispatcher alone — the public dispatch route
 * computes its own reasons and never takes one from a caller — so a prefix is a fact about who started the run, never about its text.
 * 「循证 GEO」's steps (`geo:`) are the same kind of run and are not listed until its own pages stop presenting them as conversations.
 */
export const PROGRAMME_ROUTE_REASON_PREFIXES = Object.freeze(['vcr:'])

/**
 * The route-reason prefix of a module step that ran as a turn of the study's own conversation (`vcr:turn:definition`, …): the
 * same step as `vcr:definition`, with the person present, in their conversation — so it stays under the module's `vcr:` family (its
 * purpose, its budget, its exclusion from what memory learns) and is a conversation's turn, never a programme run (`isProgrammeRun`).
 */
export const CONVERSATION_TURN_ROUTE_REASON_PREFIX = 'vcr:turn:'

/**
 * The route reason a step's run takes when it is a turn of the study's conversation: `vcr:definition` → `vcr:turn:definition`.
 * A reason of another family is returned as it is.
 * @param {string} reason @returns {string}
 */
export function conversationTurnRouteReason(reason) {
  const text = String(reason ?? '')
  if (!text.startsWith('vcr:') || text.startsWith(CONVERSATION_TURN_ROUTE_REASON_PREFIX)) return text
  return `${CONVERSATION_TURN_ROUTE_REASON_PREFIX}${text.slice('vcr:'.length)}`.slice(0, 64)
}

/**
 * Whether a run is a module step that ran in the study's own conversation, decided by the route reason the control plane wrote.
 * @param {{ effectiveRouteReason?: string | null } | null | undefined} run @returns {boolean}
 */
export function isConversationTurnRun(run) {
  return String(run?.effectiveRouteReason ?? '').startsWith(CONVERSATION_TURN_ROUTE_REASON_PREFIX)
}

/**
 * Whether a run is one of a module's programme steps, decided by the route reason the control plane wrote at dispatch. A step that
 * ran as a turn of the study's conversation is not: it is what the person asked for in their conversation.
 * @param {{ effectiveRouteReason?: string | null } | null | undefined} run @returns {boolean}
 */
export function isProgrammeRun(run) {
  const reason = String(run?.effectiveRouteReason ?? '')
  if (isConversationTurnRun(run)) return false
  return PROGRAMME_ROUTE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
}

/**
 * The closed set of roles a run can have in the platform's own bookkeeping, which a list of the person's conversations reads to
 * leave the platform's back office out. A run with none is an ordinary one.
 *  - `verification`: the independent re-check of a claim (`isVerificationRun`).
 *  - `programme`: a step of a module's programme, run in the study's project for the study (`isProgrammeRun`): the study's page
 *    says what it is doing and what it made, and its conversation is the study's own, never one of these.
 */
export const RUN_ROLES = Object.freeze(['verification', 'programme'])

/**
 * The role of a run, derived from what the control plane wrote at dispatch, or null for an ordinary run. One mark, computed once
 * on the server and carried by the run list (`role`), so no list matches route-reason strings of its own.
 * @param {{ effectiveRouteReason?: string | null } | null | undefined} run
 * @returns {'verification' | 'programme' | null}
 */
export function runRoleOf(run) {
  if (isVerificationRun(run)) return 'verification'
  return isProgrammeRun(run) ? 'programme' : null
}

/** The route reason of one programme episode of `taskType`. @param {string} taskType @returns {string} */
export function evidenceProgrammeRouteReason(taskType) {
  return `${EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX}${taskType}`
}

/** @param {unknown} reason @returns {boolean} */
export function isEvidenceProgrammeRouteReason(reason) {
  const text = String(reason ?? '')
  return text.startsWith(EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX) || text === EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON
}

