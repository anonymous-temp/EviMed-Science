/**
 * The root conversation of a native replay (`native_replay.mjs`), loaded into the kernel as a provider row. It answers every root model
 * call by asking the runner what the root does next (one `match_assess` call with its arguments, or a closing sentence), so the only
 * model reasoning in a replay is the plugin's own managed Flash child. It never sees patient words: the runner chooses the calls from the
 * task's saved progress, not from the conversation.
 *
 * Environment: NATIVE_REPLAY_CONTROL, the runner's control address for this conversation (loopback only).
 */
export const name = 'native-replay-parent'
export const inject = ['llm']

const PROVIDER = 'native-replay'

export function apply(ctx) {
  const control = String(process.env.NATIVE_REPLAY_CONTROL ?? '')
  if (!/^http:\/\/127\.0\.0\.1:\d+\//u.test(control)) throw new Error('NATIVE_REPLAY_CONTROL must be a loopback address')
  const metadata = (provider, model) => ({ provider, id: model, name: 'Replay root', context: { contextWindow: 200000 }, defaultMaxTokens: 8000,
    reasoning: { efforts: [{ id: 'high', name: 'High' }], default: 'high' } })
  let step = 0
  const adapter = {
    providerInfo: id => ({ id, name: 'Native replay root (no model)' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => [metadata(provider, 'replay-root')],
    resolveModel: async (provider, model) => metadata(provider, model),
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => image,
    async prepareCall(provider, model) { return { model: metadata(provider, model), stream: options => adapter.stream(options) } },
    async *stream(options) {
      const response = await fetch(control, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: options.sessionId ?? null, step }) })
      const next = await response.json()
      step += 1
      const block = next?.tool === 'match_assess'
        ? { type: 'tool-call', id: `replay-${step}`, name: 'match_assess', arguments: JSON.stringify(next.args ?? {}) }
        : { type: 'text', text: 'Replay finished.' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
}
