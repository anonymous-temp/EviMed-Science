/**
 * Cross-deliverable semantic review.
 *
 * Hidden knowledge: why this produces notices and never a verdict. On 29 real
 * deliveries the semantic judge produced 129 findings; code verification left
 * 114, and exactly 3 of those landed on a human annotation — roughly four
 * pieces of noise per real finding. Worse, five runs of the same input at
 * temperature 0 produced 6, 4, 4, 3 and 4 findings with different accusations
 * each time. Something that cannot reproduce itself cannot be a regression
 * signal, let alone a gate.
 *
 * So the reviewer is built the way Apodex builds a verifier — a fresh context,
 * no access to the reasoning it is checking, and grounding tools the original
 * reasoner did not use — and its output is advice.
 *
 * The review itself lives in `../src/review.mjs`, because `evimed_submit_deliverable`
 * runs it too (2026-09-20): a review the method text asked the model to
 * remember was a review that got skipped, and the package was frozen before
 * anybody had looked at it. This tool stays for a model that wants an opinion
 * mid-draft.
 *
 * @module @evimed/dsh-socket/plugins/review
 */

import { configSchema, defineTool, registerTool } from '@evimed/harness-port'
import { REVIEW_MAX_CLAIMS, REVIEW_VERDICT_SCHEMA, reviewNoticeText, runReview } from '../src/review.mjs'

const Schema = await configSchema()

export const name = 'evimed-review'

export const inject = ['tools', 'subagents']

/**
 * @typedef {object} Config
 * @property {number} maxClaims
 */

export const Config = Schema.object({
  maxClaims: Schema.number().default(REVIEW_MAX_CLAIMS)
    .description('Claims examined per review. A ceiling exists because review cost scales with the package and its value does not.'),
})

export { REVIEW_VERDICT_SCHEMA }

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  // Awaited before registering, not inside the effect: `defineTool` is async and
  // the harness's `tools.register()` reads `definition.output` synchronously, so
  // a Promise makes it throw `TypeError: tool "undefined" must declare output`
  // the moment a real kernel applies this plugin. The effect callback stays
  // synchronous because its return value is the disposer.
  const reviewTool = await defineTool({
    name: 'evimed_review_run',
    description: [
      '对本次运行的交付物做一次跨产物审查：同一实体的结论是否互相矛盾、抽样事实是否核得住。',
      '提交时会自动跑一次，裁定与审查意见一起返回；写作中途想先听一次意见，再调用它。',
      '它给建议，不替代确定性门禁。',
    ].join(' '),
    parameters: {
      focus: { type: 'string', description: '想重点审查的实体或问题；留空则全篇。' },
    },
    async execute(args, call) {
      // `call.agent ??` came first here and `ToolCall` has no `agent`, so the
      // lookup on the right was always the branch taken — a preference that
      // read as deliberate and could never apply.
      const parent = ctx.get('agents')?.get?.(call.agentId)
      // Which deliverables belong to this conversation. Published by the run
      // policy, because the plan is its state; absent (a native turn with no
      // plan) the reviewer reads the whole directory as it always did.
      const scope = ctx.get('evimedRun')?.reviewScope?.(call.sessionId) ?? null
      const result = await runReview(ctx, {
        parent,
        signal: call.signal,
        deliverableIds: scope?.deliverableIds ?? [],
        claimIds: scope?.claimIds ?? null,
        focus: args.focus ?? '',
        maxClaims: config.maxClaims,
      })
      if (!result.ok) {
        return { ok: false, code: result.code, issues: [{ code: result.code, severity: 'advisory', message: result.message }] }
      }
      const diagnostics = ctx.get('evimedDiagnostics')?.forSession?.(call.sessionId) ?? ctx.get('evimedDiagnostics')
      for (const verdict of result.verdicts) {
        if (verdict?.verdict === 'stands') continue
        diagnostics?.notice?.(reviewNoticeText(verdict))
      }
      // Advice, not a verdict: nothing here changes a deliverable's status.
      return { ok: true, data: { verdicts: result.verdicts, blocking: false, ...(result.outOfScope ? { outOfScope: result.outOfScope } : {}) } }
    },
  })
  ctx.effect(() => registerTool(ctx, reviewTool))
}
