# Hosted native evaluation

This isolated harness exercises the protected catalogue, leased preparation, runtime proof, and optional synthetic conversations. It does not deploy production. Model tests require an explicitly supplied control-plane-only provider key, a real engine image, an isolated Docker context, and a fresh output path. The default all-purpose model budget is 4 CNY; `VCR_BUDGET_REMAINING` may lower it and must be positive and at most 4. Reservations and uncertain charges count against the guard; its ledger is exported with the results.

Every declared `outputFiles` entry is recorded before download. Download failures remain in the checkpoint. Before cleanup, the runner requires exact declared-file coverage and validates each saved byte count and SHA-256. An incomplete export retains the owned test containers, volume and network and writes a resource inventory for recovery. Results from different images, question sets and test runs have separate denominators; a completed run does not by itself establish correctness.

Run the offline harness checks with:

```sh
node --test evals/vcr-hosted-native/{artifact-export,budget-guard,snapshot}.test.mjs
```
