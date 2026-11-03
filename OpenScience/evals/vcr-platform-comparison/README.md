# EviMed platform patient-matching comparison

This suite exercises the integrated product through a real local DSH kernel,
authenticated uploads, automated dispatch, VCR tools/jobs and the product's saved
matching views. It does not insert correct criteria, patient facts or judgments.
The host-kernel adapter replaces container launch only; it does not certify
container filesystem isolation. Public regression cases are not an independent
clinical holdout, and raw internal model reasoning is not a product deliverable.

On macOS the adapter selects the pinned kernel's native Seatbelt backend instead
of the runtime image's Linux Landlock executable. Hosted `workspace-write` with
approval policy `never` remains enforced; escalation is never approved. Both
the main and runtime UI listeners bind loopback. A sandbox startup failure is
an environment diagnostic, not an eligibility prediction.

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

Stage the merged tree using `evals/general-tasks/runner/seed.sh`, after the
socket's `prepack` step. Reuse only a sealed profile with the pinned kernel.
Configure `OS`, `TREE_DIR`, `LIVE_DIR`, `LIVE_DATA`, `LIVE_PORT`,
`LIVE_DATABASE_URL` (a loopback `evimed_test_*` database without query options),
`DSH_BIN`, `EVAL_DEEPSEEK_KEY_FILE`, `VCR_COLLECTION_MANIFEST`,
`VCR_STARTUP_RECEIPT`, and `VCR_BENCHMARK_BUDGET_FILE`, then run `server.mjs`.
Provider keys remain at the control plane and are never copied into case files.

The wrapper pins the official DeepSeek endpoint and disables external VCR engine
access, memory extraction/recall, learning, evolution, autopilot and LoopX. The
local JavaScript matching executor remains available. The startup receipt binds
the live instance, source SHA, actual resolved configuration, staged core files,
kernel version and collection manifest. A readiness-only dirty instance cannot
be used for a baseline.

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
