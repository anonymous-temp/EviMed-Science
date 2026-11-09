/**
 * The empirical tables of the evidence methods (algorithm round E6, E7, E8): the priors for heterogeneity, the reference mixture of the Cochrane trials and the
 * historical success rates. Each number was read from the primary text of its paper; these tests hold the transcription to the arithmetic the papers themselves
 * contain (a row that must sum, a product that must equal the printed total, an example that must find its own prior), so a mistyped digit fails here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VCR_BARTOS_2023_PRIORS, VCR_BIO_2011_2020, VCR_SUCCESS_RATE_AREAS, VCR_TURNER_2015_GENERIC, VCR_TURNER_2015_PRIORS, VCR_TURNER_COMPARISONS,
  VCR_TURNER_OUTCOMES, VCR_VAN_ZWET_2023_MIXTURE, VCR_VAN_ZWET_2023_TABLE_2, VCR_VAN_ZWET_2023_TABLE_3, VCR_WONG_2019, vcrSuccessRates,
} from '../index.mjs'

test('Turner et al. (2015) Table IV: 16 outcome types by 5 comparison types, and the columns differ by the paper\'s own ratios of tau-squared', () => {
  assert.equal(VCR_TURNER_OUTCOMES.length, 16)
  assert.equal(VCR_TURNER_COMPARISONS.length, 5)
  const ratios = { pharmacological_vs_placebo: 0.64, pharmacological_vs_pharmacological: 0.51, non_pharmacological_vs_placebo: 0.51, non_pharmacological_vs_pharmacological: 1.81 }
  for (const outcome of VCR_TURNER_OUTCOMES) {
    const row = /** @type {Record<string, any>} */ (VCR_TURNER_2015_PRIORS)[outcome]
    assert.deepEqual(Object.keys(row), [...VCR_TURNER_COMPARISONS], outcome)
    for (const [comparison, ratio] of Object.entries(ratios)) {
      const gap = Math.exp(row[comparison][0] - row.non_pharmacological_vs_non_pharmacological[0])
      assert.ok(Math.abs(gap / ratio - 1) < 0.02, `${outcome} ${comparison}: ratio ${gap.toFixed(3)} against the paper's Table III ${ratio}`)
    }
  }
  // the two worked examples of the paper find their own prior, and the generic one
  assert.deepEqual([...VCR_TURNER_2015_PRIORS.cause_specific_mortality_or_morbidity.pharmacological_vs_pharmacological], [-3.95, 1.79])
  assert.deepEqual([...VCR_TURNER_2015_PRIORS.withdrawals.non_pharmacological_vs_placebo], [-3.21, 1.91])
  assert.deepEqual([...VCR_TURNER_2015_GENERIC], [-2.56, 1.74])
  // the medians the paper quotes: 0.019, 0.12, 0.17 (drug against placebo)
  /** @param {string} outcome */
  const median = (outcome) => Math.exp(/** @type {Record<string, any>} */ (VCR_TURNER_2015_PRIORS)[outcome].pharmacological_vs_placebo[0])
  assert.ok(Math.abs(median('all_cause_mortality') - 0.019) < 0.0005)
  assert.ok(Math.abs(median('surgical_device_success') - 0.12) < 0.005)
  assert.ok(Math.abs(median('biological_markers') - 0.17) < 0.005)
})

test('Bartos et al. (2023): the four general heterogeneity priors as the paper prints them', () => {
  assert.deepEqual({ ...VCR_BARTOS_2023_PRIORS.log_odds_ratio }, { kind: 'inverse_gamma', shape: 1.77, scale: 0.55 })
  assert.deepEqual({ ...VCR_BARTOS_2023_PRIORS.log_risk_ratio }, { kind: 'inverse_gamma', shape: 1.51, scale: 0.23 })
  assert.deepEqual({ ...VCR_BARTOS_2023_PRIORS.log_hazard_ratio }, { kind: 'inverse_gamma', shape: 2.42, scale: 0.30 })
  assert.deepEqual({ ...VCR_BARTOS_2023_PRIORS.risk_difference }, { kind: 'half_normal', scale: 0.10 })
})

test('van Zwet et al. (2023): the mixture of Table 1 is a probability distribution whose signal-to-noise spread is the z spread less one, and Tables 2 and 3 are as printed', () => {
  const m = VCR_VAN_ZWET_2023_MIXTURE
  assert.equal(m.trials, 23551)
  assert.ok(Math.abs(m.proportion.reduce((a, b) => a + b, 0) - 1) < 1e-12)
  m.sdZ.forEach((sd, i) => assert.ok(Math.abs(Math.sqrt(sd * sd - 1) - m.sdSnr[i]) < 0.006, `component ${i + 1}`))
  assert.equal(VCR_VAN_ZWET_2023_TABLE_3.length, 11)
  assert.ok(Math.abs(VCR_VAN_ZWET_2023_TABLE_3.reduce((a, row) => a + row.proportion, 0) - 1) < 0.021, 'the strata of the P value cover the trials, to the printed rounding')
  for (const row of [...VCR_VAN_ZWET_2023_TABLE_2, ...VCR_VAN_ZWET_2023_TABLE_3]) assert.ok(row.exaggeration[0] <= row.exaggeration[1] && row.exaggeration[1] <= row.exaggeration[2])
  assert.deepEqual(VCR_VAN_ZWET_2023_TABLE_2.map((row) => row.proportion), [0.71, 0.29])
})

test('BIO 2011-2020: the four phase rates of every disease area multiply to the printed likelihood of approval from phase I, and the numbers of transitions are as printed', () => {
  assert.equal(Object.keys(VCR_BIO_2011_2020).length, 16)
  for (const [area, row] of /** @type {Array<[string, any]>} */ (Object.entries(VCR_BIO_2011_2020))) {
    const product = row.phase1.toNext[1] * row.phase2.toNext[1] * row.phase3.toFiling[1] * row.filingToApproval[1]
    assert.ok(Math.abs(product - row.phase1.toApproval[1]) < 0.002, `${area}: ${product.toFixed(4)} against ${row.phase1.toApproval[1]}`)
  }
  const all = /** @type {any} */ (VCR_BIO_2011_2020).all
  assert.deepEqual([all.phase1.toNext, all.phase2.toNext, all.phase3.toFiling, all.filingToApproval], [[4414, 0.52], [4933, 0.289], [1928, 0.578], [1453, 0.906]])
  assert.deepEqual([all.phase1.toApproval, all.phase3.toApproval], [[12728, 0.079], [3381, 0.524]])
})

test('Wong, Siah and Lo (2019): the paths of the nine groups add up to the printed totals, the group rates average to the printed overall ones, and the doubtful overall phase 2 rate is left out', () => {
  /** @type {Array<[string, any]>} */
  const groups = Object.entries(VCR_WONG_2019).filter(([id]) => id !== 'overall')
  /** @type {any} */
  const overall = VCR_WONG_2019.overall
  assert.equal(groups.length, 9)
  const paths1 = groups.reduce((a, [, g]) => a + g.phase1.toNext[0], 0)
  const paths2 = groups.reduce((a, [, g]) => a + g.phase2.paths, 0)
  const paths3 = groups.reduce((a, [, g]) => a + g.phase3.toApproval[0], 0)
  assert.deepEqual([paths1, paths2, paths3], [overall.phase1.toNext[0], overall.phase2.paths, overall.phase3.toApproval[0]])
  /** @param {(g: any) => [number, number]} pick */
  const mean = (pick) => groups.reduce((a, [, g]) => a + pick(g)[0] * pick(g)[1], 0) / groups.reduce((a, [, g]) => a + pick(g)[0], 0)
  assert.ok(Math.abs(mean((g) => g.phase1.toNext) - overall.phase1.toNext[1]) < 0.001)
  assert.ok(Math.abs(mean((g) => g.phase3.toApproval) - overall.phase3.toApproval[1]) < 0.001)
  // the phase 2 to 3 rate the groups imply is 48.6%; the paper prints 58.3% (the infectious-disease row's value): the table does not choose
  const implied = groups.reduce((a, [, g]) => a + g.phase2.toNext[0] * g.phase2.toNext[1], 0) / paths2
  assert.ok(Math.abs(implied - 0.486) < 0.0005)
  assert.equal(overall.phase2.toNext, null)
  assert.equal(VCR_WONG_2019.oncology.phase1.toApproval, 0.034)
  assert.equal(overall.phase1.toApproval, 0.138)
})

test('the lookup gives each source its own rows, a phase on request, and nothing from the other source where one has none', () => {
  const all = /** @type {NonNullable<ReturnType<typeof vcrSuccessRates>>} */ (vcrSuccessRates())
  assert.equal(all.area.id, 'all')
  assert.equal(all.phases.length, 3)
  const heme = /** @type {NonNullable<ReturnType<typeof vcrSuccessRates>>} */ (vcrSuccessRates({ phase: 'phase2', area: 'hematology' }))
  assert.equal(heme.phases.length, 1)
  assert.equal(heme.phases[0].wong, null, 'Wong has no haematology group')
  assert.equal(heme.wongGroup, null)
  assert.ok(heme.phases[0].bio.toNext[1] > 0.4)
  assert.equal(vcrSuccessRates({ area: 'nonsense' }), null)
  for (const area of VCR_SUCCESS_RATE_AREAS) assert.ok(/** @type {Record<string, any>} */ (VCR_BIO_2011_2020)[area.bio], area.id)
})
