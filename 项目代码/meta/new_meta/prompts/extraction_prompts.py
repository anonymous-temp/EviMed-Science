"""Prompts for the Data Extraction agent."""

SYSTEM_PROMPT = """You are a data extraction specialist for systematic reviews and meta-analyses. Your task is to extract structured data from research papers with absolute accuracy. Every extracted value must be traceable to a specific location in the source paper. Never fabricate or estimate values — if information is not found, mark it as null."""

CHARACTERISTICS_EXTRACTION_PROMPT = """Extract study characteristics from this paper for our meta-analysis.

## Research Protocol
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Study Design: {study_design}

## Paper Content
The paper text contains [PAGE N] markers indicating page boundaries.

{paper_content}

## Extract the following (provide source_location for each):
0. Bibliographic metadata if available in the PDF: title, authors, year, journal, DOI/PMID
1. Study design (RCT, cohort, case-control, etc.)
2. Country/setting
3. Sample size (intervention group, control group)
4. Population description (age, sex, disease status, etc.)
5. Intervention details (type, dose, duration, frequency)
6. Control/comparator details
7. Follow-up duration
8. Funding source

For EVERY extracted value, provide:
- The exact value
- source_location: where in the paper (e.g., "Table 1", "Methods section, paragraph 3", "Page 5")
- source_quote: verbatim quote from the paper supporting the value
- source_page: the page number from the nearest preceding [PAGE N] marker
- source_section: the section name (e.g., "Methods", "Results", "Table 2")"""

OUTCOME_EXTRACTION_PROMPT = """Extract outcome data from this paper for meta-analysis.

## Research Protocol
- Primary Outcome: {primary_outcome}
- Secondary Outcomes: {secondary_outcomes}
- Effect Measure: {effect_measure}

## Paper Content
The paper text contains [PAGE N] markers indicating page boundaries.

{paper_content}

## Extract for EACH relevant outcome:

For CONTINUOUS outcomes (means, scores):
- Mean in intervention group
- SD in intervention group
- N in intervention group
- Mean in control group
- SD in control group
- N in control group
- If median/IQR is reported instead of mean/SD, use these exact schema fields:
  median_intervention, q1_intervention, q3_intervention, n_intervention,
  median_control, q1_control, q3_control, n_control
- If median/range is reported, use:
  median_intervention, min_intervention, max_intervention, n_intervention,
  median_control, min_control, max_control, n_control
- Or: Mean difference, 95% CI, p-value (if reported directly)

For DICHOTOMOUS outcomes (events, proportions):
- Events in intervention group
- Total in intervention group
- Events in control group
- Total in control group
- Or: OR/RR, 95% CI, p-value (if reported directly)

For TIME-TO-EVENT or REPORTED ASSOCIATION outcomes:
- Extract the reported point estimate into effect_size and its interval into ci_lower/ci_upper
- Set reported_effect_measure (for example HR, OR, RR, MD, or SMD)
- Set reported_effect_scale to "original" unless the paper explicitly reports a log-scale coefficient
- Set reported_effect_adjusted=true only when the paper explicitly calls the estimate adjusted
- For an adjusted estimate, extract every reported adjustment variable into adjustment_covariates
- Never pool or relabel an unadjusted estimate as adjusted

For SINGLE-ARM PREVALENCE or INCIDENCE outcomes:
- Prevalence: events and total_n
- Incidence: events, person_time, and person_time_unit
- Preserve zero-event studies and the exact time unit

For DIAGNOSTIC-ACCURACY outcomes:
- true_positive, false_negative, false_positive, true_negative
- diagnostic_threshold and reference standard when reported
- Keep different thresholds as distinct outcome rows

For PREDICTION-MODEL PERFORMANCE outcomes:
- prediction_model_id and prediction_model_version must identify the exact evaluated model
- prediction_validation_type must distinguish external validation from development/apparent or internal validation
- prediction_performance_measure (C_STATISTIC, OE_RATIO, CALIBRATION_SLOPE, or BRIER)
- prediction_performance_estimate, prediction_performance_se, and confidence limits when reported
- prediction_sample_size, prediction_events (observed events), prediction_expected_events
  (model-expected events for O:E), and the exact outcome timepoint
- Keep different model versions, validation types, metrics, populations, and time horizons as distinct rows
- Do not relabel apparent development performance as external validation

## IMPORTANT:
- Look in Tables first (most reliable), then Results text
- If median/IQR reported instead of mean/SD, extract median, Q1, Q3, and N into the schema fields above; do not put them only in quality_notes
- If multiple time points, extract the primary endpoint
- If multiple subgroups, extract overall and per-subgroup data
- If multiple adjusted models are reported, keep them as distinct rows and label the covariate set; do not silently choose one
- For EVERY value, provide source_location, source_quote, source_page (page number from nearest [PAGE N] marker), and source_section
- Set extraction_confidence to "high", "medium", or "low" for each outcome based on clarity of the source data
- If a value is NOT found, set it to null — NEVER guess"""

EXTRACTION_CHECK_PROMPT = """Review the following data extraction for accuracy and completeness.

## Original Paper Content
{paper_content}

## Extracted Data
{extracted_data}

## Check:
1. Are all extracted values accurate and match the source paper?
2. Are any values missing that should have been extracted?
3. Are source_location and source_quote correct for each value?
4. Are the outcome types (continuous/dichotomous) correctly classified?
5. Are units consistent?

Score the extraction quality (1-10) and provide specific suggestions for improvement if score < 8."""
