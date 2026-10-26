# Offline campaign runner

The closed adapter registry currently executes only `frontier-selection`, using the actual production candidate mapper and `frontierMixSelect` over complete frozen pools. Other surfaces return `campaign_consumer_not_qualified`; no model, DSH, cloud provisioning or production fallback exists in this runner. Consequently this version cannot incur paid stage spend. Adding a paid adapter requires the lab-owner `RsiCampaignBudget.reserve` / `beginSpend` / `settle` boundary and original run-reference recovery before registry admission.

```sh
node evals/rsi-campaigns/run.mjs plan manifest.json inputs.json
node evals/rsi-campaigns/run.mjs preflight manifest.json inputs.json deploy/rsi-campaign/config.example.json
node evals/rsi-campaigns/run.mjs run manifest.json inputs.json /run/rsi-lab/config.json
node evals/rsi-campaigns/run.mjs resume manifest.json inputs.json /run/rsi-lab/config.json
node evals/rsi-campaigns/run.mjs report manifest.json inputs.json /run/rsi-lab/config.json
node --test evals/rsi-campaigns/tests/campaignRunner.test.mjs
```

An unbound configuration returns `campaign_host_unavailable` before any checkpoint write or network call. A bound launcher supplies only `RSI_LAB_DATABASE_URL`; preflight reads PostgreSQL `current_user/current_database()` (the database must be `evimed_rsi_lab`), Alibaba instance metadata and the owner-mounted `/run/rsi-lab/purpose`. An instance declaration by itself is insufficient. Host identity must equal the configured lab instance. OSS/KMS bindings remain intentionally empty until the owner provisions them.

`runCampaign({manifest, inputs, configuration, store, attestLab, now, signal})` is the orchestration API. `inputs` contains `target`, `registration` and `sources` indexed by manifest source ID. Every source digest and the registration digest bind the exact JSON encoding; sources include complete pools and labels. Registration contains finite `baselineThreshold` and `thresholds`. It must be frozen before confirmation. All thresholds are preregistered; the runner does not choose a winner or publish a statistical verdict. Independent sealed confirmation provenance must be established by the evidence/registration layer; historical exposed gold cannot certify a fresh result. The runner never upgrades producer labels into independent evidence.

`productCampaignStore(database, labAccountId)` writes account-scoped normal ProductDocuments checkpoints with revisions. A session advisory lock serializes the campaign, and checkpoints bind manifest, datasets, labels, exposure, target dependency closure and registration. Completed stages verify stored result digests before reuse; running or paid uncertain stages park instead of dispatching another first answer. Deadline, cancellation and Beijing month rollover stop execution. Timer and incident-event launchers must reuse the immutable manifest ID to coalesce the same campaign; a changed manifest with that ID refuses resume.

`profiles/benign_fixture.mjs` supplies separate nonempty synthetic development/confirmation pools for the same orchestrator. Unit tests run the lifecycle without claiming medical benefit, cloud acceptance or signing authority. `run_frontier.mjs` retains historical-gold analysis separately. Every runner report is `not-qualified` until a trusted independent evaluator completes the registered inference and source checks. `evaluateStatistics` invokes only the owned Python bridge, validates the returned input hash, limits output and runtime, and reports failure as unknown. The separate signing finalizer receives the bound report; no signing key enters this process.

The lab compose profile runs a frozen release-derived image as a nonroot user with a read-only base and one writable lab volume. The release image must contain this exact source tree and registered dependencies. It has no Docker socket, production key/mount or raw environment forwarding. The monthly systemd timer is day 1 at 02:00 Asia/Shanghai; owner-operated incident triggers invoke the same service with the same manifest identity. Nothing here installs or enables the units automatically.

Remaining qualification: real lab resource/role isolation and PostgreSQL lock integration, paid adapter recovery/budget wiring, sealed label provenance, family inference linkage, OSS finalization/KMS signatures and serving activation are separate gates. This runner does not claim those gates passed.
