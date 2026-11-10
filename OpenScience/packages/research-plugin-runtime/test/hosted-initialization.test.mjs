import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnessModule } from '@evimed/harness-port'
import { registerResearchTools } from '../index.mjs'

test('hosted bundle may mount before its adapter and follows the provider lifetime', async () => {
  const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
  const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  const { SkillRegistry } = await loadHarnessModule('@deepseek-ai/dsh-skill')
  // Emulate an independently installed bundle's distinct physical port copy.
  const hostPort = await import(new URL('../../harness-port/src/pluginProbe.mjs?host-copy', import.meta.url))
  const ctx = new Context()
  const sections = new Map()
  ctx.provide('systemPrompt', { tools() {}, section(value) { sections.set(value.name, value); return () => sections.delete(value.name) } })
  const skills = new SkillRegistry(ctx)
  const tools = new ToolRuntime(ctx)
  const agent = { ctx, session: { id: 'initialization-test', requestHeader: () => ({ config: {} }) } }
  const configuration = { name: 'virtual_trial', methods: ['design.analytic'], mode: 'hosted', workspace: '', engineRoot: '', skillUrl: new URL('../../virtual-trial/SKILL.md', import.meta.url) }
  try {
    await ctx.plugin({ name: 'research-before-provider', apply: scoped => registerResearchTools(scoped, configuration) })
    assert.equal(tools.get('virtual_trial_start', agent), undefined)
    const provider = await ctx.plugin({ name: 'late-provider', apply(scoped) {
      scoped.provide('evimedResearchAdapter', { start() {}, read() {}, cancel() {}, registerConfiguration: hostPort.registerResearchConfiguration })
    } })
    for (let attempt = 0; attempt < 100 && !tools.get('virtual_trial_start', agent); attempt++) await new Promise(done => setTimeout(done, 10))
    assert.ok(tools.get('virtual_trial_start', agent))
    // the trial bundle's lab tools come with it, and only with it
    assert.ok(tools.get('virtual_trial_search', agent) && tools.get('virtual_trial_compare', agent))
    for (let attempt = 0; attempt < 100 && !(await skills.list()).some(row => row.name === 'virtual-trial'); attempt++) await new Promise(done => setTimeout(done, 10))
    const loaded = await skills.get('virtual-trial')
    assert.match(loaded.whenToUse, /virtual_trial_describe/)
    assert.match(loaded.content, /essential inputs are absent/)
    assert.equal(loaded.source, 'runtime')
    assert.equal(loaded.resourceBase.kind, 'directory')
    assert.match(loaded.resourceBase.path, /virtual-trial/)
    assert.match(sections.get('evimed-research-virtual_trial').text, /in any useful order/)
    assert.match(sections.get('evimed-research-virtual_trial').text, /Unrelated general work stays ordinary conversation/)
    hostPort.verifyResearchAgent(ctx, agent, ['virtual-trial'])
    await provider.dispose()
    await new Promise(done => setTimeout(done, 50))
    assert.equal(tools.get('virtual_trial_start', agent), undefined)
    assert.equal((await skills.list()).some(row => row.name === 'virtual-trial'), false)
    assert.equal(sections.has('evimed-research-virtual_trial'), false)
    hostPort.verifyResearchAgent(ctx, agent, [])
  } finally { await ctx.fiber.dispose() }
})
