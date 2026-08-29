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
 * @module @evimed/dsh-socket/plugins/review
 */

import { configSchema, defineTool, registerTool, startSubagent, toSubagentOutcome } from '@evimed/harness-port'

const Schema = await configSchema()

export const name = 'evimed-review'

export const inject = ['tools', 'subagents']

/**
 * @typedef {object} Config
 * @property {number} maxClaims
 */

export const Config = Schema.object({
  maxClaims: Schema.number().default(40)
    .description('Claims examined per review. A ceiling exists because review cost scales with the package and its value does not.'),
})

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
      '对本次运行的全部交付物做一次跨产物审查：同一实体的结论是否互相矛盾、抽样事实是否核得住。',
      '它给建议，不作裁定——收到的意见值得看，但不通过它也能交付。',
    ].join(' '),
    parameters: {
      focus: { type: 'string', description: '想重点审查的实体或问题；留空则全篇。' },
    },
    async execute(args, call) {
      // `call.agent ??` came first here and `ToolCall` has no `agent`, so the
      // lookup on the right was always the branch taken — a preference that
      // read as deliberate and could never apply.
      const parent = ctx.get('agents')?.get?.(call.agentId)
      if (!parent) return { ok: false, code: 'review_unavailable', issues: [{ code: 'review_unavailable', severity: 'advisory', message: '当前会话不可审查。' }] }
      const request = {
        capability: 'evimed-review',
        label: '跨交付物审查',
        prompt: reviewPrompt(args.focus ?? '', config.maxClaims),
        // Grounding tools the original reasoner did not use: a verifier that can
        // only re-read the same artifacts can only re-derive the same mistakes.
        tools: ['read', 'glob', 'grep', 'mcp__evimed__literature_search', 'mcp__evimed__open_access_full_text', 'mcp__evimed__official_page_fetch'],
        persona: '你是独立审查者。你没有看过产出这些结论的推理过程，也不要去猜它。你的任务是评价，不是续写。',
        outputSchema: REVIEW_VERDICT_SCHEMA,
        maxDepth: 1,
      }
      const run = await startSubagent(ctx, request, parent, call.signal)
      const outcome = toSubagentOutcome(run, await run.result)
      if (outcome.stopReason !== 'completed') {
        return { ok: false, code: 'review_unavailable', issues: [{ code: 'review_unavailable', severity: 'advisory', message: `审查未完成：${outcome.diagnostic || outcome.stopReason}` }] }
      }
      const verdicts = Array.isArray(outcome.structured?.verdicts) ? outcome.structured.verdicts : []
      const diagnostics = ctx.get('evimedDiagnostics')
      for (const verdict of verdicts) {
        if (verdict?.verdict === 'stands') continue
        diagnostics?.notice?.(`review ${verdict?.verdict}: ${verdict?.claimId} — ${verdict?.grounds}`)
      }
      // Advice, not a verdict: nothing here changes a deliverable's status.
      return { ok: true, data: { verdicts, blocking: false } }
    },
  })
  ctx.effect(() => registerTool(ctx, reviewTool))
}

/** @param {string} focus @param {number} maxClaims @returns {string} */
function reviewPrompt(focus, maxClaims) {
  return [
    '审查本次运行 `deliverables/` 下的全部产物。',
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
