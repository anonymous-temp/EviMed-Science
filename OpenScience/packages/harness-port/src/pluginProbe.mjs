/** Fixed hosted-plugin proof. This is deliberately not a general tool runner. */
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadHarnessModule } from '../index.mjs'
export const CITATION_TOOLS = Object.freeze(['cite_lookup', 'cite_format', 'cite_bibtex', 'cite_check', 'cite_health'])
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

/**
 * The managed transport's own failures that are this deployment's, not the
 * source's: the runtime was given no gateway or token file, it cannot read the
 * token, or it cannot reach the control plane's gateway. The names are the
 * codes `createManagedFetch` in the socket's citation bridge throws -- a closed
 * vocabulary.
 */
const TRANSPORT_FAILURES = Object.freeze({
  citation_gateway_unconfigured: 'the runtime was given no source gateway or token file',
  citation_gateway_token_unavailable: 'the runtime could not read its gateway token',
  citation_gateway_unavailable: 'the runtime could not reach the source gateway',
})

/**
 * Gateway statuses that are the gateway's own refusal and never a source's:
 * `publicSourceGateway.mjs` passes an upstream 404 and 429 through, maps every
 * other upstream 4xx to 400 and every 5xx to 502, and answers 401 only for a
 * token it does not accept and 403 only for an endpoint its policy refuses.
 */
const GATEWAY_REFUSALS = Object.freeze({
  401: 'the source gateway refused the runtime token',
  403: 'the source gateway refused the approved endpoint',
})

/**
 * What one `cite_health` call says about the source behind the gateway, kept
 * apart from the configuration proof.
 *
 * The proof is what the control plane owns -- the build, the revision, the
 * switch, the settings and the tools registered -- plus a transport it can
 * use: a token the runtime reads and the gateway accepts. Those failures throw.
 * Everything past the gateway is Crossref, measured at about a quarter of
 * requests timing out from the production host (2026-09-26 audit), and a proof
 * that needed a live answer from it failed applies at random. So the source's
 * health is reported, `{ ok, code }`, and never fails the proof: `code` is
 * `http_<status>` for a status the gateway passed on, one of the transport's
 * own codes (`citation_gateway_timeout`, `citation_response_too_large`), or
 * `cite_health_failed` for anything else.
 *
 * `cite_health` reports its checks as dsh-cite 0.3.2 writes them -- the
 * version this probe is pinned to above: `HTTP <status>` for an answer, the
 * thrown error's message for a transport failure.
 * @param {any} health the `cite_health` result
 * @returns {{ ok: boolean, code: string | null }}
 */
export function citationUpstreamHealth(health) {
  if (health?.ok === true) return { ok: true, code: null }
  const checks = Array.isArray(health?.checks) ? health.checks : []
  const text = checks.filter((/** @type {any} */ check) => check?.ok !== true).map((/** @type {any} */ check) => String(check?.detail ?? '')).join(' ')
  const transport = Object.keys(TRANSPORT_FAILURES).find(code => new RegExp(`\\b${code}\\b`, 'u').test(text))
  if (transport) throw probeFailure('citation_probe_gateway_failed', `${TRANSPORT_FAILURES[/** @type {keyof typeof TRANSPORT_FAILURES} */ (transport)]} (${transport})`)
  const status = /\bHTTP (\d{3})\b/u.exec(text)?.[1]
  if (status && Object.hasOwn(GATEWAY_REFUSALS, status)) {
    throw probeFailure('citation_probe_gateway_failed', `${GATEWAY_REFUSALS[/** @type {keyof typeof GATEWAY_REFUSALS} */ (Number(status))]} (HTTP ${status})`)
  }
  if (status) return { ok: false, code: `http_${status}` }
  const own = /\b(citation_gateway_timeout|citation_response_too_large)\b/u.exec(text)?.[1]
  if (own) return { ok: false, code: own }
  // `cite_health` and the managed transport time out at the same moment, and
  // when the tool's own timer wins, what it reports is the platform's
  // `TimeoutError` message rather than the transport's code. Measured on a
  // local kernel with a source slower than the timeout (2026-09-27).
  if (text.includes('The operation was aborted due to timeout')) return { ok: false, code: 'citation_gateway_timeout' }
  return { ok: false, code: 'cite_health_failed' }
}

/** Read the metadata provided in that same Agent scope, then its real registry.
 *
 * The proof holds the configuration the control plane owns and a usable
 * transport; the source's own health rides beside it as `upstream`
 * (`citationUpstreamHealth`), `null` when the tools are switched off and there
 * is nothing to ask.
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
  /** @type {{ ok: boolean, code: string | null } | null} */
  let upstream = null
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
      // One call, `cite_health`: it exercises the registered definition, the
      // managed transport and the token, and it is the whole of what the
      // source is asked. A DOI lookup used to follow it, a second Crossref
      // request per probe that proved nothing about the configuration.
      await agent.runMaintenance(async (/** @type {AbortSignal} */ signal) => {
        const result = await pipeline.execute({ agent, callId: `evimed-plugin-cite_health-${Date.now()}`, name: 'cite_health',
          arguments: {}, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs + 2000)]) })
        // The native pipeline refusing the registered definition -- its input
        // or output schema, a denial -- is the registration failing, not the
        // source: `cite_health` reports a transport or source failure in its
        // result and throws only when this call itself is cancelled.
        if (result.isError) throw probeFailure('citation_probe_gateway_failed', `cite_health: ${result.error?.message ?? 'failed'}`)
        upstream = citationUpstreamHealth(result.value)
      })
    } finally { await isolated.fiber.dispose() }
  }
  return { binaryVersion: config.binaryVersion, enabled: config.enabled, revision: config.revision, timeoutMs: config.timeoutMs, tools, upstream }
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
