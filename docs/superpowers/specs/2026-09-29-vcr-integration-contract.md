# 虚拟临研 · 集成契约（2026-09-29，合并前修复）

The merge review of 2026-09-29 (six independent reviewers) found the module's parts individually
careful and its seams unconnected: the browser read shapes the server never sends, the orchestrator
built engine jobs the engine cannot read, the engine `eval()`ed strings from job scenarios, snapshot
inputs were taken from the caller, and small-cell suppression walked one shape nothing produces.
This document fixes the seams once. Every fix in the merge-repair waves builds to it; where a fix
needs a seam this document does not define, the controller rules and amends this file — a package
never invents a private shape.

Code, comments and commits are English. The plan (`2026-09-28-EviMed虚拟临研平台方案.md`) stays
authoritative on product decisions; the build contract (`2026-09-28-vcr-build-contract.md` §9) holds
the build-time rulings; this file holds the integration rulings. Where they disagree, this file wins.

## 1. Scope of this merge

- **In:** plan phase 1 and phase 2 (§13.2) — the T0 chain end to end on the real engine; real data
  intake (source → snapshot → field map → analysis tables → grants → seal) through routes; members
  and roles; matching and referral with the per-person contact stop; evidence parameterization
  with verified extractions; recompute after change; every human stop reachable from the UI.
- **Out, recorded not hidden:** phase 3 (partner sample, AC-36/37 on real partner data); the live
  DSH + DeepSeek acceptance run of each capability and the timed T0 run (AC-35) — both run at release
  time against a deployed stack and are recorded `not-run` in `evals/acceptance-ledger.json` until
  then; the separate compute node.

## 2. Two closed rule grammars (no code from data, ever)

Nothing in a job, a scenario, a criterion or a constraint is ever parsed as code. `eval`, `parse`,
`str2lang` over job data, `Function(...)`, `new Function` and their equivalents are forbidden in the
engine and the control plane. Both grammars live once in `@evimed/domain` (`vcrRules.mjs`), are
exported into `R/domain-snapshot.json` (limits and vocabularies), are validated on both sides, and
share a parity fixture file `packages/domain/test/fixtures/vcr-row-rules.json` that the domain test
and an engine numeric case both run.

### 2.1 Row rules — over table columns (cohort rules, population constraints, quality criteria)

```
RowRule :=
    { "op": "all" | "any", "operands": [RowRule, …] }          1–32 operands
  | { "op": "not", "operand": RowRule }
  | { "op": "compare", "column": Col,
      "comparator": "lt" | "lte" | "gt" | "gte" | "eq" | "ne",
      "value": number | string | boolean }
  | { "op": "between", "column": Col, "low": number, "high": number }     inclusive
  | { "op": "in" | "not_in", "column": Col, "values": [scalar, …] }        1–200 values
  | { "op": "missing" | "present", "column": Col }
Col := ^[A-Za-z_][A-Za-z0-9_.]{0,63}$   and must name a column of the table it runs on
```

- Depth ≤ 8, nodes ≤ 200. Anything else is refused by name: `rule_op_unknown`, `rule_shape_invalid`,
  `rule_too_deep`, `rule_too_large`, `rule_column_unknown` (the column check happens where the
  table is known — the engine — and names the column).
- Three-valued: a missing value in a compared column yields NA (「无法判断」) for `compare`,
  `between`, `in`, `not_in`; `missing`/`present` never yield NA; `all`/`any`/`not` are Kleene.
- Named in scenarios as `{ "name": string(1–80), "rule": RowRule }`. A scenario carrying an
  `expression` field anywhere is refused (`rule_expression_forbidden`).
- Cohort waterfall step: kept = TRUE, excluded = FALSE, indeterminate = NA. Population constraint:
  a row violates it when the rule is FALSE; generation enforces by rejection-resampling up to a cap
  and reports what it could not satisfy (never silently counts only).

### 2.2 Eligibility requirements — over dated facts (matching)

The evaluator in `apps/server/src/vcrMatching.mjs` already reads this; the domain now validates it,
the protocol skill teaches it, and the gateway refuses anything else at write time
(`vcr_criterion_malformed`, per item, the rest written).

```
Req :=
    { "op": "all" | "any", "operands": [Req, …] }
  | { "op": "not", "operand": Req }
  | { "op": "present" | "absent", "variable": Var, "window"?: Window }
  | { "op": "compare", "variable": Var,
      "comparator": "lt"|"lte"|"gt"|"gte"|"eq"|"ne"|"between"|"in"|"not_in",
      "value": number | string | [scalar, …], "highValue"?: number, "unit"?: string,
      "window"?: Window, "aggregate"?: "latest" | "all" | "any" }
  | { "op": "elapsed_since", "variable": Var, "days": integer 1–3650,
      "comparator"?: "gte" | "gt", "deniedSatisfies"?: boolean }
  | { "op": "language", "text": string 1–500, "key"?: ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$ }
Window := exactly one of { "days": 1–36500 }, { "months": 1–1200 }, { "years": 1–100 },
          optionally with "anchorDate": ISO date (the window runs back from it instead of from now)
Var    := ^[a-z][a-z0-9_]{0,63}$
```

(Amended 2026-09-29 after wave A: `years`, `anchorDate`, the washout `comparator`, `deniedSatisfies`
and the language `key` are the evaluator's own knobs, each with a clinical meaning — a washout that a
documented 「从未接受过」 does not satisfy, a window measured back from a named date.)

Numeric comparators need a finite numeric `value` (`between` also a `highValue` ≥ `value`);
`in`/`not_in` need an array. A fact without a unit is `unknown` against a criterion that names one;
an undated fact never decides a windowed comparison; a coded value the criterion's vocabulary does
not contain is `unknown` (`coding_unmapped`) — the evaluator returns UNKNOWN for anything outside
the grammar as defence in depth.

## 3. The engine job contract

### 3.1 One scenario schema per method

`packages/domain/src/vcrEngineJob.mjs` gains `VCR_SCENARIO_SCHEMAS`: for each of the 24 methods, the
exact keys the R handler reads (derived from `项目代码/vcr-engine/R/engine.R` and the files it
calls, not from memory), with type, range, required/optional, default and unit; plus the
`kind ↔ method` pairing table. `validateEngineJob` (JS) and `vcr_validate_job` (R, reading the
schemas from `domain-snapshot.json`) both refuse:

- an unknown key anywhere in the scenario — `scenario_field_unknown` with its path;
- a missing required key — `scenario_field_missing`;
- a value of the wrong type or out of range — `scenario_value_invalid`;
- an endpoint type the method does not list — `endpoint_not_supported`;
- a design × endpoint the engine does not implement — `design_not_supported` (never silently run as
  something else);
- a `kind`/`method` pair that is not in the table — `kind_method_mismatch`.

Fixed spellings (one each, everywhere — control plane, tool, skill, engine):

- `truth.null` (boolean, optional). When absent, null is derived from the effect values by
  `vcrIsNullScenario(scenario)` in the domain, mirrored in R. The replicate floor uses it.
- `accrual.dropoutAnnual` — the one dropout parameter (proportion per 12 time units), read by both
  the analytic and the simulated paths. `dropoutRate` is removed.
- `analysis.alpha` is the total alpha; `analysis.sided ∈ {1, 2}`; a two-sided analysis spends
  `alpha/2` per tail in every path (fixed, sequential, analytic, simulated, confidence intervals).
- `performance` is optional; absent or empty means every measure the method defines.
- Evidence pooling studies are `{ studyId, estimate, se }` on the analysis scale, plus optional
  `ciLow`, `ciHigh`, `level` from which the control plane derives `se` before queueing; the engine
  never receives natural-scale values it must transform. `method` and `level` are scenario keys.

`vcrIsNullScenario`, the schemas and the pairing table are exported into `domain-snapshot.json`;
case N00 keeps the snapshot byte-identical to the live exports.

### 3.2 Inputs: only the control plane builds a patient-level input

- A caller (browser route, runtime gateway, orchestrator) names patient-level data only as
  `{ "kind": "snapshot", "id": "<snapshotId>" }`. A `location`, `hash` or `shape` supplied by a
  caller is refused (`input_location_forbidden`).
- `VcrJobs.enqueue` resolves every such input: the snapshot must belong to the job's study
  (else 404), `access.require({ ability: "read_patient_level", snapshotId, fields, purpose })` must
  allow it for the acting principal (the study owner for orchestrator/runtime jobs), and the input
  becomes one or more engine inputs `{ kind: "analysis_table", id: "<snapshotId>:<shape>", shape:
  "subject" | "longitudinal" | "events" (the domain's `VCR_ANALYSIS_TABLES` spelling), location, hash }` — or, for the snapshot profiler and cohort build
  on raw files, `{ kind: "snapshot_file", id: "<snapshotId>:<n>", location, hash }` — with
  `location` relative to the data-plane root and `hash` the sha256 of exactly that file.
- The engine opens `VCR_ENGINE_DATA_ROOT/<location>` only: absolute paths, `..`, symlinks and
  anything outside the root are refused (`input_location_invalid`); a location without a hash is
  refused (`input_hash_missing`); the bytes are read once, hashed, and parsed from memory.
- Every engine input carries `valueSource` (one of the nine value sources) set by the control plane
  from the snapshot or population row it came from — never by a caller. Methods that weigh or compare
  real patients (entropy balance, propensity weighting, MAIC, RMST) accept only the real-patient
  sources `VCR_REAL_PATIENT_SOURCES` (observed, extracted, calculated, imputed — an imputed value in a
  real person's row is still that person); RMST additionally accepts `reconstructed` pseudo-patients
  for the literature-control route and counts them as `reconstructedPseudoPatients`, never
  `realPatients`. Anything else is refused (`input_source_not_individual`).
- Sealed columns are removed before the engine sees the table unless the seal is lifted (§6).

### 3.3 Named outputs other packages read

- Accrual (`accrual.poisson_gamma`): input `sites: [{ id, alpha, beta, startTime, enrolled?,
  exposureTime? }]` (per-site posteriors), `target`, `eventTarget?`, `screenFailure?: { alpha, beta }`;
  output measures `last_patient_in_months` and, when `eventTarget` is given, `target_events_months`,
  each with `interval: { low: p10, high: p90, kind: "prediction" }` and `mcse` when simulated, plus
  `probability_by_month` as a table. `apps/server/src/vcrRecruit.mjs` reads exactly these.
- Pooling (`evidence.pool`): measures `pooled_estimate` (interval kind `confidence`) and, for k ≥ 3,
  `prediction_interval` (interval kind `prediction`), on the analysis scale with `scale` named.

### 3.4 Results

- The result carries `conclusion` at top level (`estimable | limited | not_estimable`) and, when not
  estimable, a `notEstimableRule` from the closed vocabulary; `validateEngineResult` checks both
  against the domain vocabularies, checks `interval.low ≤ high`, `cpuSeconds ≥ 0`, and that every
  simulated measure has `mcse`.
- Each measure carries `source` (one of the nine value sources).
- The result echoes `method`, `methodVersion`, `scenarioHash`, `seed`, `replicates`; the control
  plane refuses a result whose echo differs from the frozen job (`vcr_engine_result_mismatch`) and
  stores the engine's own values in the execution row.
- A `failed` or `canceled` result may carry measures only when it says `conclusion: "limited"` — the
  engine's word for a run cut short by its CPU budget (`cpu_budget_exhausted`) or by a cancel after at
  least one batch. The control plane records exactly that, and nothing else, as a result marked
  `partial` (`diagnostics.partial`, conclusion `limited`); a `failed` result with measures and no
  `limited` is recorded as a failure and its measures are dropped, never believed. A run whose
  replicate count was held below the precision floor by `VCR_ENGINE_MAX_REPLICATES` is `succeeded`
  with `conclusion: "limited"`. A job cancelled while the engine is running it is cancelled at once;
  the engine's partial result is fetched afterwards and recorded under the cancelled job.
- An engine refusal it cannot tie to a job (a malformed identity field) has no echo, no output hash
  and no signature; the client returns it as a refusal carrying the engine's own issue, and the job
  fails with that reason instead of being rejected as a mismatch.
- `manifest.outputHash` = sha256 of the canonical JSON (domain canonicalization) of
  `{ measures, counts, conclusion, notEstimableRule, tables: [{ name, sha256 }] }`; the control
  plane recomputes it. `manifest.signature` = hex HMAC-SHA256(receiptKey,
  `jobId + "\n" + scenarioHash + "\n" + outputHash`). Both sides compute the scenario hash from the
  same canonical bytes: R parses job JSON with `simplifyVector = FALSE` and canonicalizes exactly as
  JS does (null kept, `{}` ≠ `[]`, one-element arrays stay arrays, JS key order).

### 3.5 The engine service

- Secrets from files: `VCR_ENGINE_TOKEN_FILE` and `VCR_ENGINE_RECEIPT_KEY_FILE` (each ≥ 32 bytes,
  opened without following symlinks). The service refuses to start without both unless
  `VCR_ENGINE_INSECURE_DEV=1`. Bearer comparison is constant-time. `/health` needs the token too,
  except a bare liveness `GET /livez` that returns `{"ok":true}` and nothing else.
- Paths: `VCR_ENGINE_WORK_DIR` (default and compose `/jobs`), `VCR_ENGINE_DATA_ROOT` (compose
  `/data-plane`, read-only). A job id is validated against the protocol id pattern and must not
  contain `..`; its directory must resolve to a direct child of the work dir before anything is
  created or deleted.
- Limits: `VCR_ENGINE_CPU_SECONDS` (default per job), `VCR_ENGINE_MAX_CPU_SECONDS`,
  `VCR_ENGINE_CORES` (a job's `cores` can lower it, never raise it), `VCR_ENGINE_MAX_REPLICATES`
  (default 200000), `VCR_ENGINE_MEMORY_BYTES` (RLIMIT_AS). The R-side CPU budget stops at 0.9 of the
  kernel limit so a job ends with its partial result instead of SIGXCPU; cancel kills the process
  group; the R child gets no secret in its environment.
- Control-plane config: `OPEN_SCIENCE_VCR_ENGINE_TOKEN_FILE`, `OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_FILE`
  (read like the platform's other key files); with the engine URL set and either file absent, the
  module reports the engine unconfigured in readiness and the engine client refuses to call.
- Compose: the engine sits on an `internal: true` network shared only with `open-science-web`,
  behind a `vcr` profile, with `/jobs` a named volume owned by uid 10001 and the data-plane host
  directory bound read-only; `open-science-web` binds the same host directory read-write at the same
  path; `deploy/web/Dockerfile` copies `scripts/vcr`.

## 4. Counts the model may see

`packages/domain/src/vcrVocabulary.mjs` exports `VCR_PEOPLE_COUNT_FIELDS` — the keys that count
people: `n, count, patients, realPatients, subjects, events, kept, excluded, indeterminate,
cohortSize, screened, eligible, enrolled, referred, contacted, candidates` (extend only here).
`suppressForModel(payload, { minCell })` in the domain:

- walks every object and array without a depth cap on correctness (cycles refused);
- in an array of sibling cells, hides the small cells (0 counts as disclosive) together with the
  next-smallest until the hidden group holds ≥ `minCell` people in ≥ 2 cells, as build ruling §9.1
  says: hidden cells keep their identity and lose every number (amended after wave A — the domain
  implements the ruling, not a merged bucket row);
- a scalar people-count in [1, minCell − 1] outside such an array becomes `null`, and the object
  that held it gains `suppressed: [<key>, …]`;
- a cell with several count keys is judged by its smallest;
- `suppressedCount`-style complements are never emitted.

It is applied at exactly one boundary: everything the runtime can read (`VcrService.runtimeRead`
for every `what`, the `simulate`/`evidence_pool` status answers, the snapshot profile). Pages a
study member reads show exact counts. The engine never emits an exact complement of a hidden level.

## 5. The browser ↔ server page contract

- The server owns presentation: `apps/server/src/vcrViews.mjs` maps stored rows to exactly the page
  types the web reads (`apps/web/src/lib/vcrClient.ts`: `VcrStudy`, `VcrStudySummary`, each
  `Vcr*Tab`, `VcrModels`, `VcrDeliverable`, `VcrPrecedent`). Every number shown is a `VcrValue`
  `{ value, source, interval: { low, high, kind } | null, mcse, review, stale }`.
- One JSON fixture per page shape lives in `apps/server/test/fixtures/vcr-views/`. The server test
  builds a seeded study through the real store and service and asserts the presenter output equals
  the fixture; the web tests read the same files through the real `vcrClient` readers with only
  `productRequest` mocked, and render the real components from them. A shape change is a fixture
  change on both sides in one commit.
- Every browser write body is exactly a route's allow-list; `vcrRoutes.test.mjs` posts each client
  body builder's output to the real routes.
- A tab that receives a shape it cannot read shows an error card inside the tab, never a route-level
  crash.

## 6. Data plane, seal, access

- Intake routes (all under `/api/vcr/studies/:id/data/*`, CSRF, `manage_data` ability): register a
  source; upload a file into the data plane (size-capped, streamed, never into a runtime-mounted
  path); propose/confirm a field map; freeze a snapshot (per-file sha256 kept); derive the three
  analysis tables; create/revoke grants. Each is audited.
- Seal direction: for `specified_analysis` and `submission_preparation`, outcome fields are sealed at
  snapshot freeze; `vcrSeal.freezePlan` (called when the analysis plan is frozen — a `vcr_write
  what:"plan"` or the orchestrator's analysis step) records `planFrozenAt` and lifts the seal; the
  first job that reads an outcome column after that records `outcomeFirstReadAt`. The two timestamps
  are what the package cover prints.
- Access is judged at `now`; a caller's `asOf` only selects which rows are visible.
- Deletion removes data-plane files after the row deletion commits, and member/grant rows naming a
  deleted account.

## 7. Evidence and matching wiring

- `evidence_pool` (tool) sends `{ parameter, endpointKey, calibres? }`; the gateway's
  `simulate kind:"pool_evidence"` runs `poolParameter`, which builds the engine job from this study's
  verified evidence items only (§3.1 shape) and returns the job ids. An assumption card with
  `sourceKind: "external_evidence"` must cite ids that `verifiedEvidenceIds(study, parameter)`
  returns; otherwise it is refused (`vcr_evidence_unverified`).
- New `vcr_write` kinds: `evidence_item` (an extraction with quote and locator, verified in code
  against the stored registry record or document before it is stored), `precedent`, `fact` (a
  patient fact with document id, character span and visible time, verified against the data-plane
  copy of the document), `site`, `followup`, `plan`. Referrals are created by the control plane from
  assessments, never written by the model.
- A `match_criteria` job's per-subject assessments are persisted on finish; candidates become
  referrals in state `candidate`; `contactReferral` (control plane) is the only way to a contact
  state and records the approving user from the session.

## 8. Error codes

Every code a module emits is registered in `packages/domain/src/errorCodes.mjs` and, if a runtime
tool can emit it, classified recoverable or terminal. A package that adds codes lists them in its
report; the controller registers them in one pass per wave.

## 8a. Roles (amended after wave A)

`manage_study` (lead) changes the data tier, intended use and status, deletes the study and confirms
the compute budget (the second human stop). `manage_data` (lead, data manager) runs data intake. A
`site` member names its site in `members.detail.siteId` and reads and moves only that site's
referrals. Deleting a study from 虚拟临研 is a soft delete (the project's conversations and files
stay); deleting the project or the account removes the rows and the data-plane files.

## 9. Ownership in the repair waves

Files belong to one package per wave. A package that needs a change in a file it does not own
writes the need into its report instead of editing the file.
