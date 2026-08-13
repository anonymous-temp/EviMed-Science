# EviMed Science (hosted SaaS + optional desktop)

Brand name: **EviMed** — an AI research workbench for evidence-based medicine.
(Bundle identifier stays `com.ai4s.workbench` and
internal `@ai4s/*` package names are unchanged — display branding only.)

Project rules and working context for AI agents (Claude Code, Cursor, Codex, etc.).
`CLAUDE.md` is a symlink to this file — edit only `AGENTS.md`.

## Design principles

Keep it **simple, explicit, clear, complete**.

- **Simple** — no over-engineering; if not necessary, do not add entities.
- **Explicit** — no ambiguity; no bugs.
- **Clear** — understandable at a glance.
- **Complete** — cover the key points; prioritize safety.

## What this project is

The primary release is a hosted, multi-tenant SaaS research platform. The same
frontend can also be packaged as an optional local-first desktop workbench for
macOS and Windows, but desktop packaging is not the core production release.
See `README.md`, `docs/PRD.md`, and `docs/TECHNICAL_DESIGN.md`.

Recommended stack: **Tauri 2 + React + TypeScript + Vite**, Tailwind (design-token CSS variables; hand-built components + cmdk + lucide; only one Radix package remains: `react-popover`),
**OpenCode** as the agent runtime (bundled single-binary sidecar; HTTP + SSE API),
local workspace + SQLite + JSONL provenance.

## Repository map

- `apps/desktop/` — Tauri + React desktop shell (`src/` frontend, `src-tauri/` Rust).
  Frontend layout: `src/app/` (router, routes, layout, providers), `src/components/`
  (feature components + `components/ui/` primitives: Button, Input/Textarea, Card,
  SegmentedControl, ConfirmDialog, Toaster, EmptyState, Skeletons, ShortcutHelp),
  `src/lib/` (stores, runtime, hooks). There is no `src/features/` — it was removed.
- `packages/` — `ui` (placeholder README only — real primitives live in
  `apps/desktop/src/components/ui/`), `shared`, `sdk` (the `OpenCodeClient` wrapper).
- `runtime/` — `manager`, `opencode-profile` (planned placeholder; the real
  profile/agents/MCP config is generated per runtime by
  `apps/server/src/runtimeManager.mjs` and `apps/desktop/src-tauri/src/opencode_config.rs`),
  `mcp`, `skills` (`skills/evimed/` holds the specialist agent packages plus the
  default `open-domain-answer` agent that handles unrouted open-domain questions).
- `docs/` — product and technical specs. `docs/REQUEST_PATH.md` traces one request
  end to end (HTTP boundary → routing → run ledger → runtime → MCP → external
  gateways → delivery gate → artifact retrieval) with each segment's timeout
  semantics, the system-wide timeout table and its contradictions, and the list of
  places a failure leaves no log, no changed return value, and no ledger entry.
- `examples/bci-trends/` — the built-in demo project.
- `scripts/` — release and dev scripts.

## Architecture guardrails

- The UI never calls OpenCode directly — it goes through `packages/sdk` (`OpenCodeClient`).
  Pin the OpenCode version (see `OPENCODE_VERSION`) and bundle it as a sidecar.
- Keep the frontend, desktop shell, and agent runtime decoupled.
- Skills, MCP servers, and model providers must stay pluggable.
- Keep the artifact schema and workflow templates stable and versioned.

## Frontend conventions (design system)

- UI baseline language is **Simplified Chinese** (code/comments stay English);
  technical identifiers (URLs, enum values, model/provider ids) stay as-is.
- Design tokens are the single source of truth: colors via CSS variables in
  `src/index.css` + `tailwind.config.js` semantic mapping (light/dark via
  `[data-theme]`); type scale `text-caption/ui-sm/ui/body/title/display`;
  containers `max-w-content-narrow/content/content-wide/content-full`;
  radii `rounded-input/rounded-card`; shadows `shadow-card` (static) / `shadow-pop` (overlays).
- ESLint bans new arbitrary values (`text-[Npx]`, `rounded-[Npx]`, bare
  `shadow-sm/md/lg`) across `src/**` — use the semantic scales; rare exceptions
  need an inline `eslint-disable` with a reason. `eslint-plugin-jsx-a11y` is enforced.
- New UI must use the `components/ui/` primitives instead of hand-rolled
  buttons/inputs/empty states; keep the four-state discipline (loading skeleton /
  empty / error-with-retry / success) on every list page.
- Theme is three-way (`light/dark/system`); never hardcode `text-white` on accent
  surfaces — use `text-accent-fg` / `text-error-fg`.

## Safety defaults (non-negotiable)

- The agent may only access the current workspace.
- Command execution, file deletion, dependency install, and remote connections
  require approval (manual approval mode by default — never ship `off`).
- API keys go to the OS keychain / credential manager; never into provenance,
  logs, crash reports, git, or exported projects.

## Working conventions

- Default working language for discussion is Chinese; **all project files and
  code are in English** (this is a pure-English project).
- One progress file: `PROGRESS.md`. Append one line per real milestone,
  `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top. Results and
  blockers only.
- Avoid adding new Markdown docs unless requested — too many docs become debt.
- Prefer minimal, verifiable changes; every step should produce a checkable result.
- Do not write inferences as verified facts; tie conclusions to code or data.
