# EviMed Frontend Design System

Version 3.1 · 2026-10-26 · Owner-reviewed specification; implementation and release status are separate.

EviMed is a general-purpose agent platform with a professional medical layer. Ordinary writing, documents, spreadsheets, slides, code, data, web research and scheduled work are first-class tasks. Medical methods, vocabulary and checks enhance relevant work; they do not become entry requirements for other work.

The owner's October 26 direction is **warm paper surfaces, restrained terracotta actions, and a near-black EviMed identity**. The implemented light identity is `#24211e`; the dark identity is light paper ink. The logo decision is near-black. Deep navy is the adopted information-status family, not a second general action accent. Preserve the existing molecule geometry and the useful native conversation surface.

This revision supersedes v3.0 after the owner review and consolidates the September/October decisions. `DESIGN.md` is the engineering companion. The actual machine-readable values are in `packages/design-tokens`; prose does not create a competing token source. Historical reports describe their own dates, not current defects.

## 1 Authority and acceptance

**MUST** is required in the applicable implementation scope. **SHOULD** is the default with a documented exception. **MAY** is optional. Explicit owner decisions and security/domain contracts prevail. The order of design evidence is: owner intent; this current specification; generated token/component contracts; observed rendering and task results. If these disagree, record and reconcile the disagreement rather than silently choosing the easiest test.

Each change identifies its surface, mode, rule, affected states, proof and remaining gaps. Source inspection, a component probe, a screenshot, a completed browser interaction, and production acceptance are different evidence classes. A passing lint or color check does not close a keyboard, touch, scientific-result or real-user requirement.

The October 26 audit examined 389 product TSX files through an AST inventory and focused manual inspection, exercised representative live surfaces, and recorded 48 captures. It did not execute all 60 registered walk views or every populated/failed/dark state. Its source baseline was `23c84044a`; the serving revision was not established. Findings and limits are in `../../docs/ui-ux-audit/2026-10-26-platform-visual-audit.md`.

### 1.1 Status and release identity

The local integration worktree now implements **token package 3.0.0** against **specification 3.1**. The preceding main 2.2.0 read and uncommitted 2.3.0 warm-brand candidate remain historical provenance. Generated values, component contracts and release digests belong to the coordinated major migration; compatible added roles are minor and within-role tuning is patch.

Implemented locally: derived color/focus/status roles, shared interaction and input primitives, typed measurements/quantities, scientific-viewer repairs, scoped GEO/VCR/module adoption, and public component contracts. See the [execution ledger](../../docs/superpowers/plans/2026-10-26-design-system-v3-execution.md) for actual proof and outstanding gates. Local implementation does not establish publication, push, main adoption or deployment.

External Vue adoption, installed production PWA cache behavior, physical touch, real assistive technology, field performance and unexecuted native workflows remain separately bounded. The prior audit is preserved unchanged as historical evidence.

### 1.2 Ownership and proof vocabulary

**H — host-owned:** React shell/components and their control-plane integration. **K — kernel-owned:** upstream native conversation UI; EviMed accepts the behavior and reports/adapts through a supported seam, without a second composer or cross-origin DOM patch. **B — both:** each owner implements its surface; the integration acceptance crosses the boundary. Backend truth/permissions stay with their existing producer regardless of UI owner.

Proof codes: **L** lint/static contract; **T** behavioral or type test; **W** rendered route/interaction walk; **G** gallery/composition fixture; **M** manual keyboard/touch/assistive-technology check. A listed check is a required proof method, not a claim it exists or passed. New rules require an ID, owner, applicable states and proof method. Appendix A covers every DS group; DS21 and the component adoption table add rule-level detail.

DS01-DS20 identifiers are retained; DS21 adds cross-component interaction. AT01-AT50 are the minimum regression scenarios, not a complete WCAG checklist. No UI rule creates an additional runtime evidence veto.

## DS01 Product grammar and modes

Use **Operate** for navigation, task execution, editors, settings, lists, maps and administration; use **Read** for articles, sources, reports and evidence. A reader can have a small operational toolbar without becoming a dashboard. Promotional pages may use a different expressive mode but must not dictate the density of work screens.

The product's character comes from continuity between asking, working, inspecting and reusing. Avoid medical decoration on general work and avoid generic promotional cards inside a research workspace. Apply Huashu's concept, hierarchy and craft questions with Impeccable's task-first restraint. Poster ratios such as a title 2.5 times body size or a fixed 40% whitespace quota are not SaaS acceptance rules.

The user should know the object, current scope, next useful action, state, and available result. Research provenance is available when needed to judge or reuse a result. Internal provider routes, runtime identifiers, token counters and operational diagnostics do not substitute for this information. Operator surfaces may expose safe diagnostic detail under their own access rules.

## DS02 Brand and color semantics

### 2.1 Existing local palette baseline

Values below describe the coordinated 3.0.0 source roles; machine-readable tokens remain authoritative. Section 2.3 records the migration rationale.

| Role | Light | Dark | Meaning |
|---|---|---|---|
| `bg` | `#f7f5ef` | `#171512` | Application canvas |
| `surface` | `#fffdf8` | `#211e1a` | Reading, cards and overlays |
| `surface-1` | `#f2efe7` | Token-defined dark surface | Sidebar, inset track and table head |
| `surface-3` | `#e3ded3` | Token-defined deeper surface | Deep neutral/pressed ground |
| `accent` | `#a34427` | `#d98c6b` | Main action, link and focus |
| `brand-ink` | `#24211e` | `#f7f5ef` | EviMed logo identity |

Neutral text, control boundaries, selected backgrounds, warnings, danger, success and data colors use their own named roles. A warm background does not justify brown low-contrast metadata. Danger must remain distinguishable from terracotta, using its label/icon and the separate crimson ramp. Amber denotes attention, not every paused or incomplete item. Scores are neither safety grades nor confidence percentages unless their defined method establishes that meaning.

Dense lists use ink titles and neutral metadata; accent identifies actions/selected states. Do not turn every heading, tag, icon and chart terracotta. Comparison charts retain the intended own-series/rival mapping, and scientific categorical/diverging palettes retain their actual data semantics.

### 2.2 Logo contract

The host mark, native frame mark, favicon and installation artwork share the existing molecule path. The wordmark remains readable ink. Hover never turns the logo into an action-color badge. Dark surfaces use light identity ink, not literal black. A native frame with its optional theme injection disabled must retain a safe native text-color fallback.

Do not redraw the logo from memory or approximate it with emoji. PNG installation icons are derivatives of the same SVGs and must be rerendered when their source changes. Cache revisions, generated assets and release evidence move together. A successful local build does not update an already installed PWA or another repository's pinned theme.

### 2.3 Adopted derived-role decisions — release 3.0.0

Owner **B** for shared themes; actual per-control consumers remain H or K as listed. These role changes are implemented locally; their required proof remains explicit below.

| Rule | Role / consumer | Adopted decision | How to verify |
|---|---|---|---|
| DS02.a | `verify-ok` | Use `ok` green in each theme. A check means the named verification passed; it is not a general medical safety guarantee. | T: equality to `ok`; G/M: check, pending and danger adjacent; AT31 |
| DS02.b | `title-ink` | Alias the full `text` role, including the dark value; read-state muting remains separate. The local light title is already neutral. | T: light/dark equality; G/W: feed and reader title; AT31 |
| DS02.c | `info`, `info-soft` | Navy information family: light ink `#18324d`, light soft `#eaf0f5`; dark ink `#9bbbd5`, dark soft `#142330`. Encode in the central ramp; never duplicate in components. | T: role/soft/surface contrast; G/M: information versus action/error; AT31 |
| DS02.d | `dot-running` and independently styled run/step dots | Use the information role with shape and words; completed uses `ok`, attention uses `warn`, failure uses danger. Audit `Tabs`/step classes as well as token aliases. | T: actual caller mappings; G: all states together; AT31 |
| DS02.e | Text-field focus | Add `focus-input`, referencing `brand-ink`. Input, Textarea, Select, SearchInput and editable field widgets use it. Buttons/links keep existing accent `focus`; error boundary and focus remain simultaneously recognizable. Native fields require a supported kernel theme mapping or an explicit upstream gap. | T: generated mappings; G/W/M: error+focus and forced colors; AT31/47 |
| DS02.f | Comparison versus scientific charts | `CHART_OWN` / `CHART_COLORS.own` keep terracotta and rivals keep greys. `CHART_SERIES` is a scientific categorical palette and does not become the action palette. | T: computed CIE76 own-versus-each-rival distance >=15 in both themes plus relevant contrast; G/M: labeled marks; AT32 |
| DS02.g | `STUDY_TYPE_BADGES` | Retain the closed study-type categorical colors as a documented data exception, including synthesis blue. They identify study type, not info/safety/strength; keep visible labels and measured foreground/background pairs. | T: allowed set and contrast; G: all types beside safety and information; AT31 |
| DS02.h | Frontier new/rising tags | Neutral surface/text with explicit new/rising text and a supporting glyph. Do not spend accent, warning or safety tones on popularity. | T: caller tone; G/W: hot-list states together; AT31 |

`chartPalette.test.ts` now checks categorical identity/order and computes the own-versus-rival CIE76 distance. Blue scientific palettes and study types remain intentional exceptions; the single-action-accent rule never meant removing every blue data encoding.

## DS03 Tokens and generation

`packages/design-tokens/src/index.mjs` owns primitive ramps, semantic roles, type, geometry and motion. Generate CSS, the Tailwind preset, Element Plus/ECharts/kernel themes, Figma/DTCG exports and host CSS. `src/release.json` binds generated bytes to the package version. Brand identity assets derive from the same roles and shared path through the existing build pipeline.

Never edit a generated consumer to tune a color. Add a new semantic role only when it represents a real reusable purpose. Distinguish a value adjustment, an added role, and removal/reinterpretation when choosing the version increment. Keep engine/theme/version compatibility explicit at the native seam. Release 3.0.0 must update the version constant, package version, generated metadata/digests, consumers and their acceptance together; do not change the upstream kernel version merely because the design-token version changes.

Theme preferences remain light/dark/system. Follow system changes only in system mode; explicit preference wins. Initial rendering should use the preference early. Test switching while a menu, dialog, table overflow cue, graph, selected row and scientific preview are present. An absolute RGB cached by a component must not outlive the surface/theme that gave it meaning.

## DS04 Typography and content density

Preserve the shared sans stack, named CJK fallbacks and punctuation handling. Serif is limited to the wordmark, home headline and document title. Controls, metadata and ordinary sections use sans. Monospace is for code or values compared character-by-character, not a decorative technical costume.

The current size vocabulary is 12/13/14/16/18/20/24/32/40px expressed in rem. Key roles are:

| Role | Size and line | Use |
|---|---|---|
| `meta`, `caption` | 12px with its token line height | Secondary metadata; not essential instructions |
| `ui` | 14px / 22px | Controls, lists and interface text |
| `body` | 16px / 1.75 | Long research prose |
| `reading`, `reading-lg`, `reading-xl` | 16/18/20px / 1.8 | Article prose and lead by viewport |
| `section` | 18px / 26px | Reading sections |
| `heading` | 20px / 28px | Data-section and preview headings |
| `title`, `doc-title` | 24px / 32 or 34px | Page/document identity |
| `metric` | 32px / 40px | Data-page values |
| `hero` | 40px / 50px | A single home brand moment |

Chinese hierarchy uses 400 and 600, not a medium weight that may resolve inconsistently. Existing per-template type budgets remain guardrails, not a reason to erase scientific units or helpful instruction. Long reading measures use 560/640px paragraph roles and a 720px reading column where appropriate; do not mistake 40 CJK characters for 40 Latin `ch` units.

Distinguish title, lead, added context and source. Each expanded block must answer a different reader question. Do not repeat the same finding in the title, lead, first fact row, quotation and interpretation without new value. Long document titles must remain fully discoverable on narrow screens; two-line truncation suitable for a list summary is not automatically suitable for the document's own title.

## DS05 Geometry and responsive composition

Preserve the shared scale: 4/8/12/16/20/24/32/40/48/64px. Use tighter spacing inside groups and more space between distinct tasks. Default page gutters are 16px below 768px and 24px from there. Align a page title and its main content to the same structural edge.

Use the established width roles: read 720px, page 1040px, wide 1200px with the existing larger-screen expansion, full for a genuinely full work surface. User-resized sidebars and panels are allowed; do not label a valid saved width as a defect because it differs from the default. Related input/configuration/progress/results can share one workbench. Unrelated content cannot be justified by calling it a workbench.

Radii remain tag 6, control/row 8, card 12, panel/dialog 16, composer 24px. Static surfaces do not acquire shadows merely because the palette is warm. Keep elevation for real overlays and the composer, using existing levels.

At 390px the page itself must not scroll horizontally. Necessary two-dimensional tables/canvases may scroll inside a named reachable region. At 320 CSS px reflow, preserve critical labels/actions and contain the exception to genuinely two-dimensional content. Intermediate tablet widths, zoom, soft keyboard and short-height viewports need separate acceptance.

Mobile navigation must close after a destination is selected, move focus into the destination appropriately, and preserve project identity. Long names must remain distinguishable without hover, using the DS21 identity rule. Keep frequent actions accessible; move infrequent rename controls into overflow or allow titles to wrap. A compact workflow rail needs an explicit overflow/all-steps affordance, not merely clipped off-screen steps.

## DS06 Buttons links tags and selection

| Element | Meaning | Required behavior |
|---|---|---|
| Primary button | The main executable action in a local task | One dominant action per action group; explicit verb/object |
| Secondary button | Alternative or supporting action | Visually subordinate, with consistent size and hit area |
| Text button | An action with low visual emphasis | Keyboard/focus semantics of a button |
| Link | Navigation or a resource | Destination expectation; return/context preservation |
| IconButton | Compact known action | Accessible name, focus feedback, discoverable explanation |
| Tag | Noninteractive classification/state | Never masquerade as a control |
| Filter chip | Changes a query/selection | Pressed state and clear/reset behavior |
| Tab | A related view in one context | Tab/panel association and correct keyboard activation |
| Switch | Immediate, reversible preference | Optimistic selection with pending lock and failure rollback; delayed runtime activation uses an explicit apply button and effective-time status, not an on/off promise |

Keep existing sizes 28 small, 36 default and 44 primary, with 16/20px icons and consistent stroke. Actual pointer targets must meet WCAG 2.5.8 or a valid exception; 44px is a preferred touch target, not a blanket AA minimum. A small icon can have a larger invisible hit area. Hover-only controls must also appear on focus and have a touch path.

Loading preserves focus, the action label and width. For an otherwise enabled action use `aria-disabled`/`aria-busy` with a real activation/submission guard; ARIA alone does not prevent duplicate effects. Native `disabled` still represents a genuine unavailable prerequisite. Use a reserved spinner slot or measured width that survives text/size variants. A disabled action explains the missing prerequisite nearby. Permission denial, missing configuration and no selection are different reasons. A family row that filters, a method row that configures and a capability row that opens a conversation must state different outcomes rather than share an unexplained chevron.

## DS07 Forms and scientific input

Every input has a visible label and associated help/error. Place units and scale beside the number: proportion 0-1, percent, months, days, hazard ratio, or other actual quantity. Show an example where the scale could be mistaken; preserve the interpreted value/unit in configuration and results. Do not infer an ambiguous unit silently. Use the NumberField contract and the shared quantity parser/formatter specified in DESIGN.md; parse on blur and on submit, retain invalid raw input and never coerce blank to zero. Current local unit rendering and an unlabeled deployed form must be reconciled by revision evidence, not by declaring either universally fixed or broken.

Keep related fields together, progressively disclose genuinely advanced parameters, and separate prerequisites from optional choices. Show a persistent error summary linking to the fields after submission failure; retain input. Chinese IME composition must not accidentally send: H owns host field submission; K owns the native composer. The integration verifies both without implementing a host replacement composer. Allow password managers, paste and available autofill. Do not force whole-study endpoints/effect assumptions merely to start matching or construct a cohort.

Long configuration and literature-to-parameter mapping belong in the main work area. Short edits and previews may use a drawer. A form cannot claim resume/undo/autosave without actual persistence support. Reversible drafts may be local only under an explicit data policy; do not silently store sensitive document bodies long-term in browser storage.

## DS08 Dialogs focus menus and keyboard

Modal content has the appropriate role/name, background isolation, initial focus, tab cycling and focus return. Destructive confirmation names the object, count, consequence and recovery. Enter activates the focused control or explicit form submit, never a global destructive default. Escape closes the top eligible layer, with unsaved-content protection when needed.

Use a proven tabbability primitive or equivalent complete logic: exclude negative tabindex, hidden/inert ancestors, hidden inputs, CSS-hidden elements and native disabled semantics such as disabled fieldsets. A selector match is not proof of a Tab stop. Prefer a proven tabbability primitive; a short `tabIndex`/`closest` recipe is insufficient. In particular the first legend of a disabled fieldset has native exceptions, radio groups have one sequential stop, and `checkVisibility()` needs explicit visibility options and a supported fallback. Test nested overlays, roving tabs, unmounted triggers and disabled final elements.

Menus position within available space and scroll when content exceeds it. Test 30/100-item histories at short heights. Selection and focus remain visible. Ordinary notifications do not steal modal focus. Single-character shortcuts are scoped or disableable; commands and native editor shortcuts keep their established ownership. Current shortcut definitions come from the native surface; do not redefine Cmd/Ctrl+Enter independently in host documentation.

## DS09 State truth and recovery

All lists/sections distinguish initial load, populated, first-use empty, filtered empty, partial, stale, first-read failure, refresh failure, denied and canceled as applicable. Preserve usable prior data with its timestamp after refresh failure. Initial failure leaves a persistent explanation and retry, not only a disappearing toast.

Unknown is not zero. Unread resource data is not a stopped runtime. Unmeasured safety is not zero severe findings. A zero is shown only with its actual scope/denominator/time or explicitly as a ledger count. No result, source failure and no evidence are different conclusions.

Show a numerical progress percentage only with a real measured denominator. Use observed stages and last update for unbounded work. Never manufacture countdowns or stage changes. Long duration is not failure; distinguish connection state from task outcome. Action-required badges count actions the current person can take. Automatic recovery belongs in status, not an unanswerable to-do.

## DS10 General conversation and long tasks

The native conversation is the general operating entry, with one composer. Home/logo/new conversation must not inherit specialist binding, study title or GEO progress. Preserve explicit resume links, history and drafts. Simple tasks can finish as text; ordinary Office/code/data files are valid deliverables without a professional-report ceremony.

Make the input's project/material scope understandable. Editable examples illustrate real tasks and do not fabricate completed work. Use task-oriented labels in the ordinary menu; raw diagnostic commands such as `loopx-init` belong behind an appropriate operator or advanced surface. Useful model selection may keep its actual model name; a blanket ban on every technical identifier must not erase an intentional user choice.

**K owns native stream scrolling, composer Enter and IME behavior; H owns its own fields and B owns routing/reconnect acceptance.** A missing upstream behavior becomes a kernel-seam/upstream issue, not an instruction to duplicate the native UI. Streaming follows only while the reader is at the end. Upward reading/selection suspends following and exposes return-to-new-content. Restore authoritative history on refresh/reconnect, without resubmitting or duplicating events. Cancel stays pending until confirmed; leaving a page does not cancel it. Retry explains whether it creates a new run or actually resumes existing work. A failed specialist binding cannot silently masquerade as a successful specialist entry.

LoopX owns its goal lifecycle. Present start, pause, state and meaningful progress through its supported controls. Unattended tasks do not wait indefinitely for a person who is not there. Clarification displays what is needed and why, accepts a real response, and does not reopen answered requests. No confirmation UI bypasses sandbox restrictions.

## DS11 Medical evidence and delivered output

Medical provenance loads where the task/content calls for it. Preserve direct/synthesized/derived distinctions and their existing domain contracts; the browser must not infer them with ad hoc text matching. Original passage, generated explanation, source availability, formal evidence quality and automatic/human checks are distinct dimensions.

A readable path connects conclusion, source, retained support and original material. Provide available title/date/identifier and location, declaring missing information. Do not label generated summaries as verbatim quotations. Retraction/update status requires reliable metadata. Publication, discovery and generation dates remain separate.

The current professional policy delivers usable work with findings and explicit verification limits; ordinary file checks are advisory. Do not revive whole-package withholding as a frontend rule. Preserve actual backend refusal boundaries for unreadable/missing/corrupted/security-relevant failures. The UI must not downgrade a completed but limited result into a generic failure or claim that accepted means all claims verified.

Keep SAFETY information and claim-linked check marks understandable without raw validator prose. A check label names its actual scope and version. Unknown verification remains unknown. Edits invalidate automatic inheritance of a check badge; downloads identify the corresponding version. Clinical limitations remain attached to the affected conclusion and survive copying/export.

## DS12 Frontier feed and reading

Keep distinct visible dimensions: view, category, specialty, source, evidence type, date and follow/read state. Group related decisions instead of treating all choices as one flat menu. On mobile use the existing filter sheet with clear/reset and current selection. Keep required destinations discoverable; do not remove them merely to lower a count.

A card opens its addressed reader. Source/date/title/summary have a consistent hierarchy. Clean publishing boilerplate and promotional noise through the content pipeline while preserving factual identity. List summaries end coherently; do not cut statistical expressions into misleading fragments. Dates identify publication time or clearly labeled discovery time, with the product's declared Beijing-time display where required. A score explains importance and its time/method scope, not clinical certainty.

Use one concise lead, distinct additional key points and genuinely additional interpretation. Keep original-source access in a predictable upper action area on desktop and a labeled accessible action bar on mobile. Avoid three competing original-source buttons in one visible region. Long readers need section navigation; ensure the fixed action bar does not obscure focus or final paragraphs. Events and evidence zones preserve source relationships, authorship and read/return paths.

## DS13 Knowledge library and file readers

Distinguish uploaded source, parsed readiness, compiled knowledge page, graph and generated output. Transfer completion does not imply parsing/search readiness. Sources may be uploaded, linked or authored only through supported actions, with per-item failures and retries. Scope is visible, and switching it invalidates old selections safely.

The original, supported extracts and compiled knowledge are different views of one traceable object. Preserve source/page/cell locations and unknown coverage. A quote jump has a return path. Graph selections link to readable records; do not fabricate edges for a sparse graph. Empty states describe useful inputs and outcomes without awkward internal bookkeeping phrases.

Office/PDF/code/table/scientific viewers must expose the same information hierarchy: identity/version, main content, available actions, limitations, and return to conversation/source. A successful download start is not proof of disk completion. Untrusted document content stays isolated; do not inject raw document markup into the application.

Scientific viewers need keyboard equivalents for pan/rotate/zoom and value inspection, readable instructions, and touch cancellation/lost-capture handling. Fixed scientific canvases may keep their palette, but their labels still meet contrast. Initialize size observation only when the drawing element exists; resize the actual coordinate system. No-features text cannot stand in for initial setup. Provide decoded values in a reachable structured alternative where appropriate.

## DS14 Memory and capsules

Make saved content, source, scope and later use understandable. Distinguish personal facts/preferences, project facts, reusable methods and imported capsules without forcing users to learn engine terminology. Enablement is separate from editing or deleting a record. Existing rights/retention govern import/export/withdrawal.

The map must reveal records, not merely display nodes. Give sparse graphs meaningful labels or a persistent selected-record summary and a linked list within reach. Label membership edges as membership, not semantic inference. One real node is sufficient; missing dimensions use honest sparse representations rather than invented links or blank decoration. Current source/live control differences must be checked before reporting a missing button.

Import/sharing explains what is included, recipient scope, activation and revocation limits. Capsules are context, not permission. Memory uses the native OpenViking engine; an unavailable engine is an explicit off/unavailable state, not a fallback to the retired records engine. A person has one capsule and project labels organize its entries. Failed/partial read and genuinely empty remain distinct.

## DS15 GEO product-policy boundary

Owner **B**. The maintained product scope and workflow live in the [GEO iteration plan](../../docs/superpowers/plans/2026-10-23-geo-profound-pureblue-todo.md), including its dated UI acceptance handoff. This design system governs truthful missingness, typed metrics, navigation discoverability, shared components and task/result identity; it does not maintain a second copy of GEO product sequencing. AT07/20 plus that plan's journeys are the acceptance contract.

## DS16 VCR product-policy boundary

Owner **B**. The [October 25 AI-native reset](../../docs/superpowers/specs/2026-10-25-vcr-ai-native-product-reset.md) owns task scope, retained scientific objects, recruitment removals and conversation-first entry. Its dated UI handoff preserves the original v3 requirements. Apply shared numeric, provenance, keyboard and result-version rules here. AT08/15/25 and the reset's scientific journeys must pass; a design-document revision does not implement the reset.

## DS17 Other module policies

Owner **B** for schedules/extensions and **H** for host settings/inbox presentation. The [scheduled-task correction plan](../../docs/superpowers/plans/2026-10-25-scheduled-tasks-correction.md), [extension-center design](../../docs/superpowers/specs/2026-10-01-dsh-ecosystem-and-extension-center-design.md), and [adoption plan's module register](../../docs/superpowers/plans/2026-10-26-frontend-design-system-v3.1-adoption.md#module-policy-register) own their evolving product decisions. Shared feedback placement, pending/effective states and accessibility live in DS09/DS21 and component contracts. Keep actual project/timezone, provenance, role boundaries and useful results. AT26-AT28 test those boundaries without claiming a form screenshot proves runtime execution.

## DS18 Accessibility motion and performance

Target applicable WCAG 2.2 A/AA across complete workflows. Normal text meets 4.5:1; qualifying large text 3:1; necessary non-text identification generally 3:1. Pure decoration, disabled controls and other exceptions retain their exact scope. Do not claim compliance from token pairs alone. Labels in fixed-color scientific canvases remain text.

Keyboard focus is visible, ordered and not obscured. Native semantics come first. Single-character shortcuts are manageable; icon names match purpose. Charts and maps expose readable alternatives. Screen readers receive meaningful state changes without token-by-token interruption. Reduced motion retains short state feedback; it does not justify destroying all hierarchy through a blanket animation kill. Match the current generated motion roles rather than hand-typing alternative durations.

Check 320px reflow, 390px phone, intermediate/tablet and desktop; 200% text resize; forced colors and both themes. Emulated layout is not real touch. Exercise pointer cancel, lost capture, interrupted gestures, keyboard equivalents, VoiceOver/Safari and NVDA/Chromium. Restore temporary browser overrides after testing.

Use LCP <=2.5s, INP <=200ms and CLS <=0.1 as field goals at the 75th percentile, segmented by device, not as measured achievements here. Keep model latency separate. When telemetry is not authorized, use labeled synthetic baselines. Do not enable prohibited content telemetry to obtain a metric. Profile steady rendering, large lists, long histories and scientific canvases; decorative CPU activity should stop when not needed.

## DS19 Components and page templates

Reuse PageShell and its supported scope/steps/activity/tabs/toolbar/headline slots; align controls with the content they affect. Keep list, master-detail, workflow, data-map, reader and settings templates, plus the connected-workbench exception. New structure needs an explicit task rationale and responsive proof, not another arbitrary nested-card system.

Helpful purpose, units, prerequisites, limitations and recovery instructions are allowed. A mechanical grey-sentence counter cannot distinguish useful guidance from internal narration. Keep existing regression budgets while updating their semantic intent and tests; never delete necessary task guidance just to reduce a count. Informative zero-count or currently empty destinations may remain discoverable when they explain a prerequisite or preserve a selected filter; provide a useful reset/next action.

Every shared component adopts the ordered JSDoc contract template in DESIGN.md: anatomy, variants, states, hit area, keyboard, long content, theme, responsive behavior, verification. The component header is the maintained implementation contract; `/__gallery` and composition fixtures are its executable examples, not another separately authored component manual. The adoption matrix records existing gaps and migration proof, including missing primitives. It does not assert that unimplemented props already exist. Do not confuse a static Tag with a button, or a screenshot of a state with its behavioral contract. Gallery goldens cover only their registered fixtures. Add scientific readers, complex overlays, composition templates and native-frame states to acceptance rather than claiming the primitive gallery covers the whole platform.

## DS20 Governance and rollout

Maintain one normative English specification here, one engineering companion in DESIGN.md, and one generated token table. Module policies stay in their maintained plans. Chinese deliverables are dated immutable reading snapshots or a link/index; do not hand-maintain a second normative body. A future generated translation must record its source revision and hash and cannot silently replace the English authority. Mark old material historical. AGENTS.md points to the current authority and records new owner decisions without reversing unrelated edits. Each exception names rule, surface, rationale, equivalent access, owner, expiry and evidence.

Do not deploy solely because a new palette builds. Review generated assets, theme-disabled native behavior, fixed scientific canvases, original/derived content, installed PWA and external Vue consumers. Preserve source revision, build/image identity and acceptance state separately. Publish the adopted brand in one coordinated change containing this specification, DESIGN.md, AGENTS.md, token 3.0.0 source/package/release metadata, generated consumers, brand assets and required consumer pin/readback updates. Consumer adoption outside this repository remains an explicit release gate. Product code, documentation and tests change together where the rule is executable. User-task outcomes decide whether a mechanical guardrail remains useful.

The [adoption plan](../../docs/superpowers/plans/2026-10-26-frontend-design-system-v3.1-adoption.md#work-packages-and-closure) owns the ordered work packages and their exit conditions. Keep sequencing there instead of maintaining a second roadmap in this normative specification.

## DS21 Cross-component interaction contracts

These rules are adopted defaults. Timing values are EviMed product budgets, not WCAG requirements or measured latency claims. Component details and migration states are in DESIGN.md.

### DS21.1 Feedback latency and durable work

Owner **B**: H for host requests/ledger/inbox, K for native turn feedback. Verify **T** fake-clock transitions and abort races, **W/M** slow-network and durable-navigation journeys; AT33/34.

| Elapsed / condition | Required presentation | Boundary |
|---|---|---|
| Immediately, including <100ms | Press/focus/selection feedback and duplicate-action guard | Do not delay the action or suppress normal control feedback to satisfy a timer |
| Before 300ms | Avoid flashing an unnecessary spinner/skeleton for a fast read | Preserve existing useful content; an admitted mutation can already be pending |
| At 300ms while unresolved | Initial read: relevant skeleton; refresh: retain old content with refresh status; mutation: stable busy action | Skeletons are not the universal answer to every operation |
| At 10s while unresolved | Real elapsed time or last update, useful stage and cancel if the producer actually supports it | Never invent progress or display a cancel button that cannot cancel |
| At 60s while unresolved | For a durable admitted task, surface the safe leave/resume path and its persistent result/inbox route | Duration alone cannot create a background job, change billing, cancel/restart the run or guarantee a notification. Non-durable requests explain their limitation and retain actual recovery |

Numeric progress is permitted for any real measured work denominator, not uploads alone. File transfer bytes and parse/search readiness remain distinct. Counting model tokens or advancing a timer is not percent-complete proof.

### DS21.2 Mutation state vocabulary

Owner **H** for shared host mutations; **B** when persistence or runtime activation participates. Verify **T/W**, AT35/36/37.

| State | Meaning | Presentation and retained data |
|---|---|---|
| `idle` | No outstanding mutation | Current persisted state plus editable draft |
| `pending` | Exactly one admitted intent awaiting a result | Stable action, accessible busy state, same request identity; prevent duplicate side effects |
| `settled` | Authoritative save result received | Reconcile persisted value. Display effective-now or effective-at-next-session separately |
| `failed-reverted` | Confirmed rejection of an optimistic reversible change | Restore previous persisted value and explain failure inline with retry |
| `failed-kept` | Failure with a valuable draft/previous result retained | Keep draft or stale result in place; show error, timestamp and actual recovery |

A transport timeout after submission may have an unknown server outcome. Do not blindly roll back, resubmit or invent a sixth UI success: retain the submitted intent under `failed-kept` with an explicit unknown-outcome marker, then reconcile by request/version identity. Late earlier responses cannot overwrite newer user intent. Read lifecycle and mutation lifecycle are different state machines.

An immediate reversible Switch may move optimistically once, then locks at that requested position while pending; it does not keep moving with retries. A confirmed failure reverts it. Scope, invariant label and error remain visible. Configuration that takes effect only in a later runtime/session uses an Apply/Enable action plus persisted/effective status rather than a switch that implies immediate activation.

### DS21.3 Undo and unsaved work

Owner **H**, backed by actual backend recovery contracts. Verify **T/W/M**, AT38/39.

| Situation | Default |
|---|---|
| Existing reversible archive/delete with an actual restoration path | Perform, offer Undo and a durable trash/history recovery route; no extra confirmation ceremony |
| Irreversible operation or meaningful external consequence | Structured confirmation names object(s), count, consequence and recovery limits; preserve existing permission/approval boundaries |
| Unsaved form/drawer closing by Escape, backdrop, close button or route leave | One shared unsaved guard offers keep editing or discard; offer save only if real save is available |

An Undo toast cannot be the only recovery path because it expires. Do not invent a recycle bin or restore promise for an API that cannot restore. If recovery is partial, say which side effects remain. `beforeunload` can only provide the browser's generic prompt where supported; it is not a mobile persistence guarantee. A pending irreversible mutation cannot be dismissed as if nothing happened; reversible drafts should remain escapable with useful recovery. Confirmed save resets the dirty baseline; a failed save does not.

### DS21.4 Feedback placement and announcement

Owner **H** for host feedback; **B** for kernel status/event delivery. Verify **T/G/M** and AT40/41.

| Channel | Use | Do not use for |
|---|---|---|
| Field error / form summary | Invalid input, with linked field and retained raw value | An unrelated global service incident |
| `InlineAlert` | Persistent first-read/save failure, missing prerequisite or scoped warning, with action | A disappearing replacement for necessary recovery |
| `Freshness` in summary/headline | Previous valid data, last successful timestamp, failed refresh and retry | Relabeling old data as current or converting failure to empty |
| Toast | Brief completion or an optional Undo supplement | Sole first-load error, sole clinical safety record or sole recovery mechanism |
| Inbox | Durable task completion, requested follow-up, user decision or incident update | A new item for every internal retry or unchanged heartbeat |
| Badge | Count of actionable/unread items linked to their actual list | Autonomous waits counted as actions required from the person |

Mount one empty host polite live region at application startup and route host `announce()` calls through it; use a separate assertive channel only for urgent, interrupting cases. Preserve focus. Deduplicate by event/entity identity and normalized text within a short documented window (default 5s), retaining visible repetition counts; identical wording from different tasks must not merge their task identities. Test re-announcement after the window and notification priority changes. A toast and its associated inline message announce one event, not two. Kernel announcements remain owned by K; the host cannot promise cross-frame deduplication without an agreed event identity and supported integration.

### DS21.5 Keyboard map and precedence

Owner **H** for host viewers/navigation, **K** for the native editor, **B** for supported shortcut forwarding. Verify **T/W/M**, AT42/47.

| Context | Keys | Contract |
|---|---|---|
| Host chrome | `?`; Cmd/Ctrl+B | Help (respect the single-key preference), sidebar toggle; do not intercept typing/editor commands |
| Native composer | Native slash menu and editor submit keys | Keep the pinned kernel's mapping; `/` is not asserted to be an existing host-global search shortcut |
| Focused scientific viewer | Arrows; `+`/`-`; `0` | Pan; zoom; reset, only where the view supports that operation |
| Focused rotatable scientific viewer | Shift+Arrows | Rotate; in a non-rotatable view do not hijack an unrelated selection shortcut |
| Focused scientific feature/value mode | Enter; Escape | Read/select the current value; release the current interaction/capture, without deleting selection data |
| Tabs | Arrows, Home/End; Enter/Space in manual mode | Cheap/preloaded panels may auto-activate; expensive/asynchronous panels move focus first and activate on intent |
| Modal/menu layers | Tab/Shift+Tab; Escape | Appropriate local traversal and top eligible layer handling, then focus return |

Controls and accessible data alternatives expose the same operations without memorizing shortcuts. Viewer bindings act only while their view has focus, ignore editable descendants and composition, and do not trap Tab or intercept browser zoom. Do not assign `role="application"` just to force key handling. Kernel text editing has precedence inside the iframe; global keys cross it only through a declared bridge.

### DS21.6 Navigation lifecycle

Owner **H**. Verify **T/W/M**, AT18/43. Put mobile drawer closure in the layout/router integration once. Close after an accepted destination transition, including back/forward; a query change that is merely a filter does not count as new destination navigation. If an unsaved guard refuses navigation, keep the old route and draft. A same-destination selection may close explicitly. After leaving the menu, use the existing route-focus mechanism; do not race drawer-trigger focus restoration against the new heading. A pending upstream task continues according to its producer contract.

### DS21.7 Long names and identity

Owner **H**. Verify **T/G/W**, AT19/44. Prefer wrapping for document identity. In compact navigation, preserve a useful prefix and distinguishing tail with middle truncation. Duplicate display names get a stable visible disambiguator derived from an existing short ID/scope, not a persisted rename or an unstable current-sort index. Keep the full accessible name and a touch-accessible way to inspect it; a native hover title alone is insufficient. This does not redefine the name of the underlying project.

### DS21.8 Microcopy numbers and time

Owner **H** for host formatting, **B** for source timezone and output interpretation. Verify **T/G/W**, AT45.

Buttons use an action verb and object where ambiguity exists. Error content answers what happened, what it means for the work and what can be done; this is a three-part content contract, not a forced three-sentence paragraph. No internal exception text or invented remedy. Error labels remain attached to the relevant object.

Use existing `lib/format.ts` as the sole host formatter authority: `formatNumber`, quantity/unit formatting and the adopted `formatRelativeTime` policy. Migrate `runPresentation.relativeTime` and `compactTime` to thin options/wrappers of that authority, then retire duplicate logic. Counts use tabular digits and grouping; IDs/PMIDs/years and typed machine input do not. Number/unit pairs use one nonbreaking space and a shared quantity formatter; currency/percentage grammar and machine exports follow their declared formatter, not page-local string concatenation. Preserve scientific precision and uncertainty.

Default display zone is `Asia/Shanghai`. Under 24 elapsed hours show an appropriate relative time; otherwise show an absolute date/time, including year when needed for identity. Also expose the exact timestamp accessibly on touch and keyboard. Future schedule times are absolute and carry the actual selected timezone. Date-only values remain calendar dates, never shifted through UTC. Publication, collection, generation and last successful refresh times are distinct fields. Pin clock and timezone in tests, including 23:59/24h boundaries, UTC conversion, invalid/future values and midnight.

### DS21.9 Composition-safe submission

Owner **B**: H implements SearchInput/shared submit guard; K supplies native composer behavior. Verify **L/T/W/M**, AT46/47. Host submit handlers consult composition state before Enter or Escape causes a task action, without suppressing the editor's normal composition. Cover compositionend followed by Enter, native-event composition flags and browser-specific fallback in Chromium/WebKit/Firefox. Scope a lint rule to submission/search handlers, with reviewed exceptions; do not ban Enter handling in every accessible widget or generated upstream code. A click submit also validates the current raw field value. The native frame gets its own acceptance case and seam/upstream issue if it fails.

### DS21.10 Batch selection

Owner **H**, with existing server permissions. Verify **T/W/M**, AT48. Adopt opt-in batch operations where the backend supports them: visible selection checkboxes, indeterminate page checkbox, count, clear selection and labeled batch action bar. Default Select All means the current page. Selecting all matching results requires an explicit query-scoped option with a frozen scope/count and exclusions; it cannot silently include later arrivals. Cross-page selection uses stable IDs. Scope/tenant change clears selection; ordinary sorting preserves it. Mixed outcomes show per-item success/failure and retry only the failed subset without repeating successful effects. Disabled/unavailable objects state why. Destructive batch actions follow DS21.3; there is no blanket product-wide ban or promise of batch support on every list.

## Minimum acceptance scenarios (existing and new; not a pass list)

| ID | Scenario | Required result |
|---|---|---|
| AT01 | Ordinary document/spreadsheet task | Native general flow, useful file, no medical gate prerequisite |
| AT02 | Home from a specialist project | No inherited specialist title/binding; history preserved |
| AT03 | Local brand across host/native/icons | Warm surfaces, terracotta action, ink logo, shared geometry |
| AT04 | Native theme body disabled in dark mode | Logo remains visible through native text fallback |
| AT05 | Theme switch with table overflow | Fade follows current surface; no old white/dark strip |
| AT06 | First metrics/account read fails | No fabricated zero/stopped fact; persistent local retry |
| AT07 | Unmeasured vs measured-zero safety | Distinct state and sample scope |
| AT08 | Rate/time scientific inputs | Units/scale and interpreted value explicit |
| AT09 | Specialist binding failure | Preserved intended capability and recovery, no disguised fallback |
| AT10 | Native menu | Task-oriented names; diagnostics appropriately separated |
| AT11 | Stream while reading upward | Stable selection/scroll and explicit new-content control |
| AT12 | Reconnect/reload | No resubmission, duplicates or false run failure |
| AT13 | Modal with roving/hidden/fieldset-disabled inputs | Correct Tab/Shift+Tab loop and focus return |
| AT14 | Genome first mount at 358px then resize | Observer attaches to real canvas; coordinate width follows |
| AT15 | Scientific view using keyboard | Pan/rotate/zoom/value inspection have equivalents |
| AT16 | Fixed scientific canvas labels | Normal instruction text >=4.5:1 |
| AT17 | Touch interrupted/canceled | No stuck drag, swallowed scroll or missing state cleanup |
| AT18 | Mobile navigation to another module | Menu closes, focus/context identifies destination |
| AT19 | Long similar project names | Distinguishable without hover; actions do not crowd identity |
| AT20 | GEO eight steps at 390px | All reachable with explicit overflow cue; waits separated |
| AT21 | Sparse memory graph | Real labels/selection/list, no fabricated links |
| AT22 | Article and source reading | Distinct content roles, source access, return position, no hidden essential title |
| AT23 | Upload complete but parsing pending | Transferred and ready are different |
| AT24 | Updated checked file | New version does not inherit old check label |
| AT25 | VCR matching/cohort request | Only task-required context; no recruitment operations |
| AT26 | Scheduled task and human continuation | Clear timezone/scope/state and actual resumed task evidence |
| AT27 | Plugin configured vs active | Real provenance/scope and truthful effective-time wording |
| AT28 | Repeating incident then recovery | One current incident with retained history; useful action count |
| AT29 | Long menus, 320px reflow, zoom and AT | No inaccessible actions; test-specific evidence recorded |
| AT30 | Export/print/open output | Correct object/version/content; no shell or internal diagnostics leakage |
| AT31 | Derived roles together in light/dark/forced colors | Verification, information, run state, safety, popularity and field focus are distinct and mapped to the adopted roles |
| AT32 | Comparison and categorical chart palettes | Compute own-versus-each-rival CIE76 distance >=15; preserve scientific category meanings and required contrast |
| AT33 | Fast/300ms/10s request transitions | No needless flashing, no delayed duplicate guard, truthful stage/elapsed/cancel behavior |
| AT34 | 60s durable versus non-durable operation | Background/resume and inbox claims only when the producer actually supports them |
| AT35 | Busy Button activated by mouse, Enter and form submit | One mutation, focus retained, stable width, unchanged accessible action label |
| AT36 | Immediate Switch save fails or times out | Lock after optimistic change; confirmed rejection reverts; unknown outcome reconciles without duplicate submission |
| AT37 | Measurement and quantity boundary | Unknown has no numeric value; real zero survives; invalid/blank input remains distinct; percent/fraction conversions agree across input/config/result |
| AT38 | Dirty FormDialog and Drawer exit | Shared guard covers close/backdrop/Escape/route; save failure preserves input; confirmed save clears dirty state |
| AT39 | Recoverable versus irreversible deletion | Real Undo plus durable recovery for recoverable action; object/count/consequence/recovery confirmation otherwise |
| AT40 | Persistent read/refresh failure | InlineAlert and Freshness retain actual old values/time with retry; toast is supplemental |
| AT41 | Host announcement and repeated message | Empty regions pre-exist; one announcement per event; repeated different-task messages remain distinct; actual AT behavior checked |
| AT42 | Expensive Tabs | Arrows only move focus in manual mode; Enter/Space activates once; focus and selection remain distinguishable |
| AT43 | Router change with mobile menu and dirty form | Only accepted destination changes close the drawer; no focus-return race or discarded draft |
| AT44 | Duplicate long project names | Stable display-only disambiguation, preserved tail/full accessible name, no stored rename |
| AT45 | Shared numeric/time formatting | 24h/midnight/timezone/future/date-only cases and scientific precision remain correct; old wrappers delegate |
| AT46 | Host IME/search submission | Composition Enter never submits; following intentional Enter/click submits once; lint exception is scoped |
| AT47 | Native composer/scroll and theme focus | Test the pinned kernel surface, record K/B gaps separately; no shell duplicate or cross-origin DOM repair |
| AT48 | Batch operation with mixed outcomes | Query/page selection scope explicit; permissions retained; retry failed items only; recovery truthful |
| AT49 | Combobox/date/file primitives | Out-of-order async results and IME safe; date semantics stable; transfer/parse readiness and partial failure distinguishable |
| AT50 | Component contract and release adoption | Nine JSDoc fields plus executable fixture/proof links; major version, generated consumers and external adoption receipts agree |

## Appendix A — ownership and verification coverage

Every requirement within a DS group inherits its row; a more specific DS02/DS21/component row adds proof rather than removing it. Existing test names are starting points, not declarations that all new assertions exist. A missing assertion/fixture stays open in the adoption plan. New MUST/SHOULD rules need an explicit owner and proof row before acceptance.

| Rules | Owner / boundary | How to verify | Minimum scenarios |
|---|---|---|---|
| DS01 product grammar | B; H entry/scope, K general composer | T routing/composition; W ordinary and medical task; M content hierarchy | AT01/02 |
| DS02 brand and derived roles | B; shared tokens, supported native mapping | L generated-value constraints; T contrast/role/data tests; G theme matrix; W installed/native identity | AT03/04/31/32 |
| DS03 generation/theme | B; H generators, K supported override | T `tokens:check`, release digests and native seam; W theme switch with overlays | AT04/05/50 |
| DS04 typography | H; document body K where native | L named scales; G long CJK/Latin; W title and reading; M readability | AT19/22 |
| DS05 geometry | B; H shell, K native pane | G template states; W 320/390/intermediate/zoom; M touch | AT18/19/20/29 |
| DS06 action grammar | H; K native buttons accepted separately | T activation/focus; G variants; W row outcome; M touch | AT09/35/36 |
| DS07 form/scientific input | B; host fields H, native composer K | T parser/type/IME; G all field states; W rejected submission | AT08/37/46/47 |
| DS08 layers and focus | B; H layers, K native layers | T tabbability/layer contract; G; W/M keyboard and AT | AT13/38/39 |
| DS09 state truth | B; producer facts + host rendering | T response-to-state adapters and negative cases; W failure/refresh recovery | AT06/07/33/34/40 |
| DS10 conversation/long work | B; K stream/composer, H routing/ledger | T seam/intent identity; W actual pinned frame; M reading/selection | AT01/02/09/10/11/12/47 |
| DS11 medical/output identity | B; existing domain policy | T domain/view-model contracts; W source/version/export; M claim scope | AT24/30 |
| DS12 frontier reading | H; producer provenance unchanged | T dates/labels; G source types; W reader and return; M editorial value | AT22/45 |
| DS13 files/viewers | B; H inspectors, K native files | T decode/resize; W actual files; M keyboard/touch/AT | AT14/15/16/17/23/30 |
| DS14 memory/capsules | H presentation with existing backend rights | T scope/state; W populated sparse graph/import preview; M record readability | AT21/24 |
| DS15 GEO | B; product plan owns sequencing | T scope/missingness; W process-to-result on desktop/phone | AT07/20 |
| DS16 VCR | B; product reset owns scope | T units/history/provenance; W contextual AI scientific journey | AT08/15/25 |
| DS17 module policies | B; host settings/inbox H | T lifecycle/roles; W actual schedule/activation and incident recovery | AT26/27/28 |
| DS18 accessibility/performance | B; iframe separately included | T accessibility contracts; W reflow; M AT/touch; measured field or labeled synthetic performance | AT15/16/17/29/41/47 |
| DS19 component contracts | H; K inventory stays upstream | L ordered JSDoc/fixture references; T/G public variants; W composition | AT35-AT42/49/50 |
| DS20 governance | B release ownership | L/T version/digest/doc-link consistency; W native and consumer adoption receipt | AT03/04/50 |
| DS21.1-DS21.10 | Per subrule above | Per-subrule L/T/W/G/M; do not replace behavioral proof with prose compliance | AT33-AT49 |

### References and provenance

- [Huashu Design 3.0.0, inspected commit](https://github.com/alchaincyf/huashu-design/blob/4fc7bfdbd5ec3fa2d43ce7a6433de60976a5e4b1/SKILL.md): requested design-review method; approved brand direction takes precedence over generic aesthetic warnings.
- [Impeccable 4.7.1, inspected commit](https://github.com/pbakaus/impeccable/blob/3671d50f0ac9a662ce0615e85a256110c9cd720b/.agents/skills/impeccable/SKILL.md): Operate/Read, independent critique and technical review. Context/detector were attempted but engine unavailable; no clean detector claim.
- [Carbon component documentation](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines): anatomy, use, behavior and accessibility structure.
- [Atlassian foundations](https://atlassian.design/foundations) and [tools](https://atlassian.design/tools): semantic decisions connected to reusable implementation.
- [Fluent responsible AI](https://fluent2.microsoft.design/responsible-AI): appropriate expectations, agency and attribution.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [APG modal pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): normative target versus implementation guidance.
- [Target-size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), and [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html): exact exceptions retained.
- [DTCG 2025.10](https://www.designtokens.org/tr/2025.10/format/): stable community interchange format, not a W3C Recommendation.
- [Web Vitals](https://web.dev/articles/vitals): performance goals and field measurement methodology.
- [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), [combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) and [switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/): interaction patterns; expensive tabs justify manual activation.
- [ARIA disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled), [fieldset semantics](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/fieldset) and [checkVisibility](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility): ARIA requires activation suppression; focus eligibility is more than an attribute selector. These implementation references were refreshed for v3.1.

The official skill snapshots were freshly read on October 26 through the GitHub connector. Carbon, Atlassian foundations, Fluent responsible AI, WCAG 2.2, APG modal guidance, target-size minimum, DTCG 2025.10 and Web Vitals were refreshed from their primary websites on October 26. The other reference links remain from the earlier research. Browser/source findings and task-specific decisions are the October audit's own evidence.
