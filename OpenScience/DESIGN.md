# EviMed design system

Engineering companion to [Frontend Design System v3.1](docs/FRONTEND_DESIGN_SYSTEM.md), revised 2026-10-26 after owner review. The full specification owns principles/acceptance; this file maps implementation and the component-contract adoption. Component JSDoc plus executable fixtures own each implemented component's details. The token package is the numerical authority. Module plans own evolving product scope; old audits remain dated evidence.

## Product and brand

EviMed Science is a general-purpose agent platform with a medical professional layer. General work stays general; the medical method and labels enhance relevant work. Preserve one native composer, project identity, existing permissions and usable results.

The owner's October 26 direction supersedes the previous blue palette: **warm paper, restrained terracotta, and an ink EviMed mark**. The local implementation uses near-black in light mode and light ink in dark mode. The independent `brand-ink` role prevents an action-accent change from recoloring the logo. The reviewed decision fixes near-black for identity and adopts deep navy for information semantics, not another general action accent.

This palette is implemented locally, not deployed. External Vue consumers must adopt the new package/artifacts; installed icons and cached native resources require release verification. No ordinary task becomes subject to a clinical delivery gate because of this design update.

## Token authority and generated consumers

Local implementation: **token package 3.0.0**, specification **3.1** (2026-10-26). Generated consumers and release digests are coordinated in this worktree. The preceding 2.2.0 main read and 2.3.0 warm-brand candidate are historical baselines, not the current source identity. Publication, remote branch identity, main adoption and deployment require their own receipts. Edit `packages/design-tokens/src/index.mjs`, then regenerate CSS, Tailwind, Element Plus/ECharts/kernel themes, Figma and DTCG exports together; `src/release.json` binds digests to this version.

`scripts/build/brand-assets.mjs` derives SVG identity, PWA metadata and the serialized native mark identity from the token roles and the shared EviMedMark path. `scripts/build/rasterize-brand-icons.mjs` creates installation PNGs from those SVGs. Preserve deterministic sources and record actual rendering; a stale PNG is not fixed by updating its source alone.

The native shell and theme can be disabled independently. Its identity must remain legible when the optional EviMed theme body is off, using the native primary-text color as a fallback. Do not relax browser isolation to synchronize appearance.

## Colour

Readback of the local 3.0.0 implementation; do not edit this table as a second source. DS02.3 roles are implemented: green verification, text-role titles, navy information/run dots, ink field focus, accent button focus and neutral popularity badges.

| Role | Light | Dark |
|---|---|---|
| `bg` | `#f7f5ef` | `#171512` |
| `surface` | `#fffdf8` | `#211e1a` |
| `surface-1` | `#f2efe7` | `#211e1a` |
| `surface-2` | `#ebe7de` | `#2a2621` |
| `surface-3` | `#e3ded3` | `#342f29` |
| `text` | `#24211e` | `#f2eee6` |
| `text-2` | `#494239` | `#d1c8ba` |
| `text-3` | `#686157` | `#a99e8f` |
| `title-ink` | `#24211e` | `#f2eee6` |
| `brand-ink` | `#24211e` | `#f7f5ef` |
| `accent` | `#a34427` | `#d98c6b` |
| `accent-soft` | `#fbefe8` | `#321c16` |
| `accent-pressed` | `#8d3922` | `#e3a385` |
| `accent-fg` | `#ffffff` | `#171512` |
| `link` | `#a34427` | `#d98c6b` |
| `border-control` | `#8c8173` | `#81766a` |
| `border-hairline` | `#e3ded3` | `#342f29` |
| `warn` | `#925100` | `#e0b169` |
| `error` | `#ad2f45` | `#e58b9c` |
| `ok` | `#1a6f44` | `#7cc0a0` |
| `info` | `#18324d` | `#9bbbd5` |

Use warm neutrals for structure; terracotta for an action, link, selected state or focus. Preserve separate crimson danger, amber attention and success semantics. Every status has language/icon information beyond color. Do not tint every title, badge or card. AI importance is not evidence certainty; unmeasured safety is not zero risk.

`border-control` identifies controls, while quiet borders are decorative. Do not demand 3:1 from every decorative separator or exempt necessary scientific-viewer labels. Contrast is computed, not estimated. The October 26 local brand validation recorded 216 role and 13 data checks; that is not a claim that every rendered page or fixed scientific canvas passes.

Keep the scientific categorical/diverging scales and the declared own-series/rival comparison mapping. `CHART_OWN` and `CHART_COLORS.own` identify our comparison series; `CHART_SERIES` is a different scientific categorical contract. `chartPalette.test.ts` computes CIE76 comparisons against every rival (>=15 per theme). Retain the closed `STUDY_TYPE_BADGES` study-type colors with labels as an explicit data exception. Topic colors do not become clinical grades. Paper/figure previews and print output retain meaningful light canvases even when surrounding chrome is dark.

## Type

One shared sans stack for chrome, explicit Chinese fallback and punctuation. Serif belongs only to wordmark, home headline and document title. Code and compared identifiers may use mono. Chinese weights are 400/600. Do not apply poster headline ratios or whitespace quotas to operating screens.

| Token | Size px | Line height | Family |
|---|---:|---|---|
| `badge` | 12 | 1 | sans |
| `meta` | 12 | 1.5 | sans |
| `caption` | 12 | 20px | sans |
| `compact` | 13 | 20px | sans |
| `ui` | 14 | 22px | sans |
| `body` | 16 | 1.75 | sans |
| `reading` | 16 | 1.8 | sans |
| `reading-lg` | 18 | 1.8 | sans |
| `reading-xl` | 20 | 1.8 | sans |
| `wordmark` | 16 | 1.3 | serif |
| `section` | 18 | 26px | sans |
| `heading` | 20 | 28px | sans |
| `title` | 24 | 32px | sans |
| `doc-title` | 24 | 34px | serif |
| `display` | 24 | 1.3 | sans |
| `metric` | 32 | 40px | sans |
| `metric-lg` | 40 | 48px | sans |
| `hero` | 40 | 50px | serif |

The closed size scale is 12/13/14/16/18/20/24/32/40, emitted in rem. Keep existing template type budgets (normally four pairs, five for applicable data templates) while preserving essential labels, units and guidance. Reading titles must remain discoverable in full; a list's truncation rule is not automatically a reader-title rule.

## Space and geometry

Spacing uses 4/8/12/16/20/24/32/40/48/64px. Gutters are 16px below 768px and 24px above. Read/page/wide maxima are 720/1040/1200px, with the existing 1280px large-screen expansion. Paragraph measures are 560/640px. A saved user panel width is legitimate and is clamped to the current viewport.

Radii: tag 6, control/row 8, card 12, panel/dialog 16, composer 24px. Heights: small 28, default 36, primary 44, tag 22px. Icons: 16/20px and one consistent stroke. Hit area is independent of drawn size. Validate actual 24px AA targets or their applicable exceptions; prefer larger touch targets without mislabeling 44px as a universal AA minimum.

Use named z tiers, opacity and elevation from the token table. Static cards need no shadow. Motion roles remain fast 120ms, base 200ms, slow 320ms, with the generated easing/reduced-motion rules. Preserve feedback and hierarchy while removing nonessential movement. Do not animate real progress from a timer.

## Page structure

Compose using PageShell slots: scope, steps, activity, tabs, toolbar and headline, in supported document order. Use shared Toolbar, StepRail, StepState, ActivityStrip, Note, Section, FactList, ChartGrid, Outline, MasterDetail, ScopeMenu and StateScreen. Keep controls before the content they affect, with meaningful sticky behavior and viewport-aware overflow.

| Template | Purpose | Detail behavior |
|---|---|---|
| List | Files, skills, feed, inbox and project indexes | Short record alongside or in drawer; document on addressed reader |
| Master detail | Select a record and inspect it | Maintain selection/list context; stack on narrow screens |
| Workflow | GEO/study context and progress | One conversation, reachable steps and explicit result destinations |
| Data map | Memory/knowledge relationships | Real graph, readable selected record and linked list |
| Reader | Article, evidence, report, source | Full identity, source access, contents, return position |
| Settings | Preferences/account/permissions within their boundaries | Stable section navigation, explicit persistence and errors |
| Connected workbench | Task-related inputs, configuration, progress and outputs | Main-area working context; short ancillary edits only in drawers |

### Rules that supersede blanket older wording

- One page serves a coherent task, not necessarily one data shape. Connected configuration and result workbenches are expressly allowed. Do not stack unrelated metadata.
- Helpful purpose, required inputs, units, prerequisites, limitations and recovery instructions are allowed. Internal implementation narration belongs in diagnostics. Grey-text counters cannot decide language quality.
- Keep one dominant action per local action group and at most one main header action. A contextual action in a workbench is not forbidden simply because it is below the header.
- Keep one coherent view-navigation/control band. Workflow progress and result navigation have different meanings; compacting them must not hide the process or require an unexplained second vocabulary.
- A static Tag does not perform an action. Filters, tabs, links and buttons retain distinct semantics even when their appearance is restrained.
- Informative empty destinations and zero-count filters are allowed when they preserve context or explain prerequisites. Never erase the selected filter merely because a refreshed count is zero.
- A row's label predicts whether it filters, configures, opens a conversation or navigates. Clicking must produce visible progress/result at the point of work.
- Mobile navigation closes after selection and identifies the destination. Long project names remain distinguishable without hover.

Existing lint/layout budgets are retained. Updating their semantic policy requires focused tests and observed evidence; do not weaken them or delete useful instructions just to obtain a green check. The 60-view walk inventory is an intended coverage map, not proof every view was exercised.

## Components and states

Use shared UI primitives; EmptyState, LoadError and Skeletons retain their cards-directory locations. Adopt the contract template and migration matrices below. Busy controls preserve focus, label and width; `aria-disabled` requires an actual activation guard, while native `disabled` remains appropriate for unavailable prerequisites. Disabled actions explain the actual prerequisite. Short view-only records may use drawers; long configuration and documents use the main area. One native composer remains authoritative.

Initial loading, first-use empty, filtered empty, failed first read, failed refresh, stale, partial and canceled are distinct. Unknown resources are not 0 B or stopped; unmeasured evidence is not a clean zero. Keep useful previous data with its time and a persistent retry beside the affected section. Automatic recovery does not inflate an action-required count.

Modal focus must include actual Tab stops only, considering negative tabindex, hidden/inert ancestors, hidden inputs, radio groups and native disabled semantics including the first-legend exception. Do not implement a simplistic disabled-fieldset ancestor filter. Enter respects focused controls. Escape handles the top layer and returns focus safely. Menus scroll within available viewport height. Theme-dependent overflow fades use live semantic surfaces rather than permanently cached RGB.

### Component contract template

The following nine fields, in this order, become the header contract when a component is implemented or next changed. Apply at public-export level where a module has multiple components. Write actual behavior; a pending requirement links to the adoption item instead of describing a nonexistent prop as present. The implementation inventory contains 53 non-test TSX modules in `components/ui/`, with multiple public exports; the contract inventory covers 72 public components.

```text
/**
 * Component: <export>; owner: H/K/B; rules: <DS/AT identifiers>.
 * Anatomy: <semantic parts and data/action boundaries>.
 * Variants: <closed public variants and when to use each>.
 * States: <applicable states, source of truth, transitions, retained data>.
 * Hit area: <drawn geometry, actual target, coarse-pointer behavior>.
 * Keyboard: <focus entry/exit, activation, traversal, Escape/IME behavior>.
 * Long content: <wrap/truncation, selection/copy, large datasets/menus>.
 * Theme: <semantic roles, forced colors, reduced motion if applicable>.
 * Responsive: <narrow/intermediate/wide layout and overflow ownership>.
 * Verification: <existing test names, gallery case, composition/walk case,
 *                and manual evidence or explicit pending gaps>.
 */
```

`/__gallery` shows the public variants/states in both themes; composition fixtures show realistic combinations and failure transitions. Fixture assertions cover behavior while images cover appearance. Update JSDoc, props, behavioral tests and fixtures together; the component-contract inventory verifies field presence but cannot prove their truth. Do not add another separately maintained component handbook.

### Existing component adoption contracts

The table records implemented behavior and required acceptance. Implemented public contracts now live beside the exports (53 UI modules, 72 public components). The implementation ledger below records proof and remaining gates; this table is not a declaration that all browser/manual scenarios passed. Owner H unless separately assigned K.

| Component / helper | Observed baseline and adopted change | Required acceptance |
|---|---|---|
| Button / buttonClasses | Implemented loading-only behavior uses guarded aria-disabled/busy, retain focus/name, reserve a spinner slot or preserve measured width; retain disabled for genuine prerequisites. CSS must cover aria-disabled and events must suppress mouse/keyboard/form activation. Focus loss is a browser risk to verify, not universal proof from the attribute. | T double click/Enter/form submit; G all sizes/long labels; W actual focus and width. AT35 |
| Switch | Implemented controlled pending and AsyncSwitch producer adapter support a single optimistic transition; keep requested position while pending, inline confirmed-failure rollback, and unknown-outcome reconciliation. An invariant label names the setting. Delayed activation uses an action button/status. | T out-of-order response, rejection, timeout, scope change; G pending/error; W persistence. AT36 |
| Input / Select / Textarea | FieldShell unifies Input/Select/Textarea label/hint/error IDs and slots. Distinguish decorative prefix/suffix/unit from a trailing actionable control and preserve text space/accessible description. | T descriptions/error precedence/IDs; G prefix/suffix/error/narrow; M AT. AT37 |
| NumberField (new) | Central quantity adapter; see below. Keep raw text separate from interpreted value. Do not replace it with a bare native number input that silently guesses scale. | T parsing/conversion/round-trip/domain mapping; G; W form/result. AT08/37 |
| FormDialog | Implemented bounded scroll body, footer and persistent linked error summary share useUnsavedGuard for close/backdrop/Escape/route. Busy must not blanket trap Tab on the panel and make retained help/errors unreachable. | T guard routes/save outcomes; G long body/summary/footer; W/M focus. AT13/38 |
| Drawer | Existing layer handling/focus and the shared dirty guard are retained; keep view-only drawers light and immediately closable. | T common guard and nested layer; W return focus/blocked navigation. AT38/43 |
| ConfirmDialog | Structured subject/count/consequences/recovery fields are implemented (optional extra readable content); safe initial focus, no global Enter destruction. Reversible operations use actual undo/history instead of an extra confirmation. | T irreversible/partial recovery semantics; G objects/counts; W actual restore path. AT39 |
| focusTrap | Implemented tabbability handling covers native disabled/legend/radio, hidden/inert, visibility and zero-stop cases, without violating nested-layer ownership. checkVisibility options/fallback need actual browser coverage. | T all excluded/included cases; W/M keyboard in Chromium/WebKit/Firefox. AT13 |
| Toaster / toast store / announce | Implemented pre-mounted host announcers, event-scoped short-window deduplication, tones and optional Undo. Actual screen-reader reliability remains a manual gate. Keep existing hover/focus timer pause. Persistent failures stay inline. | T queue/identity/dedup/priority; G long content; M real AT first/repeated announcements. AT40/41 |
| Tabs | Implemented auto/manual activation; manual arrows/Home/End move focus only, Enter/Space activate; retain correct tab/panel identity and overflow. | T focus versus selected state, async loading and item removal; G/W. AT42 |
| StatTile / StatBand | Implemented typed measurement boundary below; keep shared denominator visible/accessible at band level and retain precise drill-down scope. | T type negatives plus source adapter unknown/zero/stale/error cases; G/W real metric states. AT07/37 |
| DataTable / LoadError | Existing inline failure styling is duplicated and LoadError uses the retained ghost alias. Route persistent feedback through InlineAlert and migrate ghost to secondary when touching the call site; preserve partial rows, sorting and retry. | T retained rows/retry, partial errors; G table overflow; W. AT40/48 |
| ListRow | Stretched hit area is a conscious selection/copy tradeoff. Retain a semantic primary control, make the meta/identifier region selectable without opening the row, and keep real nested controls independent. Essential full identity/copy remains available. | T primary/secondary events; W/M text selection on mouse/touch; G long names. AT19/44 |
| SearchInput / submit hook | SearchInput owns clear/Escape today; Enter guards are scattered. Centralize host composition-safe submit while preserving caller callbacks, native form semantics and cancellation. A scoped lint rule follows adoption, not a blanket prohibition on Enter. | L scoped rule/exception tests; T IME sequence; W/M real IMEs. AT46 |
| ScrollRegion / scientific views | Retain the audit's unclosed fade, initial-size, fixed-label contrast and keyboard findings. New helper contracts do not close those bugs without actual caller migration. | T regression probes; G/W/M actual files and themes. AT05/14/15/16/17 |

### Quantity and measurement boundaries

**NumberField** requires a declared quantity/unit, explicit scale (`scalar`, `percent` or `fraction` as appropriate), canonical representation, min/max in that representation, precision/rounding policy and an example when ambiguous. A field may be unitless, but it says so. Input values like empty text, a lone minus, malformed grouping, NaN, Infinity and out-of-range values do not become zero or silently clamp. Preserve invalid draft text with explanation. Parse on blur and submit; conversion occurs exactly once. Do not round scientific values merely because the display rounds.

Create the shared quantity parser/formatter under `lib/format.ts` (or a quantity module re-exported through it). Input preview, confirmation, saved configuration and displayed results use that contract, while the domain API keeps its declared units. An entered `20` in percent mode corresponds to `0.20` only when that is the declared canonical fraction; saved `0.20` must not be converted twice on reopening. Tests include negatives, scientific notation where allowed, locale separators, 0, 100%, missing data and historical versions.

**StatTile** adopts a discriminated reading: Measured has a finite value, unit, scope and observation time/coverage; Unmeasured has a reason and no numeric value; Failed has an error/retry contract and optional previous Measured reading. Initial loading is an explicit read lifecycle, not a fake Unmeasured result. Type negatives prevent a numeric value on the Unmeasured branch. They cannot prove a caller did not lie by constructing Measured(0): adapter tests must preserve backend missingness, measurement existence, sample counts, denominator and time. Compile-time typing alone does not close audit A01. Preserve real zero and useful stale values; failed refresh must not erase an earlier measurement.

### Missing primitive contracts and introduction order

The named reusable modules below are absent in the inspected local tree. Native HTML or page-specific instances may exist; absence of a named primitive is not proof the product has no such capability. Introduce a primitive with its first real caller and fixture; avoid an unused component catalogue. All are owner H; native counterparts remain K.

| Primitive | Adopted contract | How to verify |
|---|---|---|
| InlineAlert | Semantic tone, title/body, scoped persistent recovery action, dismissal policy and announcement identity; shared by LoadError/DataTable/field-adjacent mutations | T persistent failure/retry/dedup; G all tones; AT40/41 |
| Freshness | Last successful time, current refresh state and retry in toolbar summary/headline; unknown time stays unknown | T failed refresh retains value/time; G narrow summary; AT40/45 |
| announce() | Pre-mounted polite host queue and limited assertive channel; event/entity identity, count and priority; no duplicate visible+spoken event | T queue/window/multiple tasks; M AT; AT41 |
| NumberField | Explicit quantity/scale, raw draft versus parsed value, shared formatting and domain units | T boundary and round-trip; W meaningful form; AT37 |
| Combobox | First larger missing primitive: controlled query versus selected ID, optional domain threshold and default 250ms search debounce, abort/stale-response guard, loading/empty/error, keyboard selection and clear; no free-text-as-ID unless that domain allows creation | T out-of-order/IME/abort/duplicate labels; G short/long list; W/M ARIA pattern; AT49 |
| Checkbox / Radio | Labeled native controls in fieldsets; checkbox mixed state and radio-group arrow behavior, errors/help and large hit area; unselected consent by default where consent exists | T mixed/disabled/group names; G/M keyboard and hit area; AT48/49 |
| DateField / DateRange | Prefer native calendar-date controls; distinguish date-only from instant/timezone, inclusive/exclusive endpoints, open range and invalid order; custom picker only for a supported unmet need | T leap day/timezone/range boundaries; W/M keyboard; AT45/49 |
| FileDrop | Clickable file picker plus drop, same validation and per-file status; real byte transfer progress only when measured; transferred, parsing, searchable and failed distinct; cancel/retry only where backed by the API | T partial failure/abort/duplicate policy; G long filenames; W real safe fixture upload; AT23/49 |
| Batch selection | Optional feature of eligible tables/lists using shared Checkbox and selection state, not a second catalogue; follows DS21.10 | T stable IDs/page-query scope/mixed results; W keyboard/touch; AT48 |

InlineAlert, announce, Freshness, Combobox, DateField/DateRange and FileDrop are implemented with actual callers in this branch. Publication and production adoption remain separate. `PendingFeedback` provides the shared host read lifecycle: no skeleton before 300ms, real elapsed time at 10s, and an explicit non-durable limitation at 60s. It announces only the two milestones through the shared channel. Passive gallery specimens and inactive hidden readers use an explicit boundary; native feedback and durable producer controls retain their own ownership.

### Coverage of the existing UI module inventory

Each public export uses the same nine-field header; the table supplies the first applicable proof. Existing colocated tests/gallery fixtures may be extended; absent manual cases stay explicitly bounded in the execution ledger.

| Modules | Primary behavior to document | How to verify |
|---|---|---|
| ActivityStrip, ProgressRail, StepRail, StepState | Producer-owned progress, waiting versus action, process navigation | T stage mappings; G all states; W narrow workflow |
| Button, IconButton, Switch | Action/pending/disabled/focus/hit area | T activation; G variants; W/M keyboard/touch |
| Input, SearchInput | Field shell, errors/hints/units/IME | T IDs/input sequences; G; W/M |
| ConfirmDialog, FormDialog, Drawer | Layers, dirty work, structured consequence, focus lifecycle | T nested/dirty cases; G long form; W/M |
| Card, Panel, Section, Headline | Semantic grouping, title rank, content density | T outline/composition; G templates; W narrow widths |
| ChartCard, ChartGrid, Delta, StatTile | Real data/unknown/scale/provenance, accessible chart text | T data adapters and values; G themes; W/M reading |
| DataTable, ListRow, MasterDetail | Sorting/selection/copy/detail/overflow/identity | T result/selection contracts; G dense and empty; W/M |
| Disclosure, ShowMore, Outline | Expansion, current location and return/focus | T expanded/content relation; G long content; W/M |
| FilterChips, ScopeMenu, Toolbar | Query versus scope, reset, IME, selection persistence | T scope/reset/overlay lifecycle; G; W |
| Tabs, SegmentedControl | Focus versus selected view, activation mode, overflow | T auto/manual and disabled cases; G; W/M |
| Menu, LazyMenu, Tooltip | Available viewport, delayed content, pointer/keyboard/focus ownership | T placement/async/layers; G 30/100 items; W/M |
| Tag, SeverityBadge, Score, Note, FactList | Static semantics, safety versus importance, labeled facts | T no disguised action/valid state; G all meanings; W/M |
| ScrollRegion, StateScreen | Reachable overflow, live theme and truthful load/empty/error | T cache/resize/state; G; W/M |
| PendingFeedback, PendingFeedbackBoundary | Delayed initial reads, monotonic elapsed time, milestone-only announcements, passive/hidden contexts | T 300ms/10s/60s, fast completion, reset and actual Gallery; W slow reads |
| Toaster, ShortcutHelp | Announcement priority, timer/Undo, context-safe discoverable keys | T queue/shortcut guard; G; M AT |

The implemented inventory covers 53 non-test UI modules and 72 public component contracts. PageShell and card-state components outside this directory participate through composition fixtures. Header coverage does not establish that every manual or rendered scenario passed.

## Conversation evidence and modules

- Home/logo/new conversation opens the general assistant without inherited specialist context. Native progress, cancellation and LoopX goal controls keep their actual semantics. Normal menus use task language, not diagnostic command names.
- Ordinary text/files can be delivered directly. Medical checks and claim labels enhance relevant work; do not revive whole-package withholding. Verification states name scope/version and never imply clinical certainty from a generic accepted state.
- Frontier uses an editorial list, coherent summaries and distinct reader blocks. Keep original-source access predictable. Publication/discovery dates and AI importance/evidence quality stay distinguishable. The whole feed card opens its addressed reader; original-source access is separate, and long article text is not hidden behind retired reveal actions.
- Knowledge distinguishes source/readiness/compiled page/graph/output. Reading preserves source location and jump-back. Fixed scientific canvases still need readable UI text and keyboard equivalents.
- Memory uses the current native OpenViking engine and combines honest sparse visualizations with readable records and real source/scope; there is no retired records-engine fallback. One person has one capsule, and project is an entry label. Do not create visual links without evidence or mistake a membership star for semantic relationships.
- GEO, VCR, schedules, extensions and settings/inbox product decisions are linked by the full specification DS15-DS17 and the adoption plan's module register. Do not duplicate their changing task scope here.

## Accessibility and verification

Target WCAG 2.2 A/AA across applicable complete processes. Token validation does not cover all fixed canvases or overlays. Test keyboard-only, VoiceOver/Safari, NVDA/Chromium, physical or synthesized touch and canceled gestures, 320px reflow, 390px phone, tablet/desktop, 200% text resizing, forced colors and both themes. Emulation is labeled as emulation.

Use current native shortcuts; don't invent a second host meaning. DS21 defines the context-limited viewer map, feedback channels, mutation states, latency budgets, navigation lifecycle, display identity, format authority and bulk selection. Kernel composer Enter/IME/stream scrolling are K-owned acceptance targets; host equivalents are H-owned. Ordinary toasts are polite and do not steal focus. Streaming does not announce every token. Preserve safe areas and visible focus under sticky/footer regions. Public reports, screenshots and logs must not expose secrets or unrelated user data.

## Local checks and release evidence

Run token build/check and release recording when generated bytes change; run the focused token/web/native brand tests, lint/type checks and build. For a component's look, inspect both theme renderings and gallery diffs under the documented CI font/browser environment. Do not blindly rebaseline pictures.

Production release additionally verifies deployed source/image, host/native theme propagation, PWA cache behavior and selected real user journeys. The external Vue repository adopts its package pin separately. Performance targets use field methodology; local tests are labeled local. No telemetry prohibited by the platform is enabled for measurement.

## Known open audit items

The dated October 26 audit identified pointer-only scientific-reader operations, canvas contrast hints, initial Genome width observation failure, stale ScrollRegion fades and incomplete focus eligibility. The local v3.1 implementation repairs these classes with keyboard/readout, resize, theme and focus fixtures. Preserve the original findings as historical evidence; final browser retest, full dark routes, real assistive technology and serving-revision adoption remain distinct gates.

Historical baseline counts are not new defects. Primitive gallery rows do not cover every scientific viewer, content length, page template or native frame. The official DTCG JSON Schema check is optional and was skipped locally because the external schema files were absent; structural checks passed.

See [the full specification](docs/FRONTEND_DESIGN_SYSTEM.md) for module-authority links, fifty acceptance cases, ownership/proof coverage, primary sources and evidence boundaries. The dated adoption plan owns implementation sequencing.


## Implementation proof and semantic exceptions

Last updated: 2026-10-26. The [execution ledger](../docs/superpowers/plans/2026-10-26-design-system-v3-execution.md) maps all 21 DS groups and 50 AT scenarios to proof families and unresolved boundaries. Numerical validation is local: the R 4.3.3 suite passed 222/222 across 34 methods with all 158 exact dependency locks. This does not establish production scientific acceptance. Final integrated web/server/browser results and branch push are recorded by the coordinator after completion.

The layout detector retains raw metrics and default budgets. Three evidence-backed exceptions are exact semantic predicates, with negative-case tests: inbox selection controls belong to a named selection toolbar and scope band; the ordinary control budget remains eight. VCR's eight type pairs apply only to its exact running information palette. GeoAnswer's six pairs apply only to the existing five UI pairs plus original 16px prose, with no misplaced controls. Removing the predicate restores the default budget; these exceptions do not license arbitrary typography or unrelated stacking.

The supported public native locale groups advanced commands under `command.section.commands` (高级命令与诊断). `loopx-init` remains its real command identifier. Theme-body focus lifecycle and identity with the optional theme off use supported seams; there is no private upstream command patch. Actual composer Enter, simulated composition events, reload without resubmission, stream selection/upward reading and theme on/off have local native-fixture evidence. Real hardware IME, screen readers, physical touch, LoopX execution absent from this fixture, external Vue adoption and installed production caches remain explicit boundaries.

## VCR conversation/result variant (2026-10-25/26)

Last updated: 2026-10-26. This replaces the VCR seven-step, method-catalogue and manual-configuration portions of the older templates and workflow rulings. GEO keeps its eight-step workflow. See the [approved product reset](../docs/superpowers/specs/2026-10-25-vcr-ai-native-product-reset.md) and [review](../docs/superpowers/specs/2026-10-25-vcr-ai-native-reset-review.md).

- The home presents four aligned task rows: matching, populations and virtual patients, comparators, trial-design simulation. A row fills an unsent draft in the existing native composer; it does not create a study, select a specialist or run a job. Each row visibly separates the task/action, expected result and minimum input requirement. Data labels are outside buttons, not hidden behind hover or mixed into button text. Existing research is resumable; calculation history is a quiet disclosure.
- One native conversation performs the work and its revisions. The six saved-result destinations are overview, matching, population/patients, comparator, trial and evidence/data. Group/individual scale is explicit within population; existing patient URLs remain compatible. No mandatory seven-step rail, manual PICO form or replacement composer. The full programme is available only on explicit intent. Preserve native file/browser/right-pane controls and actual run history.
- Results, source-linked assumptions, charts/tables and useful next actions share the main area. Adjust/compare sends the exact displayed object/version and result reference to the existing composer; a newer object never silently replaces the selected one. Historical configuration and numerical results are independently readable, with independent error/retry states and no new calculation action.
- Input labels distinguish one original patient case, a real patient dataset, longitudinal outcomes, an executable model, and work that can start from published parameters/assumptions. Show current availability separately; connected inputs satisfy the requirement. Empty/error/unavailable states retain matching-direction and individual/forecast controls so an unavailable subview does not hide another usable path. Native longitudinal intake remains reachable.
- A cohort view describes membership/distribution; an individual view describes a record and its complete supported observations or trajectory. Do not call every generated member a digital twin. Comparator views name the evidence route and preserve an explicit selected result. A prognostic benchmark is labeled as prediction, without treatment-effect, independent control-outcome or real/effective-N claims. Unknown values remain absent/unknown.
- Trial-design views distinguish full-study mean duration (`duration_months`, Monte Carlo uncertainty) from last-patient-in accrual timing. Fitted survival curves and extrapolation use distinct rendering; fitted-median parameter quantiles do not become patient percentiles. Unsupported absolute risks or adapter paths stay unavailable rather than interpolated into a scientific claim.
- Keep the v3.1 semantic tokens (warm paper and terracotta, above), typography, shared controls, Chinese baseline UI, mobile/keyboard access and the native frame. Huashu 3.0 informs conceptual hierarchy and purpose; Impeccable Operate/Read informs production interaction refinement. Neither authorizes a new brand world or prototype replacement. The documented application is in `.planning/vcr-ai-native-reset-20261025/design-skills/application.md`.
- Local synthetic browser inspection verifies layout/navigation/accessibility only. Actual DSH/model completion, numerical correctness, real-record matching validity, clinical validation and production acceptance need their own evidence. These boundaries do not add a new approval flow.
