---
name: clinical-evidence-synthesis
description: Produce a publication-grade, deeply researched clinical evidence analysis with reproducible searches, verified citations, claim-level traceability, and a separate safety-first practical answer.
---

# Clinical Evidence Synthesis

Use this skill for open-domain clinical questions that require an academic evidence analysis. It does not replace emergency care or individualized diagnosis.

## Required skill stack

Load these skills before retrieving evidence:

1. `deep-research`
2. `biomedical-database-search`
3. `citation-integrity`
4. `clinical-evidence-synthesis`

Do not claim completion if any required skill fails to load.

## Academic scope

1. Start from the current question. Do not reuse a prior report as a factual draft.
2. Convert the question into a direct academic title of at most 40 Chinese characters.
3. Do not put `综述`, `系统评价`, `meta分析`, `review`, or another article-type label in the title unless the user explicitly requests that design.
4. Write a publication-grade evidence analysis, not an expanded chat answer. Target 10,000–18,000 Chinese characters before the references.
5. Keep the safety-first practical answer separate and concise. Clinical urgency takes precedence over product discussion.

## Deep-research protocol

### Question decomposition

Define at least four evidence domains before searching:

- symptom phenotype and differential diagnosis;
- time-sensitive cardiovascular risk and triage;
- diagnostic pathway, including ECG and serial high-sensitivity troponin;
- non-cardiac mimics and limits of symptom-based discrimination;
- treatment-specific efficacy, safety, indication, and regulatory scope when a medicine is named.

### Reproducible search

Run at least eight distinct searches across at least two source classes. Use English and Chinese synonyms when relevant.

For an acute pressure-like chest symptom question, include targeted variants covering:

- acute chest pain AND acute coronary syndrome AND guideline;
- chest pressure AND high-sensitivity troponin AND diagnostic pathway;
- chest pain AND electrocardiogram AND emergency evaluation;
- gastroesophageal reflux AND non-cardiac chest pain AND differential diagnosis;
- symptom characteristics AND acute coronary syndrome AND diagnostic accuracy;
- sex or age differences in acute coronary syndrome presentation;
- current Chinese or international chest-pain guidance;
- the named medicine, indication, randomized trial, systematic evidence, safety, and regulatory revision.

Use `evimed_literature_search`, `evimed_guideline_search`, and selected audited sources from `evimed_data_source_catalog` or `evimed_biomedical_source_search`. Deduplicate candidate records with `evimed_evidence_deduplicate`.

When calling `evimed_evidence_deduplicate`, omit absent identifier keys instead of sending empty `doi`, `pmid`, `pmcid`, or URL strings. If input validation fails, correct the full batch and obtain a successful deduplication result before continuing.

Identify at least 30 records, retain at least 12 relevant sources after deduplication, and inspect at least 10 sources beyond title-only metadata. Prefer:

1. current guidelines and consensus statements;
2. systematic evidence and high-quality diagnostic studies;
3. primary randomized or prospective studies;
4. official regulatory documents;
5. authoritative public triage guidance for the patient-facing action boundary.

Do not inflate counts with duplicates, irrelevant records, editorials, or title-only results.

### Full-text and source preservation

Use `evimed_official_page_fetch` for approved professional-society, guideline, evidence-review, public-health, or regulatory pages. Use `evimed_open_access_full_text` for key PMID, PMCID, or DOI records with accessible full text.

Prefer a PMCID or a search record explicitly marked open access before calling the full-text tool. A closed-access result or unreachable official page belongs in `failedSources`; replace it with another relevant accessible source rather than repeatedly retrying a guessed URL. For the acute chest-pressure topic, the stable official pages below may be used when relevant:

- `https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2022/10/10/23/15/2022-acc-expert-consensus-on-chest-pain`
- `https://www.nhs.uk/symptoms/chest-pain/`

At least eight source artifacts must be successfully preserved and inspected. A successful source artifact must contain source identity, retrieval time, content hash, and usable text.

Never create, edit, replace, or copy a file under `.evimed-sources/`. Only artifacts returned by successful retrieval tools are evidence artifacts.

A title, bibliographic record, search snippet, or failed retrieval is not evidence for a clinical outcome, recommendation, effect estimate, study design, certainty rating, or causal statement.

## Evidence appraisal

For every included source, record:

- source type and study design;
- population, setting, intervention/comparator, and outcomes where applicable;
- access level: `full_text`, `official_page`, `abstract`, or `structured_record`;
- risk of bias or evidence-form limitations;
- directness to the question;
- precision and sample-size limitations;
- recency and jurisdictional applicability;
- whether the source directly supports, qualifies, or conflicts with another source.

Separate findings for emergency triage from findings for chronic stable disease. Evidence that a medicine may help diagnosed stable angina does not establish a role in self-diagnosing undifferentiated acute chest pressure.

## Citation and traceability contract

### Reader-visible citations

Use standard numbered citations in order of first appearance:

`急性胸痛需要结构化风险评估。[1](https://example.org/source) <!-- claim:CLM-001 -->`

- Readers must see `[1]`, `[2]`, and so on, not internal claim IDs.
- Put each internal marker in an HTML comment: `<!-- claim:CLM-NNN -->`.
- Put the numbered citation and hidden claim marker on the same physical line as the supported proposition.
- Every factual numeral and every practical action needs a directly applicable citation and claim marker.
- Never use a broad citation to cover a sample size, effect estimate, timing threshold, indication, contraindication, or recommendation absent from its source passage.

### Evidence matrix

Write `clinical-evidence-matrix.json` with a top-level `claims` array containing at least 18 atomic material claims. Every claim must contain:

- `claimId`
- `claim`
- `referenceNumber`
- `sourceUrl`
- `sourceTitle`
- `artifactPath`
- `identifier`
- `accessLevel`
- `supportQuote`
- `applicability`
- `uncertainty`

`referenceNumber` must resolve to the numbered reference list. `supportQuote` must be a contiguous verbatim passage present in the preserved source artifact. Every numeral in a claim must also appear in the quote, source title, or identifier.

### Bibliography and audit

Write:

- `references.bib` with at least 12 deduplicated entries;
- `citation-ledger.csv` with one row per matrix claim;
- `citation-audit.md` documenting unresolved identifiers, duplicates, corrections or retractions, metadata-only records, and claim-source mismatches.

Prefer DOI, then PMID/PMCID, then a stable official-document identifier. Verify author, title, venue, year, volume, issue, pages, DOI, PMID, and version against an authoritative record. Do not manufacture missing metadata.

The report reference list must use a consistent Vancouver-style format:

`1. Authors. Title. Journal. Year;volume(issue):pages. doi:... PMID:... URL:...`

For organizations or official documents, use the issuing organization as the author and include publication/update date and stable URL when available.

## Required report structure

Use these sections, adding a medicine-specific results subsection only when relevant:

1. `摘要`
2. `临床问题与分析框架`
3. `证据检索与评价方法`
4. `证据结果`
5. `病因鉴别与诊断推理`
6. `急诊评估与风险分层`
7. `药物证据与适用边界` when a medicine is named
8. `讨论`
9. `证据局限`
10. `结论`
11. `安全优先的实际处置`
12. `参考文献`

The methods section must report databases/source classes, complete query concepts, search date, eligibility criteria, deduplication, screening counts, access levels, and appraisal dimensions. Describe this as a scholarly method, not as a runtime log.

The results section must synthesize evidence by clinical question, not list sources one by one. Compare agreement, conflict, directness, and certainty. Tables are encouraged for evidence characteristics and decision boundaries.

The discussion must explain what the evidence does and does not establish, distinguish acute undifferentiated symptoms from diagnosed chronic disease, and separate direct evidence from reasoned synthesis.

The limitations section must address at least four of: risk of bias, indirectness, imprecision, evidence form, publication bias, recency, population transferability, jurisdiction, and health-system applicability. Do not write tool failures or access excuses into the academic report.

## Acute chest-pressure safety boundary

For new pressure-like chest discomfort:

- do not diagnose heart disease versus gastrointestinal disease from symptoms alone;
- do not use response to Suxiao Jiuxin Wan, nitroglycerin, an antacid, or any other medicine as a diagnostic test;
- support emergency contact, ECG, and serial high-sensitivity troponin actions with dedicated direct evidence;
- localize the practical emergency number to China as `120`, while keeping the source proposition faithful;
- do not add aspirin, dosing, contraindications, driving advice, body-position advice, or wait-and-see advice unless directly supported and appropriate to the question.

When Suxiao Jiuxin Wan is named, explicitly state:

`不得因服用速效救心丸而延误呼救或急诊评估。`

Support that conclusion by combining the emergency-triage evidence with medicine evidence limited to its studied or regulated population. Do not convert chronic stable-angina efficacy evidence into an acute self-triage recommendation.

## Search log schema

Write strict JSON to `clinical-evidence-search.json`:

```json
{
  "schemaVersion": 1,
  "searchedAt": "ISO-8601 timestamp",
  "databases": ["PubMed", "guideline source"],
  "queries": [
    {
      "database": "PubMed",
      "query": "complete query",
      "dateFrom": null,
      "dateTo": null,
      "resultsRetrieved": 20
    }
  ],
  "screening": {
    "recordsIdentified": 40,
    "recordsAfterDeduplication": 24,
    "sourcesIncluded": 14
  },
  "sourceRecords": [
    {
      "referenceNumber": 1,
      "citationKey": "AuthorYearKeyword",
      "identifier": "PMID or DOI",
      "accessLevel": "full_text",
      "included": true,
      "role": "diagnostic pathway"
    }
  ]
}
```

Counts must reflect actual tool results and screening decisions.

## Run receipt

Write strict JSON to `clinical-evidence-run.json` containing:

- `reportProfile`: exactly `academic_deep_research_v1`;
- `question`, `title`, `startedAt`, and `completedAt`;
- `tools`;
- `successfulSourceArtifacts`: path strings only;
- `failedSources`;
- `qualityChecks`: at least `claimTraceability`, `sourceQuoteMatch`, `contradictionAudit`, `arithmeticAudit`, `citationAudit`, and `searchReproducibility`, all boolean;
- `status`: exactly `succeeded` only when all required files and checks pass.

Inside JSON strings, use Chinese quotation marks for quoted Chinese prose rather than unescaped ASCII double quotes.

## Required outputs

- `clinical-evidence-report.md`
- `clinical-evidence-matrix.json`
- `clinical-evidence-search.json`
- `citation-ledger.csv`
- `references.bib`
- `citation-audit.md`
- `clinical-evidence-run.json`

Read every output back before claiming success. Verify:

- at least eight distinct searches across at least two source classes;
- at least 30 identified records, 12 included sources, 10 inspected beyond metadata, and eight preserved source artifacts;
- at least 18 atomic claims;
- every numbered citation resolves to a complete reference;
- every claim quote occurs in its source artifact;
- all DOI/PMID/PMCID values and bibliographic metadata are accurate;
- no visible `[claim:...]` marker remains;
- no operational failure or tool-process prose appears in the academic report;
- the practical answer is medically correct, source-supported, and does not encourage delay.

If this contract cannot be met, write an honest failed run receipt and do not present the report as publication-grade.
