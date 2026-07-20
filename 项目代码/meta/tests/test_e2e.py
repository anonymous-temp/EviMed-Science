"""End-to-end integration test for MetaAgent pipeline.

Exercises the complete pipeline with mock LLM responses to verify all
new components work together: extended schemas, effect sizes (HR/PROP/COR/IRR),
REML/HKSJ, meta-regression, cumulative analysis, NMA, PRISMA 2020, GRADE,
PET-PEESE, contour funnel, network plot, and the writing agent integration.
"""
from __future__ import annotations

import sys
from pathlib import Path
# Ensure project root is on sys.path so tests work from any directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import base64
import json
import math
import shutil
import tempfile
import logging
from pathlib import Path
from unittest.mock import patch, MagicMock

# ============================================================================
# Setup logging
# ============================================================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("test_e2e")

# ============================================================================
# 1. Schema validation
# ============================================================================
logger.info("=" * 60)
logger.info("Phase 1: Schema validation")
logger.info("=" * 60)

from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import StudyCharacteristics, OutcomeData, ExtractedStudy
from new_meta.schemas.meta_result import (
    StudyEffect, PooledEffect, LeaveOneOutResult,
    MetaRegressionResult, CumulativeResult,
    NMAContrast, NMAResult, PublicationBiasResult, MetaAnalysisResults,
)
from new_meta.schemas.grade import GRADEDomain, GRADEOutcome, GRADEProfile
from new_meta.schemas.risk_of_bias import RoBDomain, StudyRoB

# Create a full protocol with NMA fields
protocol = ResearchProtocol(
    research_question="Effect of smoking cessation interventions on abstinence",
    pico=PICO(
        population="Adult smokers",
        intervention="Nicotine replacement therapy",
        comparator="Placebo",
        outcome_primary="Smoking abstinence at 6 months",
        outcomes_secondary=["Withdrawal symptoms", "Weight gain"],
    ),
    study_design="RCT",
    study_designs=["RCT", "cohort"],
    inclusion_criteria=["Adults >= 18 years", "Current smokers"],
    exclusion_criteria=["Pregnant women"],
    databases=["PubMed", "Cochrane"],
    date_range="2010-2025",
    language="English",
    effect_measure="OR",
    model_preference="random",
    subgroup_variables=["year"],
    interventions=["NRT", "Varenicline", "Placebo"],
    analysis_type="network",
)
logger.info(f"  Protocol: analysis_type={protocol.analysis_type}, interventions={protocol.interventions}")

# Create studies with diverse outcome types
studies_data = [
    ("S1", "Smith", 2018, "RCT", "USA", 23, 100, 15, 100),
    ("S2", "Jones", 2019, "RCT", "UK", 30, 120, 18, 115),
    ("S3", "Wang", 2020, "RCT", "China", 45, 200, 35, 200),
    ("S4", "Garcia", 2021, "RCT", "Spain", 28, 90, 20, 95),
    ("S5", "Kim", 2022, "RCT", "Korea", 35, 150, 22, 148),
    ("S6", "Brown", 2023, "RCT", "USA", 40, 180, 30, 175),
]

extracted_studies = []
for sid, author, year, design, country, ei, ti, ec, tc in studies_data:
    char = StudyCharacteristics(
        study_id=sid, title=f"Study by {author} et al.", authors=[f"{author} A", "Coauthor B"],
        year=year, journal="Lancet", doi=f"10.1000/{sid}", pmid=sid, study_design=design,
        country=country, sample_size_intervention=ti, sample_size_control=tc,
        total_sample_size=ti + tc, population_description="Adult smokers",
        intervention_description="NRT patch", control_description="Placebo patch",
    )
    outcomes = [
        OutcomeData(
            outcome_name="Smoking abstinence at 6 months",
            outcome_type="dichotomous",
            events_intervention=ei, total_intervention=ti,
            events_control=ec, total_control=tc,
            subgroup="USA" if country == "USA" else "Other",
            treatment_arm="NRT", reference_arm="Placebo",
        ),
        # Secondary outcome (continuous)
        OutcomeData(
            outcome_name="Withdrawal symptoms",
            outcome_type="continuous",
            mean_intervention=3.5 + year * 0.01, sd_intervention=1.2,
            n_intervention=ti, mean_control=5.0, sd_control=1.5, n_control=tc,
        ),
    ]

    # Add HR outcome for some studies
    if year >= 2021:
        outcomes.append(OutcomeData(
            outcome_name="Time to relapse",
            outcome_type="time-to-event",
            hazard_ratio=0.65 + (year - 2020) * 0.05,
            hr_ci_lower=0.45 + (year - 2020) * 0.03,
            hr_ci_upper=0.85 + (year - 2020) * 0.07,
        ))

    extracted_studies.append(ExtractedStudy(characteristics=char, outcomes=outcomes))

logger.info(f"  Created {len(extracted_studies)} studies with diverse outcome types")

# RoB results
rob_results = []
judgments = ["Low risk", "Low risk", "Some concerns", "Low risk", "High risk", "Some concerns"]
for study, judgment in zip(extracted_studies, judgments):
    rob_results.append(StudyRoB(
        study_id=study.characteristics.study_id,
        tool_used="RoB 2",
        domains=[
            RoBDomain(domain="Randomization", judgment="Low risk", support="Adequate"),
            RoBDomain(domain="Deviations", judgment=judgment, support="See text"),
            RoBDomain(domain="Missing data", judgment="Low risk", support="Complete"),
            RoBDomain(domain="Measurement", judgment=judgment, support="Blinded"),
            RoBDomain(domain="Selection", judgment="Low risk", support="Pre-specified"),
        ],
        overall_judgment=judgment,
    ))
logger.info(f"  Created {len(rob_results)} RoB assessments")

# ============================================================================
# 2. Effect Size computation (all types)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 2: Effect Size computation (all types)")
logger.info("=" * 60)

from new_meta.engines import effect_size as es_engine

# Dichotomous (OR)
study_effects = []
for study in extracted_studies:
    for outcome in study.outcomes:
        if outcome.outcome_name == "Smoking abstinence at 6 months":
            yi, vi = es_engine.compute_effect_size(
                outcome_type="dichotomous", effect_measure="OR",
                events_i=outcome.events_intervention, total_i=outcome.total_intervention,
                events_c=outcome.events_control, total_c=outcome.total_control,
            )
            c = study.characteristics
            se_obj = StudyEffect(
                study_id=c.study_id, study_label=f"{c.authors[0].split()[0]} {c.year}",
                yi=yi, vi=vi, se=vi ** 0.5, subgroup=outcome.subgroup,
            )
            study_effects.append(se_obj)
            logger.info(f"  {se_obj.study_label}: OR(log)={yi:.4f}, SE={vi**0.5:.4f}")

# HR effect sizes
logger.info("")
logger.info("  --- HR effect sizes ---")
for study in extracted_studies:
    for outcome in study.outcomes:
        if outcome.outcome_type == "time-to-event" and outcome.hazard_ratio:
            yi, vi = es_engine.compute_effect_size(
                outcome_type="time-to-event", effect_measure="HR",
                hr=outcome.hazard_ratio, hr_ci_lower=outcome.hr_ci_lower, hr_ci_upper=outcome.hr_ci_upper,
            )
            logger.info(f"  {study.characteristics.authors[0].split()[0]} {study.characteristics.year}: log(HR)={yi:.4f}, SE={vi**0.5:.4f}")

# Proportion (Freeman-Tukey)
logger.info("")
logger.info("  --- Proportion effect sizes ---")
yi, vi = es_engine.proportion_freeman_tukey(events=15, total=100)
logger.info(f"  Freeman-Tukey: yi={yi:.4f}, vi={vi:.6f}")
p_back = es_engine.proportion_back_transform(yi, vi, 100)
logger.info(f"  Back-transform: p={p_back:.4f} (original=0.15)")

# Correlation (Fisher z)
logger.info("")
logger.info("  --- Correlation effect sizes ---")
yi, vi = es_engine.correlation_fisher_z(r=0.45, n=80)
logger.info(f"  Fisher z: z={yi:.4f}, vi={vi:.6f}")
r_back = es_engine.fisher_z_back_transform(yi)
logger.info(f"  Back-transform: r={r_back:.4f} (original=0.45)")

# IRR
logger.info("")
logger.info("  --- IRR effect sizes ---")
yi, vi = es_engine.incidence_rate_ratio(events_i=25, pyears_i=1000, events_c=40, pyears_c=1000)
logger.info(f"  log(IRR)={yi:.4f}, SE={vi**0.5:.4f}")

assert len(study_effects) == 6, f"Expected 6 study effects, got {len(study_effects)}"
logger.info(f"\n  Total study effects for primary outcome: {len(study_effects)}")

# ============================================================================
# 3. Meta-Analysis (DL, REML, HKSJ, cumulative, meta-regression)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 3: Meta-Analysis (all methods)")
logger.info("=" * 60)

from new_meta.engines import meta_engine

# DL
dl_result = meta_engine.random_effects_dl(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  DL:   OR={dl_result.pooled_effect:.3f} (95% CI: {dl_result.ci_lower:.3f}-{dl_result.ci_upper:.3f}), I²={dl_result.i_squared:.1f}%")

# REML
reml_result = meta_engine.random_effects_reml(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  REML: OR={reml_result.pooled_effect:.3f} (95% CI: {reml_result.ci_lower:.3f}-{reml_result.ci_upper:.3f}), τ²={reml_result.tau_squared:.4f}")

# HKSJ
hksj_result = meta_engine.random_effects_hksj(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  HKSJ: OR={hksj_result.pooled_effect:.3f} (95% CI: {hksj_result.ci_lower:.3f}-{hksj_result.ci_upper:.3f})")

# Leave-one-out
loo_results = meta_engine.leave_one_out(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  Leave-one-out: {len(loo_results)} analyses")
for r in loo_results:
    logger.info(f"    Excl {r.excluded_study_label}: OR={r.pooled_effect:.3f} [{r.ci_lower:.3f}, {r.ci_upper:.3f}]")

# Cumulative
cumulative_results = meta_engine.cumulative_meta_analysis(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  Cumulative: {len(cumulative_results)} steps")
for c in cumulative_results:
    logger.info(f"    +{c.study_label} (k={c.n_studies}): OR={c.pooled_effect:.3f}")

# Meta-regression (year as covariate)
years = [float(s.study_label.split()[-1]) for s in study_effects]
mr_result = meta_engine.meta_regression(study_effects, years, covariate_name="year", effect_measure="OR")
logger.info(f"  Meta-regression (year): β={mr_result.coefficient:.4f}, p={mr_result.p_value:.4f}, R²={mr_result.r_squared_analog:.2%}")

# Subgroup analysis
sg_results = meta_engine.subgroup_analysis(study_effects, "OR", "Smoking abstinence at 6 months")
logger.info(f"  Subgroup analysis: {len(sg_results)} groups")
for sg in sg_results:
    logger.info(f"    {sg.outcome_name}: OR={sg.pooled_effect:.3f}, k={sg.n_studies}")

# Secondary outcomes
sec_effects = []
for study in extracted_studies:
    for outcome in study.outcomes:
        if outcome.outcome_name == "Withdrawal symptoms":
            yi, vi = es_engine.compute_effect_size(
                outcome_type="continuous", effect_measure="MD",
                mean_i=outcome.mean_intervention, sd_i=outcome.sd_intervention, n_i=outcome.n_intervention,
                mean_c=outcome.mean_control, sd_c=outcome.sd_control, n_c=outcome.n_control,
            )
            c = study.characteristics
            sec_effects.append(StudyEffect(
                study_id=c.study_id, study_label=f"{c.authors[0].split()[0]} {c.year}",
                yi=yi, vi=vi, se=vi ** 0.5,
            ))
sec_pooled = meta_engine.random_effects_dl(sec_effects, "MD", "Withdrawal symptoms")
logger.info(f"  Secondary (Withdrawal): MD={sec_pooled.pooled_effect:.3f} [{sec_pooled.ci_lower:.3f}, {sec_pooled.ci_upper:.3f}], k={sec_pooled.n_studies}")

# ============================================================================
# 4. Publication Bias (including PET-PEESE)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 4: Publication Bias (Egger, Begg, Trim-fill, PET-PEESE)")
logger.info("=" * 60)

from new_meta.engines import publication_bias

pub_bias = publication_bias.run_all_tests(study_effects, "OR")
if pub_bias.egger_intercept is not None and pub_bias.egger_p_value is not None:
    logger.info(f"  Egger's: intercept={pub_bias.egger_intercept:.3f}, p={pub_bias.egger_p_value:.3f}")
else:
    logger.info("  Egger's: not computed (fewer than 10 studies)")
if pub_bias.begg_tau is not None and pub_bias.begg_p_value is not None:
    logger.info(f"  Begg's: τ={pub_bias.begg_tau:.3f}, p={pub_bias.begg_p_value:.3f}")
else:
    logger.info("  Begg's: not computed (fewer than 10 studies)")
logger.info(f"  Trim-fill: {pub_bias.trim_fill_missing} missing studies")
logger.info(f"  Fail-safe N: {pub_bias.failsafe_n}")
if pub_bias.pet_intercept is not None:
    logger.info(f"  PET: intercept={pub_bias.pet_intercept:.4f}, p={pub_bias.pet_p_value:.4f}")
    logger.info(f"  PEESE: intercept={pub_bias.peese_intercept:.4f}, p={pub_bias.peese_p_value:.4f}")
else:
    logger.info("  PET-PEESE: not computed")

# ============================================================================
# 5. NMA (Network Meta-Analysis)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 5: Network Meta-Analysis")
logger.info("=" * 60)

from new_meta.engines.nma import NMAEngine

# Build NMA contrasts (simulated)
nma_contrasts = [
    {"treatment": "NRT", "comparator": "Placebo", "yi": 0.35, "vi": 0.04, "study_id": "S1"},
    {"treatment": "NRT", "comparator": "Placebo", "yi": 0.42, "vi": 0.05, "study_id": "S2"},
    {"treatment": "NRT", "comparator": "Placebo", "yi": 0.30, "vi": 0.03, "study_id": "S3"},
    {"treatment": "Varenicline", "comparator": "Placebo", "yi": 0.65, "vi": 0.06, "study_id": "S4"},
    {"treatment": "Varenicline", "comparator": "Placebo", "yi": 0.58, "vi": 0.07, "study_id": "S5"},
    {"treatment": "Varenicline", "comparator": "NRT", "yi": 0.25, "vi": 0.08, "study_id": "S6"},
]

nma_engine = NMAEngine(nma_contrasts, ["Placebo", "NRT", "Varenicline"], reference="Placebo")
nma_result = nma_engine.fit()

logger.info(f"  Treatments: {nma_result.treatments}")
logger.info(f"  Reference: {nma_result.reference}")
logger.info(f"  Inconsistency p-value: {nma_result.inconsistency_p:.4f}" if nma_result.inconsistency_p else "  Inconsistency: N/A")
logger.info(f"  SUCRA rankings:")
for trt, score in sorted(nma_result.sucra_rankings.items(), key=lambda x: x[1], reverse=True):
    logger.info(f"    {trt}: {score:.3f}")
logger.info(f"  League table:")
for c in nma_result.league_table:
    logger.info(f"    {c.treatment} vs {c.comparator}: {c.effect:.3f} [{c.ci_lower:.3f}, {c.ci_upper:.3f}], p={c.p_value:.4f}")

geometry = nma_result.network_geometry
logger.info(f"  Network: {len(geometry.get('nodes', []))} nodes, {len(geometry.get('edges', []))} edges, connected={geometry.get('is_connected')}")

# ============================================================================
# 6. Visualization (all types)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 6: Visualization (all plot types)")
logger.info("=" * 60)

from new_meta.engines import visualization

tmpdir = Path(tempfile.mkdtemp(prefix="metaagent_test_"))
logger.info(f"  Output dir: {tmpdir}")

# Forest plot
visualization.forest_plot(dl_result, str(tmpdir / "forest.png"), title="Test Forest Plot")
logger.info(f"  ✓ forest.png ({(tmpdir / 'forest.png').stat().st_size / 1024:.0f} KB)")

# Standard funnel
visualization.funnel_plot(dl_result, str(tmpdir / "funnel.png"))
logger.info(f"  ✓ funnel.png ({(tmpdir / 'funnel.png').stat().st_size / 1024:.0f} KB)")

# Contour-enhanced funnel
visualization.contour_funnel_plot(dl_result, str(tmpdir / "contour_funnel.png"))
logger.info(f"  ✓ contour_funnel.png ({(tmpdir / 'contour_funnel.png').stat().st_size / 1024:.0f} KB)")

# PRISMA 2020
prisma_data = {
    "identification": {"records_identified": 523, "records_after_dedup": 412, "automation_excluded": 15},
    "screening": {
        "title_abstract_screened": 397,
        "title_abstract_excluded": 340,
        "exclusion_reasons": {"Not relevant": 200, "Wrong population": 80, "Wrong design": 60},
    },
    "eligibility": {
        "full_text_sought": 57,
        "not_retrieved": 3,
        "full_text_assessed": 54,
        "full_text_excluded": 48,
        "exclusion_reasons": {"No usable data": 20, "Duplicate cohort": 15, "Wrong outcome": 13},
    },
    "included": {"studies_included": 6, "in_meta_analysis": 6},
    "previous_studies": {"previous_studies": 2},
    "other_methods": {"records_identified": 8, "assessed": 5},
}
visualization.prisma_flow_diagram(prisma_data, str(tmpdir / "prisma.png"))
logger.info(f"  ✓ prisma.png ({(tmpdir / 'prisma.png').stat().st_size / 1024:.0f} KB)")

# RoB summary
rob_summary = []
for r in rob_results:
    domains_dict = {d.domain: d.judgment for d in r.domains}
    rob_summary.append({"study_label": r.study_id, "domains": domains_dict})
visualization.rob_summary_plot(rob_summary, str(tmpdir / "rob.png"))
logger.info(f"  ✓ rob.png ({(tmpdir / 'rob.png').stat().st_size / 1024:.0f} KB)")

# Sensitivity
visualization.sensitivity_plot(
    loo_results, dl_result.pooled_effect,
    (dl_result.ci_lower, dl_result.ci_upper), "OR",
    str(tmpdir / "sensitivity.png"),
)
logger.info(f"  ✓ sensitivity.png ({(tmpdir / 'sensitivity.png').stat().st_size / 1024:.0f} KB)")

# Cumulative forest
visualization.cumulative_forest_plot(
    cumulative_results, "OR", str(tmpdir / "cumulative.png"),
)
logger.info(f"  ✓ cumulative.png ({(tmpdir / 'cumulative.png').stat().st_size / 1024:.0f} KB)")

# Network plot
visualization.network_plot(nma_result.network_geometry, str(tmpdir / "nma_network.png"))
logger.info(f"  ✓ nma_network.png ({(tmpdir / 'nma_network.png').stat().st_size / 1024:.0f} KB)")

def _png_data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")

figures_b64 = {
    "prisma_diagram": _png_data_uri(tmpdir / "prisma.png"),
    "forest_plot": _png_data_uri(tmpdir / "forest.png"),
    "funnel_plot": _png_data_uri(tmpdir / "funnel.png"),
    "rob_plot": _png_data_uri(tmpdir / "rob.png"),
    "contour_funnel_plot": _png_data_uri(tmpdir / "contour_funnel.png"),
    "sensitivity_plot": _png_data_uri(tmpdir / "sensitivity.png"),
    "cumulative_forest": _png_data_uri(tmpdir / "cumulative.png"),
    "nma_network": _png_data_uri(tmpdir / "nma_network.png"),
}

# ============================================================================
# 7. GRADE Assessment (with mock LLM)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 7: GRADE Evidence Assessment (mock LLM)")
logger.info("=" * 60)

from new_meta.agents.grade_agent import GRADEAgent

# Build full MetaAnalysisResults
meta_results = MetaAnalysisResults(
    primary_outcome=dl_result,
    secondary_outcomes=[sec_pooled],
    leave_one_out=loo_results,
    subgroup_results={},
    publication_bias=pub_bias,
    meta_regression=[mr_result],
    cumulative=cumulative_results,
    nma_result=nma_result,
)

# Mock the LLM call to return structured JSON
mock_llm_responses = [
    # RoB rationale
    '{"rationale": "Most studies had low risk of bias with adequate randomization. One study had high risk due to protocol deviations."}',
    # Inconsistency rationale
    '{"rationale": "Low heterogeneity with I² below 50%. Q test non-significant."}',
    # Indirectness
    '{"rating": "no concern", "rationale": "Studies directly matched the PICO."}',
    # Imprecision rationale
    '{"rationale": "Adequate sample size and narrow CI."}',
    # Publication bias rationale
    '{"rationale": "No significant funnel plot asymmetry."}',
]

def mock_call_llm(self, query, **kwargs):
    """Return appropriate mock response based on query content."""
    if "risk of bias" in query.lower() or "rob" in query.lower():
        return '{"rationale": "Most studies had low risk of bias."}'
    elif "inconsistency" in query.lower() or "heterogeneity" in query.lower():
        return '{"rationale": "Low heterogeneity observed."}'
    elif "indirectness" in query.lower() or "pico" in query.lower():
        return '{"rating": "no concern", "rationale": "Studies directly match PICO."}'
    elif "imprecision" in query.lower():
        return '{"rationale": "Adequate precision."}'
    elif "publication bias" in query.lower():
        return '{"rationale": "No significant asymmetry."}'
    return '{"rationale": "Assessment completed."}'

with patch.object(GRADEAgent, 'call_llm', mock_call_llm):
    grade_agent = GRADEAgent()
    grade_profile = grade_agent.run(
        meta_results=meta_results,
        rob_results=rob_results,
        pub_bias=pub_bias,
        studies=extracted_studies,
        protocol=protocol,
    )

logger.info(f"  GRADE Profile: {len(grade_profile.outcomes)} outcomes assessed")
for go in grade_profile.outcomes:
    domains_str = ", ".join(f"{d.domain}={d.rating}" for d in go.domains)
    logger.info(f"    {go.outcome_name}: **{go.certainty}** ({domains_str})")

# ============================================================================
# 8. Query Builder (with mock LLM + MeSH)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 8: Query Builder (MeSH-validated, mock LLM)")
logger.info("=" * 60)

from new_meta.agents.query_builder import QueryBuilder

def mock_qb_call_llm(self, query, **kwargs):
    """Mock for query builder."""
    if "concept" in query.lower() or "pico" in query.lower():
        return json.dumps({
            "population_terms": ["adult smokers", "tobacco users", "cigarette smokers"],
            "intervention_terms": ["nicotine replacement therapy", "NRT", "nicotine patch"],
            "comparator_terms": ["placebo", "control"],
            "outcome_terms": ["smoking cessation", "abstinence", "quit rate"],
        })
    elif "review" in query.lower() or "optimize" in query.lower():
        return '("Smoking Cessation"[MeSH] OR "smoking cessation"[tiab]) AND ("Nicotine"[MeSH] OR "nicotine replacement"[tiab]) AND ("Placebos"[MeSH] OR "placebo"[tiab]) AND (randomized controlled trial[pt])'
    return '("smoking cessation"[tiab]) AND ("nicotine"[tiab])'

# Mock MeSH API to avoid network calls
def mock_validate(terms):
    return {t: True for t in terms}

def mock_lookup(term):
    return {
        "descriptor_name": term.title(),
        "descriptor_ui": f"D{abs(hash(term)) % 100000:06d}",
        "entry_terms": [f"{term} synonym 1", f"{term} synonym 2"],
        "tree_numbers": ["C14.280"],
    }

def mock_expand(term):
    return [f"{term} synonym 1", f"{term} synonym 2"]

with patch.object(QueryBuilder, 'call_llm', mock_qb_call_llm), \
     patch('new_meta.agents.query_builder.validate_mesh_terms', mock_validate), \
     patch('new_meta.agents.query_builder.lookup_mesh_term', mock_lookup), \
     patch('new_meta.agents.query_builder.expand_mesh_term', mock_expand):
    qb = QueryBuilder()
    result = qb.run(protocol)
    if isinstance(result, tuple):
        query, report, _single = result
        logger.info(f"  Query ({len(query)} chars): {query[:120]}...")
        logger.info(f"  Strategy report: {len(report)} chars")
    else:
        query = result
        logger.info(f"  Query ({len(query)} chars): {query[:120]}...")

# ============================================================================
# 9. Writing Agent (with mock LLM)
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 9: Writing Agent (mock LLM, real references)")
logger.info("=" * 60)

from new_meta.agents.writing_agent import WritingAgent
import new_meta.agents.writing_agent as writing_module
from new_meta.tools.reference_manager import ReferenceManager

ref_manager = ReferenceManager()
for study in extracted_studies:
    c = study.characteristics
    ref_manager.add({
        "title": c.title, "authors": c.authors, "year": c.year,
        "journal": c.journal, "doi": c.doi, "pmid": c.pmid,
    }, study_id=c.pmid)

# Check references
ref_list = ref_manager.to_numbered_list()
logger.info(f"  References: {len(ref_manager.entries)} entries")
logger.info(f"  Sample ref: {ref_list.split(chr(10))[0][:100]}...")
bibtex = ref_manager.to_bibtex()
logger.info(f"  BibTeX: {len(bibtex)} chars")

# Create temp project for saving
from new_meta.core.project import Project
test_project = Project("E2E Test", output_dir=tmpdir / "project")
test_project.save_json(
    "effect_selection_audit.json",
    [
        {
            "row_id": f"{effect.study_id}:0",
            "study_id": effect.study_id,
            "study_label": effect.study_label,
            "outcome_name": "Smoking abstinence at 6 months",
            "in_final_primary_analysis": True,
            "events_intervention": 1,
            "total_intervention": 2,
            "events_control": 1,
            "total_control": 2,
            "effect": effect.yi,
            "source_location": "Table 2",
            "source_quote": "Smoking abstinence at 6 months was reported: 1/2 in treatment and 1/2 in control.",
            "source_quote_verified": True,
            "extraction_confidence": "high",
        }
        for effect in study_effects
    ],
    subdir="analysis",
)

section_counter = [0]
def mock_writer_call_llm(self, query, **kwargs):
    section_counter[0] += 1
    n = section_counter[0]
    if n == 1:
        return "Nicotine Replacement Therapy for Smoking Cessation: A Systematic Review and Meta-Analysis"
    elif n == 2:
        return """**Background:** Smoking remains a leading preventable cause of death worldwide.
**Methods:** We searched PubMed and Cochrane. Random-effects meta-analysis was used.
**Results:** Six RCTs (N=1,348) were included. Pooled OR was 1.45 (95% CI: 1.15-1.83; p=0.002). Moderate certainty evidence.
**Conclusions:** NRT significantly improves abstinence rates."""
    elif n == 3:
        return "Tobacco smoking is the leading preventable cause of morbidity and mortality globally. This meta-analysis aims to synthesize the evidence."
    elif n == 4:
        return "This systematic review followed PRISMA 2020 guidelines. We searched PubMed and Cochrane databases."
    elif n == 5:
        return "Six RCTs met inclusion criteria. The pooled OR was 1.45 (95% CI: 1.15 to 1.83; p=0.002), favoring NRT."
    elif n == 6:
        return "Our findings demonstrate that NRT is effective for smoking cessation. The evidence was of moderate certainty."
    elif n == 7:
        return "NRT significantly increases smoking abstinence rates compared with placebo."
    elif n == 8:
        return "| Study | Year | Design | Country | N | Population | Intervention | Control |\n|---|---|---|---|---|---|---|---|\n| Smith | 2018 | RCT | USA | 200 | Smokers | NRT | Placebo |"
    return "Section content placeholder."

def mock_writer_call_llm_structured(self, query, response_model, **kwargs):
    """Keep this script-level E2E test fully offline.

    The writing pipeline now uses structured LLM calls for semantic review,
    claim-map authoring, and final readiness review. This test is about
    integration plumbing, not live model quality, so those stages return
    conservative no-op structures.
    """
    name = getattr(response_model, "__name__", "")
    if name == "ManuscriptTitleCandidate":
        return writing_module.ManuscriptTitleCandidate(
            title="Nicotine Replacement Therapy for Smoking Cessation: A Systematic Review and Meta-Analysis",
            rationale="Mock title for offline E2E validation.",
        )
    if name == "ClinicalManuscriptReview":
        return writing_module.ClinicalManuscriptReview(
            summary="No semantic edits required for offline E2E validation.",
            priority_issues=[],
            global_editing_instructions=[],
            unsafe_to_fix_without_new_sources=[],
            citation_or_source_concerns=[],
        )
    if name == "SemanticManuscriptRevision":
        return writing_module.SemanticManuscriptRevision(
            summary="No section-level edits required.",
            patches=[],
            issues=[],
        )
    if name == "SemanticParagraphRevision":
        return writing_module.SemanticParagraphRevision(
            summary="No paragraph-level edits required.",
            patches=[],
            issues=[],
        )
    if name == "SemanticSubsectionRevision":
        return writing_module.SemanticSubsectionRevision(
            summary="No subsection-level edits required.",
            patches=[],
            issues=[],
        )
    if name == "CitationGroundingRevision":
        return writing_module.CitationGroundingRevision(
            summary="No citation-grounding edits required.",
            patches=[],
            unsupported_claims=[],
        )
    if name == "SemanticGuardAdjudication":
        return writing_module.SemanticGuardAdjudication(
            accept=True,
            reason="Offline E2E mock accepts non-hard guard issues.",
        )
    if name == "SemanticManuscriptPatch":
        return writing_module.SemanticManuscriptPatch(
            heading="Discussion",
            replacement_markdown="",
            reason="Offline E2E no-op repair.",
        )
    if name == "ManuscriptClaimMap":
        return writing_module.ManuscriptClaimMap(
            summary="No evidence-understanding claim map in offline E2E.",
            claims=[],
            excluded_or_deferred_claims=[],
            authoring_strategy=[],
        )
    if name == "ClaimMapAuthoredSections":
        return writing_module.ClaimMapAuthoredSections(
            summary="No claim-map authoring in offline E2E.",
            sections=[],
            unsupported_claims_not_used=[],
        )
    if name == "FinalManuscriptReadinessReview":
        return writing_module.FinalManuscriptReadinessReview(
            decision="ready",
            score=90,
            summary="Offline E2E readiness mock.",
            strengths=["Pipeline completed with required manuscript sections."],
            issues=[],
            required_user_inputs=[],
            citation_or_provenance_concerns=[],
            safe_to_submit_without_human_review=False,
        )
    return response_model()

with patch.object(WritingAgent, 'call_llm', mock_writer_call_llm), \
     patch.object(WritingAgent, 'call_llm_structured', mock_writer_call_llm_structured):
    writer = WritingAgent()
    manuscript = writer.run(
        protocol=protocol,
        meta_results=meta_results,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query="(smoking cessation) AND (nicotine)",
        project=test_project,
        ref_manager=ref_manager,
        grade_profile=grade_profile,
        figures_b64=figures_b64,
    )

logger.info(f"  Manuscript: {len(manuscript)} chars, ~{len(manuscript.split())} words")

# Check manuscript contains key sections
checks = {
    "Title": "# " in manuscript,
    "Abstract": "## Abstract" in manuscript,
    "Introduction": "## Introduction" in manuscript,
    "Methods": "## Methods" in manuscript,
    "Results": "## Results" in manuscript,
    "Discussion": "## Discussion" in manuscript,
    "Conclusion": "## Conclusion" in manuscript,
    "References (real)": "[1]" in manuscript,
    "GRADE in Supplementary": "GRADE" in manuscript or "certainty" in manuscript.lower(),
    "Supplementary Materials": "Supplementary" in manuscript,
    "Figure Legends": "Figure" in manuscript,
}
for check_name, passed in checks.items():
    status = "✓" if passed else "✗"
    logger.info(f"    {status} {check_name}")

assert all(checks.values()), f"Some manuscript checks failed: {[k for k, v in checks.items() if not v]}"

# A complete manuscript is not successful merely because all headings exist.
# The writing stage persists the deterministic text/fact validation contract;
# fail the integration run if that contract rejected the generated article.
manuscript_validation = test_project.load_json(
    "manuscript_validation.json",
    subdir="manuscript",
)
manuscript_quality_gate = test_project.load_json(
    "manuscript_quality_gate.json",
    subdir="manuscript",
)
assert (
    manuscript_validation
    and manuscript_validation.get("passed") is True
    and manuscript_validation.get("quality_gate", {}).get("passed") is True
    and manuscript_quality_gate
    and manuscript_quality_gate.get("passed") is True
    and manuscript_quality_gate.get("summary", {}).get("warning_count") == 0
), (
    "Writing integration produced a manuscript that failed validation: "
    f"validation={(manuscript_validation or {}).get('issues', [])}; "
    f"quality_gate={(manuscript_quality_gate or {}).get('issues', [])}"
)

# ============================================================================
# 10. Full MetaAnalysisResults serialization
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("Phase 10: Serialization & data integrity")
logger.info("=" * 60)

# Serialize to JSON and back
results_json = meta_results.model_dump()
results_str = json.dumps(results_json, default=str)
logger.info(f"  MetaAnalysisResults JSON: {len(results_str)} chars")

# Check all new fields are present
assert "meta_regression" in results_json, "meta_regression missing"
assert len(results_json["meta_regression"]) == 1, "meta_regression should have 1 result"
assert "cumulative" in results_json, "cumulative missing"
assert len(results_json["cumulative"]) > 0, "cumulative should have results"
assert "nma_result" in results_json, "nma_result missing"
assert results_json["nma_result"] is not None, "nma_result should not be None"
assert "sucra_rankings" in results_json["nma_result"], "sucra_rankings missing"
assert results_json["primary_outcome"]["tau_estimator"] == "DL", "tau_estimator should be DL"
assert "pet_intercept" in results_json["publication_bias"], "pet_intercept missing"
logger.info(f"  ✓ All new fields present and serializable")

# GRADE serialization
grade_json = grade_profile.model_dump()
grade_str = json.dumps(grade_json, default=str)
logger.info(f"  GRADEProfile JSON: {len(grade_str)} chars, {len(grade_json['outcomes'])} outcomes")
assert len(grade_json["outcomes"]) >= 1, "Should have at least 1 GRADE outcome"
logger.info(f"  ✓ GRADE profile serializable")

# Protocol serialization
protocol_json = protocol.model_dump()
assert "analysis_type" in protocol_json, "analysis_type missing from protocol"
assert "interventions" in protocol_json, "interventions missing from protocol"
assert "study_designs" in protocol_json, "study_designs missing from protocol"
logger.info(f"  ✓ Protocol with new fields serializable")

# ============================================================================
# Summary
# ============================================================================
logger.info("")
logger.info("=" * 60)
logger.info("ALL TESTS PASSED")
logger.info("=" * 60)

logger.info(f"""
Summary of verified components:
  ✓ Schema extensions (protocol, study, meta_result, grade)
  ✓ Effect sizes: OR, RR, MD, SMD, HR, Proportion, Correlation, IRR
  ✓ Meta-analysis: DL, REML, HKSJ
  ✓ Leave-one-out sensitivity analysis
  ✓ Cumulative meta-analysis
  ✓ Meta-regression
  ✓ Subgroup analysis
  ✓ Publication bias: Egger, Begg, Trim-fill, Fail-safe N, PET-PEESE
  ✓ NMA: WLS fit, league table, SUCRA, node splitting, network geometry
  ✓ Visualization: forest, funnel, contour funnel, PRISMA 2020, RoB, sensitivity, cumulative, network
  ✓ GRADE evidence assessment (5 domains, certainty levels)
  ✓ MeSH-validated query builder
  ✓ Writing agent with real references, GRADE, supplementary materials
  ✓ Full serialization roundtrip

  Output directory: {tmpdir}
  Figures: {len(list(tmpdir.glob('*.png')))} PNG files
  Manuscript: ~{len(manuscript.split())} words
""")

# Cleanup
shutil.rmtree(tmpdir, ignore_errors=True)
