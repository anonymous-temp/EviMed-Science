---
name: off-label-analysis
description: Compare a proposed medicine use with current jurisdiction-specific label evidence and separately synthesize evidence support without pretending to authorize use.
---

# Off-label Use Analysis

Use this workflow to assist item-level assessment of a proposed indication, population, dose, route, frequency, duration, or formulation. Workflow approval and organizational sign-off are out of scope; do not claim that the assisted assessment authorizes use.

Unless the user requests another language, interact and write deliverables in Simplified Chinese. Preserve official label terms, product names, identifiers, source titles, dose units, and structured field names when translation would reduce traceability.

## 1. Bind the exact proposed use

Require the drug and proposed indication. First call `mcp__evimed__offlabel_evidence_packet` with `action: requirements`. Ask once for the returned missing fields in one concise group. If the user does not provide them, continue retrieval but preserve every unresolved field as a gap and withhold the affected comparison or score. Capture the exact product, population, dose, route, frequency, duration, formulation, jurisdiction, and decision date. Normalize the medicine with `mcp__evimed__drug_term_normalize`.

Jurisdiction is a classification boundary. If it is missing, record the gap and do not classify the use as label-concordant. Never substitute an FDA label for China, EMA, PMDA, or another jurisdiction.

## 2. Retrieve and freeze evidence

Call `mcp__evimed__offlabel_evidence_packet` with `action: retrieve`. Verify the exact current official product label with `mcp__evimed__drug_label_search`. Use the EviMed NMPA candidate first for a China question, then verify product, approval number, revision date, and currentness. If an exact institutional copy is material but EviMed does not return it, ask once for the current institution label or uploaded file and preserve the gap if it is not supplied. An institutional copy is local evidence and must not be presented as proof of the current NMPA record. If the product originated in another jurisdiction, retrieve that origin-country label separately as evidence support; it must never replace the target-jurisdiction label classification. Use guidelines, trials, literature, and active catalogued biomedical sources only for separate evidence-support questions.

The optional `mcp__evimed__pharmacy_reference_search` tool can help normalize private
names, routes, frequencies, dose-risk rules, interactions, or special-population
screening terms. Its output cannot establish target-jurisdiction label status,
approval, legality, or evidence support. Verify material rows against the exact
current product label, current guideline or pharmacopoeia, and approved local
policy, and retain their private provenance.

Preserve source identifier, URL, jurisdiction, product scope, version/effective date, retrieval time, exact query, and retrieved label text. A missing label, empty search, connector error, or truncated section is `unclear`, never `match`, `mismatch`, approval, or non-approval. Bibliographic search results are metadata unless evidence content is explicitly present; metadata does not establish design, efficacy, dose support, or certainty. Read the evidence content required for material conclusions.

Deduplicate records and freeze the source and query package in `evidence-snapshot.json` before assessment; the compiler input SHA-256 binds the structured assessment to the supplied inventory. Mark uploaded files as user-provided evidence. If a material licensed source such as Micromedex is unavailable, ask once for a user-provided excerpt or export and record the gap when it is not supplied. Never infer a licensed-database rating from public literature.

## 3. Compare label dimensions

Compare `indication`, `population`, `dose`, `route`, `frequency`, `duration`, and `formulation` independently when supplied. For each dimension use only `match`, `mismatch`, `unclear`, or `not_assessed`, with a rationale and exact label `evidenceIds`. Do not infer a label mismatch from guidelines or literature.

Call `mcp__evimed__offlabel_evidence_packet` with `action: compile`, `sourceInventory`, and `labelComparisons`. If it returns an error, correct the structured evidence; do not default to compliant or off-label. `potentially_off_label` is a preliminary label comparison, not a conclusion that use is illegal, unsupported, or clinically inappropriate.

Assess evidence support separately by available type: origin-country label, evidence database, clinical guideline, systematic review, randomized trial, nonrandomized study, case report/series, and reference work. Submit one `evidenceSupportAssessments` row per assessed type. Use `supports`, `mixed`, `does_not_support`, `unclear`, `not_found`, or `not_assessed`; never turn an unavailable type into a zero score. Preserve observed external ratings without converting between systems. When formally appraising evidence, use the method required by the supplied rubric or source type, such as AGREE II, AMSTAR 2, RoB 2, ROBINS-I, Jadad, MINORS, or Newcastle-Ottawa, and record both the appraisal tool and its observed rating. The compiler records type-level support but intentionally does not manufacture an overall evidence grade.

## 4. Keep four conclusions independent

Report four separate axes:

1. Regulatory label status for the exact product and jurisdiction.
2. Strength and directness of supporting evidence.
3. Clinical appropriateness for the defined patient and alternatives.
4. Workflow authorization: explicitly out of scope for this scoring agent.

Literature support does not change label status. Label mismatch does not prove ineffectiveness. Evidence presence does not prove benefit, and study counts never substitute for outcome appraisal. Do not infer regulatory approval, legality, reimbursement, or clinical appropriateness from literature support.

## 5. Deliverables

Write:

- `off-label-report.md`: exact question, label comparison, evidence synthesis, alternatives, patient risks, four-axis conclusions, gaps, and required reviews.
- `evidence-table.csv`: one row per observed source or label dimension with source ID, jurisdiction, product/version, evidence role, findings, and limitations.
- `assessment-result.json`: the exact compiler result, classification, mismatch/uncertain dimensions, audit hash, and human-review flag.
- `evidence-snapshot.json`: deduplicated sources, exact queries, scope, retrieval timestamps, and observed fields. Every source URL cited in the report must appear here; never cite a source that is not recorded in the frozen snapshot.

Resolve every material citation. Completion means the assisted evidence and score package is reproducible; it does not mean an organizational workflow has approved it.
