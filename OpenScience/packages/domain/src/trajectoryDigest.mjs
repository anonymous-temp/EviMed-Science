/**
 * What a run did, as the learning loop reads it: the person's own requests and interventions, the files it left, and the
 * order of the work's tools — never the tail of the platform's transcript.
 *
 * Hidden knowledge: the distillation was fed `slice(-limit)` of the stored transcript. The stored file is the root session's
 * lines followed by each child session's, so for a delegating run the last 40 to 80 lines are the last child's tail — submit,
 * repair, present, the closing summary — and for an undelegated one the root's: the opening request was cut off whenever the run
 * was longer than the window, and what remained was the platform's own choreography. Seventy methods learnt that way were all
 * about anchors, receipts and submission counts (audit 2026-10-23, break 1). The plan's own instruction (self-evolving agent
 * plan, 6.2) was the opposite: give the model the interval the trigger points at, a number of messages either side of a
 * correction, and what the task was.
 *
 * So the digest is built in code, from decidable parts:
 *
 *  - `requests` — the verbatim first user message of each of the run's own turns (`ownTurnStarts`), the part a tail window
 *    loses first. Platform envelopes (`<evimed-brief>` …) are stripped; what is left is what the person typed.
 *  - `interventions` — everything the person did to the run once it was going: a message typed into a running turn (found by
 *    structure, never by what it says), and the reactions the caller hands in (`options.reactions`: a follow-up judged next
 *    turn, a result corrected in the page), each with its sequence number where the transcript has one and its verbatim text.
 *  - `artifacts` — what the run left, with the format and, when the caller read one, the file's structural shape
 *    (`artifactShape.mjs`). A reader that is missing leaves path and format only.
 *  - `tools` — the order of the tools the work called, with the platform's choreography (`PLATFORM_CHOREOGRAPHY_TOOL_NAMES`,
 *    a closed list) removed and runs of the same tool folded into one entry. MCP tools are given by their base name.
 *  - `outcome` — `{ status, repaired }`.
 *
 * Pure: the transcript and the ledger's record of the run in, plain data out. A request or an intervention whose text carries a
 * credential or an identifier (`hasSensitiveText`, `identifierShapesIn`) is dropped, and `dropped.sensitive` counts it, because an input that silently
 * lost the decisive message produces a confident method about something that did not happen.
 *
 * Deletable when the kernel hands the learning loop a typed account of a turn's intent and corrections.
 *
 * @module trajectoryDigest
 */

import { cleanArtifactShapes } from './artifactShape.mjs'
import { fileFormatOf } from './fileDeliverable.mjs'
import { PLATFORM_CONTEXT_TAGS, carriesPlatformContext, identifierShapesIn, stripPlatformTags, unwrapUserWrappers } from './memoryVocabulary.mjs'
import { hasSensitiveText } from './sensitiveText.mjs'
import { isMcpToolName, isPlatformChoreographyTool, mcpToolBaseName } from './toolNames.mjs'

/** Bounds on what a digest holds: the size of a model's input, not a policy. */
export const TRAJECTORY_DIGEST_LIMITS = Object.freeze({
  requests: 8, requestChars: 4000, interventions: 12, interventionChars: 4000, artifacts: 12, tools: 80,
})

/** How many messages either side of an intervention an anchored excerpt reads. */
export const TRAJECTORY_ANCHOR_RADIUS = 12

/**
 * A whole block the platform injected into a message — the tag and what it holds — and not the tag alone: the content of an
 * `<evimed-brief>` is the platform's, and `stripPlatformTags` keeps content because it serves the display of a stored record.
 */
const INJECTED_BLOCK = new RegExp(`<(${PLATFORM_CONTEXT_TAGS.filter((entry) => entry.role === 'injected').map((entry) => entry.tag)
  .sort((left, right) => right.length - left.length).map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[\\s>/])[^>]*>[\\s\\S]*?</\\1>`, 'g')

/** What the person typed in a message: the platform's injected blocks and any stray tags removed. @param {unknown} text @returns {string} */
function typedText(text) {
  return stripPlatformTags(String(text ?? '').replace(INJECTED_BLOCK, ''))
}

/** @param {any} message @returns {string} the text parts of one transcript message, joined */
export function transcriptMessageText(message) {
  return (message?.parts ?? [])
    .filter((/** @type {any} */ part) => part?.type === 'text')
    .map((/** @type {any} */ part) => String(part.text ?? ''))
    .join('\n')
}

/**
 * The turns of the root session that belong to the run, by the rule the ledger assigns history with: a turn one of the run's
 * own request ids entered, or the native turn it was adopted from when it has no request ids. Null when the run names neither
 * (a record from before turn identity), and then every turn is read.
 * @param {readonly any[]} messages the run's own (root) session @param {any} run
 * @returns {Set<number> | null}
 */
export function ownTurnStarts(messages, run) {
  const requestIds = new Set(Array.isArray(run?.kernelRequestIds) ? run.kernelRequestIds : [])
  /** @type {Set<number>} */
  const turns = new Set()
  for (const message of messages) {
    if (message?.role === 'user' && message.source === 'user' && Number.isSafeInteger(message.turnStartSeq)
      && requestIds.has(message.sourceRequestId)) turns.add(message.turnStartSeq)
  }
  if (!requestIds.size && Number.isSafeInteger(run?.nativeTurn?.startSeq)) turns.add(run.nativeTurn.startSeq)
  return turns.size ? turns : null
}

/**
 * The run's root session and its messages. A stored transcript carries `sessionId` on every line; a live one does not, and
 * then every message is the root's.
 * @param {{ header?: any, messages?: readonly any[] } | null | undefined} transcript @param {any} run
 * @returns {{ sessionId: string | null, messages: any[] }}
 */
export function rootSessionOf(transcript, run) {
  const declared = typeof run?.sessionId === 'string' && run.sessionId ? run.sessionId : null
  const fromHeader = (transcript?.header?.sessions ?? []).find((/** @type {any} */ session) => session?.parentSessionId == null)?.sessionId
  const sessionId = declared ?? (typeof fromHeader === 'string' && fromHeader ? fromHeader : null)
  const messages = (transcript?.messages ?? []).filter((/** @type {any} */ message) => !sessionId || message?.sessionId === undefined || message.sessionId === sessionId)
  return { sessionId, messages }
}

/**
 * The messages the researcher typed into the run once it was going, in order. Two structural marks, never the words:
 *
 *  - `<evimed-correction>` — a message sent through the steer route is wrapped so a compaction keeps it; what is inside is theirs.
 *  - a message the researcher typed that is not the first of its turn. A turn opens with one ordinary message (the kernel makes a
 *    queued follow-up "the sole ordinary message of its own turn"), so another typed inside it arrived while the turn was
 *    running: a steer from the kernel's own window, which carries no wrapper. Nothing the platform wrote qualifies.
 * @param {readonly any[]} messages the run's own session @param {any} run
 * @returns {any[]}
 */
export function steeredMessages(messages, run) {
  const turns = ownTurnStarts(messages, run)
  /** @type {Map<number, number>} where each turn's first typed message is */
  const opening = new Map()
  for (const message of messages) {
    if (message?.role !== 'user' || message.source !== 'user' || !Number.isSafeInteger(message.turnStartSeq)) continue
    const first = opening.get(message.turnStartSeq)
    if (first === undefined || Number(message.seq) < first) opening.set(message.turnStartSeq, Number(message.seq))
  }
  return messages.filter((message) => {
    if (message?.role !== 'user' || (turns && !turns.has(message.turnStartSeq))) return false
    const text = transcriptMessageText(message)
    if (text.includes('<evimed-correction')) return true
    return message.source === 'user' && Number.isSafeInteger(message.turnStartSeq)
      && Number(message.seq) > (opening.get(message.turnStartSeq) ?? Number.POSITIVE_INFINITY)
      && !carriesPlatformContext(text)
  })
}

/** @param {unknown} text @param {number} max */
const bounded = (text, max) => String(text ?? '').trim().slice(0, max)

/**
 * @typedef {object} TrajectoryReaction
 * @property {'follow-up' | 'result-corrected' | 'steer'} kind
 * @property {number | null} [seq]
 * @property {string} text   the person's own words
 * @property {string | null} [rule]  the one-sentence rule a judge drew from them, when one did
 * @property {string | null} [verdict]
 */

/**
 * @typedef {object} TrajectoryDigest
 * @property {{ sessionId: string | null, seq: number | null, text: string }[]} requests
 * @property {{ kind: string, sessionId: string | null, seq: number | null, text: string, rule?: string, verdict?: string }[]} interventions
 * @property {{ path: string, format: string, shape?: import('./artifactShape.mjs').ArtifactShape }[]} artifacts
 * @property {string[]} tools
 * @property {{ status: string, repaired: boolean }} outcome
 * @property {{ sensitive: number }} dropped
 */

/**
 * @param {{ header?: any, messages?: readonly any[] } | null | undefined} transcript the stored transcript (root session lines, then children's)
 * @param {any} run the ledger's record of the run: `sessionId`, `kernelRequestIds`, `nativeTurn`, `status`, `repairRounds`, `artifacts`,
 *   `unverifiedArtifacts`, `outputFiles`
 * @param {{ shapes?: Readonly<Record<string, unknown>> | null, reactions?: readonly TrajectoryReaction[], attempts?: number }} [options]
 *   `shapes`: file path to the shape read from it (`apps/server/src/artifactShapes.mjs`). `reactions`: what the person did after
 *   the run was going that the transcript does not hold. `attempts`: the largest number of submissions any deliverable took.
 * @returns {TrajectoryDigest}
 */
export function trajectoryDigest(transcript, run, options = {}) {
  const limits = TRAJECTORY_DIGEST_LIMITS
  const { messages: root } = rootSessionOf(transcript, run)
  const turns = ownTurnStarts(root, run)
  let sensitive = 0
  /** @param {string} text */
  const unsafe = (text) => { if (hasSensitiveText(text) || identifierShapesIn(text).length) { sensitive += 1; return true } return false }

  // The first typed message of each own turn.
  /** @type {Map<number, any>} */
  const firstOf = new Map()
  for (const message of root) {
    if (message?.role !== 'user' || message.source !== 'user') continue
    const turn = Number.isSafeInteger(message.turnStartSeq) ? message.turnStartSeq : -1
    if (turns && !turns.has(turn)) continue
    const held = firstOf.get(turn)
    if (!held || Number(message.seq) < Number(held.seq)) firstOf.set(turn, message)
  }
  const requests = [...firstOf.values()]
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((message) => ({
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
      seq: Number.isSafeInteger(message.seq) ? Number(message.seq) : null,
      text: bounded(typedText(transcriptMessageText(message)), limits.requestChars),
    }))
    .filter((entry) => entry.text && !unsafe(entry.text))
    .slice(0, limits.requests)

  /** @type {TrajectoryDigest['interventions']} */
  const interventions = []
  for (const message of steeredMessages(root, run)) {
    const text = bounded(unwrapUserWrappers(transcriptMessageText(message)), limits.interventionChars)
    if (!text || unsafe(text)) continue
    interventions.push({
      kind: 'steer',
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
      seq: Number.isSafeInteger(message.seq) ? Number(message.seq) : null,
      text,
    })
  }
  for (const reaction of options.reactions ?? []) {
    const text = bounded(reaction?.text, limits.interventionChars)
    if (!text || unsafe(text)) continue
    // A steer the ledger recorded is the transcript's too: the transcript's copy has the sequence number.
    if (reaction.kind === 'steer' && interventions.some((entry) => entry.kind === 'steer' && entry.text === text)) continue
    const rule = bounded(reaction.rule, 300)
    interventions.push({
      kind: reaction.kind,
      sessionId: null,
      seq: Number.isSafeInteger(reaction.seq) ? Number(reaction.seq) : null,
      text,
      ...(rule && !unsafe(rule) ? { rule } : {}),
      ...(typeof reaction.verdict === 'string' && reaction.verdict ? { verdict: reaction.verdict } : {}),
    })
  }
  interventions.sort((left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER))

  /** @type {TrajectoryDigest['artifacts']} */
  const artifacts = []
  const seen = new Set()
  for (const field of ['artifacts', 'unverifiedArtifacts', 'outputFiles']) {
    for (const entry of Array.isArray(run?.[field]) ? run[field] : []) {
      const path = String(typeof entry === 'string' ? entry : entry?.path ?? '')
      if (!path || seen.has(path)) continue
      seen.add(path)
      const format = fileFormatOf(path).extension || 'other'
      const [shape] = cleanArtifactShapes(options.shapes?.[path] ? [options.shapes[path]] : [])
      artifacts.push({ path, format, ...(shape && shape.format === format ? { shape } : {}) })
      if (artifacts.length >= limits.artifacts) break
    }
    if (artifacts.length >= limits.artifacts) break
  }

  /** @type {string[]} */
  const tools = []
  scan: for (const message of transcript?.messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== 'tool') continue
      const raw = String(part.tool ?? '')
      if (!raw || isPlatformChoreographyTool(raw)) continue
      const name = isMcpToolName(raw) ? (mcpToolBaseName(raw) ?? raw) : raw
      if (isPlatformChoreographyTool(name)) continue
      if (tools[tools.length - 1] !== name) tools.push(name)
      if (tools.length >= limits.tools) break scan
    }
  }

  const rounds = (Number(run?.repairRounds?.content) || 0) + (Number(run?.repairRounds?.structural) || 0)
  return {
    requests,
    interventions,
    artifacts,
    tools,
    outcome: { status: String(run?.status ?? 'unknown'), repaired: rounds > 0 || (Number(options.attempts) || 0) > 1 || (Number(run?.attempts) || 0) > 1 },
    dropped: { sensitive },
  }
}
