# Bibliometric analysis agent (`文献剂量分析/`)

AI-driven bibliometric analysis of a research topic: PubMed retrieval, metadata cleaning,
network analysis, a CiteSpace-style reproduction, insight generation and a written report.

**The directory name is historical.** This agent is about literature metrics (文献计量分析),
not drug dosing. It is one of the Python specialist engines of the EviMed Science monorepo and
is reached by the hosted platform through `OpenScience/deploy/specialist-adapter/`.

Numbers come from deterministic analysis code (counts, matrices, networks, burst detection,
bibliometric laws). The model writes search strategies, translations and narrative text; with
no DeepSeek key the narrative falls back to templates.

## Layout

- `src/bibliometric/`: `cli.py` (click CLI), `pipeline.py` (`AnalysisPipeline`), `config.py`,
  and the steps `pubmed/`, `cleaning/` (including ROR institution lookup), `analysis/`,
  `export/` (VOSviewer files), `visualization/`, `insight/`, `report/` and `llm/`.
- `start.py`, `main.py`: FastAPI service on port 6066. `evimed_runner.py`: fixed-argument
  adapter. `tests/`: pytest suite.

A run writes `report.md` plus `data/` (search metadata, raw and cleaned records, citation
coverage), `figures/`, `tables/` and `vosviewer/` under its output directory.

## Run it

Use a virtual environment for this engine, then:

```bash
cd 项目代码/文献剂量分析
pip install -r requirements.txt

# CLI
PYTHONPATH=src python3 -m bibliometric analyze "semaglutide obesity" \
  --date-range 2018-2025 --max-records 2000

# FastAPI service (also: pip install -r requirements_ws.txt), port 6066
python start.py
```

CLI options: `--date-range/-d YYYY-YYYY`, `--max-records/-n`, `--output-dir/-o`,
`--modules/-m` (`trend,network,burst,timeline,frontier,insight,report`; default all),
`--api-key` and `--email` (NCBI; override the environment), `--verbose/-v`. `pyproject.toml`
also declares the console script `evimed-bibliometric`.

`start.py` serves `GET /health` and keeps an outbound WebSocket to the gateway of the archived
Java platform, uploading finished reports to object storage. That mode belongs to the archived
platform, and `FRONTEND_DEV_GUIDE.md` documents the message protocol of that platform's web
front end, not the hosted product's.

The adapter is what the hosted platform runs:

```bash
python evimed_runner.py --request request.json --output-dir out/
```

`request.json` takes `topic` (required), `dateFrom`, `dateTo`, `maxRecords` (20 to 5000, default
1000) and `outputLanguage` (`zh` or `en`). It writes `report.md` and `result.json` (`status`,
`records`, a per-step `modules` ledger naming degraded or failed steps, citation coverage and
the sources not used) and exits non-zero on failure.

## Configuration

Settings come from the process environment, then `.env` and `deploy.env` beside this file; both
are git-ignored and `.env.example` lists the names. Never commit values.

- PubMed: `NCBI_API_KEY`, `NCBI_EMAIL`, `PUBMED_ESEARCH_SORT`. A key raises the rate limit.
- Citations: `OPENALEX_API_KEY`. iCite is tried first and needs no key; OpenAlex requires one.
- Model: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_FLASH_MODEL`, `DEEPSEEK_PRO_MODEL`,
  `LLM_MAX_TOKENS`, `DEEPSEEK_PRO_REASONING_RESERVE_TOKENS`, `DEEPSEEK_MAX_OUTPUT_TOKENS`,
  `DEEPSEEK_PRO_TIMEOUT_SECONDS`, `DEEPSEEK_FLASH_TIMEOUT_SECONDS`.
- Limits: `MAX_RECORDS`, `NETWORK_MAX_NODES_KEYWORD`, `_AUTHOR`, `_INSTITUTION`, `_COUNTRY`,
  `ROR_TOP_N`, `OUTPUT_DIR`.
- Service: `WORKERS`, `RELOAD`, `BIBLIOMETRIC_ROOT`, `INTERNAL_DB_URL`, `CLEANUP_LOCAL_REPORT`,
  and for the archived gateway `JAVA_WS_URL`, `JAVA_TOKEN_URL`, `OSS_ACCESS_KEY_ID`,
  `OSS_ACCESS_KEY_SECRET`, `OSS_ENDPOINT`, `OSS_BUCKET_NAME`, `OSS_PUBLIC_BASE_URL`.

Requirements files: `requirements.txt` (engine), `requirements_ws.txt` (FastAPI service),
`requirement.txt` (full pinned freeze) and `requirements.lock` (generated for the hosted image
by `OpenScience/scripts/ops/compile-engine-locks.sh bibliometric`; do not edit by hand).

## Tests

```bash
python -m pytest tests -q
```

`pyproject.toml` puts `src` on the path, and the suite needs no API keys.

## How the SaaS reaches it

Not through `start.py`. `OpenScience/deploy/web/docker-compose.yml` builds the
`evimed-bibliometric-agent` service from `OpenScience/deploy/specialist-adapter/` with
`AGENT_DIR=项目代码/文献剂量分析` and `AGENT_KIND=bibliometric-analysis`. The adapter serves
`/api/v1/evimed/bibliometric-analysis`, runs `evimed_runner.py` for each job in an isolated
process with a job slot and a wall-clock limit, and reports usage to the control plane. The
research server calls it as the `bibliometric_analysis` engine tool through
`EVIMED_BIBLIOMETRIC_ANALYSIS_URL`. An NCBI key a researcher saved in their data-source settings
reaches the job as `NCBI_API_KEY`; model calls go through the control plane's model gateway.

`CLAUDE.md` describes the project for coding agents; its run instructions contain an absolute
path from the original author's machine, so follow the commands above instead.
