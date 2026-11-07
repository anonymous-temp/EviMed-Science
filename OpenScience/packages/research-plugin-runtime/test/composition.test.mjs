// The four professional plugins and the optional suite as products: each completes its own task alone with supplied or imported
// resources, any selection composes without ordering or a fixed workflow, one can be disabled and enabled without disturbing the
// others, historical ids and call shapes stay valid under the new names, and uninstalling a plugin leaves the research objects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { loadHarnessModule } from '@evimed/harness-port'
import { RESEARCH_NATIVE_BUNDLES, VCR_ENGINE_METHODS } from '@evimed/domain'
import { catalogue, sharedEvidenceMethods } from '../catalogue.mjs'
import { createLocalAdapter, createPlugin } from '../index.mjs'
import { createSuite } from '../../virtual-research-suite/index.mjs'

const PLUGINS = Object.freeze({
  'virtual-trial': 'virtual_trial', 'virtual-cohort': 'virtual_cohort', 'virtual-patient': 'virtual_patient', 'synthetic-control': 'synthetic_control',
})
const ACTIONS = ['describe', 'start', 'read', 'report', 'cancel']
const engineRoot = resolve(import.meta.dirname, '../../../../项目代码/vcr-engine')
const hostPortUrl = new URL('../../harness-port/src/pluginProbe.mjs', import.meta.url)

/** A host that holds no engine: its adapter records what each plugin sent it and answers like a hosted adapter would. */
function fakeAdapter(registerConfiguration, calls) {
  return {
    registerConfiguration,
    describe: async (method) => ({ method, scenarioSchema: {} }),
    start: async (request) => { calls.push(['start', request]); return { jobId: `job_${calls.length}` } },
    read: async (jobId) => ({ jobId, status: 'running' }), cancel: async () => {},
    search: async (args) => { calls.push(['search', args]); return { campaignId: 'cmp_1' } },
    compare: async (args) => { calls.push(['compare', args]); return { experimentId: 'exp_1' } },
  }
}

/** A conversation scope with a fake host adapter and the given plugin bundles mounted in the given order. @param {string[]} ids */
async function mount(ids, { suite = false } = {}) {
  const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
  const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  const hostPort = await import(hostPortUrl)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() { return () => {} } })
  const runtime = new ToolRuntime(ctx)
  const agent = { ctx, session: { id: 'composition-test', requestHeader: () => ({ config: {} }) } }
  const calls = []
  await ctx.plugin({ name: 'host-adapter', apply: (scoped) => { scoped.provide('evimedResearchAdapter', fakeAdapter(hostPort.registerResearchConfiguration, calls)) } })
  const handles = new Map()
  const add = async (id) => {
    const module = await import(`../../${id}/plugin.mjs`)
    handles.set(id, await ctx.plugin(module, { mode: 'hosted', workspace: '', engineRoot: '' }))
    await settle()
  }
  for (const id of ids) await add(id)
  if (suite) await add('virtual-research-suite')
  const has = (name) => Boolean(runtime.get(name, agent))
  const raw = (name, args) => runtime.execute({ callId: `c-${Math.random()}`, name, agent, arguments: args, signal: new AbortController().signal })
  const call = async (name, args) => {
    const result = await raw(name, args)
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value.data
  }
  const visible = () => Object.values(PLUGINS).flatMap((prefix) => ACTIONS.map((action) => `${prefix}_${action}`)).filter(has)
  const description = (name) => runtime.get(name, agent)?.description ?? ''
  return { ctx, calls, handles, has, call, raw, add, visible, description, async dispose() { await ctx.fiber.dispose() } }
}
const settle = () => new Promise((done) => setTimeout(done, 60))

test('each of the four plugins mounts alone with its own five tools and nothing of its siblings', async () => {
  for (const [id, prefix] of Object.entries(PLUGINS)) {
    const world = await mount([id])
    try {
      assert.deepEqual([...world.visible()].sort(), ACTIONS.map((action) => `${prefix}_${action}`).sort(), id)
      for (const [other, otherPrefix] of Object.entries(PLUGINS)) if (other !== id) assert.equal(world.has(`${otherPrefix}_start`), false, `${id} alone has no ${other}`)
      assert.equal(world.has('virtual_research_available'), false, 'the suite is optional')
      assert.equal(world.has('virtual_trial_search'), id === 'virtual-trial', 'the lab tools belong to the trial plugin and come with it only')
    } finally { await world.dispose() }
  }
})

test('a trajectory forecast needs no population plugin: the patient plugin takes the supplied patients and model by themselves', async () => {
  const world = await mount(['virtual-patient'])
  try {
    const request = { method: 'patients.longitudinal', scenario: { design: { nTreat: 1, nControl: 1 } }, subjectId: 'cohort_supplied_1', modelId: 'mdl_1', modelVersion: '3', inputs: [{ kind: 'dataset', id: 'inp_history' }] }
    assert.ok(catalogue.find((item) => item.id === 'virtual-patient').methods.includes(request.method))
    assert.equal((await world.call('virtual_patient_start', request)).jobId, 'job_1')
    assert.deepEqual(world.calls[0][1], request, 'the host receives the supplied references exactly as given')
    assert.equal(world.has('virtual_cohort_start'), false)
  } finally { await world.dispose() }
})

test('the lab compares hypotheses and searches a design with no population or patient plugin installed', async () => {
  const world = await mount(['virtual-trial'])
  try {
    const arms = ['none', 'symptomatic'].map((name) => ({ name, method: 'patients.progression', scenario: { design: { nTreat: 100, nControl: 100 }, treatment: name === 'none' ? {} : { symptomatic: { pointsAt: { value: -2.5, basis: 'assumed' } } } } }))
    assert.equal((await world.call('virtual_trial_compare', { experiment: { arms, comparison: { measures: ['expected_difference'], reference: 'none' } } })).experimentId, 'exp_1')
    assert.equal((await world.call('virtual_trial_search', { manifest: { space: { method: 'patients.progression' } } })).campaignId, 'cmp_1')
    assert.deepEqual(world.calls.map(([kind]) => kind), ['compare', 'search'])
    assert.equal(world.calls[0][1].experiment.arms[1].method, 'patients.progression', 'a disease arm passes through as it was named')
    assert.equal(world.has('virtual_patient_start') || world.has('virtual_cohort_start'), false)
  } finally { await world.dispose() }
})

test('a comparator takes authorized observed data directly, with no cohort or patient plugin', async () => {
  const world = await mount(['synthetic-control'])
  try {
    const request = { method: 'comparator.weighted_cox', scenario: { estimand: 'att' }, inputs: [{ kind: 'dataset', id: 'inp_trial_arm' }, { kind: 'dataset', id: 'inp_external_control' }] }
    await world.call('synthetic_control_start', request)
    assert.deepEqual(world.calls[0][1].inputs, request.inputs)
    const refused = await world.raw('synthetic_control_start', { method: 'population.scenario', scenario: {} })
    assert.equal(refused.isError, true, 'a sibling\'s method is refused, not forwarded')
    assert.match(JSON.stringify(refused), /unsupported_method/)
    assert.equal(world.calls.length, 1)
  } finally { await world.dispose() }
})

test('selected combinations compose in any order and the suite lists exactly what is installed', async () => {
  const a = await mount(['virtual-trial', 'virtual-patient'], { suite: true })
  const b = await mount(['virtual-patient', 'virtual-trial'], { suite: true })
  try {
    const listed = async (world) => (await world.call('virtual_research_available', {})).tools
    const expected = [...ACTIONS.map((action) => `virtual_patient_${action}`), ...ACTIONS.map((action) => `virtual_trial_${action}`), 'virtual_trial_compare', 'virtual_trial_search'].sort()
    assert.deepEqual(await listed(a), expected, 'the lab tools are listed with their plugin')
    assert.deepEqual(await listed(b), expected, 'mount order changes nothing')
    assert.equal(a.has('virtual_cohort_start'), false)
    // the suite alone installs and confers nothing
    const alone = await mount([], { suite: true })
    try { assert.deepEqual(await listed(alone), []) } finally { await alone.dispose() }
  } finally { await a.dispose(); await b.dispose() }
})

test('the suite composes only plugins that do not own the same method, and shares the evidence methods', () => {
  const owned = catalogue.flatMap((item) => item.methods.filter((method) => !sharedEvidenceMethods.includes(method)))
  assert.equal(new Set(owned).size, owned.length, 'no two plugins own one method')
  const adapter = { start: async (request) => ({ jobId: request.method }), read: async () => ({}), cancel: async () => {} }
  const suite = createSuite(catalogue.map((item) => createPlugin({ adapter, methods: item.methods })))
  assert.ok(suite.listMethods().includes('evidence.pool') && suite.listMethods().includes('population.scenario') && suite.listMethods().includes('patients.longitudinal'))
  assert.throws(() => createSuite([createPlugin({ adapter, methods: ['design.analytic'] }), createPlugin({ adapter, methods: ['design.analytic'] })]), /duplicate_method/)
})

test('disabling one plugin removes only its tools and enabling it again restores them, with the others undisturbed', async () => {
  const world = await mount(Object.keys(PLUGINS))
  try {
    assert.equal(world.visible().length, 20)
    await world.handles.get('virtual-patient').dispose()
    await settle()
    assert.equal(world.has('virtual_patient_start'), false)
    assert.deepEqual(world.visible().filter((name) => name.startsWith('virtual_patient')), [])
    assert.equal(world.visible().length, 15)
    assert.equal((await world.call('virtual_trial_start', { method: 'design.analytic', scenario: {} })).jobId, 'job_1', 'the others still work while it is off')
    await world.add('virtual-patient')
    assert.equal(world.visible().length, 20)
    assert.equal((await world.call('virtual_patient_start', { method: 'patients.binary', scenario: {} })).jobId, 'job_2')
  } finally { await world.dispose() }
})

test('the trial and patient plugins name the disease-progression arms the lab compares, in no more words than before', async () => {
  // Live 2026-11-07 (D2): an Alzheimer three-arm ADAS-cog question was answered by a script of the model's own. When these plugins are
  // admitted their task line rides describe, start, the skill and the prompt section, so it says the class within its old length
  // (trial 223, patient 108, compare 232 characters before).
  const world = await mount(['virtual-trial', 'virtual-patient'])
  try {
    const trial = catalogue.find((item) => item.id === 'virtual-trial').task
    const patient = catalogue.find((item) => item.id === 'virtual-patient').task
    const compare = world.description('virtual_trial_compare')
    for (const [text, words, cap] of [[trial, ['disease-progression model', 'Alzheimer ADAS-cog', 'saved', 'search for a design'], 223],
      [patient, ['disease progression', 'Alzheimer ADAS-cog'], 108], [compare, ['resultId (no rerun)', 'disease-progression model'], 232]]) {
      for (const word of words) assert.ok(text.includes(word), `${word}: ${text}`)
      assert.ok(text.length <= cap, `${text.length} > ${cap}: ${text}`)
    }
    assert.ok(world.description('virtual_patient_start').startsWith(patient) && world.description('virtual_trial_start').startsWith(trial))
    assert.ok(catalogue.find((item) => item.id === 'virtual-patient').methods.includes('patients.progression'), 'the patient plugin runs the model it names')
  } finally { await world.dispose() }
})

test('the historical package ids, tool names and call shapes stay valid under the new names', () => {
  // the ids installed profiles and recorded calls carry: they never change with what a person reads
  assert.deepEqual(catalogue.map((item) => item.id), ['virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control'])
  for (const [id, prefix] of Object.entries(PLUGINS)) {
    assert.deepEqual(ACTIONS.map((action) => `${prefix}_${action}`).every((tool) => RESEARCH_NATIVE_BUNDLES[id].tools.includes(tool)), true, id)
    assert.ok(RESEARCH_NATIVE_BUNDLES[id].tools.length >= 5)
  }
  const names = Object.fromEntries(catalogue.map((item) => [item.id, [item.title, item.displayName]]))
  assert.deepEqual(names['virtual-cohort'], ['Virtual population', '虚拟人群'])
  assert.deepEqual(names['virtual-patient'], ['Patient trajectory prediction', '患者轨迹预测'])
  assert.match(names['virtual-trial'][0], /^Virtual laboratory/)
  assert.deepEqual(names['synthetic-control'], ['Synthetic control arm', '合成对照臂'])
  // every method of every plugin is a registered engine method, so an upgrade of the plugin keeps the engine's versions
  for (const item of catalogue) for (const method of item.methods) assert.ok(VCR_ENGINE_METHODS[method], `${item.id}: ${method}`)
  // a call written before the rename (method, scenario, the method's own version) is admitted by the same plugin
  const plugin = createPlugin({ adapter: { start: async (request) => ({ jobId: 'job', request }) }, methods: catalogue.find((item) => item.id === 'virtual-trial').methods })
  return plugin.start({ method: 'design.analytic', version: VCR_ENGINE_METHODS['design.analytic'].version, scenario: {} }).then((result) => assert.equal(result.jobId, 'job'))
})

test('uninstalling a plugin leaves the research objects: a job it wrote is read, reported and listed without it', { skip: process.env.VCR_PLUGIN_R_TESTS === 'omit' && 'Executed by the pinned R engine CI job instead of the JavaScript-only job' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-compose-'))
  try {
    const writer = createLocalAdapter({ workspace, engineRoot, rscript: process.env.RSCRIPT || 'Rscript' })
    const { jobId } = await createPlugin({ adapter: writer, methods: catalogue.find((item) => item.id === 'virtual-trial').methods }).start({ method: 'design.analytic', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 24 }, analysis: { alpha: 0.025, power: 0.9 } } })
    let result
    for (let i = 0; i < 100; i++) { result = await writer.read(jobId); if (result.status !== 'running') break; await new Promise((done) => setTimeout(done, 100)) }
    assert.equal(result.status, 'succeeded')
    // the trial plugin is gone: only the comparator plugin is installed, over a fresh adapter on the same workspace
    const world = await mount(['synthetic-control'])
    try { assert.equal(world.has('virtual_trial_read'), false) } finally { await world.dispose() }
    const reader = createLocalAdapter({ workspace, engineRoot })
    assert.equal((await reader.read(jobId)).status, 'succeeded')
    assert.equal((await reader.readRequest(jobId)).job.method, 'design.analytic')
    // and the record answers to any plugin that is installed later
    const later = createPlugin({ adapter: reader, methods: catalogue.find((item) => item.id === 'virtual-trial').methods })
    assert.equal((await later.read(jobId)).measures.find((item) => item.name === 'required_events').value, 331)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
