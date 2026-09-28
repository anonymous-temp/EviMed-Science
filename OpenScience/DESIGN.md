# EviMed design system

**One product, one surface.** The shell and the embedded kernel conversation sit in the same
window, so they obey the same table. Colour already crossed that boundary; type and geometry
did not, and the seam was visible in a screenshot. **The shell conforms to the kernel**, not the
other way around.

**The table is `packages/design-tokens/src/index.mjs`, and nowhere else.** It became its own
package (`@evimed/design-tokens`) on 2026-09-26, when the fusion gave it a consumer in another
repository: the Vue shell of EviMed cannot import a module out of `@evimed/domain`'s source tree.
The old `@evimed/domain/design-tokens` path is gone; import the package. The full design
specification (v2.0, 2026-09-26) is the prose; this file is the engineering summary and defers to
it and to the table.

Seven artifacts are generated from the table, and no consumer restates a value:

| Artifact | Who reads it | What keeps it honest |
|---|---|---|
| the block in `apps/web/src/index.css` (`pnpm tokens:css`) and `dist/tokens.css` | the React shell; the Vue shell links the file | `designTokens.test.ts` regenerates and compares byte for byte |
| `dist/tailwind-preset.js` | both `tailwind.config.js` files extend it | the same test asserts each scale equals the table's |
| `dist/element-plus.css` | the Vue shell, after Element Plus's own sheet | every derived `--el-color-primary-light-N` is written out, so no teal-adjacent shade survives |
| `dist/echarts-theme.json` | both sides' charts | `chartPalette.test.ts` asserts the shared palette equals `CHART_SERIES` |
| `dist/dsh-theme.json` | `kernelThemeTokens()` → `ctx.theme.overrideTokens` in the kernel frame | the test asserts the accent, the canvas and the sidebar grey |
| `dist/figma-tokens.json` | the Figma library (Tokens Studio), until native import replaces it | generated like the rest |
| `dist/dtcg/` (2.1) | Figma's native variable import; any DTCG 2025.10 tool | a base file, one file per theme and motion setting, and `evimed.resolver.json` over `theme × motion`; the package test validates the shapes |

The CSS block carries rules as well as values since 2.1, each a decision the table owns: the
punctuation face, the serif bound to its three rungs, the English stack, the reduced-motion
values, and the forced-colours / more-contrast layer (see *Accessibility*).

Changing a value means editing the table, running `pnpm tokens:build`, and committing the
regenerated artifacts. Editing an artifact, the CSS or a Tailwind config instead is caught by
`pnpm tokens:check`, which is the point: the shell and the frame were two hand-maintained tables,
and "change it in both places" is an instruction, not a mechanism.

**The version moves with the bytes.** `packages/design-tokens/src/release.json` records the digest
of every artifact the current version shipped. When an artifact changes and the version does not,
`pnpm tokens:check` and the package test fail: bump `package.json` and `DESIGN_TOKENS_VERSION`
together (a tuned value is a patch, a new token a minor, a removed or re-meant one a major), then
run `pnpm --filter @evimed/design-tokens record-release`, which refuses to re-record an unchanged
version. The Vue shell pins a version, and a pin that stays equal while values move cannot see
drift (fusion audit F-G3).

---

## Colour

One accent — **循证蓝 `#0a5dc1`** — one blue-grey neutral ramp, four semantic ramps, and a closed
set of data colours. White on the accent is 6.27:1. The value is EviMed's live brand colour and is
not ours to tune: the platform has users and a logo already, and 循证青 `#00756b` retired with the
fusion (2026-09-26).

Every contrast figure below is **recomputed at build time** by
`packages/design-tokens/src/contrast.mjs`, which fails the build on a shortfall — in both themes,
under the more-contrast layer too, and for the rival greys a chart draws. The comparison is
unrounded: a pair at 4.4995 does not pass a 4.5 floor. The notes used to be typed by hand and went
stale silently; two of them were already fiction when the check first ran.

### Roles

| Role | Light | Dark | What it is |
|---|---|---|---|
| `bg` | `#fafbfc` | `#0f1318` | the page — a hair off white, so a card has an edge without a border |
| `surface` | `#ffffff` | `#161b21` | card, dialog, menu, popover, the reading column |
| `surface-1` | `#f5f7f9` | `#161b21` | the one grey step: sidebar, table header, inset track, code block |
| `surface-2` | `#edf0f3` | `#1e242b` | hover, the neutral selected row, a skeleton bar |
| `scrim` | `rgba(15, 19, 24, 0.32)` | `rgba(0, 0, 0, 0.56)` | behind a dialog or drawer |
| `border-hairline` | `#e4e8ec` | `#262d35` | decoration: separators, a card's edge |
| `border-faint` | `#edf0f3` | `#1e242b` | the quietest rule, inside a list |
| `border-light` | `#d6dce2` | `#262d35` | a pill or segment whose ground already separates it |
| `border-control` | `#858e97` | `#646e78` | the visible boundary of a control — 3.21:1, and 3.10:1 on the sidebar (WCAG 1.4.11) |
| `text` | `#1a1f25` | `#eef1f4` | body and headings, 16.00:1 |
| `text-2` | `#3e454d` | `#c3cad2` | secondary lines, 9.37:1 |
| `text-3` | `#5f686f` | `#8d96a0` | metadata, 5.48:1 — **nothing lighter carries text** |
| `text-graphic` | `#939ca6` | `#535b64` | icons and rules only, 2.69:1 — **never a word** |
| `accent` | `#0a5dc1` | `#5f97e0` | primary action, link, focus ring, selected row, the ✓ verified mark, and "our" chart series |
| `accent-soft` | `#eef4fc` | `#0a1f3e` | selected row background, the verified chip. Never text |
| `accent-pressed` | `#0a4da0` | `#8fb5ea` | the pressed state of an accent surface |
| `accent-strong` | `#0c3e7f` | `#8fb5ea` | text on `accent-soft`, 9.44:1 |
| `ok` `warn` `error` | 600 step | 300 step | **status only**, always beside a shape and a word |
| `member-from` / `member-to` | `#f6d58e` → `#fbe7be` | — | the membership card's one gradient |

Every role has its `-soft` background; `danger`, `warn` and `accent` also have a `-strong` text
colour for use on it. The retired names `border`, `border-strong` and `muted` are aliases of
`border-hairline`, `border-control` and `text-3`; use the new names in new work.

### Rules

- **Red is for danger and unhandled work.** Clinical-safety findings, destructive actions,
  errors, the unread badge. Nothing else.
- **"Needs checking" is amber, never red.** A claim awaiting verification is not a clinical alarm.
- **`ok` is not the verified mark.** A verified claim is the brand colour, on purpose.
- **One accent.** Links wear it too (2026-09-23): a second hue for links was an accent on every
  screen. A primary button stands apart by being solid, not by hue.
- **A comparison puts us in the brand and every rival in grey.** `CHART_COLORS.own` is the brand;
  `CHART_COLORS.rivals` is three greys, darkest for the highest rank — `#5a626b` / `#737c85` /
  `#8a939c`, 6.19 / 4.24 / 3.12:1 on white, every one a graphic a reader can see (2.1; the third
  was 1.92:1 before). At most one rival may take a colour, and only when the reader pins it. A
  chart of eight rainbow brands tells a reader nothing about which one is theirs, and that is what
  the GEO dashboard shipped. Our line is 2.5 px and every other 1.5 (`CHART_STROKES`).
- **Data with a midpoint is diverging**: `CHART_COLORS.diverging`, blue — light grey — orange,
  the two arms matched step for step in lightness, and `CHART_COLORS.missing` for a cell with no
  reading.
- **Certainty is a single-hue scale, never a traffic light.** Four brand-blue steps. Low certainty
  is not harm, and red is reserved for safety.
- **Restraint is the default; expression has a budget.** A reading page and a list page stay quiet.
  A page may spend **one brand moment** (a gradient, a serif headline, a hero), and charts and the
  32/40 metric rungs belong to data pages. Banning every expressive device is what made 循证 GEO
  look cheap, and un-banning them without a budget is how a product gets loud. **One list page
  carries one chart:** 记忆胶囊's growth line (2026-09-28, `CapsuleGrowth`) — the owner's timeline
  of how the capsule grew, which the list cannot show. It is a single brand line whose heading is
  the sentence it proves, with at most three moments; it has no tile, legend or metric rung, and it
  is not drawn until the history spans two weeks. No peer's memory page has a chart, so a second
  chart there, or a first on another list page, needs the same argument.
- **Every status is said three times** — colour, shape, words. Red and green mean opposite things
  in a Chinese market chart, and one reader in twelve cannot tell them apart at all.
- **No colour outside the table.** `designTokens.test.ts` fails on a hex literal or a colour
  function anywhere in `src/`, outside a named list of surfaces where colour is content (a
  rendered Office document, a fixed-dark scientific canvas).
- **No opacity modifier on a token colour.** `bg-accent/10` generates no CSS at all — the tokens
  are `var()` colours. Use the `-soft` / `-strong` partner. ESLint rejects the modifier.

### Run states and charts

Five run states, one rule (`runState`), one component (`RunStatusDot`): running (pulsing circle,
brand — `dot-running`), finished (filled circle, **green** — `dot-done`), finished with something
to check (diamond, amber), not finished (square, red), cancelled (hollow circle, grey). All ≥3:1
as graphics, the word always printed beside them.

Eight categorical chart slots in a fixed order, never cycled, shared with `@ai4s/shared`'s
`CHART_PALETTE_*` and `runtime/skills/core/publication-figures/openscience.mplstyle`. **Change
all three together and re-run the dataviz validator.** The order is the colour-vision mechanism.
Three slots are under 3:1 on white — **orange (slot 2) 2.97, yellow (slot 6) 2.45, light grey
(slot 8) 1.92** — so a chart using them carries direct labels or a table view; past three series
in a scatter, fold to “其他” or facet. Gridlines are the hairline, axes the control border.

### Theme

Three-way (`light` / `dark` / `system`), as `data-theme` on `<html>`, set before the first paint
by `public/theme-init.js` and kept live by `ThemeProvider`. Each block sets `color-scheme`, so
scrollbars, a select's list and date pickers follow. The dark theme points the same role names at
*different steps* — it is never the light set inverted. Never hardcode white on an accent
surface: use `text-accent-fg` / `text-error-fg`.

---

## Type

**One sans stack for the chrome. The serif is for three brand moments and nothing else.**

```
"EviMed CJK Punct", Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC",
"Noto Sans CJK SC", system-ui, sans-serif
```

The 2.1 stack. **"EviMed CJK Punct"** comes first and covers five code points only — “ ” ‘ ’ …
and the —— dash — because Inter's Latin subset otherwise drew Chinese quotes narrow and the
ellipsis on the baseline. It is an `@font-face` over `local()` sources (PingFang, Microsoft YaHei,
Noto Sans SC / CJK, Source Han Sans), so nothing is downloaded and no package enters the
lockfile; text marked `lang="en"` uses the same stack without it. Latin faces follow so numbers,
DOIs and identifiers keep the metrics the scale was measured against; then every Chinese face a
reader's OS might carry — without named CJK faces Windows falls to the bitmap-hinted SimSun.
`system-ui` is last: on a Simplified Chinese Windows it *is* Microsoft YaHei UI, and in second
place it shadowed every Chinese face after it. HarmonyOS Sans and MiSans are gone. Mono
(`JetBrains Mono`, falling back to the Chinese sans faces) is for identifiers compared character
by character: DOI, PMID, NCT, run id.

The serif came back on 2026-09-26, confined (fusion plan §5.2). An evidence platform borrows its
authority from the journals and every one of them is set in a serif, so the **wordmark**, the
**home headline** and the **title of a document** wear one — and nothing else does, because a
serif on a button reads as an old intranet. Three rungs carry the family themselves
(`text-wordmark`, `text-hero`, `text-doc-title` — a rule in the generated CSS binds it, since
Tailwind's size scale cannot), so a page never names `font-serif` to get it. A report's title is
`text-doc-title`; its sections are 18 / 600 in the sans.

```
"EviMed CJK Punct Serif", "Source Serif 4", "Songti SC", "Noto Serif SC", "Noto Serif CJK SC",
"Source Han Serif SC", "PingFang SC", "Microsoft YaHei", Georgia, serif
```

The serif's Chinese part ends in a sans on purpose: Windows has no bold 宋体, so a 600 title fell
to a regular-only SimSun and looked thin; there it is now a bold 黑体.

Only the two latin cuts ship as a webfont; the CJK serif is deliberately not one — a Source Han
Serif subset is megabytes and the systems that matter already carry Songti SC or Noto Serif CJK.
ESLint still rejects `font-serif` in `components/ui`, `components/layout` and `components/cards`:
a brand moment belongs to a page, never to a primitive.

### The nine sizes

**12 / 13 / 14 / 16 / 18 / 20 / 24 / 32 / 40.** The set is closed — a tenth is a defect, and the
test says so.

Five was the 2026-09-23 number, and it was the right cure for a page carrying eleven size ×
weight pairs and the wrong medicine for a dashboard: with 24 px as the ceiling a KPI could not
out-shout its own label, which is a large part of why 循证 GEO read as small. 13 returns for dense
controls, 18 for a section heading inside a reading page, and 32 / 40 for metrics — **the metric
rungs are admissible on a data page only.**

A page still uses at most **four size × weight pairs**. That budget is what the five-size scale
was protecting, and it survives unchanged.

| Rung | Size / line | What it is |
|---|---|---|
| `badge` | 12 / 1 | a count inside a pill |
| `meta` | 12 / 1.5 | the densest metadata: dates, journals, counts, legends |
| `caption` | 12 / 20px | captions and secondary one-liners (a line in a row) |
| `compact` | 13 / 20px | a small control, a filter chip, a dense data table |
| `ui` | **14 / 22px** | interface text, chat, list rows, controls — the default |
| `body` | 16 / 1.75 | report prose and the reading column |
| `wordmark` | 16 / 1.3 · serif | the EviMed lockup in the sidebar |
| `section` | 18 / 26px | a section heading inside an answer or a report |
| `heading` | 20 / 28px | a card heading on a data page, a document title in a preview pane |
| `title` | 24 / 32px | every page H1 |
| `doc-title` | 24 / 34px · serif | the title of a report, article or evidence card |
| `display` | 24 / 1.3 | the login page, a full-page empty state |
| `metric` | 32 / 40px | a KPI number — **data pages only** |
| `metric-lg` | 40 / 48px | the one leading KPI of a dashboard |
| `hero` | 40 / 50px · serif | the home headline — one per product |

Sizes reach the browser in **rem** (2.1), so a reader who raised the browser's default font size
gets a larger interface; the table itself speaks px.

Weights **400 / 500 / 600**, nothing else — and Chinese hierarchy uses **400 and 600 only**:
Microsoft YaHei has no 500, so a 500 title renders at 400 on Windows (an unread list row is 600
for that reason). No `letter-spacing` and no `uppercase` on Chinese — tracking breaks the
character grid.

**Mixed-script spacing** (spec §5.5): **interface copy we write types a half-width space** between
Chinese and Latin letters or digits — “打开 PubMed 检索”, “共 29 条”, “3 分钟前” — because about
half of our readers' browsers do not support automatic spacing, and a typed space works in all of
them. No space inside a formatted date or time (“2026年9月26日”, “14:05”), before % or °, or
beside full-width punctuation. **AI-generated prose and quotations are never touched** — a
quotation must match its source byte for byte — and the browser fills those gaps with
`text-autospace: normal` on the body. Code and identifiers turn it off (`no-autospace`) and keep
their grid (`text-spacing-trim: space-all`). Tables use tabular numbers.

`ui-sm` is retired (13 and 13.5 px were one rung half a pixel apart) and renders as `ui`.

A line of multi-line text is at most **40 CJK characters**: `max-w-measure` (560 at 14 px) and
`max-w-measure-body` (640 at 16 px). No list is wide enough to lift it. Ranks, scores, heat and
times are set in tabular numbers.

---

## Space, containers, radii, heights

**Base 4. Ten steps: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64** — 8 inside a group, 16–24 between
groups, 32–48 between sections. Card padding 16, grid gap 12, page gutter 24. Separate by space
first, then a quiet ground, and draw a line last.

### Containers — a page has one left edge

**Three columns, and a page uses exactly one for its title and its body both.**

| Name | Width | For |
|---|---|---|
| `max-w-read` | **720** | an answer, a report, an article, an evidence card |
| `max-w-page` | **1040** | a list: tools, the frontier feed, capsules, settings |
| `max-w-wide` | **1200** (1280 at ≥1440) | a dashboard: GEO, the evidence zone, the three-column knowledge base |
| `max-w-measure` / `max-w-measure-body` | 560 / 640 | a paragraph's line length |
| `max-w-content` | *retired* → 720 | an unmigrated reading column converges here |
| `max-w-content-narrow` | 560 | a form inside a drawer |
| `max-w-content-wide`, `-full` | *retired* → 1040 | an unmigrated call site converges here |

The single 960 column of 2026-09-23 is gone: it made a reading page too wide and a dashboard too
narrow, and a dashboard squeezed into a document column is the structural half of why 循证 GEO
looked cheap. `max-w-full` is deliberately **not** a token — a blanket map of the container table
would redefine Tailwind's own `max-w-full` as a pixel width.

Sidebar 280, collapsed 56 — the kernel's constants.

**Use `PageShell`.** It puts the title, the actions and the body inside the same box, because
three pages shipped with five different left edges (327 / 356 / 388 / 440 / 461 px) when each
page chose its own, and on 2026-09-23 the inbox still sat 126 px right of the rest. A page that
must lay itself out takes `width="full"` and still shares the gutter.

**A page header is one line**: the title, optionally a grey count or update time, and at the
right at most one primary button and two icon buttons or a search box. **No subtitle** — nothing
under the title explains how the system works; `PageHeader` has no place to put it.

### Radii

6 tags (`rounded-tag`) · 8 controls and rows (bare `rounded`) · 12 cards and popovers
(`rounded-card`) · 16 dialogs, drawers and panels (`rounded-panel`) · 24 the composer
(`rounded-composer`) · `rounded-full` pills. A chart's bars and cells take 2–4 and are not
counted. One border width (1 px) and one border colour; at most one bordered container deep, and
no rule under a card's title.

### Heights

**28 small · 36 the default · 44 for a primary action** · a tag is 22 — the token heights
`h-sm` / `h-control` / `h-form-primary` / `h-tag`, not steps of the spacing scale. Controls on one
line share a height. Icons are **16 inline / 20 in the chrome**, one stroke (1.5, read from
`--icon-stroke` on `svg.lucide`; it splits the difference between the kernel's 1.75 and EviMed's
hand-drawn 1.4). Minimum hit area 24×24 CSS px (WCAG 2.2 SC 2.5.8).

`Button` sizes map onto that: `sm` 28 with 13 px text, `md` 36 (the default), `lg` 44.
`IconButton` is 28 in a row and 36 in a header. `Input`, `Textarea` and `SearchInput` are 36 (28
with `size="sm"` in a table, toolbar or filter row) and 8 px round. Filter chips are 28 high with
13 px text.

### Layers, opacity, timing (2.1)

Stacking is by named tier (`z-*`), never by a larger number: page 0 · sticky 10 · drawer 40 ·
modal 50 · popover 60 (a menu opened in a dialog is still above it) · toast 70 · tooltip 80 ·
skip link 90. Opacity is spent on a disabled control (`opacity-disabled`, 0.4), the scrim (a
colour role) and a dragged item (0.8), never on a colour's pale version. Tooltips show after
300 ms (at once on keyboard focus) and hide 100 ms after the pointer leaves — `Tooltip` reads
`TOOLTIP_DELAYS`; nothing uses the browser's `title` for an icon's name. Toasts stay 5 s, 10 s when they carry an action,
and an error stays until it is closed (`TOAST_DURATIONS`).

### The component set (2026-09-23)

`components/ui/` holds the vocabulary a page is written in, and ESLint rejects a hand-made
bordered pill or bordered `<button>` outside it:

| Component | What it is |
|---|---|
| `PageShell` / `PageHeader` | the one column and the one-line header, no subtitle |
| `Tabs` | a page's views: underlined tabs over a hairline |
| `FilterChips` / `FilterChip` / `FilterSelect` | one row of quiet chips, 28 high and 13 px (no border; selected sits on grey), the rest in “更多 ▾” |
| `Tag` | the metadata label: 22 px, 12 px text, 6 px corner, grey, no border; `safety` red |
| `Button` | `primary` (solid accent, one per view) · `secondary` (grey ground, no border) · `text`; `danger` only confirms a destruction |
| `IconButton` | 28 in a row, 36 in a header; the label is its name and its `Tooltip` |
| `Tooltip` | an inverse 12 px layer on `z-tooltip`: an icon's name or a truncated line's whole text; hoverable, Escape closes it, never the only place something is said |
| `navItemClasses` | a column of places — the sidebar's destinations, projects and conversations, 设置's sections, the knowledge base's rail: 36 high, 8 px padding and corner, `accent-soft` at 500 when current |
| `List` / `ListRow` | like things as rows, no box; the title is the row's target (600 when unread), at most two quiet actions and “⋯”, always visible |
| `Panel` / `PanelRow` | a settings group: name outside, one box, label left and control right |
| `EmptyState` | an icon and one sentence; no button the header already has |

Plus the infrastructure a page needs: `Menu`, `Switch`, `SearchInput`, `Input`, `Drawer`,
`ConfirmDialog`, `Toaster`, `Disclosure`. A card (`Card`) is for unlike content — a hot list
above a feed, a tool in a grid — and never for a list of like things.

---

## Surfaces, states, motion

**Flat.** Structure is 1 px hairlines and the surface ladder. A static card has **no shadow** —
its border is its whole edge. Only what genuinely floats casts one: `shadow-e1` (a card that must
lift), `shadow-e2` (the composer, menus, popovers, toasts), `shadow-e3` (dialogs, drawers);
`shadow-pop` and `shadow-modal` are retired names of `e2` and `e3`. One brand moment per page, no
tinted cards, no coloured
icon tiles, no sparkles, no shimmer. A list beats a wall of cards.

**States**, the same everywhere:

| State | What it is |
|---|---|
| hover | `surface-2` |
| selected | `accent-soft` |
| focus | a 2 px `--focus` **outline** at 2 px offset (global `:focus-visible`); a text field turns its border `--focus` and adds a 1 px inner outline of the same colour. Never a `ring-*` box-shadow: forced-colours mode removes shadows, and the focus with them |
| disabled | 40 % (`opacity-disabled`) |
| loading | a skeleton, never a spinner where a skeleton fits |
| running | a pulsing dot |

Six states on every interactive component: default, hover, active, focus-visible, disabled,
loading. Four states on every list page: loading skeleton, empty, error-with-retry, content.

**Motion**: three durations — `duration-fast` 120 ms for a state change, `duration-base` 200 ms
for a container, `duration-slow` 320 ms for a page-sized change — one easing in
(`ease-standard`) and one out (`ease-exit`, 2.1). A drawer travels 24 px, a toast 8, a menu 4
(`--motion-*`). No bounce, no parallax. **Reduced motion** removes every movement and keeps the
fades: travel distances become 0, no duration exceeds 120 ms, a loop plays once and rests, a
spinner stands still — the state stays visible, it only stops moving. Charts must switch their own
animation off (ECharts does not read the setting).

### Accessibility

A **skip link** (“跳到主要内容”) is the first thing Tab reaches on every page, on the skip tier.
The token CSS carries a **forced-colours layer**: Element Plus inputs and selects get a real
border and a Highlight outline (their edge and focus were shadows), floating layers a system
border, and selected / current / pressed states an underline, because forced colours remove
fills. Under **`prefers-contrast: more`** secondary text and every rule move one step towards the
text colour (`COLOR_ROLES_MORE_CONTRAST`, measured like the rest). Data colour that must survive
forced colours opts out with `data-forced-colors="preserve"`.

### Embedded

Inside the EviMed Vue shell (`?embed=1`, or the wujie container) the React shell renders its
content area only — no sidebar, no project rail, no shortcut sheet; the host draws those.

---

## Components

New UI uses the `components/ui/` primitives — Button, Input/Textarea, Card, SegmentedControl,
Disclosure, Drawer, ConfirmDialog, Toaster, ShortcutHelp — and `components/cards/` —
EmptyState, LoadError, Skeletons — rather than a hand-rolled box. Signature components:
`PageShell` / `PageHeader`, `RunStatusDot`, `InboxBell`, `QualityNotices` (SAFETY in the danger
tone with a shield and never folded, 必须修改 in amber, 提示 folded and quiet; no validator
sentence is ever primary text), `Disclosure` (the one collapse), `ConfirmDialog`
(`tone="danger"` for what cannot be undone, `primary` for a checkpoint; initial focus on 取消).

---

## Language and responsive behaviour

UI baseline language is **Simplified Chinese**; code, comments and commits are English, and
technical identifiers (URLs, enum values, model ids) stay as they are. Map every server enum,
status and error code to Chinese before it reaches the screen (`labelFor`, `webErrorMessage`,
`errorCodeMessage`); never render a raw `Error.message` — ESLint rejects the
`instanceof Error ? … : String(…)` shape.

Breakpoints are Tailwind's (`sm 640` · `md 768` · `lg 1024` · `xl 1280` · `2xl 1536`). Below
1024 the sidebar becomes a drawer over the content; below 768 prose gets 16 px side padding and
tables scroll horizontally with the first column frozen. No page may scroll horizontally at
390 px. Figures inside a report keep a white background in both themes; printing mounts a print
copy of the report re-scoped to the light tokens, so “打印 / 存为 PDF” gives the report and its
facts on white paper, never the shell.

---

## Do's and don'ts

**Do** — ration colour (more than three coloured elements on a screen means one is wrong) · say
status three ways · use `border-control` for the visible edge of a control and `border-hairline`
for decoration · right-align numbers with `tabular-nums` · put identifiers in mono · keep a line
to 40 CJK characters · give every failure a next action · say what the user can do and what came
of it, in their words.

**Don't** — use red for anything but danger and unhandled work · make "needs checking" look like
an alarm · put a percentage or a progress bar on an agent run · use a gradient, a glow or a
coloured shimmer · put an opacity modifier on a token colour · put a shadow on a static card ·
let a badge cover the icon it sits on · render two adjacent rows with identical text · show raw
validator strings, enum codes, run ids or model names in the body of the UI · rely on hover to
reveal anything a keyboard user needs · explain how the system works on the page (a subtitle, a
hint under a card, “为什么入选”) · show the back office as text: 已交付, 核对 N 条, 用过 N 次,
起生效, token, 缓存命中, tok/s, an API's name, a project id.

---

## Changing something

**Free**: spacing within the scale, row density, which container a page uses, icon choices within
lucide.

**Needs review**: a new colour token; a change to a ramp's lightness ladder; a new blocking visual
state; a fourth coloured element on a screen that already has three.

**Never without measuring**: contrast. The figures here and in the generated CSS come from the
WCAG 2.1 relative-luminance formula. Re-measure, never estimate.

**Three places at once**: the chart series (`@evimed/design-tokens`' `CHART_SERIES`,
`packages/shared`'s `CHART_PALETTE_*`, `openscience.mplstyle`), with adjacent-pair ΔE re-measured
(the floor is 15; the current order is ≥ 22 in both schemes).

**With a picture**: a component's look. `/__gallery` draws every primitive in
every state, overlays included; `pnpm gallery:shot` records it (`--theme dark`
for the dark reference, `gallery.dark.png`) and `pnpm gallery:check` fails when
more than 0.5% of pixels move. The CI job `gallery` runs both themes against a
`vite preview` of a build made with `VITE_EVIMED_GALLERY=1`, on Ubuntu 24.04
with fonts-noto-cjk — the conditions the references are recorded under — and
keeps the photographs that did not match. Changing a component therefore means
looking at the new image and re-recording both, which is a review rather than a
surprise three pages later.

**One place, then regenerate**: everything else. Edit `packages/design-tokens/src/index.mjs`, run
`pnpm tokens:build`, bump the version and `record-release` (see above), run `pnpm test:tokens`
and `pnpm --filter @ai4s/web exec vitest run src/app/designTokens.test.ts`.

## Known gaps

- `max-w-content-full` and `text-ui-sm` are aliases, not errors, until the page rewrites drop
  their call sites. The ESLint serif ban stays scoped to the primitives on purpose now: the serif
  is a page's brand moment, so the ban is where a button lives, not everywhere.
- The kernel frame's own geometry (radii, spacing) has no token family upstream; the little of it
  the shell touches lives in a stylesheet pinned to the kernel version. Only colour and type
  cross through `overrideTokens`.
- Chart typography inside matplotlib-rendered figures is not covered by this file.
- The kernel frame receives the 2.1 sans stack through `overrideTokens` but not the punctuation
  face's `@font-face` (it is another document); there the name is skipped and quotes fall to
  Inter until the frame's stylesheet carries the face too.
- ECharts does not read `prefers-reduced-motion`; the chart host has to set `animation: false`
  itself (spec §9.5).
- `CHART_COLORS.own` has one value for both themes, and `contrast.mjs` measures only the rival
  greys. In dark, our line `#0a5dc1` is 2.76:1 on a card (`#161b21`) and 2.97:1 on the canvas,
  under the 3:1 a graphic needs, although spec §32.4 gives the dark theme `brand-400` (the dark
  accent `#5f97e0`, 5.76:1). Every trend chart shares this — 循证 GEO's and the capsule's growth
  line. The fix is a dark `--chart-own` in the table plus a measured pair in `contrast.mjs`: a
  token change, so a version bump and regenerated artifacts.
- The DTCG files are validated structurally by the package test, not yet against the official
  2025.10 JSON Schema (it is not vendored, and CI does not fetch).
- The reader's print copy is mounted on `beforeprint`; a headless PDF renderer that does not fire
  that event prints the shell unless the event is dispatched first.
