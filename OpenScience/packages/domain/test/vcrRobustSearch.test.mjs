// The robust reading of a design search (plan R34): scenarios side by side, maximin, regret, the Pareto and near-optimal sets, and no single optimum.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vcrCampaignManifest, vcrCampaignUnit, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord, vcrCampaignVerdict, vcrCampaignCandidates,
  vcrCandidateScenario, vcrRobustChoice,
} from '../src/vcrExperimentSearch.mjs'

// ---------------------------------------------------------------------------
// A hand-built table: four designs, three scenarios. The numbers are chosen so each statistic has one known answer.
// ---------------------------------------------------------------------------
const power = (/** @type {number} */ value, status = 'pass') => ({ value, mcse: 0.004, status })
const row = (/** @type {string} */ key, /** @type {number} */ index, /** @type {number[]} */ [optimistic, base, pessimistic], /** @type {number} */ n, /** @type {number} */ duration, /** @type {any} */ extra = {}) => ({
  key, index, complete: true, guard: 'pass',
  scenarios: { optimistic: { power: power(optimistic, optimistic >= 0.8 ? 'pass' : 'fail') }, base: { power: power(base, base >= 0.8 ? 'pass' : 'fail') },
    pessimistic: { power: power(pessimistic, pessimistic >= 0.8 ? 'pass' : 'fail') } },
  n: { value: n, mcse: null }, duration: { value: duration, mcse: null }, cost: { value: n, mcse: null }, costBase: { value: n, mcse: null }, ...extra,
})
const TABLE = [
  row('A', 0, [0.90, 0.80, 0.55], 100, 24),   // cheapest, fine at base, weak when the effect is small
  row('B', 1, [0.95, 0.88, 0.70], 160, 24),   // acceptable at base only
  row('C', 2, [0.99, 0.96, 0.84], 240, 24),   // acceptable in every scenario
  row('D', 3, [0.99, 0.96, 0.84], 260, 30),   // C with more people and longer: dominated, and not within tolerance of C
]
const SCENARIOS = [{ name: 'optimistic' }, { name: 'base' }, { name: 'pessimistic' }]
/** @typedef {{ rows: any[], [key: string]: any }} Chosen */
const robust = (/** @type {any} */ input) => /** @type {Chosen} */ (/** @type {any} */ (vcrRobustChoice(input)))
const choose = (over = {}) => robust({ rows: TABLE, scenarios: SCENARIOS, tolerance: { power: 0.02, relative: 0.1 }, confidence: 0.975, baseFeasible: ['A', 'B', 'C', 'D'], ...over })

test('worst-case power is the minimum over scenarios and carries the error of the scenario that was the minimum', () => {
  const out = choose()
  const worst = Object.fromEntries(out.rows.map((r) => [r.key, r.worstCase]))
  assert.deepEqual([worst.A.value, worst.A.scenario, worst.A.mcse], [0.55, 'pessimistic', 0.004])
  assert.equal(worst.C.value, 0.84)
  assert.equal(out.maximin, 'C')
})

test('regret is measured against the best design of each scenario and its maximum is the largest of them', () => {
  const out = choose()
  const regret = Object.fromEntries(out.rows.map((r) => [r.key, r.regret]))
  assert.deepEqual(out.bestIn, { optimistic: 'C', base: 'C', pessimistic: 'C' }, 'a tie goes to the lower index: C before D')
  assert.ok(Math.abs(regret.A.byScenario.pessimistic.value - 0.29) < 1e-12)
  assert.ok(Math.abs(regret.A.max.value - 0.29) < 1e-12 && regret.A.max.scenario === 'pessimistic')
  assert.ok(Math.abs(regret.B.max.value - 0.14) < 1e-12)
  assert.equal(regret.C.max.value, 0)
  // with no declared contrast the error is the sum of the two marginal errors, never their independent combination
  assert.equal(regret.A.max.mcse, 0.008)
  assert.equal(out.minimaxRegret, 'C')
})

test('a contrast the caller knows replaces the worst-case error of a regret', () => {
  const out = choose({ contrast: () => 0.001 })
  assert.equal(out.rows.find((r) => r.key === 'A').regret.max.mcse, 0.001)
})

test('expected power is computed only when every scenario carries a stated weight, and is normalised', () => {
  assert.equal(choose().weighted, false)
  assert.ok(choose().rows.every((r) => r.expectedPower === null))
  const out = choose({ scenarios: [{ name: 'optimistic', weight: 1 }, { name: 'base', weight: 2 }, { name: 'pessimistic', weight: 1 }] })
  assert.equal(out.weighted, true)
  const a = out.rows.find((r) => r.key === 'A').expectedPower
  assert.ok(Math.abs(a.value - (0.25 * 0.90 + 0.5 * 0.80 + 0.25 * 0.55)) < 1e-12)
  assert.ok(Math.abs(a.mcse - 0.004) < 1e-12, 'the weights sum to one and each error is 0.004: the worst case is their weighted sum')
  assert.deepEqual(out.scenarios.map((/** @type {any} */ s) => s.weight), [0.25, 0.5, 0.25])
  // a partial set of weights is not weights
  assert.equal(choose({ scenarios: [{ name: 'optimistic', weight: 1 }, { name: 'base' }, { name: 'pessimistic', weight: 1 }] }).weighted, false)
})

test('the Pareto set is over N, duration and worst-case power; a design that costs more of everything for the same power is out', () => {
  const out = choose()
  assert.deepEqual(out.criteria.map((/** @type {any} */ c) => c.name), ['n', 'duration', 'worst_case_power'])
  assert.deepEqual(out.pareto, ['A', 'B', 'C'], 'A is the cheapest, C the most robust, B is cheaper than C and stronger than A: none dominates another; D is dominated by C')
  assert.equal(out.rows.find((r) => r.key === 'D').pareto, false)
})

test('the near-optimal set is the Pareto set plus the designs within tolerance of one, MCSE included', () => {
  const out = choose()
  assert.deepEqual(out.nearOptimal, ['A', 'B', 'C'], 'D needs 8% more people than C (inside 10%) but 25% longer (outside it)')
  const close = choose({ rows: [...TABLE.slice(0, 3), row('D', 3, [0.99, 0.96, 0.84], 255, 24)] })
  assert.deepEqual(close.pareto, ['A', 'B', 'C'])
  assert.deepEqual(close.nearOptimal, ['A', 'B', 'C', 'D'], '6% more people at the same duration and power is within the 10% tolerance')
  // a looser power tolerance does not bring in a design that is far off on N
  assert.ok(!choose({ tolerance: { power: 0.2, relative: 0.1 } }).nearOptimal.includes('D'))
})

test('the cheapest acceptable design in every scenario is shown beside the cheapest under the base case, and they can differ', () => {
  const out = choose()
  assert.deepEqual(out.acceptable, ['C', 'D'])
  assert.equal(out.cheapestAcceptable, 'C')
  assert.equal(out.cheapestUnderBase, 'A', 'A reaches 0.80 at the base case')
  assert.equal(out.sameDesign, false)
  assert.equal(out.rows.find((r) => r.key === 'A').acceptable, 'fail')
  assert.equal(out.rows.find((r) => r.key === 'C').acceptable, 'pass')
})

test('a design that failed an error-control or safety constraint, or lacks a scenario, keeps its row and enters no set', () => {
  const rows = [row('A', 0, [0.99, 0.99, 0.99], 50, 12, { guard: 'fail' }), ...TABLE.slice(1),
    { ...row('E', 4, [0.9, 0.9, 0.9], 40, 12), complete: false }]
  const out = robust({ rows, scenarios: SCENARIOS, tolerance: { power: 0.02, relative: 0.1 }, confidence: 0.975, baseFeasible: ['A', 'B'] })
  assert.ok(!out.pareto.includes('A') && !out.nearOptimal.includes('A') && !out.acceptable.includes('A'))
  assert.equal(out.rows.find((r) => r.key === 'A').worstCase.value, 0.99, 'its numbers are still shown')
  assert.equal(out.rows.find((r) => r.key === 'E').worstCase, null)
  assert.equal(out.cheapestUnderBase, 'B', 'A is feasible under the base case on its own constraints but never competes')
  assert.equal(out.bestIn.base, 'C', 'the ineligible A is not the best of its scenario')
})

test('a design whose power is undecided in a scenario is inconclusive, never acceptable', () => {
  const rows = TABLE.map((r) => (r.key === 'C' ? { ...r, scenarios: { ...r.scenarios, pessimistic: { power: power(0.81, 'inconclusive') } } } : r))
  const out = robust({ rows, scenarios: SCENARIOS, tolerance: { power: 0.02, relative: 0.1 }, confidence: 0.975, baseFeasible: ['C'] })
  assert.equal(out.rows.find((r) => r.key === 'C').acceptable, 'inconclusive')
  assert.deepEqual(out.inconclusive, ['C'])
  assert.equal(out.cheapestAcceptable, 'D', 'only D is decided in every scenario')
})

test('a dimension some design has no number for is left out of both sets rather than counted as zero', () => {
  const out = choose({ rows: TABLE.map((r) => (r.key === 'B' ? { ...r, duration: null } : r)) })
  assert.deepEqual(out.criteria.map((/** @type {any} */ c) => c.name), ['n', 'worst_case_power'])
})

// ---------------------------------------------------------------------------
// The manifest: scenarios with a world and a weight, and the campaign that evaluates every design in every one
// ---------------------------------------------------------------------------
const BASE = {
  design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 12, followup: 12, dropoutAnnual: 0.05 },
  analysis: { method: 'logrank', alpha: 0.025, sided: 1 },
}
const truth = (/** @type {number} */ hazardRatio) => ({ hazardRatio, controlMedian: 12 })
const manifestOf = (/** @type {any} */ over = {}, /** @type {any} */ truths = null) => ({
  question: 'Smallest two-arm trial that holds up across effect assumptions',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'base' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'base' }, { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }],
  space: { method: 'design.simulate', scenario: BASE,
    truths: truths ?? [{ name: 'optimistic', truth: truth(0.6) }, { name: 'base', truth: truth(0.7) }, { name: 'pessimistic', truth: truth(0.8) }, { name: 'null', truth: truth(1) }],
    variables: [{ path: 'design.nTreat', values: [80, 160, 320] }, { path: 'design.nControl', values: [80, 160, 320] }] },
  stages: { screening: { replicates: 500 }, final: { count: 3 } }, budget: { maxCandidates: 9, cpuSeconds: 36000, modelCalls: 0 },
  ...over,
})
/** @typedef {{ issues: any[], manifest: any, [key: string]: any }} Built */
const campaign = (/** @type {any} */ input) => /** @type {Built} */ (/** @type {any} */ (vcrCampaignManifest(input)))
const issuesOf = (/** @type {any} */ input) => campaign(input).issues.map((/** @type {any} */ issue) => issue.code)
const ID = 'b'.repeat(64)

test('two or more effect scenarios make the reading robust, with every default written into the frozen manifest', () => {
  const out = campaign(manifestOf())
  assert.deepEqual(out.issues, [])
  assert.deepEqual(out.manifest.robust, { measure: 'power', scenarios: ['optimistic', 'base', 'pessimistic'], floor: 0.8, confidence: 0.975, tolerance: { power: 0.02, relative: 0.1 }, cost: null })
  assert.deepEqual(out.manifest.stages.screening.truths, ['base', 'optimistic', 'pessimistic'], 'screening sees every compared scenario, not the null one')
  // one effect scenario (and the null) is the campaign it always was: no robust block, same bytes
  const single = campaign(manifestOf({}, [{ name: 'base', truth: truth(0.7) }, { name: 'null', truth: truth(1) }]))
  assert.deepEqual(single.issues, [])
  assert.equal(single.manifest.robust, undefined)
})

test('a scenario states a world and a weight; the world cannot move the evaluator or a searched path, and weights are all or none', () => {
  const world = (/** @type {any} */ w, extra = {}) => manifestOf({}, [{ name: 'optimistic', truth: truth(0.6) }, { name: 'base', truth: truth(0.7), world: w, ...extra }, { name: 'null', truth: truth(1) }])
  assert.deepEqual(issuesOf(world({ 'accrual.dropoutAnnual': 0.2, 'accrual.followup': 18 })), [])
  assert.ok(issuesOf(world({ 'analysis.alpha': 0.1 })).includes('campaign_value_frozen'))
  assert.ok(issuesOf(world({ endpoint: { type: 'binary' } })).includes('campaign_value_frozen'))
  assert.ok(issuesOf(world({ 'design.nTreat': 10 })).includes('campaign_world_clash'))
  assert.ok(issuesOf(world({})).includes('campaign_value_invalid'))
  assert.ok(issuesOf(world({ 'accrual.dropoutAnnual': 0.2 }, { weight: 2 })).includes('campaign_weights_incomplete'), 'a weight on one compared scenario only')
  assert.ok(issuesOf(world({}, { weight: -1 })).includes('campaign_value_invalid'))
  const weighted = campaign(manifestOf({}, [{ name: 'optimistic', truth: truth(0.6), weight: 1 }, { name: 'base', truth: truth(0.7), weight: 2 }, { name: 'null', truth: truth(1) }]))
  assert.deepEqual(weighted.issues, [])
  assert.deepEqual(weighted.manifest.space.truths.map((/** @type {any} */ t) => t.weight), [1, 2, undefined])
  // a weight with nothing to weigh against is refused rather than ignored
  assert.ok(issuesOf(manifestOf({}, [{ name: 'base', truth: truth(0.7), weight: 1 }, { name: 'null', truth: truth(1) }])).includes('campaign_weights_incomplete'))
})

test('a robust block names its scenarios, floor and tolerances, and refuses what cannot be compared', () => {
  const robust = (/** @type {any} */ r) => manifestOf({ robust: r })
  assert.deepEqual(issuesOf(robust({ scenarios: ['base', 'pessimistic'], floor: 0.9, tolerance: { power: 0.05, relative: 0.2 } })), [])
  assert.ok(issuesOf(robust({ scenarios: ['base'] })).includes('campaign_robust_scenarios'))
  assert.ok(issuesOf(robust({ scenarios: ['base', 'null'] })).includes('campaign_robust_scenarios'), 'the null scenario has no power to compare')
  assert.ok(issuesOf(robust({ floor: 1.2 })).includes('campaign_value_invalid'))
  assert.ok(issuesOf(robust({ tolerance: { relative: 0.9 } })).includes('campaign_value_invalid'))
  assert.ok(issuesOf(robust({ cost: 'power' })).includes('campaign_value_invalid'))
  // a dose-finding design measures no power: asking for the robust reading of it is refused by name
  const dose = { ...manifestOf(), objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'base' }, constraints: [],
    space: { method: 'design.dose', scenario: { design: { kind: 'bayesian' } }, truths: [{ name: 'base', truth: { a: 1 } }], variables: [{ path: 'design.n', values: [20, 30] }] }, robust: {} }
  assert.ok(issuesOf(dose).includes('campaign_robust_unsupported'))
})

test('the floor defaults to the base-case power constraint, and a stated floor stands', () => {
  assert.equal(campaign(manifestOf({ constraints: [{ measure: 'power', op: '>=', bound: 0.9, kind: 'design', truth: 'base' }, { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }] })).manifest.robust.floor, 0.9)
  assert.equal(campaign(manifestOf({ robust: { floor: 0.85 } })).manifest.robust.floor, 0.85)
})

test('every design runs in every scenario on one stream: the scenarios differ by what is assumed, never by luck', () => {
  const manifest = campaign(manifestOf()).manifest
  const candidate = vcrCampaignCandidates(manifest)[4]
  const seeds = ['optimistic', 'base', 'pessimistic', 'null'].map((name) => vcrCampaignUnit(manifest, ID, candidate, 'final', name).seed)
  assert.equal(new Set(seeds).size, 1)
  assert.notEqual(vcrCampaignUnit(manifest, ID, candidate, 'screening', 'base').seed, seeds[0], 'screening and final stay apart')
  assert.notEqual(vcrCampaignUnit(manifest, ID, vcrCampaignCandidates(manifest)[1], 'final', 'base').seed, seeds[0], 'a different design with different draws has its own stream')
  // without a robust reading the truths keep their own streams, as before
  const plain = campaign(manifestOf({}, [{ name: 'base', truth: truth(0.7) }, { name: 'null', truth: truth(1) }])).manifest
  assert.notEqual(vcrCampaignUnit(plain, ID, candidate, 'final', 'base').seed, vcrCampaignUnit(plain, ID, candidate, 'final', 'null').seed)
})

test('a scenario\'s world is applied to the scenario its unit runs, and only to that scenario', () => {
  const input = manifestOf({}, [{ name: 'optimistic', truth: truth(0.6) }, { name: 'base', truth: truth(0.7), world: { 'accrual.dropoutAnnual': 0.25 } }, { name: 'null', truth: truth(1) }])
  const manifest = campaign(input).manifest
  const candidate = vcrCampaignCandidates(manifest)[0]
  const base = vcrCandidateScenario(manifest, candidate, 'base', 'final')
  assert.equal(base.accrual.dropoutAnnual, 0.25)
  assert.deepEqual(base.truth, truth(0.7), 'the truth block is the scenario\'s own, so the world cannot half-state it')
  assert.equal(vcrCandidateScenario(manifest, candidate, 'optimistic', 'final').accrual.dropoutAnnual, 0.05)
})

// ---------------------------------------------------------------------------
// A campaign driven to its stop with a fake engine: the finalists are evaluated in every scenario and the verdict carries the robust reading
// ---------------------------------------------------------------------------
/** power by design size and the scenario's hazard ratio; the null scenario has the type I error of the test */
function engine(/** @type {any} */ unit) {
  const n = unit.scenario.design.nTreat + unit.scenario.design.nControl
  const hr = unit.scenario.truth.hazardRatio
  const reps = unit.stage === 'screening' ? 500 : 20000
  const p = hr === 1 ? 0.02 : Math.min(0.999, 1 - Math.exp(-n * (1 - hr) ** 2 / 4))
  const k = Math.round(p * reps) / reps
  const extra = unit.stage === 'screening' ? { precision: 'screening' } : {}
  return { jobId: `job_${unit.key}`, state: 'succeeded', replicates: reps, seed: unit.seed, drawSignature: `draws:${unit.candidate}`, cpuSeconds: 1, queueSeconds: 0, wallSeconds: 1,
    measures: [{ name: hr === 1 ? 'type_one_error' : 'power', value: k, mcse: Math.sqrt(k * (1 - k) / reps), simulated: true, source: 'synthetic', ...extra },
      { name: 'expected_sample_size', value: n, mcse: 0, simulated: true, source: 'synthetic', ...extra }] }
}
function drive(/** @type {any} */ manifest) {
  let state = vcrCampaignInitialState(manifest)
  const units = []
  for (let i = 0; i < 300; i++) {
    const { state: next, action } = /** @type {any} */ (vcrCampaignAdvance(manifest, state, { identity: ID }))
    state = next
    if (action.type !== 'evaluate') return { state, action, units }
    units.push(action.unit)
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: action.unit.key } }, action.unit, engine(action.unit))
  }
  throw new Error('campaign did not stop')
}

test('a campaign evaluates its finalists in every scenario and ends with a robust reading, not one best design', () => {
  const manifest = campaign(manifestOf()).manifest
  const { state, action, units } = drive(manifest)
  assert.ok(['acceptable_precision', 'inconclusive_at_precision'].includes(action.reason), action.reason)
  const finals = units.filter((unit) => unit.stage === 'final')
  for (const key of state.finalists) assert.deepEqual(finals.filter((unit) => unit.candidate === key).map((unit) => unit.truth).sort(), ['base', 'null', 'optimistic', 'pessimistic'])
  const verdict = vcrCampaignVerdict(manifest, state)
  assert.ok(verdict.robust, 'the verdict carries the robust reading')
  const robust = verdict.robust
  assert.deepEqual(robust.scenarios.map((s) => s.name), ['optimistic', 'base', 'pessimistic'])
  assert.ok(robust.rows.length === state.finalists.length && robust.rows.every((r) => r.complete))
  const first = robust.rows[0]
  assert.deepEqual(Object.keys(first.oc).sort(), ['base', 'null', 'optimistic', 'pessimistic'], 'operating characteristics in every scenario evaluated, the null one included')
  assert.ok(first.oc.null.type_one_error && first.oc.base.power && first.oc.base.expected_sample_size)
  assert.ok(first.oc.base.power.mcse > 0, 'each number carries its MCSE')
  assert.ok(first.oc.base.exposure === undefined, 'exposure needs a duration the method measured')
  // the larger designs hold up in the pessimistic scenario; the cheapest under the base case need not
  assert.ok(robust.cheapestAcceptable === null || robust.acceptable.includes(robust.cheapestAcceptable))
  assert.equal(robust.measures.n, 'expected_sample_size')
  assert.ok(robust.maximin && robust.pareto.length >= 1 && robust.nearOptimal.length >= robust.pareto.length)
})

test('a campaign without a robust reading has no robust block', () => {
  const manifest = campaign(manifestOf({}, [{ name: 'base', truth: truth(0.7) }, { name: 'null', truth: truth(1) }])).manifest
  const { state } = drive(manifest)
  assert.equal(vcrCampaignVerdict(manifest, state).robust, null)
})

// ---------------------------------------------------------------------------
// The short form (what a conversation writes) states scenarios too
// ---------------------------------------------------------------------------
test('the short form states several effect scenarios and compiles to a robust manifest', async () => {
  const { vcrCampaignFromInput } = await import('../src/vcrExperimentSearch.mjs')
  const form = { question: '各效应假设下的最小样本量', method: 'design.simulate', scenario: BASE,
    scenarios: [{ name: 'optimistic', effect: { hazardRatio: 0.6 } }, { name: 'base' }, { name: 'pessimistic', effect: { hazardRatio: 0.8 }, world: { 'accrual.dropoutAnnual': 0.2 } }],
    vary: { 'design.nTreat+design.nControl': [[80, 80], [160, 160], [320, 320]] }, goal: { minimize: 'expected_sample_size' } }
  const out = /** @type {Built} */ (/** @type {any} */ (vcrCampaignFromInput(form)))
  assert.deepEqual(out.issues, [])
  const m = out.manifest
  assert.deepEqual(m.space.truths.map((/** @type {any} */ t) => t.name), ['optimistic', 'base', 'pessimistic', 'null'])
  assert.deepEqual(m.space.truths[1].truth, BASE.truth, 'a scenario without an effect is the base scenario\'s own')
  assert.deepEqual(m.space.truths[2].truth, { hazardRatio: 0.8, controlMedian: 12 }, 'an effect states only what differs')
  assert.deepEqual(m.space.truths[2].world, { 'accrual.dropoutAnnual': 0.2 })
  assert.equal(m.objective.truth, 'base')
  assert.deepEqual(m.robust.scenarios, ['optimistic', 'base', 'pessimistic'])
  assert.equal(m.robust.floor, 0.8, 'the default power the form asks for')
  assert.ok(m.constraints.some((/** @type {any} */ c) => c.kind === 'error_control' && c.truth === 'null' && c.bound === 0.025), 'the type I error constraint is still the code\'s')
  // refusals are by name
  const issues = (/** @type {any} */ scenarios) => vcrCampaignFromInput({ ...form, scenarios }).issues.map((/** @type {any} */ issue) => issue.code)
  assert.ok(issues([{ name: 'base' }]).includes('search_form_scenarios'))
  assert.ok(issues([{ name: 'a', effect: { hazardRatio: 0.6 } }, { name: 'b', effect: { hazardRatio: 0.8 } }]).includes('search_form_scenarios'), 'one is named base')
  assert.ok(issues([{ name: 'base' }, { name: 'a', extra: 1 }]).includes('search_form_field_unknown'))
})
