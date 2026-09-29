/** Per-invocation model policy for the six specialist MCP tool bodies. */
export const ENGINE_EXECUTION_CONTEXT = '__evimed_execution_context'
const ENGINE_TOOLS = Object.freeze(['meta_analysis', 'mendelian_randomization', 'bibliometric_analysis',
  'research_topic_selection', 'peer_review', 'drug_safety_analysis'].map(name => `mcp__evimed__${name}`))

/**
 * Decorate existing global definitions without registering scoped shadows or
 * changing visibility, schemas, guards, or result projection. Public arguments
 * are frozen by DSH; only the fresh object handed to the MCP body is extended.
 * @param {any} ctx @returns {() => void}
 */
export function decorateEngineToolContext(ctx) {
  /** @type {Map<any, {original: Function, wrapped: Function}>} */
  const decorated = new Map()
  const refresh = () => {
    for (const [definition, entry] of decorated) {
      if (ctx.tools?.get(definition.name) === definition) continue
      if (definition.execute === entry.wrapped) definition.execute = entry.original
      decorated.delete(definition)
    }
    for (const name of ENGINE_TOOLS) {
      const definition = ctx.tools?.get(name)
      if (!definition || definition.name !== name || typeof definition.execute !== 'function' || decorated.has(definition)) continue
      const original = definition.execute
      /** @param {any} args @param {any} exec */
      const wrapped = function (args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return original.call(definition, args, exec)
        const forwarded = { ...args }
        delete forwarded[ENGINE_EXECUTION_CONTEXT]
        const session = exec.agent?.session
        const config = session?.requestHeader?.()?.config
        if (config && typeof session.id === 'string') {
          forwarded[ENGINE_EXECUTION_CONTEXT] = {
            v: 1, sessionId: session.id, callId: String(exec.callId), rootCallId: String(exec.rootCallId ?? exec.callId),
            provider: config.provider, model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
          }
        }
        return original.call(definition, forwarded, exec)
      }
      definition.execute = wrapped
      decorated.set(definition, { original, wrapped })
    }
  }
  const unsubscribe = ctx.on('tools/change', refresh)
  refresh()
  return () => {
    unsubscribe()
    for (const [definition, entry] of decorated) {
      if (definition.execute === entry.wrapped) definition.execute = entry.original
    }
    decorated.clear()
  }
}
