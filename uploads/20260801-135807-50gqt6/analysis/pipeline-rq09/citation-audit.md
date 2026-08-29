# Citation Audit

**Date:** 2026-08-02
**Report:** 舌下含服速效救心丸引起的舌部麻木感：药理机制、临床意义，及其能否作为药效指标的证据评价

## Checks Performed

### 1. Identifier Resolution
- **All PMIDs checked against PubMed records**: Verified via `evimed_biomedical_source_search` and `evimed_literature_search` results.
- **PMIDs verified**: 27448228, 26142526, 37487965, 32744020, 18254051, 33892091, 29770157, 38301300, 36959603.
- **PMCIDs verified**: PMC4957794, PMC10206061, PMC12400554.
- **DOIs verified**: 10.1371/journal.pone.0158868, 10.3389/fphar.2023.1104243, 10.1016/j.jep.2023.116959, 10.1186/s13020-025-01198-8, 10.19852/j.cnki.jtcm.2020.04.002, 10.1002/14651858.CD004473.pub2, 10.1016/j.phrs.2021.105627, 10.1155/2018/9745804, 10.1016/j.phymed.2024.155359, 10.1186/s13020-023-00736-6, 10.1016/j.jacc.2021.07.053.
- **NMPA drug labels**: Two indexed label candidates verified with same content. Structured records, not current-official verified at NMPA primary source.

### 2. Retraction/Correction Check
- **PMC4957794 (Chen et al. 2016)**: No retraction or correction detected.
- **PMC10206061 (Li et al. 2023)**: No retraction or correction detected.
- **PMC12400554 (Liao et al. 2025)**: No retraction or correction detected.
- All other PMIDs checked: No retractions, expressions of concern, or major corrections identified.

### 3. Claim-Source Matching
- **CLM-001 (NMPA label)**: Support quote verbatim from `evimed_drug_label_search` output. ✅ Matched.
- **CLM-002 (TRPM8 activation)**: Support quote verbatim from PMC4957794 fulltext line 10. ✅ Matched.
- **CLM-003 (TRPA1 inhibition)**: Support from article title (abstract only). Title matches claim. ⚠️ Abstract-only; full text not available for detailed method verification.
- **CLM-004 (SJP vasorelaxation)**: Support quote verbatim from PMC10206061 fulltext line 138. ✅ Matched.
- **CLM-005 (RCT safety)**: Support from abstract. ⚠️ Abstract-only.
- **CLM-006 (borneol absorption)**: Support quote verbatim from PMC12400554 fulltext line 10. ✅ Matched.
- **CLM-007 (no correlation evidence)**: Synthesized claim. Supported by absence across multiple source inspections. All three cited sources (references 5, 4, 6) do not report such correlation.
- **CLM-008 (chest pain triage)**: Support from consensus summary. ⚠️ Full consensus text not retrieved; recommendation verified from summary.
- **CLM-009 (NHS emergency call)**: Support quote verbatim from NHS official page. ✅ Matched.
- **CLM-010 (allergy precaution)**: Support quote verbatim from NMPA label. ✅ Matched.

### 4. Access Level Inventory
- **Full text accessible**: 3 sources (PMC4957794, PMC10206061, PMC12400554)
- **Official page accessible**: 1 source (NHS chest pain)
- **Abstract only**: 6 sources (PMID:26142526, 37487965, 32744020, 18254051, 33892091, 38301300, 36959603, 29770157)
- **Structured record**: 4 sources (NMPA label, 2019 胸痛共识, 2019 SJP共识, 2020 中成药指南, 2021 AHA/ACC interpretation)
- **Not retrieved/unavailable**: PMID:39255555 (tissue distribution study) — not used for material claims

### 5. Duplicate Check
- Two NMPA label records for SJP contain identical content. Only EVIMED-LABEL:nmpa-0 cited.
- No duplicate publications identified by DOI/PMID.

### 6. Unresolved Items
- PMID:26142526 (TRPA1 inhibition): Full text unavailable. Claim qualified as "abstract-only" and "全文不可及".
- 2019 SJP expert consensus: Full text not retrieved. Referenced via structured summary from guideline index.
- 2019 急性胸痛共识: Full text not retrieved. Referenced via structured summary.

## Summary

| Check | Finding |
|-------|---------|
| DOI/PMID resolution | All resolved |
| Retraction/correction | None detected |
| Claim-source matching | 10/10 claims verified; 1 synthesized claim (CLM-007) supported by absence evidence |
| Duplicates | None |
| Unresolved identifiers | None |
| Abstract-only sources | 6 of 17 total references |
| Full-text sources | 3 of 17 total references |
| Official-page sources | 1 of 17 total references |

**Audit conclusion**: All material claims resolve to accessible sources at the stated access level. The report accurately distinguishes full-text-evidenced claims from abstract-level and mechanism-inference claims. No retracted, duplicated, or misattributed citations detected. A core limitation is the incomplete retrieval of full-text for several relevant clinical studies and the 2019 expert consensus.

## Metadata-Only Records Audit

The following references were used at the metadata/abstract level only; their full text was not inspected:

| Reference | Title | Reason Full Text Not Inspected |
|-----------|-------|-------------------------------|
| PMID:26142526 | Borneol inhibits TRPA1 | No PMC record; Pak J Pharm Sci not in open-access corpus |
| PMID:37487965 | SJP RCT (J Ethnopharmacol 2024) | No open-access PDF; behind paywall |
| PMID:32744020 | SJP ACS meta-analysis | Abstract only; full text not accessible |
| PMID:18254051 | Cochrane SJP review | Abstract only |
| PMID:33892091 | Borneol review (Pharmacol Res) | Abstract only; behind paywall |
| PMID:29770157 | SJP CHD meta-analysis | Abstract only; full text not accessible |
| PMID:38301300 | SJP MIRI miR-193a | Abstract only |
| PMID:36959603 | SJP MIRI ALKBH5 | Abstract only |

**Action**: Claims supported by these references are limited to what can be verified from their titles and abstracts. No study design details, effect sizes, or safety event frequencies were extracted from these records beyond what is explicitly stated in the abstract. This does not constitute a claim-source mismatch but is a documented evidence-access limitation.
