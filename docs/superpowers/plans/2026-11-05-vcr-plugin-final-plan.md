# VCR professional plugins: consolidated plan and execution checklist

Date: 2026-11-05. This is the current planning baseline. Product implementation,
paid evaluations, deployment and production migration are not performed by this
review. It consolidates the conversation and retained reviews; old findings are
kept as history, not automatically re-opened as current defects.

**Goal:** Deliver independently installable, testable and releasable research
plugins on DSH and DeepSeek, callable from open-domain conversation in arbitrary
scientifically supported combinations.

**Architecture:** Four task-domain plugins share small research contracts and
existing host/data/evidence/method services. A suite optionally composes them.
Patient recruitment and matching remains an independent parallel product.

**Technical base:** React/TypeScript, Node, existing DSH harness-port and socket,
MCP, hosted extension generations, PostgreSQL jobs and the existing R/Python
statistical runtime. Keep one implementation of each scientific method.

## 1. Frozen sources and evidence scope

| Source | Revision / evidence | How to use it |
| --- | --- | --- |
| Current algorithm checkout | `codex/vcr-algorithms-20261103`, `da2d191b42b74d1e93eac9f17fb8bc31cea42b46` | Implementation baseline for the four research plugins |
| Remote main at review | `0765c63c17d9b51c53211632fb92bc85c6ab3eab` | Included by the algorithm branch; algorithm branch not merged into main |
| Matching delivery | `codex/vcr-match-delivery-20261104`, `d5f690b15` | Parallel implementation and newer evaluation reports; not in current algorithm checkout |
| Old benchmark checkpoint | `codex/vcr-platform-benchmark-20261103`, `6e1841609` | Historical denominator, failure and exploratory TREC evidence |
| Old candidate-language prototype | `codex/vcr-language-job-20261104`, `1a4350df4` | Unmerged WIP, not the implementation baseline for the new matching job |
| Old n2c2 adapter | `codex/vcr-n2c2-platform-20261104`, `19fd840a0` | Historical evaluation adapter; do not introduce a competing pipeline without need |

The algorithm and matching branches have separate development beyond main
(110 and 173 commits respectively at this review). They must be coordinated by
ownership and shared contracts, not merged indiscriminately as part of a package
rename. The parallel recruitment/plugin-splitting progress beyond these named
commits is not verified here.

Verified GitHub evidence:

- [Web workflow at da2d191b4](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41935661537): web, public-dataset, vcr-r-library, gallery, vcr-seam, vcr-engine and docker-hosted succeeded; hosted-production-e2e skipped.
- [Engine job](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41935661537/job/126943904759): `PASSED 492/492`, 492 declared, none skipped.
- [Docker job](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41935661537/job/126967358625): isolated VCR image qualification and confirmatory design execution succeeded. Image publication/packaging steps were skipped.
- [Knowledge-plugin workflow](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41935661539): succeeded at the same source revision.
- [Matching web workflow at d5f690b15](https://github.com/anonymous-temp/EviMed-Science/actions/runs/41979809075): failed at `Test the capability audit suites`, specifically `test_guidance_snapshot_is_current` because the guidance snapshot does not match `packages/socket/src/guidanceText.mjs`; docker-hosted was skipped. Its engine/seam jobs succeeded. This failure belongs to the separate matching branch, not the algorithm checkout, and must not be described as merely an outstanding production probe.

The reviewer read these CI receipts rather than rerunning them. A successful
engine job proves neither clinical prediction validity nor an independently
installable professional plugin. No production behavior was inspected.

## 2. Final product decisions

1. DSH and DeepSeek remain the general execution base. Medical expertise loads
   when relevant; ordinary questions retain ordinary conversational behavior.
2. Each plugin covers a scientific domain fully enough to deliver complete
   research when asked. No fixed workflow, mandatory study form, numbered rail
   or obligation to execute every capability accompanies installation.
3. Users may request any subset, provide intermediate inputs, reuse results,
   change one assumption, switch topic or combine installed plugins. Execute
   only the operations needed for that request and their genuine dependencies.
4. Publish virtual cohort, virtual patient, synthetic-control and virtual-trial
   plugins separately. The optional virtual-research suite coordinates versions
   and results; it does not duplicate algorithms or own all user requests.
5. Patient recruitment and matching is separately owned. Do not restore its
   operational workflows inside these four research plugins. The suite does not
   install matching or grant access to its data implicitly.
6. Search, knowledge access, source/data interpretation, scientific assessment,
   exact computation, jobs and report rendering are shared services. Their
   presence does not make every request perform a search, grading or report.
7. Source and method requirements attach to operations. Explain a method without
   demanding a dataset; require appropriate records to compute its empirical
   estimate. Show useful data prerequisites at the point of use.
8. Explain results from the same persisted numeric objects used by the page and
   exports. Preserve observed, published, derived, simulated and assumed values.
   Do not infer a parameter's meaning from numeric coincidence.
9. Standalone DSH and hosted EviMed are separate supported modes to prove. A
   hosted-only initial slice is labelled as such, not called standalone.
10. Retain the current design tokens/native conversation. No calculator catalogue,
    no four expanded feature introductions stacked above disconnected research
    lists, no backend narration in product copy.

## 3. Plugin scope and reuse

| Plugin | Owns | Existing anchors | Data prerequisite |
| --- | --- | --- | --- |
| Virtual cohort | Target population, observed selection, declared/literature/empirical synthesis, fidelity and utility | `cohort.build`, `profile.snapshot`, `population.*`, population/data-plane objects | Individual data for observed/empirical routes; published parameters or explicit assumptions for scenario routes |
| Virtual patient | Subject histories, explicitly modelled tracks, model application/training/calibration and validation | `patients.*`, `model.*`, longitudinal and forecast services | Applicable model and subject inputs for individual predictions; outcome data for training/validation |
| Synthetic control | Comparator route, estimand, comparability, adjustment, borrowing, sensitivity and interpretation | `comparator.*`, target-trial, weighting, RMST/Cox/AIPW, MAIC/STC and bias interfaces | Method-specific treatment/outcome/index-date/confounder inputs; literature-only feasibility can run separately |
| Virtual trial | Study design alternatives and operating characteristics | `design.*`, rpact adapter, abstract accrual and scenario jobs | Sourced parameters/assumptions suffice for design exploration; individual data is optional for calibration |
| Optional suite | Cross-plugin request interpretation, supported dependency composition and result reuse | Existing conversation/task ownership and versioned research objects | Only the inputs needed by the requested composition |

Shared contracts include cohort snapshots, authorized subject references,
model artifacts, trajectories, comparator analyses, trial designs and analysis
reports. Extract them from current domain types instead of introducing a second
copy. Accept compatible imported artifacts without forcing installation of
sibling plugins. The matching team owns eligibility-specific models and policy.

## 4. Reconciled review findings

Status meanings: **retained** = implemented evidence exists and should survive
the split; **open** = current defect or unverified requirement; **partial** = a
fix exists but the relevant acceptance is incomplete; **transferred** = owned
by the separate matching lane. Code closure is not a fresh live verification.

| ID | Topic and current status | Decision / next task |
| --- | --- | --- |
| R01 | Original virtual-research positioning and rejected manual/calculator UI | Retain conversational, object-centered behavior; pluginize it under P02/P03/P09 |
| R02 | PR #17's 13 blockers and later review groups | Historical remediation records include a second closure round; do not repeat them as thirteen current blockers. Retain attribution, erasure, temporal, source and UI regressions in P08/P09/P12 |
| R03 | 2026-10-29 A01-A09 public-data fixes | Retain person-vs-row counts, intake continuity, source/units, partial progress and compact home; complete full-data evidence in P10 |
| R04 | Old 35-method inventory and missing-method list | Superseded: current R registry has 48 methods. T/C/P/E/G additions marked implemented in algorithm TODO are reuse, not a new implementation backlog |
| R05 | Numerical reference and runtime-library gaps | Numerical CI and candidate-image checks now pass. Preserve pinned references and method identities; standalone/plugin release still open (P02/P12) |
| R06 | Professional method discovery in ordinary language | Open/partial: network Meta still bypassed the engine in one of two latest diagnostic conversations; synthetic populations had earlier bypasses. Measure supported task completion and result persistence, not universal tool-call frequency (P03) |
| R07 | Wrong scenario/result association and sparse design cards | Fixes recorded for distinct assumptions, object selection, Simon cards and people/events. Some conversation scenarios were not replayed after the final fixes (P04/P09) |
| R08 | Parameters labelled as user-supplied by value alone | Confirmed current defect; new synthetic function probe below. Also retained 160-character preview limitation. Fix meaning-bound provenance (P04) |
| R09 | Result finishes in the current turn without being read | Open in latest algorithm acceptance: notification alone may not return the answer. Preserve no-duplicate/cancel semantics and complete event-driven delivery (P05) |
| R10 | Heavy simulation and repeated status reads | Open: limited CPU caused partial replicates; latency and polling remain. Measure and improve cancellation/resume/progress without inventing completion (P05/P10) |
| R11 | Literature table/KM/precedent evaluation | Component evidence exists, with explicit limitations: table selection used gold, parser route unmeasured, KM mostly synthetic, precedent labels structural/English. Validate actual evidence-to-parameter paths (P06/P10) |
| R12 | Generalizable virtual-patient prediction | Open: a disease-independent progression simulator and model-training method are not a validated model for every disease. Version intended use and validate scoped models (P07/P10) |
| R13 | Independent plugin lifecycle | Open: workflow skills and hosted extensions exist, but four standalone scientific packages/adapters are not implemented (P01/P02/P07/P12) |
| R14 | Patient matching, ranking and n2c2 | Transferred, with newer large evaluations at the matching branch. Preserve protocol differences and unresolved rollout/quality work; see section 6 |
| R15 | Old language-job and n2c2 prototype branches | Superseded as default execution routes by matching delivery. Keep evidence; do not enable the unfinished prototype or merge both implementations (P01) |
| R16 | Prior paused blind-review resources | Local receipt records creation but no confirmed cleanup; old runner process is absent. Verify owned database/account state and safely clean, without resuming 310-row review (P00) |
| R17 | Production acceptance | Open/outside current task: hosted-production-e2e skipped, no deployment by this review. Independent plugin publication and later deployment remain explicit stages (P12) |

### Current provenance defect reproduced without model calls

`vcrPersonStated({design:{nTreat:30},followupMonths:30}, ['Follow-up: 30 months.'])`
marks both parameter paths as user-stated because both contain 30. The actual
probe used the equivalent Chinese sentence and returned:

```json
{"schema":1,"readable":true,"paths":["design.nTreat","followupMonths"]}
```

This verifies a source-label defect in the function, not a numerical algorithm
error or a live clinical failure. Bind value, meaning, unit and source span to
the parameter path. Do not solve it with another global numeric regex. Preserve
the older source-label version on historical results and version any correction.

## 5. Work packages and completion evidence

### P00 — P0 — Freeze ownership, evidence and cleanup

Owner: current lead, with matching-team coordination. No matching implementation
is reassigned to the four-plugin team.

- [ ] Preserve the three code/evaluation baselines in section 1 and the relevant
      source/result hashes. Keep inferred and reported outcomes distinct.
- [ ] Reconcile superseded plans with this checklist. Keep old reports immutable
      as historical evidence; add successor links where needed.
- [ ] Verify the paused diagnostic account/database using the original ownership
      receipts; reconcile its settled partial ledger and delete only those
      owned resources. Do not restart the blinded diagnostic to satisfy cleanup.
- [ ] Agree shared contract ownership with the parallel matching/plugin work.

Done when the branch/source matrix, handoff and cleanup receipts are recorded,
and no task silently depends on an abandoned prototype.

### P01 — P0 — Define four independently usable package boundaries

Code anchors: `vcrComposition.mjs`, `vcrGateway.mjs`, `vcrService.mjs`,
`vcrRoutes.mjs`, `packages/domain/src/vcr*`, `capabilities/vcr-*`.

- [ ] Map current method IDs, stores, viewers and schemas to four product owners
      and shared interfaces; explicitly retain matching ownership separately.
- [ ] Define input/result references, version compatibility, actual operation
      prerequisites and downstream invalidation. Keep source content in its
      authorized store; a reference is not a permission grant.
- [ ] Choose standalone and hosted adapters for the first extraction; forbid
      imports from `apps/server` in a purported standalone plugin.
- [ ] Keep compatibility readers/routes for existing studies and pinned jobs.

Done when each plugin can accept ordinary imported inputs without installing
the other plugins and a build dependency check detects accidental SaaS coupling.

### P02 — P0 — Deliver one real plugin: virtual trial first

Proposed packages: `OpenScience/packages/virtual-trial/` plus only the minimal
shared contracts/runtime adapters it uses. Reuse `harness-port`, extension
generation services and `项目代码/vcr-engine`; do not clone the R stack.

- [ ] Package skills, method discovery, tool calls, result rendering and examples
      through native DSH bundle support and existing hosted extension admission.
- [ ] Run a clean standalone DSH task and the same task in hosted EviMed with
      matching, cohort and virtual-patient plugins absent.
- [ ] Bind the package to actual compatible method/runtime versions. Stop or
      explicitly migrate incompatible in-flight jobs when updating.
- [ ] Verify install, enable, disable, upgrade and rollback; historical results
      remain readable and uninstall does not implicitly delete research data.

Done when an independent install can execute and explain a supported design,
and the same scientific implementation works through the hosted adapter.

### P03 — P0 — Make open-domain composition the default

Anchors: capability discovery/router, DSH socket/harness-port, matching-free
research tool entry and `runtime/mcp/evimed-research/vcr_platform.py`.

- [ ] Publish compact task-domain descriptions and load the relevant skill and
      exact tool schemas on demand. Plugin selection scopes expertise, not the
      allowed questions or a mandatory report contract.
- [ ] Handle explanation-only queries, any supported subset, supplied intermediate
      artifacts, follow-ups, topic changes and cross-plugin combinations.
- [ ] For supported scientific calculations, reach the registered method and
      persisted result without forcing every ordinary question into a study.
- [ ] Run the complete predeclared natural-language scenario set, including
      negative/general controls and Chinese variants. Preserve every failure.

Done when irrelevant steps, reports and input requests are not forced, while
questions requiring professional computation yield traceable results. Measure
task completion, correctness, unnecessary work, tool errors and time/cost.

### P04 — P0 — Correct parameter meaning and result read-back

Anchors: `vcrPersonStated.mjs`, `vcrExecutionContext.mjs`, original conversation
reader, `vcrPremises.mjs`, `vcrScenarioSources.mjs`, result presenters/exports.

- [ ] Replace value-coincidence source attribution with parameter-specific
      source references that preserve meaning, unit, time and context.
- [ ] Read authorized original messages rather than treating a 160-character
      ledger preview as the full evidence. Keep source access bounded and scoped.
- [ ] Preserve user, literature, derived, assumption and model-predicted origins
      through jobs, results, page, answer and report. Retain historical versions.
- [ ] Add counterexamples: 30 months vs 30 people, repeated percentages with
      different meanings, contradictory follow-ups, table column mix-ups,
      identical values in two arms and changes beyond the preview limit.
- [ ] Verify selected scenario, assumptions, headline, plotted numbers and export
      refer to the same immutable result after edits and sensitivity runs.

Done when the current synthetic defect is fixed and no tested surface upgrades
an assumption to an observed/user-provided value merely because digits match.

### P05 — P0 — Return long-job results reliably

Anchors: `vcrJobs.mjs`, `vcrWorker.mjs`, `vcrConversationCompletions.mjs`,
`vcrNotify.mjs`, runtime run ledger and existing finish hooks.

- [ ] Handle completion during a busy turn and after turn end, using existing
      events and idempotent continuation rather than repeated model polling.
- [ ] Prevent duplicate runs/charges when results were already read or delivered.
- [ ] Preserve cancel intent, permission changes, source-version changes and
      partial results across disconnect, restart and failed continuation.
- [ ] Measure heavy design jobs with actual CPU/replicate caps. Present completed
      replicates, Monte-Carlo error and remaining work accurately.

Done when every finished job is reachable from its owning conversation/result,
and interruption/retry does not fabricate completion or duplicate work.

### P06 — P1 — Connect evidence, knowledge and scientific assessment

Anchors: evidence pipeline/second read/value checks, knowledge/search services,
document parser, KM digitizer, source binding, model applicability and report data.

- [ ] Make literature and knowledge retrieval callable independently and from
      any relevant plugin; reuse a frozen source when it already satisfies need.
- [ ] Preserve table row/column/arm, units, denominators, endpoint/time and study
      identity through parameterization; check reconstructed values separately.
- [ ] Distinguish certainty, bias, population transportability, model validity
      and numerical verification; retain findings with useful results.
- [ ] Validate the actual internal parser route on the prepared table corpus,
      including choosing the correct table without gold assistance. Add real
      publication KM examples and clinically meaningful precedent checks.

Done when a query can go from evidence to applicable computation and a cited
answer, or use only retrieval/interpretation, without source or meaning loss.

### P07 — P1 — Extract cohort, comparator and patient plugins

Reuse package/adapter patterns proven by P02, with no new global kernel or
universal workflow system.

- [ ] Cohort: preserve observed/derived/synthetic/reconstructed provenance, person
      counts, selection/version history, fidelity, inference utility and privacy
      diagnostics using existing `population.*` and `cohort.build` methods.
- [ ] Comparator: publish separate actual-external, literature/indirect,
      borrowing and randomized-prognostic-adjustment routes; retain estimand,
      index-date and post-baseline checks and method-specific diagnostics.
- [ ] Patient: separate observed history, scenario paths and model predictions;
      preserve model endpoint/horizon/population and calibration evidence. An
      installed training method is not a universal validated clinical model.
- [ ] Prove each plugin with sibling plugins absent and with compatible imports.
- [ ] Retain the stated multi-arm/enrichment enrollment approximation unless a
      more complete accrual model is implemented and separately validated.

Done when each domain has a working independent task surface, artifacts,
acceptance suite and honest supported-use scope.

### P08 — P1 — Preserve shared-data and lifecycle guarantees

Anchors: data plane, access, snapshot and erasure stores, job scopes, extension
permissions and source changes. Reuse existing policy implementation.

- [ ] Verify cross-account/project isolation, source withdrawal, revoked grants,
      late responses and mixed-version workers in standalone and hosted modes.
- [ ] Never put patient records into general shared knowledge/memory or grant
      cross-plugin access merely through installation or an object reference.
- [ ] Keep source/data deletion, plugin uninstall and database retirement as
      distinct operations. No startup deletion or automatic production migration.

Done when real persistence/concurrency tests protect each operation boundary,
including partial failure, and migration compatibility is documented.

### P09 — P1 — Verify actual interaction and visual results

Anchors: `apps/web/src/components/vcr/`, extension centre and current design
system. Apply the previously requested Huashu/Impeccable principles within tokens.

- [ ] Keep one composer, compact task selection and object-centered results;
      make data/model prerequisites visible only where relevant.
- [ ] Verify conversation -> exact result -> edit -> new version -> old result,
      plus source inspection, failure, limited runs, export and cancellation.
- [ ] Render desktop and narrow layouts in the built-in browser; verify the
      comparator result entry, Simon/compound endpoint cards and >4 alternatives.
- [ ] Keep algorithm/package/gateway internals out of user copy; preserve
      scientific assumptions and evidence that help assess the answer.

Done when current rendered paths are verified. Old screenshots and API-only
page checks are not evidence for new plugin layouts.

### P10 — P1 — Run the complete relevant datasets on frozen implementations

The concrete campaign matrix is in section 7. Reuse valid prior outputs where
they answer the same question; do not rerun old matching pipelines simply to
claim all local files have been exercised.

- [ ] Freeze source/plugin/method/model/prompt versions, complete input inventory,
      split, scoring and budget before each new campaign.
- [ ] Run all applicable cases through the real feature/backend path. A one-time
      operational startup check is allowed; do not replace the full campaign
      with successive handpicked pilots or block it on an arbitrary quality target.
- [ ] Retain failures and excluded/unusable records with counts and reasons;
      report both total coverage and scores on usable outputs. Resume explicitly.
- [ ] Use automated attribution, isolated patient workspaces, disabled memory,
      private gold, bounded concurrency and account/usage cleanup.
- [ ] Compare extraction-before/after outputs and task completion; publish a
      per-plugin report rather than a single undifferentiated success score.

Done when the planned full denominators reconcile and each claimed improvement
is supported on the same units with the actual execution route disclosed.

### P11 — P2 — Compose the optional suite

- [ ] Compose selected installed plugin versions through shared contracts.
- [ ] Test evidence+design only, cohort+comparison, patient+design and a requested
      complete study; allow normal DSH conversation to compose without the suite.
- [ ] Invalidate affected downstream results on input changes and preserve
      unaffected work. Matching remains optional and explicitly authorized.

Done when composition reuses released components and data rather than copying
scientific code or enforcing a mandatory cohort-to-trial chain.

### P12 — P1 — Independent releases and final integration

- [ ] Give each package its own version, dependency lock, compatibility matrix,
      release artifacts, scientific scope, test evidence and migration notes.
- [ ] Reuse engine method references, rerun affected numerical cases, and run
      final full CI on the integrated release candidate. Validate standalone
      installation and hosted activation separately.
- [ ] Publish the actual package/install instructions and tested example. A Git
      push alone is not an independently installable release.
- [ ] Coordinate main integration with the matching team through shared changes;
      retain its independent benchmark and release status.
- [ ] Keep deployment and production data changes as a separate owner decision.

Done when each advertised installation mode works from published artifacts and
the source, runtime and scientific evidence identities agree.

## 6. Matching lane: newer evidence and remaining handoff

This lane is owned by the parallel matching/plugin workstream. These are values
reported in its preserved results, not recalculated by this review.

| Evaluation | Newer evidence | Interpretation |
| --- | --- | --- |
| Ranking A | 75,061 judged pairs; three-cohort mean nDCG@10 0.750 | Job-path result; not the full conversational workflow or frozen default clause-reordered UI |
| Clause C | 1,015 clauses, agreement 79.1%, 98 false-favorable decisions vs historical 15 | Prompt-tuned public data; below the historical 87.3%, not a clean holdout |
| Full-corpus E | 133 test topics; nDCG@10 0.475/0.529/0.366 | Report topic subset and unjudged-trial treatment; not all 165 topics |
| n2c2 F | Official 86 test patients; primary reading (c) micro F1 0.922; (b) 0.871; unknown 39.5% | Policy-sensitive job-path result, with declared prior test exposure |
| Chinese G | Translated SIGIR notes nDCG@10 0.657 | Trials stayed English; not evidence for Chinese trial-text/ChiCTR matching |
| Real Chinese requests | 115 requests, 90 obtained judged candidates, 88 complete | Usability counts, no clinical gold accuracy |

The old 42.5%/603-aligned baseline remains historical. Our earlier claim that
n2c2 had not run described this local prototype lane and is superseded for the
overall project by the matching delivery branch. There is no justification for
repeating 53/165/288 through the abandoned path.

Pre-fix audit P1/P2/P3 (failed rejudgment hidden, active empty read, incomplete
export), F3 (viewer leakage), F7 (rule-list cap), F8 (search coverage), F9/F10/F11
(hospital notes, stale inputs, history) have subsequent code fixes in that
branch. Preserve their regressions and require final-revision verification;
do not present the old pre-fix report as a list of all current defects.

Matching-owner remaining checklist:

- [ ] Reconcile final code, effective settings and displayed verdict/order with
      the scored revision `a2d109cf5`; disclose job path vs conversation path.
- [ ] Repeat the actual dialogue scenarios changed after testing: protocol plus
      patient list, and Chinese-only queries to English registries; validate
      PDF/scan conversion in the real target runtime.
- [ ] Measure default 20-candidate latency (reported 3.31-4.16 minutes, missing
      the prior 2-minute median target); select concurrency from real resource
      and provider behavior, not fake-provider scale tests.
- [ ] Resolve/report false-favorable policy and a predeclared evaluation target;
      no blanket claim that higher n2c2 F1 solves TrialGPT clause errors.
- [ ] Verify residual grant/actor/withdrawal/upload/scratch and budget protections
      against the final implementation; prior security notes remain a check list,
      not a claim that every old exploit is still present.
- [ ] Retain remaining capabilities as explicit backlog: report-format export,
      selective affected-clause recomputation, long Chinese notes/Chinese trials,
      knowledge/tool access inside the judging job and exact arithmetic checks
      where claimed. Do not force all these to block a clearly scoped release.
- [ ] Finish final code tests/CI, retirement dry-run and candidate validation.
      Reconcile the guidance snapshot with the intended source, rerun the failed
      capability-audit suite and run the skipped Docker checks on the final
      matching revision; do not simply weaken the snapshot assertion.
      Only a later explicitly approved deployment performs serving-data changes.

Jev criterion judging and a second clinical-record data destination are not
reintroduced. Existing comparisons did not establish a gain; the user's granted
n2c2 processing destination remains DeepSeek. Extra ranking arms or VERDICT data
acquisition require a concrete unresolved comparison, not another default loop.

## 7. Full-data campaign matrix

| Workstream | Full applicable input | What is still needed |
| --- | --- | --- |
| Cohort | Prepared PhysioNet 2012 A/B/C records | Reconcile all files/identities; profile, cohort and synthesis tests at group/subject granularity; fidelity, utility and leakage findings |
| Virtual patient | Applicable PhysioNet longitudinal variables and model-specific external sets | Explicit horizons, whole-patient/time/site split, baselines, calibration, uncertainty and failure coverage; ICU results stay ICU-scoped |
| Comparator | All 2,139 ACTG175 participants with original endpoint/field definitions | No post-baseline leakage; treatment/censoring/time units, reference methods and deliberately constructed external-control simulations with declared limitations |
| Trial design | Existing 492-case numerical/reference suite plus frozen realistic design scenarios | Preserve numerical equality; complete real conversation/result/version/export checks and operation characteristics under relevant null/alternative conditions |
| Evidence ingestion | Existing 20-paper/1,104-cell corpus, KM rig and added real-publication figures | Actual parser and table-finding performance; source/arm/unit binding and reconstruction limitations |
| Matching, parallel owner | Existing A/C/E/F outputs and their declared full/subset denominators | Freeze plugin release and replay affected default product paths; if full 165-topic results are required, run/report the missing topics without presenting the 133-topic set as complete |

No dataset is universal validation. ACTG175 RCT data cannot by itself establish
external-control transportability, and synthetic trajectory fidelity cannot
establish individual treatment counterfactuals. Algorithm unit/reference checks,
feature execution, data quality and clinical predictive performance are reported
separately. The 2026-11-04 matching report's historic budget is not transferred
to a new campaign automatically; reuse current explicit authorization and freeze
an executable cost envelope from actual workload estimates.

## 8. Execution order and scope discipline

P00/P01 -> P02, with P03/P04/P05 fixed in that first end-to-end extraction ->
P06/P07 -> P08/P09 and each plugin's P10 -> P11 -> P12.

P08's data guarantees apply from the first implemented operation, not only at
the final review. P10 starts once the runnable implementation and scoring are
frozen; it need not wait for all four plugins or a favorable pilot score.
Independent package acceptance proceeds while the matching team closes its own
release. No numerical-engine rewrite, new universal workflow DSL, duplicated
job scheduler or indiscriminate promotion of old prototype branches is planned.

## 9. Review inventory

Read and reconciled for this consolidation:

- October 25 reset review and the original product boundaries.
- October 26 PR #17 remediation, its second closure round and remaining proof limits.
- October 29 public-data remediation and compact-home acceptance.
- November 1 paper-flow remediation and its execution addendum, and algorithm-gap research.
- November 2 algorithm TODO with its November 4 implementation status.
- November 4 algorithm real-conversation acceptance, including the partial second retest.
- November 4 historical matching checkpoint and audit, by their preserved branch.
- Matching delivery plan section 16, score index, gap/security/behavior/final reviews and subsequent fix commits at `d5f690b15`.
- Current professional-plugin design, including the owner's open-domain clarification.
- Current source functions and method registry, the synthetic provenance probe,
  and exact-revision GitHub workflow/job evidence.

Useful links:

- [Plugin design](../specs/2026-11-05-vcr-professional-plugin-design.md)
- [Algorithm implementation checklist](2026-11-02-vcr-algorithm-todo.md)
- [Algorithm conversation acceptance](2026-11-04-vcr-algorithm-acceptance.md)
- [Public-data/UI acceptance](../../ui-ux-audit/2026-10-29-vcr-remediation-acceptance.md)
- [Matching delivery and results at its reviewed revision](https://github.com/anonymous-temp/EviMed-Science/blob/d5f690b15/docs/superpowers/plans/2026-11-04-vcr-matching-delivery-plan.md)
- [Matching review index at its reviewed revision](https://github.com/anonymous-temp/EviMed-Science/blob/d5f690b15/docs/superpowers/plans/2026-11-04-vcr-matching-delivery-assets/README.md)

This review made no product changes, accessed no raw private clinical notes and
made no paid model calls. The synthetic provenance probe is the only new
execution evidence; prior test outcomes retain their original scope.
