# EviMed knowledge-source plugin

One independent service between the outside world and the EviMed platform for *knowledge* sources
(journals, PubMed/Europe PMC streams, regulators, trial registries, societies, media, AI news):
the source registry, scheduling, protected fetching, parsing, normalisation, per-source
de-duplication, on-demand enrichment and source health. The platform pulls from it over one HTTP
contract and never reaches a source itself; the plugin never calls the platform, stores no user
data and makes no content-generating model call (plan `docs/superpowers/specs/2026-09-21-frontier-feed-medical-aihot-plan.md`, chapter 14).

## The contract

`contract/knowledge-plugin-openapi.yaml` (v1.5.1, normative; a vendored copy of the plan's file,
kept byte-identical by a test while this lives in the monorepo). Paths: `/v1/manifest`,
`/v1/health` (no token), `/v1/sources[/{id}]`, `/v1/entries?after=<seq>` (the stream, ascending
`seq`), `/v1/entries/{id}`, `/v1/entries/{id}/text` (on-demand abstract and enrichment),
`POST /v1/entries/{id}/refresh`, `/v1/media/{id}` (1.5.0: a stored image's bytes), `/v1/lookups` (empty in batch 1;
`POST` answers 501).
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
| `KNOWLEDGE_PLUGIN_ELSEVIER_KEY_FILE` | unset | an Elsevier API key, sent as `X-ELS-APIKey` to `api.elsevier.com` only; the paper text chain then asks Elsevier's Article Retrieval API for the abstracts of its DOIs (`enrich/elsevier.py`); unset = never asked |
| `KNOWLEDGE_PLUGIN_EDGE_PROXY_URL` / `KNOWLEDGE_PLUGIN_EDGE_PROXY_CREDENTIALS_FILE` | unset | the `relay` exit: the Tokyo TLS forward proxy (`https://<node>`) and its `user:password` file; unset = relay sources wait |
| `KNOWLEDGE_PLUGIN_BROWSER_CDP_URL` / `KNOWLEDGE_PLUGIN_BROWSER_TIMEOUT_S` | unset / `60` | the `browser` exit: `http://frontier-browser:9222` (resolved to an IP: Chromium refuses a non-IP Host); unset = browser sources wait |
| `EVIMED_EVIDENCE_FEED_URL` | unset (the EviMed compose overlay defaults it to `$OPEN_SCIENCE_PUBLIC_URL` + the evidence base path + `/feed.json`) | the platform's own evidence feed (`https://<platform>/evidence/feed.json`), read as the source `evimed-evidence` (`platform_produced`, contract 1.3.0); unset = the source loads disabled (`feed_url_unset`) and nothing is polled. It must be the address the platform links its cards on, a public one: only the cards on the host the feed was read from are handed on, and the fetcher reaches global addresses only, so a compose-internal service name does not work. A platform whose public evidence pages are off answers the feed 404 `evidence_public_not_enabled`, which reads as an empty feed, not a failure |
| `EVIMED_SOURCE_REQUESTS_URL` | unset | optional public HTTPS JSON source wish list, pulled daily through protected fetching; only supported AI discovery readers on plugin-approved scholarly hosts are admitted, existing exclusions preserved |
| `KNOWLEDGE_PLUGIN_CRAWL` | `1` | `0` serves the stored stream without crawling |
| `KNOWLEDGE_PLUGIN_DISCOVERY` | `1` | `0` stops automatic source discovery and the source lifecycle (`discovery.py`, `lifecycle.py`) |
| `KNOWLEDGE_PLUGIN_DISCOVERY_CAPS` | unset | the daily validations per candidate line, `line=n,…` over the defaults (`outbound=60,journal=25,directory=30,hot-origin=15,social=20,request=25,readmit=30`) |
| `KNOWLEDGE_PLUGIN_DISCOVERY_OUTBOUND_PAGES` | `120` | article pages the outbound line reads a day to find the sites they link to |
| `KNOWLEDGE_PLUGIN_PORT` / `KNOWLEDGE_PLUGIN_HOST` | `8080` / `0.0.0.0` | listen address |
| `KNOWLEDGE_PLUGIN_REGISTRY` | `registry/sources.json` | the runtime registry file (watched; re-synced on change) |
| `KNOWLEDGE_PLUGIN_CONCURRENCY` / `KNOWLEDGE_PLUGIN_TEXT_CONCURRENCY` | `4` / `2` | parallel polls / enrichments |
| `KNOWLEDGE_PLUGIN_BUILD` | `dev` | shown as `manifest.plugin.build` (the image sets it from `PLUGIN_BUILD`) |
| `KNOWLEDGE_PLUGIN_LOG_LEVEL` | `INFO` | log lines carry URLs without their query string |
| `KNOWLEDGE_PLUGIN_SOCIALDATA_KEY_FILE` | unset | X through SocialData (`Authorization: Bearer`, added by the transport); unset or empty = no X |
| `KNOWLEDGE_PLUGIN_SOCIALDATA_DAILY_USD` | `5` | the day's cap (Asia/Shanghai day) at `objects × US$0.0002`; reached = X waits until the next day |
| `KNOWLEDGE_PLUGIN_DAJIALA_KEY_FILE` | unset | WeChat official accounts through Dajiala (its `key` query parameter, added by the transport); unset = no WeChat |
| `KNOWLEDGE_PLUGIN_DAJIALA_DAILY_CNY` | `30` | the day's cap at Dajiala's own `cost_money`; reached = WeChat waits until the next day |
| `KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_URL` | unset | the GEO module's six-platform crawler (production: the platform's `OPEN_SCIENCE_GEO_SOCIAL_URL`); unset = no monitoring |
| `KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_DAILY` / `KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_TIMEOUT_S` | `120` / `150` | crawler requests a day, spread evenly; one request's deadline |
| `KNOWLEDGE_PLUGIN_MEDIA_DIR` / `KNOWLEDGE_PLUGIN_MEDIA_CAP_MB` | unset / `3072` | the media store's writable volume and its cap (least recently served evicted first); unset = no images stored |
| `KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY` | `social-sources.json` beside the registry | the social sources' registry file |

## Daily medical subscription discovery

The existing crawler checks a bounded rotation of enabled medical publishers once per Shanghai calendar day. It reads explicit RSS/Atom links advertised by their own homepages, probes them through the normal protected fetch and robots policy, and validates nonempty feeds through the existing feed adapter. Only the already admitted HTTPS origin and medical category are inherited; mixed/general publishers, browser-only exits and owner-excluded institutions are not silently reclassified. Source discovery does not inherit an API robots exemption.

Validated feeds are stored under the existing `medical_sources_admitted` metadata key and enter the ordinary polling queue. Startup, file reload, AI source-request admission and medical discovery compose both dynamic channels together under one registry transaction lock. Parent removal/disable and current operator exclusions are checked again on composition. The source table owns the first successful fetch and entry count; a successful probe is not a published article.

`medical_source_discovery` retains the cursor, current lease and the last thirty measured runs: attempted publishers, validated candidates, admitted feeds, deferrals and zero-growth days. `newInstitutions` is zero by construction: this mechanism expands subscription coverage within trusted institutions, not the set of trusted institutions — new institutions are the automatic source discovery's (below), whose `parent-feed` line counts these admissions. It never invents a new-source quota or bypasses robots/challenges. The hourly discovery loop skips a day it has already completed; bounded interrupted attempts can resume on a later tick.

## Automatic source discovery and the source lifecycle

The target (owner, 2026-10-22) is at least ten net new working sources a day: admitted minus retired, where working
means the source produced a new entry during a seven-day trial. `discovery.py` runs hourly and does each step once a
Shanghai day:

1. **Retire** by rule (`lifecycle.py`), any source: two robots refusals in a row; 401/403 for seven days; silent past its
   own rhythm (AIHOT's rule: quiet longer than four times its median gap over 90 days; while the rhythm cannot be
   measured, 14 quiet days for a discovered source, 60 for a row of the registry file); off-topic by the platform's own
   screen (more than half not medical and fewer than three medical entries in its window). A retired source is left
   out of the registry composition (`sources.retired_at`), keeps its row and history, and is re-checked (robots 30
   days, 401/403 7, silence 14; off-topic only by an operator).
2. **Decide trials** that ended: admitted with a new entry after the first poll and no more than half of what the
   platform screened judged not medical; with no verdict from the platform, admitted on its own fetch results when its
   medical basis is in data (a MEDLINE journal, a listed organisation, a request), else it waits up to seven more days.
3. **Gather** candidates by line — `outbound` (sites linked from recent entries' pages), `journal` (MEDLINE journals
   from the literature streams, then the NLM catalogue in rotation), `directory` (`registry/discovery.json`),
   `hot-origin` (the journals and sites of entries several publishers carried), `social` (quoted accounts, when the
   social adapters store them), `request` (the source-request manifest, any lane but `ai`), `parent-feed`
   (`medical_discovery.py`), `readmit` (retired sources due for a re-check).
4. **Validate** within each line's daily cap: reachable (direct, then the relay), robots allows it, an existing adapter
   reads it, an item dated within 30 days, MEDLINE for a journal (and at least eight Crossref articles in 30 days). A
   valid candidate becomes an ordinary registry row on trial (`mixed` lane, every 6–24 hours; journals every 12–24).
   The journal line waits while Crossref's allowance is past 80 % used.

The plugin makes no content judgement: whether a source is medical is the platform's screen of what the source
delivered, reported back by the platform after each mirror (`POST /v1/sources/screening`). Counts by line and day are
in `discovery_daily` and `/v1/health` `discovery` (`today`, `history` of 14 days, `by_line`, `in_trial`).
`python -m knowledge_plugin lifecycle` prints what the rules would retire now (writes nothing; `--apply` retires);
`python -m knowledge_plugin discover [--lines a,b] [--caps line=n,…]` runs one cycle in the foreground.

## The paper text chain (contract 1.5.1)

`/text` for a journal entry (`knowledge_plugin/enrich/`, rt-papers 2026-10-22): the indexes first — PubMed, Europe PMC,
Crossref, Elsevier's API (only with a key), Unpaywall, OpenAlex (`enrich/openalex.py`: an abstract rebuilt from its
inverted index, the PMC id, the open copy's licence) — then the publisher: the journal's own feeds (`config.abstract_feed`
on its registry row, read at most every two hours, `enrich/feeds.py`) and its landing page (`enrich/landing.py`: the DOI's
handle record names it, it is asked as `text/html` — doi.org answers the fetcher's JSON-first `Accept` with Crossref's
record — through the source's exit, then the relay, then the browser; a challenge or a 403 is the answer, remembered per
host for a day, never got round). An open article's whole text comes from Europe PMC's `fullTextXML` (a PMC id) or from a
Creative-Commons page, as `body_text` with `## ` section titles and `text_kind` `full` (`enrich/jats.py`,
`enrich/article_html.py`); else its PDF stays `enrichment.oa_pdf_url`. A journal entry without text is asked again every
12 hours for 14 days; a feed's teaser or a page's standfirst answers at once and is replaced (the entry delivered again)
when an index gives the abstract.

`python tools/text_probe.py <doi-file>` runs the chain on DOIs (`doi` or `doi|source_id` a line) and prints which step
answered each, writing nothing; `python tools/measure_abstract_feeds.py` measures the configured feeds (text share, median
length, matchability). `python -m knowledge_plugin retext --kinds journal [--apply]` reads the journal entries the
platform asked for that have no text at all through the chain again.

## Social posts (contract 1.5.0)

X accounts (SocialData), WeChat official accounts (Dajiala) and six Chinese platforms (the GEO module's crawler) are
sources like any other — rows in `registry/social-sources.json`, entries in the same stream with a `seq`, a revision and
an identity key, polls in the fetch log, health by the same rule — but the scheduler's per-source loop never claims them:
`knowledge_plugin/social/` reads them, because their cost and pacing are not a source's.

- **X**: accounts packed two dozen to a search (`(from:a OR …) -filter:replies since_id:…`, ≤ 470 characters), each
  account's watermark moved only to its own newest post; editorial accounts every 30 minutes, the rest hourly; quoted
  posts and X Articles kept; photos and video posters re-encoded into the media store (`pbs.twimg.com` through the Tokyo
  relay when configured).
- **WeChat**: every account is re-resolved from an article verified to be its own before its first read (a saved id is
  not trusted) and kept only when Dajiala names it as expected; then read by its original id at most twice a day,
  highest priority first; each new post's text bought once. A text that could not be bought with its post (a failure
  that passes, such as Dajiala's code 20002 while the balance runs low, or the cap) is bought when the platform asks
  `/text` for it — never read as a page: mp.weixin.qq.com refuses robots — at most six calls per entry with a doubling
  wait, and five failures in a row pause every body purchase for an hour. `python -m knowledge_plugin wechat-bodies
  [--days 7]` lists the WeChat entries answered `unavailable` without their text (writes nothing, calls nobody);
  `--apply` buys them within the day's cap and delivers each recovered entry again as its next revision.
- **Six platforms**: a standing watch list (`watch_list` in the same file, each term with its reason) searched one
  platform and one term at a time, 120 requests a day spread over the day, ten minutes' wait whenever GEO's crawler is
  busy. A post keeps an excerpt and the platform's counts, never its author.
- **Money**: every paid call is a row of `provider_calls`; a provider's daily cap stops that provider until the next
  Shanghai day and nothing else; `/v1/health`'s `providers` names calls, spend, cap, balance and the last error.

The lists are built from dated research files: `tools/verify_x_accounts.py --key-file <path>` checks each X candidate
once (exists, public, posted in the last 90 days; status lines only, never the key) and `tools/build_social_registry.py`
writes `registry/social-sources.json` (`--check` verifies the committed file).

## Add or change a source

The registry is data, not code. `registry/sources.json` is generated from the probe registry
(`registry/probe-sources.json`) plus the hand-kept `registry/overrides.json`:

1. Edit `registry/overrides.json` (keyed by source id; fields win over derived values, `config`
   merges key by key; `_why` keys are comments) — e.g. selectors for a list page, a cadence, an
   `authority`, `enabled: false`. A source that is not in the probe registry (the EviMed API scans)
   is a whole row in `registry/extra-sources.json`. Explicit `owner_excluded` rows stay disabled even when an older operator enable exists; CDE and all Fierce rows are excluded. Which rows are on is a rule in the build
   (P0 on every exit this build has; P1 list pages with selectors; the EviMed scans; relay sources
   the Tokyo node read on 2026-09-22, `registry/research/`), and an adapter that rejects a row's
   configuration keeps it off with the reason.
2. `python tools/build_registry.py` rewrites `registry/sources.json` (deterministic; `--check`
   verifies the committed file). URLs are templates: `{since:%Y-%m-%d}`, `{today:%Y%m%d}`,
   `{issn}`, `{cursor}` — a literal date in a URL fails the build.
3. `python -m knowledge_plugin check-registry` and `pytest tests/test_registry_load.py`.
   A running plugin picks the new file up within a minute (rows missing from the file are
   retired, never deleted; an operator's `operator_enabled` survives reloads).

HTML lists may declare up to three `config.selector_fallbacks`, each a vetted CSS mapping with
`item`, `title`, `link` and `date`. On a permitted page with no primary entries, the adapter tries
these bounded candidates and accepts only dated normalized entries with allowed links. The
primary selector is never overwritten; successful recovery is recorded as
`html_list_recovered_selector=N`. This is deterministic recovery from captured page structures,
not a model proposer, a login/challenge bypass or permission to enable an excluded source. The
2026-09-29 source expansion and deferred reasons are recorded in
`registry/research/source-expansion-2026-09-29.json`; raw protected responses and their hashes live
in `tests/fixtures/source-expansion-20260929/probe-captures.json`.

The complete omitted-source sweep is recorded in `registry/research/source-expansion-2026-09-30.json`:
each previously unprobed P1 source has a protected response or refusal and an explicit disposition.
Conference pages and inline changelogs may be monitored as one canonical document with meaningful
body text; meeting dates remain context, never fabricated publication timestamps. CSS, scripts,
templates and other nonvisible markup are excluded from extracted text.

FDA tables without detail URLs can set `link_to_source_page: true`, an actual `selectors.id`, and
an `identity_prefix` such as `fda:novel-approvals`. This mode is restricted to FDA regulator pages.
The real page URL remains the link, while a canonical-page/row digest uses the existing FDA event
identity contract, preserving separate records through platform deduplication. The FDA calendar's
public JSON reader uses its source-modification timestamp and keeps meeting times in the summary.
OpenAlex work queries specify both date bounds and article/review types. Publisher-linked
QuoteMedia ticker streams are media sources; distributors and truncated excerpts stay explicit.

## Tests

`pytest` (from this directory, with the dev requirements). Database tests use a scratch database
on `KNOWLEDGE_PLUGIN_TEST_DATABASE_URL` (default `postgresql://postgres@127.0.0.1:55433`) and are
skipped when no server answers. Adapters are tested against recorded real responses in
`tests/fixtures/` (`tests/adapters/`, `tests/enrich/`).
