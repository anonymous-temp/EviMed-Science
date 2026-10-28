# EviMed design system

**One product, one surface.** The shell and the embedded kernel conversation sit in the same
window, so they obey the same table. Colour already crossed that boundary; type and geometry
did not, and the seam was visible in a screenshot. **The shell conforms to the kernel**, not the
other way around.

**The table is `packages/design-tokens/src/index.mjs`, and nowhere else.** It became its own
package (`@evimed/design-tokens`) on 2026-09-26, when the fusion gave it a consumer in another
repository: the Vue shell of EviMed cannot import a module out of `@evimed/domain`'s source tree.
The old `@evimed/domain/design-tokens` path is gone; import the package. The full specification,
[Frontend Design System v3.2](docs/FRONTEND_DESIGN_SYSTEM.md) (2026-10-27), owns the principles and
the acceptance cases; this file holds the engineering rules and maps implementation and component
adoption, and it defers to the specification and to the table. Component JSDoc plus the gallery and
composition fixtures own each implemented component's details; module plans own evolving product
scope; old audits remain dated evidence.

## Product and brand

EviMed Science is a general-purpose agent platform with a medical professional layer. General work
stays general; the medical method and labels enhance relevant work and are never an entry
requirement for other work. Preserve one native composer, project identity, existing permissions and
usable results. No design rule introduces a clinical delivery veto or deletes usable research, and
no ordinary task becomes subject to a clinical delivery gate because of this design language.

The owner's October 26 direction supersedes the blue palette of 2.x: **warm paper, restrained
terracotta, and an ink EviMed mark** (near-black in the light theme, light paper ink in the dark).
The independent `brand-ink` role keeps an action-accent change from recolouring the logo. The
reviewed decision fixes near-black for identity and adopts deep navy for information semantics, not
for another general action accent.

## Token authority and generated consumers

Token package **3.0.0** is the implemented token set; the current specification is **3.2**
(2026-10-27), whose DS22 adoption remains pending its execution receipts (the token package does
not change for a composition-only revision). The 2.2.0 blue palette and the
2.3.0 warm-brand candidate are historical baselines, not the current source identity. Moving the
brand and the status roles is a major version; a compatible added role is a minor and a tuned value
within a role a patch. The specification, this file, `AGENTS.md`, the token package and release
metadata, the generated consumers, the brand assets and the consumer pins and readbacks reach a
reviewed change together; publishing, merging to main and deploying are separate stages with their
own receipts, and the external Vue shell adopts the new package and artifacts separately.

Seven artifacts are generated from the table, and no consumer restates a value:

| Artifact | Who reads it | What keeps it honest |
|---|---|---|
| the block in `apps/web/src/index.css` (`pnpm tokens:css`) and `dist/tokens.css` | the React shell; the Vue shell links the file | `designTokens.test.ts` regenerates and compares byte for byte |
| `dist/tailwind-preset.js` | both `tailwind.config.js` files extend it | the same test asserts each scale equals the table's |
| `dist/element-plus.css` | the Vue shell, after Element Plus's own sheet | every derived `--el-color-primary-light-N` is written out, so no shade of the retired palettes survives |
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
and "change it in both places" is an instruction, not a mechanism. Never tune a generated consumer
to adjust a colour; add a semantic role only for a real reusable purpose.

**The version moves with the bytes.** `packages/design-tokens/src/release.json` records the digest
of every artifact the current version shipped. When an artifact changes and the version does not,
`pnpm tokens:check` and the package test fail: bump `package.json` and `DESIGN_TOKENS_VERSION`
together (a tuned value is a patch, a new token a minor, a removed or re-meant one a major), then
run `pnpm --filter @evimed/design-tokens record-release`, which refuses to re-record an unchanged
version. The Vue shell pins a version, and a pin that stays equal while values move cannot see
drift (fusion audit F-G3). Do not change the upstream kernel version merely because the token
version changes.

`scripts/build/brand-assets.mjs` derives the SVG identity, the PWA metadata and the serialized
native mark identity from the token roles and the shared EviMedMark path;
`scripts/build/rasterize-brand-icons.mjs` creates the installation PNGs from those SVGs. Keep the
sources deterministic and record the actual rendering: a stale PNG is not fixed by updating its
source alone, and a successful local build does not update an installed PWA, cached native
resources or another repository's pinned theme.

The native shell and its theme can be disabled independently. The mark must stay legible when the
optional EviMed theme body is off, using the native primary-text colour as the fallback. Do not
relax browser isolation to synchronise appearance.

---

## Colour

**Warm paper, restrained terracotta, an ink mark** (token package 3.0.0). One action accent —
**terracotta `#a34427`** in the light theme, `#d98c6b` in the dark — one warm-paper neutral ramp, a
navy information family, four semantic ramps (danger, warn, ok, info) and a closed set of data
colours. White on the accent is 6.15:1. The EviMed mark and wordmark wear their own `brand-ink` role
(`#24211e` light, `#f7f5ef` dark), so the logo is never an action-accent badge. The 循证蓝 `#0a5dc1`
of 2.x retired on 2026-10-26 (it had replaced 循证青 `#00756b` on 2026-09-26): blue now survives
only where it is data — the scientific categorical series, the diverging scale, the study-type
badges — and as the navy of information. A local build does not refresh cached native resources or
installed icons; those need release verification.

Every contrast figure below is **recomputed at build time** by
`packages/design-tokens/src/contrast.mjs`, which fails the build on a shortfall — in both themes,
under the more-contrast layer too, and for the rival greys a chart draws. The comparison is
unrounded: a pair at 4.4995 does not pass a 4.5 floor. The notes used to be typed by hand and went
stale silently; two of them were already fiction when the check first ran, and eight more by
2026-10-08 — so the build now reads back every figure a note quotes ("N on the page", "N on the
sidebar", "white on it N", "on <role>: N") and fails on a stale one. 57 role rules and 16 data
rules, each × light / dark × standard / more contrast. Token validation does not cover every
rendered page, fixed scientific canvas or overlay; a pass is not a claim that all of them pass.

### Roles

Readback of the 3.0.0 table; `src/index.mjs` is the authority and this table is never a second source.

| Role | Light | Dark | What it is |
|---|---|---|---|
| `bg` | `#f7f5ef` | `#171512` | the page — warm paper; the card is lighter than the page, so it has an edge without a border |
| `surface` | `#fffdf8` | `#211e1a` | card, dialog, menu, popover, the reading column |
| `surface-1` | `#f2efe7` | `#211e1a` | the one grey step: sidebar, table header, inset track, code block |
| `surface-2` | `#ebe7de` | `#2a2621` | hover, the neutral selected row, a skeleton bar, a secondary button |
| `surface-3` | `#e3ded3` | `#342f29` | the hover and pressed step of something already on `surface-2`; the deepest paper surface |
| `scrim` | `rgba(36, 33, 30, 0.32)` | `rgba(0, 0, 0, 0.56)` | behind a dialog or drawer |
| `border-hairline` | `#e3ded3` | `#342f29` | decoration: separators, a card's edge |
| `border-faint` | `#ebe7de` | `#2a2621` | the quietest rule, inside a list |
| `border-light` | `#d6d0c4` | `#342f29` | a pill or segment whose ground already separates it |
| `border-control` | `#8c8173` | `#81766a` | the visible boundary of a control — 3.50:1 on the page, 3.32:1 on the sidebar (WCAG 1.4.11). Quiet borders are decoration: 3:1 is asked of controls, not of every separator |
| `text` | `#24211e` | `#f2eee6` | body and headings, 14.69:1 |
| `text-2` | `#494239` | `#d1c8ba` | secondary lines, 9.08:1 |
| `text-3` | `#686157` | `#a99e8f` | metadata, 5.61:1 (5.32:1 on the sidebar) — **nothing lighter carries text**, and a warm ground never excuses brown low-contrast metadata |
| `title-ink` | `#24211e` | `#f2eee6` | the title of a list row that opens a document (前沿动态's cards): since 3.0.0 the full `text` role — ink, neither the accent nor a tint (read-state muting is separate: a read row steps down to `text-2`). **List titles in title-ink; hover accent; read text-2** |
| `brand-ink` | `#24211e` | `#f7f5ef` | the EviMed mark and wordmark, 14.69:1 on the page; independent of the accent |
| `text-graphic` | `#9b9387` | `#645c52` | icons and rules only, 2.78:1 — **never a word, and never a status** (a mark that says something wears a `dot-*` or `border-control` step; the build fails a `dot-*` that borrows this grey) |
| `accent` | `#a34427` | `#d98c6b` | primary action, link, the focus ring of buttons and links, selected row, and "our" chart series — 5.64:1 on the page |
| `accent-fg` | `#ffffff` | `#171512` | the label on an accent or error surface (`text-accent-fg` / `text-error-fg`) |
| `accent-soft` | `#fbefe8` | `#321c16` | selected row background. Never text |
| `accent-pressed` | `#8d3922` | `#e3a385` | the pressed state of an accent surface |
| `accent-strong` | `#71301f` | `#e3a385` | text on `accent-soft`, 8.68:1 — **not used for text in the shell since 2026-10-17**: text on a pale ground is the accent (5.45:1), one accent for every link, mark and state, because a page is held to seven text colours (the hot list's three rank tones are the one place it is still written) |
| `ok` `warn` `error` | 600 step: `#1a6f44` `#925100` `#ad2f45` | 300 step: `#7cc0a0` `#e0b169` `#e58b9c` | **status only**, always beside a shape and a word; `danger` is `error`'s ramp |
| `info` · `info-soft` | `#18324d` · `#eaf0f5` | `#9bbbd5` · `#142330` | the navy information family: information notices and the running state. Never a second action accent |
| `verify-ok` · `verify-pending` | `#1a6f44` · `#925100` | `#7cc0a0` · `#e0b169` | the ✓ of a verified claim (= `ok`) and "needs checking" (= `warn`) |
| `focus` · `focus-input` | `#a34427` · `#24211e` | `#d98c6b` · `#f7f5ef` | the 2 px focus outline of a button or link (accent); of a text field (ink, = `brand-ink`) |
| `member-from` / `member-to` | `#f6d58e` → `#fbe7be` | `#7a6329` → `#5c4a1d` | the membership card's one gradient |

Every role has its `-soft` background; `danger`, `warn` and `accent` also have a `-strong` text
colour for use on it. The retired names `border`, `border-strong` and `muted` are aliases of
`border-hairline`, `border-control` and `text-3`; use the new names in new work.

### Rules

- **Red is for danger and unhandled work.** Clinical-safety findings, destructive actions,
  errors, the unread badge. Nothing else. Its crimson (`danger`) is a ramp of its own, told from
  terracotta by its word and icon as well as its hue; terracotta never stands for danger.
- **"Needs checking" is amber, never red.** A claim awaiting verification is not a clinical alarm.
  Amber means attention, not every paused or incomplete item.
- **A verified claim is green, not the accent** (3.0.0, DS02.a). `verify-ok` is the `ok` green in
  each theme; the ✓ means the named verification passed, never a general medical-safety guarantee.
  AI importance is not evidence certainty, and unmeasured safety is not zero risk.
- **One action accent.** Links wear it too (2026-09-23): a second hue for links was an accent on every
  screen. A primary button stands apart by being solid, not by hue. Terracotta is for an action, a
  link, a selected state or a focus ring — do not tint every title, badge or card with it.
- **Navy is information, never an action.** `info` carries information notices and the running
  state (`dot-running`), with a shape and words; it is not a second accent.
- **A text field focuses in ink, a button or link in the accent** (DS02.e). Input, Textarea,
  Select, SearchInput and editable field widgets use `focus-input`; the native frame's fields take it
  through the kernel theme mapping where the kernel supports it, and an unsupported field is an
  upstream gap reported through the seam, never a cross-origin patch. An error boundary and the
  focus ring stay recognisable together.
- **Popularity is neutral.** The frontier's new / rising tags are neutral ground and text with a
  word and a glyph; accent, warn and safety tones are never spent on popularity (DS02.h).
- **A comparison puts us in the brand and every rival in grey.** `CHART_OWN` is the accent per
  scheme (`#a34427` light, `#d98c6b` dark); `CHART_COLORS.rivals` is three greys, darkest for the
  highest rank — `#626a73` / `#737c85` / `#838c95`, 5.49 / 4.24 / 3.41:1 on white, every one a
  graphic a reader can see, on the dark canvas too. The own colour is at least 15 CIE76 from every
  rival in both themes (`cie76` in `contrast.mjs`, asserted by `chartPalette.test.ts` — computed, not
  claimed in a comment). At most one rival may take a colour, and only when the reader pins it. A
  chart of eight rainbow brands tells a reader nothing about which one is theirs, and that is what
  the GEO dashboard shipped. Our line is 2.5 px and every other 1.5 (`CHART_STROKES`). `CHART_SERIES`
  is a different contract — the scientific categorical palette — and never becomes the action
  palette.
- **Data with a midpoint is diverging**: `CHART_COLORS.diverging`, blue — light grey — orange,
  the two arms matched step for step in lightness, and `CHART_COLORS.missing` for a cell with no
  reading.
- **Certainty is a single-hue scale, never a traffic light.** Four steps of one hue. Low certainty
  is not harm, and red is reserved for safety.
- **Study types are a closed data exception.** `STUDY_TYPE_BADGES` (Meta 分析 / 系统综述, 随机对照
  试验, 指南, 说明书, 其他研究) keep their categorical colours, the label is always printed, and each
  foreground / background pair is measured; the blue of a synthesis names a study type, not
  information, safety or strength (DS02.g). A topic colour never becomes a clinical grade.
- **Accent text means one thing: it opens or does something** (the memory section's clickability grammar, owner 2026-10-27: 「分不出哪些可以点击
  哪些不能」). Measured on these tokens the accent is 5.64:1 on the page but only 2.6:1 against `text` and 1.61:1 against `text-2`, so colour alone
  cannot mark a link (WCAG G183). Hence: (1) a title, a name — a project's included —, a label or a number that opens nothing is ink (`text`,
  `title-ink`, `text-2`, `text-3`), and a selection is a ground (`accent-soft`), never accent text; (2) a link inside a sentence is underlined,
  always (`NoteParts`, a drawer's 「来源对话」); (3) a row or tile that goes to one place is pressed as a whole — hover `surface-2`, a focus ring and
  its mark at the end, › opens here, ↗ leaves the section (`ListRow` `leaves`, `StatTile` `whole`) — with its title in ink, and a row that cannot
  be pressed has neither the ground nor the mark; (4) a section's way out is one labelled link at the end of its header, accent, underlined,
  with ›; (5) an action is a `Button`, `secondary` (the grey ground) in the memory section — never bare accent text; (6) a switch is the only
  control of a row that is also pressed as a whole, and the two do not trigger each other. The marks of a picture (● ▲ ■ ◆ ✕) are graphics in the
  data colour, not words. `clickabilityGrammar.test.ts` holds (1), (2) and the bare accent button in the memory section's sources.
- **Restraint is the default; expression has a budget.** A reading page and a list page stay quiet.
  A page may spend **one brand moment** (a gradient, a serif headline, a hero), and charts and the
  32/40 metric rungs belong to data pages. Banning every expressive device is what made 循证 GEO
  look cheap, and un-banning them without a budget is how a product gets loud. **A list page carries no
  chart.** 记忆胶囊 had the one exception (2026-09-28, `CapsuleGrowth`, from 2026-10-07 in a 成长 tab): the owner's timeline of how
  the capsule grew. It drew the stock — a line that rose to 75 and fell to 42, under a heading that began on another day than its
  first point — and could not say what happened. It is gone (2026-10-17): what happened to the memories is the time view of the
  map, the weekly bars of 记下 / 合并 / 忘记 counted from the same events as the list under them, with the window's one slider in the
  card's header. **What the capsule gained since its first day is the one chart that came back (2026-10-23), as the first card of 总览**
  (`/app/memory/overview`, a data page of its own): a dot for each gain up to thirty in a lane for each kind that has any (记下 ●, 学会 ▲,
  资料 ■, 收下 ◆), weekly counts after that, counting gains only — what was replaced or forgotten is the time view's — and `?tab=growth`
  arrives at 总览. **Since 2026-10-27 the map is no tab of its own** — it was a dashboard, and a dashboard that is not the landing is a page nobody
  found: 总览 is the data page (template T4: toolbar, sentence, five tiles, 「变化」 — the chart above, now with 忘记 ✕ as its fifth lane —, 「关系与主题」
  when there are at least twelve memories and three relations or a topic grouping, and the table behind the charts, 「最近变化」), `/app/memory/map` goes
  to it with `explore=graph|topics`, `project`, `q`, `open`, `look`, `topic` and a 30- or 90-day `range` carried over, and its time, activity and dimension views
  (the radar's angle and area read worst of all, NN/g) are gone: the chart and the table say what happened. 总览 is the memory page's one picture; its
  four lists (关于你, 项目, 做法, 收到的) are lists and nothing else; no peer's memory page has a chart, so a chart on a list page needs an argument of this
  size. The relation graph and the topics draw in the accent, the warn amber and one grey, tell a mark's kind by shape and words; the knowledge base's graph follows the same grammar.
- **Every status is said three times** — colour, shape, words. Red and green mean opposite things
  in a Chinese market chart, and one reader in twelve cannot tell them apart at all.
- **No colour outside the table.** `designTokens.test.ts` fails on a hex literal or a colour
  function anywhere in `src/`, outside a named list of surfaces where colour is content (a
  rendered Office document, a fixed-dark scientific canvas, the study-type badges). Paper and
  figure previews and print output keep a meaningful light canvas even when the chrome around them
  is dark.
- **No opacity modifier on a token colour.** `bg-accent/10` generates no CSS at all — the tokens
  are `var()` colours. Use the `-soft` / `-strong` partner. ESLint rejects the modifier.

### Run states and charts

Five run states, one rule (`runState`), one component (`RunStatusDot`): running (pulsing circle,
navy information ink — `dot-running`), finished (filled circle, **green** — `dot-done`), finished with something
to check (diamond, amber), not finished (square, red), cancelled (hollow circle, grey). All ≥3:1
as graphics — measured on the canvas, on a card and on the sidebar, in both themes — the word
always printed beside them. The cancelled dot is `n-control` in both themes: it was
`text-graphic`'s own grey until 2.1.3.

Eight categorical chart slots in a fixed order, never cycled, shared with `@ai4s/shared`'s
`CHART_PALETTE_*` and `runtime/skills/core/publication-figures/openscience.mplstyle`. **Change
all three together and re-run the dataviz validator.** The order is the colour-vision mechanism.
Three slots are under 3:1 on white — **orange (slot 2) 2.97, yellow (slot 6) 2.45, light grey
(slot 8) 1.92** — so a chart using them carries direct labels or a table view; past three series
in a scatter, fold to “其他” or facet. Gridlines are the hairline, axes the control border. The
scientific categorical, diverging and heat scales keep their data meaning and did not move with the
brand.

### Theme

Three-way (`light` / `dark` / `system`), as `data-theme` on `<html>`, set before the first paint
by `public/theme-init.js` and kept live by `ThemeProvider`. Each block sets `color-scheme`, so
scrollbars, a select's list and date pickers follow. The dark theme points the same role names at
*different steps* — it is never the light set inverted. Never hardcode white on an accent
surface: use `text-accent-fg` / `text-error-fg`. Follow the system only in `system` mode — an
explicit preference wins — and test a switch while a menu, a dialog, a table's overflow cue, a graph,
a selected row and a scientific preview are open: a component never caches an absolute RGB that
outlives the surface or theme that gave it meaning (overflow fades read the live semantic surface).

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
authority from the journals and every one of them is set in a serif, so the **standalone wordmark**, the
**home headline** and the **title of a document** wear one — and nothing else does, because a
serif on a button reads as an old intranet. Three rungs carry the family themselves
(`text-wordmark`, `text-hero`, `text-doc-title` — a rule in the generated CSS binds it, since
Tailwind's size scale cannot), so a page never names `font-serif` to get it. A report's title is
`text-doc-title`; its sections are 18 / 600 in the sans.

The navigation lockup is the compact exception (owner review, 2026-10-25): the full EviMed Science name uses the sans `text-ui` / 600 rung on one line. The notification control belongs with the account actions, leaving the brand and sidebar collapse control together even at the minimum sidebar width.

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
was protecting. A **data page** — one that sets figures at the metric rung or has two levels of
heading (循证 GEO's and 虚拟临床研究's tabs, the model records) — uses at most **five** (owner,
2026-10-19), and its leading figure is at 32 like the rest: the 40 px `metric-lg` beside the 32 px
ones was a sixth pair. The release walk holds both (`typePairs` in the `data` and `geo` budgets of
`scripts/ops/page-templates.json`).

| Rung | Size / line | What it is |
|---|---|---|
| `badge` | 12 / 1 | a count inside a pill |
| `meta` | 12 / 1.5 | the densest metadata: dates, journals, counts, legends |
| `caption` | 12 / 20px | captions and secondary one-liners (a line in a row) |
| `compact` | 13 / 20px | held in reserve for a dense grid whose 12 px cells would be too small; nothing sets it since R19.2 — a control is `ui`, a table head and a heat cell `caption` |
| `ui` | **14 / 22px** | interface text, chat, list rows, controls — the default |
| `body` | 16 / 1.75 | report prose and the reading column |
| `reading` · `reading-lg` · `reading-xl` | 16 · 18 · 20 / 1.8 | the frontier reader (2026-10-23): an article's text is `reading` below 1280 px and `reading-lg` from there (`text-reading xl:text-reading-lg`), its AI 导读 one step above (`reading-lg` → `reading-xl`), on the reading measure (`max-w-measure-body xl:max-w-read`, 40 CJK a line) — the scale's own sizes at a long text's line height, a responsive pair rather than a tenth size |
| `wordmark` | 16 / 1.3 · serif | standalone brand lockups; the sidebar uses the compact sans `ui` rung |
| `section` | 18 / 26px | a section heading inside an answer or a report |
| `heading` | 20 / 28px | a card heading on a data page, a document title in a preview pane |
| `title` | 24 / 32px | every page H1 |
| `doc-title` | 24 / 34px · serif | the title of a report, article or evidence card |
| `display` | 24 / 1.3 | the login page, a full-page empty state |
| `metric` | 32 / 40px | a KPI number — **data pages only** |
| `metric-lg` | 40 / 48px | in the closed set, set by no page since 2026-10-19 (a leading KPI is 32 like the rest) |
| `hero` | 40 / 50px · serif | the home headline — one per product |

Sizes reach the browser in **rem** (2.1), so a reader who raised the browser's default font size
gets a larger interface; the table itself speaks px.

Weights **400 / 500 / 600**, nothing else — and Chinese hierarchy uses **400 and 600 only**:
Microsoft YaHei has no 500, so a 500 title renders at 400 on Windows (an unread list row is 600
for that reason). Since R19.2 nothing in the product is set at 500 — ESLint bans `font-medium` (and
`font-bold`) in every component, and `copyRules.test.ts` reads every string — and the two weights
are given by role: **600** is a heading, a name that must be told from the text around it, an
unread row, a figure that is the point of a line; **400** is everything
a ground, a rule, a colour or a position already says — a button, a tab, a step, a chip, a
segment, a navigation item (the current one too), a link, a table head in the muted colour, a flagged value on a warm ground. Weight is
spent only at 14 px and above; a 12 or 13 px line is 400 and says the rest in colour.

No `letter-spacing` and no `uppercase` on Chinese — tracking breaks the
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
`max-w-measure-body` (640 at 16 px) — a count of Chinese characters, not 40 Latin `ch` units. No list
is wide enough to lift it. Ranks, scores, heat and times are set in tabular numbers.

Operating screens do not borrow poster ratios: a title 2.5 times the body or a fixed 40 % whitespace
quota are not acceptance rules. The per-template type budgets are guardrails, not a reason to erase
a unit, a label or a line of useful guidance. A document's own title stays discoverable in full —
a list's two-line truncation is not automatically the reader-title rule. Title, lead, added context
and source each answer a different reader question; the same finding is not repeated in the title,
the lead, the first fact row, the quotation and the interpretation without new value.

---

## Space, containers, radii, heights

**Base 4. Ten steps: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64** — 8 inside a group, 16–24 between
groups, 32–48 between sections. Card padding 16, grid gap 12, page gutter 16 below 768 and 24 from there. Separate by space
first, then a quiet ground, and draw a line last.

### Containers — a page has one left edge

**Three columns, and a page uses exactly one for its title and its body both.**

| Name | Width | For |
|---|---|---|
| `max-w-read` | **720** | an answer, a report, an article, an evidence card |
| `max-w-page` | **1040** | a list: tools, the frontier feed, capsules, the knowledge base, settings |
| `max-w-wide` | **1200** (1280 at ≥1440) | a dashboard: GEO, the evidence zone |
| `max-w-measure` / `max-w-measure-body` | 560 / 640 | a paragraph's line length |
| `max-w-content` | *retired* → 720 | no call site is left and ESLint refuses it; the preset keeps the name for the Vue shell until a major release |
| `max-w-content-narrow` | 560 | a form inside a drawer |
| `max-w-content-wide`, `-full` | *retired* → 1040 | the same: no call site, refused by ESLint |

The single 960 column of 2026-09-23 is gone: it made a reading page too wide and a dashboard too
narrow, and a dashboard squeezed into a document column is the structural half of why 循证 GEO
looked cheap. `max-w-full` is deliberately **not** a token — a blanket map of the container table
would redefine Tailwind's own `max-w-full` as a pixel width.

Sidebar 280, collapsed 56 — the kernel's constants. A saved user width of the sidebar or a panel is
legitimate, not a defect, and is clamped to the current viewport.

**Use `PageShell`** (`width` `read` · `page` · `wide` · `full`; the reading pages — the evidence card
and the event — use `read`). It puts the title, the actions and the body inside the same box, because
three pages shipped with five different left edges (327 / 356 / 388 / 440 / 461 px) when each
page chose its own, and on 2026-09-23 the inbox still sat 126 px right of the rest. A page that
must lay itself out takes `width="full"` and still shares the gutter: **16 px below 768, 24 from
there** (`px-4 md:px-6`), so the body is 358 wide at 390 px. A page that draws its own column (the
answer page, the handoff page) wears the same two classes.

**A page header is one line**: the title, optionally a grey count or update time and the page's
scope (`scope`: a `ScopeMenu`), and at the right at most one primary button and two icon buttons or
a search box. **No subtitle** — nothing under the title explains how the system works; `PageHeader`
has no place to put it. The title takes the room the actions leave (two lines at most) and the
actions never move under it; a reader's title (`titleVariant="document"`) is the serif
`text-doc-title`.

### Radii

6 tags (`rounded-tag`) · 8 controls and rows (bare `rounded`) · 12 cards and popovers
(`rounded-card`) · 16 dialogs, drawers and panels (`rounded-panel`) · 24 the composer
(`rounded-composer`) · `rounded-full` pills. A chart's bars and cells take 2–4 and are not
counted. One border width (1 px) and one border colour; at most one bordered container deep, and
no rule under a card's title.

### Heights

**28 small · 36 the default · 44 for a primary action** · a tag is 22 — the token heights
`h-sm` / `h-control` / `h-form-primary` / `h-tag`, not steps of the spacing scale (a skeleton that stands
in for a control takes the same token, so nothing jumps when it arrives). Controls on one line share a
height. Written in the scale on purpose: a menu item (`h-8`, 32), a tab (`h-10`, 40), and the
`min-h-6` floor that keeps a text link a 24 px target (WCAG 2.5.8). Icons are **16 inline / 20 in the chrome**, one stroke (1.5, read from
`--icon-stroke` on `svg.lucide`; it splits the difference between the kernel's 1.75 and EviMed's
hand-drawn 1.4). Minimum hit area 24×24 CSS px (WCAG 2.2 SC 2.5.8); under a finger
(`coarse:`, `pointer: coarse`) an `IconButton` and a filter chip widen their hit area to 40 with an invisible box and keep
their drawn size. A table or grid that scrolls sideways (`DataTable`, `HeatGrid`, a Markdown table) freezes its row-header
column and is a named, focusable region while it overflows (`ScrollRegion`). Validate the actual 24 px
AA target or its exception; 44 px is a preferred touch target, never mislabelled a universal AA
minimum, and a hover-only control also appears on focus and has a touch path.

`Button` sizes map onto that: `sm` 28 with 14 px text (13 until R19.2), `md` 36 (the default), `lg` 44.
`IconButton` is 28 in a row and 36 in a header. `Input`, `Textarea` and `SearchInput` are 36 (28
with `size="sm"` in a table, toolbar or filter row) and 8 px round — except that the 28 px search in a
toolbar row is a pill of 14 px text on the grey ground, the look of a selected chip, so the row's filled
controls are one kind. Filter chips are 28 high with 14 px text.

### Layers, opacity, timing (2.1)

Stacking is by named tier (`z-*`), never by a larger number: page 0 · sticky 10 · drawer 40 ·
modal 50 · popover 60 (a menu opened in a dialog is still above it) · toast 70 · tooltip 80 ·
skip link 90. A numeric `z-10`…`z-50` or `z-[…]` is an ESLint error; `z-sticky` is also the small
lift of one thing over its sibling inside a component. Opacity is spent on a disabled control (`opacity-disabled`, 0.4), the scrim (a
colour role) and a dragged item (0.8), never on a colour's pale version. Tooltips show after
300 ms (at once on keyboard focus) and hide 100 ms after the pointer leaves — `Tooltip` reads
`TOOLTIP_DELAYS`; nothing uses the browser's `title` for an icon's name. Toasts stay 5 s, 10 s when they carry an action,
and an error stays until it is closed (`TOAST_DURATIONS`). Real progress is never animated from a timer.

### The component set (2026-09-23)

`components/ui/` holds the vocabulary a page is written in, and ESLint rejects a hand-made
bordered pill or bordered `<button>` outside it:

| Component | What it is |
|---|---|
| `PageShell` / `PageHeader` | the one column and the one-line header, no subtitle; and the **slots** a page is composed of — `scope`, `steps`, `activity`, `tabs`, `toolbar`, `headline` — which the shell renders in one fixed order, steps/tabs/toolbar in one sticky band (see 「页面结构」); a reading page adds `eyebrow` (the line over its title) and `aside` (a sticky right column from 1024 px whose top is the back row's, under the body below) |
| `Tabs` | a page's views: underlined tabs over a hairline; `trailing` puts the open view's controls (filters, a search box) at the row's right on the same hairline, dropping under the tabs below 640 px; the open tab is always scrolled whole into its row |
| `FilterChips` / `FilterChip` / `FilterSelect` | one row of quiet chips, 28 high and 14 px (no border; selected sits on grey, at the same weight — told by ground and colour, as a selected tab is), the rest in “更多 ▾”; `iconEnd` draws a mark a press lets go of after the words (「#肝细胞癌 ×」) |
| `Tag` | the metadata label: 22 px, 12 px text, 6 px corner, grey, no border; `safety` red |
| `Button` | `primary` (solid accent, one per view) · `secondary` (grey ground, no border) · `text`; `danger` only confirms a destruction |
| `IconButton` | 28 in a row, 36 in a header; the label is its name and its `Tooltip` |
| `Tooltip` | an inverse 12 px layer on `z-tooltip`: an icon's name or a truncated line's whole text; hoverable, Escape closes it, never the only place something is said |
| `navItemClasses` | a column of places — the sidebar's destinations, projects and conversations, 设置's sections, the knowledge base's rail: 36 high, 8 px padding and corner, `accent-soft` when current, at the weight of the others |
| `List` / `ListRow` | like things as rows, no box; the title is the row's target (600 when unread), at most two quiet actions and “⋯”, always visible. A row that can be pressed says so: hover `surface-2`, `selected` `accent-soft`, and a trailing mark the row draws itself (› opens a drawer or page, ⌄ expands in place, ↗ leaves); `trailing` text lets the press through. Numbers of one measure are `columns` under a `ListHeader` |
| `Panel` / `PanelRow` | a settings group: name outside, one box, label left and control right |
| `EmptyState` | an icon and one sentence; no button the header already has — or, in place of a button, the `reason` there is none. Carries `data-empty` |
| `Toolbar` | the one row of controls above the content they control: `views`, declared `filters` (select, chips, toggle, and `panel` — a chip that opens labelled groups of those, a group of chips one value or `multi` several, 「专科 ▾」), `search` (with `suggestions`: a list under the box), `summary`, `actions`. Below 640 px, and where a band's row runs out of room, everything but the `pinned` filters folds into one 「筛选」 chip that opens a **filter panel** — every dimension a labelled group of chips, toggles as switches — as a sheet from the bottom on a phone (「重置」, 「查看结果」) and a card under the chip on a wide screen; never a menu that stacks dimensions (owner, 2026-10-23). A `scroll` chip group gives way to its row by scrolling. `oneRow` (前沿动态, owner 2026-10-25) is one row at every width: the views at the left, the open view's controls at the right, then what is applied as tokens (each a press that lets go of it; at most two, then 「+N」 that opens the panel; none once the row is short), 「筛选 · N」 with the accent mark, and the search last; a filter declared `folded` is inside 「筛选」 at every width. On a phone that row is the scrolling views with 「筛选」 and the search as icons — the search opens over the row — and one more line only while something narrows the list or a `pinned` control must stay in sight; `sheetLead` is the sheet's first section; 「/」 puts the cursor in the search (`searchShortcut`). There is no second row of controls under the views on any page. `PageShell`'s `toolbar` slot is where it stands; inside a `Section` it is that block's own |
| `Score` | a score as a pill — its name small, a hairline, the number (`ScorePill`, 「AI 评分 86」), its tier its ground (accent, accent tint, grey outline) — and its parts as thin bars (`ScoreBars`), opened on hover, keyboard focus or a tap; without parts a label |
| `StepRail` | a module's program as one 40 px row at the top of **every** tab: a dot and a name per step, state as glyph, tooltip word and screen-reader word, `activeSteps` underlined (in the accent, by the rule and the colour only: a step is drawn like a tab of the row below it — 14 / 400, square — whatever its state), a 「现在」 sentence at the end; below 640 px 「已完成 7/8 步 ▾」. Extends `ProgressRail`'s marks |
| `StepState` | the body of a step's tab while it has nothing to show: `empty` (a recipe: what it uses, what it gives, one verb-and-object button), `queued`, `running`, `failed`, `credits`. Props are facts; the sentences are composed once |
| `ActivityStrip` | what is going on right now, under the rail: 「正在生成虚拟患者 · 计算 1,200 / 2,000」, elapsed, 取消; `variant="chip"` is the header's form. No percentage |
| `Note` | the only way a sentence stands alone on a page: with an `action`, or as a `result` that holds a number which can open what it counts (the figure is the link colour at the sentence's weight). A bare string does not compile; `tone="warn"` is a pale amber band with the text colour — the ground says it, not amber text |
| `Headline` | the data page's one sentence, each number a link to what it counts |
| `Section` | the one block heading (18 / 600, `sub` 14 / 600) with a count and a `toolbar` slot; `compact` uses 14 / 600 for catalogue group labels while preserving the section's heading level |
| `FactList` | the one key / value `dl`, eight rows and then 「全部 N 项」 |
| `ChartGrid` | charts by rows; a row's cells share a height and its spans fill it, so a grid has no hole |
| `Outline` + `useOutline` | a long page's contents: a sticky column from 1024 px, a folded 「目录 · N 节」 below, or the bare list (`inline`) in a column that already sticks (the frontier reader's 「本文目录」); read off the headings the page rendered |
| `MasterDetail` | a list column (320–360 px) and one record; below the room for both, the record is a `Drawer` — or, for a conversation, replaces the list |
| `ScopeMenu` | whose things the page shows (a project, a kind of project, everyone's), in the header after the title or as a chip in a toolbar |
| `StateScreen` | a whole page's failure or wrong address: an icon, one sentence, one action, 「回到原处」 |
| `InlineAlert` | a persistent, scoped message with its recovery action (`error` · `warning` · `info`); a string child announces once, by event and entity identity. The place for a failure that outlives a toast: `LoadError`, `DataTable` and the field-adjacent mutation errors use it |
| `Freshness` | the last successful read and the refresh that failed after it, with retry: an unknown time stays 「成功读取时间未知」, a failed refresh keeps the earlier value and its time |
| `NumberField` | a number with a declared quantity, scale and unit; the raw draft is kept apart from the interpreted value (see 「Quantity and measurement boundaries」) |
| `Checkbox` / `Radio` | native controls in a caller-owned fieldset with a linked label and feedback; `Checkbox` has a mixed state; the label is a 44 px target; consent is never pre-ticked |
| `Combobox` | a controlled query beside the selected ID, a 250 ms debounce, an abort guard against a stale answer, loading / empty / failed rows, arrows / Enter / Escape, and no selection while an IME composes |
| `DateField` / `DateRange` | a calendar date as `YYYY-MM-DD`, never converted to an instant; a range has inclusive ends, an order check and an optional open end |
| `FileDrop` | the file picker and the drop surface share one validation; per file, transferring · transferred · processing · searchable · failed are different words, and a byte count appears only when it is measured |
| `PendingFeedback` | the delayed read lifecycle: no skeleton before 300 ms, real elapsed time at 10 s, an explicit non-durable limit at 60 s; only the two milestones are announced |
| `AsyncSwitch` | a `Switch` over a single optimistic transition with an inline rollback on a confirmed failure and a reconcile action when the outcome is unknown |

Plus the infrastructure a page needs: `Menu`, `Switch`, `SearchInput`, `Input`, `Drawer`
(its `footer` is the one bar stuck to the panel's bottom; `placement="bottom"` is the phone's sheet), `ConfirmDialog`, `FormDialog` (a form in a
16 px panel on the modal tier — no page draws its own), `Toaster`, `Disclosure`. A card (`Card`) is for unlike content — a hot list
above a feed, a tool in a grid — and never for a list of like things.

### 页面结构 (2026-10-07)

Six rules, adopted with the owner-approved page rectification of 2026-10-07 (plan §9.4). They
answer the one defect that showed on nineteen pages at once: two kinds of thing stacked on one
page with the back office between them — the skills page held the reader's skills and the session's
under one another, the memory page a chart, two statistics blocks and a list, 科研工具 a grid, a
capability map and an evolution panel. `scripts/ops/ui-walk.mjs` checks each rule on the live
pages after every release.

1. **One page, one kind of object, as a list.** The October 20 analysis-workbench exception below supersedes this restriction for connected configuration and results. Content of a different kind goes in a tab or on its
   own page, never above or below. The walk reads a page body's top-level sections by shape (a
   `<section>`, a list of rows, a table, a chart) and fails a page that stacks more kinds than its
   budget (`shapes` in `scripts/ops/page-templates.json`, the one table of the pages the walk visits, their template and budgets); groups of one shape — a group per use, a group per day — are
   one kind. **The one exception is a data page** — the 记忆总览 (`/app/memory/overview`: the capsule as one data page — a toolbar of the range, only what needs a look and the search; a
   sentence whose numbers each open the list they count; five tiles that are each a door to a list; 「变化」, what it gained and lost over time; 「关系与主题」 when there is
   enough to see; and the table behind the charts, 「最近变化」, whose rows open the same drawers the marks do — held to two kinds of section and five size × weight pairs) and the knowledge base's graph
   view, the owner's formal requirement of 2026-10-12 that memory and knowledge be shown and not only listed: one
   shared selection narrowing the chart, the panel and the table together, and every mark and row opening the record's own drawer or the document's own page — so its shapes
   (the numbers, the cards of charts and of the table) are its budget; the memory page and the knowledge base page
   themselves stay lists with one line, and a compiled wiki page opens as a document under rule 2. A data
   page is also held to the data-page budget of controls — 10 kinds and 7 text colours, against a reading
   page's 8 and 5 (`budgets.data` in the page table). 总览 measures **10 kinds of control, 6 text colours, 3 kinds of border, 5 size × weight pairs and 2 kinds of section** on the `rich` fixture
   (2026-10-27, Chromium, the walk's own `measure`, at 1440 and at 390): the shell's four, the tabs, the quiet chips (range and the toggle) with the search, the headline's links, the tiles, the text of the
   rows, and `记住这一条` — a secondary `Button` at the header's own height (36), which is the same look as the sidebar's current item, because at 28 it was an eleventh kind. What it spent the budget on, and what it did not
   spend: its tiles are cards of the one frame the charts are (`StatBand separate`), not cells with hairlines (a fourth kind of border); the table behind the charts and the relation graph are cards of the kind the chart is (`ChartCard`),
   not sections that hold cards (two more shapes); the switch between 关系 and 主题 is the underlined `Toolbar` `views` the band has (not a second look); and the relation graph has no replay slider. The count in a sentence wears the chips' look and is not a kind of its own.
2. **A row opens by the nature of what it is** (long configuration/mapping uses the main area under the October 20 correction below) (adopted 2026-10-08 with release 13, from the owner's
   screenshots of the scheduled-task and knowledge-base pages):
   - a **record** — a memory entry, an inbox message, an evidence-matrix row, a GEO
     source or a wrong answer — opens in the right-hand drawer (`Drawer`) and the list stays where it
     is; a record's row does not take the reader to another page to read what it holds;
   - a **conversation-type object** — a scheduled task — opens its conversation in the main area,
     with the list as a column inside the page (`/app/autopilot/:taskId`);
   - a **document** — a frontier article, a knowledge-base source, a compiled wiki page, a report, an event, a file the
     assistant made (a spreadsheet, a deck, a script, shown by the kernel's own preview) — opens on a page of
     its own that has an address (`/app/files/:sourceId`), and going back restores the list as it was.
   A drawer never holds a conversation and never holds a second input box (the kernel's composer is
   the only one).
3. **The header is the title, the scope and at most one primary button** — and a search box. Two
   solid accent buttons in a header fail the walk.
4. **Only what can be acted on, and the result itself.** Short purpose/input/output/next-action guidance is allowed under the October 20 correction below. System state, version numbers, model
   names, identifiers and how a statistic was counted are not on a user page; say what the reader
   can do and what came of it.
5. **At most one row of view switches and one row of filters.** A second tab strip, a row of
   chips under another row of chips, or a navigation row above the views is one row too many.
6. **What looks clickable shows a result where the reader is looking.** A drawer, a new page, a
   tab or a row opened in place — never a change somewhere below the fold. What opens answers the
   number or state the row shows: a red count opens the items it counts. A row that can be pressed
   says so (`ListRow`: hover `surface-2`, selected `accent-soft`, a quiet › ⌄ ↗ mark at its end; `StatTile whole` the same for a tile that is a door; ↗ also marks a route that leaves the section the list is in) — and it is the
   whole row or tile that is pressed, with its title in ink: accent text is for a link inside a sentence, underlined (「Colour → Rules」).
   The walk clicks the first row of each list on the rebuilt pages and fails a click that shows
   nothing; what a row's content holds is for unit tests, not the walk.

Seven more, adopted with the owner-approved rectification of 2026-10-14 (R19; plan §2) and held by the
page framework — the components above, `PageShell`'s slots, `layoutRules.test.ts`,
`pageComposition.test.tsx` and the walk's composition checks:

7. **Controls sit above the content they control, in one toolbar.** The views, filters and search of a
   page are `PageShell`'s `toolbar` (or `tabs`) slot or, for one block, a `Section`'s: inside the sticky
   band, above the body. A page has at most one row of views and one row of filters; a filter chip
   written under its list, in the middle of a page or at its foot, is the defect this rule exists for.
   A `Tag` is a label: it is never clickable and never inside a control.
8. **A sentence carries an action or a number.** Every sentence that stands alone is a `Note` (with its
   action, or a conclusion whose number opens what it counts), a `Headline`, an `EmptyState` or a
   heading; there is no grey line for how a thing was made, what it may be used for, what the engine
   did — those are the model's context, a log or an operator's view. `layoutRules.test.ts` counts the
   hand-written ones and lets the count only fall.
9. **A module that has a step rail shows it on every tab, sticky** (循证 GEO; 虚拟临床研究 has none since the
   2026-10-25/26 reset). The rail, the tabs and the toolbar row are one
   band at the top whose height does not depend on the tab (a tab without a toolbar reserves its row);
   the steps the open tab is built from are underlined. The page never loses where the program is by
   switching a tab. A click on a step, and a to-do, goes to the step's block (`#geo-errors`): the page's
   own ground scrolls to it, 12 px under the band — never `scrollIntoView`, which also scrolls the app
   shell and carried the sidebar and the band off the screen — and the blocks a tab is promised are data
   (`GEO_TAB_SECTIONS`), which `pageComposition.test.tsx` renders against.
   What stands over and in the band is the same on every tab too (the fixture walk of 2026-10-28 measured the band 10 to 36 px
   taller on the tabs that had more): the way back is on every tab — 项目总览 from a step, 循证 GEO from the overview — as a block link, not an
   inline one (which is a kind of control of its own); the open step's own action (加问, 选目标档, 让 AI 写下一批) is the toolbar's
   `contextAction`, a quiet 28 px text button at the row's end and never a primary — the page's one primary is the header's 「对话」,
   and a header button is exactly 36 px for a one-line label (`HeaderActions`), the look of every other 36 px button; and at a phone's
   width the band's row, whose view and scope choices cannot fold into 「筛选」, is one line that scrolls sideways (`Toolbar`
   `nowrap`), ending in the search, the count and the action.
10. **Starting work never takes the person away.** The button starts the work; the page's
    `ActivityStrip` says what is happening and how far, and the page updates itself when it ends. The
    conversation is a view of the same page, not another place.
11. **Every number opens what it counts, and a chart and its table share one selection.** A figure in a
    sentence or a `StatTile` is a link or a button to the things counted (`to` / `onOpen`); a word that
    stands in for a number opens nothing. Selecting a mark selects its row.
12. **An empty state is a recipe.** What the step uses (each one clickable), what it gives, and one
    button naming the work as a verb and its object (「生成虚拟患者」, not 「让 AI 做」). With no button
    it says why (`reason`); an empty state never merely stops.
13. **What a page lists as installed is generated from what is installed** — the plugins, skills and
    tools of the image, not a hand-kept list; a package that is installed and not on the page is a red
    test.

**Six templates.** Every page is one of these; the template fixes the slots and their order, and a page
fills them. `compositionFixtures.tsx` holds a sample of each, `pageComposition.test.tsx` reads them.

| Template | For | Slots, top to bottom | One kind of body | A record opens |
|---|---|---|---|---|
| T1 列表页 | 前沿动态, 知识库, 记忆 (关于你 / 项目 / 做法), 收件箱, 科研工具, 插件与技能, the GEO and study homes | header · `toolbar` (views at the left; filters, search, count at the right) · `List` / `DataTable` · `ShowMore` | a list or a table | a drawer (a record), a page (a document), the main area (a conversation) |
| T2 主从页 | 定时任务, 方法库, 假设卡 | header · `MasterDetail` (list 320–360 px, the record beside it; below 1024 px a `Drawer`, or the page swaps for a conversation) | a list and one record | the right-hand column |
| T3 模块页 | 循证 GEO (including its addressed answer); VCR uses the conversation/result variant below | header (the primary action is 「下一步：…」; while working, a chip) · `steps` on every GEO tab · `activity` while working · `tabs` · `toolbar` · one tab's body | one kind per tab: a T1 list, a T2 split, a T4 chart grid, a settings panel | as T1 |
| T4 数据页 | 记忆总览, GEO 总览 / 可见度, 研究的对照 / 试验, 知识图谱 | header · `toolbar` · `headline` · `StatBand` (only the numbers that exist) · `ChartGrid` (full rows) · the table behind the charts | charts and one table | a drawer; a mark is a row |
| T5 阅读页 | a knowledge-base document, a report, an evidence card, an event | back · document title · the primary action · `Outline` (from four sections) · the text · one 「来源与核对」 fold | a document; a long list is a table with a toolbar | — |
| T6 设置页 | account, appearance, notifications, allowance, data sources, projects | header · a left rail of **settings sections only** · `Panel` groups | `Panel` | — |

The specification names the same six templates List (T1), Master detail (T2), Workflow (T3), Data
map (T4), Reader (T5) and Settings (T6), and adds the **connected workbench** — the October 20
exception below: the related inputs, configuration, progress and results of one task in the main
area, with responsive tabs where useful. It has no template key in `page-templates.json`; a
measured, workbench-specific budget is a view's `budgetOverride` with a `budgetNote` that carries
the live measurement, and it expresses the connected workflow — it never excuses unrelated stacked
content.

**What each template forbids.** The walk reads the components' markers (`data-toolbar`, `data-step-rail`,
`data-note`, `data-tag`, `data-outline`, `data-empty`, `data-chart-grid` — listed in `PageShell.tsx`), not
the words on the page. Three of the prohibitions are also lint errors (`apps/web/.eslintrc.cjs`, the layout block): a
page or tab component imports no `FilterChips`, `FilterSelect`, `SearchInput`, `SegmentedControl` or `Tabs` (its tabs,
filters and search are `PageShell`'s slots or a `Toolbar`); nothing outside `Tag.tsx` imports `tagClasses`; a
虚拟临床研究 component does not navigate to the conversation. The files that still break the first two are on
`src/app/layout-lint-baseline.json` with their number of sites (14 in 14 files on 2026-10-17), where the rule is a
warning; `layoutLint.test.ts` holds each number. Two more are counts that only fall (`layout-baseline.json`, held by
`layoutRules.test.ts`): grey sentences with no action, and hand-written `divide-y` lists.

| | Required | Forbidden |
|---|---|---|
| every page | one `PageShell`; at most one primary action in the header; a sentence is a `Note`, `Headline`, `EmptyState` or heading | a hand-drawn `<h1>`, back arrow or search box; a grey sentence with no action or number; a `Tag` that is pressed or sits in a control; a status word drawn as a button; a switch to an empty place that says nothing and offers no next step (the walk's `zero-count`; see the v3.1 rules below for what may stay) |
| T1 | the toolbar above the list, views and filters in one row | a second tab list in the body; chips under the list; a hand-written `ul divide-y` (`List`, `ListRow`) |
| T2 | the record in the right-hand column on a wide page | a record in a drawer beside a list that has room; a conversation in a drawer |
| T3 | GEO: `StepRail` on every tab with the same steps; VCR: six result destinations without a step rail; the toolbar row reserved on a tab without one | the rail on one tab only; a button that carries the person to the conversation; two kinds of object in one tab; the primary action in the body |
| T4 | a `Headline` whose numbers open what they count; a `ChartGrid` whose rows are full; legend and replay controls in the card's header | a placeholder tile; a hole in the grid; a control under the canvas it controls |
| T5 | an `Outline` from four sections; the serif title | a page of many screens with no contents; the action under the title |
| T6 | settings sections only in the left rail | a link to another page (插件, 技能, 运维) drawn as a section |

**What v3.1 states over the older blanket wording (2026-10-26), as v3.2 amends it (2026-10-27).**
DS22.1–DS22.8 in the canonical specification own the current-task modes, scoped header actions,
workflow / view / filter distinctions, adaptive filters, shared emptiness, import / edit placement,
meaningful density and whole-page verification. Local implementation and scoped page-state-width
evidence are recorded in `../docs/superpowers/plans/2026-10-27-page-composition-v3.2.md`; AT51–AT58
remain open where the ledger identifies missing routes, states or acceptance. Token package 3.0.0 is
unchanged, the dated v3.1 ledger and its seven OPEN acceptance items stay separate, and this revision
claims no deployment. These are the specification's page rules. The walk's budgets are unchanged: updating their semantic policy takes a focused test and
observed evidence, and no budget is weakened, and no useful instruction deleted, just to obtain a
green check. The walk's view inventory (`page-templates.json`) is an intended coverage map, not proof
that every view was exercised.

- One page serves a coherent task, not necessarily one data shape. Connected configuration and
  results are allowed in the current mode; complete overview / list / edit / analysis workbenches are
  not stacked by default, and unrelated metadata is not stacked beside them.
- Helpful purpose, required inputs, units, prerequisites, limitations and recovery instructions are
  allowed. Internal implementation narration belongs in diagnostics, and a grey-text counter cannot
  decide language quality.
- One dominant action per local action group, and a header default of at most one primary and two
  common secondary actions, then labelled overflow; a read-only page may have no primary action. A
  contextual action in a workbench is not forbidden simply because it is below the header.
- One coherent view-navigation / control band. Workflow progress and result navigation have
  different meanings: compacting them must not hide the process or force an unexplained second
  vocabulary.
- A static `Tag` does not act. Filters, tabs, links and buttons keep distinct semantics even when
  their look is restrained.
- An informative empty destination or a zero-count filter may stay when it preserves context or
  explains a prerequisite, with a reset or a next step; a selected filter is never erased because a
  refreshed count fell to zero.
- A row's label predicts whether it filters, configures, opens a conversation or navigates, and a
  press shows its result at the point of work.

**One look for one job (2026-10-17, r19-guards3).** The walk counts a page's kinds of control by their look — height, size and
weight of type, a frame, a ground, a corner — and holds a module page to ten, a reading page and a frontier list to nine or
ten. The pages that carry real data spent 11 to 16 until the same job stopped being drawn two ways: the step rail is the tab
row's look; a row's title and every link and text button have the 8 px corner; a figure that opens what it counts, in a note or a
headline, has the weight of its sentence; a selected chip and the toolbar's search pill are one filled pill; a sort button has
one height; a source mark is 12 / 400; the frontier's header action is `secondary` like the other modules'. A page that
needs a kind of its own says what it is in its `budgetNote`. `lookKinds.test.tsx` holds the classes.

**The same, on the owner's data (2026-10-18, r19-walkfix).** The release walk of production found what the fixture could not: a
band a line taller on one tab, a tag in a link, a sort header after two pictures, 41 rows on a first screen, nine to eleven kinds of
control on pages that had eight to ten. By class: a toolbar in the band is one row whatever the data — its filters fold into 「筛选」
when the row would wrap (`Toolbar` `inBand`); a `Tag` is never in a link, a button or a row's title (`tagNotInControl.test.ts` reads
every source); every `a` and `button` has the control corner unless it sets one (`index.css`); a toolbar's controls — search, chips, segments, a small button, the activity chip — are the page's own 14 / 400 (13 was a size pair of its
own on every page that had a toolbar), a severity grade 12 / 400 like a tag, and no control is 500, and the current navigation item is 400 (its ground says it: a 600 of its own was a
second kind of 36 px control beside the secondary buttons on every page); a table's controls are 28 high; every rule is the *top* of the thing below it — a list's, a panel's, a card's body under its header — one stroke and not a top and a bottom; a list's bulk action (「全部已读」) is the toolbar's; a tab's one primary (选定方案) is the header's (`useVcrPrimary`);
a list that is a heading and a fold on one account and a heading and rows on another is one shape (the overview's 交付物); the first
screen of a data page holds at most twenty rows, so the list under two pictures starts with five (准确与安全) or twenty (信源) and says how many
more. A data file is a window of lines, a page of four sections has its contents, and a scroll box is a named stop (`KnowledgePageView`).
The operator's console is one card (`OpsCard`): a good state has no colour (amber for a thing to look at, red for a failure), an
identifier is a copy button and never page text, and a list that holds nothing is not a tab.

**前沿动态's list and reader (2026-10-23, the owner's screenshots; the band 2026-10-25: 「不要横着罗列着，顶上弄好几行」).** The band is
one row on every view (`Toolbar` `oneRow`): six views — 精选 · 全部 · 关注 · 热榜 · 简报 · 证据专区 — at the left; at the right the
open view's few controls (热榜 当前 | 本周 | 本月 and when it was taken, in Beijing time, said once; 简报 日报 | 周报, 分类, 往期, 复制 — 往期 is the toolbar's only for the weekly, and for a daily on a phone, cut into 月份 and the month's issues; on a screen with the room it is a column of months beside the issue, the open one marked, and an issue opens with 「先看三件事」 (its lead and the two items its lanes score highest, each a title and its 导读 and nothing more; the lanes under it skip those three, and the 月份 menu names its oldest month without a count while older issues remain unread); 证据专区 「全部专区 ▾」, the
count of a search, 新建专区), on 精选, 全部 and 关注 the applied tokens (the chosen tag keeps its 「关注」) and 「筛选」 — 栏目 (one
choice) with 行业动态 beside it (the kinds of business news — 交易与授权, 融资与上市, 人事与组织, 公司经营, 研发管线; one choice, said on the row as 「行业动态 · 融资与上市」; 「其他」 is a kind an item has and not one to ask for), 专科 (the thirty in their five groups, several at once, each chosen one with 「关注」, then their 热门标签), 来源, 证据类型,
时间 (全部 only), 只看收藏 — and the search last. 只看未读 is a toggle at the right end of the list's first day heading. 与我相关 is
关注's first entry (`?view=following&follow=foryou`; `?view=foryou` lands there): from 640 px 关注 is a column of the reader's places —
与我相关, 全部关注, each followed specialty, tag, drug, topic, source, event and evidence zone, each an address, then 「添加关注 · 管理」 —
beside the list it opens; on a phone that column is the first section of the 「筛选」 sheet. Nothing followed and the onboarding card
never answered: the card is 关注's empty state, and its answers become the first follows. A search's results offer 「关注“<词>”」. A card is one link to its reader:
the title's link stretches over it, the ground lightens under the pointer and the title — `title-ink` — turns the accent; the summary
is three lines (two on a phone) and never expands; the meta row ends in the 「AI 评分」 pill and the footer holds three tags that
narrow the feed, 「另有 N 家报道」, ☆ and ⋯ (深入研究 first). A day-grouped list has its clock in a column and a heading per day that
stays under the band; any other list says the date after the source. The reader is two columns from 1024 px: the article on one
edge (back, byline, title, 导读, text) and a sticky column whose top is the back row's — 「打开原文 ↗」 with ☆ and ⋯, 「深入研究」,
推荐理由 with the score's parts, 专科 and 标签 (one chip, every one a link) and 本文目录 at three sections; below 1024 px the notes
follow the text and the actions are a bar at the window's bottom.

**The event page's record and timeline (c5-reader, 2026-10-26).** An event is the list column (1040) from 1024 px with 「事件记录」 in the right column — its heat and 72-hour trend, then 最早报道 and 最近更新 (Beijing time, said once in the heading), how many reports and from how many sources, and whether first-hand material is among them — and the reading column (720) below it, where the record is the strip above the summary. The reports are 「一手材料」 (the parties' own texts) and 「报道时间线」, the rest cut into Beijing days, the newest day first (最早 reverses it), each row saying the clock it stands at; the page holds the same four size × weight pairs as before.

Both module names are a rule of the same kind. The two modules are 「循证 GEO」 and 「虚拟临床研究」
(identifiers `geo` and `vcr`); 「循证传播」 and 「虚拟临研」 are retired words — `retiredWords.test.ts`
and the walk fail on them — and a search reads them as the new names until 2027-01-07.

---

## Surfaces, states, motion

**Flat.** Structure is 1 px hairlines and the surface ladder. A static card has **no shadow** —
its border is its whole edge. Only what genuinely floats casts one: `shadow-e1` (a card that must
lift), `shadow-e2` (the composer, menus, popovers, toasts), `shadow-e3` (dialogs, drawers);
`shadow-pop` and `shadow-modal` are retired names of `e2` and `e3` and ESLint refuses them. One brand moment per page, no
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
loading. Four states on every list page and data page: loading skeleton, empty, error-with-retry, content; a data page with too little to draw says so in one sentence and shows the list.

**State truth and recovery** (v3.1, DS09). Initial loading, first-use empty, filtered empty, failed
first read, failed refresh, stale, partial, denied and cancelled are different states with their own
words. Unknown is not zero: an unread resource is not 0 B or stopped, and unmeasured evidence is not a
clean zero; a zero is shown with its scope, denominator and time. A failed refresh keeps the useful
previous data with its time and a persistent retry beside the section it affects (`Freshness`,
`InlineAlert`); a first-read failure leaves an explanation and a retry, never only a toast. A
percentage appears only over a real measured denominator, and never on an agent run. An
action-required count counts what the current person can do; automatic recovery is status, not a
to-do. A busy control keeps its focus, label and width: `aria-disabled` and `aria-busy` need a real
activation guard against a second effect, and native `disabled` stays for a genuinely unavailable
prerequisite, which the control explains nearby (a missing permission, a missing configuration and
no selection are different reasons).

**Motion**: three durations — `duration-fast` 120 ms for a state change, `duration-base` 200 ms
for a container, `duration-slow` 320 ms for a page-sized change — one easing in
(`ease-standard`) and one out (`ease-exit`, 2.1). A drawer travels 24 px, a toast 8, a menu 4
(`--motion-*`). No bounce, no parallax. **Reduced motion** removes every movement and keeps the
fades: travel distances become 0, no duration exceeds 120 ms, a loop plays once and rests, a
spinner stands still — the state stays visible, it only stops moving. Charts must switch their own
animation off (ECharts does not read the setting).

### Accessibility

A **skip link** (“跳到主要内容”) is the first thing Tab reaches on every page, on the skip tier.
After a route change the shell moves focus to the new page's `h1` — once its title is in place —
(`useRouteFocus`: `tabindex="-1"`, no ring, no scroll); it does not on the first load, for a change of
query alone (a filter, a tab, a page number), on the conversation surface, off a control the reader is
working in, or while a dialog is open. The `?` shortcut is a single character key and can be turned off
(设置 · 外观 · 快捷键, WCAG 2.2 SC 2.1.4; also for a `?` forwarded from the conversation frame); ⌘/Ctrl+B
is a chord and has no switch. What is stuck to the window's bottom — a drawer's footer, the toasts, the
sidebar's account row — keeps `max(16px, env(safe-area-inset-bottom))` above the edge (`env()` is 0
unless the viewport meta says `viewport-fit=cover`, which it does not; the `max()` keeps the 16).
The token CSS carries a **forced-colours layer**: Element Plus inputs and selects get a real
border and a Highlight outline (their edge and focus were shadows), floating layers a system
border, and selected / current / pressed states an underline, because forced colours remove
fills. Under **`prefers-contrast: more`** secondary text and every rule move one step towards the
text colour (`COLOR_ROLES_MORE_CONTRAST`, measured like the rest). Data colour that must survive
forced colours opts out with `data-forced-colors="preserve"`.

**Modal focus and keyboard** (v3.1, DS08). A modal has its role and name, background isolation,
initial focus, a Tab cycle over actual Tab stops only and a focus return. Negative `tabindex`, hidden
or inert ancestors, hidden inputs, CSS-hidden elements and native disabled semantics are excluded
(the first legend of a disabled fieldset is a native exception and a radio group is one stop):
`focusTrap.ts` takes the rule from `tabbable`, `checkVisibility()` carries explicit options and a
fallback, and a selector match is never proof of a Tab stop. Enter activates the focused control or
an explicit form submit, never a global destructive default; Escape closes the top eligible layer and
returns focus, with unsaved work protected (`useUnsavedGuard`). A menu scrolls inside the viewport
height that is left. Ordinary notifications are polite and never steal modal focus, and a stream does
not announce every token. Single-character shortcuts are scoped or can be turned off; the kernel's
composer keeps its own Enter, IME and stream-scroll behaviour, and the host never adds a second
composer.

**Verification.** The target is WCAG 2.2 A/AA across the applicable complete processes; token
validation alone does not certify fixed scientific canvases or overlays. Test keyboard only,
VoiceOver / Safari, NVDA / Chromium, touch and cancelled gestures, 320 px reflow, a 390 px phone,
tablet and desktop, 200 % text size, forced colours and both themes, and label emulation as
emulation. Public reports, screenshots and logs expose no secret and no unrelated user data.

### Embedded

Inside the EviMed Vue shell (`?embed=1`, or the wujie container) the React shell renders its
content area only — no sidebar, no project rail, no shortcut sheet; the host draws those.

---

## Components

New UI uses the `components/ui/` primitives — Button, Input/Textarea, Card, SegmentedControl,
Disclosure, Drawer, ConfirmDialog, Toaster, ShortcutHelp — and `components/cards/` —
EmptyState, LoadError, Skeletons — rather than a hand-rolled box. Signature components:
`PageShell` / `PageHeader`, `RunStatusDot`, `InboxBell`, `Disclosure` (the one collapse), `ConfirmDialog`
(`tone="danger"` for what cannot be undone, `primary` for a checkpoint; initial focus on 取消).

The delivery gate's findings are not a component of the report. A SAFETY conclusion stands before the
text in the danger tone and is never folded; every other finding is a mark on its sentence (the ✓ / ⚠
of 「依据」, and the header's “⚠ N 条待核对”), and the rest stay in the run record for operators.
`lib/qualityNotices.ts` groups them for those two places; no validator sentence is ever primary text.

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

The table records implemented behaviour and the acceptance each still needs. The public contracts live beside the exports (53 UI modules, 72 public components); the [execution ledger](../docs/superpowers/plans/2026-10-26-design-system-v3-execution.md) records proof and the remaining gates, and this table is not a declaration that every browser or manual scenario passed. Owner H unless separately assigned K.

| Component / helper | Observed baseline and adopted change | Required acceptance |
|---|---|---|
| Button / buttonClasses | Implemented loading-only behavior uses guarded aria-disabled/busy, retain focus/name, draw the spinner's room only while it spins (a resting button has no empty slot) or preserve measured width; retain disabled for genuine prerequisites. CSS must cover aria-disabled and events must suppress mouse/keyboard/form activation. Focus loss is a browser risk to verify, not universal proof from the attribute. | T double click/Enter/form submit; G all sizes/long labels; W actual focus and width. AT35 |
| Switch | Implemented controlled pending and AsyncSwitch producer adapter support a single optimistic transition; keep requested position while pending, inline confirmed-failure rollback, and unknown-outcome reconciliation. An invariant label names the setting. A setting that takes effect later (插件与技能) is still a labelled switch for what was saved, with the effective-time status line beside it; an action button is for a one-off apply, not for a standing preference. `onChange` of an AsyncSwitch resolves with the write's confirmed state and nothing is read back; the readback is the recovery for an unknown outcome only, and a refusal is said once, in the switch's own line. | T out-of-order response, rejection, timeout, scope change; G pending/error; W persistence. AT36 |
| Input / Select / Textarea | FieldShell unifies Input/Select/Textarea label/hint/error IDs and slots. Distinguish decorative prefix/suffix/unit from a trailing actionable control and preserve text space/accessible description. | T descriptions/error precedence/IDs; G prefix/suffix/error/narrow; M AT. AT37 |
| NumberField | Central quantity adapter (`lib/quantity.ts`; see below). Raw text stays separate from the interpreted value. Do not replace it with a bare native number input that silently guesses scale. | T parsing/conversion/round-trip/domain mapping; G; W form/result. AT08/37 |
| FormDialog | Implemented bounded scroll body, footer and persistent linked error summary share useUnsavedGuard for close/backdrop/Escape/route. Busy must not blanket trap Tab on the panel and make retained help/errors unreachable. | T guard routes/save outcomes; G long body/summary/footer; W/M focus. AT13/38 |
| Drawer | Existing layer handling/focus and the shared dirty guard are retained; keep view-only drawers light and immediately closable. | T common guard and nested layer; W return focus/blocked navigation. AT38/43 |
| ConfirmDialog | Structured subject/count/consequences/recovery fields are implemented (optional extra readable content); safe initial focus, no global Enter destruction. Reversible operations use actual undo/history instead of an extra confirmation. | T irreversible/partial recovery semantics; G objects/counts; W actual restore path. AT39 |
| focusTrap | Implemented tabbability handling covers native disabled/legend/radio, hidden/inert, visibility and zero-stop cases, without violating nested-layer ownership. checkVisibility options/fallback need actual browser coverage. | T all excluded/included cases; W/M keyboard in Chromium/WebKit/Firefox. AT13 |
| Toaster / toast store / announce | Implemented pre-mounted host announcers, event-scoped short-window deduplication, tones and optional Undo. Actual screen-reader reliability remains a manual gate. Keep existing hover/focus timer pause. Persistent failures stay inline. | T queue/identity/dedup/priority; G long content; M real AT first/repeated announcements. AT40/41 |
| Tabs | Implemented auto/manual activation; manual arrows/Home/End move focus only, Enter/Space activate; retain correct tab/panel identity and overflow. | T focus versus selected state, async loading and item removal; G/W. AT42 |
| StatTile / StatBand | Implemented typed measurement boundary below; keep shared denominator visible/accessible at band level and retain precise drill-down scope. | T type negatives plus source adapter unknown/zero/stale/error cases; G/W real metric states. AT07/37 |
| DataTable / LoadError | Existing inline failure styling is duplicated and LoadError uses the retained ghost alias. Route persistent feedback through InlineAlert and migrate ghost to secondary when touching the call site; preserve partial rows, sorting and retry. | T retained rows/retry, partial errors; G table overflow; W. AT40/48 |
| ListRow | Stretched hit area is a conscious selection/copy tradeoff. Retain a semantic primary control, the second line (`meta`) and `leading` let the press through to the row and keep real nested controls (a retry button, a selection checkbox) above the stretched title; a row whose second line carries an identifier to copy sets `metaSelectable`, which makes that line selectable without opening the row. Essential full identity/copy remains available. | T primary/secondary events; W/M text selection on mouse/touch; G long names. AT19/44 |
| SearchInput / submit hook | SearchInput owns clear/Escape today; Enter guards are scattered. Centralize host composition-safe submit while preserving caller callbacks, native form semantics and cancellation. A scoped lint rule follows adoption, not a blanket prohibition on Enter. | L scoped rule/exception tests; T IME sequence; W/M real IMEs. AT46 |
| ScrollRegion / scientific views | Retain the audit's unclosed fade, initial-size, fixed-label contrast and keyboard findings. New helper contracts do not close those bugs without actual caller migration. | T regression probes; G/W/M actual files and themes. AT05/14/15/16/17 |

### Quantity and measurement boundaries

**NumberField** requires a declared quantity/unit, explicit scale (`scalar`, `percent` or `fraction` as appropriate), canonical representation, min/max in that representation, precision/rounding policy and an example when ambiguous. A field may be unitless, but it says so. Input values like empty text, a lone minus, malformed grouping, NaN, Infinity and out-of-range values do not become zero or silently clamp. Preserve invalid draft text with explanation. Parse on blur and submit; conversion occurs exactly once. Do not round scientific values merely because the display rounds.

The shared quantity parser and formatter are `lib/quantity.ts` (`parseQuantity`, `formatQuantity`, `QuantityPolicy`; the general format helpers stay in `lib/format.ts`). Input preview, confirmation, saved configuration and displayed results use that contract, while the domain API keeps its declared units. An entered `20` in percent mode corresponds to `0.20` only when that is the declared canonical fraction; saved `0.20` must not be converted twice on reopening. Tests include negatives, scientific notation where allowed, locale separators, 0, 100%, missing data and historical versions.

**StatTile** adopts a discriminated reading: Measured has a finite value, unit, scope and observation time/coverage; Unmeasured has a reason and no numeric value; Failed has an error/retry contract and optional previous Measured reading. Initial loading is an explicit read lifecycle, not a fake Unmeasured result. Type negatives prevent a numeric value on the Unmeasured branch. They cannot prove a caller did not lie by constructing Measured(0): adapter tests must preserve backend missingness, measurement existence, sample counts, denominator and time. Compile-time typing alone does not close audit A01. Preserve real zero and useful stale values; failed refresh must not erase an earlier measurement.

### Shared primitive contracts and introduction order

Every primitive below is implemented and has a real caller; "Where" names it. A new primitive arrives
with its first real caller and fixture — no unused component catalogue. Native HTML or a page-specific
instance may still exist beside one, and its absence from this list is not proof that the product lacks
the capability. Owner H; native counterparts remain K.

| Primitive | Adopted contract | Where | How to verify |
|---|---|---|---|
| InlineAlert | Semantic tone, title/body, scoped persistent recovery action, dismissal policy and announcement identity; shared by `LoadError`, `DataTable` and field-adjacent mutations | `components/ui/InlineAlert.tsx` | T persistent failure/retry/dedup; G all tones; AT40/41 |
| Freshness | Last successful time, current refresh state and retry in a toolbar summary or headline; unknown time stays unknown | `components/ui/Freshness.tsx` | T failed refresh retains value/time; G narrow summary; AT40/45 |
| announce() | Pre-mounted polite host queue and a limited assertive channel; event/entity identity, count and priority; no duplicate visible-and-spoken event | `lib/announce.tsx` | T queue/window/multiple tasks; M AT; AT41 |
| NumberField | Explicit quantity/scale, raw draft versus parsed value, shared formatting and domain units | `components/ui/NumberField.tsx`, `lib/quantity.ts` | T boundary and round-trip; W meaningful form; AT37 |
| Combobox | Controlled query versus selected ID, an optional domain threshold and a default 250 ms search debounce, an abort / stale-response guard, loading/empty/error, keyboard selection and clear; no free-text-as-ID unless the domain allows creation | `components/ui/Combobox.tsx` | T out-of-order/IME/abort/duplicate labels; G short/long list; W/M ARIA pattern; AT49 |
| Checkbox / Radio | Labelled native controls in fieldsets; checkbox mixed state and radio-group arrow behaviour, errors/help and a large hit area; unselected consent by default where consent exists | `components/ui/Checkbox.tsx`, `Radio.tsx` | T mixed/disabled/group names; G/M keyboard and hit area; AT48/49 |
| DateField / DateRange | Native calendar-date controls; date-only is distinct from an instant or a timezone, endpoints are inclusive, a range can be open, invalid order is refused; a custom picker only for a supported unmet need | `components/ui/DateField.tsx` | T leap day/timezone/range boundaries; W/M keyboard; AT45/49 |
| FileDrop | Clickable file picker plus drop, the same validation and per-file status; real byte progress only when measured; transferred, parsing, searchable and failed are distinct; cancel/retry only where the API backs them | `components/ui/FileDrop.tsx` | T partial failure/abort/duplicate policy; G long filenames; W real safe fixture upload; AT23/49 |
| Batch selection | An optional feature of eligible tables and lists on the shared Checkbox and one selection state, not a second catalogue; follows DS21.10 | `lib/batchSelection.ts` (the inbox) | T stable IDs/page-query scope/mixed results; W keyboard/touch; AT48 |

`PendingFeedback` provides the shared host read lifecycle: no skeleton before 300 ms, real elapsed time
at 10 s and an explicit non-durable limit at 60 s, announcing only the two milestones through the
shared channel. Passive gallery specimens and inactive hidden readers use an explicit boundary
(`PendingFeedbackBoundary`); native feedback and durable producer controls keep their own ownership.
Publication and production adoption remain separate stages.

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

---

## Language and responsive behaviour

UI baseline language is **Simplified Chinese**; code, comments and commits are English, and
technical identifiers (URLs, enum values, model ids) stay as they are. Map every server enum,
status and error code to Chinese before it reaches the screen (`labelFor`, `webErrorMessage`,
`errorCodeMessage`); never render a raw `Error.message` — ESLint rejects the
`instanceof Error ? … : String(…)` shape.

Breakpoints are Tailwind's (`sm 640` · `md 768` · `lg 1024` · `xl 1280` · `2xl 1536`). Below
1024 the sidebar becomes a drawer over the content; below 768 every page has a 16 px gutter
(`PageShell`) and tables scroll horizontally with the first column frozen. No page may scroll horizontally at
390 px. Figures inside a report keep a white background in both themes; printing mounts a print
copy of the report re-scoped to the light tokens, so “打印 / 存为 PDF” gives the report and its
facts on white paper, never the shell. Mobile navigation closes after a destination is selected, moves
focus into it appropriately and names it; a long project name stays distinguishable without hover.

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
validator strings, enum codes, run ids or model names in the body of the UI (the model a person
chose in a picker is their choice, not provenance) · rely on hover to
reveal anything a keyboard user needs · explain how the system works on the page (a subtitle, a
hint under a card, “为什么入选”; this historical blanket wording is superseded for useful task guidance by the October 20 correction below) · show the back office as text: 已交付, 核对 N 条, 用过 N 次,
起生效, token, 缓存命中, tok/s, an API's name, a project id.

---

## Conversation evidence and modules

- Home/logo/new conversation opens the general assistant without inherited specialist context. Native progress, cancellation and LoopX goal controls keep their actual semantics. Normal menus use task language, not diagnostic command names.
- Ordinary text/files can be delivered directly. Medical checks and claim labels enhance relevant work; do not revive whole-package withholding. Verification states name scope/version and never imply clinical certainty from a generic accepted state.
- Frontier uses an editorial list, coherent summaries and distinct reader blocks. Keep original-source access predictable. Publication/discovery dates and AI importance/evidence quality stay distinguishable. The whole feed card opens its addressed reader; original-source access is separate, and long article text is not hidden behind retired reveal actions.
- Knowledge distinguishes source/readiness/compiled page/graph/output. Reading preserves source location and jump-back. Fixed scientific canvases still need readable UI text and keyboard equivalents.
- Memory uses the current native OpenViking engine and combines honest sparse visualizations with readable records and real source/scope; there is no retired records-engine fallback. One person has one capsule, and project is an entry label. Do not create visual links without evidence or mistake a membership star for semantic relationships.
- GEO, VCR, schedules, extensions and settings/inbox product decisions are linked by the full specification DS15-DS17 and the adoption plan's module register. Do not duplicate their changing task scope here.

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
(CIE76, `cie76` in `contrast.mjs`; the floor is 15; the current order is ≥ 22 in both schemes), and
the own-versus-rival distance of a comparison chart (`chartPalette.test.ts`, ≥ 15 in both themes).

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
and `pnpm --filter @ai4s/web exec vitest run src/app/designTokens.test.ts`. A change to the mark
also regenerates the brand assets and rerasterizes the installation icons (see *Token authority*).

**Local checks and release evidence.** Run the token build / check and the release recording when
generated bytes change, then the focused token, web and native brand tests, lint and type checks and
the build. For a component's look inspect both theme renderings and the gallery diffs under the
documented CI font and browser environment; do not blindly rebaseline a picture. A production release
additionally verifies the deployed source and image, host and native theme propagation, PWA cache
behaviour and selected real user journeys; the external Vue repository adopts its package pin
separately. LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1 at the 75th percentile, by device, are field
goals, local runs are labelled local, and no telemetry the platform prohibits is enabled to obtain a
metric.


## Known gaps

- The page framework (R19) is enforced, with what is left as counts that only fall: the hand-written grey sentences
  (65) and divided lists (17) are a per-file baseline (`apps/web/src/app/layout-baseline.json`), and the lint rules
  that keep a page from drawing its own tabs, filters and search are errors except in the 14 files of
  `layout-lint-baseline.json` (2026-10-17, from 78 sites when they were warnings). `FilterRow`, `VcrToolbar`,
  `VcrHeadline`, `VcrJobLine`, `PluginsList`, `KnowledgeScopeMenu`, `ProjectScope` and `useOpenVcrConversation` are
  gone; `StepPending` (循证 GEO's tabs), `VcrStepPending` (the study tabs), `TabSection` (`ValueSection`) and
  `VcrSection` (`IntakePanel`) are still in use, and go when their last caller moves to `StepState` / `Section`.
  The framework's components are drawn by `src/test/compositionFixtures.tsx` (one sample per template, in tests), not
  in `/__gallery`: adding rows re-records both reference images, which CI re-diffs on its own environment, so the first
  batch that re-records the gallery adds them.
- `text-ui-sm` is an alias, not an error, until the page rewrites drop its call sites. The
  `max-w-content` family has none left (ESLint refuses it) but the preset still carries the names:
  removing a published name is a major release of the token package, for the Vue shell to adopt.
- `text-graphic` is also the data mark of a rival in `ShareBar` (rival 2, lighter than rival 3), in
  `DataTable`'s rival bar, and in two `VcrDiagrams` marks — graphics that carry a value at 2.69:1. The ESLint serif ban stays scoped to the primitives on purpose now: the serif
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
- The DTCG files are validated structurally by the package test, not yet against the official
  2025.10 JSON Schema (it is not vendored, and CI does not fetch; the optional check was skipped
  locally because the external schema files were absent).
- The reader's print copy is mounted on `beforeprint`; a headless PDF renderer that does not fire
  that event prints the shell unless the event is dispatched first.
- The dated 2026-10-26 audit named pointer-only scientific-reader operations, canvas contrast hints,
  an initial Genome width observation failure, stale `ScrollRegion` fades and incomplete focus
  eligibility. The v3.1 implementation repairs these classes with keyboard / readout, resize, theme
  and focus fixtures; the original findings stay as historical evidence, and the final browser retest,
  the full dark routes, real assistive technology and the serving revision's adoption are distinct
  gates. Historical baseline counts are not new defects. Primitive gallery rows do not cover every
  scientific viewer, content length, page template or native frame.


### October 19 workflow correction

The owner requires usable workflows and visible memory charts, not compliance with the older drawer/tree shape at their expense. The memory landing opens its map when available, with explicit list and record links preserved. One real node or topic is enough to visualize; sparse dimensions use honest bars rather than a misleading radar or a missing chart. No-data and failed-read states remain distinct, and no placeholder records are fabricated.

Frontier evidence zones belong to the peer navigation. The whole card opens one addressed reader (owner, 2026-10-23: 展开摘要 and 详情 retired); the publisher link is separate (the reader's 「打开原文」) and Back restores the prior feed. GEO projects and conversations share a workspace identity and canonical progress. Sidebar module groups and a duplicated eight-step/eight-tab navigation are superseded; existing destinations and native DSH controls remain reachable. Non-VCR method libraries retain configuration, versioned jobs and results; VCR methods are AI tools and its historical calculations are read-only (2026-10-25/26 reset). Refer to `../docs/superpowers/plans/2026-10-19-workflow-rectification.md` for coverage and acceptance.


## Workflow correction adopted 2026-10-20

These presentation decisions supersede conflicting September 23, October 7/8 and October 14/19 rules precisely as described below. Earlier records remain historical; this is an acceptance target, not a claim that the implementation has passed. See `../docs/superpowers/plans/2026-10-19-workflow-rectification.md`, October 20 owner review.

- Global home, logo and New Conversation open the general AI assistant without inherited GEO/study title, progress or specialist binding. Resume-project links are explicit; preserve history, drafts and native tabs. The VCR home offers four task intents in the existing native composer and resumable research. Results and historical links remain reachable; there is no mandatory New Study form or manual method entry journey (VCR reset, 2026-10-25/26).
- Keep the eight GEO steps reachable with visible current/completed/waiting state and next actions, including during conversation. VCR instead has six result destinations (overview, matching, population/patients, comparator, trial, evidence/data), no mandatory step rail, and an optional full programme only when explicitly requested. The October 19 compact-control ruling removes redundant navigation, but a compact selector alone cannot be the only discoverable workflow. Use one conversation and one native composer; remove the redundant Chat button when it is open. Preserve project identity, results, actual run history and the native DSH right pane.
- Research Tools remains the shared discovery surface for professional workflows and non-VCR task-oriented tools. VCR numerical methods are AI-callable tools, not calculator catalogue entries or manual parameter forms; reference-trial research is available from global AI and the study evidence context. This supersedes the October 14 fixed catalogue inventory as a restriction on those method entries. Small calculations need not traverse a full study. Show a short purpose, required inputs, expected outputs and reachable next action; meaningful examples, missing prerequisites and remedies are explicitly permitted. The older blanket no-hint/no-purpose-text rule applies only to explanations of implementation, not useful task guidance.
- Related inputs, configuration, progress and result tables/plots belong together in one analysis workbench in the main area, with responsive tabs where useful. This is an explicit exception to the older one-object/one-shape rule, not permission to stack unrelated metadata. For VCR, the main area holds results, source-linked assumptions and comparisons; configuration and revisions use the native conversation, with only small structured edits in context. Other workbenches retain their existing configuration and literature-to-parameter mapping; drawers hold short previews or small edits. Do not repurpose the native right pane or add another file/browser system.
- Share reference-trial search across global AI and the study evidence context, with contextual reuse in the current research. Distinguish live results from saved status and source failures. Literature parameters retain values, units, passages, missing fields and destination mapping; registration alone never claims executability. Retain configuration/source versions and immutable historical results.
- The saved population object owns criteria, source data, included/excluded/unknown counts, selected version and cohort results. Select account-level reusable template versions in that context, preserve Save as Template/Use Template and compatible links, and recalculate changed criteria as a new version without overwriting history.
- Keep design tokens, default Chinese UI, keyboard/mobile access, ordinary-account access and user/project/tenant boundaries. Technical implementation, source-proof machinery and operator jargon stay out of UI; scientific sources needed to judge or reuse parameters remain available in context. No added approval ceremony or clinical delivery gate. Preserve existing quality budgets and acceptance checks; do not weaken them merely to pass unusable UI. A measured workbench-specific template change must express this connected workflow, not excuse unrelated stacked content.


## VCR conversation/result variant (2026-10-25/26)

Last updated: 2026-10-26. This replaces the VCR seven-step, method-catalogue and manual-configuration portions of the older templates and workflow rulings. GEO keeps its eight-step workflow. See the [approved product reset](../docs/superpowers/specs/2026-10-25-vcr-ai-native-product-reset.md) and [review](../docs/superpowers/specs/2026-10-25-vcr-ai-native-reset-review.md).

- The home presents four aligned task rows: matching, populations and virtual patients, comparators, trial-design simulation. A row fills an unsent draft in the existing native composer; it does not create a study, select a specialist or run a job. Each row visibly separates the task/action, expected result and minimum input requirement. Data labels are outside buttons, not hidden behind hover or mixed into button text. Existing research is resumable; calculation history is a quiet disclosure.
- One native conversation performs the work and its revisions. The six saved-result destinations are overview, matching, population/patients, comparator, trial and evidence/data. Group/individual scale is explicit within population; existing patient URLs remain compatible. No mandatory seven-step rail, manual PICO form or replacement composer. The full programme is available only on explicit intent. Preserve native file/browser/right-pane controls and actual run history.
- Results, source-linked assumptions, charts/tables and useful next actions share the main area. Adjust/compare sends the exact displayed object/version and result reference to the existing composer; a newer object never silently replaces the selected one. Historical configuration and numerical results are independently readable, with independent error/retry states and no new calculation action.
- Input labels distinguish one original patient case, a real patient dataset, longitudinal outcomes, an executable model, and work that can start from published parameters/assumptions. Show current availability separately; connected inputs satisfy the requirement. Empty/error/unavailable states retain matching-direction and individual/forecast controls so an unavailable subview does not hide another usable path. Native longitudinal intake remains reachable.
- A cohort view describes membership/distribution; an individual view describes a record and its complete supported observations or trajectory. Do not call every generated member a digital twin. Comparator views name the evidence route and preserve an explicit selected result. A prognostic benchmark is labeled as prediction, without treatment-effect, independent control-outcome or real/effective-N claims. Unknown values remain absent/unknown.
- Trial-design views distinguish full-study mean duration (`duration_months`, Monte Carlo uncertainty) from last-patient-in accrual timing. Fitted survival curves and extrapolation use distinct rendering; fitted-median parameter quantiles do not become patient percentiles. Unsupported absolute risks or adapter paths stay unavailable rather than interpolated into a scientific claim.
- Keep the v3.1 semantic tokens (warm paper and terracotta, above), typography, shared controls, Chinese baseline UI, mobile/keyboard access and the native frame. Huashu 3.0 informs conceptual hierarchy and purpose; Impeccable Operate/Read informs production interaction refinement. Neither authorizes a new brand world or prototype replacement.
- Local synthetic browser inspection verifies layout/navigation/accessibility only. Actual DSH/model completion, numerical correctness, real-record matching validity, clinical validation and production acceptance need their own evidence. These boundaries do not add a new approval flow.

## Implementation proof

Last updated: 2026-10-26. The [execution ledger](../docs/superpowers/plans/2026-10-26-design-system-v3-execution.md) maps all 21 DS groups and 50 AT scenarios to proof families and unresolved boundaries. Numerical validation is local: the R 4.3.3 suite passed 222/222 across 34 methods with all 158 exact dependency locks. This does not establish production scientific acceptance. Web, server and browser results are recorded in the ledger, not here.

The supported public native locale groups advanced commands under `command.section.commands` (高级命令与诊断). `loopx-init` remains its real command identifier. Theme-body focus lifecycle and identity with the optional theme off use supported seams; there is no private upstream command patch. Actual composer Enter, simulated composition events, reload without resubmission, stream selection/upward reading and theme on/off have local native-fixture evidence. Real hardware IME, screen readers, physical touch, LoopX execution absent from this fixture, external Vue adoption and installed production caches remain explicit boundaries.
