"""Prompts for the Risk of Bias agent."""

SYSTEM_PROMPT = """You are a risk-of-bias assessment specialist for systematic reviews. Use only the review-family-specific validated tool supplied in the task. Every domain judgment must be supported by a verbatim source quote plus page or section locator; never infer an unreported safeguard."""

ROB2_PROMPT = """Assess the risk of bias for this RCT using the Cochrane Risk of Bias tool 2 (RoB 2).

## Paper Content
The paper text contains [PAGE N] markers indicating page boundaries.

{paper_content}

## Evaluate these 5 domains:

### Domain 1: Risk of bias arising from the randomization process
- Was the allocation sequence random?
- Was the allocation sequence concealed until participants were enrolled?
- Were there baseline differences that suggest a problem with randomization?

### Domain 2: Risk of bias due to deviations from intended interventions
- Were participants aware of their assigned intervention?
- Were carers/people delivering the intervention aware of participants' assigned intervention?
- Were there deviations from the intended intervention beyond what would be expected in usual practice?

### Domain 3: Risk of bias due to missing outcome data
- Were outcome data available for all, or nearly all, participants?
- Is there evidence that the result was not biased by missing outcome data?

### Domain 4: Risk of bias in measurement of the outcome
- Was the method of measuring the outcome inappropriate?
- Could measurement of the outcome have differed between intervention groups?
- Were outcome assessors aware of the intervention received by study participants?

### Domain 5: Risk of bias in selection of the reported result
- Were the data analyzed in accordance with a pre-specified analysis plan?
- Is the numerical result being assessed likely to have been selected from multiple outcome measurements or analyses?

For EACH domain, provide:
- judgment: "Low risk" / "Some concerns" / "High risk"
- support: concise rationale based only on the paper
- source_quote: one verbatim sentence or clause copied exactly from the paper content
- source_page: page number from the nearest preceding [PAGE N] marker in the text
- source_section: section name where the evidence was found

Then provide an overall judgment."""

NOS_PROMPT = """Assess the risk of bias for this observational study using the Newcastle-Ottawa Scale (NOS).

## Paper Content
The paper text contains [PAGE N] markers indicating page boundaries.

{paper_content}

## Evaluate these domains:

### Selection (max 4 stars)
1. Representativeness of the exposed cohort
2. Selection of the non-exposed cohort
3. Ascertainment of exposure
4. Demonstration that outcome was not present at start

### Comparability (max 2 stars)
5. Comparability based on design or analysis (adjusting for confounders)

### Outcome (max 3 stars)
6. Assessment of outcome
7. Follow-up long enough for outcomes to occur
8. Adequacy of follow-up (attrition rate)

For EACH item, provide:
- judgment: "Low risk" (star awarded) / "High risk" (no star)
- support: specific evidence from the paper
- source_page: page number from the nearest preceding [PAGE N] marker in the text
- source_section: section name where the evidence was found

Provide total stars (/9) and overall judgment:
- 7-9 stars: "Low risk"
- 4-6 stars: "Some concerns"
- 0-3 stars: "High risk" """


ROBINS_I_PROMPT = """Assess this non-randomized intervention result using ROBINS-I.

## Paper Content
{paper_content}

Evaluate confounding, participant selection, intervention classification, deviations from intended interventions, missing data, outcome measurement, and selective reporting. For every domain return a judgment, verbatim source quote, source page or section, and concise rationale. Do not convert absence of reporting into low risk. Return an overall ROBINS-I judgment."""


JBI_PREVALENCE_PROMPT = """Assess this prevalence result using the JBI Critical Appraisal Checklist for Studies Reporting Prevalence Data.

## Paper Content
{paper_content}

Evaluate: appropriateness of the sample frame; sampling method; adequacy of sample size; description of subjects and setting; coverage of the identified sample; validity of condition measurement; standardized/reliable measurement; appropriateness of statistical analysis; and adequacy/management of response rate. For every item return a judgment, verbatim source quote, source page or section, and concise rationale. The target is the specific prevalence outcome, definition, time point, and analysis population. Return an overall judgment without inventing unreported safeguards."""


QUADAS2_PROMPT = """Assess this diagnostic-accuracy result using QUADAS-2.

## Paper Content
{paper_content}

Evaluate patient selection, index test, reference standard, and flow/timing. Separate risk of bias from applicability where the source permits. Record threshold prespecification and blinding explicitly. For every domain return a judgment, verbatim source quote, source page or section, and concise rationale. Return an overall judgment for the specified test result."""


QUIPS_PROMPT = """Assess this prognostic-factor result using QUIPS.

## Paper Content
{paper_content}

Evaluate study participation, attrition, prognostic-factor measurement, outcome measurement, confounding, and statistical analysis/reporting. Focus on the specified adjusted association and time horizon. For every domain return a judgment, verbatim source quote, source page or section, and concise rationale. Return an overall judgment."""


PROBAST_PROMPT = """Assess this prediction-model result using PROBAST.

## Paper Content
{paper_content}

Evaluate participants, predictors, outcome, and analysis, including events-per-parameter, missing data, overfitting, calibration, discrimination, and validation type where reported. For every domain return a judgment, verbatim source quote, source page or section, and concise rationale. Return an overall judgment for the identified model version."""
