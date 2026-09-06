/** Fixed hosted-plugin proof. This is deliberately not a general tool runner. */
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadHarnessModule } from '../index.mjs'
export const CITATION_TOOLS = Object.freeze(['cite_lookup', 'cite_format', 'cite_bibtex', 'cite_check', 'cite_health'])
const DOI = '10.1038/nphys1170'
/** Read the installed package selected by the bundle's own module resolver.
 * @param {string} manifestUrl */
export async function installedCitationVersion(manifestUrl) {
  const manifest = JSON.parse(await readFile(new URL(manifestUrl), 'utf8'))
  if (manifest.name !== 'dsh-cite' || manifest.version !== '0.3.2') throw new Error('citation_binary_unapproved')
  return manifest.version
}

const citationConfigurations = new WeakMap()
/** Standing-preset scoped observation; no process-global Cordis service is published.
 * @param {any} ctx @param {any} configuration */
export async function registerCitationConfiguration(ctx, configuration) {
  const { scopeOf } = await loadHarnessModule('@deepseek-ai/dsh-scope')
  const agent = scopeOf(ctx)
  if (!agent) return
  const value = Object.freeze({ ...configuration })
  ctx.effect(() => {
    citationConfigurations.set(agent, value)
    return () => { if (citationConfigurations.get(agent) === value) citationConfigurations.delete(agent) }
  })
}

/** Includes durable pending input and maintenance, whose public status is idle.
 * @param {any} ctx */
export async function pluginRuntimeBusy(ctx) {
  for (const agent of ctx.agents.list()) {
    if (agent.status !== 'idle' || agent.inbox.hasPending) return true
    try { await agent.runMaintenance(async () => {}) } catch { return true }
    if (agent.status !== 'idle' || agent.inbox.hasPending) return true
  }
  return false
}

/** Read the metadata provided in that same Agent scope, then its real registry.
 * @param {any} ctx @param {any} agent */
export async function verifyCitationAgent(ctx, agent) {
  const { scopeChainOf } = await loadHarnessModule('@deepseek-ai/dsh-scope')
  const config = scopeChainOf(agent).map((/** @type {object} */ scope) => citationConfigurations.get(scope)).find(Boolean)
  if (!config || config.binaryVersion !== '0.3.2' || !Number.isSafeInteger(config.timeoutMs)
    || config.timeoutMs < 2000 || config.timeoutMs > 15000 || !Number.isSafeInteger(config.revision)
    || config.revision < 0 || typeof config.enabled !== 'boolean') throw new Error('citation_probe_config_invalid')
  const tools = CITATION_TOOLS.filter(name => Boolean(ctx.tools.get(name, agent)))
  if (tools.length !== (config.enabled ? CITATION_TOOLS.length : 0)) throw new Error('citation_probe_registrations_invalid')
  if (config.enabled) {
    const [{ Context }, { ToolRuntime }, { SystemPrompt }] = await Promise.all([
      loadHarnessModule('@deepseek-ai/cordis'), loadHarnessModule('@deepseek-ai/dsh-tools'),
      loadHarnessModule('@deepseek-ai/dsh-system-prompt'),
    ])
    // Use the identical registered definitions in an owned native pipeline.
    // Native argument/output validation and cancellation still apply, while
    // probe results cannot notify the research host's business observers.
    const isolated = new Context()
    try {
      new SystemPrompt(isolated, { includeHarnessIdentity: false, includeRuntimeContext: false })
      const pipeline = new ToolRuntime(isolated)
      for (const name of tools) pipeline.register(ctx.tools.get(name, agent))
      await agent.runMaintenance(async (/** @type {AbortSignal} */ signal) => {
        const execute = async (/** @type {string} */ name, /** @type {any} */ args) => {
          const result = await pipeline.execute({ agent, callId: `evimed-plugin-${name}-${Date.now()}`, name,
            arguments: args, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs + 2000)]) })
          if (result.isError) throw new Error('citation_probe_gateway_failed')
          return result.value
        }
        const health = await execute('cite_health', {})
        if (health?.ok !== true) throw new Error('citation_probe_gateway_failed')
        const lookup = await execute('cite_lookup', { doi: DOI })
        if (!Array.isArray(lookup?.works) || !lookup.works.some((/** @type {any} */ work) => work.doi === DOI)) throw new Error('citation_probe_lookup_failed')
      })
    } finally { await isolated.fiber.dispose() }
  }
  return { binaryVersion: config.binaryVersion, enabled: config.enabled, revision: config.revision, timeoutMs: config.timeoutMs, tools }
}

/** Only two parameterless methods cross the authenticated kernel wire.
 * @param {any} ctx */
export async function registerPluginProbe(ctx) {
  const { TypertRemoteService, Remote } = await loadHarnessModule('@deepseek-ai/dsh-typert-protocol')
  /** @type {((this:any)=>void)[]} */
  const initializers = []
  class PluginProbe extends TypertRemoteService {
    constructor() {
      super(ctx, 'evimedPlugins')
      for (const initialize of initializers) initialize.call(this)
    }
    async status() { return { busy: await pluginRuntimeBusy(ctx) } }
    async verify() {
      if (await pluginRuntimeBusy(ctx)) throw new Error('citation_probe_runtime_busy')
      const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
      const workspace = await mkdtemp(path.join(tmpdir(), 'evimed-plugin-check-'))
      try {
        // Receiver filters are installed on these exact unpublished instances,
        // before SessionStore.enter captures its lifecycle carrier. No host
        // listener, prototype, user-supplied id or durable identity is changed.
        const handle = await ctx.agents.create({
          sessionId: `evimed_plugin_${randomUUID()}`,
          meta: { cwd: workspace, agentPreset: 'evimed-universal' },
          signal: AbortSignal.timeout(45000),
          setup: async (/** @type {any} */ agentCtx) => {
            const { scopeOf } = await loadHarnessModule('@deepseek-ai/dsh-scope')
            const agent = scopeOf(agentCtx)
            if (!agent?.session) throw new Error('citation_probe_agent_unavailable')
            Object.defineProperty(agent, Context.filter, { value: () => false })
            Object.defineProperty(agent.session, Context.filter, { value: () => false })
            await ctx.agentPresets.mount(agentCtx, 'evimed-universal')
          },
        })
        try { return await verifyCitationAgent(ctx, handle.agent) }
        finally { await handle.dispose() }
      } finally { await rm(workspace, { recursive: true, force: true }) }
    }
  }
  for (const name of ['status', 'verify']) Remote(PluginProbe.prototype[name], {
    kind: 'method', name, static: false, private: false,
    addInitializer: (/** @type {(this:any)=>void} */ initialize) => initializers.push(initialize),
  })
  return new PluginProbe()
}
