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
**DeepSeek Harness** as the agent kernel, one per project runtime container, reached
only by the control plane (never by a browser),
local workspace + SQLite + JSONL provenance.

## Repository map

- `apps/desktop/` — Tauri + React desktop shell (`src/` frontend, `src-tauri/` Rust).
  Frontend layout: `src/app/` (router, routes, layout, providers), `src/components/`
  (feature components + `components/ui/` primitives: Button, Input/Textarea, Card,
  SegmentedControl, ConfirmDialog, Toaster, EmptyState, Skeletons, ShortcutHelp),
  `src/lib/` (stores, runtime, hooks). There is no `src/features/` — it was removed.
- `packages/` — `ui` (placeholder README only — real primitives live in
  `apps/desktop/src/components/ui/`), `shared`, `domain` (`@evimed/domain` — the
  vocabulary every other package derives from: tool names, contract kinds, the
  workspace layout, the four state vocabularies, the error-code registry and the
  delivery-gate rules), `harness-port` (the only package that may import
  `@deepseek-ai/*`), `socket` (`@evimed/dsh-socket` — the plug: the
  `evimed-universal` composition and its eight plugins — six in the base
  preset (`guidance`, `run-policy`, `evidence`, `capsule`, `screening`,
  `review`) plus `seam-probe` and `evidence-store`, inserted by the bundle's
  own `cordis.patch.yml`), `contracts` (one
  directory per tracked upstream pin), `sdk` (retiring with the desktop shell).
- `capabilities/` — one directory per capability: `capability.yaml` (the only
  definition of a capability) plus its SKILL.md and scripts. `capability-skills/`
  holds the shared skill bodies delegation pre-injects.
- `deploy/runtime-dsh/` — the runtime image: Node, the pinned kernel, the socket
  bundle, the capability manifests and a profile pre-initialized at build time.
- `deps-version.json` — the one place a tracked upstream pin is written
  (`dsh` / `memos` / `openlist` / `mineru`). A Dockerfile ARG, a seam manifest,
  a peer dependency and a release manifest that each carried their own copy
  meant "bump the pin" was four edits and one was always missed.
- `runtime/` — `mcp` (the `evimed` research server, 26 tools), `kernel` (the
  Python/R notebook bridge), `harness` (design notes and knowledge from the
  kernel migration), `skills` (the general skill libraries the image ships:
  `core`, `community`, `curated-scientific`, `office`; `evimed` and `external`
  predate `capabilities/` — the image takes only `open-domain-answer` out of
  `evimed`, and the rest of that tree survives as one of the four places a
  capability's `preflight.py` is copied to).
- `docs/` — product and technical specs. `docs/REQUEST_PATH.md` traces one request
  end to end (HTTP boundary → routing → run ledger → runtime → MCP → external
  gateways → delivery gate → artifact retrieval) with each segment's timeout
  semantics, the system-wide timeout table and its contradictions, and the list of
  places a failure leaves no log, no changed return value, and no ledger entry.
- `examples/bci-trends/` — the built-in demo project.
- `scripts/` — release and dev scripts.

## Architecture guardrails

- **The browser never reaches an agent kernel.** It talks to `apps/server`, which
  decodes the kernel's events into `@evimed/domain`'s `RunEvent` and forwards its
  own stream (`GET /api/runs/:id/events`). The pass-through route that used to
  proxy a kernel straight into the page is retired: it made the frontend know a
  kernel's protocol, so every kernel change was a frontend change. `/api/opencode/`
  keeps the retired kernel's name and answers 410 by name, because a URL is what
  an already-deployed client types and a rename would turn each of those requests
  into an anonymous 404.
- **One socket carries the whole kernel wire.** `apps/server` opens a single
  WebSocket per runtime at `/api/remote.mux`, multiplexing independently
  cancellable logical streams; methods are slashed names (`session/create`,
  `session/prompt`, `session/page`, `session/cancel`, …) and the kernel's forwarded
  host events arrive on the `$events` stream. The kernel authenticates it with a
  browser-session cookie the control plane mints itself, and it derives that
  cookie's name from the `Host` header, so a cookie minted for another authority
  is not a weaker credential — it is one the kernel never looks for. `dshMux.mjs`
  is where that lives; the frame vocabulary there was transcribed from a running
  0.1.2-alpha.3 binary, not inferred.
- **`@deepseek-ai/*` may be imported in `packages/harness-port` and nowhere else** —
  including in a JSDoc `import()` type. The port owns its own types and converts
  shapes, so a rename upstream is one file. `seam-manifest.json` lists every
  contact point and is the single source the port's exports, the startup probe,
  the lint allow-list, the contract tests and the method allow-list derive from.
- **Versions are pinned in one place.** `deps-version.json`; tests assert every
  derived copy equals it. The kernel makes no compatibility promises before its
  first tagged release, so the discipline is: exact pin, fail-closed startup
  self-check, contract tests with golden frames, nightly matrix, security fixes
  evaluated the day they land.
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

- The agent may only access the current workspace. Writes are fenced by the
  kernel sandbox; reads and network are not, so the container's filesystem mounts
  and network policy are what actually bound them.
- **The runtime never holds a real provider key.** The kernel's `baseURL` points
  at our model gateway and its `apiKeyEnv` names a reference resolved per request
  from a 0600 credentials file the control plane rewrites in place — so a token
  rotation is a file write, not a restart.
- **Approval policy is `never` in a hosted deployment, and `never` means
  auto-refuse, not auto-approve.** Inside the sandbox nothing needs approval; the
  only things that ask are attempts to step outside it, and refusing those is
  exactly right for an unattended run. A local profile uses `ask`.
- Telemetry is disabled in the image, in the patch and in the container
  environment — three places, because any one of them being undone leaks message
  bodies, tool arguments and workspace paths.
- API keys go to the OS keychain / credential manager; never into provenance,
  logs, crash reports, git, or exported projects.
- **A capsule is context, never permission.** Nothing a memory capsule or an
  imported workstyle pack says can loosen a contract, relax a safety rule, or
  reach a host the gateway would not.

## Working conventions

- Default working language for discussion is Chinese; **all project files and
  code are in English** (this is a pure-English project).
- One progress file: `PROGRESS.md`. Append one line per real milestone,
  `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top. Results and
  blockers only.
- Avoid adding new Markdown docs unless requested — too many docs become debt.
- Prefer minimal, verifiable changes; every step should produce a checkable result.
- Do not write inferences as verified facts; tie conclusions to code or data.
