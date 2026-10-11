# EviMed control plane (`@ai4s/server`)

The server side of the hosted web application: HTTP API, authentication and tenancy,
project workspaces, the run ledger and delivery gate, the gateways a runtime calls, and the
feature modules (knowledge base, autopilot, memory, frontier feed, and so on). The browser
talks to this process and to nothing else; it never reaches an agent kernel.

It is plain Node (`.mjs`, ESM, no build step). `tsconfig.json` runs `checkJs` over
`src/**/*.mjs` and ESLint gates it at `--max-warnings 0`, so `pnpm lint` and
`pnpm typecheck:server` from `OpenScience/` cover it.

## Entrypoints

| Entry | Script | What it starts |
| --- | --- | --- |
| `src/index.mjs` | `pnpm --filter @ai4s/server start` | The HTTP API (`createWebApiApp` in `src/server.mjs`), default `127.0.0.1:8787` |
| `src/runtimeControllerIndex.mjs` | `pnpm --filter @ai4s/server start:controller` | The runtime controller: the only process allowed to drive Docker, listening on a mode-0600 unix socket (`OPEN_SCIENCE_RUNTIME_CONTROLLER_SOCKET`) |

In a Docker deployment the API has no Docker socket. It asks the controller, which validates
canonical user and project identifiers and rebuilds the fixed image, mounts, network, resource
limits and command from server configuration; arbitrary Docker commands are not part of the
protocol (`runtimeControllerClient.mjs` / `runtimeControllerServer.mjs`, versioned by
`RUNTIME_CONTROLLER_PROTOCOL_VERSION`).

## How a request reaches a runtime

The agent kernel is the DeepSeek Harness (DSH), the only kernel. Each project has at most one
runtime: a container on this host (`OPEN_SCIENCE_RUNTIME_PROVIDER=docker`, the default) or an
Alibaba AgentBay session (`agentbay`). The runtime runs only from the runtime image
(`OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker`); any other sandbox mode is refused by name.
`OPEN_SCIENCE_RUNTIME_MODE=mock` swaps in an in-process fake kernel for tests and demos.

- `runtimeManager.mjs` owns the lifecycle and the launch plan (start, stop, idle reaping,
  capacity, quota monitor). `agentbay/` is the other provider.
- `dshProfilePatch.mjs` renders the per-project kernel profile before each start;
  `dshBrowserAuth.mjs` mints the kernel's browser-session cookie. No provider key enters the
  container.
- `dshMux.mjs` holds the single WebSocket to the kernel at `/api/remote.mux`, which carries
  every logical stream, addressed by slashed method names (`session/create`,
  `session/prompt`, `session/page`, `session/cancel`, ...). `dshEventPump.mjs` follows the
  sessions the ledger says are running.
- `dshRuntimeAdapter.mjs` decodes kernel frames into `@evimed/domain`'s `RunEvent` and
  `RunTranscript`, so the ledger, the gate and the browser never learn the kernel's
  vocabulary. `runEventStream.mjs` serves the result at `GET /api/runs/:id/events`, resumable
  by sequence number. Only `@evimed/harness-port` may import `@deepseek-ai/*`.
- `agentRuns.mjs` is the run ledger: dispatch (`POST /api/agent-runs/dispatch`), progress,
  steer, cancel, and the delivery decision. `specialistRouting.mjs` and
  `specialistClassifier.mjs` choose between the open-domain answer line and a capability.
- The old browser-to-kernel pass-through is gone: `/api/opencode/*` answers
  `410 runtime_passthrough_retired` and `/api/runtime-ui/*` answers `410 runtime_ui_path_retired`.

## The delivery gate

The rules that decide whether a finished run may be delivered exist once, in
`packages/domain/src/clinicalEvidence.mjs`. `src/clinicalEvidenceQuality.mjs` is a re-export
shim and holds no logic; the run side reaches the same module through the socket's
`evimed_submit_deliverable` tool. Safety rules for specific medicines are data in
`packages/domain/src/clinical-safety-rules.json`. A verdict is a return value: a package is
delivered with its findings attached and each claim marked, not withheld. See the root
`CLAUDE.md` / `AGENTS.md` for the full account.

## Persistence

- `OPEN_SCIENCE_STATE_STORE` is `file` (the default; users and sessions in JSON files under
  `OPEN_SCIENCE_DATA_DIR`, for local development) or `postgres`
  (`OPEN_SCIENCE_DATABASE_URL` or `OPEN_SCIENCE_DATABASE_URL_FILE`; `controlPlaneDatabase.mjs`
  is the pool and the `evimed_control` schema, `store.mjs` the user/project/session store).
- Every durable product module is a document-and-job ledger over that database:
  `productPersistence.mjs` (schema `evimed_product`: `documents`, `revisions`, `jobs`),
  `productStore.mjs`, `productJobs.mjs`. Research memory (`researchMemory.mjs`) and the
  frontier, GEO, VCR, review and credits modules keep their own schemas. Modules that need the
  database stay unconfigured on the file store.
- Workspaces are directories under `OPEN_SCIENCE_DATA_DIR` (default `.openscience-web-data`
  relative to the working directory), scoped per user and project. Workspace I/O refuses
  symbolic links, pins directories and files with `O_NOFOLLOW` descriptors, and writes
  atomically (`security.mjs`).

## Feature modules

Each module is a service, a routes file, optionally a leased worker, and one switch in
`src/config.mjs`; `createWebApiApp` registers it. With a switch off the module's routes are
not mounted and the rest of the platform is unaffected.

| Module | Files | Switch (default) |
| --- | --- | --- |
| Knowledge-base intake | `source*.mjs`, `openList*.mjs`, `documentParserClient.mjs` | `OPEN_SCIENCE_SOURCE_INGESTION_ENABLED` (on in production) |
| Autopilot (proactive research) | `autopilot*.mjs` | `OPEN_SCIENCE_AUTOPILOT_ENABLED` (on in production) |
| Learning loop | `learning*.mjs`, `method*.mjs`, `handbook*.mjs` | `OPEN_SCIENCE_LEARNING_ENABLED` (on) |
| Research evolution | `evolution*.mjs` | `OPEN_SCIENCE_EVOLUTION_ENABLED` (on) |
| Research memory and recall | `memory*.mjs`, `researchMemory.mjs` | `OPEN_SCIENCE_MEMORY_ENABLED` (on), `OPEN_SCIENCE_MEMORY_RECALL_ENABLED` |
| Data semantics, result versions | `dataSemantics*.mjs`, `result*.mjs` | `OPEN_SCIENCE_DATA_SEMANTICS_ENABLED`, `OPEN_SCIENCE_RESULTS_ENABLED` (on) |
| Frontier feed | `frontier*.mjs` | `OPEN_SCIENCE_FRONTIER_ENABLED` (off) |
| Evidence-based GEO | `geo*.mjs` | `OPEN_SCIENCE_GEO_ENABLED` (off) |
| Virtual clinical research | `vcr*.mjs` | `OPEN_SCIENCE_VCR_ENABLED` (off) |
| Independent reviewer, Jev judge sites | `review*.mjs`, `judge*.mjs` | `OPEN_SCIENCE_REVIEW_ENABLED` (off), `OPEN_SCIENCE_JEV_ENABLED` (on) |
| Chat channels | `im*.mjs`, `channels/` | `OPEN_SCIENCE_IM_ENABLED` (off), plus one `OPEN_SCIENCE_CHANNEL_<NAME>_ENABLED` per channel |
| Credits | `evimedCredits*.mjs` | `OPEN_SCIENCE_EVIMED_CREDITS_ENABLED` (off) |
| Public evidence pages | `evidence*.mjs` | `OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED` (off) |
| Web read, render, managed browser | `webRead*.mjs`, `webRender*.mjs`, `managedBrowser*.mjs` | `OPEN_SCIENCE_WEB_READ_ENABLED` (on), `OPEN_SCIENCE_WEB_RENDER_ENABLED` and `OPEN_SCIENCE_MANAGED_BROWSER_ENABLED` (off) |

Capsules, plugin settings, the inbox, the usage ledger, the skill library, document export
and extensions have no switch of their own: they exist whenever the product database does.
Self-registration is `OPEN_SCIENCE_SELF_REGISTRATION_ENABLED` (on).

## Gateways

A runtime holds no provider key. It calls the control plane's gateways with a signed,
timestamped token that each gateway verifies; an unset gateway refuses that egress by a named
code. Paths include `/internal/model/v1/chat/completions` and `/internal/model/v1/messages`
(`modelGateway.mjs`), `/internal/sources/v1/fetch` (`publicSourceGateway.mjs`, which also
backs `web_read`: robots.txt honoured, every hop's DNS answer checked, private addresses
refused), `/internal/search/v1/query`, `/internal/kb/v1/search`, `/internal/frontier/v1/search`,
`/internal/capsules/v1`, `/internal/geo/v1`, `/internal/vcr/v1`, `/internal/results/v1` and
`/internal/semantics/v1`. A runtime in an AgentBay session, which is on the internet, reaches
the same gateways through `/runtime-gateway/<name>/` (`runtimeGatewayEntry.mjs`), with a
per-runtime rate limit.

## Security defaults

- Auth modes (`OPEN_SCIENCE_AUTH_MODE`): `development` (the default when nothing is set),
  `local` (password login; bootstrap user from `OPEN_SCIENCE_BOOTSTRAP_USER` and
  `OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE`, created by `pnpm configure:local-auth`), `oidc`
  (Authorization Code with PKCE, state/nonce/ID Token validation) and `evimed`. Under
  `NODE_ENV=production`, `development` is rejected by readiness, and a bootstrap password
  taken from the process environment is rejected.
- Mutating cookie-backed requests need the `X-Open-Science-CSRF` token returned by login and
  `/api/me`. The active project comes from `X-Open-Science-Project` or `projectId=`.
- Security headers and a CSP are on by default (`OPEN_SCIENCE_SECURITY_HEADERS`); production
  CORS admits only `OPEN_SCIENCE_PUBLIC_URL`'s origin and exact HTTPS entries of
  `OPEN_SCIENCE_CORS_ORIGINS`. Production also requires `OPEN_SCIENCE_TRUST_PROXY`.
- Docker runtimes drop capabilities, set `no-new-privileges` and a pids limit, run with a
  read-only root and a bounded tmpfs, and default to no network. Host or shared-container
  networking is refused; in production any other network needs both
  `OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and
  `OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true`.
- In-memory fixed-window rate limits: 600 requests per minute per client address, 20 per five
  minutes for login, 120 per minute per user/project/command
  (`OPEN_SCIENCE_RATE_LIMIT_*`, `OPEN_SCIENCE_AUTH_RATE_LIMIT_*`,
  `OPEN_SCIENCE_COMMAND_RATE_LIMIT_*`).
- Every response carries `X-Open-Science-Request-Id`; failed `/api/*` requests are written,
  sanitized, to `.openscience/errors.jsonl`. Account export and deletion are
  `GET /api/account/export` and `DELETE /api/account`.

## Health, readiness and metrics

`GET /api/health` is liveness. `GET /api/ready` runs the checks: data directory, static
assets, auth, state store, memory, usage ledger, security, observability, release manifest,
resource limits, backup, runtime sandbox and controller, and each enabled module's own
invariants. `GET /api/metrics` is the current project's storage, task and runtime snapshot.
`GET /api/ops/metrics` is the low-cardinality deployment metrics endpoint, behind
`OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` or `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE`
(production requires one). Alertmanager posts to `/api/ops/alerts`.

## Run it

From `OpenScience/` (Node 22.22 or newer, `pnpm install` first):

```bash
pnpm dev:server    # the HTTP API on 127.0.0.1:8787, file state store, development auth
pnpm dev:evimed    # local stack: local auth, serves apps/web/dist if built, port 8798
pnpm dev           # the Vite dev server, in another terminal
```

Relative defaults (`.openscience-web-data`, the bundled skill roots) resolve against the
working directory, and `pnpm dev:server` runs the package script from `apps/server`. To keep
them under `OpenScience/`, run `node apps/server/src/index.mjs` from there, or set
`OPEN_SCIENCE_DATA_DIR`; `pnpm dev:evimed` already runs from `OpenScience/`.

A real runtime needs Docker, the runtime image and
`OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker`; without them set
`OPEN_SCIENCE_RUNTIME_MODE=mock`. Point the frontend at the API with
`VITE_OPEN_SCIENCE_API_URL=http://127.0.0.1:8787/api`. Hosted deployment is described in
`docs/WEB_DEPLOYMENT.md` and the Compose stacks under `deploy/web/`.

## Tests

```bash
pnpm test:server                                           # whole suite (scripts/test/runServerTests.mjs)
pnpm --filter @ai4s/server exec node --test test/<file>.test.mjs   # one file
pnpm lint:server && pnpm typecheck:server
pnpm smoke:deployment    # against a deployed stack: OPEN_SCIENCE_SMOKE_BASE_URL, _USERNAME, _PASSWORD
```

`*.integration.test.mjs` files need PostgreSQL and skip unless
`OPEN_SCIENCE_TEST_POSTGRES_URL` is set. With it set, `pnpm test:server` runs those files one
at a time, because each resets and counts across the schema it is given. `pnpm test:web:e2e`
runs the hosted production end-to-end script.

## Known limits

The task queue, the rate limiter and per-project storage mutation serialization live in one
process; running several API replicas needs distributed coordination or per-project routing.
Project quotas are checked by the API and a runtime monitor, not enforced by the filesystem.

## Where the rest is

`../../docs/TECHNICAL_DESIGN.md` (architecture), `../../docs/WEB_DEPLOYMENT.md`,
`../../docs/WEB_OPERATIONS_RUNBOOK.md`, `../../docs/WEB_PRIVACY_AND_COMPLIANCE.md`,
`../../docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md`, and `../../AGENTS.md` for the working
rules of this subtree.
