/** Bounded reference harness. The root is scripted; its one clinical child is real native DeepSeek Flash. */
import { readFile, appendFile } from 'node:fs/promises'
import { loadHarnessModule } from '../../packages/harness-port/index.mjs'
export const name = 'matching-reference-clinical-runtime'
export const inject = ['llm']
export async function apply(ctx) {
  const { registerDeepSeekProvider, resolveAdapterOptions } = await loadHarnessModule('@deepseek-ai/dsh-llm-deepseek')
  const connection = resolveAdapterOptions({ baseURL: process.env.REFERENCE_FLASH_PROXY, maxTokens: 16000, thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-flash', contextWindow: 1000000, maxTokens: 16000 }], retryPolicy: { mode: 'normal', maxRetries: 0 }, streamIdleTimeoutMs: 240000 })
  registerDeepSeekProvider(ctx, 'deepseek', { options: () => connection, resolveAuth: async () => ({ headers: { 'x-api-key': process.env.REFERENCE_WORKLOAD_TOKEN } }), providerName: 'Host-owned Flash reference gateway', admit: (_connection, model) => { if (model !== 'deepseek-flash') throw new Error('Only Flash is allowed') } })
  let childCount = 0
  ctx.on('agent/created', async ({ agent }) => {
    await appendFile(process.env.REFERENCE_NATIVE_EVENTS, `${JSON.stringify({ kind: 'agent-created', id: agent.id, origin: agent.session.header.origin ?? null, parent: agent.session.header.parentSession ?? null, provider: agent.options?.provider ?? null, model: agent.options?.model ?? null })}\n`)
    if (agent.session.header.origin !== 'subagent' && !agent.session.header.parentSession && agent.options?.provider !== 'deepseek') return
    if (++childCount !== 1) throw new Error('Only one clinical child is authorized')
    const observed = new Set()
    agent.ctx.systemPrompt.section({ name: 'reference:fixture-procedure', order: 99999, text: 'This is one public synthetic fixture. Before structured_output, use match_evidence with source patient/action read to inspect the preserved age, weight and height passages. Then use match_compute, calculatorId bmi, with operands named weight (kg) and height (m), each linked to its exact patient evidenceId. The BMI criterion must use the returned exact calculation; mark its basis computed. Judge only the supplied two protocol criteria. Do not add disease, recruitment or other requirements. Cite all authorized sourceRefs and the exact evidence bundle identity from the frozen context. Return the complete structured response using the native structured_output tool. No external literature search is required.' })
    agent.ctx.tools.guard(exec => exec.name === 'structured_output' && (!observed.has('match_evidence') || !observed.has('match_compute')) ? 'The public fixture requires successful native evidence and BMI computation tools before structured output.' : undefined)
    agent.ctx.on('tools/result', async (exec, result) => {
      const ok = !result.isError && result.value?.ok !== false
      if (ok) observed.add(exec.name)
      await appendFile(process.env.REFERENCE_NATIVE_EVENTS, `${JSON.stringify({ kind: 'child-tool', tool: exec.name, callId: exec.callId, sessionId: agent.id, ok })}\n`)
    })
    await appendFile(process.env.REFERENCE_NATIVE_EVENTS, `${JSON.stringify({ kind: 'child-created', childId: agent.id, model: agent.options?.model ?? 'deepseek-flash' })}\n`)
  })
  let rootCalls = 0
  const meta = (provider, id) => ({ provider, id, name: 'Scripted reference root', context: { contextWindow: 100000 }, defaultMaxTokens: 1024 })
  const adapter = {
    providerInfo: id => ({ id, name: 'Scripted reference root; no provider calls' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => image, listModels: async provider => [meta(provider, 'reference-root')], resolveModel: async (provider, model) => meta(provider, model),
    async prepareCall(provider, model) { return { model: meta(provider, model), stream: options => adapter.stream(options) } },
    async *stream() {
      const state = JSON.parse(await readFile(process.env.REFERENCE_SETUP_FILE, 'utf8')), step = rootCalls++
      const args = step === 0 ? { messageSeq: 1 } : step === 1 ? { messageSeq: 2, protocolText: state.protocolText, title: 'Public synthetic adult BMI protocol' } : step === 2 ? { taskId: state.protocol.taskId, subjectKeys: [state.patient.subjectKey] } : null
      const block = args ? { type: 'tool-call', id: `reference-root-call-${step}`, name: step < 2 ? 'match_context' : 'match_assess', arguments: JSON.stringify(args) } : { type: 'text', text: 'The reference clinical execution ended; its saved result or partial diagnostic is preserved.' }
      yield { type: 'block-start', index: 0, blockType: block.type }; yield { type: 'block-end', index: 0, block }; yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }; yield { type: 'finish', reason: { kind: args ? 'tool-calls' : 'stop' } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter(['reference-root'], adapter))
}
