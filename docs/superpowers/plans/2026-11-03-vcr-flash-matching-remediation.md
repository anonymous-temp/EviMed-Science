# VCR patient matching: Flash-only diagnosis and remediation

> **Superseded on 2026-11-04** by [the matching delivery plan](2026-11-04-vcr-matching-delivery-plan.md). Kept as the record of the diagnosis. Its goal of reaching the historical 87.3% was withdrawn: that gold was labelled while reading GPT-4's output, so it is reported beside other figures and is not a target.

Date: 2026-11-03, Asia/Shanghai.

Status: proposed implementation and evaluation plan. This review made no new inference calls, changed no product behavior, and deployed nothing. It re-analyzed retained public benchmark responses and inspected source at `c180ff7b53d2e9527c9dcdb9ff76bb1c6ec72226`. It does not certify the running production revision.

Owner clarification, 2026-11-03: the primary comparison must run EviMed Science's actual feature. The [platform comparison protocol](2026-11-03-evimed-trialgpt-platform-comparison.md) supersedes this document's experiment/delivery order. First measure the current platform, then repair and compare the platform again; direct API arms below are diagnostics, not the primary deliverable.

## Decision and correction of the previous conclusion

Use DeepSeek V4.1 Flash for this work. Do not run another Pro arm or introduce Jev into the remediation. Keep DSH as the existing agent kernel. The experiment should establish how to use this model and the platform effectively, rather than treat model substitution as the solution.

The previous 73.89% result measures an annotation-aligned TrialGPT prompt, sent directly to the official Chat Completions API with thinking explicitly disabled. It does not measure Flash with reasoning enabled, DSH orchestration, the full production matching path, or the model's general capability. The previous report's broad interpretation that a newer model or more reasoning did not close the gap must be narrowed: Flash reasoning was not tested. Preserve the previous responses and numbers; this document supersedes that interpretation, not those observations.

A stronger general model is a reason to investigate this implementation carefully, not evidence that an unmeasured patient-matching configuration must outperform a historical result. DSH optimization is real according to DeepSeek's release announcement; its clinical benefit here remains to be measured.

## 1. What the current external sources establish

Sources were checked on 2026-11-03. Keep publication version, benchmark version, reasoning effort, and scaffold attached to comparisons.

| Evidence | Observation | Implication |
| --- | --- | --- |
| DeepSeek current model/pricing page [1] | `deepseek-flash` names V4.1-Flash-1017. Legacy `deepseek-v4-flash` also routes to it. | The previous Flash request alias alone is not evidence of an obsolete model. All 210 original Flash response bodies identify `deepseek-flash`. Exact historical weights cannot be certified from this alias alone. |
| DeepSeek 1017 announcement [2] | Explicitly describes optimization for DSH and recommends DSH 0.2.1-rc.1 or later. | Local source pins rc.5, which is within the recommended version range. Verify the actual runtime and outbound settings; the source pin alone is not runtime evidence. |
| DeepSeek thinking API [3] | Thinking defaults to enabled/high. OpenAI-format requests support `thinking.type` and `reasoning_effort`. Temperature is ineffective in thinking mode. | Our explicit `disabled` overrides that default. A temperature-zero call is not a test of the model's best reasoning configuration. |
| Artificial Analysis current v5 pages [4-6] | Rounded index scores are 19 for non-reasoning, 29 for high, and 32 for max. | Reasoning mode materially changes this model's measured aggregate performance. This does not quantify a TrialGPT improvement. Do not mix these values with older index versions. |
| Artificial Analysis GPT-4 page [7] | Deprecated; the current intelligence index is N/A. | Do not invent a same-version Flash-versus-original-GPT-4 numerical comparison from this site. |
| DeepSeek 1017 model card [8] | Reports broad improvements and different benchmark scaffolds, including Claude Code for Terminal-Bench 4.0 and Mini-SWE-V2 for DeepSWE. | There is no universal “DSH score multiplier.” Compare task, harness, settings and resource limits together. |
| TrialGPT paper and repository [9-10] | Retrieval, criterion matching and ranking are separate stages. The paper used GPT-4-0613; criterion annotation covers 53 descriptions / 1,015 pairs, distinct from the broader 183-patient evaluation. | Compare the same stage and denominator. The historical 87.3% is a useful task benchmark, not a general-model league table. |

The September announcement's historical Pro routing notice and today's pricing table describe different points in time. Neither is needed to justify another Pro experiment. This plan excludes Pro.

## 2. Offline diagnosis of the retained Flash outputs

Evidence: `.evimed-local/acceptance/vcr-flash-diagnostic-20261103/diagnostic.json`. The file records source hashes, exact counts and illustrative public annotation IDs. The original receipts remain unchanged under `vcr-trialgpt-reproduction-20261102`.

### The gap is concentrated in uncertainty classification

| Reference-label partition | N | Flash, thinking disabled | Historical cached GPT-4 |
| --- | ---: | ---: | ---: |
| `not enough information` | 293 | 95 correct, 32.42% | 255 correct, 87.03% |
| Other five reference labels | 722 | 655 correct, 90.72% | 631 correct, 87.40% |
| All annotations | 1,015 | 750 correct, 73.89% | 886 correct, 87.29% |

This is a post-hoc diagnostic partition, not a replacement headline metric. The 722 cases include `not applicable`; they are not all unequivocal positive/negative clinical facts. These are reference-label agreements, not independently adjudicated clinical accuracy rates.

Of 265 Flash disagreements, 198 (74.72%) occur on reference-unknown cases. Those cases account for a 160-correct-answer deficit versus cached GPT-4; Flash gains 24 correct answers on the remaining labels, producing the net 136 deficit. Among the unknown cases, Flash assigns `included` or `not excluded` to 132. These are criterion-level reference disagreements, not 132 wrongly enrolled patients.

The strict prompt swings the other way: it recognizes 263/293 reference-unknown cases, but changes 329 reference-`not excluded` cases to unknown. Therefore neither “infer absence whenever important information is unmentioned” nor “make almost every unmentioned condition unknown” is an adequate task policy.

There are five missing/invalid original Flash predictions, including three known parser omissions. Even an impossible perfect repair of all five would add only 0.49 percentage points. Output parsing cannot explain the roughly 13.40-point total gap. The earlier equivalent-object parser issue affected Pro; it is not an explanation for this Flash result.

### Concrete examples, not only aggregate scores

| Public annotation ID | Observed failure | Required correction |
| ---: | --- | --- |
| 43 | The reply uses the trial's lung-cancer topic plus a patient lung mass to assert the patient is a lung-cancer patient. The reference is unknown. | Separate trial requirements/background from patient evidence. A suspected diagnosis must not become a confirmed patient fact. |
| 92 | The reply turns an expected pulmonary angiography referral into an actual referral. | Preserve planned, recommended, ordered and performed events separately. Clinical plausibility is not an event record. |
| 15 | Age is substituted for missing pregnancy/nursing evidence. | Applicability rules and population priors must not manufacture a patient-specific negative test/status. |
| 50 | Missing IVIG history becomes failure to meet a treatment-response criterion. | Unrecorded previous treatment/response remains unresolved; do not infer an entire treatment history from silence. |
| 106 | Missing admission laboratory documentation becomes a conclusion that the tests were not done. | Distinguish “not documented” from “not performed.” |
| 24, 479 | `not applicable` is replaced with `not excluded`. | Evaluate a conditional criterion's premise separately from the predicate; preserve the benchmark adapter's labels. These disagreements need not imply a clinically different patient-level disposition. |

These selected examples illustrate mechanisms; they are not a clinician-adjudicated exhaustive taxonomy of all 265 disagreements. The full next audit must label every disagreement and an independently selected sample of agreements, so plausible explanations are also checked when the label happens to agree.

## 3. Confirmed implementation facts and unproven causes

| Finding | Evidence in source | Confidence / consequence |
| --- | --- | --- |
| The primary Flash evaluation disabled thinking | `OpenScience/evals/vcr-trialgpt-reproduction/run.py`, `payload()` | Confirmed configuration. Its effect size is unknown until paired Flash arms are run. |
| That evaluation bypassed DSH | Same runner calls the evaluation `ProviderClient`; `evals/vcr-model-comparison/api.py` calls the official endpoint directly | Confirmed. No agent tools, evidence re-reading or DSH repair sequence were measured. |
| Production batch extraction also disables thinking | `apps/server/src/vcrMatchBatch.mjs`, `createFactExtractor()` | Confirmed at this checkout. Changing the DSH conversation's effort does not change this separate control-plane caller. |
| Production extraction has a 2,000-output-token allowance | `packages/domain/src/vcrMatchBatch.mjs`, `VCR_MATCH_BATCH_LIMITS.outputTokens` | Confirmed. Simply enabling reasoning under this cap is not a sound fix; measure reasoning/final-token usage and update the budget estimator together. No new truncation rate is claimed. |
| Batch extraction does not complete language predicates | `planBatch()`, `pendingLanguageKeys`; matching SKILL section three | Confirmed. Conversation currently joins extraction, outstanding language judgments and deterministic assessment. This is a real orchestration path, but batch-level completion/coverage remains incomplete. |
| Source anchoring is weaker than semantic support | `vcrMatching.mjs`, `evaluateLanguage()` verifies cited source spans | Confirmed. A real quotation can still fail to support the claimed diagnosis, time, subject or predicate. Exact quotation checks must remain, but do not certify entailment. |
| Long-note selection can omit necessary context | `vcrMatchBatch.mjs`, `recordView()` selects lexical passages or the document head | Confirmed selection behavior; impact on actual long notes needs measurement. A valid positive quote does not protect against omitted negation, correction or later contradictory records. This does not explain short-note TrialGPT errors by itself. |
| Retrieval order is not eligibility ranking | `vcrCandidateSearch.mjs`; `vcrPatientTrials.mjs`, `rankPatientTrials()` | Confirmed. Current final order uses eligibility tier and decided-criterion coverage; its ranking utility needs a dedicated test. More complete documentation is not automatically greater clinical relevance. |

Already-fixed issues must not be presented as still-open defects: the first-80-character/first-use context loss, missing interval metadata, out-of-window negative inference, timezone-dependent date bindings, extraction budget/cache identity, and metric-definition drift were repaired in `c180ff7b5`. Retain their regression tests. Their repair has not yet been evaluated through a full new DSH clinical matching run.

## 4. Target workflow using existing architecture

The researcher supplies a patient description or dataset and a matching question. DSH interprets the request, locates the relevant trial/record versions, starts the existing durable jobs, and presents the resulting comparison with source evidence and specific missing items. Tools remain implementation details, not a sequence of calculators the user must operate.

1. **Interpret the protocol once per version.** Preserve every original inclusion/exclusion clause, its applicability premise, AND/OR structure, temporal anchor, measurement and event-state requirements. Retain ambiguous language for model judgment rather than forcing it into a guessed numeric predicate. Verify original-clause coverage before assessment; incomplete parsing is not clinical uncertainty.
2. **Build a patient evidence view.** Reuse source documents, locators, timestamps and clinical context. Read short records whole. For long records, retrieve criterion-relevant passages plus neighboring sections, date headers, negations, corrections and competing results. Keep retrieval completeness and unprocessed sections visible to the worker. A search miss is not negative evidence.
3. **Use Flash to interpret language with evidence.** Distinguish observed facts, explicit denials, supported derivations, uncertain hypotheses, family history and missing information. A supported derivation may use established definitions and verified inputs; it must identify both, and must not be stored as an observed test or event. Trial background never supplies patient facts.
4. **Let code compute what is well specified.** Apply unit conversions, calendar windows, age, counts, thresholds, exclusion polarity and logical combinations to verified inputs. Preserve uncertainty through combinations. Code should not attempt to replace language understanding with a growing keyword list.
5. **Re-read targeted contradictions.** Trigger a bounded Flash review when a proposed decisive answer has missing support, contradictory dates/results, a suspected-versus-confirmed mismatch, a conditional-premise mismatch, or conflicting first-pass judgments. Review the original clause and relevant source independently; request a short evidence rationale, not a long self-affirming essay. Same-model review is not independent clinical validation.
6. **Complete the job automatically.** Within the existing worker/job ledger, schedule outstanding language work after extraction, persist its answers, assess, and return the result to the initiating conversation. Distinguish queued/unfinished/failed computation from genuine missing clinical data. Cancellation and resumption preserve completed work. No second agent framework is needed.
7. **Rank after judging, and expose uncertainty.** Distinguish relevance, verified eligibility, evidence coverage and information gaps. Keep potentially suitable but incomplete trials discoverable. Evidence-backed exclusion cannot be overridden by a high relevance score. An “all criteria met” display must also require complete criterion coverage for that frozen protocol.

DSH should own task orchestration and selective follow-up. Bulk record/criterion evaluation should remain in bounded background jobs using the same Flash model through the existing model gateway. Do not start one DSH session per criterion; that repeats context and creates avoidable cost and failure opportunities.

## 5. Implementation work packages

| Priority | Work | Existing integration points | Acceptance evidence |
| --- | --- | --- | --- |
| P0 | Correct experiment identity and interpretation | Reproduction README/results metadata; evaluation runner; model gateway receipts | Canonical `deepseek-flash`; documented provider mapping date; requested/served alias, reasoning effort, output ceiling, finish reason and code/prompt hashes attached to each arm. Old results preserved. |
| P0 | Add Flash reasoning configuration and matching budgets together | `createFactExtractor`, domain batch planner and cache identity | Frozen high-effort configuration; adequate output/time allowance measured on development cases; all chunk costs reserved; changing effort invalidates cached inference; truncated work is explicit, never valid empty evidence. |
| P1 | Replace blanket missingness instructions with explicit evidence semantics | `vcr-matching` skill and batch prompt; existing clinical metadata/evidence writer | Positive and counterexample tests for each observed error family; no conversion of a possible diagnosis or expected treatment into a recorded event; valid clinical derivations still work. |
| P1 | Complete outstanding language predicates in the durable job | Existing batch executor/worker, `language_judgment` writer, assessment snapshot | All requested clauses are settled or have explicit unresolved/error reasons after background completion; no manual conversation nudge is required; cancel/resume and source-version changes work. |
| P1 | Add targeted semantic support and contradiction checks | Evidence/judgment path and existing source reader | Real but irrelevant quotations are rejected as support; positive and negative contexts remain accessible; review attempts are bounded and fully counted. |
| P1 | Measure/fix long-record evidence coverage | `recordView`, passage retrieval, document reader | Located evidence and corrections from late sections survive selection; missing sections remain declared; compare full-note and selected-evidence arms on the same records. |
| P2 | Calibrate retrieval and ranking separately | `vcrCandidateSearch`, `vcrPatientTrials`, existing TREC harness | Recall and nDCG use frozen corpus/candidates/qrels; patient-level exclusion and uncertain candidates are checked separately from ranking. No Jev/Pro dependency added. |
| P2 | Simplify the existing result experience | `MatchingTab.tsx`, `ClinicalMatchingDetails.tsx`, conversation result composition | A result-first list plus criterion/evidence details; task progress and missing evidence in plain language; technical budgets/logs remain internal. No top-functions/bottom-project-list redesign introduced. |

Do not create a new generic orchestration service, a parallel evidence database, or a benchmark-specific production branch. Reuse existing study, protocol, fact, judgment, job, snapshot and assessment records. New semantic fields must have explicit versioning and an adapter into the existing vocabulary.

## 6. The experiments that can identify the cause

### Stage A: configuration and evidence audit before another large run

- Label all 265 current disagreements and a prespecified, stratified sample of current agreements. Separate annotation-policy ambiguity, applicability, unsupported inference, context omission, temporal reasoning, output failure and mapping failure. Preserve original expert labels; any second clinical adjudication is a separate reference layer.
- Use the existing ten development patients for configuration debugging. The previous 43-patient evaluation partition has already been inspected; call the full set public regression, never a fresh holdout.
- Inspect sanitized outbound requests on both paths: DSH's Messages adapter and the worker's Chat Completions caller. Confirm effort reaches the provider, reasoning tokens are available where reported, tool-call context is retained according to the applicable protocol, and the actual runtime matches the recorded pin. No keys or patient text in telemetry.
- Start with a small fixed development probe. Choose an output allowance, initially 32K for the experiment, from actual completion distributions. If it truncates, revise the allowance before freezing the comparison; do not silently retry successful answers or choose the best output. The production allowance is chosen from measurements, not copied mechanically from this experiment.

### Stage B: isolate model mode, reasoning policy and harness effects

Every arm uses Flash only. Freeze input, prompt, scorer, corpus, allowed tools, stop rules, configuration and maximum spend before inference. Interleave contemporary paired calls where possible because provider aliases can change.

| Arm | Question | Configuration |
| --- | --- | --- |
| A | Contemporary reproduction baseline | Original aligned prompt, no thinking, direct API. Match output allowance and data to B; the old 73.89% remains a historical local baseline. |
| B | Does Flash reasoning help this task? | Same input/prompt as A, thinking enabled/high. No tools. Test max on development data only if high leaves demonstrated reasoning failures. |
| C | Do explicit evidence/applicability rules fix the dominant errors? | Same model/mode/input as B, revised structured judgment instructions; no tools. |
| D | Does the DSH workflow improve useful outcomes? | Same Flash configuration and source data as C, actual pinned DSH with the proposed evidence-reading/calculation/targeted-review workflow. |
| E | Does the shipped product retain the gains? | Full local platform route: request, protocol parsing, data intake, background completion, assessment, ranking and rendered result. |

B versus A estimates the configuration effect; C versus B the judgment-policy effect. D versus C estimates the combined agent/tool workflow effect, not a pure kernel effect. A strict harness-effect claim would require a tool-equivalent non-DSH controller; that extra controller is not required to make the product useful. E measures losses introduced by the product boundary. Also report cost-matched quality if claiming efficiency, not just quality under a larger budget.

Allow only frozen supplied patient records, trial corpus and approved calculation/terminology tools in the benchmark runtime. Expert labels, cached GPT-4 answers, prior predictions, this diagnostic's examples and scorer files stay outside the model workspace. Disable benchmark-time memory carry-over and web searches that could retrieve the public answers. Production can still search trial registries; the isolated benchmark should not search for its own solutions.

### Stage C: distinct evidence sets and metrics

| Data / exercise | Purpose | Required output |
| --- | --- | --- |
| TrialGPT, all 1,015 rows | Public criterion-level regression | Overall agreement, macro-F1, each label's recall/precision, complete confusion matrix, unknown-to-favorable and unknown-to-negative transitions, missing outputs, evidence localization, cost and latency. Always retain the full denominator. |
| Existing TREC 2021-2023 snapshots | Retrieval and ranking | Recall@100/500, nDCG@10 and graded relevance definitions; candidate coverage and unjudged-topic treatment. Paired results under identical corpus and candidate sets. Historical six-candidate or top-ten reranking tasks are not full retrieval benchmarks. |
| n2c2 development then sealed evaluation | Real longitudinal note interpretation within that task's scope | Freeze criteria definitions, parser and inference settings before opening sealed labels. Use the existing authorized data route; no new provider destination. Report dataset-specific criterion and patient metrics, and note its disease/task scope. |
| Separately authored Chinese cases plus a fresh clinician-adjudicated set when available | Chinese language and practical validity | Distinguish engineering fixtures from real clinical validation; split by patient and study, include negation, dates, units, plans, conflicts and missing information. Use blinded dual review/adjudication for clinical labels. |
| Local DSH/backend and a small browser sample | Product usability and execution completeness | Complete successful cases, unresolved cases, missing uploads, resumed jobs, newly added evidence, changed protocols and cancel/restart. Test large corpora in the backend; screenshots only for representative UI states. |

Report uncertainty by resampling patients rather than treating 1,015 correlated criteria as independent patients. For repeated runs, report all prespecified repetitions, not the highest score. Freeze any reviewer trigger and acceptance threshold on development cases before evaluating new patients.

### Acceptance criteria and decision rules

- **Benchmark objective:** reach at least the historical 87.3% criterion agreement on the same public reference, while reporting unknown recall, other-label performance and all failures. This is a target, not a forecast. A superiority claim additionally needs a positive patient-cluster paired difference with uncertainty reported; a single higher point estimate is insufficient.
- **Do not trade all uncertainty for accuracy:** explicitly report the 293 unknown cases and the 722 other-reference-label cases together. A candidate that fixes unknowns by destroying supported negative/positive decisions is rejected. Compare false exclusions at matched coverage, not by abstaining on every difficult case.
- **Reference policy versus product evidence:** preserve TrialGPT's original labels and score the product's real outputs through a documented, semantics-preserving adapter. Do not silently reinterpret clinical unknown as benchmark-negative. If expert adjudication identifies a legitimate policy disagreement, report both original-benchmark agreement and the separate adjudication result.
- **Engineering acceptance:** no omitted clause may be reported as assessed; no truncated call may become valid empty evidence; dates/units/exclusion logic and quote locators pass positive and counterexample tests; every asynchronous stage terminates, resumes or exposes a recoverable state.
- **Clinical pilot acceptance:** predefine decision thresholds with the study owner and independent labels. Include false inclusion/exclusion, usable coverage and human review time. Neither a universal 90% accuracy number nor 233 unit tests establishes suitability for a clinical workflow.
- **Default activation:** only the selected Flash configuration and complete workflow advance, with all paid attempts counted. If it fails, retain the evidence and the better validated behavior; do not keep adding samples or examples after seeing the held-out labels.

## 7. Researcher-facing behavior

The normal interaction is “Find potentially suitable trials for this patient” or “Assess these patients against this protocol.” The platform performs the sequence itself.

- **Single patient:** a patient description or record is required; a tabular dataset is not. Trial criteria may come from an uploaded protocol or a preserved registry record.
- **Batch matching:** highlight that a patient dataset/record collection is required, with identifiers and relevant source dates. Do not require researchers to precompute predicates or manually call an extraction tool.
- **Results:** show potentially suitable trials, evidence-backed exclusions and cases needing more information. A selected result opens the original criterion, supporting/contradicting record excerpts, any deterministic calculation and the specific item that would resolve uncertainty.
- **Progress:** say that records or criteria are still being assessed. Distinguish this from absent clinical information. A completed extraction alone is not a completed match.
- **Explanation:** provide a concise evidence-based justification and tool-derived values. Do not expose raw internal chain-of-thought, model-routing diaries, schema names or execution receipts as product content.
- **Follow-up:** a supplied missing test/date or revised protocol recomputes only affected assessments under a new version. Existing results remain accessible. No patient contact, referral or recruitment OA workflow is reintroduced.

Keep virtual cohorts, virtual patients, synthetic controls and trial design available as the existing research tasks. Better matching can improve cohort selection and identify missing covariates; it does not validate generated longitudinal outcomes, drug counterfactuals or external-control treatment effects. PhysioNet and ACTG175 remain separate validation tracks and must not be used to inflate the matching result.

## 8. Delivery order

1. Correct the interpretation and instrument Flash settings; finish the error taxonomy.
2. Run the small Flash off/high configuration contrast and select an adequate reasoning budget.
3. Implement the evidence semantics and complete background language judgment; preserve the repaired numerical/evidence contracts.
4. Run the controlled full public regression, then the actual DSH/product path; independently evaluate n2c2 under frozen settings.
5. Finish ranking and the result-first interaction, then representative browser acceptance.
6. Review, local verification, commit and push the implementation with the remaining gaps explicitly recorded. Deployment remains outside the current authorization.

No completion date or improvement magnitude is promised before the controlled configuration test. Success is a measured, usable matching workflow with appropriate uncertainty, not more calculator pages or more passing fixture tests.

## Sources

1. [DeepSeek model identity and pricing](https://api-docs.deepseek.com/quick_start/pricing/).
2. [DeepSeek V4.1 Flash 1017 announcement](https://api-docs.deepseek.com/news/news261017/).
3. [DeepSeek thinking and tool-call behavior](https://api-docs.deepseek.com/guides/thinking_mode/).
4. [Artificial Analysis Flash 1017, non-reasoning](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017-non-reasoning).
5. [Artificial Analysis Flash 1017, high](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017-high).
6. [Artificial Analysis Flash 1017, max](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017).
7. [Artificial Analysis original GPT-4](https://artificialanalysis.ai/models/gpt-4).
8. [DeepSeek V4.1 Flash 1017 official model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017).
9. [TrialGPT, Nature Communications, 2024](https://www.nature.com/articles/s41467-024-53081-z).
10. [TrialGPT official code and data](https://github.com/ncbi-nlp/TrialGPT).
11. [Real-world validation of a multimodal LLM-powered matching pipeline, Communications Medicine](https://www.nature.com/articles/s43856-025-01256-0). Relevant design precedent for criterion interpretation and evidence retrieval, not a directly comparable score or validation of our pipeline.
