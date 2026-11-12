# VCR Matching Recovery Implementation Plan

> **Superseded on 2026-11-04** by [the matching delivery plan](2026-11-04-vcr-matching-delivery-plan.md). Its rule-grammar recovery tasks were not carried out: the free-text path no longer compiles clauses into rules.

> **For agentic workers:** Use `executing-plans` for the sequenced work below. If work is delegated, use `subagent-driven-development`, assign explicit file ownership and review each change before integration. Checkbox items are acceptance-driven work packages. Code-level changes follow the frozen diagnostic decisions in Tasks 1 and 2.

**Goal:** Make the EviMed patient-matching workflow complete reliably, preserve the clinical meaning of each condition and demonstrate its performance through the same product path.

**Architecture:** Keep DSH as the conversational entry and coordinator. Reuse the existing source records, matching evaluator, language-judgment writer, durable jobs and result views. Add bounded language evaluation to the existing job infrastructure after measuring the whole-clause treatment, with DeepSeek Flash as the model throughout.

**Tech Stack:** React, TypeScript, Node, PostgreSQL, DSH, DeepSeek Flash and the existing Python evaluation suite.

## Verified starting point

The reviewed checkout is `7ff8329fe`, with the measured implementation at `3eee7f765`. The complete first-attempt inventory contains 53 patients, 31 completed matching tasks, five timeouts, 12 failures, three operator interruptions and two conversations that ended without a saved feature result. All accounts were deleted.

There are 603 scorable rows out of 1,015. Agreement is 256/603 for EviMed and 519/603 for the historical TrialGPT predictions on those same rows. Restricting to completed runs gives 227/512 versus 436/512. The 412 unresolved rows remain visible. Of these, 76 belong to completed runs, and all 312 `no_overlap` rows lack returned criteria for their patient-trial pair.

The 278 reference `not excluded` rows predicted as unknown explain 80.1% of observed label disagreements. They have not all been clinically adjudicated. Confirmed source-to-rule losses and omitted displayed evidence require correction independently of label agreement.

Review of the retained transcripts found no calls to the batch digitization/simulation tools in this campaign. The historical facts-only batch extractor disables thinking, but that setting has not been established as a cause of this campaign's result. Record effective settings on the path that actually executes.

The first topic of each TREC year failed before a source-verified retrieval receipt or saved ranking. Full TREC performance remains unmeasured. The two frozen corpus readers did return 500 distinct records, ten pages and exact source records in component checks.

References are the [baseline report](2026-11-03-evimed-trialgpt-platform-baseline-results.md) and [frozen comparison protocol](2026-11-03-evimed-trialgpt-platform-comparison.md). The following numerical targets are proposed engineering acceptance targets, not measured outcomes or a promised performance gain.

## Implementation checkpoint — 2026-11-04

The current worktree integrates `origin/main` through merge `b5740f2ff`. Frozen control revision `b5740f2ff` completed the preselected six-patient panel in isolated real DSH. The six cases contain 107 annotations; 94 aligned, with 39 label agreements and 73 historical TrialGPT agreements on the same aligned rows. This is a development control, not a 53-patient or clinical performance estimate. The historical control did not capture per-call reasoning settings.

The 1,015-row engineering audit and blinded clinical review packets are recorded in [the follow-up audit](2026-11-04-vcr-baseline-audit.md). Clinical adjudication is still pending. Version-bound candidate writes, whole-clause size, ambiguous language-key guards, conservative numeric fidelity advisories, applicability/time evaluation and evidence presentation are implemented and under verification. The new candidate-trial parse cache is additive; old binaries retain their original table and primary key.

The model gateway can record redacted provider status and optional per-call metadata, distinguish semantic deltas from heartbeats, and drain receipt producers before test shutdown. It has no new default semantic timeout. The evaluation driver stops its campaign on three attributable same-run upstream refusals within 60 seconds, retains partial results and performs a post-drain receipt audit. Task completion is improved for explicitly selected missing/empty trials, but a durable inventory of every requested pair is not yet implemented.

The background language job is not enabled. Safe implementation still requires a common authorization fence at body handoff and at atomic result commit, with a leased job identity, source and judgment revision checks, all input-document dependencies, erasure/revocation handling and concurrency tests. Existing fact-extraction caching is not a sufficient authority for those writes. Full candidate/protocol background automation, paired E1, TREC and n2c2 remain open.

## Six-patient paired pilot — 2026-11-04

The real DSH recovery candidate `64e415ac3` completed all six preselected patients. The control and candidate aligned 94 and 98 of the same 107 reference units respectively. On their common 93 units, the control agreed on 39, the candidate on 38, and historical TrialGPT on 72. Both current arms kept 46 `not excluded` reference labels as unknown. These are previously inspected development cases, and the control's effective per-call thinking settings were not captured. The completed integration repair has not demonstrated a matching accuracy improvement on this panel.

Gateway receipts for the recovery run record the normalized Flash alias, reasoning setting and output cap for calls through the HTTP model gateway. They do not cover direct control-plane model calls. The protected language background job remains unavailable.

A further isolated candidate changes only the matching skill's guidance: use a full language clause when the typed grammar cannot retain a material qualifier, while retaining exact calculations for specified values and dates. It does not change the missing-information policy. Repeat the identical six-person panel and retain every attempt, coverage outcome and source-bound judgment. Compare its common aligned units with the `64e415ac3` treatment as well as the merged-main control. Do not infer clinical superiority from this small public panel.

## Execution order

The three preselected TREC operational probes are now complete and recorded in
[the November 4 results](2026-11-04-vcr-trec-operational-results.md). Their
individual scores do not close the full-cohort matching or TREC ranking gates.

1. Run Tasks 1 and 2 together. Error adjudication can proceed while request stability is repaired.
2. Run Tasks 3 and 4 on a small frozen development panel through the actual platform. Decide the condition representation from that comparison.
3. Complete Tasks 5, 6 and 7 on one integrated revision.
4. Pass the matching gates before expanding Task 8 to all TREC topics. Finish Task 9 with a separate external-record evaluation.

### Task 1 — P0 — Account for unknowns and measurement gaps

**Files and evidence:** `OpenScience/evals/vcr-platform-comparison/alignment.py`, `score.py`, `alignment-policy.json`, the private `matching-first-attempts-final-score/` artifacts and `OpenScience/evals/vcr-trialgpt-reproduction/README.md`.

- [ ] Assign an earliest demonstrated failure stage to all 347 aligned disagreements and all 412 unresolved units. Record uncertainty when attribution cannot be established. Distinguish unprocessed work, rejected writes, omitted conditions, unavailable source context, genuine missing clinical information, applicability, semantic interpretation and reference-policy differences.
- [ ] Review all 278 unknown-versus-not-excluded rows with the note, full condition and trial context. Reviewers make an initial evidence judgment before seeing system/reference labels. Also examine a preselected sample of agreements to detect shared unsupported inference. Preserve disagreements requiring clinical adjudication.
- [ ] Specify how observed facts, explicit denials, supported clinical derivations and absent information are represented. A derivation names its inputs and rationale. It never creates an unobserved measurement or event. A diagnosis may support a clinical inference without supplying an exact laboratory value.
- [ ] Keep a distinct execution status for unfinished or failed work. A clinical unknown requires completed evaluation that identifies the missing evidence. Preserve current-state compatibility and version any changed contract.
- [ ] Freeze the public development panel, provider settings, scoring and coverage definitions before paid experiments. These repeatedly inspected public cases remain development/regression material. Preserve the sealed n2c2 evaluation partition.

**Acceptance:** A reconciled issue table covers every denominator row and retains both the original label and evidence interpretation. Inference-policy disputes stay visible. No blanket unknown-to-favorable conversion is accepted. Keep the current label-blind overlap rule and the unresolved buckets unchanged for the primary paired comparison.

### Task 2 — P0 — Make a failed model call observable and recoverable

**Files:** `OpenScience/apps/server/src/modelGateway.mjs`, `agentRuns.mjs`, `vcrJobs.mjs`, `vcrWorker.mjs`, `OpenScience/evals/vcr-platform-comparison/run.mjs`, and the existing gateway/usage-ledger tests.

- [ ] Preserve sanitized upstream status, provider request identifier when supplied, first semantic-output time, last semantic-output time, finish reason and retry history. Capture requested/served model, thinking setting, output limit and prompt/source hashes without recording credentials or patient text in operational logs.
- [ ] Track transport heartbeats separately from model text, reasoning deltas and tool output. Define a bounded semantic-idle policy using measured development traces, including a generous first-output interval for thinking. Keep meaningful slow generation distinguishable from a stalled stream.
- [ ] Bound transient retries in one responsible layer, honor server retry hints and prevent multiplicative retries across gateway, DSH and job runner. Apply a campaign stop rule on repeated upstream failures after a fixed minimum observation window. Preserve partial work and automatic-resume checkpoints.
- [ ] Reconcile usage before disposing of an account when possible. Keep uncertain reservations distinguishable from settled charges. Exercise late settlement, cancellation during streaming, duplicate retry and account deletion.

**Regression fixtures:** A stream with heartbeats but no model deltas, a slowly reasoning model with real deltas, a non-success upstream response before streaming, a truncated stream, and a late usage event after cancellation. Use the existing gateway test harness for these deterministic cases.

**Acceptance:** Every failure reports a reproducible cause and last completed stage. Preselected small product tasks complete in two consecutive healthy windows, with completed artifacts preserved through an injected recoverable failure. Only then restart large paid campaigns. Runtime failures remain part of the first-attempt report.

### Task 3 — P0 — Finish the requested matching task

**Files:** `OpenScience/capability-skills/vcr-matching/SKILL.md`, its shipped copies, `apps/server/src/vcrPatientTrials.mjs`, `vcrComposition.mjs`, `vcrGateway.mjs`, `vcrJobs.mjs`, and the platform driver.

- [ ] Resolve a request with supplied trial IDs to those exact records in the selected collection and version. Track expected and completed patient-trial pairs. If IDs are absent, use the retrieval workflow and retain its candidate manifest.
- [ ] Maintain a source-clause inventory for each protocol version. Each clause receives a saved assessment or an explicit pending/error disposition. Confirmed source gaps remain visible. Avoid treating an incomplete parse as a fully evaluated protocol.
- [ ] Derive feature completion from saved patient-trial and clause outcomes. Preserve a conversation's usable narrative and partial artifacts while showing that the matching task remains incomplete. Do not revive a global deliverable-withholding gate.
- [ ] Add class-level regressions for the `sigir-201515` failure pattern, a missing frozen record, one failed trial among several, resumed work, duplicated writes and a source-version change during inference. Use independent synthetic fixtures for logic changes.

**Acceptance:** Supplied trials cannot disappear silently. A partial result names its unfinished pairs and can resume only the remaining work. Proposed full-cohort target is at least 51/53 complete first attempts, with all incomplete attempts retained and all 105 expected pairs accounted for.

### Task 4 — P0 — Preserve condition meaning and measure the reasoning path

**Files:** `OpenScience/packages/domain/src/vcrRules.mjs`, `apps/server/src/vcrWriteContracts.mjs`, `vcrPatientTrials.mjs`, `vcrCandidateTrialStore.mjs`, `vcrMatching.mjs`, and the matching skills.

- [ ] Keep the complete original condition and its applicability premise. Typed rules must preserve disease subtype, AND/OR scope, thresholds, units, time anchors, plans, exceptions and event relationships. Use a whole-clause language requirement where the grammar cannot represent those qualifiers faithfully.
- [ ] Resolve the 500-character language limit against the existing 4,000-character source bound. Carry the full supported condition or resolve its exact frozen reference. Never truncate away a necessary qualifier. Update validators, writers, cache identity and shipped contracts together.
- [ ] Audit or invalidate cached parses when compilation policy changes. A matching source hash alone does not certify that an old compiled rule preserves the source meaning.
- [ ] Run a paired development experiment through the product. Arm A replays the current structured-condition path. Arm B uses complete language clauses where needed, the same Flash configuration and context, exact code for well-specified arithmetic, and the same validated persistence path. Keep inference policy and annotation mapping constant. Record clause coverage, false favorable decisions, false exclusions, unknowns, token use, tool calls and latency.
- [ ] Use synthetic counterexamples covering BMI 25 versus greater than 25, NYHA I/IV versus II/III, type 1 versus type 2 diabetes, symptomatic arrhythmia, fixed versus reversible perfusion defects, and a completed procedure versus a planned procedure. Include clearly supported positive cases.

**Acceptance:** Critical counterexamples preserve their source distinctions and all positive controls still pass. The whole-clause treatment advances only with measured coverage/quality benefit under the frozen comparison. A correctly copied source quotation does not by itself certify the compiled meaning or inference.

### Task 5 — P1 — Complete language judgments in bounded background work

**Files:** `OpenScience/apps/server/src/vcrMatchBatch.mjs`, `vcrComposition.mjs`, `vcrGateway.mjs`, `vcrJobs.mjs`, `vcrWorker.mjs`, `vcrCandidateTrialStore.mjs`, and existing batch/job integration tests.

- [ ] Extend the existing leased job path to resolve outstanding language judgments for the chosen patient-trial pairs. The current facts-only extraction job explicitly leaves them pending. Keep DSH responsible for interpreting the task, starting work and presenting saved results.
- [ ] Give each bounded inference unit the full condition, necessary trial context, the authorized original patient evidence and relevant surrounding/correcting context. Short records are read whole. Benchmark whether repeated condition-specific context can be safely reused.
- [ ] Reuse the validated judgment/evidence persistence logic with genuine job provenance. Native invocation proofs remain specific to real native tool calls. Preserve subject ownership, exact evidence spans, source revisions and late-response write fencing.
- [ ] Checkpoint completed units and retry only unresolved units after recoverable faults. Bind caches to source, prompt, model settings and policy versions. Bound concurrency, output and total spending using actual estimates. Increasing thinking must update the output allowance and budget estimator together.
- [ ] Compare Arm C, the background execution of the selected Task 4 treatment, against Arm B with the same input/prompt semantics. Separate reduced orchestration cost from changes in prediction quality.

**Acceptance:** One conversational request completes all accessible conditions or presents explicit missing-data/error outcomes without a manual follow-up prompt. Restart/cancel/resume creates no duplicate judgments or stale-source assessment. Median/P95 latency, model/tool call counts and truncations are measured against the frozen platform baseline.

### Task 6 — P1 — Correct applicability and temporal boundaries

**Files:** `OpenScience/apps/server/src/vcrMatching.mjs`, `vcrPatientTrials.mjs`, `vcrViewsTabs.mjs`, `vcrCandidateTrialStore.mjs`, and matching temporal/evidence tests.

- [ ] Preserve the raw applicability axis and its missing evidence. Unknown applicability must not produce a definite exclusion solely from a failed requirement. Carry this semantics consistently through counts, ranking, saved views and exports.
- [ ] Test language predicates in applicability as well as requirements. Wire discovery, evidence submission, persistence, hashing and evaluation consistently wherever this form is supported.
- [ ] Define and version calendar-month boundary behavior. Test month ends and leap years, exact endpoints, undated events, partial intervals and explicit denials covering the requested window. The current `setUTCMonth` rollover needs a documented protocol convention before correction.
- [ ] Check exclusion inversion exactly once and retain unit compatibility and source-derived time bounds. A partial denial or a past negative observation cannot silently clear a different interval.

**Acceptance:** Deterministic regression cases pass at, inside and outside every boundary. Explain any changed historical assessment when recalculated under the new version. These source findings have not been established as the cause of all benchmark disagreements.

### Task 7 — P1 — Make the result and its evidence usable

**Files:** `OpenScience/apps/server/src/vcrViewsTabs.mjs`, `vcrPatientTrials.mjs`, `apps/web/src/components/vcr/ClinicalMatchingDetails.tsx`, `apps/web/src/components/vcr/tabs/MatchingTab.tsx`, and their tests.

- [ ] Deduplicate repeated evidence locators before display. Keep the determining branch visible and make every retained citation accessible. Test a positive fourth branch after three repeated negative citations.
- [ ] Show trial order, eligibility conclusion, assessment coverage, missing evidence and unfinished work distinctly. The score must not imply a probability of enrollment. Keep original condition, short evidence rationale and exact source available from the result.
- [ ] Verify that conversation text, persisted row, opened detail and downloaded JSON/CSV agree after recomputation and resume. Add a visible, actionable partial-result state rather than a completed-looking empty view.

**Acceptance:** Representative browser cases cover success, clinical unknown, explicit exclusion, incomplete processing, cancellation/resume and a source refresh. Backend bulk testing supplies the full corpus evidence. The user reaches the result from one conversational request and can inspect the decisive quotation.

### Task 8 — P2 — Validate retrieval and ranking separately, then together

**Files:** `OpenScience/apps/server/src/vcrTrialCorpus.mjs`, `vcrCandidateSearch.mjs`, `vcrPatientTrials.mjs`, `OpenScience/evals/vcr-platform-comparison/run.mjs`, and `score_trec.py`.

- [ ] Repeat the preselected first topic of all three TREC years through the actual platform after the runtime gate passes. Require a frozen retrieval receipt and a saved final order before scaling to all 165 topics. Preserve previous failures and all attempts.
- [ ] Measure retrieval Recall@500 with the frozen corpus and actual query records. Measure sorting on an explicitly fixed candidate set to isolate ranking quality. Then measure the end-to-end product with its actual candidate depth and processing coverage disclosed.
- [ ] Evaluate the current criterion-proportion order against a relevance-aware candidate ordering on development topics. Preserve verified exclusion and uncertainty. Do not promote a clinically unrelated trial simply because its generic criteria are easy to answer.
- [ ] Freeze reranking depth, candidate policy, treatment of unjudged trials, metric gain convention and resource limits. The current driver asks for retrieval of 500 and evaluation of 20. That differs from evaluating all 500 and must remain visible in comparisons with historical runs.
- [ ] Run all 75/50/40 topics after operational recovery. Retain the three 2023 topics without qrels separately. Report eligible Recall@500, nDCG@10, P@10, judgment coverage, task completion and time/cost together.

**Acceptance:** Every scored retrieval/ranking row traces to its source-versioned saved result. No retrieved receipt means recall is unavailable. A fixed six-candidate task cannot substitute for a full-corpus result. A higher eligibility-coverage fraction alone does not establish useful ranking.

### Task 9 — P2 — Repeat the full platform evaluation and external validation

**Files:** `OpenScience/evals/vcr-platform-comparison/`, `OpenScience/evals/vcr-trialgpt-reproduction/`, and the existing private n2c2 acquisition/evaluation manifests.

- [ ] Integrate reviewed fixes, run scoped checks, commit and push, then freeze the next platform revision. Retain the original first-attempt artifacts and scoring code. Repeat all 53 patient tasks with disposable accounts, automated attribution and disabled memory.
- [ ] Target at least 95% coverage of the 997 uniquely locatable reference units under the existing alignment policy, while publishing coverage over all 1,015 as well. Keep unresolved clauses in the report. Report the same-unit historical comparator again because the aligned subset may change.
- [ ] Predeclare the comparison on the intersection of baseline/treatment aligned units alongside each arm's coverage. Include complete-case and all-attempt views, error classes, evidence support, patient-level paired uncertainty and negative/positive clinical controls. The initial quality target is to reach the historical reference agreement on comparable units while passing the completion, coverage and evidence controls. A superiority claim additionally requires a patient-level paired interval above zero. A point estimate above the reference alone does not establish superiority.
- [ ] Evaluate the frozen n2c2 test partition only after the short-note pipeline stabilizes. Reconfirm license, authorized processing destination and inference configuration. Use its own criterion definitions and metrics for longitudinal notes, corrections and time windows. Report prior exposure of public datasets and any reused cached predictions.
- [ ] Publish the achieved gates and remaining gaps. Keep deployment a separate owner decision. Resume virtual cohort, virtual-patient and synthetic-control validation with their own method-specific datasets and endpoints after this matching milestone.

## Proposed acceptance checkpoints

| Checkpoint | Required evidence |
| --- | --- |
| Runtime recovery | Repeated product smoke checks succeed, injected failure resumes correctly, and incomplete calls remain attributable |
| Interpretation candidate | Whole-clause and numeric/date counterexamples pass, with explicit inference policy and source-bound decisions |
| Matching completion | At least 51/53 complete first attempts, every expected pair accounted for and no completed-looking empty matching result |
| Matching coverage | At least 95% of uniquely locatable units aligned, total 1,015 denominator and every unresolved disposition retained |
| Quality comparison | Reach the same-unit historical reference, report patient-level uncertainty, and pass false favorable/exclusion and evidence controls |
| TREC operational path | Each preselected topic produces an actual frozen retrieval receipt and saved order |
| TREC evaluation | All 165 topics attempted under a frozen design, judged and unjudged topic denominators explicit |
| External validation | New task-specific n2c2 results through the approved processing path, with sealed labels and declared prior exposure |

## Verification and delivery discipline

Reuse the existing matching, candidate-trial, temporal, gateway and UI suites for the named regressions. PostgreSQL integration tests require the dedicated test database and must record their executed count. For each changed slice, run its targeted tests and relevant type/lint checks before adding another change. The scoring-suite commands from the repository root are:

```sh
python3 -m unittest discover -s OpenScience/evals/vcr-platform-comparison -p 'test_*.py'
node --test OpenScience/evals/vcr-platform-comparison/*.test.mjs
```

Keep patient data, credentials, raw transcripts and reference labels in private artifacts. Put the plan, reviewed implementation and aggregate results in Git. A paid run binds the actual pushed code and runtime configuration. Every claimed improvement must identify the measured revision and retained attempt set.
