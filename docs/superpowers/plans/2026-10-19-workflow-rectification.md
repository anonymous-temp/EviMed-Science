# Research workspace workflow rectification

> For agentic workers: use subagent-driven-development, with specification review followed by independent code review. The owner authorized implementation, deployment and real acceptance after this reconciliation; do not request the same approval again.

**Goal:** Complete the owner's nine screenshot findings as coherent, usable workflows without losing existing research, tenant isolation, native DSH behavior or scientific functionality.

**Architecture:** Keep the control plane and existing project, session, job, method, evidence and memory records authoritative. Reuse the persistent native DSH frame, current VCR computation jobs, source plugin and memory adapters. Change presentation and missing adapters, not the underlying execution model.

**Baseline:** `29ab9b3df2d8569ad448b3b740ed5d864831c850`. Production observed before work: R19.2 `4df43c60c152`; this is a starting observation, not a release claim.

**Tech stack:** React/TypeScript, existing design-token primitives, Node control plane, PostgreSQL, DSH, OpenViking and the existing R/Python VCR engine.

**Implementation checkpoint (2026-10-19):** Product changes and evidence through `44b919079` are committed and independently reviewed. Checked items below mean local implementation plus focused checks, not deployment. The complete local browser walk and its focused corrections are recorded; exact-revision Linux CI, release artifacts and live acceptance remain open in section 9. Literature intake maps preserved source numbers into the existing reference simulators; an external fitted model without a supported execution contract remains an incomplete registration.

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

The reference-trials view currently searches only saved records; use `vcrEvidence.findPrecedents/readRegistryRecord/extractPrecedent` rather than building another fetcher. Existing VCR card settings cover population, trial scenario and criteria; other supported methods must reuse the existing domain contracts and job API. Existing source requests expand AI discovery, not automatically the medical frontier feed. Empty native-memory output is not evidence of lost data; verify the actual account/engine first.

## 1. Shared rules and contextual navigation

- [x] Replace contradictory current rules in root `AGENTS.md`/`CLAUDE.md`, `OpenScience/AGENTS.md`, `OpenScience/DESIGN.md` and the October 8 reference with an explicitly dated October 19 correction; retain historical findings.
- [x] Flatten module wrappers in `components/sidebar/ProjectBrowser.tsx`; retain global module navigation and project type icons.
- [x] Use canonical resolved project names across sidebar, header and conversation; retain disambiguation and rename behavior.
- [x] Keep DSH file tree, tabs, preview, browser, zoom and fullscreen in the native frame.
- [x] Preserve direct URLs, refresh, Back/Forward, project switching and correct focus; reject stale async results from the previous project.

Verify `ProjectBrowser.test.tsx`, `Sidebar.test.tsx`, router, frame/pane and composition tests. Browser acceptance includes desktop/mobile, two projects, a retained conversation and a native right-pane action.

## 2. GEO conversation and workflow

- [x] Reuse `SessionFrameHost` placement for a GEO conversation view, with canonical project and session binding from the existing GEO API.
- [x] Keep project identity and one compact workflow/status selector visible while conversing; no extra composer or competing workflow state.
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
- [x] Call the library Reference Trials and explain its purpose through search and use actions, not another project manager.
- [x] Add thin authorized routes for existing external registry search and record lookup; retain saved records and source coverage.
- [x] Search -> open preserved registration -> select an existing study -> save/reuse its reference/evidence with lineage.
- [x] Distinguish configured/unqueried/failed/empty sources and support clear/retry/example queries.
- [x] Preserve planned/actual enrollment, participant matching, clinical constraints and tenant concealment.

Verify `VcrHomePage`, `VcrPanels`, `vcrTrialSearch.integration`, `vcrEvidenceMatching.integration` and route authorization tests.

## 7. VCR method configuration and execution

- [x] Organize methods by user task and show their relationship to model records.
- [x] Show required inputs, applicability, outputs and use-in-study actions before technical versions/validation details.
- [x] Reuse `VcrSettingsDrawer/getVcrCardSettings/editVcrCard` for existing study cards; project other supported domain schemas into typed forms without a second executor.
- [x] Save changed parameters as versions, retain actual source/data references, invalidate affected descendants through existing contracts and create/get/cancel the existing VCR jobs.
- [x] Link results/failures/partial outputs and reusable configuration to the actual run; no fake successful execution for metadata-only models.
- [x] Correct scenario/baseline-prediction/digital-twin labels and distinguish numerical reference checks from clinical applicability.
- [x] Represent missing assumptions/endpoint/risk information honestly; preserve the existing method engine and supported partial delivery.

Verify card-edit, method/domain/job/applicability suites and a real configured deterministic job, subsequent version and result comparison.

## 8. Source-led literature model intake

- [x] Start from a DOI/link/upload/existing reference and reuse the source/evidence pipeline to extract available parameters and units.
- [x] Display the actual model interface, parameters, input/output mapping, population and missing fields; allow useful incomplete registration without claiming it runs.
- [x] Remove automatic low-risk and empty-endpoint-as-unlimited assumptions; retain unassessed/undeclared semantics through API, storage and display.
- [x] Distinguish registration, incomplete specification, supported execution and measured validation based on real records.
- [x] Support versioned correction, source supplementation, supported test/use-in-study, and retirement without altering historical runs.
- [x] Use a compact registration dialog and a proper configuration surface where needed; no empty tall drawer standing in for a working import.

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
