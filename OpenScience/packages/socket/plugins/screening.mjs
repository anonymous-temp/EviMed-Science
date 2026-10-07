/**
 * Batch screening as a compound tool.
 *
 * Hidden knowledge: how fifty parallel children get organized, and why the
 * model does not do it. "Screen five thousand papers with fifty agents" is not
 * a plan the orchestrator should improvise — the batch size, the concurrency
 * ceiling, the tool restriction, the output schema and the ledger format are
 * all decisions with one right answer, and asking a model to rediscover them
 * per run is how a run ends up with three hundred children and no ledger.
 *
 * So this is one tool call. The model asks for a screening; the code decides
 * how it is carried out. That is the same division the delegation tool makes,
 * and for the same reason (§14 rule 13).
 *
 * @module @evimed/dsh-socket/plugins/screening
 */

import { configSchema, defineTool, registerTool, startSubagent, toSubagentOutcome, writeFileAt } from '@evimed/harness-port'
import { isProtectedWritePath, normalizeWorkspacePath } from '@evimed/domain'
import { chunk, renderScreeningLedger, screeningPrompt, SCREEN_VERDICT_SCHEMA } from '../src/screening.mjs'
import { collectSubagentRun } from '../src/subagentRun.mjs'
import { errorMessage } from '../src/runPolicy.mjs'

const Schema = await configSchema()

export const name = 'evimed-screening'

export const inject = ['tools', 'subagents']

/**
 * @typedef {object} Config
 * @property {boolean} [enabled]
 * @property {number} batchSize
 * @property {number} maxConcurrentChildren
 */

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Off registers nothing: no screening tool (EVIMED_SCREENING_ENABLED=0).'),
  batchSize: Schema.number().default(50)
    .description('Records per screening child. A deployment whose records are longer lowers it.'),
  // The same number that bounds a run's concurrent delegations. It is a wave
  // size here and was always one, which is the meaning the old shared name
  // (`maxParallelChildren`) promised and delegation did not keep.
  maxConcurrentChildren: Schema.number().default(30)
    .description('Concurrent screening children. Owned by the control plane, same ceiling as concurrent delegations.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  if (config.enabled === false) return
  // Awaited before registering, not inside the effect: `defineTool` is async and
  // the harness's `tools.register()` reads `definition.output` synchronously, so
  // a Promise makes it throw `TypeError: tool "undefined" must declare output`
  // the moment a real kernel applies this plugin. The effect callback stays
  // synchronous because its return value is the disposer.
  const screenTool = await defineTool({
    name: 'evimed_screen_batch',
    description: [
      '按纳入/排除标准批量筛选检索结果。你给标准与记录，工具负责分批、并行、汇总，并写出 screening-ledger.csv。',
      '不要自己起一堆子代理来筛——批量筛选的批次大小、并发上限、工具限制与台账格式都由这个工具决定。',
    ].join(' '),
    parameters: {
      criteria: { type: 'string', required: true, description: '纳入与排除标准，写清楚到一个人读了就能判断。' },
      records: {
        type: 'array',
        required: true,
        description: '待筛记录，每条含 id 与足以判断的题录信息。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            abstract: { type: 'string' },
            year: { type: 'integer' },
            source: { type: 'string' },
          },
        },
      },
      ledgerPath: { type: 'string', description: '台账写到哪；默认 screening-ledger.csv。' },
    },
    async execute(args, call) {
      const records = Array.isArray(args.records) ? args.records : []
      if (!records.length) {
        return { ok: false, code: 'invalid_input', issues: [{ code: 'invalid_input', severity: 'required', message: '没有待筛记录。' }] }
      }
      const batches = chunk(records, config.batchSize)
      const parent = ctx.get('agents')?.get?.(call.agentId)
      const diagnostics = ctx.get('evimedDiagnostics')?.forSession?.(call.sessionId) ?? ctx.get('evimedDiagnostics')
      /** @type {Record<string, any>[]} */
      const verdicts = []
      /** @type {string[]} */
      const failures = []

      // Batches run in waves rather than all at once: the ceiling is the
      // control plane's, and exceeding it is how one run starves every other
      // run in the container.
      // 0 is "no ceiling" here as it is for delegation: one wave of every batch.
      const waveSize = Number(config.maxConcurrentChildren) > 0 ? Number(config.maxConcurrentChildren) : Math.max(1, batches.length)
      for (const wave of chunk(batches, waveSize)) {
        // A cancelled call starts no further wave — it used to stop here by the
        // next wave's starts rejecting, which `allSettled` below now reports
        // instead. The children already out were cancelled through the signal
        // they hold, and have been collected and released.
        call.signal?.throwIfAborted?.()
        // `allSettled`, not `Promise.all`: every child that did start is one
        // this call owns and must release, and a sibling whose start was
        // refused used to reject the whole wave and leave the ones that had
        // started running with nobody holding them. A refused start is a batch
        // that failed, reported like any other — the way the kernel's own
        // background delegation reports one. `async` so a start that throws
        // before it returns a promise is a rejection here too, not a throw out
        // of `map` past the siblings it already started.
        const starts = await Promise.allSettled(wave.map(async (batch, index) => startSubagent(ctx, {
          capability: 'evimed-screening',
          label: `筛选 ${index + 1}/${batches.length}`,
          prompt: screeningPrompt(String(args.criteria), batch),
          // Read-only: a screening child judges records it was handed and has
          // no business touching the workspace.
          tools: ['read'],
          persona: '你是文献筛选员。你只按给定标准判断给定记录，不检索、不写文件、不改判标准。',
          outputSchema: SCREEN_VERDICT_SCHEMA,
          maxDepth: 1,
        }, parent, call.signal)))
        // Each child is released as soon as its own result is in, not after
        // the slowest sibling's; `collectSubagentRun` never rejects, so one
        // child's fault cannot strand the others.
        const collected = await Promise.all(starts.map((start) => (start.status === 'fulfilled' ? collectSubagentRun(start.value) : null)))
        starts.forEach((start, index) => {
          if (start.status === 'rejected') {
            failures.push(`subagent start failed: ${errorMessage(start.reason)}`)
            return
          }
          const collection = /** @type {import('../src/subagentRun.mjs').SubagentCollection} */ (collected[index])
          // Recorded, not failed: the batch's verdicts stand, and what is left
          // is a child the kernel may still hold.
          if (collection.releaseError) diagnostics?.degrade?.(`screening child not released: ${collection.releaseError}`)
          if (!collection.ok) {
            failures.push(errorMessage(collection.error))
            return
          }
          const outcome = toSubagentOutcome(start.value, collection.settled)
          if (outcome.stopReason !== 'completed') {
            failures.push(outcome.diagnostic || outcome.stopReason)
            return
          }
          const structured = /** @type {Record<string, any>} */ (outcome.structured ?? {})
          for (const verdict of Array.isArray(structured.verdicts) ? structured.verdicts : []) verdicts.push(verdict)
        })
      }

      // `ledgerPath` is model-supplied, and every other write target in this
      // socket is a hard-coded constant precisely so the model can never choose
      // *where* something lands, only *what*. This tool is the one exception,
      // because a batch running across several deliverables needs to name its
      // own ledger — so it is the one place that has to check by hand what the
      // rest of the system gets for free: without this, `ledgerPath:
      // "task-plan.json"` overwrites the plan the run is being graded against,
      // and `ledgerPath: "../.evimed-brief/index.json"` reaches the question
      // itself. Refused as a value, like every other verdict here — not
      // silently redirected, which would teach the model nothing.
      const requestedPath = String(args.ledgerPath ?? 'screening-ledger.csv')
      const normalized = normalizeWorkspacePath(requestedPath)
      if (!normalized || isProtectedWritePath(normalized)) {
        return {
          ok: false,
          code: 'invalid_input',
          issues: [{
            code: 'screening_ledger_path_invalid',
            severity: 'required',
            message: `ledgerPath "${requestedPath}" 无法解析，或指向题面、回执、状态投影或只读数据分区。台账请写在工作区内的普通路径，例如 screening-ledger.csv 或 deliverables/<交付物 id>/screening-ledger.csv。`,
          }],
        }
      }
      await writeFileAt(ctx, call.cwd, normalized, renderScreeningLedger(verdicts))
      const included = verdicts.filter((verdict) => verdict?.decision === 'include').length
      return {
        ok: true,
        data: {
          screened: verdicts.length,
          requested: records.length,
          included,
          excluded: verdicts.filter((verdict) => verdict?.decision === 'exclude').length,
          unclear: verdicts.filter((verdict) => verdict?.decision === 'unclear').length,
          batches: batches.length,
          ledgerPath: normalized,
          // A batch that failed is reported, never silently dropped: a
          // screening that covered 4,700 of 5,000 records and said nothing is
          // a screening whose numbers are wrong.
          failures,
        },
      }
    },
  })
  ctx.effect(() => registerTool(ctx, screenTool))
}
