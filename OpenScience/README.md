# EviMed

EviMed is a traceable medical research agent platform. It combines an open-domain
research workbench with specialist medical-research agents on one shared runtime,
artifact, provenance, notebook, tool, and data-source foundation.

[中文说明](./README.zh.md)

## Product surfaces

- **Open-domain research** — multi-turn research with literature search, code,
  notebooks, files, figures, reports, integrity review, and reproducible run records.
- **Specialist research workflows** — dedicated conversational entry points for
  pharmacovigilance, off-label evidence, drug evaluation and selection,
  meta-analysis, Mendelian randomization, bibliometrics, topic selection, and peer
  review. Each workflow is configured as a skill while reusing the same harness.
- **Personal knowledge base** — uploaded files and saved knowledge can be reused by
  both open-domain and specialist research sessions.

Research output is decision support for scientific work. It does not replace
clinical diagnosis, treatment, or professional judgment; important conclusions
must be checked against the original evidence.

## Architecture

EviMed is a hosted SaaS product and nothing else: the React/TypeScript frontend
connects through the EviMed server to isolated DeepSeek Harness (DSH) runtimes,
the DeepSeek model gateway, append-only run records, artifact provenance,
Jupyter kernels, curated scientific skills, and EviMed data/tool adapters. The
optional Tauri desktop shell was removed on 2026-09-04.

Specialist adapters are registered through `EVIMED_*_URL` environment variables.
The meta-analysis service is included in the hosted Compose stack. Other specialist
services must be deployed and configured before their entry points are enabled in a
production release; see [the release checklist](./docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md).

## Local development

Requirements: Node.js 22+ and pnpm 9.

```bash
pnpm install
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh
pnpm dev:evimed
```

The agent runtime is not fetched as a binary here: DSH is installed into a
version-pinned profile inside the runtime image (`deploy/runtime-dsh/`), from
the single pin in `deps-version.json`.

The local setup script stores provider credentials outside the repository. Never
commit API keys, deployment `.env` files, user workspaces, run logs, or generated
release manifests.

Core checks:

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

The hosted Web deployment is the only release path. Desktop packaging was
removed on 2026-09-04 together with the Tauri shell.

## License and upstream attribution

This repository retains the upstream MIT license and third-party notices in
[LICENSE](./LICENSE). EviMed is built on the Open Science workbench and the
DeepSeek Harness (DSH) agent runtime; those upstream names are retained only
where technically or legally required for attribution and compatibility.
