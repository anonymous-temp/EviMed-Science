# Hosted Web Privacy and Compliance Checklist

This checklist covers the current hosted Web slice in this repository. It is a
technical deployment-readiness checklist, not legal advice. A production
operator must review the actual deployment, bundled artifacts, model-provider
terms, user terms, and privacy notice before offering the service to external
users.

## Deployment Readiness Verdict

The default `controlled-pilot` profile is suitable for a controlled MVP when the
operator controls users and infrastructure. The explicit `individual-saas`
profile can establish technical readiness for the original individual-account
tenant model only after all readiness checks and target-host acceptance pass.
It does not establish organization collaboration, billing, horizontal scaling,
or institution-specific compliance. See `docs/SAAS_PRODUCT_ALIGNMENT.md`.

## Data Stored by the Hosted Server

`OPEN_SCIENCE_DATA_DIR` is the server's artifact and local operational-state
boundary. Production users, projects, sessions, and research identity state use
the required Postgres control plane; local development and controlled fallback
modes can still contain:

- `users.json`, including local usernames/password hashes or OIDC-derived local
  user ids, display names, and `authType=oidc`. Raw OIDC issuer subjects are not
  stored.
- Per-user and per-project workspace files uploaded or created by users and
  agents.
- Per-project metadata under `.openscience/`, including provenance, audit logs,
  task logs, task state indexes, runtime logs, runtime state, and stored
  environment snapshots.
- Server-level security audit logs under `.openscience/security.jsonl`,
  including login/logout event metadata and failure codes without passwords.
- Server-level API error logs under `.openscience/errors.jsonl`, including
  request ids, HTTP method, sanitized route pattern, status, error code, and
  optional project id.
- Runtime workspace mounts used by OpenCode or kernel execution when enabled.

Operators must treat this directory as sensitive research data. The MVP includes
project-level and current-account self-service export and deletion, but does
not yet include automated retention windows, organization-level exports,
server-side encryption controls, or database-level access auditing. Production
readiness rejects missing backup ownership unless encrypted local backups plus
restore drills or explicitly managed external backups are configured. Define
the remaining policies outside the app before any non-internal deployment.
The optional S3-compatible object workflow uploads only client-side encrypted
archive/checksum pairs by default. Cloud credentials stay in the selected CLI's
credential chain or workload identity and must not be stored in project data,
backup URIs, browser settings, logs, or committed Compose environment files.
The local backup Compose profile gives the API a read-only archive mount and no
passphrase. Only the isolated backup service receives the mode-`0400`
file-backed passphrase, reads application data read-only, and writes encrypted
archives plus sanitized health metadata.

## User and Session Privacy

- Production-like mode must set `OPEN_SCIENCE_AUTH_MODE=local` with an
  owner-only, no-follow `OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE` mounted through
  `docker-compose.local-auth.yml`, or `OPEN_SCIENCE_AUTH_MODE=oidc` with a reviewed
  external identity provider and separate file-backed client/flow secrets.
  Production readiness rejects a local bootstrap password sourced directly
  from the process environment.
- Sessions use the `os_session` cookie with `HttpOnly` and `SameSite=Lax`.
  The cookie is marked `Secure` only when the server is configured for a secure
  public URL. The server stores a file-backed session index containing hashed
  session IDs, user IDs, CSRF tokens, and expiry timestamps, so login state and
  logout revocation survive process restarts. `OPEN_SCIENCE_SESSION_TTL_MS`
  controls both the server-side expiry and cookie `Max-Age`; production
  `/api/ready` rejects invalid TTL values. Put the service behind TLS for every
  hosted deployment; production `/api/ready` rejects missing, non-HTTPS, or
  non-origin `OPEN_SCIENCE_PUBLIC_URL` values. When the public URL is HTTPS and
  security headers are enabled, responses include
  `Strict-Transport-Security: max-age=31536000`.
- Hosted sign-out revokes the server session. Sign-out, account deletion, and
  authenticated requests receiving HTTP 401 clear the frontend's in-memory CSRF
  token and selected-project key, disconnect the Runtime client, and drop
  account-derived session titles, thread content, pending questions/permissions,
  workspace state, and inspector state before another user can sign in on the
  same browser.
- The hosted AppShell checks `/api/me` before starting a Runtime. Anonymous
  browsers are sent directly to the Settings login surface, and a session-ended
  event returns an active view there; desktop startup remains independent of
  this Web authentication gate.
- In production local and OIDC modes, mutating cookie-backed APIs require an
  `X-Open-Science-CSRF` token returned by `/api/auth/login` or `/api/me`. The
  hosted frontend sends it automatically for command, task, project, file, and
  proxied runtime writes. The OpenCode proxy strips browser session, project,
  and CSRF headers before forwarding to the runtime, and its runtime proxy logs
  record only sanitized method/route/status/duration and request/response byte
  count metadata. The proxy also allowlists the browser-facing runtime routes
  and blocks runtime config/auth/OAuth/MCP mutation endpoints before request
  bodies are parsed or a runtime is started.
- Credentialed CORS is exact-origin allowlisted. Without
  `OPEN_SCIENCE_CORS_ORIGINS`, development mode allows localhost frontends and
  production mode only allows the origin from `OPEN_SCIENCE_PUBLIC_URL`.
  Separate frontend/API origins must be explicitly listed; wildcard CORS is not
  safe with cookie sessions because `/api/me` returns the active CSRF token.
  Production readiness rejects wildcard, invalid, local-development, non-HTTPS,
  and non-exact CORS origins, and also rejects disabled security headers or
  dangerous hosted shell/approval escape hatches.
- Workspace file previews, including generated HTML/SVG content, are served
  with `no-store` caching and a sandboxed preview CSP that disables scripts,
  outbound connections, forms, object embeds, and base-URI changes. This limits
  preview execution, but generated files remain user data and must still be
  covered by retention, export, and deletion policy.
- Hosted workspace paths shown to the browser are scoped display paths such as
  `/workspace/<project>`, not host filesystem paths. Runtime directory selection
  is enforced inside the server-side OpenCode proxy after authentication and
  project authorization.
- OIDC delegates authentication, MFA, and account recovery policy to the
  configured provider. The application session index remains file-backed and
  does not provide application roles, per-organization tenancy, or centralized
  revocation across multiple API replicas. Those controls still require a
  database/session backend or gateway before horizontal public operation.

## External Identity and OIDC

OIDC uses Authorization Code with PKCE and validates state, nonce, issuer,
audience, signature, and ID Token expiry. A short-lived `os_oidc_flow` cookie
contains only AES-256-GCM-encrypted correlation state, PKCE verifier, nonce,
timestamp, and same-origin return path. It is `HttpOnly`, `SameSite=Lax`, scoped
to `/api/auth/oidc`, marked `Secure` for HTTPS public deployments, and deleted
at callback. The encryption secret is distinct from the provider client secret.

Access tokens, refresh tokens, ID Tokens, raw `sub`, email, and group claims are
not persisted in users, sessions, workspaces, exports, logs, or provenance. The
issuer and subject are hashed into a stable local user id; the selected display
name and OIDC auth type are retained. Security audit rows record only action,
status, local user id, and sanitized failure code.

Optional group admission uses exact claim-value matching. Optional email-domain
admission requires `email_verified=true` and an exact lower-case domain match.
The IdP client registration, group claims, domain list, MFA policy, account
recovery, offboarding, and upstream session revocation remain operator-owned.
Application logout revokes the Open Science session only; it does not retain
provider tokens or invoke provider-specific global logout.

## Model Keys and Provider Data Flow

Encrypted model-key storage is intentionally deferred in this slice. Do not put
provider keys in frontend code, static assets, browser storage, project
workspaces, provenance, or task logs.

The DeepSeek production profile mounts an owner-readable key file only into the
Web service. OpenCode receives a runtime-lifetime project token, not the
provider key, and can reach only the internal Model Gateway network. Before a
release is accepted, `pnpm preflight:deepseek:release` must produce a non-fake,
mode-0600 receipt bound to the exact source revision, reviewed gateway config
revision, `deepseek-v4-pro`, and OpenCode 1.17.13. The receipt contains only
capability booleans and release identifiers; it contains no prompts, messages,
keys, or runtime tokens. It is HMAC-signed with a domain-separated key derived
from the private Model Gateway signing secret. Host preflight and server
readiness reject altered receipts, receipts older than 24 hours by default, and
timestamps more than five minutes in the future.

The gateway also fails closed on group/world-readable secret files, bounds
request and provider-response bytes, and cancels upstream streaming if the
browser/runtime disconnects. These controls limit accidental disclosure and
resource exhaustion; they do not make prompts or provider responses
non-sensitive, so normal workspace retention and operator-access rules still
apply.

In hosted Web mode, the Settings page hides browser-visible provider key,
OAuth, custom endpoint, and provider-removal controls. Treat real provider
credentials as operator-managed server runtime configuration until encrypted
server-side key storage exists. The hosted Settings page also disables
browser-side MCP/Jupyter provisioning and removal controls; existing MCP
entries are shown as server-managed status only, without local command strings
or deployment secrets. The hosted Skills page is similarly read-only: it shows
the server runtime's reported agents and skills, but does not expose browser
controls for custom skill installation or local scientific-environment
detection.

Before enabling real hosted model use, add server-side key management with:

- encrypted at-rest storage or integration with a managed secrets service;
- key rotation and deletion;
- per-user or per-organization key scoping;
- audit records for key creation, use, and deletion;
- clear disclosure of which prompts, files, command output, and generated
  artifacts may be sent to the selected provider.

## Runtime and Execution Boundary

- `OPEN_SCIENCE_RUNTIME_MODE=mock` is appropriate only for UI/API verification.
- Real hosted agent use requires `OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker`
  with either the repository's `deploy/runtime-dsh/Dockerfile` image or an
  equivalent operator-supplied agent runtime image.
- The Docker runtime path uses per-project containers, project workspace mounts,
  `no-new-privileges`, dropped Linux capabilities, pids limits, CPU and memory
  limits, and rejects host/shared-container networking unless explicitly
  allowed. The supplied Compose profile mounts only the selected project's
  named-volume subpaths and carries OpenCode HTTP/SSE over a project-scoped Unix
  socket, with no published runtime port. It defaults to the named Docker
  `internal: true` network `open-science-runtime-internal`, which can reach the
  authenticated Web Model Gateway and the separate official-host public-source
  gateway but has no public route. Public-source requests are HTTPS GET-only,
  redirect-disabled, response-bounded, and authenticated with the active
  runtime token; the gateway does not accept arbitrary hosts or caller headers.
  A catalog entry or Skill mapping is not a connected source. In production,
  any other Docker
  runtime network mode
  requires both `OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true` and
  `OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true`; keep both disabled
  until outbound filtering, network logging, data-flow risk, and incident
  response ownership are reviewed. The acknowledgement records operator intent
  but does not replace technical filtering or telemetry.
  `OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS` should
  stay enabled so inactive per-project runtimes are stopped after the approved
  idle window instead of retaining workspace mounts and resource allocations
  indefinitely. Keep `OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS` positive so
  attached runtimes are stopped when background writes exceed project quota or
  when a bounded usage scan cannot complete safely. This periodic application
  guard does not replace filesystem or volume quotas on untrusted worker hosts.
- The public Web API does not hold the host Docker socket. It sends only a
  versioned, fixed operation set over a private mode-`0600` Unix socket to the
  unexposed Runtime Controller. The controller reconstructs canonical project
  paths and container arguments from deployment configuration, mounts the data
  volume read-only in its own process, and rejects arbitrary image, mount,
  network, command, and Docker-argument fields. Runtime passwords and kernel
  source pass through this local socket only for the lifetime of the operation;
  the controller does not persist them or include them in responses or logs.
- Browser-direct shell proxying is disabled by default with
  `OPEN_SCIENCE_ALLOW_DIRECT_SHELL=false`. Host-mode shell proxying additionally
  requires `OPEN_SCIENCE_ALLOW_HOST_SHELL=true`; the hosted browser UI does not
  expose the `!` shell path.
- Only the Runtime Controller needs Docker access. Treat that service and its
  host as trusted infrastructure; never publish the controller or mount its
  control socket into project runtime containers.
- `OPEN_SCIENCE_DATA_DIR` must be a real deployment-owned directory, not a
  symbolic link or file. Readiness rejects symlinked/non-directory data roots,
  and hosted state/log/workspace paths also reject symbolic links before reading
  or writing user data.
- The hosted Web service image deploys only the first-party
  `runtime/skills/core` pack by default. Add external skill directories to
  `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` only after their hosted-use licenses,
  notices, network behavior, and credential handling have been reviewed. The
  hosted browser UI does not provide a custom skill installation path.
- Server kernels are disabled by default. If command API kernel execution is
  enabled for a controlled deployment, use
  `OPEN_SCIENCE_KERNEL_SANDBOX_MODE=docker`; the host Python kernel path is
  rejected by production readiness and `kernel_execute`. Docker kernels reuse
  the reviewed runtime image/resource controls, force `--network none`, cap
  stdout/stderr, kill child processes after `OPEN_SCIENCE_KERNEL_TIMEOUT_MS`,
  and recheck project usage after execution. Non-streaming OpenCode proxy
  responses are separately capped by
  `OPEN_SCIENCE_MAX_JSON_BYTES` and
  `OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS`. Hosted Web notebook pages
  can create Python notebooks and submit cells or expressions to this scoped
  server kernel; users can abort matching in-flight executions. Jupyter
  provisioning and R kernels remain unavailable in hosted Web.

## Third-Party Components and Licenses

The repository's own application code is MIT licensed under `LICENSE`, with a
note that third-party scientific skills keep their own licenses.

For hosted Web deployments, verify and preserve notices for every redistributed
component actually included in the image or runtime:

Run `pnpm audit:hosted-compliance` before publishing an image or changing the
runtime skill allowlist. The audit is a local gate for the default Web image,
runtime version pins/labels, architecture-specific release-asset checksums,
preserved runtime licenses, release-manifest wiring, required privacy/license
documentation, and configured runtime skill directories. Generate the
deployment record with `pnpm release:manifest` after both images exist, then run
`pnpm verify:release-manifest` before startup. The manifest contains release and
source identifiers, image names/IDs, component versions, file counts, and
SHA-256 content digests; it does not permit credentials, arbitrary extra fields,
host absolute paths, or research data. Treat private registry names and source
revision metadata according to the deployment's operator-metadata policy. This
is not a substitute for legal review of upstream licenses.

- Agent runtime: `deploy/runtime-dsh/Dockerfile` pins the hosted runtime image
  default, from the single version definition in `deps-version.json`. The kernel
  arrives as a pinned npm package that carries its own license text, so there is
  no separate archive or license fetch to verify for it; the pin is enforced by
  a publish-date filter plus an assertion that every installed package in the
  tree is at the pinned version. The image downloads and redistributes two
  third-party binaries: the Node runtime and uv. Both are verified against
  pinned per-architecture SHA-256 digests before extraction, and a missing pin
  fails the build rather than skipping the check — arm64's Node digest was blank
  behind a presence guard until 2026-09-02, which meant an unverified runtime
  and a build log that looked identical to a verified one. uv's MIT license text
  is verified against its own pinned digest and installed under
  `/usr/share/licenses/uv/LICENSE-MIT`. Update each version, every architecture
  digest, and the license digest as one reviewed change.
- Runtime socket relay: the hosted runtime image installs Debian `socat` and
  uses it only to relay OpenCode loopback HTTP/SSE over a project-scoped Unix
  socket. Preserve the corresponding package license and source notices in the
  runtime image's third-party inventory.
- OIDC client: the Web API pins `openid-client` 6.8.4 (MIT), with its pinned
  `jose` and `oauth4webapi` dependencies from `pnpm-lock.yaml`. Preserve their
  license notices and review their security advisories when updating the
  identity boundary.
- Browser document previews: workspace overrides keep `pptx-preview` on ECharts
  6.1.0 for the fix to CVE-2026-45249 and keep the ExcelJS/PPTX UUID dependency
  on 11.1.1 for the fix to CVE-2026-41907. `pnpm audit:dependencies` checks all
  production dependencies against the official npm advisory endpoint at
  moderate severity and is part of `pnpm ci:web`. Re-run preview tests and a
  real browser document fixture whenever either override changes because these
  are compatibility overrides above the parents' declared major ranges.
- `uv`: `scripts/dev/fetch-uv.sh` pins the desktop sidecar helper, and the
  hosted runtime Dockerfile pins the runtime image helper. The hosted image
  verifies both Linux architecture archives and preserves the selected MIT
  license from uv's `MIT OR Apache-2.0` upstream license under
  `/usr/share/licenses/uv/LICENSE-MIT`. Update its version and digests together.
- `ai4s-skills`: `scripts/dev/fetch-skills.sh` pins a commit, and the local
  external copy records that commit in `.commit`. No license file is present in
  the local fetched directory; verify the upstream license before bundling it
  into a hosted image or installer.
- Office exporters: Hosted and desktop releases package four first-party MIT
  `docx`, `pdf`, `pptx`, and `xlsx` implementations with independent artifact
  smoke tests. Restricted Anthropic source directories remain excluded, and the
  hosted compliance audit rejects them if reconfigured for runtime deployment.
- Seven audited science connectors are included in the Hosted default through
  the fixed-host EviMed gateway. Additional MCP servers, browser tools, HPC
  tools, and user-installed skills remain outside the reviewed slice; assess
  each package's license, network behavior, credentials, and data flow first.

## Logs, Backups, and Retention

Audit, provenance, runtime logs, and workspace metadata can contain usernames,
project IDs, file names, prompts, command names, errors, and snippets of
generated output. Task events and task state indexes intentionally omit raw
command arguments and command results, but still contain task ids, command
names, user/project ids, timestamps, status, and structured errors. These
records are useful for support and incident review, but must be covered by the
operator's privacy notice and retention policy.
Hosted provenance entries are limited to normalized workspace-relative artifact
paths plus bounded metadata, and large recorded content is capped before it is
written.

The hosted MVP records project audit events for command execution, project
creation, browser uploads, previews/downloads, task creation/cancellation, and
runtime start/restart/stop actions. Runtime lifecycle audit rows include only
sanitized lifecycle metadata such as command name, runtime action, kind,
sandbox mode, running flag, and stale flag; they do not store runtime URLs,
passwords, browser credentials, request bodies, or host workspace paths.
Authenticated hosted users can read a bounded tail of the selected project's
audit rows through `/api/logs/audit` and the hosted Settings page; this endpoint
does not provide a cross-project or cross-user audit export. A selected project
can be exported as a `tar.gz` archive through `/api/projects/:id/export`; the
archive contains project-relative workspace, metadata, task, runtime, and log
files, rejects symbolic links, is capped by `OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES`
and `OPEN_SCIENCE_MAX_ARCHIVE_BYTES`, and does not expose host filesystem paths.
Runtime proxy logs record sanitized OpenCode proxy route patterns, HTTP status,
duration, request/response byte counts, streaming flag, and policy error codes;
they do not include browser auth headers, cookies, `auth_token` query values,
OpenCode `directory` paths, prompts, request bodies, response bodies, or file
contents.
Runtime proxy write requests are bounded by `OPEN_SCIENCE_MAX_JSON_BYTES`, so
oversized browser payloads are rejected before a runtime is started or contacted.
Runtime config/auth/OAuth/MCP mutation routes and unknown upstream OpenCode
paths return `runtime_proxy_forbidden` before request bodies are read.
Allowed runtime mutation payloads are schema-checked before startup; malformed
prompt, slash-command, shell, question, and permission bodies return
`invalid_runtime_proxy_payload` without reaching OpenCode.
Stale abort/session-delete controls are idempotent and do not wake a stopped
runtime; stale question and permission mutations return `runtime_not_running`
instead of starting a new agent.
Task status APIs expose task metadata only and do not return raw command
arguments, stdout/stderr payloads, file contents, or command result objects.
Runtime state files record sanitized operational metadata such as runtime kind,
sandbox mode, pid, container name, last event, stale flag, and timestamps; they
do not include runtime URLs, passwords, absolute filesystem paths, request
bodies, or browser credentials. Server-start orphan cleanup uses that sanitized
state to remove stale Docker containers and writes only the cleanup event,
container name, sandbox mode, and result/error to project runtime logs.
Authentication events are written to the server-level security audit log.
Authenticated hosted users can read a bounded tail of their own related
security rows through `/api/logs/security`; rows for other usernames or user ids
are filtered out. Failed API requests are written to the server-level error log
with request ids and route patterns, not request bodies, prompts, query strings,
file paths, runtime URLs, cookies, or authorization headers. Authenticated
hosted users can read a bounded tail of their selected project's error rows,
plus projectless rows, through `/api/logs/errors`. These logs are file-backed
and not yet covered by full automated retention or redaction. The server does
apply a single-node size cap to operational JSONL logs through
`OPEN_SCIENCE_MAX_LOG_FILE_BYTES`, rotating the current file to `.1`; hosted
provenance JSONL uses the same single-node growth guard. This is not a
substitute for
organization-level retention, export, deletion, encryption, or off-host log
archive policy. Log read APIs use `OPEN_SCIENCE_MAX_LOG_READ_BYTES` as a total
tail budget across the current file and `.1`, and both files reject symbolic
links. Provenance metadata is not size-rotated by default because it is part of
the research reproducibility record.
The `/api/metrics` endpoint exposes operational metadata such as storage byte
counts, task status counts, runtime state, and server process resource usage;
if project usage exceeds `OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES`, it
reports `project.storage.scanLimited=true` instead of walking the full tree. It
does not include file contents or absolute paths, but operators should still
treat project IDs, usernames, and usage patterns as sensitive metadata.
The `/api/ops/metrics` endpoint is intended for deployment monitoring systems
and requires `OPEN_SCIENCE_OPERATOR_METRICS_TOKEN` or the no-follow
`OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE`. It emits low-cardinality Prometheus
metrics for readiness, process resources, normalized HTTP routes/statuses/error
codes, request-duration histograms, task queues, and runtime counts without
user names, concrete project IDs, workspace paths, file names, query strings,
or request bodies. Treat
the scrape token, scrape logs, and time-series data as operator-sensitive
metadata. Production readiness requires a non-placeholder token of at least 32
bytes; keep it in the deployment secret store, scope it to the scraper, and
rotate it through the same incident-response process as other operator secrets.
The bundled monitoring profile writes Prometheus, Alertmanager, and Grafana
state to separate named volumes and sends alert metadata to an operator-owned
HTTPS webhook. Although alert payloads use only these low-cardinality signals,
the receiver, time-series retention, console access, and webhook custody still
need the deployment's operator-access and incident-response policy.
The deployment smoke test creates a short-lived project and workspace file
under the authenticated smoke-test account; when runtime smoke is enabled, it
also creates runtime/session/task/audit log entries. Use non-sensitive smoke
inputs and include these records in the deployment's retention policy.

Before production use, define:

- backup scope and restore testing for `OPEN_SCIENCE_DATA_DIR`; production
  readiness requires `OPEN_SCIENCE_BACKUP_MODE=local` with an absolute backup
  directory outside the data dir, positive retention, encrypted archives, and
  restore-drill acknowledgement, or `OPEN_SCIENCE_BACKUP_MODE=external` with
  explicit external-backup and restore-drill acknowledgements. The included
  `scripts/ops/backup-data.sh`, `scripts/ops/restore-data.sh`, and
  `scripts/ops/restore-drill.sh` provide a single-node file-volume path with
  passphrase-based encrypted archives, local retention pruning, and disposable
  restore drills. The backup Compose profile schedules that workflow, retries
  failures, persists health, and fails health closed. `scripts/ops/migrate-data-dir.sh` provides a
  stopped-service migration path with symbolic-link rejection, overlap checks,
  non-empty target opt-in, and post-copy verification, but production policies
  still need off-host storage, passphrase custody, scheduler ownership, and
  operator access controls;
- retention periods for workspaces and logs;
- deletion flow for user accounts, uploaded files, generated files, and
  organization-level log archives; project-level deletion now removes the
  selected project's workspace files, metadata, task state, runtime state, and
  project logs after exact id confirmation;
- incident response access controls for operators reading project data;
  `docs/WEB_SECURITY_INCIDENT_RESPONSE.md` defines independent approval,
  narrow read-only scope, evidence custody, recovery, and notification gates;
- monitoring that does not leak research content into third-party observability
  tools.

## Go-Live Gate

Do not mark a hosted deployment production-ready until these items are resolved:

- TLS is configured and `OPEN_SCIENCE_PUBLIC_URL` is the HTTPS public origin.
- The target Linux host passes `pnpm preflight:host` before Compose startup and
  again with `--online` through the public TLS route.
- Development auth is disabled; local bootstrap credentials are generated into
  an owner-only file and retained in an operator password manager, or OIDC is
  configured with provider-managed recovery.
- A production identity plan is selected for the intended user population.
- The production model key is an owner-readable server file used only by the
  signed gateway; browser, workspace, runtime, logs, and exports do not receive
  it. Any future per-user or per-organization BYOK requires encrypted scoping,
  rotation, and deletion.
- A fresh, HMAC-authenticated, non-fake DeepSeek/OpenCode release-gate receipt
  matches the deployed source revision, reviewed config revision, model, and
  receipt ID.
- Runtime containers are sandboxed and resource-limited, or real runtime use is
  disabled.
- A protected operator metrics token and content-safe monitoring retention,
  alerting, and access policy are configured.
- The OpenCode runtime image and any bundled skills have verified licenses and
  preserved notices.
- Only the first-party MIT Office exporters are packaged; restricted third-party
  document directories remain excluded by the compliance gate.
- Backup, retention, deletion, privacy notice, and operator access policies are
  documented, and restore drills have been scheduled against actual
  `OPEN_SCIENCE_DATA_DIR` backups.
- Named incident-command, security-operation, data-access-approval, and
  privacy/legal owners have exercised the security incident response procedure.
- Deployment smoke tests are run with non-sensitive test inputs and the created
  project/log records are covered by retention and deletion procedures.
- CI checks pass for the server, hosted frontend build, and Tauri backend
  compile check.
