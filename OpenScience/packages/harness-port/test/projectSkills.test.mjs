import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { apply as applyNativeSkillConsumer } from '@deepseek-ai/dsh-tool-skill'
import { registerProjectSkillProvider } from '../src/projectSkills.mjs'

test('native registry keeps disabled winners with neither invocation channel in root and child scopes; other projects and fixed generation stay independent', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-skills-')))
  const office = path.join(root, 'office'), core = path.join(root, 'core'), community = path.join(root, 'community')
  for (const [directory, name, body] of [[office, 'docx', 'office'], [community, 'docx', 'shadow'], [core, 'stats-integrity', 'required']]) {
    await fs.mkdir(path.join(directory, name), { recursive: true })
    await fs.writeFile(path.join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n${body}`)
  }
  const ctx = new Context(); new SkillRegistry(ctx)
  const preset = createScope(ctx, { id: 'preset-one' }), otherPreset = createScope(ctx, { id: 'preset-two' })
  const config = { customSkillDirs: [core, office, community], disabledSkills: ['office:docx', 'core:stats-integrity'] }
  await registerProjectSkillProvider(preset.ctx, config)
  await registerProjectSkillProvider(otherPreset.ctx, { ...config, disabledSkills: [] })
  const rootAgent = createScope(preset.ctx, { id: 'root' }, { parent: scopeOf(preset.ctx) }), child = createScope(preset.ctx, { id: 'child' }, { parent: scopeOf(preset.ctx) })
  const other = createScope(otherPreset.ctx, { id: 'other' }, { parent: scopeOf(otherPreset.ctx) })
  /** @type {any[]} */ const steps = []
  /** @type {any} */ let skillTool
  applyNativeSkillConsumer(/** @type {any} */ ({ skills: ctx.skills, workingDirectory: { ensure: async () => '/unused' },
    tools: { register: (/** @type {any} */ tool) => { skillTool = tool }, get: () => skillTool }, on: (/** @type {any} */ _event, /** @type {any} */ handler) => { steps.push(handler) } }))
  t.after(async () => { await Promise.all([rootAgent.dispose(), child.dispose(), other.dispose()]); await Promise.all([preset.dispose(), otherPreset.dispose()]); await fs.rm(root, { recursive: true, force: true }) })
  for (const scope of [rootAgent, child]) {
    const options = { scope: scopeOf(scope.ctx) }, items = await ctx.skills.list(options), disabled = items.find(item => item.name === 'docx')
    assert.ok(disabled)
    assert.equal(disabled.provider, 'filesystem')
    assert.equal(isModelInvocable(disabled), false)
    assert.equal(isUserInvocable(disabled), false)
    const definition = await ctx.skills.get('docx', options)
    assert.ok(definition)
    assert.equal(definition.content, 'office')
    assert.equal(isModelInvocable(definition), false)
    assert.equal(isUserInvocable(definition), false)
    const required = items.find(item => item.name === 'stats-integrity'); assert.ok(required)
    assert.equal(isModelInvocable(required), true)
    assert.equal((await ctx.skills.snapshot(options)).complete, true)
    const agent = /** @type {any} */ (scopeOf(scope.ctx)), signal = AbortSignal.timeout(5000)
    agent.session = { surface: { nodes: [] }, seq: 0 }
    await assert.rejects(skillTool.execute({ name: 'docx' }, { agent, signal }), /not available for model invocation/)
    const manual = await steps[0]({ agent, signal, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/docx' }] }] }, async () => ({ kind: 'enter', messages: [] }))
    assert.deepEqual(manual.messages, [], 'the real pinned slash consumer cannot inject a disabled method')
    const catalogue = await steps[1]({ agent, signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(catalogue.messages.flatMap((/** @type {any} */ message) => message.source.entries ?? []).some((/** @type {any} */ item) => item.name === 'docx'), false)
  }
  config.disabledSkills.length = 0
  const captured = await ctx.skills.get('docx', { scope: scopeOf(rootAgent.ctx) }); assert.ok(captured)
  assert.equal(isUserInvocable(captured), false, 'a running composition retains its captured policy')
  const independent = await ctx.skills.get('docx', { scope: scopeOf(other.ctx) }); assert.ok(independent)
  assert.equal(isUserInvocable(independent), true)
  const allowed = await steps[0]({ agent: scopeOf(other.ctx), signal: AbortSignal.timeout(5000), messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/docx' }] }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(allowed.messages.some((/** @type {any} */ message) => message.source.kind === 'skill-invocation' && message.source.name === 'docx'), true)
  assert.equal((await skillTool.execute({ name: 'docx' }, { agent: scopeOf(other.ctx), signal: AbortSignal.timeout(5000) })).content, 'office')
})
