"""Prompts for the GRADE (Grading of Recommendations, Assessment, Development and Evaluations) agent."""

SYSTEM_PROMPT = """You are an expert in GRADE (Grading of Recommendations, Assessment, \
Development and Evaluations) methodology for systematic reviews and meta-analyses. \
You assess the certainty of evidence across five domains: risk of bias, inconsistency, \
indirectness, imprecision, and publication bias. Your assessments are rigorous, \
transparent, and follow the GRADE handbook guidelines. When providing rationale, \
cite specific quantitative evidence (e.g., I-squared values, confidence intervals, \
sample sizes) and reference the GRADE framework criteria. Always return structured \
JSON output as requested."""

INDIRECTNESS_PROMPT = """Assess the indirectness of evidence for this outcome.

## Study PICO details
{studies_pico}

## Protocol PICO (target question)
{protocol_pico}

## Instructions
Evaluate the following dimensions of indirectness by comparing each included study's \
PICO elements to the target research question:

1. **Population**: Are the study populations sufficiently similar to the target \
population? Consider age, sex, disease severity, comorbidities, and setting.
2. **Intervention**: Do the study interventions match the target intervention in \
dose, duration, formulation, and delivery method?
3. **Comparator**: Do the study comparators match the target comparator? Consider \
active vs placebo, dose equivalence, and standard-of-care variation.
4. **Outcome**: Do the measured outcomes directly reflect the target outcome? \
Consider surrogate vs clinical endpoints, measurement tools, and time points.

Rate the overall indirectness as one of:
- "no concern": All PICO elements closely match the target question.
- "serious": One or more PICO elements differ meaningfully, potentially affecting \
applicability.
- "very serious": Multiple PICO elements differ substantially, or a single element \
is highly discrepant (e.g., entirely surrogate outcome).

Provide a concise rationale citing specific discrepancies or confirming alignment.

Return JSON: {{"rating": "...", "rationale": "..."}}"""

ROB_SUMMARY_PROMPT = """Summarize the risk of bias findings across all included studies \
for the GRADE assessment.

## Risk of Bias Data
{rob_data}

## Instructions
Review the individual study risk-of-bias judgments above. Consider:
- The proportion of studies at high risk, some concerns, and low risk
- Which specific domains drive the concerns
- Whether high-risk studies contribute disproportionately to the pooled effect

Provide a concise summary suitable for a GRADE evidence profile footnote.

Return JSON: {{"rating": "...", "rationale": "..."}}"""

IMPRECISION_RATIONALE_PROMPT = """Provide a GRADE-style rationale for the imprecision \
assessment of this outcome.

## Pooled Effect Summary
{effect_summary}

## Imprecision Assessment
Rating: {rating}
Number of studies: {n_studies}
Total sample size: {total_n}
Optimal information size (OIS): {ois}
Confidence interval width: {ci_width}
CI crosses null: {crosses_null}

## Instructions
Write a concise rationale explaining why this level of imprecision was assigned. \
Reference the specific numbers (sample size vs OIS, CI width, number of events if \
applicable). Follow GRADE handbook language conventions.

Return JSON: {{"rationale": "..."}}"""

INCONSISTENCY_RATIONALE_PROMPT = """Provide a GRADE-style rationale for the \
inconsistency assessment of this outcome.

## Heterogeneity Statistics
I-squared: {i_squared:.1f}%
Q statistic: {q_stat:.2f} (p = {q_p:.4f})
Tau-squared: {tau_squared:.4f}
Prediction interval: {prediction_interval}
Number of studies: {n_studies}

## Rating
{rating}

## Instructions
Write a concise rationale explaining the inconsistency rating. Reference the \
heterogeneity statistics and their clinical interpretation. Follow GRADE handbook \
language conventions.

Return JSON: {{"rationale": "..."}}"""

PUBLICATION_BIAS_RATIONALE_PROMPT = """Provide a GRADE-style rationale for the \
publication bias assessment of this outcome.

## Publication Bias Test Results
{pub_bias_summary}

## Rating
{rating}

## Instructions
Write a concise rationale for the publication bias rating. Reference the specific \
test results (Egger's p-value, Begg's, trim-and-fill estimates). Follow GRADE \
handbook language conventions.

Return JSON: {{"rationale": "..."}}"""
