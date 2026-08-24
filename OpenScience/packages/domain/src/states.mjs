/**
 * The four state vocabularies and the only function allowed to move between
 * their values.
 *
 * Hidden knowledge: which transitions exist. A `status` column that anyone can
 * assign is a shared mutable global (ch.5); routing every write through
 * `transition()` turns an illegal move into a thrown error at the site that
 * attempted it, instead of a wrong value discovered three subsystems later.
 * The run ledger, the socket's run mirror, the evidence table and the control
 * plane all write through here.
 */

/**
 * The nine-state run lifecycle — a *projection*, never a stored field (§7.1.1,
 * decision 2026-08-24 #20). The run ledger's own, authoritative `status` column
 * has four values (`running` / `succeeded` / `failed` / `canceled`); these nine
 * are derived from it, plus `dispatchStatus`, `verification`, `partial` and
 * whether progress has been observed, by the one pure function below,
 * `runPhase()`. Naming it `RUN_STATES` first and discovering only after the
 * ledger existed that it was not the ledger's vocabulary is exactly the "two
 * things with one name" this file exists to prevent — `RUN_PHASES` is the
 * corrected name, so a reader never mistakes this for something a caller may
 * assign.
 */
export const RUN_PHASES = Object.freeze([
  'reserved',
  'dispatched',
  'running',
  'delivering',
  'repairing',
  'accepted',
  'degraded',
  'failed',
  'canceled',
])

/** Lifecycle of one planned deliverable inside a run. */
export const PLAN_ITEM_STATES = Object.freeze([
  'planned',
  'queued',
  'delegated',
  'submitted',
  'accepted',
  'rejected',
  'failed',
])

/** Lifecycle of one evidence record in the run's evidence table (§7.3). */
export const EVIDENCE_STATES = Object.freeze(['queued', 'ready', 'verified', 'rejected', 'stale'])

/** Why a DSH turn ended; `unknown` is ours, for a kind this build does not know. */
export const TURN_END_KINDS = Object.freeze([
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'unknown',
])

/** How much of a delivered claim set was actually checked. */
export const VERIFICATION_STATES = Object.freeze(['verified', 'unverified', 'unchecked'])

/** Confidence tier of an autopilot claim (§24.4.4). Only a verification episode may raise it. */
export const CLAIM_TIERS = Object.freeze(['unverified', 'gated', 'reproduced'])

/** Every vocabulary, keyed the way `transition()` names its tables. */
export const states = Object.freeze({
  run: RUN_PHASES,
  planItem: PLAN_ITEM_STATES,
  evidence: EVIDENCE_STATES,
  turnEnd: TURN_END_KINDS,
  verification: VERIFICATION_STATES,
  claimTier: CLAIM_TIERS,
})

/**
 * from → event → to, per table. An event name that is absent for the current
 * state is an illegal move; a state that is absent entirely is terminal.
 * @type {Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>}
 */
const TRANSITIONS = Object.freeze({
  run: Object.freeze({
    reserved: Object.freeze({ dispatch: 'dispatched', cancel: 'canceled', fail: 'failed' }),
    // Every event `running` accepts, `dispatched` accepts too: nothing about
    // being dispatched but not yet progressed rules out a run that finishes (or
    // gets its kernel turn cut short) before the first progress observation
    // ever lands. `finishInternal`'s own precondition is `status === "running"`
    // — dispatchStatus and progress do not gate it — so a dispatched-but-silent
    // run reaching a terminal event directly is not a corrupted sequence, it is
    // a fast one, and the phase-adjacency check (§7.1.1) would otherwise flag
    // every quick success as illegal.
    dispatched: Object.freeze({
      progress: 'running',
      deliver: 'delivering',
      cancel: 'canceled',
      fail: 'failed',
      accept: 'accepted',
      degrade: 'degraded',
    }),
    running: Object.freeze({
      progress: 'running',
      deliver: 'delivering',
      cancel: 'canceled',
      fail: 'failed',
      accept: 'accepted',
      degrade: 'degraded',
    }),
    delivering: Object.freeze({
      accept: 'accepted',
      degrade: 'degraded',
      repair: 'repairing',
      fail: 'failed',
      cancel: 'canceled',
    }),
    repairing: Object.freeze({ progress: 'running', fail: 'failed', cancel: 'canceled', degrade: 'degraded' }),
  }),
  planItem: Object.freeze({
    planned: Object.freeze({ queue: 'queued', delegate: 'delegated', fail: 'failed' }),
    queued: Object.freeze({ delegate: 'delegated', fail: 'failed' }),
    delegated: Object.freeze({ submit: 'submitted', fail: 'failed', delegate: 'delegated' }),
    submitted: Object.freeze({ accept: 'accepted', reject: 'rejected', fail: 'failed' }),
    rejected: Object.freeze({ delegate: 'delegated', submit: 'submitted', fail: 'failed' }),
  }),
  evidence: Object.freeze({
    queued: Object.freeze({ ready: 'ready', reject: 'rejected', stale: 'stale' }),
    ready: Object.freeze({ verify: 'verified', reject: 'rejected', stale: 'stale' }),
    stale: Object.freeze({ ready: 'ready', reject: 'rejected' }),
  }),
  claimTier: Object.freeze({
    unverified: Object.freeze({ gate: 'gated' }),
    gated: Object.freeze({ reproduce: 'reproduced', refute: 'unverified' }),
    reproduced: Object.freeze({ refute: 'unverified' }),
  }),
})

/** Thrown when a caller attempts a move the table does not have. */
export class IllegalTransitionError extends Error {
  /** @param {string} table @param {string} from @param {string} event */
  constructor(table, from, event) {
    super(`illegal ${table} transition: ${from} --${event}-->`)
    this.name = 'IllegalTransitionError'
    this.table = table
    this.from = from
    this.event = event
    this.code = 'illegal_state_transition'
  }
}

/**
 * The single writer of every `status` field in the system.
 * @param {'run'|'planItem'|'evidence'|'claimTier'} table
 * @param {string} from
 * @param {string} event
 * @returns {string}
 */
export function transition(table, from, event) {
  const byState = TRANSITIONS[table]
  if (!byState) throw new IllegalTransitionError(String(table), String(from), String(event))
  const byEvent = byState[from]
  const next = byEvent ? byEvent[event] : undefined
  if (!next) throw new IllegalTransitionError(String(table), String(from), String(event))
  return next
}

/**
 * Whether the move is legal, for callers that need to branch rather than throw
 * (the UI greys out an action instead of crashing on it).
 * @param {'run'|'planItem'|'evidence'|'claimTier'} table @param {string} from @param {string} event
 * @returns {boolean}
 */
export function canTransition(table, from, event) {
  const byState = TRANSITIONS[table]
  const byEvent = byState ? byState[from] : undefined
  return Boolean(byEvent && byEvent[event])
}

/**
 * Every legal move out of a state, for tests that must enumerate them.
 * @param {'run'|'planItem'|'evidence'|'claimTier'} table @param {string} from
 * @returns {readonly string[]}
 */
export function transitionEvents(table, from) {
  const byState = TRANSITIONS[table]
  const byEvent = byState ? byState[from] : undefined
  return byEvent ? Object.freeze(Object.keys(byEvent)) : Object.freeze([])
}

/** Run phases from which nothing further happens (a projection, like `RUN_PHASES` itself — see its doc comment). */
export const TERMINAL_RUN_PHASES = Object.freeze(['accepted', 'degraded', 'failed', 'canceled'])

/** @param {string} phase @returns {boolean} */
export function isTerminalRunPhase(phase) {
  return TERMINAL_RUN_PHASES.includes(String(phase))
}

/**
 * The one place the mapping from the ledger's own vocabulary to the nine-state
 * projection is written (§7.1.1, decision 2026-08-24 #20). A pure function
 * over the ledger's folded record, never a stored field — computed fresh every
 * time a run is read, so nothing can hold a stale phase.
 *
 * The record shape reflects what the ledger's fold produces today. `turnEnded`
 * and `awaitingRepairDispatch` are optional because the ledger does not yet
 * carry the finer-grained signal they need (§3.1's four ledger items, not this
 * change) — omitted, they simply mean the record cannot be `delivering` or
 * `repairing` yet, which is the correct, conservative answer: a run that might
 * be mid-delivery but that the caller cannot yet distinguish from an ordinary
 * one in progress is not wrongly labelled something more specific than the
 * caller actually knows.
 *
 * @param {{
 *   status: 'running' | 'succeeded' | 'failed' | 'canceled',
 *   dispatchStatus?: 'dispatching' | 'accepted' | 'unknown' | 'rejected',
 *   verification?: string | null,
 *   partial?: boolean,
 *   hasProgressEvent: boolean,
 *   turnEnded?: boolean,
 *   awaitingRepairDispatch?: boolean,
 * }} record
 * @returns {string}
 */
export function runPhase(record) {
  const status = String(record?.status ?? '')
  if (status === 'failed') return 'failed'
  if (status === 'canceled') return 'canceled'
  if (status === 'succeeded') {
    const verification = record?.verification ?? null
    const degraded = Boolean(record?.partial) || verification === 'unverified' || verification === 'unchecked'
    return degraded ? 'degraded' : 'accepted'
  }
  if (status !== 'running') {
    // Not one of the ledger's own four values. The caller passed something
    // this function does not recognize; refusing a guess is what makes an
    // unrecognized status visible instead of silently reading as "reserved".
    throw new TypeError(`runPhase: unknown ledger status "${status}"`)
  }
  // Most specific first: a run that is also mid-repair or mid-delivery is not
  // usefully described as merely "running", even though both conditions
  // co-occur with having produced progress.
  if (record?.awaitingRepairDispatch) return 'repairing'
  if (record?.turnEnded) return 'delivering'
  if (record?.hasProgressEvent) return 'running'
  // The table names only `dispatching` and `accepted`. A dispatch that came
  // back `unknown` or `rejected` while the run itself is still `running` is an
  // anomaly the fold already logs elsewhere (recovery reclassifies an orphaned
  // `dispatching` run to `unknown`); reading it as `reserved` here is the
  // conservative default, not a claim about what actually happened to it.
  return record?.dispatchStatus === 'accepted' ? 'dispatched' : 'reserved'
}
