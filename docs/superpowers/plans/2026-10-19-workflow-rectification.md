# Research workspace workflow rectification

> For agentic workers: use subagent-driven-development, with specification review followed by independent code review. The owner authorized implementation, deployment and real acceptance after this reconciliation; do not request the same approval again.

**Goal:** Complete the owner's nine screenshot findings as coherent, usable workflows without losing existing research, tenant isolation, native DSH behavior or scientific functionality.

**Architecture:** Keep the control plane and existing project, session, job, method, evidence and memory records authoritative. Reuse the persistent native DSH frame, current VCR computation jobs, source plugin and memory adapters. Change presentation and missing adapters, not the underlying execution model.

**Baseline:** `29ab9b3df2d8569ad448b3b740ed5d864831c850`. Production observed before work: R19.2 `4df43c60c152`; this is a starting observation, not a release claim.

**Tech stack:** React/TypeScript, existing design-token primitives, Node control plane, PostgreSQL, DSH, OpenViking and the existing R/Python VCR engine.

**Implementation checkpoint (2026-10-19):** Product changes and evidence through `181b5bc65` are committed and independently reviewed. Checked items below mean local implementation plus focused checks, not deployment. The complete local browser walk and its focused corrections are recorded; exact-revision Linux CI, release artifacts and live acceptance remain open in section 9. Literature intake maps preserved source numbers into the existing reference simulators; an external fitted model without a supported execution contract remains an incomplete registration.

**Owner-review checkpoint (2026-10-20):** Application source `74482190c27732679b0e8bebd763f790c9060c79` is deployed; PR #13 is merged. The four new owner screenshots reopen product acceptance for the global home, VCR navigation, method discovery/use, literature intake and study startup. Earlier checked boxes record implemented mechanisms and scoped checks, not acceptance of the current experience. The October 20 section below is the current execution backlog and takes precedence over conflicting presentation choices. The owner has approved completing the consolidated October 20 list, including implementation, review, deployment and real acceptance.

## Reconciliation and preserved scope

Sources reviewed include root and OpenScience AGENTS, PRD/technical design, DESIGN, the September 21 frontier spec and its later corrections, September 28 VCR product/build design, September 29 integration contract, September 30 release plan, October 8 design reference and its later owner rulings, memory presentation/map code and earlier memory reviews. Historical inventories and implementation-package ownership are not current product restrictions.

The owner's October 19 instructions supersede three older presentation rules: module-grouped project trees, frontier article drawers and hiding sparse memory visualizations. The latest instructions do not remove scientific provenance, account ownership, permissions, explicit uncertainty, native capabilities or existing module features. Preserve general-purpose work and load medical specialization where relevant. Do not add mandatory human approval, paid actions, new spend caps, or a second agent/runtime/data model.

| Area | Required outcome | Preserve |
| --- | --- | --- |
| Shared navigation | Project -> conversation in sidebar; clear page/step/filter hierarchy; one appropriate primary action | Search, rename/delete, sorting, lazy conversations, feature visibility, native right pane |
| GEO | One project workspace across conversation, workflow and results; durable URL context | Eight canonical steps, every result view, sources/claims, metrics, budgets, membership, actual run identities |
| Memory | Visible, interactive relationship/topic/dimension/time/activity views on actual account data | Native and legacy engines, correction/forget/undo, scope, partial reads, no fabricated records |
| Frontier | Evidence zone as peer navigation; AIHot-style Chinese feed and addressed article/event readers | Original links, preprint/retraction labels, follows, stars, read/hide, research context, history restoration |
| Continuous content | Separate evidence for source discovery/admission, collection, editing, daily/weekly and authored research | Existing plugin ownership and validation, real source/output records, budget/error semantics |
| VCR reference trials | External search -> record -> use in selected existing study | Planned vs actual enrollment, source provenance, existing clinical matching/recruitment |
| VCR methods | Task-grouped catalogue -> configure -> versioned job -> result -> reuse | Existing typed schemas, deterministic jobs, cancellation, partial outputs, data-plane isolation |
| Literature models | Source-led registration/parameter intake and honest executable-state distinction | Model evidence, units, immutable versions, applicability and existing supported execution contracts |

At the original baseline, the reference-trials view searched only saved records; reuse `vcrEvidence.findPrecedents/readRegistryRecord/extractPrecedent` rather than building another fetcher. Existing VCR card settings cover population, trial scenario and criteria; other supported methods must reuse the existing domain contracts and job API. Existing source requests expand AI discovery, not automatically the medical frontier feed. Empty native-memory output is not evidence of lost data; verify the actual account/engine first.

## 1. Shared rules and contextual navigation

- [x] Replace contradictory current rules in root `AGENTS.md`/`CLAUDE.md`, `OpenScience/AGENTS.md`, `OpenScience/DESIGN.md` and the October 8 reference with an explicitly dated October 19 correction; retain historical findings.
- [x] Flatten module wrappers in `components/sidebar/ProjectBrowser.tsx`; retain global module navigation and project type icons.
- [x] Use canonical resolved project names across sidebar, header and conversation; retain disambiguation and rename behavior.
- [x] Keep DSH file tree, tabs, preview, browser, zoom and fullscreen in the native frame.
- [ ] **Reopened by the October 20 usability review.** Preserve direct URLs, refresh, Back/Forward, project switching and correct focus; reject stale async results from the previous project.

Verify `ProjectBrowser.test.tsx`, `Sidebar.test.tsx`, router, frame/pane and composition tests. Browser acceptance includes desktop/mobile, two projects, a retained conversation and a native right-pane action.

## 2. GEO conversation and workflow

- [x] Reuse `SessionFrameHost` placement for a GEO conversation view, with canonical project and session binding from the existing GEO API.
- [ ] **Reopened by the October 20 usability review.** Keep project identity and one compact workflow/status selector visible while conversing; no extra composer or competing workflow state.
- [x] Support both ordinary-chat-origin GEO and module-origin GEO. Starting work continues the correct project and returns its real progress/results.
- [x] Simplify the eight-step/eight-tab/subchip stack while keeping every existing result destination reachable through `geoTabs.ts` mappings and aliases.
- [x] Show actual programme run/session links from the run ledger for the selected step; opening a view does not count as completing work.
- [x] Preserve selected project/session/step/result in URLs and history and retain member capabilities, budgets and external-action constraints. Verify access as an ordinary nonoperator; obsolete operator/preview restrictions are not preserved.

Verify `useOpenGeoConversation.test.tsx`, `GeoProjectPage.test.tsx`, `geoTabs.test.ts`, frame tests and existing GEO route/isolation regressions. Real acceptance must exercise creation from chat, a step execution, its output, return to chat, refresh and a cross-project negative.

## 3. Memory visualization and actual data

- [x] Trace legacy/native data -> map API -> frontend selection/rendering; do not silently treat source errors as successful zero counts.
- [x] Make visualizations discoverable from the memory landing surface and keep the five views on one shared selection.
- [x] Render small real datasets meaningfully rather than suppressing every chart; distinguish no memories, no relationships, empty filter and partial read.
- [x] Keep relationship, topic, dimension, time and activity visuals linked to real memory/document/project records and their correction/forget actions.
- [x] Preserve engine-specific history/limitations internally without inventing fact-level provenance or showing back-office origin/safety notices. Retain capsule sharing, import/export, edit, forget and undo.
- [x] Verify list/chart/count consistency after updates and account/project changes; include keyboard/mobile and text equivalents.

Primary files: `MemoryPage`, `MemoryFrame`, `MemoryMapPage`, `components/memory/map/*`, `memoryMap.mjs` and `memoryMapSources/*` only where a reproduced data defect requires it. Verify focused map/view tests, both source adapters and the real account's aggregate/API observations.

## 4. Frontier navigation and addressed reading

- [x] Put evidence zones in the feed's peer navigation and preserve all existing zone URLs and functions.
- [x] Route article titles and Details to one addressed internal reader; keep the original publisher link explicit.
- [x] Reuse preserved Chinese/original abstracts and metadata. Do not fabricate article bodies or repeat a summary as full text.
- [x] Preserve source, flags, original title, actual Chinese headline/summary, event continuation, star/read/hide/follow and research actions.
- [x] Restore filters, loaded pages, expanded state and scroll when returning; direct-entry readers have a useful fallback destination.
- [x] Compare actual AIHot homepage, article, event and daily reading interactions; retain EviMed branding and medical data boundaries.
- [x] Fix the title-only pipeline cause using actual editor/pending/budget/provider evidence, while preserving readable partial items.

Primary files: `FrontierPage`, `FrontierControls`, `FrontierCard`, `FrontierDetails`, `FrontierLinkedItem`, reading-state helpers, router and only necessary client/service fields. Verify routed reading, original links, source errors, Chinese/partial text, history restoration and desktop/mobile light/dark screenshots.

## 5. Continuous source and writing operations

- [x] Capture the last seven days of real source additions/admission, active-source fetches, received entries, edited/published items and failures.
- [x] Independently capture daily/weekly output and platform-authored research output, including generated-but-refused/unpublished cards.
- [x] Separate AI-only discovery from medical-feed expansion. Complete the requested recurring medical-source candidate/admission path through existing plugin validation when absent; never count article growth as source growth.
- [ ] Resolve concrete stopped/failed/backlogged stages and apply the R19.3 refused-card resettlement through its existing scoped script.
- [x] Persist daily candidate/admitted/failed/retired source counts and last successful processing/output timestamps in operator evidence; no arbitrary minimum new-source quota or invented success.
- [ ] Verify scheduling, health and real persisted results; a live timer is not acceptance.

Reuse `frontierWorker`, pipeline/editor/composer/daily, `frontierIngest`, evidence programme, and the knowledge plugin scheduler/source-request machinery. Read the plugin's own rules before edits. Production reads and repair actions remain scoped and must not print credentials or raw private content.

## 6. VCR study entry and reference trials

- [x] Show New Study as the study-list primary action, not stacked above method/reference configuration actions.
- [ ] **Reopened by the October 20 usability review.** Call the library Reference Trials and explain its purpose through search and use actions, not another project manager.
- [x] Add thin authorized routes for existing external registry search and record lookup; retain saved records and source coverage.
- [x] Search -> open preserved registration -> select an existing study -> save/reuse its reference/evidence with lineage.
- [x] Distinguish configured/unqueried/failed/empty sources and support clear/retry/example queries.
- [x] Preserve planned/actual enrollment, participant matching, clinical constraints and tenant concealment.

Verify `VcrHomePage`, `VcrPanels`, `vcrTrialSearch.integration`, `vcrEvidenceMatching.integration` and route authorization tests.

## 7. VCR method configuration and execution

- [ ] **Reopened by the October 20 usability review.** Organize methods by user task and show their relationship to model records.
- [ ] **Reopened by the October 20 usability review.** Show required inputs, applicability, outputs and use-in-study actions before technical versions/validation details.
- [x] Reuse `VcrSettingsDrawer/getVcrCardSettings/editVcrCard` for existing study cards; project other supported domain schemas into typed forms without a second executor.
- [x] Save changed parameters as versions, retain actual source/data references, invalidate affected descendants through existing contracts and create/get/cancel the existing VCR jobs.
- [ ] **Reopened by the October 20 usability review.** Link results/failures/partial outputs and reusable configuration to the actual run; no fake successful execution for metadata-only models.
- [x] Correct scenario/baseline-prediction/digital-twin labels and distinguish numerical reference checks from clinical applicability.
- [x] Represent missing assumptions/endpoint/risk information honestly; preserve the existing method engine and supported partial delivery.

Verify card-edit, method/domain/job/applicability suites and a real configured deterministic job, subsequent version and result comparison.

## 8. Source-led literature model intake

- [ ] **Reopened by the October 20 usability review.** Start from a DOI/link/upload/existing reference and reuse the source/evidence pipeline to extract available parameters and units.
- [ ] **Reopened by the October 20 usability review.** Display the actual model interface, parameters, input/output mapping, population and missing fields; allow useful incomplete registration without claiming it runs.
- [x] Remove automatic low-risk and empty-endpoint-as-unlimited assumptions; retain unassessed/undeclared semantics through API, storage and display.
- [x] Distinguish registration, incomplete specification, supported execution and measured validation based on real records.
- [x] Support versioned correction, source supplementation, supported test/use-in-study, and retirement without altering historical runs.
- [ ] **Reopened by the October 20 usability review.** Use a compact registration dialog and a proper configuration surface where needed; no empty tall drawer standing in for a working import.

Verify frontend form/error states, API validation and scope, source-bound parameter admission, historical version preservation and a real supported execution. Unsupported external executables remain registered with their concrete missing integration; never add arbitrary code execution.

## 9. Review, host reclamation and release

- [x] Review each slice against this coverage matrix, then run independent TypeScript/JavaScript, Python, database and security reviews as applicable.
- [ ] Run focused meaningful checks first, then required full CI/audits/types/build and real browser flows; do not replace behavioral assertions with permissive snapshots.
- [ ] Inventory Tencent disk/images/containers/build contexts; remove only exact superseded EviMed artifacts/caches/temp files after confirming no active references or original data. Keep other products and credentials intact.
- [ ] Build via the current isolated release workflow; verify source/config/image identity and reuse unchanged engines only with source-closure proof.
- [ ] Follow current manifest/preflight/maintenance/switch/receipt procedures with the live configuration and existing secret files; never reuse October 3 draft operators.
- [ ] Run deployed checks for all nine screenshot paths and the underlying actual operations, including two-tenant/project negatives, native right pane, memory charts and published content.
- [ ] Persist observations/screenshots, update PROGRESS and this checklist, merge/push the reviewed code and synchronize the primary checkout while retaining its untracked owner files.

Completion requires the implemented behavior to work on the deployed revision. Tests, a staged image, a generated report and a completed rollout are separately recorded facts.

## Verification boundaries recorded before release

- Complete web suite: 389 files / 4,701 tests passed; the later method-label change passed all 802 relevant VCR/copy/layout checks and actual browser spot checks. Method field labels now follow method, distribution and complete field path; Gamma/Beta shape parameters are not test significance levels.
- The rich synthetic fixture walk covered 127 views with no functional or axe failures. Its obsolete memory-list probe was corrected without a waiver; the official four-view memory/reader recheck passed, and four real-browser reader contexts checked direct links, reload, original-source navigation and retained nonzero scroll. Synthetic fixture results do not certify native DSH or deployed computation.
- Local plugin suite: 1,300 passed / 8 external probes skipped. Real configured OpenViking browse/read/grep plus cross-user/project, invalid-token and traversal checks passed; the temporary namespace was removed. Curated 38 and Office 4 bounded deterministic tasks passed locally; these are not image/native-dispatch certifications.
- The existing global live-tool/connector/skill audit remains a separate legacy evidence boundary. Old registry/source identities cannot be relabeled current. The nine-workflow remediation does not claim all 57 tools, 128 connector queries or 44 native/delegated tasks were newly certified. No audit gate or historical receipt was loosened to hide this.
- Local Mac server tests include Linux `/proc`, Bash and case-sensitive-filesystem assumptions; short canonical temp paths fixed socket-path issues, but remaining host-specific results must be judged by clean Linux CI. Owner untracked historical peer-review outputs were left untouched; committed-source capability checks ran in an isolated archive rather than publishing those private runs.
- Existing full-release CI exports twelve built images and omits the knowledge plugin. The new independent plugin workflow produces its thirteenth, separately qualified artifact with exact source, base, config, layer and platform identities. Deployment needs both artifacts.


## October 20 owner review: product structure and usability rebaseline

### Evidence and decisions

The owner supplied four additional screenshots: a general assistant home inside a GEO project header; a model catalogue with non-actionable reference simulators and a long literature-registration drawer; live trial results followed by an unrelated saved-record empty state; and a new study with both a Chat button and a large generic conversation surface but no clear research-start action. These are product-acceptance findings, not requests to remove the underlying scientific methods or project records.

Current source inspection establishes:

- The VCR catalogue puts all model records above the task-grouped method list. The four seeded reference simulators do not have `executionSpec`, so their details offer no execution action. Executable method entry points exist farther down the page. A lower-page runner does not make those prominent model cards usable.
- There are 32 canonical R engine methods and four additional longitudinal forecast protocol methods. The forecast methods are not seeded by the R-method catalogue loop. Persisted catalogue rows, historical names and screenshots with different counts require reconciliation; do not declare every displayed row executable or erase historical IDs to make counts agree.
- Literature model records are account-owned and versioned. A registered source/description is different from an executable parameterized reference configuration or an externally fitted predictive model.
- The reference-trials view shares one query across a live search and a saved-record list, producing the contradictory mixed empty state shown by the owner.
- Population definitions are account-level reusable rule templates, while a study owns its selected definition version, input data, cohort and results. Their ownership must be visible through project use, not a disconnected browse-only top-level page.
- A blank study draft waits for its first research definition. Displaying example chips and an input box does not establish that the user knows what will start the programme. The earlier automatic expiry removed apparently unused drafts, including the original acceptance fixture. The October 20 retention correction preserves existing projects because source, study and native-upload writes do not share a deletion lock; explicit deletion remains available. Unknown legacy attachment history keeps a draft reachable without claiming that an upload succeeded. New-study navigation should avoid allocating a remote project until the researcher saves, attaches materials or starts work.
- The screenshot of a GEO header around the global assistant requires independent route/frame-state reproduction. Do not claim a root cause or fix it by changing only the title.

### Research informing the proposal

These primary sources were inspected on October 20. They are interaction references, not new dependencies or claims that one layout is universally optimal.

- [jamovi analyses](https://docs.jamovi.org/usermanual/um_3_analyses.html): selecting an analysis exposes its options and results; selecting an existing result reopens the associated configuration. Adopt the connection between parameters and results, while keeping expensive EviMed jobs explicitly runnable.
- [Galaxy tool interface](https://training.galaxyproject.org/training-material/topics/introduction/tutorials/introduction/slides.html) and [rerunning a tool](https://training.galaxyproject.org/training-material/faqs/galaxy/tools_rerun.html): a tool has typed inputs, parameters, a run action and outputs in an analysis history. Reopening a result recovers the settings needed to reproduce it.
- [RPACT trial-design tutorial](https://www.rpact.org/vignettes/getting-started/rpact_step-by-step_tutorial/index.html): users specify design, endpoint and calculation target, inspect plots, compare scenarios and export a report. This supports a task/scenario workbench rather than pages of method metadata.
- [KNIME first workflow](https://docs.knime.com/get-started/first-workflow): configuration, execution state and resulting data remain connected. Adopt that state continuity; do not add a general node-graph editor merely to copy its appearance.

Three arrangements were considered: a catalogue-only redesign is easy to browse but leaves research context disconnected; putting every tool exclusively inside a full study makes small calculations cumbersome; the recommended arrangement is a general assistant home, project-owned research workspaces, and shared task-oriented methods in the existing Research Tools surface. The existing project, session, source, model-version and job records remain authoritative.

### P0-A. Restore global home and explicit workspace scope

- [ ] A1. Reproduce home/logo/New Conversation navigation from GEO, VCR and ordinary projects, including a fresh login, refresh, Back/Forward and an old open tab. Global home must show the general AI input with no inherited GEO/study title, progress or specialist binding.
- [ ] A2. Keep resume-existing-project links explicit. Clear only the view's stale scope when returning home; preserve projects, conversation history, drafts, sources and native tab state.
- [ ] A3. Keep the VCR landing page focused on research projects, their progress and one New Study action. Remove methods, trial search and population-template browsing as competing project-level top tabs; retain compatible deep links and existing saved objects.

### P0-B. Make a research workspace explain and drive its work

- [ ] B1. Keep the seven canonical VCR steps reachable and their current/completed/waiting states visible. A compact selector may supplement the workflow but cannot be its only discoverable representation. Apply the same continuity rule to the eight GEO steps.
- [ ] B2. Use one conversation entry and one native composer. When conversation is already open, remove the redundant Chat button. Keep project identity, current step and resulting artifacts reachable from conversation and back again.
- [ ] B3. Replace the empty generic study landing with a short research brief: research question, target population, intervention/comparator, endpoint, available materials and intended output. Support partial information and focused follow-up; do not require a large form before asking a question. Derive an editable project name from the first brief and preserve unsent input during navigation.
- [ ] B4. Supply complete editable examples for study design, literature-based planning and existing-data analysis. Selecting an example must visibly populate a meaningful brief. Make Start Research/Run This Step and their effect explicit.
- [ ] B5. Connect the first submitted brief to the real definition, subsequent orchestration and visible outputs. Show what is missing, what can proceed and the next useful action. Do not equate displaying a tab with completing a step, or imply every project must run every matching/recruitment activity.
- [ ] B6. Preserve the requested medical workflow while permitting ordinary discussion in its project. Do not silently replace the bound research conversation with the last opened sibling conversation or detach the programme from its actual run history.

### P0-C. Reorganize methods by research task

Use the following as the proposed display grouping, not a change to mathematical method IDs or scientific assumptions:

| User task | Existing methods to expose | Display consolidation and boundaries |
| --- | --- | --- |
| Inspect data and define a cohort | `profile.snapshot`, `cohort.build`, `population.scenario`, `population.literature`, `population.synthpop`, `population.quality` | One task family; distinguish inspecting data, filtering a cohort, generating a population and assessing its quality. Generation modes retain their different source requirements. |
| Generate simulated patient outcomes | `patients.binary`, `patients.continuous`, `patients.time_to_event`, `patients.longitudinal` | Consolidate the four reference-simulator cards into an actionable simulation entry. Endpoint is a choice; repeated measurements retain a distinct longitudinal mode and inputs. |
| Extract and prepare evidence parameters | `evidence.pool`, `evidence.reconstruct_km` | Evidence pooling and survival-curve reconstruction remain distinct actions. Reconstructed individual records retain that label and provenance. |
| Build external controls and estimate effects | `comparator.entropy_balance`, `comparator.propensity_weight`, `comparator.maic`, `comparator.maic_time_to_event`, `comparator.rmst`, `comparator.weighted_cox`, `comparator.aipw`, `comparator.prognostic_adjustment`, `comparator.map_prior` | Organize weighting/balance, effect estimation and historical-information borrowing as separate stages within one task family. Preserve estimands, anchoring and data requirements. |
| Plan sample size and compare trial scenarios | `design.analytic`, `design.simulate`, `design.grid`, `design.assurance`, `design.procova` | Use one design workbench with calculation target, endpoint and scenario controls. Analytic/simulation/grid are related ways to investigate a design; assurance and prognostic adjustment retain their distinct purposes. |
| Check robustness | `comparator.evalue`, `comparator.covariate_sets`, `comparator.negative_control`, `comparator.tipping_point` | Share navigation and result conventions; retain four different questions rather than inventing one robustness score. |
| Plan accrual and assess eligibility | `accrual.poisson_gamma`, `matching.evaluate` | Two explicit tasks: forecast recruitment and match criteria to authorized records. Keep project/data permissions and unknown-match states. |

- [ ] C1. Reconcile the displayed/persisted catalogue with the 32 canonical engine methods, their versions and the four forecast protocols. Account for `forecast.trajectories`, `forecast.evaluate`, `forecast.compare` and `forecast.trial_benchmark` separately; an interface definition alone does not certify an available predictive service.
- [ ] C2. Put task-oriented method entries on the initial catalogue screen. Move the model inventory, source citations, versions and validation metadata out of the dominant top section and into the relevant configuration/details.
- [ ] C3. Audit every visible entry for an actual purpose, required inputs, expected outputs and a reachable primary action. `matching.evaluate` and `evidence.reconstruct_km` currently bypass the generic runner; route them to their existing specialized flows instead of showing dead controls.
- [ ] C4. Reuse the existing Research Tools surface for discoverability and the same method component inside each project step. Avoid a second disconnected tool directory and avoid forcing a small calculation through the whole seven-step programme.

### P0-D. One interaction contract for every runnable method

- [ ] D1. Use a consistent path: choose task -> select project/data or example -> configure -> run -> inspect result -> save/use in study -> reopen or compare. If a project is required, offer selection/creation in place and preserve entered parameters on return.
- [ ] D2. Show a plain-language purpose and concrete input/output examples where they help the user choose. Use typed fields, units, data-column mapping, meaningful defaults and an explicit advanced section. Reconcile older rules that forbid useful purpose text; do not expose internal API/runtime terminology.
- [ ] D3. Keep a visible primary action on each tool screen. Missing data or unsupported execution must identify the missing prerequisite and offer its remedy. A name, version and green validation tag are not substitutes for an action.
- [ ] D4. Keep parameter configuration and result tables/plots together in the main work area, with responsive tabs when necessary. Do not repurpose the application-wide native DSH right pane or introduce a second file/browser system.
- [ ] D5. Expose actual run progress, cancellation, errors, retained partial results and retryable conditions. Parameter changes create a new configuration/result version; old results retain their original inputs and source/model versions.
- [ ] D6. Give the simulators real configuration, Run Simulation, result-distribution/trajectory views, export and Use in Study actions. Mark example/simulated outputs explicitly. Numerical checks do not imply individual prediction or clinical applicability.
- [ ] D7. Share one configuration/result component and the existing design tokens: aligned controls, clear units and errors, keyboard focus, light/dark charts and reachable desktop/mobile actions. Do not build a different form or navigation pattern for each method.

### P0-E. Put literature and trial references at their point of use

- [ ] E1. Replace the ambiguous prominent literature-model form with a clear Use Literature Parameters action within method configuration or the study's evidence step. Reuse DOI/link/upload/knowledge-source/registry intake.
- [ ] E2. Show extracted values, units, original passages, missing information and destination fields. Allow correction and retain source generation/hash. Saving a citation or a name alone must not claim to import an executable model.
- [ ] E3. Save useful parameter sets as versioned reusable configurations with a clear use action. Keep a separate explicit path for registering an existing fitted model only when its interface, required assets and supported execution contract are known.
- [ ] E4. Move lengthy mapping/configuration into an appropriate main-work-area screen. Restrict drawers to short previews or small edits. Do not ask users to invent semantic versions or self-certify a low model risk as the primary workflow.
- [ ] E5. Reuse the existing clinical-trial search capability from the AI home and Research Tools. From a study, invoke that same search in its evidence context and offer Use in This Study; do not maintain another parallel search product.
- [ ] E6. Separate live search results from saved-in-this-study status. Never show a saved-record empty state below successful live results as if the search failed. Preserve source-specific failure/coverage and distinguish retrieved/displayed totals and planned/actual enrollment.
- [ ] E7. Keep public trial search separate from matching a real person's eligibility. The latter remains a project-authorized operation with its current data and contact boundaries.

### P0-F. Keep population definitions with their research

- [ ] F1. Make the study's population step own its criteria, source data, included/excluded/unknown counts, version and resulting cohort. Remove the detached browse-only population tab from the VCR landing page.
- [ ] F2. Offer reusable definition/knowledge templates from inside that step. Preview and select a specific version; do not present a template as an already assembled study population.
- [ ] F3. Preserve the account-level template library behind Save as Template/Use Template and compatible links. Changed criteria require a new calculation/version and retain historical cohorts and outputs.

### P1-G. Carry forward unresolved work without relabeling it complete

- [ ] G1. Finish real literature-source -> parameter mapping -> two model versions -> deterministic runs -> results -> configuration reuse/historical immutability, including an actual UI save/use action and cross-user/project negatives. The expired blank cross-project fixture was replaced through the normal API with a named, paused synthetic study. The first versioned model and deterministic job were created; the job succeeded, but the patient view returned no records or calibration. Diagnose the persisted result linkage before continuing; do not recreate the successful job, source or model. Retain both failed receipts and use job-specific outputs for historical acceptance.
  - Include the newly repaired generated-population quality path in deployed acceptance: choose authorized training/holdout data and a real generated version through the ordinary interface, execute the R method, and verify independent quality output, exact generation attachment and unchanged original records. Browser queue/cancel evidence and real data-plane integration tests cover their own layers, not successful deployed R execution.
  - Include reconstruction-to-MAIC selection and execution with clearly identified synthetic acceptance data: preserve the original curve receipt, retain the reconstruction table, select that exact result in the workbench, execute the R comparison and reopen its immutable configuration/result. No manually invented pseudo-IPD reference and no engine-double result may stand in for deployed execution.
- [ ] G2. Finish independent review and actual production rerun of the UI-walk tab-isolation/diagnostic fix. The original 76-view run with 56 failures is retained; most desktop failures were a shared-tab navigation cascade, while remaining genuine failures still need individual evidence. Never relax the baseline to hide them. A diagnostic rerun on the ordinary QA account completed 125 live views with no navigation cascade and 18 unaccepted findings: one population heading-level defect repeated across viewport/accessibility checks, plus account-data coverage and stale/asynchronously read memory-address probes. Preserve those findings, repair the semantic probes and complete coverage; the native conversation was deliberately outside this diagnostic rerun and remains part of final acceptance.
- [x] G3. Reviewed the staging-permission fix and passed all six regressions on Linux as root, including actual UID 10001/472/65534 reads of public templates and denial of private skills, secrets and data. The six live directories had already been repaired and real native-memory reads and charts passed. The next release must reuse the reviewed public-directory handling and repeat its live read; private paths remain untouched.
- [x] G4. Verified after-maintenance execution from real persisted records: the programme succeeded on its first attempt at 00:36:43.965–00:36:49.083 UTC on October 20, one decision was saved, and five daily in-app notices plus five pushed preferences were recorded. The earlier 07:30 daily also succeeded; the maintenance delay remains in the record.
- [ ] G5. Continue the frontier content-quality follow-up with actual source/editor results. The observed bounded historical pass repaired summaries for 65 of 99 records; 34 remained title-only at that observation, including 16 original-title fallbacks. Do not fabricate translated headlines, summaries or freshly published dates to close the count. Keep source discovery/admission, collection, editing, daily/weekly and authored research separately observable. The October 20 read-only follow-up verified ongoing intake, two published synthesis-card revisions and a failed CKD capture despite real report/matrix files. Repair the oversized repeated matrix-review metadata through version/digest references, preserve the 256 KiB document limit, and capture bounded field-rejection diagnostics for title-only items. Restore existing artifacts through an authorized repair path without new model runs.
- [x] G6. Cleared the stopped, exclusively owned temporary registry store and the qualified Web transfer copy, then removed two unused D612 Web image identities after checking all consumers and both tag/digest reference sets. Measured free space rose from 10,436,816,896 to 13,348,753,408 bytes (2,911,936,512 bytes reclaimed). Current backups, data, secrets and proof records were preserved; later releases still require a fresh capacity check.
- [ ] G7. Reconcile the GEO run ledger with the four actually presented/downloaded corrected files. The real correction passed, but its ledger still marks the run unverified and lists three artifacts without the CSV. Preserve that limitation until corrected through the supported bookkeeping path; do not add a model turn merely to manufacture a green label.
- [ ] G8. Review/commit/push the remaining verification fixes and this revised plan, then synchronize the primary checkout while preserving owner files. After the redesigned product journeys pass, perform any required release and final ordinary-account acceptance with the exact deployed source recorded.
- [ ] G9. Preserve GEO calendar dates across server timezones. The full local database regression reproduced `2026-09-01` becoming `2026-08-31` when PostgreSQL DATE values pass through a local-midnight Date and UTC formatting. Correct all four affected read paths (`round`, `armSeries`, `armRounds`, `baselineDate`) and cover UTC and Asia/Shanghai separately, including null dates and unchanged timestamps. Do not change expected calendar dates or force UTC to conceal the defect.
- [ ] G10. Remove the frontier retry fixture's millisecond rounding race without changing scheduling behavior: a timestamp written as “now” into `timestamptz(3)` can round into the future before the immediate claim. Make the test's explicit “already due” helper unambiguously past, preserving retry-count and recovery assertions. Keep local environment prerequisites separate: six suites previously missing pgvector now pass all 41 checks against the pinned PostgreSQL image; immutable extension-image checks still require their prepared inputs or the complete Linux CI job.
- [ ] G11. Correct the session-list reader's static regression guard. CI on `861b83ece` found one failure because the test searched from the first session-list call to the end of a large file and rejected an unrelated source-list `.items` access. Scope the guard to actual kernel response bindings, retain negative cases for bypassing the canonical reader, and add the unrelated-list counterexample. Do not rename valid production code to evade the test or weaken the kernel contract.

- [ ] G12. Use neutral curve-image provenance in reconstruction discovery and selection. An authenticated digitization receipt verifies preserved image bytes and point acquisition, not publication status; replace the newly hardcoded `published_curve` metadata with `curve_image` and retain legacy reader compatibility. Keep actual source descriptions/receipt identities and all numerical/source-admission rules. For positive MAIC deployment acceptance use documented public observed trial data and an explicitly labelled dataset-derived KM through the real pixel digitizer; keep synthetic-source refusal as a negative test, never relabel invented records as observed.

Local implementation checkpoint (October 20): A3/B/E5–E7/F/G12 are implemented and independently reviewed. Briefs preserve scoped text, material state and immutable submission receipts through errors/navigation; explicit research-data intake reuses the protected data plane, while public references keep the native upload path. Durable canonical submission flags survive the short activity tail, and visible workflow/view controls preserve programme versus calculation context. The local mock fixture verified one native upload and one persisted Start, preserved its conversation after refresh, and opened protected data intake without an upload or run. Mock runtime unavailability remains explicit; it is not live DSH/definition-generation proof. A 4,835-test full frontend baseline plus final focused recovery/navigation regressions, PostgreSQL contracts and 103 walk checks pass. Three stale intake JSON fixtures from the earlier branch CI failure were canonically regenerated without changing permissions or weakening assertions; final Linux CI and deployed acceptance remain open.

Local implementation checkpoint (October 20): C/D/E1–E4 now have a shared method workbench with actionable task discovery, main-area configuration/results, exact source/job history, explicit study reuse and preserved native DSH surfaces. All 4,785 frontend tests and independent specification/TypeScript/scientific/integration reviews pass; actual local desktop and 390px browser checks verify reachable Run actions, scoped drafts and readable source units. Local queue/cancel and producer-shaped tests do not replace deployed deterministic execution, which remains in G1.

Local implementation checkpoint (October 20): G9–G11 are implemented and independently reviewed. The new calendar regression executes real PostgreSQL assertions in both UTC and Asia/Shanghai; the existing GEO suite passes 32 checks in each zone, frontier retry/recovery passes 25, and scoped kernel reader/adapter checks pass 57. Typecheck and lint pass. These fixes are not yet deployed, so their final release checkboxes remain open.

Already measured and retained, not reopened as missing implementation: final-source full release CI passed; the locked R suite passed 208 cases across 32 methods; actual final public/private Web and runtime bytes and all six skill-root digests were verified; runtime Office flows 21 and render checks eight passed; the startup backup and restore drill completed. After the public-directory permission repair, native memory returned the original 12 records and the original one-record project; actual desktop/390px phone charts showed ticks 0 and 1. The minimal GEO correction used one normal turn, preserved sources/history, and passed seven stranger-access negatives. These facts do not close the product-structure findings above.

### Acceptance order and preservation contract

1. Validate the global-home/project/tool information architecture with concrete page states and one complete research-start journey.
2. Implement the shared method interaction and task grouping, then connect simulators, literature parameters, trial references and population definitions through that same interaction.
3. Exercise the individual methods and complete study journeys against real persisted configurations/jobs/results, then run the full browser/release checks and remaining operational follow-up.

Every changed surface must preserve existing project/session/model IDs, historical versions, source and quote provenance, uncertainty, tenant/project boundaries, scientific method assumptions, native DSH file tree/tabs/preview/browser/zoom/fullscreen, scheduled work and usable partial results. Human-readable purpose and next actions are required where users otherwise cannot use the feature. Do not add a second executor, a global graph editor, forced paid actions, new approval bureaucracy or invented clinical validation to solve a navigation problem.
