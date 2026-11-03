# Data analysis API and scientific acceptance

Date: 2026-11-02. Owner authorization: research, design, implement, test, commit and push; no deployment. Baseline: a039ae886. Existing research-tools work continues in another worktree.

## Decision

Keep DeepSeek + DSH, the statistical-analysis capability, native Python/R, the existing project runtime, run ledger, skills, artifact storage and model gateway. Choose a thin in-process API facade over a new statistics service or a second agent orchestrator. A new service would duplicate authentication, execution, cancellation and accounting; exposing generic project routes alone would leave ownership and reproducible results ambiguous.

The API's durable analysis is one dedicated existing project and one continuing session. Different analyses have separate runtime workspaces. Turns within one analysis serialize. A control-plane-owned workspace policy must apply to API and ordinary/native dispatch so opening a second session cannot undermine isolation. The same analysis is intentionally shared across its follow-ups. Existing unrelated projects are unchanged.

## Interface

Base path `/api/data-analysis/v1`. Reuse account API keys with explicit `analysis.read` and `analysis.write` scopes, owner/project restrictions and revocation. Never accept provider credentials or arbitrary filesystem paths. Browser access, if included, uses existing authenticated/CSRF-checked identity, not a second identity system.

- `POST /analyses`: create a named dedicated analysis project/session. Support a client request identifier with idempotent retries.
- `GET /analyses/{id}`: identity, input versions, state and turn links.
- `POST /analyses/{id}/inputs`: JSON base64 file, public HTTPS URL, or configured source ID. Raw file upload must also be supported and documented with curl/Python. Each immutable input has a content digest, bounded size, safe filename and acquisition status. URL fetching reuses DNS-pinned public-fetch security, size/deadline limits and redirect checks. Configured HTTP data sources bind exact endpoints and control-plane credential files; never send those credentials to the model. No arbitrary SQL or private-network URL from a caller.
- `POST /analyses/{id}/turns`: question and request ID; create the ordinary statistical-analysis run and return 202 plus its ID. A repeated request returns its original result; a conflicting reuse returns 409. Follow-ups reuse the same session and inputs. Inputs cannot mutate during active execution.
- `GET /analyses/{id}/turns/{turnId}` and `/results`: progress, status, notices, summary, bounded structured results and an output manifest with tables, figures, reports and reproducible code.
- `POST /analyses/{id}/turns/{turnId}/cancel`: existing cancellation path.
- `GET /analyses/{id}/artifacts/{artifactId}`: owner-checked download of an immutable turn snapshot. Response includes media type, size and digest. No model-supplied URL or pathname grants access.
- Publish OpenAPI and runnable examples. Error codes and feature configuration are explicit.

Durability uses ProductDocuments/CAS and existing run reservation locks. Reserve before dispatch and recover unknown/failed attempts without silently charging a second run. Output capture must complete before another turn may overwrite files; capture failures remain visible and retryable. Preserve useful partial results. No new clinical approval or delivery gate.

## Analyst configuration

Keep instructions short and task-proportional. Inspect actual data and dictionaries, distinguish subject from observation, fit preprocessing on training folds, preserve missingness and censoring, choose suitable installed methods, execute before reporting, distinguish uncertainty from proof, and retain partial work. When charts/tables are requested, write their actual files and associated plotted data; use headless plotting and valid labels/units. Return structured results plus figures/tables/code; missing structured output is explicit, never fabricated. Reuse recorded estimates/model probabilities on unit or threshold-only follow-ups.

Advanced methods remain available through installed libraries and skills; support claims require cases, not an algorithm inventory. Do not force every task through all methods.

## Evidence and tests

Research basis: BixBench/BixBench3 (multi-step biological artifacts), BLADE (semantics and valid alternative analyses), Data Interpreter (dependency-aware execution), SciVisAgentBench (visualization verification), Hex and Julius (connected sources, conversation and downloadable outputs). Sources are retained in `_knowledge_base/research-data-analysis-api-20261102.md`.

Test independent dimensions: execution, numerical agreement, semantic interpretation, figures and plotted data, input provenance, continuation reuse, cancellation, concurrent isolation, restart, auth/revocation and SSRF/path traversal. Use public WDBC/lung/UCI heart-failure data, additional licensed public datasets and local aggregate-only schema/missingness checks. Never copy private patient rows into git or send them to a model. Preserve failures; label public-data development acceptance separately from general reliability.

Run real DeepSeek/DSH through an isolated candidate Linux environment using the built image, with provider keys only in the control plane, independent scratch/database, learning disabled, bounded tasks and account cleanup. No production state changes. Host and Docker VM have limited disk; reuse existing images/dependencies and bounded fixtures.

## Completion

Scoped suites, server/domain lint and typecheck, real API/model cases and independently checked artifacts; no unresolved material review finding. Commit/push the isolated branch and verify the remote SHA. Report exact test evidence and remaining limits without calling local validation deployment.
