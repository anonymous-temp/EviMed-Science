// R36 root fix: a campaign given a replicate budget spends it by a sequential allocation and keeps every error-control rule.
// The campaign is driven by its own state machine; a unit's outcome is a binomial draw from a small known world.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vcrCampaignManifest, vcrCampaignCanonical, vcrCampaignCandidates, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord,
  vcrCampaignVerdict, vcrCampaignBudgetPlan, VCR_ALLOCATION, vcrClopperPearson, vcrSearchFromForm,
} from '../src/vcrExperimentSearch.mjs'

const BASE = {
  design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 24, followup: 12 },
  analysis: { method: 'logrank', alpha: 0.025, sided: 1 },
}
// design i: patients, true power, true type I error (the 25,000 trials of a full evaluation: 5,000 alternative + 20,000 null)
const WORLD = [
  { n: 100, power: 0.55, typeOne: 0.024 }, { n: 125, power: 0.66, typeOne: 0.024 }, { n: 150, power: 0.74, typeOne: 0.025 },
  { n: 175, power: 0.835, typeOne: 0.0215 }, { n: 200, power: 0.88, typeOne: 0.0212 }, { n: 225, power: 0.92, typeOne: 0.022 },
  { n: 250, power: 0.95, typeOne: 0.0215 }, { n: 275, power: 0.97, typeOne: 0.021 },
]
// twelve designs: the cheap ones look alike at screening and fail only on their type I error (or, at the floor, on power); one at the end passes
const HARD = Array.from({ length: 12 }, (_, i) => ({ n: 100 + 25 * i, power: i === 2 || i === 5 ? 0.77 : i < 10 ? 0.86 : 0.9, typeOne: i < 10 ? (i === 2 || i === 5 ? 0.02 : 0.0275) : 0.0212 }))
const manifestInput = (/** @type {any} */ budget = {}, /** @type {any} */ stages = {}, world = WORLD) => ({
  question: 'Fewest patients with power at least 0.8 and type I error held at 2.5%',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [
    { measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' },
  ],
  space: { method: 'design.simulate', scenario: BASE,
    truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
    candidates: world.map((w) => ({ set: { 'design.nTreat': w.n / 2, 'design.nControl': w.n / 2 } })) },
  stages: { screening: { replicates: 500 }, final: { count: 1 }, ...stages },
  budget: { maxCandidates: world.length, cpuSeconds: 600_000, modelCalls: 0, ...budget },
})
const frozen = (/** @type {any} */ budget = undefined, /** @type {any} */ stages = undefined, world = WORLD) => { const out = vcrCampaignManifest(manifestInput(budget, stages, world)); assert.deepEqual(out.issues, []); return /** @type {Record<string, any>} */ (out.manifest) }

function mulberry32(/** @type {number} */ seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const binomial = (/** @type {number} */ n, /** @type {number} */ p, /** @type {() => number} */ rng) => { let k = 0; for (let i = 0; i < n; i++) if (rng() < p) k += 1; return k }

/** Drive a campaign to its stop; `units` is every unit the machine asked for, in order. */
function drive(/** @type {Record<string, any>} */ manifest, /** @type {number} */ worldSeed, world = WORLD, secondsPer = (/** @type {number} */ _n) => 0.001) {
  const identity = 'b'.repeat(64)
  const candidates = vcrCampaignCandidates(manifest)
  let state = vcrCampaignInitialState(manifest)
  const units = []
  for (let step = 0; step < 5_000; step += 1) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity })
    state = next
    if (action.type !== 'evaluate') break
    const unit = /** @type {Record<string, any>} */ (action.unit)
    units.push(unit)
    const c = world[candidates.findIndex((x) => x.key === unit.candidate)]
    const screening = unit.stage === 'screening'
    const alt = unit.truth === 'alternative'
    const replicates = screening ? manifest.stages.screening.replicates : (unit.replicates ?? (alt ? 5_000 : 20_000))
    const rng = mulberry32(worldSeed * 1_000_003 + unit.seed)
    const k = binomial(replicates, alt ? c.power : c.typeOne, rng)
    const p = k / replicates
    const measures = [{ name: 'expected_sample_size', value: c.n, mcse: 0, simulated: true, ...(screening ? { precision: 'screening' } : {}) },
      alt ? { name: 'power', value: p, mcse: Math.sqrt(p * (1 - p) / replicates), simulated: true, ...(screening ? { precision: 'screening' } : {}) }
        : { name: 'type_one_error', value: p, mcse: Math.sqrt(p * (1 - p) / replicates), simulated: true }]
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, /** @type {any} */ (unit),
      { jobId: `j_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates, precision: screening ? 'screening' : 'final', measures, cpuSeconds: replicates * secondsPer(units.length) })
  }
  return { state, units, candidates }
}

test('a manifest without a replicate budget is what it was: same bytes, same fixed stages', () => {
  const plain = frozen()
  assert.equal(Object.hasOwn(plain.budget, 'replicates'), false)
  assert.equal(vcrCampaignCanonical(plain), vcrCampaignCanonical(frozen({ replicates: undefined })))
  assert.notEqual(vcrCampaignCanonical(plain), vcrCampaignCanonical(frozen({ replicates: 200_000 })), 'a replicate budget is a different campaign')
  const { state } = drive(plain, 1)
  assert.equal(state.allocation, undefined, 'the fixed structure never writes an allocation')
})

test('a replicate budget is refused where it cannot mean anything', () => {
  const codes = (/** @type {any} */ input) => vcrCampaignManifest(input).issues.map((issue) => `${issue.code}@${issue.field}`)
  assert.ok(codes(manifestInput({ replicates: 0 })).includes('campaign_budget_invalid@budget.replicates'))
  assert.ok(codes(manifestInput({ replicates: 1.5 })).includes('campaign_budget_invalid@budget.replicates'))
  const noScreening = manifestInput({ replicates: 100_000 }); noScreening.stages = { final: { count: 1 } }
  assert.ok(codes(noScreening).includes('campaign_budget_invalid@budget.replicates'))
})

test('the campaign spends the budget it is given: no structural cap, and a stated reason when it stops short', () => {
  const plan = vcrCampaignBudgetPlan({ candidates: HARD.length, replicates: 600_000 })
  const manifest = frozen({ replicates: 600_000 }, { screening: { replicates: plan.screeningReplicates }, final: { count: plan.finalCount } }, HARD)
  const { state, units, candidates } = drive(manifest, 3, HARD)
  const spent = state.usage.replicatesCompleted
  assert.ok(spent <= 600_000, 'never over the budget')
  assert.equal(spent, units.reduce((sum, u) => sum + (u.stage === 'screening' ? plan.screeningReplicates : (u.replicates ?? (u.truth === 'alternative' ? 5_000 : 20_000))), 0))
  // the fixed structure could not spend more than five finalists and a screening below the floor, and it had no recourse when they all failed
  assert.ok(spent > 5 * 25_000 + HARD.length * 4_999, `it went on past what the fixed structure could spend (${spent})`)
  const verdict = vcrCampaignVerdict(manifest, state)
  assert.equal(verdict.best, candidates[10].key, 'it found the cheapest feasible design behind ten that failed')
  assert.equal(state.stop.reason, 'acceptable_precision')
  assert.equal(state.allocation.unspentReason, 'decided')
  assert.equal(state.allocation.spent, spent)
  assert.equal(state.allocation.unspent, 600_000 - spent)
})

test('a spent budget stops the campaign with its reason and the finished work stays', () => {
  const manifest = frozen({ replicates: 30_000 }, { screening: { replicates: 500 }, final: { count: 1 } })
  const { state } = drive(manifest, 5)
  assert.ok(state.usage.replicatesCompleted <= 30_000)
  assert.equal(state.stop.reason === 'budget_exhausted' || state.stop.reason === 'acceptable_precision' || state.stop.reason === 'no_feasible_beneficial_candidate' || state.stop.reason === 'inconclusive_at_precision', true)
  if (state.stop.reason === 'budget_exhausted') assert.equal(state.allocation.unspentReason, 'next_unit_does_not_fit')
  const evaluated = Object.values(state.candidates).filter((entry) => entry.status === 'evaluated' || entry.status === 'finalist')
  assert.ok(evaluated.length >= 1, 'the screening and the first final evaluation are not discarded')
})

test('no design is left without a reason', () => {
  for (const [budget, seed] of [[60_000, 1], [150_000, 2], [400_000, 3], [900_000, 4]]) {
    const { state } = drive(frozen({ replicates: budget }, { screening: { replicates: 500 }, final: { count: 1 } }), seed)
    for (const [key, entry] of Object.entries(state.candidates)) {
      if (['eliminated', 'unsupported', 'failed', 'evaluated'].includes(entry.status)) continue
      assert.ok(entry.reason, `${key} (${entry.status}) at ${budget} has a stated reason`)
      assert.match(entry.reason, /^(not_needed:cannot_beat_best|not_evaluated:budget|not_screened:budget)$/)
    }
    assert.deepEqual(state.allocation.unevaluated.sort(), Object.entries(state.candidates).filter(([, e]) => e.status === 'screened' || e.status === 'pending').map(([k]) => k).sort())
  }
})

test('the same seed gives the same campaign, byte for byte', () => {
  const manifest = frozen({ replicates: 300_000 }, { screening: { replicates: 500 }, final: { count: 1 } })
  const a = drive(manifest, 11); const b = drive(manifest, 11); const c = drive(manifest, 12)
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state))
  assert.deepEqual(a.units.map((u) => u.key), b.units.map((u) => u.key))
  assert.notEqual(JSON.stringify(a.state), JSON.stringify(c.state), 'another world seed is another run')
})

test('error control is as it was: every verdict reads one fresh final run at the floor or more, at the constraints\' confidence', () => {
  let escalations = 0
  for (let seed = 1; seed <= 12; seed += 1) {
    const manifest = frozen({ replicates: 500_000 }, { screening: { replicates: 500 }, final: { count: 1 } }, HARD)
    const { state, units } = drive(manifest, seed, HARD)
    const seeds = new Map()
    for (const u of units) {
      assert.equal(seeds.has(`${u.candidate}|${u.truth}|${u.seed}`), false, 'no run reuses a stream of its own design and truth')
      seeds.set(`${u.candidate}|${u.truth}|${u.seed}`, u)
    }
    for (const u of units.filter((x) => x.stage === 'final')) {
      const floor = u.truth === 'alternative' ? 5_000 : 20_000
      assert.ok((u.replicates ?? floor) >= floor, 'never below the floor')
      const screeningSeeds = units.filter((x) => x.stage === 'screening' && x.candidate === u.candidate).map((x) => x.seed)
      assert.equal(screeningSeeds.includes(u.seed), false, 'a final run uses no stream a screening unit used')
      if (u.round) escalations += 1
    }
    const verdict = vcrCampaignVerdict(manifest, state)
    for (const row of verdict.rows.filter((r) => r.feasible)) {
      for (const v of row.verdicts) {
        assert.equal(v.final, true)
        assert.equal(v.bound.kind, 'clopper_pearson')
        const confidence = v.bound.confidence
        const cp = vcrClopperPearson(v.bound.events, v.bound.trials, confidence)
        assert.ok(v.op === '>=' ? cp.lower >= v.bound.lower - 1e-12 && v.bound.lower >= manifest.constraints[v.index].bound : v.bound.upper <= manifest.constraints[v.index].bound, 'a pass is the bound passing, never the point estimate')
      }
    }
    // a feasible design was never passed on pooled runs: a re-run replaces the run it follows
    for (const entry of Object.values(state.candidates)) {
      for (const old of entry.superseded ?? []) assert.ok(entry.evaluations[`final:${old.truth}`].seed !== old.seed)
    }
  }
  assert.ok(escalations >= 1, 'the sample of worlds includes a design that was undecided and was re-run')
})

test('a design that already fails its power constraint is not run on its error-control truth', () => {
  const { state, units } = drive(frozen({ replicates: 400_000 }, { screening: { replicates: 500 }, final: { count: 1 } }, HARD), 7, HARD)
  for (const [key, entry] of Object.entries(state.candidates)) {
    if (!String(entry.reason ?? '').startsWith('final_failed:')) continue
    const kinds = units.filter((u) => u.candidate === key && u.stage === 'final').map((u) => u.truth)
    assert.deepEqual(kinds, ['alternative'], `${key} stopped after the constraint that failed`)
  }
  assert.ok(Object.values(state.candidates).some((entry) => String(entry.reason ?? '').startsWith('final_failed:')), 'the sample has a design that failed early')
})

test('the screening rule of the plan is stated and bounded', () => {
  assert.deepEqual(vcrCampaignBudgetPlan({ candidates: 12, replicates: 40_000 }), { screeningReplicates: 600, finalCount: VCR_ALLOCATION.firstWave })
  assert.equal(vcrCampaignBudgetPlan({ candidates: 12, replicates: 10_000_000 }).screeningReplicates, 4_999, 'screening stays below the floor')
  assert.equal(vcrCampaignBudgetPlan({ candidates: 200, replicates: 40_000 }).screeningReplicates, 200, 'and never below its minimum')
})

const sequential = (/** @type {number} */ cpuSeconds, /** @type {any} */ world = HARD) =>
  frozen({ allocation: 'sequential', cpuSeconds }, { screening: { replicates: 500 }, final: { count: 1 } }, world)

test('a sequential campaign derives its replicate budget from the CPU seconds it measures', () => {
  const manifest = sequential(200) // 200 CPU seconds at 0.002 s a replicate is 100,000 replicates, whatever the engine's speed was guessed to be
  assert.equal(Object.hasOwn(manifest.budget, 'replicates'), false)
  const { state } = drive(manifest, 3, HARD, () => 0.002)
  assert.equal(state.rate.perReplicate, 0.002)
  assert.equal(state.allocation.derived.replicates, 100_000)
  assert.equal(state.allocation.derived.perReplicateCpuSeconds, 0.002)
  assert.equal(state.allocation.budget, 100_000)
  assert.ok(state.usage.replicatesCompleted <= 100_000)
  assert.equal(state.allocation.unspent, 100_000 - state.usage.replicatesCompleted)
  // the same seconds on an engine twice as fast buy twice the replicates
  const fast = drive(sequential(200), 3, HARD, () => 0.001).state
  assert.equal(fast.allocation.derived.replicates, 200_000)
  assert.ok(fast.usage.replicatesCompleted >= state.usage.replicatesCompleted)
})

test('a rate that changes mid-campaign re-derives the budget, and the CPU seconds are never exceeded', () => {
  for (const [cpu, seed] of [[60, 1], [120, 2], [250, 3]]) {
    // the screening units are cheap per replicate and the final runs cost four times as much
    const manifest = sequential(cpu)
    const { state } = drive(manifest, seed, HARD, (units) => (units <= 12 ? 0.001 : 0.004))
    assert.ok(state.usage.cpuSeconds <= cpu + 1e-9, `${cpu} CPU seconds: used ${state.usage.cpuSeconds}`)
    assert.equal(state.rate.perReplicate, 0.004)
    assert.equal(state.rate.history.length, 1)
    assert.equal(state.rate.history[0].from, 0.001)
    assert.equal(state.allocation.derived.replicates, Math.floor(cpu / 0.004))
    assert.equal(state.allocation.derived.rateChanges, 1)
  }
})

test('a stored manifest without the allocation field keeps its bytes, its fixed stages and an unchanged state', () => {
  const stored = frozen()
  assert.equal(Object.hasOwn(stored.budget, 'allocation'), false)
  assert.equal(vcrCampaignCanonical(stored), vcrCampaignCanonical(frozen({ allocation: undefined })))
  assert.notEqual(vcrCampaignCanonical(stored), vcrCampaignCanonical(sequential(600_000, WORLD)))
  const { state } = drive(stored, 2, WORLD, () => 0.002)
  assert.equal(state.rate, undefined)
  assert.equal(state.allocation, undefined)
})

test('the short form, and so every hosted default, asks for the sequential allocation; a form that cannot have it is left out of it', () => {
  const form = { question: 'fewest patients', method: 'design.simulate', scenario: BASE, vary: { 'design.nTreat': [100, 150, 200] },
    goal: { minimize: 'expected_sample_size', power: 0.8 } }
  const compiled = vcrSearchFromForm(form)
  assert.deepEqual(compiled.issues, [])
  assert.equal(/** @type {any} */ (compiled.input).budget.allocation, 'sequential')
  assert.equal(vcrCampaignManifest(compiled.input).manifest?.budget.allocation, 'sequential')
  // refused field values are named, not read as something else
  assert.ok(vcrCampaignManifest({ ...manifestInput(), budget: { ...manifestInput().budget, allocation: 'greedy' } }).issues.some((i) => i.field === 'budget.allocation'))
})
