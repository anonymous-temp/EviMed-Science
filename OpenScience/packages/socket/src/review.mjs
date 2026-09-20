/**
 * The independent reviewer, in one place.
 *
 * Hidden knowledge: who calls it and what its answer is worth. It used to be a
 * tool the method text asked the model to remember to call before its first
 * submission — 「先审查再提交」 written into a 1,839-line skill body — and on
 * the run that mattered the model skipped it and submitted, which froze the
 * package before anybody had looked at it. A step that must happen before
 * another step is a data dependency, not a sentence: `evimed_submit_deliverable`
 * runs it now, and the tool stays for a model that wants an opinion mid-draft.
 *
 * Its output is advice by construction (see the plugin's own note: 129 findings
 * over 29 deliveries, 3 of them real, and five runs at temperature 0 disagreed
 * with each other). `contradicted` comes back as something to fix while the
 * files are still editable; `weakened` comes back as advice. Neither withholds
 * a delivery — the 2026-09-17 ruling stands.
 *
 * @module @evimed/dsh-socket/src/review
 */

import { startSubagent, toSubagentOutcome } from '@evimed/harness-port'

/** Claims one review examines. The ceiling exists because review cost scales
 *  with the package and its value does not. */
export const REVIEW_MAX_CLAIMS = 40

/** The reviewer's fixed output shape: a verdict per claim, with its grounds. */
export const REVIEW_VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['claimId', 'verdict', 'grounds'],
        properties: {
          claimId: { type: 'string' },
          verdict: { type: 'string', enum: ['stands', 'weakened', 'contradicted'] },
          grounds: { type: 'string' },
          conflictsWith: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
})

/**
 * What the reviewer is asked to read.
 *
 * The directories are named. One project's workspace holds every conversation
 * that ran in it, and `deliverables/` was all this prompt said: a GEO run's
 * review came back carrying another conversation's aspirin claims, judged
 * against sources that run had never fetched.
 *
 * @param {{ deliverableIds?: readonly string[], focus?: string, maxClaims?: number }} input
 * @returns {string}
 */
export function reviewPrompt({ deliverableIds = [], focus = '', maxClaims = REVIEW_MAX_CLAIMS } = {}) {
  const scope = deliverableIds.length
    ? deliverableIds.map((id) => `\`deliverables/${id}/\``).join('、')
    : '`deliverables/` 下的全部产物'
  return [
    `审查${scope}。这几个目录之外的文件不属于本次对话，即使同一工作区里还有别的目录，也不要读、不要判、不要引用。`,
    '',
    '1. 读出每份产物里的结论（claim）与它引用的来源。',
    '2. 找出**同一实体上互相矛盾**的结论，逐对指出。',
    `3. 抽样核查最多 ${maxClaims} 条结论：用检索工具去核，只接受可解析的文献结果作为依据。`,
    '4. 对每条给出 stands / weakened / contradicted 与理由。',
    '',
    focus ? `重点：${focus}` : '',
    '',
    '你没有看过产出这些结论的推理过程。不要重建它，也不要替它辩护——按产物本身与你自己查到的证据判断。',
  ].filter(Boolean).join('\n')
}

/**
 * One review, run as a fresh-context subagent.
 *
 * Never throws for a review that did not finish: the caller is either a tool
 * answering the model or a submission that has a gate verdict to deliver, and
 * neither may fail because an advisory did.
 *
 * @param {any} ctx
 * @param {{ parent: any, signal: AbortSignal, deliverableIds?: readonly string[], focus?: string, maxClaims?: number, claimIds?: ReadonlySet<string> | null }} input
 * @returns {Promise<{ ok: true, verdicts: any[], outOfScope: number } | { ok: false, code: string, message: string }>}
 */
export async function runReview(ctx, { parent, signal, deliverableIds = [], focus = '', maxClaims = REVIEW_MAX_CLAIMS, claimIds = null }) {
  if (!parent) return { ok: false, code: 'review_unavailable', message: '当前会话不可审查。' }
  const request = {
    capability: 'evimed-review',
    label: '跨交付物审查',
    prompt: reviewPrompt({ deliverableIds, focus, maxClaims }),
    // Grounding tools the original reasoner did not use: a verifier that can
    // only re-read the same artifacts can only re-derive the same mistakes.
    tools: ['read', 'glob', 'grep', 'mcp__evimed__literature_search', 'mcp__evimed__open_access_full_text', 'mcp__evimed__web_read'],
    persona: '你是独立审查者。你没有看过产出这些结论的推理过程，也不要去猜它。你的任务是评价，不是续写。',
    outputSchema: REVIEW_VERDICT_SCHEMA,
    maxDepth: 1,
  }
  let outcome
  try {
    const run = await startSubagent(ctx, request, parent, signal)
    outcome = toSubagentOutcome(run, await run.result)
  } catch (error) {
    return { ok: false, code: 'review_unavailable', message: `审查没有完成：${error instanceof Error ? error.message : String(error)}` }
  }
  if (outcome.stopReason !== 'completed') {
    return { ok: false, code: 'review_unavailable', message: `审查没有完成：${outcome.diagnostic || outcome.stopReason}` }
  }
  /** @type {any[]} */
  const all = Array.isArray(outcome.structured?.verdicts) ? outcome.structured.verdicts : []
  // A verdict on a claim this run never wrote is a verdict on somebody else's
  // package. Counted rather than quietly dropped: an unreported filter is how a
  // review that read the wrong workspace goes on looking correct.
  if (!claimIds || !claimIds.size) return { ok: true, verdicts: all, outOfScope: 0 }
  const mine = all.filter((verdict) => claimIds.has(String(verdict?.claimId ?? '')))
  return { ok: true, verdicts: mine, outOfScope: all.length - mine.length }
}

/**
 * The reviewer's verdicts split the way a run must act on them: `contradicted`
 * is something to fix while the files are still editable, `weakened` is advice,
 * `stands` is nothing.
 * @param {readonly any[]} verdicts
 * @returns {{ mustFix: any[], advice: any[] }}
 */
export function reviewFindings(verdicts) {
  /** @type {any[]} */
  const list = Array.isArray(verdicts) ? verdicts : []
  return {
    mustFix: list.filter((verdict) => verdict?.verdict === 'contradicted'),
    advice: list.filter((verdict) => verdict?.verdict === 'weakened'),
  }
}

/**
 * One verdict as a sentence a researcher reads, with the claim it is about.
 * Written here rather than at the surface that displays it: the notice travels
 * through the run projection into the inbox, the IM card and the page, and the
 * English line those three used to show — `review weakened: CLM-012 — …` — was
 * produced once, right here.
 * @param {any} verdict @returns {string}
 */
export function reviewNoticeText(verdict) {
  const claimId = String(verdict?.claimId ?? '').trim() || '某条结论'
  const grounds = String(verdict?.grounds ?? '').trim()
  const word = verdict?.verdict === 'contradicted' ? '与独立审查者查到的证据相矛盾' : '证据强度弱于结论写法'
  return `结论 ${claimId} ${word}${grounds ? `：${grounds}` : '。'}`
}
