# Paper-and-ink visual adoption on the module workspace

Date: 2026-11-02. Source baseline: `origin/main` at `6118b7a50`, specification v3.3 and DS23. Branch: `codex/paper-ink-ui-20261102`. This replaces the unimplemented November 2 proposal wherever it conflicts with the owner's review. No deployment is authorized.

## Accepted corrections

- Adopt direction A, paper and ink, directly. Keep the existing warm paper, terracotta and ink roles; do not add a palette, static-card shadows or arbitrary sizes.
- Keep the current 24px page title and 280px kernel sidebar constant (and legitimate saved widths). No 28px heading or 208–232px sidebar experiment.
- Preserve DS23's single projection, next-step-only header primary, eight GEO steps, collapsed conversation dock, 1180px split breakpoint and 432px native conversation column. Improve visual hierarchy and list/detail clarity inside that structure; do not add a competing action header or rearrange the workbench.
- Memory remains a star-led T4 overview. Readable content, categories and changes follow the star. Do not add a pending/approval area or require memory confirmation. Existing data filters do not become a new workflow.
- The native input is the home page's protagonist. Do not add another inbox or conversation/task list. At most one future continuation line may name only running work or work actually waiting for this person; this iteration adds none without a verified need.
- Empty states state the way to proceed. Do not add page-value explanations, new safety/source/backend status panels or clinical approvals; preserve the existing check/caution marks and actual business error recovery.
- Use existing T1–T6 templates: the proposed P2/P3/P4/P7 map to T1/T2/T3/T4, reading to T5, settings to T6. Conversation and editing use the existing conventions; create no parallel P-template system.
- Reuse `OpenScience/scripts/ops/page-templates.json`, the current walk and its baseline. The previous 151-view run is historical evidence, not a new inventory or this revision's result.
- Remove external-user comparison studies, participant recruitment, baseline-metric research, multiple-direction competitions and multi-role process ceremonies. Keep concrete counterexample tasks for our own walk-through.

## Work and ownership

1. Correct the proposal, canonical specification and engineering links; include the previously missing source index. Retain DS22.5/DS22.6 by reference rather than restating another state/form policy.
2. Apply paper-and-ink hierarchy through existing shared surfaces: distinguish page ground from work surface with existing tokens, keep 24px title, use spacing and weak boundaries rather than extra enclosing cards. Preserve height/focus/scroll contracts.
3. Keep the DS23 conversation/result split and dock behavior; refine only their surfaces, edges and readable hierarchy. Header actions keep projection-owned next-step semantics and action kinds.
4. Add static groups to the existing sidebar navigation. Keep destinations and separate Research Tools and Extensions entries. Keep the project/conversation list and sidebar width behavior intact.
5. Check star-led memory, GEO list/detail, reading and home against the existing template table. Fix confirmed visual defects without undoing current product decisions or adding state explanations.
6. Run targeted and full appropriate tests, build, existing page walk, light/dark and narrow/split visual review. Do not raise budgets merely to pass. Review specification compliance before code quality.
7. Attempt the four real-native gaps below in a disposable local environment, distinctly from the synthetic walk. Record exact configuration and observable result, not just API registration or mock success.
8. Update `OpenScience/PROGRESS.md` and this receipt, commit and push the branch; no merge or deployment implied.

## Real-native acceptance ledger

All entries start open. Local synthetic layout proof is useful but cannot close them. A revision-unknown runtime image is not evidence of the current native bundle until its relevant bytes or a new build are verified.

| ID | Required observation | Final local result |
|---|---|---|
| N1 | A complete real DSH + DeepSeek turn in the DS23 split, with result and native composer usable together | Passed in the isolated real-provider setup; initialization HTTP 403 anomaly retained below |
| N2 | After a real conversation, stored project facts refresh the adjacent checklist and tick the actual satisfied item | Passed after repairing the completion bridge; no reload, 385ms from native completion message to the checked UI |
| N3 | Stop a real GEO run; distinguish stop-request pending from the producer-confirmed stopped outcome | Open: real evidence-step request queued, but no programme producer/run_id was dispatched before request timeout; the GEO activity stop endpoint was not verified |
| N4 | Open and use the native right-side panel while its host conversation column is 432px, preserving a usable return/composer | Passed: actual native column 432px; Workspace files and Browser panel opened |

No production accounts or data are used. Provider credentials remain runtime-only. Isolation, resource caps and known image/provider identity are prerequisites for a genuine acceptance claim.

## Research used, and its limits

The private research index was previously not delivered to the owner. A reviewable index is now included in [paper-ink sources](../../ui-ux-audit/2026-11-02-paper-ink-sources.md). Sources informed this proposal but do not override owner decisions or the canonical specification.

CDC's historical CoDesign case informs brand intensity by touchpoint and coordination of content, navigation and implementation. 58UXD's experienced-user case is compatible with existing DS22.6 and does not create another form rule. Alibaba Cloud's playbook describes declarations and execution/evaluation contracts, not a catalogue of page patterns; it is a methodological reference only, with no dependency or skill installation.

## Execution receipt

### Implemented and reviewed

- Sidebar destinations now have four static groups without changed routes, feature permissions or width constants. A shared scrolling body preserves the project area and keeps the account footer reachable at short heights.
- WorkspaceSplit uses the existing surface and hairline/faint roles. Its outline does not consume the native column's width; outer, client and content width were each measured at 432px. The 1180px breakpoint, resident-frame behavior, dock and next-step projection remain unchanged.
- The existing geo-visibility page had 11 measured control kinds on both the baseline and initial candidate, against its unchanged budget of 10. Group links now use the existing 14px UI role at the existing small-control height rather than inheriting 12px grid metadata. Tall metric content, drill-down and scope were preserved; no budget was raised.
- Real testing exposed a short-turn refresh defect. The existing ledger reader now announces a newly observed terminal run once even when it never observed running. More importantly, the supported DSH rc.5 SessionSummary.running transition sends a native turn-settled notification. The host retains source/origin/frame/project/sequence checks and matches the current scoped session before announcing the existing shared refresh event. No new poll, synthetic completion, second composer or cross-origin DOM patch was added.
- Specification, TypeScript/code and security reviews found no remaining blocking issue in these changes. Source references are delivered with the branch; the separate Chinese reading copy was corrected to these same owner decisions.

### Verification

- Full web suite: **543 files, 6,764 tests passed**. Web typecheck and full web lint passed. Native bridge tests: **36 passed**; focused host bridge tests: **156 passed**; harness-port typecheck and relevant lint passed.
- The existing full fixture walk exercised **151 views**. Its single failure was the pre-existing geo-visibility control-style count above. After the targeted fix, eight light/dark and 390/768/1024/1440 combinations measured 9 or 10 control kinds, no horizontal document overflow, and successfully opened the actual question/model-answer detail. The original full report and the targeted correction are separate records; a second wholesale 151-view walk was not claimed.
- Sixteen additional combinations (four widths, two heights, two actual themes) had no horizontal document overflow. At 480px height, Tab reached all navigation, project and footer targets without a trap. Light and dark data-theme/computed backgrounds were recorded. The star remained the leading view. The sampled T5 file was raw text, not a PDF qualification test.
- Real acceptance used a synthetic account, dedicated PostgreSQL/internal networks, DSH **0.2.1-rc.5**, and real DeepSeek through an isolated control plane. Final successful run: `run_b0f56793d5eed97c6f32a5ed7bd6f67d`. Native completion and host event: `2026-11-02T08:10:12.403Z`; project GET at `.419`; checked indication visible at `.788`. Provider usage retained settled request/run associations, with **CNY 0.20433640 settled** and one canceled request whose cost remains uncertain.
- Controlled derivative runtime image: `sha256:ba41da8e173f4d1344454fa0f6a9beba18cb820c00358e58c79ff27bc9fcebf3`. The resolved profile-installed socket source matched the candidate, and installed client SHA256 was `32e35f24f0ab55be2c3c03fd555180d726fdcdbcded3da47fb232286b5308cb0`. This is not a production release-image build receipt. A production adoption must rebuild/install the socket client; copying only web assets or the outer source directory does not update the profile's installed bundle.
- `verify:seams` passed against the actual Linux runtime profile installation. A native macOS invocation reported a differing sandbox argv profile; the target Linux invocation matched the recorded runner contract. No fixture was rewritten to hide that platform difference.

### Retained gaps and boundaries

1. **N3 remains open.** The actual programme request stored requested/queued and a claimed dispatch but produced no run_id; it ended in a headers timeout. Native conversation cancellation separately reached canceled/runtime_canceled, but is not evidence for GEO activity stop. Diagnose bounded-session reservation/producer dispatch in the isolated environment before retesting the actual stop path; do not invent a run ID or clear the queue to call it passed.
2. Native initialization session/settings/commands/skills requests produced repeatable empty-body HTTP 403 responses even though navigation acknowledged success and real turns subsequently completed. Their cause remains unresolved and is not removed from the receipt.
3. Initial real tests used an outdated profile-installed socket copy. The final image/served-byte check corrected that test setup and enabled the true immediate-refresh verification. Earlier fallback-only evidence is retained, not presented as the final result.
4. Physical assistive technology, all real device/browser combinations, a fresh production PDF/output qualification, CI and a production release-image build remain separate. No deployment or production data access occurred.
5. The previous v3.1/v3.2 acceptance gaps are not implicitly closed. The existing page-templates table and walk remain the sole page inventory.

Evidence is retained outside the repository under the task's `paper-ink-walk-20261102` temporary directory and `evimed-paper-ink-native-20261102` acceptance cache. Credentials, cookies, raw native logs and third-party images are not committed. The source baseline is the main revision recorded above; unrelated research commits arriving on main during this task were not silently incorporated into the tested candidate.

The task-owned control planes and runtimes were stopped, both isolated databases were shut down, and the task Docker networks/data volume were removed after evidence collection. Other tasks' services and data were not changed. Source recipes and acceptance artifacts remain available for a later fresh replay.

## Follow-up: monitoring page visual completion

The owner rejected the screenshot from the preceding receipt as visually unfinished and approved this follow-up. Its baseline is `7a8c16656`, using the same synthetic monitoring project for a direct local comparison. The previous checks remain historical; this iteration needs new screenshots and scoped checks.

1. Establish result-section spacing at the GEO composition boundary, including signals, empty/loading branches and the active view. A list's last row must not touch the following heading. Preserve mounted hidden content and scope identity.
2. Separate view selection from data filtering. Present the visibility metric as one view selector; place engine, question-pool and question-group filters in the existing filter panel, keeping applied values, removal and clear behavior. Preserve the eight-step rail and current toolbar slot.
3. Give routine running/queued and needs information a quieter presentation while retaining its text, count, progress/recovery actions and visibility. Do not suppress an error or warning that requires action.
4. Make findings a coherent surface with aligned titles, metadata and timestamps. Use existing tokens and primitives, without a decorative enclosing card around every section.
5. Make automatic monitoring a clearly bounded section: scope, current accepted measurement and the stop action/consequence stay visible. Less frequent schedule and allowance details may fold only after consent; enabling must still expose what will be scheduled and charged.
6. Verify real rendered light/dark, narrow and split layouts, long labels, filter round trips, enabled/disabled automation, role restrictions and retry. Keep budgets unchanged. Run independent specification and code reviews, record new evidence and retained gaps, then commit and push without deployment.

Ownership: one implementation worker owns the GEO/component changes and focused tests; the controller owns this plan, canonical rule updates, fixture rendering and final integration. No new route inventory, visual-direction competition, provider run or production rollout is part of this visual follow-up.

The first 26-view follow-up walk exposed a shared composition defect: the collapsed conversation dock obscured part of a 28px chart button on Accuracy, leaving 16px clickable. A second scroll position obscured another row. This is repaired at PageShell's scroll/dock boundary for all callers; increasing individual chart-row heights or waiving the accessibility rule would not address the cause. The sticky top band retains its existing ownership and focus-scroll contract.

### Follow-up implementation and verification

- GEO's result composition now owns a 32px sibling gap; the findings surface has no additional outer top margin. Routine activity and needs retain their existing slots, text and actions with quieter presentation. The metric is one navigation selector; the three data dimensions use the existing filter panel and applied-value controls.
- Findings use one continuous surface. Timestamps trail on a wide list and move below metadata when the actual list width is below 640px, including a narrow result pane in a large browser. Mobile progress and stop controls remain horizontal and readable.
- Monitoring is an unboxed section with aligned heading/actions, current scope and accepted measurement. The consequence of stopping is visible once. Schedule and allowance details fold only while the existing consent is effective; they remain visible before enabling or re-enabling. Permissions, mutation retry and the exact measurement link are preserved.
- PageShell reserves the dock below its scroll viewport. Its wrapper and scroll node remain mounted with or without a dock, so local state, an unsaved draft and scroll position survive a toggle. Chrome observers rebind for the changed viewport geometry. The independent review's initial remount finding was repaired and re-reviewed; both specification and TypeScript reviews have no remaining blocker.
- Final frozen-source web suite: **543 files, 6,768 tests passed**. Full web lint, typecheck and production build passed. The shared-layout checks include draft/DOM/scroll retention, observer cleanup, GEO and VCR composition. No style budget or accessibility rule was relaxed.
- The final **complete existing fixture walk passed all 151 views with zero failures**, zero baseline exceptions, and zero axe-core violations across 75 scanned page views. It includes the page-family and route coverage checks omitted by the earlier partial 26-view run. The harness refused 463 runtime-start attempts as designed; these are layout/read-path results, not native execution evidence. Report: `paper-ink-walk-20261102/complete-walk/report.json` outside the repository.
- Eight light/dark combinations at 390/768/1024/1440px have no horizontal document overflow and remain within the existing 9–10 control-style count. The findings' last row is separated from monitoring by the surface padding plus the 32px module gap. Local split checks at 1180/1280/1440px retain a 432px conversation column; these are mock-fixture geometry checks, not new native-provider acceptance.
- Real browser keyboard checks at 390 and 1440px passed: Enter opens/closes the monitoring disclosure, clearing a selected engine retains the selected metric, and a findings row opens and returns correctly. Additional axe probes at scroll positions 0 and 100px report zero target-size violations after the dock repair. At 400px, a separate probe flags two 22px title rectangles behind the existing sticky top band, rather than dock-covered chart targets. Both retained focus probes show the offscreen or partially covered title automatically returning below the band and passing a pointer hit test when focused; the rows' actual stretched targets are 68–69px high. This offscreen-scanner limitation is recorded separately from the complete walk's 75 clean scans; it is not a claim that every scroll position or physical assistive technology has passed. Independent screenshot review found no additional overlap in the desktop, dark, phone and split captures.
- Before/after desktop, phone and dark screenshots were captured from local builds against the retained synthetic project, with `7a8c16656` as the before build. The shareable copies are in the thread's `paper-ink-monitoring-followup` visualization folder. Fixture task states remain actual capture-time states; no production data or new provider run was used.

The preceding **N3 real GEO producer-stop gap** and **native initialization HTTP 403 anomaly** remain open. This visual follow-up does not reclassify them or claim a new real-provider pass. No merge or deployment is included.

The follow-up control plane and isolated PostgreSQL were stopped after the final walk. Source, reports and preview images are retained; no other task's service or data was changed.
