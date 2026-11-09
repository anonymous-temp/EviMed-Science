/**
 * Empirical priors for the between-study heterogeneity of a meta-analysis, and the empirical distribution of the signal-to-noise ratio of a
 * randomized trial (algorithm round E7, E8, 2026-11-03). Data, never code: a value is here only if it was read from the primary text of the
 * paper it is credited to on 2026-11-03, with the place it was read at. Nothing in this file is a tuned or remembered number.
 *
 * Hidden knowledge:
 *
 * - **A Cochrane prior describes the population of comparisons in the Cochrane Database, not the drug in front of you.** The priors are
 *   centred on no effect (the heterogeneity prior on how much studies of one comparison disagree, the shrinkage mixture on the z statistics of
 *   trials of every kind of intervention). The result says where its prior came from and the page words it as the Cochrane reference, so a
 *   reader can set it beside their own judgement; it never replaces a number the person stated.
 * - **The three families are not interchangeable.** Turner et al. (2015) give a log-normal distribution for tau-squared on the log odds ratio scale
 *   of binary outcomes (their Table IV, 80 settings: 16 outcome types by 5 comparison types, and one generic prior). Bartos et al. (2023) give an
 *   inverse-gamma distribution for tau itself (log odds ratio, log risk ratio, log hazard ratio) or a half-normal one (risk difference). The two are
 *   different questions asked of different data; the engine takes the one the scenario names and never mixes them.
 * - **Rhodes et al. (2015) (continuous outcomes, standardized mean difference) is deliberately absent.** Their predictive distributions are log-t on
 *   tau-squared with five degrees of freedom, but the open text does not say whether the second parameter is the scale or the standard deviation, and
 *   the 95% ranges the paper prints fit neither exactly; a parameter whose reading is a guess is not entered. A person who has the paper can state a
 *   log-t prior (`log_t`: location, scale, degrees of freedom) in the scenario, and the scale is then the scale of the t distribution.
 * - **Column order of Turner Table IV was proved, not assumed.** The text extracted from the open-access paper loses its column headings; the order
 *   (pharmacological vs placebo/control, pharmacological vs pharmacological, non-pharmacological vs placebo/control, non-pharmacological vs
 *   pharmacological, non-pharmacological vs non-pharmacological) is the one in which the differences between columns equal the paper's Table III
 *   ratios of tau-squared (0.64, 0.51, 0.51, 1.81 against the non/non reference, to two decimals on the log scale) and in which the paper's own two
 *   worked examples find their priors (ticlopidine plus aspirin, active against active, major morbidity: log-normal(-3.95, 1.79^2); acupuncture against
 *   sham, withdrawals: log-normal(-3.21, 1.91^2)).
 * - **The van Zwet mixture is for the z statistic of the primary efficacy outcome of a randomized trial.** Table 1 of van Zwet, Gelman, Greenland, Imbens, Schwab and Goodman gives
 *   the mixture of four zero-mean normal distributions fitted to the z statistics of 23,551 Cochrane trials; the signal-to-noise ratio has the same
 *   mixture with each variance reduced by one (its standard deviations are sqrt(sd_z^2 - 1)). Both rows are kept as printed and the test holds them
 *   consistent with each other to the paper's rounding.
 *
 * @module @evimed/domain/vcrEvidencePriors
 */

/** @param {readonly any[]} list */
const frozen = (list) => Object.freeze([...list])

export const VCR_TURNER_2015_SOURCE = Object.freeze({
  citation: 'Turner RM, Jackson D, Wei Y, Thompson SG, Higgins JPT. Predictive distributions for between-study heterogeneity and simple methods for their application in Bayesian meta-analysis. Statistics in Medicine 2015;34:984-998. doi:10.1002/sim.6381',
  place: 'Table IV (80 settings), and the text of Section 3.3 (the generic prior log-normal(-2.56, 1.74^2))',
  data: '14,886 binary outcome meta-analyses of the Cochrane Database of Systematic Reviews',
  scale: 'log odds ratio',
  prior: 'log-normal on tau-squared: log(tau^2) ~ Normal(mean, sd^2), the two numbers printed as LN(mean, sd^2)',
})

export const VCR_TURNER_COMPARISONS = frozen(["pharmacological_vs_placebo", "pharmacological_vs_pharmacological", "non_pharmacological_vs_placebo", "non_pharmacological_vs_pharmacological", "non_pharmacological_vs_non_pharmacological"])

export const VCR_TURNER_COMPARISON_LABELS_ZH = Object.freeze({
  "pharmacological_vs_placebo": "药物对安慰剂或对照",
  "pharmacological_vs_pharmacological": "药物对药物",
  "non_pharmacological_vs_placebo": "非药物对安慰剂或对照",
  "non_pharmacological_vs_pharmacological": "非药物对药物",
  "non_pharmacological_vs_non_pharmacological": "非药物对非药物"
})

export const VCR_TURNER_OUTCOMES = frozen(["all_cause_mortality", "obstetric", "cause_specific_mortality_or_morbidity", "resource_use", "surgical_device_success", "withdrawals", "structure_related", "general_physical_health", "adverse_events", "infection_new_disease", "signs_symptoms", "pain", "quality_of_life", "mental_health", "biological_markers", "subjective_various"])

export const VCR_TURNER_OUTCOME_LABELS_ZH = Object.freeze({
  "all_cause_mortality": "全因死亡",
  "obstetric": "产科结局",
  "cause_specific_mortality_or_morbidity": "特定原因死亡、重大并发症或复合终点",
  "resource_use": "资源使用、住院时间或过程指标",
  "surgical_device_success": "手术或器械的成败",
  "withdrawals": "退出或脱落",
  "structure_related": "内部或外部结构相关结局（如影像）",
  "general_physical_health": "一般身体健康指标",
  "adverse_events": "不良事件",
  "infection_new_disease": "感染或新发急慢性疾病",
  "signs_symptoms": "体征症状（病情持续或结束）",
  "pain": "疼痛",
  "quality_of_life": "生活质量或功能（二分类）",
  "mental_health": "心理健康指标",
  "biological_markers": "生物标志物（二分类）",
  "subjective_various": "其他主观结局"
})

/** The generic prior of the paper's null regression model: a future meta-analysis in a general healthcare setting. [mean, sd] of log(tau^2). */
export const VCR_TURNER_2015_GENERIC = Object.freeze([-2.56, 1.74])

/** Table IV: outcome type -> comparison type -> [mean, sd] of log(tau^2). */
export const VCR_TURNER_2015_PRIORS = Object.freeze({
  all_cause_mortality: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-3.95, 1.34]), pharmacological_vs_pharmacological: Object.freeze([-4.18, 1.41]), non_pharmacological_vs_placebo: Object.freeze([-4.17, 1.55]), non_pharmacological_vs_pharmacological: Object.freeze([-2.92, 1.02]), non_pharmacological_vs_non_pharmacological: Object.freeze([-3.5, 1.26]) }),
  obstetric: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-3.52, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-3.75, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-3.74, 1.91]), non_pharmacological_vs_pharmacological: Object.freeze([-2.49, 1.5]), non_pharmacological_vs_non_pharmacological: Object.freeze([-3.08, 1.68]) }),
  cause_specific_mortality_or_morbidity: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-3.71, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-3.95, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-3.93, 1.91]), non_pharmacological_vs_pharmacological: Object.freeze([-2.68, 1.51]), non_pharmacological_vs_non_pharmacological: Object.freeze([-3.27, 1.68]) }),
  resource_use: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.34, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-2.58, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-2.56, 1.91]), non_pharmacological_vs_pharmacological: Object.freeze([-1.31, 1.5]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.9, 1.68]) }),
  surgical_device_success: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.14, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-2.37, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-2.36, 1.91]), non_pharmacological_vs_pharmacological: Object.freeze([-1.11, 1.5]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.69, 1.68]) }),
  withdrawals: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.99, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-3.23, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-3.21, 1.91]), non_pharmacological_vs_pharmacological: Object.freeze([-1.96, 1.51]), non_pharmacological_vs_non_pharmacological: Object.freeze([-2.55, 1.68]) }),
  structure_related: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.71, 1.74]), pharmacological_vs_pharmacological: Object.freeze([-2.94, 1.79]), non_pharmacological_vs_placebo: Object.freeze([-2.93, 1.92]), non_pharmacological_vs_pharmacological: Object.freeze([-1.67, 1.51]), non_pharmacological_vs_non_pharmacological: Object.freeze([-2.26, 1.68]) }),
  general_physical_health: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.29, 1.53]), pharmacological_vs_pharmacological: Object.freeze([-2.53, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.51, 1.72]), non_pharmacological_vs_pharmacological: Object.freeze([-1.26, 1.25]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.85, 1.46]) }),
  adverse_events: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-1.87, 1.52]), pharmacological_vs_pharmacological: Object.freeze([-2.1, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.1, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-0.84, 1.24]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.43, 1.45]) }),
  infection_new_disease: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.49, 1.52]), pharmacological_vs_pharmacological: Object.freeze([-2.73, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.71, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-1.46, 1.24]), non_pharmacological_vs_non_pharmacological: Object.freeze([-2.05, 1.45]) }),
  signs_symptoms: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.06, 1.51]), pharmacological_vs_pharmacological: Object.freeze([-2.29, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.28, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-1.03, 1.24]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.61, 1.45]) }),
  pain: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-1.83, 1.52]), pharmacological_vs_pharmacological: Object.freeze([-2.06, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.05, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-0.8, 1.25]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.38, 1.45]) }),
  quality_of_life: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.54, 1.54]), pharmacological_vs_pharmacological: Object.freeze([-2.78, 1.6]), non_pharmacological_vs_placebo: Object.freeze([-2.77, 1.73]), non_pharmacological_vs_pharmacological: Object.freeze([-1.51, 1.27]), non_pharmacological_vs_non_pharmacological: Object.freeze([-2.1, 1.47]) }),
  mental_health: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.12, 1.53]), pharmacological_vs_pharmacological: Object.freeze([-2.35, 1.6]), non_pharmacological_vs_placebo: Object.freeze([-2.34, 1.72]), non_pharmacological_vs_pharmacological: Object.freeze([-1.09, 1.27]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.67, 1.47]) }),
  biological_markers: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-1.77, 1.52]), pharmacological_vs_pharmacological: Object.freeze([-2.0, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-1.99, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-0.74, 1.24]), non_pharmacological_vs_non_pharmacological: Object.freeze([-1.33, 1.45]) }),
  subjective_various: Object.freeze({ pharmacological_vs_placebo: Object.freeze([-2.7, 1.52]), pharmacological_vs_pharmacological: Object.freeze([-2.93, 1.58]), non_pharmacological_vs_placebo: Object.freeze([-2.92, 1.71]), non_pharmacological_vs_pharmacological: Object.freeze([-1.67, 1.25]), non_pharmacological_vs_non_pharmacological: Object.freeze([-2.26, 1.45]) }),
})

export const VCR_BARTOS_2023_SOURCE = Object.freeze({
  citation: 'Bartos F, Otte WM, Gronau QF, Timmers B, Ly A, Wagenmakers E-J. Empirical prior distributions for Bayesian meta-analyses of binary and time to event outcomes. arXiv:2306.11468v1, 20 June 2023 (preprint; its publication status was not checked)',
  place: 'Section "Results": the priors estimated on the complete data sets (the hierarchically pooled ones for log OR, log RR and RD; the maximum-likelihood ones for log HR)',
  data: 'the Cochrane Database of Systematic Reviews: binary outcomes (about 484,000 results in 97,500 comparisons) and time-to-event outcomes (8,149 results in 1,515 comparisons)',
  prior: 'tau itself, not tau-squared: inverse-gamma(shape, scale), or a half-normal (Normal+) for the risk difference',
  caution: 'the log hazard ratio prior rests on 225 comparisons only, so it is the least certain of the four',
})

/** The four general heterogeneity priors of Bartos et al. (2023), keyed by effect scale. */
export const VCR_BARTOS_2023_EFFECT_SCALES = frozen(['log_odds_ratio', 'log_risk_ratio', 'risk_difference', 'log_hazard_ratio'])
export const VCR_BARTOS_2023_EFFECT_SCALE_LABELS_ZH = Object.freeze({
  log_odds_ratio: '对数比值比', log_risk_ratio: '对数风险比', risk_difference: '风险差', log_hazard_ratio: '对数风险比（生存）',
})
export const VCR_BARTOS_2023_PRIORS = Object.freeze({
  log_odds_ratio: Object.freeze({ kind: 'inverse_gamma', shape: 1.77, scale: 0.55 }),
  log_risk_ratio: Object.freeze({ kind: 'inverse_gamma', shape: 1.51, scale: 0.23 }),
  risk_difference: Object.freeze({ kind: 'half_normal', scale: 0.10 }),
  log_hazard_ratio: Object.freeze({ kind: 'inverse_gamma', shape: 2.42, scale: 0.30 }),
})

export const VCR_VAN_ZWET_2023_SOURCE = Object.freeze({
  citation: 'van Zwet E, Gelman A, Greenland S, Imbens G, Schwab S, Goodman SN. A New Look at P Values for Randomized Clinical Trials. NEJM Evidence 2023;3(1). doi:10.1056/EVIDoa2300003',
  place: 'Table 1 (the mixture), Table 2 and Table 3 (the quantities derived from it, by P value)',
  data: 'the z statistics of the primary efficacy outcome of 23,551 randomized trials of the Cochrane Database of Systematic Reviews',
  note: 'the reference population is every kind of intervention and trial size in the database, so it can shrink a sponsor-run confirmatory trial more than it deserves',
})

/**
 * Table 1: the z statistic of a trial of the Cochrane Database is a mixture of four zero-mean normal distributions. `sdZ` is the standard
 * deviation of the z statistic, `sdSnr` the standard deviation of the signal-to-noise ratio (true effect over standard error): the z statistic is
 * the signal-to-noise ratio plus standard normal noise, so sdSnr = sqrt(sdZ^2 - 1).
 */
export const VCR_VAN_ZWET_2023_MIXTURE = Object.freeze({
  trials: 23551,
  proportion: frozen([0.32, 0.31, 0.30, 0.07]),
  sdZ: frozen([1.17, 1.74, 2.38, 5.73]),
  sdSnr: frozen([0.61, 1.42, 2.16, 5.64]),
})

/** Table 2 of the same paper: the same quantities for the two coarse strata of the P value, as printed (quartiles of the exaggeration, coverage, correct sign, replication). */
export const VCR_VAN_ZWET_2023_TABLE_2 = Object.freeze([
  Object.freeze({ p: [0.05, 1], proportion: 0.71, exaggeration: [0.60, 1.20, 2.66], coverage: 0.97, correctSign: 0.71, replicate: 0.13 }),
  Object.freeze({ p: [0, 0.05], proportion: 0.29, exaggeration: [1.02, 1.29, 1.92], coverage: 0.89, correctSign: 0.98, replicate: 0.60 }),
])

/**
 * Table 3 of the same paper: quantities of the Cochrane Database stratified by the two-sided P value of the trial, as printed. `exaggeration` is the
 * quartiles (25%, 50%, 75%) of the ratio of the estimated effect to the true one, `coverage` the coverage of the usual 95% interval, `correctSign` the
 * probability that the estimate has the sign of the true effect, `replicate` the probability that an exact replication has a two-sided P below 0.05 in
 * the same direction. Kept for the test that holds the engine's deterministic calculation to the paper's Monte Carlo ones.
 */
export const VCR_VAN_ZWET_2023_TABLE_3 = Object.freeze([
  Object.freeze({ p: [0.9, 1], proportion: 0.06, exaggeration: [0.06, 0.12, 0.29], coverage: 0.99, correctSign: 0.52, replicate: 0.06 }),
  Object.freeze({ p: [0.8, 0.9], proportion: 0.06, exaggeration: [0.23, 0.41, 0.89], coverage: 0.99, correctSign: 0.55, replicate: 0.07 }),
  Object.freeze({ p: [0.7, 0.8], proportion: 0.06, exaggeration: [0.39, 0.68, 1.47], coverage: 0.99, correctSign: 0.59, replicate: 0.07 }),
  Object.freeze({ p: [0.6, 0.7], proportion: 0.06, exaggeration: [0.54, 0.95, 2.05], coverage: 0.99, correctSign: 0.63, replicate: 0.08 }),
  Object.freeze({ p: [0.5, 0.6], proportion: 0.06, exaggeration: [0.67, 1.19, 2.55], coverage: 0.99, correctSign: 0.66, replicate: 0.10 }),
  Object.freeze({ p: [0.1, 0.5], proportion: 0.33, exaggeration: [0.95, 1.67, 3.59], coverage: 0.97, correctSign: 0.79, replicate: 0.15 }),
  Object.freeze({ p: [0.05, 0.1], proportion: 0.07, exaggeration: [1.06, 1.74, 3.51], coverage: 0.94, correctSign: 0.91, replicate: 0.26 }),
  Object.freeze({ p: [0.01, 0.05], proportion: 0.10, exaggeration: [1.05, 1.56, 2.81], coverage: 0.90, correctSign: 0.95, replicate: 0.37 }),
  Object.freeze({ p: [0.005, 0.01], proportion: 0.03, exaggeration: [1.04, 1.41, 2.25], coverage: 0.87, correctSign: 0.98, replicate: 0.48 }),
  Object.freeze({ p: [0.001, 0.005], proportion: 0.04, exaggeration: [1.04, 1.35, 1.95], coverage: 0.87, correctSign: 0.99, replicate: 0.58 }),
  Object.freeze({ p: [0, 0.001], proportion: 0.11, exaggeration: [1.00, 1.16, 1.44], coverage: 0.89, correctSign: 1.00, replicate: 0.86 }),
])
