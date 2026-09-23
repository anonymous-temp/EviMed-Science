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

/** How often a running review is asked after. */
export const REVIEW_POLL_MS = 3_000

/** How long a submission waits for its review before delivering the verdict without it. */
export const REVIEW_WAIT_MS = 16 * 60_000

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
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
 * @property {{ id: string, kind: string, label: string, severity: string, origin: string, location: string, evidence: string, fix: string, message: string, answerRequired: boolean }[]} findings
 * @property {{ present: number, absent: string[], unlocated: string[] }} checklist
 * @property {{ met: string[], unmet: string[], unlocated: string[] }} acceptance
 * @property {{ references: any, numeric: any, jobs: string[], previous: { open: string[], resolved: string[] } }} deterministic
 * @property {number} dropped
 */

/**
 * One review of one deliverable: started, then asked after until done.
 *
 * @param {any} ctx @param {{ revisionAuthorizeUrl?: string, tokenFile?: string }} config
 * @param {{ runId: string, sessionId: string, deliverableId: string, contractKind: string, capability: string, attempt: number,
 *   acceptance?: readonly string[], editor?: boolean, signal?: AbortSignal, pollMs?: number, waitMs?: number }} input
 * @returns {Promise<{ ok: true, review: ReviewResult } | { ok: true, skipped: string } | { ok: false, code: string, message: string }>}
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
    return { ok: false, code: 'review_unavailable', message: `审查在 ${Math.round(waitMs / 60_000)} 分钟内没有完成；本次提交不等它。` }
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
 * A review as the lines the run acts on: each finding with its id, where it
 * is, the words it rests on and the edit; answer-required ones say so.
 * @param {ReviewResult} review @returns {{ code: string, severity: string, message: string }[]}
 */
export function reviewIssues(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : []
  const listed = findings.slice(0, REVIEW_ISSUE_LIMIT).map((finding) => ({
    code: `review_${finding.kind}`,
    severity: finding.severity === 'required' ? 'required' : 'advisory',
    message: `[${finding.id}]${finding.answerRequired ? '（需回应）' : ''} ${finding.message}`,
  }))
  const rest = findings.length - listed.length
  if (rest > 0) listed.push({ code: 'review_more', severity: 'advisory', message: `另有 ${rest} 条审查发现没有列出；读回请调用 evimed_review_run。` })
  const absent = review?.checklist?.absent ?? []
  if (absent.length) listed.push({ code: 'review_missing_item', severity: 'advisory', message: `报告清单中这些条目没有找到：${absent.join('、')}。补上，或在报告里说明不适用。` })
  const unmet = review?.acceptance?.unmet ?? []
  if (unmet.length) listed.push({ code: 'review_missing_item', severity: 'advisory', message: `计划里的验收项没有满足：${unmet.join('、')}。` })
  return listed
}

/**
 * A review as the run's summary line in a submission's data.
 * @param {ReviewResult} review
 */
export function reviewSummary(review) {
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
    answerRequired: findings.filter((finding) => finding.answerRequired).map((finding) => finding.id),
    byKind,
    references: review.deterministic?.references ?? null,
    ...(review.deterministic?.numeric ? { numeric: review.deterministic.numeric } : {}),
    ...(review.deterministic?.previous?.resolved?.length ? { previousResolved: review.deterministic.previous.resolved } : {}),
    checklist: { present: review.checklist?.present ?? 0, absent: (review.checklist?.absent ?? []).length },
    ...(review.dropped ? { dropped: review.dropped } : {}),
    how: '对每条「需回应」的发现，改了就在下次提交时回 fixed，不改就回 declined 并写一句理由（responses 参数）。其余是建议。',
  }
}
