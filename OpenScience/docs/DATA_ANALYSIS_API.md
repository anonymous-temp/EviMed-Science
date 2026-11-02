# Data Analysis API

This versioned interface runs the existing statistical-analysis capability on DeepSeek + DSH. Python/R libraries compute the results. It does not introduce a second agent engine, require a particular statistical method, or certify scientific correctness from a successful run.

## Enable and authenticate

Set `OPEN_SCIENCE_DATA_ANALYSIS_API_ENABLED=true` on a configured EviMed control plane. PostgreSQL product storage, the ordinary model gateway and the DSH runtime must be available. Keep provider keys in the control plane. Existing account, storage and model-spend limits still apply. An analysis's project belongs to this API: it is not listed among the person's projects, does not count against their project ceiling (the per-account analysis limit below does instead), and is removed with `DELETE /analyses/{analysisId}` or with the account.

Create an account API key through the existing authenticated `POST /api/agent-keys` interface with scopes `analysis.read` and `analysis.write`. Keys are returned once and can be revoked through the same account interface. Creating an analysis requires an unbound key; a key bound to the analysis's backing project may access that analysis only. Memory-only keys gain no analysis access. `X-Subject` is not supported.

All data endpoints require `Authorization: Bearer <account-key>`. An offline [OpenAPI contract](data-analysis.openapi.json) is included for integration without starting the server. It is checked against the served schema by a regression test. The enabled service publishes its contract at `/api/data-analysis/v1/openapi.json`. It accepts no browser-cookie fallback or provider key. Error responses use HTTP status plus `{error,code,requestId}`.

Configuration defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPEN_SCIENCE_DATA_ANALYSIS_API_ENABLED` | false | Enable the external interface |
| `OPEN_SCIENCE_DATA_ANALYSIS_MAX_INPUT_BYTES` | 20 MiB | One source input; ordinary platform file limit also applies |
| `OPEN_SCIENCE_DATA_ANALYSIS_MAX_ARTIFACT_BYTES` | 50 MiB | One returned artifact |
| `OPEN_SCIENCE_DATA_ANALYSIS_MAX_SNAPSHOT_BYTES` | 200 MiB | Total preserved input/output bytes per analysis |
| `OPEN_SCIENCE_DATA_ANALYSIS_MAX_DISPATCHES` | 4 | Bounded dedicated admission connections per web process; metadata query pool remains available |
| `OPEN_SCIENCE_DATA_ANALYSIS_INPUTS_IN_FLIGHT_PER_ACCOUNT` | 2 | Inputs one account may have being received or acquired at once, whatever keys it holds; more are refused 429 `analysis_input_busy` |
| `OPEN_SCIENCE_DATA_ANALYSIS_INPUTS_IN_FLIGHT` | 6 | The same for the whole web process. Each in-flight input holds about three times its size in memory (request body, decoded copy, preserved copy), so memory for inputs is bounded by this times three times `MAX_INPUT_BYTES` |
| `OPEN_SCIENCE_DATA_ANALYSIS_MAX_PER_ACCOUNT` | 50 | Analyses one account keeps; creating another is refused 409 `analysis_limit_reached` until one is deleted. A replay of an existing `requestId` is not a new analysis |
| `OPEN_SCIENCE_DATA_ANALYSIS_FETCH_TIMEOUT_MS` | 30000 | Source acquisition deadline |
| `OPEN_SCIENCE_DATA_ANALYSIS_SOURCES_FILE` | empty | Optional server-owned JSON source map |

An analysis supports at most 64 distinct inputs and 128 turns. A snapshot returns at most 64 artifacts. The route admits at most 120 operations per key per minute per web process. The three refusals above are counted on `open_science_data_analysis_refusals_total{reason=input_account|input_server|analysis_limit}`. Limits and partial capture notices are observable; a large file is not silently truncated.

## Create, upload, ask and retrieve

Set `EVIMED_BASE` to the control-plane origin and `EVIMED_ANALYSIS_KEY` through your secret manager. Never put keys into source files or URLs.

```bash
curl --fail-with-body "$EVIMED_BASE/api/data-analysis/v1/analyses" \
  -H "Authorization: Bearer $EVIMED_ANALYSIS_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Heart failure analysis","requestId":"heart-study-001"}'
```

The response is `{data:{id,projectId,...}}`. Save `data.id` as `ANALYSIS_ID`. Each analysis has a dedicated existing project/runtime; it is not a folder inside a shared analysis runtime. Its native project is reserved for this API. Its follow-ups intentionally share one session.

Raw upload preserves bytes without base64 expansion:

```bash
curl --fail-with-body "$EVIMED_BASE/api/data-analysis/v1/analyses/$ANALYSIS_ID/inputs?filename=heart-failure.csv" \
  -H "Authorization: Bearer $EVIMED_ANALYSIS_KEY" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @heart-failure.csv
```

JSON alternatives for that same input route:

```json
{"filename":"cohort.csv","base64":"YSxiCjEsMgo="}
```

```json
{"filename":"cohort.csv","url":"https://data.example.org/cohort.csv"}
```

```json
{"filename":"cohort.json","sourceId":"approved-cohort"}
```

Choose exactly one of `base64`, `url` and `sourceId`. Public URLs must use HTTPS; every redirect and DNS address is checked. Private/link-local destinations are refused. A URL import snapshots the actual response bytes; it is not a live SQL connection or an instruction for the model to fetch credentials. CSV, Excel, JSON and Parquet can be analyzed by installed libraries; receiving a file does not prove its contents support the requested analysis. Input versions carry byte counts, SHA-256 and acquisition provenance (upload, public URL origin/path without query, or configured source ID). They never replace previous snapshots. Signed URL query strings and source credentials are not retained in the receipt.

```bash
curl --fail-with-body "$EVIMED_BASE/api/data-analysis/v1/analyses/$ANALYSIS_ID/turns" \
  -H "Authorization: Bearer $EVIMED_ANALYSIS_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"analysis-001","question":"Describe the cohort and estimate 90-day survival with uncertainty. Return a report, structured results, a survival figure and its plotted data."}'
```

HTTP 202 means the request was admitted, not that analysis passed. Save `data.id` as `TURN_ID` and poll:

```bash
curl --fail-with-body "$EVIMED_BASE/api/data-analysis/v1/analyses/$ANALYSIS_ID/turns/$TURN_ID/results" \
  -H "Authorization: Bearer $EVIMED_ANALYSIS_KEY"
```

A settled turn contains `result.summary`, `result.structuredResults`, `result.artifacts`, `result.notices` and `result.frozenAt`. Structured results may be null when not produced or invalid; the response says so. Artifacts carry `id`, `filename`, `role`, `mediaType`, `bytes`, `sha256` and `downloadUrl`. Roles distinguish tables, figures, reports, code and other data. Follow `downloadUrl` with the same authorization header; downloads are attachments, including HTML/SVG active content. Verify the bytes against the manifest digest. The artifact verification field preserves the platform delivery-check label; it does not establish independent statistical validation or external clinical validity. Never execute a generated script or model pickle merely to preview it.

Use `result.primaryOutput` to locate the selected bundle's manifest, results and report by their full `path`; filenames alone are not unique. Summary and structured results come from the same bundle: one explicitly presented bundle first, otherwise the unique outermost bundle. Nested copies remain downloadable for reproducibility; discovery order cannot replace the chosen result. Multiple explicitly presented bundles or unresolved outermost alternatives return null `primaryOutput` and structured results with `primary_output_ambiguous`; all captured files remain available. A malformed or unavailable selected result does not fall back to a historical result. This is delivery selection, not scientific verification.

```bash
curl --fail-with-body "$EVIMED_BASE/api/data-analysis/v1/analyses/$ANALYSIS_ID/artifacts/$ARTIFACT_ID" \
  -H "Authorization: Bearer $EVIMED_ANALYSIS_KEY" --output downloaded-artifact
```

## Continuation, cancellation and retries

Submit a new question with a new requestId to the same analysis. The same session can use preserved transformations, estimates and fitted state. Correcting labels, adding data, changing units and changing a probability threshold have different downstream effects; the analyst records its choices. Upload new data only while the analysis is idle.

Retry the identical requestId and payload after an interrupted HTTP response. It returns the same analysis/turn. Reusing that identifier with different content returns 409. A second writer to a busy analysis returns a conflict; different analyses use distinct workspaces.

`POST /analyses/{analysisId}/turns/{turnId}/cancel` requests cancellation. Poll until the actual runtime settles. If a request stopped during preparation before any dispatch, cancellation fences that preparation and a new requestId may start again. A crash before the run ledger reservation can recover by retrying the same requestId: a dedicated PostgreSQL admission lock reconciles the readable ledger and preserves the same dispatch identity. If the ledger is unavailable, or an existing run has unknown prompt acceptance, the reservation stays held rather than silently submitting a second potentially billable task. Query the same turn; do not automatically retry under new identifiers.

Completed output bytes are frozen before another turn is admitted. Historical artifact IDs keep their original bytes when later code overwrites a workspace filename. A file that cannot be preserved is listed in `result.notices` as `artifact_unavailable` with its `path` and a `reason` (`missing`, `unreadable`, `too_large` for the artifact byte limit, `snapshot_limit` for the analysis's preserved-bytes limit, `not_a_file`, `unsafe_path`), and every other file, the summary and the structured results are returned: a limit never blocks the poll or the next turn. Only a fault of the preserved-bytes storage itself answers the turn with the notice `snapshot_retry_required` and keeps the reservation, so the next poll captures again and a later turn cannot overwrite the unfrozen outputs. Only files the run declared as its outputs carry its `verified` label; other files it wrote while working are listed as `unverified`. Failed/cancelled runs preserve available artifacts as unverified partial results. The original source snapshots are controller-owned and are restored before each turn.

`DELETE /analyses/{analysisId}` (scope `analysis.write`; a key bound to the analysis's project may delete that analysis) removes one analysis whole: it stops a turn that is still running, then deletes the backing project with its inputs, turns, results, memory and preserved bytes, and answers `{data:{id,deleted:true}}`. Deleted bytes cannot be recovered, and the same `requestId` afterwards creates a new analysis. Generic project deletion, archival and renaming through the ordinary project routes remain refused for these projects. Account deletion removes all of an account's analyses, including the preserved bytes kept outside its project data.

## Configured source example

The operator may provide a JSON source map outside the repository:

```json
{
  "approved-cohort": {
    "url": "https://research.example.org/api/cohort/export",
    "accountIds": ["authorized-account-id"],
    "credentialFile": "/run/secrets/cohort-authorization"
  }
}
```

The credential file contains the complete Authorization header value (for example a bearer credential) and is readable only by the control plane. It never enters the model prompt or runtime. A redirect to another origin drops it permanently. Callers cannot override the endpoint, add arbitrary headers or grant themselves access. This supports authorized HTTP export APIs; arbitrary database queries and private-network connectors are not exposed by this version.

## Verification boundary

The companion evaluation under `evals/statistical-analysis/api/` separates API behavior, deterministic numerical checks, real model behavior, visual/artifact checks and local-only dataset inspections. Public development datasets do not establish external clinical validity. Production deployment and account/source configuration are separate from committing this interface.
