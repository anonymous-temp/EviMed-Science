// Two copies of @deepseek-ai/dsh-scope in one process, as the runtime image has.
//
// Production, 2026-09-27: every plugin probe failed with
// `citation_probe_agent_unavailable`. The kernel's agent machinery runs from the
// CLI's install; this package, inside the profile seed, resolved the seed's own
// copy of dsh-scope. Its scope tag is a module-local `Symbol('dsh.scope')`, so
// the second copy's `scopeOf` answered `undefined` for every kernel context.
// Reproduced on a seed projected the way the container boots
// (`profile-seed.mjs sync`), passing only when the whole seed was copied.
//
// Here the kernel side is the real dsh-scope and a real cordis context, joined
// the way dsh-agent-presets joins an agent to a preset's standing composition;
// the second copy is the same file loaded under another URL -- a second module
// instance, exactly what two installs are -- and it is what this package would
// get if it imported dsh-scope itself.
import assert from 'node:assert/strict'
import test from 'node:test'
import { __setHarnessModule, loadHarnessModule } from '../index.mjs'
import { registerCitationConfiguration, registerPluginProbe } from '../src/pluginProbe.mjs'

const scopeUrl = import.meta.resolve('@deepseek-ai/dsh-scope')
const kernelScope = await import(scopeUrl)
const secondScope = await import(`${scopeUrl}?second-copy`)
const { Context } = await import('@deepseek-ai/cordis')

/** An agent the way dsh-agent-loop mints one: `createScope(loopCtx, agent)`.
 *  @param {any} root @param {string} id */
function kernelAgent(root, id) {
  /** @type {any} */ const agent = {
    id, session: { id }, status: 'idle', inbox: { hasPending: false },
    runMaintenance: async (/** @type {any} */ operation) => operation(AbortSignal.timeout(1000)),
  }
  agent.ctx = kernelScope.createScope(root, agent).ctx
  return agent
}

/** A kernel whose preset is mounted once, standing, and joined by every agent
 *  (dsh-agent-presets: `ensureStanding`, then `bindScopeParent(agent, standing)`).
 *  @param {Record<string, any>} configuration what the standing citation bridge registers */
function kernelWithStandingPreset(configuration) {
  const root = new Context()
  /** @type {any} */ let standing = null
  /** @type {any[]} */ const agents = []
  /** @type {any[]} */ const setups = []
  const kernel = {
    agents: {
      list: () => agents,
      // dsh-agent-loop's factory: `setup(agent.ctx, agent)` before publication.
      create: async (/** @type {any} */ options) => {
        const agent = kernelAgent(root, options.sessionId)
        setups.push(agent)
        await options.setup(agent.ctx, agent)
        return { agent, dispose: async () => {} }
      },
    },
    agentPresets: {
      mount: async (/** @type {any} */ agentCtx, /** @type {string} */ preset) => {
        assert.equal(preset, 'evimed-universal')
        if (!standing) {
          const key = {}
          standing = { key, ctx: kernelScope.createScope(root, key).ctx }
          await registerCitationConfiguration(standing.ctx.plugin(() => {}).ctx, configuration)
        }
        kernelScope.bindScopeParent(kernelScope.scopeOf(agentCtx), standing.key)
      },
    },
    tools: { get: () => undefined },
  }
  return { kernel, root, agents, setups }
}

test('the hazard is real: a second copy of dsh-scope cannot read the kernel\'s scope', () => {
  const agent = kernelAgent(new Context(), 'hazard')
  const mounted = agent.ctx.plugin(() => {}).ctx
  assert.equal(kernelScope.scopeOf(mounted), agent)
  assert.equal(secondScope.scopeOf(mounted), undefined, 'two module instances, two symbols')
})

test('this package never imports dsh-scope itself', async () => {
  __setHarnessModule('@deepseek-ai/dsh-scope', secondScope)
  await assert.rejects(loadHarnessModule('@deepseek-ai/dsh-scope'), /kernel state in module-local symbols/)
})

test('a probe proves the configuration of a real standing composition, with a second dsh-scope present', async () => {
  // The old code read the agent and the configuration through this copy.
  __setHarnessModule('@deepseek-ai/dsh-scope', secondScope)
  // A minimal typert: the class and the decorator only; the wire is not under test.
  __setHarnessModule('@deepseek-ai/dsh-typert-protocol', { TypertRemoteService: class {}, Remote: () => {} })
  const { kernel, root, agents, setups } = kernelWithStandingPreset({ binaryVersion: '0.3.2', enabled: false, timeoutMs: 10000, revision: 1 })
  // A researcher's session already running on the same standing composition.
  const user = kernelAgent(root, 'user-session')
  await kernel.agentPresets.mount(user.ctx, 'evimed-universal')
  agents.push(user)

  const probe = await registerPluginProbe(kernel)
  const proof = await probe.verify()
  assert.deepEqual(proof, { binaryVersion: '0.3.2', enabled: false, revision: 1, timeoutMs: 10000, tools: [], upstream: null })
  // Its agent was the one the kernel handed setup, hidden from host listeners
  // before publication.
  assert.equal(setups.length, 1)
  assert.equal(setups[0][Context.filter](), false)
  assert.equal(setups[0].session[Context.filter](), false)
  // And it joined the standing composition, by the kernel's own reading.
  assert.equal(kernelScope.scopeChainOf(setups[0]).length, 2)
})
