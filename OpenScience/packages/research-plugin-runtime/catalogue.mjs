// Product inventory; modes describe intended adapters, not installed or validated status.
const domainCatalogue = [
  {
    "id": "virtual-trial",
    "title": "Virtual trial",
    "task": "Trial design and operating characteristics",
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
    "title": "Virtual cohort",
    "task": "Cohort construction and population scenarios",
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
    "title": "Virtual patient",
    "task": "Patient scenarios and model application",
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
      "model.prognostic_train"
    ],
    "compatibility": "Existing VCR engine method versions",
    "availableMode": [
      "standalone",
      "hosted"
    ]
  },
  {
    "id": "synthetic-control",
    "title": "Synthetic control",
    "task": "Comparator construction and diagnostics",
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
