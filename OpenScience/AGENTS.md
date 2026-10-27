# EviMed Science (hosted SaaS)

Brand name: **EviMed Science** — a general-purpose agent platform first and, on top of it, a professional layer for evidence-based medicine (owner, 2026-10-12).
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

A hosted, multi-tenant SaaS agent platform: a general work assistant first (documents, spreadsheets, slides, code, data, the open web, scheduled work), with the medical research method, vocabulary and checks loaded when the task or the content is medical — enhancement and labels, never a precondition for other work. There is no second form: the
optional desktop packaging was deleted on 2026-09-04 along with the Tauri shell
and the browser-side kernel client. See `README.md`, `docs/PRD.md`, and
`docs/TECHNICAL_DESIGN.md`.

Stack: **React + TypeScript + Vite**, Tailwind (design-token CSS variables; hand-built components + cmdk + lucide; only one Radix package remains: `react-popover`),
**DeepSeek Harness** as the agent kernel, one per project runtime (a Docker container on the
host, or an AgentBay session with `OPEN_SCIENCE_RUNTIME_PROVIDER=agentbay`), reached
only by the control plane (never by a browser),
per-project workspace + JSONL provenance.

## Repository map

- `apps/web/` — the React single-page frontend (`@ai4s/web`), served by `apps/server`.
  Layout: `src/app/` (router — every page under `/app`, layout, providers),
  `src/components/` (feature components + `components/ui/` primitives: Button,
  IconButton, Tooltip, Tag, FilterChips, Tabs, ListRow, Panel, Menu, Switch, SearchInput,
  Input/Textarea, Card, ConfirmDialog, Toaster, ShortcutHelp; `EmptyState` and
  `Skeletons` in `components/cards/`), `src/lib/` (api client, project store, run stream).
  There is no desktop packaging: the Tauri shell, its Rust command layer,
  `packages/sdk` and the browser-side kernel store were deleted on 2026-09-04.
- `packages/` — `shared`, `design-tokens` (`@evimed/design-tokens`, see
  below), `domain` (`@evimed/domain` — the
  vocabulary every other package derives from: tool names, contract kinds, the
  workspace layout, the four state vocabularies, the error-code registry and the
  delivery-gate rules), `harness-port` (the only package that may import
  `@deepseek-ai/*`), `socket` (`@evimed/dsh-socket` — the plug: the
  `evimed-universal` composition and its eighteen plugin rows — nine agent-scope
  policies in the preset and nine host-scope rows the bundle's own
  `cordis.patch.yml` inserts, listed in `HOST_PLUGIN_IDS` / `AGENT_PLUGIN_IDS`,
  plus the scoped Cowork bridge), `contracts` (one directory per tracked
  upstream pin).
- `capabilities/` — one directory per professional workflow: `capability.yaml` (the only
  definition of a capability) plus its SKILL.md and scripts. An ordinary task
  needs none; its units are a skill, a tool and the general `file-deliverable` contract. `capability-skills/`
  holds the shared skill bodies delegation pre-injects.
- `deploy/runtime-dsh/` — the runtime image: Node, the pinned kernel, the socket
  bundle, the capability manifests and a profile pre-initialized at build time.
- `deps-version.json` — the one place a tracked upstream pin is written
  (`dsh` / `openlist` / `evimed-extract` / `openviking` / `pgvector` / `knowledge-plugin` / `loopx`, among others). A Dockerfile ARG, a seam manifest,
  a peer dependency and a release manifest that each carried their own copy
  meant "bump the pin" was four edits and one was always missed.
- `runtime/` — `mcp` (the `evimed` research server; its tool roster is
  `MCP_TOOL_BASE_NAMES` in `packages/domain/src/toolNames.mjs`, which
  `apps/server/test/evimedMcp.test.mjs` holds equal to what the server publishes, so no count
  is written here to go stale), `skills` (the
  general skill libraries the image ships: `core`, `community`,
  `curated-scientific`, `office`; `evimed` and `external`
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
  0.1.2-alpha.3 binary, not inferred (the pin has since moved more than once;
  every frame type, event and session-event name that vocabulary uses still
  appears in the shipped code, which `pnpm verify:seams` checks, and the golden
  fixture re-recorded off a live kernel at each pin move is what checks the
  frames themselves).
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
- Keep the frontend, the control plane, and the agent runtime decoupled.
- Skills, MCP servers, and model providers must stay pluggable.
- **Reuse upstream with the narrowest adapter.** Before building a piece, find the one that already does it
  (a DSH row or plugin, an official skill, a mature library, OpenViking's native engine); a mismatch with a
  boundary we drew is an adapter, a shim or a template with a stated date of deletion, not a rebuild.
- **OpenViking is an engine, not only an index** (v0.5.1.1, `packages/contracts/openviking/README.md` is the
  division of labour; the identity shim of v0.5.0 is deleted, and a write-back to a knowledge page is a checked write). Every account's memory is the engine's own: it extracts, merges and recalls; the runtime's official
  plugin reaches it through a loopback bridge and the control plane's memory gateway; PostgreSQL keeps a thin
  overlay. Without OpenViking memory is off as a status, never a fallback (the control plane's own records engine was
  deleted on 2026-10-25). The knowledge base pushes every readable document to the engine as a Resource, and the official
  `llm-wiki` and `knowledge-graph` skills compile the wiki and the graph, mirrored back into the product
  ledger; quotation checks on them are ✓ / ⚠ labels, not a condition. The engine's model calls go through our
  model gateway; the runtime holds no key; the volume is backed up.
- **Memory keeps what the person stated, confirmed or corrected** — and the constraints they gave for a named piece of
  work — and never what a document, a tool, a web page, the platform or the assistant said. The two shared blocks of
  `packages/domain/src/memoryNeverKept.mjs` (what is never kept, how to decide) are the one place the policy is written; a
  change to them is replayed on `evals/memory-write-quality` (every case, a failing one three times) and the never side
  only gets better. A native memory has no expiry date and nothing promises one.
- **A person has one capsule**; a project is a label on its entries, a received pack is enabled for the whole account, and a
  native account reaches its capsule through the memory gateway's `search` and a profile block, never a second recall
  tool. A capsule is context, never permission (below).
- **The learning loop learns only from the researcher's own work.** A script or eval that starts a run marks it
  `automated` (`apps/server/test/automatedDrivers.test.mjs` holds the list); evidence is the person's own words, checked
  as a substring of what they wrote, or their opening a delivered file, and silence is unknown, never approval; nothing is withheld from a run on purpose to measure a method; a method takes
  effect at once and every automatic stop or change is restorable in one click and carries its reason.
- Keep the artifact schema and workflow templates stable and versioned.

## Frontend conventions (design system)

- UI baseline language is **Simplified Chinese** (code/comments stay English); technical identifiers
  (URLs, enum values, model/provider ids) stay as-is. The maintained design authority is
  `docs/FRONTEND_DESIGN_SYSTEM.md` **v3.1**; `DESIGN.md` holds the engineering rules and the component
  adoption map; component JSDoc plus `/__gallery` and the composition fixtures own each implemented
  contract; product scope stays in the linked module plans. Chinese reading copies are dated snapshots
  or link indexes, not a second normative specification.
- **The design tokens are one package — `@evimed/design-tokens`
  (`packages/design-tokens/src/index.mjs`) — and `DESIGN.md` is its prose.** It generates seven
  artifacts into `dist/` and no consumer restates a value: the block in `src/index.css`
  (`pnpm tokens:css`), the Tailwind preset both front ends extend, the Element Plus theme the Vue shell
  links, the ECharts theme both sides register, the kernel frame's `overrideTokens` map, a Figma token
  file and the DTCG export. Change a value by editing the table, `pnpm tokens:build`, bumping the
  version and `record-release` (`src/release.json` binds the digests to the version); `pnpm tokens:check`
  fails on a stale artifact and `apps/web/src/app/designTokens.test.ts` regenerates and compares, so
  editing a consumer instead of the table is a red test. Contrast is recomputed at build time and a
  shortfall fails the build. The shell conforms to the kernel, not the other way around. Token
  **3.0.0** implements specification **3.1**; the earlier main 2.2.0 and warm-brand 2.3.0 reads are
  historical baselines. This brand and status reinterpretation is a major version, compatible
  additions are minor, and within-role tuning is patch. The specification, `DESIGN.md`, this file, the
  token package and release metadata, the generated consumers, the brand assets and the consumer
  pins/readbacks reach the reviewed change together; publishing, merging and deploying remain separate
  stages with their own receipts.
- Brand is **warm paper, terracotta actions (`#a34427`) and an ink EviMed mark** (owner, 2026-10-26;
  the 循证蓝 `#0a5dc1` palette retired): the independent `brand-ink` role is near-black in the light
  theme and paper ink in the dark, so an accent change never recolours the logo, and the native shell
  keeps visible logo ink when its optional theme body is off. Role decisions implemented in 3.0.0
  (specification DS02.3): green verification, exact text-role titles, navy information and running
  dots, ink focus on text fields with accent focus on buttons and links, neutral popularity tags.
  Scientific categorical palettes and the closed study-type colours remain explicit data exceptions.
  In a comparison chart we are the brand and every rival is a grey (`CHART_COLORS`; `CHART_OWN` /
  `CHART_COLORS.own` identify our series, `CHART_SERIES` is a different categorical contract) —
  compute colour distance (`cie76`), never rely on a comment. One sans stack for the chrome; the
  **serif is three brand moments only** — the wordmark, the home headline, a document title
  (`text-wordmark`/`text-hero`/`text-doc-title` carry the family). Nine sizes
  (12/13/14/16/18/20/24/32/40) as `text-badge/meta/caption/compact/ui/body/
  wordmark/section/heading/title/doc-title/display/metric/metric-lg/hero`, still at most four size ×
  weight pairs per page (five on a data page) and **32/40 on data pages only**; weights 400/600 for
  Chinese (`font-medium` is an ESLint error); a line of text at most 40 CJK characters (`max-w-measure`
  560 / `-body` 640). The per-template type budgets remain, and meaningful units and help are not
  removed to lower a mechanical text count. **Three columns through `PageShell`**: `max-w-read` 720
  (answers, reports), `max-w-page` 1040 (lists), `max-w-wide` 1200 (dashboards); its header is one
  line with **no subtitle**. Radii: `rounded-tag` 6, `rounded` 8 (controls, rows), `rounded-card` 12,
  `rounded-panel` 16 (dialogs, drawers), `rounded-composer` 24, `rounded-full` pills. Heights: 28 small,
  36 default, 44 primary, tags 22. Icons 16 / 20, one stroke (1.5). One accent (links too). Static
  cards have no shadow — `shadow-e1` / `shadow-e2` (composer, menus, popovers) / `shadow-e3` (dialogs,
  drawers). **Restraint is the default and expression has a budget**: one brand moment per page,
  charts and metric rungs on data pages. The component set (`PageShell`, `Tabs`, `FilterChips`, `Tag`,
  `Button`, `IconButton`, `List`/`ListRow`, `Panel`, `EmptyState`, `StatTile`, `Delta`, `ChartCard`,
  `DataTable`, plus `Menu`, `Switch`, `SearchInput`) is in `DESIGN.md`; ESLint rejects a hand-made
  bordered pill or bordered button outside `components/ui/`.
- **The interface never explains the system** (2026-09-23 plan; blanket hint/subtitle prohibitions
  superseded for useful task guidance by the October 20 ruling below): no subtitle, no hint under a
  card title, no 「为什么入选」; no internal state as text (已交付, 核对 N 条, 用过 N 次, token, tok/s,
  API names, ids). Say what the user can do and the result. The example pills on a blank conversation
  tell the user what can be asked; that is not explaining the system. Nothing shows back-office
  provenance, an engine name or a file address. Purpose, required inputs, units, examples,
  prerequisites, limitations and recovery are explained where they help; raw implementation
  diagnostics stay out of ordinary tasks, while an intentional user choice (the model a person picked)
  is theirs and not provenance. A static tag is not a button, and a row predicts whether it filters,
  configures or opens a destination.
- **Page structure** (one-object and drawer restrictions qualified by the October 20 workbench ruling
  below; 2026-10-07 plan §9.4, `DESIGN.md` 「页面结构」): a page serves one coherent task — a list of
  one kind of object, with a data page (the memory dashboard 总览, the knowledge base's reader and graph) and a
  connected workbench (the related inputs, configuration, progress and results of one task, in the
  main area) as the named exceptions (`DESIGN.md` rule 1); short record detail opens in a drawer, long
  configuration and documents use the main area; articles and documents have addressed reading pages,
  and conversations remain in their project workspace. The header is the title, the scope and at most
  one primary button, and nothing that looks clickable may be silent; keep one dominant action per
  local group, one native composer and no redundant workflow rails. `scripts/ops/ui-walk.mjs` measures
  it on the live pages after every release. Since R19 (2026-10-14) a page is **composed from slots**,
  not drawn: `PageShell` takes `scope`, `steps`, `activity`, `tabs`, `toolbar` and `headline` and
  renders them in one fixed order, the appropriate workflow selector, view navigation and toolbar in
  one band without redundant step/tab bars (owner, 2026-10-19); the pieces are `Toolbar`, `StepRail`,
  `StepState`, `ActivityStrip`, `Note`, `Headline`, `Section`, `FactList`, `ChartGrid`, `Outline`,
  `MasterDetail`, `ScopeMenu` and `StateScreen` in `components/ui/`. A page does not write its own
  filter row, step rail, tab bar or standalone grey sentence. 循证 GEO keeps its eight steps; 虚拟临床研究
  has six result destinations and no mandatory step rail (the reset of 2026-10-25/26). `DESIGN.md`
  「页面结构」 holds the six templates (T1–T6, still keyed in `scripts/ops/page-templates.json`) and
  rules 7–13; `layoutRules.test.ts` (a count that may only fall) and `pageComposition.test.tsx`
  (document order, via `expectComposed`) hold them; the layout lint rules are errors, and the files
  still drawing their own controls are `layout-lint-baseline.json` (warnings there, each count held by
  `layoutLint.test.ts`). The lint and walk budgets remain until a scoped, evidence-backed change updates
  them; never weaken one just to pass, and informative empty or zero-count views may preserve context
  and offer a reset or next step.
- **Module names** (the owner's rulings of 2026-10-07): the product calls its two modules 「循证 GEO」
  (code `geo`; it was 「循证传播」 only from 2026-10-06) and 「虚拟临床研究」 (code `vcr`; it was
  「虚拟临研」) everywhere a reader or a model sees them — pages, notices, e-mails, error sentences,
  capability titles and SKILL text. Identifiers, routes, schemas, `OPEN_SCIENCE_*` keys and file
  names keep `geo` / `vcr`. The old names are retired words: `retiredWords.test.ts` (web) and
  `geoProductName.test.mjs` (server) fail on them, the walk fails on a page that shows them, and
  the search boxes over tools, skills and plugins read them as the new names until 2027-01-07
  (`@evimed/domain`'s `retiredNames.mjs`). A line that must hold an old name as data carries
  `retired-word-ok`. Paths, schemas and configuration identifiers do not change for visual branding.
- ESLint bans new arbitrary values (`text-[Npx]`, `rounded-[Npx]`, bare
  `shadow-sm/md/lg`, `shadow-card`, opacity modifiers on token colours) across
  `src/**`, and `font-serif` inside `components/{ui,layout,cards}` — use the
  semantic scales; rare exceptions need an inline `eslint-disable` with a
  reason. A test fails on hex literals outside the token module.
  `eslint-plugin-jsx-a11y` is enforced.
- New UI must use the `components/ui/` primitives instead of hand-rolled
  buttons/inputs/empty states; keep the four-state discipline (loading skeleton /
  empty / error-with-retry / success) on every list page. Apply the full read and mutation state
  contracts: unknown is not zero; first-read and refresh failures are distinct; useful old results and
  drafts are preserved with local recovery. Switches are reversible preferences; a setting that takes effect
  in a later runtime is a labelled switch for the saved choice with its effective-time status beside it. An
  `aria-disabled` busy button needs a real duplicate-activation guard.
- Each touched public component adopts the nine-field JSDoc header in `DESIGN.md` (anatomy, variants,
  states, hit area, keyboard, long content, theme, responsive, verification), written from its real
  behaviour with pending gaps linked, not described as present. DS/AT ids identify owner and proof
  (lint, tests, walk, gallery, manual); do not infer implementation or accessibility from prose or a
  static screenshot. Ownership: H is host-built, K is kernel-native, B crosses both; the native
  composer's IME, Enter and stream-follow behaviour is K-owned acceptance, host fields and viewers are
  H-owned, and an upstream or seam gap is fixed through a supported boundary — never a second composer
  or a cross-origin DOM patch. DS21 owns the shared latency, mutation, undo, notification, keyboard,
  navigation, naming, formatting, IME and batch contracts.
- Theme is three-way (`light/dark/system`); never hardcode `text-white` on accent
  surfaces — use `text-accent-fg` / `text-error-fg` (semantic foreground roles). Check forced colours,
  reduced motion, narrow and intermediate widths, keyboard and actual AT or touch separately; current
  package tests do not certify fixed scientific canvases or every native-frame state.
- Full rule details and exceptions live in the linked specification, not as repeated and contradictory
  fragments here. No design rule introduces a clinical delivery veto or deletes usable research.

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

## Hosted extension preparation

The owner authorized an ordinary-user extension and personal-skill center. Reuse
native DSH package inspection, preparation, skill parsing and scoped loading;
only harness-port may import upstream DSH packages. Do not expose unrestricted
profile administration or enable HMR in a serving research installation.

Exact packages may be prepared in bounded disposable jobs outside the web
process, without customer workspaces, provider credentials or host-control
sockets. Activate a deployment-owned read-only generation after current work
finishes; retain the exact extension and skill identities on each run. Unknown
host code uses an admitted isolated tool/viewer boundary or stays unsupported.
Only independently measured artifact/adapter/runtime/permission combinations
may be offered as SaaS qualified. Personal imports cannot grant permissions,
shadow required methods, supply qualification flags or export connection secrets.
"SaaS qualified" is a label the extension centre shows, never a gate (owner ruling
2026-10-04): a missing, stale or unreadable qualification record, or a deployment
manifest written under other source, may not hide, disable or fail an installed,
admitted extension. The allow-list, package and artifact digests, the owned
preparation job and the live probe with rollback are what still refuse.

## Working conventions

- Default working language for discussion is Chinese; **all project files and
  code are in English** (this is a pure-English project).
- One progress file: `PROGRESS.md`. Append one line per real milestone,
  `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top. Results and
  blockers only.
- Avoid adding new Markdown docs unless requested — too many docs become debt.
- Prefer minimal, verifiable changes; every step should produce a checkable result.
- Do not write inferences as verified facts; tie conclusions to code or data.

- The root `AGENTS.md` owner decisions dated 2026-09-29 govern this subtree: preserve usable partial research, avoid whole-package methodological vetoes or human adjudication requirements, apply autonomous learning across capabilities, and honor the settled product/operations choices.

## Owner decisions adopted 2026-10-20

These presentation decisions supersede conflicting September 23, October 7/8 and October 14/19 rules precisely as described below. Earlier records remain historical; this is an acceptance target, not a claim that the implementation has passed. See `../docs/superpowers/plans/2026-10-19-workflow-rectification.md`, October 20 owner review.

- Global home, logo and New Conversation open the general AI assistant without inherited GEO/study title, progress or specialist binding. Resume-project links are explicit; preserve history, drafts and native tabs. The VCR home offers four task intents in the existing native composer and resumable research. Results and historical links remain reachable; there is no mandatory New Study form or manual method entry journey (VCR reset, 2026-10-25/26).
- Keep the eight GEO steps reachable with visible current/completed/waiting state and next actions, including during conversation. VCR instead has six result destinations (overview, matching, population/patients, comparator, trial, evidence/data), no mandatory step rail, and an optional full programme only when explicitly requested. The October 19 compact-control ruling removes redundant navigation, but a compact selector alone cannot be the only discoverable workflow. Use one conversation and one native composer; remove the redundant Chat button when it is open. Preserve project identity, results, actual run history and the native DSH right pane.
- Research Tools remains the shared discovery surface for professional workflows and non-VCR task-oriented tools. VCR numerical methods are AI-callable tools, not calculator catalogue entries or manual parameter forms; reference-trial research is available from global AI and the study evidence context. This supersedes the October 14 fixed catalogue inventory as a restriction on those method entries. Small calculations need not traverse a full study. Show a short purpose, required inputs, expected outputs and reachable next action; meaningful examples, missing prerequisites and remedies are explicitly permitted. The older blanket no-hint/no-purpose-text rule applies only to explanations of implementation, not useful task guidance.
- Related inputs, configuration, progress and result tables/plots belong together in one analysis workbench in the main area, with responsive tabs where useful. This is an explicit exception to the older one-object/one-shape rule, not permission to stack unrelated metadata. For VCR, the main area holds results, source-linked assumptions and comparisons; configuration and revisions use the native conversation, with only small structured edits in context. Other workbenches retain their existing configuration and literature-to-parameter mapping; drawers hold short previews or small edits. Do not repurpose the native right pane or add another file/browser system.
- Share reference-trial search across global AI and the study evidence context, with contextual reuse in the current research. Distinguish live results from saved status and source failures. Literature parameters retain values, units, passages, missing fields and destination mapping; registration alone never claims executability. Retain configuration/source versions and immutable historical results.
- The saved population object owns criteria, source data, included/excluded/unknown counts, selected version and cohort results. Select account-level reusable template versions in that context, preserve Save as Template/Use Template and compatible links, and recalculate changed criteria as a new version without overwriting history.
- Keep design tokens, default Chinese UI, keyboard/mobile access, ordinary-account access and user/project/tenant boundaries. Technical implementation, source-proof machinery and operator jargon stay out of UI; scientific sources needed to judge or reuse parameters remain available in context. No added approval ceremony or clinical delivery gate. Preserve existing quality budgets and acceptance checks; do not weaken them merely to pass unusable UI. A measured workbench-specific template change must express this connected workflow, not excuse unrelated stacked content.

## Owner decisions adopted 2026-10-25 and 2026-10-26: VCR reset

Last updated: 2026-10-26. These requirements replace the VCR portions of the October 10/14/19/20 feature-retention, seven-step, calculator and recruitment rules. They do not alter GEO's eight-step workflow or the platform's general tools. The approved reset and review are the scope; implementation, numerical checks, live-model acceptance and production rollout are distinct evidence.

- Four task intents fill the existing native composer: patient matching, populations and virtual patients, comparators, trial-design simulation. Six result destinations are overview, matching, population/patients, comparator, trial and evidence/data; old patient URLs remain readable. No new manual study/PICO prerequisite, parameter form or calculator catalogue. Full-study orchestration is optional and runs only when explicitly requested. Historical calculations remain read-only.
- Global patient-to-trial work starts in ordinary conversation. Resolve the actual native invocation to its verified root conversation and lazily create only its owned task scope. Never select the newest study, change a project's meaning or rebind a general session to a specialist. Deterministic jobs keep frozen inputs, source versions and receipts; durable, idempotent completion returns to that same conversation, including after a restart. Local matching has its own bounded lane; this does not create a second R worker or prove parallel analytical execution.
- Inspect available inputs, retrieve and preserve evidence, then bind source-supported parameters before asking for unavailable research facts. Match requirements to the operation: one case needs original patient information; batch real matching/cohort work needs an uploaded or connected real patient source; literature-driven synthetic populations and design simulations may start from published parameters and declared assumptions. Real external controls need comparable exposure/outcome IPD, index dates and confounders. Unknown is never excluded, satisfied or zero.
- A cohort is a real, derived or synthetic collection; an individual record or supported modeled trajectory is not automatically a digital twin. Comparator routes distinguish actual external controls, literature benchmarks, randomized prognostic adjustment, hybrid borrowing and scoped prediction benchmarks. Predictions do not identify causal effects, create observed controls, add real/effective N or replace randomization. A virtual trial means trial-design simulation, not a decentralized clinical trial or evidence of drug approval.
- Verify published numbers, literal units, exact source generation/hash/quotation spans and baseline bindings. Derived values verify quoted inputs only and cannot become reported observed baselines. Nearby evidence is an explicit exploratory assumption, never automatic transportability. Fitted population survival baselines and typed published linear/logistic/Cox equations are scoped executable methods, not proof of clinical validity. Missing Cox baseline/reference supports relative scores only; declare centering/scaling and never evaluate source text as code. A fit needs explicit source-arm selection before use as a control baseline. Preserve lognormal/loglogistic fits while the current reference-patient/design adapter supports only exponential/Weibull; do not silently approximate them.
- Patient-level data remains in the controlled data plane. A specifically selected record uses the viewer's current grant, permitted fields, source and cloud permission; aggregate views retain small-cell suppression. A synthetic label grants no cloud permission. Native `generated_records` requires verified independent generation ancestry; empirical or upload-derived records keep their controlled path. Pre-enrolment records, exit date/reason and post-trial care cannot reconstruct hidden trial treatment, unobserved outcomes or causal effects.
- Recruitment OA, contact/referral/site workflows and recruiter/site roles are retired. Scientific follow-up observations, protocol schedules, matching rechecks and explicit abstract accrual assumptions remain. Mean full-study duration comes from `duration_months`, separately from an optional last-patient-in accrual forecast; no CRM fallback. Do not restore CDE or ICTRP sources.
- Production OA retirement is archive-first and explicit: `scripts/ops/vcr-retire-recruitment.mjs` prepares a private verified v2 archive preserving PostgreSQL JSON text losslessly, then uses locks, a READ COMMITTED comparison and a RESTRICT transaction. Legacy retired grants may be revoked. Startup never deletes legacy tables/data. Stop all old writers and prevent restart before a later explicit offline retirement; this implementation task performs no serving-database operation or deployment.
- Apply Huashu 3.0 and Impeccable Operate/Read refinement inside the existing EviMed tokens, identity and native frame. Data requirements stay visibly outside task buttons; the population workspace distinguishes group and individual scale. Synthetic browser walks, actual DSH/model use and clinical validation are separately reported, without new approval ceremonies.

## Owner direction adopted 2026-10-26: warm brand and current design authority

- Warm paper surfaces and terracotta actions replace the intervening blue palette. Keep the EviMed molecule geometry and use a separate near-black logo role in light mode and light ink in dark mode; the reviewed identity remains near-black, and deep navy is reserved for the information family, not a second action accent. The native shell must retain visible logo ink if its optional theme body is disabled.
- `docs/FRONTEND_DESIGN_SYSTEM.md` v3.1 is the full maintained specification, `DESIGN.md` its engineering map, and `packages/design-tokens` the numerical authority. Earlier full drafts and audits remain historical.
- Audit findings and implemented changes are separate. Preserve unknown/loading/stale/failed states, scientific units, keyboard equivalents, mobile destination visibility and real source/verification scope. Do not mark unobserved pages or skipped detector work as passing.
- The subsequent owner instruction authorizes the complete v3.1 implementation, commit and branch push, with gpt-6.1-sol delegated workers. The execution ledger records implementation and verification separately. On the evening of 2026-10-26 the owner asked for the branch to be reviewed, integrated with PR #17 and 前沿动态 round 4, and deployed.

## Owner review adopted 2026-10-26: design specification v3.1

The owner supplied a detailed review and asked that decisions use its recommendations. The specification is now implemented locally with token 3.0.0, shared component contracts and scoped module repairs. Implementation is distinct from the acceptance and release receipts in the execution ledger; main/production adoption is not implied. Preserve the prior audit as dated evidence. The English canonical body is maintained; the Chinese v3.0 reading copy remains frozen and a dated link/change index points to the current specification.


### Design v3.1 implementation evidence (2026-10-26)

Read [the execution ledger](../docs/superpowers/plans/2026-10-26-design-system-v3-execution.md) for DS01–DS21 / AT01–AT50 proof boundaries. Preserve the supported native theme/focus lifecycle; do not patch private upstream APIs. Native diagnostics use the public locale group `command.section.commands` (高级命令与诊断); command IDs remain upstream identities. Layout budgets are not widened in code: a measured, view-specific change is a `budgetOverride` with a `budgetNote` in `scripts/ops/page-templates.json`, and raw metrics and default budgets stay visible. Deployment follows the release procedure and its own receipts.
