/**
 * Structured compaction: the summariser that has to keep the run's handles.
 *
 * Compaction is the one place where losing a single string loses the run. The
 * upstream backend condenses a region of the conversation into free prose, and
 * prose is exactly where `task-plan.json`, a source id, or a deliverable digest
 * stops existing - silently, because a summary that dropped a path still reads
 * like a good summary. The run then keeps working from a checkpoint that no
 * longer names the artefact it is supposed to be repairing.
 *
 * So the region summary is written twice over: a deterministic STATE HANDLES
 * block listing every durable identifier, and a free summary of the region. The
 * handles are then *checked* in code - deterministic membership, not a model
 * asserting it complied - and a summary that lost one is retried once naming
 * what it lost, then abandoned in favour of the plain upstream result. Losing a
 * handle must never fail the compaction: a run that cannot compact dies at the
 * context wall, which is strictly worse than a checkpoint with a named
 * degradation recorded against it.
 *
 * Two upstream facts shape the file, and the design note's reading of each is
 * wrong, so both are named here:
 *
 *   1. `summarizeWithLlm` is NOT exported. `@deepseek-ai/dsh-compaction-basic`
 *      declares it in `lib/types/summarizer.d.ts`, but the published bundle
 *      exports only `{ BasicCompactionEngine, default }` - the function is
 *      module-internal and `./src/*` is not in the package's `files`. There is
 *      no supported way to run the upstream summarisation call while replacing
 *      its directive, so the augmented call goes through the base's own
 *      `summarize()` hook, which appends its checkpoint-structure directive
 *      after ours. That ordering is why the EviMed directive below is written
 *      as content-selection rules the structure directive inherits, rather than
 *      as a competing output format.
 *   2. The base class is not installed in this workspace and must not be
 *      imported at module load. `pnpm-lock.yaml` names no compaction package;
 *      the runtime image installs them. A static import would make this file
 *      unloadable under `node --test`, so the subclass is produced by a factory
 *      over an injected base class, and `loadEvimedCompactionEngine()` resolves
 *      the pinned one lazily through the port's single loader.
 *
 * @module @evimed/harness-port/compaction
 */

import { randomUUID } from 'node:crypto'
import SEAMS from '../seam-manifest.json' with { type: 'json' }
import { loadHarnessModule } from '../index.mjs'

/**
 * One durable identifier the summary may not lose.
 *
 * `id` is the literal token checked against the summary text, so it must be
 * something the model can reproduce byte for byte - a path, a source id, a
 * digest, a numeric budget. `detail` is free context for the model and is never
 * checked. Neither field is redacted here: handles come from the run's own
 * projection, the caller owns redaction, and redacting an id would make the
 * deterministic check unsatisfiable.
 *
 * @typedef {object} StateHandle
 * @property {string} kind one of {@link STATE_HANDLE_KINDS}; an unknown kind is kept and sorted last
 * @property {string} id the token that must survive verbatim
 * @property {string} [detail] one line of context, not checked
 */

/**
 * The injection seam. Everything the engine needs that is not the conversation
 * itself arrives here, so the whole flow runs against a fake with no kernel.
 *
 * `readHandles` is the caller's projection reader - in the runtime it reads the
 * `evimed_run` storage domain rather than the workspace files, because a
 * summariser that read the workspace would summarise whatever an upload just
 * put there. Absent, or returning nothing, means "no handles", and the engine
 * then behaves exactly like the base class.
 *
 * `summarise` replaces the base summarisation path in full: both the augmented
 * attempts and the plain fallback go through it. That is deliberate - one seam
 * means a test drives every branch with one fake, and it keeps the fallback
 * honestly identical to the path it is falling back to. Absent means
 * `super.summarize`.
 *
 * `observe` receives {@link CompactionObservation}s. It may throw; a metrics
 * sink must not be able to fail a compaction.
 *
 * `takeCompactRequest` is consulted once per step and must *consume* the
 * request: a marker that survives the compaction it asked for would compact
 * again on the next step, and again, until the session had nothing left.
 *
 * @typedef {object} CompactionDeps
 * @property {(agent: any, signal?: AbortSignal) => StateHandle[] | Promise<StateHandle[]>} [readHandles]
 * @property {(input: any, agent: any, signal?: AbortSignal) => Promise<any>} [summarise]
 * @property {(observation: CompactionObservation) => void} [observe]
 * @property {(agent: any) => {reason?: string} | null} [takeCompactRequest]
 */

/**
 * @typedef {object} CompactionObservation
 * @property {string} event one of {@link COMPACTION_OBSERVATIONS}
 * @property {string} reason machine code, never a sentence
 * @property {string} sessionId the session the compaction belongs to, or `''`
 * @property {number} handles how many handles were required
 * @property {string[]} missing the handles that did not survive, in packet order
 * @property {string} [note] the model's own words, when the observation is about
 *   something it asked for; for a reader judging whether the request was sensible
 * @property {string} [detail] a failure message, truncated
 * @property {number} attempts how many augmented summarisation calls were made
 */

/** The two policies the composition may mount. Exactly one engine is mounted:
 *  `basic` is the upstream class, `structured` is the subclass in this file. */
export const COMPACTION_POLICIES = Object.freeze(['basic', 'structured'])

/** Kind order in the packet, which is reading order for a resuming model: what
 *  the plan is, where the run got to, what it read, what it produced, what it
 *  still owes. */
export const STATE_HANDLE_KINDS = Object.freeze([
  'plan',
  'projection',
  'correction',
  'source',
  'deliverable',
  'repair',
  'method',
  'budget',
])

/** How a mid-run correction is marked in the conversation.
 *
 *  The control plane wraps a researcher's correction in this tag before handing
 *  it to the kernel, and this engine lifts it back out into a handle. The
 *  published implementations of mid-run steering all warn about the same
 *  failure: a steered instruction that is treated as an ordinary user message
 *  can be summarised away while the assistant turn it modified is kept, and
 *  what the model then reads is the original task with the correction removed.
 *  A run that loses a correction does not fail — it confidently does the thing
 *  it was told to stop doing. */
const CORRECTION_MARKER = /<evimed-correction>([\s\S]{1,4000}?)<\/evimed-correction>/g

/** The named failure a lost handle produces. It is a reason code on an
 *  observation and never a thrown error: see the module note. */
export const COMPACTION_HANDLE_LOST = 'compaction_handle_lost'

/** Reason codes the degradation observation carries. */
export const COMPACTION_DEGRADATIONS = Object.freeze([
  COMPACTION_HANDLE_LOST,
  'handles_unavailable',
  'summarizer_failed',
  'fallback_failed',
  'request_failed',
])

/** What a manager-requested compaction did. `nothing_to_compact` is the
 *  ordinary answer on a short session and is not a failure: the request was
 *  heard, and there was no safe range to give back. */
export const COMPACTION_REQUEST_OUTCOMES = Object.freeze(['compacted', 'nothing_to_compact', 'request_failed'])

/** Observation names. `preserved` is not noise: the policy grid in
 *  `evals/context-fidelity/` is chosen from the distribution of `attempts`, and
 *  a counter that only fires on failure has no distribution to read. */
export const COMPACTION_OBSERVATIONS = Object.freeze({
  preserved: 'compaction/handles-preserved',
  degraded: 'compaction/policy-degraded',
  requested: 'compaction/requested',
})

/** The plugin name stamped on the messages this engine appends, so the durable
 *  log tells them apart from the run's own turns. */
export const COMPACTION_PLUGIN = 'evimed-compaction'

/** First line of the packet, and the marker the retry directive points back at. */
export const STATE_HANDLE_HEADING = 'STATE HANDLES'

/** Last line of the packet. A closing marker, so the block has an end even when
 *  a handle detail is long. */
export const STATE_HANDLE_FOOTER = 'END STATE HANDLES'

const STATE_HANDLE_PREAMBLE
  = 'Durable state of this run, listed as `[kind] identifier - context`. '
  + 'Every identifier below must appear verbatim in your summary. '
  + 'Do not abbreviate, translate, re-derive, renumber or invent one, '
  + 'and do not replace an identifier with a description of it.'

/**
 * The free-summary directive, ported from EvoDS.
 *
 * It is appended before the base class's own checkpoint-structure directive
 * (see the module note), so it governs what goes in and leaves the section
 * layout to the directive that follows. The numbered-item rule is scoped to the
 * items inside those sections, which is compatible with that structure and is
 * the part of EvoDS carrying the value: one fact per item, self-contained, so a
 * resuming model can use any single line without reading the ones around it.
 *
 * The last rule is easy to leave out and expensive to omit. A checkpoint is
 * navigation. A claim that exists only because an earlier summary said so has
 * no source behind it, and the evidence gate will accept it as a citation if
 * the summary is allowed to read as one.
 */
export const EVIMED_SUMMARY_INSTRUCTION = [
  'Additional requirements for this checkpoint. They take precedence over any general guidance about what to include.',
  '',
  'Include:',
  '- environment facts: versions, paths, hosts, credentials by name (never their values), and anything about this machine that was discovered rather than assumed;',
  '- data facts: what each dataset or source actually contains, its size, its identifiers, and the access level it was read at;',
  '- decisions and their reasons, including decisions not to do something;',
  '- intermediate results, with the numbers as they were produced;',
  '- tool usage and format conventions that were established and are still in force.',
  '',
  'Exclude:',
  '- pleasantries, acknowledgements, and restatements of the task. The task statement is preserved outside this checkpoint, and restating it spends the budget the checkpoint was supposed to free;',
  '- information a later message superseded. Keep the current value, not the history of it;',
  '- failed attempts that revealed nothing. Keep a failure that revealed a constraint, and state the constraint rather than the attempt.',
  '',
  'Form:',
  '- write the items inside each section as a numbered list;',
  '- each item is self-contained, precise, and carries exactly one fact;',
  '- reproduce identifiers, paths, digests, commands and numeric values exactly as they appeared.',
  '',
  `Reproduce every identifier from the ${STATE_HANDLE_HEADING} block verbatim, each in the section it belongs to.`,
  'This checkpoint is navigation, not a source. Nothing in it may be cited, and a fact that appears only here must be re-established from its own source before it is used in a deliverable.',
  '',
  'Do not call any tool, and take no action other than writing the checkpoint.',
].join('\n')

/** Config defaults, recorded from the pinned backend so a change upstream reads
 *  as a diff here rather than as a silently different threshold. Read from
 *  `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.1`. */
export const COMPACTION_DEFAULTS = Object.freeze({
  policy: 'basic',
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
})

/**
 * Env names per setting, most specific first.
 *
 * Two namespaces because there are two sides of one container boundary: the
 * control plane decides in `OPEN_SCIENCE_RUNTIME_COMPACTION_*` and forwards
 * `EVIMED_COMPACTION_*`, which is what the preset rows read. One derivation
 * function reads both, so the two sides cannot disagree about what `0.16`
 * means, and {@link compactionRuntimeEnv} produces the forwarded pairs - a knob
 * that is not on the compose env list does nothing and says nothing.
 */
export const COMPACTION_ENV_KEYS = Object.freeze({
  policy: Object.freeze(['EVIMED_COMPACTION_POLICY', 'OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY']),
  thresholdRatio: Object.freeze(['EVIMED_COMPACTION_THRESHOLD_RATIO', 'OPEN_SCIENCE_RUNTIME_COMPACTION_THRESHOLD_RATIO']),
  retainRatio: Object.freeze(['EVIMED_COMPACTION_RETAIN_RATIO', 'OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO']),
  retainTokens: Object.freeze(['EVIMED_COMPACTION_RETAIN_TOKENS', 'OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_TOKENS']),
  maxTokens: Object.freeze(['EVIMED_COMPACTION_MAX_TOKENS', 'OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS']),
})

/* ------------------------------------------------------------- the packet */

/**
 * The STATE HANDLES block: deterministic, deduplicated, sorted.
 *
 * Deterministic because the packet is a prompt prefix. Two runs holding the
 * same handles in a different order would produce two different prefixes and
 * lose the provider's cache on every compaction, which is a real cost paid for
 * nothing.
 *
 * @param {StateHandle[]} handles
 * @returns {string}
 */
/**
 * The corrections a conversation carries, as handles the summary must keep.
 *
 * Read off the messages rather than from the run mirror, because a correction
 * is not a durable project fact — it is a thing said in this conversation, and
 * the conversation is the only place that knows it was said. Deterministic:
 * a closed marker the control plane writes, never a judgement about which
 * sentences look like corrections.
 *
 * @param {readonly any[] | undefined} messages
 * @returns {StateHandle[]}
 */
export function correctionHandles(messages) {
  /** @type {StateHandle[]} */
  const handles = []
  const seen = new Set()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      const text = typeof block === 'string' ? block : block?.text
      if (typeof text !== 'string' || !text.includes('<evimed-correction>')) continue
      CORRECTION_MARKER.lastIndex = 0
      for (const match of text.matchAll(CORRECTION_MARKER)) {
        const body = match[1].trim()
        if (!body || seen.has(body)) continue
        seen.add(body)
        // Numbered in the order they were given: a resuming model reading two
        // corrections needs to know which one came second.
        handles.push({ kind: 'correction', id: `correction-${handles.length + 1}`, detail: body.slice(0, 400) })
      }
    }
  }
  return handles
}

/**
 * The handle packet the compaction must reproduce verbatim.
 * @param {StateHandle[] | any} handles
 * @returns {string}
 */
export function buildStateHandlePacket(handles) {
  const lines = [STATE_HANDLE_HEADING, STATE_HANDLE_PREAMBLE, '']
  for (const handle of canonicalHandles(handles)) {
    lines.push(handle.detail ? `[${handle.kind}] ${handle.id} - ${handle.detail}` : `[${handle.kind}] ${handle.id}`)
  }
  lines.push('', STATE_HANDLE_FOOTER)
  return lines.join('\n')
}

/**
 * Which handles are not in the summary.
 *
 * Whitespace is collapsed on both sides before the membership test, because a
 * summary that wrapped a long path across two lines did keep it. Case is not
 * folded, because a digest that differs by case is a different digest.
 *
 * @param {string} summaryText
 * @param {StateHandle[]} handles
 * @returns {string[]} the missing ids, in packet order
 */
export function missingHandles(summaryText, handles) {
  const haystack = collapse(typeof summaryText === 'string' ? summaryText : '')
  return canonicalHandles(handles)
    .filter((handle) => !haystack.includes(collapse(handle.id)))
    .map((handle) => handle.id)
}

/**
 * The retry directive. It names what was lost rather than repeating "keep the
 * handles": the first attempt already carried that instruction, and complying
 * with it harder is not an action a model can take.
 * @param {string[]} missing
 * @returns {string}
 */
export function strictHandleInstruction(missing) {
  const noun = missing.length === 1 ? 'identifier' : 'identifiers'
  return [
    EVIMED_SUMMARY_INSTRUCTION,
    '',
    `Your previous checkpoint dropped ${missing.length} required ${noun}. Write the checkpoint again, and this time include each of these verbatim, in the section it belongs to:`,
    ...missing.map((id) => `- ${id}`),
    'If you do not know where one of them belongs, put it under Critical Context with the context given for it above. Do not omit one because it looks unimportant.',
  ].join('\n')
}

/**
 * The text a `SummaryResult` actually shows the next model.
 * @param {any} result
 * @returns {string}
 */
export function summaryResultText(result) {
  const blocks = Array.isArray(result?.summary) ? result.summary : []
  return blocks
    .map((/** @type {any} */ block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * Sorted, deduplicated, defensive. Kind order is {@link STATE_HANDLE_KINDS}; a
 * kind we do not know is kept - dropping it would silently stop protecting a
 * handle someone added - and sorted after the known ones.
 * @param {any} handles
 * @returns {{ kind: string, id: string, detail?: string }[]}
 */
function canonicalHandles(handles) {
  /** @type {Map<string, { kind: string, id: string, detail?: string }>} */
  const unique = new Map()
  for (const entry of Array.isArray(handles) ? handles : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    const kind = typeof entry?.kind === 'string' && entry.kind.trim() ? entry.kind.trim() : 'other'
    const detail = typeof entry?.detail === 'string' && entry.detail.trim() ? collapse(entry.detail) : undefined
    const key = `${kind}\u0000${id}`
    const seen = unique.get(key)
    if (!seen) unique.set(key, detail === undefined ? { kind, id } : { kind, id, detail })
    else if (seen.detail === undefined && detail !== undefined) seen.detail = detail
  }
  return [...unique.values()].sort((left, right) => {
    const byRank = kindRank(left.kind) - kindRank(right.kind)
    if (byRank !== 0) return byRank
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** @param {string} kind @returns {number} */
function kindRank(kind) {
  const index = STATE_HANDLE_KINDS.indexOf(kind)
  return index === -1 ? STATE_HANDLE_KINDS.length : index
}

/** @param {string} text @returns {string} */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------- the config */

/**
 * Turn env into the backend's config, in one place.
 *
 * Nothing throws. A malformed ratio is reported and the default kept, because a
 * runtime refusing to boot over a typo in an optional tuning knob is a worse
 * outage than one compacting at 0.8. The caller emits `invalid` as a notice; it
 * is a list of `KEY=value (why)` strings, never a silent drop.
 *
 * `retainRatio` and `retainTokens` are mutually exclusive upstream - supplying
 * both fails plugin load - so an explicit absolute budget wins and the ratio is
 * reported as the one that lost.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ policy: string, config: { thresholdRatio: number, maxTokens: number, retainRatio?: number, retainTokens?: number }, invalid: string[] }}
 */
export function compactionConfigFromEnv(env = {}) {
  /** @type {string[]} */
  const invalid = []
  /** @param {readonly string[]} names @returns {{ name: string, value: string } | null} */
  const read = (names) => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return { name, value: value.trim() }
    }
    return null
  }

  /** @type {string} */
  let policy = COMPACTION_DEFAULTS.policy
  const rawPolicy = read(COMPACTION_ENV_KEYS.policy)
  if (rawPolicy) {
    if (COMPACTION_POLICIES.includes(rawPolicy.value)) policy = rawPolicy.value
    else invalid.push(`${rawPolicy.name}=${rawPolicy.value} (not one of ${COMPACTION_POLICIES.join(', ')})`)
  }

  const thresholdRatio = ratio(read(COMPACTION_ENV_KEYS.thresholdRatio), invalid) ?? COMPACTION_DEFAULTS.thresholdRatio
  const maxTokens = positiveInteger(read(COMPACTION_ENV_KEYS.maxTokens), invalid) ?? COMPACTION_DEFAULTS.maxTokens
  const retainTokens = positiveInteger(read(COMPACTION_ENV_KEYS.retainTokens), invalid)
  const rawRetainRatio = read(COMPACTION_ENV_KEYS.retainRatio)
  const retainRatio = ratio(rawRetainRatio, invalid)

  if (retainTokens !== null) {
    if (retainRatio !== null && rawRetainRatio) {
      invalid.push(`${rawRetainRatio.name}=${rawRetainRatio.value} (ignored: an absolute retain budget is also set)`)
    }
    return { policy, config: { thresholdRatio, maxTokens, retainTokens }, invalid }
  }
  return {
    policy,
    config: { thresholdRatio, maxTokens, retainRatio: retainRatio ?? COMPACTION_DEFAULTS.retainRatio },
    invalid,
  }
}

/**
 * The env pairs the control plane must forward into the runtime container,
 * derived from the same function that reads them so a setting cannot exist on
 * one side of the boundary only.
 * @param {{ policy: string, config: { thresholdRatio: number, maxTokens: number, retainRatio?: number, retainTokens?: number } }} derived
 * @returns {Record<string, string>}
 */
export function compactionRuntimeEnv(derived) {
  /** @type {Record<string, string>} */
  const env = {
    EVIMED_COMPACTION_POLICY: String(derived.policy),
    EVIMED_COMPACTION_THRESHOLD_RATIO: String(derived.config.thresholdRatio),
    EVIMED_COMPACTION_MAX_TOKENS: String(derived.config.maxTokens),
  }
  if (derived.config.retainTokens === undefined) env.EVIMED_COMPACTION_RETAIN_RATIO = String(derived.config.retainRatio)
  else env.EVIMED_COMPACTION_RETAIN_TOKENS = String(derived.config.retainTokens)
  return env
}

/** @param {{ name: string, value: string } | null} raw @param {string[]} invalid @returns {number | null} */
function ratio(raw, invalid) {
  if (!raw) return null
  const value = Number(raw.value)
  // The interval the backend's own `assertRatio` enforces. Validating it here
  // turns a plugin-load throw inside the container into a notice out here.
  if (Number.isFinite(value) && value > 0 && value <= 1) return value
  invalid.push(`${raw.name}=${raw.value} (must be a number in (0, 1])`)
  return null
}

/** @param {{ name: string, value: string } | null} raw @param {string[]} invalid @returns {number | null} */
function positiveInteger(raw, invalid) {
  if (!raw) return null
  const value = Number(raw.value)
  if (Number.isSafeInteger(value) && value > 0) return value
  invalid.push(`${raw.name}=${raw.value} (must be a positive integer)`)
  return null
}

/* ------------------------------------------------------------- the engine */

/**
 * The subclass, over an injected base.
 *
 * A factory rather than a `class ... extends BasicCompactionEngine`
 * declaration, because the base is not installed in this workspace and a static
 * import would make the module unloadable outside the runtime image - see the
 * module note. Statics reach cordis unchanged: `static inject` and
 * `static Config` are found through the subclass's own prototype chain.
 *
 * @param {new (...args: any[]) => any} BaseCompactionEngine the pinned `BasicCompactionEngine`
 * @param {CompactionDeps} [deps] bound for every instance the composition creates
 * @returns {new (...args: any[]) => any}
 */
export function createEvimedCompactionEngine(BaseCompactionEngine, deps = {}) {
  class EvimedCompactionEngine extends BaseCompactionEngine {
    /** @type {CompactionDeps} */
    #deps

    /** @param {any} ctx @param {any} [config] @param {CompactionDeps} [overrides] */
    constructor(ctx, config, overrides) {
      super(ctx, config)
      this.#deps = { ...deps, ...overrides }
      this.#registerRequestedCompaction(ctx)
    }

    /**
     * Serve a compaction the manager asked for, at the one place it can be served.
     *
     * Registered *after* `super()` on purpose. The base registers its own
     * `agent/pre-step` handler in its constructor, and a cordis waterfall runs
     * handlers in registration order, so the base's pressure check has already
     * finished by the time this one runs. That ordering is what keeps
     * `assertNoActiveCompaction` from ever seeing two compactions at once on
     * one session — the guard the base raises at its own pressure branch.
     *
     * Verified live on the pinned kernel (2026-09-07, probe V-2) rather than
     * inferred: the base itself calls `compactRegion` from this hook, and
     * `compactRegion` declares `owner: "current-turn"`. The constraint that
     * looked like "refuses while active" is the opposite — the region compactor
     * *requires* an open turn, which a pre-step has and an idle agent does not.
     * That is why `compactNow` is the wrong method here: it goes through
     * `agent.runMaintenance` and throws while a turn is in flight.
     *
     * `compactIfNeeded(agent, 'context-overflow', …)` rather than a hand-built
     * range. That branch skips the pressure threshold — which is the whole
     * point of an explicit request — retains nothing, and picks its own
     * balanced boundaries through the base's `selectCompactableRange`. Choosing
     * the boundaries here instead would mean reimplementing the balance rules
     * the region compactor enforces, and getting them wrong is a throw in the
     * middle of somebody's turn.
     *
     * @param {any} ctx
     */
    #registerRequestedCompaction(ctx) {
      ctx.on(SEAMS.events.preStep, async (/** @type {any} */ payload, /** @type {any} */ next) => {
        const { agent, signal } = payload ?? {}
        const take = this.#deps.takeCompactRequest
        // No consumer wired, or the step is already being abandoned: a
        // compaction on an aborted step spends a summarizer call on a turn that
        // is going away.
        if (typeof take !== 'function' || !agent || signal?.aborted) return next()
        /** @type {any} */
        let request = null
        try {
          request = take(agent)
        } catch {
          request = null
        }
        if (!request) return next()
        /** @type {string} */
        let outcome = 'compacted'
        /** @type {string} */
        let detail = ''
        try {
          const result = await this.compactIfNeeded(agent, 'context-overflow', signal)
          if (result === null) outcome = 'nothing_to_compact'
        } catch (error) {
          // A requested compaction that fails must not fail the step. The model
          // asked for room; not getting it is the state it was already in.
          outcome = 'request_failed'
          detail = error instanceof Error ? error.message : String(error)
        }
        this.#observeRequest(agent, request, outcome, detail)
        return next()
      })
    }

    /** @param {any} agent @param {any} request @param {string} outcome @param {string} detail */
    #observeRequest(agent, request, outcome, detail) {
      try {
        this.#deps.observe?.({
          event: COMPACTION_OBSERVATIONS.requested,
          reason: outcome,
          sessionId: sessionIdOf(agent),
          handles: 0,
          missing: [],
          attempts: 1,
          // The model's own words for why, truncated: a reason is for a reader
          // deciding whether the request was sensible, not a field to parse.
          note: String(request?.reason ?? '').slice(0, 200),
          ...(detail ? { detail: detail.slice(0, 200) } : {}),
        })
      } catch {
        // A metrics sink must not be able to fail a compaction, or a step.
      }
    }

    /**
     * The sole hook the backend exposes, and the only method overridden.
     *
     * @param {{ system?: string, tools?: readonly any[], messages: readonly any[] }} input
     * @param {any} agent
     * @param {AbortSignal} [signal]
     * @returns {Promise<any>}
     */
    async summarize(input, agent, signal) {
      const handles = [...correctionHandles(input?.messages), ...await this.#handles(agent, signal)]
      if (!handles.length) return this.#summarise(input, agent, signal)

      const packet = buildStateHandlePacket(handles)
      const sessionId = sessionIdOf(agent)
      /** @type {any} */
      let last = null
      /** @type {string[]} */
      let missing = []

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const directive = attempt === 1 ? EVIMED_SUMMARY_INSTRUCTION : strictHandleInstruction(missing)
        try {
          last = await this.#summarise(appendUserText(input, `${packet}\n\n${directive}`), agent, signal)
        } catch (error) {
          // A cancelled turn arrives here as one rejection like any other, and
          // retrying it would spend a second doomed call to reach the same
          // rejection. Cancellation is re-raised in the shape upstream already
          // handles; every other provider failure degrades to the plain call.
          if (signal?.aborted) throw error
          this.#observe({
            event: COMPACTION_OBSERVATIONS.degraded,
            reason: 'summarizer_failed',
            sessionId,
            handles: handles.length,
            missing: [],
            attempts: attempt,
          })
          return this.#summarise(input, agent, signal)
        }
        missing = missingHandles(summaryResultText(last), handles)
        if (!missing.length) {
          this.#observe({
            event: COMPACTION_OBSERVATIONS.preserved,
            reason: 'ok',
            sessionId,
            handles: handles.length,
            missing: [],
            attempts: attempt,
          })
          return last
        }
      }

      this.#observe({
        event: COMPACTION_OBSERVATIONS.degraded,
        reason: COMPACTION_HANDLE_LOST,
        sessionId,
        handles: handles.length,
        missing,
        attempts: 2,
      })
      try {
        return await this.#summarise(input, agent, signal)
      } catch (error) {
        // The structured attempt produced a usable checkpoint and only its
        // handle guarantee failed. Discarding a summary we already hold because
        // the unaugmented retry also failed would turn a degraded compaction
        // into no compaction, which is the wall this path exists to avoid.
        // A cancelled turn is the exception: committing a checkpoint for a turn
        // the caller abandoned is a durable write nobody asked for.
        if (signal?.aborted) throw error
        this.#observe({
          event: COMPACTION_OBSERVATIONS.degraded,
          reason: 'fallback_failed',
          sessionId,
          handles: handles.length,
          missing,
          attempts: 2,
        })
        return last
      }
    }

    /** @param {any} agent @param {AbortSignal} [signal] @returns {Promise<{ kind: string, id: string, detail?: string }[]>} */
    async #handles(agent, signal) {
      const read = this.#deps.readHandles
      if (!read) return []
      try {
        return canonicalHandles(await read(agent, signal))
      } catch {
        this.#observe({
          event: COMPACTION_OBSERVATIONS.degraded,
          reason: 'handles_unavailable',
          sessionId: sessionIdOf(agent),
          handles: 0,
          missing: [],
          attempts: 0,
        })
        return []
      }
    }

    /** @param {any} input @param {any} agent @param {AbortSignal} [signal] @returns {Promise<any>} */
    #summarise(input, agent, signal) {
      const injected = this.#deps.summarise
      if (injected) return injected(input, agent, signal)
      return super.summarize(input, agent, signal)
    }

    /** @param {CompactionObservation} observation @returns {void} */
    #observe(observation) {
      try {
        this.#deps.observe?.(observation)
      } catch {
        // isolated: evimed_compaction_observation_dropped_total
      }
    }
  }
  return EvimedCompactionEngine
}

/**
 * Resolve the pinned backend, prove its hook is still there, and subclass it.
 *
 * The probe runs before the subclass exists, on purpose. An override of a
 * method upstream renamed is not an error - it is a new method nobody calls,
 * and the run compacts with no handle protection while every test still passes.
 * Checking first turns that into a named failure at composition time.
 *
 * @param {CompactionDeps} [deps]
 * @returns {Promise<new (...args: any[]) => any>}
 */
export async function loadEvimedCompactionEngine(deps = {}) {
  const base = await loadCompactionBase()
  const issues = compactionProviderIssues(base)
  if (issues.length) throw new Error(`evimed: compaction provider seam broken: ${issues.join('; ')}`)
  return createEvimedCompactionEngine(base, deps)
}

/**
 * The seam probe. Reads what it expects out of `seam-manifest.json`, so the
 * manifest stays the one place the upstream shape is written down.
 * @param {any} BaseCompactionEngine
 * @returns {string[]} one line per broken expectation; empty means intact
 */
export function compactionProviderIssues(BaseCompactionEngine) {
  const spec = SEAMS.providers.compaction
  if (typeof BaseCompactionEngine !== 'function') {
    return [`${spec.package} no longer exports \`${spec.export}\` as a class`]
  }
  /** @type {string[]} */
  const issues = []
  /** @type {any} */
  const proto = BaseCompactionEngine.prototype
  const hook = proto?.[spec.hook]
  if (typeof hook !== 'function') {
    issues.push(`${spec.export}.prototype.${spec.hook} is gone; the sole customization hook was renamed or removed`)
  } else {
    if (!Object.prototype.hasOwnProperty.call(proto, spec.hook)) {
      issues.push(`${spec.export}.prototype.${spec.hook} is inherited rather than this class's own hook; overriding it may no longer be what the backend calls`)
    }
    if (hook.length !== spec.hookArity) {
      issues.push(`${spec.export}.prototype.${spec.hook} takes ${hook.length} arguments, not ${spec.hookArity}`)
    }
  }
  for (const method of spec.methods) {
    if (typeof proto?.[method] !== 'function') issues.push(`${spec.export}.prototype.${method} is gone`)
  }
  for (const name of spec.statics) {
    if (!(name in BaseCompactionEngine)) issues.push(`${spec.export}.${name} is gone; cordis will not mount the subclass the same way`)
  }
  return issues
}

/**
 * Run the seam probe against the installed backend.
 * @returns {Promise<{ checked: string, issues: string[] }>}
 */
export async function probeCompactionProvider() {
  const spec = SEAMS.providers.compaction
  return {
    checked: `${spec.package}#${spec.export}.${spec.hook}`,
    issues: compactionProviderIssues(await loadCompactionBase()),
  }
}

/** @returns {Promise<any>} */
async function loadCompactionBase() {
  const spec = SEAMS.providers.compaction
  const module = await loadHarnessModule(spec.package)
  return module?.[spec.export] ?? module?.default
}

/**
 * Append one user message. The packet and the directive ride a single message
 * so the augmented call stays a genuine prefix of the routed request plus one
 * novel trailing turn, which is the property the backend's cache reuse depends
 * on.
 * @param {{ system?: string, tools?: readonly any[], messages: readonly any[] }} input
 * @param {string} text
 * @returns {{ system?: string, tools?: readonly any[], messages: readonly any[] }}
 */
function appendUserText(input, text) {
  return {
    ...input,
    messages: [
      ...(Array.isArray(input?.messages) ? input.messages : []),
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: COMPACTION_PLUGIN },
      },
    ],
  }
}

/** @param {any} agent @returns {string} */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : ''
}
