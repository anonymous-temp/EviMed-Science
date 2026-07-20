# Slice #1 — UI Shell + Static Workspace (Design Spec)

Date: 2026-07-02
Status: Awaiting user review (revised to match Claude Science reference screenshots)
Part of: AI4S Workbench Desktop v0.1 (see `docs/PRD.md`, `docs/TECHNICAL_DESIGN.md`)
Visual reference: three Claude Science screenshots provided by the user (logo need not match).

## 1. Why this slice first

v0.1 is ~8 independent subsystems. This slice is the frontend foundation every later
slice plugs into. It is independently verifiable (launch it, click through), needs no
Hermes/Python/Rust/network, and produces the README screenshots.

Build order for the rest of v0.1 (each its own spec → plan → implement cycle):
2. HermesClient SDK + live agent chat · 3. Runtime Manager · 4. Provenance + Reviewer ·
5. Literature search · 6. Artifacts/export · 7. Packaging/CI · 8. BCI demo content.

## 2. Goal & non-goals

**Goal:** a runnable frontend that reproduces the Claude Science interaction model with
mock data — a three-column workbench (sessions sidebar · thread/canvas · contextual
inspector) rendered in a warm paper aesthetic, faithfully matching the three reference
screenshots.

**Non-goals (this slice):** no real agent, data, persistence, network, code execution,
live kernel, or Tauri native shell.

## 3. Decisions adopted

- **First slice = UI shell + static workspace.**
- **Browser-first**: pure Vite React app via `pnpm dev`; the thin Tauri `src-tauri`
  wrapper is added later once Rust (rustup) is installed. Frontend code is unchanged when wrapped.
- **Component style**: shadcn-style copy-in components on Radix primitives + Tailwind.
- **Layout follows the screenshots** (three columns; no global top bar), superseding the
  earlier TopBar+ArtifactDock + page-per-route model in `docs/TECHNICAL_DESIGN.md` §6.3.
- **Light "paper" theme first**; dark theme structured via CSS variables but deferred.
- **PDF inspector** renders a styled HTML facsimile for the mock; real pdf.js deferred.

## 4. Tech stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | React + TypeScript + Vite | tech design §4.1 |
| Styling | Tailwind CSS + Radix UI (shadcn-style) | copy-in components |
| Routing | React Router | session-centric routes |
| UI state | Zustand | theme, active project/session, inspector state, palette |
| Command palette | `cmdk` | ⌘K / Ctrl+K |
| Markdown | `react-markdown` + `remark-gfm` | agent messages, reports |
| Code view | `highlight.js` (read-only, synchronous) | Monaco deferred |
| Fonts | `@fontsource` — serif display (Source Serif 4), sans (Inter), mono (JetBrains Mono) | bundled locally, offline-friendly |
| Icons | `lucide-react` | line icons matching the reference |
| Testing | Vitest + React Testing Library | TDD |

**Deferred (YAGNI):** Monaco, charting library (figures = static images), real pdf.js,
TanStack Query (no async yet), live notebook kernel, `packages/ui` extraction, real
Tauri shell, persistence, dark-theme polish.

## 5. Monorepo layout

Activate pnpm workspaces now:

- `pnpm-workspace.yaml` + root `package.json` (workspace scripts, shared devDeps).
- **`apps/desktop`** — the Vite React app (active).
- **`packages/shared`** — stable domain types imported by the app and later the SDK:
  `Project`, `Session`, `Message`, `StepSummary`, `ToolCall`, `ToolCallStatus`,
  `ReviewFinding`, `Artifact`, `ArtifactType`, `ArtifactVersion`, `NotebookCell`,
  `ProvenanceEvent`, `Citation`, `RunningJob`, `RuntimeStatus`, `ModelStatus`. (active)
- `packages/ui`, `packages/sdk` — stubs until a second consumer exists.

## 6. Application structure

```text
src/
  app/
    routes/        # route defs + top-level page components
    layout/        # AppShell, Sidebar, ThreadPane, InspectorPane
    providers/     # ThemeProvider, RouterProvider, StoreProvider
  components/
    sidebar/       # Wordmark, ProjectSwitcher, SidebarNav, SessionList, SettingsButton
    thread/        # ThreadView, UserMessage, AgentMessage, StepSummaryRow,
                   #   ToolCallRow, ReviewerCard, DataTable, FigureBlock,
                   #   AnnotationPopover, RunningJobsOverlay, StatusLine, Composer
    inspector/     # InspectorShell, ArtifactInspector, NotebookInspector, PdfInspector
    command-palette/  code-viewer/  markdown-viewer/  cards/  approval-dialog/
  features/        # onboarding, projects, chat, literature, artifacts, provenance,
                   #   review, skills, settings  (thin this slice; wired later)
  lib/
    store/  theme/  mock/  events/(stub)  api/(stub)
```

### 6.1 Layout — three columns (no global top bar)

`AppShell` = `Sidebar` (left, ~272px) · `ThreadPane` (center, flexible) · `InspectorPane`
(right, ~46%, collapsible/closable).

**Sidebar** (white, thin right border):
- Wordmark (serif) + `Beta` tag.
- Project switcher: `←  <Project name>  ▾` (back arrow + dropdown).
- Nav actions: `+ New`, `Customize`, `Files` (lucide icons).
- Grouped session list under section headers (`Today`, `Active`); each row = status dot +
  title (truncated) + optional right-aligned count badge (e.g. `8`).
- Footer: settings gear, plus small runtime/model status pills.

**ThreadPane** (center): renders the active session as an ordered list of blocks +
a sticky bottom `Composer`. Block types (all from mock this slice):
- `UserMessage` — soft gray rounded bubble.
- `AgentMessage` — markdown text with **blue monospace inline-code tokens**.
- `StepSummaryRow` — collapsible: `› Ran 4 searches, loaded 2 skills, … +2 more` · right `10 steps`.
- `ToolCallRow` — leading icon + summary + right meta (`142 lines of output`, elapsed).
  Status ∈ {Pending, Running, WaitingApproval, Success, Warning, Failed} with a badge.
- `ReviewerCard` — header `⛊ Reviewer · N findings`; each finding has a colored badge
  (`Warn`=amber, `OK`=green ✓, `Error`=red), title, and an expandable monospace evidence body.
- `DataTable` — bordered table (the arm/n_latent/label example), monospace label cells.
- `FigureBlock` — captioned static image; supports an `AnnotationPopover`
  (numbered pin + note text + `Send` button), matching shot 1.
- `RunningJobsOverlay` — floating `REMOTE · N` list of jobs (spinner + label + elapsed).
- `StatusLine` — e.g. `⚡ 8 running · 16m 2s` or `all 5 agents done · Reviewing`.
- `Composer` — rounded input `Ask anything`, left `+`/tools icons, right mic + **rust send button**.

**InspectorPane** (right): `InspectorShell` (header: title, version selector `‹ v2 ›`,
download, close) hosting one of three variants:
- `ArtifactInspector` — tab bar `Code · Execution Log · Messages · Environment · Review ✓`;
  `Download script` button; `Inputs` chips (filenames); `CodeViewer` with line numbers. (shot 1)
- `NotebookInspector` — notebook name tab + `Shared with the agent` + `● Live ▾`;
  cells (`[28] python`) with line-numbered code; `> output`; kernel footer text. (shot 2)
- `PdfInspector` — `review.pdf`; styled two-column HTML facsimile (title, summary table,
  figure, equations, sections). (shot 3)

### 6.2 Routes

| Path | Renders |
| --- | --- |
| `/` | redirect to the mock project's default session |
| `/project/:projectId/session/:sessionId` | AppShell with the session thread + its inspector |
| `/skills` | Skills page (installed / recommended / install-from-GitHub) — paper aesthetic |
| `/settings` | Settings (model provider, masked API keys, workspace path, backend, approvals, theme) |
| `*` | NotFound (404) |

Files/Customize open lightweight panels within the shell (mock). The PRD's Literature /
Data&Code / Artifacts / Review surfaces are represented through the thread + inspector
this slice; dedicated pages for them are later slices.

## 7. Visual system (warm paper)

CSS custom properties; light theme is authoritative, dark defined but unpolished.

| Token | Light value (approx) | Use |
| --- | --- | --- |
| `--bg` | warm cream `#F7F5EF` | app background |
| `--surface` | white `#FFFFFF` | cards, panels |
| `--border` | `#E7E3DA` | hairline borders |
| `--text` | warm near-black `#2A2723` | body text |
| `--muted` | `#8C877D` | secondary text |
| `--accent` | rust/terracotta `#C15F3C` | send button, primary action |
| `--link` | blue `#2A6FDB` | links, inline-code tokens |
| `--warn` | amber `#C98A2B` | Reviewer Warn |
| `--ok` | green `#4B8B5B` | Reviewer OK / success |
| `--error` | soft red `#C0564B` | failures |
| radius | 12–16px cards, 10px inputs | generous rounding |

Fonts: serif display for wordmark + PDF facsimile; humanist sans (Inter) for UI; mono
(JetBrains Mono) for code and inline tokens. Theme toggle in Settings, persisted to
`localStorage`; first load respects `prefers-color-scheme`.

## 8. Mock data (three reference surfaces)

One mock **project** with several **sessions**, under `src/lib/mock/`, typed against
`packages/shared`. Three sessions reproduce the screenshots so all block/inspector types
are exercised and the result is screenshot-ready:

1. **Figure canvas** (shot 1): a session showing a `FigureBlock` (UMAP placeholder image)
   with an `AnnotationPopover`; inspector = `ArtifactInspector` (Python code, Inputs chips,
   Review tab checked).
2. **Hyperparameter screen** (shot 2): title + inline-code prose + `DataTable` (8 arms) +
   `FigureBlock` + `RunningJobsOverlay` + `StatusLine`; inspector = `NotebookInspector`
   (pandas/scanpy cell + output + kernel footer).
3. **Literature review** (shot 3): user message + `StepSummaryRow` + `ToolCallRow` +
   `ReviewerCard` (one Warn finding with monospace evidence) + agent acknowledgment;
   inspector = `PdfInspector` (review.pdf facsimile). Aligns with the PRD BCI/lit-review demo.

Content is illustrative (adapted to AI4S Workbench, not copied verbatim from Claude Science).

## 9. State & data flow

- **Zustand**: `uiStore` (theme, sidebar/inspector collapse, palette open),
  `sessionStore` (active project/session id, selected artifact + inspector variant,
  expanded step/reviewer rows). Mock imported synchronously; no async layer.
- `lib/events`, `lib/api` are typed stubs so slice #2 implements them without restructuring.

## 10. Error & empty states

404 route; empty-state components (no sessions, no artifacts, no findings); disconnected
runtime/model status pills; reusable loading-skeleton components (even though mock is sync)
for slice #2.

## 11. Testing (TDD)

Vitest + React Testing Library, tests first:
- The session route renders each of the three mock sessions without throwing.
- `ToolCallRow` renders the correct badge per status; `ReviewerCard` shows the finding
  badge and expands/collapses.
- `Composer` renders and the send button is the accent color; `AnnotationPopover` opens.
- `InspectorShell` switches among Artifact / Notebook / PDF variants and Artifact tabs switch.
- Theme toggle flips `data-theme` and persists; CommandPalette opens on ⌘K/Ctrl+K and filters.

## 12. Success criteria (verification)

1. `pnpm install && pnpm --filter desktop dev` serves the app in a browser.
2. All three mock sessions render, each with its correct inspector variant, matching the
   screenshots' structure in the light paper theme.
3. ⌘K/Ctrl+K opens the palette and filtering works.
4. Zero console errors/warnings on navigation and inspector switching.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.
6. Each of the three surfaces is screenshot-ready for the README.

## 13. Explicitly out of scope / deferred

Real Tauri shell, Monaco, charting lib, real pdf.js, TanStack Query, live notebook kernel,
`packages/ui` / `packages/sdk` implementation, real agent/runtime/data, persistence,
literature APIs, provenance writing, packaging/CI, polished dark theme. Each is a later slice.
