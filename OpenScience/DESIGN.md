# EviMed design system

**One product, one surface.** The shell and the embedded kernel conversation sit in the same
window, so they obey the same table. Colour already crossed that boundary; type and geometry
did not, and the seam was visible in a screenshot. **The shell conforms to the kernel**, not the
other way around.

**The table is `packages/domain/src/designTokens.mjs`, and nowhere else.** Three consumers read
it and none of them restates it:

| Consumer | How it reads the table | What keeps it honest |
|---|---|---|
| `apps/web/src/index.css` | a generated block between two markers, written by `pnpm tokens:css` | `designTokens.test.ts` regenerates and compares byte for byte |
| `apps/web/tailwind.config.js` | imports `@evimed/domain/design-tokens` directly | the same test asserts each scale equals the module's |
| `packages/harness-port/src/runtimeUiTheme.mjs` | `kernelThemeTokens()` → `ctx.theme.overrideTokens` | the same test asserts the accent, the canvas and the sidebar grey |

Changing a value means editing the module and running `pnpm tokens:css`. Editing the CSS or the
Tailwind config instead is caught by the test, which is the point: the shell and the frame were
two hand-maintained tables, and "change it in both places" is an instruction, not a mechanism.

---

## Colour

One accent — **循证青 `#00756b`** — one cool neutral ramp, four semantic ramps. White on the
accent is 5.59:1, against 4.23:1 on the kernel's own blue, which is why the frame takes ours.

### Roles

| Role | Light | Dark | What it is |
|---|---|---|---|
| `bg` | `#ffffff` | `#14181a` | the page. White, as the conversation is |
| `surface` | `#ffffff` | `#1d2225` | card, dialog, menu, popover |
| `surface-1` | `#f8f8f9` | `#1d2225` | the one grey step: sidebar, table header, inset track, code block |
| `surface-2` | `#f0f1f2` | `#272d30` | hover, the neutral selected row, a skeleton bar |
| `scrim` | `rgba(20,24,26,.32)` | `rgba(0,0,0,.56)` | behind a dialog or drawer |
| `border-hairline` | `#dfe2e4` | `#3a4044` | decoration: separators, a card's edge |
| `border-faint` | `#e9ebed` | `#292f32` | the quietest rule, inside a list |
| `border-control` | `#8b9195` | `#646c71` | the visible boundary of a control — 3.19:1 (WCAG 1.4.11) |
| `text` | `#242628` | `#f0f1f2` | body and headings, 15.19:1 |
| `text-2` | `#4c5154` | `#c8cdcf` | secondary lines, 8.04:1 |
| `text-3` | `#606669` | `#acb2b5` | metadata, 5.83:1 — **nothing lighter carries text** |
| `accent` | `#00756b` | `#63c5b9` | primary action, focus ring, selected row, the ✓ verified mark |
| `accent-soft` | `#f0fbf9` | `#004841` | selected row background, the verified chip. Never text |
| `accent-pressed` | `#005e56` | `#98dbd2` | the pressed state of an accent surface |
| `accent-strong` | `#005e56` | `#98dbd2` | text on `accent-soft`, 7.26:1 |
| `ok` `warn` `error` `info` | 700 step | 300 step | **status only**, always beside a shape and a word |

Every role has its `-soft` background; `danger`, `warn` and `accent` also have a `-strong` text
colour for use on it. The retired names `border`, `border-strong` and `muted` are aliases of
`border-hairline`, `border-control` and `text-3`; use the new names in new work.

### Rules

- **Red is for danger and unhandled work.** Clinical-safety findings, destructive actions,
  errors, the unread badge. Nothing else.
- **"Needs checking" is amber, never red.** A claim awaiting verification is not a clinical alarm.
- **`ok` is not the verified mark.** A verified claim is the brand colour, on purpose.
- **Links are not the brand**, so a page full of citations never drowns the primary button.
- **Every status is said three times** — colour, shape, words. Red and green mean opposite things
  in a Chinese market chart, and one reader in twelve cannot tell them apart at all.
- **No colour outside the table.** `designTokens.test.ts` fails on a hex literal or a colour
  function anywhere in `src/`, outside a named list of surfaces where colour is content (a
  rendered Office document, a fixed-dark scientific canvas).
- **No opacity modifier on a token colour.** `bg-accent/10` generates no CSS at all — the tokens
  are `var()` colours. Use the `-soft` / `-strong` partner. ESLint rejects the modifier.

### Run states and charts

Five run states, one rule (`runState`), one component (`RunStatusDot`): running (pulsing circle,
info), delivered (filled circle, brand), delivered with an open verdict (diamond, warn), not
delivered (square, danger), cancelled (hollow circle). All ≥3:1 as graphics, the word always
printed beside them.

Eight categorical chart slots in a fixed order, never cycled, shared with `@ai4s/shared`'s
`CHART_PALETTE_*` and `runtime/skills/core/publication-figures/openscience.mplstyle`. **Change
all three together and re-run the dataviz validator.** The order is the colour-vision mechanism.
Aqua, yellow and magenta are under 3:1 on white, so a chart using them carries direct labels or a
table view; past three series in a scatter, fold to 「其他」 or facet. Gridlines are the hairline,
axes the control border.

### Theme

Three-way (`light` / `dark` / `system`), as `data-theme` on `<html>`, set before the first paint
by `public/theme-init.js` and kept live by `ThemeProvider`. Each block sets `color-scheme`, so
scrollbars, a select's list and date pickers follow. The dark theme points the same role names at
*different steps* — it is never the light set inverted. Never hardcode white on an accent
surface: use `text-accent-fg` / `text-error-fg`.

---

## Type

**One sans stack. No serif anywhere in the chrome.**

```
Inter, system-ui, "PingFang SC", "HarmonyOS Sans SC", MiSans, "Microsoft YaHei",
"Noto Sans CJK SC", sans-serif
```

Latin faces lead so numbers, DOIs and identifiers keep the metrics the scale was measured
against; then every Chinese face a reader's OS might carry — without named CJK faces Windows
falls to the bitmap-hinted SimSun. Mono (`JetBrains Mono`, falling back to the Chinese sans
faces) is for identifiers compared character by character: DOI, PMID, NCT, run id.

`font-serif` survives only as an alias of the sans stack, so a page nobody has migrated renders
in it rather than falling back to the browser's Georgia. ESLint rejects the class in
`components/ui`, `components/layout` and `components/cards`; the ban widens to `src/**` once the
page rewrites have dropped their call sites.

### The six sizes

12 / 13 / 14 / 16 / 20 / 24. The set is closed — a seventh is a defect, and the test says so.

| Rung | Size / line | What it is |
|---|---|---|
| `badge` | 12 / 1 | a count inside a pill |
| `meta` | 12 / 1.5 | the densest metadata: timestamps, counts, units |
| `caption` | 13 / 20px | captions and secondary one-liners |
| `ui` | **14 / 22px** | interface text, chat, list rows, controls — the default |
| `body` | 16 / 1.75 | report prose and the reading column |
| `wordmark` | 16 / 1.3 | the EviMed lockup in the sidebar |
| `title` | 20 / 1.3 | every page H1 |
| `display` | 24 / 1.3 | the home hero, the login page, a full-page empty state |

Weights **400 / 500 / 600**, nothing else. No `letter-spacing` and no `uppercase` on Chinese —
tracking breaks the character grid. Mixed-script spacing is the browser's job (`text-autospace:
normal` on the body, `no-autospace` on code and identifiers), never a typed space: a typed one
would differ, byte for byte, from the quotation it copies. Tables use tabular numbers.

`ui-sm` is retired (13 and 13.5 px were one rung half a pixel apart) and renders as `ui`.

---

## Space, containers, radii, heights

**Base 4. Six steps: 8 / 12 / 16 / 24 / 32 / 48.** Card padding 16, grid gap 12, page gutter 24,
section gap 32.

### Containers — a page has one left edge

| Name | Width | For |
|---|---|---|
| `max-w-content-narrow` | 560 | settings, forms |
| `max-w-content` | **748** | the reading column: conversation, report prose, the inbox |
| `max-w-content-wide` | 1000 | catalogues, ledgers, the evidence matrix |
| `max-w-content-full` | *retired* → 1000 | an unmigrated call site converges here |

Sidebar 280, collapsed 56 — the kernel's constants.

**Use `PageShell`.** It puts the title, the description, the actions and the body inside the same
`mx-auto max-w-…` box, because three pages shipped with five different left edges (327 / 356 /
388 / 440 / 461 px) when each page chose its own. A page that must lay itself out takes
`width="full"` and still shares the gutter; it does not open a sixth container.

### Radii

8 controls and rows (bare `rounded`) · 12 cards and popovers (`rounded-card`) · 16 panels and
dialogs (`rounded-panel`) · 24 the composer (`rounded-composer`) · `rounded-full` chips. A
control nested inside another wears the outer radius minus the padding (a segment inside an 8 px
track is 6).

### Heights

32 controls · 28 chips and in-composer tags · 36 list rows · 44 nav and tab bars · **40 for a
form's primary button and nothing else** · icons 16 inline / 20 in the chrome. Minimum hit area
24×24 CSS px (WCAG 2.2 SC 2.5.8); 32×32 for chrome icon buttons.

`Button` sizes map onto that: `sm` 28, `md` 32 (the default), `lg` 40. `Input` and `Textarea` are
32 and 8 px round.

---

## Surfaces, states, motion

**Flat.** Structure is 1 px hairlines and the surface ladder. A static card has **no shadow** —
its border is its whole edge. Only what genuinely floats casts one: `shadow-pop` (menus,
popovers, toasts), `shadow-modal` (dialogs, drawers). No gradients, no tinted cards, no coloured
icon tiles, no sparkles, no shimmer. A list beats a wall of cards.

**States**, the same everywhere:

| State | What it is |
|---|---|
| hover | `surface-2` |
| selected | `accent-soft` |
| focus | a 2 px `accent` ring at 2 px offset (global `:focus-visible`; text fields signal with the border instead) |
| disabled | 40 % |
| loading | a skeleton, never a spinner where a skeleton fits |
| running | a pulsing dot |

Six states on every interactive component: default, hover, active, focus-visible, disabled,
loading. Four states on every list page: loading skeleton, empty, error-with-retry, content.

**Motion**: two durations — `duration-fast` 120 ms for a state change, `duration-base` 200 ms for
a container — and one easing (`ease-standard`). No bounce, no parallax.
`prefers-reduced-motion` collapses everything to an instant; a loading indicator still renders,
it just does not move.

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
copy of the report re-scoped to the light tokens, so 「打印 / 存为 PDF」 gives the report and its
facts on white paper, never the shell.

---

## Do's and don'ts

**Do** — ration colour (more than three coloured elements on a screen means one is wrong) · say
status three ways · use `border-control` for the visible edge of a control and `border-hairline`
for decoration · show odometers (elapsed, sources, claims checked, cost) for long work ·
right-align numbers with `tabular-nums` · put identifiers in mono · keep prose to 748 px · give
every failure a next action.

**Don't** — use red for anything but danger and unhandled work · make "needs checking" look like
an alarm · put a percentage or a progress bar on an agent run · use a gradient, a glow or a
coloured shimmer · put an opacity modifier on a token colour · put a shadow on a static card ·
let a badge cover the icon it sits on · render two adjacent rows with identical text · show raw
validator strings, enum codes, run ids or model names in the body of the UI · rely on hover to
reveal anything a keyboard user needs.

---

## Changing something

**Free**: spacing within the scale, row density, which container a page uses, icon choices within
lucide.

**Needs review**: a new colour token; a change to a ramp's lightness ladder; a new blocking visual
state; a fourth coloured element on a screen that already has three.

**Never without measuring**: contrast. The figures here and in the generated CSS come from the
WCAG 2.1 relative-luminance formula. Re-measure, never estimate.

**Three places at once**: the chart series (`designTokens.mjs`'s `CHART_SERIES`, `packages/shared`'s
`CHART_PALETTE_*`, `openscience.mplstyle`), with the dataviz validator re-run.

**One place, then regenerate**: everything else. Edit `packages/domain/src/designTokens.mjs`, run
`pnpm tokens:css`, run `pnpm --filter @ai4s/web exec vitest run src/app/designTokens.test.ts`.

## Known gaps

- `font-serif` and `max-w-content-full` are aliases, not errors, until the page rewrites drop
  their call sites; the ESLint serif ban is scoped to the primitives until then.
- The kernel frame's own geometry (radii, spacing) has no token family upstream; the little of it
  the shell touches lives in a stylesheet pinned to the kernel version. Only colour and type
  cross through `overrideTokens`.
- Chart typography inside matplotlib-rendered figures is not covered by this file.
- No motion spec for streaming text — buffering cadence is an engineering decision.
- The reader's print copy is mounted on `beforeprint`; a headless PDF renderer that does not fire
  that event prints the shell unless the event is dispatched first.
