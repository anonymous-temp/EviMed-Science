# EviMed platform visual and interaction audit

Two isolated assessments: A reviewed design and saved live-page evidence; B reviewed implementation and component contracts. The parent operated the shared native Chrome window and synthesized the reports only after A completed. This is a dual-agent assessment with a documented browser-tool adaptation, not two independent browser sessions or a successful Impeccable detector run.

Date: 2026-10-26. Source baseline: `23c84044a934ec73d8482045ddfecd1159e18c2f`, with pre-existing local documentation changes preserved. The live serving revision was not established. Local brand edits made later in the task are described separately.

## Decision

Update the full specification and continue using the existing component and token system. The foundation is coherent: restrained lists, readable typography, native general conversation, reusable controls and a real generation pipeline. The main defects concern the meaning of state, predictability of actions, scientific access and responsive behavior. A palette replacement alone cannot fix those defects.

The owner-selected warm-paper/terracotta direction is now implemented locally with a near-black logo. The full maintained specification is [Frontend Design System v3.0](../../OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md); [DESIGN.md](../../OpenScience/DESIGN.md) maps it to implementation. Numerical values remain in `OpenScience/packages/design-tokens`, now 2.3.0. This is not a deployment or a claim that the audit backlog is fixed.

## Coverage and method

| Evidence | What was actually done | What it does not establish |
|---|---|---|
| Live review | 48 screenshot/AX captures; A examined 34 stable captures spanning the principal modules and selected 390 x 844 layouts | 48 distinct pages, all 60 registered views, every data/state combination |
| Source inventory | AST inventory of 389 product TSX files, 65,424 lines; focused manual inspection of shared controls, viewers, routes and modules | Every source line manually reviewed or every surface rendered |
| Contract probes | Isolated jsdom reproductions of focus eligibility, genome initial measurement and cached overflow background; declared-color contrast calculations | Browser geometry, touch or assistive-technology acceptance |
| Baseline checks | 350 focused web tests; ESLint 1,032 files, zero errors and 15 existing warnings | Complete platform test suite or production acceptance |
| Brand validation | Generated artifacts, contrast checks, scoped tests, type/lint, web build and two code reviews; static light/dark visual sample | Every deployed route/native session/PWA/Vue consumer using the new theme |

All screenshots remain in the private task artifact folder, `audit-2026-10-26/captures/`. Its `registered-view-coverage.csv` records all 60 registered views and seven separately handled route patterns, explicitly distinguishing observed, partial/loading and unobserved evidence without assigning automatic passes. Screenshot numeric identifiers below identify evidence without publishing browser chrome, account details or unrelated tab names into Git. An empty native conversation was opened and its runtime warmed; no research prompt, calculation or paid-model task was submitted. Test/data-looking memory records were not classified as a data-quality failure merely because they were visible.

The requested official skill versions were freshly read: [Huashu Design 3.0.0](https://github.com/alchaincyf/huashu-design/blob/4fc7bfdbd5ec3fa2d43ce7a6433de60976a5e4b1/SKILL.md) and [Impeccable 4.7.1](https://github.com/pbakaus/impeccable/blob/3671d50f0ac9a662ce0615e85a256110c9cd720b/.agents/skills/impeccable/SKILL.md). Huashu's concept/hierarchy/craft questions were applied to an operating product; poster whitespace quotas and headline ratios were not imposed. The owner's already-selected direction takes precedence over generic aesthetic preferences.

Impeccable context and detector commands were attempted. The saved launcher first lacked execution permission; invoking it with `sh` reached the real failure: no `darwin-arm64` engine binary, exit 127. There is no deterministic detector count. Browser extension/CDP access timed out; native Chrome and saved evidence supplied the visual review. No mutable overlay or Impeccable live server was injected. The static brand-preview server is a separate, temporary local artifact preview.

## Priority findings

P1 means correct before the affected surface can be accepted as reliable. P2 means meaningful usability or implementation repair. These are audit priorities, not a claimed incident or clinical outcome severity. Evidence labels: **V** live visible/operated; **S** source behavior; **R** isolated reproduction; **D** owner-directed migration.

| ID | Priority / evidence | Problem and consequence | Repair and acceptance |
|---|---|---|---|
| A01 | P1, V + S | GEO displays zero severe errors while other measures are unmeasured; the visible safety number has no measurement denominator. Resource first reads default unknown values to zero/stopped; account read failures can leave disabled blanks with a toast only (source branches, not induced live failures). Unknown facts can look settled. | Separate unknown, loading, failed, stale, partial and measured zero. Show scope/time and local persistent retry. AT06/07. |
| A04 | P1, V; source/live mismatch | Live control/intervention event-rate fields do not show percent/fraction scale, unit or example. The local renderer already has unit-aware support. | Establish serving revision, then verify rendered labels and interpreted values. Do not add a duplicate fix from the screenshot alone. AT08. |
| B01 | P1, S | Genome panning, molecule rotation/zoom and FITS/anomaly value inspection do not offer equivalent keyboard functions. These viewers are reachable from real file/source readers. | Focusable operations, named pan/rotate/zoom and keyboard-selectable value/feature access. Preserve equivalent structured scientific content. AT15/17. |
| B02 | P1, S + calculation | Normal instruction text using white at 30% opacity on fixed FITS/anomaly canvases measures 2.6556:1 and 2.6807:1. | Measured scientific-canvas text roles; normal instructions at least 4.5:1. This is unaffected by merely warming the app canvas. AT16. |
| B03 | P2, S + R | Genome's initial measurement effect runs before the canvas ref exists and never attaches its observer. Valid BED data in a 358px mocked container produces a 760px SVG and zero ResizeObserver instances. | Attach measurement when the real element mounts; verify initial and subsequent resize in a browser. AT14. |
| B04 | P2, S + R | ScrollRegion caches an absolute background RGB. Switching its ancestor from white to dark leaves a white overflow fade. | Inherit a semantic surface variable or refresh when the surface changes; exercise both directions with actual overflow. AT05. |
| B05 | P2, S + R | Shared focus eligibility includes native controls with tabindex -1, hidden inputs and fieldset-disabled inputs. Shift+Tab can target a disabled final input and leave focus stuck at the first. | Correct tabbability including ancestor state, retaining nested-layer behavior; verify actual dialogs. No specific production lockout was observed. AT13. |
| A02 | P2, V | GEO's action-required count contains an automatic service wait. Inbox shows 671 unread items and repeated backlog/recovery messages. This overstates the attention the person must provide. | Separate user action from automatic recovery; group incident updates with current status and accessible history. Preserve safety priority and role boundaries. AT28. |
| A03 | P2, V + S | Similar catalogue rows/chevrons mean family filtering, configuration or conversation. A specialist binding failure can silently fall back to general conversation in source. | Name the actual destination/action, retain failed intent and recovery. Expanded methods already say configure-and-calculate; retain that useful specificity. AT09. |
| M01 | P2, V + S | GEO's process rail and result navigation use different labels without enough mapping, including evidence versus basis and diagnosis versus accuracy/safety. | Explain the relationship at the destination; preserve eight process steps and useful result views without another redundant navigation rail. AT20. |
| M03 | P2, V | A sparse memory graph displays ten nodes with only a few labels and a large blank canvas before readable records. | Make selected records, search/list and real relationships understandable; use an honest sparse-graph arrangement, not fabricated links. AT21. |
| M04 | P2, V | The ordinary native composer menu exposes `loopx-init` with a tool-readiness diagnostic description. | A user-task label when appropriate, or diagnostics in the operator surface; preserve useful native controls. AT10. |
| M05 | P2, V | The sampled article repeats its central fact through title, lead, fact/quotation/interpretation and the side summary with limited added value. | Give each block a distinct reader purpose; keep sources and useful related context. This is an editorial hierarchy finding, not a medical fact check. AT22. |
| M06 | P2, V | At narrow width, similar long project names are truncated while persistent add/rename controls consume identity space. | Make names distinguishable without hover; subordinate secondary row actions. AT19. |
| M07 | P2, V | At 390px, only the first two GEO steps are visible with weak overflow discovery, while a long wait notice and tall unmeasured metric blocks dominate the first view. | Compact missing-state summaries, visible progress/overflow affordance and reachable steps. No unreachable step was proved. AT20. |
| M08 | P2, V | Selecting a mobile navigation destination changes the route but leaves the menu covering that destination. Manual closure works. | Close after successful selection and move/announce context appropriately. AT18. |
| M09 | P2, V | In the GEO extension category, which reports 51 entries, the four displayed entries use raw English skill identifiers as primary titles in an otherwise Chinese catalogue; the other entries are collapsed. | Localized task-oriented title and short purpose, retaining package ID/source/version in detail. AT27. |

The five B findings are the independently confirmed technical defects: two P1 and three P2, with no P0 found in that assessment. The broader table deliberately separates visible problems, source branches and reproduced contracts. It is not an assertion that every listed issue occurred in production.

### Source anchors

Paths beginning `apps/` are relative to `OpenScience/`; shortened `components/`, `app/` and `lib/` paths are relative to `OpenScience/apps/web/src/`. Line numbers refer to the inspected source, before subsequent unrelated edits.

- A01: `apps/web/src/components/geo/geoOverviewModel.ts:341-359`; `components/settings/WebResourcesCard.tsx:20-28,74-93,170-176`; `components/settings/AccountSection.tsx:38-44,91-115`. Live capture 13.
- A04: `components/vcr/VcrScenarioEditor.tsx:76-77`, `vcrMethodFieldText.ts:33-36`; capture 08.
- A02: captures 13 and 35. The audited account had operator access; ordinary-account exposure is not asserted.
- A03: `components/vcr/VcrMethodCatalogue.tsx:6-17`; `app/routes/CapabilitiesPage.tsx:155-159,185-205,223-249`; `app/extensions/ExtensionsPage.tsx:124-133`; captures 05/06/08.
- B01/B02: `components/inspector/GenomeView.tsx:165,174,214`, `MoleculeView.tsx:130,157,167`, `FitsView.tsx:132,150,170`, `AnomalyMapView.tsx:111,125,167`. Call chain: FilePreviewInspector to RunFilePage and SourceOriginal.
- B03: `components/inspector/GenomeView.tsx:47-72,165,188`; B04: `components/ui/ScrollRegion.tsx:38,54-56,69,77-82`; B05: `lib/focusTrap.ts:6-13,24-41`.
- M01: `components/geo/geoTabs.ts:31-40,96-117`, `app/routes/GeoProjectPage.tsx:363-404`; captures 13/14.
- M03/M04/M05/M06/M07/M08/M09: captures 24 / 04 / 39-40 / 44 / 48 / 44+46 / 27 respectively.

## Module ledger

| Surface | Observed evidence | Verdict / remaining coverage |
|---|---|---|
| Global shell / mobile navigation | Desktop routes, mobile menu and destination change | Retain restrained hierarchy; repair identity compression and menu closure. Intermediate widths and actual touch remain. |
| General conversation / native frame | Stable empty home, native composer and plus menu | General-first examples are good. Diagnostic naming needs repair. Streaming, reconnect, populated outputs and all native dark states untested. |
| Research tools | Initial catalogue, family expansion and method form | Useful task guidance exists; action grammar and visible numeric scale need work. Successful numerical execution untested. |
| VCR | Empty study index and new-study view, source inspection | October 25 conversational reset is pending implementation. Old method/recruitment surfaces are known migration work, not an invented new defect. Populated scientific journeys untested. |
| GEO | Project entry/overview, view selector, empty sources and phone layout | Unknown-versus-zero, attention semantics and narrow hierarchy need work. Actual probes/content/publication were not submitted. |
| Frontier | Feed, filters, article reader and phone reader | Good editorial rows and source context. Reduce repeated central facts; retain source type and distinguish importance from evidence strength. Other source types, events and zones untested. |
| Knowledge | Empty source index, add menu/link dialog and wiki; graph initially loading | Entry points are visible. No positive-data reader/graph/import journey accepted. |
| Memory / capsule | Overview and populated sparse map | Improve record legibility and sparse layout. Live map controls exist: the source-only missing-controls hypothesis is withdrawn. Capsule export/import untested. |
| Scheduled tasks | Empty page and new-task dialog | Project, timezone and enablement wording are useful. This review does not repeat or certify earlier timed-execution acceptance. |
| Extensions | Skills, plugins and plugin detail | Improve raw skill titles. Verify selected/configured/active scope through real runtime use later. |
| Account / appearance / usage / connectors | Stable settings views and source error branches | Coherent sections; avoid unknown-as-zero and toast-only read failure. No security, billing or connector mutations performed. |
| Inbox / operations | Populated inbox and settled resource view | Group repeated incidents; preserve operator role boundary. Initial transient loading was not counted as a permanent zero-data defect. |
| File / scientific viewers | Reachability, source and isolated component probes | Five technical defects above; full rendered files, Office/code/data viewers and assistive technology still require acceptance. |

## Design judgment and strengths

The product looks like an operating research/work platform rather than a generic marketing dashboard. Its lists, restrained surfaces, native composer, shared typography, source access and scheduled-task context should survive the brand migration. The weaker moments ask a person to infer state or translate implementation concepts: zero versus not measured, filter versus launch, diagnostic command versus useful action, process step versus result category.

A's provisional Nielsen score is **23/36 over nine scored heuristics**; error recovery is unobserved, not zero and not passed. Huashu's qualitative observed-surface profile is **6.3/10**. B's source/contract health profile is **14/20**. These are prioritization aids with different scopes, not user-study scores, compliance certificates or comparable trend measurements.

For a new general-work user, the initial invitation is clear but the diagnostic menu weakens it. For a researcher, absent units and scope increase interpretation cost. For a keyboard user, the scientific viewer gap prevents equivalent use. For a mobile returning user, menu persistence and truncated project identity create avoidable navigation friction. No abandonment, error-rate or task-time metric was measured.

## Known migration and specification conflicts

1. Warm branding is an authorized direction change, not a defect in an otherwise correctly generated former blue theme. It is implemented locally in this task.
2. The October 25 VCR reset supersedes the October 20 method-discovery rule for ordinary-user VCR entry. Keep validated numerical tools and scientific objects; move task initiation into the native conversation and remove recruitment operations, while retaining scientific patient/trial matching.
3. Old blanket bans on help text, multiple related workbench shapes or zero-count destinations conflict with useful task guidance and newer owner decisions. v3 makes those distinctions explicit. Existing layout budgets remain; tests and exceptions must evolve deliberately, not be weakened to pass.
4. A live memory toolbar exists despite its absence from the inspected local branch's map composition. The live numeric form also differs from local unit-aware rendering. Resolve serving/source identity before treating a local edit as a production fix.

## Local work completed

- Token package **2.3.0**: warm neutral ramps; light accent `#a34427`, dark accent `#d98c6b`; independent light `brand-ink` `#24211e` and dark paper ink. Danger remains a distinct crimson, with semantic/chart roles retained.
- Generated CSS/Tailwind, Element Plus, ECharts, kernel, Figma and DTCG consumers, including artifact digests. Source-level changes do not prove adoption by an external Vue app.
- Shared molecule geometry across host/native mark, favicon and installation artwork, with actual PNG rasterization and PWA metadata updates.
- Native theme-disabled logo fallback fixed following code review. A regression exercised actual `off: ['theme']` composition, failed before the fix and passed after. Independent review closed the finding.
- Full specification v3, engineering companion and the narrowly scoped owner-direction rules updated. Existing unrelated working-tree changes retained.
- Static light/dark color and logo comparison rendered in Chrome. It is a demonstration using actual token bytes, not a replacement native-composer screenshot.

### Validation record

| Check | Result |
|---|---|
| Brand contrast | 216 role + 13 data checks. Applicable text minimum 4.5561:1; necessary graphics minimum 3.3212:1; chart minimum 3.0822:1. Decorative checks use a separate floor. |
| Token contracts | 30 pass; one optional DTCG schema check skipped because schemas are unavailable |
| Focused brand web checks | 39 pass across five files |
| Native frame/shell checks | 41 pass after theme-disabled fallback fix |
| Generated artifacts / types / lint / build | Current; scoped type/lint and web production build passed. Full web lint retains 15 pre-existing warnings. |
| Code reviews | Generic and TypeScript reviews completed; the sole medium fallback finding repaired and independently rechecked |

Do not sum these into a unique test count: review and worker checks overlap. None closes the five technical audit defects or all live-route acceptance.

## Remediation sequence

| Order | Work | Proof required |
|---|---|---|
| 1 | Unknown/failed metric states and scientific units | Source identity, counterexamples for real zero, failed first read and live unit interpretation |
| 2 | Five shared/scientific technical defects | Focus/resize/theme regressions plus real keyboard and rendered viewer acceptance |
| 3 | Mobile navigation and GEO workflow discovery | Select destination, see/focus destination, discover all steps at narrow/intermediate widths |
| 4 | VCR task-entry migration | AI-native task journeys under October 25 scope, with scientific history and access boundaries intact |
| 5 | Catalogue labels, attention grouping, reader hierarchy and sparse maps | Representative content and state transitions, not only empty screens |
| 6 | Release adoption of warm brand | Host/native light-dark paths, generated icons, installed cache behavior, external consumer identity and deployment receipt |

v3 contains **30 named acceptance cases**, AT01-AT30, covering these classes. The remaining release proof includes populated VCR/knowledge/output paths, failure/retry, keyboard and screen readers, touch interruption, 320px reflow, zoom, all dark routes, native iframe behavior and selected real user tasks. No all-platform pass is claimed.

## Current primary references

The October 26 web refresh confirmed [Carbon's data-table structure and behaviors](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines), [Atlassian foundations and token authority](https://atlassian.design/foundations), and [Fluent's AI expectations, attribution and user control](https://fluent2.microsoft.design/responsible-AI). These inform the structure of the specification; EviMed's workflow decisions come from owner intent and observed product needs.

Accessibility references are [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [APG modal interaction](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and the [target-size criterion and exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). A 28/36px control is not automatically an AA violation merely because it is smaller than the preferred 44px touch target. [DTCG 2025.10](https://www.designtokens.org/tr/2025.10/format/) is a stable community interchange format, not a W3C Recommendation. [Web Vitals](https://web.dev/articles/vitals) informs performance goals, not a performance result measured here.

## Run notes and closure

Target: the local `OpenScience/apps/web/src` tree plus representative authenticated EviMed pages. The Impeccable engine could not produce a slug or canonical stored critique; this requested repository report and private artifacts are the explicit archive. No ignore-list rule was applied to suppress a finding. Assessment independence was preserved; parent-controlled native browsing replaced unavailable isolated browser control. There was no detector overlay or detector live server. Temporary responsive overrides were restored; the separate static preview server is stopped before final handoff, with the self-contained HTML retained.

Questions skipped: the user already selected the brand direction and explicitly asked to complete the audit, updated specification and local brand work. Unobserved acceptance states are recorded rather than converted into unnecessary preference questions.
