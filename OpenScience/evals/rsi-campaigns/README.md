# Offline campaigns (RSI lab)

Platform experiments run here, offline, on a dedicated lab host; production keeps only serving and a thin import/rollback layer (`apps/server/src/rsi*.mjs`, opt-in). The closed consumer registry admits one surface today, `frontier-selection` — the frontier feed's selection threshold, replayed by production's own `frontierMixSelect` over whole days. Other surfaces answer `campaign_consumer_not_qualified`.

## The monthly frontier-selection campaign

Production pushes, on the 1st at 00:30 Asia/Shanghai, a read-only export of months M-2 and M-1 (`scripts/ops/rsi-frontier-export.mjs`, run inside the serving web container by `deploy/rsi-campaign/production/rsi-frontier-push.sh`) into the lab's write-only inbox. At 02:00 the lab runs `deploy/rsi-campaign/rsi-lab-monthly.sh`, every step in the lab image (`deploy/rsi-campaign/Dockerfile`: Python 3.12 + the pinned statistics, Node 22), resumable through its `STATUS` file:

1. **plan** (`frontier_assemble.mjs plan`): replay every registered threshold on every day from the state before that day's mix (the export takes back what the mix picked, keeping item-time safety picks), and fix each day's labelled set from the replays alone — rows at or above the lowest registered threshold, safety alerts, and every row any registered threshold selects.
2. **calibrate** and **label** (`frontier_labels.mjs`): a two-pass Qwen jury (a model family other than the DeepSeek screener; temperature 0, exemplar order reversed between passes; disagreement abstains) reads only the source's own text. Calibrated each month on the even half of the 2026-10-25 human anchor (`../frontier-selection/gold.jsonl`, exemplars from the odd half only); unqualified calibration stops the campaign (`campaign_labels_unqualified`). First calibration, 2026-10-26: pick-vs-other κ 0.875 (the two human labellers: 0.87), pick precision 0.94, recall 0.85, abstention 2.4%, ¥5.2 for 248 calls. Every call is reserved and settled in the lab's budget ledger (`RsiCampaignBudget`: ¥1,000 per campaign, ¥30,000 per Beijing month) and cached, so a rerun never pays twice.
3. **build** (`frontier_assemble.mjs build`): manifest and inputs. Development = month M-2, confirmation = month M-1 (sealed: new items no campaign has opened). Claim `superiority`; the sampling unit is the **day** (`frontierMixSelect` shares one day's size, group shares, language target and event picks across sources, so sources inside a day are not independent); endpoint = a day's weighted accuracy over its labelled set, a pick weighing 3; groups = confirmation days with ≥20 labelled rows (decided from labels, never outcomes). The supply report gives days, labelled rows, abstentions, replay fidelity against production's real picks, selector drift between lab and production, and the minimum detectable effect.
4. **run** (`run.mjs run`): development freezes the registered threshold with the highest mean day difference among those losing no safety pick and selecting at most 1.1× the baseline volume (ties: nearest the baseline; no positive difference ends the campaign). Before confirmation the runner reserves the quarter's error budget and the corpus in the confirmation ledger (a corpus is opened by one campaign only; a surface's confirmations draw at most α = 0.05 per quarter, 0.05/3 per monthly campaign), then measures the frozen policy and the baseline and stops at `awaiting-evaluation`.
5. **receipt** (`evaluator.mjs receipt`, own Ed25519 key, no network): recomputes the development choice and the confirmation (twice — a deterministic consumer gives the same bytes) and signs a receipt bound to the runner's request, including the integrity facts it attests. The runner accepts it only when those facts equal its own observations; a missing or unbound receipt is retried, never persisted.
6. **resume** (`run.mjs resume`): the registered statistics (`statistics.py`, procedure `rsi-paired-group-v5`: one-sided paired t at half the claim's alpha, ≥25 groups, influence and zero-variance checks; a candidate losing a safety pick is not qualified; `superiority` requires the zero-model-call cost identity).
7. **report**: `monthly_report.mjs` writes `report.json` and a Chinese `report.md`, signed by the evaluator, into `/srv/rsi-lab/outbox/<month>/`, whatever the verdict. A qualified campaign is also finalized (`evaluator.mjs evidence` + `finalize.mjs`, publisher and evaluator file keys, network none) into a signed `bundle.json`. In this phase nothing is imported into production.

`reports/statistics-v5-qualification.json` is the procedure's own qualification: two seeds of 20,000 simulations per scenario, including superiority nulls (normal and skewed) and a modest effect at 25 and 31 day groups and at α 0.05 and 0.05/3. It is mathematical evidence about the procedure, never about a real candidate.

## Commands

```sh
node evals/rsi-campaigns/frontier_assemble.mjs plan --export frontier-2026-11.json.gz --month 2026-11 --out plan.json
node evals/rsi-campaigns/frontier_labels.mjs calibrate|label ...            # see the file header
node evals/rsi-campaigns/frontier_assemble.mjs build --export ... --plan plan.json --labels labels.json --calibration calibration.json --out-dir dir
node evals/rsi-campaigns/run.mjs run|resume|report --manifest dir/manifest.json --inputs dir/inputs.json --config /run/rsi-lab/config.json --out-dir dir/run
node evals/rsi-campaigns/evaluator.mjs receipt|evidence|report|qualification ...
pnpm test:rsi
```

A rehearsal names explicit windows and a prefix: `rsi-lab-monthly.sh 2026-10 --development-days 2026-10-01..2026-10-12 --confirmation-days 2026-10-13..2026-10-25 --id-prefix rehearsal-` (a rehearsal is never finalized).

## Lab host

`deploy/rsi-campaign/rsi-lab-install.sh lab` builds the image on the lab host from `git archive HEAD` and installs the launcher, the owner inputs under `/etc/rsi-lab/owner-inputs` (mounted read-only at `/run/rsi-lab`) and the timer; `rsi-lab-install.sh production` installs the export, the push script and its timer on the serving host. The lab database is its own PostgreSQL container on its own network (`evimed_rsi_lab`, role `rsi_lab`); keys are generated on the lab host and never leave it; the DashScope key is the only provider credential and only the jury steps mount it. The lab configuration's `transport: {kind: "none"}` is a lab without the OSS channels: public and synthetic campaigns run, an authorized-incident campaign does not. The OSS transport and Secrets Manager signer remain in the code for when those channels are provisioned.

Local verification: `python3 -m pip install --target ../.evimed-local/toolchains/rsi-python -r evals/rsi-campaigns/requirements.txt`, then `pnpm test:rsi`, and the server's `rsi*.test.mjs` serially with a disposable localhost `OPEN_SCIENCE_TEST_POSTGRES_URL`.

Not yet: paid DSH consumers and skill/tool activation, the production import of a bundle (the thin layer is opt-in and not deployed), authorized-incident campaigns (they need the OSS channels), and the Harness2/GEPA research arms.
