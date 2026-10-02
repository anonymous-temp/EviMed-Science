import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeManager } from '../src/runtimeManager.mjs'
import { runtimeEnvironment } from '../src/dshProfilePatch.mjs'

test('personal source pins remain on the live generation and native invoke uses one admitted slash prompt', async () => {
  const project = { userId: 'owner', id: 'project', workspaceDir: '/workspace' }
  const pin = { skillId: 'skill-one', revision: 1, digest: `sha256:${'b'.repeat(64)}`, nativeName: 'personal-fixture', invocation: { userInvocable: true, modelInvocable: false } }
  const candidate = { reference: { generationHash: 'a'.repeat(64) }, pins: [pin] }
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  const runtime = { personalSkillGeneration: candidate, modelGatewayTokenJti: 'native-fixture-generation' }
  manager.runtimes.set(manager.key(project), runtime)
  manager.personalSkillGenerations = { requireInvocation: async () => ({ nativeName: pin.nativeName, digest: pin.digest }) }
  manager.start = async () => runtime
  let prompt, admitted = false
  manager.pluginService = { withAdmission: async (_project, action, options) => { assert.equal(options.prompt, true); admitted = true; return action() } }
  manager.callKernel = async (_runtime, _project, method) => {
    assert.equal(admitted, true)
    return method === 'session/list' ? { items: [{ sessionId: 'conversation' }] } : { skills: [{ name: pin.nativeName, modelInvocable: false,
      path: `/opt/evimed/personal-skills/${pin.nativeName}/SKILL.md` }] }
  }
  manager.dispatchAdmittedPrompt = async (_project, sessionId, body) => { prompt = { sessionId, ...body } }
  assert.deepEqual(manager.runtimePersonalSkillPins(project), [{ skillId: pin.skillId, revision: 1, digest: pin.digest, nativeName: pin.nativeName, source: 'personal' }])
  const result = await manager.invokePersonalSkill({ project, skillId: pin.skillId, revision: 1, sessionId: 'conversation', idempotencyKey: 'invoke-one' })
  assert.equal(result.accepted, true)
  assert.deepEqual(prompt, { sessionId: 'conversation', text: '/personal-fixture', requestId: 'invoke-one' })
  await assert.rejects(manager.invokePersonalSkill({ project, skillId: pin.skillId, revision: 2, sessionId: 'conversation', idempotencyKey: 'invoke-two' }), /waiting/u)
})

test('native provider settings use a fixed personal root and preserve existing capsule authority', () => {
  const settings = runtimeEnvironment({ presetSkillsDir: '/opt/core', capabilitiesDir: '/opt/capabilities', capabilitySkillsDir: '/opt/capability-skills',
    capsuleMethodsDir: '/capsule-methods', capsuleGatewayUrl: '', workloadTokenFile: '/runtime/workload', bundleVersion: 'fixture',
    flags: { hosted: true, askUser: false, review: false, capsule: false, requiredEnforcement: 'full' }, limits: { deliveryAttemptLimit: 3, maxSteps: 10, maxTokens: 1000, evidenceStaleMinutes: 60 } })
  assert.equal(settings.EVIMED_PERSONAL_SKILLS_DIR, '/opt/evimed/personal-skills')
  assert.equal(settings.EVIMED_CAPSULE_METHODS_DIR, '/capsule-methods')
})

test('cold preparation exceptions select baseline without consulting retired lastGood bytes', async () => {
  const manager = new RuntimeManager({ dataDir: '/private/tmp/personal-runtime-cold-fixture', runtimeIdleTimeoutMs: 0 })
  const project = { userId: 'cold-owner', id: 'cold-project' }
  manager.personalSkillGenerations = { prepareForRuntime: async () => { throw new Error('ledger unavailable') }, current: async () => assert.fail('must not revive retired lastGood') }
  manager.syncCapsuleMethods = async () => ({ count: 0 })
  let observed
  manager.provider = { preflight: async () => {}, prepare: async (_project, args) => { observed = args.personalSkillGeneration; throw new Error('provider boundary fixture') } }
  await assert.rejects(manager.startKernel(project), /provider boundary fixture/u)
  assert.equal(observed, null)
})
