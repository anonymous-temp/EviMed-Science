"""Prompts for the Writing agent — section-by-section manuscript generation."""

SYSTEM_PROMPT = """You are an expert academic medical writer specializing in systematic reviews and meta-analyses. You write in a rigorous, evidence-based, and objective scientific style following PRISMA 2020 reporting guidelines. You ONLY write from structured data and verified results — you NEVER fabricate claims, statistics, or citations.

FORMATTING RULE: Do NOT use bold formatting (**...**) in body text. Bold is ONLY allowed for sub-section labels at the start of a paragraph (e.g. "**Background:**"). Never bold regular sentences, data descriptions, conclusions, or emphasis words.

CONCLUSION LANGUAGE RULES (strict):
- FORBIDDEN phrases: "can improve", "is effective", "significantly improves", "可改善", "有效", "显著改善", "证实", "明确表明", "结论性证据"
- REQUIRED hedging: use "may improve", "evidence is limited", "findings are inconclusive", "可能改善", "证据有限", "结论不确定", "尚需进一步验证"
- When ≤2 studies: MUST state "limited evidence" / "证据有限"
- When key statistics missing: MUST insert uncertainty statement
- NEVER mix endpoint values with change-from-baseline values in the same comparison

CROSS-STUDY INTEGRATION RULES (strict):
- When studies use different measurement approaches (endpoint vs change-from-baseline, different time points, dose-response vs single dose):
  * If a prespecified meta-analysis has been performed on a compatible effect scale, describe the pooled estimate as answering the prespecified broader construct and explicitly state the endpoint-definition or timing caveat.
  * If no compatible pooled analysis has been performed, state that individual studies should be interpreted separately and explain why synthesis was not appropriate.
  * FORBIDDEN without supporting subgroup/component evidence: "all studies showed", "each component improved", "class effect", "所有组成终点均改善", "已证实类别效应"
- NEVER combine endpoint and change values in the same sentence
- NEVER summarize dose-response and single-dose results together

SPECULATION RULES (strict):
- FORBIDDEN: "可能由于…导致" / "may be due to" / "this might be attributed to" — without citing a specific study author's explanation
- When a study result appears anomalous and no author explanation is available:
  * REQUIRED: "原因尚不明确，原研究未提供充分信息" / "The reason remains unclear; the original study did not provide sufficient information"
- You MAY explain results IF the explanation comes directly from a cited study author (e.g., "Smith et al. [3] attributed this to...")

STATISTICAL EXPRESSION RULES (strict):
- p=0.0 is impossible; always write p<0.001
- All numeric values must include units (mg, kg, %, weeks, etc.)
- If unit is missing from original data: append "（原研究未报告单位）" / "(unit not reported in original study)"
- NEVER fabricate units not present in the source data

EVIDENCE CLASSIFICATION RULES (strict):
- Only studies classified as "direct_eligible_rct" count as "included RCT" in the report.
- "included study count" / "纳入研究数" = count of direct_eligible_rct ONLY.
- Observational, post-hoc, real-world, systematic review, case report, basic research → these are NOT "纳入RCT".
- Table 1 = direct_eligible_rct only.
- Table 2 = indirect clinical evidence (observational, post-hoc, real-world).
- Table 3 = excluded evidence (reviews, case reports, animal/in vitro, untraceable).

METHODS ACCURACY RULES (strict):
- Do NOT claim human reviewers, two independent reviewers, third-party adjudication, manual cross-checking, hand extraction, PROSPERO registration, or database searches unless those facts are explicitly provided in the prompt.
- Screening, extraction, and verification are automated pipeline steps unless explicit human-review metadata is provided.
- Use only the database names supplied in the prompt; do not add Embase, CENTRAL, Web of Science, CNKI, Wanfang, or other databases unless they are listed."""

TITLE_PROMPT = """Generate a concise, descriptive title for this meta-analysis.

Research Question: {research_question}
PICO:
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
Number of direct eligible RCTs: {n_studies}

Follow the format: "[Intervention] for [Outcome] in [Population]: A Systematic Review and Meta-Analysis"
Keep it under 25 words."""

ABSTRACT_PROMPT = """Write a structured abstract for this meta-analysis using the following verified data.

## Research Protocol
{protocol_json}

## Key Results
- Direct eligible RCTs included: {n_studies}
- Total studies screened and assessed: {total_screened}
- Primary outcome ({effect_measure}): {pooled_effect} (95% CI: {ci_lower} to {ci_upper}; p={p_value})
- Heterogeneity: I²={i_squared}%
- Publication bias: {pub_bias_summary}
{grade_conclusion}

## Evidence Classification
{evidence_class_summary}

## Structure (250-300 words):
**Background:** Brief context and rationale
**Methods:** Databases, inclusion criteria, statistical methods
**Results:** PRISMA flow summary, main findings with exact numbers. ONLY count direct_eligible_rct as "included RCT".
**Conclusions:** Clinical implications, certainty of evidence

CRITICAL RULES:
- "纳入" / "included" count = {n_studies} (direct_eligible_rct only)
- Use EXACT numbers from the data provided. Do not round excessively.
- Do NOT count observational/post-hoc/review/case-report studies as "RCT".
- Total participant count MUST come from direct_eligible_rct studies only, NOT from all screened studies."""

INTRODUCTION_PROMPT = """Write the Introduction section for this meta-analysis.

## Research Question: {research_question}
## PICO: {pico_json}
## Number of existing reviews on this topic: Mention this is needed as current evidence is insufficient or inconclusive.

## Structure (700-900 words, 5-7 paragraphs):
1. Background on the clinical/scientific problem
2. Current state of knowledge and why a meta-analysis is needed
3. Knowledge gap this meta-analysis addresses
4. Clear statement of the objective

Use background citations when a citation context is provided. Do not invent citations or cite records that are not listed in the context."""

NARRATIVE_INTRODUCTION_PROMPT = """Write the Introduction section for this systematic review (narrative synthesis, NOT a meta-analysis).

## Research Question: {research_question}
## PICO: {pico_json}
## Number of existing reviews on this topic: Mention this is needed as current evidence is insufficient or inconclusive.

## Structure (700-900 words, 5-7 paragraphs):
1. Background on the clinical/scientific problem
2. Current state of knowledge and why a systematic review is needed
3. Knowledge gap this systematic review addresses
4. Clear statement of the objective

CRITICAL RULES:
- Do NOT mention "meta-analysis", "meta-analytic pooling", "pooled effect", "I²", "heterogeneity statistics",
  "sensitivity analysis", "subgroup analysis", "forest plot", "funnel plot", or any meta-analysis-specific methods.
- This is a NARRATIVE SYSTEMATIC REVIEW using descriptive synthesis.
- Use phrases like "systematic review", "narrative synthesis", "descriptive summary of evidence".
- Use background citations when a citation context is provided. Do not invent citations or cite records that are not listed in the context.
- Write in {lang_instruction}."""

METHODS_PROMPT = """Write the Methods section for this meta-analysis based on these verified details.

## Protocol
{protocol_json}

## Search Strategy
- Databases: {databases}
- Search query: {search_query}
- Date of search: {search_date}

## Screening (USE THESE EXACT NUMBERS — do NOT invent different numbers)
- Total records identified: {records_identified}
- After deduplication: {records_dedup}
- Screened (title/abstract): {screened}
- Full-text assessed: {full_text_assessed}
- Direct eligible RCTs included: {included}

## Data Extraction Method
Study characteristics, intervention details, comparators, and outcome data were extracted into structured evidence tables and checked against available source records.
Do not describe software, automation, audit file names, internal validation, or manuscript-generation steps in the Methods section.

## Risk of Bias Tool
Cochrane Risk of Bias 2 (RoB 2) for randomized controlled trials.

## Statistical Methods
{statistical_methods_text}

## Structure: Follow PRISMA 2020 checklist items for Methods.
Reference the PRISMA flow diagram (**Figure 1**) when describing the study selection process.
Use ONLY the exact screening numbers provided above. Do NOT estimate or invent different numbers.
Do NOT claim two independent human reviewers, dual independent extraction, or manual adjudication unless explicit human-review metadata is provided. Do not describe automation or internal workflow details.
Write in past tense, formal academic style. 1000-1300 words."""

RESULTS_PROMPT = """Write the Results section based on these verified statistical outputs.

## PRISMA Flow (USE THESE EXACT NUMBERS)
{prisma_json}

## Evidence Classification
{evidence_class_summary}

## Study Characteristics Summary
{study_table}

## Risk of Bias Summary
{rob_summary}

## Primary Outcome: {primary_outcome_name}
- Model: {model} effects
- Pooled {effect_measure}: {pooled_effect} (95% CI: {ci_lower} to {ci_upper})
- p-value: {p_value}
- Heterogeneity: Q={q_stat}, p={q_p}, I²={i_squared}%, τ²={tau_squared}
- Prediction interval: {pred_interval}
- Per-study data: {per_study_data}

## Secondary Outcomes
{secondary_outcomes_data}

## Sensitivity Analysis (Leave-one-out)
{sensitivity_data}

## Publication Bias
{pub_bias_section}

## GRADE Evidence Profile
{grade_data}

## Network Meta-Analysis
{nma_data}

## Citation Map (study → reference number)
{citation_map}

## Writing Instructions:
1. Study selection: reference **Figure 1** (PRISMA flow diagram)
2. Study characteristics: reference **Table 1** (direct eligible RCTs only)
3. Risk of bias: reference **Figure 4** (RoB summary)
4. Primary outcome: reference **Figure 2** (forest plot) — report EXACT numbers
5. Secondary outcomes
6. Sensitivity analysis: reference **Figure 5** (leave-one-out) and **Figure 6** (cumulative)
7. Publication bias: {pub_bias_instruction}
8. GRADE certainty assessment (if available)
9. Network meta-analysis results (if available, reference NMA figures)

## Inline Citations:
When mentioning individual studies, use numbered citations from the citation map above.
For example: "Smith 2020 [3] reported...". When listing multiple studies, group their
citations: "Several studies [1,3,5] found...".

Use ONLY the numbers provided. Every statistic must match the data above exactly. 1200-1600 words.

CRITICAL: The number of "included studies" = direct eligible RCTs only ({n_studies} studies).
Do NOT count observational, post-hoc, review, or case report studies as included RCTs."""

DISCUSSION_PROMPT = """Write the Discussion section for this meta-analysis.

## Key Findings
- Primary outcome: {primary_summary}
- Heterogeneity level: {heterogeneity_interpretation}
- Publication bias: {pub_bias_interpretation}
- Risk of bias: {rob_summary}
- GRADE evidence assessment: {grade_interpretation}

## Direct Eligible RCTs: {n_studies} studies
## Protocol
{protocol_json}

## Citation Map (study → reference number)
{citation_map}

## Structure (1200-1600 words):
1. **Main findings** — Summarize the principal results clearly
2. **Comparison with existing evidence** — How do results compare with prior reviews/guidelines. When referring to individual included studies, use their citation number from the map above (e.g., "[3]").
3. **Heterogeneity exploration** — Discuss potential sources (clinical, methodological, statistical). Reference sensitivity analysis (**Figure 5**), Galbraith plot (**Figure 8**), and Baujat plot (**Figure 9**) where relevant.
4. **Certainty of evidence** — Interpret the GRADE assessment and its implications
5. **Strengths** — Rigorous methodology, comprehensive search, etc.
6. **Limitations** — Number of studies, study quality, potential biases, language restriction
7. **Implications for practice** — Clinical or policy relevance
8. **Implications for research** — What gaps remain

Be balanced and scientifically conservative. Do not overstate conclusions.

CLINICAL INTERPRETATION RULES:
- The Discussion must read like a clinical meta-analysis discussion, not a description of how the manuscript was produced.
- Interpret the pooled result for readers: magnitude and direction of effect, uncertainty, baseline risk, absolute risk translation, endpoint components, benefit-harm balance, applicability, implementation, monitoring, and certainty.
- For composite or time-to-event outcomes, explain which clinical events matter and how follow-up, censoring, and event definitions affect interpretation.
- Discuss safety, adverse events, patient preferences, cost/access, and clinical follow-up when relevant.
- Do not make process transparency, source audit files, extraction rows, calculation files, or traceability the main meaning of the study. Those details belong in Methods, supplementary material, or audit appendices.
- If source audit or traceability is mentioned at all, keep it brief and subordinate to clinical interpretation.

DISCUSSION CONCISION RULES:
- Target 8-14 paragraphs, not a long checklist of loosely related clinical comments.
- Use one paragraph per clinical theme: main result, endpoint meaning, absolute-risk translation, benefit-harm/safety, applicability/subgroups, implementation, certainty/limitations, and future research.
- Do not repeat baseline risk, safety, implementation, endpoint components, or certainty in multiple separate paragraphs after the theme has already been addressed.
- Avoid "strength" paragraphs that mainly praise manuscript consistency, traceability, or auditability; strengths should be methodological or clinical and should not crowd out result interpretation.
- Do not repeat the same broad citation bundle at the end of many paragraphs; cite the most specific source(s) for each claim.

CRITICAL: "纳入" count = {n_studies} (direct eligible RCTs only). Use this number consistently."""

CONCLUSION_PROMPT = """Write a brief Conclusion (100-150 words) for this meta-analysis.

CRITICAL: This review is about: {topic}
You MUST reference the correct drug/intervention and disease/outcome in the conclusion.
Do NOT mention any other drug or disease.

Primary finding: {primary_summary}
Direct eligible RCTs: {n_studies}
Certainty: {certainty}
Key limitation: {key_limitation}

Be concise, avoid repeating the abstract. Focus on actionable implications.

CRITICAL LANGUAGE RULES:
- The Conclusion must be a clinical conclusion for readers, not a note about manuscript generation, source auditing, review packages, AI detection, polishing, or submission preparation.
- FORBIDDEN: "can improve", "is effective", "significantly improves", "可改善", "有效", "显著改善", "证实"
- REQUIRED: "may improve", "evidence is limited", "findings are inconclusive", "可能改善", "证据有限", "结论不确定"
- If ≤2 studies: MUST say "limited evidence" / "证据有限"
- If key statistics missing: MUST say "conclusions are uncertain" / "结论不确定"
- NEVER overstate the certainty of findings
- "纳入研究" count = {n_studies} (direct eligible RCTs only)"""

TABLE1_PROMPT = """Generate Table 1 (Characteristics of Included Studies) as a raw Markdown table.

IMPORTANT: This table ONLY contains studies classified as "direct_eligible_rct".
Studies classified as observational, post-hoc, real-world, systematic review, case report, basic research, or excluded
must NOT appear in this table. They go in separate supplementary tables.

## Direct Eligible RCT Study Data
{studies_json}

## Columns:
| Study | Year | Design | Country | N (I/C) | Population | Intervention | Control | Follow-up | Primary Outcome |

CRITICAL:
- The "Study" column must use "FirstAuthor et al." format (e.g., "Smith et al."), NOT PMID or numeric IDs.
  Extract the first author's last name from the "authors" field.
- Do NOT put PMID, study_id, or any numeric identifier in the Study column.
- Output ONLY the markdown table. Do NOT wrap it in code blocks (no ```markdown or ```).

Keep entries concise. Use standard abbreviations (RCT, NR for not reported, etc.)."""


# ---------------------------------------------------------------------------
# Narrative systematic review prompts (used when meta-analysis is not feasible)
# ---------------------------------------------------------------------------

NARRATIVE_TITLE_PROMPT = """Generate a concise, descriptive title for this narrative systematic review.

Research Question: {research_question}
PICO:
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
Number of direct eligible RCTs: {n_studies}

Format: "[Intervention] for [Outcome] in [Population]: A Systematic Review"
If writing in Chinese, format: "[干预]治疗[人群]中[结局]的系统评价"

CRITICAL RULES:
- MUST include "Systematic Review" (English) or "系统评价" (Chinese)
- Do NOT include "Meta-Analysis" / "Meta分析" / "荟萃分析" / "系统评价与Meta分析"
- Keep it under 25 words."""

NARRATIVE_ABSTRACT_PROMPT = """Write a structured abstract for this narrative systematic review.

## Research Protocol
{protocol_json}

## Key Information
- Direct eligible RCTs: {n_direct_rct}
- Total studies assessed (all types): {total_screened}
- Evidence classification:
{evidence_class_summary}
- Note: Due to insufficient extractable quantitative data from the included studies, quantitative meta-analysis pooling was NOT performed. A narrative synthesis approach was used instead.

## Structure (250-300 words):
**Background:** Brief context and rationale
**Methods:** Databases, inclusion criteria, narrative synthesis methods
**Results:** PRISMA flow summary, main findings from individual studies (describe each or group by direction)
**Conclusions:** Clinical implications, limitations

CRITICAL RULES:
- "纳入RCT" count = {n_direct_rct} ONLY. Do NOT count observational/review/case-report as RCT.
- Use EXACT numbers from the data provided. Do NOT fabricate statistics, pooled estimates, or p-values.
- Preserve every individual study's reported effect-measure label exactly (for example OR or HR). Never substitute the protocol's preferred measure.
- For PRISMA flow numbers (records identified, screened, included), use ONLY the numbers from the protocol data.
- When individual studies report no quantitative data, state "no quantitative data reported" — do NOT invent effect sizes.
- Do NOT use "significant" without a specific p-value from the data.
- If fewer than 2 direct RCTs, state "direct evidence is insufficient" / "直接证据不足"."""

NARRATIVE_METHODS_PROMPT = """Write the Methods section for this narrative systematic review.

## Protocol
{protocol_json}

## Search Strategy
- Databases: {databases}
- Search query: {search_query}
- Date of search: {search_date}

## Screening (USE THESE EXACT NUMBERS — do NOT invent different numbers)
- Total records identified: {records_identified}
- After deduplication: {records_dedup}
- Screened (title/abstract): {screened}
- Full-text assessed: {full_text_assessed}
- Direct eligible RCTs: {included}

## Data Extraction Method
Structured extraction of study characteristics and outcome data.
Extracted values were verified against source text with page or section locations recorded when available.

## Risk of Bias Tool
Cochrane Risk of Bias 2 (RoB 2) for randomized controlled trials only.

## Synthesis Method
IMPORTANT: Due to insufficient extractable quantitative data from the included studies,
this review uses a narrative synthesis approach. Study results are described individually
and grouped by direction of effect. No quantitative meta-analysis pooling was performed.

## Structure: Follow PRISMA 2020 checklist items for Methods.
Reference the PRISMA flow diagram (**Figure 1**) when describing the study selection process.
Use ONLY the exact screening numbers provided above (records_identified, records_dedup, screened, etc.).
Do NOT estimate or invent different numbers.
Do NOT claim two independent human reviewers or manual adjudication unless explicit human-review metadata is provided.
Use neutral, publication-style method wording. Do not mention AI, automation, a pipeline, internal files, or the manuscript-generation process.
Do NOT claim prospective registration unless an actual registration identifier is provided in the protocol context.
Write in past tense, formal academic style. 1000-1300 words."""

NARRATIVE_RESULTS_PROMPT = """Write the Results section for this narrative systematic review.

## PRISMA Flow (USE THESE EXACT NUMBERS)
{prisma_json}

## Evidence Classification
{evidence_class_summary}

## Study Characteristics Summary
{study_table}

## Risk of Bias Summary
{rob_summary}

## Individual Study Results
{individual_study_results}

## Citation Map (study → reference number)
{citation_map}

## Writing Instructions:
1. Study selection: reference **Figure 1** (PRISMA flow diagram)
2. Study characteristics: reference **Table 1** (direct eligible RCTs only)
3. Risk of bias: describe risk of bias profile for each study
4. Individual study results: describe each study's main findings using citation numbers (e.g., "Smith 2020 [3]")
5. Synthesis of results: group studies by direction of effect (consistent/inconsistent findings)

CRITICAL RULES:
- "纳入RCT" count = direct_eligible_rct ONLY. Do NOT count observational/review/case-report studies as RCT.
- PRISMA NUMBERS: Use ONLY the exact numbers from the PRISMA Flow data above. Do NOT invent, estimate, or modify
  any screening counts (records identified, deduplicated, screened, full-text assessed, included).
- Do NOT include pooled effect estimates, forest plots, funnel plots, I², τ², sensitivity analysis, or any meta-analysis-specific content
- Do NOT include combined p-values or pooled statistics
- Describe each study's results SEPARATELY
- Preserve each study's reported effect-measure label exactly; never relabel an OR as RR or an HR as RR.
- Do NOT fabricate any numbers not provided above
- Do NOT create pseudo-precise quantitative claims without source data. AVOID phrases like:
  * "approximately X%-Y%" or "ranged from A to B" (unless each value comes from a specific cited study)
  * "mean reduction of X.X points" (unless the exact number is in the data above)
  * "significant improvement / non-significant decrease" (do not use "significant" without a reported p-value)
  * "achieved X.X percentage points" or "decreased by X.X%"
- When quantitative data is NOT available for a finding, use qualitative language instead:
  * "suggested a trend toward improvement" / "提示改善趋势"
  * "findings were consistent in direction" / "结果方向一致"
  * "quantitative comparison was not possible due to heterogeneity in outcome measures"
- Only reference **Figure 1** (PRISMA) and **Table 1**. Do NOT mention Figure 2, 3, 4, 5, etc.

STRICT ANTI-HALLUCINATION RULES:
- Do NOT invent or fabricate exclusion reasons for any study. If a study was excluded, state ONLY what the data above shows
  (e.g., "population did not meet PICO criteria" — NOT "excluded due to type 1 diabetes" unless the data explicitly says so).
- Do NOT fabricate details about study populations, designs, or outcomes that are NOT present in the data above.
- Do NOT describe a study as having "type 1 diabetes patients" or "gestational diabetes" unless the Study Characteristics data
  explicitly states this. Only describe what is actually written in the data.
- The PRISMA flow numbers MUST be internally consistent: if T/A screening included N papers, then exactly N papers went to
  full-text assessment. Do NOT add or subtract papers that are not in the data.
1200-1600 words."""

NARRATIVE_DISCUSSION_PROMPT = """Write the Discussion section for this narrative systematic review.

## Key Findings
{findings_summary}

## Risk of Bias Summary
{rob_summary}

## Direct Eligible RCTs: {n_studies}
## Protocol
{protocol_json}

## Citation Map (study → reference number)
{citation_map}

## Structure (1200-1600 words):
1. **Main findings** — Summarize the direction and consistency of results across studies
2. **Comparison with existing evidence** — How do findings compare with prior reviews/guidelines. When referring to individual included studies, use their citation number from the map above (e.g., "[3]").
3. **Heterogeneity exploration** — Discuss clinical and methodological differences between studies
4. **Certainty of evidence** — Provide a qualitative assessment based on risk of bias and consistency
5. **Strengths** — Rigorous methodology, comprehensive search, etc.
6. **Limitations** — Number of studies, study quality, inability to perform quantitative synthesis
7. **Implications for practice** — Clinical or policy relevance
8. **Implications for research** — What gaps remain, need for studies with reportable effect sizes

CRITICAL RULES:
- "纳入RCT" count = {n_studies} ONLY. Use this consistently throughout. Do NOT use different numbers in different paragraphs.
- This is a narrative systematic review — NO quantitative meta-analysis was performed.
- Do NOT fabricate any statistics, p-values, effect sizes, or confidence intervals not provided above.
- Do NOT create pseudo-precise quantitative claims. AVOID phrases like:
  * "approximately X%-Y%" or "ranged from A to B" (unless each value comes from a specific cited study)
  * "mean reduction of X.X points" (unless the exact number is provided above)
  * "significant improvement / significant decrease" (do NOT use "significant" without a reported p-value)
  * "achieved X.X percentage points" or "decreased by X.X%"
- When study results say "未提供具体数据" or "no quantitative data available":
  * ONLY state: "该研究关注此结局但未报告可提取的定量数据，无法形成一致结论"
  * Do NOT summarize cross-study trends for that outcome
  * Do NOT draw clinical effect judgments
- When quantitative data IS available, you may describe it accurately with the exact numbers provided.
- Do NOT mention forest plots, funnel plots, I², τ², Egger's test, sensitivity analysis, leave-one-out, GRADE, or any meta-analysis-specific methods.
- Do NOT mention Figure 2, 3, 4, 5, etc. — only Figure 1 (PRISMA flow diagram) and Table 1 exist.
- Be balanced and scientifically conservative. Do not overstate conclusions.

NARRATIVE MODE LANGUAGE RULES (strict):
- FORBIDDEN: "一致性较好", "效应强度", "显著优于", "significant improvement", "clearly effective", "good consistency"
- REQUIRED: "无法比较", "证据有限", "异质性较大", "cannot be compared", "evidence is limited", "substantial heterogeneity"
- When studies report different outcome types (endpoint vs change), state: "results cannot be directly compared due to different measurement approaches"
- If a study lacks change-from-baseline data, note: "cannot be used for effect size comparison"
- NEVER claim effectiveness or improvement with certainty
- NEVER make cross-study summaries or consistency judgments
- ONLY describe individual study results separately
- ONLY express uncertainty: "evidence is insufficient" / "证据不充分"
- NEVER explain why results differ without citing a specific study author
- NEVER combine different measurement types in one comparison sentence"""

NARRATIVE_CONCLUSION_PROMPT = """Write a brief Conclusion (100-150 words) for this narrative systematic review.

Key findings: {findings_summary}
Direct eligible RCTs: {n_studies}
Key limitation: {key_limitation}

Be concise, avoid repeating the abstract. Focus on actionable implications.
Note: This review used narrative synthesis, not quantitative meta-analysis.

CRITICAL LANGUAGE RULES:
- "纳入RCT" count = {n_studies}. Use this number ONLY. Do NOT use a different count.
- FORBIDDEN: "一致性较好", "效应强度", "显著优于", "is effective", "can improve", "clearly shows"
- FORBIDDEN: any cross-study summary, consistency judgment, or causal explanation
- FORBIDDEN: "may be due to" / "可能由于" without citing a specific study author
- REQUIRED: "无法比较", "证据有限", "异质性较大", "evidence is limited", "cannot be compared", "findings are inconclusive"
- If ≤2 studies: MUST explicitly state "evidence is extremely limited" / "证据极为有限"
- NEVER claim treatment effectiveness with certainty
- ALWAYS note that conclusions are tentative and require further research
- ONLY describe individual study findings, never aggregate or synthesize"""


# ---------------------------------------------------------------------------
# Meta-analysis statistical constraints
# ---------------------------------------------------------------------------

META_STATISTICAL_CONSTRAINTS = """
Statistical constraints for meta-analysis:
- When k < 10 studies: Do NOT report Egger's test for publication bias (insufficient power). Use visual funnel plot inspection only.
- When k < 3 studies: Do NOT perform subgroup analysis or sensitivity analysis (insufficient studies).
- When I² > 75%: MUST note substantial heterogeneity and consider its impact on pooled estimates.
- Always report: k (number of studies), effect measure, model type (fixed/random), I², τ².
"""


# ---------------------------------------------------------------------------
# Report state injection — single source of truth for all numbers
# ---------------------------------------------------------------------------

REPORT_STATE_INJECTION = """
## VERIFIED REPORT DATA — use EXACTLY these numbers, do NOT invent or change

- Report type: {report_type}
- Direct eligible studies: {n_direct_eligible}
- Analyzable primary outcome studies: {n_analyzable_primary}
- Meta-analysis eligible: {n_meta_eligible}
- Total sample size (direct eligible only): {total_sample_size_or_nr}
- PRISMA flow: {prisma_records_identified} identified → {prisma_after_dedup} after dedup → {prisma_full_text_assessed} full-text assessed → {n_direct_eligible} included
- Data sources: {prisma_source_database} from database search, {prisma_source_user_upload} from user upload
- Search end year: {search_end_year}

CRITICAL RULES:
1. "纳入研究" count = {n_direct_eligible} (direct eligible only). Use this number everywhere.
2. Total N = {total_sample_size_or_nr}. If "NR", write "样本量报告不完整" / "sample size not fully reported".
3. Do NOT use any other number for included studies count.
4. If report_type is "evidence_gap": Do NOT generate "纳入研究基本特征表" or claim "纳入X项RCT". Do NOT generate RoB table. Write "无直接证据" not "低确定性".
5. If report_type is "narrative": Do NOT use meta-analysis terms (pooled effect, I², forest plot).
6. Do NOT write "方向一致", "综合来看", "稳健支持", "总体趋势", "跨研究归纳" in any section.
7. If database records = 0 but user uploads > 0: state "数据库检索未获得可用记录；另有N篇用户上传全文进入评估".
8. Do NOT describe studies with year > {search_end_year} as coming from database search — they are from user upload.
"""


# ---------------------------------------------------------------------------
# Supplementary table prompts
# ---------------------------------------------------------------------------

TABLE2_PROMPT = """Generate Table 2 (Indirect / Supporting Evidence) as a raw Markdown table.

This table contains studies classified as indirect evidence, observational, real-world evidence, or post-hoc/secondary analysis.

## Indirect / Supporting Evidence Data
{studies_json}

## Columns:
| Study | Year | Design | Population | Intervention | Reported Outcomes | Relevance |

CRITICAL:
- The "Study" column must use "FirstAuthor et al." format (e.g., "Smith et al.").
- Do NOT put PMID, study_id, or any numeric identifier in the Study column.
- Output ONLY the markdown table. Do NOT wrap it in code blocks.
- Keep entries concise. Use standard abbreviations (NR for not reported, etc.)."""


TABLE3_PROMPT = """Generate Table 3 (Excluded Studies) as a summary Markdown table.

This table lists studies that were excluded from the main analysis due to design or data issues.

## Excluded Studies Data
{studies_json}

## Columns:
| Study | Year | Reason for Exclusion |

CRITICAL:
- The "Study" column must use "FirstAuthor et al." format.
- Output ONLY the markdown table. Do NOT wrap it in code blocks.
- Keep exclusion reasons concise and specific."""
