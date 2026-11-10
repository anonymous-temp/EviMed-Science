// Round-2 plan R36 / stream D6: the screening share of a budgeted campaign allocated by OCBA-CO instead of equally. Screening only ranks and
// eliminates, so the allocation may not touch a verdict: the S3 state-machine test (each look read at the split confidence) holds here too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vcrCampaignManifest, vcrCampaignCanonical, vcrCampaignCandidates, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord,
  vcrCampaignVerdict, vcrCampaignBudgetPlan, VCR_ALLOCATION,
} from '../src/vcrExperimentSearch.mjs'

const BASE = { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 24, followup: 12 }, analysis: { method: 'logrank', alpha: 0.025, sided: 1 } }
// twelve designs by patients: the cheap ones are underpowered, 700..1100 are powered but their type I error is above the bound, the last three pass
const WORLD = Array.from({ length: 12 }, (_, i) => ({ n: 100 + 100 * i, power: Math.min(0.97, 0.5 + 0.05 * i), typeOne: i >= 5 && i < 9 ? 0.0285 : 0.021 }))
const input = (/** @type {any} */ budget = {}, /** @type {any} */ world = WORLD) => ({
  question: 'q', objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }, { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }],
  space: { method: 'design.simulate', scenario: BASE, truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
    candidates: world.map((/** @type {any} */ w) => ({ set: { 'design.nTreat': w.n / 2, 'design.nControl': w.n / 2 } })) },
  stages: { screening: { replicates: 300, truths: ['alternative', 'null'] }, final: { count: 1 } },
  budget: { maxCandidates: world.length, cpuSeconds: 600_000, modelCalls: 0, replicates: 400_000, screening: 'ocba', ...budget },
})
const frozen = (/** @type {any} */ budget = {}, /** @type {any} */ world = WORLD) => { const out = vcrCampaignManifest(input(budget, world)); assert.deepEqual(out.issues, []); return /** @type {Record<string, any>} */ (out.manifest) }

const mulberry32 = (/** @type {number} */ seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const binomial = (/** @type {number} */ n, /** @type {number} */ p, /** @type {() => number} */ rng) => { const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng()); return Math.max(0, Math.min(n, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * z))) }

function drive(/** @type {Record<string, any>} */ manifest, /** @type {number} */ worldSeed, world = WORLD) {
  const identity = worldSeed.toString(16).padStart(8, '0').repeat(8)
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
    const replicates = screening ? (unit.screeningReplicates ?? manifest.stages.screening.replicates) : (unit.replicates ?? (alt ? 5_000 : 20_000))
    const p = binomial(replicates, alt ? c.power : c.typeOne, mulberry32((worldSeed * 1_000_003 + unit.seed) >>> 0)) / replicates
    const measures = [{ name: 'expected_sample_size', value: c.n, mcse: 0, simulated: true, ...(screening ? { precision: 'screening' } : {}) },
      { name: alt ? 'power' : 'type_one_error', value: p, mcse: Math.sqrt(p * (1 - p) / replicates), simulated: true, ...(screening ? { precision: 'screening' } : {}) }]
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, /** @type {any} */ (unit),
      { jobId: `j_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates, precision: screening ? 'screening' : 'final', measures, cpuSeconds: replicates * 0.001 })
  }
  return { state, units, candidates }
}

test('the OCBA screening is opt-in: without it a manifest keeps its bytes, and it is refused outside a budgeted campaign', () => {
  const plain = vcrCampaignManifest(input({ screening: undefined })).manifest
  assert.equal(Object.hasOwn(/** @type {any} */ (plain).budget, 'screening'), false)
  assert.notEqual(vcrCampaignCanonical(/** @type {any} */ (plain)), vcrCampaignCanonical(frozen()))
  const unbudgeted = vcrCampaignManifest(input({ replicates: undefined }))
  assert.ok(unbudgeted.issues.some((issue) => issue.code === 'campaign_budget_invalid' && issue.field === 'budget.screening'))
  assert.ok(vcrCampaignManifest(input({ screening: 'thompson' })).issues.some((issue) => issue.field === 'budget.screening'))
})

test('the plan keeps the first look to a share of the screening share, split over the cells', () => {
  const equal = vcrCampaignBudgetPlan({ candidates: 12, replicates: 400_000 })
  const ocba = vcrCampaignBudgetPlan({ candidates: 12, replicates: 400_000, screening: 'ocba', cells: 2 })
  assert.equal(equal.screeningReplicates, 4_999)
  assert.equal(ocba.screeningReplicates, Math.floor(VCR_ALLOCATION.ocba.firstShare * VCR_ALLOCATION.screeningShare * 400_000 / 12 / 2 / 100) * 100)
})

test('screening increments go to the designs that decide the pick, within the screening share, each on a stream of its own', () => {
  const manifest = frozen()
  const { state, units, candidates } = drive(manifest, 7)
  const screening = units.filter((u) => u.stage === 'screening')
  const increments = screening.filter((u) => u.round > 0)
  assert.ok(increments.length >= 3, `the rule allocated ${increments.length} increments`)
  assert.equal(new Set(units.map((u) => u.key)).size, units.length, 'every unit has its own key')
  assert.equal(new Set(units.map((u) => u.seed)).size, units.length, 'and its own stream')
  for (const u of increments) {
    assert.ok(u.screeningReplicates >= 200 && u.screeningReplicates < 5_000, 'a screening run stays between the minimum and the final floor')
    assert.equal(u.scenario.evaluation.screeningReplicates, u.screeningReplicates)
  }
  const screeningSpent = screening.reduce((sum, u) => sum + (u.screeningReplicates ?? manifest.stages.screening.replicates), 0)
  assert.ok(screeningSpent <= VCR_ALLOCATION.screeningShare * 400_000, `screening spent ${screeningSpent}`)
  // designs worse than the cheapest one the first look called feasible need nothing more (their objective is exact)
  const first = screening.filter((u) => !u.round)
  assert.equal(first.filter((u) => u.truth === 'alternative').length, 12, 'every design is looked at once on its power')
  assert.ok(first.some((u) => u.truth === 'null'), 'and the survivors on their type I error (a design the first look eliminated is not looked at again)')
  const byCandidate = new Map()
  for (const u of increments) byCandidate.set(u.candidate, (byCandidate.get(u.candidate) ?? 0) + 1)
  const expensive = candidates.slice(9).map((c) => byCandidate.get(c.key) ?? 0)
  const cheap = candidates.slice(0, 9).map((c) => byCandidate.get(c.key) ?? 0)
  assert.ok(Math.max(...cheap) > Math.max(...expensive), 'the increments went to the cheaper designs')
  // pooled: a design's screening estimate carries every increment it got
  const pooled = state.candidates[candidates[0].key]
  const own = increments.filter((u) => u.candidate === candidates[0].key && u.truth === 'alternative').reduce((s, u) => s + u.screeningReplicates, 0)
  assert.equal(pooled.evaluations['screening:alternative'].replicates === undefined ? 0 : pooled.evaluations['screening:alternative'].replicates, manifest.stages.screening.replicates + own)
  assert.equal(state.usage.replicatesCompleted, units.reduce((s, u) => s + (u.stage === 'screening' ? (u.screeningReplicates ?? manifest.stages.screening.replicates) : (u.replicates ?? (u.truth === 'alternative' ? 5_000 : 20_000))), 0))
  assert.ok(state.usage.replicatesCompleted <= 400_000)
})

test('the verdict is the same rule: a final run alone at the split confidence; the campaign still finds a passing design', () => {
  const manifest = frozen()
  const { state, candidates } = drive(manifest, 11)
  const verdict = vcrCampaignVerdict(manifest, state)
  assert.ok(verdict.best, `stop ${state.stop.reason}`)
  assert.ok(['c009', 'c010', 'c011'].includes(verdict.best), `picked ${verdict.best}`)
  for (const key of state.finalists) assert.ok(state.candidates[key].evaluations['final:alternative'].replicates >= 5_000, 'a final evaluation is at the floor or more')
  void candidates
})

test('error control is untouched: a design exactly on its type I error bound is certified at no more than the nominal rate under OCBA screening', () => {
  const ONE = [{ n: 200, power: 0.95, typeOne: 0.025 }]
  const manifest = frozen({ replicates: 2_000_000 }, ONE)
  const N = 1500
  let hits = 0
  for (let s = 1; s <= N; s++) {
    const { state } = drive(manifest, s, ONE)
    if (vcrCampaignVerdict(manifest, state).best) hits += 1
  }
  const rate = hits / N; const mcse = Math.sqrt(0.025 * 0.975 / N)
  assert.ok(rate <= 0.025 + 2 * mcse, `certified ${rate} of ${N} campaigns for a design exactly on its bound (nominal 0.025)`)
})
