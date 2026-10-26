# RSI offline campaign implementation plan

> For agentic workers: use a small number of workers when useful, with independent specification and code review; the owner later freed model/delegation choices. Work only on `codex/rsi-offline-campaigns`; do not deploy.

**Goal:** Implement the owner-approved online-native-learning/offline-platform-experiment architecture, including the follow-up review, with local acceptance and committed/pushed code. Alibaba host, two OSS channels, KMS and lab provider credentials intentionally remain unbound until the owner configures them.

**Architecture:** Online account learning and product operations stay native. Platform experiments run through a single offline campaign path; production exports authorized incident-derived records and admits signed qualified revisions through existing consumers. Optimizers are surface-specific research arms, never publication authorities.

**Tech stack:** existing Node ESM/PostgreSQL/domain packages, Python numerical qualification where appropriate, real DSH consumer adapters, container/OSS deployment contracts. No second serving kernel.

## Confirmed implementation inputs

- Base: origin/main `9614de895`, containing production `dc459da49`; v2 spec cherry-picked as `7d8a64063`.
- Budget: CNY 1,000 per campaign, CNY 30,000 per Asia/Shanghai calendar month. Reserve before spend, include retries and failed calls, no rolling-window/calendar ambiguity.
- Improvers: configured DeepSeek Flash and Qwen 3.8 Max through lab-owned gateways; no Claude in the initial profiles.
- Provider/resource bindings are empty by owner choice. Unbound lab/transport/signing fails with an explicit actionable code, never production fallback or automatic provisioning.
- Latest owner request authorizes implementation, commit and push, and explicitly prohibits deployment.
- Withdraw the previous five-account-only signal rule. Authorized incident conversations may be read by the existing approved model and converted into bounded, traceable reproductions for the configured lab; do not export credentials or unrelated histories. Preserve source rights, deletion/invalidation and purpose scope.
- The existing 248-row frontier anchor is available, but tracked test/all results expose the even split. Treat it as historical calibration/development, never a fresh confirmation certificate. Production selection uses `frontierMixSelect`, not a score-only threshold.

## Work packages

- [x] WP0: residual online experiment admission, execution and activation fencing.
- [x] WP1 (configuration/contract code; actual bindings deferred): unbound Alibaba lab/OSS/KMS deployment configuration and resource preflight; finite budget and trigger contract.
- [x] WP2 (first frontier surface; other consumer qualification remains closed): offline campaign state/checkpoints, dependency-closure identity, preregistered efficiency and targeted-repair evaluation, actual consumer adapters.
- [ ] WP3: source-group/label/exposure provenance, generated cases, real frontier-selection replay and supply/MDE reporting.
- [x] WP4 (core and first policy consumer; skill/tool activation not yet qualified): signed campaign bundle, deterministic importer, compatible baseline CAS, surface-specific shadow/cohort/global activation and rollback receipts.
- [x] WP5 (local lifecycle only): complete local synthetic/benign lifecycle and historical-gold analysis, without claiming live lab or fresh-confirmation acceptance.
- [ ] WP6: separate the serving sensors/admission/fuses from the offline experimental owner, remove unreachable online experiment/meta entrypoints after local cutover proof.
- [ ] WP7: offline-only optimizer interfaces and recorded stop rules; no upstream model experiment when unconfigured.

## WP0 build sequence

Files: `OpenScience/apps/server/src/evolutionWorker.mjs`, `evolutionService.mjs`, `evolutionMaintenance.mjs`, `evolutionComposition.mjs`, `evolutionDecisions.mjs`, `productJobs.mjs` and focused tests.

1. Add executable regressions for paused Monday/monthly scheduling, mixed queued evaluate actions, forced-kind/canResume bypass, metrics-only maintenance and late activation. Run RED and commit only owned test paths.
2. Introduce one closed action-aware policy used for enqueue, SQL candidate selection, execution and experimental publication. Paused experimental rows must not starve an allowed release replay at the queue head or consume attempts.
3. Preserve monthly enqueue payload/idempotency identity; impose metrics-only at execution. Allow exact existing retirement/recovery journals; block merge/build/new-tool publication and paid expiry decisions.
4. Release replay is not assumed free: workflow smoke and sudden-perfect audit can call models. Keep bounded immutable serving checks distinct and defer experimental replay honestly.
5. Run the same regressions GREEN, relevant PostgreSQL admission integration, server lint/type checks. Independent reviewers inspect semantic coverage and lifecycle race conditions.

Relevant checks: `evolutionHousekeepingInterval.test.mjs`, `evolutionPauseResume.test.mjs`, `evolutionWorkerLanes.test.mjs`, `productJobAdmission.integration.test.mjs`, `evolutionCore.test.mjs`. Real PG semantics are required for queue starvation proof; an enqueue-only fake is insufficient.

## WP1-WP4 contracts and build order

Define and test the public data contracts before wiring the workers:

- A campaign manifest binds surface, target dependency closure, base revision, datasets/exposure, claim, family-specific margin/repeat/score registration, finite budget, explicit model roles and automated execution.
- A dependency fingerprint hashes the consumer's declared transitive code/config/tool/kernel/model dependencies. Full source/image digests are provenance; unrelated release changes do not invalidate a surface. Unknown dynamic dependency edges conservatively refuse compatibility.
- A fixed claim is `efficiency`, `targeted-repair`, or a separately qualified deterministic tool contract. Targeted repair requires registered failure-slice superiority, global NI and cost <=1.1x, with separate error allocation. No post-hoc claim/margin selection.
- A transport envelope has one producer and one reader role per OSS channel; lab never initiates a production control-plane connection. Signed immutable bundle verification precedes all staging.
- A bundle imports only admitted policy/skill/isolated-tool classes, with issuer/evaluator authority, provenance, replay/expiry checks and current base CAS. Shadow selection uses actual consumer executions for shared feeds; per-user cohort percentages are not applied to a global feed.
- Incident extraction retains an exact source/run/authorization identity, bounded necessary excerpts and a generated public/authorized reproduction; invalidation/deletion revokes derived export visibility. The five-account threshold is removed without turning all conversations into an unscoped export.

Tests first for each boundary: tampered files/signatures, unknown closure paths, changed affected/unaffected files, stale bases, duplicate imports, signed-but-unqualified verdicts, interrupted reservation/settlement, month rollover, parallel campaign admission, missing host/OSS/KMS, non-automated drivers and unauthorized source references.

Register `evals/rsi-campaigns` in the existing acceptance ledger using its current schema and truthful not-run state. Every driver dispatches `automated: true` or the equivalent header at the actual call site.

## WP3 frontier evidence requirements

Reuse the real production row-to-candidate mapping and `frontierMixSelect`, including visible time, source caps, events, genre floors, safety bypass, score-version eligibility and demotion. Sampled gold lacks some of those fields; report missing prerequisites or explicit synthetic fixture assumptions rather than fabricate a historical production replay.

Historical anchor results cannot qualify a new candidate as unseen. Journal authority, report counts, citations and clicks are features or weak signals, not automatically editorial truth. Retractions/safety alerts can be highly publishable news; do not turn them into generic negative labels. Preserve label source, calibration and abstention/missingness. New independent confirmation requires a sealed compatible cohort.

## Review and verification

For each code package: tests-first evidence, minimal implementation, rerun, specification review, appropriate language/code/security review, then commit. Never stage another worker's paths. No force pushes or history rewrites.

Final local closure includes relevant unit/integration suites, generated registries/acceptance ledger, types/lint, offline qualification simulations, budget/transport/import failure injection and consumer-version/rollback lifecycle. Record unavailable live-host/model proofs as deferred by owner configuration, not passing. Do not run paid experiments merely to hide missing credentials.

Push the implementation branch after reviews and local checks. No production configuration/container/image/schema changes are part of this turn. Observe the already-enabled production search pause only through existing evidence unless a read is needed; do not deploy WP0 automatically.


## Local implementation handoff

Implemented and reviewed: pause fencing, thin serving composition, owner-scoped legacy-job quarantine, finite campaign/month budget ledger, unbound Alibaba preflight, exact affected dependency closure, signed evaluator/publisher bundle, live trust revocation, signed evidence finalization, source-authorized incident outbox and directional OSS withdrawal, shadow/global/cohort state machine, real frontier selector receipts and compatible rollback. The runner uses the actual frontier mapper/selector and keeps deterministic finite diagnostics separate from source-group population inference. Startup without bindings has no account provisioning, model/cloud calls or polling timer. Maintenance stops both new workers and includes active RSI work in its drain count.

Validation receipts are recorded at `OpenScience/evals/rsi-campaigns/reports/implementation-evidence.json`. Two independent review rounds closed the four integration blockers: live trust, global observations, exact incident identity and actual runner-to-finalizer evidence binding. A real PostgreSQL composition exercised shadow (12 baseline picks), global (6 candidate picks), counted candidate use and revoked-admission rollback (12 baseline picks). Mathematical calibration is explicitly scoped and cannot certify real task-family labels.

Remaining work is not marked complete: WP3 fresh independently calibrated supply and live inventory/power feasibility; paid DSH/control-plane consumers and skill/tool activation qualification; WP6 production cutover, a complete former night window and physical deletion of the old experimental implementation; WP7 optimizer comparison only after those gates. No live campaign or deployment was performed. Host/region/OSS/KMS resource IDs remain unbound as the owner requested. This branch is a tested implementation foundation and first local lifecycle, not a claim that every proposed surface is operational.
