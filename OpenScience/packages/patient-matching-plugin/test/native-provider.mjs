/** Synthetic adapter only. This file is excluded from the published bundle. No external network or key. */
import { appendFile, readFile } from 'node:fs/promises'
export const name = 'matching-synthetic-provider'
export const inject = ['llm']
export function apply(ctx) {
  const counts = new Map()
  const metadata = (provider, model) => ({ provider, id: model, name: 'Synthetic native proof model', context: { contextWindow: 200000 }, defaultMaxTokens: 8000, reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'medium', name: 'Medium' }, { id: 'low', name: 'Low' }], default: 'high' } })
  const adapter = {
    providerInfo: id => ({ id, name: 'Synthetic proof (no external calls)' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [metadata(provider, 'deepseek-flash'), metadata(provider, 'synthetic-parent')],
    resolveModel: async (provider, model) => metadata(provider, model), imageRequestPricing: () => undefined, imageRequestTarget: (_provider, _model, image) => image,
    async prepareCall(provider, model) { return { model: metadata(provider, model), stream: options => adapter.stream(options) } },
    async *stream(options) {
      const names = (options.tools ?? []).map(tool => tool.name)
      const liveAgents = ctx.get('agents').list().length
      await appendFile(process.env.MATCHING_PROOF_LOG, `${JSON.stringify({ sessionId: options.sessionId, model: options.model, provider: options.provider, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens, tools: names, liveAgents, skills: (await ctx.get('skills').list()).map(skill => skill.name) })}\n`)
      const key = options.sessionId ?? 'aux', count = counts.get(key) ?? 0; counts.set(key, count + 1)
      if (names.includes('structured_output') && process.env.MATCHING_PROOF_INVALID_CHILD === '1') {
        yield {type:'finish',reason:{kind:'error',failure:{code:'SYNTHETIC_INVALID_JSON',message:'Synthetic provider returned unreadable structured output'}}}; return
      }
      if (names.includes('structured_output') && process.env.MATCHING_PROOF_CANCEL_CHILD === '1') {
        const cancellation = await ctx.get('typertGateway').invoke({ namespace: 'patientMatching', method: 'cancel', args: { taskId: 'task-a' }, peer: { principal: { kind: 'owner' }, signal: new AbortController().signal } })
        await appendFile(process.env.MATCHING_PROOF_LOG, `${JSON.stringify({ cancellation })}\n`)
        options.signal.throwIfAborted()
      }
      const tool = (toolName, args) => ({ type: 'tool-call', id: `synthetic-${count}`, name: toolName, arguments: JSON.stringify(args) })
      let block
      if (names.includes('structured_output')) {
        if (count === 0) block = tool('match_evidence', { taskId: 'task-a', source: 'patient', action: 'read', subjectKey: 'patient-a', evidenceId: 'e1' })
        else if (count === 1) block = tool('match_compute', { taskId: 'task-a', calculatorId: 'proof-calculator', subjectKey: 'patient-a', operands: [{ name: 'age', value: 50, unit: 'years', evidenceId: 'e1' }] })
        else block = tool('structured_output', { decisions: [JSON.parse(await readFile(process.env.MATCHING_PROOF_FIXTURE, 'utf8')).decision] })
      } else if (names.includes('match_assess') && count === 0) block = tool('match_assess', { taskId: 'task-a' })
      else block = { type: 'text', text: names.includes('match_assess') ? 'Synthetic matching proof finished.' : 'Synthetic general conversation unchanged.' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek'], adapter))
}
