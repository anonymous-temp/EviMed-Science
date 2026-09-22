# EviMed knowledge-source plugin

One independent service between the outside world and the EviMed platform for *knowledge* sources
(journals, PubMed/Europe PMC streams, regulators, trial registries, societies, media, AI news):
the source registry, scheduling, protected fetching, parsing, normalisation, per-source
de-duplication, on-demand enrichment and source health. The platform pulls from it over one HTTP
contract and never reaches a source itself; the plugin never calls the platform, stores no user
data and makes no content-generating model call (plan `docs/superpowers/specs/2026-09-21-frontier-feed-medical-aihot-plan.md`, chapter 14).

## The contract

`contract/knowledge-plugin-openapi.yaml` (v1.1.0, normative; a vendored copy of the plan's file,
kept byte-identical by a test while this lives in the monorepo). Paths: `/v1/manifest`,
`/v1/health` (no token), `/v1/sources[/{id}]`, `/v1/entries?after=<seq>` (the stream, ascending
`seq`), `/v1/entries/{id}`, `/v1/entries/{id}/text` (on-demand abstract and enrichment),
`POST /v1/entries/{id}/refresh`, `/v1/lookups` (empty in batch 1; `POST` answers 501).
Bearer token from a file; errors are `{code, message, retryable, details?}`.

## Run it locally

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt -e .
python -c "import secrets; print(secrets.token_urlsafe(32))" > /tmp/kp.token && chmod 600 /tmp/kp.token
KNOWLEDGE_PLUGIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/evimed_knowledge_dev \
KNOWLEDGE_PLUGIN_TOKEN_FILE=/tmp/kp.token \
KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE=/path/to/contact.email \
KNOWLEDGE_PLUGIN_PORT=18080 \
  .venv/bin/python -m knowledge_plugin serve
curl -s localhost:18080/v1/health
curl -s -H "Authorization: Bearer $(cat /tmp/kp.token)" 'localhost:18080/v1/entries?after=0&limit=5'
```

Exits: `direct`/`api` (pinned connections from this host), `relay` (through the Tokyo node: TLS to the
proxy, a CONNECT tunnel, TLS to the target) and `browser` (a headless Chromium over CDP; one context per
poll; every request outside the source's `allowed_hosts` aborted). A missing exit or key is the
deployment's gap, not the source's failure: those sources wait and `/v1/health` names the exit
`unconfigured`. For the browser locally: `chrome --headless --remote-debugging-port=9222
--user-data-dir=/tmp/kp-chrome` and `KNOWLEDGE_PLUGIN_BROWSER_CDP_URL=http://127.0.0.1:9222`;
`python -m knowledge_plugin.browser render <url> --wait <css>` prints a rendered page (fixtures).

`python -m knowledge_plugin.probe --egress relay` (or `--source <id>`, repeatable) reads the enabled
sources once through their own exit — plan, protected fetch, parse — and prints one JSON line each,
writing nothing: the production check for exits that only work from Beijing (the Tokyo relay, the
regulators behind the browser), run inside the plugin container.

The database must exist; the schema (`knowledge_plugin/schema.sql`) is applied at every start,
idempotently, behind an advisory lock. `python -m knowledge_plugin migrate` applies it alone;
`python -m knowledge_plugin check-registry` validates the registry and each enabled row against
its adapter without a database.

The image: `docker build --build-arg PYTHON_BASE_IMAGE=… --build-arg PIP_INDEX_URL=… --build-arg PLUGIN_BUILD=<rev> .`
(runs as uid 10002, read-only root filesystem friendly, healthcheck on `/v1/health`, port 8080).

## Environment

| variable | default | meaning |
|---|---|---|
| `KNOWLEDGE_PLUGIN_DATABASE_URL` | — (required) | libpq URL of the plugin's own database, without the password |
| `KNOWLEDGE_PLUGIN_DATABASE_PASSWORD_FILE` | unset | the role's password, by path |
| `KNOWLEDGE_PLUGIN_TOKEN_FILE` | unset | the bearer token (0600 file, shared with the platform); unset = every request refused |
| `KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE` / `KNOWLEDGE_PLUGIN_CONTACT_EMAIL` | unset | the `mailto:` in the `EviMedBot/1.0` User-Agent (file wins); never logged |
| `KNOWLEDGE_PLUGIN_NCBI_KEY_FILE`, `KNOWLEDGE_PLUGIN_OPENFDA_KEY_FILE` | unset | optional keys; absent or empty = anonymous rate (NCBI 0.4 s, openFDA 300/day) |
| `KNOWLEDGE_PLUGIN_EVIMED_API_KEY_FILE` | unset | the team's EviMed evidence API key, sent as `Authorization: Bearer` on its API path only (the `evimed-api` scans); unset = those sources wait |
| `KNOWLEDGE_PLUGIN_EDGE_PROXY_URL` / `KNOWLEDGE_PLUGIN_EDGE_PROXY_CREDENTIALS_FILE` | unset | the `relay` exit: the Tokyo TLS forward proxy (`https://<node>`) and its `user:password` file; unset = relay sources wait |
| `KNOWLEDGE_PLUGIN_BROWSER_CDP_URL` / `KNOWLEDGE_PLUGIN_BROWSER_TIMEOUT_S` | unset / `60` | the `browser` exit: `http://frontier-browser:9222` (resolved to an IP: Chromium refuses a non-IP Host); unset = browser sources wait |
| `KNOWLEDGE_PLUGIN_CRAWL` | `1` | `0` serves the stored stream without crawling |
| `KNOWLEDGE_PLUGIN_PORT` / `KNOWLEDGE_PLUGIN_HOST` | `8080` / `0.0.0.0` | listen address |
| `KNOWLEDGE_PLUGIN_REGISTRY` | `registry/sources.json` | the runtime registry file (watched; re-synced on change) |
| `KNOWLEDGE_PLUGIN_CONCURRENCY` / `KNOWLEDGE_PLUGIN_TEXT_CONCURRENCY` | `4` / `2` | parallel polls / enrichments |
| `KNOWLEDGE_PLUGIN_BUILD` | `dev` | shown as `manifest.plugin.build` (the image sets it from `PLUGIN_BUILD`) |
| `KNOWLEDGE_PLUGIN_LOG_LEVEL` | `INFO` | log lines carry URLs without their query string |

## Add or change a source

The registry is data, not code. `registry/sources.json` is generated from the probe registry
(`registry/probe-sources.json`) plus the hand-kept `registry/overrides.json`:

1. Edit `registry/overrides.json` (keyed by source id; fields win over derived values, `config`
   merges key by key; `_why` keys are comments) — e.g. selectors for a list page, a cadence, an
   `authority`, `enabled: false`. A source that is not in the probe registry (the EviMed API scans)
   is a whole row in `registry/extra-sources.json`. Which rows are on is a rule in the build
   (P0 on every exit this build has; P1 list pages with selectors; the EviMed scans; relay sources
   the Tokyo node read on 2026-09-22, `registry/research/`), and an adapter that rejects a row's
   configuration keeps it off with the reason.
2. `python tools/build_registry.py` rewrites `registry/sources.json` (deterministic; `--check`
   verifies the committed file). URLs are templates: `{since:%Y-%m-%d}`, `{today:%Y%m%d}`,
   `{issn}`, `{cursor}` — a literal date in a URL fails the build.
3. `python -m knowledge_plugin check-registry` and `pytest tests/test_registry_load.py`.
   A running plugin picks the new file up within a minute (rows missing from the file are
   retired, never deleted; an operator's `operator_enabled` survives reloads).

## Tests

`pytest` (from this directory, with the dev requirements). Database tests use a scratch database
on `KNOWLEDGE_PLUGIN_TEST_DATABASE_URL` (default `postgresql://postgres@127.0.0.1:55433`) and are
skipped when no server answers. Adapters are tested against recorded real responses in
`tests/fixtures/` (`tests/adapters/`, `tests/enrich/`).
