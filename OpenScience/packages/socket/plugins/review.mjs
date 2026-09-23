/**
 * The independent review, on request.
 *
 * Hidden knowledge: the review runs without being asked — every submission a
 * gate could read is reviewed, and the findings come back in the same answer
 * (`run-policy.mjs`). This tool is for a writer who wants the editor's
 * opinion before submitting: the same review, of one deliverable of this
 * conversation's plan, by the same control-plane reviewer (another model
 * family, every reference resolved, findings located or dropped).
 *
 * It used to start a subagent of this kernel on the writer's own model,
 * sampling forty claims; on 29 real deliveries that judge produced 129
 * findings, 3 of them real, and five reruns at temperature 0 disagreed with
 * each other (plan 2026-09-22 §1). The reviewer is not in the kernel any
 * more, so this plugin needs no subagents.
 *
 * Advice, never a verdict: nothing here changes a deliverable's status. An
 * editor pass counts against the deliverable's passes for the turn, so a
 * writer who asks mid-draft and then submits spends both.
 *
 * @module @evimed/dsh-socket/plugins/review
 */

import { configSchema, defineTool, registerTool } from '@evimed/harness-port'
import { reviewIssues, reviewSummary } from '../src/review.mjs'

const Schema = await configSchema()

export const name = 'evimed-review'

export const inject = ['tools']

/** @typedef {object} Config */

export const Config = Schema.object({})

/**
 * @param {any} ctx
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  // Awaited before registering, not inside the effect: `defineTool` is async and
  // the harness's `tools.register()` reads `definition.output` synchronously, so
  // a Promise makes it throw `TypeError: tool "undefined" must declare output`
  // the moment a real kernel applies this plugin. The effect callback stays
  // synchronous because its return value is the disposer.
  const reviewTool = await defineTool({
    name: 'evimed_review_run',
    description: [
      '请独立审查者（另一家族的模型）审一件本次计划里的交付物：逐条核对参考文献、结果数字与论断，发现带编号、所在位置、依据原文与改法。',
      '提交时会自动审一次，结果与门禁裁定一起返回；写作中途想先听一次意见，再调用它。它给建议，不替代确定性门禁。',
    ].join(' '),
    parameters: {
      deliverableId: { type: 'string', description: '计划中的交付物 id；计划里只有一件时可以不填。' },
    },
    async execute(args, call) {
      // Which deliverables belong to this conversation, and how to ask for a
      // review of one: published by the run policy, because the plan is its
      // state. Absent — a turn with no plan — there is nothing of this
      // conversation's to review.
      const scope = ctx.get('evimedRun')?.reviewScope?.(call.sessionId) ?? null
      const ids = Array.isArray(scope?.deliverableIds) ? scope.deliverableIds : []
      const deliverableId = String(args.deliverableId ?? (ids.length === 1 ? ids[0] : ''))
      if (!scope?.review || !ids.length) {
        return { ok: false, code: 'review_unavailable', issues: [{ code: 'review_unavailable', severity: 'advisory', message: '本次对话还没有计划中的交付物；先用 evimed_plan 写下计划。' }] }
      }
      if (!ids.includes(deliverableId)) {
        return { ok: false, code: 'deliverable_unknown', issues: [{ code: 'deliverable_unknown', severity: 'advisory', message: `请指定要审的交付物：${ids.join('、')}。` }] }
      }
      const result = await scope.review(deliverableId, call.signal)
      if (!result) {
        return { ok: false, code: 'review_unavailable', issues: [{ code: 'review_unavailable', severity: 'advisory', message: '本部署没有启用独立审查，或这件交付物不送审。' }] }
      }
      if (!result.ok) return { ok: false, code: result.code, issues: [{ code: result.code, severity: 'advisory', message: result.message }] }
      if ('skipped' in result) return { ok: true, data: { review: { status: 'skipped', reason: result.skipped } } }
      // Advice, not a verdict: nothing here changes a deliverable's status.
      return { ok: true, data: { review: reviewSummary(result.review), blocking: false }, issues: reviewIssues(result.review) }
    },
  })
  ctx.effect(() => registerTool(ctx, reviewTool))
}
