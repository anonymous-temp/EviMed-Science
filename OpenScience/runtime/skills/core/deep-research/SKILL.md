---
name: deep-research
description: Conduct multi-query, multi-source scientific research with reproducible search records, source inspection, evidence synthesis, and explicit uncertainty.
---

# Deep Research

Use this skill when a question requires more than a short factual answer or a single-source lookup.

## Workflow

1. Decompose the question into four to six answerable subquestions.
2. Define the evidence hierarchy and inclusion criteria before searching.
3. Run at least two query variants for each major subquestion when the topic permits.
4. Search more than one source class. For biomedical work, combine literature indexes, guideline sources, and authoritative regulatory or public-health documents.
5. Preserve every query, filter, date, result count, identifier, access level, and screening decision.
6. Deduplicate by DOI, PMID, stable URL, then normalized title.
7. Inspect the most important records beyond title-only metadata. Prefer full text; label abstract-only evidence accurately.
8. Build a source inventory and claim-to-source ledger before drafting.
9. Synthesize agreement, conflict, directness, bias, precision, recency, and applicability. Do not write a source-by-source annotated list as the final analysis.
10. Stop or narrow the conclusion when the evidence cannot support the requested scope.

## EviMed tools

Select only relevant tools from the agent's declared contract:

- `evimed_data_source_catalog`
- `evimed_biomedical_source_search`
- `evimed_literature_search`
- `evimed_guideline_search`
- `evimed_official_page_fetch`
- `evimed_open_access_full_text`
- `evimed_evidence_deduplicate`

Search results are discovery records. They do not establish study design, recommendations, effects, or causality unless the returned record exposes the exact supporting content.

## Quality rules

- Use 15–30 relevant sources for broad scientific questions when the evidence base permits.
- Inspect at least three to five pivotal sources in full and more for clinical questions with heterogeneous evidence.
- Every material factual claim must resolve to a source actually inspected at the required access level.
- Cross-check high-consequence conclusions against more than one independent source.
- Label model synthesis and clinical inference separately from directly reported findings.
- Prefer current authoritative evidence, but retain older landmark evidence when historically or methodologically necessary.
- Report negative or conflicting findings rather than selecting only supportive studies.
- Do not count duplicates, inaccessible records, empty searches, or failed tools as evidence.
- Source quantity never excuses low relevance or incorrect citation metadata.

## Deliverable standard

The final report must include:

- a concise research question and scope;
- reproducible search and selection methods;
- evidence characteristics and appraisal;
- thematic synthesis;
- conflicts and uncertainty;
- limitations and applicability;
- a complete, consistently formatted reference list;
- supporting search, citation, and provenance artifacts required by the calling specialist.
