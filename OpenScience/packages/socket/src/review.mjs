/**
 * The independent reviewer, as the run sees it: a gateway on the control plane.
 *
 * Hidden knowledge: who reviews, and why not from in here. The reviewer used
 * to be a subagent of this kernel — a fresh context, but the writer's own
 * model, sampling forty claims with search tools, answering with advice
 * nobody could act on after the freeze. A reviewer of the writer's own family
 * false-rejects its correct answers and adds nothing; one of another family,
 * not weaker, adds about twelve points (plan 2026-09-22 §1). The kernel can
 * only run its own model, so the review moved to the control plane
 * (`apps/server/src/reviewService.mjs`, Qwen3.8-Max): it resolves every
 * reference, traces an engine report's numbers to the engine's output, and
 * has the editor read the package as an outside submission. The run sends a
 * deliverable id and gets located findings back — never the prompt, the
 * checklists or the model, which it cannot read (runtime-can-read-the-gate).
 *
 * The control plane is reached at a sibling of the revision gateway's address,
 * which the runtime is already given: no new variable in the container, and no
 * new protocol version for the privileged controller that builds its
 * environment. The workload token is read afresh for every request — it
 * rotates every five minutes, and a review can outlast it.
 *
 * Asynchronous by construction: a review is started (202, an id) and asked
 * after. An editor pass thinks for minutes, and `fetch` abandons a response
 * whose headers have not arrived in 300 s.
 *
 * Never throws for a review that did not finish: the caller is a submission
 * that has a gate verdict to deliver, and it must not fail because an
 * advisory did.
 *
 * @module @evimed/dsh-socket/src/review
 */

import { REVIEW_FINDING_KIND_LABELS_ZH } from '@evimed/domain'
import { readFileAt } from '@evimed/harness-port'
import { sendWithFreshWorkloadToken } from './workloadRequest.mjs'

/** How often a running review is asked after. */
export const REVIEW_POLL_MS = 3_000

/**
 * How long a submission waits for the editor to read a package before it
 * answers with the gate's verdict alone. The review goes on and is recorded
 * either way; the wait decides only whether this answer carries it.
 *
 * The bound is above what was measured and below what a stuck editor can hold:
 * across twelve BixBench capsules (2026-10-28) the editor's reads took 1.9 to
 * 5.2 minutes (median 3.7) and two of the nine first reads found a defect the
 * writer then fixed (a contradicted sentence; a check that was itself wrong),
 * so a bound under three minutes would have kept them out of the run. The
 * control plane's own editor timeout is fifteen.
 */
export const REVIEW_WAIT_MS = 6 * 60_000

/**
 * The wait for a repeat review, which asks the code's checks alone (references,
 * traced numbers, statistics): seconds of work, bounded for the queue in front of it.
 */
export const REVIEW_REPEAT_WAIT_MS = 30_000

/** The wait when the writer asked for the review itself (`evimed_review_run`): it chose to listen, so it listens as long as the editor may think. */
export const REVIEW_EXPLICIT_WAIT_MS = 16 * 60_000

/** Findings listed one by one in a submission's answer; the rest are counted. */
export const REVIEW_ISSUE_LIMIT = 20

/** One request's own bound. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * The review gateway's base URL, from the revision gateway's.
 * @param {string} revisionAuthorizeUrl @returns {string}
 */
export function reviewGatewayUrl(revisionAuthorizeUrl) {
  const value = String(revisionAuthorizeUrl ?? '')
  for (const [suffix, replacement] of [
    ['/internal/revisions/v1/authorize', '/internal/review/v1'],
    ['/runtime-gateway/revisions/v1/authorize', '/runtime-gateway/review/v1'],
  ]) {
    if (value.endsWith(suffix)) return `${value.slice(0, -suffix.length)}${replacement}`
  }
  return ''
}

/**
 * @param {any} ctx @param {{ tokenFile?: string }} config
 * @returns {Promise<string>}
 */
async function workloadToken(ctx, config) {
  if (!config.tokenFile) return ''
  const token = await readFileAt(ctx, '/', config.tokenFile.replace(/^\/+/, ''))
  return String(token ?? '').trim()
}

/**
 * One request to the gateway.
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config
 * @param {'GET'|'POST'} method @param {string} path @param {unknown} body @param {AbortSignal | undefined} signal
 * @returns {Promise<{ status: number, value: any }>}
 */
async function gateway(ctx, config, method, path, body, signal) {
  const base = reviewGatewayUrl(config.revisionAuthorizeUrl ?? '')
  if (!base) return { status: 0, value: { error: { code: 'review_unconfigured' } } }
  const token = await workloadToken(ctx, config)
  if (!token) return { status: 0, value: { error: { code: 'review_unconfigured' } } }
  // The poll asks every few seconds for minutes, each time with the token as
  // the file holds it, and one that straddles a rewrite is refused as invalid
  // though it was good when it left: asked once more with what the file holds
  // now (`workloadRequest.mjs`) instead of ending the whole review on it.
  const response = await sendWithFreshWorkloadToken({
    token,
    readToken: () => workloadToken(ctx, config),
    send: (current) => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      return fetch(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${current}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    },
  })
  let value = null
  try { value = await response.json() } catch { value = null }
  return { status: response.status, value }
}

/** @param {number} ms @param {AbortSignal | undefined} signal */
function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
  })
}

/**
 * @typedef {object} ReviewResult
 * @property {string} reviewId
 * @property {'done'} status
 * @property {string} tier
 * @property {string} model
 * @property {string} editor
 * @property {string | null} editorError
 * @property {{ id: string, kind: string, label: string, severity: string, origin: string, location: string, evidence: string, fix: string, message: string, answerRequired: boolean, response?: string }[]} findings
 * @property {{ present: number, absent: string[], unlocated: string[] }} checklist
 * @property {{ met: string[], unmet: string[], unlocated: string[] }} acceptance
 * @property {{ references: any, numeric: any, jobs: string[], previous: { open: string[], resolved: string[] } }} deterministic
 * @property {number} dropped
 */

/**
 * What asking for a review comes to. `pending` is a review that is still
 * running when the wait ends: it carries its id so the next submission can look
 * at it instead of starting another. `reused` is the finished review of the
 * very bytes being submitted again.
 * @typedef {{ ok: true, review: ReviewResult, reused?: boolean } | { ok: true, skipped: string } | { ok: false, code: string, message: string, pending?: boolean, reviewId?: string }} ReviewOutcome
 */

/**
 * One review of one deliverable: started, then asked after until done.
 *
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config
 * @param {{ runId: string, sessionId: string, deliverableId: string, contractKind: string, capability: string, attempt: number,
 *   acceptance?: readonly string[], studyType?: string, editor?: boolean, signal?: AbortSignal, pollMs?: number, waitMs?: number }} input
 *   `studyType` is what the plan declared the deliverable to report or design;
 *   the control plane attaches that design's reporting checklist. Sent only
 *   when declared, so a request without one is the request it always was.
 * @returns {Promise<ReviewOutcome>}
 */
export async function runReview(ctx, config, input) {
  const pollMs = Math.max(10, Number(input.pollMs ?? REVIEW_POLL_MS))
  const waitMs = Math.max(pollMs, Number(input.waitMs ?? REVIEW_WAIT_MS))
  try {
    const started = await gateway(ctx, config, 'POST', '/deliverables', {
      deliverableId: input.deliverableId,
      contractKind: input.contractKind,
      ...(input.capability ? { capability: input.capability } : {}),
      runId: input.runId,
      sessionId: input.sessionId,
      attempt: Math.max(1, Math.floor(Number(input.attempt) || 1)),
      acceptance: [...(input.acceptance ?? [])].slice(0, 10),
      ...(input.studyType ? { studyType: input.studyType } : {}),
      ...(input.editor === false ? { editor: false } : {}),
    }, input.signal)
    if (started.status === 200 && started.value?.status === 'skipped') return { ok: true, skipped: String(started.value.reason ?? 'skipped') }
    if (started.status !== 202 || !started.value?.reviewId) return unavailable(started)
    const reviewId = String(started.value.reviewId)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (input.signal?.aborted) return { ok: false, code: 'review_unavailable', message: '审查被取消。' }
      await pause(pollMs, input.signal)
      let state
      try {
        state = await gateway(ctx, config, 'GET', `/deliverables/${reviewId}`, undefined, input.signal)
      } catch {
        continue
      }
      if (state.status === 200 && state.value?.status === 'running') continue
      if (state.status === 200 && state.value?.status === 'done') return { ok: true, review: state.value }
      return unavailable(state)
    }
    return { ok: false, code: 'review_unavailable', pending: true, reviewId, message: `审查还在进行（已等 ${waitMs >= 120_000 ? `${Math.round(waitMs / 60_000)} 分钟` : `${Math.round(waitMs / 1000)} 秒`}）：它会继续，发现会记入交付记录；不拦交付，也不需要为它等或再提交。` }
  } catch (error) {
    return { ok: false, code: 'review_unavailable', message: `审查没有完成：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** @param {{ status: number, value: any }} answer @returns {{ ok: false, code: string, message: string }} */
function unavailable(answer) {
  const code = String(answer.value?.error?.code ?? answer.value?.code ?? 'review_unavailable')
  if (code === 'review_disabled' || code === 'review_unconfigured') return { ok: false, code, message: '本部署没有启用独立审查。' }
  return { ok: false, code: 'review_unavailable', message: `审查没有完成（${code}）。` }
}

/**
 * A writer's answers to a review's findings.
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config
 * @param {{ reviewId: string, answers: readonly { id: string, response: string, reason?: string }[], signal?: AbortSignal }} input
 * @returns {Promise<{ ok: true, recorded: number, refused: { id: string, reason: string }[] } | { ok: false, code: string }>}
 */
export async function answerReview(ctx, config, { reviewId, answers, signal }) {
  try {
    const answer = await gateway(ctx, config, 'POST', '/responses', {
      reviewId,
      answers: answers.slice(0, 60).map((entry) => ({ id: String(entry?.id ?? ''), response: String(entry?.response ?? ''), reason: String(entry?.reason ?? '') })),
    }, signal)
    if (answer.status !== 200) return { ok: false, code: String(answer.value?.error?.code ?? 'review_unavailable') }
    return { ok: true, recorded: Number(answer.value?.recorded) || 0, refused: Array.isArray(answer.value?.refused) ? answer.value.refused : [] }
  } catch {
    return { ok: false, code: 'review_unavailable' }
  }
}

/**
 * The findings a writer still owes an answer to: a kind that asks for one, and
 * none given. An answered finding carried into a later pass is not owed again.
 * @param {{ findings?: readonly { id: string, answerRequired?: boolean, response?: string }[] } | null | undefined} review
 */
export function owedFindings(review) {
  return (Array.isArray(review?.findings) ? review.findings : []).filter((finding) => finding.answerRequired && !finding.response)
}

/** @param {{ answerRequired?: boolean, response?: string }} finding */
function findingStanding(finding) {
  if (finding.response) return `（已回应：${finding.response === 'fixed' ? '已改' : '不改'}）`
  return finding.answerRequired ? '（需回应）' : ''
}

/**
 * What a deliverable's last review comes to, kept on its plan item: enough to
 * decide whether the next submission needs another read, and to remind the run
 * of what it still owes.
 *
 * `required` counts every finding whose kind asks for an answer, answered or
 * not: a package whose last read raised one is read once more after the
 * writer's repair, and one whose last read raised none is not.
 * @typedef {{ reviewId: string, digest: string, status: 'done' | 'pending', required: number, findings: { id: string, kind: string, answerRequired: boolean, answered: boolean }[] }} ReviewStanding
 */

/**
 * @param {ReviewResult} review @param {string} digest the submitted bytes it read
 * @returns {ReviewStanding}
 */
export function reviewStanding(review, digest) {
  const findings = Array.isArray(review?.findings) ? review.findings : []
  return {
    reviewId: review.reviewId,
    digest,
    status: 'done',
    required: findings.filter((finding) => finding.answerRequired).length,
    findings: findings.map((finding) => ({ id: finding.id, kind: finding.kind, answerRequired: Boolean(finding.answerRequired), answered: Boolean(finding.response) })),
  }
}

/**
 * What the plan item keeps after a submission asked for a review.
 * @param {ReviewStanding | undefined} previous @param {ReviewOutcome} outcome @param {string} digest
 * @returns {ReviewStanding | undefined}
 */
export function nextStanding(previous, outcome, digest) {
  if (outcome.ok && 'review' in outcome) return reviewStanding(outcome.review, digest)
  // Still out: it read the bytes it was started on, which are not these when it is the earlier one still running.
  if (!outcome.ok && outcome.pending && outcome.reviewId) {
    return outcome.reviewId === previous?.reviewId ? previous : { reviewId: outcome.reviewId, digest, status: 'pending', required: 0, findings: [] }
  }
  // Skipped, unavailable, refused: whatever was known stays known.
  return previous
}

/**
 * One look at a review that was started earlier: running, done (with its
 * findings) or gone (failed, unknown, unreachable). Never waits.
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config @param {string} reviewId @param {AbortSignal | undefined} signal
 * @returns {Promise<{ state: 'running' } | { state: 'done', review: ReviewResult } | { state: 'gone' }>}
 */
async function peekReview(ctx, config, reviewId, signal) {
  try {
    const answer = await gateway(ctx, config, 'GET', `/deliverables/${reviewId}`, undefined, signal)
    if (answer.status === 200 && answer.value?.status === 'running') return { state: 'running' }
    if (answer.status === 200 && answer.value?.status === 'done') return { state: 'done', review: answer.value }
  } catch { /* unreachable reads as gone: the caller asks afresh or goes without */ }
  return { state: 'gone' }
}

/**
 * The review a submission asks for, given what the deliverable's last review
 * came to. The editor reads a package once; a submission after that gets less:
 *
 * - the very bytes already read: the finished review is handed back, nothing is
 *   started;
 * - changed bytes, and the last read raised nothing the writer owed an answer
 *   to: the code's checks alone (`editor: false`) — a resubmission that chases
 *   advisories is not read again for them;
 * - changed bytes after a read that owed findings: the editor reads once more,
 *   which is the repair loop the review exists for;
 * - a read still out from an earlier submission is looked at first, and no
 *   second one is stacked behind it.
 *
 * Measured on twelve BixBench capsules (2026-10-28): 18 submissions, 61.6
 * minutes blocked, 31.0 of them in 9 resubmissions, and in none did the
 * repeated read find a finding the writer owed. A read the writer asked for
 * (`explicit`) is always the full one.
 *
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config
 * @param {Parameters<typeof runReview>[2] & { digest?: string, explicit?: boolean }} input
 * @param {ReviewStanding | undefined} previous
 * @returns {Promise<ReviewOutcome>}
 */
export async function reviewForSubmission(ctx, config, input, previous) {
  const { digest = '', explicit = false, ...request } = input
  if (explicit) return runReview(ctx, config, { ...request, waitMs: request.waitMs ?? REVIEW_EXPLICIT_WAIT_MS })
  let standing = previous
  if (standing?.status === 'pending') {
    const looked = await peekReview(ctx, config, standing.reviewId, request.signal)
    if (looked.state === 'running') return pendingOutcome(standing.reviewId, '审查还在进行：它会继续，发现会记入交付记录；不拦交付，也不需要为它等或再提交。')
    standing = looked.state === 'done' ? reviewStanding(looked.review, standing.digest) : undefined
    // A read that finished between submissions is the previous read from here on.
    if (looked.state === 'done' && digest && standing?.digest === digest) return { ok: true, review: looked.review, reused: true }
  } else if (standing?.status === 'done' && digest && standing.digest === digest) {
    const looked = await peekReview(ctx, config, standing.reviewId, request.signal)
    return looked.state === 'done' ? { ok: true, review: looked.review, reused: true } : { ok: true, skipped: 'review_unchanged' }
  }
  const codeOnly = standing?.status === 'done' && standing.required === 0
  return runReview(ctx, config, {
    ...request,
    ...(codeOnly ? { editor: false } : {}),
    waitMs: request.waitMs ?? (codeOnly ? REVIEW_REPEAT_WAIT_MS : REVIEW_WAIT_MS),
  })
}

/** @param {string} reviewId @param {string} message @returns {ReviewOutcome} */
function pendingOutcome(reviewId, message) {
  return { ok: false, code: 'review_unavailable', pending: true, reviewId, message }
}

/**
 * The plain sentence a passed submission ends on: whether anything is still
 * required, and that nothing else is a reason to submit again. The tool's
 * description says the same before the call; this is the line at the point of
 * use, where a run weighing a typo or an advisory note decides whether to
 * submit once more (2026-10-28: a run fixed a typo after an accepted, clean
 * submission and resubmitted "to keep the receipt consistent", four minutes).
 * @param {ReviewOutcome | null} outcome the review this submission got, null when none was asked for
 * @returns {string}
 */
export function settledNote(outcome) {
  const owed = outcome && outcome.ok && 'review' in outcome ? owedFindings(outcome.review) : []
  if (owed.length) {
    return `已通过。审查有 ${owed.length} 条需回应的发现（${owed.map((finding) => finding.id).join('、')}）：改了的在下次提交的 responses 里回 fixed，不改的回 declined 并写一句理由，然后再提交一次。除此之外，没有必须再提交的理由。`
  }
  return '已通过：没有必须修的问题，交付物成立。其余只是建议，改不改由你判断，不需要为它们重新提交；本轮结束前文件还能改，回执会按最终文件生成。'
}

/**
 * A review as the lines the run acts on: each finding with its id, where it
 * is, the words it rests on and the edit; answer-required ones say so.
 * @param {ReviewResult} review @returns {{ code: string, severity: string, message: string }[]}
 */
export function reviewIssues(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : []
  const listed = findings.slice(0, REVIEW_ISSUE_LIMIT).map((finding) => ({
    code: `review_${finding.kind}`,
    severity: finding.severity === 'required' ? 'required' : 'advisory',
    message: `[${finding.id}]${findingStanding(finding)} ${finding.message}`,
  }))
  const rest = findings.length - listed.length
  if (rest > 0) listed.push({ code: 'review_more', severity: 'advisory', message: `另有 ${rest} 条审查发现没有列出；读回请调用 evimed_review_run。` })
  // Where an unmet item is answered is part of the message. 「补上，或在报告里
  // 说明不适用」 and a bare 「没有满足」 sent every run's answer into the report:
  // 验收项对照 sections, number-provenance tables, 「报告规范的适用性」 and
  // conflict-of-interest statements nobody made, in eight of nineteen accepted
  // capabilities (quality classes 2026-09-29, C1). The report is the reader's;
  // an item about the package itself is answered where the package's own
  // record is kept.
  const absent = review?.checklist?.absent ?? []
  if (absent.length) listed.push({ code: 'review_missing_item', severity: 'advisory', message: `报告清单中这些条目没有找到：${absent.join('、')}。读者需要、你又有依据写的内容，补进报告；不适用的条目，以及利益冲突、资助这类没人告诉过你的事实，不写进报告、不代人声明，在 revision-notes.md 里说明。` })
  const unmet = review?.acceptance?.unmet ?? []
  if (unmet.length) listed.push({ code: 'review_missing_item', severity: 'advisory', message: `计划里的验收项没有满足：${unmet.join('、')}。读者需要的内容补进报告；关于文件、字段、数字与产物是否一致或检查过程的验收项，在 revision-notes.md 回应，不在报告里另立小节。` })
  return listed
}

/**
 * A review as the run's summary line in a submission's data.
 * @param {ReviewResult} review @param {boolean} [reused] the finished review of the very bytes being submitted again
 */
export function reviewSummary(review, reused = false) {
  const findings = Array.isArray(review?.findings) ? review.findings : []
  /** @type {Record<string, number>} */
  const byKind = {}
  for (const finding of findings) {
    const label = REVIEW_FINDING_KIND_LABELS_ZH[/** @type {keyof typeof REVIEW_FINDING_KIND_LABELS_ZH} */ (finding.kind)] ?? finding.kind
    byKind[label] = (byKind[label] ?? 0) + 1
  }
  return {
    status: 'done',
    reviewId: review.reviewId,
    tier: review.tier,
    model: review.model,
    editor: review.editor,
    ...(review.editorError ? { editorError: review.editorError } : {}),
    findings: findings.length,
    answerRequired: owedFindings(review).map((finding) => finding.id),
    byKind,
    references: review.deterministic?.references ?? null,
    ...(review.deterministic?.numeric ? { numeric: review.deterministic.numeric } : {}),
    ...(review.deterministic?.previous?.resolved?.length ? { previousResolved: review.deterministic.previous.resolved } : {}),
    checklist: { present: review.checklist?.present ?? 0, absent: (review.checklist?.absent ?? []).length },
    ...(review.dropped ? { dropped: review.dropped } : {}),
    ...(reused ? { unchanged: '文件自上次审查后没有改动，这是上次的结果。' } : {}),
    how: '对每条「需回应」的发现，改了就在下次提交时回 fixed，不改就回 declined 并写一句理由（responses 参数）。其余是建议。',
  }
}
