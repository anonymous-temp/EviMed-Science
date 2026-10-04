# AI4S Workbench Desktop — Technical Design

> **This is the v0.1 desktop design, superseded on two axes. Do not implement from it
> without checking `AGENTS.md` first.** It was written on 2026-07-02, when the product was
> a local-first desktop app and the agent runtime was a bundled OpenCode sidecar. Since
> then the release target moved to the hosted multi-tenant SaaS (desktop packaging is
> optional), and the agent kernel became **DeepSeek Harness (DSH)** — OpenCode was deleted
> on 2026-09-01, with no rollback lever and no second code path kept alive. §5 below has
> been rewritten for the current kernel, §5.6 lists the control-plane modules and seams
> added from 2026-09-22 to 09-28, and §16 is the repository as it is; the rest of the
> document still describes the desktop shell as it was designed, and every sentence that
> says "the bundled OpenCode sidecar" should be read in that past tense. `AGENTS.md`,
> `docs/WEB_DEPLOYMENT.md` and `docs/REQUEST_PATH.md` are authoritative on the system as it
> runs today.
>
> **Original implementation status (v0.1, 2026-07-02).** Built and verified: Tauri 2 shell
> + React UI; OpenCode bundled as an isolated sidecar (auto-started, app-private
> config/data, dedicated port); a client wrapper over HTTP + SSE; real multi-session chat
> with history; Skills page backed by the runtime's real skills/agents; macOS `.dmg`;
> cross-platform CI. Planned at the time: self-authored scientific skills, MCP connectors,
> provenance/reviewer engine, literature search, Jupyter runtime, remote compute.

## 1. Technical goals

A high-performance, open-source research workbench with macOS / Windows installers.
Design priorities: fast startup; smooth UI; simple install; replaceable agent runtime;
local and sandboxed execution; MCP / skills / workflow support; artifact provenance;
extensibility to Jupyter, HPC, Modal, Docker, and remote servers.

## 2. Overall architecture

```text
AI4S Workbench Desktop
├── Desktop Shell: Tauri 2
├── Frontend: React + TypeScript + Vite
├── UI System: Tailwind CSS + Radix UI / shadcn-style components
├── Local Service: Rust commands + control-plane-managed agent runtime
├── Agent Runtime: DeepSeek Harness (one container per project)
├── Agent Protocol: slashed methods over one /api/remote.mux WebSocket
├── Skills Layer: kernel skills/agents + optional third-party scientific skills
├── MCP Layer: filesystem / paper-search / BioMCP / Zotero / GitHub / custom
├── Execution Layer: kernel agents/tools + optional Jupyter Kernel Gateway
├── Storage: Local workspace + SQLite + JSONL provenance
└── Packaging: Tauri DMG / APP / NSIS / MSI
```

## 3. Tauri over Electron

### 3.1 Recommendation

v1 uses **Tauri 2 + React + TypeScript + Vite**. Not Electron.

Reasons: Tauri is lighter with smaller installers; it uses the OS-native WebView,
suited to tool-type desktop apps; it is cross-platform (macOS / Windows / Linux); it
allows any frontend framework; and a Rust backend is well-suited to local files,
security, process management, and sidecar orchestration. Tauri positions itself around
small, fast, secure cross-platform apps built from a single codebase.

### 3.2 When Electron might fit

If later needs arise — complex browser capabilities, a more mature desktop ecosystem,
identical embedded Chromium behavior, or many native Node.js modules — Electron could be
reconsidered. But AI4S Workbench's core is the workbench, files, agent, runtime, and
artifacts, which do not need Chromium-level capabilities, so Tauri fits better.

## 4. Frontend

### 4.1 Stack

React · TypeScript · Vite · Tailwind CSS · Radix UI · TanStack Query · Zustand ·
React Router · Monaco Editor · Markdown renderer · ECharts / Plotly / Observable Plot.

### 4.2 Module layout

```text
src/
  app/{routes,layout,providers}
  components/{sidebar,topbar,command-palette,cards,artifact-viewer,
             approval-dialog,tool-call-card,code-viewer,markdown-viewer}
  features/{onboarding,projects,chat,agent-runtime,literature,artifacts,
            provenance,review,skills,settings}
  lib/{api,events,store,theme}
```

### 4.3 UI performance strategy

Streaming chat render; virtualized log lists; lazy file tree; paginated CSV; chunked
large-Markdown render; on-demand figures; cached artifact previews; a unified agent
event bus; all heavy work off to sidecar / worker; the Tauri main process does system
capabilities only, not heavy computation.

## 5. Agent runtime

### 5.1 Choice: DeepSeek Harness

The agent kernel is **DeepSeek Harness (DSH)**, `@deepseek-ai/dsh`, and it is the only
one. The pin lives in exactly one place — `deps-version.json` — and tests assert that
every derived copy equals it: the runtime image's Dockerfile ARG, the seam manifest, the
peer dependency, and the release manifest. Four files each carrying their own copy of a
version meant "bump the pin" was four edits and one of them was always missed.

DSH makes no compatibility promises before its first tagged release, so the discipline is
explicit: exact pin, fail-closed startup self-check, contract tests with golden frames
recorded from the live wire, a nightly compatibility matrix, and security fixes evaluated
the day they land. The npm install is additionally pinned in time, because
`@deepseek-ai/dsh` declares its 61 subpackages as a caret range — naming an exact version
pins one package and floats the rest.

The predecessor was OpenCode, a single MIT binary bundled as a desktop sidecar. That
choice was made for the desktop shell, where "no Python/Node runtime to package" was the
deciding constraint. It stopped being the deciding constraint when the release target
became a hosted service that builds its own runtime image anyway.

### 5.2 Control plane ↔ kernel communication

**The browser never reaches a kernel.** It calls `apps/server`, which holds the one
connection to the DSH kernel running in that project's container. That connection is a
single WebSocket at `/api/remote.mux` carrying every logical stream, each independently
cancellable:

| Frame | Direction | Use |
| --- | --- | --- |
| `{"type":"open","streamId","endpoint","payload":{"args":{...}}}` | out | Start a logical stream |
| `{"type":"cancel","streamId"}` | out | Cancel one stream without touching the others |
| `{"type":"item","streamId","value"}` | in | One endpoint-owned value |
| `{"type":"error","streamId","error":{"code","message","details"}}` | in | Stream failed |
| `{"type":"end","streamId"}` | in | Stream finished |

Endpoints are slashed method names: `session/create`, `session/prompt`, `session/cancel`,
`session/page`, `session/fork`, `session/list`, `subagents/list`, `skills/list`,
`agentPresets/list`. The kernel's forwarded host events arrive on the `$events` stream of
the same socket. Everything else the kernel exposes — credentials, settings, workspace
mutation, model catalogs, goals, message feedback — is on the seam manifest's `denied`
list, so a method the product does not use cannot be reached even by accident.

Two consequences the earlier single-stream downlink did not have. A session's events
arrive on the stream that was opened for that session, so the session id is no longer *in*
the frame — `dshMux.mjs` is what remembers the pairing. And the host sends WebSocket Ping
control frames every two seconds and terminates a socket that did not answer the previous
one, so the pong path is load-bearing rather than politeness.

The kernel authenticates the socket with a browser-session cookie the control plane mints
itself, and it derives that cookie's *name* from the `Host` header it receives — so a
cookie minted for a different authority is not a weaker credential, it is a different
cookie the kernel never looks for, and the request arrives unauthenticated.

Flow:

```text
Control plane starts the project's runtime container (image, mounts, network policy)
↓
dshMux opens one WebSocket to /api/remote.mux with the minted session cookie
↓
session/create → session/prompt
↓
$events streams turn/step/tool/assistant events → decoded into @evimed/domain RunEvent
↓
apps/server serves its own GET /api/runs/:id/events to the browser
```

The frontend sees only `RunEvent`. That is the whole point: the retired pass-through route
made the frontend know a kernel's protocol, so every kernel change was a frontend change.
`/api/opencode/:projectId/*` still exists as a URL and answers `410
runtime_passthrough_retired`, keeping the retired kernel's name deliberately — a URL is
what an already-deployed client types, and renaming it would turn each of those requests
into an anonymous 404 instead of the one chance to name the replacement.

### 5.3 The anti-corruption layer

`@deepseek-ai/*` may be imported in **`packages/harness-port` and nowhere else**,
including in a JSDoc `import()` type. The port owns its own types and converts shapes, so
a rename upstream is one file. `packages/harness-port/seam-manifest.json` lists every
contact point and is the single source that the port's exports, the startup probe, the
lint allow-list, the contract tests and the method allow-list all derive from.

`packages/socket` (`@evimed/dsh-socket`) is the composition layer: the `evimed-universal`
preset and its plugins are what turn a bare kernel into the EviMed runtime. A bare kernel
started from a binary has no tool chain at all — the preset, the capability manifests and
the research MCP are baked into the runtime image at `/opt/evimed`, and the generated
profile patch names those paths.

### 5.4 Isolation

In the hosted deployment the kernel runs one container per project, started by an
unexposed Runtime Controller that owns the Docker socket; the API container never receives
it. The kernel listens on container loopback and `socat` exposes it through a 0600 unix
socket at `runtime/container-runtime/control/dsh.sock` inside that project's runtime
subpath, so no runtime TCP port is published and a sibling runtime cannot be addressed
through the API container's `127.0.0.1`. The socket file carries the kernel's name for a
reason: two kernels speak different protocols, and a stale socket that still accepts
connections is a runtime that looks alive and answers nothing the caller understands.

**The runtime never holds a real provider key.** The kernel's `baseURL` points at our
model gateway and its `apiKeyEnv` names a reference resolved per request from a 0600
credentials file the control plane rewrites in place, so a token rotation is a file write
rather than a restart.

### 5.5 The desktop shell's own sidecar (historical, still in the tree)

The desktop shell predated the hosted service and started its own sidecar from
`src-tauri/src/runtime.rs` and `src-tauri/src/opencode_config.rs`. Both, with the shell
and `packages/sdk`, were deleted on 2026-09-04; this section is kept as the record of the
design, and nothing in the hosted deployment goes through it.

How it was designed, and why the shape is worth keeping if the shell is ever repointed at
DSH: the sidecar ran the **bundled** binary rather than the user's `PATH`, on a
**dedicated free port** rather than the default, with an **app-private** config/data dir
via `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under the bundle identifier's application-support
directory, and was killed on app exit — so a user's own installation, sessions and config
were never touched. It did share the user's login: their `auth.json` was copied read-only
into the sandbox at startup so the workbench could answer out of the box without a
separate login. We only ever read that file; we never modified it or the user's sessions.
The provider key entered in Settings went into the app-private config by a Rust command,
never into the user's global config, logs, or git.

### 5.6 Modules and seams added 2026-09-22 → 09-28

The frontier feed, GEO and the login, credits and handoff seams are layer-2 feature
modules (`<x>Service.mjs` + routes + an optional leased worker + one
`OPEN_SCIENCE_<X>_ENABLED`, registered by one line in `createWebApiApp`), each off unless
its switch is on; the rest are changes inside existing layers.

- **「前沿动态」, the medical frontier feed** (`frontier*.mjs`, schema `evimed_frontier`,
  `OPEN_SCIENCE_FRONTIER_ENABLED`). Every source it reads belongs to the knowledge-source
  plugin — `项目代码/knowledge-plugin`, the team's own Python service with its own database,
  contract `packages/contracts/knowledge-plugin`, pinned in `deps-version.json` (1.2.0). The
  control plane pulls the plugin's `seq`-cursor stream (`knowledgePluginClient.mjs`, its only
  caller; the plugin never calls the platform), screens and writes each item on
  `deepseek-flash` under purpose `frontier` and the module's own daily budget, builds events,
  the hot list, the 07:30 daily and 与你相关, and serves the runtime a read-only
  `frontier_search` (`frontierGateway.mjs`).
- **「循证 GEO」** (`geo*.mjs`, schema `evimed_geo`, `OPEN_SCIENCE_GEO_ENABLED`, opened per
  account): one row per GEO project on top of an ordinary project, `/api/geo/*`; the consumer
  AI engines are measured server side through the probe host and the metrics computed from
  `@evimed/domain`'s `geo/metrics.json`; the eight-step program runs the four GEO capabilities
  inside the project; media orders are placed and settled in code. The owner's proprietary
  skill pack reaches the runtime only through the gitignored `runtime/skills/geo-private/`.
- **「虚拟临研」** (`vcr*.mjs`, schema `evimed_vcr`, `OPEN_SCIENCE_VCR_ENABLED`, opened per
  account): one row per study on top of an ordinary project, `/api/vcr/*` with abilities
  checked per operation; the seven-step programme runs the five vcr capabilities inside the
  project, and every number comes from a job of the R engine `项目代码/vcr-engine` (the methods listed by `VCR_ENGINE_METHODS`
  in `@evimed/domain`, one scenario schema each, validated identically by the control plane and the engine).
  Patient-level data lives in a data plane never mounted in a runtime: the control plane alone
  resolves a snapshot into engine inputs after an access decision, outcome columns stay sealed
  until the analysis plan is frozen, and what the runtime reads passes through small-cell
  suppression. The 模型分析计划 and 模型分析报告 (ICH M15) are two more export kinds whose
  structure, tables and numbers the control plane writes from the study's records
  (`vcrModelDocuments.mjs`; every report number is rendered from a saved result by `vcrRender.mjs`)
  and whose prose sections the `vcr-package` capability writes by named section; the plan's
  content is frozen as a hashed version, never edited (a trigger refuses it), at the same
  instant as the analysis plan and before the outcome columns lift (`vcrSeal.mjs`). The seams
  are fixed in `docs/superpowers/specs/2026-09-29-vcr-integration-contract.md`.
  A study lands on a disease through a **knowledge pack** (`vcrKnowledge*.mjs`, contract and
  validator in `@evimed/domain` `vcrKnowledgePack.mjs`): definitions only — terms with
  identifiers from NCIt, OMOP or ICD-10-CM, phenotypes and common criteria in the requirement
  grammar, endpoints with their standard, field-name mappings, short background — every entry
  sourced (link, title, date read, licence from a closed table; WHO ICTRP, ATC/DDD and MedDRA
  refused). Three curated packs ship as data files (`vcr-packs/`: non-small-cell lung cancer,
  breast cancer, type 2 diabetes); a disease with none gets an AI-drafted minimal pack written
  through `vcr_write` `pack`, marked 「AI 草拟」 and promoted by the lead or an operator after
  review. The account's **population definition library** keeps a study's cohort rules with
  their plain-language text, versions and the studies that used them; two versions are
  compared by the engine (`cohort.build` with `compare`, filed as a result kind the study's
  own pages never list).
- **Fusion seams with EviMed's own platform** (fusion plan 2026-09-26 §9); login, credits
  and handoff are off by default and answer 404 when off:
  - *login* (`evimedAuthService.mjs`, `OPEN_SCIENCE_EVIMED_AUTH_ENABLED`): the shell's EviMed
    credential is introspected server side and exchanged for an ordinary session of ours on
    an account kind `evimed`, whose id is a one-way hash of EviMed's user id; the credential
    is never stored. The account row also keeps EviMed's own user id (`evimed_user_id`,
    schema version 4), rewritten at every exchange and read only by the credits client;
  - *灵豆 credits* (`evimedCredits*.mjs`, schema `evimed_credits`,
    `OPEN_SCIENCE_EVIMED_CREDITS_ENABLED`): after a run ends its recorded CNY cost is charged
    once to EviMed, idempotent on the run id, retried on a bounded backoff, never interrupting
    a run; a start is refused (402 `credits_exhausted`) only on a balance read as short. The
    deduction and balance calls name the EviMed user id, and an account without one is never
    charged under our hash;
  - *research allowance* (`researchAllowanceRoutes.mjs`, `/api/account/allowance`): the
    account page presents CNY allowance and confirmed task charges, independently of
    supplier costs. `OPEN_SCIENCE_RESEARCH_BILLING_ENABLED` activates the versioned
    `research-allowance-v1-20261003` charging policy in PostgreSQL before work begins.
    The activation is durable; a flag rollback cannot reopen legacy charging rules or
    retrospectively charge old requests. Exact resource costs use eight decimal places;
    the existing integer wallet receives only whole credits, with fractional remainders
    explicitly waived. No fractional-wallet contract is assumed. Request attribution and
    trusted autonomous-task identities prevent duplicate charging. Pending deductions are
    never represented as confirmed spending. Financial evidence and its retry outbox survive
    account deletion, while account-generation checks prevent a reused username reading an
    earlier owner's statement. Token counts remain resource measurements, not currency;
  - *simulated wallet* (`evimedCreditsSimulator.mjs`, `OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED`,
    2026-10-04): replaces the wallet and only the wallet, behind the same credits client — a
    `fetch` that speaks the wire envelope against tables of its own in `evimed_credits` — so
    charges still come from what a task really cost and only the credits are simulated.
    Settlement rows are marked `wallet = 'simulated'`; statements, totals and the retry
    sweep read one wallet kind; the real client refuses a `sim:` payer and the simulator a
    real user id. Billing failing never stops research (`ensureReady`: the module goes
    quiet and readiness's `credits` check names why); the balance gate asks before a run
    exists on every way work begins (`test/balanceGateCoverage.test.mjs`);
  - *hosted commerce* (`researchCommerce.mjs`): optional recharge, membership, order and
    refund links come from explicit trusted HTTPS deployment configuration. A configured
    link is not a checkout API, a payment receipt, a membership entitlement or a reservation.
    Unsupported automatic commerce and fractional settlement are reported by
    `pnpm check:research-billing --require-automatic-commerce --require-precision`;
  - *handoff* (`researchHandoff.mjs`, `OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED`): 「转为深度研究」
    binds a new research session with the quick answer's question, sources and premises as
    its first-message draft; the person's send starts the run through the one prompt path;
  - *routing decision* (`routingDecision.mjs`, `POST /api/routing/decision`, always on):
    advice before a send — quick answer or deep research, which capability, estimated
    minutes and, with credits on, 灵豆. It runs the dispatch's own router and decides
    nothing.
- **Design tokens are one package**, `@evimed/design-tokens`: one table generated into the
  CSS variables, the Tailwind preset both front ends extend, the Element Plus and ECharts
  themes, the kernel frame's `overrideTokens` and the Figma/DTCG files; `pnpm tokens:check`
  and `designTokens.test.ts` fail on a stale artifact.
- **Web reading renders in the deployment's own browser** (`webRender.mjs`): with
  `OPEN_SCIENCE_WEB_RENDER_ENABLED` on and `OPEN_SCIENCE_WEB_RENDER_CDP_URL` set, a page
  drawn in script is rendered by the host's headless Chromium (`frontier-browser`,
  `localBrowser.mjs`) through a per-render forward
  proxy that resolves each host, refuses private addresses and connects only to the address
  it checked (`webRenderEgress.mjs`); AgentBay's cloud browser remains the other provider.
  Direct reads — and, since 09-28, open-access PDFs — go over the pinned socket of
  `webReadNetwork.mjs`.
- **Alertmanager delivers to the control plane**: `POST /api/ops/alerts`
  (`alertReceiver.mjs`, its own bearer credential `OPEN_SCIENCE_ALERT_RECEIVER_TOKEN_FILE`)
  writes one inbox item per alert instance for each operator, pushed to Feishu where bound.
  The previous public receiver was answered `204` by nginx and dropped every alert.
- **Learned methods travel as cards.** A method EviMed learned from the researcher's runs is
  handed to a run as a card — when it applies and the path of its file — and read when it
  applies; what the researcher wrote or enabled is still inlined whole. The mount's byte
  budget (`OPEN_SCIENCE_MOUNTED_METHOD_PROMPT_BYTES`, 32 KiB) is spent on what is injected: a
  learned method costs its card, and what the budget leaves out is counted
  (`open_science_mounted_methods_left_out_total`).
- **The run answers its review at delivery** (`packages/socket/src/review.mjs`): the
  independent reviewer's findings come back to the run's submission with ids, and the run
  answers each answer-required one in the next submission's `responses` — `fixed`, or
  `declined` with a reason — which the control plane records (`/responses`,
  `open_science_review_responses_total`).
- **A run cannot read the gate.** The run policy (`packages/socket/src/runPolicy.mjs`)
  refuses any file tool call or shell command that names the gate's implementation —
  `@evimed/domain`'s sources and the socket's `src`/`plugins`, including the image's copy
  under `/opt/evimed/socket` — with or without a separator after the directory
  (`gate_source_denied`, `isGateImplementationPath`); skills and presets stay readable.

## 6. Skills & MCP

### 6.1 Skill layering

```text
skills/
  core/      # reproducible-research, literature-review, figure-provenance,
             # citation-reviewer, paper-to-report
  external/  # K-Dense scientific-agent-skills
  user/      # custom skills
```

### 6.2 v1 built-in skills

| Skill | Purpose |
| --- | --- |
| `reproducible-research` | Standardize project structure, artifacts, logs, reproducibility |
| `literature-review` | Search, filter, summarize literature |
| `bibliometric-analysis` | Year trends, keywords, journal distribution, clustering |
| `figure-provenance` | Figures must trace to code and data |
| `citation-reviewer` | Check citation format and sources |
| `paper-to-report` | Generate a Markdown report |

### 6.3 Third-party skills

`K-Dense-AI/scientific-agent-skills` (large set; compatible with Cursor, Claude Code,
Codex, OpenCode) can be added later. Do **not** enable all ~148 skills by default: use
curated install, enable by domain, and show license, dependencies, and risk. (Curated
third-party install is a later feature; the Skills page lists the real skills the runtime
has loaded, never a hardcoded catalog.)

### 6.4 MCP servers

First batch: `filesystem` (project files), `paper-search-mcp` (literature), `BioMCP`
(biomedical databases), `Zotero MCP` (library), `GitHub MCP` (repos/issues/releases),
`local runtime MCP` (execution status). v1 ships filesystem + paper search first;
BioMCP and Zotero follow.

## 7. Execution layer

```text
Execution Layer
├── Kernel tools (in the project runtime)
├── Docker sandbox            (optional, advanced)
├── SSH / Modal remote        (optional, advanced — later)
└── Jupyter Kernel Gateway    (later)
```

The kernel executes its tools within the runtime, gated by its permission system. Heavier/remote execution (Docker sandbox, SSH, Modal) is optional and belongs in
an advanced "Remote Compute" area, never the default path.

**v1 default:** local execution + manual approval for high-risk actions. Do not
hard-depend on Docker Desktop or WSL in v1 — that raises the install barrier and is not
consumer-grade.

**v0.3 Jupyter Kernel Gateway** for a more notebook-like experience:

```text
Desktop App → Local Runtime Manager → Jupyter Kernel Gateway → Python / R kernel
→ stream output / figures / tables
```

Jupyter Kernel Gateway is a headless Jupyter kernel server addressable over REST /
WebSocket.

## 8. Local Runtime Manager

### 8.1 Why

The installer should not bundle every scientific dependency (huge installer, slow
updates, cross-platform pain, dependency conflicts, hard debugging). Instead: a
lightweight installer + a first-launch Runtime Manager + on-demand scientific env.

### 8.2 Responsibilities

Detect the kernel; detect Python / uv / Node / Git; create the workspace; create isolated
environments; install base Python packages; manage scientific tool dependencies; start
the kernel; start an optional Jupyter Gateway; monitor runtime health.

### 8.3 Runtime directory

```text
~/.ai4s-workbench/
  config/  runtime/{kernel,python,node}/  profiles/ai4s-workbench/
  workspaces/  logs/  cache/  secrets/
```

Windows: `%APPDATA%/AI4S Workbench/` · macOS: `~/Library/Application Support/AI4S Workbench/`

## 9. Storage

### 9.1 Project structure

```text
workspace/
  project.json  plan.md
  data/{raw,processed}/  papers/  parsed/  scripts/  notebooks/
  figures/  reports/  artifacts/  reviews/
  provenance.jsonl  manifest.json
```

### 9.2 SQLite

Stores: project list, session index, artifact index, literature metadata index,
tool-call state, user settings, runtime state.

### 9.3 JSONL

`provenance.jsonl` is an append-only execution record — easy to read, diff, recover,
export, and open-source friendly.

## 10. Artifact provenance

### 10.1 Manifest

```json
{
  "project_id": "bci-trends",
  "created_at": "",
  "artifacts": [
    {
      "id": "fig_year_trend",
      "type": "figure",
      "path": "figures/year_trend.png",
      "created_by_step": "step_004",
      "input_files": ["data/processed/corpus.csv"],
      "code_files": ["scripts/analyze.py"],
      "status": "reviewed"
    }
  ]
}
```

### 10.2 Provenance event

```json
{
  "event_id": "evt_001",
  "step_id": "step_004",
  "type": "code_execution",
  "tool": "python",
  "command": "python scripts/analyze.py",
  "input_files": ["data/processed/corpus.csv"],
  "output_files": ["figures/year_trend.png"],
  "started_at": "",
  "finished_at": "",
  "status": "success"
}
```

### 10.3 Reviewer rules (v1, deterministic)

Artifact exists; output is recorded in provenance; figure has a code file; table has
source data; report includes limitations; citation has a recognizable ID; script can
be re-run.

## 11. Security

### 11.1 Default permissions

The agent may only access the current workspace; command execution requires approval;
it cannot delete files outside the workspace; it cannot read the whole Home directory;
it cannot auto-upload files; it cannot silently install dependencies.

### 11.2 Approval levels

| Action | Default |
| --- | --- |
| Read current project files | Allow |
| Write current project files | Allow (shown) |
| Overwrite file | Ask |
| Delete file | Require approval |
| Shell command | Require approval |
| Install dependency | Require approval |
| Network access | First-time approval |
| Connect remote server | Require approval |
| Access files outside workspace | Require approval |

The kernel has a per-tool permission system (allow / ask / deny per agent). The desktop
maps high-risk actions to "ask" and must never blanket-allow them. A hosted deployment
uses `never`, which means auto-refuse: inside the sandbox nothing needs approval, so the
only things that ask are attempts to step outside it.

### 11.3 API keys

Stored in macOS Keychain / Windows Credential Manager (fallback: encrypted local
secrets). Never enter provenance, logs, crash reports, git, or exported projects.

## 12. Packaging & release

### 12.1 macOS

Outputs: `AI4S-Workbench-aarch64.dmg`, `AI4S-Workbench-x64.dmg`,
`AI4S-Workbench-universal.dmg` (later). Code signing / notarization needs an Apple
Developer account; a free account cannot notarize, so users may still see an
"unverified" prompt.

### 12.2 Windows

Outputs: `AI4S-Workbench-Setup.exe`, `AI4S-Workbench.msi` (later). Prefer the NSIS
`Setup.exe` in v1 for a familiar install experience. Unsigned apps run but may trigger
SmartScreen; formal release needs a code-signing certificate (EV certs earn SmartScreen
reputation faster). Early GitHub Release preview builds may be unsigned, but the README
must say so.

### 12.3 Auto update

Tauri updater with GitHub Releases + `latest.json` + a Tauri updater signature (update
packages must be signed; signature verification cannot be disabled). v0.1 no forced
auto-update; v0.2 adds a GitHub Releases updater; v0.3 adds in-app update prompts.

### 12.4 CI/CD

GitHub Actions build matrix:

```yaml
macos-latest:
  - aarch64-apple-darwin
  - x86_64-apple-darwin
windows-latest:
  - x86_64-pc-windows-msvc
```

The official Tauri GitHub Action builds native binaries for macOS / Linux / Windows and
uploads to a GitHub Release.

## 13. Process model

### 13.1 Startup

```text
User opens app → Tauri starts → Frontend loads → Runtime Manager checks dependencies
→ Start the agent runtime → Connect to Gateway → Load projects → Ready
```

### 13.2 Agent task

```text
User submits task → Frontend posts a prompt to apps/server → the kernel plans
→ Frontend renders plan approval card → User approves → the kernel executes tools
→ Tool events stream back → Runtime writes artifacts → Provenance service records events
→ Reviewer runs checks → Frontend updates artifact/review panels
```

## 14. High-performance design

### 14.1 UI

Layered state: UI state in Zustand, server/runtime state in TanStack Query, streaming
events in an event bus. Big-data optimizations: paginated CSV preview, virtualized log
viewer, lazy Markdown render, lazy artifact load. Render optimizations: memoized
tool-call cards, batched message chunks, `requestAnimationFrame` batching, background
task workers.

### 14.2 Runtime

Persistent kernel per project; reused project sessions; incremental file index; artifact
hash cache; per-project reused Python env; literature metadata cache; cached PDF parse
results; figure preview thumbnails.

### 14.3 Startup targets

```text
App UI cold start: < 3s
Runtime ready: < 10s
First agent response: < 5s after runtime ready
```

Strategy: UI first, runtime after; show runtime-loading state on Home; a failed runtime
connection must not block the UI; first-time dependency install happens in onboarding.

## 15. Error handling

### 15.1 Runtime errors

Runtime not started; Gateway start failure; port in use; missing API key; model
connection failure; workspace permission denied; broken Python env; Docker unavailable;
MCP server start failure. Each must provide: a human-readable explanation, collapsible
technical details, a one-click fix button, and a copy-logs button.

### 15.2 Agent errors

Tool-call failure; literature source rate-limited; dependency install failure; code run
failure; file permission failure; citation check failure. Must show: the failed step,
the cause, a fallback suggestion, a retry button, and an edit-plan button.

## 16. Repository structure

Monorepo:

```text
OpenScience/
  apps/web/                        # the React single-page frontend
  apps/server/                     # the hosted web boundary and control plane
  packages/{domain,harness-port,socket,contracts,shared,design-tokens}/
  capabilities/  capability-skills/
  runtime/{mcp,skills}/
  deploy/{web,runtime-dsh,specialist-adapter,tooluniverse,openlist,host}/
  deps-version.json                # the one place an upstream pin is written
  docs/{PRD.md,TECHNICAL_DESIGN.md}
  examples/bci-trends/
  scripts/{build,dev,ops,release}/
../项目代码/                        # the six Python specialist engines and the knowledge-source plugin
```

- `apps/server` — the hosted web boundary; owns the only connection to a kernel.
- `apps/web` — the React single-page frontend, served by `apps/server`. The Tauri
  desktop shell and its browser-side kernel client were deleted on 2026-09-04.
- `packages/harness-port` — the anti-corruption layer; the only importer of
  `@deepseek-ai/*`.
- `packages/socket` — the `evimed-universal` plugin composition.
- `packages/design-tokens` — the one token table and its generated artifacts (§5.6).
- `runtime/skills` — self-authored scientific skills.
- `项目代码/<engine>/requirements.lock` — each engine image's fully pinned dependencies,
  resolved for its Python through the production PyPI mirror
  (`scripts/ops/compile-engine-locks.sh`); the images install the lock when present.
- `examples` — the complete demo project.

## 17. v0.1 task breakdown

### 17.1 Day-one goals

1. Init Tauri + React.
2. Build the main layout.
3. Build a static onboarding page.
4. Build a static project workspace page.
5. Build tool-call card / artifact card / approval dialog.
6. Bundle + auto-start the agent runtime; connect through the SDK client wrapper.
7. Ship the runtime config/skills bundle.
8. Write the 3 core skills.
9. Build static artifacts for the BCI demo.
10. Draft the GitHub Actions build.

### 17.2 v0.1 must deliver

macOS app runs; Windows app runs; README has screenshots; a complete demo; API key
config; open a workspace; a bundled OpenCode the app auto-starts and drives (sessions,
streaming, history, skills); show plan / tool / artifact / review; export `report.md`.

## 18. Technical risks

### 18.1 Kernel integration

Risk: the kernel's API changes across versions — and DSH makes no compatibility promise
before its first tagged release, so this is not hypothetical. Mitigation: **one importer**
(`packages/harness-port`, enforced by lint), a seam manifest that every derived artifact
reads from, **one pin** in `deps-version.json` with tests asserting each derived copy
equals it, contract tests against golden frames recorded from the live wire, a fail-closed
startup self-check, and a nightly compatibility matrix. A hand-authored wire fixture is
worse than none: one certified the wrong shape and defeated an audit.

### 18.2 Windows environment complexity

Risk: WebView2, permissions, Defender, SmartScreen, PATH, missing Python / Git / Node.
Mitigation: the Runtime Manager detects the environment; do not hard-depend on system
Python early; provide a portable fallback; code-sign for formal releases.

### 18.3 Installer size

Risk: bundling a large runtime and scientific packages makes the installer huge.
Mitigation: for the desktop shell, keep the app body light; install heavy scientific dependencies on demand as optional Science Packs;
defer Docker / Jupyter.

### 18.4 Agent safety

Risk: the agent runs commands, reads/writes files, accesses the network. Mitigation:
manual approval by default; workspace allowlist; isolated local secrets; dangerous-
command dialogs; optional Docker sandbox; full provenance recording.

## 19. Final stack

```text
Tauri 2
React + TypeScript + Vite
Tailwind + Radix UI
DeepSeek Harness as agent kernel (one container per project, pinned in deps-version.json)
Slashed methods over one /api/remote.mux WebSocket, behind packages/harness-port
Kernel skills/agents + optional third-party scientific skills
Local workspace + SQLite + JSONL provenance
DMG / NSIS / MSI installers via GitHub Actions
GitHub Releases (self-contained; sidecar fetched at build time)
```

One line:

**Use Tauri for a high-performance modern desktop shell, an isolated agent kernel as
the Claude Code alternative layer, scientific skills and MCP as the research capability
layer, and provenance/reviewer as the real moat of an open-source Claude Science alternative.**
