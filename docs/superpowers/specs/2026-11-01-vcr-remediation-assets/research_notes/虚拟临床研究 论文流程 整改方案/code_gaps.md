# VCR code against published workflows: gap table (github/main 77ba0a436, 2026-11-01)

**How this was checked.** All code read through `git show` / `git grep` at `github/main` 77ba0a436. Nothing was run or rendered: no tests, R, database or browser. So every UI statement is "the code would draw this", not an observation. Production flags were not read. Of the five research notes I read every Takeaway and Inferences section, plus the full cross-pipeline synthesis sections and targeted findings; I did not read every cited finding line by line.

**Path shorthand.** S = `OpenScience/apps/server/src`; W = `OpenScience/apps/web/src`; D = `OpenScience/packages/domain/src`; M = `OpenScience/runtime/mcp/evimed-research`; C = `OpenScience/capabilities`; G = `项目代码/vcr-engine/R`; E = `OpenScience/evals`.

**Classes.** DONE = works in the user's path. UNREACHABLE = built, but the default user or model path does not use or show it. PARTIAL. MISSING. OUT = deliberately out of scope, ruling named.
**Markers.** [code] is enforced behaviour. [skill] is a sentence the model may or may not follow.
**Sizes.** S under a day, M a few days, L a week or more (rough).

## 0. What stands out

1. The engine and its honesty layer are strong. The gaps sit before it (recall, feasibility, target-trial record, dry run) and after it (the result page is hard to reach, diagnostics stay in `diagnostics`).
2. Much is built and only runs if asked: E-value, negative controls, tipping point, design grid, simulation report, and the MAP operating-characteristics table, which no view reads at all.
3. Rules the literature treats as method exist here only as skill sentences: null scenario, E10 suitability, target trial, read-back, assumption echo.
4. Not implemented anywhere: benchmark design, non-proportional effect or MaxCombo, a hybrid (randomised plus borrowing) design kind, independent validation of a literature population, local calibration of an applied published model, per-criterion evidence retrieval, DELTA2 role on an assumption.
5. Skill text contradicts code in at least two places (§6), and a typical design task reads about 80,000 characters of skill text before its first object.

## 1. Matching

| Step | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| Narrowing and recall | PARTIAL | No platform recall stage; the model searches freely. `clinical_trial_search` passes a free `query` to CT.gov `query.term` (M/public_sources.py:1868-1878), with status, phase and year filters (M/server.py:656-668). [skill] "凭诊断、分期、生物标志物、年龄、性别和地区挑" (C/vcr-matching/SKILL.md:165). No dense or fusion step (no embedding/top-k in matching files). A separate multi-registry search (CT.gov + ChiCTR + CTIS, S/vcrEvidence.mjs:1250-1297) feeds the page panel `VcrReferenceSearch`, not this tool. | One read action returning a merged, filtered, capped candidate list from that existing search (M) |
| Registry coverage | PARTIAL / OUT | `candidate_trial` accepts clinicaltrials.gov, chictr, ctis (S/vcrGateway.mjs:1020). ChiCTR needs a key seat (S/vcrEvidence.mjs:1195,1240). CDE and ICTRP: OUT, owner decisions 2026-09-29 "no CDE or Fierce source recovery"; [skill] C/vcr-evidence/SKILL.md:23. | None for CDE. Say coverage in the reply (S) |
| Parse once, reuse per trial version | PARTIAL | Own protocol: each write is a new version (C/vcr-protocol/SKILL.md:101). Registry trial: reusable inside one study, re-judge with `subjectKeys` only (C/vcr-matching/SKILL.md:178; S/vcrGateway.mjs:1041). Keyed by `(study_id, registry, registry_id)`, and criteria overwrite by ordinal (S/vcrCandidateTrialStore.mjs:139,165). `record_hash` is stored, but criteria are not bound to it. A new study re-parses. | Account-level parsed-criteria table keyed by registry + record hash (M) |
| Parse quality audit | MISSING | No sampled check of parsed criteria found; research notes call this the weakest measured link. | Add parse cases to E/vcr-matching (S) |
| Per-criterion evidence from a long record | MISSING | `subject_document` is a paged read by offset (C/vcr-matching/SKILL.md:86-90); `kb_search` is forbidden for charts (:92). No per-criterion locate. Published systems use top-k chunks per criterion. | Deterministic lexical locate per `evidenceNeeded` term inside the deployment (M) |
| Batch: which step is LLM per patient | PARTIAL | Facts and language judgments are model work per subject (C/vcr-matching/SKILL.md:94,118). Verdict is code: `assessSubject`, `summarizeEligibility` (S/vcrMatching.mjs:1043,952). Frozen-batch continuation exists (:130). Selection allows 5,000 subjects (M/vcr_platform.py:311), but extraction runs in the model's turn. Not measured at scale. | Per-subject extraction pass with resumable state (L) |
| Applicability / recorded / satisfied | DONE (recorded is implicit) | [code] `state`, `applicable`, `applicabilityState` kept apart (S/vcrMatching.mjs:889-896). Unknown applicability stays applicable (:894). "Recorded" is not a stored axis: it is `unknown` plus `missing[].reason` (:897-902); reasons at D/vcrVocabulary.mjs:136-140. [skill] three questions, C/vcr-matching/SKILL.md:44. | Expose missing-reason in read-back (S) |
| Negated-fact guard | DONE | [code] quote re-read at write and at evaluation, `vcr_evidence_unverified` (C/vcr-matching/SKILL.md:110; `verifyFactEvidence` S/vcrMatching.mjs:261). Tool text states age/sex do not imply pregnancy (M/vcr_platform.py:488). | None |
| Patient-trial ranking | PARTIAL | [code] `rankPatientTrials` (S/vcrPatientTrials.mjs:257-265): eligible, then the rest by unknown + pending count, then ineligible; ties by registry status, title, id. Deterministic, nothing from a model. Unknown is an unweighted count: an unknown exclusion equals an unknown lab inclusion. A trial with few parsed criteria can outrank a fully parsed one (no share-decided term). | Add a decided-share tie-break (S) |
| Scorecard | DONE on the page; UNREACHABLE from chat | "X 条满足 · Y 条未知 · Z 条不满足" (S/vcrViewsTabs.mjs:1181,1231; W/components/vcr/tabs/PatientTrials.tsx:84). `criteriaCounts` in read-back (S/vcrPatientTrials.mjs:618). No decided percentage. | Fixes in §7 |
| Near-miss kept visible | PARTIAL | `pendingReviewExclusions` (S/vcrMatching.mjs:1150); [skill] do not remove (C/vcr-matching/SKILL.md:154). Trials judged ineligible stay listed, ranked last. | None urgent |
| Human checkpoint | UNREACHABLE / OUT | Optional 改判 exists (W/components/vcr/tabs/MatchingTab.tsx:403-407; S/vcrRoutes.mjs:218), but only on a study page. A mandatory human step is OUT: owner decisions 2026-09-29 "Never add a mandatory human adjudication step". | Link from reply (§7) |
| Reader-facing evidence in conversation | PARTIAL | [skill] verdicts copied from read-back (C/vcr-matching/SKILL.md:54; M/vcr_platform.py:487), and each 满足/不满足 quotes its sentence only in `matching-assessment.md` (:142). No enforcement on the reply. Page evidence: `ClinicalMatchingDetails`. | Short evidence block in `candidate_trials` read (S) |
| Stored evaluation and metrics | PARTIAL | Code: `patientMatchingMetrics`, `interRaterAgreement`, `runMatchingEvaluation` (S/vcrMatching.mjs:1284,1323,1393); driver E/vcr-matching/run_matching_evaluation.mjs (makes no model call and takes facts as given). Data: synthetic sample (`synthetic: true`, matching-eval-sample.json:3-5) and 12 synthetic source groups, 2 repeats: native 0.854 on 48, enhanced 0.958 on 24 (openmed-scorecard.json), `independentClinicalValidation: false`. Six briefs. No retrieval-recall metric. `realDelivery: not-run` (E/acceptance-ledger.json:541-552). The brief's "5/12" was not found in evals, PRD or the 10-25 review by my grep. | Frozen patient-grouped holdout when a labelled set exists (M, data-dependent) |
| Contact, referral, recruitment | OUT | 2026-10-25 reset (C/vcr-protocol/references/operating-contract.md:45-48; E/vcr-matching/briefs.json note). | None |

## 2. Population and virtual patients

Seven shared steps from the virtual_patients note:

| Step | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| 1 Context of use and risk | PARTIAL | `intendedUse` defaults to exploratory, and the ceiling is computed (C/vcr-protocol/SKILL.md:83; M/vcr_platform.py:192). ICH M15 style `model_assessment` with derived risk (C/vcr-analysis/SKILL.md:159-183; D/vcrModelAssessment.mjs). [skill] "每个用到的模型写一条", not enforced; incomplete records are kept (:185). Nothing for a literature population. | Write a COU stub at first object, as a notice (S) |
| 2 Source inventory with relevance | DONE for literature | [code] `literature_population` is refused without exact `baselineBindings` (S/vcrJobs.mjs:808-817; S/vcrEvidenceSources.mjs:67). The job records `marginals_source_verified`, `correlation: assumed`, `transportability: not_validated` (S/vcrJobs.mjs:821-822). Those labels are not on the page. | Show them on the population tab (S) |
| 3 Generation | DONE | S/vcrOrchestrator.mjs:775; G/population.R, G/simulators.R. | None |
| 4 Calibration kept separate | MISSING as a step | `CalibrationStrip` compares set, generated and evidence values (W/components/vcr/patients/CalibrationStrip.tsx:9-24; S/vcrRows.mjs:623-631). That checks against inputs, not a fit to a target that is then held apart. No plausible-patient selection. Synthpop has a holdout only. | Rename and add a target-distribution fit job (L) |
| 5 Independent validation | MISSING for literature/scenario; PARTIAL elsewhere | Synthpop: `holdoutShare` default 0.2 (D/vcrScenarioSchemas.mjs:500); disclosure refuses without holdout (G/quality.R:16-18). Forecast path has split evaluation (D/vcrForecastEvaluation.mjs:279), but needs an external provider or imported file. No path to test a literature population on a second published distribution. | `population_check` job against a second bound baseline table (M) |
| 6 Applicability and uncertainty | PARTIAL | [code] `vcrModelApplicabilityIssues` refuses out-of-range models (S/vcrOrchestrator.mjs:1199-1200). `parameterDraws` default 1 (D/vcrScenarioSchemas.mjs:496). `applicability = source_trial_population` is engine-only (G/population.R:377), no view reads it. | Default re-draws and show the label (S) |
| 7 Plan and report | PARTIAL / OUT for forcing | Analysis plan freeze, `model_analysis_plan`, `simulation_report`, `study_package` exist (D/vcrVocabulary.mjs:847; S/vcrOrchestrator.mjs:232-236). Only on explicit request (C/vcr-protocol/references/operating-contract.md:4-5, the 2026-10-25 reset). Seal is off under exploratory use (S/vcrSeal.mjs:14-18). | Offer a short record export on any result (M) |

**`population.quality`.** Fidelity: KS, TVD, pairwise, sPMSE, propensity AUC. Utility: feasibility pass-rate, CI overlap only if `analyses` declared, TSTR only if `tstrOutcome` declared. Privacy: replication, DCR, nearest-neighbour share, membership AUC, with a statement that it is not an anonymity claim (G/quality.R:79-102,139,194,227-282; view S/vcrViewsTabs.mjs:184-215). Runs automatically with `population.synthpop` (G/engine.R:746,770). Reachable from conversation as kind `population_quality`. It needs real training rows (D/vcrScenarioSchemas.mjs:508-511), so it does not exist for literature or scenario populations. Class: DONE for empirical synthetic; not applicable otherwise.

**Calibration or validation from conversation.** Local calibration of a generated cohort: none. Forecast evaluation: reachable through `evaluate_forecast` only if a prediction exists.

| Item | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| Correlation assumption exposed and labelled | PARTIAL | `correlation` optional, `correlationSource` default assumed (D/vcrScenarioSchemas.mjs:494-495). "Cited" is refused as unverified (S/vcrEvidenceSources.mjs:73). **No matrix means identity** (G/population.R:121), and then no `(correlation)` source row (:379) and no sensitivity run (:380-382). So the commonest path assumes independence silently. Diagnostics carry `correlationSource`, `correlationSensitivity` (G/engine.R:688-690); no reference in S/vcrViews*, or W outside a field-label file. | Treat null as declared independence; label and show it (S) |
| KM without numbers at risk | PARTIAL | `riskTable` required, min 2 (D/vcrScenarioSchemas.mjs:151,570; M/vcr_platform.py:425-439). So absence is a refusal, not a labelled degraded reconstruction, although G/reconstruct.R:20-24 says it still reconstructs. | Allow with `limited` and information level (M) |
| KM without total events | PARTIAL | `totalEvents` optional (D/vcrScenarioSchemas.mjs:571); QC silently skips that check (G/reconstruct.R:220), and a pass reads the same. No statement that HR reliability needs events and at-risk numbers. | Add `informationLevel` to diagnostics and view (S) |
| Pairing, common random numbers | PARTIAL | Real for patient generators: auto key population@version (S/vcrJobs.mjs:799-800,885-890), member-stable ids and seeds (G/rng.R:117-145), draw-stable inversion (G/simulators.R:10-16). Not for design: grid says `no_common_random_numbers_between_cells` (G/engine.R:1832; G/design_simulate.R:743), and a single scenario seed is its own hash (S/vcrJobs.mjs:885). Event-level synchronisation not verified numerically by me. | Optional shared stream across a grid's truths (M) |
| TRIPOD / PROBAST information | PARTIAL | No such vocabulary in vcrModelDocuments or vcrModelInterfaces. Card carries population, region, endpoints, time range, input range, horizon, validation, declared evidence (S/vcrModelDocuments.mjs:187-205). Source-bound coefficients and scale [code] (C/vcr-analysis/SKILL.md:420). | Add model appraisal fields to the card (S) |
| Calibration-in-the-large for applied model | MISSING | `model.prognostic_apply` has no observed-outcome comparison (G/model_prognostic.R). `calibrationInLarge` exists only in forecast evaluation (D/vcrForecastEvaluation.mjs:59). | Route applied predictions plus observed outcome through that evaluator (M) |
| What the card says before local validation | DONE | Conclusion capped `limited` and "Transportability and calibration in this target population have not been established" (G/model_prognostic.R:87,94), shown as 已知局限 (S/vcrViewsTabs.mjs:722; W/components/vcr/VcrModelRecord.tsx:129-132). | None |
| LLM as data generator | DONE by construction | [code] numbers not writable (M/vcr_platform.py:244). | None |

## 3. Comparators

| Step | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| Feasibility-first route | PARTIAL, mostly [skill] | [skill] E10 four conditions then FDA ten dimensions (C/vcr-analysis/SKILL.md:241). [code] only the data-tier gate (S/vcrOrchestrator.mjs:750-759; D/vcrVocabulary.mjs:616). E10 and dimension tables are model-written configuration (S/vcrViewsTabs.mjs:683-692,693,736) and drawn only if present (W/components/vcr/tabs/ComparatorTab.tsx:308). A hazard ratio can be produced with no recorded answer. A hard stop would break owner decision 2026-10-10 (no new gates). | Standing `suitability` record on the comparator, missing = notice and shown in the result (S) |
| Non-inferiority or modest effect leads to "not appropriate" | MISSING | Not in `VCR_NOT_ESTIMABLE_RULES` (D/vcrVocabulary.mjs:624-645). | Add code-decidable triggers as limited/notice (S) |
| Target-trial components | PARTIAL | Only `{item: free text, emulation: exact/approximate/cannot}`, optional (D/vcrScenarioSchemas.mjs:165-168,383). No required eligibility, strategies, assignment, outcome, time zero, follow-up, contrast or plan. Time zero is a column on a real cohort (:460). [code] any `cannot` gives `limited` (G/engine.R:1091-1096,1265-1285; G/aipw.R:184; G/weighted_cox.R:222). | Closed component vocabulary, notice when absent (S) |
| Target-trial record shown | PARTIAL, a defect | Two shapes. Skill example: `configuration.targetTrial[]` (C/vcr-analysis/SKILL.md:231-235). Gateway: top-level object (S/vcrGateway.mjs:1311,1316). View reads only top-level `.population/.treatment/.note` (S/vcrViewsTabs.mjs:743-746). So the skill's own shape reaches the engine but never the page. `targetTrialCannot` has no view reference found. | One shape, render it (S) |
| Overlap, balance, ESS | DONE by default | Inside the weighting job (G/engine.R:1190-1194); rows at S/vcrViewsTabs.mjs:696-703,749-754; plots W/components/vcr/tabs/ComparatorTab.tsx:201-207. | None |
| SMD pass/fail | Tension | SMD above 0.1 returns not estimable (D/vcrVocabulary.mjs:626,917; C/vcr-analysis/SKILL.md:247). Notes: 0.1 is a convention, and FDA wants a justified a priori threshold. Compare owner decisions 2026-09-29 on delivery vetoes. | Make `limited` with the value shown (S; needs a ruling) |
| Residual-confounding output | UNREACHABLE | Only E-value or negative controls, neither default. View carries the E-value caveat (S/vcrViewsTabs.mjs:726). | See next row |
| Negative controls, tipping point | UNREACHABLE | Run only if the model declares them (S/vcrOrchestrator.mjs:903-925,1159-1166; C/vcr-analysis/SKILL.md:245). Negative controls need a real column; asking the user is fair. | Skill line: propose them for any T2 estimate (S) |
| E-value | UNREACHABLE | Separate `evalue` kind with typed input; no auto stage (S/vcrOrchestrator.mjs:1159-1166 has none; S/vcrViewsTabs.mjs:712). | Auto stage after a primary binary/TTE estimate (S) |
| Anchored vs unanchored MAIC | DONE in engine | G/maic.R:101,167; G/maic_tte.R:248; D/vcrScenarioSchemas.mjs:662,705. [code] unanchored capped `limited` (G/maic.R:17-18,168). | None |
| Unanchored residual-error requirement | MISSING | Not stated anywhere: "residual" appears only in G/negative_control.R:12. Nor does a result ask for predictive-accuracy evidence. | Fixed limit sentence in the unanchored result (S) |
| MAIC target population in results | UNREACHABLE | `targetPopulation = aggregate_data_trial`, `anchored`, `unadjustedEffectModifiers` in diagnostics (G/engine.R:1419,1432). No reference in S/vcrViewsTabs.mjs or result views; only input-help text in W. | One fact row (S) |
| Outcome drift, calendar time | MISSING for external control | `era` exists only for evidence strata (S/vcrEvidence.mjs:120,471-479). Drift only in MAP OC `drifts` (D/vcrScenarioSchemas.mjs:739) and `single_arm_external.logOddsDrift` (C/vcr-analysis/SKILL.md:288). | Index-year balance row when a date column exists (S-M) |
| Freeze before outcomes | PARTIAL | [code] seal is real (S/vcrSeal.mjs), off under default `exploratory` (:14-18). Off by default is a stated rule (no approval ceremony); the package says the plan came later. | None; state it in reply (S) |
| Output classes | PARTIAL | Estimable, limited, not estimable with rule and gaps [code] (D/vcrVocabulary.mjs:624-645). No distinct "benchmark only" class; label is by route. | Add class label (S) |
| Prognostic adjustment | DONE as design | `design.procova`, `comparator.prognostic_adjustment`, T3 gate (D/vcrVocabulary.mjs:616). Not rated further. | None |

**Hybrid borrowing.** Class: UNREACHABLE for the OC table; MISSING for a real hybrid design.
- No randomised-plus-borrowing design kind: `VCR_TRIAL_DESIGNS` is single_arm, single_arm_external, two_arm_fixed, group_sequential, simon_two_stage (D/vcrVocabulary.mjs:680). `single_arm_external` is a synthetic single-arm stratified simulation (C/vcr-analysis/SKILL.md:288).
- `comparator.map_prior` has an optional `operatingCharacteristics` sub-object over drifts (D/vcrScenarioSchemas.mjs:736-743; G/map_prior.R:308-341). Its replicate default is **5,000** (G/engine.R:1524; G/map_prior.R:310). `vcrReplicatesForJob` applies no floor outside design kinds (S/vcrJobs.mjs:280-288). So zero-drift false-positive rows run at 5,000 unless the model passes `replicates`.
- The output table is written to a file (G/engine.R:1553). I found no view reading `operating-characteristics` in S/vcrViews*, ComparatorTab or the method result; W only has field labels. Prior ESS is shown (W/components/vcr/tabs/ComparatorTab.tsx:241-250).
- It does not reach design. Route `hybrid_control` runs only `map_prior` (S/vcrOrchestrator.mjs:797,1347). `trial_scenario.comparatorId` is stored (S/vcrGateway.mjs:1328-1338) and has no reference in S/vcrOrchestrator.mjs. Only survival `modelResultId` feeds design (:1388-1393). `inputsAssumed` marks unverified historical counts (:2818).
- Null floor: `VCR_REPLICATES_NULL_MIN` 20,000, alternative 5,000, cap 200,000 (D/vcrVocabulary.mjs:914-915; D/vcrEngineJob.mjs:235,430-435). Convention for reported type I error (FDA 2019, ICH E20, CDE draft) is 100,000. At p = 0.025 the 95% half-width is about 0.0043 at 5,000, 0.0022 at 20,000, 0.00097 at 100,000 (my arithmetic).
- Smallest fixes: apply the floor to map_prior and render the table (S); raise null floor or expose as an option, CPU times 5 (S); a real hybrid design kind with drift and overlap inputs (L).

## 4. Trial design

**ICH E20 §5.2 report items against the design result.**

| Item | State | Evidence |
|---|---|---|
| 1 Key questions | PARTIAL | `aim` = study question (S/vcrViewsTabs.mjs:825); `comparisonGoal` only on a grid (:943). Empty in a hidden study with no definition |
| 2 Designs evaluated, with benchmark | PARTIAL | Table yes; benchmark no |
| 3 Operating characteristics | PARTIAL | Engine: power or type I, bias, empSE, MSE, coverage, expected N/events/analyses, early stop, duration, cost (G/design_simulate.R:520-600). Page columns omit bias and coverage (S/vcrViewsTabs.mjs:881-883). Type I only if a null scenario was written |
| 4 Knowledge behind scenarios | DONE | Assumption cards, evidence, pooled prediction intervals |
| 5 Parameter ranges with justification | PARTIAL | Pooled PI and calibres on the card ([skill] C/vcr-evidence/SKILL.md:149-150,188). No check that scenarios cover the range |
| 6 DGP, replicates with rationale | PARTIAL | ADEMP "怎么生成数据" prints only numeric `truth` (S/vcrViewsTabs.mjs:829), so accrual and dropout are omitted. Count shown (W/components/vcr/tabs/TrialTab.tsx:471-477); rationale (floor, target MCSE, G/design_simulate.R:73-74) not shown |
| 7 Software, code, seed | PARTIAL | Seed, method and version in drawer (S/vcrViewsTabs.mjs:904-906; TrialTab.tsx:507-510). No example call |
| 8 Overall results | DONE | Table, power curve, heat grid |
| 9 Example single trials | MISSING | Required only inside model-written `simulation.json` (D/vcrContracts.mjs:370); engine produces none |
| 10 Limits | PARTIAL | Footnotes, stale notes; free text otherwise |
| 11 Clinical discussion | PARTIAL | Free text in reply or report only |

| Step | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| Mandatory benchmark design | MISSING | [skill] "通常写三个方案" (C/vcr-analysis/SKILL.md:251). No code. | Auto-add fixed design beside any GSD or Simon row (S-M) |
| Null scenario | PARTIAL, [skill] plus notice | [skill] "必须有一个零效应情景" (:294). [code] `vcrBuildStages` runs one simulation of the stated truth (S/vcrOrchestrator.mjs:1444), though Simon already runs both laws (:1430-1437). Only advisory in `simulation.json` (D/vcrContracts.mjs:377). So a plain two-arm result has no measured type I error. | Copy the Simon pattern to all designs (S) |
| Analytic first, simulation check | DONE | [code] S/vcrOrchestrator.mjs:1407,1444; check in G/design_simulate.R:628-660; shown TrialTab.tsx:507-510. | None |
| Monte Carlo SE shown | DONE | G/design_simulate.R:535-600; W/components/vcr/tabs/TrialTab.tsx:443-455. | None |
| Links from assumptions to results | DONE in data, PARTIAL in display | Bound cards, per-job `bound` (S/vcrOrchestrator.mjs:1113,1395-1400,2812); markers (S/vcrViewsTabs.mjs:953); card change makes stale (C/vcr-analysis/SKILL.md:331). No assumption list above the result with default flags. | Assumption strip from `bound` + defaults (S) |
| Dropout default | PARTIAL | Default 0 (D/vcrScenarioSchemas.mjs:260,270,775). A card overrides it (C/vcr-analysis/SKILL.md:331). No `dropout` reference in S/vcrViews* beyond a label, and none in W beyond field text. So default 0 is invisible, as the brief says. | Echo applied defaults in diagnostics and page (S) |
| Non-proportional hazards | MISSING | `truth.hazardRatio` is one constant (D/vcrScenarioSchemas.mjs:239; G/design_simulate.R:290,302). Piecewise is control distribution only (D/vcrScenarioSchemas.mjs:208-219). Methods logrank, rmst only (:1320). No delay, crossing, weighted log-rank, MaxCombo. RMST gives some robustness only if the effect were non-PH, which cannot be generated. | Treatment-arm piecewise HR plus MaxCombo in simulate only (M); analytic later (L) |
| DELTA2 target difference | MISSING | Card fields: key, name, endpoint, unit, note, applicability, parameter, sourceKind (S/vcrGateway.mjs:840-850); source kinds D/vcrVocabulary.mjs:706. No important vs realistic role. | Add `effectRole`, notice when absent (S) |
| Assumption provenance | DONE | [code] pooled cards not hand-fillable (S/vcrGateway.mjs:854-858). `expert_set` labelled as assumption ([skill] C/vcr-evidence/SKILL.md:184-186). | None |
| Assurance default | PARTIAL | Automatic only when the effect card has a predictive distribution; confidence basis refused (S/vcrOrchestrator.mjs:700-711,1452-1466). Else silently absent, with a "no longer shown" note only if it existed before (S/vcrViewsTabs.mjs:995). | Say why it is absent (S) |
| Trade-off table | PARTIAL | Table exists (S/vcrViewsTabs.mjs:881-887; W/components/vcr/tabs/TrialTab.tsx:404-490). Chart only with duration and assurance (:258-260). `dominated` only with a `comparisonGoal` (S/vcrViews.mjs:967). | Default a goal from alpha and target power (S) |
| Recommendation | PARTIAL by design | "The platform never picks a design" (W/components/vcr/tabs/TrialTab.tsx:85). A chosen design is a recorded decision (S/vcrGateway.mjs:1408-1415; S/vcrViewsTabs.mjs:955-962). No skill rule asks for a recommendation or says what it rests on, though the brief's §2.2 implies one. | Skill line plus constraint-basis label (S) |
| Sensitivity sweep | PARTIAL | Only on request via `design_grid` (S/vcrOrchestrator.mjs:1471). Automatic: effect-only power curve (G/engine.R:1716,1785) and pooled calibres. Control rate, dropout and accrual not swept by default. | Analytic one-at-a-time sweep in the analytic stage (M) |
| Accrual heterogeneity | UNREACHABLE by default | `accrual.poisson_gamma` exists, only if asked (S/vcrViewsTabs.mjs:928). Design default is uniform (D/vcrScenarioSchemas.mjs:254-262). | Skill line for duration questions (S) |
| Assumption audit (planned vs realised effect) | MISSING | Not found. | Fixed note from published ratios (S) |
| Trial outcome prediction score | OUT | Brief §1.2 and §6.4 "我们不做成败分"; contract: design simulation is not proof a drug works (operating-contract.md:13-14). | None |

## 5. Agent workflow

| Rule | Enforced? | Evidence | Smallest fix (size) |
|---|---|---|---|
| Dry run before compute | MISSING | Actions: shape, start, status, cancel (M/vcr_platform.py:298,1063-1095). `shape` gives no filled spec. No filled-spec preview with defaults and cost; validation only at start. "dry-run" in S/vcrCardEdits.mjs:237 concerns card edits. | `action: validate` returning normalised scenario, applied defaults, replicates (S) |
| Assumption echo before | [skill] partial | "回复里说清你替研究者定了哪个值" for definition only (C/vcr-protocol/SKILL.md:84). | Covered by validate (S) |
| Assumption echo after | [skill] partial | No rule specific to results beyond "Explain inputs, chosen evidence, computation status and limitations" (C/vcr-protocol/SKILL.md:28). | Return applied values in `_job_answer` (S) |
| Ask vs assume | [skill] | Search first (operating-contract.md:35-37). "不要问用户确认…只有一种情况该问" (C/vcr-protocol/SKILL.md:86). "without asking again" (C/vcr-analysis/SKILL.md:397). The brief's "一次只问…一件事" was not found by my grep of VCR skills. No field-level check tells the model what is underspecified beyond refusal. | One sentence in contract (S) |
| Never invent inputs | Mixed | [code] results and counts not writable (M/vcr_platform.py:244); quote and number checks (S/vcrEvidence.mjs:335-367); facts (above). [skill] for free `truth` values in a scenario with no card (operating-contract.md:23). `expert_set` allows any labelled number. | Mark scenario-typed numbers as assumed on the page (S) |
| Read-back of saved result | [skill] | operating-contract.md:65; next action "Read the result with vcr_read" (M/vcr_platform.py:1210); matching read-back (C/vcr-matching/SKILL.md:54). Terminal result does return in the tool call. Reply check is a notice (S/vcrReplyCheck.mjs:1-30) behind `OPEN_SCIENCE_REVIEW_ENABLED`, default false (S/config.mjs:1461). Production value not read. | Decide whether reply check runs here (S) |
| Spec validated by server, refusal text | DONE [code] | Per-field issues; unknown keys refused (S/vcrOrchestrator.mjs:1142; S/vcrGateway.mjs:320). `refusal_hint` returns keys of the refused place (M/vcr_platform.py:1031-1060,1089-1091). | None |
| `action: shape`, examples | DONE [code] | M/vcr_platform.py:960-1028; generated from schemas; `contracts` read for writes. | Minimal per-task templates would still reduce calls (M) |

**Text the model reads.** Root descriptions, compact: about 720 + 940 + 370 characters (M/vcr_platform.py:487-489). The VCR skills are **not in the skill catalogue**, and the tool text tells the model to read them by path (:488), unenforced. Character counts: contract 6,120; vcr-protocol 16,290; vcr-analysis 39,494; vcr-evidence 17,438; vcr-matching 21,056; vcr-package 11,792. A design task with evidence (contract + protocol + analysis + evidence) is about **79,000 characters** before tool results. A matching task is about 27,000 to 43,000. Shape JSON size (raw help, rendered text is shorter): `design.analytic` 8,664, `design.simulate` 17,219, `design.grid` 20,208. Field rows total 799 (matches the brief). Fix: split the skill by task family and move the longitudinal and packaging text behind a reference (M).

| Item | Class | Evidence | Smallest fix (size) |
|---|---|---|---|
| Verbatim quote plus value check on result fields | DONE [code] | Value, interval, n, events anchored to the quote (S/vcrEvidence.mjs:325-395, `quote_missing_number`, `unanchored`). Literature spans and unit verification (S/vcrEvidenceSources.mjs:11,56-58,96). | None |
| Figure numbers | DONE [code] | Digitizer measures pixels; refuses rather than guesses (M/vcr_platform.py:344-364). | None |
| Missing fields (main LLM extraction error) | PARTIAL | Registry: `unavailable[]` and `VCR_NOT_IN_REGISTRY` (S/vcrEvidence.mjs:149,1052; C/vcr-evidence/SKILL.md:79,118). Pool: `refused` list ([skill] :145). Literature paper: no expected-field list, so an omitted SD or n is invisible unless the model says so. Notes: omission is 87.8% of errors in one benchmark. | Per-parameter required-field checklist on `precedent`/source (S-M) |
| Durable record: result to assumptions | DONE in data | Job: method, version, seed, scenario and input hashes, `bound`, `detail` (S/vcrJobs.mjs:883-941; S/vcrOrchestrator.mjs:2812-2819). Lineage D/vcrLineage.mjs. Stale marks. Immutable versions. | None |
| Record shown in UI | UNREACHABLE by default | DesignRecordDrawer (W/components/vcr/tabs/TrialTab.tsx:501-510), VcrVersionComparison, Methods, and ADEMP under 模拟设定 (:364), all on the study page. | §7 |
| VCR conversation eval harness | PARTIAL | Briefs: analysis 4, evidence 4, matching 6, package 5, protocol 9 (`note`: not measured results). `realDelivery: not-run` for all five (E/acceptance-ledger.json:513-581). E/vcr-reply-check/cases.json. E/method-quality/run_native_vcr.mjs drives real DSH + VCR tools on synthetic data. E/tool-graph/tdg.vcr-*.json. Routing: nine `vcr` lines in E/routing/cases.json. Note: the ledger's matching note still mentions recruitment drafts (:552), stale. | Run briefs through the harness, record scores (M) |
| Native-control comparison | MISSING | "native" arms in openmed-scorecard.json compare clinical enrichment off vs on, not platform tools vs a bare model. E/general-tasks has no VCR hit by my grep. Brief §5.3 says the same. | One paired arm on 4 briefs plus underspecified cases (M) |

## 6. Text that disagrees with code

- `C/vcr-analysis/SKILL.md:196` says `model_comparator` is "当前版本没有实现". Code runs `prognosticPlan` (S/vcrOrchestrator.mjs:1345), with a benchmark section (W/components/vcr/tabs/ComparatorTab.tsx:270).
- `C/vcr-evidence/SKILL.md:120` says only registry values can enter a card, "论文正文…核对不了". `:26-38` and S/vcrEvidenceSources.mjs verify literature spans. I did not trace whether pooling admits them.
- Skill and gateway disagree on `targetTrial` shape (§3).
- `G/reconstruct.R:20-24` versus required `riskTable` (§2).
- `vcrNext` is exported (D/vcrNext.mjs; `OpenScience/packages/domain/index.mjs:1977`), and S/vcrRoutes.mjs:718 and W/lib/vcrClient.ts:562 describe `next`, but I found no server caller outside tests.

## 7. Flow and UI: re-verifying the brief's break

| Claim | Verdict | Evidence |
|---|---|---|
| Home "开始" jumps to default-project general chat | Confirmed | W/app/virtual-research/VcrHomePage.tsx:332; W/components/vcr/useGeneralResearchDraft.ts:13-16 |
| `createVcrStudy`, `startVcrStudy` have no UI caller | Confirmed | W/lib/vcrClient.ts:2335,2355; only `vcrClient.test.ts`. Route still exists (S/vcrRoutes.mjs:673). "新研究" only reopens the task picker (VcrHomePage.tsx:186,298) |
| First write creates hidden 对话研究 | Confirmed, also on digitize and simulate start | S/vcrGateway.mjs:2252-2254; S/vcrStore.mjs:428-440 (name 对话研究, purpose task, scope conversation) |
| List shows only `scope='project'` | Confirmed | S/vcrStore.mjs:551,566; S/vcrService.mjs:555 |
| Empty state contradicts this | Confirmed | VcrHomePage.tsx:249-253 |
| No result link | Confirmed, with refinement | No URL in `_job_answer` (M/vcr_platform.py:1141-1212) or `task_context`, which returns only `studyId` (S/vcrGateway.mjs:2291). No skill asks for one; operating-contract.md:59 keeps IDs out of replies. C/vcr-protocol/SKILL.md:26-28 names the workspaces without a way there. |

**Refinements, which do not overturn the break:**
- Besides the inbox there is a **toast** (W/components/vcr/useVcrFinishedToasts.ts:81-85). A notice fires for jobs from the runtime (S/vcrOrchestrator.mjs:3036-3050; S/vcrNotify.mjs:257-265).
- The study page has no scope filter, so a hidden study opens from a notice. The notice names it 研究「对话研究」 (vcrNotify.mjs:262), since the name changes only on a definition write.
- **`candidate_trial` judges at write, with no job** (S/vcrGateway.mjs:1044 onward). So patient-to-trial matching gets no notice and has **no route to its page at all** (read from code, not exercised).
- `followupHistoryForRuntime` returns a `browserPath` (S/vcrService.mjs:965), the only browser path a run receives; it covers one history feature.
- A study page's "调整" opens that study's conversation (W/app/virtual-research/VcrStudyPage.tsx:249-257). For a hidden study `#conversation` calls the resolver (S/vcrService.mjs:805-814); I did not trace that it returns the originating session.

**`VcrResearchProgress`.** Shows population definition, cohort input, computation and counts (W/components/vcr/VcrResearchProgress.tsx:29-41; S/vcrResearchProgress.mjs:12). Used only in OverviewTab:54 and PopulationTab:134,140. Not in frame or chat. The frame chip is loaded only for a conversation bound to a VCR capability (W/components/vcr/useFrameVcrOptions.ts:49), and a home draft is not bound. Sidebar registration skips `purpose: "task"` (VcrStudyPage.tsx:177).

**Six tabs for a task study** (W/components/vcr/vcrTabs.ts:10):
- 总览: returns `VcrNoDefinition` ("说明研究问题") when there is no question, headline, counts, deliverables or population definition (W/components/vcr/tabs/OverviewTab.tsx:48). `overviewHeadline` reads only designs and not-estimable comparators (S/vcrViews.mjs:711-723). The hidden row has no question (S/vcrStore.mjs:439), and matching needs no definition (C/vcr-protocol/SKILL.md:11-12).
- So a registry-trial matching task would land on an overview asking for a research question, while 匹配 holds its results. A population task reads acceptably. A design task gets its headline, but ADEMP lacks an aim. Partly inference: not rendered; I did not establish whether a `match_criteria` result supplies `counts`.
- Empty tabs: `VcrStepPending` returns the same "说明研究问题" for any undescribed study (W/components/vcr/VcrStates.tsx:185), including a study that clearly has other work. Progress card always speaks of 人群定义, even for matching or design tasks. Other tabs follow the object they hold.

**Flow class:** study list and result link are UNREACHABLE paths; "AI first, no form" holds in the conversation. Fixes: list hidden studies with objects, named from first message (S); link in `_job_answer` plus a skill line (S); overview aware of task family (S-M). PR #17's review kept hidden studies out of the sidebar and general projects (brief §7): do not undo.

## 8. Where a user meets input forms

Control counts are JSX tags by grep, so undercounted where a tag wraps.

| Surface | Component | Reached from |
|---|---|---|
| Task picker | `TaskEntry`, `VcrTaskRequirements`: segmented control, 开始, statistical 数据要求 text (W/components/vcr/frameVcrOptions.ts:51-54) | Home |
| Reference trials | `VcrReferenceSearch` (2) in `VcrPrecedentsPanel` | Home view, DataTab |
| Population templates | `VcrDefinitionsPanel`, `VcrKnowledge` (10): save as, name, description, compare, use template, disease pack (:243,349-355,409-416,463-475,557) | Home view, DataTab, PopulationTab |
| Data intake | `VcrIntakeDrawer`, `IntakePanel` (7), `SourceCard` (11), `FieldMapEditor` (13), `CloudDocuments` (7), `WithdrawConsent` (1) | Study "⋯" (VcrStudyPage.tsx:319) |
| Assumption card edit | `DataTab`: value, unit, note, remark (:516-519,569) | 依据 tab |
| Decision | `TrialTab`: goal, chosen, rationale (:601,635) | 试验 tab |
| Regulatory log | `VcrRegulatoryLog` (6) | 试验 tab |
| Version compare | `VcrVersionComparison` (2) | Four tabs |
| Judgment change | `VcrJudgmentDrawer` (2), `ClinicalMatchingDetails` (1) | 匹配 tab |
| Model assessment | `VcrModelAssessments` (9) in `ModelRecordDrawer` | Patients |
| Forecast | `VcrLongitudinalPanel` (5), `VcrForecastComparison` (2) | Patients |
| Registered prediction | `VcrFilePrediction` (4) in `VcrPredictionsDrawer` | Trial context |
| Publish | `VcrPublishSimulation` (2) in `VcrPackageReader` | Package |
| Budget, members, rename | `VcrBudgetDialog` (1), `VcrMembersDialog` (2), `VcrStudyDialogs` (1) | Study page |
| Composer chips | 起点, 预期用途 (frameVcrOptions.ts:37-43) | Only a bound conversation |
| Method workbench | Read-only for new work: "计算已移入研究对话" (W/app/routes/VcrMethodWorkbenchPage.tsx:23); shows historical jobs | `capabilities/methods/:id` |

**No parent at main (dead):** `VcrLiteratureSource` (5), `VcrReconstructionInput` (1), excluding tests. `editVcrCard` (W/lib/vcrClient.ts:2468) has no UI caller, though the route exists (S/vcrRoutes.mjs:887).

## 9. Overlap with the module workspace plan

The plan is not in the shared checkout. I read a copy at `docs/ui-ux-audit/2026-11-01-module-workspace/整改方案.md`. Its header says it was **implemented on branch `codex/module-workspace-20261101` (based on int-1101), not merged, not deployed**, whereas the session memory says "not built"; the branch exists locally and on `github`. I did not read the branch. Baseline 38b5af2a8 is an ancestor of 77ba0a436.

- Overlaps: "对话和结果互斥" (right-column conversation over results), draft vs start button kinds ("生成虚拟患者" only fills a draft), waiting-for-budget shown as failure, a `now`/next state for VCR, activity strip on task finish.
- Its statement "`vcrNext.mjs` 已不在代码里" is wrong at 77ba0a436: the file is there and unused (§6). Behaviour is as it says.
- Not addressed by it, per the plan text: listing hidden studies, a result link in tool answers, task-aware overview, any scientific item in this file. It keeps "no forced seven-step rail" (10-25/26), which this audit does not contradict.

## 10. Not verified

Numerical correctness (engine tests not run). Rendered UI of any tab. Whether production enables VCR, review or provider flags (`OPEN_SCIENCE_VCR_ENABLED` defaults false in code, S/config.mjs:1061). Whether `results` read returns the unsurfaced diagnostics in full to the model. Pooling admission of literature evidence. The 5/12 figure in the brief. Exact conversation session returned for a hidden study. Whether any part of an MCP tool answer carries a URL outside the code paths I read.
