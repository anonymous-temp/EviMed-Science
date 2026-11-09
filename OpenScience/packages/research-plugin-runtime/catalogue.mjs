// Product inventory; modes describe intended adapters, not installed or validated status. `id` is the historical package id and never
// changes with the name a person reads (`title`, `displayName`): the names follow the five entrances, the ids keep every installed profile and recorded call valid.
const domainCatalogue = [
  {
    "id": "virtual-trial",
    "title": "Virtual laboratory: design simulation",
    "displayName": "虚拟实验室 · 设计模拟",
    "task": "Virtual laboratory: sample size, power, dose finding; on the hosted platform also compare saved or new designs or drug hypotheses on a disease-progression model (Alzheimer ADAS-cog), search for a design, information value",
    "dataRequirement": "Design assumptions",
    "draft": true,
    "methods": [
      "design.analytic",
      "design.simulate",
      "design.confirmatory",
      "design.dose",
      "design.win_ratio",
      "design.bayesian",
      "design.grid",
      "design.assurance",
      "design.procova",
      "decision.value_of_information",
      "accrual.poisson_gamma"
    ],
    "compatibility": "Existing VCR engine method versions",
    "availableMode": [
      "standalone",
      "hosted"
    ]
  },
  {
    "id": "virtual-cohort",
    "title": "Virtual population",
    "displayName": "虚拟人群",
    "task": "Virtual population: build and check a population from stated assumptions, literature distributions or authorized records",
    "dataRequirement": "Declared assumptions or authorized records",
    "draft": true,
    "methods": [
      "profile.snapshot",
      "cohort.build",
      "population.scenario",
      "population.literature",
      "population.synthpop",
      "population.quality",
      "population.check"
    ],
    "compatibility": "Existing VCR engine method versions",
    "availableMode": [
      "standalone",
      "hosted"
    ]
  },
  {
    "id": "virtual-patient",
    "title": "Patient trajectory prediction",
    "displayName": "患者轨迹预测",
    "task": "Patient trajectories: disease progression (Alzheimer ADAS-cog), per-person forecast, drug interaction, model",
    "dataRequirement": "Model and compatible inputs",
    "draft": true,
    "methods": [
      "patients.progression",
      "patients.continuous",
      "patients.binary",
      "patients.time_to_event",
      "patients.longitudinal",
      "model.survival_fit",
      "model.prognostic_apply",
      "model.prognostic_train",
      "forecast.individualize",
      "pk.interaction"
    ],
    "compatibility": "Existing VCR engine method versions",
    "availableMode": [
      "standalone",
      "hosted"
    ]
  },
  {
    "id": "synthetic-control",
    "title": "Synthetic control arm",
    "displayName": "合成对照臂",
    "task": "Synthetic control arm: comparator construction and diagnostics from authorized observed data",
    "dataRequirement": "Authorized comparator data and estimand",
    "draft": true,
    "methods": [
      "comparator.entropy_balance",
      "comparator.propensity_weight",
      "comparator.rmst",
      "comparator.maic",
      "comparator.weighted_cox",
      "comparator.maic_time_to_event",
      "comparator.aipw",
      "comparator.covariate_sets",
      "comparator.evalue",
      "comparator.map_prior",
      "comparator.borrowing",
      "comparator.bias_analysis",
      "comparator.stc",
      "comparator.target_trial",
      "comparator.negative_control",
      "comparator.tipping_point",
      "comparator.prognostic_adjustment"
    ],
    "compatibility": "Existing VCR engine method versions",
    "availableMode": [
      "standalone",
      "hosted"
    ]
  }
]

// These deterministic evidence methods are shared services, not an additional required plugin.
export const sharedEvidenceMethods = Object.freeze(['evidence.pool', 'evidence.network', 'evidence.dose_response', 'evidence.shrinkage', 'evidence.reconstruct_km'])
export const catalogue = domainCatalogue.map((item) => ({ ...item, methods: Object.freeze([...item.methods, ...sharedEvidenceMethods]) }))
