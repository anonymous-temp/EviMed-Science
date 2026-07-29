# EviMed Science SaaS

This repository is the release orchestrator for the EviMed hosted research
platform. The production entry point is the Web/SaaS stack under `OpenScience/`;
the Tauri desktop shell is optional and is not the primary release target.

## Repository layout

- `OpenScience/` — **the production system**: hosted Web application, server
  boundary, runtime, MCP, tools, data-source catalog, skills, deployment
  manifests, and release gates. This is a ground-up rewrite of the drug-evaluation
  platform; all new product work happens here.
- `项目代码/` — the six specialist Python agents consumed by the SaaS runtime.
- `记忆模块/` — the EviMed memory service (vendored Memos).
- `接口文档/` — shared capability contracts.
- `docs/superpowers/` — architecture specs and implementation plans.

Everything above is a normal tracked directory in this single repository (branch
`main`) — there are no Git submodules. The five legacy Java services that
`OpenScience/` replaced are **archived (frozen 2026-07-24)**: still on disk under
`项目代码/` for reference but untracked (see `.gitignore`), not built, and not
maintained. Local infrastructure, credentials, user data, evaluation outputs,
generated artifacts, and third-party reference snapshots are also excluded.

## Clone

```bash
git clone git@gitee.com:zwan7221/evimed-science.git
cd evimed-science
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
