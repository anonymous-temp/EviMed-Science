# EviMed Science SaaS

This repository is the release orchestrator for the EviMed hosted research
platform. The production entry point is the Web/SaaS stack under `OpenScience/`;
the Tauri desktop shell is optional and is not the primary release target.

## Repository layout

- `OpenScience/` — hosted Web application, server boundary, runtime, MCP, tools,
  data-source catalog, skills, deployment manifests, and release gates.
- `项目代码/` — five Java services and six specialist Python agents, pinned as
  independent Git submodules.
- `记忆模块/` — the EviMed memory service, pinned as a submodule.
- `接口文档/` — shared capability contracts.
- `docs/superpowers/` — architecture specs and implementation plans.

Local infrastructure, credentials, user data, evaluation outputs, generated
artifacts, and third-party reference snapshots are intentionally excluded.

## Clone

```bash
git clone --recurse-submodules \
  git@gitee.com:zwan7221/evimed-science.git
cd evimed-science
git submodule update --init --recursive
```

## Main SaaS checks

```bash
cd OpenScience
pnpm install
pnpm ci:web
```

See `OpenScience/docs/WEB_DEPLOYMENT.md` and
`OpenScience/docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md` for deployment and
release requirements.
