# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is the Claude-Code-variant of the workspace `AGENTS.md` — the two are kept in sync.

## What this workspace is

`EviMed Science` (循证医学 / evidence-based medicine) is the **SaaS platform monorepo**. Product code lives in ordinary directories with separate stacks and toolchains. There is no root build; `cd` into the relevant subtree before running project commands.

| Path | What it is | Stack | Authoritative docs |
|---|---|---|---|
| `项目代码/` (Java services) | EviMed platform — 5 Spring Cloud microservices | Java 8/21 · Spring Boot · Maven | documented here (the service dirs have **no** READMEs of their own) |
| `项目代码/` (Python agents) | 6 Python AI agents consumed by the platform | Python · FastAPI / CLI | each has its own `README.md` / `CLAUDE.md` / `AGENTS.md` — read those first |
| `OpenScience/` | EviMed Science hosted SaaS release (plus an optional desktop shell) | React · TS · Node · Tauri 2 · Rust | `OpenScience/AGENTS.md` |
| `记忆模块/` | Memos, vendored as the platform's "memory" store | Go 1.26.2 · React/TS (ConnectRPC) | `记忆模块/AGENTS.md` |
| `接口文档/` | Markdown API specs for shared capabilities | — | `.md` files in place |

Git model: the workspace root is the single authoritative repository and uses the `main` branch. The five Java services, six Python specialist agents, `OpenScience/`, and `记忆模块/` are normal tracked directories, not submodules. Commit and push from the workspace root. `scientific-agent-skills-main/`, `open-science-master/`, and `grok-build-main/` are ignored reference snapshots.

Working language: discussion in Chinese is fine, but **code, files, comments, and commits are English** (per `OpenScience/AGENTS.md`). When a subtree has its own `AGENTS.md`/`CLAUDE.md`, that file wins for that subtree. `AGENTS.md` at the workspace root is the Codex-variant of this file — keep them in sync when editing rules.

### Supporting directories (do not code here)

- `.evimed-local/` — local infra state: `memos/memos_prod.db` (SQLite for Memos), `secrets/` (`deepseek.api-key`, signing keys, Memos admin password/PAT, bootstrap password), and recoverable migration metadata under `git-backups/`. Treated as runtime state; never commit, never echo.
- `outputs/` — audit/evaluation artifacts, not chat-style agent runs: UUID dirs hold audit workbooks (`.xlsx` + build scripts); `outputs/audit/` is an evaluation harness (`corpus/`, `runs/`, `reports/`, `scripts/`); `outputs/outputs/audit/` is a stray nested duplicate. Ephemeral.
- `docs/superpowers/` — `plans/` and `specs/` for the `superpowers` skill framework (incl. the EviMed platform design spec and the `grok-build` fusion design). `docs/ui-ux-audit/` — frontend UI/UX audit reports (Chinese).
- `open-science-master/` — upstream reference snapshot of OpenScience (`ai4s-workbench` v0.2.0, desktop-only: no `apps/server`, `deploy/`, or `evals/`). **Not** the active tree — use `OpenScience/`. Read-only.
- `grok-build-main/` — vendored Rust workspace (SpaceXAI "Grok Build" terminal coding agent; ~85 `xai-*` crates under `crates/`, vendored `third_party/`). Unrelated to platform code; read-only reference for the fusion design in `docs/superpowers/specs/`.
- `.playwright-mcp/` — Playwright MCP session logs/snapshots. Tooling artifact.

## Local bring-up (toolchain + middleware, added 2026-07-19)

Local toolchain (no sudo): JDK 8 = Zulu 8u492 arm64 at `.evimed-local/toolchains/zulu8.94.0.17-ca-fx-jdk8.0.492-macosx_aarch64/Contents/Home`, JDK 21 = `/opt/homebrew/opt/openjdk@21`, Maven 3.9 (brew). `source .evimed-local/toolchains/env.sh` → `usejdk8` / `usejdk21`. `~/.m2/settings.xml` has Aliyun mirrors (Maven Central flaky here); Docker Hub is unreachable — use `docker.m.daocloud.io` image prefixes. The private parent pom `com.evimed:parent:1.0.0` (药品遴选) is reconstructed at `.evimed-local/toolchains/evimed-parent-pom/pom.xml` and installed into `~/.m2`. Aspose was removed (药品遴选/安全性分析) in favor of JODConverter + LibreOffice at `/Applications/LibreOffice.app` (set `EVIMED_OFFICE_HOME` on other hosts).

Local middleware via `.evimed-local/infra/docker-compose.yml` (project `evimed-local-infra`): MySQL 8 (`xunzheng`, `evimed-evidence-agent`; generated DDL in `mysql/init/`), Mongo 6 (no auth), ES 7.10.1 (empty indices pre-created), Kafka 3.9 KRaft; Milvus optional via `--profile milvus`. Redis runs on the host (no auth).

Run a service locally: `.evimed-local/run/run-local.sh <env-file> <jar> <log>` with per-service env in `.evimed-local/run/`. Hard-won facts: **quote JDBC URLs in env files** (unquoted `&` backgrounds the assignment and silently drops the var); Boot 2.3 fails on mongo `uri` + `host` both set, so the dev ymls of 循证/超说明书/安全性分析 now use a single `spring.data.mongodb.uri: ${MONGODB_URI:...}`; LLM keys come from `.evimed-local/secrets/deepseek.api-key` via `DEEPSEEK_API_KEY` + `EVIMED_LEGACY_LLM_API_KEY(S)`; 循证药品综合评价agent runs on port **18899** locally (8899 taken by another process) with Tavily search gracefully disabled (no key) and a mock upstream WS server in `.evimed-local/acceptance/mock_upstream/`. Acceptance artifacts live in `.evimed-local/acceptance/`.

## 项目代码/ — Java services (Spring Cloud)

Five Spring Boot services that together perform evidence-based drug evaluation. They register with a shared **Eureka** registry and call each other over **OpenFeign**, and share **Kafka**, **Elasticsearch** (Aliyun), **MongoDB** (db `evimed_new`), and **Redis**. The four REST services are layered `controller → service(impl) → mapper/feign` and export reports with **EasyExcel, POI-ooxml, iText, html2pdf** (plus Aspose Words in two services — see below). LLM providers: DeepSeek, Qwen via Alibaba DashScope, Baidu ERNIE, Tavily search.

| Dir | Purpose | JDK | Boot | Port (profile) | Entry class | Maven |
|---|---|---|---|---|---|---|
| `循证药品综合评价/` | Core evidence-evaluation monolith (HTA, trials, guidelines, labels, reports) | 8 | 2.3.5 | 8023 (release) | `com.sentum.evidencecomprehensive.EvidenceBasedApplication` | `./mvnw` |
| `循证药品综合评价agent/` | Spring AI agent companion (ReAct QA, plan-execute reports, deep research) | 21 | 3.5.6 | 8899 (release) | `com.evimed.agent.evidence.agentevidencebased.AgentEvidenceBasedApplication` | `mvn` |
| `药品遴选/` | Drug/formulary selection scoring + report generation | 8 | via parent¹ | 2089 (dev) | `com.sentum.EvaluationApplication` | `mvn` |
| `超说明书用药/` | Off-label-use evidence retrieval + evaluation reports | 8 | 2.3.5 | 8022 (release) | `com.sentum.evidencecomprehensive.EvidenceChaoApplication` | `./mvnw` |
| `安全性分析/` | Pharmacovigilance — FAERS adverse-event signals + alerts | 8 | 2.3.5 | 2088 (release) | `com.sentum.drugsafe.PharmacovigilanceApplication` | `mvn` |

¹ `药品遴选` inherits from an **external parent pom `com.evimed:parent:1.0.0`** (not in the repo — must be resolvable from a private repo to build; dependency versions imply Boot 2.3.x).

### Build / run / test (from inside a service dir)

Use `./mvnw` where it exists (`循证药品综合评价`, `超说明书用药`); otherwise your system `mvn` (Maven ≥3.9). **Match the JDK** — four services are Java 8, only `循证药品综合评价agent` is Java 21.

```bash
./mvnw clean package                                       # build (tests skipped by default — see note)
./mvnw spring-boot:run                                      # run in place
java -jar target/<artifact>-0.0.1-SNAPSHOT.jar             # run the packaged jar
./mvnw test -DskipTests=false                               # actually run tests
./mvnw test -DskipTests=false -Dtest=SomeTest#someMethod   # run a single test
```

- **The four Java-8 services configure Surefire with `skipTests=true`**, so a plain `mvn test`/`package` runs no tests; pass `-DskipTests=false` to run them. `循证药品综合评价agent` has **no** such surefire config.
- **Only `药品遴选` and `安全性分析` use system-scope Aspose jars** (`src/main/resources/lib/aspose-words-21.11-jdk17.jar`, used by their `WordToPdfUtil`; `includeSystemScope=true` is set for the runnable jar). `循证药品综合评价`'s root `lib/` holds Aspose jars that are **not referenced** by its pom or code; `超说明书用药`'s `lib/` is empty.
- `安全性分析` uses **Log4j2** (Logback is excluded); config is `log4j2.xml` and it writes to `安全性分析/logs/`.
- No service ships a Dockerfile or deploy scripts.

### Configuration & external services

- `application.yml` only selects the active Spring profile; real config lives in `application-{dev,test,release}.yml` (the core service also has `-windows.yml`; the agent service has only `-dev`/`-release`). Confirm the active profile before assuming a port or host — currently `药品遴选` runs `dev`, the other four run `release`.
- Running a service for real requires its backing infra up: **Eureka, MongoDB, Redis, Elasticsearch, Kafka**, plus **MySQL** (db `xunzheng`, MyBatis-Plus) for `循证药品综合评价` and `超说明书用药` only, and **Milvus** (SDK in the core and agent poms) for vector retrieval.
- `循证药品综合评价agent` has **no REST controllers** — it is driven by a Netty **WebSocket client** (`UPSTREAM_WEBSOCKET_URL`), uses MySQL db `evimed-evidence-agent` (no Kafka/Mongo), DashScope (`qwen-plus`, embedding `text-embedding-v4`) and Tavily MCP. Its **pgvector autoconfiguration is explicitly excluded** — RAG currently disabled.
- Known pom quirks: `超说明书用药` and `安全性分析` pull the `eureka-server` dependency while registering as clients (`@EnableEurekaClient`); `药品遴选`'s eureka dependency comes from its external parent.

### The two `循证药品综合评价*` services are not a fork

`循证药品综合评价` (Java 8 / Boot 2.3, package `com.sentum.evidencecomprehensive`) is the mature REST platform. `循证药品综合评价agent` (Java 21 / Boot 3.5, package `com.evimed.agent.evidence`) is a separate modern **Spring AI** service driven over WebSocket. An `AgentDispatcher` routes to agent implementations — `medicalqa`, `report`, `deepresearch`, `evidencereport`, `generalresearch` — keyed by `AgentType` (MEDICAL_QA=1, FILE_UPLOAD=2, PPT=3, DEEP_RESEARCH=4, KB_EVIDENCE_REPORT=5, DRUG_SAFETY=6). DRUG_SAFETY routes ADR/pharmacovigilance questions to a `DrugSafetyAgent` that calls the `药物安全分析agent` Python service (`DRUG_SAFETY_AGENT_URL`, default `http://localhost:6010`); LLM classification handles it when `agent.classification.force-kb=false`. They share infra but no code.

## 项目代码/ — Python AI agents

Each agent is an independent Python project with its own `requirements.txt`, `start.py` (FastAPI/uvicorn entry for the platform-facing service), and `tests/`. Several have a CLI mode (`python -m ...`) for local runs. They mostly talk to **DeepSeek** (OpenAI-compatible API, V4 Flash/Pro two-tier routing) and write artifacts under their own `output/` or `outputs/`. Read each agent's own `README.md` / `CLAUDE.md` / `AGENTS.md` before changing it — this section is the orientation only.

Platform integration is the same across the five service agents: an **outbound WebSocket** to the Java side (`JAVA_WS_URL`, default `wss://evidence-factory.evimed.com/ws/ws`) plus **Aliyun OSS report upload via oss2**; `孟德尔随机化/`, `论文审稿/`, `文献剂量分析/`, and `科研选题/` additionally ship an `evimed_runner.py` "fixed-argument EviMed adapter" CLI (request.json → result.json).

| Dir | Purpose | Entry | Default port | Docs |
|---|---|---|---|---|
| `meta/` | **MetaAgent** — automated systematic-review / meta-analysis manuscript generator. Five-layer arch in `new_meta/` (`agents/` LLM · `engines/` deterministic numpy/scipy stats · `schemas/` Pydantic v2 · `core/` infra · `tools/` PubMed/PDF). All math is deterministic; LLM never does statistics. | `python -m new_meta.main --topic "..."` (CLI; also `metaagent` console script) · `python start.py` (FastAPI prod server) | 8002 | `meta/AGENTS.md`, `meta/CLAUDE.md`, `meta/README.md` |
| `孟德尔随机化/` | Mendelian Randomization analysis agent (`mr_agent/` package). **Requires R** (`r_scripts/` + local `.r-lib/`). | `python start.py` | 8003 | `孟德尔随机化/README.md` |
| `论文审稿/` | Plan-Retrieve-Argue peer-review system; advertises 11 international checklists (CONSORT/PRISMA/STROBE/TRIPOD-AI/STARD/CARE/ARRIVE/COREQ/CHEERS/GRADE/Universal); `src/rubrics/` actually ships 15 YAMLs. | `python -m src.main <pdf>` (CLI) · `python start.py` (FastAPI) | 6009 | `论文审稿/README.md` |
| `文献剂量分析/` | **AI-driven bibliometric analysis** (PubMed → cleaning → network analysis → CiteSpace-style reproduction → insight → report). *Name is historical — this is bibliometrics, not dosing.* | `python start.py` (FastAPI) · `PYTHONPATH=src python3 -m bibliometric analyze "topic" ...` (CLI, `src/bibliometric/cli.py`) | 6066 | `文献剂量分析/CLAUDE.md`, `文献剂量分析/FRONTEND_DEV_GUIDE.md` |
| `科研选题/` | Research-topic strategic analysis agent V5.1 — M1–M6 modules (problem landscape, ecosystem, evidence, contradictions, breakthroughs, agenda). | `python start.py` | 6008 (see note) | `科研选题/README.md` |
| `药物安全分析agent/` | **Drug-safety (pharmacovigilance) agent** — rebuild of the Java `安全性分析` service. `safety_agent/` package: openFDA client (primary data source) · deterministic signals (ROR/PRR/χ²/IC/EBGM, numpy/pandas — LLM never does statistics) · DeepSeek interpretation · FAERS safety reports (md/docx/pdf). FastAPI REST + outbound WS (`drug-safety-analysis`) + `evimed_runner.py`. | `python start.py` (FastAPI+WS) · `python evimed_runner.py --request <json> --output-dir <dir>` | 6010 | `药物安全分析agent/README.md` |
| `scientific-agent-skills-main/` | Third-party "scientific agent skills" library (K-Dense v2.53.0) — ~149 vendored skill packages under `skills/`. Not a service; pyproject-only (Python ≥3.13), no `requirements.txt`. | `scan_skills.py` / `scan_pr_skills.py` | — | `scientific-agent-skills-main/README.md` |

Common run / test pattern across Python agents:

```bash
pip install -r requirements.txt
python start.py                      # FastAPI service; port per table above
python -m pytest tests/ -q           # tests (meta also has script-style tests run as `python tests/test_deep.py`)
```

Per-agent caveats:

- `meta/`: also has `pyproject.toml` (Python ≥3.10,<3.13), `uv.lock`, `.venv/`, and `Dockerfile.evimed`. Tests are mixed — a pytest suite **plus** script-style `tests/test_deep.py` / `tests/test_e2e.py` run directly with `python`. Its git repo tracks only `.env.example` (no real keys); `start.py` optionally reads `.env` then `deploy.env` at runtime.
- `文献剂量分析/`: **three** requirements files — `requirements.txt` (core), `requirements_ws.txt` (FastAPI service deps), `requirement.txt` (full pinned freeze). Virtualenv is `.venv/`; its `CLAUDE.md` run instructions contain a stale absolute path — trust `start.py` / `src/bibliometric/cli.py` instead.
- `科研选题/`: port docs are inconsistent — `start.py` defaults to **6008** while the README / `docker-compose.yml` / `config/settings.py` say 8000. **Celery is vestigial**: `docker-compose.yml` defines a worker for `app.celery_app`, a module that does not exist. The README's structure listing is stale; actual services live in `services/` (`internal_db_service.py`, `llm_service.py`, `pubmed_service.py`, `task_service.py`). Has `Dockerfile` + `docker-compose.yml` (api + redis + mongo).
- `论文审稿/`: `src/celery_app.py` / `src/tasks.py` exist but are **not** imported by the API entry; `start.py` warns that `workers>1` needs a Redis-backed job store.

⚠️ Secret-handling note: `文献剂量分析/deploy.env` on disk contains real API keys, and several agents have local `.env` files. They are ignored local-only files in the monorepo. Never add new secrets, never echo existing ones, and flag it if asked to handle them (see "Security notes" below).

## 接口文档/

Three Markdown API specs: `EviMed医学证据检索.md` (evidence retrieval API V1.0), `多模态文档解析.md` (document structure-parsing API), `指南检索.md` (guideline retrieval — a short companion deferring to the evidence-retrieval spec). Update the relevant file when an agent's public contract changes.

## OpenScience/ — AI research workbench

Read `OpenScience/AGENTS.md` first — it is the authoritative rules file (its `CLAUDE.md` is a symlink to it). pnpm monorepo `evimed-science` (Node ≥20, `pnpm@9.4.0`): `apps/desktop` (Tauri + React + Vite, `@ai4s/desktop`), `apps/server` (plain-Node hosted web boundary, `@ai4s/server`), `packages/{sdk,shared}` (`packages/ui` is a README-only placeholder — real primitives live in `apps/desktop/src/components/ui/`), `runtime/` (`harness`, `kernel`, `manager`, `mcp`, `opencode-profile`, `skills`), `deploy/` (`runtime-opencode/`, `web/`). The same React frontend ships as a Tauri desktop app **or** a hosted web app; the UI never calls the agent runtime directly — it goes through `packages/sdk` (`OpenCodeClient`) to a bundled, version-pinned **OpenCode** sidecar (`OPENCODE_VERSION = "1.17.13"` in `packages/sdk/src/types.ts`, fetched by `scripts/dev/fetch-opencode.sh` into `apps/desktop/src-tauri/binaries/`) over HTTP + SSE.

```bash
cd OpenScience
pnpm install
pnpm dev            # desktop frontend (Vite); `pnpm --filter @ai4s/desktop tauri dev` for the full shell
pnpm dev:server     # hosted web / server variant
pnpm build          # build desktop; `pnpm build:web` for the hosted bundle
pnpm typecheck      # tsc --noEmit (desktop)
pnpm lint           # ESLint (desktop)
pnpm check:tauri    # cargo check for the Rust side (apps/desktop/src-tauri)
pnpm test           # desktop unit tests (Vitest)
pnpm test:server    # server tests (node --test)
pnpm test:web       # server tests + typecheck + desktop tests
pnpm ci:web         # full CI pipeline
# single desktop test: pnpm --filter @ai4s/desktop exec vitest run <file> -t "<name>"
# single server test:  node --test test/<file>.test.mjs
```

Also present: ops/release scripts (`audit:*`, `preflight:*`, `release:manifest`, `smoke:deployment`, `configure:*`/`check:*` under `scripts/ops/`), `evals/` (Python eval harnesses), `examples/` (`bci-trends`, `climate-trends`).

Progress convention: append one line per real milestone to `OpenScience/PROGRESS.md` (`YYYY-MM-DD HH:MM · ...`, newest on top); don't add new Markdown docs unless asked.

## 记忆模块/ — Memos (memory store)

Vendored copy of `github.com/usememos/memos` (Go 1.26.2 backend, Echo v5 + ConnectRPC/gRPC-Gateway, + `web/` React 19/TS/Vite frontend), used as the platform's memory store. Its own `记忆模块/AGENTS.md` is authoritative. **Protobuf is the source of truth** — edit `.proto` then regenerate (`proto/gen/` for Go/OpenAPI, `web/src/types/proto/` for TS); never hand-edit generated output. Schema changes need migrations for all three drivers (`store/db/{sqlite,mysql,postgres}/`) plus `LATEST.sql`; new public endpoints must be registered in `server/router/api/v1/acl_config.go`. Production SQLite lives at `.evimed-local/memos/memos_prod.db` (the Memos data dir is pointed there; the file is not under the agent dir).

```bash
cd 记忆模块
go run ./cmd/memos --port 8081        # backend dev server
go test ./...                          # all Go tests (use -race for ./server/... and ./internal/...)
golangci-lint run                      # Go lint (config: .golangci.yaml)
cd web && pnpm install && pnpm dev     # frontend on :3001, proxying API to :8081 (pnpm@11.0.1, Node ≥24)
cd web && pnpm lint && pnpm test       # typecheck + Biome + Vitest
cd web && pnpm release                 # build SPA into ../server/router/frontend/dist
cd proto && buf generate && buf lint   # regenerate + lint proto (Go + TS + OpenAPI)
```

## Security notes

- **Committed secrets exist in Java source**: hardcoded tokens/API keys in `constants/Constants.java` (循证, 超说明书, 安全性分析), `ERNIE_Bot.java` (循证, 超说明书), and `TencentTranSmartApi.java` (安全性分析). The `application-*.yml` files themselves use env-var references with empty defaults, but they do commit infra hosts/URLs.
- **Python agents**: `文献剂量分析/deploy.env` contains real keys; other agents have local `.env` files. All six specialist directories are now independent git submodules. Keep every real `.env`, `deploy.env`, and credential file ignored; only example files may be committed.
- `.evimed-local/secrets/` holds the local DeepSeek key, signing keys, and Memos credentials — never commit, never echo.
- Do not add new secrets anywhere; do not print existing ones into logs, PRs, or chat; if a task requires touching them, flag it to the user first.
