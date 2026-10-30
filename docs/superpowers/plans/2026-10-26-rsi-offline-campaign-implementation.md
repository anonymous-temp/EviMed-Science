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
- [x] WP3 (frontier surface, 2026-10-26 review round): day-unit replay of production's export from the pre-mix state, a calibrated two-pass Qwen label jury, fixed labelled sets, supply/replay-fidelity/drift/MDE reporting.
- [x] WP4 (core and first policy consumer; skill/tool activation not yet qualified): signed campaign bundle, deterministic importer, compatible baseline CAS, surface-specific shadow/cohort/global activation and rollback receipts.
- [x] WP5 (local lifecycle only): complete local synthetic/benign lifecycle and historical-gold analysis, without claiming live lab or fresh-confirmation acceptance.
- [~] WP6: serving composition separated and its review regressions fixed (2026-10-26); physical deletion of the old experimental implementation still waits for the first accepted live campaign and a production cutover window.
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


## 2026-10-26 review round and lab binding

Three independent reviews (statistics/runner, import/transport security, pause/serving wiring) and a web fact check of the Alibaba pieces found defects the local lifecycle could not show. All are fixed on this branch:

- Runner: the evaluator's integrity facts (exposure, look, cost completeness and identity, budget expiry, registration digest) were overwritten with passing values before the statistics — they now come from the evaluator's signed receipt and must equal the runner's own observations; a transient evaluator or statistics failure is retried instead of persisted; no eligible candidate and a failed confirmation are terminal; a confirmation corpus is opened once and a surface's confirmations draw at most α 0.05 per quarter (confirmation ledger); synthetic campaigns can never reach population scope or a production bundle.
- Statistics: procedure `rsi-paired-group-v5` (the registered group is the independent unit, ≥25), claim `superiority` for a zero-model-call deterministic consumer, a strict efficiency cost bound; the qualification adds superiority nulls (normal, skewed) and power at 25/31 day groups, a skewed-cost null and a repair-boundary scenario that can fail. Tests start from a qualifying fixture so every mutation is what fails it.
- Frontier campaign: source groups were not independent (one day shares its size, group shares, language target and event picks) and the replay could not take back a sticky pick; the campaign now replays whole days from production's export with the day's mix taken back, the day is the unit, development and confirmation share one endpoint (weighted accuracy, pick ×3) on a labelled set fixed from replays alone.
- Labels without human labelling: a two-pass Qwen jury (other family than the DeepSeek screener), calibrated each month on the even half of the human anchor. First calibration: κ 0.875 (human inter-rater 0.87), pick precision 0.94, recall 0.85, abstention 2.4%.
- Production thin layer: incident export compared jsonb-reordered bytes and always failed; an observation write failure aborted the frontier round; one bad bundle blocked every later one; withdrawals depended on the import configuration; verbatim quotes stayed in revision history; earlier turns could be exported; permanent extraction errors retried forever; the poll chain could fork; a late rollback could hide an active campaign; canonical JSON was not RFC 8785; the layer was wired into every policy read even unconfigured, its start-up failure stopped other workers and its failure failed user deletions.
- Evolution serving cutover: waiting agendas were stranded (self-check refused), poison jobs retried forever, an unanswered harm review silently overrode the harm alarm, the operator digest and recovery paths stopped, stuck experimental decisions could not be resolved, nested transactions undid preserved retirement progress, the monthly metrics stopped, quarantine ran every 15 s, the frontier mix failed on a selector error.
- Fact check: `oss:MaxKeys` is not an OSS condition key (removed); `x-oss-forbid-overwrite` is ignored on a versioned bucket; Alibaba KMS lists Ed25519 only for software keys and not for AsymmetricSign, so keys stay operator-provisioned PEMs (Secrets Manager or a lab-local file).

Lab binding (owner, 2026-10-26: first trial without OSS/KMS, lab only, no production import): the lab is the Alibaba host `evimed-test` (instance `i-2ze3rsk5p2bh4xisit81`, cn-beijing) — its own users (`rsi-lab` uid 10001, `rsi-inbox`), its own PostgreSQL container and network, keys generated on the host, the image built there, timer on the 1st at 02:00. Production pushes its read-only export on the 1st at 00:30 through a key forced to `rrsync -wo` and pinned to production's address; the lab holds no production credential. The existing OSS key (RAM user `oss-bucket-put-object`) is refused by RAM as a leakage risk and KMS is not activated on the account, so the OSS transport and Secrets Manager signer stay unbound; the lab configuration says `transport: {kind: "none"}`. First run: 2026-11-01, monthly after that.

Still open: paid DSH consumers and skill/tool activation, the production import of a bundle (thin layer opt-in, not deployed), authorized-incident campaigns (need OSS), physical deletion of the old experimental code (WP6), and the Harness2/GEPA arms (WP7).
