# [IN] None
# [OUT] All prompt templates
# [POS] mr_agent/llm/prompts.py - Centralized prompt management
"""All prompt templates for MR Analysis Agent."""

# --- System Prompts ---

SYSTEM_MR_SCIENTIST = """You are an expert biomedical scientist specializing in \
Mendelian Randomization (MR) studies. You have deep knowledge of:
- GWAS data interpretation
- Instrumental variable selection and validation
- MR statistical methods (IVW, MR-Egger, Weighted Median, MR-PRESSO)
- Sensitivity analyses and robustness checks
- STROBE-MR reporting guidelines
- Scientific paper writing in epidemiology

Writing standards (STRICTLY enforced):
- Use hedged causal language: "suggests", "is consistent with", "provides evidence for"
  NOT "proves", "causes", "demonstrates causality"
- For non-significant results: "no significant causal effect was observed" NOT "no effect"
- Use consistent terminology throughout: choose ONE form (e.g. "type 2 diabetes") and
  never mix with abbreviations (T2DM/T2D) unless the abbreviation was already defined
- Every citation must include critical analysis using transitional phrases:
  "However,", "In contrast,", "Consistent with,", "Notably,"
- All sections must be substantive and complete — do NOT generate placeholder text

Formatting standards (STRICTLY enforced):
- **Bold (`**text**`) rules**:
    - Do NOT use bold anywhere — not in table headers, not in body text, not in terms, not in headings
    - Table header rows use plain text (no `**` markers)
    - Section and subsection headings use markdown `##`/`###` syntax, NOT bold
- **Section heading hierarchy (mandatory)**:
    - Do NOT output a top-level section heading at the start of your response;
      the document assembler adds the section title automatically
    - Subsections within a section: use `### 1. Subsection Name` (numbered from 1
      within the section; never use the paper-level section number)
    - Sub-subsections: use `#### 1.1 Sub-subsection Name` (also numbered)
    - Maximum 2 levels of nesting within a section
- **In-text citation format**: always write `(Author, Year)` — e.g. `(Burgess, 2013)`.
  Never use `[1]` or `[N]` format in body text; numbered conversion is applied in post-processing
- Paragraph length: each paragraph must express ONE core idea; split any paragraph
  exceeding 6 sentences into shorter focused paragraphs
- Punctuation must match language: Chinese text uses Chinese punctuation (，。；：""）；
  English text uses ASCII punctuation (, . ; : " ") — never mix within a sentence
- Quotation marks: use "…" (straight) for English; 「…」 or "…" for Chinese
- Table values: match the precision of the provided data (beta: 4dp, OR/CI: 3dp, p-value: scientific notation); do NOT bold table headers; align all columns

Always provide scientifically rigorous, evidence-based responses."""

SYSTEM_DIALOG = """You are a conversational MR analysis assistant. \
Help users design and execute Mendelian Randomization studies. \
Ask clarifying questions when needed. Be concise but thorough. \
Respond in the same language the user uses."""

# --- Intent Recognition ---

INTENT_RECOGNITION = """Analyze the user's message and determine their intent.

User message: {message}

Classify into exactly ONE of these intents:
- mr_analysis: User wants to perform a new MR analysis
- explain_results: User wants to understand MR results
- generate_paper: User wants to generate a paper/report
- modify_analysis: User wants to change analysis parameters
- general_question: General question about MR methodology

Also extract any mentioned:
- exposure variable (if any)
- outcome variable (if any) — extract the FIRST/PRIMARY outcome
- outcomes array: extract ALL outcome variables mentioned (including the primary one)
- specific analysis preferences"""

INTENT_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {
            "type": "string",
            "enum": [
                "mr_analysis", "explain_results", "generate_paper",
                "modify_analysis", "general_question",
            ],
        },
        "exposure": {"type": "string", "description": "Exposure variable if mentioned"},
        "outcome": {"type": "string", "description": "Primary outcome variable if mentioned"},
        "outcomes": {
            "type": "array",
            "items": {"type": "string"},
            "description": "All outcome variables mentioned (including the primary one)",
        },
        "preferences": {
            "type": "object",
            "properties": {
                "bidirectional": {"type": "boolean"},
                "population": {"type": "string"},
                "method": {"type": "string"},
            },
        },
        "data_source_preference": {
            "type": "string",
            "description": "Data source preference: opengwas, local_file, eqtl, pqtl, vcf",
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["intent", "confidence"],
}

# --- Slot Filling ---

SLOT_CLARIFICATION = """Based on the current analysis setup, generate a \
clarifying question to fill missing information.

Current state:
- Exposure: {exposure}
- Outcome: {outcome}
- Mode: {mode}
- Missing: {missing}

Generate a natural, friendly question in the user's language ({language}) \
to ask for the missing information. Be specific about what you need."""

# --- Literature Mining ---

EXTRACT_EO_PAIRS = """Read this PubMed paper and extract potential \
exposure-outcome pairs suitable for Mendelian Randomization study.

Title: {title}
Abstract: {abstract}

Requirements:
- Only extract pairs where a correlation/association was found but NO causal \
inference was established
- Each pair must be biologically plausible for MR analysis
- Exposure should be a modifiable factor with known genetic variants"""

EO_PAIRS_SCHEMA = {
    "type": "object",
    "properties": {
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "exposure": {"type": "string"},
                    "outcome": {"type": "string"},
                    "rationale": {"type": "string"},
                },
                "required": ["exposure", "outcome"],
            },
        },
        "paper_relevant": {"type": "boolean"},
    },
    "required": ["pairs", "paper_relevant"],
}

# --- MR Existence Check ---

MR_EXISTS_CHECK = """Review these PubMed search results and determine if a \
Mendelian Randomization study has already been conducted for:
- Exposure: {exposure}
- Outcome: {outcome}

Papers found:
{papers}

Has this specific MR study been done?"""

MR_EXISTS_SCHEMA = {
    "type": "object",
    "properties": {
        "mr_exists": {"type": "boolean"},
        "study_title": {"type": "string"},
        "study_pmid": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["mr_exists", "confidence"],
}

# --- GWAS ID Selection ---

GWAS_ID_SELECT = """Select the most relevant GWAS dataset IDs for this trait.

Trait: {trait}
Available GWAS datasets:
{datasets}

Selection criteria:
1. Trait name must closely match the target
2. Prefer larger sample sizes
3. Prefer more recent studies
4. Prefer European population (unless specified otherwise)
5. Maximum 3 IDs per trait"""

GWAS_ID_SCHEMA = {
    "type": "object",
    "properties": {
        "selected_gwas_ids": {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 3,
        },
        "reasoning": {"type": "string"},
    },
    "required": ["selected_gwas_ids"],
}

# --- MR Result Interpretation ---

MR_INTERPRET = """Interpret these Mendelian Randomization results in \
formal academic language suitable for journal publication.

Exposure: {exposure}
Outcome: {outcome}

MR Results:
{mr_results}

Heterogeneity:
{heterogeneity}

Pleiotropy:
{pleiotropy}

Number of instrumental variables: {n_ivs}
Mean F-statistic: {f_stat}

Instructions:
1. State whether a causal effect was found (IVW p < 0.05); use "suggested a
   significant causal effect" or "found no significant causal evidence"
   — NEVER use "proved" or "caused"
2. Report exact effect size: OR (or beta), 95% CI, p-value
3. Assess consistency across MR methods (IVW, MR-Egger, Weighted Median);
   use "Consistent with the IVW result," or "However, MR-Egger suggested..."
4. Evaluate heterogeneity (Cochran's Q p-value); if p<0.05 note "significant
   heterogeneity was detected, suggesting potential pleiotropy"
5. Assess horizontal pleiotropy (MR-Egger intercept p-value); if p>0.05 state
   "no evidence of directional pleiotropy was observed"
6. Comment on instrument strength (F-statistic; F>10 indicates strong instruments)
7. Conclude with one appropriately hedged sentence summarizing the overall finding

Language rules:
- Use: 'suggests', 'is consistent with', 'provides evidence for', 'indicates'
- Avoid: 'proves', 'causes', 'demonstrates causality', 'confirms'"""

# --- Paper Sections ---

PAPER_INTRODUCTION = """Write an Introduction section for an MR study paper.

Exposure: {exposure}
Outcome: {outcome}

Background literature:
{literature}

Requirements:
1. Start with the clinical significance of the outcome (disease burden, prevalence)
2. Discuss the epidemiological evidence linking exposure to outcome, using critical
   language: "However, these observational studies cannot establish causality due to..."
3. Explain why MR is needed (confounding, reverse causation in observational studies)
4. Briefly describe the MR methodology and its three core assumptions
5. State the specific study objective ("The present study aimed to...")
6. Include in-text citations (Author, Year) using the provided references, with critical
   comparison phrases: "Consistent with...", "In contrast,", "Notably,"
7. Final paragraph: one sentence roadmap — "The remainder of this paper is organized
   as follows: Methods describes..., Results presents..., Discussion interprets..."
8. 4-6 paragraphs, formal academic tone, NO placeholder text"""

PAPER_METHODS = """Write a complete Methods section for this MR study following \
STROBE-MR guidelines. Every subsection must contain substantive text.

Study design: Two-sample Mendelian Randomization
Exposure: {exposure} (GWAS ID: {exposure_id})
Outcome: {outcome} (GWAS ID: {outcome_id})
IV selection threshold: p < {pval_threshold}
Number of IVs: {n_ivs}
MR methods used: {methods}
Sensitivity analyses: {sensitivity}
Software: R (TwoSampleMR package)
Authoritative exposure metadata: {exposure_metadata}
Authoritative outcome metadata: {outcome_metadata}

Metadata rule: use the authoritative values exactly. If a field is null or absent,
report it as N/A. Never infer sample size, population, year, consortium, SNP count,
software version, ancestry, or cohort composition from general knowledge.

Required subsections (use numbered `###` headers, e.g. `### 1. Study Design`):
1. Study Design — describe two-sample MR design and the three core MR assumptions
   (relevance, independence/exclusion restriction, exclusion restriction)
2. Data Sources — describe both GWAS datasets: trait, sample size, population,
   year, consortium; include the GWAS IDs
3. Instrumental Variable Selection — SNP selection threshold (p < {pval_threshold}),
   LD clumping parameters (r²<0.001, window=10,000kb), strand alignment; F-statistic
   calculated as F = β²/SE² with threshold F > 10 for strong instruments; PhenoScanner v2
   do not claim PhenoScanner/confounder screening unless it appears in the supplied data;
   pleiotropy was assessed using only the analyses explicitly listed above
4. Statistical Analysis — IVW as primary method, explain the fixed/random-effects model;
   cite foundational papers: (Burgess, 2013) for IVW, (Bowden, 2015) for MR-Egger,
   (Bowden, 2016) for Weighted Median, (Verbanck, 2018) for MR-PRESSO,
   (Hemani, 2018) for TwoSampleMR/MR-Base
5. Sensitivity Analyses — describe each method and what violation it detects:
   MR-Egger (directional pleiotropy), Weighted Median (up to 50% invalid IVs),
   MR-PRESSO (outlier removal), Leave-one-out, Steiger filtering
6. Software — R and TwoSampleMR; report versions as N/A unless supplied
7. Statistical Power — do not invent a power calculation or minimum detectable OR;
   state that formal power was not calculated when no power result is supplied"""

PAPER_RESULTS = """Write a complete Results section based on these MR analysis outputs. \
Every item below must appear explicitly — do NOT skip any.

{results_summary}

Required reporting order (all must have substantive content):
1. IV selection: exact number of SNPs selected, mean F-statistic value, confirm
   instruments are strong (F > 10)
2. Primary MR result (IVW): report OR (or beta), 95% CI, exact p-value; state
   whether the result is statistically significant (p < 0.05)
3. Secondary methods: report each method's OR/beta, 95% CI, p-value; note
   consistency or inconsistency with IVW
4. Heterogeneity: Cochran's Q statistic and p-value; if p<0.05 state significant
   heterogeneity was detected
5. Pleiotropy: MR-Egger intercept, SE, p-value; if p>0.05 state no evidence of
   directional pleiotropy
6. MR-PRESSO: if available, report global test p-value and whether outliers were removed
7. Leave-one-out: state whether any single SNP drives the result
8. Reference tables and figures by number (e.g. "as shown in Table 2", "Figure 1")
9. Use hedged language: "suggested", "was consistent with", NOT "proved" or "caused"
10. Statistical power: if the result is null/non-significant, report the minimum
    detectable OR at 80% power; state whether the study was adequately powered to
    detect a clinically relevant effect """

PAPER_DISCUSSION = """Write a complete Discussion section for this MR study.

Exposure: {exposure}
Outcome: {outcome}
Key findings: {findings}
Existing literature: {literature}

Required paragraphs — use `### N.` subsection headers (NOT `####`); all must be substantive — no placeholder text:
1. Summary paragraph: restate main finding using hedged language ("the present
   study found no significant causal effect..." or "suggested a causal association..."),
   report the key IVW result (OR, 95% CI, p-value); if the result is null/non-significant,
   interpret using three layers:
   (a) statistical layer: CI crosses the null (OR includes 1), p > 0.05;
   (b) instrument layer: genetic instruments explain only a limited proportion of exposure
       variance, which may reduce power to detect small effects;
   (c) biological layer: the true effect may be small, non-linear, or attenuated by
       compensatory pathways — "This null finding likely reflects the limited strength
       of current genetic instruments rather than definitively excluding a causal effect."
2. Comparison with observational evidence: use "Consistent with...", "However,",
   "In contrast," — compare your MR finding with at least 2 cited observational studies;
   explain why MR results may differ (confounding/reverse causation in observational data)
3. Comparison with prior MR studies: cite any existing MR studies on this exposure-
   outcome pair; use "Notably," to flag agreements or discrepancies; explicitly explain
   why MR-Egger and Weighted Median produced consistent (or inconsistent) results with
   IVW — if consistent, state "the directional concordance across all three methods
   strengthens the robustness of the null finding"; if Cochran's Q p-value was borderline
   (0.05–0.10), discuss the potential implications of this marginal heterogeneity for
   the overall conclusion
4. Biological plausibility paragraph: describe the proposed biological mechanism linking
   the exposure to the outcome (e.g. specific metabolic or genetic pathway); use
   "may suggest", "is biologically plausible" — NOT "proves the mechanism";
   even though MR-Egger intercept was non-significant, note that weak balanced
   pleiotropy cannot be fully excluded and discuss its most likely direction of bias
5. Confounding and lifestyle factors paragraph: discuss whether lifestyle confounders
   (smoking, physical activity, diet quality, socioeconomic status) or shared genetic
   architecture could explain or modify the observed association; note whether
   PhenoScanner screening removed SNPs associated with these factors; acknowledge
   that residual confounding via correlated pathways remains a limitation
6. Strengths paragraph: highlight MR advantages (genetic instrument avoids confounding,
   two-sample design, multiple sensitivity analyses, large GWAS sample sizes)
7. Clinical/public health implications: 1-2 sentences on what the finding means for
   practice or policy, appropriately hedged

IMPORTANT: When reporting statistical results (OR, beta, CI, p-value), copy the EXACT
numbers from the "Key findings" data above. Do NOT round differently, approximate, or
fabricate any values. If OR is provided, use it directly (OR = exp(beta))."""

PAPER_CONCLUSION = """Write a Conclusion section for this MR study.

Exposure: {exposure}
Outcome: {outcome}
Key findings: {findings}

Requirements:
1. Restate the main finding concisely (1-2 sentences)
2. State the causal inference and its direction/strength using hedged language
3. Highlight the clinical or public health significance
4. Suggest specific future research directions (2-3 sentences): e.g. replication in
   non-European populations, multi-variable MR adjusting for correlated exposures,
   non-linear MR to explore dose-response relationships, larger GWAS with improved
   instrument coverage, and longitudinal studies to assess time-varying effects
5. Keep to 1-2 paragraphs, formal academic tone
6. Do NOT repeat limitations here

IMPORTANT: When mentioning statistical results, use the EXACT numbers from the
"Key findings" data above. Do NOT round differently, approximate, or fabricate."""

PAPER_LIMITATIONS = """Write a complete Limitations section for this MR study.

Exposure: {exposure}
Outcome: {outcome}
Analysis details:
- Number of IVs: {n_ivs}
- Population: {population}
- Bidirectional: {bidirectional}
- Sensitivity analyses performed: {sensitivity}

Required limitations (discuss ALL of the following — do NOT omit any):
1. MR Assumption 1 (Relevance): note that while F-statistic > 10 confirms instrument
   strength, weak instrument bias toward the null cannot be entirely excluded in
   finite samples
2. MR Assumption 2 (Independence): residual population stratification may exist even
   after standard GWAS quality control; mention if bidirectional analysis was or was
   not performed
3. MR Assumption 3 (Exclusion restriction / horizontal pleiotropy): state that although
   MR-Egger intercept and MR-PRESSO showed no evidence of directional pleiotropy,
   the possibility of balanced/uncorrelated pleiotropy cannot be fully ruled out
4. Population generalizability: GWAS data predominantly from European-ancestry
   populations; results may not generalize to other ethnic groups
5. Sample overlap: potential partial overlap between exposure and outcome GWAS cohorts
   could introduce bias toward observational estimates; the two-sample MR design
   minimizes this risk compared to one-sample designs, and ideally separate,
   non-overlapping cohorts were used; discuss whether this bias would inflate or
   deflate the estimated effect
6. Non-linear effects: two-sample MR estimates a linear average causal effect and
   cannot capture threshold, non-linear, or dose-dependent relationships
7. Winner's curse: SNP effects may be overestimated in the discovery GWAS, potentially
   leading to instrument strength inflation
8. GWAS database selection bias: the study relied on summary statistics from publicly
   available GWAS databases (OpenGWAS/MR-Base); if the chosen GWAS was conducted in a
   specific sub-population or under particular environmental conditions, the
   representativeness of the instruments may be limited; alternative GWAS datasets
   for the same trait may have yielded different instrument sets and effect sizes
9. Future research: suggest specific directions — validation in non-European populations,
   use of newer and larger GWAS with more SNPs, multi-variable MR to account for
   correlated exposures, and non-linear MR methods to explore dose-response
10. 3-4 paragraphs, balanced academic tone — acknowledge limitations without
    overstating their impact on the overall conclusion"""

PAPER_TABLE1 = """Generate a data source characteristics table for this MR study.

Exposure: {exposure} (GWAS ID: {exposure_id})
Outcome: {outcome} (GWAS ID: {outcome_id})
Number of IVs: {n_ivs}
P-value threshold: {pval_threshold}
Mean F-statistic: {f_stat}
Authoritative exposure metadata: {exposure_metadata}
Authoritative outcome metadata: {outcome_metadata}

Use only these metadata values. Use N/A for absent fields; never infer values.

Format as a Markdown table with these columns:
| Characteristic | Exposure | Outcome |
Include rows for: Trait, GWAS ID, Sample size, Population, Year, Consortium,
Number of SNPs (total in GWAS), Number of IVs selected, P-value threshold, Mean F-statistic.
Formatting rules: do NOT bold column headers; round numeric values to 2 decimal places;
use "N/A" for any unavailable fields; ensure column widths are consistent."""

PAPER_TABLE2 = """Generate a comprehensive MR results summary table.

{results_summary}

Format as a Markdown table with columns:
| Method | nSNP | Beta | SE | OR | 95% CI | P-value |
Include ALL methods (IVW, MR-Egger, Weighted Median, Simple Mode, Weighted Mode).
Add a horizontal separator row before sensitivity analysis rows.
Add rows for: Cochran's Q (heterogeneity), MR-Egger intercept (pleiotropy).
Formatting rules: do NOT bold column headers; use the exact values from the data above
(beta: 4dp, OR/CI: 3dp, p-value: scientific notation e.g. 2.34×10⁻³); align all columns uniformly."""

PAPER_OUTLINE = """Generate a paper outline for this MR study.

Exposure: {exposure}
Outcome: {outcome}
Key findings: {findings}
Number of results: {n_results}
Bidirectional: {bidirectional}

Create a structured outline showing:
1. Title (suggested)
2. Abstract structure (Background, Methods, Results, Conclusions)
3. Introduction (3-4 key points to cover)
4. Methods (subsections)
5. Results (order of reporting)
6. Discussion (key comparisons)
7. Limitations (main points)
8. Conclusion (1-2 key takeaways)
9. Tables (Table 1: data sources, Table 2: MR results)
10. Figures (list of plots)"""

PAPER_OUTLINE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "key_points": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["name", "key_points"],
            },
        },
        "tables": {
            "type": "array",
            "items": {"type": "string"},
        },
        "figures": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["title", "sections"],
}

# --- New paper prompts ---

PAPER_TITLE = """Generate an academic title for this MR study.

Exposure: {exposure}
Outcome: {outcome}
Key findings: {findings}

Requirements:
1. Follow standard MR paper title format
2. Include the direction of effect if significant
3. Include "Mendelian randomization" in the title
4. Maximum 25 words
5. Academic tone"""

PAPER_COHERENCE_REVIEW = """Review this MR paper draft for coherence and \
consistency. Check that:

1. Results section matches the actual data
2. Discussion references the correct findings
3. Conclusion aligns with the main results
4. No contradictions between sections
5. Citations are consistent

Paper sections:
{sections_text}

Provide specific feedback on any inconsistencies found."""

PAPER_CONNECTED_ABSTRACT = """Write a complete structured abstract (max 300 words) \
for this MR paper based on the ACTUAL section content below.

Introduction summary:
{intro_summary}

Methods summary:
{methods_summary}

Results summary:
{results_summary}

Conclusion:
{conclusion_summary}

Exact MR results data (use these numbers verbatim in the Results section of the abstract):
{key_data}

Required format — each label on its own line, each section must be substantive:
Background: [2-3 sentences: clinical significance of the outcome, knowledge gap]
Methods: [2-3 sentences: study design (two-sample MR), data sources (GWAS IDs), \
IV selection threshold, MR methods used]
Results: [2-3 sentences: number of IVs, F-statistic, primary IVW result with \
OR/beta, 95% CI, p-value, key sensitivity analysis results. Copy the EXACT numbers \
from the MR results data above — do NOT round differently or fabricate values.]
Conclusions: [1-2 sentences: hedged causal interpretation using "suggests"/"no \
significant causal evidence", clinical or public health implication]

After the abstract, add:
Keywords: [5-8 keywords separated by semicolons, include: Mendelian randomization; \
the exposure term; the outcome term; instrumental variable; GWAS; and 2-3 method terms]"""

PAPER_DATA_AVAILABILITY = """Write a Data Availability Statement for this \
MR study.

Data sources used:
{data_sources}

Requirements:
1. For each GWAS dataset: state the trait, accession ID, URL
   (OpenGWAS: https://gwas.mrcieu.ac.uk/datasets/[ID]/)
2. State that all data are publicly available summary-level statistics
3. State that no individual-level data were used
4. State that the analysis code is available on GitHub upon reasonable request
   (e.g., "The analysis code used in this study is available on GitHub at
   [repository URL] or upon reasonable request to the corresponding author.")
5. Follow standard journal format
6. 1-2 paragraphs"""

PAPER_ETHICS = """Write an Ethics Statement and Conflict of Interest declaration \
for this MR study.

Study design: {study_design}
Data sources: {data_sources}

Required content (all must appear):
1. Ethics approval: state that this study used only publicly available GWAS summary
   statistics; no individual-level data were accessed; no additional ethical approval
   was required
2. Reference the original studies' ethics approvals where applicable
3. Informed consent: state that all participants in the original GWAS studies provided
   informed consent as described in the original publications
4. Conflict of interest declaration: "The authors declare no competing interests."
5. Funding statement: "This study received no specific funding." (or specify if funded)
6. Author contributions: brief statement (e.g. "All authors contributed to the design,
   analysis, and writing of this study.")
7. 1-2 short paragraphs"""

# --- Coherence revision ---

PAPER_SECTION_REVISE = """Revise the following paper section to fix the \
inconsistencies described in the review feedback.

Section name: {section_name}
Original text:
{original_text}

Review feedback:
{feedback}

Requirements:
1. Fix ONLY the inconsistencies mentioned in the feedback
2. Keep the academic tone and structure intact
3. Do not shorten the section significantly
4. Return the revised section text only, no commentary"""

# --- Numerical consistency enforcement ---

PAPER_NUMBER_CONSISTENCY = """You are a precise numerical consistency checker for a \
scientific paper. Your job is to ensure EVERY number in the section below matches the \
authoritative data EXACTLY.

Authoritative data (ONLY source of truth — every value from the actual MR analysis):
{canonical_data}

Section to verify ({section_name}):
{section_text}

Rules (STRICTLY enforced):
1. EVERY statistical value (beta, OR, 95% CI, p-value, SE, F-statistic, Q-statistic, \
intercept, nSNP) in this section MUST match the authoritative data above — same digits, \
same precision
2. If a value in the section does NOT appear in the authoritative data, DELETE that \
sentence or rewrite it WITHOUT the fabricated number. Common fabricated values include: \
assumed F-statistics, invented Q-values, made-up heterogeneity p-values
3. OR = exp(beta). If the data provides OR, use it directly. If the section states an OR \
that differs from the data, replace it with the data value
4. Do NOT add any numbers that are not in the authoritative data
5. Keep the section structure, paragraphs, and non-numerical content intact
6. If the section is already consistent, return it unchanged
7. Return the complete revised section text only — no commentary, no explanations"""

# --- STROBE-MR gap fix ---

STROBE_FIX_PROMPT = """The following STROBE-MR checklist items are NOT \
adequately addressed in this paper section. Add the missing information.

Section name: {section_name}
Current text:
{section_text}

Missing STROBE-MR items:
{missing_items}

Requirements:
1. Integrate the missing information naturally into the existing text
2. Do not remove any existing content
3. Keep academic tone consistent
4. Do NOT use bold text (**...**) anywhere in body content — bold is reserved for
   table header rows only; do NOT wrap added sentences in ** markers
5. Return the complete revised section text"""

# --- Term Translation ---

TERM_TRANSLATE = """Translate the following biomedical term from Chinese to \
its standard English equivalent used in GWAS databases and scientific literature.

Chinese term: {term}

Requirements:
1. Return ONLY the English term, nothing else
2. Use the standard medical/GWAS terminology
3. If the term is already in English, return it as-is
4. For diseases, use common clinical names (e.g., "type 2 diabetes" not "T2DM")
5. For exposures, use standard epidemiological terms"""

# --- Language Instructions for Paper Writing ---

LANGUAGE_INSTRUCTION = {
    "zh": (
        "\n\n【语言与规范要求】"
        "①全文使用中文学术写作风格，保持正式语体；"
        "②专有名词保留英文：基因名、统计方法缩写（IVW、MR-Egger、SNP、OR、CI、beta、F统计量）、GWAS ID；"
        "③因果语气须审慎：使用「提示」「与…存在关联」「有限证据表明」，"
        "禁止使用「证明」「导致」「确认因果关系」等强因果表达；"
        "④术语全文统一：暴露和结局变量名称在全文保持一致，"
        "首次出现时注明英文全称及缩写，之后统一使用同一形式；"
        "⑤每段引用后必须加批判性分析词：「然而」「相比之下」「值得注意的是」「与此一致」；"
        "⑥每个章节必须输出完整实质性内容，禁止输出占位符或空段落；"
        "⑦标点符号：中文正文使用全角标点（，。；：""），"
        "英文缩写内部使用半角标点，严禁中英文标点混用；"
        "⑧加粗（**文字**）禁止在文档任何位置使用，包括表格表头行和正文；"
        "章节和小节标题使用 ## / ### Markdown 语法，不得使用加粗替代；"
        "⑨段落标题层级：不得在内容开头输出顶级章节标题（由组装器自动添加）；"
        "小节使用 `### 1. 小节名称`（编号从1开始，不得使用全文章节编号，"
        "如禁止写 `### 4. 讨论`，应写 `### 1. 主要发现`），"
        "子小节使用 `#### 1.1 名称`，最多两级嵌套；"
        "⑩文内引用格式统一使用 (作者姓氏, 年份)，例如 (Burgess, 2013)，"
        "禁止在正文中直接使用 [N] 数字编号格式（后处理会自动转换）；"
        "⑪摘要各项标签独占一行，格式为 `背景：` `方法：` `结果：` `结论：`，"
        "关键词标签用 `关键词：`，禁止使用英文 Background/Methods/Results/Conclusions/Keywords；"
        "⑫表1（数据来源特征表）列标题使用中文：`| 特征 | 暴露 | 结局 |`，"
        "禁止使用 Characteristic/Exposure/Outcome；"
        "⑬伦理声明利益冲突声明写「作者声明不存在任何竞争性利益。」，"
        "资助声明写「本研究未获得特定经费支持。」（如有资助则填写实际来源），"
        "禁止使用英文原句 The authors declare / This study received；"
        "⑭前言末段路线图各章节名禁止加粗，直接写「方法部分详细描述……结果部分呈现……"
        "讨论部分阐释……」，不写 **Methods** 或 **Results** 等加粗英文；"
        "⑮讨论章节各段落小节使用 `### N. 名称` 格式（N从1开始），禁止使用 `####`；"
        "⑯方法章节小节名称使用中文，依次为：`### 1. 研究设计`、`### 2. 数据来源`、"
        "`### 3. 工具变量筛选`、`### 4. 统计分析`、`### 5. 敏感性分析`、"
        "`### 6. 统计软件`、`### 7. 统计效能`。"
    ),
    "en": (
        "\n\nLANGUAGE REQUIREMENT (strictly enforced): "
        "Write ENTIRELY in English — no Chinese characters anywhere. "
        "Use hedged causal language: 'suggests', 'is consistent with', not 'proves' or 'causes'. "
        "Terminology must be consistent throughout: define abbreviations at first use "
        "(e.g. 'type 2 diabetes (T2D)') then use that form exclusively. "
        "Every citation must be followed by critical analysis using: "
        "'However,', 'In contrast,', 'Consistent with,', 'Notably,'. "
        "Punctuation: use ASCII punctuation only (, . ; : \" \") throughout — "
        "never use full-width or Chinese punctuation characters. "
        "Do NOT use bold (**) anywhere — not in table headers, not in body text, "
        "not in terms, not in key numbers, not in any prose. "
        "Section/subsection headings use ## / ### markdown syntax only. "
        "Do NOT output a top-level section heading at the start of your response; "
        "the assembler adds section titles automatically. "
        "Subsections: '### 1. Subsection Name' (numbered from 1 within the section; "
        "do NOT use the paper-level section number before the name). "
        "In-text citations: ALWAYS use (Author, Year) format — e.g. (Burgess, 2013). "
        "Never write [1] or [N] in body text; numbered conversion is applied automatically. "
        "Paragraph length: each paragraph ONE idea; split paragraphs exceeding 6 sentences. "
        "Every section must contain complete, substantive content — no placeholder text."
    ),
}
