"""Prompts for the Screening agent."""

SYSTEM_PROMPT = """You are a systematic review screening specialist. Your role is to evaluate studies for inclusion in a meta-analysis based on predefined criteria.

You must apply TWO judgments per paper:
1. **include / exclude**: Does this study plausibly belong in the review?
2. **priority_tier**: How likely is it to be a directly usable RCT for quantitative meta-analysis?

Priority tier definitions:
- "direct": High-confidence RCT (or the protocol's target design) that matches PICO on all four elements. Likely has extractable quantitative outcome data.
- "uncertain": Possibly relevant but information is incomplete (e.g. design unclear from abstract, intervention only partially matches, outcome not explicitly stated). Could become direct after full-text review.
- "indirect": Observational study, real-world study, subgroup analysis, post-hoc analysis, or non-RCT that may provide supporting evidence but is unlikely to yield direct meta-analysis data.

Mandatory exclusions (always "exclude"):
- Systematic reviews, meta-analyses, narrative reviews, scoping reviews
- Case reports, case series (N<5)
- Animal studies, in vitro studies, preclinical experiments
- Editorials, commentaries, letters without original data
- Guidelines, consensus statements without new data

These study types provide no extractable primary data and must be excluded at T/A screening."""

TITLE_ABSTRACT_IDENTITY_RULES = """

## Source-bound Triage Contract
- Copy source_identity exactly from the supplied object, including empty strings. record_id binds this assessment to this record; do not substitute another publication or a trial registration. PMID/DOI identify publications, while trial_registration identifies a trial that may have several publications.
- For EVERY item in the Complete Protocol Identifier Inventory, return exactly one publication_identity_checks item with identifier_type, requirement, the entire identifiers list, and verbatim protocol_criterion. The exact field name is requirement: set requirement="any_of" for permitted alternatives, requirement="none_of" for forbidden identifiers, or requirement="context_only" for citations that impose no publication restriction. Do not substitute check, match_type, matched or satisfied for requirement; identifier matching is independently computed by the runtime. A context_only check requires context_reason. Do not omit an alternative, reinterpret a negated restriction as permission, or turn a contextual citation into a whitelist. If a mixed group cannot be faithfully represented, return review_required. Return [] only when the inventory is empty.
- A publication-identity exclusion must use reason_code=publication_identity and an actual mismatch with a complete applicable identifier constraint. Do not say a supplied PMID is different from itself. Exact identifier equality is checked independently. A matching publication identifier alone does not establish clinical eligibility.
- Set publication_role from the publication itself: primary_publication, secondary_analysis, design_or_protocol, adjacent_outcome_trial, other or uncertain. A secondary endpoint is not a secondary publication. An eligible main report may report the review's target outcome as secondary or exploratory even when its abstract emphasizes another primary endpoint.
- Set target_outcome_evidence to reported, not_mentioned, explicitly_not_measured or uncertain, based only on this title/abstract. Outcome absence from the abstract does not prove absence from the full text. A missing abstract or an abstract listing another primary outcome cannot establish that the requested secondary outcome is unavailable. Forward these cases as decision=include, priority_tier=uncertain for full-text review. This is triage, not final clinical inclusion.
- Use explicitly_not_measured only when the abstract explicitly establishes that the target outcome was not measured; copy the supporting verbatim abstract text into outcome_evidence_quote. Set outcome_evidence_quote=null if there is no such quote. Do not label silence, an abstract's endpoint list or different primary endpoint as explicit non-measurement.
- Use reason_code=eligible for inclusion; publication_identity/publication_type/population/intervention/comparator/outcome/study_design/data_unavailable/other for the corresponding substantive exclusion. Use uncertain for unresolved judgments. An exclusion requires exclusion_criterion. If metadata, identifiers, publication role or outcome availability conflict or are incomplete, return include/uncertain or review_required rather than exclude. Supported clinical exclusions still apply when a publication identifier matches.
- Return decision, priority_tier, reason_code, reason, exclusion_criterion, confidence, source_identity, publication_role, target_outcome_evidence, outcome_evidence_quote and publication_identity_checks for each paper.

## Exact Schema for Each publication_identity_checks Item
This item schema applies to every decision, including each decision in a batch.
{publication_identity_check_schema}
"""

TITLE_ABSTRACT_SCREENING_PROMPT = """Evaluate whether this study should be included in our meta-analysis based on its title and abstract.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
- Target Study Design: {study_design}
- Inclusion Criteria:
{inclusion_criteria}
- Exclusion Criteria:
{exclusion_criteria}

## Source Identity to Bind the Decision
{source_identity}

## Complete Protocol Identifier Inventory
{publication_identity_inventory}

## Paper to Screen
- Title: {title}
- Abstract: {abstract}

## Decision Rules

### Step 1 — Mandatory exclusion (auto-exclude regardless of PICO):
- Systematic review / meta-analysis / scoping review / narrative review
- Case report / case series (N<5)
- Animal / in vitro / preclinical study
- Editorial / commentary / letter without original data
- Guideline / consensus statement without new data

If the paper matches any of the above → decision="exclude", priority_tier="indirect".

### Step 2 — PICO assessment (only for original research):
- If the paper CLEARLY matches PICO on population, intervention, and outcome, and is an RCT/target design → decision="include", priority_tier="direct"
- If the paper LIKELY matches PICO but some elements are uncertain from abstract → decision="include", priority_tier="uncertain"
- If the paper is observational/non-RCT but addresses the same clinical question → decision="include", priority_tier="indirect"
- If the paper CLEARLY does not meet PICO criteria → decision="exclude", priority_tier="indirect"

IMPORTANT: The intervention ARM must contain the specified intervention. Multi-arm RCTs that include the specified intervention as one of several treatment arms being compared SHOULD be included — the study's stated primary aim does not need to be the specified intervention. For example, a 3-arm trial comparing Drug A vs Drug B vs Drug C, where Drug A is the specified intervention, IS a match (include). However, studies where the specified intervention appears only as background therapy in ALL arms (every arm receives it plus different add-on drugs) should be excluded.

### Step 3 — If uncertain between include/exclude:
- Include, but set priority_tier="uncertain"

Provide your source-bound decision and a brief reason.""" + TITLE_ABSTRACT_IDENTITY_RULES

FULL_TEXT_SCREENING_PROMPT = """Evaluate whether this study should be included based on full-text review.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
- Study Design: {study_design}
- Inclusion Criteria:
{inclusion_criteria}
- Exclusion Criteria:
{exclusion_criteria}

## Authoritative Paper Metadata
{paper_metadata}

## Source Identity to Bind the Decision
{source_identity}

## Complete Protocol Identifier Inventory
{publication_identity_inventory}

## Full Text Content
{full_text}

## Decision
Carefully evaluate against ALL inclusion and exclusion criteria. Return a FullTextScreeningDecision.

SOURCE AND PUBLICATION IDENTITY:
- Copy source_identity exactly from the supplied identity object, including empty strings. Do not infer a different PMID from prose or replace it with a trial registration.
- These identifiers identify the publication being screened. A trial registration identifies a trial, not every publication about it. Matching an allowed publication identifier does not establish clinical eligibility.
- Compare the full text with the metadata using title, authors, DOI and trial details. Set full_text_identity_status to consistent, conflicting or uncertain. PMID absence from a PDF alone is not a conflict. Do not silently attach another report's content to the supplied identity.
- For EVERY item in the Complete Protocol Identifier Inventory, return exactly one publication_identity_checks item, preserving the entire identifiers list, identifier_type and verbatim protocol_criterion. Do not omit a field, identifier type or alternative identifier, even if repeated in another field. The inventory recognizes identifier syntax only; interpret the requirement from the complete protocol: any_of for permitted alternatives, none_of for forbidden identifiers, or context_only for contextual citations that impose no publication restriction. context_only requires context_reason explaining that interpretation. Return [] only when the inventory is empty. If one inventoried group mixes allowed, forbidden or contextual identifiers such that these requirement types cannot faithfully represent it, return review_required rather than dropping identifiers.
- Use reason_code=publication_identity for exclusions based on publication PMID/DOI restrictions. Such an exclusion requires an anchored check with an actual identifier mismatch; do not claim a supplied PMID differs from itself. Identifier comparisons are verified deterministically.
- Publication type and endpoint priority are separate judgments. A primary_publication can report the review's target outcome as a secondary endpoint or exploratory endpoint. The review's primary synthesis outcome need not have been the trial's primary endpoint. Excluding secondary publications does not exclude secondary endpoints reported in an eligible main publication.
- Set publication_role from the publication itself: primary_publication, secondary_analysis, design_or_protocol, adjacent_outcome_trial, other or uncertain. Set target_outcome_priority separately: primary, secondary, exploratory, not_reported or uncertain. Baseline-covariate adjustment alone does not make a main publication a secondary publication.
- Use reason_code=publication_type for exclusions based on publication role; population/intervention/comparator/outcome/study_design/data_unavailable for the corresponding substantive eligibility problem. Use eligible only for inclusion. If identity or eligibility cannot be resolved, use decision=review_required and reason_code=uncertain.

IMPORTANT METHODOLOGICAL GUIDANCE:
- Multi-arm RCTs can meet intervention eligibility when the specified intervention is one of several monotherapy treatment arms, even if the trial's stated primary aim focuses on a different treatment.
- Check whether at least one arm uses the specified intervention as monotherapy (or as the primary treatment component) compared to another arm. This addresses intervention eligibility only; every other protocol criterion still applies.
- The intervention criterion fails when the specified intervention is background therapy in ALL arms (every arm receives it, so no arm isolates its effect).
- Do not exclude a study simply because its title or stated objective focuses on a different drug — focus on the study ARMS and whether extractable data exists for the specified intervention vs a comparator.
1. Decision: "include", "exclude" or "review_required"
2. If exclude, specify which exclusion criterion was met
3. If include, briefly note how the study meets PICO criteria"""

FULL_TEXT_CORRECTION_PROMPT = """

## One Corrective Assessment
The previous response could not be accepted. Reassess the same source using the unchanged metadata, protocol and full text above. Correct the precise validation problem without changing source identity or clinical scope. An identifier match is not a reason to force inclusion; retain any supported clinical exclusion. If the problem cannot be resolved, return review_required. The previous response is a fallible assessment, not source evidence.

Previous attempt and validation problem:
{previous_attempt}
"""

SCREENING_DECISION_SCHEMA = """{{
  "decision": "include or exclude",
  "priority_tier": "direct / uncertain / indirect",
  "reason": "brief explanation",
  "exclusion_criterion": "which criterion if excluded, null if included",
  "confidence": "high / medium / low"
}}"""

BATCH_TITLE_ABSTRACT_SCREENING_PROMPT = """Evaluate whether EACH of the following studies should be included in our meta-analysis based on their title and abstract.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
- Target Study Design: {study_design}
- Inclusion Criteria:
{inclusion_criteria}
- Exclusion Criteria:
{exclusion_criteria}

## Complete Protocol Identifier Inventory
{publication_identity_inventory}

## Papers to Screen
{papers_block}

## Decision Rules

### Mandatory exclusion (auto-exclude):
- Systematic review / meta-analysis / scoping review / narrative review
- Case report / case series (N<5)
- Animal / in vitro / preclinical study
- Editorial / commentary / letter without original data
- Guideline / consensus statement without new data

### PICO assessment (for original research only):
- "direct": Clearly matches PICO (population + intervention + outcome) AND is RCT/target design
- "uncertain": Likely matches PICO but some elements unclear from abstract
- "indirect": Observational / non-RCT addressing the same clinical question

IMPORTANT: The intervention ARM must contain the specified intervention. Apply these rules:
1. Multi-arm RCTs with the specified intervention as one of several monotherapy arms SHOULD BE INCLUDED (e.g., a 3-arm trial with Drug A, Drug B, Drug C where Drug A is the intervention — include even if the study's primary aim focuses on Drug B or C).
2. Studies where the specified intervention is the primary treatment component in the intervention arm SHOULD BE INCLUDED.
3. EXCLUDE only when the specified intervention appears solely as background therapy in ALL arms — i.e., every arm receives the intervention plus different add-on drugs, with no arm that isolates the intervention's effect.

For EACH paper, return a JSON object with:
- "source_identity": the exact identity object supplied for this paper
- "decision": "include" or "exclude"
- "priority_tier": "direct" / "uncertain" / "indirect"
- "reason": brief explanation
- "exclusion_criterion": which criterion if excluded, null if included
- "confidence": "high" / "medium" / "low"

Return a JSON array of decisions, one per paper, in the same order.

CRITICAL: You MUST return exactly one decision object for EVERY paper listed above. Do not skip or omit any paper. If unsure about a paper, set decision="include", priority_tier="uncertain" for full-text review rather than excluding or omitting it.""" + TITLE_ABSTRACT_IDENTITY_RULES
