# EviMed platform patient-matching comparison

This suite exercises the integrated product through a real local DSH kernel,
authenticated uploads, automated dispatch, VCR tools/jobs and the product's saved
matching views. It does not insert correct criteria, patient facts or judgments.
Formal campaigns require the local Docker-backed control plane and the pinned
DSH runtime image. The runtime receives only its own project's workspace and
home subpaths. The frozen index is available only to the control plane, and gold,
scorers and historical outputs remain on the operator host. Public regression
cases are not an independent clinical holdout, and raw internal model reasoning
is not a product deliverable.

Host-kernel campaigns are diagnostics only. The macOS adapter repaired its
native sandbox startup and exposed a real ordinary-text intake defect, but one
later case read historical corpus bytes from the host. All host campaigns are
quarantined from formal comparison, including cases that appeared successful.
Account cleanup receipts and the original artifacts remain preserved.

The implementation combines `c180ff7b5` and release integration `3970e4f8f` in
`faa8d0f28`, followed by the frozen-corpus/ranking and evaluation changes here.
Do not point this suite at the November 1 production deployment.

## Preparation

`prepare.py` accepts only the digest-verified public seven-field TrialGPT input
and pinned official SIGIR corpus. It builds an immutable SQLite trial index,
case uploads and reference geometry. Model inputs contain only a patient note
and known candidate IDs. Its `matching` task is conditional matching, not open
retrieval. The inserted exclusion-section heading is declared; original section
bytes and boundaries remain traceable. Run with `--inputs`, `--corpus`, `--out`.

The operator-configured collection manifest contains `version: 1`, `id`,
`sourceVersion`, `snapshotDate`, `databasePath`, `databaseSha256`, and optional
`sourceFormat` (`clinicaltrials-xml` or `trialgpt-json`). The existing TREC FTS5
indexes use the same format. No qrels or answer columns enter the index.

Frozen retrieval uses up to 32 query phrases and returns up to 500 unique IDs,
with pages of 50 cards. Copy the initial search's `collection.revision` into
`collectionRevision` on exact reads and candidate writes. A changed snapshot
is refused rather than replaced by a live record. Live registry limits remain
separate. This BM25/RRF implementation is not MedCPT.

## Local runtime

Use `container-launch.mjs` with `--name`, `--state`, `--collection`,
`--docker-client`, and `--budget-dir`. A formal launch additionally requires
`--paid` and `--deepseek-key-file`; use `--seed-budget` only once to carry earlier
costs into a fresh durable journal. State, corpus, budget and secret paths must
remain private. The launcher builds an overlay from an explicit tracked-source
allowlist and records the exact image ID. It does not deploy the platform.

The control plane uses a fresh PostgreSQL database and named data volume. It
publishes only loopback ports; project kernels run on an internal Docker network
without the repository, corpus, gold, host socket or provider key. Public-source
and web-search gateway requests are refused, and live-registry transport is
refused rather than substituted for the selected frozen collection. The runtime
cannot call browser/admin APIs through the control plane. Model calls still use
the actual platform gateway and official DeepSeek Flash endpoint.

Memory extraction/recall, learning, evolution, autopilot and LoopX are disabled.
The local JavaScript matching executor remains available. Run
`container-probe.mjs <state>` before inference: the current-instance receipt
must establish the real kernel/source bytes, workspace access, prohibited mounts,
direct and mediated egress refusal, and disposable-account/runtime cleanup.
Readiness probes dispatch no model prompt. A dirty or readiness-only launch is
not accepted as a paid baseline.

After export and account cleanup, `node container-resources.mjs <absolute-state>`
removes only inventory- and label-verified owned Docker resources; host evidence
and the durable budget remain. Never prune unrelated Docker resources.

The older `server.mjs` and host adapter remain for local diagnosis; `run.mjs`
rejects their startup receipts for formal benchmarking.

The benchmark ingress journal covers every model purpose, including VCR calls
excluded from normal account-wide caps. Its default aggregate allowance is
CNY 200 and per-account allowance CNY 5, under reference-price reservations.
Actual settlements are retained; uncertain calls keep the full estimate. This
is estimated-price admission, not a supplier invoice guarantee. The journal
survives account deletion and normal server restarts; its exclusive lock prevents
two servers owning it. Do not remove a lock while its recorded PID is alive.

## Run only after commit and push

`run.mjs` requires `--base`, `--manifest`, `--startup`, `--sha`, `--out`, and,
for matching, `--reference` and `--gold`. It checks a clean checkout, fresh
remote branch SHA, live-instance identity and frozen source/configuration hashes
before dispatch. Optional `--limit 6` is an operational sample, not the full
accuracy result; no limit schedules every manifest case. Use a new output
directory per immutable campaign. The driver does not choose successful retries.

Each patient gets a new throwaway account, project and kernel-created session.

Plain `.txt` and `.md` patient uploads now receive authenticated immutable
original receipts, discoverable through `patient_context`. The exact handle
contains `sourceId`, `generation` and `sha256`. It is the same product intake
available to ordinary uploads, not a benchmark-only patient/fact seed. Retention
warnings are preserved separately from successful workspace uploads.
Runs are marked `automated: true`; the browser composer itself does not support
that mark, so the supported dispatch route exercises the ordinary conversation
and verified VCR context. Saved-object composer selection is a separate browser
check. Jobs, including `awaiting_budget`, are canceled and checked before account
deletion on interrupted/failed work. Files, views, transcript and usage are
exported before cleanup. A failed deletion stops the campaign and names the
remaining account; it is never reported as success.

Known-candidate manifests require exactly `patient.txt` and `trials.txt`.
Retrieval manifests require only `patient.txt`, `task: "retrieval"`, and the
applicable collection ID. Do not feed annotated trial IDs to an open retrieval
arm. Cross-case memory, files, gold labels and prior answers are not uploaded.

## Alignment and scores

`alignment-policy.json` and implementation hashes freeze before inference.
Alignment is label-blind, confined to patient/trial/kind/source version and
section, and uses literal source geometry. Numeric/operator/negation cuts,
ambiguous occurrences and unsupported split/merge mappings stay unresolved.
JavaScript UTF-16 offsets require explicit conversion to Python code points.

`score.py --campaign ... --reference ... --collection ... --gold ... --out ...`
reads the product's saved view and verifies frozen references and collection
provenance. It reports all N annotations, scorable M, conditional accuracy C/M,
coverage M/N, and every unresolved/output-identity bucket. Unaligned criteria
are not incorrect or silently dropped. Missing answers on aligned criteria
remain failures. Historical GPT-4 agreement uses exactly the same M IDs.

Before product predictions, the pinned reference-source audit locates 997 of
1,015 annotations, with nine ambiguous and nine unlocated. This is source
availability, not model performance or final alignment coverage.

## Verification

```sh
python3 -m unittest discover -s OpenScience/evals/vcr-platform-comparison -p 'test_*.py'
node --test OpenScience/evals/vcr-platform-comparison/*.test.mjs
```

Product tests include real PostgreSQL source-refresh races, exact/read/list
consistency, cohort/protocol ranking, immutable collection identities, paging,
worker admission, cancellation and shutdown. Review and test counts do not
substitute for the subsequent paid platform campaign or browser acceptance.
