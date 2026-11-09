import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vcrCampaignManifest, vcrCampaignCanonical, vcrCampaignCandidates, vcrCampaignUnit, vcrCampaignInitialState, vcrCampaignAdvance,
  vcrCampaignRecord, vcrCampaignVerdict, vcrJudgeConstraint, vcrClopperPearson, vcrEvaluationContrast, vcrCampaignDrawKey,
  vcrNominalErrorControl, VCR_CAMPAIGN_STOP_REASONS,
} from '../src/vcrExperimentSearch.mjs'
import { canonicalScenarioJson, validateEngineJob, VCR_ENGINE_METHODS } from '../src/vcrEngineJob.mjs'

const BASE = {
  design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 12, followup: 12 },
  analysis: { method: 'logrank', alpha: 0.025, sided: 1 },
}
const manifestOf = (/** @type {any} */ over = {}) => ({
  question: 'Smallest two-arm trial with power at least 0.8',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [
    { measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' },
  ],
  space: { method: 'design.simulate', scenario: BASE,
    truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
    variables: [{ path: 'design.nTreat', values: [80, 120, 160] }, { path: 'design.nControl', values: [80, 120, 160] }] },
  stages: { screening: { replicates: 500 }, final: { count: 2 } },
  budget: { maxCandidates: 9, cpuSeconds: 3600, modelCalls: 0 },
  ...over,
})
const frozen = (/** @type {any} */ over = {}) => { const out = vcrCampaignManifest(manifestOf(over)); assert.deepEqual(out.issues, []); return /** @type {Record<string, any>} */ (out.manifest) }
const ID = 'a'.repeat(64)

test('a manifest freezes only known fields and its canonical bytes ignore key order', () => {
  const a = frozen()
  const reordered = vcrCampaignManifest(JSON.parse(JSON.stringify({ budget: manifestOf().budget, stages: manifestOf().stages, space: manifestOf().space,
    constraints: manifestOf().constraints, objective: manifestOf().objective, question: manifestOf().question, extra: 'dropped' })))
  assert.equal(vcrCampaignCanonical(a), vcrCampaignCanonical(/** @type {any} */ (reordered.manifest)))
  const stricter = frozen({ constraints: [{ measure: 'power', op: '>=', bound: 0.85, kind: 'design', truth: 'alternative' }] })
  assert.notEqual(vcrCampaignCanonical(a), vcrCampaignCanonical(stricter), 'a changed constraint is a new campaign')
  assert.equal(a.space.version, VCR_ENGINE_METHODS['design.simulate'].version)
})

test('the evaluator cannot be searched or relaxed', () => {
  const codes = (/** @type {any} */ over) => vcrCampaignManifest(manifestOf(over)).issues.map((issue) => `${issue.code}@${issue.field}`)
  assert.ok(codes({ space: { ...manifestOf().space, variables: [{ path: 'truth.hazardRatio', values: [0.6, 0.7] }] } }).includes('campaign_value_frozen@space.variables[0].path'))
  // the analysis level may be searched downward only (F4): a level above the frozen constraint is a relaxation, not a candidate
  assert.ok(codes({ space: { ...manifestOf().space, variables: [{ path: 'analysis.alpha', values: [0.025, 0.05] }] } }).includes('campaign_alpha_relaxed@space.variables[0].values'))
  assert.ok(codes({ space: { ...manifestOf().space, variables: [{ path: 'analysis.sided', values: [1, 2] }] } }).includes('campaign_value_frozen@space.variables[0].path'))
  assert.ok(codes({ space: { ...manifestOf().space, variables: [{ path: 'endpoint.type', values: ['binary'] }] } }).includes('campaign_value_frozen@space.variables[0].path'))
  assert.ok(codes({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.05, kind: 'error_control', truth: 'null' }] }).includes('campaign_alpha_relaxed@constraints[0].bound'))
})

test('a misspecified evaluator is refused before anything runs', () => {
  const codes = (/** @type {any} */ over) => vcrCampaignManifest(manifestOf(over)).issues.map((issue) => `${issue.code}@${issue.field}`)
  // a measure the method never produces
  assert.ok(codes({ objective: { measure: 'win_ratio', direction: 'maximize', truth: 'alternative' } }).includes('campaign_measure_unknown@objective.measure'))
  // a type I error constraint judged under a truth with an effect would read power
  assert.ok(codes({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'alternative' }] })
    .includes('campaign_error_control_truth@constraints[0].truth'))
  // error control on a measure that is not an error rate
  assert.ok(codes({ constraints: [{ measure: 'power', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }] }).includes('campaign_error_control_measure@constraints[0].measure'))
})

test('dose finding is judged by toxicity and selection, never by a superiority alpha', () => {
  const dose = {
    objective: { measure: 'correct_dose_probability', direction: 'maximize', truth: 'curve' },
    constraints: [{ measure: 'patients_above_mtd', op: '<=', bound: 6, kind: 'safety', truth: 'curve' }],
    space: { method: 'design.dose', scenario: { design: { kind: 'boin', targetToxicity: 0.3, cohortSize: 3, maxPatients: 30 }, truth: { toxicity: [0.05, 0.12, 0.3, 0.45] } },
      truths: [{ name: 'curve', truth: { toxicity: [0.05, 0.12, 0.3, 0.45] } }],
      variables: [{ path: 'design.kind', values: ['boin', 'keyboard', 'three_plus_three'] }, { path: 'design.cohortSize', values: [1, 3] }] },
    stages: { screening: { replicates: 1000 }, final: { count: 2 } }, budget: { maxCandidates: 6, cpuSeconds: 600 },
  }
  assert.deepEqual(vcrCampaignManifest(dose).issues, [])
  const alpha = vcrCampaignManifest({ ...dose, constraints: [{ measure: 'correct_dose_probability', op: '<=', bound: 0.025, kind: 'error_control', truth: 'curve' }] })
  assert.ok(alpha.issues.some((issue) => issue.code === 'campaign_error_control_measure' && /toxicity and selection/.test(issue.detail)))
  const target = vcrCampaignManifest({ ...dose, space: { ...dose.space, variables: [{ path: 'design.targetToxicity', values: [0.25, 0.3] }] } })
  assert.ok(target.issues.some((issue) => issue.code === 'campaign_value_frozen'))
})

test('screening sizes stay under the floor and finalists never run below it', () => {
  const codes = (/** @type {any} */ over) => vcrCampaignManifest(manifestOf(over)).issues.map((issue) => issue.code)
  assert.ok(codes({ stages: { screening: { replicates: 100 }, final: { count: 2 } } }).includes('campaign_screening_replicates'))
  assert.ok(codes({ stages: { screening: { replicates: 5000 }, final: { count: 2 } } }).includes('campaign_screening_replicates'), 'a screening run is below the 5,000 floor')
  assert.ok(codes({ stages: { screening: { replicates: 500 }, final: { count: 2, replicates: 2000 } } }).includes('campaign_final_below_floor'))
  assert.ok(codes({ budget: { maxCandidates: 4, cpuSeconds: 60 } }).includes('campaign_space_exceeds_budget'))
})

test('candidates come in a deterministic order and a random subset is a pure function of its seed', () => {
  const all = vcrCampaignCandidates(frozen())
  assert.deepEqual(all.map((c) => c.key), ['c000', 'c001', 'c002', 'c003', 'c004', 'c005', 'c006', 'c007', 'c008'])
  assert.deepEqual(all[1].set, { 'design.nTreat': 80, 'design.nControl': 120 })
  const sampled = frozen({ space: { ...manifestOf().space, sample: { count: 4, seed: 7 } }, budget: { maxCandidates: 5, cpuSeconds: 60 }, reference: 0 })
  const one = vcrCampaignCandidates(sampled).map((c) => c.key), two = vcrCampaignCandidates(sampled).map((c) => c.key)
  assert.deepEqual(one, two)
  assert.ok(one.includes('c000'), 'the reference is always evaluated')
  assert.ok(one.length === 4 || one.length === 5)
})

test('screening and final units never share a cache key, a scenario or a stream', () => {
  const manifest = frozen()
  const candidate = vcrCampaignCandidates(manifest)[4]
  const screen = vcrCampaignUnit(manifest, ID, candidate, 'screening', 'alternative')
  const final = vcrCampaignUnit(manifest, ID, candidate, 'final', 'alternative')
  assert.deepEqual(screen.scenario.evaluation, { version: 1, screeningReplicates: 500 })
  assert.deepEqual(final.scenario.evaluation, { version: 1 })
  assert.notEqual(canonicalScenarioJson(screen.scenario), canonicalScenarioJson(final.scenario))
  assert.notEqual(screen.idempotencyKey, final.idempotencyKey)
  assert.notEqual(screen.seed, final.seed, 'finalists are checked on streams no screening unit used')
  assert.equal(screen.kind, 'design_simulation')
  // each unit is a job the engine protocol accepts as it stands
  for (const unit of [screen, final]) {
    const job = { jobId: 'job_x', studyId: 'std_x', kind: unit.kind, method: unit.method, methodVersion: unit.version, protocolVersion: 1,
      scenario: unit.scenario, inputs: [], seed: unit.seed, cpuSecondsLimit: 60 }
    assert.deepEqual(validateEngineJob(job).map((issue) => `${issue.code}@${issue.field}`), [])
  }
})

test('candidates that draw identically share a seed; a different size draws on its own', () => {
  const manifest = frozen({ space: { ...manifestOf().space, scenario: { ...BASE, design: { kind: 'group_sequential', nTreat: 100, nControl: 100, informationRates: [0.5, 1] } },
    variables: [{ path: 'design.informationRates', values: [[0.5, 1], [0.6, 1]] }, { path: 'design.nTreat', values: [100, 120] }] }, budget: { maxCandidates: 4, cpuSeconds: 60 } })
  const [a, b, c] = vcrCampaignCandidates(manifest)   // (0.5,100), (0.5,120), (0.6,100)
  assert.equal(vcrCampaignDrawKey(manifest, a), vcrCampaignDrawKey(manifest, c))
  assert.notEqual(vcrCampaignDrawKey(manifest, a), vcrCampaignDrawKey(manifest, b))
  assert.equal(vcrCampaignUnit(manifest, ID, a, 'final', 'alternative').seed, vcrCampaignUnit(manifest, ID, c, 'final', 'alternative').seed)
  assert.notEqual(vcrCampaignUnit(manifest, ID, a, 'final', 'alternative').seed, vcrCampaignUnit(manifest, ID, b, 'final', 'alternative').seed)
})

test('Clopper-Pearson bounds match R qbeta to 1e-12', () => {
  const a = vcrClopperPearson(500, 20000, 0.975)
  assert.ok(Math.abs(a.upper - 0.027259038729895657) < 1e-12)
  assert.ok(Math.abs(a.lower - 0.022880525081978138) < 1e-12)
  assert.ok(Math.abs(vcrClopperPearson(0, 20000, 0.975).upper - 0.00018442696396189909) < 1e-12)
  assert.ok(Math.abs(vcrClopperPearson(11, 200, 0.975).upper - 0.096277644433912846) < 1e-12)
})

const evaluation = (/** @type {any} */ measures, /** @type {any} */ over = {}) => ({ state: 'succeeded', precision: 'final', replicates: 20000, measures, ...over })
const m = (/** @type {any} */ name, /** @type {any} */ value, /** @type {any} */ extra = {}) => ({ name, value, mcse: Math.sqrt(value * (1 - value) / 20000), simulated: true, source: 'synthetic', ...extra })

test('an error-rate constraint passes only on its upper bound; at the nominal alpha it is inconclusive, never a pass', () => {
  const manifest = frozen()
  const [, alphaRule] = manifest.constraints
  const at = (/** @type {any} */ value) => vcrJudgeConstraint(manifest, alphaRule, evaluation([m('type_one_error', value)]), { stage: 'final' })
  assert.equal(at(0.025).status, 'inconclusive', 'an estimate exactly at alpha leaves compliance undecided')
  assert.equal(at(0.0249).status, 'inconclusive')
  assert.equal(at(0.022).status, 'pass')
  assert.ok(at(0.022).bound.upper <= 0.025 && at(0.022).bound.kind === 'clopper_pearson')
  assert.equal(at(0.03).status, 'fail')
  // error control is not judged on a screening evaluation, and a screening measure never satisfies a final constraint
  assert.equal(vcrJudgeConstraint(manifest, alphaRule, evaluation([m('type_one_error', 0.001)]), { stage: 'screening' }).reason, 'error_control_judged_at_final')
  const screened = vcrJudgeConstraint(manifest, alphaRule, evaluation([m('type_one_error', 0.001, { precision: 'screening' })], { precision: 'screening', replicates: 500 }), { stage: 'final' })
  assert.deepEqual([screened.status, screened.reason], ['not_judged', 'screening_result_not_final'])
})

test('a test whose size is exact passes on its nominal level unless the simulation contradicts it; an asymptotic one is held to the bound (review stats P1-2)', () => {
  const manifest = frozen({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null', analyticSupport: true }] })
  const rule = manifest.constraints[0]
  const exact = 'pooled_t_equal_sd_normal'
  const nominal = vcrJudgeConstraint(manifest, rule, evaluation([m('type_one_error', 0.0255)], { nominalControl: exact }), { stage: 'final' })
  assert.deepEqual([nominal.status, nominal.bound.kind, nominal.bound.calibration], ['pass', 'nominal_level', exact])
  assert.equal(vcrJudgeConstraint(manifest, rule, evaluation([m('type_one_error', 0.0305)], { nominalControl: exact }), { stage: 'final' }).status, 'fail')
  // the pooled score z of a binary design at its true size (2.72% at 30 per arm, p = 0.10) no longer passes on its level
  const asymptotic = vcrJudgeConstraint(manifest, rule, evaluation([m('type_one_error', 0.0272)], { nominalControl: null }), { stage: 'final' })
  assert.deepEqual([asymptotic.status, asymptotic.bound.kind, asymptotic.bound.nominalNotExact], ['inconclusive', 'clopper_pearson', true])
  assert.equal(vcrJudgeConstraint(manifest, rule, evaluation([m('type_one_error', 0.0255)], { nominalControl: true }), { stage: 'final' }).status, 'inconclusive',
    'a record that said only "calibrated" (the log-rank of an older build) is held to the simulation bound')
  assert.equal(vcrNominalErrorControl({ ...BASE, analysis: { method: 'maxcombo' } }), null)
  assert.equal(vcrNominalErrorControl(BASE), null, 'the log-rank test is asymptotic')
  assert.equal(vcrNominalErrorControl({ design: { kind: 'two_arm_fixed' }, endpoint: { type: 'binary' } }), null, 'the score z of a risk difference is asymptotic')
  assert.equal(vcrNominalErrorControl({ design: { kind: 'two_arm_fixed' }, endpoint: { type: 'continuous' } }), exact)
  assert.equal(vcrNominalErrorControl({ design: { kind: 'group_sequential' }, endpoint: { type: 'continuous' } }), null)
  assert.ok(vcrCampaignManifest(manifestOf({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.02, kind: 'error_control', truth: 'null', analyticSupport: true }] }))
    .issues.some((issue) => issue.field === 'constraints[0].analyticSupport'))
})

test('a mean is judged with its MCSE and an exact value as it is', () => {
  const manifest = frozen({ constraints: [{ measure: 'expected_sample_size', op: '<=', bound: 250, kind: 'design', truth: 'alternative' }] })
  const rule = manifest.constraints[0]
  const mean = (/** @type {any} */ value, /** @type {any} */ mcse) => vcrJudgeConstraint(manifest, rule, evaluation([{ name: 'expected_sample_size', value, mcse, simulated: true }]), { stage: 'final' })
  assert.equal(mean(240, 2).status, 'pass')
  assert.equal(mean(248, 2).status, 'inconclusive')
  assert.equal(mean(260, 2).status, 'fail')
  assert.equal(mean(250, 0).status, 'pass', 'a simulated mean that is the same in every trial is exact')
})

/** A fake engine: the power and expected size of a two-arm design at n per arm, deterministic. */
/** @param {any} unit @param {{ failAll?: boolean, powerScale?: number, nullRate?: number }} [options] @returns {Record<string, any>} */
function fakeOutcome(unit, { failAll = false, powerScale = 1, nullRate = 0.02 } = {}) {
  if (failAll) return { jobId: `job_${unit.key}`, state: 'failed', issues: ['handler_error'], cpuSeconds: 1 }
  const n = unit.scenario.design.nTreat + unit.scenario.design.nControl
  const isNull = unit.scenario.truth.hazardRatio === 1
  const reps = unit.stage === 'screening' ? 500 : 20000
  const p = isNull ? nullRate : Math.min(0.999, powerScale * (1 - Math.exp(-n / 180)))
  const k = Math.round(p * reps) / reps
  const precision = unit.stage === 'screening' ? 'screening' : undefined
  return { jobId: `job_${unit.key}`, state: 'succeeded', replicates: reps, seed: unit.seed, cpuSeconds: unit.stage === 'screening' ? 2 : 20, queueSeconds: 1, wallSeconds: 3,
    measures: [m(isNull ? 'type_one_error' : 'power', k, precision ? { precision } : {}), { name: 'expected_sample_size', value: n, mcse: 0, simulated: true, source: 'synthetic', ...(precision ? { precision } : {}) }] }
}

/** Run a campaign to its stop with the fake engine. */
/** @param {any} manifest @param {(unit: any) => Record<string, any>} [engine] @param {{ limit?: number, interrupt?: ((state: any, n: number) => any) | null }} [options] @returns {{ state: Record<string, any>, action: Record<string, any>, units: any[] }} */
function drive(manifest, engine = fakeOutcome, { limit = 200, interrupt = null } = {}) {
  let state = vcrCampaignInitialState(manifest)
  const units = []
  for (let i = 0; i < limit; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID })
    state = next
    if (action.type !== 'evaluate') return { state, action, units }
    const unit = /** @type {any} */ (action.unit)
    units.push(unit)
    state = { ...state, inFlight: { unitKey: unit.key } }
    if (interrupt) state = interrupt(state, units.length) ?? state
    state = vcrCampaignRecord(manifest, state, unit, engine(unit))
  }
  throw new Error('campaign did not stop')
}

test('a campaign screens every candidate, checks finalists on independent streams and stops with acceptable precision', () => {
  const manifest = frozen({ constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }] })
  const { state, action, units } = drive(manifest)
  assert.equal(action.reason, 'acceptable_precision')
  const screening = units.filter((unit) => unit.stage === 'screening')
  assert.equal(screening.length, 9, 'error-control truths are not screened')
  assert.ok(screening.every((unit) => unit.truth === 'alternative'))
  // small designs are eliminated by their screening power bound, the rest ranked by expected size
  assert.equal(state.candidates.c000.status, 'eliminated')
  assert.equal(state.finalists.length, 2)
  const finals = units.filter((unit) => unit.stage === 'final')
  assert.equal(finals.length, 4, 'two finalists under both truths')
  const screenSeeds = new Set(screening.map((unit) => unit.seed))
  assert.ok(finals.every((unit) => !screenSeeds.has(unit.seed)), 'no final unit reuses a screening stream')
  const verdict = vcrCampaignVerdict(manifest, state)
  assert.ok(verdict.best && verdict.feasible.includes(verdict.best))
  assert.equal(state.stop.reason, 'acceptable_precision')
  assert.ok(VCR_CAMPAIGN_STOP_REASONS.includes(state.stop.reason))
  assert.equal(state.usage.cpuSeconds, 9 * 2 + 4 * 20)
})

test('a null design with nothing feasible stops with no feasible beneficial candidate', () => {
  const manifest = frozen()
  const { action, state } = drive(manifest, (unit) => fakeOutcome(unit, { powerScale: 0.3 }))
  assert.equal(action.reason, 'no_feasible_beneficial_candidate')
  assert.ok(Object.values(state.candidates).every((entry) => entry.status === 'eliminated'))
})

test('a design calibrated exactly at alpha leaves compliance inconclusive at this precision, not infeasible (review stats P1-1)', () => {
  const manifest = frozen()
  const { action, state } = drive(manifest, (unit) => fakeOutcome(unit, { nullRate: 0.025 }))
  assert.equal(action.reason, 'inconclusive_at_precision', 'nothing failed: it is undecided, never "nothing feasible"')
  assert.deepEqual(state.stop.verdict.inconclusive, ['c008'], 'the only design with enough power is undecided on alpha, not passed')
  const row = state.stop.verdict.rows.find((/** @type {any} */ entry) => entry.key === 'c008')
  assert.deepEqual(row.verdicts.map((/** @type {any} */ v) => v.status), ['pass', 'inconclusive'])
  assert.deepEqual(row.verdicts[1].needed, { replicates: null, reason: 'estimate_at_bound' }, 'an estimate on the bound is decided by no number of replicates')
  // the closest design is reported with the constraint nothing could decide, its simulated value and error (F4)
  assert.equal(state.stop.verdict.best, null)
  assert.equal(state.stop.verdict.bestUndecided, 'c008')
  const undecided = state.stop.verdict.undecided.find((/** @type {any} */ entry) => entry.key === 'c008')
  assert.deepEqual(undecided.constraints.map((/** @type {any} */ c) => [c.measure, c.estimate, c.needed.reason]), [['type_one_error', 0.025, 'estimate_at_bound']])
  assert.ok(undecided.constraints[0].mcse > 0)
  // just inside the bound: the replicates that would decide it are stated
  const near = drive(manifest, (unit) => fakeOutcome(unit, { nullRate: 0.0245 }))
  const needed = near.state.stop.verdict.rows.find((/** @type {any} */ entry) => entry.key === 'c008').verdicts[1].needed
  assert.equal(near.action.reason, 'inconclusive_at_precision')
  assert.ok(needed.replicates > 20000 && needed.reason === null, JSON.stringify(needed))
  // a failure is still a failure: an alpha the simulation contradicts is "nothing feasible"
  assert.equal(drive(manifest, (unit) => fakeOutcome(unit, { nullRate: 0.04 })).action.reason, 'no_feasible_beneficial_candidate')
})

test('screening optimism does not decide: the final, independent evaluation does', () => {
  const manifest = frozen({ objective: { measure: 'power', direction: 'maximize', truth: 'alternative' },
    constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }] })
  // the screen flatters c004 (a lucky stream); its final evaluation does not
  const engine = (/** @type {any} */ unit) => {
    const out = fakeOutcome(unit)
    if (unit.candidate === 'c004' && unit.stage === 'screening') out.measures[0] = m('power', 0.99, { precision: 'screening' })
    return out
  }
  const { state } = drive(manifest, engine)
  assert.ok(state.finalists.includes('c004'))
  const verdict = vcrCampaignVerdict(manifest, state)
  assert.notEqual(verdict.best, 'c004', 'the winner is chosen on the final streams')
})

test('a screening outcome recorded in a final slot can never satisfy a final constraint', () => {
  const manifest = frozen({ constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }] })
  const engine = (/** @type {any} */ unit) => unit.stage === 'final' ? { ...fakeOutcome({ ...unit, stage: 'screening' }), precision: 'screening' } : fakeOutcome(unit)
  const { action } = drive(manifest, engine)
  assert.equal(action.reason, 'no_feasible_beneficial_candidate')
})

test('stop rules: persistent failure, unsupported space, budget and cancellation', () => {
  assert.equal(drive(frozen(), (unit) => fakeOutcome(unit, { failAll: true })).action.reason, 'persistent_model_failure')
  const unsupported = drive(frozen(), (_unit) => ({ jobId: null, state: 'failed', unsupported: true, issues: ['design_not_supported'] }))
  assert.equal(unsupported.action.reason, 'unsupported_candidate')
  const budget = drive(frozen({ budget: { maxCandidates: 9, cpuSeconds: 5 } }))
  assert.equal(budget.action.reason, 'budget_exhausted')
  assert.equal(budget.state.usage.cpuSeconds, 6, 'the units that ran are counted, the rest never started')
  const cancelled = drive(frozen(), fakeOutcome, { interrupt: (state, n) => (n === 3 ? { ...state, cancelRequested: true } : null) })
  assert.equal(cancelled.action.reason, 'user_cancellation')
  assert.equal(cancelled.units.length, 3)
})

test('an improvement smaller than the declared minimum over the reference stops as no useful improvement', () => {
  const manifest = frozen({ reference: 8, stopRules: { minImprovement: 1000 },
    constraints: [{ measure: 'power', op: '>=', bound: 0.7, kind: 'design', truth: 'alternative' }] })
  const { action, state } = drive(manifest)
  assert.ok(state.finalists.includes('c008'), 'the reference is evaluated at final precision')
  assert.equal(action.reason, 'no_useful_improvement')
  const beneficial = drive(frozen({ reference: 8, stopRules: { minImprovement: 10 }, constraints: [{ measure: 'power', op: '>=', bound: 0.7, kind: 'design', truth: 'alternative' }] }))
  assert.equal(beneficial.action.reason, 'acceptable_precision')
  assert.equal(beneficial.state.stop.verdict.improvement, 80, 'the improvement is read on the final evaluations: 320 against 240')
})

test('an analytic pre-check eliminates sizes below the closed-form requirement before any simulation', () => {
  const manifest = frozen({ constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }],
    stages: { analytic: { scenario: { design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
      analysis: { alpha: 0.025, power: 0.8, sided: 1 }, accrual: { duration: 12, followup: 12 } },
    eliminate: [{ measure: 'required_patients', exceeds: ['design.nTreat', 'design.nControl'], tolerance: 0.05 }] }, screening: { replicates: 500 }, final: { count: 2 } } })
  const engine = (/** @type {any} */ unit) => unit.stage === 'analytic'
    ? { jobId: 'job_a', state: 'succeeded', measures: [{ name: 'required_patients', value: 280, source: 'calculated' }], cpuSeconds: 0.1 }
    : fakeOutcome(unit)
  const { units, state } = drive(manifest, engine)
  assert.equal(units[0].stage, 'analytic')
  assert.equal(units.filter((unit) => unit.stage === 'analytic').length, 1, 'one analytic unit serves every candidate with the same applied paths')
  assert.equal(state.candidates.c000.reason, 'analytic_below:required_patients')
  assert.ok(!units.some((unit) => unit.stage === 'screening' && unit.candidate === 'c000'))
})

test('an analytic rule naming a path no candidate has is refused, and never eliminates by counting it as 0', () => {
  const stages = (/** @type {string[]} */ exceeds) => ({ analytic: { scenario: { design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' },
    truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { alpha: 0.025, power: 0.8, sided: 1 }, accrual: { duration: 12, followup: 12 } },
  eliminate: [{ measure: 'required_patients', exceeds, tolerance: 0.05 }] }, screening: { replicates: 500 }, final: { count: 2 } })
  const refused = vcrCampaignManifest(manifestOf({ constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }], stages: stages(['design.n']) }))
  assert.ok(refused.issues.some((/** @type {any} */ issue) => issue.field === 'stages.analytic.eliminate[0].exceeds[0]'), JSON.stringify(refused.issues))
})

test('a design-search precision block is attached only where the method takes one', async () => {
  const { vcrEvaluationAllowed } = await import('../src/vcrScenarioSchemas.mjs')
  assert.equal(vcrEvaluationAllowed('design.dose', { design: { kind: 'randomized_selection' } }), false)
  assert.equal(vcrEvaluationAllowed('design.dose', { design: { kind: 'boin' } }), true)
  assert.equal(vcrEvaluationAllowed('design.simulate', BASE), true)
  assert.equal(vcrEvaluationAllowed('design.analytic', BASE), false)
})

test('contrasts follow the coupling the runs really had', () => {
  const bits = (/** @type {any} */ pattern) => pattern.match(/.{1,8}/g).map((/** @type {any} */ byte) => Number.parseInt(byte.padEnd(8, '0').split('').reverse().join(''), 2).toString(16).padStart(2, '0')).join('')
  const a = { seed: 5, drawSignature: 'x', replicates: 16, rejects: bits('1111000011110000'), measures: [{ name: 'power', value: 0.5, mcse: 0.125, simulated: true }] }
  const b = { seed: 5, drawSignature: 'x', replicates: 16, rejects: bits('1110000011100000'), measures: [{ name: 'power', value: 0.375, mcse: 0.121, simulated: true }] }
  const paired = vcrEvaluationContrast(a, b, 'power')
  assert.equal(paired.coupling, 'paired')
  assert.deepEqual(paired.discordant, { onlyA: 2, onlyB: 0 })
  assert.ok(paired.mcse < Math.sqrt(0.125 ** 2 + 0.121 ** 2), 'pairing removes the shared variance')
  const shifted = vcrEvaluationContrast(a, { ...b, drawSignature: 'y' }, 'power')
  assert.deepEqual([shifted.coupling, shifted.mcse], ['same_seed_different_draws', null], 'same seed, different draws: no interval')
  const independent = vcrEvaluationContrast(a, { ...b, seed: 6 }, 'power')
  assert.equal(independent.coupling, 'independent')
  assert.ok(Math.abs(Number(independent.mcse) - Math.sqrt(0.125 ** 2 + 0.121 ** 2)) < 1e-12)
})

test('a unit cancelled from outside stops the campaign as a cancellation, not a model failure, and no next candidate starts (review eng P1-2)', () => {
  const engine = (/** @type {any} */ unit) => (unit.key === 'c000:screening:alternative' ? { jobId: `job_${unit.key}`, state: 'canceled', issues: [], cpuSeconds: 1 } : fakeOutcome(unit))
  const { action, state, units } = drive(frozen(), engine)
  assert.equal(action.reason, 'user_cancellation')
  assert.equal(units.length, 1, 'the next candidate is never evaluated')
  assert.equal(state.consecutiveFailures, 0)
  assert.equal(state.candidates.c000.status, 'pending', 'the cancelled candidate is not judged')
})

test('a spent budget never hides a verdict that needs no more runs (review stats P2-3); dropout is the world, not a design (P2-2)', () => {
  // every unit costs 20 CPU-seconds at the final stage: the last final unit ends over a budget of 100
  const manifest = frozen({ stages: { final: { count: 2 } }, budget: { maxCandidates: 9, cpuSeconds: 98, modelCalls: 0 },
    constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }],
    space: { ...manifestOf().space, variables: [{ path: 'design.nTreat', values: [160, 200] }] } })
  const done = drive(manifest, (unit) => ({ ...fakeOutcome(unit), cpuSeconds: 49 }))
  assert.ok(done.state.usage.cpuSeconds >= 98)
  assert.equal(done.action.reason, 'acceptable_precision')
  const searched = vcrCampaignManifest(manifestOf({ space: { ...manifestOf().space, variables: [{ path: 'accrual.dropoutAnnual', values: [0, 0.1, 0.2] }] } }))
  assert.ok(searched.issues.some((issue) => issue.code === 'campaign_value_frozen' && issue.field === 'space.variables[0].path'))
})

test('an improvement over the reference is decided on the bound of the contrast, not two point estimates (review stats P2-1)', () => {
  const manifest = frozen({ objective: { measure: 'power', direction: 'maximize', truth: 'alternative' }, reference: 0, stopRules: { minImprovement: 0.02 },
    constraints: [{ measure: 'power', op: '>=', bound: 0.3, kind: 'design', truth: 'alternative' }],
    stages: { final: { count: 2 } }, space: { ...manifestOf().space, variables: [{ path: 'design.nTreat', values: [200, 201] }] } })
  // two powers 0.03 apart, each with the error of 500 replicates: the difference is not decided
  const engine = (/** @type {any} */ unit) => {
    const out = fakeOutcome(unit)
    const p = unit.candidate === 'c000' ? 0.70 : 0.73
    out.replicates = 500
    out.measures[0] = { name: 'power', value: p, mcse: Math.sqrt(p * (1 - p) / 500), simulated: true, source: 'synthetic' }
    return out
  }
  const { action, state } = drive(manifest, engine)
  assert.equal(action.reason, 'inconclusive_at_precision')
  assert.ok(state.stop.verdict.improvementBound.lower < 0.02 && state.stop.verdict.improvement > 0.02)
  assert.equal(state.stop.verdict.selection.finalists, 2)
})

test('an analytic pre-check eliminates only in the world the objective is judged in (review stats P2-4)', () => {
  const stages = (/** @type {any} */ truth) => ({ analytic: { scenario: { design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth,
    analysis: { alpha: 0.025, power: 0.8, sided: 1 }, accrual: { duration: 12, followup: 12 } },
  eliminate: [{ measure: 'required_patients', exceeds: ['design.nTreat', 'design.nControl'], tolerance: 0.05 }] }, screening: { replicates: 500 }, final: { count: 2 } })
  const smaller = vcrCampaignManifest(manifestOf({ stages: stages({ hazardRatio: 0.8, controlMedian: 12 }) }))
  assert.ok(smaller.issues.some((issue) => issue.code === 'campaign_analytic_truth_mismatch' && issue.field === 'stages.analytic.scenario.truth.hazardRatio'))
  assert.deepEqual(vcrCampaignManifest(manifestOf({ stages: stages({ hazardRatio: 0.7, controlMedian: 12 }) })).issues, [])
})

const alphaSpace = (/** @type {any[]} */ levels) => ({ ...manifestOf().space, variables: [{ path: 'design.nTreat', values: [200] }, { path: 'analysis.alpha', values: levels }] })

test('the analysis level is a search variable only at or below the frozen error-control bound (F4)', () => {
  const codes = (/** @type {any} */ over) => vcrCampaignManifest(manifestOf(over)).issues.map((issue) => `${issue.code}@${issue.field}`)
  const ok = frozen({ space: alphaSpace([0.02, 0.024, 0.025]), budget: { maxCandidates: 3, cpuSeconds: 3600 } })
  assert.equal(ok.constraints.find((/** @type {any} */ c) => c.kind === 'error_control').bound, 0.025, 'the constraint is what it was')
  assert.equal(vcrCampaignCandidates(ok).length, 3)
  assert.notEqual(vcrCampaignCanonical(ok), vcrCampaignCanonical(frozen({ space: alphaSpace([0.02, 0.024]), budget: { maxCandidates: 3, cpuSeconds: 3600 } })))
  assert.ok(codes({ space: alphaSpace([0.02, 0.03]) }).includes('campaign_alpha_relaxed@space.variables[1].values'))
  assert.ok(codes({ space: alphaSpace([0]) }).includes('campaign_alpha_relaxed@space.variables[1].values'))
  // searching the level with no constraint to hold it under would let a larger level win on power
  assert.ok(codes({ space: alphaSpace([0.02]), constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }] }).includes('campaign_alpha_search_unbounded@constraints'))
  // explicit candidates are held to the same ceiling
  const explicit = { ...manifestOf().space, variables: undefined, candidates: [{ set: { 'design.nTreat': 120, 'analysis.alpha': 0.05 } }] }
  assert.ok(codes({ space: explicit, budget: { maxCandidates: 1, cpuSeconds: 3600 } }).includes('campaign_alpha_relaxed@space.candidates[0].set.analysis.alpha'))
  // the dose design has no analysis level to search
  assert.ok(vcrCampaignManifest({ ...manifestOf(), space: { ...manifestOf().space, method: 'design.dose', variables: [{ path: 'analysis.alpha', values: [0.02] }] } }).issues.length > 0)
})

test('a lower analysis level gives an asymptotically calibrated test margin under the unchanged constraint (F4)', () => {
  const manifest = frozen({ space: alphaSpace([0.022, 0.025]), budget: { maxCandidates: 2, cpuSeconds: 3600 }, stages: { screening: { replicates: 500 }, final: { count: 2 } } })
  const engine = (/** @type {any} */ unit) => {
    const out = fakeOutcome(unit, { nullRate: 0.02 })
    // the simulated type I error of an asymptotic test sits at its own level
    return unit.scenario.truth.hazardRatio === 1 ? { ...out, measures: [m('type_one_error', unit.scenario.analysis.alpha)] } : out
  }
  const { state, action } = drive(manifest, engine)
  const verdict = vcrCampaignVerdict(manifest, state)
  const level = (/** @type {string} */ key) => vcrCampaignCandidates(manifest).find((c) => c.key === key)?.set['analysis.alpha']
  assert.equal(action.reason, 'acceptable_precision')
  assert.equal(level(/** @type {string} */ (verdict.best)), 0.022, 'the lower level passes the unchanged 2.5% bound')
  assert.deepEqual(verdict.inconclusive.map(level), [0.025], 'the level equal to the bound stays undecided and is never passed on its point estimate')
})

// Improvement precision and the screened-out reference (round 2, F05/F06). The cases are the shape of the independent review's
// `unknown-covariance` and `screened-reference` harnesses, run through the public campaign functions with synthetic engine outcomes.
const improvementManifest = (/** @type {any} */ over = {}) => frozen({ objective: { measure: 'power', direction: 'maximize', truth: 'alternative' }, reference: 0,
  constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }],
  stages: { final: { count: 2 } }, space: { ...manifestOf().space, variables: [{ path: 'design.nTreat', values: [200, 201] }] }, ...over })
const powerEngine = (/** @type {Record<string, number>} */ powers, /** @type {(out: any, unit: any) => void} */ shape = () => {}) => (/** @type {any} */ unit) => {
  const out = fakeOutcome(unit)
  const p = powers[`${unit.candidate}:${unit.stage}`] ?? powers[unit.candidate]
  out.replicates = 20000
  out.measures[0] = { name: 'power', value: p, mcse: Math.sqrt(p * (1 - p) / 20000), simulated: true, source: 'synthetic' }
  shape(out, unit)
  return out
}
// the same seed on both finals, each with its own draw signature: the dependence is unknown
const sameSeedOwnDraws = (/** @type {any} */ out, /** @type {any} */ unit) => { out.seed = 5; out.drawSignature = `draws:${unit.candidate}` }

test('an unknown dependence is bounded by the sum of the marginal errors, never by their independent combination (F05)', () => {
  const engine = powerEngine({ c000: 0.70, c001: 0.80 }, sameSeedOwnDraws)
  const wide = drive(improvementManifest({ stopRules: { minImprovement: 0.09 } }), engine)
  const bound = wide.state.stop.verdict.improvementBound
  assert.equal(bound.basis, 'worst_case')
  assert.equal(bound.coupling, 'same_seed_different_draws')
  const marginals = Math.sqrt(0.7 * 0.3 / 20000) + Math.sqrt(0.8 * 0.2 / 20000)
  assert.ok(Math.abs(bound.mcse - marginals) < 1e-12, 'Cauchy–Schwarz: sd(A − B) <= sd(A) + sd(B)')
  // under independence the lower bound (about 0.0916) would meet 0.09; the worst case (about 0.0884) does not
  assert.equal(wide.action.reason, 'inconclusive_at_precision')
  const easy = drive(improvementManifest({ stopRules: { minImprovement: 0.05 } }), engine)
  assert.equal(easy.action.reason, 'acceptable_precision')
  assert.equal(easy.state.stop.verdict.improvementBound.basis, 'worst_case')
})

test('a missing marginal error is unknown, not zero: the improvement is unassessed and the requested minimum is not satisfied (F05)', () => {
  const noError = (/** @type {any} */ out, /** @type {any} */ unit) => { if (unit.candidate === 'c001') delete out.measures[0].mcse; sameSeedOwnDraws(out, unit) }
  const bounded = drive(improvementManifest({ stopRules: { minImprovement: 0.01 } }), powerEngine({ c000: 0.70, c001: 0.80 }, noError))
  assert.equal(bounded.state.stop.verdict.improvementBound.basis, 'unassessed')
  assert.equal(bounded.state.stop.verdict.improvementBound.lower, null)
  assert.equal(bounded.action.reason, 'inconclusive_at_precision')
  // different seeds are independent streams, yet an absent error still leaves the contrast without an interval
  const independentNoError = drive(improvementManifest({ stopRules: { minImprovement: 0.01 } }), powerEngine({ c000: 0.70, c001: 0.80 }, (out, unit) => { if (unit.candidate === 'c001') delete out.measures[0].mcse }))
  assert.equal(independentNoError.state.stop.verdict.improvementBound.basis, 'unassessed')
  assert.equal(independentNoError.action.reason, 'inconclusive_at_precision')
})

test('a contrast is independent only between two known, different seeds (F05)', () => {
  const a = { seed: 5, replicates: 100, measures: [{ name: 'power', value: 0.5, mcse: 0.05, simulated: true }] }
  const b = { seed: 6, replicates: 100, measures: [{ name: 'power', value: 0.4, mcse: 0.05, simulated: true }] }
  assert.equal(vcrEvaluationContrast(a, b, 'power').coupling, 'independent')
  const unseeded = vcrEvaluationContrast({ ...a, seed: null }, b, 'power')
  assert.deepEqual([unseeded.coupling, unseeded.mcse, unseeded.worstCaseMcse], ['unknown_dependence', null, 0.1])
  const noError = vcrEvaluationContrast(a, { ...b, measures: [{ name: 'power', value: 0.4, simulated: true }] }, 'power')
  assert.deepEqual([noError.coupling, noError.mcse, noError.worstCaseMcse], ['independent', null, null])
  const exact = vcrEvaluationContrast(a, { ...b, measures: [{ name: 'power', value: 0.4 }] }, 'power')
  assert.deepEqual([exact.mcse, exact.worstCaseMcse], [0.05, 0.05], 'a calculated measure has no error of its own')
})

test('a reference screened out is still evaluated finally for the contrast and never wins (F06)', () => {
  const manifest = improvementManifest({ stopRules: { minImprovement: 0.01 }, stages: { screening: { replicates: 500 }, final: { count: 1 } },
    constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }] })
  // the reference's screening power is far under the bound, so screening eliminates it; its final power is what the contrast reads
  const { action, state, units } = drive(manifest, powerEngine({ 'c000:screening': 0.10, 'c000:final': 0.55, 'c001:screening': 0.80, 'c001:final': 0.80 }))
  assert.equal(state.candidates.c000.role, 'reference_only')
  assert.ok(units.some((unit) => unit.candidate === 'c000' && unit.stage === 'final'), 'the reference has a final evaluation')
  const verdict = state.stop.verdict
  assert.equal(verdict.best, 'c001')
  assert.ok(!verdict.feasible.includes('c000'), 'it never competes, though its own final power would pass')
  assert.ok(Math.abs(verdict.improvement - 0.25) < 1e-12)
  assert.notEqual(verdict.improvementBound, null)
  assert.equal(action.reason, 'acceptable_precision')
  // and the stop honours the minimum the person asked for
  const demanding = drive(improvementManifest({ stopRules: { minImprovement: 0.4 }, stages: { screening: { replicates: 500 }, final: { count: 1 } } }),
    powerEngine({ 'c000:screening': 0.10, 'c000:final': 0.55, 'c001:screening': 0.80, 'c001:final': 0.80 }))
  assert.equal(demanding.action.reason, 'no_useful_improvement')
})

test('a reference that cannot be evaluated leaves the improvement unassessed and the requested minimum unsatisfied (F06)', () => {
  const manifest = improvementManifest({ stopRules: { minImprovement: 0.01 }, stages: { screening: { replicates: 500 }, final: { count: 1 } } })
  const engine = (/** @type {any} */ unit) => (unit.candidate === 'c000' && unit.stage === 'final' ? { jobId: `job_${unit.key}`, state: 'failed', issues: ['handler_error'], cpuSeconds: 1 }
    : powerEngine({ 'c000:screening': 0.10, 'c001:screening': 0.80, 'c001:final': 0.80 })(unit))
  const { action, state } = drive(manifest, engine)
  assert.equal(state.stop.verdict.best, 'c001')
  assert.equal(state.stop.verdict.improvement, null)
  assert.equal(action.reason, 'inconclusive_at_precision')
})
