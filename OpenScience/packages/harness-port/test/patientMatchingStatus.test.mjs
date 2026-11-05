import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { registerPatientMatchingStatus } from '../src/patientMatchingStatus.mjs'
import { registerSkill } from '../index.mjs'
import SEAMS from '../seam-manifest.json' with { type: 'json' }
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const ctx = new Context(); ctx.provide('systemPrompt', { tools() {} })
  const tools = new ToolRuntime(ctx); new SkillRegistry(ctx)
  const names = ['match_context', 'match_assess']
  const disposers = names.map(name => tools.register({ name, description: 'Inert probe fixture', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'object' }, render: () => [] }, async execute() { throw new Error('Probe must not execute a tool') } }))
  const removeSkill = registerSkill(ctx, { name: 'patient-matching', description: 'Professional matching', content: 'Use the bounded matching tools.' })
  const service = await registerPatientMatchingStatus(ctx, { tools: names })
  t.after(() => ctx.fiber.dispose())
  return { ctx, service, names, disposers, removeSkill }
}
test('fixed native status reads the actual registry without executing tools or a model', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.service.status(), { enabled: true, tools: f.names, skill: 'patient-matching' })
  assert.equal((await f.ctx.skills.get('patient-matching'))?.content, 'Use the bounded matching tools.')
  assert.deepEqual(remoteMethods(f.service).map(method => method.method), ['status', 'cancel'])
  assert.ok(SEAMS.wire.unary.includes('patientMatching/status'))
  assert.deepEqual(SEAMS.wire.unaryArgs['patientMatching/status'], [])
})
test('status observes actual tool/skill removal and cannot claim a missing registration', async t => {
  const f = await fixture(t)
  f.disposers[1]()
  assert.deepEqual(await f.service.status(), { enabled: false, tools: [f.names[0]], skill: 'patient-matching' })
  f.removeSkill()
  assert.deepEqual(await f.service.status(), { enabled: false, tools: [f.names[0]], skill: null })
})
test('status respects cancellation and registration accepts only matching inventory names', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.status(AbortSignal.abort()), { name: 'AbortError' })
  for (const tools of [[], ['bash'], ['match_context', 'match_context']]) await assert.rejects(registerPatientMatchingStatus(f.ctx, { tools }), /patient_matching_probe_config_invalid/)
})
test('fixed cancel RPC admits only one opaque task identifier and delegates to the trusted callback', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  /** @type {string[]} */ const observed = []
  const service = await registerPatientMatchingStatus(ctx, { tools: ['match_assess'], cancel: taskId => { observed.push(taskId); return taskId === 'task-active' } })
  assert.deepEqual(await service.cancel('task-active'), { cancelled: true })
  assert.deepEqual(await service.cancel('task-missing'), { cancelled: false })
  for (const invalid of ['', 'task with spaces', { taskId: 'task-active' }]) await assert.rejects(service.cancel(/** @type {any} */ (invalid)), /patient_matching_task_invalid/)
  assert.deepEqual(observed, ['task-active', 'task-missing'])
  assert.deepEqual(SEAMS.wire.unaryArgs['patientMatching/cancel'], ['taskId'])
})
