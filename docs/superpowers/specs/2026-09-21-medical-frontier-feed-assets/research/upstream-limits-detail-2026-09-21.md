# API etiquette, hard limits and model prices

Verified 2026-09-21 against each provider's own pages. **UNVERIFIED** = the provider publishes nothing on it. `[probed]` = measured live today, not documented.

## Part A — source APIs

### A1. Rate limits and identification

| API | Anonymous | Polite / keyed | How to identify |
|---|---|---|---|
| **Crossref** | 5 req/s single-record, **1 req/s list queries**, 1 concurrent ([pools](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)) | polite 10/s single, 3/s list, 3 concurrent; Plus 150/s, no concurrency cap. Changed 2025-12-01 and again **2026-07-21** — the old 50 req/s is dead ([blog](https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/), [2026](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137)) | `mailto=` param **or** UA `Bib/1.1 (https://site/; mailto:you@org)`; Plus: `Crossref-Plus-API-Token: Bearer <key>`. Now keyed on **email as well as IP** |
| **NCBI E-utils** | 3 req/s per IP | **10 req/s** with `api_key`; more on request ([NBK25497](https://www.ncbi.nlm.nih.gov/books/NBK25497/)) | `tool=` + `email=` (developer's) + `&api_key=`. An `api-key:` **header** also works `[probed]` |
| **Europe PMC** | UNVERIFIED — no doc page states one. Provider [forum](https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices/c/MfxQ8nvIT5Q): 10 req/s, 500/min; [EBI terms](https://www.ebi.ac.uk/about/terms-of-use/) reserve the right to block | no key exists | descriptive UA |
| **openFDA** | **240 req/min, 1 000 req/day per IP** | 240 req/min, **120 000 req/day** per key ([auth](https://open.fda.gov/apis/authentication/)) | `api_key=` param or basic-auth username; free |
| **ClinicalTrials.gov v2** | UNVERIFIED — nothing in the [OpenAPI spec](https://clinicaltrials.gov/api/oas/v2) or terms; "50/min" is third-party only | no key | UA only |
| **Federal Register** | UNVERIFIED — [none documented](https://www.federalregister.gov/reader-aids/developer-resources/rest-api); "APIs do not require API keys" | — | UA only |
| **medRxiv/bioRxiv** | **None published** on any [help page](https://api.biorxiv.org/details/help) | — | none required |
| **WHO** | None; [robots.txt](https://www.who.int/robots.txt) has **no `User-agent: *` block and no `Crawl-delay`** | — | UA only |
| **EMA** | None on the [feeds](https://www.ema.europa.eu/en/news-events/rss-feeds) or [data](https://www.ema.europa.eu/en/medicines/download-medicine-data) pages; [robots.txt](https://www.ema.europa.eu/robots.txt) has no `Crawl-delay` | — | UA only |
| **GOV.UK** | Content API: **10 req/s per client, documented** ([content-api](https://content-api.publishing.service.gov.uk/)). Search API is **unsupported, may change without notice** ([reuse](https://www.gov.uk/help/reuse-govuk-content)) | — | UA; `Crawl-delay: 10` is AhrefsBot-only |
| **Unpaywall** | `email=` mandatory; 100 000/day **UNVERIFIED** (JS-only site). Now on the OpenAlex DB, API unchanged ([help](https://help.openalex.org/access/unpaywall/)) | no key | `email=` param |
| **OpenAlex** | **Breaking, 2026-02-13: a free key is now required**; keyless ≈ $0.10/day then HTTP 409 | Free key = **$1/day** budget (ID lookup free, list $0.0001, search $0.001); hard **100 req/s** → 429 ([auth](https://help.openalex.org/api/authentication/), [pricing](https://blog.openalex.org/openalex-api-new-features-and-usage-based-pricing/)) | `api_key`; `mailto` now secondary |
| **arXiv** | **1 request / 3 s, one connection at a time**, across all your machines ([TOU](https://info.arxiv.org/help/api/tou.html)) | — | no UA requirement; credit line requested |

### A2. Paging, page size, incremental filters

| API | Max page | Paging | Incremental filter (exact names) |
|---|---|---|---|
| Crossref | `rows` 1000 (default 20); `offset` capped at 10 000 | `cursor=*` → `next-cursor`; `select=` works, not with `offset`/`sample` | **`from-index-date`** (reindex stamp — harvest on this), `from-update-date`≡`from-deposit-date`, `from-created-date`, `from-pub-date`, `from-online-pub-date` ([filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/)) |
| NCBI | `retmax` **10 000**; `retstart+retmax ≤ 10 000` | `usehistory=y` → `WebEnv`+`query_key`; efetch **POST above ~200 UIDs**, batch ~500 | `datetype=edat` (**default**) `\|pdat\|mdat\|crdt\|mhda`; `reldate=n`; `mindate`/`maxdate` as `YYYY/MM/DD` |
| Europe PMC | `pageSize` **1000** (default 25) | `cursorMark=*` → `nextCursorMark` | fields `FIRST_IDATE`, `CREATION_DATE`, `UPDATE_DATE`, `FIRST_PDATE`; range `FIRST_IDATE:[2026-09-14 TO 2026-09-21]`; `sort=P_PDATE_D desc`; `resultType=core` adds abstract/MeSH/full-text URLs; `SRC:PPR` = preprints (1.24 M) |
| openFDA | `limit` **1000** (**100 for drug/shortages**); `skip` **25 000** | `search_after` from the `Link: rel="Next"` header (unlimited, excludes `skip`) ([paging](https://open.fda.gov/apis/paging/)) | drug/event `receivedate`; enforcement `report_date`, `recall_initiation_date`; drugsfda `submissions.submission_status_date`; label `effective_time`; shortages `update_date`, `change_date`. Every response carries `meta.last_updated` |
| ClinicalTrials.gov | `pageSize` **1000** (default 10; silently coerced) | `pageToken` ← `nextPageToken`; `countTotal=true`; `fields=`, `format=json\|csv` | `filter.advanced=AREA[LastUpdatePostDate]RANGE[2026-09-20,MAX]`; also `AREA[StudyFirstPostDate]`, `AREA[StudyFirstSubmitDate]`, `AREA[ResultsFirstPostDate]`; bogus AREA → 400. `sort=LastUpdatePostDate:desc` |
| Federal Register | `per_page` **1000** (default 20) | `page` + `next_page_url`; **caps at 10 000 / 10 pages; page 11 → 400** `[probed]` | `conditions[publication_date][gte\|lte\|is\|year]`, `conditions[effective_date][…]`, `conditions[agencies][]=food-and-drug-administration`, `conditions[type][]`, `fields[]`, `order=newest`. **No `last_modified` filter** |
| medRxiv | **30 per `/details` call**, not 100 `[probed]`; `/pubs/`, `/pub/`, `/publisher/`, `/funder/` give 100 | numeric `cursor` | interval = `YYYY-MM-DD/YYYY-MM-DD`, or `N`, or `Nd` |
| WHO | default 50 | `@odata.nextLink` (`$skip`) | OData `$top $skip $select $orderby $count` work on `/api/news/newsitems` and `/api/emergencies/diseaseoutbreaknews`; `PublicationDateAndTime desc`. **Undocumented-but-observed**; `/api/` root is 404 |
| EMA | RSS only | none | 20 feeds under `/en/news-events/rss-feeds` (news, whats-new, human-medicine-new, orphan, withdrawn-applications, eurd-list…). **No referrals/PRAC feed** — those are XLSX/JSON only |
| GOV.UK | `count` **max 1500** | `start` (0-based); unknown params → **422** | `/drug-safety-update.atom` and `/drug-device-alerts.atom`, 50 entries each; Search API `filter_*`, `order=-public_timestamp` |
| OpenAlex | `per_page` **100** (2026 help centre; the old 200 is superseded); basic paging caps at 10 000 | `cursor=*` → `meta.next_cursor`; `select=` | `from_publication_date` free; **`from_created_date` / `from_updated_date` now require Premium** |
| arXiv | `max_results` 2000/slice, 30 000 total | `start` 0-based | Atom only; no JSON API |

### A3. Conditional requests, lag, 429/ban

| API | ETag / If-Modified-Since | Indexing lag | 429 / ban |
|---|---|---|---|
| Crossref | UNVERIFIED | ~20 min after deposit, UNVERIFIED (support page 403s) | 429 = slow down; **403 = manual block**; the 10 s grace before auto-blocking was removed Dec 2025. `Retry-After` UNVERIFIED |
| NCBI | UNVERIFIED | UNVERIFIED | `{"error":"API rate limit exceeded"}` / 429; IP block lifted **only** by registering `tool`+`email` |
| Europe PMC | **Not supported** — no `ETag`/`Last-Modified`; `If-Modified-Since` ignored `[probed]` | preprints ~1 day; **MEDLINE `firstPublicationDate` runs a median +46 days into the future** `[probed]` | UNVERIFIED |
| openFDA | UNVERIFIED | drug/event quarterly, "may lag 3 months or more"; enforcement and label weekly; drugsfda daily Mon–Fri; shortages daily | UNVERIFIED — `/apis/errors/` is 403 |
| ClinicalTrials.gov | UNVERIFIED | daily (`/api/v2/version` → `dataTimestamp 2026-09-21T09:00:05`) | UNVERIFIED — spec documents only 400. v1 retired June 2024 |
| Federal Register | UNVERIFIED | public-inspection list updates **08:45 ET**; 6 a.m. publication UNVERIFIED | UNVERIFIED |
| medRxiv / WHO / EMA | UNVERIFIED | EMA JSON refreshes **06:00 and 18:00 Amsterdam**; tables overnight | none published |
| GOV.UK | UNVERIFIED on the Atom feeds | — | "too many requests ⇒ access limited", no number; an internal 2022 [note](https://docs.publishing.service.gov.uk/manual/rate-limiting.html) mentions 6 rpm/IP at the cache layer |
**RSS/Atom etiquette.** `If-None-Match`/`ETag` and `If-Modified-Since`/`Last-Modified` → **304**; `Retry-After` = delay-seconds or HTTP-date ([RFC 9110](https://httpwg.org/specs/rfc9110.html)). 429 is [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585) and **must not be cached**. The only interval any authority names is hourly — [RSS Best Practices Profile](https://www.rssboard.org/rss-profile) ("most aggregators check once an hour"; it has no conditional-GET section at all) and [Feedly](https://feedly.com/fetcher.html) ("no more than once every hour on average"). **`Crawl-delay` is not standard**: [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) defines only user-agent/allow/disallow, and robots.txt should be cached ≤24 h.

**Three traps.** (1) Europe PMC returned a bare `{"version":"6.9"}` — HTTP 200, no `hitCount` — on **20 % of identical requests**, unaffected by pacing; gate on `hitCount` and retry. (2) A misspelled NCBI `datetype` **silently returns Count 0**, which reads exactly like "no news". (3) Crossref retractions: `filter=update-type:retraction` **is valid**, plus the daily [Retraction Watch CSV](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/). Crossref `abstract` is a JATS string, publisher-dependent coverage.

## Part B — model prices

### B1. DeepSeek ([pricing](https://api-docs.deepseek.com/quick_start/pricing), CNY/1M tokens, peak)

| Model | Cache hit | Cache miss | Output | Context | Max out |
|---|---|---|---|---|---|
| `deepseek-flash` | ¥0.04 | ¥2 | ¥8 | 1M | 384K |
| `deepseek-v4-pro` | ¥0.30 | ¥9 | ¥27 | 1M | 384K |

USD peak: flash $0.006/$0.3/$1.2; pro $0.044/$1.32/$3.96. **Off-peak = exactly 50 %**; peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri **excluding Chinese public holidays**. `deepseek-chat`/`deepseek-reasoner` **discontinued 2026-07-24**; `deepseek-v4-flash` and `-vision-exp` retired 2026-09-10, still callable, served by V4.1-Flash at Flash price ([changelog](https://api-docs.deepseek.com/updates/)).

Features: `response_format` = `text` | **`json_object`** only (no json_schema). Thinking **is disableable per request** — `thinking:{type:"disabled"}` or `reasoning_effort:"none"`; `max_tokens` defaults 8K non-thinking / 64K thinking / 128K at `reasoning_effort:"max"`. Caching is **on by default**, disk prefix caching, hit requires a **full match of a cache prefix unit**, TTL hours-to-days, best-effort, reported as `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` ([kv_cache](https://api-docs.deepseek.com/guides/kv_cache)) — a long shared system prompt is the right design, but put the variable part last. Concurrency 2500 (flash) / 500 (pro) per account, 429 above ([rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit)). Tokenizer: **1 English char ≈ 0.3 token, 1 Chinese char ≈ 0.6 token** ([token_usage](https://api-docs.deepseek.com/quick_start/token_usage)).

**Repo agreement — `packages/domain/src/metering.mjs` is correct.** All four ids priced (`deepseek-flash`, `deepseek-v4-pro`, and the two legacy aliases at Flash rates, exactly how DeepSeek bills them); every CNY rate matches; `OFF_PEAK_MULTIPLIER = 0.5` and `PEAK_WINDOWS_UTC` `[1,4)`+`[6,10)` match; `embeddingPerMillion: 0.5` matches DashScope. **One divergence:** `isPeak()` excludes weekends but **not Chinese public holidays**, so on a weekday holiday the platform bills peak while DeepSeek charges off-peak. `deps-version.json` pins no DeepSeek id (only a note that the kernel default moved `deepseek-v4-flash` → `deepseek-flash`, matching upstream).

### B2. DashScope / Bailian (CNY/1M, Beijing)

| Model | Price | Notes |
|---|---|---|
| `qwen3.7-text-embedding` | **0.5** (Batch 0.25) | dims 2560/2048/1536/**1024 default**/768/512/256; 128 000 tok/text; **20 texts/request** ([card](https://help.aliyun.com/zh/model-studio/qwen3-7-text-embedding)) |
| `qwen3.7-text-embedding-flash` | 0.125 | dims 1024 default…256 |
| `text-embedding-v4` | **0.5** (Batch 0.25) | dims 2048…64, 1024 default; 8192 tok; **10 texts/request** ([sync API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)) |
| `qwen3-rerank` | **0.5** | 500 docs, 4000 tok/doc, 120 000 tok/req; path **`/compatible-api/v1/reranks`** |
| `qwen3.7-text-rerank` | 0.5 | 500 docs, 30 000 tok/doc, native path |
| `gte-rerank-v2` | 0.8 | `gte-rerank` v1 **deprecated 2026-05-30** |
| `qwen-mt-flash` / `-turbo` | 0.7 in / 1.95 out | 92 languages, 16 384 ctx |
| `qwen-mt-plus` | 1.8 in / 5.4 out | flash is the recommended successor |

**Batch = 50 % of real-time price**, 24–336 h window ([batch](https://help.aliyun.com/zh/model-studio/batch-interfaces-compatible-with-openai)) — covers all embedding models but **not rerank and not qwen-mt**. Free quota 1M tokens / 90 days, Beijing only.

**Repo agreement — `deps-version.json` ids are valid.** `qwen3.7-text-embedding` at dimension 1024 is the model's own default ✓; `qwen3-rerank` is real and sits on `/compatible-api/v1/reranks` exactly as pinned ✓ (`gte-rerank-v2` would cost 60 % more). **Caveat:** Alibaba now documents the host as workspace-scoped `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`, while the repo pins `https://dashscope.aliyuncs.com` — the repo's 2026-09-14 probe shows the legacy host still answers, but it is no longer the documented one.

## Part C — recommended scheduler settings per host

| Host | Concurrency | Min interval | Daily budget | Identification |
|---|---|---|---|---|
| Crossref | 2 | **350 ms** list / 110 ms single-DOI | 1 500 | `mailto=` + UA with URL & mailto |
| NCBI E-utils | 1 | **110 ms** with key (350 ms without) | 2 000; large jobs 21:00–05:00 ET or weekends | `tool` + `email` + `api_key` |
| Europe PMC | 2 | 350 ms | 2 000 | descriptive UA; retry on missing `hitCount` |
| openFDA | 2 | 300 ms | 2 000 (key mandatory — 1 000/day without) | `api_key=` |
| ClinicalTrials.gov | 1 | 1 000 ms | 500 | UA (no limit published — self-throttle) |
| Federal Register | 1 | 1 000 ms | 200 | UA |
| medRxiv/bioRxiv | 1 | 2 000 ms | 300 (30 rows/call) | UA |
| WHO | 1 | 2 000 ms | 100 | UA (API undocumented — stay quiet) |
| EMA | 1 | 2 000 ms | 100; poll after 06:00 & 18:00 Amsterdam | UA |
| GOV.UK | 2 | 500 ms (documented cap 10/s) | 300 | UA |
| Generic RSS host | 1 | **1 poll/hour/feed** | feeds × 24 | UA + conditional GET, honour `Retry-After` |
| Generic HTML list page | 1 | 5 000 ms | 200 | UA + robots.txt (cache ≤24 h) |

Set a global UA of the form `EviMedMonitor/1.0 (+https://<site>/bot; mailto:<ops-address>)`, send `Accept-Encoding: gzip` and conditional-GET headers everywhere, and treat `Retry-After` as authoritative over the table above.
