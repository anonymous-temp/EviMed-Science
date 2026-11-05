# Context: what EviMed 虚拟临床研究 (VCR) has today

Read from branch `codex/vcr-remediation-20261101` (cde64eddc), 2026-11-02. Not deployed.

## Product
A to-C agent platform (DeepSeek + DSH agent kernel) with a virtual clinical research module of four tasks: 患者匹配 (patient-trial matching), 人群与患者 (populations and virtual patients), 对照研究 (external/synthetic control comparisons), 虚拟试验 (trial design and simulation). The model reads language, chooses methods and fills parameters; every number comes from a deterministic R engine.

## Engine constraints (any candidate method must fit or say why not)
- R 4.3.3, packages pinned to a dated CRAN snapshot (2026-09-28); no network at run time; no GPU; shared four-core host, concurrency of one job; each job has CPU and memory limits. A Python FastAPI wrapper exists (pyarrow only), and Python can run in a disposable intake container.
- Runtime library in use: base stats, survival, nlme, mvtnorm, synthpop (with ranger, randomForest, party in its closure). Everything else is hand-written R after the paper, cross-checked in CI against rpact, gsDesign, WeightIt, cobalt, survRM2, EValue, RBesT, metafor, flexsurv, nlme. rstan is in the CI-only library, not at run time.
- Every simulated number carries a Monte Carlo standard error; same seed gives identical results.

## The 35 engine methods
Models: model.survival_fit (parametric survival, base survreg); model.prognostic_apply (applies a published equation the user supplies; no platform-shipped validated clinical models).
Data and populations: profile.snapshot; cohort.build (rule waterfall); population.scenario (declared marginals + Gaussian copula); population.literature (published baseline table, assumed correlations); population.synthpop (sequential CART); population.quality (utility, replication, membership AUC); population.check (SMD against second baseline table).
Virtual patients: patients.continuous; patients.binary; patients.time_to_event (Bender 2005 inversion: Weibull, piecewise); patients.longitudinal (linear mixed model, MCAR monotone dropout).
Evidence: evidence.pool (random-effects pooling, checked against metafor); evidence.reconstruct_km (Guyot 2012). Separate Python KM figure digitizer, classical image processing, calibration stated by the model.
Comparators: comparator.entropy_balance; comparator.propensity_weight; comparator.rmst; comparator.maic (Signorovitch; NICE DSU TSD 18); comparator.maic_time_to_event (unanchored and anchored); comparator.evalue (VanderWeele & Ding 2017); comparator.map_prior (Neuenschwander; robust MAP, normal-normal hierarchical, checked against RBesT); comparator.weighted_cox (with Grambsch-Therneau PH test); comparator.aipw (Bang & Robins 2005, continuous and binary only); comparator.covariate_sets; comparator.negative_control (Lipsitch 2010, Schuemie 2014 empirical calibration); comparator.tipping_point (Jackson 2014); comparator.prognostic_adjustment (FDA 2023 covariate adjustment guidance, standardisation).
Design: design.analytic (two-arm fixed Lachin-Foulkes, group sequential with alpha spending, Simon 1989 two-stage, single-arm); design.simulate (Monte Carlo incl. piecewise hazards, log-rank, MaxCombo per Karrison 2016 / Lin 2020); design.grid; design.assurance (O'Hagan 2005, incl. group sequential); design.procova (EMA 2022 qualification); accrual.poisson_gamma (Anisimov & Fedorov 2007).
Matching: matching.evaluate (Kleene three-valued logic over criteria).

## Matching outside the engine
The model extracts facts with character spans from notes and parses criteria; code re-reads the span and combines by Kleene logic. Retrieval: three registries queried (ClinicalTrials.gov, CTIS, ChiCTR), merged, filtered by closed tables over structured fields, no ranking. No trained NLP model, no embedding retrieval or reranking in matching. Precedent similarity for evidence is word overlap.
n2c2 2018 Track 1, 162 held-out train patients: 62% unknown; strict accuracy 0.355; reading unknown as not-met 0.749 (majority baseline 0.765); micro F1 under annotators' convention 0.869; when decided about 0.87 right. Date-window criteria mostly unknown.

## Knowledge
Three curated disease packs (NSCLC, breast cancer, type 2 diabetes): terms, phenotypes, endpoints, criteria, mappings. Field mapping from FHIR R4, OMOP CDM, ADaM exists.

## Known gaps already found
- Plain requests often bypass the module: the model writes its own script.
- `IPDfromKM`, `simsurv`, `simstudy` are labelled as cross-checks in the registry but are not run in tests.
- MaxCombo not compared against simtrial or gsDesign2 (not in the locked library).
- No disease-mechanism model, no trained prognostic model, no digital twin generator.
- Clinical correctness not validated.

## Owner rulings that bound recommendations
- The model never does statistics; regex never does language; no new approval gates, forms or mandatory human steps; a verdict never withholds a delivery.
- Reuse mature upstream with the narrowest adapter before writing your own. General first; medical methods load only when relevant.
- No recruitment or patient-contact workflow. CDE and ICTRP registries are not reopened.
- Compliance and copyright are not blockers the owner wants raised, but a licence that prevents commercial use must be stated plainly as a fact.
