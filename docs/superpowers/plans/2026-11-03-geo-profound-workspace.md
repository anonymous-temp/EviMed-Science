# GEO Profound Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Work within the scoped ownership recorded below.

**Goal:** Implement the approved Profound-based GEO workspace while retaining the existing project, workflow, measurement and native-conversation identities.

**Architecture:** Keep the existing GEO API, result components and legacy addresses. Give the platform sidebar a GEO context, arrange result tabs and analysis views by the approved groups, and place the single resident DSH frame either in project work or beside its exact result. Preserve scope and session identity on every transition; the eight execution steps remain available in task detail.

**Tech Stack:** React, TypeScript, React Router, existing design-token components, Vitest, Node server, DSH.

---

## Task 1: Correct medical empty states

**Files:** `OpenScience/apps/web/src/components/geo/tabs/AccuracyCharts.tsx`, `AccuracyTab.tsx`, direct accuracy tests.

- [ ] Distinguish no observed answer, a completed measured zero, partial results, a failed read and an empty filter; never claim an unmeasured product has no errors.
- [ ] Exercise both the no-observation and measured-zero cases in `AccuracyTab.test.tsx` or a dedicated focused test. Preserve retained and filtered results.
- [ ] Run `corepack pnpm --filter @ai4s/web exec vitest run src/components/geo/tabs/AccuracyTab.test.tsx`; expect exit 0.

## Task 2: Project collection

**Files:** `OpenScience/apps/web/src/app/routes/GeoHomePage.tsx`, `GeoHomePage.test.tsx`, existing project client.

- [ ] Replace master-detail preview with directly navigable project cards, using existing project state, feature flags, sorting and creation recovery. Do not manufacture metrics.
- [ ] Exercise empty, loading, failure, creation, duplicate names and direct project navigation in `GeoHomePage.test.tsx`.
- [ ] Run `corepack pnpm --filter @ai4s/web exec vitest run src/app/routes/GeoHomePage.test.tsx`; expect exit 0.

## Task 3: Contextual navigation and grouped analysis

**Files:** `OpenScience/apps/web/src/components/sidebar/Sidebar.tsx`, `Sidebar.test.tsx`, `components/geo/geoTabs.ts`, `geoAnalysisMode.ts`, their direct tests.

- [ ] Give GEO project routes one contextual sidebar with project work, AI performance, content and publication, product and evidence, and settings; retain a direct way back to the platform and its existing width and collapse behavior.
- [ ] Classify all 27 existing analysis IDs once into the destinations in V2 section 9. Remove the global 27-item menu and expose each view in its own group.
- [ ] Preserve all pre-existing addresses and their scope, session, selected object, version and hash. Existing links may continue using old paths when their behavior is correct.
- [ ] Add a contract test that every `GEO_ANALYSIS_OPTIONS` ID is classified exactly once and no new ID is invented. Test the sidebar on GEO and non-GEO routes and at least one same-project navigation carrying filters and session.
- [ ] Run the sidebar, GEO navigation and analysis mode tests; expect exit 0.

## Task 4: Project work, analysis tabs and native conversation

**Files:** `OpenScience/apps/web/src/app/routes/GeoProjectPage.tsx`, `components/geo/GeoConversationPane.tsx`, `components/geo/useOpenGeoConversation.ts`, `components/geo/useGeoPath.ts`, `lib/taskPane.ts`, `app/layout/SessionFrameHost.tsx`, direct tests.

- [ ] Replace the always-visible eight-step rail and full-width dock with the project work layout and four analysis tabs. Keep run progress and stop reachable through the existing run details and activity controls.
- [ ] Place the resident native conversation as the primary work surface; on results open that same session in a right pane. Preserve exact answer identity and hash instead of converting an answer URL to a generic question list.
- [ ] Keep old `/chat/:sessionId` links working and preserve project ownership, scope, session, draft, refresh, permissions, retries and return path. A result route may host the frame only with an explicit addressed session and same-project authorization.
- [ ] Exercise direct answer to conversation to answer, project switch, browser back, scope change, read-only and missing-session paths. Reuse the resident frame; no second composer or iframe.
- [ ] Run `GeoProjectPage.test.tsx`, `GeoAnswerPage.test.tsx`, `RuntimeUiFrame.test.tsx`, `useGeoPath.test.ts` and task-pane tests; expect exit 0.

## Task 5: Recompose existing result views

**Files:** existing GEO `tabs/*`, `GeoAnalysisWorkbench.tsx`, related focused tests.

- [ ] Use the existing visibility trend and ranking surfaces as the analysis template; put claims, citations, questions, content, publication and evidence in their approved destinations without duplicating controls.
- [ ] Preserve the existing truth contract for no data, actual zero, partial collection, errors, changed scope, metric definition and target/actual comparison. Keep all 27 registered views reachable.
- [ ] Test question import and diagnostic start, claim/answer/evidence drilling, content revision/versions and publication/monitoring links.

## Task 6: Update design authority and verify

**Files:** `OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md`, `OpenScience/DESIGN.md`, `OpenScience/AGENTS.md`, focused acceptance tests and this plan.

- [ ] Record the owner's approved GEO-specific exception to the persistent eight-step rail and bottom dock. Retain DS23's shared projection, permissions, native frame and truthful states for all modules.
- [ ] Run the targeted tests above, web typecheck, lint and build; run broader frontend and GEO integration checks as warranted. Use UI fixtures and browser walkthrough at desktop, intermediate and narrow widths with empty and populated projects.
- [ ] Exercise real DSH + DeepSeek and monitoring only where the isolated local environment and authorized services permit. Record unavailable external provider or runtime gates separately from mock tests.
- [ ] Conduct independent spec and TypeScript code review, correct findings, commit and push the branch. Do not deploy.

## Open acceptance boundaries

- A creation request whose response is lost is retained locally and is never silently retried. This is not server-side idempotency: a request may still be running after the person checks the list, and independent tabs can race. A durable actor-scoped request key, payload hash, reserved control/GEO identities, cross-process recovery, deletion tombstone and transactional project-limit admission need an independently tested backend change before exactly-once creation can be claimed.
- The isolated UI fixture does not provide a live native runtime or the external measurement/social providers. Its browser walk proves only the observed navigation, data states and accessibility, not the three real-model journeys, producer dispatch, native stop or remote provider behavior.
- Browser history now keeps an opaque intent locator; an unacknowledged draft held only in this document cannot be recovered safely after a full reload or account switch and is reported as not restored. Previously written legacy history entries can be scrubbed only when visited. Drafts already acknowledged by the native composer retain the kernel's existing behavior.
