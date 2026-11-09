// Run from a clean profile where the suite and optional domain bundles are installed.
import assert from 'node:assert/strict'
import { loadHarnessModule } from '@evimed/harness-port'
import * as suite from '@evimed/virtual-research-suite/plugin'
const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
const ctx = new Context()
ctx.provide('systemPrompt', { tools() {}, section() { return () => {} } })
const runtime = new ToolRuntime(ctx)
// Since DSH 0.2.2 a call runs through the composition's selected executor (a batch of calls), not through ToolRuntime itself.
ctx.plugin(await loadHarnessModule('@deepseek-ai/dsh-tool-executor-native'))
await ctx.plugin(suite, { mode: 'standalone' })
if (process.env.WITH_TRIAL) {
  const trial = await import('@evimed/virtual-trial/plugin')
  await ctx.plugin(trial, { mode: 'standalone', workspace: process.env.WORKSPACE, engineRoot: process.env.ENGINE_ROOT, rscript: process.env.RSCRIPT || 'Rscript' })
}
await new Promise(done => setTimeout(done, 30))
const agent = { session: { id: 'suite-probe', requestHeader: () => ({ config: {} }) }, ctx }
const batch = await runtime.execute({ calls: [{ type: 'tool-call', id: 'suite-probe', name: 'virtual_research_available', arguments: '{}' }], agent, signal: new AbortController().signal })
const result = batch.results[0].result
assert.equal(result.isError, false)
if (process.env.WITH_TRIAL) assert.ok(result.value.data.tools.includes('virtual_trial_start'))
else assert.deepEqual(result.value.data.tools, [])
await ctx.fiber.dispose()
console.log(process.env.WITH_TRIAL ? 'Suite discovers the installed trial tool' : 'Suite installs without domain bundles and reports no visible tools')
