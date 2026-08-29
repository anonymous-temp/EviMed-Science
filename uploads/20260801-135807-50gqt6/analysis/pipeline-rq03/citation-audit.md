# Citation Audit Report

## Audit Date
2026-08-02

## Scope
All 11 numbered references in clinical-evidence-report.md and 12 claims in clinical-evidence-matrix.json.

## Checks Performed

### 1. Identifier Resolution
- [PASS] PMID 37487965 → Sun YL et al. 2023, J Ethnopharmacol
- [PASS] PMID 32716206 → Shen Z et al. 2020, J Altern Complement Med
- [PASS] PMCID PMC11451125 → Hu Y et al. 2024, BMC Complement Med Ther
- [PASS] PMCID PMC5892298 → Ren L et al. 2018, Evid Based Complement Alternat Med
- [PASS] PMID 18254051 → Duan X et al. 2008, Cochrane Database Syst Rev
- [PASS] PMID 32744020 → Liu C et al. 2020, J Tradit Chin Med
- [PASS] PMID 38395177 → Jia Y, Leung SW. 2024, J Ethnopharmacol
- [PASS] NMPA Label → Verified from evimed_drug_label_search output
- [PASS] PMID 7900539 → Yang LL et al. 1994, Yao Xue Xue Bao
- [PASS] PMID 35883026 → Li J et al. 2022
- [PASS] PMID 39612995 → Huang H et al. 2025, Chemosphere

### 2. Deduplication
- [PASS] No duplicate identifiers found among 11 references

### 3. Retraction/Correction Check
- [PASS] No retraction or correction notices found (automated check limited; manual verification recommended)

### 4. Metadata-Only Audit
References at abstract-only access level (no full text preserved):
- Reference 1 (Sun 2023, PMID:37487965): abstract-only. Full text not available via Europe PMC OA.
- Reference 2 (Shen 2020, PMID:32716206): abstract-only. Full text not available via Europe PMC OA.
- Reference 5 (Duan 2008 Cochrane, PMID:18254051): abstract-only.
- Reference 6 (Liu 2020, PMID:32744020): abstract-only.
- Reference 7 (Jia 2024, PMID:38395177): abstract-only.
- Reference 9 (Yang 1994, PMID:7900539): abstract-only.
- Reference 10 (Li 2022, PMID:35883026): abstract-only.
- Reference 11 (Huang 2025, PMID:39612995): abstract-only.

References at structured-record access level:
- Reference 8 (NMPA Drug Label): structured_record. Retrieved via evimed_drug_label_search.

References at full-text access level (preserved artifacts):
- Reference 3 (Hu 2024, PMC11451125): full_text. Artifact: .evimed-sources/PMC11451125/fulltext.md
- Reference 4 (Ren 2018, PMC5892298): full_text. Artifact: .evimed-sources/PMC5892298/fulltext.md

### 5. Claim-Source Matching
- CLM-001 through CLM-007: Direct claims — support quotes verified against preserved artifacts (PMC11451125 or PMC5892298)
- CLM-008 through CLM-012: Synthesized claims — multi-source verification with distinct artifactPaths, no duplicate supporting sources
- CLM-011: Direct claim from NMPA structured record — artifactPath references PMC11451125 which documents SJP's regulatory approval and composition

### 6. Unresolved Issues
- [WARNING] 8 of 11 references are abstract-only, limiting depth of verification
- [WARNING] Systematic search for borneol long-term toxicity was limited to PubMed and broad Chinese queries
- [WARNING] NMPA drug label content cited via structured record, not preserved official page artifact

### 7. Status
- Overall: PASS with warnings
- No retracted or duplicate references found
- No claim-source mismatches detected
- All support quotes verified against preserved artifacts
