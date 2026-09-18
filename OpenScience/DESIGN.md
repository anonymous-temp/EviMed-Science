---
version: 1.0
name: EviMed-design-system
description: >
  A calm clinical instrument for evidence-based medicine: direction A 「循证青」.
  Cool paper canvas, deep teal brand, hairline structure, almost no shadow.
  Colour is rationed: red is reserved for danger and unread work, amber for
  "needs checking", teal for the primary action and for the product's own
  promise — a verified claim. Typography does the hierarchy work, not colour
  blocks. Chinese is the baseline UI language; Latin faces lead the stack so
  numbers, DOIs and identifiers keep their metrics. Every status is encoded
  three times — colour, shape, words. The source of truth is
  apps/web/src/index.css and apps/web/tailwind.config.js; this file mirrors
  them, and the kernel frame mirrors the same values through
  ctx.theme.overrideTokens.

colors:
  # brand — OKLCH H=185 on a fixed lightness ladder, chroma clamped to sRGB
  brand-50:  "#f0fbf9"
  brand-100: "#e1f7f3"
  brand-200: "#c3ece6"
  brand-300: "#98dbd2"
  brand-400: "#63c5b9"
  brand-500: "#26ac9f"
  brand-600: "#008f84"
  brand-700: "#00756b"
  brand-800: "#005e56"
  brand-900: "#004841"
  brand-950: "#002d29"
  # neutral — OKLCH H=232, C<=0.010 (cool paper). n-500 is 2.96:1 on white:
  # never text, never a state dot.
  n-50:  "#f8f8f9"
  n-100: "#f0f1f2"
  n-150: "#e9ebed"
  n-200: "#dfe2e4"
  n-300: "#c8cdcf"
  n-400: "#acb2b5"
  n-500: "#90979b"
  n-600: "#767d81"
  n-700: "#606669"
  n-800: "#4c5154"
  n-900: "#3a3e40"
  n-950: "#242628"
  # dark surfaces, same hue, one step lighter per layer
  dark-bg:            "#14181a"
  dark-surface:       "#1d2225"
  dark-surface-2:     "#272d30"
  dark-border-faint:  "#292f32"
  dark-border:        "#3a4044"
  dark-border-strong: "#646c71"
  # semantic ramps (steps in use)
  danger-50:  "#fff6f5"
  danger-100: "#ffecea"
  danger-300: "#ffb7ae"
  danger-400: "#ff8b7f"
  danger-600: "#cf463e"
  danger-700: "#af302b"
  danger-800: "#8f2320"
  danger-950: "#470f0d"
  warn-50:  "#fff7ef"
  warn-100: "#ffeedc"
  warn-300: "#efc392"
  warn-400: "#e8a042"
  warn-600: "#ab6c00"
  warn-700: "#8c5700"
  warn-800: "#704500"
  warn-950: "#382000"
  ok-50:  "#f3fbf4"
  ok-300: "#aadbb3"
  ok-600: "#3a9052"
  ok-700: "#25773e"
  ok-800: "#1a5f30"
  ok-950: "#082e14"
  info-50:  "#f4f9ff"
  info-100: "#e8f2ff"
  info-300: "#aacfff"
  info-400: "#79b4ff"
  info-600: "#1f7ae0"
  info-700: "#0362bf"
  info-800: "#004e9c"
  info-950: "#01254e"
  # semantic roles — light
  bg:             "{colors.n-50}"
  surface:        "#ffffff"
  surface-2:      "{colors.n-100}"
  border-faint:   "{colors.n-150}"
  border:         "{colors.n-200}"
  border-strong:  "#8b9195"
  text:           "{colors.n-950}"
  muted:          "{colors.n-700}"
  accent:         "{colors.brand-700}"
  accent-fg:      "#ffffff"
  accent-soft:    "{colors.brand-50}"
  accent-strong:  "{colors.brand-800}"
  link:           "{colors.info-700}"
  ok:             "{colors.ok-700}"
  ok-soft:        "{colors.ok-50}"
  warn:           "{colors.warn-700}"
  warn-soft:      "{colors.warn-50}"
  warn-strong:    "{colors.warn-800}"
  danger:         "{colors.danger-700}"
  danger-soft:    "{colors.danger-50}"
  danger-strong:  "{colors.danger-800}"
  info-soft:      "{colors.info-50}"
  verify-ok:      "{colors.brand-700}"
  verify-pending: "{colors.warn-800}"
  highlight:      "{colors.warn-300}"   # a located quotation in a preserved source
  focus:          "{colors.brand-700}"
  badge:          "{colors.danger-700}"
  badge-fg:       "#ffffff"
  dot-running:    "{colors.info-600}"
  dot-done:       "{colors.brand-600}"
  dot-review:     "{colors.warn-600}"
  dot-failed:     "{colors.danger-600}"
  dot-canceled:   "{colors.n-600}"
  # semantic roles — dark (same names, different steps; never the light set inverted)
  dark-text:           "{colors.n-100}"
  dark-muted:          "{colors.n-400}"
  dark-accent:         "{colors.brand-400}"
  dark-accent-fg:      "{colors.dark-bg}"
  dark-accent-soft:    "{colors.brand-900}"
  dark-accent-strong:  "{colors.brand-300}"
  dark-link:           "{colors.info-300}"
  dark-ok:             "{colors.ok-300}"
  dark-ok-soft:        "{colors.ok-950}"
  dark-warn:           "{colors.warn-300}"
  dark-warn-soft:      "{colors.warn-950}"
  dark-warn-strong:    "{colors.warn-300}"
  dark-danger:         "{colors.danger-300}"
  dark-danger-soft:    "{colors.danger-950}"
  dark-danger-strong:  "{colors.danger-300}"
  dark-info-soft:      "{colors.info-950}"
  dark-verify-ok:      "{colors.brand-300}"
  dark-verify-pending: "{colors.warn-300}"
  dark-highlight:      "{colors.warn-800}"
  dark-focus:          "{colors.brand-400}"
  dark-badge:          "{colors.danger-600}"
  dark-dot-running:    "{colors.info-400}"
  dark-dot-done:       "{colors.brand-400}"
  dark-dot-review:     "{colors.warn-400}"
  dark-dot-failed:     "{colors.danger-400}"
  dark-dot-canceled:   "{colors.n-500}"
  # categorical chart slots, fixed order (shared with @ai4s/shared and openscience.mplstyle)
  series-1: "#2a78d6"
  series-2: "#eb6834"
  series-3: "#1baf7a"
  series-4: "#eda100"
  series-5: "#e87ba4"
  series-6: "#008300"
  series-7: "#4a3aa7"
  series-8: "#e34948"
  dark-series-1: "#3987e5"
  dark-series-2: "#d95926"
  dark-series-3: "#199e70"
  dark-series-4: "#c98500"
  dark-series-5: "#d55181"
  dark-series-6: "#008300"
  dark-series-7: "#9085e9"
  dark-series-8: "#e66767"

typography:
  fontFamilySans: >
    Inter, "SF Pro Text", system-ui, "PingFang SC", "HarmonyOS Sans SC", "MiSans",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif
  fontFamilySerif: >
    "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif
  fontFamilyMono: >
    "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC",
    "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace
  badge:    { fontFamily: "{typography.fontFamilySans}", fontSize: 11px, fontWeight: 600, lineHeight: 1 }
  caption:  { fontFamily: "{typography.fontFamilySans}", fontSize: 12px, fontWeight: 400, lineHeight: 1.5 }
  ui:       { fontFamily: "{typography.fontFamilySans}", fontSize: 14px, fontWeight: 400, lineHeight: 22px }
  body:     { fontFamily: "{typography.fontFamilySans}", fontSize: 16px, fontWeight: 400, lineHeight: 1.75 }
  title:    { fontFamily: "{typography.fontFamilySerif}", fontSize: 20px, fontWeight: 600, lineHeight: 1.35 }
  display:  { fontFamily: "{typography.fontFamilySerif}", fontSize: 26px, fontWeight: 600, lineHeight: 1.25 }
  wordmark: { fontFamily: "{typography.fontFamilySerif}", fontSize: 17px, fontWeight: 600, lineHeight: 1 }
  code:     { fontFamily: "{typography.fontFamilyMono}", fontSize: 14px, fontWeight: 400, lineHeight: 1.6 }

rounded:
  sm: 4px
  input: 8px
  card: 12px
  panel: 16px
  chip: 999px

spacing:
  unit: 4px
  scale: [0, 4, 8, 12, 16, 24, 32, 48, 64]
  rowCompact: 36px
  rowStandard: 44px
  cardPadding: 16px
  sectionGap: 32px
  measure: 680px
  containerNarrow: 640px
  container: 680px
  containerWide: 1000px
  containerFull: 1120px
  sidebar: 232px
  hitTarget: 24px
  chromeIconTarget: 32px

motion:
  fast: 120ms
  base: 200ms
  easeStandard: "cubic-bezier(0.2, 0, 0, 1)"

elevation:
  flat: "none"
  pop: "0 4px 16px rgba(20,24,26,.10), 0 1px 3px rgba(20,24,26,.06)"
  modal: "0 16px 48px rgba(20,24,26,.18), 0 2px 8px rgba(20,24,26,.08)"

components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.ui}"
    rounded: "{rounded.input}"
    height: 36px
    padding: 0 14px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.input}"
    height: 36px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.input}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.card}"
    padding: "{spacing.cardPadding}"
    boxShadow: "{elevation.flat}"
  popover:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.card}"
    boxShadow: "{elevation.pop}"
  dialog:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.card}"
    boxShadow: "{elevation.modal}"
  text-input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-strong}"
    focusBorderColor: "{colors.focus}"
    rounded: "{rounded.input}"
    height: 36px
    typography: "{typography.ui}"
  segmented-control:
    backgroundColor: "{colors.surface-2}"
    borderColor: "{colors.border-strong}"
    selectedBackgroundColor: "{colors.surface}"
    rounded: "{rounded.input}"
  badge-unread:
    backgroundColor: "{colors.badge}"
    textColor: "{colors.badge-fg}"
    rounded: "{rounded.chip}"
    height: 16px
    typography: "{typography.badge}"
  badge-count-neutral:
    backgroundColor: "transparent"
    borderColor: "{colors.border-strong}"
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    height: 16px
    typography: "{typography.badge}"
  chip-neutral:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  chip-verified:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-strong}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  chip-needs-check:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn-strong}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  chip-safety:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-strong}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  citation-chip:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.link}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  notice-safety:
    backgroundColor: "{colors.danger-soft}"
    borderColor: "{colors.danger}"
    textColor: "{colors.danger-strong}"
    rounded: "{rounded.input}"
  notice-must-fix:
    backgroundColor: "{colors.warn-soft}"
    borderColor: "{colors.border-strong}"
    textColor: "{colors.warn-strong}"
    rounded: "{rounded.input}"
  notice-advice:
    textColor: "{colors.muted}"
  run-status-dot:
    size: 8px
    running: "{colors.dot-running} pulsing circle"
    done: "{colors.dot-done} filled circle"
    review: "{colors.dot-review} diamond"
    failed: "{colors.dot-failed} square"
    canceled: "{colors.dot-canceled} hollow circle"
  table-row:
    height: "{spacing.rowCompact}"
    borderColor: "{colors.border-faint}"
    hoverBackgroundColor: "{colors.surface-2}"
    selectedBackgroundColor: "{colors.accent-soft}"
  table-header:
    backgroundColor: "{colors.surface-2}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.ui}"
  sidebar:
    width: "{spacing.sidebar}"
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    selectedRowBackgroundColor: "{colors.accent-soft}"
  report-prose:
    typography: "{typography.body}"
    maxWidth: "{spacing.measure}"
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
  focus-ring:
    outline: "2px solid {colors.focus}"
    outlineOffset: 2px
---

## Overview

EviMed is a hosted AI research workbench for evidence-based medicine. The people using it are
clinicians, clinical pharmacists and medical researchers, reading dense mixed Chinese/English
scientific text for an hour at a time. The interface must read as an **instrument**, not as a
chat product.

Three ideas carry the whole system:

1. **Colour is rationed.** One brand hue (deep teal), one neutral ramp, four semantic ramps.
   Red is reserved for two things only: danger (errors, destructive actions, clinical-safety
   findings), and work the user has not handled yet (the unread badge).
2. **Lines, not shadows.** Structure comes from 1 px hairlines and surface steps. Static cards
   have no shadow at all; only what genuinely floats — menus, popovers, dialogs, drawers — casts
   one.
3. **Every status is said three times** — colour, shape and words. Red and green mean opposite
   things in a Chinese market chart to what they mean in a Western one, and one reader in twelve
   cannot tell them apart at all.

**Key Characteristics**
- Cool paper canvas `{colors.bg}` (#f8f8f9) with near-black cool ink `{colors.text}` (#242628).
- Deep teal brand `{colors.accent}` (#00756b), the family of the product's first favicon. It marks
  the primary action, the focus ring, the selected row and, deliberately, a verified claim.
- Amber `{colors.verify-pending}` for "needs checking". **Never red.** A claim awaiting
  verification is not a clinical alarm.
- Hairline structure: `{colors.border}` for decoration, `{colors.border-strong}` for anything that
  is the visible boundary of a control.
- Typography carries the hierarchy: five rungs plus `badge` and `wordmark`, 14/22 interface text,
  16/1.75 report prose at a 680 px measure (~42 Chinese characters).
- Numbers are tabular; identifiers (DOI, PMID, NCT, run id) are monospace so they can be checked
  character by character.

## Colors

### Brand & Accent
- **Teal 700** (`{colors.accent}` — #00756b): primary buttons, active navigation, focus ring, the
  ✓ verified mark. 5.59:1 on white, 5.27:1 on the canvas; white on it 5.59:1.
- **Teal 400** (`{colors.dark-accent}` — #63c5b9): the same roles in dark. 7.81:1 on the dark
  surface; the dark canvas on it 8.69:1.
- **Teal 50 / 900** (`{colors.accent-soft}` / `{colors.dark-accent-soft}`): selected rows, the
  current sidebar row, the verified chip. Never text. Text on it is `{colors.accent-strong}`
  (7.26:1 light, 6.69:1 dark).

### Surface
Light: `bg` → `surface` → `surface-2` is a three-step ladder from canvas to raised panel. Dark:
the same three names point at #14181a → #1d2225 → #272d30; each added layer is one step lighter,
never a lightened copy of the light theme.

### Text
- `text` (#242628) — body and headings. 15.19:1 on white, 13.43:1 on surface-2.
- `muted` (#606669) — captions, metadata, secondary rows. 5.83:1 on white, 5.16:1 on surface-2.
- Nothing lighter than `muted` carries text. There are no alpha composites: an opacity modifier on
  a token colour (`text-muted/50`) generates no CSS in this Tailwind setup, and ESLint rejects it.

### Semantic
- `danger` — errors, destructive actions, clinical-safety findings, the unread badge. Nothing else.
- `warn` — needs checking, a degraded capability, an expired credential.
- `ok` — a completed operation. **Not** the verified mark (that is the brand).
- `link` / `info` — links, the running state, citation chips. Links are not the brand colour, so a
  page full of citations never drowns the primary button.
- Each has a `-soft` background; `danger`, `warn` and `accent` also have a `-strong` text colour
  for use on it (8.13:1, 7.80:1, 7.26:1).

### Run states
Five states, one rule (`runState` in `apps/web/src/lib/runPresentation.ts`), one component
(`RunStatusDot`): running (pulsing circle, info), delivered (filled circle, brand), delivered with
an open verdict (diamond, warn), not delivered (square, danger), cancelled (hollow circle, n-600).
All ≥ 3:1 as graphics; the word is always printed beside them.

### Charts
Eight categorical slots in a fixed order, never cycled, shared with `@ai4s/shared` and the
matplotlib style. The order is the colour-vision mechanism: validated with the dataviz validator
on 2026-09-18 against #ffffff / #f8f8f9 (worst adjacent CVD ΔE 9.1, normal-vision 19.6) and
#1d2225 / #14181a (8.4 / 19.3). Aqua, yellow and magenta are under 3:1 on white — a chart using
them carries direct labels or a table view. In a scatter, past three series fold into 「其他」 or
facet. Gridlines are `border`, axes `border-strong`.

## Typography

### Font Family
Latin faces lead (`Inter`, `SF Pro Text`), Chinese faces follow (`PingFang SC`,
`HarmonyOS Sans SC`, `MiSans`, `Hiragino Sans GB`, `Microsoft YaHei`, `Noto Sans CJK SC`). The
stack is written out in full: browser defaults for CJK differ per OS and per Chrome version, and
on Windows an unnamed CJK face falls to bitmap-hinted SimSun. Mono falls back to the Chinese sans
faces, so a Chinese word that lands in mono renders at the right width.

### Hierarchy
`badge 11/1` · `caption 12/1.5` · `ui 14/22` · `body 16/1.75` · `title 20/1.35 serif` ·
`display 26/1.25 serif` · `wordmark 17/1 serif`. Every page H1 is `title`
(`PageHeader` / `PAGE_TITLE_CLASS`); `display` is for the login page and empty states only.

### Principles
- Weights 400 and 600 for new work (Chinese screen faces carry no true 500).
- Never add `letter-spacing` or `uppercase` to Chinese.
- Mixed-script spacing is the browser's job: `text-autospace: normal` on the body (all three
  engines ship it initially off, so it is written), `no-autospace` on code and identifiers;
  `text-spacing-trim: normal` as progressive enhancement.
- Serif is for titles. It never carries Chinese body text.
- Tables use tabular numbers.

### Note on Font Substitutes
If `Inter` or `Source Serif 4` are unavailable, fall back to the system UI sans and Georgia. Do
not substitute a different Chinese face — the scale was measured against PingFang SC and
Microsoft YaHei.

## Layout

### Spacing System
4 px base (Tailwind's spacing scale). Rows 36 px compact / 44 px standard; card padding 16 px;
section gap 32 px. Page padding 32 px — never a 96 px marketing rhythm.

### Grid & Container
Sidebar 232 px (drag 184–340; a drawer below 1024 px). Containers: `max-w-content-narrow`
640 · `max-w-content` 680 (reading measure: conversation, report prose, inbox) ·
`max-w-content-wide` 1000 (run ledger) · `max-w-content-full` 1120 (catalogues, the evidence
matrix).

### Whitespace Philosophy
This is a dense tool. Whitespace separates groups, not every element: a list of twenty runs fits a
laptop screen without scrolling to find the fourth.

### Motion
Two durations: `duration-fast` 120 ms for a state change (press, toggle, chevron) and
`duration-base` 200 ms for a container (menu, drawer, panel), one easing (`ease-standard`). No
bounce, no parallax, no coloured shimmer. `prefers-reduced-motion` collapses everything to an
instant; a spinner still renders, it just does not move.

## Elevation & Depth
Three levels: `flat` (none), `pop` (menus, popovers, toasts), `modal` (dialogs, drawers). Static
cards are `flat` with a 1 px border; ESLint rejects the retired `shadow-card`. In dark mode
shadows are nearly invisible; depth comes from the surface ladder.

## Shapes
`rounded` 4 · `rounded-input` 8 · `rounded-card` 12 · `rounded-panel` 16 · `rounded-full` for
chips and pills. A control nested inside another uses the outer radius minus the padding
(a segment inside an 8 px segmented control is 6 px); small swatches may be 2 px.

## Components
See `components:` in the frontmatter. Every component reads its values from `{colors.*}`,
`{typography.*}`, `{rounded.*}`: a literal hex in a component is a defect, and
`apps/web/src/app/designTokens.test.ts` fails on one outside a short list of content palettes
(canvas and WebGL viewers, rendered Office documents), each named with its reason.

Six states on every interactive component: default, hover, active, focus-visible, disabled,
loading. The focus ring is the global 2 px `{colors.focus}` outline at 2 px offset (text fields
signal focus with a `focus` border plus a 1 px ring).

Signature components: `InboxBell` (20 px glyph in a 32 px target; the unread pill hangs off the
corner; a shield replaces the bell while a clinical-safety item is unread), `RunStatusDot`,
`QualityNotices` (SAFETY in the danger tone with a shield and never folded, 必须修改 in amber,
提示 folded and quiet; no validator sentence is ever primary text), `PageHeader`, `Disclosure`
(the one collapse), `ConfirmDialog` (`tone="danger"` for what cannot be undone, `primary` for a
checkpoint; initial focus on 取消).

Minimum hit area 24×24 CSS px (WCAG 2.2 SC 2.5.8); 32×32 for icon buttons in the chrome.

## Do's and Don'ts

### Do
- Ration colour. If a screen has more than three coloured elements, one of them is wrong.
- Encode status three ways: colour, shape, words.
- Use `border-strong` for the visible boundary of a control; `border` is decoration only.
- Show odometers (elapsed, sources, claims checked, cost) for long work.
- Right-align numbers and set `tabular-nums`.
- Put identifiers in monospace so they can be checked character by character.
- Keep prose to 680 px.
- Give every failure a next action.
- Map every server enum, status and error code to Chinese before it reaches the screen
  (`labelFor`, `webErrorMessage`, `errorCodeMessage`); an unregistered code reads as unregistered.

### Don't
- Don't use red for anything but danger and unhandled work.
- Don't make "needs checking" look like a clinical alarm.
- Don't put a percentage or a progress bar on an agent run.
- Don't use gradients, sparkles, glows or coloured shimmer.
- Don't use an opacity modifier on a token colour; use its `-soft`/`-strong` partner.
- Don't put a shadow on a static card.
- Don't let a badge cover the icon it sits on.
- Don't render two adjacent rows with identical text.
- Don't show raw validator strings, enum codes, run ids or model names in the body of the UI;
  support material goes behind an operator-only disclosure.
- Don't rely on hover to reveal anything a keyboard user needs.

## Responsive Behavior

### Breakpoints
`sm 640` · `md 768` · `lg 1024` · `xl 1280` · `2xl 1536` (Tailwind defaults).

### Touch Targets
≥ 24×24 CSS px everywhere; 32×32 for chrome icon buttons; inline citation chips are exempt by the
inline-target exception but keep ≥ 4 px separation.

### Collapsing Strategy
`< 1024`: the sidebar becomes a drawer over the content. `< 768`: prose gets 16 px side padding;
tables scroll horizontally with the first column frozen. No page may scroll horizontally at
390 px.

### Image Behavior
Figures inside a report keep a white background in both themes (a chart printed on a dark card is
unreadable and unprintable); the report prose itself follows the theme. Printing gets white paper:
the reader mounts a print copy of the report while the browser prints (`beforeprint`), re-scoped to
the light tokens with `data-theme="light"`, and the print stylesheet hides everything else — so
「打印 / 存为 PDF」 gives the report and its facts, each 依据 mark a plain word, never the shell.

## Iteration Guide

**May be changed** without review: spacing within the scale, row density, which of the four
containers a page uses, icon choices within lucide.

**Requires review**: any new colour token; any change to a ramp's lightness ladder; a new
blocking visual state; anything that adds a coloured element to a screen that already has three;
any change to the `components` block. Contrast figures in `index.css` comments are measured with
the WCAG 2.1 relative-luminance formula — re-measure, never estimate.

**Must change in three places at once**: the chart series (`index.css` `--series-*`,
`packages/shared` `CHART_PALETTE_*`, `runtime/skills/core/publication-figures/openscience.mplstyle`),
with the dataviz validator re-run.

**Must change in two places at once**: every value in `colors:` and `typography:` is mirrored
into the kernel frame through `ctx.theme.overrideTokens` (the frame layer,
`packages/harness-port/src/runtimeUi*.mjs`), so the shell and the conversation match exactly.

## Known Gaps

- `border-strong` is #8b9195, not appendix D's #8e969b: D measured 3.01:1 on white only, and
  controls sit on the canvas (#f8f8f9) as often, where #8e969b is 2.83:1. The frame's control
  boundary should use the same value.
- `font-weight: 500` (`font-medium`) is still used in older components; Chinese faces without a
  500 cut render it at 400 while the Latin run goes to 500.
- `text-ui-sm` survives as an alias of `ui` for two frame-owned files; ESLint rejects it
  everywhere else.
- The frame's own geometry (radii, spacing) has no tokens; it is held by suffix-selector
  stylesheets pinned to the kernel version.
- Chart typography inside matplotlib-rendered figures is not covered by this file.
- The right pane and sidebar widths predate appendix D §8.6 (right pane default 560 px; D proposes
  360 px, never wider than the centre column).
- No motion spec for streaming text (buffering cadence is an engineering decision).
