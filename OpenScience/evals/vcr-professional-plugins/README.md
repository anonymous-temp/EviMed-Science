# VCR professional plugins: local full-input evaluation

The current results, source and input hashes, scientific limitations, quality findings and prior attempts are in [RUN-20261105.md](./RUN-20261105.md). The original early assessment text is preserved verbatim in [INITIAL-20261105.md](./INITIAL-20261105.md); its missing-package and incomplete-run statements describe that earlier stage, not the current version 1.4 result.

Inputs and generated records stay under private `.evimed-local` directories. The public report contains aggregate results and no patient rows. The runner calls the local R engine and does not call a model API. Product execution, numerical checks, privacy diagnostics, model calibration, hosted operation and clinical validation have separate scopes in the report.

## Inputs and execution

From the repository root, provide PhysioNet 2012 `set-a.tar.gz`, `set-b.tar.gz`, `set-c.tar.gz` and `Outcomes-a.txt`/`-b.txt`/`-c.txt` under the raw input directory, and the locally authorized ACTG CSV. Prepare the exact R 4.3.3 runtime library as described below, then select a fresh private output directory:

```sh
VCR_EVAL_RAW_DIR="$PWD/.evimed-local/acceptance/vcr-benchmark-20261029/numeric/raw" \
VCR_EVAL_ACTG_INPUT="$PWD/.evimed-local/acceptance/vcr-benchmark-20261029/numeric/input/actg_survival.csv" \
VCR_EVAL_OUTPUT="$PWD/.evimed-local/acceptance/my-new-vcr-eval/clinical" \
VCR_EVAL_RLIB="$PWD/.evimed-local/acceptance/vcr-professional-full-20261105/rlib" \
  OpenScience/evals/vcr-professional-plugins/run.sh
```

The runner refuses an output directory that already contains results. It prepares A/B/C data, uses A-only preprocessing, runs the five-copy product synthesis with an external 2,400 CPU-second / 3,000 wall-second watchdog, scores completed synthetic output and encoding relationships, and runs the cohort, HR, ACTG and known-truth checks. Each subprocess logs to the chosen output; failures and `*.exit` files must be inspected alongside JSON status, because an engine can return a structured failure while the R process exits normally. Runtime package versions are verified before execution.

`run.sh` reads the current checkout. For a frozen-source campaign, use `freeze_source.py` with a fresh destination, record the resulting manifest hash, mount that read-only snapshot as `/repo`, mount inputs and a fresh output directory separately, and record each command, image digest and input hash. The dated report records this distinction; copying a manifest after a run does not prove the bytes used by that run. `test_paths.py` checks separate fabricated input/output locations and fresh offline download-directory creation without network access.

## Locked R library

`python3 OpenScience/evals/vcr-professional-plugins/download_locked_packages.py` downloads the 70 runtime-lock archives from the dated 2026-09-28 CRAN snapshot to the private local mirror. It creates its destination when missing; `VCR_EVAL_CRAN_DIR` can override the `src/contrib` destination. Then run from the repository root:

```sh
mkdir -p .evimed-local/acceptance/vcr-professional-full-20261105/rlib
docker run --rm --network none --cpus 4 --memory 8g \
  -e VCR_R_LIBS=/rlib -e VCR_R_LOCKS=runtime -e VCR_R_BUILD_NCPUS=4 \
  -e VCR_CRAN_REPO=file:///cran -e VCR_ENGINE_ROOT=/repo/项目代码/vcr-engine \
  -v "$PWD:/repo:ro" \
  -v "$PWD/.evimed-local/acceptance/vcr-professional-full-20261105/cran:/cran:ro" \
  -v "$PWD/.evimed-local/acceptance/vcr-professional-full-20261105/rlib:/rlib" \
  --entrypoint bash evimed-vcr-native-numeric:20261026 \
  /repo/OpenScience/scripts/vcr/r-library.sh install
```

The package versions are locked, but this downloader does not establish byte identity with a past download. Preserve and compare the private archive hash list and installation receipt. The 2026-11-05 run used image digest `sha256:61a4f80ef9e7e92aaa285c06f7e24ad8bd1234f7201b41a888b10a1bd77df583` and a separately verified 70-package library.
