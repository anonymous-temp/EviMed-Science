# Hosted Web Deployment

This document describes the current hosted Web slice. Production uses a shared
Postgres control plane and a file-backed operator model secret behind the signed
server gateway; it does not provide self-service per-user or organization BYOK.

The canonical product and claim boundary is
[`SAAS_PRODUCT_ALIGNMENT.md`](./SAAS_PRODUCT_ALIGNMENT.md). Base Compose defaults
to `controlled-pilot`; public technical SaaS requires the explicit
`individual-saas` profile and does not imply organization or billing features.

For privacy, retention, data handling, and third-party license gates, also read
[`WEB_PRIVACY_AND_COMPLIANCE.md`](./WEB_PRIVACY_AND_COMPLIANCE.md) before
publishing a hosted deployment.

For a stricter readiness assessment of the current Web adaptation, see
[`WEB_DEPLOYMENT_READINESS_REPORT.md`](./WEB_DEPLOYMENT_READINESS_REPORT.md).

## What Is Implemented

- Vite frontend can call a hosted command backend via `VITE_OPEN_SCIENCE_API_URL`.
- `apps/server` exposes `POST /api/commands/:command` with an allowlist,
  consistent JSON errors, development auth, per-user/project workspace roots,
  file upload/preview/download, project storage quotas, provenance, audit logs,
  scoped log read APIs, and the runtime session surface (`POST /api/runtime/sessions`,
  `GET /api/runtime/sessions/:id/transcript`, `GET /api/runs/:id/events`). The
  browser never speaks a kernel's protocol: the old `/api/opencode/:projectId/*`
  pass-through is retired and answers `410 runtime_passthrough_retired`, keeping
  the retired kernel's name on purpose so an already-deployed client gets told
  what replaced it instead of an anonymous 404. Malformed percent-encoded route
  parameters return stable `400 invalid_encoding` JSON errors instead of internal
  decode failures, including command, file, task, and runtime route parameters.
- Every API response includes `X-Open-Science-Request-Id`; error responses also
  include that id in the JSON body. Failed `/api/*` requests are written to
  `.openscience/errors.jsonl` with sanitized method, route pattern, status,
  code, request id, and optional project id. These records omit request bodies,
  prompts, query strings, file paths, runtime URLs, cookies, and authorization
  headers. `/api/logs/errors` exposes a bounded tail of the selected project's
  error rows plus projectless rows for authenticated hosted users.
- Authentication attempts and logout events are written to
  `.openscience/security.jsonl`. `/api/logs/security` returns only the bounded
  tail of rows related to the authenticated user, so one user cannot browse
  other users' login history or failed username attempts through the Web API.
- Authentication has explicit `development`, `local`, and `oidc` modes.
  Production OIDC uses Authorization Code with PKCE through the pinned
  `openid-client` package, validates state, nonce, issuer, audience, signature,
  and ID Token expiry, and can require exact group membership or a verified
  email domain. Provider access, refresh, and ID tokens are never written to
  user, project, session, audit, or error state. The external issuer/subject is
  reduced to a stable SHA-256-derived local user id; only that id, display name,
  and `authType=oidc` are persisted.
- Workspace file previews are served with `Cache-Control: no-store` and a
  sandboxed preview CSP that disables scripts, outbound connections, forms,
  object embeds, and base-URI changes. Downloads are forced through attachment
  responses with sanitized filenames.
- Runtime proxy requests write sanitized runtime log metadata: HTTP method,
  route pattern, status, duration, request/response byte counts, streaming flag,
  and policy error code. These records intentionally omit browser credentials,
  query secrets, workspace paths, request bodies, and response bodies.
  Non-GET/HEAD runtime proxy requests are capped by
  `OPEN_SCIENCE_MAX_JSON_BYTES` and rejected before runtime startup when they
  exceed that limit. Server-disabled persistent approvals and direct shell proxy
  requests are also rejected before runtime startup when the policy decision
  does not require inspecting the runtime sandbox. Runtime responses are also
  sanitized before reaching the browser: runtime cookies, auth challenges, hop-by-hop headers, content
  encoding/length metadata, and redirect targets that bypass the proxy are not
  forwarded. Runtime-local redirects are rewritten through the server's own
  runtime route rather than being handed to the browser.
- Project metadata includes the active workspace folder, so hosted
  `set_workspace` and `new_dated_workspace` choices persist across server
  restarts while remaining scoped under the project workspace root.
  `OPEN_SCIENCE_DATA_DIR` itself must be a real directory rather than a symbolic
  link or file. User roots, per-user project containers, project roots, project
  metadata files, and active workspace directories also reject symbolic links, so
  a polluted data volume cannot redirect work outside its user-owned tree.
- Browser-facing workspace commands return scoped display paths such as
  `/workspace/<project>/<folder>`, not host filesystem paths. The Web runtime
  client does not send a `directory` parameter; the server injects the selected
  project's real workspace directory after authenticating and authorizing the
  request. In Docker runtime mode the injected directory is
  the container-visible `/workspace` mount backed by only that project's named-
  volume subpath; host and mock runtimes receive the server workspace path.
- After an established hosted SSE connection drops, the browser `EventSource`
  keeps its native reconnect loop. When the stream opens again, the frontend
  refreshes the session index and the complete pending question/permission
  sets, then reconciles every locally running turn against server message
  history. This repairs missed completion frames and stale approval prompts
  without depending on upstream event replay. Recovery reads are bound to the
  client instance that started them, so a late response cannot repopulate
  cleared account state after logout or project reconnection.
- The hosted Settings page includes account and project management surfaces.
  Account actions expose current-account archive export and exact-id-confirmed
  deletion. Project switching updates the frontend's `X-Open-Science-Project`
  context, reconnects the hosted runtime proxy, and refreshes project-scoped
  resource, task, and API-error views.
- Hosted users can export a selected project through
  `GET /api/projects/:id/export`, which returns a `tar.gz` archive containing
  only project-relative paths under that project root. Project deletion is
  available through `DELETE /api/projects/:id` with exact id confirmation. The
  server protects the default project, rejects deletion while queued/running
  tasks exist, stops the selected project runtime before removal, and deletes
  the project workspace, metadata, task state, runtime state, and project logs.
  Project exports reject symbolic links and non-regular filesystem entries, and
  cap collected archive entries with `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES`.
- Current-account export is available through `GET /api/account/export`. It
  returns a `tar.gz` archive scoped to the authenticated user's data root plus
  an `account.json` metadata file with user/project ids and names only; password
  hashes, sessions, CSRF tokens, and host paths are not included. Account export
  uses the same `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` cap. Current-account
  deletion is available through `DELETE /api/account`: it requires exact user id
  confirmation, requires the current password for login-backed accounts, rejects
  accounts with queued/running tasks, stops attached project runtimes, revokes
  sessions, deletes the user data root, and records a file-backed tombstone so a
  deleted bootstrap user is not recreated on server restart. The hosted Settings
  UI calls these APIs directly and returns users to the login state after
  successful deletion.
- Browser uploads and the `upload_file` command accept nested relative paths
  inside either the current workspace root or the project base root, while
  rejecting absolute paths, traversal segments, empty path segments, oversized
  files, and quota overflow. The hosted session Files pane uploads into the
  current workspace folder; the global Files page uploads into the currently
  browsed project folder. Upload request JSON envelopes are sized from
  `OPEN_SCIENCE_MAX_FILE_BYTES`, while non-upload JSON APIs keep the tighter
  `OPEN_SCIENCE_MAX_JSON_BYTES` guard. Queued `upload_file` tasks use the same
  file-sized envelope path; other queued command tasks keep the tighter JSON
  guard. Mutating command, task, and direct upload routes validate the
  authenticated user/project context before reading upload-sized request
  bodies. File APIs reject symbolic links inside hosted workspaces, skip them
  during directory listing/artifact resolution/notebook listing, and missing
  files/directories return stable JSON 404 errors. Direct directory listings
  and recursive workspace scans are capped by
  `OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES`. On the production Linux host,
  workspace reads, streams, scans, quota walks, and exports traverse directories
  through pinned `/proc/self/fd` descriptors opened with `O_NOFOLLOW`; writes
  create a private temporary file inside the pinned parent descriptor and replace
  the destination atomically. This closes the check-then-replace window while a
  runtime container is modifying the same workspace. Archive generation also
  fails closed if a collected file changes size before or during its bounded
  stream. Capacity checks and API writes are serialized per project inside one
  API process, preventing concurrent uploads from independently passing the same
  quota check. Multi-replica deployments must additionally use a distributed
  lock, storage-controller quota, or sticky per-project routing because this
  lock is not shared between processes. HTML previews are also
  rendered in a browser iframe without script permission, in addition to the
  server-side preview CSP.
  Hosted file previews use the authenticated streaming download endpoint
  instead of exposing the desktop-only `open_path` action or loading whole
  downloads into browser JavaScript memory.
- The hosted `install_example` command now installs the same real NASA GISTEMP
  climate dataset used by the desktop workflow starter. Only the allowlisted
  `climate-trends` bundle is copied into the Web image and release source
  digest. Installation is project-quota checked, rejects unsafe paths, creates
  files atomically without following links, and never replaces a file the user
  already edited. `/api/ready` fails if the required bundle is absent or
  malformed, and deployment smoke installs and reads the real CSV through the
  public command API, so a production image cannot advertise a broken starter
  flow.
- Hosted provenance records are stored under the selected project only, use
  normalized workspace-relative artifact paths, assign per-artifact versions,
  cap large recorded content, include the frontend-provided provenance log
  label, and rotate `provenance.jsonl` to `.1` with
  `OPEN_SCIENCE_MAX_LOG_FILE_BYTES`.
- `apps/server` also exposes `/api/tasks` for async command tasks, status
  polling, cancellation, command timeouts, and per-project task JSONL events.
  Running task cancellation and timeouts propagate an `AbortSignal` to command
  handlers that support interruption, including the current hosted kernel
  execution slice. That development-only kernel slice returns `{ ok, stdout,
  stderr, artifacts }` for Python when explicitly enabled outside production.
  Hosted Web UI surfaces notebook files as project artifacts, but it disables
  notebook creation and cell/expression execution controls until a server-side
  kernel sandbox is enabled.
  The execution queue is still in-process and enforces global concurrency,
  per-project concurrency, global queue depth, and per-project queue depth so
  one project cannot occupy every async task slot or accumulate unbounded
  waiting work. `/api/tasks` uses an explicit queue allowlist for file/artifact,
  provenance, example-install, notebook-listing, and kernel execution commands;
  runtime lifecycle, settings, auth import, MCP/Jupyter provisioning, HPC, and
  Modal control commands must stay on their synchronous API surfaces. Task
  metadata is also persisted per project in
  `.openscience/tasks-state.json`; completed records survive server restarts,
  and unfinished records are marked failed with `server_restarted` rather than
  silently disappearing or being re-executed. Task APIs, task events, and task
  state indexes intentionally expose task metadata only: id, command name,
  status, user/project ids, timestamps, and structured errors. Raw command
  arguments and command results are not stored in task state or returned from
  task status endpoints. Task state and task-event files reject symbolic links.
  This gives the hosted API a stable task surface before the database queue is
  introduced.
- The server runs a real DSH runtime container per project and holds the only
  connection to it. In production-like auth mode, unsandboxed host runtime startup is
  refused unless `OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME=true`; use
  `OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker` for the server-managed container
  launch plan. Production Compose does not mount the Docker socket into the Web
  API. A separate, unexposed Runtime Controller owns that socket and listens on
  a mode-`0600` Unix socket shared only with the API. Its versioned protocol
  accepts fixed health/image, project-runtime lifecycle, and bounded kernel
  operations; it reconstructs canonical `/data/users/<user>/projects/<project>`
  paths and Docker arguments from validated identifiers and never accepts an
  arbitrary image, mount, network, command, or Docker argument list. Controller
  protocol v2 also reports the global and per-user runtime limits;
  the API rejects a Controller whose limits differ from its own configuration.
  The Controller serializes start/cleanup operations per project and enforces
  those limits itself using Docker label discovery plus in-flight reservations,
  so capacity policy does not depend only on API process memory. Production
  readiness and runtime/kernel execution fail with `runtime_controller_required`
  when Docker control remains direct unless an explicit nondefault test escape
  is enabled. Docker runtimes get deterministic per-project container names
  and labels. Server startup scans stored project runtime state and removes
  previously attached Docker containers before accepting traffic; each
  per-project runtime launch also removes any matching stale container before
  launching a new one. A missing container is treated as a no-op, while Docker
  cleanup failures are recorded in the selected project's runtime log and
  runtime state. Per-launch cleanup failures return `runtime_cleanup_failed`
  before any new container is launched. Explicitly opted-in host runtimes also
  attempt conservative cleanup
  of a stale same-project kernel PID recorded in runtime state before startup, but Docker remains the recommended hosted sandbox. Without a real
  runtime, `OPEN_SCIENCE_RUNTIME_MODE=mock` provides a test/runtime placeholder
  while model configuration is deferred; production readiness and
  `start_runtime` reject it unless `OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true` is
  explicitly set for a smoke test. Runtime status metadata is persisted per
  project in `.openscience/runtime-state.json`; after a server restart,
  `runtime_status` and `/api/metrics` mark previously running or interrupted-
  start runtimes as `stale` instead of pretending they are still attached.
  Both the API admission layer and Runtime Controller enforce
  `OPEN_SCIENCE_MAX_RUNNING_RUNTIMES` and
  `OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER`, counting both attached runtimes
  and in-flight starts. The Controller additionally counts matching Docker
  containers left by an earlier Controller process; exceeding either limit
  returns `runtime_limit_exceeded` with `Retry-After`. Runtime proxy requests
  and SSE streams are also capped by
  `OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS` and
  `OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT`; exceeding either
  limit returns `runtime_proxy_limit_exceeded` before additional runtime work is
  started. The kernel wire itself is allow-listed rather than open: the server
  may call only the unary methods and stream endpoints named in
  `packages/harness-port/seam-manifest.json`, and everything else the kernel
  exposes — credentials, settings, workspace mutation, model catalogs, agent
  presets, goals, message feedback — is on that manifest's `denied` list, so a
  method the product does not use cannot be reached even by accident. Stale
  abort and cancel controls are idempotent and do not wake a stopped runtime. Started runtimes are
  also stopped after
  `OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS` with no active proxied request or SSE
  stream; the default is 30 minutes, and values less than or equal to zero
  disable idle stopping. Runtime startup refuses projects that already exceed
  `OPEN_SCIENCE_MAX_PROJECT_BYTES`; after proxied runtime requests, the server
  rechecks project storage and stops that project runtime with a
  `quota_exceeded` state if agent-generated files push the project over quota.
  While a runtime remains attached, the server also scans project usage every
  `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS` so background writes are
  stopped without waiting for another proxy response. A bounded-scan failure
  stops the runtime with `quota_check_failed` rather than allowing unmeasured
  writes to continue.
  Changing the active workspace with hosted `set_workspace` or
  `new_dated_workspace` also stops the selected project's attached or starting
  runtime, so the next runtime start or proxied request is launched against the
  newly selected folder instead of continuing with the previous mount.
  Skills are no longer synchronized per project. The runtime image bakes its
  skill roots in at build time (`/opt/evimed` for the core and capability packs,
  `/usr/local/share/evimed` for the curated-scientific pack), and the generated
  profile patch names those paths. `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` now only
  feeds the release manifest's skill-pack digests, which is what a deployment is
  checked against. Copying a tree per project is what made a run reference a
  directory the image does not have.
  In hosted Web mode, the Skills page is a read-only runtime catalog: it lists
  server-reported agents and skills, but hides custom skill installation and
  local scientific-environment detection. The Web command API also returns an
  empty `detect_tools` result so browser users cannot probe server-local tool
  versions through the hosted command allowlist.
  Runtime state, runtime-event files, and deployed skill targets reject
  symbolic links.
- Hosted responses include basic security headers and exact-origin credentialed
  CORS allowlisting. In local-password and OIDC modes, mutating cookie-backed
  APIs require an `X-Open-Science-CSRF` token issued by `/api/auth/login`, the
  OIDC callback, or `/api/me`; the Web frontend refreshes and sends this token
  automatically.
  When `OPEN_SCIENCE_PUBLIC_URL` is an HTTPS origin and security headers are
  enabled, responses also include `Strict-Transport-Security: max-age=31536000`.
  Production `/api/ready` fails if security headers are disabled, if dangerous
  hosted shell or approval escape hatches are enabled, or if production CORS
  origins are wildcard, invalid, local-development, non-HTTPS, or not exact
  origins.
  Production CSP restricts browser connections to the hosted origin so the
  frontend cannot reach browser-local services or a bare kernel instead of the
  server's own runtime routes. Development mode keeps
  localhost/WebSocket connect allowances for local debugging.
  Malformed cookie values are ignored during session lookup so authentication
  failures remain stable JSON responses instead of internal decode errors.
  Full approval mode, persistent permission approvals, and browser-direct shell
  proxying are disabled unless explicitly enabled by server environment
  variables. Disabled proxy actions are rejected before runtime startup when
  possible, so policy failures cannot be used to wake project runtimes. Host
  runtime shell proxying remains a separate escape hatch. The
  hosted Web composer shows this as a server-enforced approval policy instead
  of exposing browser-side full-access or direct-shell controls.
- The server applies in-memory rate limits for API requests by client address,
  stricter login-attempt limits, and per-user/project/command limits for command
  execution. Rate-limited responses use HTTP 429 and include `Retry-After`.
- `/api/health` reports process liveness, and `/api/ready` checks whether the
  data directory is a writable real directory rather than a symbolic link or
  file, configured static assets are readable, production auth is not
  accidentally left in development mode, local mode has at least one configured
  user, OIDC has valid HTTPS issuer/client/callback settings and separate
  non-placeholder client/flow secrets, production resource limits are valid and bounded, production
  backup/restore ownership is explicitly configured, and the selected runtime
  sandbox is viable. The
  Compose service uses `/api/ready` for its healthcheck. Static frontend assets
  are served without following symbolic links, and readiness fails if the
  configured static `index.html` is a symbolic link. The hosted Settings page
  displays the structured readiness checks, including non-200 not-ready
  responses, so pilot operators can see deployment-gate failures without
  opening server logs.
- `/api/metrics` reports a current-project resource snapshot for the signed-in
  user: project storage bytes/quota, task status counts, runtime status, and
  Node process memory/CPU/load data. It intentionally omits absolute filesystem
  paths and research file contents. Runtime status includes only sanitized
  metadata such as kind, sandbox mode, pid, container name, last event, stale
  flag, and timestamps. The hosted settings page displays this snapshot for
  operators and pilot users and exposes current-project runtime start, restart,
  and stop actions backed by the same server command API. Start/restart
  reconnect the browser client to the proxied runtime URL; stop detaches the
  browser client after the server runtime stops. The hosted live-session page
  uses the same server runtime bootstrap path when the runtime is stopped, so
  browser users are never directed to run or connect to a kernel process
  themselves. Log read APIs under
  `/api/logs/*` read only the
  latest `OPEN_SCIENCE_MAX_LOG_READ_BYTES` bytes across the current log and
  its `.1` rotation before applying the requested row limit; both files reject
  symbolic links. Operational JSONL logs
  (`audit.jsonl`, `tasks.jsonl`, `runtime.jsonl`, `debug.jsonl`,
  `provenance.jsonl`, server `security.jsonl`, and server `errors.jsonl`) rotate
  to a single `.1` file when the current file would exceed
  `OPEN_SCIENCE_MAX_LOG_FILE_BYTES`.
  The hosted settings page also shows recent project audit events,
  project-scoped API errors, and current-account authentication events. Runtime
  start, restart, and stop commands also write project audit actions
  (`runtime.start`, `runtime.restart`, `runtime.stop`) with sanitized lifecycle
  metadata only: command name, runtime action, kind, sandbox mode, running flag,
  and stale flag. These audit rows omit runtime URLs, passwords, browser
  credentials, request bodies, and host workspace paths. Use deployment log
  storage for full historical exports.
- `/api/ops/metrics` exposes low-cardinality Prometheus text metrics for
  deployment monitoring: readiness check state, process memory/CPU/load,
  active command count, task queue counts and queue limits, runtime counts,
  runtime proxy connection counts and limits, runtime limits, and static server
  configuration labels. It requires `Authorization: Bearer
  $OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` or
  `X-Open-Science-Operator-Token`. It is disabled when that token is unset in
  development; production readiness requires a non-placeholder token of at
  least 32 bytes. It intentionally does not expose workspace paths, file names,
  user names, or project IDs.
- Docker and Compose definitions are under `deploy/web`.

## Package Mirrors a Build Needs

Every image build fetches from Debian, npm, PyPI and GitHub. The Dockerfiles
and Compose take each source as a build argument, and the defaults are the
upstream ones — correct for a host that can reach them, and wrong for a host
that cannot. On the China-hosted production server, measured:

| Source | Direct | Set instead |
|---|---|---|
| Debian packages | `deb.debian.org` installs ~21 packages in 13 minutes | `OPEN_SCIENCE_APT_MIRROR=http://mirrors.aliyun.com/debian`, `OPEN_SCIENCE_DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security` |
| GitHub release assets (the uv binary and its licence) | **unreachable — 0 B/s** | `OPEN_SCIENCE_GITHUB_DOWNLOAD_PREFIX=https://ghfast.top/` (2.1 MB/s measured) |
| npm | slow | `OPEN_SCIENCE_NPM_REGISTRY=https://registry.npmmirror.com` |
| PyPI | slow | `OPEN_SCIENCE_PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple` |

These belong in the deployment's `.env`, which is where Compose reads them from
and where the production server already carries them. Build through Compose
(`docker compose --profile runtime-image build dsh-runtime-image`) rather than
invoking `docker build` directly: the forwarding is the part that is easy to
lose, and a build that silently falls back to an unreachable default fails
after several minutes on a `curl` timeout rather than at its first line.

The failure this documents cost two builds before it was written down: the
values existed only in the server's `.env`, and nothing in the repository said
which mirrors this deployment must use.

## Production Host Preflight

The target host must run Linux and Docker Engine 26 or newer. Before starting
Compose, build or pull the reviewed Web and Runtime images plus the exact Caddy
image, generate the release manifest, configure the selected local-auth or
OIDC identity secrets plus monitoring/backup secrets, and make the deployment
env file private. Then run:

```bash
stat -c '%g' /var/run/docker.sock
# Set that numeric output as OPEN_SCIENCE_DOCKER_SOCKET_GID in deploy/web/.env.
chmod 600 deploy/web/.env
pnpm preflight:host --env-file deploy/web/.env
```

The preflight rejects non-Linux hosts, Docker before version
26, missing Compose, insufficient Docker-root free space, non-private or
symlinked configuration, HTTP/mismatched Caddy domains, placeholder release
metadata, unpinned or wrong-architecture Web/Runtime/Caddy images, invalid
selected overlays, release-manifest/image drift, unsafe runtime escape hatches,
an absent Docker socket, a stale socket-group GID, insufficient group access,
an invalid host-only API diagnostic port, disabled Caddy proxy trust, and
invalid local-auth, OIDC, monitoring, or backup secret files. Local mode
fails preflight when the bootstrap password is present in the environment,
missing from its owner-only regular file, or reachable through a symbolic link.
When
`OPEN_SCIENCE_OBJECT_BACKUP_URI` is configured, it also creates a random
canary object, reads it back byte-for-byte, and deletes it. Set
`OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE=true` to make that off-host destination
mandatory for the production gate. The probe uses the standard AWS CLI
credential chain or workload identity and never prints the object URI. Install
the AWS CLI on the host that runs preflight, or set
`OPEN_SCIENCE_OBJECT_BACKUP_CLI` to an audited S3-compatible executable; run the
probe under the same workload identity used by scheduled backups.

After Compose is reachable through its real certificate and DNS route, run:

```bash
pnpm preflight:host --env-file deploy/web/.env --online
pnpm smoke:deployment
```

Online preflight verifies the frontend, TLS certificate, redirect boundary,
security headers, health/readiness, and release identity. With bundled monitoring
and `OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY=true`, it also sends a bounded
synthetic resolved Alertmanager webhook payload to the exact private receiver
configured by `pnpm configure:monitoring`; any timeout or non-2xx response fails
the gate. Deployment smoke then performs authenticated project, upload, preview,
runtime/SSE, and cleanup checks. These automated probes do not replace
filesystem-level project quotas, confirmation that a human escalation path
received the notification, or an operator-owned restore drill.

## Run Locally

```bash
export OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE="$PWD/.openscience-local/bootstrap-password.txt"
pnpm configure:local-auth

OPEN_SCIENCE_DATA_DIR=.openscience-web-data \
OPEN_SCIENCE_STATIC_DIR=apps/desktop/dist \
OPEN_SCIENCE_AUTH_MODE=local \
OPEN_SCIENCE_DEV_AUTH=false \
OPEN_SCIENCE_BOOTSTRAP_USER=admin \
node apps/server/src/index.mjs
```

The generated local-development password remains in the private file named by
`OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE`; the command does not print it.

Build the frontend first:

```bash
VITE_OPEN_SCIENCE_API_URL=http://127.0.0.1:8787/api \
pnpm --filter @ai4s/desktop build
```

When the frontend is served by the same Node server, `/api` is enough:

```bash
VITE_OPEN_SCIENCE_API_URL=/api pnpm --filter @ai4s/desktop build
```

Useful runtime controls:

```bash
NODE_ENV=production
OPEN_SCIENCE_PUBLIC_URL=https://science.example.com
OPEN_SCIENCE_AUTH_MODE=local
OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE=./secrets/bootstrap-password.txt
OPEN_SCIENCE_MAX_CONCURRENT_COMMANDS=8
OPEN_SCIENCE_MAX_CONCURRENT_TASKS=2
OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT=1
OPEN_SCIENCE_MAX_QUEUED_TASKS=100
OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT=25
OPEN_SCIENCE_MAX_RUNNING_RUNTIMES=8
OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER=4
OPEN_SCIENCE_COMMAND_TIMEOUT_MS=120000
OPEN_SCIENCE_SESSIONS_FILE=.openscience-web-data/.openscience/sessions.json
OPEN_SCIENCE_SESSION_TTL_MS=604800000
OPEN_SCIENCE_OPERATOR_METRICS_TOKEN=replace-with-at-least-32-random-bytes
OPEN_SCIENCE_MAX_JSON_BYTES=12582912
OPEN_SCIENCE_MAX_FILE_BYTES=52428800
OPEN_SCIENCE_PROXY_MAX_BODY_SIZE=73408512
OPEN_SCIENCE_MAX_PROJECT_BYTES=1073741824
OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES=10000
OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES=10000
OPEN_SCIENCE_MAX_ARCHIVE_BYTES=1073741824
OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES=10000
OPEN_SCIENCE_MAX_LOG_READ_BYTES=1048576
OPEN_SCIENCE_MAX_LOG_FILE_BYTES=10485760
OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES=1048576
OPEN_SCIENCE_KERNEL_TIMEOUT_MS=10000
OPEN_SCIENCE_MAX_CONCURRENT_KERNELS=2
OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER=1
OPEN_SCIENCE_CORS_ORIGINS=
OPEN_SCIENCE_RATE_LIMIT_WINDOW_MS=60000
OPEN_SCIENCE_RATE_LIMIT_MAX_REQUESTS=600
OPEN_SCIENCE_AUTH_RATE_LIMIT_WINDOW_MS=300000
OPEN_SCIENCE_AUTH_RATE_LIMIT_MAX_REQUESTS=20
OPEN_SCIENCE_COMMAND_RATE_LIMIT_WINDOW_MS=60000
OPEN_SCIENCE_COMMAND_RATE_LIMIT_MAX_REQUESTS=120
OPEN_SCIENCE_TRUST_PROXY=true
OPEN_SCIENCE_APP_VERSION=0.1.3
OPEN_SCIENCE_RELEASE_ID=replace-with-release-id
OPEN_SCIENCE_SOURCE_REVISION=replace-with-40-character-source-revision
OPEN_SCIENCE_BUILD_CREATED=replace-with-rfc3339-build-time
OPEN_SCIENCE_WEB_CONTAINER_IMAGE=open-science-web:0.1.3
OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE=./release-manifest.json
OPEN_SCIENCE_DATA_VOLUME=open-science-data
OPEN_SCIENCE_ENABLE_KERNEL=false
OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker
OPEN_SCIENCE_KERNEL_PYTHON_BIN=python3
OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL=false
OPEN_SCIENCE_DSH_VERSION=0.1.2-alpha.3
OPEN_SCIENCE_DSH_CORDIS_VERSION=4.0.2
OPEN_SCIENCE_SOCKET_VERSION=0.1.0
OPEN_SCIENCE_NODE_VERSION=22.22.0
OPEN_SCIENCE_PNPM_VERSION=11.7.0
OPEN_SCIENCE_UV_VERSION=0.11.26
OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS=30000
OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS=120000
OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS=1800000
OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS=30000
OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS=64
OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT=8
OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker
OPEN_SCIENCE_RUNTIME_CONTROLLER_MODE=socket
OPEN_SCIENCE_RUNTIME_CONTROLLER_SOCKET=/run/open-science-controller/controller.sock
OPEN_SCIENCE_RUNTIME_CONTROLLER_TIMEOUT_MS=10000
OPEN_SCIENCE_RUNTIME_CONTROLLER_POLL_MS=500
OPEN_SCIENCE_ALLOW_DIRECT_DOCKER_CONTROL=false
OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE=open-science-runtime:dsh-0.1.2-alpha.3-uv-0.11.26
OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL=true
OPEN_SCIENCE_RUNTIME_TRANSPORT=unix
OPEN_SCIENCE_RUNTIME_NETWORK_MODE=none
OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=false
OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=false
OPEN_SCIENCE_RUNTIME_CPU_LIMIT=2
OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT=4g
OPEN_SCIENCE_RUNTIME_PIDS_LIMIT=256
OPEN_SCIENCE_RUNTIME_NO_NEW_PRIVILEGES=true
OPEN_SCIENCE_RUNTIME_CAP_DROP=ALL
OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT=true
OPEN_SCIENCE_RUNTIME_TMPFS=/tmp:rw,nosuid,nodev,size=64m
OPEN_SCIENCE_RUNTIME_CONTAINER_USER=
OPEN_SCIENCE_RUNTIME_SKILL_DIRS=runtime/skills/core
OPEN_SCIENCE_ALLOW_RUNTIME_HOST_NETWORK=false
OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME=false
OPEN_SCIENCE_ALLOW_HOST_SHELL=false
OPEN_SCIENCE_ALLOW_DIRECT_SHELL=false
OPEN_SCIENCE_ALLOW_PERSISTENT_APPROVALS=false
OPEN_SCIENCE_ALLOW_FULL_APPROVAL=false
```

The Compose Web API service runs with a read-only root filesystem, all Linux
capabilities dropped, `no-new-privileges`, and a bounded non-executable `/tmp`
tmpfs controlled by `OPEN_SCIENCE_WEB_TMPFS_SIZE` (default `128m`). Its only
writable persistent mount is `/data`; backup and Runtime Controller mounts are
read-only.

When `NODE_ENV=production`, `/api/ready` fails unless
`OPEN_SCIENCE_PUBLIC_URL` is configured as an HTTPS origin such as
`https://science.example.com`; values with `http:`, paths, credentials, query
strings, or fragments are rejected. Production readiness also fails if
authentication resolves to `development`, and authenticated API routes reject
development auth with `dev_auth_enabled` instead of creating a shared dev user.
`OPEN_SCIENCE_DEV_AUTH` remains a legacy development/local selector when
`OPEN_SCIENCE_AUTH_MODE` is unset; deployments should set the explicit mode.
In local mode readiness fails until an existing user is present in
`OPEN_SCIENCE_USERS_FILE` or a bootstrap user can be created from
`OPEN_SCIENCE_BOOTSTRAP_USER` and `OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE`.
Production readiness rejects an environment-sourced bootstrap password; the
direct `OPEN_SCIENCE_BOOTSTRAP_PASSWORD` setting is retained only for
non-production compatibility and tests.
If that bootstrap account is later deleted through `DELETE /api/account`, the
file-backed user state records a deletion tombstone so the same bootstrap
identity does not reappear on the next restart; configure a new
bootstrap username or restore/create another login user before expecting
readiness to pass again.

## Production Local Authentication

Local password mode is intended only for a controlled single-node pilot. Keep
the password out of `deploy/web/.env`; that file should contain an empty
`OPEN_SCIENCE_BOOTSTRAP_PASSWORD` and the host path in
`OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE`.

```bash
pnpm configure:local-auth
pnpm check:local-auth

docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  --profile tls up -d
```

The configuration command creates a random password in an owner-only regular
file, refuses symbolic-link paths, and never prints the password. The Compose
overlay clears the direct password environment value and mounts the file at
`/run/secrets/bootstrap-password` with mode `0400`. Host preflight selects this
overlay automatically when `OPEN_SCIENCE_AUTH_MODE=local`.

Bootstrap input is consumed only while the user store has no login account.
Replacing the secret file later does not change an existing account password,
and the current local mode has no self-service password-reset endpoint. Record
the initial value in an operator-owned password manager before admitting users;
use OIDC for provider-managed MFA, recovery, and broader access. Deleting the
bootstrap account creates a tombstone, so recovery requires a deliberately new
bootstrap username or a controlled user-state restore rather than a restart.

## Production OIDC

Register this exact redirect URI with the identity provider:

```text
https://science.example.com/api/auth/oidc/callback
```

Set the non-secret identity-provider values in `deploy/web/.env`:

```bash
OPEN_SCIENCE_AUTH_MODE=oidc
OPEN_SCIENCE_OIDC_ISSUER=https://id.example.com/realms/research
OPEN_SCIENCE_OIDC_CLIENT_ID=open-science
OPEN_SCIENCE_OIDC_CLIENT_AUTH_METHOD=client_secret_basic
OPEN_SCIENCE_OIDC_SCOPES="openid profile email"
OPEN_SCIENCE_OIDC_LABEL="Research SSO"
OPEN_SCIENCE_OIDC_ALLOWED_GROUPS=researchers
OPEN_SCIENCE_OIDC_GROUP_CLAIM=groups
OPEN_SCIENCE_OIDC_ALLOWED_EMAIL_DOMAINS=example.edu
```

`OPEN_SCIENCE_OIDC_ALLOWED_GROUPS` and
`OPEN_SCIENCE_OIDC_ALLOWED_EMAIL_DOMAINS` are optional admission controls. A
configured group list requires at least one exact value in the configured ID
Token claim. A configured email-domain list requires `email_verified=true` and
an exact domain match; suffix matching is not used.

Generate owner-only Docker secret files without writing secret values to the
Compose environment file or command output:

```bash
OPEN_SCIENCE_OIDC_CLIENT_SECRET="$(pass show open-science/oidc-client)" \
pnpm configure:oidc

pnpm check:oidc
```

The command creates separate `oidc-client-secret.txt` and
`oidc-flow-secret.txt` files under `OPEN_SCIENCE_OIDC_SECRETS_DIR`. The flow
secret protects a short-lived AES-256-GCM correlation cookie and must not equal
the provider client secret. Existing files are not overwritten unless the
operator deliberately uses `pnpm configure:oidc -- --rotate`; rotation
invalidates only OIDC flows currently between redirect and callback.

Start with the OIDC overlay:

```bash
docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.oidc.yml \
  --profile tls up -d
```

For the public individual-account technical profile, add the fail-closed SaaS
overlay. It requires external backup ownership and completed restore-drill
acknowledgements, and `/api/ready` verifies the complete profile:

```bash
docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.oidc.yml \
  -f deploy/web/docker-compose.saas.yml \
  --profile tls up -d
```

The hosted Settings page reads `/api/auth/methods` and presents only the
configured SSO action in OIDC mode; the local username/password form and local
login endpoint are disabled. Application logout revokes the Open Science
session but does not promise to terminate the identity provider's browser-wide
SSO session because provider tokens are intentionally not retained.

For target-host smoke testing, sign in through the browser, provide only the
short-lived `os_session=...` cookie through
`OPEN_SCIENCE_SMOKE_SESSION_COOKIE_FILE`, and run `pnpm smoke:deployment`.
The smoke tool fetches the CSRF token from `/api/me`, never prints the cookie,
and rejects values that are not an exact Open Science session cookie. Remove
the temporary cookie file immediately after the run.

For real DSH runtimes, readiness fails unless host mode is explicitly
allowed or Docker mode has a reachable, release-matched Runtime Controller and
a configured runtime image. In production Docker runtime mode, any
`OPEN_SCIENCE_RUNTIME_NETWORK_MODE`
other than `none` requires both
`OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and
`OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true`. The first is the
technical opt-in; the second confirms that outbound filtering, network logging,
data-flow risk, and incident-response ownership have been reviewed. The
acknowledgement is a deployment gate, not a substitute for firewall/proxy
controls or network telemetry. Production Docker readiness also
verifies the configured runtime image with `docker image inspect`. For
production, the inspected image ID and the image's
`io.open-science.runtime.version` / `io.open-science.uv.version` labels must
match the mounted deployment release manifest; only checking that a tag exists
is not sufficient. Those two labels are deliberately kernel-neutral: the gate
used to read `io.open-science.opencode.version`, which a DSH image does not
publish, so readiness failed `runtime_image_metadata_missing` on every DSH
deployment — a check that could not survive the kernel it was gating. Set
`OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL=false` only if the deployment
deliberately relies on Docker lazy-pulling the image at runtime. Production
readiness rejects `OPEN_SCIENCE_RUNTIME_MODE=mock` unless
`OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true` is set for an explicit smoke test.
Readiness also fails in production when `OPEN_SCIENCE_ENABLE_KERNEL=true` would
execute Python through the host `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=host` path.
The host kernel path is for local development only. Production kernel execution
is supported only with `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker`: the server
runs Python in the reviewed runtime image, mounts only the selected project
workspace at `/workspace`, applies the same CPU, memory, PID, read-only root,
tmpfs, capability-drop, no-new-privileges, and optional container-user controls
as the agent runtime, and forces `--network none`. Readiness checks Docker
availability and, when `OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL=true`, the
configured runtime image; kernel `docker run` also uses `--pull never` in that
mode. The hosted frontend exposes Python-only notebook creation, cell execution,
and Stop controls through this server sandbox. It does not provision Jupyter or
expose R execution. `kernel_execute` validates the selected notebook inside the
project, mounts its selected workspace, runs from the notebook directory, and
`kernel_reset` aborts matching in-flight work. Stdout and stderr are independently
capped by `OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES` before they are returned or
stored in task output handling, and the child process is killed after
`OPEN_SCIENCE_KERNEL_TIMEOUT_MS` even when the outer command timeout is longer.
The Runtime Controller independently enforces
`OPEN_SCIENCE_MAX_CONCURRENT_KERNELS` and
`OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER`, including in-flight launches.
Before its Unix socket becomes available, it discovers all containers labelled
`open-science.web.kernel=true` and removes them; a cleanup failure prevents the
Controller from listening instead of leaving an unbounded kernel attached.

## Docker

```bash
cp deploy/web/.env.example deploy/web/.env
# edit deploy/web/.env, including public URL, non-secret identity settings,
# immutable release id, exact source revision, RFC3339 build time, and images
pnpm configure:local-auth
pnpm check:local-auth

docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  --profile runtime-image build

# Export the same release/image values to the manifest generator. It inspects
# the two built images and writes deploy/web/release-manifest.json.
export OPEN_SCIENCE_RELEASE_ID="2026.07.10-release.1"
export OPEN_SCIENCE_SOURCE_REVISION="$(git rev-parse HEAD)"
export OPEN_SCIENCE_BUILD_CREATED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
export OPEN_SCIENCE_WEB_CONTAINER_IMAGE="open-science-web:0.1.3"
export OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE="open-science-runtime:dsh-0.1.2-alpha.3-uv-0.11.26"
pnpm release:manifest
pnpm verify:release-manifest

docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  --profile tls up -d
```

The exported release values and `deploy/web/.env` must be identical. In a
release pipeline, derive both from one immutable release context rather than
maintaining two independent copies. `pnpm release:manifest` refuses placeholder
release IDs, non-SHA source revisions, invalid timestamps, unversioned or
`latest` image references, missing image IDs, symbolic-link skill/input files,
and undeclared manifest fields. It records the actual Web and runtime Docker
image IDs, exact DSH/uv and monitoring versions, the core skill-pack
digest/file count, and SHA-256 digests of the package lock, package/build
configuration, complete hosted frontend/server/SDK/shared source trees,
Dockerfiles, runtime socket launcher, Compose/Caddy configuration, and
monitoring configuration. Source-tree digests include sorted relative paths,
file sizes, and file digests, so content changes and file additions or removals
all invalidate the manifest; symbolic links are rejected.
`pnpm verify:release-manifest` recomputes those source/skill digests and
re-inspects both images. The generated file is intentionally ignored by version
control and mounted read-only at `/run/open-science/release-manifest.json`.
Production readiness fails if it is missing, invalid, or inconsistent with
service configuration; runtime/kernel launch policy also rejects missing or
mismatched provenance when readiness is bypassed.

The Docker image builds the hosted frontend with
`VITE_OPEN_SCIENCE_API_URL=/api` by default. Override the build arg only when
the static frontend and API are intentionally served from different origins.
The Compose file explicitly passes request-body, upload, log-read, queue-depth,
and runtime-count limits from `deploy/web/.env` into the Node service. The
bundled Caddy TLS profile also applies `OPEN_SCIENCE_PROXY_MAX_BODY_SIZE`
before requests reach Node; keep it at least
`ceil(OPEN_SCIENCE_MAX_FILE_BYTES * 1.4) + 8192` for browser/base64 uploads and
align every reverse proxy with host capacity before opening a public endpoint.
The base Compose file publishes the Node API diagnostic socket only as
`127.0.0.1:${OPEN_SCIENCE_API_PORT:-8787}:8787`; Caddy reaches
`open-science-web:8787` over the private Compose network. Keep this mapping on
loopback and enable `--profile tls` on every production startup so public
clients can enter only through ports 80/443 and Caddy's TLS/security boundary.
Do not add a wildcard or host-address API mapping. Host preflight validates
`OPEN_SCIENCE_API_PORT` as a TCP port; change it only to avoid a host-local port
collision.

For a real containerized DSH runtime, build or supply an image named by
`OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE`. The Compose file defaults to
`OPEN_SCIENCE_RUNTIME_MODE=kernel` and
`OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker`. `OPEN_SCIENCE_RUNTIME_MODE` takes
only `kernel` or `mock` now; a deployment still passing `opencode` is refused at
startup by name rather than starting with the value ignored. Only the unexposed
`open-science-runtime-controller` service mounts the host Docker socket. The Web
API mounts a read-only view of a separate control volume and calls the controller over
`/run/open-science-controller/controller.sock`; the controller mounts `/data`
read-only, publishes no port, drops Linux capabilities, and joins only the
numeric Docker-socket group verified by host preflight. This preserves access
to the explicitly mounted socket without restoring broad filesystem
capabilities. The controller creates all runtime and kernel launch arguments
from its own deployment configuration. Treat the
controller and Docker host as trusted infrastructure, and do not expose or
proxy the controller socket. By default, production readiness requires the
controller protocol/release identity and runtime capacity limits to match the
API, and requires the runtime image to already exist on the Docker host.
The named-volume isolation requires Docker Engine 26 or newer because that is
when [`volume-subpath`](https://docs.docker.com/engine/release-notes/26.0/) was
added to `docker run --mount`; readiness and runtime/kernel launch both reject
older or unparseable daemon versions when `OPEN_SCIENCE_RUNTIME_DATA_VOLUME` is
configured.
Compose gives the application data volume the stable
`OPEN_SCIENCE_DATA_VOLUME` name and passes it as
`OPEN_SCIENCE_RUNTIME_DATA_VOLUME`. Runtime and optional kernel containers mount
only the selected project's existing `volume-subpath`; they do not pass the API
container's `/data/...` path to the host daemon and do not mount another user's
project subtree.
For an existing Compose installation, set `OPEN_SCIENCE_DATA_VOLUME` to its
current volume name or migrate the stopped data volume before first startup;
silently accepting the new default would select an empty volume.

`OPEN_SCIENCE_RUNTIME_TRANSPORT=unix` starts the kernel on container loopback
and uses `socat` to expose it through
`runtime/container-runtime/control/dsh.sock` inside that project's runtime
subpath. The socket file carries the kernel's name on purpose: two kernels speak
different protocols, and a stale socket that still accepts connections is a
runtime that looks alive and answers nothing the caller understands. The API connects to that socket through its own data-volume mount, so a
sibling runtime is not addressed through the API container's `127.0.0.1` and no
runtime TCP port is published. Production readiness rejects an invalid named
volume or a volume-backed runtime configured with the TCP transport.
The runtime's named `internal: true` network can reach the Web service but has
no public route. Model calls and approved public research-source GET requests
therefore use separate authenticated Web gateways. The public-source gateway
accepts only HTTPS URLs on its exact official-host allowlist, rejects redirects
and caller-supplied headers, bounds time and response bytes, and reuses the
active runtime gateway token. Keep
`OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=false`; adding a source to the
catalog or mapping it to a Skill does not connect it through this gateway.
The repository includes a runtime image definition (`deploy/runtime-dsh/`) that
downloads the pinned Node and `uv` binaries for `linux/amd64` or `linux/arm64`,
installs the pinned DSH kernel from npm, and copies this repository's
`packages/socket` bundle in as the kernel's plugin composition. BuildKit supplies the target architecture, so a native ARM64 build cannot
silently fall back to AMD64 artifacts. Asset downloads use bounded
connection/low-speed timeouts, retry transient failures, and resume partial
release archives. The image verifies each archive against an
architecture-specific SHA-256 build argument before extraction, verifies the
selected uv MIT license text, and preserves those texts under
`/usr/share/licenses`. The npm install is additionally pinned in time by
`DSH_PUBLISHED_BEFORE`: `@deepseek-ai/dsh` declares its 61 subpackages as a caret
range, so naming an exact version pins one package and floats the rest — asking
the registry for the tree as it stood at that instant is the only way to install
what the pin was tested against. When changing any version, update every matching
archive and license digest in the same reviewed release change; a mismatched
asset fails the image build:

```bash
docker compose -f deploy/web/docker-compose.yml \
  --profile runtime-image \
  build dsh-runtime-image
```

Pre-pull or build the image before marking the service healthy, or set
`OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL=false` if your deployment policy
allows runtime lazy pulls. For local API smoke tests without a real agent image
or TLS endpoint, set `NODE_ENV=development`, `OPEN_SCIENCE_PUBLIC_URL` to the
local HTTP origin, `OPEN_SCIENCE_RUNTIME_MODE=mock`, and
`OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true` in `deploy/web/.env`.

After the service is running, execute the deployment smoke test from a trusted
operator machine. It validates `/api/health`, `/api/ready`, the readiness
security and observability sub-checks, protected `/api/ops/metrics`, login, CSRF,
project creation, file upload/read/preview/download, and can optionally exercise
the project-scoped Python kernel or start the runtime, verify proxied SSE, and
stop the runtime cleanly:

```bash
OPEN_SCIENCE_SMOKE_BASE_URL=https://science.example.com \
OPEN_SCIENCE_SMOKE_USERNAME=admin \
OPEN_SCIENCE_SMOKE_PASSWORD="$(pass show open-science/admin-password)" \
OPEN_SCIENCE_SMOKE_METRICS_TOKEN="$(pass show open-science/metrics-token)" \
pnpm smoke:deployment
```

To include runtime startup, proxied SSE, and runtime stop verification, set
`OPEN_SCIENCE_SMOKE_RUNTIME=true`. In production this should only be run after
the DSH runtime image has been built or pulled on the Docker host and the
runtime is using the intended transport and network policy. The default smoke
does not send a model prompt and therefore runs with `--network none`.

To verify the hosted Notebook path, set `OPEN_SCIENCE_SMOKE_KERNEL=true`. The
smoke creates a notebook below `smoke/`, executes Python from that notebook
directory, reads the uploaded input, writes a result back to the project volume,
and checks the persisted result. Set
`OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL=true` for production acceptance so a
host-kernel configuration cannot pass. The Linux `docker-hosted` CI job sets
both flags and verifies that no labelled kernel container remains afterward.
The smoke script requires
HTTPS for non-local targets unless `OPEN_SCIENCE_SMOKE_ALLOW_HTTP=true` is set
for a controlled development endpoint.

The runtime manager names containers as `open-science-...`, labels them with
`open-science.web.runtime=true`, removes previously attached stale containers
during server startup, and removes a stale same-project container before a new
runtime launch and on `stop_runtime`/`restart_runtime`. Server-start cleanup
records `startup_orphan_cleanup` or `startup_orphan_cleanup_failed` in the
selected project's runtime log; per-launch cleanup failures still stop startup
with `runtime_cleanup_failed` and record `cleanup_failed`. It also schedules an
idle stop after
`OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS` when no browser proxy request or SSE
stream is active, so abandoned project runtimes do not remain attached
indefinitely. Each attached runtime also gets a non-overlapping periodic project
usage scan controlled by `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS`;
over-quota runtimes are stopped, and scan failures stop the runtime with a
sanitized `quota_check_failed` event. When an active workspace changes, the
current project runtime is stopped, including an in-flight start once it
finishes. The next start recreates the container with the new workspace mounted at
`/workspace`. Under Compose this is a project-only named-volume subpath; a host-
launched API can still use a bind mount. Docker runtimes also set
`no-new-privileges`, drop
Linux capabilities by default, apply a pids limit, run with a read-only root
filesystem, provide a bounded tmpfs at `/tmp`, and reject `host` or
`container:*` networking unless
`OPEN_SCIENCE_ALLOW_RUNTIME_HOST_NETWORK=true`. In production, `bridge`,
custom, host, or shared-container Docker networks also require
`OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and
`OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true`. The supplied Compose and
Linux CI profiles use `OPEN_SCIENCE_RUNTIME_NETWORK_MODE=none`; HTTP/SSE remains
reachable over the Unix socket. Do not use the bridge escape hatch for untrusted
workloads until outbound destinations are restricted or independently logged.
The writable container paths
are the selected project workspace, `/runtime` for kernel state, and the
configured tmpfs. `OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS` bounds the
initial upstream connection. Non-streaming runtime responses are buffered
only up to `OPEN_SCIENCE_MAX_JSON_BYTES` and must complete within
`OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS`; SSE event streams remain
long-lived and are controlled by browser disconnects plus the runtime idle
timer. Browser-direct shell proxying to `/session/:id/shell` is
disabled unless `OPEN_SCIENCE_ALLOW_DIRECT_SHELL=true`; host-mode runtimes also
require `OPEN_SCIENCE_ALLOW_HOST_SHELL=true`, so direct shell cannot be enabled
by a browser-side UI change alone. `OPEN_SCIENCE_RUNTIME_CONTAINER_USER` can
run the runtime container as a non-root UID/GID after the mounted data volume
permissions have been verified for that identity.
The runtime image bakes its skill roots in at build time, so there is no
per-project copy step to disable. `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` is a
comma-separated allowlist of reviewed skill-pack directories, and it now feeds
only the release manifest's skill-pack digests — the record a deployment is
verified against. **Emptying it does not disable a deployment path; it blanks
those digests**, which is why the earlier instruction to clear it has been
removed rather than reworded. Do not add external skill packs to that list until
their hosted-use license and notices have been reviewed.

Host-mode runtime is for trusted development or explicitly accepted
single-host deployments only. When host mode is enabled, startup reads
`.openscience/runtime-state.json` and attempts to terminate a stale same-project
kernel PID only if the process command line still matches the configured kernel
command. This is a cleanup aid, not a replacement for a
container or worker sandbox.

## Data Backup and Restore

For the current single-node hosted slice, all durable server state is under
`OPEN_SCIENCE_DATA_DIR`. The recommended Compose profile runs the immutable Web
image as a separate backup service. Generate its owner-only secret, validate it,
and enable the overlay:

```bash
pnpm configure:backup
pnpm check:backup

docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  -f deploy/web/docker-compose.backup.yml \
  --profile backup --profile tls up -d
```

The API sees `/backups` read-only and never receives the passphrase. The backup
service sees `/data` read-only, `/backups` read-write, and the passphrase as a
mode-`0400` secret. It publishes no port, drops capabilities, uses a read-only
root filesystem, and records health in
`/backups/.open-science-backup-state.json`. API startup waits for the first
encrypted backup and restore drill to become healthy.

The scheduler runs every `OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS`, retries after
`OPEN_SCIENCE_BACKUP_RETRY_SECONDS`, and exits after
`OPEN_SCIENCE_BACKUP_MAX_FAILURES` consecutive failures so the container restart
policy and monitoring can surface the outage. It performs a disposable restore
drill every `OPEN_SCIENCE_BACKUP_RESTORE_DRILL_EVERY` successful backups. Size
`OPEN_SCIENCE_BACKUP_TMPFS_SIZE` above the largest decrypted archive and restore
working set; drill plaintext exists only in that container tmpfs.

The scripts can also be run manually before upgrades:

```bash
OPEN_SCIENCE_DATA_DIR=/var/lib/open-science \
OPEN_SCIENCE_BACKUP_DIR=/var/backups/open-science \
OPEN_SCIENCE_BACKUP_RETENTION_DAYS=30 \
scripts/ops/backup-data.sh
```

Production `/api/ready` treats backup ownership as a deployment gate. Use
`OPEN_SCIENCE_BACKUP_MODE=local` when this service runs the provided backup
script. In that mode, set an absolute `OPEN_SCIENCE_BACKUP_DIR` outside
`OPEN_SCIENCE_DATA_DIR`, a positive `OPEN_SCIENCE_BACKUP_RETENTION_DAYS`,
`OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK=true`, and
`OPEN_SCIENCE_RESTORE_DRILL_ACK=true` after the scheduler and restore drills are
owned. The backup overlay sets those two acknowledgements because it validates
the file-backed passphrase and drill before allowing API startup.
Use `OPEN_SCIENCE_BACKUP_MODE=external` only when platform/object-store backup
and restore drills are managed outside the service container; then set
`OPEN_SCIENCE_BACKUP_EXTERNAL_ACK=true` and
`OPEN_SCIENCE_RESTORE_DRILL_ACK=true`.

The backup script refuses data directories containing symbolic links and writes
both a `.tar.gz` archive and a `.sha256` checksum sidecar. When
`OPEN_SCIENCE_BACKUP_RETENTION_DAYS` is set, it also prunes local
`open-science-data-*.tar.gz` and `open-science-data-*.tar.gz.enc` archives older
than that many days, plus their checksum sidecars. The pruner refuses
symbolic-link backup directories and symbolic-link backup artifacts. Restore
into an empty target directory by default:

```bash
scripts/ops/restore-data.sh \
  /var/backups/open-science/open-science-data-YYYYMMDDTHHMMSSZ.tar.gz \
  /var/lib/open-science
```

Set `OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE` to an owner-only file, or provide
`OPEN_SCIENCE_BACKUP_PASSPHRASE` only to a trusted one-shot process, to produce an encrypted
`.tar.gz.enc` archive. The encryption path uses Node.js `aes-256-gcm` with a
scrypt-derived key, deletes the plaintext archive after encryption succeeds,
and writes the checksum for the encrypted file:

```bash
OPEN_SCIENCE_BACKUP_PASSPHRASE="$(pass show open-science/backup)" \
OPEN_SCIENCE_DATA_DIR=/var/lib/open-science \
OPEN_SCIENCE_BACKUP_DIR=/var/backups/open-science \
OPEN_SCIENCE_BACKUP_RETENTION_DAYS=30 \
scripts/ops/backup-data.sh

OPEN_SCIENCE_BACKUP_PASSPHRASE="$(pass show open-science/backup)" \
scripts/ops/restore-data.sh \
  /var/backups/open-science/open-science-data-YYYYMMDDTHHMMSSZ.tar.gz.enc \
  /var/lib/open-science
```

Encrypted archive/checksum pairs can be copied to S3-compatible object storage.
`object-backup.mjs` defaults to the `aws` executable; override only its executable
path with `OPEN_SCIENCE_OBJECT_BACKUP_CLI`. Supply credentials through the CLI's
standard credential chain, workload identity, or an owner-only process
environment. Credentials, signed query strings, and userinfo are forbidden in
the `s3://` URI and are never added to command arguments by this tool.

Set `OPEN_SCIENCE_OBJECT_BACKUP_URI` to make `backup-data.sh` upload the newly
created archive and `.sha256` sidecar after local verification:

```bash
OPEN_SCIENCE_BACKUP_PASSPHRASE="$(pass show open-science/backup)" \
OPEN_SCIENCE_OBJECT_BACKUP_URI=s3://research-backups/open-science/production \
OPEN_SCIENCE_OBJECT_BACKUP_SSE=aws:kms \
OPEN_SCIENCE_OBJECT_BACKUP_KMS_KEY_ID="$(pass show open-science/backup-kms-key-id)" \
scripts/ops/backup-data.sh /var/lib/open-science /var/backups/open-science
```

The object tool rejects plaintext archives by default, validates every URI/key
segment, refuses symbolic-link/non-regular local artifacts, verifies SHA-256
before upload and after download, caps CLI output, and invokes the CLI with an
argument array rather than a shell. `AES256` and `aws:kms` server-side encryption
flags are supported in addition to the required client-side encrypted archive.
Configure bucket versioning/object lock and lifecycle retention in the object
store; the local retention pruner does not delete remote objects.

Download into an operator-only directory, then use the normal restore or restore
drill so archive traversal/symlink checks still run:

```bash
pnpm restore:object -- \
  s3://research-backups/open-science/production/open-science-data-YYYYMMDDTHHMMSSZ.tar.gz.enc \
  /var/backups/open-science/downloaded

OPEN_SCIENCE_BACKUP_PASSPHRASE="$(pass show open-science/backup)" \
scripts/ops/restore-drill.sh \
  /var/backups/open-science/downloaded/open-science-data-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

The supplied Compose scheduler provides timing, retries, health, encrypted
archive creation, local retention, optional object upload, and restore drills.
The operator still owns workload identity, bucket policy and object lock,
off-host lifecycle, alert routing, and passphrase escrow.

Run restore drills on a schedule without touching production data. The drill
restores into a temporary directory, relies on the same checksum/decryption and
archive-safety checks as normal restore, then deletes the temporary copy:

```bash
OPEN_SCIENCE_BACKUP_PASSPHRASE="$(pass show open-science/backup)" \
OPEN_SCIENCE_RESTORE_DRILL_DIR=/var/tmp/open-science-restore-drills \
scripts/ops/restore-drill.sh \
  /var/backups/open-science/open-science-data-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

To replace an existing non-empty target, stop the Web service first and opt in
explicitly:

```bash
OPEN_SCIENCE_RESTORE_REPLACE=true \
scripts/ops/restore-data.sh BACKUP_ARCHIVE /var/lib/open-science
```

The restore script verifies the checksum when present, decrypts encrypted
archives only after checksum verification, and rejects archive entries with
absolute paths, traversal segments, or symbolic links. These scripts are a
file-volume recovery path for controlled deployments; production operators
still need to enable the off-host workflow (or an equivalent platform backup),
passphrase custody, and access controls appropriate to their data policy.

To move `OPEN_SCIENCE_DATA_DIR` to a new local path or mounted volume, stop the
Web service first, run the migration against an empty target, then point
`OPEN_SCIENCE_DATA_DIR`, `OPEN_SCIENCE_USERS_FILE`, and
`OPEN_SCIENCE_SESSIONS_FILE` at the new location:

```bash
pnpm migrate:data /var/lib/open-science /mnt/open-science-data
```

The migration script refuses symbolic links in either tree, rejects source and
target path overlap, copies into a temporary directory, verifies the migrated
copy with `diff -qr`, then atomically moves it into place. Existing non-empty
targets are rejected unless the operator has stopped the service and explicitly
opts in:

```bash
OPEN_SCIENCE_MIGRATE_REPLACE=true \
pnpm migrate:data /var/lib/open-science /mnt/open-science-data
```

For TLS through Caddy:

```bash
OPEN_SCIENCE_DOMAIN=science.example.com \
OPEN_SCIENCE_CADDY_VERSION=2.11.4-alpine \
OPEN_SCIENCE_PUBLIC_URL=https://science.example.com \
docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  --profile tls up --build
```

When raising upload limits in the Caddy profile, raise
`OPEN_SCIENCE_PROXY_MAX_BODY_SIZE` with `OPEN_SCIENCE_MAX_FILE_BYTES`; the
default `73408512` supports the default 50 MiB decoded file limit plus the JSON
base64 envelope.

## Important Boundaries

- Database-backed users, projects, provider keys, and task history are still
  deferred. The current hosted slice uses file-backed `users.json`, a
  file-backed hashed session index, and an in-process task queue with
  file-backed task state; the default user/session state paths reject symbolic
  links and use temporary-file writes before atomic rename. Deleted file-backed
  users are retained as non-secret tombstones to prevent accidental bootstrap
  recreation. This is enough for a controlled MVP, but should be moved behind a
  real identity provider and durable queue before broad public multi-tenant use.
- Hosted privacy, retention, and license readiness are separate go-live gates.
  In particular, do not redistribute bundled third-party skills or runtime
  images until their exact licenses and notices are verified. See
  [`WEB_PRIVACY_AND_COMPLIANCE.md`](./WEB_PRIVACY_AND_COMPLIANCE.md).
- Project isolation is selected by the frontend through `X-Open-Science-Project`.
  Workspaces and runtime roots stay under the authenticated user's data root.
  File APIs scope `root=base` to the current project's workspace root, not to
  every project owned by that user. Non-default projects must be created with
  `POST /api/projects` before commands, file APIs, or the runtime routes can
  use them. `OPEN_SCIENCE_DATA_DIR`, user roots, per-user project containers,
  project roots, project metadata files, project JSONL logs, task/runtime state
  files, active workspace directories, and hosted file APIs do not follow
  symbolic links, including during artifact auto-resolution and notebook
  discovery.
- Container runtime launch is implemented as a Docker sandbox plan with a
  repository runtime-image Dockerfile, but it still requires building or pulling
  the runtime image on a Docker-capable deployment host. Server
  kernels are disabled by default with `OPEN_SCIENCE_ENABLE_KERNEL=false`.
  Host Python kernels are blocked by `/api/ready` and `kernel_execute` in
  production. If kernels are enabled for a controlled deployment, use
  `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker`; Docker kernels reuse the runtime
  image/resource controls, run with `--network none`, and cap stdout/stderr with
  `OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES`; each kernel child is also killed after
  `OPEN_SCIENCE_KERNEL_TIMEOUT_MS`. Keep the Controller kernel concurrency
  limits within reviewed host capacity; Controller startup removes labelled
  kernel orphans and fails closed if removal does not succeed.
- Real model use requires configuring a server-managed kernel profile and key
  storage. The hosted Settings UI hides provider key, OAuth, custom endpoint,
  and provider-removal controls until encrypted server-side key management is
  implemented. In hosted mode it also treats MCP/Jupyter tooling as
  deployment-managed: users can see sanitized server-managed MCP status, but
  browser-side provisioning/removal controls and local command strings are not
  exposed. The hosted Skills page likewise treats skills as deployment-managed:
  users can inspect the runtime catalog, but cannot install custom skills or
  trigger local tool detection from the browser or command API. The mock runtime is only for
  UI/API verification and is rejected in production unless explicitly allowed
  for a smoke test.
- Back up the `OPEN_SCIENCE_DATA_DIR` volume with `scripts/ops/backup-data.sh`
  or an equivalent encrypted off-host backup process; it contains workspaces,
  provenance, project audit logs, task logs, task state indexes, runtime logs,
  security audit logs, server error logs, and runtime state. The runtime state
  file intentionally omits runtime URLs, passwords, absolute paths, browser
  credentials, and request bodies. Runtime lifecycle audit rows use the same
  privacy boundary and store lifecycle metadata only, not runtime connection
  secrets or host paths.
- Run `pnpm audit:hosted-compliance` before publishing a hosted image or
  changing `OPEN_SCIENCE_RUNTIME_SKILL_DIRS`. The audit verifies the default Web
  image excludes external skills, runtime tool versions are pinned, required
  privacy/license docs exist, and configured runtime skill directories do not
  include locally detected restrictive license files.
- Treat runtime proxy logs as operational metadata only: they include sanitized
  route patterns, status/duration fields, and request/response byte counts, not
  auth headers, cookies, `auth_token` query values, workspace `directory` paths,
  prompts, request bodies, or response bodies. Runtime response headers are not
  treated as trusted browser headers; cookies, auth challenges, hop-by-hop
  headers, and direct runtime redirects are stripped or rewritten by the proxy.
  Built-in log APIs are intentionally bounded tail readers, not full archive
  readers. Uploaded or generated HTML previews are embedded by the
  hosted frontend without `allow-scripts`, so browser-side fallback rendering
  does not re-enable script execution when the server CSP is not the only
  active boundary. Browser file actions download directly through
  `/api/files/download` with the selected project context rather than invoking
  local OS file openers or buffering files in frontend memory.
- Runtime proxy write requests are bounded by `OPEN_SCIENCE_MAX_JSON_BYTES`,
  the same size guard used for non-upload command and task JSON APIs. Browser
  upload bodies and the `upload_file` command are bounded by a JSON envelope
  limit derived from `OPEN_SCIENCE_MAX_FILE_BYTES`; this includes queued
  `upload_file` tasks and uploads targeting either `workspace` or `base` roots.
  These write routes resolve the authenticated user/project context before
  reading upload-sized request bodies. Uploads are then checked again against
  the decoded file size and project quota. Workspace directory listings,
  artifact auto-resolution, and notebook discovery are bounded by
  `OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES` to prevent unbounded file-count
  scans. Project and account archive exports are bounded by
  `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` and `OPEN_SCIENCE_MAX_ARCHIVE_BYTES`;
  they return `archive_too_large` before streaming a tarball when the scoped
  export would collect too many entries or too many uncompressed file bytes.
  Project quota usage scans are separately bounded by
  `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES`; writes, runtime startup, and
  post-runtime quota checks return `project_scan_too_large` if a project tree
  is too large to scan within that guard. `/api/metrics` still responds in that
  case with `project.storage.scanLimited=true`.
  In the bundled Caddy profile, `OPEN_SCIENCE_PROXY_MAX_BODY_SIZE` is the outer
  body limit and defaults to `73408512`, enough for the default 50 MiB decoded
  upload limit plus the JSON base64 envelope. Increase either service-side
  limit only alongside reverse-proxy body limits and monitoring.
- Non-streaming runtime proxy responses are also capped by
  `OPEN_SCIENCE_MAX_JSON_BYTES` and
  `OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS`, so a stalled or oversized
  upstream kernel JSON response returns a structured proxy error instead of
  holding an API worker connection indefinitely. SSE responses are excluded from
  this request timeout and remain controlled by connection close, proxy
  connection limits, and the runtime idle timer.
- `OPEN_SCIENCE_MAX_PROJECT_BYTES` is enforced for browser/API writes and as a
  runtime quota guard before startup, after proxied runtime requests, and on a
  periodic timer while each runtime remains attached.
  `kernel_execute` also rechecks project usage after host or Docker execution
  before returning success. These quota scans are capped by
  `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES` to keep high-file-count project
  trees from tying up the API process. Periodic runtime scans fail closed when
  this bound is exceeded, but this is still not a kernel-level filesystem quota
  for container writes; production worker hosts should still use volume
  quotas, project-specific filesystems, or an equivalent storage controller to
  hard-stop single-request disk exhaustion.
- The built-in rate limiter is per-process memory. Keep it for the MVP, but add
  reverse-proxy or gateway limits before horizontally scaling the API. The
  bundled production profile requires `OPEN_SCIENCE_TRUST_PROXY=true`; Caddy
  replaces any incoming `X-Forwarded-For` value with its observed remote IP,
  and Node accepts only a valid IPv4 or IPv6 value for the per-client limit key.
  Custom proxies must provide the same overwrite guarantee. Keep the API port
  unreachable to public clients and treat host-loopback diagnostics as a trusted
  operator path.
- Production readiness rejects invalid or disabled resource controls for upload
  size, project quota, workspace/archive/log scan bounds, API/auth/command rate
  limits, command/task/runtime-proxy timeouts, task queue depth, active task
  limits, runtime proxy connection limits, the runtime quota-monitor interval,
  attached-runtime limits, and Docker runtime CPU/memory/pids limits. It also rejects obvious inconsistencies such as
  `OPEN_SCIENCE_MAX_FILE_BYTES` exceeding `OPEN_SCIENCE_MAX_PROJECT_BYTES`.
- Production readiness rejects missing backup ownership. Local backups must use
  an absolute backup directory outside `OPEN_SCIENCE_DATA_DIR`, positive
  retention days, encrypted archives, and restore-drill acknowledgement;
  externally managed backups require explicit external-backup and restore-drill
  acknowledgements.
- CORS is exact-origin allowlisted. With no `OPEN_SCIENCE_CORS_ORIGINS`,
  development mode allows localhost frontends and production mode only allows
  the origin from `OPEN_SCIENCE_PUBLIC_URL`. If static assets and API are split
  across domains, set `OPEN_SCIENCE_CORS_ORIGINS` to the frontend origin list;
  do not use a wildcard with cookie sessions. In production, each entry must be
  an exact HTTPS origin such as `https://app.example.com`; entries with paths,
  trailing slashes, `http://`, `localhost`, `null`, or `*` are readiness
  failures.
- The built-in metrics endpoint is request/response only. For production
  operations, scrape `/api/ops/metrics` with a deployment-owned bearer token and
  connect it to monitoring retention, alerts, and dashboards that do not ingest
  research file contents. In addition to readiness/process/task/runtime gauges,
  the endpoint emits counters by normalized route/method/status/error code and
  route-level request-duration histograms. Concrete project IDs, file paths,
  query strings, bodies, prompts, users, and credentials are not metric labels.
  Production `/api/ready` rejects a missing, shorter than 32-byte,
  whitespace-padded, obvious placeholder, conflicting token source, unreadable
  token file, or symbolic-link token file. Configure exactly one of
  `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` and
  `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE`; the deployment smoke test accepts
  `OPEN_SCIENCE_SMOKE_METRICS_TOKEN_FILE` as well as a direct smoke token.

### Bundled monitoring profile

`deploy/web/docker-compose.monitoring.yml` adds version-pinned Prometheus,
Blackbox Exporter, Alertmanager, and Grafana services. Prometheus scrapes the
protected metrics endpoint, probes `/api/health` and `/api/ready`, evaluates the
rules in `deploy/web/monitoring/open-science.rules.json`, and sends alerts to an
operator-owned Alertmanager webhook. Grafana provisions the
`Open Science Operations` dashboard. Prometheus, Alertmanager, and Grafana
consoles bind to `127.0.0.1` by default; expose them only through an authenticated
operator path such as a VPN or SSH tunnel.

Generate the Compose secret files without storing the Grafana password or alert
webhook URL in `deploy/web/.env`:

```bash
export OPEN_SCIENCE_OPERATOR_METRICS_TOKEN="$(openssl rand -base64 48)"
read -rsp "Grafana admin password: " OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD; echo
export OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD
read -rsp "HTTPS Alertmanager webhook URL: " OPEN_SCIENCE_ALERT_WEBHOOK_URL; echo
export OPEN_SCIENCE_ALERT_WEBHOOK_URL
pnpm configure:monitoring
unset OPEN_SCIENCE_OPERATOR_METRICS_TOKEN \
  OPEN_SCIENCE_GRAFANA_ADMIN_PASSWORD OPEN_SCIENCE_ALERT_WEBHOOK_URL
pnpm check:monitoring
```

The generator creates only owner-readable files under
`OPEN_SCIENCE_MONITORING_SECRETS_DIR` (default
`deploy/web/secrets`, ignored by version control). It refuses symbolic-link
directories/files, weak or placeholder secrets, non-HTTPS/local webhooks, and
group/world-readable files during validation. Start the base and monitoring
stacks together:

```bash
docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.local-auth.yml \
  -f deploy/web/docker-compose.monitoring.yml \
  --profile monitoring --profile tls up -d
```

The examples above use local identity. For OIDC, replace
`docker-compose.local-auth.yml` with `docker-compose.oidc.yml`; never load both
identity overlays in the same Compose invocation. Add
`docker-compose.saas.yml` only for an individual-account public profile after
the external recovery and target-host evidence exists.

The default alert set covers metrics loss, health/readiness failure, readiness
sub-checks, sustained API errors, high error ratio, rate-limit pressure, task
queue saturation, runtime capacity, and missing runtime quota monitors. See
`docs/WEB_OPERATIONS_RUNBOOK.md` for response and rotation procedures. The
bundled profile is a single-host baseline, not an independent external monitor:
for public service, send alerts and retained telemetry off-host and add an
outside-in probe that survives total host/network loss.

Example Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: open-science-web
    metrics_path: /api/ops/metrics
    scheme: https
    static_configs:
      - targets: ["science.example.com"]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/open_science_metrics_token
```

## Verification

Local checks:

```bash
CI=true pnpm ci:web
pnpm audit:hosted-compliance
pnpm check:local-auth
OPEN_SCIENCE_SMOKE_BASE_URL=https://science.example.com \
OPEN_SCIENCE_SMOKE_USERNAME=admin \
OPEN_SCIENCE_SMOKE_PASSWORD="$(pass show open-science/admin-password)" \
pnpm smoke:deployment
CI=true pnpm --filter @ai4s/server test
pnpm --filter @ai4s/server test:e2e
pnpm --filter @ai4s/desktop typecheck
CI=true pnpm --filter @ai4s/desktop test
CI=true VITE_OPEN_SCIENCE_API_URL=/api pnpm --filter @ai4s/desktop build
cd apps/desktop/src-tauri && cargo check
```

Root-level shortcuts:

```bash
pnpm test:web
pnpm test:web:e2e
pnpm ci:web
pnpm check:tauri
```

`.github/workflows/web.yml` runs the hosted API tests, frontend typecheck,
frontend tests, hosted frontend build, and a Tauri backend compile check on
pull requests, pushes to `main`/`master`, and manual dispatch. Its dependent
`docker-hosted` job also builds both release-labelled images on Linux, generates
and verifies the deployment manifest from actual image IDs, starts the API and
monitoring Compose profiles, exercises the real hosted DSH connection
boundary and project-scoped Docker Python kernel with deployment smoke, verifies
runtime and kernel cleanup, and tears down the stack. This complements but does
not replace target-host TLS, storage, network, backup, and external
alert-delivery verification.
