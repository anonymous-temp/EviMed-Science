// A context that runs a tool call needs an executor mounted beside the registry, and a call is a batch. Until 0.2.2 `ToolRuntime` ran one
// call itself; now the composition's `tool-executor-native` row does, over `{ calls, signal, agent }`, and a test that builds a bare
// context mounts the same plugin and asks for one call's outcome the way the agent loop does.

/** @param {any} ctx a Cordis context that already provides `tools` */
export async function mountNativeExecutor(ctx) {
  ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
}

/**
 * One call through the selected executor, as its result.
 * @param {any} runtime the context's `tools` service
 * @param {{ callId: string, name: string, agent?: any, arguments?: unknown, signal: AbortSignal }} call
 */
export async function runNativeCall(runtime, call) {
  const batch = await runtime.execute({
    calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }],
    ...(call.agent === undefined ? {} : { agent: call.agent }),
    signal: call.signal,
  })
  return batch.results[0].result
}
