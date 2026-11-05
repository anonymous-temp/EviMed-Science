# Patient matching release candidate

The native bundle, exact calculator worker and core contracts are versioned separately from the general DSH host. The first host ABI is `patient-matching.host.v1`. Matching clinical execution accepts `deepseek-flash` only; it never escalates to Pro. Qwen3.7 embedding/reranking and optional Jev 1.14 priority remain algorithm services behind host-held credentials.

## Build and identify

Run from the repository root after the workspace's frozen dependency install:

```sh
pnpm --dir OpenScience/packages/patient-matching-worker build
pnpm --dir OpenScience/packages/patient-matching-worker pack --pack-destination /secure/artifacts
pnpm --dir OpenScience/packages/patient-matching-core pack --pack-destination /secure/artifacts
node OpenScience/packages/patient-matching-plugin/scripts/pack.mjs /secure/artifacts
node OpenScience/deploy/patient-matching/build-worker-image.mjs \
  <verified-local-Node-and-Python-runtime> \
  /secure/artifacts/evimed-patient-matching-worker-0.1.0.tgz \
  evimed-patient-matching-worker:0.1.0-candidate /secure/artifacts/worker-image.json
docker image save -o /secure/artifacts/patient-matching-worker.oci.tar evimed-patient-matching-worker:0.1.0-candidate
node OpenScience/deploy/patient-matching/build-release.mjs /secure/artifacts /secure/receipts
```

The offline image builder copies only public Node/Python binaries, their standard library and system shared libraries from the selected local image. It copies no application tree, home, provider configuration or customer workspace. Its receipt records that source image and actual interpreter versions. The release builder reads the exported OCI index for the distribution digest and retains Docker's actual runtime image identity separately in the private catalogue. A candidate coordinate is unpublished until the corresponding OCI/package publication is performed.

Do not replace a proven tarball in place. A changed digest needs its own native compatibility receipt. The release builder derives versions from each source package and checks the corresponding tarball's package identity. Core/plugin 0.1.1 and worker 0.1.0 are the current local candidates. The offline native checks are `node packages/patient-matching-plugin/test/native-smoke.mjs <exact-tarball>` and `node packages/patient-matching-plugin/test/native-status-smoke.mjs <exact-tarball>`, run from `OpenScience/` with `MATCHING_PROOF_DSH` selecting the pinned kernel binary. They verify actual tool/skill loading, failure checkpoints, cancellation and disabled general conversation using a synthetic provider. The historical 0.1.0 real single-case Flash workflow is documented in `evals/patient-matching-plugin/README.md`; it is not current 0.1.1 clinical qualification.

## Hosted preparation and activation

The deployment owns `catalogue.json`; it contains exact local artifact references and integrity, never provider credentials. Requests select only a catalogue release id. The lifecycle worker verifies and unpacks the self-contained tarball into an immutable readonly generation, then adopts it under the existing exclusive idle-project fence. Both the control plane and privileged runtime controller verify that generation before mounting it. A failed optional matching activation preserves ordinary conversation.

Configure the operator-owned catalogue path and an isolated worker connection:

- `OPEN_SCIENCE_PATIENT_MATCHING_CATALOGUE`
- `OPEN_SCIENCE_PATIENT_MATCHING_WORKER_CONTAINER`
- `OPEN_SCIENCE_PATIENT_MATCHING_WORKER_IMAGE_DIGEST`
- `OPEN_SCIENCE_PATIENT_MATCHING_WORKER_SOCKET`
- `OPEN_SCIENCE_PATIENT_MATCHING_WORKER_TOKEN_FILE`

Create the worker token with at least 32 random characters and mode 0600. Its containing Linux directory must be mode 0700 and owned by the same numeric uid as the web boundary and worker. Mount it at `/run/patient-matching` in both services. The contained worker has no network, readonly root, dropped capabilities, no new privileges and resource limits. `compose.yml` is an optional overlay for the existing hosted stack, with a Linux host directory. macOS host-to-VM bind mounts do not transport Unix sockets; the local container proof uses a private Linux volume. No provider key enters the worker or DSH runtime. `OPEN_SCIENCE_PATIENT_MATCHING_PRIORITY_ENABLED=true` enables optional Jev advisory priority for shortlists when primary reranking is unavailable; it does not alter clinical eligibility.

The authenticated `/api/patient-matching?projectId=...` resource reads release/state/version. POST takes `{action, releaseId?, expectedRevision}` with action `install`, `enable`, `disable`, `uninstall` or `rollback`, under normal account/CSRF/project-management authorization. It queues preparation; it does not run a package manager in a live session. The runtime's exact tools and loadable skill are proven through its authenticated native status seam. Host operations additionally require the pending native call and its current root/child binding.

Disable/remove waits for the current admitted work boundary and keeps existing results in the erasure-aware data plane. Compatible rollback selects a previous admitted generation. An unavailable/mismatching worker refuses matching operations explicitly. This initial deployment connection selects one contained worker image; prepare the compatible worker resource before activating a release that changes it. Replacing shared worker resources is an operator release action, not a model tool.

## Separate trial index

`OPEN_SCIENCE_PATIENT_MATCHING_TRIAL_INDEX_MANIFEST` optionally selects an immutable public ClinicalTrials.gov NDJSON resource. Its protected manifest has `collectionId`, absolute `recordsPath`, `recordsSha256` and `expectedRecords`; each line is `{registryId:"NCT...",text:"..."}`. The loader verifies bytes and source stamp and the index uses its own PostgreSQL schema, 1024 dimensions, endpoint/model/profile identity and immutable ready generations. It never changes the memory index. Build/resume is a privileged operator operation; a matching turn queries only a ready generation. An absent/unbuilt index is a declared degraded resource while source-specific registry retrieval remains available.

The operator prepares the public registry text, source hash and exact nonblank-record count; the builder does not scrape a registry or read patient files. The manifest and NDJSON must be regular files, not symlinks, and must not be group/world writable. Keep the manifest immutable throughout a build. PostgreSQL must already have the `vector` extension and the existing billing account/project; the builder checks ownership, deletion and archive status before work and before each paid embedding dispatch. Index writes use the existing resource port, and provider reservations and settlement use the existing durable `UsageLedger`. The existing control-plane and usage schema migrations run on connection as they do in the serving process; use an operator-selected compatible database and take the normal release backup first.

Select the database with a private JSON file containing `databaseUrl`. Select the provider with a separate private JSON file containing `{"dashscope":{"key_file":"/secure/dashscope.key"}}`; both configuration files and the key file must have mode 0600 or stricter. No credential or database URL is accepted on the command line or printed. An optional `dashscope.fetchProxy` (or top-level `fetchProxy`) HTTP/HTTPS proxy URL reuses the control plane's existing CONNECT transport. Credentials in that URL remain in the private file. The default embedding model, endpoint and revision come from the pinned matching profile: Beijing DashScope, 1024 dimensions, with Flash as the only clinical model. This command calls embeddings only. An intentional `--embedding-endpoint` override changes the index profile identity and must match the serving configuration to make that generation queryable.

Run from the repository root after dependency installation:

```sh
node OpenScience/deploy/patient-matching/build-trial-index.mjs --help
node OpenScience/deploy/patient-matching/build-trial-index.mjs \
  --manifest /secure/trial-index/manifest.json \
  --postgres-config /secure/control-plane-postgres.json \
  --provider-config /secure/provider-config.json \
  --actor-id OPERATOR_ACCOUNT_ID --project-id OPERATOR_PROJECT_ID \
  --max-cost-cny 10 --account-max-cost-cny 10
```

This is a paid operator release operation against the explicitly selected database, separate from production deployment. The default CNY 10 build cap is cumulative for the same billing account, project, source manifest and embedding profile across resumptions. The reservation fence counts settled cost plus reserved/uncertain exposure, including unresolved expired reservations; it refuses the next estimated provider call that would cross the cap. Calls use the account-capped `kernel` usage purpose, as the native matching plugin does. `--account-max-cost-cny` also defaults to 10 and applies the existing ledger's daily/weekly limits to the account's other capped calls. For a shared multi-provider campaign, all its callers must select the same billing account and the same campaign ceiling; the build allocation can be smaller. These existing rolling windows do not constitute an all-time campaign cap. No account setting is modified and no new billing store is created. A provider's final measured usage remains authoritative and is settled by the existing ledger. Resume with the same settings and cap; increase the cap explicitly only when additional spending is authorized.

For the separately authorized CNY 500 matching evaluation campaign, also pass `--campaign-budget /secure/campaign/shared-budget.json --account-max-cost-cny 500`. This selects the evaluation runner's shared, atomic multi-provider spending guard; its maximum exposure includes DeepSeek, DashScope and Jev callers using that same file. The CLI reserves there before the durable billing reservation, releases a pre-dispatch refusal, and settles its measured or uncertain outcome. The PostgreSQL ledger remains the authoritative billing record. No model caller should bypass either campaign guard or account cap.

The command visits offsets in chunks of 1000; `--concurrency` allows 1 to 4 concurrent chunks (CLI default 4). The index port persists each successful embedding batch of at most 20 with the current provider port and reuses valid stored vectors. The resource's required hash pass also checks the exact record count and records sparse UTF-8 byte offsets, so a resumed chunk seeks near its start rather than rereading every earlier record. Raw lines are bounded at 256 KiB. The first unsupported/error result or budget refusal stops new chunks and aborts active siblings, with no automatic retries. SIGINT/SIGTERM abort in-flight calls and preserve committed batches; uncertain exposure stays in the ledger. JSON progress describes completed chunks and the first unfinished offset; a stopped chunk may have saved additional batches. Restart at offset 0 to safely reuse all saved vectors, or use `--offset` with a known first unfinished record. No generation is served until the expected record count is complete. Exit status is 0 for ready, 2 for stopped/invalid configuration and 130 for an interrupted running build. A completed index proves a built resource, not a retrieval-quality benchmark or clinical validation.

The operator build uses one fixed provider capacity policy across its workers: request starts are at least 500 ms apart, and input admission is capped at 800,000 estimated tokens in a rolling minute. The pacing estimate is input UTF-8 bytes divided by four, rounded up, plus 512 tokens per request; it schedules English coarse projections only and never prices billing. Token waits occur before model/billing work; queued waits honor cancellation. Actual dispatch attempts are counted separately in JSON progress. A provider 429 stops the build without automatic retry; a separately authorized resume reuses its committed vectors and keeps uncertain exposure reserved.

The focused offline checks make no provider request:

```sh
node --check OpenScience/deploy/patient-matching/build-trial-index.mjs
node --test OpenScience/apps/server/test/patientMatchingTrialIndexOperator.test.mjs
```

## Verification boundary

The committed receipts distinguish exact native artifact compatibility, isolated PostgreSQL authority/persistence tests, actual provider contracts, one historical 0.1.0 public synthetic Flash workflow, and historical official benchmark scores. Current 0.1.1 has zero-paid synthetic runtime proofs and offline/isolated-database engineering checks. The export-only M5 adapter is `evals/vcr-matching-boards/native_projection.mjs`; it preserves saved order and missing-topic accounting. It does not execute a model or establish a new SIGIR/TREC score. The owner stopped TREC, SIGIR and other paid evaluation; their partial data and cost uncertainty remain preserved, with no automatic resume. The build/evaluation commands above describe operator mechanisms and are not scheduled work. Translated SIGIR is excluded.

Package publication, hosted installation, production deployment and clinical validation remain separate recorded actions.
