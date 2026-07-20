# Hosted Web Deployment Readiness Report

Date: 2026-07-13

Reassessed: 2026-07-19. The canonical product/SaaS boundary is now
`docs/SAAS_PRODUCT_ALIGNMENT.md`, enforced by
`deploy/web/saas-capability-contract.json` and `pnpm audit:saas-alignment`.
The repository implements an explicit `individual-saas` technical profile for
the original individual-researcher product. This does not make the default
controlled pilot, organization collaboration, billing, horizontal scaling, or
institutional compliance complete.

Scope: comparison of the original local desktop project under
`open-science-master/open-science-master` and the hosted Web adaptation under
`open-science-web`. The original project is left unchanged. This report focuses
on what is still required before the Web version can be operated online.

## Executive Verdict

`open-science-web` now has the shape of a hosted Web MVP: a browser-capable
frontend, a Node API boundary, per-user/project workspace scoping, file upload
and preview APIs, task APIs, runtime proxying, Docker/Compose deployment files,
CI coverage, and deployment documentation.

The repository and its immutable deployment artifacts have passed a real
single-node Ubuntu ARM64 Docker/Compose acceptance run. There is no known code
blocker for the controlled single-node pilot profile in this report. This is
not target-host go-live evidence and it is not yet ready to be marketed as a
broad public multi-tenant SaaS. The operator must still accept the actual host,
public DNS/TLS, identity provider, model configuration, off-host backup,
alert-delivery, retention, capacity, and third-party license controls.

## Project Comparison

| Area | Original project | Web adaptation |
| --- | --- | --- |
| Location | `open-science-master/open-science-master` | `open-science-web` |
| Runtime model | Tauri desktop app with local sidecars | Browser frontend plus hosted Node API |
| File access | Local filesystem via desktop/Tauri commands | Server-scoped user/project workspaces |
| Agent runtime | Local OpenCode sidecar | Mock runtime or proxied hosted OpenCode runtime |
| Deployment target | User machine | Docker/Compose host or equivalent server |
| User/session model | Local user context | Local password or external OIDC identity; shared production session control plane |
| Production posture | Local-first desktop MVP | Controlled pilot by default; explicit gated individual-account SaaS profile |

## Implemented Hosted Capabilities

- Web API adapter in the frontend through `VITE_OPEN_SCIENCE_API_URL`.
- Server command allowlist and JSON error envelopes.
- Login/logout/me APIs with bootstrap user support. Hosted sign-out revokes the
  server session; sign-out, account deletion, and HTTP 401 responses clear the
  browser's CSRF/project selection plus all account-derived Runtime,
  conversation, permission, workspace, and pane state.
- Production local authentication loads the bootstrap password from an
  owner-only, no-follow file mounted by `docker-compose.local-auth.yml` as a
  mode-`0400` Docker secret. The standard env template and Linux Compose CI keep
  the direct password value empty; host preflight and `/api/ready` reject an
  environment-sourced production bootstrap password. The idempotent
  `configure:local-auth`/`check:local-auth` tooling generates and validates the
  file without printing its value.
- The hosted AppShell verifies `/api/me` before bootstrapping OpenCode, routes
  anonymous browsers to the login surface, and returns active users there when
  a Session expires; the desktop startup path is unchanged.
- Production OIDC mode using pinned `openid-client` Authorization Code with
  PKCE, state, nonce, issuer/audience/signature/expiry checks, optional exact
  group and verified email-domain admission, separate file-backed client/flow
  secrets, and AES-256-GCM short-lived correlation state. Provider tokens and
  raw identity subjects are not persisted. The hosted Settings page discovers
  the auth mode and replaces local password inputs with the configured SSO
  action. Deployment smoke accepts an operator-supplied short-lived application
  session cookie for an otherwise complete OIDC-hosted smoke run.
- Hosted startup and Settings no longer probe or provision desktop Jupyter.
  Hosted users can create and execute both Python and R notebooks through the
  scoped Docker kernel boundary; the production image pins the Python science
  stack and includes R, and deployment smoke exercises both languages. Browser
  users cannot mutate the process-wide approval policy, and deferred
  provider/MCP mutation commands return explicit unsupported responses instead
  of silently succeeding. Desktop Jupyter provisioning remains desktop-only.
- User/project-scoped workspaces and explicit project creation.
- Browser-facing workspace commands expose scoped display paths such as
  `/workspace/<project>` instead of host filesystem paths; the hosted runtime
  client does not send a `directory` parameter, and the server-side OpenCode
  proxy injects the authorized project workspace internally.
- Browser file upload, preview, download, list, read, write, and provenance
  support, with sandboxed `no-store` preview responses and sanitized download
  attachment filenames. Hosted uploads can target the active workspace root or
  the project base root, so both the session Files pane and global Files page
  use server-scoped upload paths instead of local folder selection. Hosted
  provenance records use normalized workspace-relative artifact paths, per-
  artifact versions, capped recorded content, and JSONL rotation. Directory
  listing, artifact auto-resolution, and notebook discovery are capped by
  `OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES`; project and account archive exports
  are capped by `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` and
  `OPEN_SCIENCE_MAX_ARCHIVE_BYTES`; project quota usage scans are capped by
  `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES`.
- Hosted workflow example parity: `install_example` copies the same real NASA
  GISTEMP README and CSV used by the desktop starter instead of generating a
  placeholder report. The allowlisted bundle is included in the Web image and
  release input digest; readiness validates it, and installation uses
  project-quota checks plus no-follow atomic exclusive writes so reinstalling
  cannot overwrite user edits.
- Async task creation, status polling, cancellation, command timeout handling,
  global and per-project concurrency limits, global and per-project queue-depth
  limits, project-scoped task logs, and file-backed task state indexes that
  survive server restarts without re-executing unfinished tasks. Task creation
  is restricted by an explicit queue allowlist, so runtime lifecycle and
  settings/integration control commands cannot be routed through the async
  worker. Task status APIs, task logs, and task state indexes expose metadata
  only and do not persist or return raw command arguments or command results.
  Concurrent project hydration is coalesced and state writes are serialized per
  project; snapshots are built only after a write reaches the queue front, so a
  stale running/canceling snapshot cannot overwrite a later terminal state.
- In-memory API, login, and command rate limits with `Retry-After` responses.
  The bundled Caddy path replaces `X-Forwarded-For`, production readiness and
  host preflight require proxy trust, and the API accepts only valid IPv4/IPv6
  forwarded values so public clients receive independent bounded limit keys.
  Unknown command names share one bounded rate/audit dimension and are recorded
  as `command.unknown`; raw attacker-selected names and exception messages do
  not enter command audit rows.
- Project audit logs for command execution, project creation, file access, task
  lifecycle actions, and runtime lifecycle actions (`runtime.start`,
  `runtime.restart`, `runtime.stop`), plus server-level security audit logs for
  auth events. Runtime lifecycle audit rows keep sanitized command/action,
  runtime kind, sandbox mode, running flag, and stale flag metadata without
  runtime URLs, passwords, or host paths. Operational JSONL logs rotate to a
  single `.1` file at
  `OPEN_SCIENCE_MAX_LOG_FILE_BYTES` to prevent unbounded single-node growth;
  log read APIs read a bounded tail across the current file and `.1`.
- API error responses include request ids, and failed `/api/*` requests are
  written to server-level error logs with sanitized route patterns, status,
  error code, request id, and optional project id. Authenticated users can read
  a bounded tail of their selected project's error rows, plus projectless rows,
  through `/api/logs/errors`.
- Command, file, task, and `/api/opencode/:projectId/*` route parameters reject
  malformed percent encoding with stable JSON errors; task routes also reject
  ambiguous extra path segments before dispatching cancellation actions.
- Runtime proxy logs for sanitized OpenCode method, route pattern, status,
  duration, request/response byte counts, streaming flag, and policy error
  code, without credentials, query secrets, prompts, file contents, request or
  response bodies, or workspace paths.
- Runtime proxy write requests are capped by `OPEN_SCIENCE_MAX_JSON_BYTES` and
  rejected before runtime startup when oversized.
- Non-streaming runtime proxy responses are capped by
  `OPEN_SCIENCE_MAX_JSON_BYTES` and
  `OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS`; SSE event streams remain
  long-lived and are governed by proxy connection limits, browser disconnects,
  and the runtime idle timer.
- Established hosted browser event streams use native `EventSource`
  reconnection. A renewed `ready` transition refreshes sessions and the exact
  pending question/permission sets, then reconciles locally running turns from
  server message history so missed completion frames do not leave stale UI
  locks or approvals. Recovery commits are client-instance-bound so late reads
  cannot repopulate cleared state after logout or project reconnection. SDK and
  Store regression tests cover the transport, recovery, and logout race.
- File-backed per-project runtime status in `.openscience/runtime-state.json`;
  `runtime_status` and `/api/metrics` report stale previously-running or
  interrupted-start runtimes after a server restart without exposing runtime
  URLs, passwords, request bodies, or host paths. Runtime state, task state,
  provenance, server error logs, and project JSONL log files reject symbolic
  links; provenance and operational JSONL logs rotate to a single `.1` file.
- Current-project resource snapshot API and settings UI for storage usage,
  task counts, runtime status and runtime lifecycle actions, deployment
  readiness checks, recent project audit events, project-scoped API errors,
  current-account security audit events, and server process memory/CPU/load
  metrics.
- Token-protected `/api/ops/metrics` endpoint for Prometheus-compatible
  deployment monitoring, exposing readiness state, process resources, command
  and task queue counts, task queue limits, runtime counts, runtime limits, and
  static server configuration labels without workspace paths, file names, user
  names, or project IDs. Production readiness requires a non-placeholder
  operator scrape token of at least 32 bytes, and the deployment smoke test
  verifies the protected endpoint instead of silently skipping it.
- Optional deployment monitoring profile with version-pinned Prometheus,
  Blackbox Exporter, Alertmanager, and Grafana services. It scrapes protected
  low-cardinality API metrics, probes health/readiness over the Compose network,
  evaluates ten availability/error/capacity alerts, forwards firing and
  resolved alerts to an operator-owned HTTPS webhook, and provisions a local-
  only operations dashboard. `scripts/ops/configure-monitoring.mjs` generates
  owner-only Docker secret files, rejects symbolic-link targets, weak secrets,
  and local/non-HTTPS webhooks, and supports separate validation and synthetic
  resolved-notification probe passes without printing the receiver URL.
- Single-node `OPEN_SCIENCE_DATA_DIR` backup, restore, restore-drill, retention
  pruning, and migration tooling. The migration script refuses symbolic links,
  source/target overlap, and non-empty targets unless explicitly enabled, then
  verifies the temporary copy before moving it into place.
- Optional local backup Compose profile using the same immutable Web image. It
  mounts application data read-only, gives only the backup service archive
  write access and a mode-`0400` passphrase secret, schedules encrypted backups,
  retries failures, runs disposable restore drills, and exposes persistent
  fail-closed health without publishing a port or giving the API the key.
- Optional S3-compatible off-host backup upload/download for encrypted archive
  and checksum pairs. The no-shell CLI adapter validates credential-free object
  URIs and local file types, rejects plaintext by default, verifies SHA-256 both
  directions, supports AES256/KMS object encryption flags, and hands downloaded
  archives back to the existing traversal/symlink-safe restore drill.
- User-scoped security audit log API for authentication events, with server
  JSONL rotation and filtering so authenticated users only see rows tied to
  their own username or user id.
- Hosted Settings account and project management. The account surface exposes
  current-account archive export and exact-id-confirmed deletion; project
  management lists, creates, and switches project workspaces, with runtime
  reconnection and project-scoped metrics/log refresh after a switch.
- Project-level self-service export and deletion. `GET
  /api/projects/:id/export` returns a `tar.gz` archive with project-relative
  paths only, rejects symbolic links/non-regular entries, and refuses exports
  that exceed `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` or
  `OPEN_SCIENCE_MAX_ARCHIVE_BYTES`. Linux collection and streaming use pinned
  no-follow directory/file descriptors, and fail closed when a source changes
  size, so a concurrently running agent cannot redirect or grow an export after
  its limits are checked. `DELETE /api/projects/:id` requires exact
  id confirmation, protects the default project, rejects queued/running task
  state, stops the selected project runtime, and removes that project's
  workspace, metadata, task state, runtime state, and project logs.
- Current-account self-service export and deletion. `GET /api/account/export`
  returns a `tar.gz` archive scoped to the authenticated user's data root plus
  non-secret `account.json` metadata and is capped by
  `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` and `OPEN_SCIENCE_MAX_ARCHIVE_BYTES`;
  password hashes, sessions, CSRF tokens, and host paths are excluded. `DELETE
  /api/account` requires exact user id confirmation, requires the current
  password for login-backed users, rejects
  accounts with queued/running tasks, stops attached project runtimes, revokes
  sessions, removes the user root, and records a deletion tombstone so a deleted
  bootstrap user is not recreated after restart.
- `/api/ready` deployment checks and hosted Settings readiness UI for
  data-directory root type/no-symlink/writability checks, static asset access,
  production HTTPS public origin configuration, production auth mode, configured
  login availability without disclosing the account count, production
  security-header enablement, exact HTTPS production CORS
  origins, protected production observability metrics, disabled hosted
  shell/approval escape hatches, production
  resource-limit validity and consistency, production backup/restore
  configuration, selected runtime sandbox viability, Docker daemon access,
  configured Docker runtime image locality when required, explicit production
  runtime network egress opt-in plus operator policy acknowledgement,
  accidental production mock runtime mode, accidental production host Python
  kernel enablement, and optional Docker kernel sandbox viability.
- OpenCode HTTP/SSE proxy with browser credential stripping, sanitized proxy
  metadata logging, and a server-side route/method allowlist. The hosted proxy
  permits the Web client's session, message, event, catalog, question,
  permission, cancel, and session-delete calls, while blocking runtime
  config/auth/OAuth/MCP mutation routes and unknown upstream paths before
  request-body parsing or runtime startup. Allowed mutation calls validate
  prompt, slash-command, shell, question, and permission JSON payload shapes
  before contacting OpenCode. Stale abort/session-delete controls do not wake a
  stopped runtime, and stale question or permission mutations return
  `runtime_not_running` instead of starting a new agent.
- Production Docker control is isolated from the public API container. Compose
  mounts `/var/run/docker.sock` only into an unexposed Runtime Controller and
  gives the API a read-only control-volume view of a private mode-`0600` Unix
  control socket instead. The
  versioned controller protocol accepts only health/image inspection,
  canonical project runtime lifecycle, and bounded kernel operations; it
  reconstructs fixed launch plans from validated user/project identifiers and
  does not accept arbitrary Docker arguments, images, mounts, networks, or
  commands. Its own `/data` mount is read-only, it publishes no port, and API
  readiness plus actual runtime/kernel execution reject direct production
  Docker control by default. Runtime credentials and kernel source are
  transient request data and are not persisted by the controller. Controller
  startup probes an existing Unix socket and refuses to replace an active
  instance; socket cleanup is ownership-checked, and a runtime launched for a
  client that disconnects before the start response is removed before the
  operation is released. Protocol v2 also binds API and Controller runtime
  limits: the Controller serializes lifecycle operations per project, discovers
  labelled Docker runtimes left by an earlier process, reserves in-flight
  starts, and independently enforces global and per-user capacity.
- The Web API container itself now runs with a read-only root filesystem,
  `no-new-privileges`, all Linux capabilities dropped, and a bounded
  non-executable `/tmp` tmpfs. It has no Docker socket; its backup, release, and
  Runtime Controller mounts are read-only, while `/data` is its only writable
  persistent mount.
- Docker runtime launch plan with deterministic per-project container names,
  server-start stale-container cleanup for previously attached projects,
  per-launch stale-container cleanup, Docker cleanup-failure reporting through
  `startup_orphan_cleanup_failed` at server start or
  `runtime_cleanup_failed` plus `cleanup_failed` runtime log rows before a new
  launch, Linux capability drop, pids limits, no-new-privileges, read-only root
  filesystems, bounded `/tmp` tmpfs mounts, host-network blocking by default,
  and production runtime network egress blocking unless both
  `OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and
  `OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true` are configured.
- Compose sibling-container data and transport topology no longer relies on
  container-local paths or localhost. The API data volume has a stable
  `OPEN_SCIENCE_DATA_VOLUME` name; runtime and Docker kernel launches mount only
  the selected project's existing `volume-subpath`. OpenCode listens on runtime
  container loopback and `socat` relays HTTP/SSE through a project-scoped Unix
  socket visible to the API through the same data volume, without publishing a
  runtime TCP port. Readiness rejects invalid volume names and volume/TCP
  transport mismatches. The supplied production Compose and Linux CI profiles
  now default runtime networking to `none`.
- Started runtimes have an idle-stop timer controlled by
  `OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS`; active proxied requests and SSE
  streams keep the runtime attached until the stream closes.
- Attached runtimes have a non-overlapping project quota monitor controlled by
  `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS`. It stops background runtimes
  that exceed `OPEN_SCIENCE_MAX_PROJECT_BYTES`, and fails closed with
  `quota_check_failed` if a bounded usage scan cannot complete safely.
- Runtime startup enforces global and per-user attached-runtime limits with
  `OPEN_SCIENCE_MAX_RUNNING_RUNTIMES` and
  `OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER`, counting in-flight starts as
  well as already attached runtimes.
- Each OpenCode readiness request has an independent bounded timeout and its
  response stream is canceled after the status check. An OpenCode request held
  during offline initialization can therefore be retried within the overall
  startup deadline instead of occupying the outer command timeout indefinitely.
- Hosted Settings exposes current-project runtime start, restart, and stop
  actions. Start/restart reconnect the browser runtime client to the server
  proxy URL; stop detaches the browser client after the server runtime is
  stopped. These lifecycle actions are visible in the selected project's audit
  tail with sanitized runtime metadata only. Hosted live sessions also start a
  stopped project runtime through the server command API instead of exposing a
  direct `opencode serve` path.
- Runtime startup refuses projects that already exceed
  `OPEN_SCIENCE_MAX_PROJECT_BYTES`; after proxied runtime requests and on the
  periodic monitor, project storage is rechecked and an over-quota project
  runtime is stopped with a `quota_exceeded` runtime state and log event. Quota scans return
  `project_scan_too_large` when a project exceeds
  `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES`; `/api/metrics` reports that
  condition with `project.storage.scanLimited=true`.
- Optional server-side `kernel_execute` can run Python through the Docker
  sandbox with `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker`, reusing the reviewed
  runtime image and resource controls while forcing `--network none`; stdout and
  stderr are capped by `OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES`, child lifetime is
  bounded by `OPEN_SCIENCE_KERNEL_TIMEOUT_MS`, and project usage is rechecked
  after execution. The Controller independently caps concurrent kernels globally
  and per user, removes all labelled kernel orphans before listening, and fails
  closed when orphan cleanup cannot complete.
- Browser-direct OpenCode shell proxying is server-disabled by default and
  hidden from the hosted Web composer; enabling it requires
  `OPEN_SCIENCE_ALLOW_DIRECT_SHELL=true`, with a separate host-runtime shell
  escape hatch for non-Docker runtimes.
- Hosted Web notebook surfaces now create Python notebooks and route cell or
  inspector expression execution through the scoped server kernel. Notebook
  paths are validated inside the selected project, historical workspace mounts
  and notebook working directories are preserved, and Stop aborts the matching
  in-flight execution. Production policy still fails closed unless the Docker
  kernel sandbox is enabled; Jupyter service provisioning and R kernels remain
  in the deferred second batch.
- Runtime startup deploys manifest-backed skills from
  `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` into the project runtime XDG config. The
  default hosted Web image includes only the first-party `runtime/skills/core`
  pack; deployed skill targets reject symbolic links. The hosted Skills page is
  a read-only runtime catalog and does not expose browser-side custom skill
  installation or local environment probing; the Web `detect_tools` command
  returns an empty result instead of server-local tool versions.
- Explicit host-mode runtime startup attempts conservative stale same-project
  OpenCode `serve` PID cleanup from runtime state, but host mode remains a
  trusted-deployment fallback rather than the recommended production sandbox.
- Hosted security headers, exact-origin credentialed CORS allowlisting, safer
  session cookies for HTTPS public URLs, configurable session TTLs with cookie
  `Max-Age`, `Strict-Transport-Security` for HTTPS public origins, production
  readiness rejection for invalid session TTLs and unsafe production security
  policy settings, and production-mode CSRF token checks for mutating
  cookie-backed APIs.
- The production Compose origin boundary publishes the Node API diagnostic port
  only on host loopback as
  `127.0.0.1:${OPEN_SCIENCE_API_PORT:-8787}:8787`; Caddy reaches the API through
  the private Compose network. Host preflight validates the diagnostic port, all
  documented production startup commands enable the TLS profile, and the hosted
  compliance audit rejects drift in this boundary.
- Dockerfile, Compose file, an OpenCode runtime-image Dockerfile, deployment
  documentation, and Web CI workflow. The root `ci:web` script and GitHub
  workflow now include the hosted E2E flow:
  login, project creation, upload, proxied runtime/SSE, artifact generation,
  preview, and runtime log readback.
- Deployment smoke-test script for already-running Web deployments. It checks
  health, readiness, the readiness security-policy sub-check, optional operator
  metrics, login, CSRF, project creation, upload/read/preview/download, and
  optional runtime startup with proxied SSE plus runtime stop verification.
- A fail-closed production host preflight verifies a private non-symlinked env
  file, Linux, Docker Engine 26+, Compose, Docker-root free space, exact HTTPS
  public/Caddy domains, immutable release metadata, local Web/Runtime/Caddy
  image architecture, selected Compose overlays, release-manifest image IDs,
  local-auth/OIDC/monitoring/backup secret files, runtime escape hatches, and optional
  public frontend/health/readiness/security-header/release evidence. A configured
  object destination is tested with random write, byte-for-byte read-back, and
  delete operations; the production template makes this destination mandatory.
  Online preflight can also require a synthetic resolved notification to receive
  a 2xx response from the exact private Alertmanager webhook. The Linux
  Docker CI job runs the offline preflight; target deployments run it again with
  `--online` before deployment smoke.
- Single-node `OPEN_SCIENCE_DATA_DIR` backup, restore, restore-drill, retention
  pruning, and migration scripts. Backup/restore support checksum sidecars,
  optional passphrase-based encrypted archives, symlink rejection, traversal
  rejection on restore, and explicit opt-in before replacing a non-empty
  target. `OPEN_SCIENCE_BACKUP_RETENTION_DAYS` prunes old local backup
  archives and checksum sidecars, `scripts/ops/restore-drill.sh` restores an
  archive into a disposable directory for scheduled restore drills, and
  `scripts/ops/migrate-data-dir.sh` verifies a stopped-service data-dir copy
  before moving it into place.
- Hosted compliance audit script for default Web image skill packaging, runtime
  version pins, architecture-specific release-archive integrity, preserved
  OpenCode/uv license texts, required privacy/license documentation, and
  configured runtime skill directories.
- A security/privacy incident-response workflow defines named roles and
  severity, independent authorization for operator access to user projects,
  narrow read-only scope, evidence custody and hashing, containment, secret and
  session revocation, recovery gates, notification decisions, and post-incident
  verification. The compliance audit fails when these controls or their
  operations/privacy links are missing.
- Immutable deployment release manifest generation and verification. The
  generated record binds a release id and exact source revision to the actual
  Web/runtime/Caddy Docker image IDs, OpenCode/uv/Caddy versions, version-pinned monitoring
  components, core skill-pack file count/content digest, package lock, complete
  hosted frontend/server/SDK/shared source-tree digests, both Dockerfiles,
  runtime socket launcher and privileged-controller protocol, archive crypto,
  backup/restore/scheduler/object-storage adapters, local-auth and OIDC secret
  adapters, base/backup/local-auth/OIDC/monitoring Compose configuration, Caddy configuration,
  deployment/privacy/incident runbooks, and monitoring configuration. Web and runtime images carry
  matching OCI release labels, while
  the runtime image also labels OpenCode and uv versions. Production readiness
  rejects missing, malformed, symbolic-link, placeholder, `latest`, or
  configuration-mismatched manifests; local Docker readiness compares the
  actual image ID/tool labels without exposing image IDs. Runtime and Docker
  kernel launch policy fails closed on missing/mismatched provenance even when
  readiness is bypassed.
- A separate Linux `docker-hosted` CI job builds the hosted Web and pinned
  OpenCode runtime images with OCI release labels, pulls the exact Caddy proxy,
  generates and re-verifies the deployment manifest against actual Docker image
  IDs, runs production host preflight, starts the production
  Compose API plus backup and monitoring profiles, waits for the backup
  scheduler, API, Prometheus, Alertmanager, and Grafana readiness, verifies an
  encrypted archive and restore-drill state, starts Caddy with an ephemeral
  local CA, trusts that CA in the runner, and runs online preflight plus
  deployment smoke through the HTTPS reverse proxy and a real OpenCode
  container boundary without requiring model credentials. The same smoke run
  requires the Docker Python kernel, reads and writes the selected project
  volume from the notebook directory, verifies the persisted output, checks
  runtime and kernel container cleanup plus mount/socket privilege boundaries,
  and tears down volumes/orphans on every outcome.
  Local-password CI creates a private random bootstrap file, mounts it through
  the local-auth overlay, and supplies it to deployment smoke only by reading
  the file at process launch rather than persisting the password in `.env.ci`.

## Verification Evidence

The local full Web gate was run on 2026-07-13 with the repository-pinned package
manager (`CI=true npx --yes pnpm@9.4.0 ci:web`) and completed successfully. The
host's unrelated global pnpm 8 installation cannot parse this pnpm 9 lockfile
for dependency auditing and is not a supported verification toolchain:

- Server: 309 test cases; 308 passed locally and the descriptor-replacement race
  test was skipped because it intentionally requires Linux `/proc/self/fd`.
  A separate Node 20 Linux container run executed the complete security file
  suite, including that race, with 10/10 passing. The suite also
  verifies that bundled examples resolve correctly when pnpm launches the server
  package from `apps/server` instead of the repository root.
- Frontend: 75 test files and 412 tests passed; TypeScript checking passed.
- Hosted browser/API flow: 1 end-to-end test passed.
- Real-browser acceptance: Firefox driven through Playwright verified the
  anonymous auth gate, local-password login, automatic runtime startup,
  project switching with synchronized workspace/data-flow paths, browser file
  upload/list/preview, proxied mock-agent conversation and artifact preview,
  and logout cleanup of account, runtime, and workspace state.
- Hosted compliance: 56 checks passed with 0 failures and 0 warnings, including
  the loopback-only API origin, documented Caddy/TLS startup boundary, and
  validated trusted-proxy client identity used for rate limiting, native
  runtime architecture selection, read-only capability-free API/container
  boundaries, post-connect SSE state recovery, and hosted real-example parity.
- Production dependency audit: 0 known vulnerabilities at moderate-or-higher
  severity through the npm advisory registry.
- Production frontend build: completed successfully.
- Rust/Tauri backend: `cargo check` completed successfully after rebuilding its
  generated state from the current project path.
- Production server packaging: `pnpm --filter @ai4s/server deploy --prod`
  completed successfully, and every packaged `.mjs` entry passed Node syntax
  validation.
- Release-manifest generation, source-digest checks, and actual Web/runtime/Caddy
  image-ID verification passed after the final image rebuild.

### Real Linux Docker Acceptance

An ephemeral Lima VM was used as a disposable acceptance host. It is Ubuntu
24.04 ARM64 with 4 CPUs, 8 GiB RAM, an 80 GiB disk, Docker Engine 29.6.1, and
Docker Compose 5.3.1. This run is stronger than mocked process tests but is not
the intended production host.

- The native ARM64 OpenCode runtime image built successfully and verified
  OpenCode 1.17.13, uv 0.11.26, architecture-specific SHA-256 checks, and
  preserved license files. The final Web image, runtime image, and Caddy
  2.11.4 image matched the host architecture and generated release manifest.
- The production base, local-auth, backup, monitoring, and TLS Compose profiles
  started together. Web API, Runtime Controller, backup scheduler, Prometheus,
  Alertmanager, Grafana, Blackbox Exporter, and Caddy remained running; all
  defined health/readiness checks passed.
- Offline and online host preflight passed every enabled check: private env and
  secret files, Linux OS, Docker socket group/mode, Engine/Compose versions,
  free storage, image architecture, Compose policy, release identity, local
  auth, monitoring, backup, frontend, HTTPS health/readiness, security headers,
  and release identity.
- HTTPS acceptance used `https://localhost` and Caddy's temporary local CA. The
  real deployment smoke passed health/readiness, protected operator metrics,
  local login, CSRF, project creation, the release-bound climate workflow,
  upload/read/preview/download, a Docker Python kernel that read and wrote only
  the selected project volume, OpenCode startup/proxy access, and runtime stop.
- The first OpenCode readiness request was deliberately observed hanging during
  network-isolated initialization. The new per-probe timeout regression passed,
  and the rebuilt deployment completed the full smoke in under four seconds.
- Encrypted backup archives, SHA-256 sidecars, restore-drill state, and scheduler
  health were present. The Web API could only read backups; only the backup
  service could write them and read the passphrase secret.
- Runtime Controller was the only application service with the Docker socket.
  Its verified supplementary group matched socket GID 988. Web, Controller, and
  backup privilege assertions passed; Web and Controller used read-only roots,
  dropped all capabilities, and enabled `no-new-privileges`.
- No containers labelled `open-science.web.runtime=true` or
  `open-science.web.kernel=true` remained after smoke cleanup.

The acceptance run intentionally did not test a public DNS name or ACME
certificate, a real external OIDC provider, model credentials or a billable LLM
prompt, external object storage, external Alertmanager delivery, horizontal
replicas, host loss, or sustained concurrency/load. Those are target-environment
acceptance items, not evidence supplied by this VM.

## P0 Go-Live Blockers for Public SaaS

These must be resolved before opening the service to untrusted external users.

- Production identity: standard OIDC authentication, provider-managed MFA and
  account recovery are now available, while local password mode remains for a
  controlled single-node pilot. Local mode now uses a file-backed Docker secret,
  but it has no self-service password reset; changing the bootstrap file after
  the first account is persisted does not rotate that account. Application
  users, projects, and sessions use the required shared Postgres control plane
  in the production Compose profile, but
  role/tenant administration, invitation/offboarding workflows, organization
  policy, and centralized revocation semantics remain required before broad
  multi-tenant or horizontally scaled operation.
- Model keys: the production DeepSeek path uses an operator-managed file-backed
  server secret and a signed server-side gateway; the browser, workspace, and
  runtime do not receive the provider key. Per-user or per-organization BYOK,
  encrypted key lifecycle, rotation UI, and multiple-provider self-service are
  still deferred.
- Data governance: workspace files, provenance, audit logs, task logs, task
  state indexes, runtime logs, and runtime state live under
  `OPEN_SCIENCE_DATA_DIR`; production user/project/session state is in Postgres,
  while fallback modes may also use `users.json`. The data-directory root must be a real
  directory rather than a symbolic link or file, task state indexes omit raw
  command arguments and results, and these hosted state/log paths reject symbolic
  links. Project-level and current-account export/deletion now exist in the API
  and hosted Settings UI, and production readiness now rejects missing backup
  ownership unless local encrypted backups plus restore drills or explicit
  external backup ownership are configured. Organization-level retention/export,
  off-host backup custody, encryption, and operator-access policies are still
  required.
- Runtime image: the repository now pins and labels OpenCode/uv versions,
  verifies architecture-specific release assets before extraction, preserves
  their selected license texts, selects native AMD64/ARM64 artifacts from
  BuildKit's target architecture without a hard-coded default, and verifies image identity through the
  deployment manifest. Real hosted agent use still requires building or pulling
  that exact image on the target host and operator acceptance of its complete
  package/license inventory.
- Third-party skills and Office skills/exporters: the restricted Anthropic
  redistribution path has been replaced
  by four first-party MIT exporters for `docx`, `pdf`, `pptx`, and `xlsx`.
  Each exporter has an executable entrypoint, parseable-artifact smoke test,
  desktop packaging, and Hosted packaging. The hosted audit still rejects any
  attempted reintroduction of the restricted third-party directories.
- Deployment acceptance: the disposable Ubuntu ARM64 Docker run passed, but the
  `docker-hosted` job still needs a green run in the actual GitHub repository and
  the complete preflight/smoke procedure must be repeated on the intended host
  with its real DNS/TLS, identity, egress, object storage, alert delivery, and
  capacity policy.

## P1 Operational Hardening

These should be done before a larger controlled beta.

- Users, projects, sessions, and research identity state already use the shared
  Postgres control plane in production. Move task dispatch, rate limits, log
  indexes, storage coordination, and runtime scheduling to distributed services
  before horizontal API replicas; current queue/quota serialization remains
  process-local.
- Move monitoring retention and availability outside the single application
  host before a broad public launch. The bundled profile provides local
  retention, alerts, probes, and dashboards, but it cannot notify if the entire
  host or its network is lost; an independent external probe/Alertmanager path
  and centralized incident-review storage are still required at that scale.
  The built-in `.1` JSONL rotation remains only a local growth guard.
- Replace the in-memory rate limiter with central gateway or database-backed
  rate limits before horizontal API scaling.
- Back the runtime quota guard with real storage enforcement, such as
  per-project volume quotas, project-specific filesystems, or dedicated worker
  storage controllers, before allowing untrusted large agent workloads. The API
  quota scan is bounded by `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES` and is
  now run periodically for every attached runtime. API capacity checks and
  writes are serialized per project inside one API process, but this is still
  an application guard rather than a cross-replica or filesystem-level hard
  quota.
- If the API and frontend are intentionally split across origins, configure
  `OPEN_SCIENCE_CORS_ORIGINS` to exact HTTPS frontend origins and keep the
  readiness gate in the deployment pipeline.
- Move the Runtime Controller onto dedicated worker hosts before horizontal or
  high-risk public workloads; the single-host controller now removes Docker
  Socket access from the API but still shares the application's failure domain.
- Before enabling real model traffic, replace the unrestricted bridge escape
  hatch with a destination-restricted or independently audited egress path. The
  current controlled-pilot Compose profile deliberately uses `--network none`.

## P2 Product and Maintenance Work

These are not immediate blockers for an internal pilot but affect quality and
maintainability.

- Broaden the current hosted Settings operational panels into a real admin UI
  for users, cross-user projects, quotas, runtime status, and task inspection.
- Connect the supplied scheduler's optional S3-compatible upload to owned
  workload identity, bucket lifecycle/object lock, documented passphrase
  custody, independent alerts, and operator access controls.
- Continue reducing large frontend chunks and review the existing 3Dmol `eval`
  build warning.

## Current Minimum Online Deployment Profile

For a controlled pilot, use this posture:

- Run `pnpm preflight:host --env-file deploy/web/.env` before Compose, then
  rerun it with `--online` through the public TLS route before deployment smoke.
- Same-origin frontend and API with `VITE_OPEN_SCIENCE_API_URL=/api`.
- TLS in front of the server and `OPEN_SCIENCE_PUBLIC_URL=https://...`; in
  production `/api/ready` rejects missing, non-HTTPS, or non-origin values.
- Keep the API host diagnostic mapping on
  `127.0.0.1:${OPEN_SCIENCE_API_PORT:-8787}` and start Compose with
  `--profile tls`; only Caddy ports 80/443 may be public. Do not add a wildcard
  or public-interface mapping for container port 8787.
- Keep `OPEN_SCIENCE_TRUST_PROXY=true` with the bundled Caddy configuration so
  Caddy-replaced, validated client IPs drive API and login rate limits. Any
  replacement proxy must overwrite rather than preserve browser-supplied
  `X-Forwarded-For` values.
- Prefer `OPEN_SCIENCE_AUTH_MODE=oidc` plus the file-secret Compose overlay,
  provider MFA/account-recovery policy, and at least one reviewed group or
  verified email-domain admission rule for external users. Local mode remains
  acceptable only for a controlled single-node pilot when
  `pnpm configure:local-auth` and `pnpm check:local-auth` pass, the password is
  retained in an operator password manager, and
  `docker-compose.local-auth.yml` is loaded. Do not set the password directly
  in `.env` or the container environment.
- Versioned Web/runtime image names, immutable release/source/build metadata,
  and a generated `deploy/web/release-manifest.json`. Run
  `pnpm verify:release-manifest` after images are built or pulled and before
  Compose startup; production `/api/ready` must report the release provenance
  check as tracked and successful.
- Use the exact `OPEN_SCIENCE_CADDY_VERSION=2.11.4-alpine` proxy image recorded
  by the release manifest; `OPEN_SCIENCE_DOMAIN` must exactly match the public
  URL hostname.
- A deployment-secret `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` of at least 32
  random bytes, with the matching scrape credential supplied to deployment
  smoke and the monitoring system. For the bundled monitoring profile, generate
  an owner-only `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE`, Grafana password,
  and Alertmanager webhook config with `pnpm configure:monitoring`, then validate
  them with `pnpm check:monitoring` before Compose startup. Keep
  `OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY=true` so online preflight requires the
  configured operator endpoint to accept a synthetic resolved notification.
- `OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker` with the reviewed
  `deploy/runtime-opencode/Dockerfile` image, or an equivalent operator-supplied
  OpenCode image, for real hosted agent use. `OPEN_SCIENCE_RUNTIME_MODE=mock`
  now also requires
  `OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true` in production and should only be used
  for smoke tests.
- Keep `OPEN_SCIENCE_DATA_VOLUME=open-science-data`,
  `OPEN_SCIENCE_RUNTIME_TRANSPORT=unix`, and
  `OPEN_SCIENCE_RUNTIME_NETWORK_MODE=open-science-runtime-internal` for the
  current controlled profile. This Docker network is internal: runtimes reach
  only the authenticated Web model and official-host public-source gateways,
  while arbitrary runtime Internet egress remains disabled.
  Keep the Compose-fixed `OPEN_SCIENCE_RUNTIME_CONTROLLER_MODE=socket` and
  `OPEN_SCIENCE_ALLOW_DIRECT_DOCKER_CONTROL=false`; the API service must not
  mount `/var/run/docker.sock`, and the controller service must not publish a
  port.
  The named-volume subpath gives each runtime only its own project, and the Unix
  socket carries HTTP/SSE without a published runtime port. The public-source
  gateway does not turn the 123-source review catalog into 123 connections: its
  allowlist currently backs only the explicitly registered public connectors.
  Set the two runtime egress opt-ins only after a restricted or independently
  logged outbound path, data-flow review, and response owner exist;
  acknowledgement alone does not create network enforcement.
- Keep `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS` positive so attached
  runtimes remain covered by periodic fail-closed project usage checks.
- `OPEN_SCIENCE_ENABLE_KERNEL=false` by default. If command API kernels are
  enabled for a controlled deployment, use
  `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker`; the host Python kernel path is
  local-development only and remains rejected in production.
- Keep provider secrets in the file-backed server gateway. Do not add browser
  keys or claim per-user/organization BYOK until encrypted lifecycle management
  is implemented.
- Keep restricted Anthropic document directories outside desktop and Hosted
  packaging; only the first-party MIT Office exporters are release-approved.
- Backups, local retention pruning, and restore drills configured for the
  `OPEN_SCIENCE_DATA_DIR` volume. Use `docker-compose.backup.yml` with the
  `backup` profile, an owner-only generated secret, encrypted archives,
  positive retention, sized restore-drill tmpfs, and healthy scheduler state;
  or use
  `OPEN_SCIENCE_BACKUP_MODE=external` with explicit external-backup and restore
  drill acknowledgements. The included scheduler is acceptable for controlled
  single-node recovery only when paired with off-host storage, passphrase
  custody, and independent alert ownership. `OPEN_SCIENCE_OBJECT_BACKUP_URI=s3://...`
  enables verified encrypted archive/checksum upload; periodically download with
  `pnpm restore:object` and run the normal restore drill. Keep
  `OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE=true` so the offline host gate requires
  and probes write/read/delete access to that destination.

## Related Documents

- `docs/SAAS_PRODUCT_ALIGNMENT.md`
- `docs/WEB_DEPLOYMENT.md`
- `docs/WEB_PRIVACY_AND_COMPLIANCE.md`
- `docs/WEB_OPERATIONS_RUNBOOK.md`
- `apps/server/README.md`
- `runtime/skills/README.md`
