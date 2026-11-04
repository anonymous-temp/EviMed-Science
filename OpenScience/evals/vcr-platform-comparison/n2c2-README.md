# n2c2 platform protocol matching

This adapter evaluates supplied n2c2 2018 Track 1 records through automated conversation, uploads, the saved study protocol and the trial_to_patient matching view. The assistant receives complete longitudinal text and the thirteen published textual requirements, and creates its representation, observations and judgments through normal product tools.

The official train split has 202 patients and the official test split has 86. Manifests, provenance, prediction freezes and metrics remain separate. Both splits have prior experiment exposure. Neither is a fresh independent holdout.

## Inputs and authorization

The public n2c2-protocol.json records the full definitions, guide provenance and exact package digests. The latest-record evaluation date and longitudinal continuity convention accompany the requirements. Binary scoring defaults stay outside model inputs. [Challenge description](https://n2c2.dbmi.hms.harvard.edu/challenge/2018-track-1-clinical-trial-cohort-selection), [shared-task publication](https://pmc.ncbi.nlm.nih.gov/articles/PMC6798568/)

The private authorization record must identify n2c2-2018-t1, user-confirmed processing, the sole destination https://api.deepseek.com, an opaque confirmation reference, the exact source root and all pinned archive hashes. Its experimentId is the intended unique vcrbench-* launcher name. Other data, destinations and experiments are refused.

The preparer verifies package hashes before reading notes. It extracts original CDATA TEXT bytes, strips training TAGS, and records XML digests and each original record date, offset and segment hash. Only patient.txt and protocol.txt enter each upload whitelist. Original filename mappings remain in private provenance. Notes, labels, outputs and authorization files require an ignored .evimed-local/acceptance directory and restrictive permissions.

~~~sh
python3 OpenScience/evals/vcr-platform-comparison/n2c2-prepare.py \
  --source-root "$N2C2_SOURCE_ROOT" \
  --authorization "$N2C2_AUTHORIZATION_FILE" \
  --out "$N2C2_PREPARED_DIRECTORY"
~~~

Preparation creates immutable train and test manifests. Host admission verifies the original authorization bytes, parses them as authority and requires the inline snapshot to match. It reconstructs every note and provenance entry from the pinned original archive before dispatch. The following performs the same check without inference.

~~~sh
python3 OpenScience/evals/vcr-platform-comparison/n2c2-prepare.py \
  --verify-manifest "$N2C2_PREPARED_DIRECTORY/test/cases.json"
~~~

## Product path

The driver task protocol_matching uploads both files into a new account/project for one patient, creates a normal session and dispatches one automated answer-line request. It observes ordinary run/job completion and captures the saved protocol assessment and criterion states. A finished conversation without a saved assessment remains a missing feature result.

Formal execution retains the existing clean, pushed revision and fresh Docker isolation/startup probes. The provider must resolve to deepseek-flash, with memory and learning disabled. Add the narrow authorization flag to the existing launcher arguments.

~~~sh
node OpenScience/evals/vcr-platform-comparison/container-launch.mjs \
  --name "$N2C2_EXPERIMENT_NAME" \
  --state "$N2C2_CONTAINER_STATE" \
  --collection "$PUBLIC_FROZEN_COLLECTION_MANIFEST" \
  --docker-client "$LINUX_DOCKER_CLIENT" \
  --budget-dir "$N2C2_BUDGET_DIRECTORY" \
  --n2c2-authorization "$N2C2_PREPARED_DIRECTORY/authorization-binding.json"
~~~

Without the flag, the launcher retains its synthetic-data configuration. Protected protocol manifests require matching authorization in the actual startup receipt. The binding covers exact prepared inputs, experiment name and process instance. Closed registry, web, browser, public-network, workload-token and workspace fences continue to apply. Raw archives and sealed labels are not mounted into the agent runtime.

Before resource creation, the launcher checks executable Linux-compatible little-endian ELF64 format and architecture against the control image. It copies validated bytes. A host Mach-O or wrong CPU client is refused.

The public frozen collection remains an isolation fixture. Protocol matching does not request or manufacture a registry trial. Run train and test manifests as separate campaigns with the existing run.mjs CLI and separate outputs.

## Prediction freeze and scoring

Finish or explicitly stop the campaign and preserve every attempt, then freeze saved product views before opening reference labels.

~~~sh
python3 OpenScience/evals/vcr-platform-comparison/n2c2-score.py freeze \
  --campaign "$N2C2_CAMPAIGN_DIRECTORY" \
  --manifest "$N2C2_PREPARED_DIRECTORY/test/cases.json" \
  --out "$N2C2_PREDICTION_FREEZE"
~~~

Mapping uses complete literal clauses after whitespace/Unicode normalization and removal of an explicit public tag prefix. Truncated, merged, duplicated, wrong-kind and unmatched clauses stay unmapped. Rows without a saved decision stay unprocessed. Failed conversations may retain usable rows. Every planned patient contributes thirteen denominator units and a separate execution status.

Native states retain decisive satisfaction/refutation, clinical unknown, pending recheck, non-applicability, unprocessed and unmapped. Pending recheck retains its date information and cannot receive a favorable default or enter the complete-assessment subset.

After the freeze, the scoring command checks unchanged artifacts and opens the appropriate reference labels.

~~~sh
python3 OpenScience/evals/vcr-platform-comparison/n2c2-score.py score \
  --predictions "$N2C2_PREDICTION_FREEZE" \
  --source-root "$N2C2_SOURCE_ROOT" \
  --out "$N2C2_METRICS_DIRECTORY"
~~~

Native strict agreement counts correct decisive rows over all planned units. Binary sensitivity b reads genuine clinical unknown as not met. Sensitivity c additionally reads genuine clinical unknown as met for ENGLISH and MAKES-DECISIONS. These conventions do not establish why evidence was unknown.

Official binary outputs cover complete-assessment patients and a separately named all-attempt mechanical reading. The latter fills pending, unprocessed, unmapped and non-applicable units as not met for the binary interface, with explicit counts. It supplies no clinical negative finding.

The exact supplied official scorer runs unchanged on labels-only temporary XML under the private output directory. No patient text enters scoring folders. Independent micro/macro F1 calculations are cross-checked against the pinned script on fabricated labels.

## Offline checks and remaining gates

~~~sh
node --test OpenScience/evals/vcr-platform-comparison/*.test.mjs
python3 -m unittest discover -s OpenScience/evals/vcr-platform-comparison -p 'test_*.py'
python3 OpenScience/evals/vcr-platform-comparison/n2c2-test.py
~~~

Set EVIMED_N2C2_ROOT to include the exact official-script synthetic-label check. Three fake HTTP cases cover automated dispatch, two uploads, saved assessment, missing/failed processing and account cleanup. They do not execute a kernel or model.

This preparation has no paid inference result. Integration/review, a fresh protected-data container probe, actual completion/coverage, clinical evidence review and deployment remain separate gates.

## Snapshot status

This isolated preparation snapshot passed 29 Node checks, 32 existing Python checks and 16 n2c2-specific Python checks. The exact official scorer was cross-checked on fabricated labels. The supplied train/test inputs were prepared privately and passed the initial manifest/hash checks. The latest reconstruction guard has synthetic coverage and awaits a fresh complete protected-data preflight after integration. Notes and labels are absent from this commit.

The pending-recheck sensitivity and authorization-snapshot splicing findings were corrected with regressions. Final independent review remains pending at snapshot time. The protected-data Docker startup path and actual DSH protocol-matching task still need a fresh no-model isolation probe and an explicitly budgeted product pilot after integration. No n2c2 paid call, clinical performance estimate or new holdout result is supplied here.
