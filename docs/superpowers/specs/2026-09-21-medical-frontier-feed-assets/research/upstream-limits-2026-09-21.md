# Upstream limits and etiquette, checked 2026-09-21

What the scheduler's per-host token buckets (plan chapter 10.2.2) rest on. Each line names the provider page it was read
from that day; "probed" means measured against the live API, "UNVERIFIED" means no provider page states it.

## Crossref REST API
- From 2026-07-21: public pool 5 req/s single record and **1 req/s list/query**; polite pool 10 req/s single and **3 req/s list**;
  concurrency 1 (public) / 3 (polite); Metadata Plus 150 req/s. Limits are keyed on e-mail as well as IP.
  https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137 ·
  https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/
- 429 = slow down; **403 = manual block**. Response headers `x-rate-limit-limit`, `x-rate-limit-interval`, `x-concurrency-limit`, `x-rate-limit-type`.
- Polite pool: `mailto=` query parameter or a User-Agent with `(…; mailto:…)`. `rows` max 1000; `offset` capped at 10K; deep paging with `cursor=*`.
- Date filters: `from-created-date` (first deposit), `from-update-date` / `from-deposit-date` (redeposit), `from-index-date` (reindexed), `from-pub-date`.
  https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/
- `filter=update-type:retraction` is valid; Retraction Watch data is published every working day at https://gitlab.com/crossref/retraction-watch-data .
- Probed: `/journals/{issn}/works` refuses `select=subtype` and `select=language`; `rows=100` truncates silently (check `total-results`);
  154 journal queries at 1.25 s spacing: zero 429s. Conditional requests: UNVERIFIED (not documented).

## NCBI E-utilities
- 3 req/s without a key, 10 req/s with `api_key`; `tool` and `email` on every request; large jobs on weekends or 21:00–05:00 US Eastern.
  NBK25497 / NBK25499 (read from https://ftp.ncbi.nlm.nih.gov/pub/litarch/74/63/helpeutils_NBK25501.tar.gz , the book pages serve a CAPTCHA to servers).
- esearch `retmax` ≤ 10,000 and only the first 10,000 results are reachable; efetch above ~200 ids should be POSTed.
- Probed: `datetype` accepts `edat` (default), `pdat`, `mdat`, `crdt`, `mhda`; **an unknown value returns Count 0 with no error**.
  `<doi>[doi]` is not an exact match (14% of fetched records carried a DOI that was never asked for): re-join on the DOI.
  The `api-key:` HTTP header is accepted as well as the query parameter (undocumented).

## Europe PMC REST (API 6.9)
- No key. Provider forum figure: 10 req/s and 500 req/min (https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices/c/MfxQ8nvIT5Q); no doc page states a limit.
- Probed: `pageSize` max 1000; `cursorMark=*`; `resultType=core` carries abstract, pubTypeList, meshHeadingList; no ETag / Last-Modified;
  **about 20% of identical requests answer 200 with a bare `{"version":"6.9"}` and no `hitCount`** - treat as retryable, spacing does not help;
  newly indexed MED records carry a `firstPublicationDate` a median 46 days in the future - select on `FIRST_IDATE` / `CREATION_DATE`, never `FIRST_PDATE`;
  preprints (`SRC:PPR`) appear about one day after posting.

## openFDA
- No key: 240 req/min and **1,000 req/day per IP**; with a free key: 240 req/min and 120,000 req/day. https://open.fda.gov/apis/authentication/
- `limit` max 1000 (drug shortages: 100); `skip` max 25,000, then `search_after` from the `Link` header. https://open.fda.gov/apis/paging/
- Cadence: drug/event quarterly with a lag of three months or more; drug/enforcement weekly; drugsfda daily Mon–Fri; drug/label weekly; drug/shortages daily.
- Probed: shortages dates are `MM/DD/YYYY`, every other endpoint `YYYYMMDD`; no record has a URL field; `meta.last_updated` is reliable.

## ClinicalTrials.gov API v2 · Federal Register API v1
- ClinicalTrials.gov: no key, no published rate limit (the often-quoted 50/min is third-party); `pageSize` max 1000, `pageToken` cursor,
  `filter.advanced=AREA[LastUpdatePostDate]RANGE[<date>,MAX]`, also `StudyFirstPostDate`, `ResultsFirstPostDate`; a bogus AREA answers 400. https://clinicaltrials.gov/api/oas/v2
- Federal Register: no key, no published limit; `per_page` max 1000; any result set is capped at 10,000; `conditions[publication_date][gte]`,
  `conditions[agencies][]=food-and-drug-administration`. The HTML documentation redirects data-centre IPs to an unblock page; `/api/v1/*` is unaffected.

## medRxiv / bioRxiv, arXiv
- api.biorxiv.org `/details/<server>/<interval>/<cursor>/json` returns **30** per call (100 on `/pubs`); no published limit; a details call took 10.6 s in the dry run.
- arXiv: one request every three seconds, single connection (https://info.arxiv.org/help/api/tou.html); Atom only.

## WHO, EMA, GOV.UK
- WHO `www.who.int/api/news/newsitems` and `/api/emergencies/diseaseoutbreaknews`: undocumented OData v4, `$top/$skip/$select/$orderby/$count` honoured,
  news items carry a title and a date but no body; the old RSS path is 404.
- EMA: twenty RSS feeds at https://www.ema.europa.eu/en/news-events/rss-feeds (no referral/PRAC feed exists); JSON report files update at 06:00 and 18:00 Amsterdam time; no published limit.
- GOV.UK: Atom feeds carry 50 entries; content API documents 10 req/s per client; the search API is unsupported ("may change without notice").

## Feeds in general
- The only interval any authority names is hourly (RSS Best Practices Profile; Feedly's fetcher). `Crawl-delay` is not part of RFC 9309; robots.txt may be cached 24 h.
- `Retry-After` is seconds or an HTTP date (RFC 9110); 429 is RFC 6585.

## Models and embeddings (official price pages, CNY per million tokens)
- DeepSeek `deepseek-flash`: cache hit 0.04, cache miss 2, output 8. `deepseek-v4-pro`: 0.30 / 9 / 27. Off-peak is exactly half price;
  peak is 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays. The repository's `REFERENCE_PRICE_LIST`
  (`evimed-reference-2026-09-10`) agrees item by item; its peak-window check does not exclude public holidays.
- DashScope `qwen3.7-text-embedding`: 0.5 (batch 0.25), 1024 dimensions by default, 20 texts per request. `qwen3-rerank`: 0.5, up to 500 documents,
  path `/compatible-api/v1/reranks`, no batch discount. `qwen-mt-flash`: 0.7 in / 1.95 out (not used: title translation rides the summarisation call).
