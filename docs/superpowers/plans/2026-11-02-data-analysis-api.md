# Data Analysis API Implementation Plan

> For agentic workers: use subagent-driven-development for implementation and independent specification/code reviews; keep one implementation worker at a time and explicit file ownership.

**Goal:** expose and verify the existing DeepSeek/DSH analyst through a durable, isolated data-analysis API with real downloadable results.
**Architecture:** reuse one existing project/runtime per analysis, one continuing session, existing account API keys and run ledger. Add bounded data acquisition and immutable result snapshots, not another agent engine.
**Tech Stack:** Node ESM/checkJs, PostgreSQL ProductDocuments, DSH, Python/R, existing numerical libraries, Node tests/pytest.

## Task 1: API facade and execution boundaries

Files: new `OpenScience/apps/server/src/dataAnalysis*.mjs` and corresponding `test/dataAnalysis*.test.mjs`; narrow wiring in `server.mjs`, scopes in `agentApiKeys.mjs`, kinds in `productPersistence.mjs`, documented config in `config.mjs`/`.env.example`; shared reservation isolation if needed in `agentRuns.mjs`.

- [x] Write failing behavior tests for scope/ownership, create/input/turn/result/download lifecycle, idempotent retry and conflicts, active-turn upload refusal, concurrent turns/analyses, invalid paths and URL redirects/private DNS, missing outputs, cancellation and restart.
- [x] Implement dependency-injected facade around `createResearcherProject`, `writeProjectUpload`, `dispatchChannelRun`, run refresh/cancel, ProductDocuments CAS and no-follow files. Extend dispatch options with explicit unattended/automated semantics while preserving existing callers.
- [x] Make turn artifact snapshots durable before continuation; test historical bytes survive later changes. Restrict artifact lookup to the saved manifest.
- [x] Supply raw upload and JSON inputs, HTTPS import and configured HTTP-source references without exposing credentials. Keep exact provenance and digest.
- [x] Add OpenAPI/executable examples and configuration with tests holding routes/schema consistent.
- [x] Run focused tests, server lint/typecheck and independent spec/security/code review; resolve all findings.

Behavior contract examples:
```js
assert.equal((await api('POST', '/analyses', {name:'Cohort', requestId:'create-1'})).status, 201);
assert.equal((await api('POST', '/analyses', {name:'Different', requestId:'create-1'})).status, 409);
// Upload the fixture using binary bytes and a safe filename, then ask a question.
const started = await api('POST', `/analyses/${id}/turns`, {requestId:'turn-1', question:'Compare the two groups and return a plot.'});
assert.equal(started.status, 202);
assert.equal((await api('POST', `/analyses/${id}/turns`, {requestId:'turn-1', question:'Compare the two groups and return a plot.'})).body.data.id, started.body.data.id);
```

## Task 2: Analyst result and chart delivery

Files: `capabilities/statistical-analysis/SKILL.md`, mirrored skill and scripts only where a repeatable defect needs code, capability metadata/generated consumers, numerical/artifact tests.

- [x] Reproduce observed assumption overinterpretation and weak/missing figure/result delivery in natural cases.
- [x] Add proportional instructions and a small optional output manifest helper if needed; no rigid algorithm workflow or gate.
- [x] Test real figures are readable and their plotted values equal preserved numerical data. Test code/report/result continuity and missing/failed optional calculations remain visible.
- [x] Run Python reference suite and copy/manifest checks; review changes.

## Task 3: Public and local data acceptance

Files: `evals/statistical-analysis/api/` dataset manifests, acquisition and API driver/judge scripts, focused tests, compact results/evidence README. Private rows and raw model traces remain in gitignored local storage.

- [x] Acquire small licensed fixtures with immutable hashes and source citations; reuse WDBC/lung, add heart-failure and longitudinal/missingness/format controls.
- [x] Run numerical controls and local aggregate-only tests on discovered deidentified tables; test CSV/Excel/JSON/Parquet as supported by actual runtime.
- [x] Run real candidate API cases: comparison+chart, survival+censoring, leakage-aware prediction, guided correction, unit reuse, threshold reuse, paired/missingness/format controls, concurrent distinct analyses, cancel/retry and artifact download. A new-patient supplement continuation and general longitudinal modeling are not claimed accepted by this pass.
- [x] Judge independently against source data and reference libraries; preserve all attempts and failures, fix actual defects and rerun affected cases.

## Task 4: Delivery

- [x] Update API docs and PROGRESS with measured evidence and configured boundaries.
- [x] Final independent specification, code/security and scientific review; resolve implementation findings and retain generated-report interpretation limitations in the acceptance ledger.
- [x] Run required local checks and inspect the prepared commit for credentials/private data; publish on `codex/data-analysis-api-20261102` after the evidence ledger closes.
- [x] Separate local/model/CI evidence in the handoff; remote SHA verification is reported after push. Do not deploy or merge.

## Task 1b: Isolated native entry for new catalogue analyses

Decision after tracing GUI compatibility: a fresh statistical-analysis catalogue card allocates an ordinary dedicated project and one allowed native root session; the original DSH composer/file viewer remains the UI. An already populated conversation is never silently moved, since the native tool-picker payload does not transfer attachments. Historical conversations remain accessible in place and are not retrospectively described as isolated.

- [x] Add a small authenticated, idempotent workspace-allocation route and controller-owned ProductDocuments record; reuse project creation/quota/session binding.
- [x] Restrict new dedicated GUI analysis projects to their recorded root session across HTTP/mux and run admission, keeping child execution under that root.
- [x] Update shared catalogue useOpenTool for statistical-analysis only, navigate with explicit project+session; preserve failed-binding retries and other capability behavior.
- [x] Cover catalogue entry, request retry, explicit project selection, second-root refusal/restart and native history compatibility; update DS/DESIGN for the changed entry contract.
- [x] Independently review and run scoped web/server checks before commit.

## Acceptance boundary

See `OpenScience/evals/statistical-analysis/api/results/acceptance.json` for retained successful, failed, cancelled and seeded-delivery attempts. Execution completion is not scientific acceptance. Current unit/threshold reuse, full survival curves, equivalent formats and partial-result capture have bounded independent evidence; residual generated prose and older supplementary-method findings are explicit. Browser catalogue isolation and draft-preserving guard were exercised; the automated native file-chooser step was not verified. Source implementation and integration tests do not establish merge, CI, release-image verification or production deployment.
