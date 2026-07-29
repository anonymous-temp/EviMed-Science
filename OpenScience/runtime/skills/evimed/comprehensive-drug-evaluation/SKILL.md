---
name: comprehensive-drug-evaluation
description: Produce a traceable, domain-by-domain medicine evaluation using EviMed evidence without automatically converting study design, certainty, or scores into a recommendation.
---

# Comprehensive Drug Evaluation

Use this workflow for a medicine and defined indication. It supports evidence review and institutional decision preparation; it is not a prescription, HTA ruling, reimbursement decision, or procurement authorization.

Unless the user requests another language, interact and write deliverables in Simplified Chinese. Preserve official medicine names, identifiers, source titles, currencies, units, and structured fields when translation would reduce traceability.

## 1. Bind the question

Require medicine and indication. First call `evimed_comprehensive_drug_evaluation` with `action: requirements`. Ask once for the returned missing fields in one concise group. If the user does not provide them, continue retrieval but keep the affected dimensions unscored. Capture population, comparator, jurisdiction, care setting, outcomes, time horizon, decision date, and uploaded evidence when material. If the user requests a quantitative score, set `quantitativeScoringRequested: true` and collect the exact evaluation domains, item definitions, scales, weights, directions, missing-data rules, and versioned scoring policy. Normalize the medicine with `evimed_drug_term_normalize`. State unresolved scope gaps rather than silently broadening the question.

## 2. Retrieve and freeze evidence

Call `evimed_comprehensive_drug_evaluation` with `action: retrieve`. Use label, guideline, trial, literature, and active biomedical-source tools only to fill a declared gap or verify a material claim. Deduplicate records with `evimed_evidence_deduplicate`.

The optional `evimed_pharmacy_reference_search` tool may supply private
terminology, dose-risk, interaction, route, monitoring, or special-population
context. Treat every returned row as a hypothesis or institution-specific
decision-support reference, never as current label, guideline, pharmacopoeia,
HTA, efficacy, or safety evidence. Verify any material rule against a current
authoritative source and keep private rows labeled `user_provided_other`.

Preserve the exact query, source identifier, URL, jurisdiction, version/date, retrieval time, and observed fields. Bibliographic metadata alone cannot establish study design, outcomes, effect size, certainty, or comparative benefit. Read the abstract or full text required for every material conclusion. A source outage or empty retrieval is missing evidence, not evidence of no effect. Mark uploaded files as user-provided evidence.

For every `sourceInventory` item passed to the compiler, declare `evidenceAccess`
as `full_text`, `abstract`, `regulatory_record`, `registry_record`,
`bibliographic_only`, `user_provided_full_text`, or `user_provided_other`.
Never cite a `bibliographic_only` item in an observed domain assessment; it may
remain in the snapshot only as a retrieval lead. A label effective, revision,
or retrieval date is not the product's original authorization date. Describe
an unavailable jurisdiction as unavailable and do not invent an HTTP status.

Freeze the retrieval and provenance package in `evidence-snapshot.json` before assessment; the compiler input SHA-256 binds the structured assessment to the supplied inventory.

## 3. Assess domains without shortcuts

Assess `effectiveness`, `safety`, and `applicability` as mandatory core domains. Add `economics`, `hta`, `evidence_certainty`, `innovation`, `accessibility`, `equity`, or `other` only when supported and relevant. Each row must contain status, rationale, and `evidenceIds` that resolve to the snapshot.

Evaluate the body of evidence, not the highest single study. Study design is only a starting point: do not call metadata a randomized trial, do not infer certainty from design alone, and do not map certainty directly to recommendation strength. Use `certainty: not_rated` unless a validated adapter or a user-supplied formal assessment provides a named framework, traceable full-text evidence, and explicit risk-of-bias, inconsistency, indirectness, imprecision, and publication-bias judgments. For a formal rating, send those as `certaintyOrigin`, `certaintyFramework`, `fullTextEvidenceIds`, `certaintyBasis`, and `certaintyJudgments`; a narrative impression or abstract-only review is not a formal certainty assessment.

Keep effectiveness, harms, applicability, certainty, economics/HTA, equity, values, and implementation separate. Resolve contradictions rather than averaging them away. Never invent an HTA conclusion, price, budget impact, cost-effectiveness result, composite score, threshold, or weight. Preserve currency, price date, jurisdiction, perspective, time horizon, discounting, and provenance when economics exist. A publication score is reproducible only for its reported product, regimen, price date, population, setting, rubric version, and evidence cutoff; use it as an external reference case, not a universal score.

Preserve subgroup denominators exactly. When a source reports a combined group
(for example, two adjacent age strata), never assign the combined percentage to
only one component subgroup. Reconcile the prose against the source table or
explicit stratum counts before writing the claim.

## 4. Compile deterministically

Call `evimed_comprehensive_drug_evaluation` with `action: compile`, `sourceInventory`, and all domain assessments. Preserve its core-domain coverage and audit hash. If quantitative scoring was requested, also supply the exact `evaluationDomains`, `scoringRubric`, `scoringPolicyVersion`, and item-derived score fields for every domain. The compiler computes a weighted normalized score only when the declared domains are complete, all rules use the supplied version, every value is finite and in range, and any economic context is complete. Otherwise it withholds the score and lists the reasons; missing evidence is never zero. If compilation returns an error, correct the evidence rows; do not bypass the gate. A computed score never determines recommendation strength automatically.

The final narrative may describe benefit-harm and decision considerations, but must label uncertainty and leave clinical, HTA, reimbursement, and procurement conclusions to qualified reviewers.

## 5. Deliverables

Write:

- `comprehensive-evaluation-report.md`: question, methods, source coverage, domain findings, certainty basis, contradictions, applicability, economics/HTA limits, and reviewer considerations.
- `evidence-table.csv`: one traceable row per source-domain link with observed findings and limitations.
- `evaluation-summary.json`: the exact compiler result, domain coverage, audit hash, and human-review flag.
- `evidence-snapshot.json`: deduplicated sources, exact queries, scope, retrieval timestamps, and observed fields. Every source URL cited in the report must appear here; never cite a source that is not recorded in the frozen snapshot.

Resolve every material citation. Completion means the assisted evidence and domain-assessment package is reproducible, not that an external approval workflow has finished.
