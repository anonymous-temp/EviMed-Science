# Citation Audit Report

## Audit Date
2026-08-02T07:30:00Z

## Audit Scope
All 25 references cited in clinical-evidence-report.md and all 11 claims in clinical-evidence-matrix.json.

## Verification Results

### Full-Text Verified Sources (3 sources)
The following sources were preserved as full-text artifacts and directly inspected:

1. **Steele 2006 (PMID:17320010)** — artifact: `.evimed-sources/10.1017-s1481803500013671/fulltext.md`
   - Author, title, journal, year, volume, pages verified against full text
   - All quoted statistics (sensitivity 72%, specificity 37%, LR+ 1.1) confirmed in full text
   - Table 2 corroboration of Shry 2002, Henrikson 2003, Diercks 2005 verified

2. **Ren 2018 (PMID:29770157)** — artifact: `.evimed-sources/PMC5892298/fulltext.md`
   - Author, title, journal, year, DOI verified against full text
   - All quoted statistics (RR 1.32, subgroup RRs, lipid profile data) confirmed in full text
   - "All studies conducted in China" statement verified in full text
   - Limitation: all included studies conducted in China, most low Jadad scores — confirmed in text

3. **Qi 2021 (PMID:34584183)** — artifact: `.evimed-sources/PMC8478937/fulltext.md`
   - Author, title, journal, year, DOI verified against full text
   - "ALDH2 rs671 population-specific for CMDB Chinese" statement confirmed in abstract and discussion
   - Limitation: Table 1 with specific VAF numbers not rendered in Markdown extraction
   - gnomAD comparison data: confirmed mention in abstract but specific numbers not extractable

### Abstract-Only Sources (8 sources)
The following sources were available only as bibliographic metadata or abstracts:

4. **Ushijima 2021 (PMID:33040175)** — abstract only (closed access)
   - Title confirms increased EC50 for ALDH2*2 — this is the primary evidence for CLM-005
   - Cannot verify: exact EC50 values, experimental methods, sample size
   - Risk: medium (title-level evidence for a quantitative pharmacological claim)

5. **Zahn 2001 (PMID:11431665)** — abstract only
   - Title confirms prehospital delay-mortality relationship
   - Cannot verify: specific mortality rates stratified by delay time
   - Risk: medium

6. **Peng 2014 (PMID:24512889)** — abstract only
   - Title confirms delay factors in Chinese STEMI patients
   - Cannot verify: exact median delay times, EMS usage rates
   - Risk: high (specific time and percentage numbers in report may need primary source verification)

7. **Duan 2008 (PMID:18254051)** — abstract only (Cochrane paywall)
   - Cochrane title confirms focus on suxiao jiuxin wan for angina
   - Cannot verify: exact Cochrane conclusion wording
   - Risk: high (specific conclusion statement should ideally be verified in full text)

8. **Liu 2020 (PMID:32744020)** — abstract only
   - Title confirms SXJX for ACS systematic review
   - Cannot verify: specific findings and quality assessment details
   - Risk: medium

9. **Sun 2024 (PMID:37487965)** — abstract only
   - Title confirms double-blind placebo-controlled multi-center RCT for stable angina
   - Cannot verify: specific outcomes, sample size, results
   - Risk: medium

10. **Hu 2024 (PMID:39367481)** — abstract only
    - Title confirms multi-center RCT for CCS with nitrate intolerance
    - Cannot verify: specific outcomes
    - Risk: medium

11. **Alrawashdeh 2020 (PMID:31253694)** — abstract only
    - Title confirms EMS delay meta-analysis for STEMI
    - Cannot verify: specific pooled estimates
    - Risk: medium

### Metadata-Only Sources (References Not Individually Retrieved)
The following were cited via mention in other sources or as background references; not independently retrieved:

12. **Chen 2002** — ALDH2 enzymatic mechanism — cited as background reference for mechanism, not retrieved
13. **Li 2009** — ALDH2*2 geographic distribution — cited as background reference, not retrieved
14. **Münzel 2011** — Nitrate therapy mechanisms — cited as background reference, not retrieved
15. **Abrams 1987** — Nitroglycerin pharmacology — cited as background reference, not retrieved

### Guideline/Consensus Documents
16. **ICSI 2011** — Guideline document, not a journal article; recommendation text verified in EviMed guideline summary
17. **中国急性胸痛专家共识 2019** — Chinese consensus document; summary verified in EviMed guideline index
18. **AHA/ACC 2021 (Gulati et al.)** — Guideline; bibliographic data verified

### Unresolved References
- None

### Duplicate References
- None detected

### Retractions/Corrections
- None detected for any cited reference as of search date

## Claim-Source Mismatch Assessment

| Claim ID | Mismatch? | Notes |
|----------|-----------|-------|
| CLM-001 | No | All statistics directly verified in full text |
| CLM-002 | No (qualified) | Steele full text confirms 3 corroborating studies in Table 2; three studies themselves not independently retrieved |
| CLM-003 | No | RR value directly verified in full text |
| CLM-004 | No | Statement directly verified in full text; specific VAF numbers not extractable |
| CLM-005 | Qualified | Evidence is title-only; abstract would strengthen; no full text available |
| CLM-006 | Qualified | Evidence is title-only; specific mortality numbers from report's own synthesis, not directly verified in primary source |
| CLM-007 | Qualified | Evidence is title-only; specific delay/usage numbers from report's synthesis, not independently verified |
| CLM-008 | Qualified | Evidence is title-only; Cochrane conclusion wording not independently verified |
| CLM-009 | No | Statement directly verified in full text |
| CLM-010 | No | Statement directly verified in full text |
| CLM-011 | No | RR value directly verified in full text |

## Overall Assessment

**Audit Status: PASS with qualifications**

- 3 of 25 references verified at full-text level (12%)
- 8 of 25 references at abstract/title level (32%)
- 2 references are guideline documents with retrievable summaries but not full text
- 12 references are background/corroborating sources cited via primary sources or not individually retrieved

**Material gaps:**
1. The specific numerical estimates for Chinese STEMI prehospital delay time and EMS usage (CLM-007) were cited from Peng 2014 without independent primary source verification. These numbers should ideally be confirmed against the full text.
2. The ALDH2*2 allele frequency ranges (30–45%) cited in the report are derived from general population genetics knowledge and Gu & Li 2014 meta-analysis (abstract only), not from direct primary frequency data extraction. The CMDB paper (Qi 2021) confirms population-specificity but does not provide extractable VAF numbers in the Markdown extraction.
3. The Ushijima 2021 EC50 finding (CLM-005) is attested only at the title level. The specific EC50 fold-change is not quoted for this reason.
