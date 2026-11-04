# EviMed Science versus TrialGPT: platform evaluation protocol

> **Superseded on 2026-11-04** by [the matching delivery plan](2026-11-04-vcr-matching-delivery-plan.md), which scores the feature on the upstream data with the upstream scripts (`OpenScience/evals/vcr-matching-boards/`). The harness this protocol describes belongs to the path that was replaced.

Date 2026-11-03. The integrated product and Docker harness were pushed and the first-attempt matching baseline is recorded. The TREC operational probes encountered upstream model failures. See the [baseline results](2026-11-03-evimed-trialgpt-platform-baseline-results.md).

Owner execution amendment (2026-11-03): merge `c180ff7b5` with the current integration line (`origin/codex/release-1102`, `3970e4f8f`) first. Implement missing ranking and a usable frozen-corpus retrieval path, verify locally, commit and push before the paid platform baseline. Production remains the owner's reported November 1 version and is not the baseline. Run a real local DSH kernel. This amendment supersedes any earlier instruction here to benchmark the unmerged feature or count alignment failures as incorrect predictions.

### Execution ledger

- [x] Merge both lines without losing either line's evidence/date fixes (`faa8d0f28`).
- [x] Connect explicit trial matching ranking to the product result path, including coherent reads and source-refresh write fencing.
- [x] Support a frozen, versioned trial collection through the same product retrieval/record boundary, with up to 500 candidates and paged reads; preserve live-registry behavior separately.
- [x] Implement source-span alignment with explicit unresolved buckets; the executable policy is frozen with each campaign before inference.
- [x] Build the local platform driver with throwaway-account lifecycle, automated attribution, patient-specific projects/sessions, and memory extraction disabled.
- [x] Complete scoped product tests and independent review; commit/push the integrated product candidate without deployment (`3434ff107`, followed by intake fix `aa17e0d66`).
- [x] Close the Docker environment review and push the harness in `3eee7f765`. Verify the live isolated instance before inference.
- [x] Record all 53 first attempts and score the 603 aligned conditions. Preserve failed and interrupted attempts and publish the [baseline findings](2026-11-03-evimed-trialgpt-platform-baseline-results.md).
- [ ] Restore a repeatable TREC end-to-end path and measure all frozen topics. The three initial topics failed before producing a retrieval receipt or saved order.
- [ ] Fix the semantic and product-completion findings and run a paired comparison on the frozen inputs.

### Mandatory test hygiene

Each campaign registers and deletes its own account using `scripts/ops/throwaway-account.mjs`. Cleanup is required on success, failure and interruption; cancel owned jobs before deletion and retain an explicit cleanup receipt. Each patient gets a different project and conversation because conversations in one project share files. All dispatched/native runs carry verifiable `automated` attribution. Disable memory extraction and benchmark memory read/write/learning, and verify effective configuration rather than merely omitting a memory service. Model-visible workspaces contain no gold labels, prior answers or scorer code. Export needed test artifacts before deleting the account. No production account, production runtime or historical business workspace is used.

Implementation clarification: each patient receives a separate throwaway account as well as a project/session, bounding retained runtime disk usage. All inference uses the supported automated dispatch route; native browser submissions do not expose the automation mark and are not used for paid bulk inference. The actual resolved configuration and live-instance receipt are checked. The host DSH adapter is now diagnostic-only: a case bypassed the platform and read historical corpus bytes on the host. All host campaigns are quarantined, not just that case. Formal runs require Docker project isolation, a control-plane-only frozen index, no host/gold mounts, direct public egress blocked, mediated public-source/search and live-registry routes refused, and a current-instance no-model probe. The runtime may not access browser/admin APIs. This public regression must not be advertised as an independent clinical holdout. The durable benchmark budget journal includes every model purpose and survives account deletion; it uses reference-price estimates and preserves uncertain charges.

### Frozen alignment rule

Align only within the same patient/trial, criterion kind, frozen source document and source version. Normalize Unicode/whitespace conservatively while retaining a mapping to original character positions; preserve numbers, units, negation and logical operators. Locate literal annotation and platform source fragments first. Repeated occurrences without a unique location are ambiguous. Compare overlap of anchored source intervals, not embeddings or answer labels. Fixed thresholds and tie-breaking must be versioned and hashed before scoring.

Prefer an exact whole-clause judgment. A split/merge relation must not copy a parent verdict onto every child. Score a fragment group only when the original clause's judgment or an explicitly preserved, supported composition makes the result unambiguous. Otherwise retain it as `split_unresolved`, `merged_unresolved`, `source_unlocated` or `ambiguous_overlap`. Do not have an LLM invent a mapping or use the gold answer to select one.

Report `N=1015`, aligned/scorable M, correct C among M, C/M, M/N, and every unresolved bucket. Recompute historical GPT-4 agreement on the same scorable IDs for the paired comparison. Unaligned rows are neither incorrect nor dropped; they remain in the manifest and coverage report. Inference failures on an already aligned criterion remain failures. A low-coverage result cannot establish superiority even when its conditional accuracy is high.

This document takes precedence over the experiment order in `2026-11-03-vcr-flash-matching-remediation.md`. That document remains the component diagnostic and remediation backlog. The primary treatment is EviMed Science's patient-matching feature, running on its normal DeepSeek + DSH foundation. Direct API and isolated DSH experiments are diagnostic controls only.

## 1. Decision to be made

Can a researcher give EviMed the same patient and trial information available to TrialGPT and receive a more useful, accurate and complete matching result through the actual product?

Measure the product before changing it. Then remediate the stages responsible for observed losses and rerun a frozen comparison. Do not replace this question with a model leaderboard, a calculator test, or a manually populated assessment database. Use V4.1 Flash throughout new inference; no Pro or Jev arm is required. A research baseline's existing non-generative retrieval models, such as MedCPT, remain part of that baseline rather than new production LLM providers.

The initial scope is patient-to-trial matching. Trial-to-patient batch assessment is a separate product exercise. Virtual cohort generation, virtual patients, synthetic controls and trial simulation keep their own validity tests; they are not tasks TrialGPT was designed to solve.

## 2. Verified product entry and why old harnesses are insufficient

Source reviewed at `c180ff7b53d2e9527c9dcdb9ff76bb1c6ec72226`:

- `VcrHomePage.tsx` uses `TaskEntry` to populate a draft, not execute a precompiled matching job.
- `useGeneralResearchDraft.ts` selects the default project and opens the native conversation with that draft. The ordinary-conversation skill permits patient matching without a pre-existing study or questionnaire.
- `runtimeUiServer.mjs` admits native `session/prompt` traffic through the application's authenticated boundary. Its own comments explicitly distinguish this primary surface from `/api/agent-runs/dispatch`.
- `vcrExecutionContext.mjs` verifies the originating transcript/run. A test must not fabricate that proof or inject a trusted study context.
- `vcrPatientContext.mjs` accepts authenticated original messages or owned uploads, not model-written patient narratives as evidence.
- VCR's real gateways, data plane, workers, matching engine and persistence then produce research objects. The displayed result and its underlying assessment are both evaluation outputs.

The representative browser path is:

`VCR matching entry -> native composer -> normal attachment intake -> authenticated native prompt -> normal routing/DSH -> VCR tools and background jobs -> persisted assessment -> conversation and study result views`.

For high volume, a backend driver must send the same class of admitted request and use the same data-intake path. It replaces repetitive human clicking, not product computation. Derive its endpoint/frame from the application's existing transport rather than inventing a second prompt API or connecting directly to the kernel. Record automated provenance so benchmark interactions do not teach the user's memory or learning loop. Use owned synthetic uploads where inline-human-evidence admission would otherwise be inappropriate; do not spoof a human actor.

Existing reusable pieces and their limitations:

| Existing harness | Reuse | Not valid as the main product measurement without changes |
| --- | --- | --- |
| `scripts/ops/vcr-serving-acceptance.mjs` | Runtime/revision checks, artifact and run inspection | Starts the older module-managed study/step path; current home entry uses a conversation draft. |
| `scripts/vcr/live-acceptance.mjs` | Authenticated HTTP, durable attempt receipts, export checks | Contains engine-job/step exercises; those are not native user matching decisions. |
| `evals/general-tasks/runner/cell.mjs` | Disposable accounts, uploads, outputs, run observation | Uses dispatch; native composer equivalence must be demonstrated, not assumed. |
| `evals/method-quality/run_native_vcr.mjs` | Diagnostic DSH/tool instrumentation | Explicitly isolated, not the full hosted boundary; seeds criteria, uses runtime doubles and sets thinking off. |
| `evals/vcr-trialgpt-reproduction` | Frozen source/input manifests and offline criterion scoring | Calls the provider directly and does not test EviMed's feature. |

A successful smoke test must show the actual route and output ownership before the large run starts. A script's name containing `native` or `live` is not sufficient evidence.

## 3. Comparison arms

| Arm | Role | Interpretation |
| --- | --- | --- |
| E0: current EviMed Science | Primary baseline | Current complete product, including its current routing, skills, model settings, tools and ranking. Freeze before remediation. |
| E1: corrected EviMed Science | Primary treatment | Same entry, inputs and evaluation, after scoped fixes. Shows whether the product improved. |
| T-history: released TrialGPT answers | Historical reference | Cached GPT-4 criterion answers can be rescored against expert labels. Historical ranking comparisons require the matching cohort, candidate universe and result files. |
| T-Flash: official TrialGPT workflow with Flash | Architecture control | Reuse official retrieval/matching/aggregation/ranking logic, changing the LLM adapter to the same Flash configuration. It is not the paper's GPT-4 result. |
| F-Flash: direct Flash | Small diagnostic control | Same input and question; helps locate product/prompt loss. It does not replace E0/E1. |

Do not start by running every possible API arm across all datasets. First observe E0 on a fixed small platform sample and the full criterion dataset. Use direct controls only to investigate a demonstrated failure. Preserve current behavior even if its settings appear suboptimal; otherwise the before/after comparison disappears.

Historical GPT-4-0613 need not remain callable. If a model/version or published per-case result cannot be reproduced, label that limitation. Do not substitute GPT-4o or an arbitrary newer model and call it the original TrialGPT baseline. The current upstream README also illustrates GPT-4-Turbo calls, so code revision, model version and paper version must be recorded separately.

## 4. Three matching benchmarks, not one mixed score

### A. Criterion assessment through EviMed

The acquired annotation set contains 53 patient descriptions, 105 patient/trial pairs, 103 distinct trial IDs and 1,015 annotated criteria. Organize it into patient-level tasks, preserving each associated trial and criterion. The product, not the test driver, interprets the clauses and writes the facts/judgments.

Supply only the allowlisted patient note, trial identity/background and source criterion texts. Preserve source sentence numbering for evidence scoring. Remove GPT explanations, GPT labels, expert labels, expert sentence lists, correctness columns and relevance groupings from all model-visible files. Labels stay in a separate scorer process outside the runtime workspace.

Use two explicitly named input tracks:

1. **Annotation-unit comparison:** the same literal annotated clauses and patient note go to both EviMed and the TrialGPT control. This is a criterion-assessment task with known candidate trials, not a claim to have retrieved them. Preserve the full 1,015-row denominator, including source/mapping failures. An annotation-aligned input is not byte-identical reproduction of the paper-era source.
2. **Native full-protocol exercise:** upload original full trial material and let EviMed parse it. Score aligned annotated clauses and report unmatched/split/merged clause coverage separately. This tests realistic ingestion; its different context must not be mixed into the first track's headline.

Do not prewrite the DSL, patient facts, language judgments or final eligibility. Attaching trial text is legitimate input; supplying the correct machine interpretation would bypass the functionality being evaluated. Never add unreported clinical details to make a case decidable. The released notes' consent/compliance sentence stays in the source-faithful track; that synthetic assumption is not a general product assumption about real patients.

### B. Ranking with the same candidate set

Give both systems the same patient and frozen candidate trial texts. Each system assesses and orders those candidates using its own workflow. This isolates matching/ranking quality from retrieval. Evaluate all available topics in the frozen manifest; the original paper's TREC 2021/2022 subset and the 2023 extension receive separate reports.

The current candidate gateway normalizes one request to at most 20 results by default (`candidateRequest` and its gateway caller). Measure actual runtime behavior, including repeated searches and deduplication, before choosing a shared candidate depth. A common top-20 pool is a practical initial ranking experiment if it fits both paths. It must not be represented as full-corpus retrieval or compared numerically with a paper result on a different candidate universe. Keep the prior top-ten reranking runs as historical diagnostics.

No gold-aware candidate selection is permitted. Use a fixed, documented retriever or a prespecified union of independent retrieval outputs, deduplicate deterministically, and freeze its ordering/selection before scoring. Do not hide known eligible trials in or inject them into a pool according to qrels.

### C. Retrieval plus matching/ranking

Give each system the patient and access to the same frozen trial collection. Score its retrieved candidate IDs before scoring the final ranked output. This is the full workflow comparison.

Two corpus profiles must remain separate:

- A source-compatible profile using the author's released cohort collections and evaluation rules, when those exact inputs are available and verified.
- A full TREC-snapshot profile using the already acquired historical document collections. It is a larger retrieval task, not automatically comparable to the paper's selected collections.

EviMed currently searches live registries; historical qrels cannot fairly judge today's changed registry contents and recruitment status. A local frozen registry-data adapter may supply historical data at the existing provider boundary, while retaining the application's query generation, merging, filtering and judging. Record this substitution explicitly. It measures platform orchestration over a controlled data source, not the coverage of the live registry service. If the adapter also implements a new retriever, identify that separately; it must not be described as unchanged EviMed retrieval.

Historical relevance evaluation uses the existing `status: any` option where applicable and a clearly declared historical study task. Do not rewrite a completed trial as currently recruiting. Current-registry availability/status checking gets its own small operational test, outside the historical accuracy comparison.

If the current feature cannot expose enough candidates for Recall@100/500, report its measured recall at the supported depth and the capability limit. Do not expand limits only inside the evaluation driver and call the result the current product.

## 5. Scoring without changing what the product said

Keep raw structured assessments, rendered answers and failures. Convert only their documented meanings:

| Native criterion result | TrialGPT scoring label |
| --- | --- |
| Explicitly not applicable | `not applicable` |
| Applicable inclusion, satisfied / not satisfied | `included` / `not included` |
| Applicable exclusion, final requirement satisfied / not satisfied | `not excluded` / `excluded` |
| Clinical information unresolved | `not enough information` |
| Missing computation, invalid output or incomplete clause | Failure/missing, retained in the denominator |

Exclusion polarity depends on whether the native record is the raw exclusion predicate or the final negated requirement. Verify this from actual schemas and fixtures before scoring. Do not negate twice. Treat `pending_recheck` explicitly as unresolved in the categorical benchmark and preserve its future date/status in product metrics. Do not coerce absent applicability metadata to false.

Measure three output layers separately: the model/tool proposal, the persisted assessment, and what the user sees. A correct internal answer followed by an incorrect final message is a product failure. A polished final narrative that cannot be tied to a persisted assessment is not evidence that the matching feature ran.

Metrics:

- Criterion agreement over all scheduled rows; macro-F1 and label confusion; missing/failed/unprocessed rates; applicability; evidence sentence precision/recall and exact-set agreement; source validity and semantic support as separate properties.
- Ranking nDCG@10, P@10 and eligible-trial recall, with cohort, gains, positive class and denominator stated. NIST labels are 0 irrelevant, 1 excluded, 2 eligible; grade 1 being useful to a graded relevance metric does not make a patient eligible.
- Retrieval recall at supported depths, missed eligible trials, candidate coverage and duplicate rate. The paper's relevance-weighted recall is distinct from eligible-only binary recall; preserve both names if both are reported.
- The original-paper treatment of unjudged pairs and standard full-corpus TREC treatment differ. Use the selected protocol consistently; validate metric primitives against official tooling and small hand-worked fixtures before purchasing a large run.
- Product completion, first usable result time, total wall time, all-model/tool cost, required user interventions, cancellation/resumption, source/result persistence and displayed-versus-stored consistency.

Use patient-level paired uncertainty estimates. Do not treat 1,015 correlated criteria as 1,015 independent patients. Old public cases are regression data after repeated inspection. n2c2 and any fresh clinical adjudication remain external checks, with their own task definitions and sealed-label protocol.

## 6. Direct Flash results still need diagnosis, not dismissal

An independent recount on 2026-11-03 read the preserved raw JSON responses without importing the prior scorer. It recovered 750 correct labels out of 1,015 and 886 cached GPT-4 labels matching the expert reference. All 210 Flash replies reported `stop`; one reply nevertheless contained malformed JSON. There were 1,010 usable raw labels. The recount is retained in `.evimed-local/acceptance/vcr-flash-diagnostic-20261103/independent-recount.json`.

This reduces the likelihood of a simple arithmetic mistake. It does not certify prompt equivalence, model capability, source alignment or platform performance. The prior original Flash arm explicitly disabled reasoning. A reasoning-enabled direct Flash control is still unmeasured; its benefit must not be assumed.

Investigate direct-call discrepancies in this order:

1. Actual provider endpoint, requested/served model, effective generation settings, finish reason and prompt bytes.
2. Exact patient text, consent sentence, trial background, criterion grouping/numbering and source snapshot. The prior preparation changed criterion segmentation, and the remaining mapping exceptions are recorded.
3. Expert target column versus cached GPT output, exclusion polarity, `not applicable`, unknown and parser-failure handling.
4. Source policy: the public reference sometimes accepts absence inferences and sometimes requires unknown. For example, source rows 9/10/29 label unmentioned conditions `not excluded` with no expert evidence sentences; row 15 remains unknown. These illustrate task conventions, not permission to manufacture clinical negatives.
5. Sensitivity to the original instruction to minimize unknown. Test a plain, clearly specified direct task on a fixed development sample as a diagnostic, with no tuned test answers or selective retry.
6. Only then attribute a remaining difference to model/task performance, with the exact configuration stated.

The benchmark's expert consensus was collected while reviewing TrialGPT predictions. That context and differing missingness conventions justify an independently blinded clinical check; they do not justify discarding the reference labels or declaring them wrong whenever EviMed disagrees.

## 7. Run organization and evidence

Start with a fixed six-case operational sample spanning supported inclusion, exclusion, unknown, non-applicability, compound criteria and temporal evidence. These are workflow checks, not an accuracy estimate. Include at least one raw source upload, one multi-trial result and a recoverable interruption. Confirm browser and backend submission reach equivalent product behavior.

Then execute the complete 53-patient / 1,015-criterion platform batch. Run all frozen ranking topics once candidate/corpus/metric alignment is ready. Measure full retrieval separately. Estimate full-run cost from the operational sample and freeze a spending envelope before dispatch; do not silently downsample an expensive task or substitute cached predictions for unrun cases.

Each run should retain:

- Source revision and executable/runtime/configuration identities; request and input hashes.
- Account/project/session/run/study IDs, generated protocol/assessment IDs, candidate/source versions, automation provenance and final status.
- Source upload receipts, admitted prompt, public tool events, worker completion, usage, raw persisted assessment and user-facing output.
- Criterion-level trace through intake, protocol parsing, evidence selection, extraction, language judgment, calculation, ranking and presentation. Assign the earliest demonstrated defect, retaining downstream consequences.
- Attempt history, including timeouts, retries, cancellations and partial results. Terminal conversation status alone is insufficient when a background job is still active.

Isolate cases in owned test workspaces/accounts, disable cross-case memory/learning for the benchmark, and keep scorer files and prior answers outside agent-accessible mounts. If the module's default-project path would share case files, use isolated test accounts or prove equivalent isolated project routing. No benchmark “human” may answer a missing clinical fact from the hidden labels. Predetermine responses to requests for absent information as unavailable.

Large-scale testing uses backend runs and structured records. Browser checks cover representative entry, attachment, progress, result details, cited evidence, follow-up, cancel/resume and errors; there is no requirement for thousands of screenshots. Show users evidence-based explanations and calculations, not raw internal chain-of-thought.

## 8. Delivery and interpretation

The final report must lead with E0 versus E1 versus the applicable TrialGPT reference. API controls belong in the diagnostic appendix. Provide an issue ledger with reproducible case IDs, earliest failing stage, expected/observed behavior, user impact, correction and retest evidence.

Prioritize fixes that restore the actual journey: normal intake and routing, full clause coverage, appropriate evidence interpretation, completion of language judgments, reliable numerical conditions, useful ranking and faithful presentation. Retain all valid work rather than withholding the entire result because one criterion is unresolved.

Do not introduce benchmark-only reasoning rules into production, prefill expected facts, or flatten all unknown cases into favorable labels to improve the headline. Report reference-policy disagreements without silently altering the score. A higher benchmark score still needs the separate real-record and product-completion evidence.

The integrated candidate and ordinary-text source-intake repair have been committed and pushed. Host operational probes exposed environment, intake and criterion-compilation problems; none is a formal comparative performance result. The reported E0 uses the isolated Docker platform path at `3eee7f765`. Clinical-semantic issues observed in diagnostics remain in the remediation backlog and require paired isolated evidence before any E1 claim. Local verification, review, commit and push remain distinct from deployment; deployment is not authorized by this protocol.

## Sources

- [TrialGPT paper](https://www.nature.com/articles/s41467-024-53081-z): task definitions, cohort scope, expert annotation and evaluation methods.
- [TrialGPT repository](https://github.com/ncbi-nlp/TrialGPT): released inputs, retrieval/matching/aggregation execution and model examples.
- [Official TrialGPT ranking implementation](https://github.com/ncbi-nlp/TrialGPT/blob/main/trialgpt_ranking/rank_results.py): criterion counts plus model aggregation scores; not equivalent to a generic reranker.
- [Criterion annotations](https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations): input/answer separation and reference conventions.
- [NIST TREC 2022 data](https://trec.nist.gov/data/trials2022.html): topics, judgments and relevance-label meanings.
- [DeepSeek model identity](https://api-docs.deepseek.com/quick_start/pricing/) and [thinking configuration](https://api-docs.deepseek.com/guides/thinking_mode/): inference configuration, not evidence of task-specific superiority.

## 9. Diagnostic findings carried into the formal run

The real product intake now retains authenticated TXT/Markdown originals with
exact source handles; automated text is never relabeled as a human statement.
The host probe subsequently persisted one patient, two trials and 31 judgments,
but that run is quarantined with the rest of the host campaigns. Its generated
report is not a substitute for saved feature results.

Independent clinical review of that diagnostic found lost disease subtypes,
procedure plans and event relationships, time windows and risk-factor thresholds
in agent-authored criteria. No language judgments were saved. A valid source
span and schema do not prove semantic equivalence. The isolated baseline must
measure complete-clause preservation, handling of language-judgment requests,
source-grounded facts, and faithful persisted-versus-reported results. Do not
change labels or reinterpret unknowns to hide these failures.

Two separate evaluator questions remain to verify with explicit counterexamples:
unknown applicability combined with a failed requirement, and month-end calendar
subtraction. These are not established causes of the host case's disagreements.
Metadata retries (`evidenceNeeded` shape and missing clinical schema) are another
observed cost/usability issue; any repair must preserve clinical validation.
