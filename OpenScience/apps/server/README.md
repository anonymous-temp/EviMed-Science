# Open Science Web API

This package is the server-side runtime boundary for hosted web deployments.
It uses the pinned, OpenID-certified `openid-client` package for production
OIDC and otherwise keeps the hosted boundary independent of a database, durable
queue, or model-provider setup.
See `../../docs/WEB_PRIVACY_AND_COMPLIANCE.md` for the hosted data, privacy,
retention, and third-party license checklist.

Implemented in this slice:

- `POST /api/commands/:command` with an allowlist and consistent `{ data }` /
  `{ error, code }` envelopes. Malformed percent-encoded route parameters are
  rejected with stable `400 invalid_encoding` JSON responses instead of leaking
  internal decode errors.
- Explicit development, local-password, and OIDC authentication modes. Set
  `OPEN_SCIENCE_AUTH_MODE=local` to require `/api/auth/login`; the first
  file-backed user can be bootstrapped with `OPEN_SCIENCE_BOOTSTRAP_USER` and
  an `OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE`. The production Compose path mounts
  that owner-only, no-follow file through `docker-compose.local-auth.yml`, and
  production readiness rejects a bootstrap password sourced directly from the
  process environment. `pnpm configure:local-auth` creates the file without
  printing its value. Set `OPEN_SCIENCE_AUTH_MODE=oidc` to use
  Authorization Code with PKCE, state/nonce/ID Token validation, optional exact
  group or verified email-domain admission, encrypted short-lived flow state,
  and a stable hashed external identity mapping. Provider tokens and raw
  identity subjects are not persisted. Session indexes are file-backed under
  `OPEN_SCIENCE_SESSIONS_FILE` by default, store only hashed session IDs, and
  survive server restarts. `OPEN_SCIENCE_SESSION_TTL_MS` controls the server
  session expiry and browser cookie `Max-Age`; production readiness rejects
  invalid TTL values. The configured `OPEN_SCIENCE_DATA_DIR` itself must be a
  real directory, not a symbolic link or file; the default `users.json` and
  session index paths under it also reject symbolic links and are written
  through temporary files before atomic rename. In local and OIDC modes, mutating cookie-backed
  APIs also require the `X-Open-Science-CSRF` token returned by
  `/api/auth/login` or `/api/me`. Under `NODE_ENV=production`, development auth
  is rejected by both `/api/ready` and authenticated API routes. Malformed
  cookie values are ignored during session lookup so authentication failures
  remain stable JSON responses.
- User/project-scoped workspaces under `OPEN_SCIENCE_DATA_DIR`.
- Project listing and creation through `/api/projects`; project isolation then
  uses `X-Open-Science-Project` or `projectId=...`. User roots, per-user
  project containers, project roots, project metadata files, and active
  workspace directories reject symbolic links so a polluted data volume cannot
  redirect work outside its user-owned tree.
- Current-account export and deletion are available through `/api/account/export`
  and `DELETE /api/account`. Account exports contain scoped user/project data
  plus non-secret `account.json` metadata; they omit password hashes, sessions,
  CSRF tokens, and host paths. Account deletion requires exact user id
  confirmation, requires the current password in login mode, rejects queued or
  running tasks, stops the user's attached runtimes, revokes sessions, removes
  the user root, and records a tombstone so deleted bootstrap users are not
  recreated on restart.
- Each project stores its active workspace folder in `project.json`, so
  `set_workspace` and `new_dated_workspace` survive server restarts without
  exposing host absolute paths. Successful workspace changes stop the selected
  project's attached or starting runtime so the next start or proxy request is
  bound to the newly selected folder.
- Path traversal protection for all workspace file commands.
- Current-project `root=base` scoping, so one project cannot use the base tree
  to read or write a sibling project.
- File upload, preview, download, directory listing, notebook listing, and
  provenance JSONL storage, with per-project storage quota checks. Uploads
  accept nested project-relative paths such as `inputs/raw.csv`, but reject
  absolute paths, `..` traversal, empty segments, and oversized payloads.
  Provenance records are versioned per workspace-relative artifact path; large
  recorded content is capped, and the provenance JSONL rotates with
  `OPEN_SCIENCE_MAX_LOG_FILE_BYTES`.
  Project quota usage scans are bounded by
  `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES` and return
  `project_scan_too_large` when a project tree is too large to scan safely.
  Project and account archive exports are bounded by both
  `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES` and `OPEN_SCIENCE_MAX_ARCHIVE_BYTES` before
  tarball streaming starts.
  Hosted file APIs also reject symbolic links inside workspaces, skip symbolic
  links during directory listing/artifact resolution/notebook listing, and
  return stable JSON 404 errors for missing files or directories instead of
  surfacing filesystem exceptions. Linux workspace I/O pins each directory and
  file with `O_NOFOLLOW` descriptors, uses descriptor-relative atomic writes,
  and bounds archive streams to the collected file size so concurrent runtime
  path replacement cannot redirect API reads or writes outside the project.
  Capacity checks and mutations are serialized per project inside one API
  process. Multiple API replicas require distributed coordination or
  per-project routing.
  Upload request JSON envelopes are sized from `OPEN_SCIENCE_MAX_FILE_BYTES`
  so browser/base64 uploads can reach the actual decoded file-size check. This
  applies to direct browser uploads, `upload_file`, and queued `upload_file`
  tasks; non-upload command and task JSON APIs remain bounded by
  `OPEN_SCIENCE_MAX_JSON_BYTES`. Mutating command, task, and direct upload
  routes validate the authenticated user/project context before reading
  upload-sized request bodies.
  Preview responses use `Cache-Control: no-store` and a sandboxed
  file-preview CSP that disables scripts, network connections, forms, object
  embeds, and base-URI changes. The hosted frontend also renders HTML previews
  in an iframe without script permission and uses the authenticated download
  endpoint instead of desktop `open_path` or frontend Blob buffering. Downloads
  are served as attachments with sanitized filenames.
- Server-side OpenCode runtime management, status, graceful stop, and HTTP/SSE
  proxying. Production auth mode refuses unsandboxed host OpenCode startup by
  default; set `OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker` to use the container
  launch plan, or explicitly opt into host mode with
  `OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME=true`. Production Compose uses an
  isolated Runtime Controller. The Web
  API has no Docker socket; it connects to a mode-`0600` controller Unix socket,
  while the unexposed controller validates canonical user/project identifiers
  and reconstructs fixed image, mount, network, resource, and command arguments
  from server configuration. Arbitrary Docker commands are not part of the
  protocol. Protocol v2 requires API/Controller runtime-capacity limits to
  match; the Controller independently discovers labelled Docker runtimes,
  reserves in-flight starts, enforces global/per-user limits, and serializes
  lifecycle operations for each project. Production readiness plus
  runtime/kernel launch reject direct Docker control by default. Docker
  runtimes use deterministic per-project container names and labels. Server startup scans
  stored project runtime state and removes previously attached Docker containers
  before accepting traffic; per-project runtime launches also clean matching
  stale containers before startup, report true launch cleanup failures as
  `runtime_cleanup_failed` plus `cleanup_failed` runtime log rows, and can be
  replaced through `restart_runtime`.
  They also set `no-new-privileges`, drop Linux capabilities by default, apply
  a pids limit, run with a read-only container root filesystem plus a bounded
  tmpfs, and reject host/shared-container networking unless explicitly enabled.
  In production, any runtime network other than `none` requires both
  `OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and the separate
  `OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true` operator confirmation.
  The supplied Compose profile uses a stable `OPEN_SCIENCE_DATA_VOLUME`, mounts
  only the active project's `volume-subpath` into sibling runtime/kernel
  containers, and defaults to `OPEN_SCIENCE_RUNTIME_TRANSPORT=unix` plus
  `OPEN_SCIENCE_RUNTIME_NETWORK_MODE=none`. OpenCode listens on container
  loopback and HTTP/SSE is relayed through a project-scoped Unix socket, so no
  runtime port or API-container localhost assumption is required.
  Docker runtime proxy requests inject the container-visible `/workspace`
  directory, while explicit host and mock runtimes use the server workspace path.
  Active runtime proxy requests and SSE streams are capped globally and per
  project by `OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS` and
  `OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT`.
  Every attached runtime also gets a project usage monitor controlled by
  `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS`. It stops the runtime when the
  workspace exceeds `OPEN_SCIENCE_MAX_PROJECT_BYTES`, and fails closed with a
  `quota_check_failed` event when usage cannot be scanned safely.
  Explicit host-mode runtimes also attempt conservative stale PID cleanup from
  the same project's runtime state before startup, but Docker remains the
  recommended hosted sandbox. Each project also gets
  `.openscience/runtime-state.json` with sanitized runtime status metadata;
  after a server restart, mock/uncleaned states are reported as stale while
  successfully cleaned Docker orphans are marked `orphan_cleanup`, without
  exposing runtime URLs, passwords, or host paths. Runtime state and
  runtime-event files reject symbolic links.
- Async task API under `/api/tasks` for queueing command work, checking status,
  canceling queued/running tasks, applying command timeouts, and passing an
  `AbortSignal` into interruptible command handlers. The execution queue is
  in-process and enforces both global and per-project concurrency limits, while
  each project gets a file-backed task index at `.openscience/tasks-state.json`
  plus task events in `.openscience/tasks.jsonl`.
  On restart, completed task records remain visible and unfinished records are
  marked failed with `server_restarted` instead of being re-executed. Task
  state and task-event files reject symbolic links.
- Optional hosted `kernel_execute` returns `{ ok, stdout, stderr, artifacts }`
  for Python. Host execution remains development-only; production requires the
  Runtime Controller Docker sandbox, which mounts only the selected project,
  forces network isolation, applies runtime CPU/memory/PID controls, caps
  output and lifetime, independently limits global/per-user kernel concurrency,
  and removes labelled orphan kernels before the Controller starts listening.
  Hosted Python notebooks preserve the selected historical workspace and
  notebook directory; `kernel_reset` aborts matching in-flight executions.
  Jupyter provisioning and R kernels remain deferred.
- Scoped observability endpoints under `/api/logs/audit`, `/api/logs/tasks`,
  `/api/logs/runtime`, `/api/logs/errors`, and `/api/metrics`. The metrics
  endpoint reports the current project's storage/quota, task status counts, runtime status, and
  server process resource data without exposing absolute filesystem paths; if
  the storage scan exceeds `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES`, it
  reports `project.storage.scanLimited=true`. Log
  read APIs cap file reads to the latest `OPEN_SCIENCE_MAX_LOG_READ_BYTES`
  bytes before applying the requested row limit, so long-lived JSONL logs are
  not loaded fully into memory for each request.
  Runtime logs include sanitized OpenCode proxy method, route pattern, status,
  duration, streaming flag, and policy error code without browser credentials,
  query secrets, or workspace paths. The proxy strips browser credentials before
  forwarding requests, strips runtime cookies/challenges/hop-by-hop headers
  before responses reach the browser, and rewrites runtime-local redirects back
  through `/api/opencode/:projectId`. The hosted proxy is not a general
  OpenCode reverse proxy: it allowlists the session, message, event, catalog,
  question, permission, and cancel/delete routes needed by the Web client, while
  blocking runtime config/auth/OAuth/MCP mutation routes such as
  `/global/config`, `/auth/:provider`, `/provider/:provider/oauth/*`, and
  unknown paths before reading request bodies or starting a runtime. Allowed
  runtime mutation routes validate their JSON-object payload shape before runtime
  startup as well, so malformed prompts, slash-command payloads, shell payloads,
  question replies, and permission replies return `invalid_runtime_proxy_payload`
  without waking the agent. Stale abort/session-delete controls are idempotent
  and do not wake a stopped runtime; stale question and permission mutations
  return `runtime_not_running` instead of starting a new agent. Non-GET/HEAD
  runtime proxy requests are bounded by
  `OPEN_SCIENCE_MAX_JSON_BYTES`; oversized requests are rejected before a runtime
  is started or contacted. Runtime proxy requests and SSE streams are
  concurrency-limited before additional runtime work is started. Server-disabled
  persistent approvals and direct shell proxy requests are also rejected before
  starting a runtime whenever their decision does not depend on the runtime
  sandbox mode.
  `/api/ops/metrics` exposes low-cardinality deployment metrics behind
  `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` or the no-follow
  `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE`. It includes normalized HTTP
  request/error counters and request-duration histograms in addition to
  readiness, process, task, and runtime signals; route labels never contain
  concrete project ids or file paths. Production readiness requires a
  non-placeholder token of at least 32 bytes, rejects conflicting or invalid
  token-file sources, and never returns the token or secret-file path.
- API responses include `X-Open-Science-Request-Id`; error responses include
  the same request id in the JSON envelope. Failed `/api/*` requests are written
  to `.openscience/errors.jsonl` under `OPEN_SCIENCE_DATA_DIR` with sanitized
  method, route pattern, status, code, request id, and optional project id. The
  records omit request bodies, prompts, query strings, file paths, runtime URLs,
  cookies, and authorization headers, and the error log file rejects symbolic
  links. `/api/logs/errors` returns only rows for the selected project plus
  projectless rows.
- Server-managed OpenCode runtime startup synchronizes manifest-backed skills
  from `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` into
  `XDG_CONFIG_HOME/opencode/skills` for the selected project. The default
  source is the first-party `runtime/skills/core` pack copied into the hosted
  Web service image; deployed skill targets reject symbolic links.
- In-memory rate limits for API requests by client address, stricter login
  attempt limits, and per-user/project/command command limits.
- Project audit events for commands, project creation, file upload/preview/
  download, task lifecycle actions, and runtime lifecycle actions
  (`runtime.start`, `runtime.restart`, `runtime.stop`). Runtime audit rows keep
  only sanitized metadata such as the command name, runtime action, kind,
  sandbox mode, running flag, and stale flag; they do not record proxied runtime
  URLs, passwords, or host workspace paths. Login/logout metadata is written to
  `.openscience/security.jsonl` under `OPEN_SCIENCE_DATA_DIR`. Project JSONL
  logs, provenance files, task state, runtime state, and server error logs are
  opened without following symbolic links.
- `/api/health` for process liveness and `/api/ready` for deployment readiness
  checks. Readiness verifies the data directory is a writable real directory
  rather than a symbolic link or file, verifies static asset access, rejects
  development auth under `NODE_ENV=production`, confirms local mode has at least
  one configured user, validates OIDC issuer/client/callback and separate secret
  settings, and validates production resource-limit settings for upload
  size, project quota, scan bounds, log bounds, rate limits, queues, timeouts,
  runtime proxy limits, runtime quota-monitor interval, attached-runtime limits,
  and Docker CPU/memory/pids limits. It validates production backup/restore
  configuration, protected observability metrics, an immutable deployment
  release manifest, and the selected OpenCode
  runtime sandbox configuration, and rejects mock runtime mode in production unless
  `OPEN_SCIENCE_ALLOW_MOCK_RUNTIME=true` is set for an explicit smoke test.
  Docker runtime and kernel checks also verify the Runtime Controller protocol,
  release identity, Docker Engine version, and runtime image metadata through
  the controller rather than granting the API direct daemon access.
  It also rejects disabled production security headers, wildcard/invalid/
  non-HTTPS/local production CORS origins, dangerous hosted shell escape hatches,
  persistent approvals, full approval mode, and host Python kernel execution for
  production deployments. In production Docker runtime mode it requires the
  configured runtime image to be locally inspectable unless
  `OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL=false` is set for a lazy-pull
  deployment. A local production image must have the exact image ID and
  OpenCode/uv OCI labels recorded by the release manifest. Readiness rejects
  release/config/image mismatches without returning image IDs. It also rejects
  outbound runtime networking until both its technical
  opt-in and operator policy acknowledgement are set. Static frontend assets
  are served without following symbolic links, and readiness fails if the
  configured `index.html` is a symbolic link.
- Hosted security headers, exact-origin CORS allowlisting, server-side approval
  policy enforcement, disabled persistent approvals by default, production-mode
  CSRF checks, and direct host shell proxy blocking unless explicitly allowed.
  Production CSP restricts browser connections to the hosted origin, so browser
  traffic reaches OpenCode through `/api/opencode/:projectId` instead of
  localhost or bare WebSocket runtime URLs; non-production mode keeps localhost
  allowances for local development. HTTPS public origins also get
  `Strict-Transport-Security: max-age=31536000` when security headers are
  enabled.
  With no `OPEN_SCIENCE_CORS_ORIGINS`, development mode allows localhost
  frontends and production mode only allows `OPEN_SCIENCE_PUBLIC_URL`'s origin;
  separate frontend/API origins must be configured explicitly as exact HTTPS
  origins, and `/api/ready` rejects wildcard, local, invalid, non-HTTPS, or
  path-bearing production CORS entries.
- Single-node backup and restore helpers for `OPEN_SCIENCE_DATA_DIR` live under
  `scripts/ops/`; they reject symbolic links and unsafe archive paths. The
  optional backup Compose profile runs those helpers from the immutable Web
  image with read-only application data, API-inaccessible file-backed
  encryption, retries, persistent health, and scheduled restore drills.
  Encrypted archives and
  checksum sidecars can be uploaded to and downloaded from S3-compatible object
  storage with `pnpm backup:object` / `pnpm restore:object`; the adapter rejects
  plaintext by default and keeps credentials in the selected CLI's credential
  chain. Production readiness
  requires either `OPEN_SCIENCE_BACKUP_MODE=local` with an absolute backup
  directory outside `OPEN_SCIENCE_DATA_DIR`, positive retention days, encrypted
  archives, and restore-drill acknowledgement; or
  `OPEN_SCIENCE_BACKUP_MODE=external` with explicit operator acknowledgement
  that platform/object-store backup and restore drills are owned outside the
  service container.
- Hosted compliance checks run with `pnpm audit:hosted-compliance`; the audit
  verifies default skill packaging, runtime version pins and OCI labels,
  release-manifest wiring, privacy/license docs, and configured runtime skill
  directories before publishing a hosted image. `pnpm release:manifest` records
  exact Web/runtime image IDs, tool versions, core skill digest, monitoring
  versions, and release input digests; `pnpm verify:release-manifest` rechecks
  source content and both local images before deployment.

Not implemented yet by design:

- Database-backed users/projects/sessions.
- Encrypted model key storage.
- Production durable job queues.
- Centralized rate limiting for horizontally scaled API replicas.
- Filesystem-level hard project quotas for runtime workspace mounts.
- Hosted-use license review for optional external skill packs.

Run locally:

```bash
OPEN_SCIENCE_DATA_DIR=.openscience-web-data node apps/server/src/index.mjs
```

Then build the frontend with `VITE_OPEN_SCIENCE_API_URL=http://127.0.0.1:8787/api`.

Verification:

```bash
pnpm --filter @ai4s/server test
pnpm --filter @ai4s/server test:e2e
OPEN_SCIENCE_SMOKE_BASE_URL=https://science.example.com \
OPEN_SCIENCE_SMOKE_USERNAME=admin \
OPEN_SCIENCE_SMOKE_PASSWORD=... \
OPEN_SCIENCE_SMOKE_KERNEL=true \
OPEN_SCIENCE_SMOKE_REQUIRE_DOCKER_KERNEL=true \
pnpm smoke:deployment
```
