# Patient Matching: Results Diagnosis and Next-Phase Implementation Plan

> **Execution superseded on 2026-11-05:** [V3: independent DSH professional plugin](2026-11-05-vcr-matching-plugin-v3.md) is the current architecture proposal, following [V2](2026-11-05-vcr-matching-next-phase-v2.md). The diagnosis and derived results below remain evidence; the later versions replace this version's broad experiment matrix and repeat-run requirements.

> **For agentic workers:** Use the `executing-plans` skill to execute the checked tasks in dependency order. This document defines analysis and experiments; unmeasured design alternatives are not instructions to ship them.

**Goal:** Improve the EviMed patient-matching product by correcting classes of retrieval, judgment, state, and measurement failures, with English SIGIR and full-corpus TREC reported separately.

**Architecture:** Keep DSH + DeepSeek, the existing matching jobs, source plane, ledger, and readers. Separate what the model says about eligibility from recommendation priority; use deterministic code for arithmetic, identity, evidence addressing, and state consistency. Select retrieval and ranking changes through controlled product-path experiments, preserving useful partial results.

**Tech Stack:** Node/JavaScript, Python evaluation tools, PostgreSQL, React/TypeScript, SQLite FTS5, the existing DashScope reranker, and pinned upstream evaluators.

**Date / scope:** 2026-11-05, Asia/Shanghai. Read at `d5f690b15866c2891ffde593ca5321259b4d6297`. The scored model runs were frozen at `a2d109cf5` (`fit-3`, `criteria-5`). No paid model run, deployment, or original-corpus rescore was performed for this analysis. Derived statistics are in [reanalysis.json](2026-11-05-vcr-matching-next-phase-assets/reanalysis.json), with input hashes. Implementation remains future work.

## 1. Decision

The delivered branch substantially improves the old matching path, but the evidence does not establish an accepted end-to-end product. The next phase should prioritize three things: repair the meaning of eligibility versus recommendation, recover the evidence needed to attribute retrieval losses, and validate the actual conversation-to-saved-result path. Adding more knowledge collections or another judge is not the first step.

The strongest new findings are:

1. On the **same 2023 candidates**, final judgment ordering reduces official nDCG@10 from **0.4753 to 0.3663**. This is an observed stage regression, not merely a difference between two datasets.
2. Unjudged trials occupy **59.6%** of the final 2023 top ten. This makes the official score incomplete as a clinical-quality measure, but does not prove those trials are relevant or explain away the regression.
3. The prompt mixes eligibility and recommendation preference; current code turns a low score into `ineligible` even when supplied clauses are all satisfied and no exclusion reason exists. This is a reproducible semantic problem at the current head.
4. English SIGIR is **near the published TrialGPT 2.0 point estimates**, not demonstrably equivalent or superior. It has been used for development, so it is not an untouched generalization test.
5. The 17 incident cases have incomplete acceptance assertions. Their recorded success includes historically contradictory score/verdict outputs. The later fix needs a stronger replay, not a declaration that 16 cases passed.
6. The reported NIH 88.1% is case-weighted; the paper's 70% is institute-macro. Our institute-macro value is **93.33%**, but narrowing and attribution differences still prevent a model-superiority claim. **13 of 15 misses are NCI cases**.

**Owner scope applied:** English SIGIR stays in the next benchmark. Translated SIGIR (board G) is historical only: no further translation, rerun, tuning target, or headline score. Real Chinese intake/search remains a product capability and is tested using real Chinese workflows, not translated SIGIR.

## 2. Evidence and what each board actually measures

Primary local sources: [delivery plan section 16](2026-11-04-vcr-matching-delivery-plan.md#16-结果2026-11-05), [asset index](2026-11-04-vcr-matching-delivery-assets/README.md), the six board score pairs (A/B/C/E/F/G), the incident and Chinese usability JSON files, and the five analysis documents. The older reviews concern earlier revisions; their open findings are not automatically current defects.

| Evidence | What is established | What is not established |
|---|---|---|
| A, 75,061 judged pairs | Ordering within a supplied, fully judged pool; all pairs completed | Corpus retrieval, normal worker scheduling, the conversation, or final product ordering after clause checks |
| English SIGIR, 58 cases / 3,835 pairs | A complete English candidate-pool ranking result | A held-out result; SIGIR and board C were development material |
| B, 126 cases / 12,600 pairs | Target recovery after narrowing to 100 | Same protocol as scoring all 101,682 pairs; isolated contribution of the judging model |
| C, 1,015 clauses / 53 patients | Paired comparison against the supplied expert labels | Out-of-sample clause accuracy; these rows influenced three prompt versions |
| E, 133 topics / 13,300 final candidates | Retrieval plus job-path ordering against full qrels | The entire user conversation; actual top-500 recall from the submitted final-list file |
| F, 86 patients / 1,118 decisions | Official scorer result under specified binary mapping | 92.2% native model accuracy; clinical validation; a newly untouched test set |
| 17 incidents, 51 attempts | Particular assertions passed on synthetic cases | Complete score/reason/verdict/rank/persistence consistency |
| 115 Chinese requests | Coverage and operational behavior without gold | Clinical accuracy or recall of all eligible trials |
| 5,000-person scale test | Queue, database and reader behavior with a model double | Real-model throughput, cost or clinical-quality scaling |

### Measurement corrections

- **P@10 is not one metric across these boards.** A follows the TrialGPT normalized graded precision (`sum(grades)/20`). E uses eligible-only precision (`count(grade=2)/10`). Never compare their numbers as the same precision. nDCG uses graded gain, including partial credit for TREC grade 1, which denotes exclusion rather than eligibility.
- **A confidence interval containing a competitor's point is not an equivalence test.** Replace “statistically tied” with “similar point estimates; a difference is not established by this comparison.” Formal equivalence needs a prespecified margin and suitable uncertainty, preferably paired outputs.
- **The paper has uncertainty information.** TrialGPT 2.0 v2 describes patient-query error bars; the earlier statement that the other system has no intervals is too strong. We lack its paired per-topic outputs, not all uncertainty information.
- **Not every number was produced by an upstream script.** A/B wrap official evaluators; C uses our label comparator. E's `score_e.py` implements the official formulas and optionally checks `trec_eval`. The committed E JSON has no `trecEvalCheck` field: this artifact alone does not prove that optional cross-check ran for this exact score. F retains its official-scorer identity.
- **Do not silently drop absent cases.** E iterates output records and skips topics absent from qrels. An all-judged count says the retained rows have scores; expected-input completion needs the frozen manifest. Current rows cover the stated 65/40/28 topics, but future scorers must explicitly list intended, unscorable, missing, failed, resumed and completed cases.
- **The exact evaluated reader matters.** Later commits changed verdicts and order while retaining prompt version strings. A prompt pin alone is not a whole-product revision pin.

## 3. English SIGIR: present the actual level

Our figures are from `scores/board-a.json`, all-patient SIGIR. Comparator figures below are the **rounded labels** in TrialGPT 2.0 v2, Supplementary Figure 3c, visually inspected on 2026-11-05; they are not a fresh reproduction. The comparison uses judged-pair pools. [Primary figure](https://arxiv.org/html/2609.01202v2/backbone.png).

| Metric | EviMed | EviMed 95% patient-bootstrap interval | TrialGPT 2.0 / GPT-5.4 | TrialGPT 2.0 / Gemini-3.1 |
|---|---:|---:|---:|---:|
| nDCG@10 | 0.6509 | 0.5952–0.7051 | about 0.66 | about 0.65 |
| Graded P@10 | 0.4802 | 0.4207–0.5414 | about 0.50 | about 0.48 |
| MRR, eligible only | 0.7002 | 0.5962–0.7957 | about 0.73 | about 0.70 |
| MAP, eligible only | 0.5175 | 0.4643–0.5707 | about 0.50 | about 0.48 |

Interpretation: **competitive point estimates in this narrow ranking setting**, with nDCG/P@10/MRR slightly below GPT-5.4 and MAP slightly above its rounded figure. This does not establish a leaderboard rank, superiority, or equivalence. Graded P@10 0.4802 does not mean exactly 4.8 eligible trials per patient. MRR 0.7002 is not a mean first-hit rank of 1/0.7002. The cohort also contains patients without any grade-2 candidate; its theoretical MRR ceiling is below 1 (the harness documents 0.9138).

The **three-cohort** average 0.7497 must not be displayed as a SIGIR score. Likewise, the TrialGPT 1.0 paper-subset SIGIR nDCG is 0.6590, while our three-cohort subset average is 0.7596; the latter cannot be compared with a SIGIR-only reference.

The next report will show four English SIGIR metrics on one row, the exact candidate-pool definition, a development-set label, and a separate product-default result using fit plus top-20 clause judgments. Preserve board G files for reproducibility but remove G from future execution and success criteria.

## 4. TREC: where the result is lost

### 4.1 Measured stage changes

`retrievalOrderNdcg10` is the saved retrieval order restricted to the candidates handed to judgment. It includes the retrieval pipeline's rerank when that arm supplied the file. It must not be called bare BM25. The committed artifact does not contain the earlier candidate lists needed to quantify BM25-to-Qwen changes independently.

| Test cohort | Topics | Incoming order nDCG@10 | Final nDCG@10 | Paired change, 95% interval | Improved / tied / worsened |
|---|---:|---:|---:|---:|---:|
| 2021 | 65 | 0.4640 | 0.4750 | +0.0110 [−0.0409, +0.0650] | 30 / 1 / 34 |
| 2022 | 40 | 0.4743 | 0.5286 | +0.0542 [−0.0230, +0.1334] | 25 / 0 / 15 |
| 2023 | 28 | 0.4753 | 0.3663 | **−0.1090 [−0.2063, −0.0146]** | 10 / 1 / 17 |
| Pooled | 133 | 0.4695 | 0.4682 | −0.0013 [−0.0423, +0.0411] | 65 / 2 / 66 |

These are new, **exploratory** paired topic bootstraps (20,000 resamples, seed 20261105) from the saved rows. They measure topic sampling uncertainty for one run, not model repeatability. The 2023 topics share disease templates; a template-cluster sensitivity analysis is still needed. Do not treat nominal intervals across several endpoints as multiplicity-adjusted confirmatory tests.

Eligible-only P@10 changes are **+0.0815**, **+0.0925**, **+0.0393**, respectively; the first two paired intervals exclude zero, while 2023's is −0.0536 to +0.1321. Thus judgment has some demonstrated utility. It improves eligible counts in 2021/22 while not establishing a graded nDCG gain. In 2023, discounted graded order deteriorates despite a small, uncertain increase in eligible count. Possible mechanisms include moving grade-1 trials down, moving unjudged trials up, and changing the positions of grade-2 trials. Per-rank ids/grades are needed to apportion these mechanisms.

The historical NIST references preserved in `board-e-end2end.md` put 2021/22 above track-wide median point estimates and below the best; those track-wide means use different topic sets, so they are contextual, not paired standings. For the same 28 scorable 2023 test topics the archived reference is median 0.6680 and best 0.8070; 0.3663 is substantially below both. This report did not re-download and rescore the NIST runs.

### 4.2 Unjudged coverage is a limitation, not an explanation of every error

| Cohort | Judged fraction of final top 10 | Mean unjudged slots / 10 | Official nDCG | Condensed judged-only nDCG |
|---|---:|---:|---:|---:|
| 2021 | 53.08% | 4.69 | 0.4750 | 0.8192 |
| 2022 | 67.50% | 3.25 | 0.5286 | 0.7408 |
| 2023 | 40.36% | 5.96 | 0.3663 | 0.8548 |

The condensed calculation removes unjudged ids from the whole returned list, moves later judged trials into the first ten, then scores it. It is **not** correctness conditional on the original top ten, nor a correction estimating the true score. It benefits from an evaluation-time operation using judgment availability. Its high value cannot validate the unknown trials or certify the original first page.

Record unjudged and judged-negative separately. Preserve official scoring as primary for TREC comparison. A bounded, blinded assessment of previously unjudged outputs may estimate whether they are useful; it is a separate supplemental evaluation and must not replace official qrels or become a product approval step. Runtime ranking must never consult qrels membership.

### 4.3 The candidate list already limits what judgment can recover

All 133 final lists contain 100 scored items. No missing fit scores explain the final E score. This does not establish first-attempt completion or a normal production-worker run.

| Cohort | Mean eligible Recall@100 | Mean maximum possible Recall@100 | Mean per-topic fraction of that maximum |
|---|---:|---:|---:|
| 2021 | 33.48% | 92.31% | 35.05% |
| 2022 | 38.99% | 90.35% | 42.64% |
| 2023 | 6.83% | 41.51% | 19.93% |

The denominator is **all judged eligible trials for a topic**, not every truly eligible trial in the corpus. The ceiling is `min(100, eligible_count) / eligible_count`, averaged by topic. The last column averages each topic's ratio, not the ratio of the two previous means. 2023 has more eligible trials per topic, so the raw 6.83% cannot be compared across years without its ceiling. Nevertheless the low fraction of available capacity identifies candidate selection as a high-priority investigation.

Low Recall@100 does **not** mathematically imply low nDCG@10: ten excellent candidates can suffice for a perfect first page while recall of hundreds remains small. Recover candidate-pool oracle nDCG@10 to separate candidate shortage from ordering loss before concluding that more retrieval alone will fix E.

**A reporting trap:** `metrics()` computes Recall@100 and Recall@500 on whatever list it receives. In E that list has only 100 rows, so these two fields are identical for all 133 topics. E's `recall500` is not the 500-candidate retrieval recall. Obtain the separate retrieval output before making any 500-to-100 loss claim.

### 4.4 Ranked causes and how to test them

| Cause | Evidence now | Confidence / next discriminator |
|---|---|---|
| Judgment stage damages 2023 graded ordering | Same-topic paired decrease above | Observed; recover rank movements and split unjudged, grade 0/1/2 |
| Eligibility and recommendation are conflated | Current prompt and pure-function reproduction in section 5 | Observed design defect; prevalence and share of TREC loss unmeasured |
| Different task distribution in 2023 | Official 2023 task uses disease questionnaires and a newer corpus; parser drops empty fields | Verified input shift; compare by template, missingness, study type, and matched candidate size |
| Missingness assumptions fit narrative records poorly when applied to short questionnaires | Prompt asks what a well-documented note would omit; questionnaires deliberately omit unavailable values | Strong hypothesis; matched full/short/field-omitted cases and stratified error inspection |
| Lexical candidate recall and early cuts | `vcrTrialCorpus.mjs` uses FTS5, token OR queries, weighted fusion, per-query and final caps; no independent dense recall branch in this path | Code verified; quantify filter/cap losses before selecting a retrieval change |
| Rerank card loses relevant context | `candidateCard()` limits all text to 1,500 characters and uses the beginning of eligibility | Code verified; inspect excluded tail evidence and compare bounded complete-section cards |
| Standalone fit scores lack cross-trial calibration | Per-pair scalar and confidence, deterministic tie order; no cross-candidate judgment in this path | Hypothesis; inspect saturation/ties and compare rank fusion or a small shortlist comparison |
| Qrels pool incompleteness | Low final J@10 | Observed limitation; candidate validity and counterfactual true score unknown |
| Failures/partial runs cause this final score | Every saved E list has 100 fit scores | Not supported for retained final rows; original-attempt and omitted-topic accounting still needed |

Official 2023 task context is confirmed at [TREC Clinical Trials 2023](https://www.trec-cds.org/2023.html). The hypotheses above are our inference from that task and the local code, not conclusions supplied by the organizers.

## 5. A current semantic defect: low recommendation is read as ineligible

`packages/domain/src/vcrTrialJudgment.mjs` asks `FIT_SYSTEM` to lower scores for non-disease-directed registries/biobanks and missing prerequisites, as well as for actual exclusions. `trialVerdict()` then returns `ineligible` whenever fit is below 20, including when clause rows are all satisfied. `rankJudgments()` also has a separate stated-disqualifier ordering policy. The one scalar cannot tell these causes apart.

A current-head, no-model probe supplied fit 10, one stated `included` and one stated `not_excluded` clause, no missing clauses and no exclusion reasons. It returned `ineligible`, `because: fit_band`, and **an empty disqualifier list**. This is a synthetic contract reproduction, not a claim that a particular scored patient was wrongly excluded. The historical fit-0/eligible contradiction is corrected at this head; the more general semantic conflation remains.

Class-level direction:

- Let the model express eligibility state, uncertainties, explicit incompatibilities, and recommendation preference as distinct information in one judgment. Do not create a second executor or require a second model on every pair.
- Preserve the existing four visible eligibility labels and client compatibility. Add versioned internal judgment fields only after the control experiment selects their semantics. Historical rows retain their producer version; an adapter must not manufacture a missing eligibility assessment from a recommendation score.
- A low preference is a low rank, not automatically an exclusion. A stated incompatibility must remain visible even if another component assigns a high relevance score. Disagreement becomes an explanation and an eligible targeted retry, not withheld research.
- Teach a short task-general distinction between “can screen this person” and “worth prioritizing for this request.” Do not branch on benchmark year, disease keywords or qrels categories in production.
- Evaluate eligibility and recommendation separately. A TREC grade-1 item legitimately earns graded retrieval credit while remaining excluded in the clinical view; do not improve nDCG by falsely presenting it as eligible.

## 6. Other material gaps revealed by the results

### 6.1 Clause errors are concentrated, and policy disagreement is not the whole error

Board C has **212 errors**, of which **114 (53.8%)** are on gold `not enough information` rows. The strict false-favourable count is **98**: **96** convert gold unknown into a favourable answer and **2** contradict a gold explicit disqualification. The two categories need different diagnoses; 98 is not 98 proven harmful enrolments.

Among gold unknowns, **88 become `not excluded` and 8 become `included`**. This is consistent with the broad silent-exclusion instruction. But other deficits remain: inclusion sensitivity is 126/150 (84.0%); `not included` sensitivity is 9/23 (39.1%); explicit `excluded` sensitivity is 8/10 (80.0%, a small denominator). Quote-linked rows agree on 329/405 (81.2%) versus GPT-4 350/405 (86.4%). Merely fixing silence will not fix evidence interpretation, prerequisites, alternatives and attribution.

Report strict false-favourable count 98 beside GPT-4 15, or broad count 117 beside 16; never mix definitions. Strict false-favourable rate is 98/1,015 (9.66%) over all rows or 98/326 (30.06%) over at-risk gold rows; name the denominator. The gold was influenced by GPT-4 outputs and our prompt was tuned on it. These limitations do not cancel each other.

Next experiment: contrast explicit negative, not mentioned, pending test, abnormal finding, historical/resolved finding, another person's history, and incompletely read source. Keep per-criterion model judgment and the owner's visible silence labels. Do not restore the old rule that every unknown disqualifies or that every silent exclusion is automatically safe. Explicitly distinguish source completeness from clinical silence.

### 6.2 Evidence addressing is not evidence entailment

A valid sentence id proves that text exists. It does not prove it supports the conclusion, concerns the same person, uses the right time window/unit, or applies to the selected arm. The 1,448 source-linked Chinese clauses are an addressing success, not 100% reasoning accuracy.

Use offline counterexamples for correct-id/wrong-support, negation, family history, stale laboratory values, unit conversion, arm alternatives and omitted exclusions. Deterministic arithmetic should recompute extracted values with units and dates where supplied; the model interprets the criterion. Incomplete arithmetic inputs keep their limitation and do not block the package. The three successful repeats of one numeric case are insufficient evidence to abandon arithmetic verification.

### 6.3 n2c2 is promising but policy-sensitive

F's primary binary mapping gives micro F1 **0.922**, versus **0.871** for mapping (b); unknown share is **39.5%** (442/1,118). Mapping (c) supplies two benchmark-specific defaults for ENGLISH and MAKES-DECISIONS. These belong in the scorer, not a new production rule. Mapping unknown as wrong yields accuracy **0.545**; that is another diagnostic, not a replacement for the official reading.

Keep official F1, native six-label output, unknown rate and per-criterion tables together. Do not describe the 5.1-point F1 mapping difference as a model improvement. The test set was used by the prior pipeline and is now inspected; later iterations are regression measurements, not fresh prospective tests. Keep the condition titles and possible benchmark recognition as declared exposure.

### 6.4 NIH recovery hides a disease-area concentration and a denominator mismatch

The saved counts yield micro Recall@10 **111/126 = 88.10%** and an unweighted mean across 11 institutes of **93.33%**. The paper's 70% uses institute macro averaging. Both our values should be shown, with the narrowing protocol retained. The macro value has no reconstructed interval here.

**NCI is 28/41 (68.29%), MRR 0.1988; it accounts for 13/15 misses.** All targets still have a saved rank. Thus these misses occur in ordering within the judged shortlist, not failure to place their target in this run's top 100. NCI cases warrant stage/line/biomarker/prior-treatment and preference-versus-eligibility analysis, not a new NCI-specific rule. The historical rerank-only Recall@10 was already 86.5%, and the final scorer reduced Recall@1; retrieve the raw paired outputs before quantifying that trade-off further.

### 6.5 Incident success does not certify the full contract

The saved fixture report gives 50/51 asserted passes; one male/female-trial attempt fails its fit threshold. Several historical rows with fit 0 and verdict `eligible` still have empty findings, because those cases did not require the correct verdict. The pass count is accurate for its assertions, not for comprehensive behavior.

Extend each incident into positive and negative controls, paraphrases, boundary values, missing and contradictory inputs, follow-up updates, cancellation and resume. Check final verdict, reasons, referenced evidence, ordering, database row, page and export. Add low-priority-but-eligible and high-relevance-but-excluded cases. Report attempts and unique cases separately; three repeats of a synthetic case cannot establish population safety.

### 6.6 Chinese usability exposes intake-to-result loss

Of 115 inputs, 90 have judged records (**78.26%**); 88 are complete (**76.52% of all inputs**, 97.78% of the 90 judged records). The plan explains 24 zero-candidate searches and the JSON records one invalid search; reconcile these per-input before assigning every failure a cause. Five of ten inspected zero-result searches reproduced a Chinese-query/English-registry mismatch; this is not proof that all 24 have that cause.

The correction should cover registry-language-aware search planning, translated synonyms where needed, query validation, explicit source outages, fallback searches and saved outcomes. Avoid treating zero search results as clinical ineligibility. Evaluate real Chinese documents, Chinese trials and registry-text availability separately. This work survives removal of translated SIGIR.

### 6.7 Product state, security and engineering remain distinct proof obligations

The current branch contains later fixes for failed rejudgment, early reads before the first row, partial exports, stale documents, FHIR/OMOP notes, rule-table pagination, search coverage, withdrawal association and small-cell access. Examples include `27165309a`, `bb164cbeb`, `2be2ef68c`, `4b7aa068f`, `dcc6a1537`, `41751f88e` and `94bb96b3e`. They are not all revalidated at this head in this analysis.

Earlier security review B1–B5 had subsequent passing focused tests; do not call them current exploitable vulnerabilities without reproducing. Keep their entire class in regression: symlinks and immutable originals; deletion/revocation while a call is in flight; withdrawn re-import; large malformed archives/CSV; authorized content on list/detail/export/conversation. Residual questions in the final review still need a current-head audit: shared upload retention after individual withdrawal, identity under which member-started jobs read, search-summary identifiers, project-deletion scratch races, and spend booked after reranking. Each requires an explicit data/permission contract, not a blanket deletion or another confirmation ceremony.

Normal conversation still needs successful replay of protocol plus roster and Chinese-only search corrections. PDF intake failed in the prior real environment because its conversion service was absent; mock-parser success does not establish the deployment path. Native completion, source changes and durable result links must be tested with real jobs.

The 20-candidate latency sample is 3.31/3.78/4.16 minutes versus a P50 target of 2. The job itself was 107–120 seconds, leaving meaningful orchestration/retrieval/wait overhead; exact attribution needs spans rather than subtraction of unmatched averages. Separate first useful results, whole-trial ranking, clause completion and final reply. Preserve the 2-minute target during investigation rather than silently loosening it.

**Live CI observation:** `web` job 127087060142 in [run 41979809075](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41979809075) failed its capability-audit-suite step. Its log reports a stale harness-adaptation guidance snapshot hash and asks for `node tools/snapshot_guidance.mjs`. This is a source/snapshot consistency failure, not evidence of worse clinical scores and not the same as the separately pending deployed capability probes. At inspection, vcr-seam, gallery and public-dataset passed; vcr-engine was still running. Later CI stages and candidate deployment are not certified.

## 7. Work packages and dependencies

Sequence: **W0 → W1 → W2/W3 controlled experiments → W4 → W5 → W6/W7 → W8**. The experiments share frozen evaluation controls; do not run incompatible variants on a shared database or rewrite historical scores. W6's known product-path replays and W7's isolation checks can begin while scientific attribution is being prepared, without changing the scoring experiment.

### W0. Freeze the measurement contract and repair the report

**Files:** `OpenScience/evals/vcr-matching-boards/{README.md,score.py,score_e.py,score_f.py,test_score.py,test_score_e.py,test_score_f.py,check_report.py}`, this plan and the historical result index.

- [ ] Record code, prompt hashes, reader/sort policy, corpus/qrels hashes, split, candidate depth, reranker model/configuration, actual reported model, attempt number and missing-data policy for every arm.
- [ ] Require an expected-topic manifest in scoring. A fixture with two expected topics and only one output must retain both and mark the absent result, rather than quietly report one completed case.
- [ ] Name metrics `graded_precision_at_10`, `eligible_precision_at_10`, `eligible_recall_at_k`, and `judged_fraction_at_10` in the analysis schema; adapt presentation without breaking existing clients.
- [ ] Mark requested versus available list depth. A 100-row final list cannot claim measured retrieval Recall@500. Add a fixture preserving existing score math while making this unavailable scope explicit.
- [ ] Add institute-macro NIH reporting from exact counts; keep micro and per-institute rows. Add complete clinical-output assertions to the incident expectations without rewriting their historical pass counts.
- [ ] Run the official scorer on saved inputs without new model calls, preserve its version/command/output digest, and compare every retained topic. Correct mismatches rather than changing expected values to fit our implementation.
- [ ] Publish English SIGIR separately and mark G as retired from future runs. Fix “equivalent”, missing-interval and “all official scripts” wording in the next generated report.

Verification command from `OpenScience/evals/vcr-matching-boards`:

```sh
python3 -I -B -m unittest discover -s . -p 'test_score*.py'
```

Expected: scoring fixtures pass; external-scorer tests explicitly identify any unavailable dependency. A skipped official check is not official-score verification. Save and review the evidence-only change separately from product changes.

### W1. Recover the missing retrieval-stage evidence

**Files:** `OpenScience/evals/vcr-matching-boards/{retrieve_e.mjs,e2e_e.mjs,score_e.py,retrieve_e.test.mjs,test_score_e.py}`; create an offline `analyze_stages.py` beside the scorer if no existing helper covers the following joins.

- [ ] Recover the already-paid query plans, no-rerank list, reranked list, final judgments and official qrels from the preserved run owner. If missing, record exactly what must be regenerated; do not substitute a different corpus silently.
- [ ] Join by topic, registry id and corpus revision. Produce counts and recall before filters, after filters, at fused 500, reranked 500, cut 100, and final 10. List age/sex/region/status removals separately.
- [ ] Compute the oracle nDCG@10 of each candidate set using qrels only in the evaluator. Then report candidate-oracle minus actual ranking separately from full-qrels-ideal minus candidate-oracle. These use the same nDCG denominator; do not substitute recall ceilings for an nDCG oracle.
- [ ] For changed top-ten positions, count moves among eligible, excluded, irrelevant and unjudged, with gain and rank discount changes. Group 2023 by template and missing fields; inspect NCI misses by clinical cause.
- [ ] Preserve private per-case evidence under the existing acceptance directory; publish only aggregate tables and synthetic reproductions. Add input digests and a machine-readable stage-presence inventory.

**Acceptance:** Every suspected loss has a measured stage or is explicitly unmeasured. No paid all-board rerun is needed before this accounting. Candidate-oracle diagnostics cannot enter runtime ranking.

### W2. Fix the class of eligibility/recommendation conflation

**Files:** `OpenScience/packages/domain/src/vcrTrialJudgment.mjs`, `OpenScience/packages/domain/test/vcrTrialJudgment.test.mjs`; `OpenScience/apps/server/src/{vcrMatchJudge.mjs,vcrMatchResults.mjs,vcrMatchJudgmentStore.mjs}`; relevant server tests; `OpenScience/apps/web/src/components/vcr/tabs/JudgedPair.tsx`; `OpenScience/DESIGN.md` and `OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md` when visible behavior changes.

- [ ] Capture the current fit-10/all-clauses-met reproduction as an expected-behavior regression, paired with a real explicit exclusion, missing diagnosis, low-priority registry, optional screening test, multi-arm trial and a historical row.
- [ ] Compare the present one-score output with a single-call output that distinguishes eligibility state, recommendation priority, explicit incompatibility and missing information. Keep model, source text and candidates fixed. Inspect whether the extra fields agree with the model's own rationale and the clauses.
- [ ] Select the smallest useful representation on development cases; bump the judgment/prompt identity and define a backward-compatible reader. An absent old field remains unknown; no destructive migration or regeneration of old packages.
- [ ] Make page, conversation, export and sorting consume the same selected semantics. Source-backed exclusion and low recommendation must remain distinguishable. An uncertain judgment retains a visible result and explanation.
- [ ] Re-score English SIGIR, TREC development topics and the paired NCI diagnostic set using both fit-only and actual product-default order. No year-specific runtime rule.

Current reproduction, runnable from the repository root:

```sh
node --input-type=module - <<'JS'
import { trialVerdict } from './OpenScience/packages/domain/src/vcrTrialJudgment.mjs';
console.log(trialVerdict({
  fit: 10,
  criteria: [
    { number: 1, label: 'included', basis: 'stated' },
    { number: 2, label: 'not_excluded', basis: 'stated' },
  ],
  missing: [], ineligibleReasons: [],
}));
JS
```

Today it returns `ineligible` with no disqualifier. The desired contract is that low preference alone cannot establish ineligibility. The exact new output schema is selected by the experiment, not invented as a completed fix in this plan.

### W3. Improve retrieval only where measured losses justify it

**Files:** `OpenScience/apps/server/src/{vcrCandidateSearch.mjs,vcrTrialCorpus.mjs,vcrCandidateRerank.mjs,vcrEvidence.mjs}` and their existing tests; `OpenScience/evals/vcr-matching-boards/{retrieve_e.mjs,retrieve_e.test.mjs}`.

- [ ] Keep the current lexical-plus-rerank path as control. First test query scope and filter correctness on the W1 failures: principal condition versus incidental findings, synonyms, negation, age units and sex restrictions.
- [ ] Compare capped OR-token search with field-aware phrase/term alternatives using existing FTS5 facilities. Do not AND every phrase or add disease-specific keyword exceptions.
- [ ] If missing candidates remain the bottleneck, evaluate a mature semantic retriever through a narrow adapter alongside lexical retrieval; use the upstream TrialGPT hybrid design as a candidate, not a presumed improvement. Check model license, host resources and corpus revision before indexing.
- [ ] Compare the current 1,500-character head card with bounded title/condition/inclusion/exclusion section coverage. Preserve alternative arms and explicit negative evidence rather than simply sending longer text.
- [ ] On the same retrieval cache, compare judging 50/100/200 candidates only if oracle gain supports the expense. The development winner needs improved candidate coverage and useful top-ten output at recorded cost, not merely a larger list.

**Acceptance:** A selected change improves its intended stage under paired analysis and does not mask failures or worsen the declared eligibility-error constraints. Keep the current simpler path when evidence is inconclusive. A semantic reranker alone cannot retrieve an item omitted from all first-stage lists.

### W4. Correct missingness, evidence and arithmetic as reusable classes

**Files:** `OpenScience/packages/domain/src/{vcrTrialJudgment.mjs,vcrClauseDefinitions.mjs}`, `OpenScience/apps/server/src/vcrMatchJudge.mjs`, `OpenScience/evals/vcr-matching-boards/{incidents.json,incidents.mjs,incidents.test.mjs,score.py}`, and the existing clinical-score/terminology tool boundary under `OpenScience/runtime/mcp/evimed-research/`.

- [ ] Build contrast sets for omitted versus explicitly negative findings, pending tests, uncertain diagnosis, time windows, another person's history, source truncation, arm alternatives, numeric bounds and unit conversions. Each has a positive control and a counterexample; hold out whole case families/templates, not paraphrases of the same case.
- [ ] Separate model clinical silence from unread input and absent trial text. A “not mentioned” label must not hide a document that never reached the model.
- [ ] Use existing deterministic calculation tools for checkable units/dates/thresholds and keep clinical interpretation with the model. Cache reusable definitions only when an ablation shows benefit; do not ship all terminology sources because they are available.
- [ ] Evaluate source entailment offline in addition to sentence-id validity. Preserve model output and the contrary source passage when a conclusion is unsupported.
- [ ] Report strict/broad false-favourable counts, missed explicit exclusions, false rejection of eligible cases, unknowns and completion together. Predeclare acceptable development trade-offs before the next frozen evaluation; do not optimize the 98 count by simply turning every case unknown.

**Knowledge priority:** query terminology where W1 shows lexical misses; clinical definitions where W4 shows interpretation errors; arithmetic where inputs support it. The previous definition-card ablation had mixed effects and does not justify default activation. Existing clinical tools in the conversation are not automatically available inside the job's tool-less model call. Prefer one bounded preparatory context/calculation step through existing gateways if measured necessary, not another unrestricted agent loop.

### W5. Complete the evaluation contract and failure-family regressions

**Files:** `OpenScience/evals/vcr-matching-boards/{incidents.json,incidents.mjs,incidents.test.mjs,run_scenarios.mjs,run_scenarios.test.mjs,scenario_inputs.mjs,score.py,score_f.py,README.md}`.

- [ ] Every incident checks saved verdict and evidential reason in addition to score. Include a fixture where fit 0 plus `eligible` must fail, and a fixture where low recommendation plus well-supported eligibility must not be declared a clinical exclusion.
- [ ] Run at least three repeats for the existing 17 cases at the selected head; add held-out family variants, recording failure frequencies rather than implying that three successes establish safety.
- [ ] Validate a source sentence that exists but supports the opposite answer, a wrong patient/time reference, and an instruction inside a registry record. Never use regex to decide their clinical meaning.
- [ ] Keep A and F as transparent regression boards after exposure. Reserve new unseen cases or an untouched external collection for confirmatory claims. Do not relabel observed test topics as a fresh holdout.
- [ ] Preserve both native labels and F's fixed scorer mappings. Do not change mapping (c) after observing a new score.

### W6. Verify the actual product workflow and timing

**Files:** `OpenScience/apps/server/src/{vcrGateway.mjs,vcrWorker.mjs,vcrMatchJudge.mjs,vcrConversationCompletions.mjs,vcrPatientContext.mjs,vcrRecordsImport.mjs,vcrDataPlane.mjs}`, the matching skill/tool descriptions, and `OpenScience/evals/vcr-matching-boards/run_scenarios.mjs`.

- [ ] Replay protocol plus roster, a Chinese-only search request, same-patient follow-up, an actual text PDF, a scan through the authorized parser, topic switch, no record, registry outage and cross-account access with the real DSH/kernel path.
- [ ] Assert the result was saved under the correct study/person/version and that reply, page and export agree. A correct answer with no saved result fails this product task.
- [ ] Exercise first-row wait, mid-stage cancellation, provider outage, database timeout, crash/reclaim, budget stop, stale source and failed rejudgment with recovery. Retain earlier usable results visibly marked as earlier, and account for outstanding pairs.
- [ ] Trace queue wait, search planning, registry read, rerank, fit calls, clauses, database, completion notification and final reply. Record first useful result and full completion separately, with P50/P95 and cost.
- [ ] Test bounded concurrency 8 versus 12 versus 16 on the same 20-candidate cases only after identifying the critical path. Track 429s, retries, fairness and other-account delay. Never claim a 5,000-person model-double test establishes this performance.
- [ ] Keep 2-minute P50 as the stated target; report measured failure if unmet. Any proposed target revision carries the latency evidence and product trade-off explicitly.

### W7. Revalidate permission, lifecycle and release consistency

**Files:** `OpenScience/apps/server/test/{vcrMatchSecurity.integration.test.mjs,vcrMatchResults.integration.test.mjs,vcrRecordsImportBounds.test.mjs}` and the corresponding source modules; `OpenScience/evals/harness-adaptation/tools/snapshot_guidance.mjs` and its generated snapshot.

- [ ] Re-run the historical security reproductions at the selected head with an isolated PostgreSQL database. Assert response content, outgoing calls and persisted remnants, not HTTP 200 alone.
- [ ] Define the existing-source contract for shared originals and individual withdrawal; check unauthorized reuse and project-deletion races. Preserve unrelated patients' records and the established retention policy.
- [ ] Ensure a member-started job, page, export and conversation use the same effective source grant; test revocation during execution and before a saved-result read.
- [ ] Regenerate the stale guidance snapshot through its owner tool after checking the source diff. Re-run its focused test and the capability-audit-suite step. Do not weaken the assertion or confuse this with a production probe.
- [ ] Run full engineering checks at one selected revision and record environmental skips. Retain deployed-tool probe gaps for candidate verification; no probe is invented to make the audit green.

Illustrative existing verification commands from `OpenScience` (PostgreSQL tests require `OPEN_SCIENCE_TEST_POSTGRES_URL` pointing to an isolated test service):

```sh
node --test packages/domain/test/vcrTrialJudgment.test.mjs
node --test apps/server/test/vcrMatchJudgeStages.test.mjs apps/server/test/vcrMatchResults.test.mjs
node --test apps/server/test/vcrMatchSecurity.integration.test.mjs apps/server/test/vcrMatchResults.integration.test.mjs apps/server/test/vcrRecordsImportBounds.test.mjs
pnpm ci:web
```

Expected: applicable tests pass; missing environments remain explicit skips/blockers, not successes. For the snapshot, run `node tools/snapshot_guidance.mjs` from `OpenScience/evals/harness-adaptation`, inspect the generated diff and invoke that suite's documented test command.

### W8. Freeze the chosen implementation and publish an honest decision

- [ ] Freeze model/configuration/code/corpus/split/scorer after development. No test-set tuning after this point; any change becomes another labeled revision.
- [ ] Produce an English SIGIR row, TREC per-year stage table, C error breakdown, F native/mapped results, NIH micro/macro/institute results, incident contract results and real-workflow coverage/timing.
- [ ] Compare actual product-default ordering with the saved fit-only diagnostic. Preserve every missing/failed input in coverage accounting and show first attempt separately from resume.
- [ ] Claim improvement only for a prespecified endpoint with appropriate paired uncertainty and repeat stability. Use template-cluster sensitivity for 2023. Similar point estimates do not justify an equivalence label.
- [ ] Separate local checks, commit/push, CI, PR/main, candidate validation and deployment. This analysis authorizes none of the latter actions. Offline retirement of unread tables and online tool probes remain later deployment work under the existing release procedure.

## 8. Experiment matrix and spending discipline

| Experiment | Frozen control | Treatment | Primary question | Stop / retain rule |
|---|---|---|---|---|
| E0, offline | Saved final and retrieval lists | Stage/oracle accounting | Candidate loss or ordering loss? | No model calls; missing evidence remains missing |
| E1, judgment semantics | Current single fit | Separate eligibility / preference in one call | Does semantic consistency improve without new false rejections? | Keep simpler behavior if inconsistent or no useful gain |
| E2, first-stage retrieval | Current FTS5/fusion | One field/query change; then optional hybrid | Can lost eligible candidates be recovered? | No cumulative bundle before individual effects are measured |
| E3, rerank context | 1,500-character head | Bounded sections preserving exclusions/arms | Are relevant negatives or qualifiers being cut? | Reject extra latency without measurable benefit |
| E4, ordering | Incoming rerank order | Fit order, product-default order, one rank-fusion candidate | Does judgment improve the requested objective? | Diagnose graded-versus-eligible trade-offs; no benchmark-specific runtime switch |
| E5, silence/evidence | Current criteria prompt | Short source-completeness-aware guidance and bounded calculations | Reduce unsupported favourability and explicit-condition errors? | Unknown-only inflation is not improvement |
| E6, real workflow | Current ordinary conversation | Selected implementation | Are results saved, consistent and timely? | Provider failures, empty reads and unsaved answers remain visible failures |

Use existing development data for selection. All 133 E test topics and F test are now observed; their next use is regression. Obtain fresh held-out material before advertising new generalization. A full rerun of every board for every idea is unnecessary: reuse paid retrieval/judgment caches where inputs and producers match, then run the selected candidate once on the full retained boards.

The existing CNY 3,000 campaign cap is a total, not a renewed allowance. Read settled spend plus unresolved reservations and current balance before paid work; preserve the CNY 200 balance floor and off-peak batch restriction. Estimate call count and cost from this campaign's actual ledger, including retries, rather than extending old reference-price assumptions. This plan does not increase the budget.

Suggested effort sequence is 1–2 engineering days for W0/W1; 2–4 for semantics and bounded retrieval experiments; 1–2 for W4/W5; and 2–3 for real-workflow/latency/security closure. These are planning estimates, overlap where independent, and exclude waiting for missing raw evidence or service availability. They are not delivery promises.

## 9. Completion criteria for the next stage

The next stage is complete when it has a reproducible explanation of the measured losses, one selected implementation, and complete result/acceptance records at the same revision. It is not complete merely because the average score increases.

Development targets are anchored to existing controls: first recover the 2023 incoming-order nDCG@10 of 0.4753 while checking eligible P@10 against 0.3464; retain English SIGIR's 0.6509 baseline; eliminate contradictory eligibility/preference outputs on the fixed contract fixtures. These are regression targets on already-observed data, not a claim of statistical superiority or a fresh test. Do not accept improvement in one scalar by hiding a regression in another. Freeze a practical noninferiority margin and error-rate trade-off before any new confirmatory collection is opened; no new clinical safety threshold is inferred from these small, biased samples.

- Every TREC stage is present or explicitly unavailable; official, condensed and oracle scores are distinct. The selected judgment ordering has no unexplained 2023-like regression relative to its own incoming list. Official-score trade-offs that improve actual eligibility must be explained, not concealed.
- English SIGIR has its own four metrics and comparison scope. No translated-SIGIR budget or success target remains.
- The 17 original incidents plus class counterexamples check output semantics and persistence; the historical score/verdict contradiction is no longer a false pass. Explicit incompatibility and low preference are distinguishable on every user surface.
- Clause evaluation reports both unsupported favourable judgments and false exclusions, with fixed denominators and evidence-quality checks. Neither unknown suppression nor unknown inflation counts as progress by itself.
- Real conversation tests save the intended result, preserve follow-up identity/history, and recover partial work. The 115-request funnel is reconciled; new Chinese usability tests have a fixed denominator and distinguish no candidate from ineligibility.
- First-attempt completion target remains at least 98%; resumed completion is separately reported. The latency target and any remaining gap are explicit. Full tests, CI and candidate/runtime validation retain their own states.

Historical gap coverage: W2/W4 address G1/G12/G13/G14/G17/G19/G25; W3/W6 address G10/G11/G24; W6 addresses G2–G9/G15/G16/G18/G20/G21/G23/G26/G27; W7 covers G22/G28/G29 and cross-cutting security. “Covered by a work package” does not mean already fixed.

## 10. Reproduction and sources

The new JSON was computed without reading patient text. Paired intervals use the same topic's final minus incoming score, Python `random.Random(20261105)`, 20,000 samples of n topics with replacement, and sorted draws at indices 499 and 19,499. Wins/ties/losses use tolerance 1e-12. Recall means use the saved eligible denominators and capacities; NIH macro uses exact institute hit counts. Input SHA-256 hashes are stored beside the results. These aggregate reanalyses do not replace the original scorers.

Reproduce the paired nDCG table from the repository root without a service, credentials or model calls:

```sh
python3 - <<'PY'
import json
import random
import statistics
from pathlib import Path

source = Path('docs/superpowers/plans/2026-11-04-vcr-matching-delivery-assets/scores/board-e-end2end.json')
rows = json.loads(source.read_text())['rows']
for year in [2021, 2022, 2023, 'pooled']:
    selected = [row for row in rows if year == 'pooled' or row['year'] == year]
    differences = [row['ndcg10'] - row['retrievalOrderNdcg10'] for row in selected]
    rng = random.Random(20261105)
    draws = sorted(
        sum(rng.choices(differences, k=len(differences))) / len(differences)
        for _ in range(20000)
    )
    print(year, len(selected), statistics.mean(differences), draws[499], draws[19499])
PY
```

Expected 2023 row: 28 topics, mean -0.1090217575, interval [-0.2063470121, -0.0145541025]. This calculation needs no access to qrels or patient notes because it compares already-saved topic scores.

External sources checked on 2026-11-05:

- [TrialGPT 2.0 v2, methods and Supplementary Figure 3](https://arxiv.org/html/2609.01202v2): judged-pair protocol, figure labels and institute-macro NIH definition. Our comparisons use these defined quantities, not a fresh upstream reproduction.
- [Pinned TrialGPT 2.0 repository](https://github.com/TrialGPT2/TrialGPT2.0/tree/1c5f9ebc3b98d1f780ceea68043efdaa2daba880): packaged cohort sizes and evaluator interface.
- [TREC 2023 official task](https://www.trec-cds.org/2023.html): questionnaire inputs, changed corpus and graded judgments.
- [Original TrialGPT paper](https://www.nature.com/articles/s41467-024-53081-z): lexical/semantic hybrid retrieval is an existing upstream candidate to evaluate, not a reason to build a second platform.
- [CI run inspected](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41979809075): current engineering state must be refreshed before execution.

Limitations: no raw pre-cut retrieval output, original qrels, full conversations or production environment was replayed here; original NIST run scores are taken from the archived result report. No current exploit was claimed from an old review alone. The pure-function contract reproduction and new paired arithmetic are the only newly executed behavior/statistical checks. All proposed causal mechanisms beyond these observations require the discriminating experiments above.
