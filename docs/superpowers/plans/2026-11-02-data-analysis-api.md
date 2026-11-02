# Data Analysis API Implementation Plan

> For agentic workers: use subagent-driven-development for implementation and independent specification/code reviews; keep one implementation worker at a time and explicit file ownership.

**Goal:** expose and verify the existing DeepSeek/DSH analyst through a durable, isolated data-analysis API with real downloadable results.
**Architecture:** reuse one existing project/runtime per analysis, one continuing session, existing account API keys and run ledger. Add bounded data acquisition and immutable result snapshots, not another agent engine.
**Tech Stack:** Node ESM/checkJs, PostgreSQL ProductDocuments, DSH, Python/R, existing numerical libraries, Node tests/pytest.

## Task 1: API facade and execution boundaries

Files: new `OpenScience/apps/server/src/dataAnalysis*.mjs` and corresponding `test/dataAnalysis*.test.mjs`; narrow wiring in `server.mjs`, scopes in `agentApiKeys.mjs`, kinds in `productPersistence.mjs`, documented config in `config.mjs`/`.env.example`; shared reservation isolation if needed in `agentRuns.mjs`.

- [ ] Write failing behavior tests for scope/ownership, create/input/turn/result/download lifecycle, idempotent retry and conflicts, active-turn upload refusal, concurrent turns/analyses, invalid paths and URL redirects/private DNS, missing outputs, cancellation and restart.
- [ ] Implement dependency-injected facade around `createResearcherProject`, `writeProjectUpload`, `dispatchChannelRun`, run refresh/cancel, ProductDocuments CAS and no-follow files. Extend dispatch options with explicit unattended/automated semantics while preserving existing callers.
- [ ] Make turn artifact snapshots durable before continuation; test historical bytes survive later changes. Restrict artifact lookup to the saved manifest.
- [ ] Supply raw upload and JSON inputs, HTTPS import and configured HTTP-source references without exposing credentials. Keep exact provenance and digest.
- [ ] Add OpenAPI/executable examples and configuration with tests holding routes/schema consistent.
- [ ] Run focused tests, server lint/typecheck and independent spec/security/code review; resolve all findings.

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

- [ ] Reproduce observed assumption overinterpretation and weak/missing figure/result delivery in natural cases.
- [ ] Add proportional instructions and a small optional output manifest helper if needed; no rigid algorithm workflow or gate.
- [ ] Test real figures are readable and their plotted values equal preserved numerical data. Test code/report/result continuity and missing/failed optional calculations remain visible.
- [ ] Run Python reference suite and copy/manifest checks; review changes.

## Task 3: Public and local data acceptance

Files: `evals/statistical-analysis/api/` dataset manifests, acquisition and API driver/judge scripts, focused tests, compact results/evidence README. Private rows and raw model traces remain in gitignored local storage.

- [ ] Acquire small licensed fixtures with immutable hashes and source citations; reuse WDBC/lung, add heart-failure and longitudinal/missingness/format controls.
- [ ] Run numerical controls and local aggregate-only tests on discovered deidentified tables; test CSV/Excel/JSON/Parquet as supported by actual runtime.
- [ ] Run real candidate API cases: comparison+chart, survival+censoring, leakage-aware prediction, correction, unit reuse, threshold reuse, added patients, repeated measures/missingness, concurrent distinct analyses, cancel/retry and artifact download.
- [ ] Judge independently against source data and reference libraries; preserve all attempts and failures, fix actual defects and rerun affected cases.

## Task 4: Delivery

- [ ] Update API docs and PROGRESS with measured evidence and configured boundaries.
- [ ] Final independent specification, code/security and scientific review; resolve findings.
- [ ] Run required checks, inspect diff for credentials/private data, commit and push `codex/data-analysis-api-20261102`.
- [ ] Verify remote SHA and report local/model/CI evidence separately. Do not deploy or merge.
