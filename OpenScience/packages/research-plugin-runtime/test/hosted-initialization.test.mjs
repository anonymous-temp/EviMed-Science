import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnessModule } from '@evimed/harness-port'
import { registerResearchTools } from '../index.mjs'

test('hosted bundle may mount before its adapter and follows the provider lifetime', async () => {
  const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
  const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  // Emulate an independently installed bundle's distinct physical port copy.
  const hostPort = await import(new URL('../../harness-port/src/pluginProbe.mjs?host-copy', import.meta.url))
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const skills = new Map()
  ctx.provide('skills', { register(skill) { skills.set(skill.name, skill); return () => skills.delete(skill.name) } })
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
    for (let attempt = 0; attempt < 100 && !skills.has('virtual-trial'); attempt++) await new Promise(done => setTimeout(done, 10))
    assert.match(skills.get('virtual-trial').whenToUse, /virtual_trial_describe/)
    assert.match(skills.get('virtual-trial').content, /essential inputs are absent/)
    hostPort.verifyResearchAgent(ctx, agent, ['virtual-trial'])
    await provider.dispose()
    await new Promise(done => setTimeout(done, 50))
    assert.equal(tools.get('virtual_trial_start', agent), undefined)
    assert.equal(skills.has('virtual-trial'), false)
    hostPort.verifyResearchAgent(ctx, agent, [])
  } finally { await ctx.fiber.dispose() }
})
