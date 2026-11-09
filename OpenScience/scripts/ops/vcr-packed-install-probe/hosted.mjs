// Run from inside a profile that holds the packed bundles in the hosted composition. Argument: the bundle ids that must be selected.
// Mounts each installed bundle's plugin in hosted mode beside a stand-in `evimedResearchAdapter` provider (the socket's row in the
// real composition), calls its tools through the kernel's own ToolRuntime, checks the native registry with the same
// `verifyResearchAgent` the control plane's probe uses, then drops the provider and checks every tool is gone.
import assert from 'node:assert/strict'
import { loadHarnessModule, registerResearchConfiguration, verifyResearchAgent } from '@evimed/harness-port'
const ids = process.argv.slice(2)
const METHOD = { 'virtual-trial': 'design.analytic', 'virtual-cohort': 'population.scenario', 'virtual-patient': 'patients.binary', 'synthetic-control': 'comparator.evalue' }
const PREFIX = { 'virtual-trial': 'virtual_trial', 'virtual-cohort': 'virtual_cohort', 'virtual-patient': 'virtual_patient', 'synthetic-control': 'synthetic_control' }
const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
const ctx = new Context()
ctx.provide('systemPrompt', { tools() {}, section() { return () => {} } })
const tools = new ToolRuntime(ctx)
ctx.plugin(await loadHarnessModule('@deepseek-ai/dsh-tool-executor-native'))   // DSH 0.2.2: calls run through the composition's executor
const agent = { ctx, session: { id: 'packed-probe', requestHeader: () => ({ config: {} }) } }
const seen = []
const provider = await ctx.plugin({ name: 'probe-adapter', apply(scoped) {
  scoped.provide('evimedResearchAdapter', {
    async start(request) { seen.push(request); return { jobId: 'job_probe' } },
    async read() { return { status: 'succeeded' } }, async cancel() {}, async describe(method) { return { method, scenarioSchema: {} } },
    registerConfiguration: registerResearchConfiguration,
  })
} })
for (const id of ids) {
  const mod = await import(`@evimed/${id}/plugin`)
  await ctx.plugin(mod, { mode: 'hosted', workspace: '', engineRoot: '' })
}
const visible = name => Boolean(tools.get(name, agent))
const call = async (name, args) => { const batch = await tools.execute({ calls: [{ type: 'tool-call', id: `p-${Math.random()}`, name, arguments: JSON.stringify(args ?? {}) }], agent, signal: new AbortController().signal }); const r = batch.results[0].result; assert.equal(r.isError, false, JSON.stringify(r)); return r.value.data }
for (let i = 0; i < 100 && !ids.every(id => id === 'virtual-research-suite' ? visible('virtual_research_available') : visible(`${PREFIX[id]}_start`)); i++) await new Promise(done => setTimeout(done, 20))
verifyResearchAgent(ctx, agent, ids)
for (const id of ids) {
  if (id === 'virtual-research-suite') {
    const data = await call('virtual_research_available', {})
    // the suite reports the domain tools that are visible to this agent
    for (const other of ids.filter(x => PREFIX[x])) assert.ok(data.tools.includes(`${PREFIX[other]}_start`), `suite does not see ${other}`)
    continue
  }
  const before = seen.length
  const out = await call(`${PREFIX[id]}_start`, { method: METHOD[id], scenario: { probe: true } })
  assert.equal(out.jobId, 'job_probe'); assert.equal(seen.length, before + 1); assert.equal(seen.at(-1).method, METHOD[id])
  assert.equal((await call(`${PREFIX[id]}_read`, { jobId: 'job_probe' })).status, 'succeeded')
}
// A bundle that is not selected must not be visible.
for (const [id, prefix] of Object.entries(PREFIX)) if (!ids.includes(id)) assert.equal(visible(`${prefix}_start`), false, `${id} visible without being installed`)
await provider.dispose()
await new Promise(done => setTimeout(done, 60))
for (const id of ids) if (PREFIX[id]) assert.equal(visible(`${PREFIX[id]}_start`), false, `${id} tools outlive the provider`)
verifyResearchAgent(ctx, agent, [])
await ctx.fiber.dispose()
console.log(`hosted probe ok: ${ids.join(',')}`)
