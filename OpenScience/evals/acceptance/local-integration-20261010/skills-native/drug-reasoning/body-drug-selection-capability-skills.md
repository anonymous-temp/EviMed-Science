---
name: drug-selection
description: Compare candidate medicines for a formulary decision using traceable evidence, qualitative comparison, and reproducible conditional scoring with an explicit rubric.
---

# Drug Selection Evaluation

Use this workflow for formulary admission, substitution, or candidate comparison. It is an evidence and scoring assistant; external approval workflows are out of scope and it does not make a procurement, reimbursement, or patient-level treatment decision.

Unless the user requests another language, interact and write deliverables in Simplified Chinese. Preserve official medicine names, identifiers, currencies, units, and source titles when translation would reduce traceability.

## 1. Bind the decision scope

Require candidate medicines and one indication. First call `mcp__evimed__drug_selection_evaluation` with `action: requirements`. Ask only for missing information that prevents identifying the comparison. Continue with a qualitative evidence comparison when a scoring rubric or other optional context is absent; leave affected fields explicit and withhold unsupported quantitative ranking. Capture population, jurisdiction, care setting, comparator, budget perspective, product specification, and decision date when material. Normalize every candidate with `mcp__evimed__drug_term_normalize`.

Record the institution's criteria, domain definitions, weights, thresholds, and policy version. Never invent a rubric or silently use equal weights. If no explicit quantitative rubric is supplied, perform a qualitative evidence comparison and withhold ranking. An attributable published rubric may be replayed as a named scenario, with its version and limitations; do not imply that the institution adopted it. Delivery of the evidence comparison does not require a committee approval step.

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

Trace the field's landmark trials before you assess: call `mcp__evimed__reference_list`
on the newest guideline and the newest systematic review you retrieved, and screen
the trials and reviews their reference lists name (`mcp__evimed__literature_search`
`pmids` for the abstracts). A trial known by an acronym is missed by keyword queries
and is named in every guideline's references; a guideline Europe PMC does not index
is read with `mcp__evimed__open_access_full_text` or `mcp__evimed__web_read` instead.

## 3. Build domain assessments

Use only these structured domains: `pharmaceutical_properties`, `effectiveness`, `safety`, `economics`, `appropriateness`, `accessibility`, `innovation`, and `other`. For each candidate and domain, record status, rationale, and `evidenceIds` that resolve to `evidence-snapshot.json`.

Keep observed source facts, validated adapter calculations, user-supplied data, and agent interpretation separate. Numeric scores may only be carried from a validated adapter or an explicit rubric. Identify whether its origin is institutional policy, user-supplied rules, or a sourced published scenario. Preserve scale minimum/maximum, direction, weight, denominator, normalization rule, missing-data rule, and policy version. Never turn missing, conflicting, or unassessed data into zero.

Economics is comparable only when currency, price date, dosage basis, treatment duration, jurisdiction, and perspective are all explicit. Do not invent prices, budget impact, cost-effectiveness, thresholds, or product equivalence. When these prerequisites are incomplete, avoid a definitive ranking.

## 4. Compile deterministically

Call `mcp__evimed__drug_selection_evaluation` with `action: compile`, the exact `selectionDomains`, source inventory, and all domain assessments. Accept a ranking only when the compiler confirms that every candidate exactly covers the declared domains with comparable scoring rules and economic context. Preserve its leave-one-domain-out sensitivity result. If compilation returns an error, correct the structured evidence; do not bypass the gate or write a synthetic result.

Treat a conditional ranking as one committee input. Explain missing domains, contradictions, close scores, sensitivity, and whether the top candidate changes. The authorized pharmacy and therapeutics process remains the final decision maker.

## 5. Deliverables

Write:

- `drug-selection-report.md`: decision scope, policy/rubric, retrieval coverage, domain findings, contradictions, sensitivity, limitations, and committee-ready options.
- `selection-scorecard.csv`: one row per candidate-domain pair with status, source IDs, rationale, score fields, rule version, and missing-data state.
- `decision-summary.json`: the exact compiler result, ranking or withholding reasons, audit hash, and human-review flag.
- `evidence-snapshot.json`: the scope, and one entry per source you rely on: its `sourceId` as the retrieval tool returned it, `evidenceAccess`, and the observed evidence fields. Each submission writes `retrieved` into this file: the platform's record of every source this run's retrieval tools returned, with its identifier, title, address, tool, query and time. That key is the platform's; never type or script it. Every link in the report must be a source this run retrieved. A portal, home or search page is not a source: cite a label by its approval number and label id, and name a work you did not read as not read, without a link.

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

**What the reader gets.** The deliverable is read by a clinician, pharmacist or
reviewer, not by this platform.

- The package's bookkeeping — which acceptance or checklist item is answered
  where, where a number came from, why an item does not apply — goes to
  `revision-notes.md`, never into a section of the deliverable. A statement
  nobody gave you (conflicts of interest, funding, authorship) is not written.
- Say what a field, status or file means, never its name: 「未排序（未提供评分
  细则）」, not `ranking: withheld`. No JSON keys, enum values, job or run ids,
  file paths, or sentences about this deployment, its tools or its routing.
- A count, sum, share or formula result the run makes itself — sources, rows,
  categories, placeholders — is computed by a script over the file that holds
  the items and copied from its output, with its definition beside it; count
  again after the items change. Where a tool does not state how it computed a
  value, say so; never reconstruct the formula.
- Reference entries — title, authors, journal, year, DOI, PMID — are copied
  from the record the retrieval tool returned, never typed from memory.
- Write in the language of the user's request: a brief written in English gets
  an English deliverable.
