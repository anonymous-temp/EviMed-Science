// Review S3: re-running an undecided design on fresh data gave it up to three looks and certified a design exactly on its bound 3.3% of the time
// (2.4% with one look) at a 97.5% confidence. The state machine is driven with binomial outcomes of one design whose true value sits ON its bound.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vcrCampaignManifest, vcrCampaignCandidates, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord, vcrCampaignVerdict } from '../src/vcrExperimentSearch.mjs'

const BASE = { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 24, followup: 12 }, analysis: { method: 'logrank', alpha: 0.025, sided: 1 } }
const manifestOf = (/** @type {number | null} */ budget) => {
  const out = vcrCampaignManifest({ question: 'q', objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
    constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }, { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }],
    space: { method: 'design.simulate', scenario: BASE, truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
      candidates: [{ set: { 'design.nTreat': 100, 'design.nControl': 100 } }] },
    stages: { screening: { replicates: 500 }, final: { count: 1 } }, budget: { maxCandidates: 1, cpuSeconds: 600_000, modelCalls: 0, ...(budget ? { replicates: budget } : {}) } })
  assert.deepEqual(out.issues, [])
  return /** @type {Record<string, any>} */ (out.manifest)
}
const mulberry32 = (/** @type {number} */ seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const binom = (/** @type {number} */ n, /** @type {number} */ p, /** @type {() => number} */ rng) => { const z = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng()); return Math.max(0, Math.min(n, Math.round(n * p + z * Math.sqrt(n * p * (1 - p))))) }

/** One campaign of one design with the true power and type I error given: whether it was named. */
function certified(/** @type {Record<string, any>} */ manifest, /** @type {number} */ typeOne, /** @type {number} */ power, /** @type {number} */ worldSeed) {
  const identity = worldSeed.toString(16).padStart(8, '0').repeat(8)
  let state = vcrCampaignInitialState(manifest)
  for (let step = 0; step < 200; step++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity })
    state = next
    if (action.type !== 'evaluate') break
    const unit = /** @type {Record<string, any>} */ (action.unit)
    const screening = unit.stage === 'screening'; const alt = unit.truth === 'alternative'
    const replicates = screening ? manifest.stages.screening.replicates : (unit.replicates ?? (alt ? 5000 : 20000))
    const p = binom(replicates, alt ? power : typeOne, mulberry32((worldSeed * 1000003 + unit.seed) >>> 0)) / replicates
    const measures = [{ name: 'expected_sample_size', value: 200, mcse: 0, simulated: true, ...(screening ? { precision: 'screening' } : {}) },
      { name: alt ? 'power' : 'type_one_error', value: p, mcse: Math.sqrt(p * (1 - p) / replicates), simulated: true, ...(screening ? { precision: 'screening' } : {}) }]
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `j${unit.key}`, state: 'succeeded', seed: unit.seed, replicates, precision: screening ? 'screening' : 'final', measures, cpuSeconds: 0 })
  }
  void vcrCampaignCandidates
  return Boolean(vcrCampaignVerdict(manifest, state).best)
}

test('a design exactly on its type I error bound is certified at no more than the nominal rate, with re-runs allowed', () => {
  const N = 6000
  const budgeted = manifestOf(2_000_000)
  let hits = 0
  for (let s = 1; s <= N; s++) if (certified(budgeted, 0.025, 0.95, s)) hits += 1
  const rate = hits / N; const mcse = Math.sqrt(0.025 * 0.975 / N)
  // one look at 97.5% gives about 2.4%; three looks at 97.5% each gave 3.3%; the error split across the looks must not exceed 2.5%
  assert.ok(rate <= 0.025 + 2 * mcse, `certified ${rate} of ${N} campaigns for a design exactly on its bound (nominal 0.025)`)
})

test('a design exactly on its power bound is not certified more often than the nominal rate either', () => {
  const N = 6000
  const budgeted = manifestOf(2_000_000)
  let hits = 0
  for (let s = 1; s <= N; s++) if (certified(budgeted, 0.02, 0.80, s)) hits += 1
  const rate = hits / N; const mcse = Math.sqrt(0.025 * 0.975 / N)
  assert.ok(rate <= 0.025 + 2 * mcse, `certified ${rate} of ${N} campaigns for a design exactly on its power bound (nominal 0.025)`)
})
