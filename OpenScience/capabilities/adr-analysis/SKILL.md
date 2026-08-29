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
pharmacovigilance report, call `mcp__evimed__drug_safety_analysis` with
`action=capabilities`, then start the managed job with the drug and optional
reaction terms. Record its job id and poll with `waitSeconds=45` until terminal.
When the user or protocol declares aliases, exact FAERS role codes,
administration routes, a target study window, or a wider background window,
pass them as `drugAliases`, `suspectRoles`, `administrationRoutes`,
`studyDateFrom`/`studyDateTo`, and
`backgroundDateFrom`/`backgroundDateTo`. Do not invent these scope controls;
the background window must contain the target window.
The language model may explain the returned findings, but must not replace the
specialist's case retrieval, statistics, evidence search, or report artifacts.
Before interpreting a completed run, inspect `data_source`, `suspect_binding`,
`suspect_roles`, `administration_routes`, `study_date_from`, `study_date_to`,
`background_date_from`, `background_date_to`, `snapshot_id`,
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
use `mcp__evimed__data_source_catalog` to select a relevant active source and then
`mcp__evimed__biomedical_source_search`. Do not query unrelated databases merely to
increase source count.

Use `mcp__evimed__pharmacy_reference_search` only when a configured private reference
can clarify a drug alias, route, dose-risk rule, interaction, monitoring item,
or special-population screening hypothesis. Its rows may be institution-specific
and are not current clinical authority. Verify every material rule against the
current official label, guideline, pharmacopoeia, and local governance policy;
an unavailable or empty private index is an evidence gap, not a negative finding.

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

## Before delivering: two fixed steps

Both run on the finished deliverable, in this order, every time. They are steps
of this capability, not options the run weighs — a pass that happens only when
the model remembers it is a pass that happens on the easy runs and not the hard
ones.

1. **`traceability-review`** — every citation resolves, no number appears in
   prose without a source in the artifacts, and every figure or table matches
   the code that produced it. Findings are repaired before the next step, not
   after: humanizing prose around a citation that does not resolve only makes
   the defect read better.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index and claim marker byte-identical. Load the
   language-matched upstream rules it names. It is the last thing that touches
   the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory. That file is the designated home for revision notes, replies to a
rejection, and process description; the report itself carries none of them, and
no check reads the notes as report prose.
