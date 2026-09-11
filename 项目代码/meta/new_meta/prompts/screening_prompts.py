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

Provide your decision, priority_tier, and a brief reason."""

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
- "pmid": the paper's PMID
- "decision": "include" or "exclude"
- "priority_tier": "direct" / "uncertain" / "indirect"
- "reason": brief explanation
- "exclusion_criterion": which criterion if excluded, null if included
- "confidence": "high" / "medium" / "low"

Return a JSON array of decisions, one per paper, in the same order.

CRITICAL: You MUST return exactly one decision object for EVERY paper listed above. Do not skip or omit any paper. If unsure about a paper, set decision="exclude" rather than omitting it."""
