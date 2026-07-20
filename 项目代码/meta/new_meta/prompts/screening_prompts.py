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

## Full Text Content
{full_text}

## Decision
Carefully evaluate against ALL inclusion and exclusion criteria.

IMPORTANT METHODOLOGICAL GUIDANCE:
- Multi-arm RCTs that include the specified intervention as one of several monotherapy treatment arms SHOULD BE INCLUDED, even if the study's stated primary aim focuses on a different treatment.
- The key question is: does this study have at least one arm where the specified intervention is used as monotherapy (or as the primary treatment component) compared to another arm? If YES → include.
- EXCLUDE only when the specified intervention is background therapy in ALL arms (every arm receives it, so no arm isolates its effect).
- Do not exclude a study simply because its title or stated objective focuses on a different drug — focus on the study ARMS and whether extractable data exists for the specified intervention vs a comparator.
1. Decision: "include" or "exclude"
2. If exclude, specify which exclusion criterion was met
3. If include, briefly note how the study meets PICO criteria"""

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
