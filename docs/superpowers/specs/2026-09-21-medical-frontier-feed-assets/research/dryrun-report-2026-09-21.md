# P0 ingestion dry run — 2026-09-21 (front half only)

Window 2026-09-14 → 2026-09-21 (7 days), overseas network. Full numbers in
`$A/research/dryrun-p0-2026-09-21.json`; raw bodies cached under `/tmp/medhot2/raw/`.

## Headline

- **268 P0 rows.** 260 attempted, **257 ok, 0 hard failures**, 11 skipped: 8 `html-list`
  (out of scope) + 3 `json-api` (below).
- **10,140 items returned; 3,352 of them dated inside the 7-day window = 478.9 items/day.**
  By family: journals 1,687 (241.0/day), rss 760 of 7,029 returned (108.6/day), atom 23 of 150
  (3.3/day), json-api 882 of 1,274 (126.0/day).
- **Token bill: 179,148 input tokens/day** for title + best text (0.3/char en, 0.6/char CJK).
  Titles only: **14,644/day** — a 12× lever. Evidence lane is 72% (128,319/day), AI 19,944,
  every other lane under 8,500. Per item: median 80.1, p90 615.3, mean 215.4, max 23,889.

## Journals (154 crossref-issn rows, all 200 OK, **zero 429s** at 1.25 s spacing)

1,687 works, 1,687 distinct DOIs. **`type` distribution is meaningless: the registry endpoints
carry `filter=…,type:journal-article`, so 1687/1687 are journal-article by construction.**
Crossref also **refuses `subtype` and `language`** on the `/journals/{issn}/works` route
(`select-not-available`) — that route offers 61 selects and those two are not among them.

- Crossref abstract present: **738/1,687 = 43.8%** (median 1,787 chars).
- Found in PubMed: **1,132/1,687 = 67.1%**. Of those, **778 = 68.7%** have a PubMed abstract.
- Crossref→PubMed lag: median 0 d, p90 0 d, max 5 d. **50 records are negative** (PubMed entry
  *before* Crossref `created`); 984 are same-day.
- Not yet in PubMed by age of the Crossref record: **0–1 d: 112/145 = 77.2%**;
  2–3 d: 148/369 = 40.1%; 4–7 d: 295/1,173 = 25.2%. PubMed is not an enrichment you can wait for.
- Publication-type classes (denominator = 1,132 found): **only non-research 198 = 17.5%**,
  **has a research type 152 = 13.4%**, **rest 782 = 69.1%** — the "rest" is overwhelmingly a bare
  `Journal Article` with no second type. Top types: Journal Article 931, Review 79, Letter 72,
  News 66, Editorial 40, Comment 31, Published Erratum 31, Systematic Review 22, RCT 13.
- `update-to` present: **52/1,687 = 3.1%** (correction 31, new_version 10, erratum 9,
  expression_of_concern 1, retraction 1).
- Non-article title prefixes: **57/1,687 = 3.4%** (Author Correction 17, Correction 8,
  Editorial Board 7, Reply 7, Erratum 4, Publisher Correction 4, Table of Contents 4, …).
  `is_update` and the title prefix overlap only partly — you need both.
- 86 works (5.1%) have **zero authors**; max authors 1,884. 482 (28.6%) have no `published` date.

## Surprises that would break a naive ingester

1. **RSS is mostly an archive. 79.4% of the 7,179 feed items are older than 30 days.**
   `cdc-mmwr` returns 2,325 items back to 2019-03-21, `cdc-newsroom` 1,842 back to 2006,
   `openai-news` 1,210 back to 2015. A poller that treats "in the feed" as "new" re-ingests
   ~5,700 stale items on its first tick and pays for them.
2. **Feeds with no dates at all:** `chinjmap`, `zgyxzz-pharm` (0 dated items of 15 and 12).
   **Feeds whose newest item is over 30 days old:** `chinagp` (newest 2021-12-21 — dead but
   200 OK with 65 items) and `statistical-thinking-harrell` (2026-08-18). 9 feeds returned
   0 items in the 7-day window; for `mhra-drug-safety-update` (monthly) that is correct.
3. **Truncated summaries are the norm, not the exception:** 16.8% of rss items (1,146/6,836)
   and **50.7% of atom items** (GOV.UK one-line summaries). Full `content:encoded` exists for
   only 4.7% of rss items. One item is 79,565 chars — cap before you tokenise.
4. **PubMed `<doi>[doi]` is not an exact match.** 1,687 DOIs in 43 batches returned 1,409 PMIDs
   and 1,324 records, **185 (14.0%) carrying a DOI never asked for.** Re-join on the DOI.
5. **Weekend cliff:** Crossref registrations by weekday — Mon 366, Thu 339, Fri 305, Wed 303,
   Tue 287, **Sat 64, Sun 23**. A daily volume alarm will fire every weekend.
6. **`rows=100` silently truncates:** `j-2041-1723` (Nature Communications) had 224 works in the
   window, `j-1663-9812` 121. Both returned 100. 14 journals returned 0.
7. **Dates are not one format.** openFDA ships `MM/DD/YYYY` on `/drug/shortages` and `YYYYMMDD`
   everywhere else; the first parser silently produced null dates for 5/5 shortage records.
8. **APIs that give you no text or no link:** `who-news-api` returns 0 body chars on all 20 items
   (title + date only), and its `ItemDefaultUrl` is a stub, not a full path. openFDA has no URL
   field on any record (51 items, 4.0% of json-api, have no link).
9. **Sort field ≠ record date.** `ctgov-results-first-posted` sorts on ResultsFirstPostDate, but
   the record's `studyFirstPostDateStruct` is years old — reading the first date you find dates
   the item wrong (0 of its 50 items land in the window).
10. **One transient 502** from NCBI efetch (`pubmed-retractions`); succeeded on retry. Europe PMC
    took 2.2–2.9 s, medRxiv details 10.6 s — the registry notes 35 s timeouts on Europe PMC.

## Skipped json-api rows (3 of 36)

- `unpaywall-oa-status` — **endpoint embeds an e-mail address**; not called.
- `star-guideline-rating-cn` — GET answers `{"code":-20001,…}`; the API is POST-only.
- `stanford-medhelm` — a benchmark release summary, not an item stream.

No Chinese source refused this machine; `prepare-guideline-registry` answered 200 with 20 rows
(carrying PII fields we dropped).

## Duplicates

Of 10,140 items, 2,920 (28.8%) carry a DOI; 2,821 distinct. **94 DOIs (3.3%) appear in more than
one source**, affecting 191 items (1.9%) — journal row vs PubMed query stream is the usual pair
(`j-1465-1858` ↔ `pubmed-sr-ma-core-journals`). **261 of 9,655 normalised titles (2.7%)** cross
sources, but the biggest groups are junk collisions: "Editorial Board" in 7 journals, "Table of
Contents" in 6. **99 identical links (1.0% of 9,988)**, almost all `ema-whats-new` against EMA's
per-topic feeds. 7 exact duplicate items inside a single source.
