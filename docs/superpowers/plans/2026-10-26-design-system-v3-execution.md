# Design System v3 Implementation Ledger

2026-10-26. The owner authorized implementing the full v3.1 specification, using gpt-6.1-sol subagents with the parent coordinating, then committing and pushing code without deployment. This ledger records implementation and acceptance separately. The normative scope remains the v3.1 specification and its adoption plan.

## Integration boundary

- Dedicated branch: `codex/design-system-v3-20261026`, initially based on `23c84044a934ec73d8482045ddfecd1159e18c2f`.
- The original checkout and unrelated uncommitted work remain untouched. Only the recorded design/brand files and required referenced plans were carried into the managed integration worktree.
- Reuse peer implementations by scoped patch and dependency evidence, not by replacing large shared modules or importing every ancestor. VCR source: `89fc72cca`, with `useAskAbout.ts` from `7c277a25e`. GEO navigation candidate: `4e7a59f49`. Extensions candidate chain: `afe5d535b`, `c653fabfa`, `97e105cee`.
- No production database mutation, deployment, merge to main or release-tag action is authorized by this execution. Push the reviewed branch; generated/build/local fixtures are distinct from production adoption.

## Work register (2026-10-26 owner-directed handoff)

Local source implements W1–W6: token 3.0.0/generated roles; typed metrics/quantities and real scientific callers; shared interaction/layer/input/batch primitives; scientific viewers; scoped GEO/VCR/module repairs; formatting, IME, navigation, identity and component contracts. The contract inventory records 53 UI modules and 72 public component headers. Historical work-in-progress rows are superseded by this checkpoint.

Confirmed evidence: final frontend suite **483 files / 5,805 tests passed**, TypeScript/Vite web build passed; package suite completed (2,119 passed, 15 explicit environment-dependent skips); pinned R 4.3.3 numerical suite **222/222**, **34 methods**, **158 exact dependency locks**. Native deterministic fixture exercised composer Enter, simulated composition, reload without duplicate submission, stream selection/upward reading, light/dark focus and theme-off identity, with **zero paid calls**.

The owner requested freezing this source checkpoint, committing and pushing it, and recording unfinished execution items. Independent scoped code, TypeScript, security, scientific and migration reviews are complete. Server/web type checks and scoped lint pass; the web lint retains 14 existing warnings. The final targeted browser replay passed 20 of 22 scenarios; both unresolved cases are the GEO header conversation navigation described in OPEN-01. The maintained full walk is not green. No deployment has occurred. The remote branch head and final handoff receipt identify the pushed revision; this document does not imply merge or release.

## Evidence discipline

AT01-AT50 are each resolved to an implementation owner and a proof type. A unit test is not a rendered check, a host axe pass is not native-iframe coverage, and local deterministic tasks are not paid-model or production-data acceptance. External Vue consumption, installed production PWA caches and deployment remain separately named boundaries under the no-deploy instruction.

Use dedicated disposable fixture data and explicit browser executable paths. Never silently disable axe, broaden test exclusions, regenerate all golden images or reduce existing safety/data guards to make the checks green. Keep measured color, numeric correctness, truthful missingness, request identity and producer-owned lifecycle semantics intact.

## Handoff status

- Source implementation, generated token/brand identities, component contracts and scoped module fixes are integrated.
- Findings found by review were repaired with counterexamples, including session-fenced uploads, numeric input, scientific selection, GEO module routing and VCR migration idempotence.
- Browser acceptance remains incomplete: OPEN-01 and OPEN-02 are required before calling the route walk clean.
- This is a commit/push checkpoint, not a declaration that every AT/manual/release gate passed. No deployment, merge to main or release publication is included.

## Remaining execution items

Execute these from the handoff branch. Retain existing failed evidence; create a new result per rerun. Do not widen a budget, suppress an error, classify an empty result as positive coverage, or change a production permission to make a fixture pass.

| ID / priority | Current evidence | Next execution step | Closure criterion |
|---|---|---|---|
| OPEN-01 / P1 | GEO header “Conversation” does not navigate at desktop or phone width. Latest fixture POST `/api/geo/projects/:id/conversation/open` returns **404 `runtime_session_not_found`**, after earlier missing mock inventory/generation was repaired. The real module routing regression is already fixed and its 3 PostgreSQL cases pass. | Trace `useOpenGeoConversation`, the conversation-open route, exact owner/project/session identity and the restored mock session inventory. Determine whether the remaining defect is fixture state or product code; preserve native ownership/generation checks. Add a regression at the failing boundary. | Both widths open the correct selected module session from the actual header; the request succeeds or a real error has visible retry, with no silent non-navigation or generic-assistant substitution. |
| OPEN-02 / P1 | Original maintained fixture walk: **143 views, 38 failures**, 0 baseline acceptances. A stable rebuild replay and later fixes resolved many findings. Final strict targeted replay: **20/22**; source drawer, both VCR studies, Memory and Inbox passed, but this is not a rerun of the maintained failed-view report. | After OPEN-01, run the maintained walker over all previously failing views with axe enabled and the same synthetic coverage requirements. Inspect source control/type/orphan/primary-action counts and unique landmarks, the hot-view typography, all GEO contexts, Inbox selection ownership and Memory totals. Re-run broader views only where changed shared behavior requires it. | A fresh maintained report has no remaining failures for the repaired views; all intended positive data is observable. Preserve the original 143-view report and link the new report rather than overwriting it. |
| OPEN-03 / P1 before merge/release | Full minimal Linux unit receipt remains non-green: 8,987 pass, 43 fail, 3 cancelled, 3,327 explicit no-database skips. Focused reruns resolved nonroot, process reaping, scientific dependencies, source prepack, routing and same-VM PostgreSQL failures. Office rendering lacks the pinned runtime LibreOffice Kit; a pin-inventory scan timed out on the macOS bind mount. Two real Docker extension-preparation PG cases require the immutable Cowork acceptance image. | Read this pushed revision's CI results. Use the workflow's pinned Office/runtime and immutable extension acceptance preparation, normal nonroot Linux checkout and isolated per-suite databases. Replay remaining environmental failures there; fix any reproduced source failure without weakening gates. | Required CI checks for the exact pushed revision pass, or each genuine external blocker is separately recorded with a reproducible command. A source/build pass is not an image, runtime or deployment pass. |
| OPEN-04 / P2 | Desktop Chromium, emulated touch, forced colors and reduced-motion probes passed; native deterministic tests covered Enter, simulated IME, reload, scroll/selection and theme on/off. Physical assistive technology and all browser engines were not exercised. | Run actual screen-reader/keyboard and touch acceptance on representative desktop/mobile hardware; cover host dialogs, announcements, scientific value alternatives and the native iframe separately. Run composition sequences in WebKit/Firefox where supported. | Record AT41/AT47/AT49 outcomes per browser/device/assistive technology, with no inferred universal accessibility certification. |
| OPEN-05 / P2 release boundary | Token 3.0.0 consumers/assets are generated in this repository. External Vue consumers and already-installed PWA/native caches have not adopted a release. | In the relevant consumer/release work, update the exact token pin/readback, inspect light/dark and theme-disabled identity, and test installed-icon/cache refresh. | External consumer receipts and installed-client readbacks match the adopted package/brand version. Do not publish or deploy under this task's no-deploy instruction. |
| OPEN-06 / P2 | Web lint passes with **14 existing layout warnings**; these have not been eliminated in this checkpoint. | Review the named warnings in the lint receipt page by page. Move controls into the appropriate existing slots or document a measured, task-specific exception; do not disable the rule or increase the global baseline. | Each warning is removed or has a reviewed semantic exception with a rendered test. |
| OPEN-07 / release acceptance boundary | Local fixtures and the numerical suite do not establish production-data correctness, paid-model end-to-end outcomes or field performance. | In a separately authorized release/acceptance task, execute representative ordinary work, GEO and VCR journeys against the intended runtime/data, then measure relevant performance on representative devices. Preserve source/claim/provenance and partial-result semantics. | Named user journeys and performance measurements have real receipts. This item does not authorize deployment or paid production activity now. |

### Status after integration and release (2026-10-27, integrator)

Integrated with PR #17 and 前沿动态 rounds 4–5 on `int/1026`, live as `evimed-fd515cda2980-1` (2026-10-27 00:10Z); the next line is `int/1027`.

- **OPEN-01 closed.** The header 「对话」 opens the project's primary conversation; the fixture restores the pointer it needs. Fixture walk passes it at both widths.
- **OPEN-02 closed on the fixture, re-walk pending on production.** Fixture walk of `52671987c`: 143 views, 0 failures, 0 axe violations, after three walk carve-outs were removed for measured `budgetOverride` rows. The production walk of `evimed-fd515cda2980-1` (real data, throwaway account): 92 views, 7 failures — the congress list took 13.9 s (and so two pages it names), 「AI 概览」 citations as a tenth control kind, the empty study list without its reason (desktop and phone), and the conversation frame's cold start; each fixed on `int/1027` (`a1207c07b`, `df2d4d836`), to be walked again after that release.
- **OPEN-03 closed.** Linux battery on the merge: server 9,121 pass / 0 fail (3,319 database skips run in the product-state and solo-database steps, green but the two local-Docker extension cases), web 5,802/5,802, packages, ops, MCP 1,028, build. CI's one failure (the inbox selection case hard-coding a budget of eight) is fixed in `103991a78`.
- **OPEN-04 open.** Physical assistive technology is not available to the integrator; the emulated probes stand.
- **OPEN-05 closed for this repository.** Production serves `/manifest.json?v=16c9bc0c` with theme and background `#f7f5ef` and versioned icons (`evimed-192.png?v=47bb46c1` …); an installed PWA picks them up from the changed URLs. External Vue consumers adopt token 3.0.0 in their own release.
- **OPEN-06 closed.** Web lint: 0 warnings.
- **OPEN-07 partly closed.** The release walk covered ordinary, GEO and VCR journeys on production data with a throwaway account; paid-model end-to-end outcomes were not re-run (owner: no further live campaigns for this round).


## Evidence receipts retained locally

The coordinator's `implementation-2026-10-26/` artifact set contains the following. These local filenames are evidence pointers, not bundled production assets.

- `web-final-delivery.log`: 483 files / 5,805 tests; `web-build-layout-final.log`, final type/lint receipts.
- `packages-final.log`: domain 1,340; port 389 plus 10 skips; socket 321; contracts 69 plus 5 skips. Token tests separately passed 32 with 1 optional official-schema environment skip.
- `r-numeric/final-full.log` and `.json`: complete 222-case / 34-method run, with all 158 dependency locks; complete local environment archive and checksum retained.
- `browser/final-source/`: 43 focused browser checks, including scientific viewers and emulated touch.
- `gallery-linux/` and `gallery-check-*.log`: reviewed Ubuntu 24.04 / Noto CJK / pinned Chromium light and dark references; measured 0.000% differences on readback. These cover the default gallery, not every page.
- `browser/final-ui-walk/report.json`: 143-view historical failed receipt; axe 4.12.1 scanned 68 views with zero violations in that run. `browser/rebuild-recheck/` retains the subsequent stable replay, including the source landmark finding later repaired.
- `browser/final-walk-closure/`: final targeted 20/22 result; 51 Chromium judge tests, 142 Node tests and 4 fixture restart/generation tests passed. The two remaining header failures are OPEN-01.
- `linux-pg-final-residual.log`: 87/87 across 8 isolated PostgreSQL suites; `linux-pg-native-routing-fixed.log`: 3/3; `vcr-migration-final.log`: 32/32 with historical rows, new-write refusals, stale preexisting checks and repeat-OID assertions.
- `linux-server-unit.log` and `server-durable-isolated-final.log` retain the initial broad failures. Focused replay receipts explain the repaired regressions and environmental differences; they do not turn those original runs green.

## DS coverage and AT evidence map

The specification's Appendix A remains the DS01–DS21 ownership map. The following connects its AT cases to actual source proof families. A named test is a reproducible implementation check, not a declaration that all W/M requirements passed. Paths below are relative to `OpenScience/apps/web/src/`, unless stated otherwise.

| DS groups | Implementation and proof family | Boundary |
|---|---|---|
| DS01, DS10 | Native deterministic provider, `lib/runtimeUiBridge.test.ts`, routing/server tests | Real paid provider and absent native workflows unexecuted |
| DS02–DS05, DS20 | `app/designTokens.test.ts`, chart palette tests, generated digests, browser geometry/theme fixtures | External Vue, installed PWA caches, field devices remain external |
| DS06–DS09, DS19 | `components/ui/*.test.tsx`, `lib/focusTrap.test.ts`, `lib/announce.test.tsx`, component-contract inventory | Screen-reader and physical touch acceptance remains manual |
| DS11, DS13, DS16 | Scientific viewers, quantity/type tests, VCR domain/server/MCP/R tests | Clinical validity is distinct from fixture correctness |
| DS12, DS14, DS15, DS17 | Frontier/memory/GEO/inbox/extensions route/component tests and seeded browser walks | Production data and runtime activation require separate receipts |
| DS18 | Browser keyboard/reflow/axe fixtures and token contrast | No universal WCAG/field-performance claim |
| DS21 | Mutation/dirty/nav/format/IME/batch component tests and native fixture | Host 300ms/10s/60s transitions, monotonic time, passive examples and inactive hidden readers are implemented and tested; native and physical AT remain separately scoped |

| AT | Existing proof family / acceptance boundary |
|---|---|
| AT01 | Native conversation fixture and host routing; ordinary task production acceptance separate |
| AT02 | Specialist routing/server and seeded conversation fixtures; no paid-model completion claim |
| AT03 | Token generated-artifact/package identity checks; publication separate |
| AT04 | Token tests and host/native theme-on/off fixtures; installed cache adoption external |
| AT05 | Theme/overlay and scientific gallery browser fixtures; OPEN-02 maintained walk closure pending |
| AT06 | Read/error/stale component and route tests; OPEN-02 maintained walk closure pending |
| AT07 | GEO typed missingness/navigation tests; production measurement separate |
| AT08 | quantity.test.ts, NumberField.test.tsx, VcrNumber.test.tsx and R numerical suite |
| AT09 | Button.test.tsx and native admission fixture; one intent identity retained |
| AT10 | Public native command group localized; loopx-init ID retained; real execution fixture-unavailable |
| AT11 | Native stream selection/upward-read fixture; real device manual gate |
| AT12 | Native reload without resubmission fixture; production reconnect separate |
| AT13 | focusTrap.test.ts, FormDialog/Drawer tests; cross-engine/real AT manual gate |
| AT14 | Scientific viewer gallery and viewerKeyboard.test.ts; 43 focused browser checks passed; physical AT remains manual |
| AT15 | Scientific gallery keyboard/value fixtures; physical touch manual gate |
| AT16 | Scientific keyboard and canvas readout fixtures; real AT manual gate |
| AT17 | Viewer gallery/keyboard fixtures; physical device gestures manual gate |
| AT18 | Mobile route/unsaved navigation fixtures; final full walk pending |
| AT19 | Token scale and long-title/identity browser fixtures; OPEN-02 maintained walk closure pending |
| AT20 | GeoTabs/GeoTypeScale and VCR scoped-step tests; seeded process/result walk |
| AT21 | Memory sparse graph/linked list and ShowMore fixture; production graph separate |
| AT22 | FrontierReader.test.ts and reader route fixtures; editorial acceptance separate |
| AT23 | useFileDrop.test.tsx and upload readiness tests; real transfer/parser external |
| AT24 | Source/version/capsule domain and route checks; actual import rights retained |
| AT25 | VCR units/provenance/model tests and 222 R checks; scientific review separate |
| AT26 | Schedule server/route tests; no actual timed unattended run claim |
| AT27 | AsyncSwitch.test.tsx and extension lifecycle tests; actual native activation separate |
| AT28 | InboxBell and inbox selection/recovery fixtures; delivery channels separate |
| AT29 | Reflow/axe/layout fixtures; physical touch and real AT unexecuted |
| AT30 | Viewer/output identity and source tests; actual export/application check per format |
| AT31 | designTokens.test.ts and generated semantic role checks |
| AT32 | Computed chart palette distance tests; categorical data exception retained |
| AT33 | PendingFeedback.test.tsx: no flashing before 300ms, truthful 10s feedback, monotonic deadlines, completion/unmount cleanup; admission and duplicate guards stay immediate |
| AT34 | PendingFeedback.test.tsx and real GalleryPage.test.tsx: 60s non-durable limit, no invented cancellation/background, milestone-only announcements, no announcements from passive/hidden examples; actual durable ActivityStrip controls retained |
| AT35 | Button.test.tsx; real focus/width browser fixtures |
| AT36 | Switch.test.tsx, AsyncSwitch.test.tsx; true promise and unknown-result cases |
| AT37 | FieldShell and NumberField tests; quantity parser and scientific callers |
| AT38 | FormDialog/Drawer and shared unsaved-guard tests; route portal/dirty save races |
| AT39 | ConfirmDialog.test.tsx; actual backend restore remains operation-specific |
| AT40 | Toaster.test.tsx and lib/announce.test.tsx; real AT reliability manual gate |
| AT41 | Announcer deduplication tests; first/repeat real screen-reader proof pending |
| AT42 | Tabs.test.tsx auto/manual and overflow tests |
| AT43 | Accepted navigation/dirty-block fixtures; full route walk pending |
| AT44 | ProjectBrowser and display identity tests; no stored rename |
| AT45 | lib/format.test.ts; Beijing/24h/date-only/future boundaries |
| AT46 | Host composition submission tests; real hardware IME manual gate |
| AT47 | Actual pinned native fixture Enter/composition/reload/selection/theme checks; hardware IME manual |
| AT48 | lib/batchSelection.test.ts and actual selection callers; mixed-failure recovery scope retained |
| AT49 | Combobox/date/file tests and gallery; async/IME/date/parse boundaries |
| AT50 | 72 public component contracts plus generated 3.0.0 identities; external adoption unverified |

Preserve old failed logs and distinguish the final receipts. The coordinator must update pending results before claiming integrated acceptance or a verified remote head.
