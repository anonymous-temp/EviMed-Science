import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeManager } from '../src/runtimeManager.mjs'
import { AgentBayRuntimeProvider } from '../src/agentbay/runtimeProvider.mjs'
import { personalSkillRuntimeIdentity } from '../src/personalSkillRuntimeIdentity.mjs'
import { PersonalSkillGenerationService } from '../src/personalSkillGenerationService.mjs'
import { ExtensionGenerationService } from '../src/extensionGenerationService.mjs'

test('AgentBay image identity and actual launch environment carry frozen skill and client-plugin policies without Docker', async () => {
  const config = { runtimeProvider: 'agentbay', agentbayImageId: 'imgc-fixed-build', loopxEnabled: true }
  const manager = new RuntimeManager(config, { agentbayClient: {} })
  const identity = await personalSkillRuntimeIdentity(manager)
  assert.match(identity.baseRuntimeImageDigest, /^sha256:[a-f0-9]{64}$/)
  const provider = new AgentBayRuntimeProvider(manager, {})
  const policy = { disabled: ['office:docx'], disabledPlugins: ['annotation'] }
  const environment = provider.kernelEnvironment({ userId: 'owner' }, { gateways: {}, personalSkillGeneration: { platformSkills: policy }, pluginConfig: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } } })
  assert.deepEqual(JSON.parse(environment.EVIMED_DISABLED_PLATFORM_SKILLS), policy.disabled)
  assert.deepEqual(JSON.parse(environment.EVIMED_DISABLED_CLIENT_BUNDLES), policy.disabledPlugins)
})

test('a policy replacement rebases the installed composite rather than dropping its plugin composition', async () => {
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  const project = { id: 'paper', userId: 'owner' }
  const old = { projection: { plugins: [{ extensionId: 'installed-extension' }], personal: { reference: null, pins: [], platformSkills: { disabled: [] } } } }
  const selected = { reference: null, pins: [], platformSkills: { disabled: ['office:docx'] } }
  const rebased = { ...old, projection: { ...old.projection, personal: selected } }
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.personalSkillGenerations = { prepareForRuntime: async () => selected }
  manager.extensionGenerationResolver = async () => old
  manager.prepareGeneration = async () => ({ joined: true })
  manager.rebasePersonalComposite = async (_project, actual) => { assert.equal(actual, selected); return rebased }
  let observed
  manager.provider = { preflight: async () => {}, prepare: async (_project, input) => { observed = input; throw new Error('provider boundary') } }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed.extensionGeneration, rebased)
  assert.equal(observed.extensionGeneration.projection.plugins[0].extensionId, 'installed-extension')
})

test('a cold startup cannot silently re-enable a saved disabled method when generation identity or preparation is unavailable', async () => {
  const project = { userId: 'owner', id: 'paper' }, selected = { revision: 1, payload: { skills: [], disabledPlatformSkills: ['office:docx'] } }
  const service = new PersonalSkillGenerationService(null, { config: {}, skillService: { projectSelections: async () => selected }, pluginService: {},
    resolveUser: async () => ({ id: project.userId }), identities: async () => { throw new Error('image unavailable') } })
  service.current = async () => ({ payload: { phase: 'effective', runtimeGeneration: 'old', effective: { selectionRevision: 1, platformSkills: { disabled: ['office:docx'] } } } })
  service.reconcile = async () => { throw new Error('preparation unavailable') }
  await assert.rejects(service.prepareForRuntime(project), error => error.preserveSkillPolicy === true)
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  manager.personalSkillGenerations = service; manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.provider = { preflight: async () => {}, prepare: async () => assert.fail('a baseline must not replace restrictive choices') }
  await assert.rejects(manager.startKernel(project), error => error.preserveSkillPolicy === true)
})

test('a refused composite rebase releases every temporary override before the next authoritative startup', async () => {
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 }), project = { id: 'paper', userId: 'owner' }
  manager.rebasePersonalComposite = async () => { throw new Error('plugin selection changed') }
  await assert.rejects(manager.replacePersonalSkillRuntime(project, { reference: { generationHash: 'old' } }), /plugin selection changed/)
  assert.equal(manager.personalSkillOverrides.has(manager.key(project)), false)
  assert.equal(manager.extensionGenerationOverrides.has(manager.key(project)), false)
  let observed = false
  manager.rebasePersonalComposite = null
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  manager.personalSkillGenerations = { prepareForRuntime: async () => { observed = true; return null } }
  manager.provider = { preflight: async () => {}, prepare: async () => { throw new Error('provider boundary') } }
  await assert.rejects(manager.startKernel(project), /provider boundary/)
  assert.equal(observed, true)
})

test('a retired installer account is reauthorized through the owner, and unavailable owner authority still refuses', async () => {
  const actors = [], fake = {
    database: { transaction: async work => work({}), withTransactionClient: async (_client, work) => work() },
    current: async () => ({ payload: { effective: { reference: {}, scope: { actorId: 'retired-installer', actorAccountCreatedAt: 'old' } } } }),
    verifyManifest: async () => {},
    snapshot: async actor => { actors.push(actor.id); throw Object.assign(new Error('unavailable'), { status: actor.id === 'owner' ? 403 : 401 }) },
  }
  await assert.rejects(ExtensionGenerationService.prototype.rebasePersonal.call(fake, { id: 'paper', userId: 'owner' }, {}), { status: 403 })
  assert.deepEqual(actors, ['retired-installer', 'owner'])
})
