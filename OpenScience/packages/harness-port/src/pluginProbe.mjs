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

/**
 * A probe failure that says which check failed and why, not only that one did.
 *
 * The code stays the first word, so every reader matching on it still matches;
 * what follows is the reason, bounded and on one line. The reasons are the
 * probe's own findings and the citation tools' own error text, which the
 * managed transport already reduces to its codes (no address, no token).
 * The first production apply (2026-09-27) failed with nothing recorded but a
 * bare code, which could not tell a token the runtime could not read from a
 * gateway it could not reach from a source that said no.
 * @param {string} code @param {string} [reason]
 */
function probeFailure(code, reason = '') {
  // eslint-disable-next-line no-control-regex
  const detail = String(reason).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 240)
  return new Error(detail ? `${code}: ${detail}` : code)
}

/** The failed checks a `cite_health` result reports, as one line.
 * @param {any} health */
function failedHealthChecks(health) {
  const checks = Array.isArray(health?.checks) ? health.checks : []
  const failed = checks.filter((/** @type {any} */ check) => check?.ok !== true)
    .map((/** @type {any} */ check) => `${String(check?.name ?? 'check')} ${String(check?.detail ?? '')}`.trim())
  return failed.length ? `cite_health: ${failed.join('; ')}` : 'cite_health did not report ok'
}

/** Read the metadata provided in that same Agent scope, then its real registry.
 * @param {any} ctx @param {any} agent */
export async function verifyCitationAgent(ctx, agent) {
  const { scopeChainOf } = await loadHarnessModule('@deepseek-ai/dsh-scope')
  const config = scopeChainOf(agent).map((/** @type {object} */ scope) => citationConfigurations.get(scope)).find(Boolean)
  if (!config) throw probeFailure('citation_probe_config_invalid', 'no citation configuration registered in this agent scope')
  if (config.binaryVersion !== '0.3.2' || !Number.isSafeInteger(config.timeoutMs)
    || config.timeoutMs < 2000 || config.timeoutMs > 15000 || !Number.isSafeInteger(config.revision)
    || config.revision < 0 || typeof config.enabled !== 'boolean') {
    throw probeFailure('citation_probe_config_invalid', `binaryVersion=${config.binaryVersion} timeoutMs=${config.timeoutMs} revision=${config.revision} enabled=${config.enabled}`)
  }
  const tools = CITATION_TOOLS.filter(name => Boolean(ctx.tools.get(name, agent)))
  if (tools.length !== (config.enabled ? CITATION_TOOLS.length : 0)) {
    throw probeFailure('citation_probe_registrations_invalid', `enabled=${config.enabled}, registered ${tools.length ? tools.join(',') : 'none'}`)
  }
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
          if (result.isError) throw probeFailure('citation_probe_gateway_failed', `${name}: ${result.error?.message ?? 'failed'}`)
          return result.value
        }
        const health = await execute('cite_health', {})
        if (health?.ok !== true) throw probeFailure('citation_probe_gateway_failed', failedHealthChecks(health))
        const lookup = await execute('cite_lookup', { doi: DOI })
        if (!Array.isArray(lookup?.works) || !lookup.works.some((/** @type {any} */ work) => work.doi === DOI)) {
          throw probeFailure('citation_probe_lookup_failed', `cite_lookup returned ${Array.isArray(lookup?.works) ? `${lookup.works.length} work(s) without ${DOI}` : 'no works'}`)
        }
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
      if (await pluginRuntimeBusy(ctx)) throw probeFailure('citation_probe_runtime_busy', 'an agent is running, has queued input or is in maintenance')
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
