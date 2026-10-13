# EviMed (OpenScience/)

EviMed is a traceable agent platform — a general work assistant first, with a professional
layer for medical research: hosted and multi-tenant, each project running in its own isolated
runtime on the DeepSeek Harness (DSH) agent kernel. This directory is the production system. The repository-level
overview is [`../README.md`](../README.md), contribution rules are in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md), and the rules agents and people follow inside
this subtree are in [`AGENTS.md`](./AGENTS.md).

[中文说明](./README.zh.md)

Research output is decision support for scientific work. It does not replace clinical
diagnosis, treatment, or professional judgment; important conclusions must be checked
against the original evidence.

## What is here

A pnpm monorepo (`engines.node >= 22.22.0`, pnpm 9.4.0; workspaces `apps/*` and
`packages/*`). The product is the hosted web application and nothing else.

| Path | What it is |
| --- | --- |
| `apps/web/` | React + TypeScript + Vite frontend (`@ai4s/web`), served by the server |
| `apps/server/` | Plain-Node control plane (`@ai4s/server`): HTTP API, authentication and tenancy, run ledger, gateways, delivery gate, feature modules |
| `packages/` | `domain` (the shared vocabulary and the delivery-gate rules), `harness-port` (the only package that imports `@deepseek-ai/*`), `socket` (the `evimed-universal` kernel composition), `contracts`, `design-tokens`, `shared` |
| `capabilities/`, `capability-skills/` | One directory per capability (`capability.yaml`, `SKILL.md`, scripts) and the shared skill bodies |
| `runtime/` | The MCP servers and skill libraries the runtime image ships |
| `deploy/` | The runtime image, Docker Compose stacks, the specialist adapter, and host release scripts |
| `evals/` | Evaluation harnesses and briefs; separate from tests, they call live models |
| `scripts/` | Build generators, local development helpers, operations and release tooling; see [`scripts/README.md`](./scripts/README.md) |
| `docs/` | Product, technical, deployment, operations and release documents |
| `deps-version.json` | The one place every tracked upstream pin is written |

## How it fits together

The browser never reaches an agent kernel. It calls `apps/server`, which holds the one
WebSocket to the DSH kernel in the project's runtime (a container on the host, or an
AgentBay session), decodes the kernel's events into the vocabulary of `@evimed/domain`, and
serves its own run-event stream. Model calls from the runtime go through the control
plane's model gateway, which holds the provider credentials; the runtime holds no provider
key and has workspace-only access. The specialist analysis engines (the Python agents under
`../项目代码/`) are fronted by `deploy/specialist-adapter/` and run as services of the hosted
Compose stack in `deploy/web/`; the control plane finds them through `EVIMED_*_URL`
environment variables.

The kernel version is pinned once, in `deps-version.json`; it is installed into a
version-pinned profile at runtime-image build time (`deploy/runtime-dsh/`), not fetched
here. [`docs/TECHNICAL_DESIGN.md`](./docs/TECHNICAL_DESIGN.md) and
[`docs/PRD.md`](./docs/PRD.md) are the original v0.1 desktop-era design records and are
marked as superseded in their opening notes; [`AGENTS.md`](./AGENTS.md),
[`docs/REQUEST_PATH.md`](./docs/REQUEST_PATH.md) and
[`docs/WEB_DEPLOYMENT.md`](./docs/WEB_DEPLOYMENT.md) describe the system as it runs.

## Local development

Requirements: Node.js 22.22.0 or newer and pnpm 9.4.0.

```bash
pnpm install
pnpm configure:evimed-local   # creates the local signing secrets and reports what is missing
pnpm dev                      # web frontend (Vite dev server)
pnpm dev:server               # control-plane HTTP API
pnpm dev:evimed               # local wrapper: control plane with password login on port 8798
```

`pnpm dev:evimed` serves `apps/web/dist` when it has been built (`pnpm build`). It sets a
local-only opt-in that lets a runtime start on the host outside the container sandbox;
hosted deployments keep the container boundary.

Provider credentials are stored outside the tracked tree, under `.evimed-local/secrets/`
at the repository root. Never commit API keys, deployment `.env` files, user workspaces,
run logs, or generated release manifests.

`bash scripts/dev/fetch-skills.sh` fetches the pinned external skill pack into
`runtime/skills/external/` (git-ignored). The runtime image build and CI run it themselves;
you need it only when you build or run the runtime image locally.

Core checks (the per-area list is in [`../CONTRIBUTING.md`](../CONTRIBUTING.md)):

```bash
pnpm lint
pnpm ci:web
```

## Deployment and operations

- [Web deployment](./docs/WEB_DEPLOYMENT.md)
- [Operations runbook](./docs/WEB_OPERATIONS_RUNBOOK.md)
- [Privacy and compliance](./docs/WEB_PRIVACY_AND_COMPLIANCE.md)
- [Security incident response](./docs/WEB_SECURITY_INCIDENT_RESPONSE.md)
- [Release and delivery checklist](./docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md)

The hosted web deployment is the only release path.

## License and upstream attribution

This directory retains the upstream MIT license and third-party notices in
[LICENSE](./LICENSE). EviMed is built on the Open Science workbench and the DeepSeek
Harness (DSH) agent runtime; those upstream names are retained only where technically or
legally required for attribution and compatibility.
