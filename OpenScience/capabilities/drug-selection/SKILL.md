---
name: drug-selection
description: Compare candidate medicines for a formulary decision using traceable EviMed evidence, explicit institutional criteria, reproducible scoring, and human committee review.
---

# Drug Selection Evaluation

Use this workflow for formulary admission, substitution, or candidate comparison. It is an evidence and scoring assistant; external approval workflows are out of scope and it does not make a procurement, reimbursement, or patient-level treatment decision.

Unless the user requests another language, interact and write deliverables in Simplified Chinese. Preserve official medicine names, identifiers, currencies, units, scoring fields, and source titles when translation would reduce traceability.

## 1. Bind the decision scope

Require candidate medicines and one indication. First call `mcp__evimed__drug_selection_evaluation` with `action: requirements`. Ask once for the returned missing fields in one concise group. If the user does not provide them, continue the evidence comparison but leave affected items blank and withhold quantitative ranking. Capture population, jurisdiction, care setting, comparator, budget perspective, product specification, and decision date when material. Normalize every candidate with `mcp__evimed__drug_term_normalize`.

Record the institution's criteria, domain definitions, weights, thresholds, and policy version. Never invent a rubric or silently use equal weights. If no approved quantitative rubric is supplied, perform a qualitative evidence comparison and withhold ranking.

## 2. Retrieve and freeze evidence

For every candidate, call `mcp__evimed__drug_selection_evaluation` with `action: retrieve`. Use `mcp__evimed__drug_label_search`, `mcp__evimed__guideline_search`, `mcp__evimed__clinical_trial_search`, and `mcp__evimed__literature_search` only to fill a declared gap or cross-check a material claim. Use `mcp__evimed__data_source_catalog` and `mcp__evimed__biomedical_source_search` for an identified active-source gap; a catalog-only or blocked source is not evidence.

Use `mcp__evimed__pharmacy_reference_search` only for configured private formulary
context such as name mapping, high-alert classification, route/frequency
normalization, interaction screening, or monitoring hypotheses. Do not convert
an institution-specific row into a universal criterion or score. Verify it
against current official sources and the approved local policy before it enters
an assessment or committee-facing output.

Deduplicate records and preserve the exact query, jurisdiction, source identifier, URL, retrieval time, version/date, and retrieved fields. Bibliographic metadata does not establish study design, outcomes, effect size, certainty, or comparative value. Read the abstract or full text needed for each material conclusion. A failed or empty search is an evidence gap, not a zero score and not evidence against a candidate.

Freeze the retrieval and provenance package in `evidence-snapshot.json` before assessment; the compiler input SHA-256 binds the structured assessment to the supplied inventory. Uploaded files must be marked as user-provided evidence.

## 3. Build domain assessments

Use only these structured domains: `pharmaceutical_properties`, `effectiveness`, `safety`, `economics`, `appropriateness`, `accessibility`, `innovation`, and `other`. For each candidate and domain, record status, rationale, and `evidenceIds` that resolve to `evidence-snapshot.json`.

Keep observed source facts, validated adapter calculations, user-supplied data, and agent interpretation separate. Numeric scores may only be carried from a validated adapter or an explicit institutional rubric. Preserve scale minimum/maximum, direction, weight, denominator, normalization rule, missing-data rule, and policy version. Never turn missing, conflicting, or unassessed data into zero.

Economics is comparable only when currency, price date, dosage basis, treatment duration, jurisdiction, and perspective are all explicit. Do not invent prices, budget impact, cost-effectiveness, thresholds, or product equivalence. When these prerequisites are incomplete, avoid a definitive ranking.

## 4. Compile deterministically

Call `mcp__evimed__drug_selection_evaluation` with `action: compile`, the exact `selectionDomains`, source inventory, and all domain assessments. Accept a ranking only when the compiler confirms that every candidate exactly covers the declared domains with comparable scoring rules and economic context. Preserve its leave-one-domain-out sensitivity result. If compilation returns an error, correct the structured evidence; do not bypass the gate or write a synthetic result.

Treat a conditional ranking as one committee input. Explain missing domains, contradictions, close scores, sensitivity, and whether the top candidate changes. The authorized pharmacy and therapeutics process remains the final decision maker.

## 5. Deliverables

Write:

- `drug-selection-report.md`: decision scope, policy/rubric, retrieval coverage, domain findings, contradictions, sensitivity, limitations, and committee-ready options.
- `selection-scorecard.csv`: one row per candidate-domain pair with status, source IDs, rationale, score fields, rule version, and missing-data state.
- `decision-summary.json`: the exact compiler result, ranking or withholding reasons, audit hash, and human-review flag.
- `evidence-snapshot.json`: deduplicated source inventory, queries, scope, retrieval timestamps, and observed evidence fields. Every source URL cited in the report must appear here; never cite a source that is not recorded in the frozen snapshot.

Resolve every material citation. Completion means the assisted scorecard is reproducible and its gaps are explicit, not that an external approval workflow has finished.

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
