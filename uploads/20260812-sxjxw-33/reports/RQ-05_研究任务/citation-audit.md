# Citation Audit — 用力排便作为急性冠脉事件触发因素 + 卫生间常备速效救心丸证据评价

Run date: 2026-08-11. This audit documents identifier resolution, duplicates, corrections/retractions, metadata-only records, and claim-source mismatches for the current run.

## 1. Identifier resolution (unresolved / mis-resolved)

- `PMID:34641779` — submitted as the putative PMID of the 2021 AHA/ACC chest pain guideline; Europe PMC resolved it to an unrelated article ("Early recognition of cardiac surgery-associated acute kidney injury", PMC8513334). The artifact was discarded; the guideline's Circulation DOI (10.1161/CIR.0000000000001029) and JACC DOI (10.1016/j.jacc.2021.07.053) were then attempted directly and both returned "not open access" from the gateway. **Resolution: the 2021 AHA/ACC chest pain guideline is documented at index level (Circulation 2021;144:e368–e454, with 2023 erratum confirmed via PMID:38079489) but was not preservable; no claim in this report is carried by its text.** Listed in failedSources.
- `PMID:18254051` (Cochrane CD004473, Suxiao Jiuxin Wan review) — identified; full text blocked (cochranelibrary HTTP 403). Metadata-only; not used for claims.
- `PMID:40153815` (constipation–MI meta-analysis, J Gastrointestin Liver Dis) — jgld.ro unreachable; metadata-only; not used for claims.
- `PMID:34911344` (Stroke 2022 ICH trigger case-crossover) — abstract retrieved via two connectors (RR 37.6 for straining for defecation) but full text not open access (ahajournals HTTP 403); **used as context only, not as a claim source**. Its OA counterpart (Chongqing case-crossover, PMID:41030662) carries the trigger claims instead.
- `PMID:41003451` (JACC Asia constipation–CVD cohort) and `PMID:42412703` (JACC Asia editorial) — abstracts retrieved; full text not preservable; metadata/abstract only, not claim sources.
- `DOI 10.1111/jch.13489` (Ishiyama 2019, constipation-induced pressor effects) — not open access; cited within preserved sources (PMC7473662, PMC10920016) as their reference, not cited independently here.
- `PMC9115663` (GRACE chest pain guideline) — Europe PMC full-text retrieval failed (upstream unavailable, retryable); not used.
- 2023 ESC ACS guideline (`DOI 10.1093/eurheartj/ehad191`) — gateway response too large / OUP 403; ESC content carried via the preserved open-access interpretation (PMC11317809).
- 《急性胸痛急诊诊疗专家共识》(中华急诊医学杂志 2019;28(4)) — identified at guideline-index level only; full text not retrievable through the gateway; no recommendation text from it is quoted.

## 2. Duplicates

- `evimed_evidence_deduplicate` ran on 180 screened candidate records; no duplicates within the batch (all PMIDs unique).
- Cross-search duplicates removed manually during screening: PMID:34911344 (appeared in ≥3 queries), PMID:27716918, PMID:12870773, PMID:38464992, PMID:41003451, PMID:29770157, PMID:18254051, PMID:38206306, PMID:40152902 — each counted once.
- The same document preserved in Markdown + XML counts as one source; each preserved document has exactly one canonical `fulltext.md` path in `successfulSourceArtifacts`.

## 3. Corrections / retractions

- 2021 AHA/ACC chest pain guideline: an erratum (Circulation, 2023-12-12, PMID:38079489) corrected one sentence on FFR-CT diagnostic sensitivity. Noted; the guideline text is not used for claims in this report.
- No other included source has a detected correction, expression of concern, or retraction as of retrieval date.

## 4. Metadata-only records (identified, not claim-bearing)

- PubMed/PMC/Europe PMC records screened but only reaching title/abstract level and therefore excluded from claim support: the Cochrane Suxiao review (18254051), Stroke ICH case-crossover (34911344), JACC Asia cohort (41003451) and editorial (42412703), JG-LD MI meta-analysis (40153815), Commode Cardia forensic case series (27716918, Wiley 403), Pepine & Wiener 1979 Circulation Valsalva ischemia study (436222), Sikirov 2003 posture study (12870773), bed-reclining-angle study (26505154), and the 2021 AHA/ACC and 2023 ESC guideline originals. These are listed in the search log's screened records or `failedSources`; none carries a numbered claim.
- Note: "abstract-only" is not "metadata-only" — abstract text retrieved from connectors was used only to guide screening and appears in the report only where a preserved artifact (full text or official page) backs the claim.

## 5. Claim–source mismatch checks

- All 25 matrix claims verified: every direct claim's `supportQuote` is a verbatim contiguous passage (with explicit `…` elision only) present in its preserved artifact; every synthesized claim's two supporting sources are distinct documents with their own verbatim quotes; both derived claims carry full `method`/`assumptions`/`sensitivity` working and are marked 〔推导〕 in the report.
- Numerals in each claim were checked to appear in the quote, title, or identifier.
- Emergency-call claim (CLM-019): the contiguous quote contains both the action ("Call 999 straight away") and the symptom conditions ("sudden pain or discomfort in your chest that does not go away…spreads to your left or right arm…feel sweaty, sick, light headed or short of breath").
- No visible `[claim:…]` markers remain in the report; all markers are hidden HTML comments.

## 6. Reference list integrity

- 12 numbered references; each resolves to a complete Vancouver-style entry with DOI/PMID (or stable official URL for NHS).
- `references.bib` contains one entry per numbered reference (12).
- Citation-ledger has header (claimId, referenceNumber, supportQuote, sourceTitle, identifier, claimType) and 23 rows (one per cited non-derived claim).
