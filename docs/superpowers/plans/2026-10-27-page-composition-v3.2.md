# Page Composition v3.2 Implementation Plan

> For agentic workers: use subagent-driven development with independent specification and code review. The owner approved the design and execution in this conversation; do not request approval again between tasks.

**Goal:** Apply DS22 across the affected platform pages so each surface exposes its current task, scoped actions, useful content and truthful state without stacking complete workbenches.

**Architecture:** Reuse PageShell, HeaderActions, Toolbar, Menu, the existing feature frames and their authoritative data hooks. Declare action ownership and navigation separately from filters. Feature parents coordinate shared empty causes and explicit edit/analysis modes; no new backend, composer, token palette or permission policy is introduced.

**Tech Stack:** React, TypeScript, React Router, existing UI primitives, Vitest/Testing Library, repository browser fixtures and Chromium.

**Baseline:** `47e002f757a432c3a8e5ec7ea35dfc67a66b00ff`, branch `codex/design-system-v3-20261026`. Commit and push the reviewed changes; do not merge or deploy. The October 26 execution ledger remains historical and its seven OPEN items are not implicitly closed by this work.

## Scope and page decisions

| Family / route | Decision and ownership |
|---|---|
| Shared PageShell/PageHeader | Explicit primary/common-secondary/overflow plan; separate immediate preferences; intentional narrow layout; no permanently reserved null-toolbar row |
| Shared Toolbar | Navigation is not a filter; keep useful list actions outside the filter sheet; display applied query scope and reset using the existing measured folding implementation |
| Shared document exports | One format menu, with original ordinary three-format and GEO five-format producers, source identity, retry, download, cancellation and progress retained |
| GEO project and all eight workflow steps | One business or analysis main area; all 27 analysis views remain reachable; retain current step, session, round, dates, versions, selection and frozen plan scope |
| GEO overview / visibility / accuracy / journey / evidence | Remove default full-analysis stacking. Preserve meaningful result summaries, history, partial data and independent failures; coordinate first-use causes only after successful reads |
| GEO questions | First show the question task/list. Import and full editing are explicit main-area modes, preserving original rows, mapping, version, draft, sampling contract and idempotent recovery |
| GEO sources / plan / content / distribution | Keep exact source-to-plan context in the existing Plan destination; source analysis, planning and result analysis use explicit modes rather than complete embedded pages |
| Memory overview | Show useful content and attention items before history; group related content without repeated empty recipes; use compact sparse history and explicit received-capsule management |
| Memory list/map | Preserve source-specific errors, native engine truth, map/list alternatives and immediate memory preference; move representation selectors out of filter semantics |
| VCR study/calculation/history | Separate result destinations and nested representation choices from filters; preserve budget confirmation, native conversation, active work, history and all scientific objects |
| Sources / Inbox | Preserve batch ownership, selected scope and partial results. Knowledge representation selectors are navigation; safety inbox items remain outside unsafe bulk operations |
| Frontier feed/directory | Use the shared query/action contract. Preserve the existing adaptive feed and content-specific navigation; make permitted zone creation an explicit page action |
| Extensions | Long create/import/edit skill work uses the main area with return/draft behavior; short inspection/configuration can remain in drawers |
| Autopilot | Preserve split-pane task selection and visible run/stop/recovery. Distinguish execution navigation from task actions |
| Readers, settings, capability lists, shared-capsule transactions, operations | Retain legitimate reader/local-toolbar/configuration/transaction structures; migrate applicable shared header/query contracts without flattening useful sections or weakening permissions |

## Tasks

### Task 1 — Canonical specification

Files: `OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md`, `OpenScience/DESIGN.md`, `OpenScience/AGENTS.md`.

- [x] Add DS22.1–DS22.8 and AT51–AT58, dated 2026-10-27.
- [x] Reconcile DS05/06/09/19 and the old unconditional same-height toolbar rule.
- [x] Keep token 3.0.0 and historical evidence unchanged; identify new implementation as pending until actual receipts exist.

### Task 2 — Shared composition contracts

Files: `components/layout/{HeaderActions,PageHeader,PageShell}.tsx`, `components/ui/{Toolbar,Menu}.tsx`, `components/document/DocumentExportActions.tsx`, their tests and composition fixtures under `OpenScience/apps/web/src/`.

- [ ] Implement typed `PageActionPlan` and preserve Button/Link state semantics across visible/overflow render paths.
- [ ] Make responsive priority explicit: primary remains reachable, secondary actions yield to labeled overflow, preferences remain a separately named control group.
- [ ] Add Toolbar navigation and ordinary applied-query summaries without counting navigation as filtering.
- [ ] Remove blank null-toolbar reservation and keep measured sticky/scroll offsets correct.
- [ ] Group export formats in a menu; preserve exact producer source, pending/error/ready/retry/cancel and immediate duplicate-intent guards.
- [ ] Run focused component tests and web typecheck, then specification and TypeScript/code review.

Behavioral assertions include:

```tsx
await user.click(screen.getByRole('button', { name: '导出所选数据' }));
await user.click(screen.getByRole('menuitem', { name: '导出 CSV' }));
expect(requestDocumentExport).toHaveBeenCalledWith(source, ['csv']);
expect(container.querySelector('[data-toolbar-reserved]')).toBeNull();
```

### Task 3 — GEO main-area modes

Files: `app/routes/GeoProjectPage.tsx`, `components/geo/GeoAnalysisWorkbench.tsx`, `GeoQuestionWorkbench.tsx`, `geoFrame.ts`, all analysis callsites in `components/geo/tabs/`, associated scoped navigation/export/feature tests.

- [ ] Add an explicit `analysis=V01…V27` main-area selection, without overloading the existing business `view` query parameter.
- [ ] Use the existing `GeoAnalysisDescriptor` fields and existing selection/session/version keys; mount only the active business or analysis area.
- [ ] Replace full-workbench append operations with named analysis entry/return paths; preserve frozen V26 strategy identity and exact source-to-plan data.
- [ ] Coordinate genuine first-use overview state while keeping history/trends, partial results, independent read failures and scoped empty results visible.
- [ ] Default Questions to browsing/generation; enter import/edit deliberately and preserve sampling/cost/evidence confirmation before execution.
- [ ] Verify all 27 views, all five export formats, unchanged original-row identity, exact scope, history and denied/failed/stale states.

Commands:

```sh
pnpm --filter @ai4s/web exec vitest run src/app/routes/GeoProjectPage.test.tsx src/components/geo/GeoAnalysisWorkbench.test.tsx src/components/geo/GeoAnalysisWorkbench.navigation.test.tsx src/components/geo/GeoQuestionWorkbench.test.tsx
pnpm --filter @ai4s/web exec vitest run src/components/geo/tabs
```

### Task 4 — Memory and task-specific editing

Files: `app/routes/MemoryOverviewPage.tsx`, `components/memory/overview/*`, `components/memory/MemoryFrame.tsx`, `app/extensions/*`, corresponding real feature tests.

- [ ] Give memory attention/content priority over historical growth; avoid large repeated empty recipes.
- [ ] Keep all current content/detail destinations and independently readable parts. Receiving/activating/sharing remain distinct operations.
- [ ] Render sparse history compactly and place received-capsule management behind an explicit main-area entry with a clear return.
- [ ] Move long skill authoring/import into a main-area editing mode, preserving original data, scope, dirty guard, save failure and activation semantics.
- [ ] Test actual data access and actions, not only changed card/heading counts.

### Task 5 — All shared callers and regression prevention

Files: remaining PageShell/PageHeader callers and feature frames in the scope table; `test/{compositionFixtures,expectComposed,pageComposition.test}.tsx/ts`, applicable lint and browser composition tests.

- [ ] Migrate action ownership explicitly; remove opaque action piles from affected callers and guard new unreviewed use of the migration escape hatch.
- [ ] Move destination/representation selectors in StudyFrame, memory map and knowledge graph into navigation semantics.
- [ ] Preserve local reader controls, batch bars, permissions and meaningful empty destinations as named valid compositions.
- [ ] Add whole-page state assertions for shared empty cause, one active work area, explicit edit entry, action ownership and retained partial results.
- [ ] Change superseded fixed-height assertions by semantic rule and evidence, not by global budget increases.

### Task 6 — Rendered acceptance and handoff

- [ ] Run the complete web suite with bounded workers, web/server type and applicable lint checks, and the production frontend build.
- [ ] Exercise affected templates at 390, 768, 1024 and 1440 CSS px; include dark, first-use, populated, selected-filter and independent-error examples, plus representative 200% zoom/short height.
- [ ] Measure actual action bounds and content start, open overflow/filter/export menus, follow analysis/return paths and confirm preserved draft/scope. Use isolated synthetic state and no paid providers.
- [ ] Review the original three screenshot families visually. A DOM test, color budget or no-overflow result alone is not a page-quality verdict.
- [ ] Complete independent specification, code and TypeScript reviews, repair findings and retain precise evidence.
- [ ] Update this scope map and canonical implementation status from actual receipts; keep unresolved historical/open release gates explicit.
- [ ] Commit from the repository root, push the current branch, verify the remote hash, and clean only owned temporary services. No deployment.

## Acceptance receipt

Implementation is in progress. Record actual commands/results here after each task; do not infer a pass from an expected test or from this plan.

### 2026-10-27 coordination checkpoint

- DS22/AT51–AT58 are written in the canonical specification; the token source remains 3.0.0.
- Shared foundations have a typed action plan, responsive container handling, distinct toolbar navigation and a single document export menu. A real browser verified 390/768/1024/1440 and a 500px split pane, native modified-link guards, menu focus return, a selected-filter reset and the primary intent guard. Further work remains: common secondary actions must not be hidden on every ordinary content width; visible workflow rails need an explicit overflow affordance and a fully visible current step; scope controls must coexist with planned actions. Targeted tests for the first and third cases are currently red by design until the shared implementation is updated.
- Memory overview now presents attention/content before compact history and uses an explicit received-pack mode. Independent specification review required retaining the direct full methods list and known partial history; both were repaired and re-reviewed. The latest page suite passed 25 tests, with 34 model tests and the memory-controls test separately passed. Whole-page browser proof is separate.
- GEO main-area analysis, explicit question editing and source-to-plan context were implemented. Independent specification review identified scope/pagination, dirty-query navigation, frozen-version, source-search, unknown-save and partial-result cases; corrections and targeted regressions are in progress. Do not infer final pass until its next independent review and final browser replay.
- A first synthetic browser build captured 28 pages at four widths; it predates the latest GEO fixes. It confirmed a 390px workflow rail clips its current step and has no explicit overflow entry. The selected-scope source-to-plan path, received-pack mode and five-format export menu were exercised. Native iframe and real file export were not certified.
- No deployment, production data mutation, or paid model call has been made in this work. The 2026-10-26 OPEN items and their original evidence remain separate.

### 2026-10-27 second checkpoint

- The shared rail's real 720px feedback loop was reproduced and fixed. A fresh Chromium pass at 390, 768, 1024 and 1440px sampled 120 frames per width without a React error or horizontal document overflow; current step, all-step navigation, keyboard, touch, native link state, disabled links and manually scrolled position were exercised. The all-steps affordance may remain visible at a boundary after status wrapping; this deliberate hysteresis prevents a resize loop. It does not remove a step.
- Memory map representation controls, frontier period and tracking categories, the knowledge graph representation and VCR study destinations now use navigation rather than query-filter semantics. Sources retain their original add-menu/project behavior, and permitted evidence-zone creation is directly available. The VCR population result precedes optional definition management; used definitions and historical comparisons remain visible, and direct template/version links are preserved.
- Report Markdown, print and conversion actions are grouped while retaining immutable version identity and the preview's project-scoped download. The conversion component now rejects activation from an already open menu when the originating GEO results become stale.
- Skill creation, import and long editing were moved into the main area. Review identified missing project-switch and transfer dirty guards, ambiguous ordinary import outcomes, a stale editing flag after Back and a missing exit from a paused transfer. The implementation reports all repaired: 168 focused web tests, plus 40 server tests including real PostgreSQL, passed. Ordinary imports now use an account-scoped atomic receipt and an explicit, same-tab session recovery intent. Security and database review passed; final code review and rendered-page acceptance are pending. Closing a tab is not certified to retain its session intent; service-instance reconstruction is not a process-crash test, and database rollback does not remove unreferenced immutable files.
- Independent GEO review found four state/context defects after the 330-test pass: slow account recovery could overwrite a new draft, an analysis failure hid prior data, V26 version was counted as a filter, and a source-to-plan entry could lose its source context. All four were repaired, then independently re-reviewed; 340 focused tests passed. Synthetic browser replay also verified first-read failure and refreshing failure: the previously read rows and exact scope remain visible and locked until retry succeeds.

### 2026-10-27 final local verification

- The full web suite passed **493 files / 5,938 tests** with bounded workers; the web typecheck passed. The web lint command completed with **0 errors and 13 warnings** in other existing files. The source-layout guard uses nine reviewed, exact source/role/text exceptions for meaningful state or scope explanations; ordinary internal narration, even with an ARIA role, is still detected. This is a static safeguard, not proof of page-level acceptance.
- Updated composition tests and the directly exercised feature tests passed **177 tests**. Independent review confirmed distinct reachable GEO steps, real visible memory counts and links, received-mode focus and scope, and pending/failed data states.
- Isolated browser replay covered seven baseline routes at 390, 768, 1024 and 1440 CSS pixels, plus 38 additional page-width and task-state cases for the affected families. It used synthetic data and an explicitly mocked skill validator; an initial 429 from intensive fixture use passed after the stated retry delay. The original three screenshot families, partial/failure paths and draft/project-switch protection were exercised. A separate final-build replay with delayed synthetic transfer responses verified pending pause, settled pause and reuse of the same intent key at 390 and 1440px. These do not certify native runtime behavior, actual export bytes, real users, physical assistive technology or whole-platform visual coverage.
- Ordinary skill-import idempotency and recovery received independent code, security and PostgreSQL reviews. **40 focused server tests passed, with no skips**, including local PostgreSQL concurrency and database rollback. Service-instance reconstruction is not a process-crash test; session storage is not guaranteed to survive closing the tab.

## Remaining acceptance and follow-up items

These are execution items, not statements that the corresponding product paths have passed. The seven OPEN items in the 2026-10-26 execution ledger remain separate and unchanged.

| ID | Remaining item | Evidence needed to close |
|---|---|---|
| OPEN-V32-01 | Complete a route-by-route composition inventory beyond the exercised page families; retain explicit exceptions for legitimate local controls and migrate any remaining crowded header or mixed navigation/filter. The shared `actions` compatibility slot remains available. | Route/state inventory with screenshots and a decision for every production route; regression checks for each newly discovered class. |
| OPEN-V32-02 | Validate the native conversation, actual skill validation/activation, live model work and actual file outputs. The synthetic runtime and skill-validation stub prove host layout and local interactions only. | Authenticated end-to-end run on the intended revision and runtime, with actual producer receipts and output checks. |
| OPEN-V32-03 | Complete accessibility and responsive acceptance beyond the automated browser coverage. | Real assistive technology and keyboard/touch review, actual browser 200% zoom, short height, dark theme and relevant device/browser combinations, with findings and retest. |
| OPEN-V32-04 | Ordinary skill-import recovery is scoped to the same browser tab's session storage; closing that tab or losing its storage is not guaranteed to retain the original request key. | A deliberately specified durable recovery mechanism across tab/browser closure, authenticated account and project isolation, no stored document bodies, and replay/expiry/revocation tests; until then the user must inspect the added-skills list before a new import. |
| OPEN-V32-05 | Test import recovery through an actual process crash/restart and assess same-account lock duration on representative large skill packages. Current tests reconstruct service instances and use PostgreSQL, but do not kill the process or measure large-package contention. A database rollback can leave an unreferenced immutable prepared file. | Crash injection with durable-receipt verification, bounded contention measurement and a safe orphan-retention/cleanup decision. |
| OPEN-V32-06 | The frontend lint command reports 13 warnings in existing, separately owned files; the layout scanner's reviewed exceptions cover only the explicitly recorded static text and cannot establish whole-page state correctness. | Review and resolve the remaining warnings and maintain behavioral state tests alongside any newly approved exception; do not use role or a count alone as acceptance. |
| OPEN-V32-07 | CI, merge, deployment and release acceptance are not established by this branch handoff. | Inspect CI for the pushed revision and separately authorize/perform any merge or deployment, then verify the intended runtime and customer path. |
