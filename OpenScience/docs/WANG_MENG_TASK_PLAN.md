# Wang Meng — Delivery Task Plan

Updated: 2026-10-30 14:02 Asia/Shanghai. Working branch: `dev-wm`.

This is the personal execution plan for assignment C: **all web pages and the Frontier backend**. It uses `EviMed_Team_Code_Assignment_October_2026_v3.docx` (the October 12 responsibility revision) and the recorded evidence in [PROGRESS.md](../PROGRESS.md). It does not replace the team assignment or certify a production release.

## Ownership and working boundaries

- Own the React web experience, API integration, shared UI adoption, responsive behavior, error states and browser acceptance across the application.
- Own the native DSH client experience, including the runtime UI adapter, citation readers, annotation and Mermaid interactions. A registered client plugin alone does not establish working UI integration.
- Own Frontier ingestion orchestration, editing/filtering, numeric consistency, events, digests, recommendations/subscriptions and their web views, including the knowledge-source integration contract.
- Coordinate runtime, authentication/permissions, shared server entry points, plugin assembly and releases with Liu Peng. Coordinate research/GEO/evidence business acceptance with Guo Linsong, research execution with Feng Shuai, knowledge/memory/source locations with Mu Shuren, and collector adapters with Chen Ran.
- Reuse the existing implementation. Existing pages without a current acceptance record need validation and targeted fixes, not a presumed rewrite. Flutter implementation remains outside this assignment.

## Current position

“Locally verified” means the named path has implementation and recorded local evidence. It does not mean every business operation, every page state or production deployment has passed.

| Workstream | Current status | Evidence and remaining boundary |
| --- | --- | --- |
| Vue account migration | Implemented; password sign-in locally verified | Successful real sign-in on October 28, with authentication regression checks. Phone/SMS, registration and password recovery are implemented but still need real end-to-end acceptance. |
| Login presentation | Locally verified | Stable tab heights, validation/error display, compact responsive layout and removal of the team flow's local-account switch. Tested viewport and error-state evidence is in the October 28 entries. |
| Literature, guidelines, drugs and clinical trials | Locally verified core retrieval | Real authenticated results, paging and detail readers; filters, sorting, timeline, tab-specific drafts/cache/scroll and new-query resets migrated. |
| Collection, citation, export and download | Implemented; partially verified live | Live citation text, valid XLSX export and an already-owned PDF verified. New collection writes and allowance-consuming downloads still need real-account acceptance. |
| Search home and result presentation | Locally verified | Integrated category tabs/composer, laptop/desktop layout, loading scene and magnifier motion; October 30 fixes align the result heading/count and animate filter collapse/expand with retained drafts and reduced-motion handling. |
| Global topic recommendation plugin | Locally verified | Independent `@evimed/dsh-search-topics` 0.2.0 package, visible in the local extension center. Uses recent published Frontier developments and a bounded official sample of interventional trial updates; all four categories and original-source drawers verified. No production rollout recorded for this work. |
| Full Frontier delivery | Core chain implemented; team release evidence exists | Ingestion/deduplication, editorial checks, events/hot feeds, follows and daily/weekly distribution are wired into the server. October 25–27 records cover live releases and Frontier browser acceptance. October 30 review passed 134 focused checks; only current-merge smoke checks and reproduced defects remain in this plan. |
| Native DSH client | Implemented; current-release acceptance remains separate | The persistent session frame, frame bridge, source readers and shipped citation/annotation/Mermaid bundles exist. No missing core client implementation was established by this audit. |
| Other web pages | Implemented main routes; specific Active Research gaps remain | GEO, evidence, knowledge/memory, VCR, scheduled work, account, inbox and extensions have real components/API wiring. The concrete unfinished research capabilities are listed under WM-04, separately from configuration and regression work. |

## Execution order

The order below is a work queue, not a new date commitment. Close WM-01's test compatibility issue and real-account acceptance. WM-02/WM-03 and most of WM-04 are merge-regression checks, not feature-development phases. The actual development candidates are WM-04-A/B/C; D/E depend on the backend's data and deployment requirements. WM-05 is integration and handoff.

### WM-01 — Close login and medical-search acceptance

Status: **Implemented; live acceptance and one test adaptation remain**. Owner: Wang Meng; dependencies: account holder and Liu Peng for account/entitlement behavior.

- [x] Confirm the UI-to-service paths for captcha, SMS, password sign-in, registration, code verification and recovery, plus retrieval, collection, citation, export and entitlement-aware download. These are implemented operations, not missing forms or placeholder endpoints.
- [ ] Adapt the collection regression to the shared Button's current loading contract: `EvimedSearchActions.test.tsx:54` still expects native `disabled`, while Button preserves focus with `aria-disabled`/`aria-busy` and guards activation. The same assertion fails in isolation; retain a behavioral duplicate-write check when adapting it. This is test compatibility work, not evidence that collection is unimplemented.
- [ ] Complete real SMS sign-in, registration and password recovery with an appropriate test account; the account holder enters private credentials and codes.
- [ ] Verify collection creation, persistence after refresh, and removal; verify citations and exported records refer to the selected result.
- [ ] Verify a download that consumes entitlement with an agreed test account and allowance; record the expected charge/allowance change and duplicate-click behavior. The already-owned download is already verified separately.
- [ ] Check expired search authorization, permission denial, account switching and retry behavior across all four categories; confirm prior-account results and selections are cleared.
- [ ] Record real-business outcomes separately from mocked regressions, and fix only reproduced gaps.

Exit: a concise acceptance record names the environment, operations, results and unresolved external dependencies. Current UI and retrieval work does not need to be rebuilt to close this task.

### WM-02 — Check Frontier after the merge; fix confirmed regressions only

Status: **Core implementation exists; no new feature work established by this review**. Owner: Wang Meng; dependencies: Chen Ran for collector defects and Liu Peng for infrastructure/shared boundaries.

- [x] Inspect the existing chain: `frontierIngest.mjs` commits entries and cursors together with replay deduplication; `frontierPipeline.mjs` and `frontierNumbers.mjs` implement editing and numeric checks; `server.mjs` wires events, follows, daily/weekly issues, notifications, service routes and the background worker.
- [x] Reuse team evidence: October 25–27 milestones record deployed Frontier iterations, source backfills, typed follows, event regrouping and browser acceptance. October 27 10:35 specifically records 34 Frontier fixture views with zero failures and zero axe findings. These are historical team receipts, not a fresh production inspection.
- [x] Run the current checkout's focused pipeline, numeric, event, daily scheduling, subscription, worker, route, regrouping and plugin-client suites: **134 passed, zero skipped**, October 30. This run is unit/contract coverage; it did not rerun PostgreSQL integration or exercise external delivery.
- [ ] Before handing off this merged branch, smoke-check real list/hot/detail reads, follow/unfollow persistence and existing daily/weekly issues. Inspect ingestion freshness/status and configured notification readiness; if an existing receipt covers the same revision/environment, reuse it.
- [ ] Only if a check fails, open a specific defect with its reproduction and owner, fix it, and rerun the affected checks. Verify actual delivery only on an agreed test recipient/channel when that path changed or failed.

Exit: the merged branch has no reproduced Frontier regression in these paths, or each failure has a tracked owner. Do not schedule a full rebuild or repeat every historical acceptance exercise merely because it is absent from this personal plan. The technical design's October 3 roadmap is historical: for example, its missing post-hoc regrouping now exists in `frontierRecluster.mjs` and the composer's scheduled sweep. Recheck such claims against current code before creating tasks. The already verified homepage recommendation plugin needs new work only for a reproduced regression or a new requirement.

### WM-03 — Accept the native DSH client experience

Status: **Core client implemented; no new feature gap confirmed in this review**. Owner: Wang Meng; dependencies: Liu Peng, Feng Shuai and Mu Shuren.

- [x] Confirm `SessionFrameHost` / `RuntimeUiFrame`, socket client build exports and the port's frame/transport/source bridge. Citation, annotation and Mermaid bundles are present in the runtime image build. `SessionRoute` intentionally delegates rendering to the persistent host; its placeholder comment does not mean conversation UI is missing.
- [ ] Exercise a real conversation's stream, stop, history, refresh, reconnect and project switching, preserving drafts and session isolation.
- [ ] Verify citation opening, source location, annotation and Mermaid interaction on the pinned serving kernel.
- [ ] Check failure/recovery states and accessible keyboard interaction in the actual runtime frame, not only component fixtures.
- [ ] Reconcile client bundle and runtime-image versions with Liu Peng; review any shared adapter/assembly changes together.

Exit: reuse applicable team receipts and complete only the current revision/environment gaps. Actual browser/runtime receipts demonstrate the interactions; a plugin entry or successful build alone is insufficient. Do not rebuild the native client from this checklist.

### WM-04 — Complete the whole-web acceptance inventory

Status: **Main pages implemented; targeted development gaps identified below**. Owner: Wang Meng with the relevant API/business owners.

| Page group | Joint acceptance owner | Primary checks |
| --- | --- | --- |
| GEO, evidence zones/cards and source readers | Guo Linsong; Mu Shuren for source locations | Navigation, API states, readable evidence and stable links back to source/context. |
| Knowledge base and memory capsules | Mu Shuren | Import/read/update flows supported by the current APIs, permission boundaries and refresh persistence. |
| Research tools, runs/results, virtual and active research, scheduled tasks | Guo Linsong and Feng Shuai; Liu Peng for runtime | Create/resume/cancel where supported, live status, files/results, history and failure recovery. |
| Account, inbox, extensions and skills | Liu Peng and each service owner | Actual permissions, empty/error states, readback after changes and installation/status consistency. |

- [ ] Build a route/state checklist from the current router and reuse existing acceptance receipts where their revision and environment still apply.
- [ ] Check loading, empty, error and populated states; laptop/desktop/narrow layouts; typography, alignment, scroll behavior, focus and reduced motion against the [design system](FRONTEND_DESIGN_SYSTEM.md) and [engineering rules](../DESIGN.md).
- [ ] Fix failures in the responsible shared component or page; avoid a blanket redesign of already accepted screens.

Exit: every in-scope page group has an evidence-backed pass or a specific unresolved issue and collaborator.

#### Confirmed unfinished capabilities within WM-04

These are based on current code as well as [the Active Research gap record](active-research/execution-gaps.md). They are enhancements to an existing workspace; the observatory, scheduled-study queue, file links and bounded database import already work as implemented.

| ID | Unfinished capability and current behavior | Wang Meng's part and dependency |
| --- | --- | --- |
| WM-04-A | Authoritative project-wide long-goal inventory and goal state. `observedResearchGoals.ts` includes only recorded LoopX continuation runs; a newly created goal without a continuation is absent, and a round's result is not the goal's current state. | Integrate the authoritative list/state and display/control it consistently. Liu Peng owns the kernel/port boundary; Feng Shuai coordinates research execution. Reuse native LoopX rather than create a second scheduler. |
| WM-04-B | Complete research output/version history. The page lists `artifactRefs`, `outputFiles` and `presentedFiles` from recorded runs; it is not a complete project inventory of intermediate outputs and paper/code revisions. Existing source versions and individual file readers do not close this UI/inventory gap. | Build the results/version experience against authoritative artifact records with Feng Shuai and Mu Shuren. Preserve access and historical retrieval. |
| WM-04-C | Immediate direction changes for bounded background research, if required. The current page steers an interactive execution; a bounded execution receives a follow-up for its next execution, as both the UI and its test state. | Coordinate bounded-runtime delivery/acknowledgement with Liu Peng/Feng Shuai before changing UI semantics. The existing next-execution workflow is implemented; do not describe it as broken. |
| WM-04-D | Reproducible large-table intake and research lineage. The bounded PostgreSQL snapshot has no `ORDER BY`; rows past its cap have no stable selection/sample. Types, truncation metadata and content-addressed source versions already exist, but cross-version schema comparison and complete result-to-input-version traceability remain open. | Wang Meng displays selection/version/difference facts; Mu Shuren/Feng Shuai supply source and execution contracts. Additional database engines and unlimited intake are not implicitly required. |
| WM-04-E | Database-credential rotation/retirement across replicas and shared resource admission. The keyring reader/credential encryption exist, but there is no coordinated rotation lifecycle; `researchDbCapacity.mjs` explicitly limits each process independently. | Backend/platform work led with Liu Peng; Wang Meng integrates relevant status/error states. Prioritize only when the target deployment requires this lifecycle or multiple replicas. |

**Do not count these as undeveloped pages:** disabled or unconfigured connectors; upstream GEO extraction failures that need provider investigation; trial-reference services absent from one deployment; or the intentionally hosted checkout links. `researchCommerce.mjs` implements `hosted_handoff`, not automatic in-app checkout/refunds. A new automatic-payment requirement needs an upstream contract and Liu Peng's coordination; it is not a missing login/search function. Historical documents that say "not deployed" are superseded by the October 28 16:50 team release entry for the named changes, while their remaining functional limits still require code-level checks.

### WM-05 — Integrate and prepare the release handoff

Status: **Integration/release work, not an undeveloped product feature**. Owner: Wang Meng for the handoff; Liu Peng for assembly and production release.

- [ ] Finish reviewing the current main integration: this checkout has a pending merge with no unresolved index entries at plan update time. Preserve existing staged/team work and separate the local changes for review.
- [ ] Run checks appropriate to the final diff, then the agreed integration/browser acceptance. Recheck remote push readiness; the historical Gitee author-email rule required administrator help, but its current state is unconfirmed.
- [ ] Hand over the reviewed revision, package/image identity, configuration requirements, reproducible acceptance evidence and known limitations without credentials.
- [ ] Obtain the team's staging/gray-release and rollback receipts and record the actual production disposition with Liu Peng.

The assignment originally targeted October 30 for production and October 31 for contingency/handover. Those are source-document targets, not evidence that this checkout is released. Do not silently replace them with invented deadlines or mark this local work as deployed.

## Evidence and maintenance

- [PROGRESS.md](../PROGRESS.md) is the sole milestone ledger: October 28 14:59/15:50 for login and live retrieval; October 28 17:52 for search actions; October 30 12:11 for real recommendations; October 30 13:29 for result alignment and filter motion.
- Local-only recommendation receipt: `.evimed-local/acceptance/search-topics-real-20261030/verification.json` at repository root. The independent bundle is under `outputs/dsh-search-topics/`; these runtime/evidence artifacts are not published with this plan.
- Local-only result-layout screenshot: `.evimed-local/acceptance/search-results-aligned-20261030.png` at repository root.
- Local-only Frontier review test log: `.evimed-local/acceptance/frontier-plan-review-20261030.log` at repository root (134 focused checks, October 30). Relevant historical deployment/browser receipts are the October 25–27 Frontier entries in `PROGRESS.md`.
- October 30 review of WM-01/03/04/05: 67 focused server checks and 83 port checks passed; 11 web files produced 468 passes and one reproducible stale collection-button assertion (12 passes/one failure in that file's isolated rerun). Logs are `.evimed-local/acceptance/task-plan-1345-{server,port,web}-20261030.log` and `task-plan-1345-search-rerun-20261030.log`. These are focused tests and source inspection, not exhaustive browser, database or production acceptance. No product implementation was changed during this review.
- Update this checklist when acceptance changes, and add outcomes to `PROGRESS.md`. Keep local verification, shared acceptance and deployment as separate facts; do not infer a completion percentage from implementation counts.
