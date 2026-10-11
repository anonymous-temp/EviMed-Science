# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting.
Open the repository's **Security** tab and choose **Report a vulnerability**. This reaches the
maintainers without making the report public.

Do not open a public issue, pull request or discussion for a vulnerability, and do not post
exploit details, credentials or personal data anywhere public.

A useful report says:

- what is affected: the component and path (for example `OpenScience/apps/server`, the runtime
  image, a gateway, a Python engine) and the commit or deployment version;
- how to reproduce it, with the smallest steps that work;
- what an attacker gains (another tenant's data, a credential, code execution, a bypassed
  check);
- a suggested fix, if you have one.

Please test only against a deployment you own or are authorized to test, and use synthetic data
rather than real patient or personal data. We will acknowledge the report, work with you on a
fix, and agree on disclosure timing; tell us if you would like to be credited.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes. Security fixes land here. |
| Anything else (old commits, forks, past release images) | No. Update to `main`. |

## What the platform promises

These defaults are non-negotiable in the design (see `OpenScience/AGENTS.md`, "Safety
defaults"). A way around any of them is a vulnerability worth reporting:

- **Workspace-only access.** An agent may only reach its own project workspace. Writes are
  fenced by the kernel sandbox; reads and network egress are bounded by the runtime container's
  mounts and network policy.
- **The runtime never holds a real provider key.** Provider keys are held by the control plane's
  gateways. The kernel's model endpoint points at the model gateway, and its credential is a
  reference resolved per request, not a key.
- **The browser never reaches an agent kernel.** Only the control plane (`apps/server`) does, so
  authentication, tenancy and authorization are enforced in one place.
- **Approval policy is `never` in a hosted deployment, and `never` means auto-refuse.** Attempts
  to step outside the sandbox are refused, not approved.
- **Telemetry is disabled** in the runtime image, its profile and its container environment.
- **A memory capsule is context, never permission.** Nothing an imported capsule or workstyle
  pack says can loosen a contract, relax a safety rule or reach a host a gateway would not.
- **Server-side fetching is bounded.** The public-source gateway refuses private and link-local
  addresses before fetching, and checks every hop's DNS answer.

## In scope

- Authentication, session and CSRF handling; tenant, project and data-ownership isolation
  (`OpenScience/apps/server`).
- Escapes from the project workspace or the runtime container, or access to a kernel from
  outside the control plane.
- Leakage of provider keys, signing keys or other credentials into a runtime, a log, an artifact
  or an export.
- Server-side request forgery or path traversal in the gateways and file handling.
- Secrets or personal data committed to this repository.
- The specialist adapter and engine boundaries under `OpenScience/deploy/specialist-adapter` and
  `项目代码/`.

## Out of scope

- Vulnerabilities in upstream components such as DeepSeek Harness, DeepSeek, OpenViking or
  PostgreSQL. Report them to their maintainers; do tell us if our pinned version is affected.
- Findings that need a deployment which has disabled the defaults above.
- Incorrect or incomplete research output. That is a bug, not a vulnerability; open an ordinary
  issue. Research output is decision support and does not replace clinical judgment.
- Volumetric denial of service, social engineering and physical attacks.

## Secrets and scanning

CI runs a secret scanner, `pnpm audit:source-secrets`, as part of `pnpm ci:web`; run it before
you commit. Real `.env` files, `deploy.env` and credential files are gitignored, and only
`.env.example` files may be committed. If you find a secret in the repository or its history,
report it privately as above rather than publishing it.

Operators of a hosted deployment should also read
[`OpenScience/docs/WEB_SECURITY_INCIDENT_RESPONSE.md`](OpenScience/docs/WEB_SECURITY_INCIDENT_RESPONSE.md).
