# Native patient-matching reference host

This harness runs one public synthetic case through an installed patient-matching tarball, the real native DeepSeek Flash adapter, an isolated PostgreSQL host adapter, and saved Markdown/JSON reports. The root only supplies the fixture inputs and calls the matching tools. The clinical child produces its own decisions.

The patient is 62 years old, weighs 80 kg and is 2 m tall. The protocol requires age at least 18 years and BMI below 25 kg/m2. A private fixture instruction requires successful native `match_evidence` and `match_compute` calls before `structured_output`. It does not supply an eligibility verdict. The registered BMI calculator and original passage identities supply the computation and evidence.

The host proxy owns the provider key. The runtime receives only a random workload token. The run permits one clinical child, at most 16 provider requests, no retries and 16,000 cumulative output tokens; input and cached tokens are recorded separately. The output directory contains a guard that prevents accidental repetition after the first provider request.

## Configuration

Use an operator-owned JSON file for the key proxy:

```json
{
  "deepseek": {
    "key_file": "/secure/deepseek.key",
    "messages_endpoint": "https://api.deepseek.com/anthropic/v1/messages"
  }
}
```

An optional `proxy` field configures the host's curl proxy. Existing configuration with `endpoint` instead of `messages_endpoint` uses that origin with `/anthropic/v1/messages`.

Use another private JSON file containing `databaseUrl`. The database helper accepts only a local PostgreSQL URL whose database name starts with `evimed_test`. Its account needs permission to create a temporary database. The harness creates and drops its own database; saved report files remain in the chosen output directory.

## Commands

These checks do not request a model:

```sh
node --check OpenScience/evals/patient-matching-plugin/reference-host.mjs
node --check OpenScience/evals/patient-matching-plugin/reference-runtime.mjs
node OpenScience/evals/patient-matching-plugin/reference-host.mjs --help
pnpm --dir OpenScience/packages/patient-matching-plugin test
```

This command starts one bounded paid clinical child. Use the pinned DSH binary and a new output directory:

```sh
node OpenScience/evals/patient-matching-plugin/reference-host.mjs \
  --artifact /artifacts/evimed-dsh-patient-matching-0.1.0.tgz \
  --artifact-sha256 YOUR_VERIFIED_ARTIFACT_SHA256 \
  --key-proxy-config /secure/provider-config.json \
  --postgres-config /secure/postgres-connection.json \
  --out /outputs/new-clinical-reference \
  --dsh /toolchain/dsh
```

The receipt records the artifact digest, actual served model, native tool calls, calculation, literal source checks, clinical decision, timings and provider usage. Success requires equality between the native reply's persisted result, PostgreSQL readback, page projection and JSON report; Markdown must equal the same saved-result renderer. A failure preserves partial diagnostics and provider responses instead of starting another clinical child.

## Recorded evidence

The public evidence package is in `docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3-assets/`: `native-clinical-workflow.json`, `native-clinical-report.md`, `native-clinical-report.json` and `native-clinical-result.json`. The recorded one-child run used the private predecessor of this harness; its configuration was then promoted to these CLI arguments without another paid run. The published CLI was checked with syntax/help checks.

All identities and source contents in those files belong to the public synthetic fixture. This is one reference-host compatibility case, not a benchmark score, clinical validation, production deployment or SaaS customer acceptance. SaaS authorization and the independently installable bundle have separate tests. The standalone package proofs remain under `packages/patient-matching-plugin/test/`.

## Non-TREC acceptance preparation

The owner stopped all leaderboard and paid-evaluation work on 2026-11-05. The new non-TREC harness is prepared and checked offline; its incident, C and F executions are **user-skipped**. It has made no model requests and produces no benchmark score. No remaining TREC or translated-SIGIR work is admitted.

`acceptance-prepare.mjs` freezes three source-only streams apart from scorer inputs: the 17 unchanged synthetic incidents (one pass), C's 53 public patient descriptions / 105 pairs / 1,015 annotated rows, and the exact previously authorized 86 n2c2 official-test notes. The C parquet must match the README's published SHA256; C uses the preserved original TrialGPT 1 source collection and its full criteria. The n2c2 notes are `deidentified-clinical`, retain the frozen original XML/text hashes and case-to-source mapping, and use the 13 original guide criteria through native protocol intake. No registry trial is fabricated for that protocol. These C/F patients were previously inspected; a future run would be a regression replay, not an untouched holdout. Preparation does not open the sealed test gold. Licensed notes, source mappings, gold and patient-level outputs stay in the ignored private directory.

`acceptance-host.mjs` reuses the production PostgreSQL HostAdapter/Gateway and the installed artifact with a managed native Flash child. Its scripted root supplies source inputs and invokes the public matching tools; it never supplies an expected decision. Its only model traffic comes from the managed clinical child; no retrieval model or reranker is called. Source files, the harness and the installed artifact are checked before execution. The original shared CNY 500 lifetime budget and durable usage ledger remain authoritative, including prior TREC spend and uncertain reservations; a nested CNY 40 ceiling can only narrow that budget. The harness has two topic slots, no provider retries, and refuses a second pass over a started case. A failed segment stays partial. The prepared configuration has `allowProviderCalls: false` and `executionStatus: "user-skipped"`; normal execution refuses that state before reading credentials or starting services.

`acceptance-export.mjs` is a separate, read-only post-run projection. It converts native inclusion/exclusion polarity into the existing six labels. C's annotation numbers remain zero-based per kind, with an explicit mapping to native criterion IDs and one-based backend positions; only unique whitespace-normalized literal clause equality is accepted. Ambiguous, null and unmapped clauses stay absent and count wrong in the unchanged `vcr-matching-boards/score.py c` denominator. Unset recommendation priority stays unset. Incident evidence checks use actual saved passage IDs. F's labels map by the guide's fixed criterion identity; the unchanged `score.py f` / official `track1_eval.py` remain the scoring authority, with reading C primary and B plus the unknown share secondary. Missing or incomplete execution is never replaced by synthetic judgments or a zero-score report.

The offline checks below do not start a kernel or call a provider. `--prepare-only` checks frozen sources, collection manifests, credentials by file reference and the existing local PostgreSQL account; it creates no matching task or clinical result.

```sh
node --test OpenScience/evals/patient-matching-plugin/acceptance-inputs.test.mjs
node --check OpenScience/evals/patient-matching-plugin/acceptance-host.mjs
node --check OpenScience/evals/patient-matching-plugin/acceptance-prepare.mjs
node --check OpenScience/evals/patient-matching-plugin/acceptance-export.mjs
node OpenScience/evals/patient-matching-plugin/acceptance-host.mjs --config /private/non-trec/config.json --prepare-only
```

Offline source preparation, source-to-label mapping and HostAdapter availability are separate from actual native runtime acceptance and official scoring. Follow-up, source/knowledge binding, exact calculation, cancellation, disable and rollback behavior also retain their existing package/server tests and recorded native fixtures; the preparation scripts do not establish new end-to-end clinical evidence for those workflows.
