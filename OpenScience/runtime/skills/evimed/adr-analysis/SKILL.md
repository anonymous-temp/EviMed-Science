---
name: adr-analysis
description: Use for pharmacovigilance, adverse-event signal analysis, or a structured drug-safety evidence report.
metadata:
  evimed-agent: adr-analysis
---

# Drug safety analysis

Use this skill when the research question concerns suspected adverse reactions,
pharmacovigilance databases, disproportionality signals, label comparison, or a
drug-safety evidence synthesis. Do not use it to make an individual treatment
decision or to claim that a statistical signal proves causality.

Clarify the drug, target population, adverse event, geography, database, and
analysis period only when they materially change the result. Otherwise state
reasonable assumptions and proceed.

Unless the user requests another language, conduct the interaction and write
all deliverables in Simplified Chinese. Preserve official product names,
database fields, statistical symbols, identifiers, and source titles where
translation would reduce traceability.

Normalize drug and event terms before querying. Prefer traceable evidence with
stable source identifiers and retrieval dates. Separate spontaneous-reporting
signals from clinical evidence, describe important limitations, and never infer
incidence from a reporting database. Use the declared EviMed tools only; do not
substitute unverified figures from memory.

For an open-domain request that asks for a drug-safety analysis or structured
pharmacovigilance report, call `evimed_drug_safety_analysis` with
`action=capabilities`, then start the managed job with the drug and optional
reaction terms. Record its job id and poll with `waitSeconds=60` until terminal.
The language model may explain the returned findings, but must not replace the
specialist's case retrieval, statistics, evidence search, or report artifacts.
Before interpreting a completed run, inspect `data_source`, `suspect_binding`,
`suspect_roles`, `study_date_from`, `study_date_to`, `snapshot_id`,
`gps_prior_fitted`, and `gps_prior_id`. Preserve these provenance fields in the
answer whenever they affect reproducibility or the strength of a conclusion.
An `openfda_live` result with
`suspect_binding=report_contains_suspect_approximation` is a report-level
approximation: never describe it as PS-only or as same-drug-object binding. A
`frozen_faers` result is only reproducible within its declared snapshot,
aliases, roles, date range, and deduplication rules. If `gps_prior_fitted` is
false, describe EBGM/EB05 as exploratory output from an unfitted starting
prior; never call it a paper-grade or full-matrix empirical-Bayes fit.

When the declared safety, label, or literature adapters leave a material gap,
use `evimed_data_source_catalog` to select a relevant active source and then
`evimed_biomedical_source_search`. Do not query unrelated databases merely to
increase source count.

The public literature search returns bibliographic metadata unless it explicitly
includes abstract or full-text fields. Do not assign study design or evidence
level, summarize findings, or claim an outcome from titles alone.

Write the research narrative to `safety-report.md` and the structured signal
table to `signals.csv`. Cite every material
evidence claim and label unavailable or conflicting evidence explicitly.

Keep case counts, ROR, PRR, IC, EBGM, confidence intervals, suppression rules,
and analysis periods exactly aligned with the adapter output. A zero or missing
cell, unavailable database, duplicate report, indication bias, stimulated
reporting, or concomitant medicine can materially change interpretation. Do not
convert any disproportionality metric into incidence, relative risk, or causal
probability, and do not combine metrics from incompatible databases as though
they shared one denominator.
