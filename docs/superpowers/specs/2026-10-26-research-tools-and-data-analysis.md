# Research tools release scope, statistical analysis and the DSH bundle

Date: 2026-10-26 (Asia/Shanghai). Baseline: GitHub `main` at `9614de895903e274471f634a8db3cf2fd3592eb2`. Working branch: `codex/research-tools-data-analysis-20261026`.

## LLM-driven data-analysis agent: the governing architecture

The owner clarified that data analysis must be an LLM-driven agent, not a catalogue of calculation forms. The chosen system is **DeepSeek + the existing DSH runtime + statistical/data-analysis skills + sandboxed native Python/R tools**, inside one researcher-facing research bundle. The model understands the research goal, inspects real data, chooses and adapts an analysis, writes/executes code, inspects diagnostics, corrects failures and answers follow-ups. Scientific libraries compute the numbers. The user supplies a question and data, not a method sequence.

This is already the direction of `statistical-analysis`; retain it and improve its operating loop. The nine checked helper functions are optional components, not a closed list of permitted analyses. A small comparison stays small; a prediction problem triggers evaluation; a causal question triggers design/identification reasoning. A new interface should expose the resulting work and the conversation, not an algorithm-selection wizard. The Newcombe repair in this round is one supporting numerical fix, not the architecture or main product deliverable.

The skill now explicitly encodes that loop, reuse of matching executed results including method/code/dependency compatibility, proportional method selection, actual execution before an answer, decisive numerical cross-checks and follow-up corrections. Three added public-data agent scenarios ask for autonomous method choice, a leakage-aware malignant-probability baseline (source coding is 0=malignant, 1=benign) and an mm-to-cm correction over preserved state. They are evaluation specifications, **not yet live-model results**. The acceptance driver now executes follow-up prompts sequentially in the same session, captures each turn before the next changes its files, preserves run linkage and stops dependent turns on a non-acceptance or an incomplete artifact snapshot. Capture completeness, saved paths and failures are persisted per turn. Custom prompts and module-triggered runs stay single-turn. A frozen automatic prediction/unit-conversion replay judge is still planned; their grading text is explicitly criteria, not a claim of an implemented judge.

### ToolUniverse: useful optional tool supply, not the analysis runtime

The upstream project supports model-independent tool use, MCP and compact discovery, and its statistical-modeling skill is relevant as a reference. Its paper demonstrates a scientific tool ecosystem, not clinical validation of an EviMed statistical agent. [Official repository](https://github.com/mims-harvard/ToolUniverse), [paper](https://arxiv.org/abs/2509.23426), [statistical modeling skill](https://github.com/mims-harvard/ToolUniverse/blob/main/plugin/skills/tooluniverse-statistical-modeling/SKILL.md).

The current repository already has an optional ToolUniverse sidecar (Dockerfile pin 1.4.1), a workload-authenticated bridge and a bounded catalogue. Its profile enables `pubmed`, `EuropePMC`, `clinical_trials`, `fda_drug_label` and compact discovery; it does **not** currently declare a general local-statistics ToolUniverse backend. The statistical capability's two declared MCP tools are dataset semantics and numerical rendering. A configured sidecar is not evidence that all upstream statistical tools are available to that capability.

Recommendation: first reuse native Python/R for supplied data and retain ToolUniverse for admitted source/knowledge operations. If a missing scientific tool has a demonstrated advantage, test its exact pinned schema, numerical outputs, dependency/permission/data boundary, resource use and failure behavior, then expose that bounded module through the existing bridge. Do not load the whole upstream catalogue into every prompt, give the runtime provider keys, or send patient-level tables to a remote tool just to run ordinary regression. Do not copy upstream auto-update/install instructions into a serving runtime. One orchestrator remains DSH, one analytical owner remains the DeepSeek agent.

## Decision and evidence boundary

The owner selected twelve Research Tools entries: clinical evidence synthesis, topic selection, statistical analysis, drug safety, comprehensive drug evaluation, formulary selection, off-label analysis, peer review, grant development, Meta analysis, Mendelian randomization and bibliometrics. Retain all twelve. Their inclusion is a product decision, not a new scientific validation claim.

Remove other entries from the ordinary Research Tools discovery surface, including the embedded virtual-clinical method catalogue and its reference-trial link. Preserve the VCR module, executable capabilities, contracts, historical studies and files. Specifically hide the standalone dataset-scoping, evidence-appraisal, gene-expression and manuscript-section entries through each manifest's `display.listed: false`. This changes the shared catalogue consumed by Research Tools, the extension centre and the native workflow index. It does not revoke an existing conversation binding or delete an engine. A later decision to disable execution or retire data would be a separate change.

The original desktop checkout had 909 fewer commits than fetched main and unrelated uncommitted design work. This assessment uses a separate worktree from fetched main; it does not include that brand work or the draft VCR PR. GitHub PR [#17](https://github.com/anonymous-temp/EviMed-Science/pull/17) was open and draft when checked, with further enabled-account and integration validation explicitly outstanding. Historical memory was used only to locate this issue; the PR and current code were re-read.

This is a code, retained-artifact and literature audit, with local deterministic tests. No production rollout, live paid-model benchmark, clinical validation or new external-data certification was performed in this round. September acceptances below are historical evidence, not October-wide reliability estimates. Several ledger notes append newer outcomes without removing older sentences; read their final dated outcome and the underlying artifact rather than treating the first sentence or `accepted` flag as the whole story.

## What exists now

There are 30 capability packages: 25 public and 5 internal. Before this change, 16 public packages were listed on Research Tools. Four GEO and five VCR capability cards were already unlisted, but `CapabilitiesPage.tsx` separately loaded `getVcrModels` and displayed seven VCR task families. That second path explains why VCR still appeared despite the capability-card flags. The new list has exactly the twelve owner-selected workflows.

The five internal packages serve source understanding, method distillation, method relationships, tool building and evolution scouting. They are platform work, not ordinary catalogue choices. The change does not expose them.

Three different objects must not be counted as if they were equivalent:

- A capability is a research workflow and its deliverable contract.
- An MCP/native tool is an operation available to a model.
- A DSH bundle is an installation/composition unit that can carry multiple plugin rows, skills and capability manifests.

Current implementation already combines one DSH socket composition, shared domain contracts, a research MCP server and independent specialist engines. It is much closer to a unified research bundle than to twelve unrelated agents installed separately.

## Twelve retained workflows: evidence, gaps and next iteration

“More established” below means stronger observed evidence within this repository. It is not a publication-ready or clinical-use certification.

| Retained workflow | Current evidence | Material remaining gap | Next useful iteration |
| --- | --- | --- | --- |
| Clinical review | v2.17.1; Sept 28 retained delivery: 43 KB report, eight sources, 66 claims; four reviewer findings repaired | Nineteen number-to-quote notices and one attribution notice remained; source access and current-guideline coverage vary | Claim-level source/status update checks, study/report de-duplication, explicit narrative/systematic scope, evidence-linked numerical rendering, multi-topic repeat evaluation |
| Research topics | v1.4.0; Sept 28 constrained-cohort rerun delivered; reviewer findings fell from 37 to six, five repaired and none unanswered | Institutional feasibility, event counts and accessible datasets still need explicit constraints; one topic family does not establish general novelty quality | Use a shared dataset profile, resource constraints, existing-study/registration check and an executable analysis outline per candidate; evaluate genuinely different domains |
| Statistical analysis | v1.2.0 baseline; a retained WDBC production comparison independently reproduced; nine reference-checked helper functions | Only one stored capability-level live case; sequential transforms/native-R briefs not closed in the ledger; predictive/causal/longitudinal coverage is not productized | Highest priority: durable analysis state, appropriate uncertainty, repeated-measure/missingness support, model validation, fresh multi-turn public-data acceptance |
| Drug safety | v1.3.1; deployment E2E repeats this line; Sept 27 osimertinib run used the real specialist | Some prose numbers/reviewer notices remain; spontaneous reports are neither incidence nor causal effects; changing public source availability | Reproducible FAERS releases, duplicate/suspect-role handling, sensitivity analyses and complete table-to-prose number binding |
| Comprehensive evaluation | v2.5.1; Sept 28 verified package after source-snapshot fix; six reviewer findings repaired, sixteen advice suggestions explicitly not taken | Prices, reimbursement, jurisdiction and comparator scope can be incomplete; no universal score is justified | Evidence table by outcome/time window, versioned local economic assumptions, no invented zeros, concise decision rationale |
| Drug selection | v2.4.0; Sept 27 delivery invoked the deterministic scoring tool and repaired two findings | Ranking depends on comparable data, the supplied rubric and weight assumptions | Weight sensitivity, missingness bounds, non-comparable options separated, preserve disaggregated dimensions |
| Off-label analysis | v2.5.0; one retained Sept 9 accepted delivery | Exact product, label edition, population, dose, route and jurisdiction determine whether use is off-label | Versioned label comparison, separate regulatory status from evidence support, stronger source coverage and cross-scenario tests |
| Peer review | v1.0.2; Sept 27 review of a real 34-page manuscript used the specialist and recalculation | One real case cannot establish recall/precision across study types; rubric compliance is not originality assessment | Benchmark known methodological/statistical errors by study type, distinguish missing reporting from flawed conduct, anchor every criticism |
| Grant development | v1.1.0; Sept 9 seven-file delivery | One guide date was stated as fact despite being an assumption elsewhere; funder fit and investigator feasibility need evidence | Current call extraction, hard requirement traceability, feasibility and milestones, dated call-specific cases |
| Meta analysis | v1.1.4; Sept 28 numerical synthesis: two multi-arm RCTs/three contrasts, REML/HKSJ/shared-control covariance, MD -251.06 mL | Five RCTs included but only two pooled; screening relevance caps and independent-verifier failures lost evidence; engine manuscript still had release issues | Separate assisted synthesis from “fully automated manuscript”; close screening accounting, extraction verification, multi-arm/missing-precision paths and full-text acquisition |
| Mendelian randomization | v1.2.0; token-free GWAS Catalog BMI/CAD run, 64 variants in IVW, estimates matching engine outputs | Distance pruning is not LD clumping; Steiger/outlier-corrected output incomplete; ancestry/LD panels/OpenGWAS credentials change applicability | Explicit ancestry and instrument QC, genuine LD route where available, harmonization and sensitivity tests, uploaded-summary and authenticated public-source acceptance |
| Bibliometrics | v1.1.1; real artifacts and multiple delivered runs | Retained case used a truncated 2023–2026 corpus for a 2015–2025 question; one reported theme percentage was contradicted by recomputation | Prove search/date coverage and pagination, rebuild/retest corrected dependencies, count-based rendering, corpus-size/coverage notices; retain as selected but do not call its old case clean |

Evidence appraisal and dataset scoping remain useful internal methods. Removing their standalone discovery rows is consolidation, not a judgment that all of their calculations are invalid. Gene-expression analysis has a narrow Welch/BH scope, explicitly not limma; removing its entry avoids presenting a limited workflow as a broad omics product. Manuscript-section drafting remains available through ordinary writing and specialist composition.

## Statistical analysis: code-level assessment

### Existing strengths

`capabilities/statistical-analysis/SKILL.md` already instructs the model to identify the estimand, independent observation unit, outcome/event coding, missing data and repeated measurements. It integrates `dataset_semantics` for dictionaries, keys, units, transformations, denominator drift, joins and time leakage. `research_calculate(action=render)` binds report numbers to executed results. `run_analysis.py` records source/script hashes, library versions, invocation and observed outputs, supports native Python/R and links follow-up attempts. Partial results remain deliverable.

`analysis_methods.py` provides nine reusable functions: continuous-group comparison (Welch/Student/paired/Mann–Whitney), covariate balance, contingency tables, OLS, logistic regression, Kaplan–Meier, log-rank, Cox and multiplicity adjustment. It already reports many missingness, separation, repeated-subject, collinearity and proportional-hazard limitations. This is a real analytical foundation, not a prompt-only calculator.

The baseline image pins numpy 2.2.6, scipy 1.15.3, pandas 2.2.3, scikit-learn 1.6.1 and statsmodels 0.14.6; lifelines is also installed. New model packages should not be installed opportunistically during a research turn. Their dependencies and model artifacts require an independently reproducible build.

### Gaps that matter before adding more algorithms

1. **Analysis state:** instructions require persistent splits and transforms, but the product needs a first-class, resumable analysis object linking dataset versions, decisions, code, fitted state and results. Do not create a second competing dataset-semantics registry.
2. **Input quality:** consistent typed checks for non-finite values, units, dates, censoring, duplicate subjects, categorical coding and invalid parameters across all helpers. Do not silently convert an unavailable calculation to a zero or a successful null estimate.
3. **Missing data:** listwise deletion is common in the helper. Add design-specific missingness reports, MICE with pooled uncertainty, and sensitivity analyses, rather than a universal median-imputation button.
4. **Model diagnostics:** a diagnostic p value alone does not prove an assumption. Include effect plots, influential observations, nonlinear terms, separation and small-event behavior; retain qualified results.
5. **Prediction:** no reusable validated pipeline in this helper for grouped/time/external splitting, nested tuning, calibration, threshold selection, decision curves, subgroup performance and drift. Native code can perform these tasks, but this does not prove they form a reliable product workflow.
6. **Causal inference:** adjusted associations are not automatically causal. The analysis object must record intervention, population, follow-up, estimand, adjustment set, overlap and identifying assumptions before invoking AIPW/DML/TMLE.
7. **Longitudinal/survival:** add GEE/mixed models, competing-risk cumulative incidence and RMST, with matching endpoint/censoring assumptions. Do not force every time-to-event question into proportional hazards.
8. **Acceptance:** baseline statistical harness had three public-data briefs; the ledger links only the WDBC comparison as live acceptance. A retained independent check reproduces its main Welch result but also shows a threshold-interval discrepancy. Test execution, numerical agreement and scientific interpretation need separate measures.

### First implemented numerical improvement

The contingency helper previously used an uncorrected Wald risk-difference interval. With `[[0,5],[5,0]]` it returned `[-1,-1]`; with `[[3,1],[1,3]]` its upper limit exceeded 1. It now reuses the installed statsmodels Newcombe/Wilson implementation and labels the interval method. The risk difference always uses original observed counts even when the user requests a 0.5 continuity correction for ratios. Invalid confidence levels return a named unsupported result before computation. The method record is 1.1.0 and the capability is 1.3.0.

This is a defensible first repair, not completion of the entire data-analysis roadmap. The interval is for independent binomial groups; clustered, paired or survey-weighted rates need a different analysis. Empty margins retain the existing explicit unsupported behavior. [Newcombe 1998](https://pubmed.ncbi.nlm.nih.gov/9595617/); [statsmodels API](https://www.statsmodels.org/stable/generated/statsmodels.stats.proportion.confint_proportions_2indep.html).

## Recommended data-analysis programme

The user journey should be one native conversation with an analysis workbench: input data and question → observed schema/units/independent unit → plan and assumptions → executed results/tables/figures → follow-up or sensitivity analysis → reproducible export. Reuse the existing file viewer and native right pane. Show useful inputs, outputs and limitations, not tool names or a separate statistics form for every algorithm.

| Order | Delivery | Reuse | Acceptance evidence |
| --- | --- | --- | --- |
| 1: dependable foundation | Dataset/version binding; analysis object; standard diagnostics; numeric-to-prose rendering; replayable export | dataset_semantics, run_analysis.py, research_calculate, pandas; optional DuckDB for larger tables | Fresh-process replay; method/code/dependency compatibility; immutable source hash; interrupted-run recovery; units/labels corrected once and retained; no PHI in logs |
| 2: clinical research workhorse | Descriptives/Table 1, contrasts, GLM, restricted splines, mixed/GEE, missing-data sensitivity, KM/Cox/RMST/competing risks | statsmodels, scipy, survival, mice, established R implementations | Reference comparisons per estimand and tie/variance choice; sparse/zero/event-code/repeated-person controls; plots match computed arrays |
| 3: prediction and validation | Logistic/regularized baseline, tree boosting, calibrated probabilities, group/time/external evaluation | scikit-learn Pipeline; CatBoost/XGBoost as separately pinned optional backends | All fitted transforms inside training folds; thresholds not optimized on test; calibration intercept/slope/Brier/ROC/PR with uncertainty; subgroup/time-transfer checks |
| 4: causal research | ATE/ATT, overlap/balance, AIPW, cross-fitted DML, heterogeneous effects, unmeasured-confounding sensitivity | DoubleML/EconML or R grf; keep study design explicit | Known-effect simulations, overlap failure, negative controls; never equate a predictor's SHAP attribution with a causal effect |
| 5: advanced candidates | TabPFN and conformal intervals/sets; survival forests; Bayesian models where useful | Upstream implementations, licensed pinned weights, isolated compute | Compare with simpler baselines at matched data/split/budget; external calibration, computational cost, reproducibility and license review; opt-in experimental status |

These are dependency-ordered work packages, not a commitment to install every library. Scope each increment to a small number of real studies and expand only when the output improves. Method selection remains contextual; unsupported operations explain their limitation and preserve successful analyses. Product release decisions are separate from run delivery: no new blanket clinical approval gate.

After the six retained/new agent briefs, expand the acceptance set to at least twelve scenarios: two-group public data, sparse binary rates, repeated subjects, longitudinal missingness, logistic separation, ordinary Cox, non-PH/competing events, training-only transformations over multiple turns, grouped prediction, temporal prediction, an external test cohort, and a causal known-effect simulation. For every scenario score numerical truth, method/estimand consistency, uncertainty, source/state lineage, prose fidelity, repeatability, user recovery and time/cost separately. Use deterministic reference computations first; an LLM reviewer cannot be the sole oracle. [InfiAgent-DABench, ICML 2024](https://proceedings.mlr.press/v235/hu24s.html) is useful for agent/task evaluation, but biomedical design and safety need the additional controls above.

## Technical literature and frontier algorithms

| Source | What it contributes | EviMed decision |
| --- | --- | --- |
| [scikit-learn common pitfalls](https://scikit-learn.org/stable/common_pitfalls.html) | Pipelines and training-only preprocessing prevent common leakage | Build this into the reusable evaluation workflow, not only skill prose |
| [mice, JSS 2011](https://www.jstatsoft.org/article/view/v045i03) | Chained-equation multiple imputation and pooling | Use for supported missing-data designs with assumptions and sensitivity; no universal imputation rule |
| [TRIPOD+AI, BMJ 2024](https://www.bmj.com/content/385/bmj-2023-078378) | Reporting for regression and machine-learning prediction studies | Produce a concise reporting appendix from actual execution fields |
| [PROBAST+AI, BMJ 2025](https://www.bmj.com/content/388/bmj-2024-082505) | Quality, bias and applicability appraisal | Use as design and review prompts; it is not an automated quality score or delivery veto |
| [Van Calster et al., BMC Medicine 2019](https://doi.org/10.1186/s12916-019-1466-7) | Calibration is essential to interpretable probabilities | Treat calibration alongside discrimination as a first-class output |
| [DoubleML, JMLR 2022](https://jmlr.org/papers/v23/21-0862.html), [guide](https://docs.doubleml.org/stable/guide/guide.html) | Orthogonal scores, sample splitting, cross-fitting and inference | Add after estimand/overlap/design objects; this does not remove unmeasured confounding |
| [Generalized Random Forests, 2019](https://www.gsb.stanford.edu/faculty-research/publications/generalized-random-forests) | Flexible heterogeneous-effect estimation with uncertainty under assumptions | Candidate for later causal modules; not a justification for automatically recommending subgroup treatment |
| [scikit-survival evaluation](https://scikit-survival.readthedocs.io/en/stable/user_guide/evaluating-survival-models.html) | IPCW concordance, time-dependent AUC and Brier metrics | Evaluate censoring-aware survival predictions, not only ordinary AUROC |
| [TabPFN, Nature 2025](https://www.nature.com/articles/s41586-024-08328-6) | Strong small-tabular-data predictive performance in the paper's benchmark regime | Add as a challenger, with fixed weights, privacy and compute boundaries |
| [Clinical comparison, BMC Medical Informatics 2026](https://link.springer.com/article/10.1186/s12911-026-03654-3) | Twelve clinical tasks compared TabPFN with twelve established ML methods; advantages over the best baseline were not universal | Benchmark on our tasks; do not replace established models just because a method is newer |
| [Test-time compute for TFMs, October 2026 preprint](https://arxiv.org/abs/2610.12005) | Adaptation/selective aggregation can improve benchmarks; naive averaging/context expansion is not consistently beneficial and costs more | Research backlog only: a preprint and benchmark result, not clinical deployment evidence |
| [Conformal prediction introduction](https://arxiv.org/abs/2107.07511) | Prediction sets/intervals with coverage under stated exchangeability conditions | Useful uncertainty layer; distinguish marginal from individual/conditional guarantees and disclose distribution-shift limitations |
| [DuckDB data import](https://duckdb.org/docs/current/data/overview) | Reusable CSV/JSON/Parquet analytical ingestion | Candidate for large files when pandas memory becomes limiting; avoid building a new SQL engine |

The strongest near-term improvement is the correctness of the analytical process. More sophisticated prediction does not repair wrong patient IDs, leakage, incompatible units, missing outcomes or a confused estimand.

## One research bundle or one plugin per tool?

**Recommendation: one researcher-facing Research bundle, composed of independently versioned capability/method modules.** This matches the owner's preference and the platform's existing direction.

The official DSH model distinguishes a profile from a bundle, and a bundle can install multiple plugin rows through its patch. Package it with the upstream `package.json` `dsh.bundle` mechanism rather than inventing a new install format. [DSH packaging guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish), [architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/).

| Option | Benefit | Cost | Recommendation |
| --- | --- | --- | --- |
| Twelve separately installed DSH plugins | Independent distribution and third-party ownership | Repeated configuration, tool collisions, version matrices, inconsistent datasets/results and confusing user choice | Reserve for genuinely independent third-party providers |
| One indivisible plugin with all logic | Simple installation | Coupled upgrades, large prompt/tool surface, one failure affecting everything | Avoid |
| One bundle, modular internals | One product/install point; shared context and provenance; modules tested and evolved independently | Requires explicit module dependencies and per-module health | Preferred |

Proposed boundary:

```text
General EviMed DSH composition
  └─ Research bundle (one product/install point; proposed package boundary)
       ├─ Shared dataset semantics, evidence identities, numerical rendering, artifacts
       ├─ Twelve capability manifests + lazily loaded method skills
       ├─ Statistics methods and optional predictor/causal backends
       ├─ MCP/tool adapters → existing specialist services
       └─ Module status, version/digest, test fixtures and compatibility checks

VCR module → its own context and workflows → reusable methods where appropriate
```

Keep `harness-port` as the only importer of `@deepseek-ai/*`. Keep general office/data tasks outside compulsory medical prompts. A unified bundle does not mean every task gets every tool, every input goes to every engine, every service shares process state, or every method shares one version. Preserve the project's runtime isolation and the control plane's credential boundary. Change module enablement for new turns or after ongoing work completes; retain the exact capability and method versions on historical results.

A dedicated `@evimed/research-bundle` is a proposed future packaging boundary, not a package created or published in this round. Initially keep the current socket and research MCP composition, narrow the catalogue, and improve module contracts. Extract a standalone bundle only after dependency mapping, import tests on the pinned DSH, and a fresh runtime replay prove no reliance on the SaaS checkout. This avoids a packaging rewrite before the statistical quality work.

## Implemented scope and verification

- The twelve-entry shared catalogue is explicit in authored manifests, then generated; no hand-edited generated tables.
- Research Tools no longer fetches or renders VCR methods or links to its trial-reference page.
- The other four capability records stay available for historical display and internal composition; VCR/GEO remain in their own modules.
- Statistics now has an explicit LLM-driven operating loop and three new agent-level evaluation scenarios, in addition to Newcombe-Wilson intervals, original denominators and confidence-level validation.
- Failure-first tests reproduced two catalogue defects and five interval/parameter cases before the implementation.
- Local verification so far: Research Tools/icons/extension-centre tests 61/61; statistical suite 98/98; display/statistical/server contracts 20/20 including the Python integration; native frame 5/5; socket guidance 7/7; web typecheck and changed-file ESLint passed. The Web build also passed with existing large-chunk warnings. Generated manifests pass their consistency check. Independent Python review also exercised 544 valid small contingency tables and variable confidence levels.
- The acceptance driver now covers same-session follow-ups, per-turn capture and lineage, failure/timeout stopping and throwaway-account cleanup; 20/20 driver tests pass. Automatic replay judges for the new prediction and unit-correction scenarios remain planned and are labelled as such.
- Remaining release proof: current deployed images, native-browser walkthrough, a fresh DSH public-data run on the new statistics capability, repeated/multi-turn analysis cases, and the larger method roadmap. The older September evaluation is not relabelled as acceptance of v1.3.0.

Primary code evidence: `apps/web/src/app/routes/CapabilitiesPage.tsx`; `capabilities/*/capability.yaml`; `packages/domain/src/capability-display.json`; `evals/acceptance-ledger.json`; `capabilities/statistical-analysis/scripts/{analysis_methods.py,analysis_method_records.json,run_analysis.py}`; `evals/statistical-analysis/{briefs.json,test_methods_reference.py,results/2026-09-30-statistics-001-wdbc-group-comparison-run2/}`; `packages/socket/{package.json,src/guidanceText.mjs}`; `deploy/runtime-dsh/install-runtime.sh`.
