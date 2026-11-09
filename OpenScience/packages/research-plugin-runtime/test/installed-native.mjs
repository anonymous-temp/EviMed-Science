// Copy this probe into a clean installation containing the packed packages.
// ENGINE_ROOT points to a separately installed VCR engine, WORKSPACE to a scratch directory.
import assert from 'node:assert/strict'
import { loadHarnessModule } from '@evimed/harness-port'
const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
const ctx = new Context()
ctx.provide('systemPrompt', { tools() {}, section() { return () => {} } })
const runtime = new ToolRuntime(ctx)
const agent = { session: { id: 'local-probe', requestHeader: () => ({ config: {} }) }, ctx }
async function call(name, args) {
  const result = await runtime.execute({ callId: `probe-${Math.random()}`, name, agent, arguments: args, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.data
}
const cases = [
  ['virtual_trial', 'design.analytic', { design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 24 }, analysis: { alpha: 0.025, power: 0.9 } }],
  ['virtual_trial', 'evidence.network', { measure: 'log_ratio', direction: 'lower_better', reference: 'A', studies: [{ studyId: 's1', contrasts: [{ treatment: 'B', comparator: 'A', effect: -0.30, se: 0.15 }] }, { studyId: 's2', contrasts: [{ treatment: 'C', comparator: 'A', effect: -0.50, se: 0.20 }] }, { studyId: 's3', contrasts: [{ treatment: 'C', comparator: 'B', effect: -0.15, se: 0.18 }] }, { studyId: 's4', contrasts: [{ treatment: 'B', comparator: 'A', effect: -0.25, se: 0.22 }] }] }],
  ['virtual_cohort', 'population.scenario', { n: 200, population: { variables: [{ name: 'age', family: 'normal', mean: 60, sd: 9 }] } }],
  ['virtual_patient', 'patients.binary', { design: { nTreat: 40, nControl: 40 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 } }],
  ['synthetic_control', 'comparator.evalue', { riskRatio: 3.9, confidenceLimit: 1.8 }],
]
const mounted = new Set()
for (const [prefix, method, scenario] of cases.filter(([name]) => !process.env.PLUGIN_CASE || name === process.env.PLUGIN_CASE)) {
  const plugin = await import(`@evimed/${prefix.replaceAll('_', '-')}/plugin`)
  if (!mounted.has(prefix)) {
    await ctx.plugin(plugin, { mode: 'standalone', workspace: process.env.WORKSPACE, engineRoot: process.env.ENGINE_ROOT, rscript: process.env.RSCRIPT || 'Rscript' })
    mounted.add(prefix)
    await new Promise(done => setTimeout(done, 50))
  }
  const overview = await call(`${prefix}_describe`, {})
  assert.ok(overview.guidance.includes('Inputs and provenance'))
  const shape = await call(`${prefix}_describe`, { method })
  assert.ok(shape.scenarioSchema)
  const { jobId } = await call(`${prefix}_start`, { method, scenario })
  let result
  for (let i = 0; i < 100; i++) {
    result = await call(`${prefix}_read`, { jobId })
    if (result.status !== 'running') break
    await new Promise(done => setTimeout(done, 100))
  }
  assert.equal(result.status, 'succeeded', `${method}: ${JSON.stringify(result)}`)
  if (method === 'design.analytic') assert.equal(result.measures.find(item => item.name === 'required_events').value, 331)
  const report = await call(`${prefix}_report`, { jobId })
  assert.match(report.report, /Research result/)
  assert.ok(report.path)
  assert.ok(report.reproductionPath)
  console.log(`${method}: native DSH tool probe passed`)
}
await ctx.fiber.dispose()
