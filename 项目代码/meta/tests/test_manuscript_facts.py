import re
from pathlib import Path

import new_meta.agents.writing_agent as writing_module
from new_meta.agents.writing_agent import (
    ClaimSourceAlignmentItem,
    ClaimSourceAlignmentReview,
    ClaimMapAuthoredSections,
    ClaimMapSectionDraft,
    ManuscriptClaimItem,
    ManuscriptClaimMap,
    ManuscriptTitleCandidate,
    SemanticGuardAdjudication,
    SemanticParagraphRevision,
    WritingAgent,
)
from new_meta.core.grade_inputs import (
    build_grade_input_snapshot,
    repair_grade_profile_with_snapshot,
)
from new_meta.core.manuscript_facts import (
    _compact_background_evidence_context,
    _domain_controversy_candidates,
    _ensure_pipeline_warning_note,
    _merge_evidence_understanding_study_cards,
    build_manuscript_facts,
    validate_and_repair_manuscript,
)
from new_meta.core.manuscript_text_metrics import (
    manuscript_quality_gate,
    manuscript_style_audit,
    publication_min_main_words_for_primary_count,
    remove_near_duplicate_sentences,
)
from new_meta.core.model_selection import build_model_decision_and_sensitivity
from new_meta.core.positioning import ensure_review_positioning
from new_meta.core.project import Project
from new_meta.schemas.grade import GRADEDomain, GRADEOutcome, GRADEProfile
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect, StudyEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from new_meta.tools.reference_manager import ReferenceManager
from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do corticosteroids reduce mortality?",
        pico=PICO(
            population="Critically ill adults with COVID-19",
            intervention="Systemic corticosteroids",
            comparator="Usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
        model_preference="random",
    )


def _meta() -> MetaAnalysisResults:
    effects = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.2236),
        StudyEffect(study_id="S3", study_label="Wang 2022", yi=-0.3, vi=0.06, se=0.2449),
    ]
    pooled = PooledEffect(
        outcome_name="28-day all-cause mortality",
        n_studies=3,
        effect_measure="RR",
        pooled_effect=0.86,
        ci_lower=0.75,
        ci_upper=1.00,
        p_value=0.052,
        i_squared=16.0,
        studies=effects,
    )
    return MetaAnalysisResults(primary_outcome=pooled)


def _save_verified_effect_selection(project: Project) -> None:
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": f"{study_id}:0",
                "study_id": study_id,
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported: 2/10 in treatment and 3/20 in control.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            }
            for study_id in ("S1", "S2", "S3")
        ],
        subdir="analysis",
    )


def test_manuscript_facts_repair_covid_benchmark_sources_and_build_study_cards(tmp_path: Path) -> None:
    project = Project("covid source repair", output_dir=tmp_path)
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "32876695:5",
                "study_id": "32876695",
                "study_label": "Tomazini 2020",
                "outcome_name": "28-day all-cause mortality",
                "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                "source_quote": "CoDEX (NCT04327401): 28-day deaths/total were 69/128 in the steroid arm and 76/128 in the no-steroid arm.",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 69,
                "total_intervention": 128,
                "events_control": 76,
                "total_control": 128,
                "effect": 0.80,
                "se": 0.253,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "10.1101/2020.06.22.20137273:3",
                "study_id": "10.1101/2020.06.22.20137273",
                "study_label": "Horby 2020",
                "outcome_name": "28-day all-cause mortality",
                "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                "source_quote": "RECOVERY (NCT04381936): 28-day deaths/total were 95/324 in the steroid arm and 283/683 in the no-steroid arm.",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 95,
                "total_intervention": 324,
                "events_control": 283,
                "total_control": 683,
                "effect": 0.59,
                "se": 0.145,
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )
    meta = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="28-day all-cause mortality",
            n_studies=2,
            effect_measure="OR",
            pooled_effect=0.64,
            ci_lower=0.50,
            ci_upper=0.81,
            p_value=0.001,
            studies=[
                StudyEffect(study_id="32876695", study_label="Tomazini 2020", yi=-0.22, vi=0.064, se=0.253, weight=25.0),
                StudyEffect(study_id="10.1101/2020.06.22.20137273", study_label="Horby 2020", yi=-0.53, vi=0.021, se=0.145, weight=75.0),
            ],
        )
    )

    facts = build_manuscript_facts(protocol=_protocol(), meta_results=meta, project=project)
    rows = facts["evidence_readiness"]["selected_primary_rows"]
    cards = {card["slug"]: card for card in facts["study_cards"]}

    assert rows[0]["source_recovery_applied"] is True
    assert "WHO REACT" not in rows[0]["source_location"]
    assert "WHO REACT" in rows[0]["source_location_original"]
    assert rows[0]["source_provenance_tier"] == "secondary_meta_figure"
    persisted_audit = project.load_json("effect_selection_audit.json", subdir="analysis")
    assert persisted_audit[0]["source_provenance_tier"] == "secondary_meta_figure"
    assert persisted_audit[0]["source_allowed_in_publication"] is False
    assert persisted_audit[0]["source_allowed_in_benchmark"] is True
    assert facts["report_type"] == "evidence_gap"
    assert "secondary_meta_source_used_as_primary_row" in facts["evidence_readiness"]["blocker_codes"]
    assert "CoDEX" in cards["codex"]["display_name"]
    assert "ventilator-free days" in cards["codex"]["primary_outcome_note"]
    assert "mechanical-ventilation subgroup" in cards["recovery"]["analysis_population"]
    assert cards["recovery"]["weight"] == 75.0


def test_manuscript_facts_allows_secondary_meta_rows_only_for_benchmark_reconstruction(tmp_path: Path) -> None:
    project = Project("covid benchmark reconstruction facts", output_dir=tmp_path)
    project.save_json(
        "positioning.json",
        {
            "category": "reproduction_or_benchmark_alignment",
            "report_type": "benchmark_reconstruction",
            "anchor_review": {"label": "WHO REACT"},
        },
        subdir="analysis",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "32876695:5",
                "study_id": "32876695",
                "study_label": "Tomazini 2020",
                "outcome_name": "28-day all-cause mortality",
                "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                "source_quote": "CoDEX (NCT04327401): 28-day deaths/total were 69/128 in the steroid arm and 76/128 in the no-steroid arm.",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 69,
                "total_intervention": 128,
                "events_control": 76,
                "total_control": 128,
                "effect": 0.80,
                "se": 0.253,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "10.1101/2020.06.22.20137273:3",
                "study_id": "10.1101/2020.06.22.20137273",
                "study_label": "Horby 2020",
                "outcome_name": "28-day all-cause mortality",
                "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                "source_quote": "RECOVERY (NCT04381936): 28-day deaths/total were 95/324 in the steroid arm and 283/683 in the no-steroid arm.",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 95,
                "total_intervention": 324,
                "events_control": 283,
                "total_control": 683,
                "effect": 0.59,
                "se": 0.145,
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )
    meta = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="28-day all-cause mortality",
            n_studies=2,
            effect_measure="OR",
            pooled_effect=0.64,
            ci_lower=0.50,
            ci_upper=0.81,
            p_value=0.001,
            studies=[
                StudyEffect(study_id="32876695", study_label="Tomazini 2020", yi=-0.22, vi=0.064, se=0.253, weight=25.0),
                StudyEffect(study_id="10.1101/2020.06.22.20137273", study_label="Horby 2020", yi=-0.53, vi=0.021, se=0.145, weight=75.0),
            ],
        )
    )

    facts = build_manuscript_facts(protocol=_protocol(), meta_results=meta, project=project)
    readiness = facts["evidence_readiness"]

    assert facts["report_type"] == "benchmark_reconstruction"
    assert not readiness["blockers"]
    assert readiness["warnings"][0]["code"] == "secondary_meta_source_used_for_benchmark_reconstruction"
    assert facts["source_provenance"]["counts"] == {"secondary_meta_figure": 2}
    persisted_audit = project.load_json("effect_selection_audit.json", subdir="analysis")
    assert [row["source_provenance_tier"] for row in persisted_audit] == ["secondary_meta_figure", "secondary_meta_figure"]


def test_manuscript_style_audit_flags_ai_style_and_section_citation_imbalance() -> None:
    long_para = " ".join(["The result should be interpreted carefully rather than directly applied."] * 7)
    manuscript = "\n\n".join([
        "# Draft",
        "## Introduction\nBackground claim without citation. Another background sentence.",
        "## Methods\nEligibility was specified [1]. Data were extracted [1]. Risk of bias was assessed [1].",
        "## Results\nOR 0.66 was observed [1].",
        f"## Discussion\n{long_para}",
        "## References\n[1] Trial report.",
    ])

    audit = manuscript_style_audit(manuscript)
    codes = {issue["code"] for issue in audit["issues"]}

    assert "excessive_rather_than" in codes
    assert "long_publication_paragraphs" in codes
    assert "introduction_citation_density_low_relative_to_methods" in codes
    assert audit["summary"]["rather_than_count"] == 7


def test_manuscript_style_audit_excludes_tables_figures_and_declarations() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        "## Introduction\nPatients had the target condition [1].",
        "## Methods\nMethods were prespecified [1].",
        "## Results\nTreatment reduced the primary outcome [1].",
        "## Discussion\nThe clinical interpretation is focused and concrete [1].",
        "## Tables\nThe pooled estimate appears in a table note. This review appears in a table note.",
        "## Figures\nThe pooled estimate appears in a forest-plot legend. This review appears in a figure legend.",
        "## Declarations\nThis review synthesized published reports. This review had no supplied funding statement.",
        "## References\n[1] Trial report.",
    ])

    audit = manuscript_style_audit(manuscript)

    assert audit["summary"]["abstract_subject_sentence_count"] == 0
    assert not any(issue["code"] == "abstract_subject_overuse" for issue in audit["issues"])


def test_non_meta_draft_cannot_keep_nr_pooled_effect_or_zero_zero_counts() -> None:
    manuscript = "\n\n".join([
        "# 速效救心丸治疗稳定型心绞痛的系统综述和Meta分析",
        "## 摘要",
        "主要Meta分析纳入1项研究、共0名参与者；合并效应为RR for dichotomous outcomes; MD for continuous outcomes measured on the same scale; SMD for continuous outcomes measured on different scales. NR（95% CI NR至NR）。",
        "在本系统综述和Meta分析中，速效救心丸相较于安慰剂与心绞痛症状风险降低相关。",
        "## 方法",
        "研究层面RR for dichotomous outcomes; MD for continuous outcomes measured on the same scale; SMD for continuous outcomes measured on different scales.及标准误采用预设模型。",
        "## 结果",
        "臂水平事件计数为干预组0/0、对照组0/0。",
        "## 讨论",
        "当前证据仍需补全文。",
    ])
    facts = {
        "report_type": "narrative",
        "effect_measure": "RR for dichotomous outcomes; MD for continuous outcomes measured on the same scale; SMD for continuous outcomes measured on different scales.",
        "primary_effect": None,
        "studies": {"primary_analysis_count": 1},
        "primary_population": {"selected_total_participants": 0},
        "evidence_readiness": {"blockers": [], "warnings": []},
        "search": {"source_names": ["PubMed"]},
        "text_sources": {},
        "pipeline_warnings": [],
    }

    repaired, validation = validate_and_repair_manuscript(manuscript, facts)

    assert validation["passed"] is True
    assert "Meta分析" not in repaired.splitlines()[0]
    assert "NR（95% CI" not in repaired
    assert "0/0" not in repaired
    assert "风险降低相关" not in repaired
    assert "RR for dichotomous outcomes; MD for continuous outcomes" not in repaired
    assert "证据缺口" in repaired


def test_benchmark_reconstruction_keeps_benchmark_title_and_pooled_effect() -> None:
    manuscript = "\n\n".join([
        "# Systemic corticosteroids and short-term mortality in critically ill adults with COVID-19: a benchmark reconstruction of the WHO REACT meta-analysis",
        "## Abstract",
        "This benchmark reconstruction included 2 trials totaling 1263 participants. The pooled OR was 0.64 (95% CI 0.50 to 0.81).",
        "## Methods",
        "Rows transcribed from the WHO REACT Figure 2 source were labeled as secondary-meta provenance.",
        "## Results",
        "The pooled OR was 0.64 (95% CI 0.50 to 0.81).",
        "## Discussion",
        "The result is presented as a benchmark reconstruction, not as independent publication-mode extraction.",
    ])
    facts = {
        "report_type": "benchmark_reconstruction",
        "primary_effect": {
            "n_studies": 2,
            "pooled_effect": 0.64,
            "ci_lower": 0.50,
            "ci_upper": 0.81,
        },
        "studies": {"primary_analysis_count": 2},
        "primary_population": {"selected_total_participants": 1263},
        "evidence_readiness": {
            "blockers": [],
            "warnings": [
                {"code": "secondary_meta_source_used_for_benchmark_reconstruction"}
            ],
            "selected_primary_rows": [
                {
                    "row_id": "trial:0",
                    "source_location_original": "WHO REACT Working Group. JAMA 2020 Figure 2",
                    "source_provenance_tier": "secondary_meta_figure",
                }
            ],
        },
        "search": {"source_names": ["PubMed"]},
        "text_sources": {},
        "pipeline_warnings": [],
    }

    repaired, validation = validate_and_repair_manuscript(manuscript, facts)

    assert validation["passed"] is True
    assert repaired.splitlines()[0] == manuscript.splitlines()[0]
    assert "Evidence-gap systematic review" not in repaired
    assert "The pooled OR was 0.64" in repaired
    assert not any(issue["kind"] == "non_meta_title_repaired" for issue in validation["issues"])


def test_publication_contract_flags_unrepaired_internal_jargon() -> None:
    manuscript = "\n\n".join([
        "# Evidence-gap systematic review",
        "## Results",
        "The available evidence was insufficient to pool the primary outcome.",
        "## Discussion",
        "Rule-based P/I/C/O directness check found no obvious mismatch. OIS=600; CI crosses null=False.",
    ])
    facts = {
        "report_type": "evidence_gap",
        "primary_effect": None,
        "studies": {"primary_analysis_count": 0},
        "primary_population": {"selected_total_participants": 0},
        "evidence_readiness": {"blockers": [], "warnings": []},
        "search": {"source_names": ["PubMed"]},
        "text_sources": {},
        "pipeline_warnings": [],
    }

    _, validation = validate_and_repair_manuscript(manuscript, facts)

    assert validation["passed"] is False
    assert any(issue["kind"] == "internal_grade_or_pipeline_jargon_leaked" for issue in validation["issues"])


def test_covid_citation_repair_does_not_rewrite_reference_section() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        (
            "## Introduction\n"
            "RECOVERY supplied mortality data outside the full hospitalized RECOVERY population [18]. "
            "CoDEX studied dexamethasone and used ventilator-free days; mortality was not the trial's main endpoint [18]. "
            "REMAP-CAP and CAPE COVID contributed hydrocortisone evidence [19]. "
            "WHO REACT was the published comparator [1]."
        ),
        "## References",
        "[1] Horby P. Dexamethasone in Hospitalized Patients with Covid-19. doi: 10.1056/NEJMoa2021436",
        "[2] Tomazini BM. CoDEX Randomized Clinical Trial. doi: 10.1001/jama.2020.17021",
        "[3] Angus DC. REMAP-CAP COVID-19 Corticosteroid Domain Randomized Clinical Trial. doi: 10.1001/jama.2020.17022",
        "[4] Dequin PF. CAPE COVID. doi: 10.1001/jama.2020.16761",
        "[5] WHO REACT Working Group. Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19. doi: 10.1001/jama.2020.17023",
    ])

    repaired = WritingAgent._repair_covid_contextual_citation_attribution(manuscript)

    assert "RECOVERY population [1]" in repaired
    assert "trial's main endpoint [2]" in repaired
    assert "hydrocortisone evidence [3,4]" in repaired
    assert "WHO REACT was the published comparator [5]" in repaired
    assert "\n[2] Tomazini" in repaired
    assert "\n[3] Angus" in repaired
    assert "\n[4] Dequin" in repaired
    assert "\n[5] WHO REACT" in repaired


def test_manuscript_quality_gate_catches_reference_corruption_and_internal_jargon() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        "## Abstract\nThis systematic review and meta-analysis found lower mortality[3].",
        "## Introduction\nRule-based P/I/C/O directness check found no obvious mismatch.",
        "## Methods\nMethods text.",
        "## Results\nResults text.",
        "## Discussion\nDiscussion text.",
        "## References",
        "[1] First trial report.",
        "[2] Second trial report. [3] Third trial report accidentally embedded on the same line.",
        "[4] Fourth trial report.",
    ])

    gate = manuscript_quality_gate(manuscript, {"report_type": "meta"})
    codes = {issue["code"] for issue in gate["issues"]}

    assert gate["passed"] is False
    assert "reference_number_sequence_broken" in codes
    assert "reference_entry_contains_embedded_reference" in codes
    assert "internal_grade_or_pipeline_jargon" in codes
    assert "sticky_english_numeric_citation" in codes


def test_manuscript_quality_gate_warns_on_zh_self_result_external_citation() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        "## 摘要\n摘要。",
        "## 引言\n背景。",
        "## 方法\n方法。",
        "## 结果\n结果。",
        "## 讨论\n本系统综述和Meta分析显示，治疗的合并HR为0.81，95% CI为0.74至0.88 [1,2]。",
        "## 参考文献\n[1] Trial report.",
    ])

    gate = manuscript_quality_gate(manuscript, {"report_type": "meta"})

    assert any(issue["code"] == "self_result_sentence_has_external_trial_citation" for issue in gate["issues"])


def test_manuscript_quality_gate_blocks_secondary_meta_source_primary_rows() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        "## Abstract\nThe review included two trials [1].",
        "## Introduction\nBackground evidence framed the review question [1].",
        "## Methods\nMethods followed prespecified eligibility and synthesis criteria [1].",
        "## Results\nThe primary synthesis included the trial evidence [1].",
        "## Discussion\nThe clinical interpretation used the same trial evidence [1].",
        "## References\n[1] Trial report.",
    ])
    facts = {
        "report_type": "meta",
        "evidence_readiness": {
            "selected_primary_rows": [
                {
                    "row_id": "trial:0",
                    "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
                    "source_role": "secondary_meta_analysis",
                }
            ]
        },
    }

    gate = manuscript_quality_gate(manuscript, facts)

    assert gate["passed"] is False
    assert any(issue["code"] == "secondary_meta_source_used_as_primary_row" for issue in gate["issues"])


def test_manuscript_quality_gate_checks_original_source_even_after_display_recovery() -> None:
    manuscript = "\n\n".join([
        "# Draft",
        "## Abstract\nThe review included two trials [1].",
        "## Introduction\nBackground evidence framed the review question [1].",
        "## Methods\nMethods followed prespecified eligibility and synthesis criteria [1].",
        "## Results\nThe primary synthesis included the trial evidence [1].",
        "## Discussion\nThe clinical interpretation used the same trial evidence [1].",
        "## References\n[1] Trial report.",
    ])
    facts = {
        "report_type": "meta",
        "evidence_readiness": {
            "selected_primary_rows": [
                {
                    "row_id": "trial:0",
                    "source_location": "CoDEX JAMA 2020 primary trial report",
                    "source_location_original": "WHO REACT Working Group. JAMA 2020 Figure 2",
                    "source_provenance_tier": "secondary_meta_figure",
                }
            ]
        },
    }

    gate = manuscript_quality_gate(manuscript, facts)

    assert gate["passed"] is False
    assert any(issue["code"] == "secondary_meta_source_used_as_primary_row" for issue in gate["issues"])


def test_manuscript_quality_gate_warns_for_declared_benchmark_secondary_rows() -> None:
    manuscript = "\n\n".join([
        "# Benchmark reconstruction",
        "## Abstract\nThis benchmark reconstruction included two trials.",
        "## Introduction\nBackground.",
        "## Methods\nMethods.",
        "## Results\nResults.",
        "## Discussion\nDiscussion.",
        "## References\n[1] Trial report.",
    ])
    facts = {
        "report_type": "benchmark_reconstruction",
        "evidence_readiness": {
            "selected_primary_rows": [
                {
                    "row_id": "trial:0",
                    "source_location": "CoDEX JAMA 2020 primary trial report",
                    "source_location_original": "WHO REACT Working Group. JAMA 2020 Figure 2",
                    "source_provenance_tier": "secondary_meta_figure",
                }
            ]
        },
    }

    gate = manuscript_quality_gate(manuscript, facts)

    assert gate["passed"] is True
    assert any(issue["code"] == "secondary_meta_source_declared_for_benchmark_reconstruction" for issue in gate["issues"])


def test_writing_agent_saves_quality_gate_artifacts(tmp_path: Path) -> None:
    project = Project("quality gate save", output_dir=tmp_path)
    writer = WritingAgent()
    manuscript = "\n\n".join([
        "# Draft",
        "## Abstract\nThe review included two trials [1].",
        "## Introduction\nBackground evidence framed the review question [1].",
        "## Methods\nMethods followed prespecified eligibility and synthesis criteria [1].",
        "## Results\nThe primary synthesis included the trial evidence [1].",
        "## Discussion\nThe clinical interpretation used the same trial evidence [1].",
        "## References\n[1] Trial report.",
    ])
    validation = {"passed": True, "issues": [], "facts_summary": {"report_type": "meta"}}

    merged, _, gate = writer._quality_checked_validation(
        manuscript,
        {"report_type": "meta"},
        validation,
        project=project,
    )

    assert gate["passed"] is True
    assert merged["passed"] is True
    assert project.load_json("manuscript_quality_gate.json", subdir="manuscript")["passed"] is True
    assert project.load_json("manuscript_validation.json", subdir="manuscript")["quality_gate"]["passed"] is True
    submission_gate = project.load_json("submission_quality_gate.json", subdir="manuscript")
    assert submission_gate["status"] == "fail"
    assert any(item["name"] == "claim_source_resolution" for item in submission_gate["checks"])


def test_generated_length_target_is_lower_for_small_evidence_base() -> None:
    assert publication_min_main_words_for_primary_count(7) == 2800
    assert publication_min_main_words_for_primary_count(8) == 4500


def _sglt2_protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question=(
            "In adults with heart failure with mildly reduced or preserved ejection fraction, "
            "do SGLT2 inhibitors compared with placebo reduce cardiovascular death or hospitalization "
            "for heart failure?"
        ),
        pico=PICO(
            population="Adults with heart failure with mildly reduced or preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Composite of cardiovascular death or first hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="random",
    )


def _sglt2_meta() -> MetaAnalysisResults:
    effects = [
        StudyEffect(study_id="34449189", study_label="Anker 2021", yi=-0.2357, vi=0.00459, se=0.0678),
        StudyEffect(study_id="36027570", study_label="Solomon 2022", yi=-0.1985, vi=0.00348, se=0.0590),
    ]
    pooled = PooledEffect(
        outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
        n_studies=2,
        effect_measure="HR",
        pooled_effect=0.8069,
        ci_lower=0.7395,
        ci_upper=0.8805,
        p_value=0.0000014,
        i_squared=0.0,
        tau_squared=0.0,
        model="random",
        studies=effects,
    )
    return MetaAnalysisResults(primary_outcome=pooled)


def _save_sglt2_effect_selection(project: Project) -> None:
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "34449189:0",
                "study_id": "34449189",
                "study_label": "Anker 2021",
                "outcome_name": "Composite of cardiovascular death or first hospitalization for heart failure",
                "source_quote": (
                    "a primary outcome event occurred in 415 of 2997 patients in the empagliflozin group "
                    "and in 511 of 2991 patients in the placebo group (hazard ratio, 0.79; 95% CI, 0.69 to 0.90)"
                ),
                "source_location": "Abstract and Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 415,
                "total_intervention": 2997,
                "events_control": 511,
                "total_control": 2991,
                "effect": 0.79,
                "se": 0.0678,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "36027570:0",
                "study_id": "36027570",
                "study_label": "Solomon 2022",
                "outcome_name": "Composite of cardiovascular death or first hospitalization for heart failure",
                "source_quote": (
                    "the primary outcome occurred in 512 of 3131 patients in the dapagliflozin group "
                    "and in 610 of 3132 patients in the placebo group (hazard ratio, 0.82; 95% CI, 0.73 to 0.92)"
                ),
                "source_location": "Abstract and Results",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 512,
                "total_intervention": 3131,
                "events_control": 610,
                "total_control": 3132,
                "effect": 0.82,
                "se": 0.0590,
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )


def test_build_manuscript_facts_repairs_given_name_first_primary_labels(tmp_path: Path) -> None:
    project = Project("facts labels", output_dir=tmp_path)
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "34449189:0",
                "study_id": "34449189",
                "study_label": "Stefan 2021",
                "outcome_name": "Composite of cardiovascular death or first hospitalization for heart failure",
                "source_quote": "415/2997 versus 511/2991.",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 415,
                "total_intervention": 2997,
                "events_control": 511,
                "total_control": 2991,
                "in_final_primary_analysis": True,
            }
        ],
        subdir="analysis",
    )
    meta = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
            n_studies=2,
            effect_measure="HR",
            pooled_effect=0.8069,
            ci_lower=0.7395,
            ci_upper=0.8805,
            p_value=0.000001,
            studies=[
                StudyEffect(study_id="34449189", study_label="Stefan 2021", yi=-0.2357, vi=0.00459, se=0.0678),
                StudyEffect(study_id="36027570", study_label="Scott 2022", yi=-0.1985, vi=0.00348, se=0.0590),
            ],
        )
    )
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="34449189",
                pmid="34449189",
                title="Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                authors=["Stefan D. Anker"],
                year=2021,
            ),
            outcomes=[OutcomeData(outcome_name="Composite of cardiovascular death or first hospitalization for heart failure")],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="36027570",
                pmid="36027570",
                title="Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
                authors=["Scott D. Solomon"],
                year=2022,
            ),
            outcomes=[OutcomeData(outcome_name="Composite of cardiovascular death or first hospitalization for heart failure")],
        ),
    ]

    facts = build_manuscript_facts(
        protocol=_sglt2_protocol(),
        meta_results=meta,
        extracted_studies=extracted,
        project=project,
    )

    assert facts["studies"]["primary_analysis_labels"] == ["Anker 2021", "Solomon 2022"]
    assert [study["study_label"] for study in facts["primary_effect"]["studies"]] == ["Anker 2021", "Solomon 2022"]
    assert facts["evidence_readiness"]["selected_primary_rows"][0]["study_label"] == "Anker 2021"


def _main_body_before_supplement(manuscript: str) -> str:
    return re.split(r"##\s+(?:Supplementary Materials|补充材料)", manuscript, maxsplit=1)[0]


def test_build_manuscript_facts_reads_sources_and_primary_effect(tmp_path: Path) -> None:
    project = Project("facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"pubmed": 0, "OpenAlex": 76})
    project.save_json("text_source_warnings.json", [{"pmid": "123", "title": "Blocked PDF"}])
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        rob_results=[StudyRoB(study_id="S1", tool_used="RoB 2")],
        prisma_data={"identification": {"records_identified": 76}},
        search_query="COVID-19 corticosteroids",
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Very low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="serious", rationale="Some concerns"),
                    GRADEDomain(domain="inconsistency", rating="serious", rationale="Wide prediction interval"),
                    GRADEDomain(domain="indirectness", rating="no concern", rationale="Direct population"),
                    GRADEDomain(domain="imprecision", rating="no concern", rationale="CI excludes null"),
                ],
            )
        ]),
    )

    assert facts["search"]["source_names"] == ["PubMed", "OpenAlex"]
    assert facts["search"]["source_counts"] == {"OpenAlex": 76}
    assert facts["primary_effect"]["n_studies"] == 3
    assert facts["primary_population"]["selected_total_participants"] == 90
    assert facts["primary_population"]["selected_events_intervention"] == 6
    assert facts["primary_population"]["selected_events_control"] == 9
    assert facts["text_sources"]["abstract_only_count"] == 1
    assert facts["text_sources"]["metadata_only_count"] == 0
    assert facts["text_sources"]["limited_source_count"] == 1
    assert facts["report_type"] == "meta"
    assert facts["evidence_readiness"]["status"] == "ready"
    assert facts["evidence_readiness"]["warnings"][0]["scope"] == "non_primary_records"
    assert facts["rob"]["tools"] == ["RoB 2"]
    assert facts["grade"]["outcomes"][0]["domains"][1]["domain"] == "inconsistency"


def test_build_manuscript_facts_infers_pubmed_source_from_pubmed_query_syntax(tmp_path: Path) -> None:
    project = Project("facts pubmed query source", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 76})
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 76, "records_after_dedup": 20},
            "screening": {"title_abstract_screened": 20},
            "eligibility": {"full_text_assessed": 5},
            "included": {"studies_included": 3},
        },
        search_query='("heart failure"[tiab] AND SGLT2[tiab]) AND "English"[la]',
        project=project,
    )

    assert facts["search"]["source_names"] == ["PubMed", "OpenAlex"]
    assert facts["search"]["source_counts"] == {"OpenAlex": 76}


def test_build_manuscript_facts_derives_absolute_effect_from_observed_control_risk(tmp_path: Path) -> None:
    project = Project("absolute effects", output_dir=tmp_path)
    _save_sglt2_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_sglt2_protocol(),
        meta_results=_sglt2_meta(),
        prisma_data={"identification": {"records_identified": 2}},
        search_query="HFpEF SGLT2",
        project=project,
    )

    absolute = facts["absolute_effects"]
    assert absolute["effect_measure"] == "HR"
    assert absolute["source"] == "observed_comparator_event_risk"
    assert absolute["method"] == "proportional_hazards_baseline_risk_translation"
    assert absolute["baseline_events"] == 1121
    assert absolute["baseline_total"] == 6123

    scenario = absolute["scenarios"][0]
    assert scenario["label"] == "Observed comparator risk in included trials"
    assert scenario["assumed_control_risk_per_1000"] == 183
    assert scenario["intervention_risk_per_1000"] == 151
    assert scenario["events_avoided_per_1000"] == 33
    assert scenario["events_avoided_ci_low_per_1000"] == 20
    assert scenario["events_avoided_ci_high_per_1000"] == 44
    assert scenario["nnt"] == 31
    assert scenario["nnt_ci_low"] == 23
    assert scenario["nnt_ci_high"] == 51


def test_build_manuscript_facts_adds_user_supplied_baseline_risk_scenarios(tmp_path: Path) -> None:
    project = Project("absolute effect scenarios", output_dir=tmp_path)
    _save_sglt2_effect_selection(project)
    project.save_json(
        "baseline_risk_scenarios.json",
        {
            "scenarios": [
                {
                    "label": "Lower-risk target population",
                    "label_zh": "较低风险目标人群",
                    "assumed_control_risk_per_1000": 100,
                    "source": "external_clinical_context",
                },
                {
                    "label": "Higher-risk post-discharge population",
                    "label_zh": "较高风险出院后人群",
                    "assumed_control_risk": 0.30,
                    "source": "external_clinical_context",
                },
            ]
        },
        subdir="analysis",
    )

    facts = build_manuscript_facts(
        protocol=_sglt2_protocol(),
        meta_results=_sglt2_meta(),
        prisma_data={"identification": {"records_identified": 2}},
        search_query="HFpEF SGLT2",
        project=project,
    )

    scenarios = facts["absolute_effects"]["scenarios"]
    assert [item["label"] for item in scenarios] == [
        "Observed comparator risk in included trials",
        "Lower-risk target population",
        "Higher-risk post-discharge population",
    ]
    assert scenarios[1]["source"] == "external_clinical_context"
    assert scenarios[1]["assumed_control_risk_per_1000"] == 100
    assert scenarios[1]["intervention_risk_per_1000"] == 82
    assert scenarios[1]["events_avoided_per_1000"] == 18
    assert scenarios[1]["nnt"] == 55
    assert scenarios[1]["nnt_ci_low"] == 40
    assert scenarios[1]["nnt_ci_high"] == 88
    assert scenarios[2]["assumed_control_risk_per_1000"] == 300
    assert scenarios[2]["intervention_risk_per_1000"] == 250
    assert scenarios[2]["events_avoided_per_1000"] == 50
    assert scenarios[2]["nnt"] == 21


def test_manuscript_facts_scrubs_internal_known_source_names(tmp_path: Path) -> None:
    project = Project("facts-known-source-labels", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"internal_db": 3, "known_source_evidence": 7})
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )
    counts_text = WritingAgent()._fallback_source_counts(facts["search"]["source_counts"])

    assert "curated literature index" in facts["search"]["source_names"]
    assert "source-adjudicated records" in facts["search"]["source_names"]
    assert "internal literature database" not in " ".join(facts["search"]["source_names"])
    assert "known_source" not in " ".join(facts["search"]["source_names"])
    assert "internal literature database" not in counts_text
    assert "known_source" not in counts_text
    assert "curated literature index: 3" in counts_text
    assert "source-adjudicated records: 7" in counts_text


def test_manuscript_facts_repairs_grade_imprecision_total_from_selected_rows(tmp_path: Path) -> None:
    project = Project("grade-imprecision-repair", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 3})
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Very low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="serious", rationale="Some concerns"),
                    GRADEDomain(domain="indirectness", rating="serious", rationale="Some indirectness"),
                    GRADEDomain(
                        domain="imprecision",
                        rating="serious",
                        rationale="Total N=376 vs OIS=600; CI width=0.288; CI crosses null=False.",
                    ),
                    GRADEDomain(
                        domain="publication_bias",
                        rating="serious",
                        rationale="Egger's test significant despite too few studies.",
                    ),
                ],
            )
        ]),
    )

    grade = facts["grade"]["outcomes"][0]
    domains = {item["domain"]: item for item in grade["domains"]}
    assert domains["imprecision"]["rationale"].startswith("Total N=90 vs OIS=600")
    assert domains["imprecision"]["rating"] == "serious"
    assert domains["publication_bias"]["rating"] == "no concern"
    assert grade["certainty"] == "Very low"


def test_manuscript_facts_clears_imprecision_when_selected_total_meets_ois(tmp_path: Path) -> None:
    project = Project("grade-imprecision-adequate", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 7})
    rows = []
    for idx in range(7):
        rows.append({
            "row_id": f"S{idx}:0",
            "study_id": f"S{idx}",
            "outcome_name": "28-day all-cause mortality",
            "source_quote": "28-day mortality was reported with full arm counts.",
            "source_location": "Table 2",
            "source_quote_verified": True,
            "extraction_confidence": "high",
            "events_intervention": 30,
            "total_intervention": 120,
            "events_control": 50,
            "total_control": 130,
            "in_final_primary_analysis": True,
        })
    project.save_json("effect_selection_audit.json", rows, subdir="analysis")

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=7,
                effect_summary="OR 0.66 (95% CI 0.53 to 0.82)",
                certainty="Very low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="serious", rationale="Some concerns"),
                    GRADEDomain(domain="indirectness", rating="serious", rationale="Some indirectness"),
                    GRADEDomain(
                        domain="imprecision",
                        rating="serious",
                        rationale="Total N=376 vs OIS=600; CI width=0.428; CI crosses null=False.",
                    ),
                    GRADEDomain(
                        domain="publication_bias",
                        rating="serious",
                        rationale="Egger's test significant despite too few studies.",
                    ),
                ],
            )
        ]),
    )

    grade = facts["grade"]["outcomes"][0]
    domains = {item["domain"]: item for item in grade["domains"]}
    assert facts["primary_population"]["selected_total_participants"] == 1750
    assert domains["imprecision"]["rationale"].startswith("Total N=1750 vs OIS=600")
    assert domains["imprecision"]["rating"] == "no concern"
    assert domains["publication_bias"]["rating"] == "no concern"
    assert grade["certainty"] == "Low"


def test_build_manuscript_facts_uses_review_decisions_to_clear_extraction_warnings(tmp_path: Path) -> None:
    project = Project("review decision facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 3})
    _save_verified_effect_selection(project)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 1, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "28-day all-cause mortality",
                    "requires_review": True,
                    "conflicts": [{"field": "events_intervention", "message": "needs check"}],
                }
            ],
        },
        subdir="extraction",
    )
    save_extraction_review_decision(
        project,
        ExtractionReviewDecision(
            row_id="S1:0",
            study_id="S1",
            outcome_index=0,
            decision="accepted",
            note="Verified against source quote.",
            updated_by="tester",
        ),
        expected_revision=0,
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    warning_codes = {item["code"] for item in facts["evidence_readiness"]["warnings"]}
    assert "unresolved_extraction_review_rows" not in warning_codes
    assert "unresolved_extraction_conflicts" not in warning_codes
    assert facts["evidence_readiness"]["extraction_audit_summary"]["rows_requiring_review"] == 0
    assert facts["evidence_readiness"]["extraction_audit_summary"]["conflict_rows"] == 0


def test_evidence_readiness_keeps_non_primary_review_backlog_out_of_manuscript_warnings(tmp_path: Path) -> None:
    project = Project("non-primary backlog", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 3})
    _save_verified_effect_selection(project)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 4, "rows_requiring_review": 2, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "28-day all-cause mortality",
                    "requires_review": False,
                    "conflicts": [],
                },
                {
                    "row_id": "S1:1",
                    "study_id": "S1",
                    "outcome_index": 1,
                    "outcome_name": "90-day all-cause mortality",
                    "requires_review": True,
                    "conflicts": [{"field": "events_control", "message": "Secondary row needs review."}],
                },
                {
                    "row_id": "S2:1",
                    "study_id": "S2",
                    "outcome_index": 1,
                    "outcome_name": "Hospital length of stay",
                    "requires_review": True,
                    "conflicts": [],
                },
            ],
        },
        subdir="extraction",
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    warning_codes = {item["code"] for item in readiness["warnings"]}
    assert readiness["status"] == "ready"
    assert "unresolved_extraction_review_rows" not in warning_codes
    assert "unresolved_extraction_conflicts" not in warning_codes
    assert readiness["extraction_audit_summary"]["rows_requiring_review"] == 2
    assert readiness["extraction_backlog"]["non_primary_review_rows"] == 2
    assert readiness["extraction_backlog"]["non_primary_conflict_rows"] == 1
    assert readiness["extraction_backlog"]["selected_primary_review_rows"] == 0
    assert readiness["extraction_backlog"]["selected_primary_conflict_rows"] == 0


def test_evidence_readiness_uses_row_id_before_outcome_name_for_primary_review_counts(tmp_path: Path) -> None:
    project = Project("row-id primary backlog", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 3})
    _save_verified_effect_selection(project)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"outcomes": 2, "rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_index": 0,
                    "outcome_name": "28-day all-cause mortality",
                    "requires_review": False,
                    "conflicts": [],
                },
                {
                    "row_id": "S1:9",
                    "study_id": "S1",
                    "outcome_index": 9,
                    "outcome_name": "28-day all-cause mortality",
                    "requires_review": True,
                    "conflicts": [{"field": "source_quote", "message": "Duplicate candidate row."}],
                },
            ],
        },
        subdir="extraction",
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    assert readiness["status"] == "ready"
    assert readiness["extraction_backlog"]["selected_primary_review_rows"] == 0
    assert readiness["extraction_backlog"]["selected_primary_conflict_rows"] == 0
    assert readiness["extraction_backlog"]["non_primary_review_rows"] == 1
    assert readiness["extraction_backlog"]["non_primary_conflict_rows"] == 1


def test_manuscript_facts_counts_metadata_only_source_warnings(tmp_path: Path) -> None:
    project = Project("metadata facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"RegistrySeed": 1})
    project.save_json(
        "text_source_warnings.json",
        [
            {
                "title": "Steroids-SARI",
                "trial_registration": "NCT04244591",
                "text_availability": "metadata_only",
            }
        ],
    )
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        rob_results=[StudyRoB(study_id="S1", tool_used="RoB 2")],
        prisma_data={},
        search_query="COVID-19 corticosteroids",
        project=project,
        grade_profile=None,
    )

    assert facts["text_sources"]["abstract_only_count"] == 0
    assert facts["text_sources"]["metadata_only_count"] == 1
    assert facts["text_sources"]["limited_source_count"] == 1
    assert facts["evidence_readiness"]["warnings"][0]["code"] == "limited_text_sources_present"
    assert "metadata-only" in facts["evidence_readiness"]["warnings"][0]["message"]


def test_manuscript_facts_resolves_limited_warning_with_benchmark_primary_source(tmp_path: Path) -> None:
    project = Project("benchmark source facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 1})
    project.save_json(
        "text_source_warnings.json",
        [{"pmid": "32876695", "doi": "10.1001/jama.2020.17021", "title": "CoDEX primary article"}],
    )
    source_dir = project.base_dir / "benchmark" / "sources" / "codex"
    source_dir.mkdir(parents=True)
    source_path = source_dir / "codex_pmc.txt"
    source_path.write_text(
        "CoDEX primary article. DOI 10.1001/jama.2020.17021. PMID 32876695.",
        encoding="utf-8",
    )
    project.save_json(
        "benchmark_source_manifest.json",
        {
            "sources": [
                {
                    "trial_id": "codex",
                    "trial_name": "CoDEX",
                    "source_kind": "primary_full_text",
                    "filename": "codex_pmc.txt",
                    "local_path": str(source_path),
                    "parse_status": "ok",
                    "text_chars": source_path.stat().st_size,
                }
            ]
        },
        subdir="benchmark",
    )
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    assert facts["text_sources"]["limited_source_count"] == 0
    assert "limited_text_sources_present" not in {
        item["code"] for item in facts["evidence_readiness"]["warnings"]
    }


def test_non_primary_limited_text_sources_do_not_downgrade_verified_primary_meta(tmp_path: Path) -> None:
    project = Project("non-primary limited source facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 20})
    project.save_json(
        "text_source_warnings.json",
        [
            {
                "pmid": "31523904",
                "doi": "10.1002/ejhf.1596",
                "title": "EMPEROR-Preserved design paper",
                "text_availability": "abstract_only",
            },
            {
                "pmid": "37534453",
                "doi": "10.1161/circulationaha.123.065134",
                "title": "CAMEO-DAPA",
                "text_availability": "abstract_only",
            },
        ],
    )
    _save_sglt2_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_sglt2_protocol(),
        meta_results=_sglt2_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    assert readiness["report_type"] == "meta"
    assert readiness["status"] == "ready"
    assert readiness["blocker_codes"] == []
    assert readiness["warnings"][0]["code"] == "limited_text_sources_present"
    assert readiness["warnings"][0]["scope"] == "non_primary_records"
    assert readiness["warnings"][0]["action_required"] is False


def test_validate_manuscript_repairs_patient_total_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 3},
        "primary_effect": {"n_studies": 3, "pooled_effect": 0.73, "ci_lower": 0.62, "ci_upper": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nThe primary analysis included 1703 critically ill patients. RR 0.73."

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    issue = next(item for item in report["issues"] if item["kind"] == "patient_total_mismatch")
    assert issue["severity"] == "fixed"
    assert issue["claimed_total"] == 1703
    assert issue["selected_total"] == 1535
    assert "1,535 critically ill patients" in repaired
    assert "1703 critically ill patients" not in repaired


def test_validate_manuscript_accepts_source_backed_patient_total() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 3},
        "primary_effect": {"n_studies": 3, "pooled_effect": 0.73, "ci_lower": 0.62, "ci_upper": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nThe primary analysis included 1535 critically ill patients. RR 0.73."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert not any(item["kind"] == "patient_total_mismatch" for item in report["issues"])


def test_validate_manuscript_preserves_arm_level_event_denominators() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Abstract\n"
        "The primary meta-analysis included 2 studies totaling 12,251 participants. "
        "Primary outcome events occurred in 927/6,128 participants in the intervention groups "
        "and 1,121/6,123 in the control groups. HR 0.81 (95% CI 0.74 to 0.88)."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "927/6,128 participants" in repaired
    assert "927/12,251 participants" not in repaired
    assert not any(item["kind"] == "patient_total_mismatch" for item in report["issues"])


def test_validate_manuscript_repairs_arm_level_event_denominator_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {
            "selected_events_intervention": 927,
            "selected_total_intervention": 6128,
            "selected_events_control": 1121,
            "selected_total_control": 6123,
            "selected_total_participants": 12251,
        },
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Abstract\n"
        "The primary meta-analysis included 2 studies totaling 12,251 participants. "
        "Primary outcome events occurred in 927/12,251 participants in the intervention groups "
        "and 1,121/6,123 in the control groups. HR 0.81 (95% CI 0.74 to 0.88)."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    issue = next(item for item in report["issues"] if item["kind"] == "arm_event_denominator_mismatch")
    assert issue["severity"] == "fixed"
    assert issue["arm"] == "intervention"
    assert issue["observed_total"] == 12251
    assert issue["expected_total"] == 6128
    assert "927/6,128 participants in the intervention groups" in repaired
    assert "927/12,251 participants in the intervention groups" not in repaired


def test_validate_manuscript_repairs_arm_level_of_total_denominator_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {
            "selected_events_intervention": 927,
            "selected_total_intervention": 6128,
            "selected_events_control": 1121,
            "selected_total_control": 6123,
            "selected_total_participants": 12251,
        },
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Abstract\n"
        "The primary meta-analysis included 2 trials totaling 12,251 participants. "
        "Primary outcome events occurred in 927 of 12,251 participants in the intervention groups "
        "and 1,121 of 12,251 participants in the control groups. HR 0.81 (95% CI 0.74 to 0.88)."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    fixed = [item for item in report["issues"] if item["kind"] == "arm_event_denominator_mismatch"]
    assert len(fixed) == 2
    assert "927 of 6,128 participants in the intervention groups" in repaired
    assert "1,121 of 6,123 participants in the control groups" in repaired
    assert "927 of 12,251 participants in the intervention groups" not in repaired


def test_publication_body_polish_repairs_template_pico_sentence_and_redundant_conclusion() -> None:
    manuscript = (
        "# Title\n\n"
        "## Introduction\n"
        "This review evaluates Systemic corticosteroids (including but not limited to dexamethasone, "
        "hydrocortisone, methylprednisolone, prednisone, or prednisolone) administered via any route "
        "(intravenous, oral, or intramuscular), at any dose and duration, either as monotherapy or as "
        "part of combination therapy where corticosteroids are the index intervention being evaluated. "
        "compared with Placebo, standard of care without systemic corticosteroids, or active comparator "
        "treatments that do not include systemic corticosteroids (e.g., other immunomodulators alone). "
        "for All-cause mortality at 28 days post-randomization (or closest available time point between "
        "21 and 35 days if 28-day data is unavailable). in Adults (>=18 years) with confirmed SARS-CoV-2 "
        "infection who are critically ill, defined as requiring intensive care unit (ICU) admission, "
        "invasive mechanical ventilation, or supplemental oxygen to maintain SpO2 >=90% or PaO2/FiO2 "
        "ratio <300 mmHg.. Numeric claims in the report were anchored to the extraction table, source "
        "documentation, and statistical analysis files.\n\n"
        "## Conclusion\n"
        "The clinical interpretation is that corticosteroids provide a mortality benefit in critical COVID-19, "
        "while GRADE judgments should be interpreted alongside risk-of-bias and GRADE judgments.\n\n"
        "## Supplementary Materials\n"
        "This review evaluates raw source material for audit purposes."
    )

    polished = WritingAgent._polish_publication_body_language(manuscript)
    main = polished.split("## Supplementary Materials", 1)[0]

    assert "This review evaluates Systemic corticosteroids" not in main
    assert "The review evaluated systemic corticosteroids compared with usual care or placebo" in main
    assert "in Adults (>=18 years)" not in main
    assert "risk-of-bias and applicability judgments" in main
    assert "This review evaluates raw source material" in polished


def test_publication_body_polish_removes_internal_readiness_language() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n"
        "### Evidence-readiness status\n"
        "The final consistency check classified this run as a meta-analysis with source-verified primary rows. "
        "The evidence-readiness status was ready. Any non-blocking review warnings are preserved in the supplementary evidence file rather than omitted from the manuscript record.\n\n"
        "The trial-level table should be read as the audit trail for the pooled result. "
        "This systematic review used a prespecified workflow and retained records with incomplete source support in the evidence audit. "
        "Registry source recovery supplied remaining selected primary rows. "
        "The structured data files remain important because endpoint wording varies across trials. "
        "The statistical result itself was internally consistent, but certainty depends on trial conduct.\n\n"
        "## Discussion\n"
        "Before external use, reviewers should decide whether the pooled estimate is merely internally consistent or also clinically defensible.\n"
        "## Supplementary Materials\n"
        "### Appendix 2. Source verification for selected primary rows\n"
        "The source verification appendix can retain its technical label."
    )

    polished = WritingAgent._polish_publication_body_language(manuscript)
    main = _main_body_before_supplement(polished).lower()

    for phrase in (
        "evidence-readiness",
        "audit trail",
        "evidence audit",
        "prespecified workflow",
        "source support",
        "source recovery",
        "selected primary rows",
        "source-verified",
        "structured data files",
        "internally consistent",
    ):
        assert phrase not in main
    assert "primary analysis data" in main
    assert "protocol" in main
    assert "source verification for selected primary rows" in polished.lower()


def test_publication_body_polish_repairs_mechanical_language_glitches() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n"
        "If the source documentationed a different time point, the row was excluded. "
        "The primary outcome was 28-day mortality.. The effect was checked against the source.\n\n"
        "## Figures\n"
        "![Figure 1. Forest plot](../figures/forest_plot.png)\n\n"
        "## Supplementary Materials\n"
        "The parser stored the raw phrase documentationed for audit comparison."
    )

    polished = WritingAgent._polish_publication_body_language(manuscript)
    main = _main_body_before_supplement(polished)

    assert "documentationed" not in main
    assert "documented a different time point" in main
    assert "mortality.." not in main
    assert "](../figures/forest_plot.png)" in main
    assert "raw phrase documentationed" in polished


def test_publication_body_polish_removes_chinese_workflow_tone_from_main_text() -> None:
    manuscript = (
        "# 中文稿件\n\n"
        "## 引言\n"
        "本稿采用事实锁定写作，把选定主要行、来源摘录、效应量计算和GRADE判断连接起来。"
        "这种写法的核心价值是可审计性。\n\n"
        "## 结果\n"
        "结构化数据文件证明摘要、结果表和图形使用同一套事实。\n\n"
        "## 讨论\n"
        "审稿意见能定位至具体数据行，而非泛泛要求核对结果。"
        "本稿通过事实表回填这些字段，以减少跨章节不一致。"
        "来源核验字段、结构化证据表、提取复核界面、写作模块和数据重新生成流程不应出现在正文。\n\n"
        "## 补充材料\n"
        "来源审计附录可以保留事实锁定写作术语用于开发排查。"
    )

    polished = WritingAgent._polish_publication_body_language(manuscript)
    main = _main_body_before_supplement(polished)

    assert "事实锁定写作" not in main
    assert "结构化数据文件" not in main
    assert "同一套事实" not in main
    assert "可审计性" not in main
    assert "审稿意见能定位至具体数据行" not in main
    assert "事实表" not in main
    assert "来源核验字段" not in main
    assert "结构化证据表" not in main
    assert "提取复核界面" not in main
    assert "写作模块" not in main
    assert "数据重新生成" not in main
    assert "证据依据" in main
    assert "结果表和图形保持一致" in main
    assert "来源审计附录可以保留事实锁定写作术语" in polished


def test_publication_inline_citation_backfill_adds_citations_to_main_sections() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Abstract\nPrimary outcome OR 0.66.",
        "## Introduction\nThe intervention has been evaluated in eligible trials.",
        "## Methods\nThe review used source-verified extraction.",
        "## Results\nThe primary meta-analysis included 2 trials.",
        "## Discussion\nThe evidence should be interpreted with clinical context.",
        "## References\n[1] Smith J. Trial report.\n[2] Jones J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = backfilled.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    results = backfilled.split("## Results", 1)[1].split("## Discussion", 1)[0]
    discussion = backfilled.split("## Discussion", 1)[1].split("## References", 1)[0]
    references = backfilled.split("## References", 1)[1]
    assert "[1,2]" in introduction
    assert "[1,2]" in results
    assert "[1,2]" in discussion
    assert references.count("[1]") == 1
    assert references.count("[2]") == 1


def test_publication_figure_reference_backfill_adds_missing_figure_mentions() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Abstract\nPrimary outcome OR 0.66.",
        "## Results\nThe primary meta-analysis included 2 trials.",
        "## Discussion\nThe evidence should be interpreted with clinical context.",
        "## Figures",
        "### Figure 1. PRISMA flow diagram",
        "![Figure 1. PRISMA flow diagram](../figures/prisma_diagram.png)",
        "### Figure 2. Forest plot",
        "![Figure 2. Forest plot](../figures/forest_plot.png)",
        "## References\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_figure_references(manuscript)

    main = backfilled.split("## Figures", 1)[0]
    assert "Figure 1" in main
    assert "Figure 2" in main
    assert "Figure 1 and Figure 2" in main


def test_publication_figure_legend_backfill_adds_descriptive_legends() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Results\nFigure 1 shows the primary meta-analysis.",
        "## Figures",
        "### Figure 1. Forest plot for 28-day mortality",
        "![Figure 1. Forest plot for 28-day mortality](../figures/forest_plot.png)",
        "## References\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_figure_legends(manuscript)

    figure_section = backfilled.split("### Figure 1. Forest plot", 1)[1].split("## References", 1)[0]
    assert "Legend:" in figure_section
    assert "forest plot" in figure_section.lower()
    assert "CI=confidence interval" in figure_section


def test_publication_figure_legend_backfill_stops_before_bibliography() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Results\nFigure 1 shows the primary meta-analysis.",
        "## Figures",
        "### Figure 1. Forest plot for 28-day mortality",
        "![Figure 1. Forest plot for 28-day mortality](../figures/forest_plot.png)",
        "## Bibliography\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_figure_legends(manuscript)

    figure_section = backfilled.split("### Figure 1. Forest plot", 1)[1].split("## Bibliography", 1)[0]
    bibliography = backfilled.split("## Bibliography", 1)[1]
    assert "Legend:" in figure_section
    assert "Legend:" not in bibliography
    assert bibliography.count("[1] Smith") == 1


def test_publication_table_note_backfill_adds_abbreviation_notes() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Results\nThe primary meta-analysis included 2 trials.",
        "## Tables",
        "### Table 1. Trial-level effects",
        "| Study | OR | 95% CI | SE(log OR) | GRADE |",
        "|---|---:|---|---:|---|",
        "| Trial 1 | 0.66 | 0.53 to 0.82 | 0.11 | Moderate |",
        "## References\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_table_notes(manuscript)

    table_section = backfilled.split("### Table 1. Trial-level effects", 1)[1].split("## References", 1)[0]
    assert "Note:" in table_section
    assert "OR=odds ratio" in table_section
    assert "CI=confidence interval" in table_section
    assert "SE=standard error" in table_section
    assert "GRADE=Grading of Recommendations Assessment, Development and Evaluation" in table_section


def test_publication_table_note_backfill_stops_before_bibliography() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Results\nThe primary meta-analysis included 2 trials.",
        "## Tables",
        "### Table 1. Trial-level effects",
        "| Study | OR | 95% CI |",
        "|---|---:|---|",
        "| Trial 1 | 0.66 | 0.53 to 0.82 |",
        "## Bibliography\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_table_notes(manuscript)

    table_section = backfilled.split("### Table 1. Trial-level effects", 1)[1].split("## Bibliography", 1)[0]
    bibliography = backfilled.split("## Bibliography", 1)[1]
    assert "Note:" in table_section
    assert "OR=odds ratio" in table_section
    assert "Note:" not in bibliography
    assert bibliography.count("[1] Smith") == 1


def test_publication_figure_legend_backfill_handles_chinese_figure_heading() -> None:
    manuscript = "\n\n".join([
        "# 稿件",
        "## 结果\n图1展示主要结局的合并效应。",
        "## 图表",
        "### 图1. 28天死亡率森林图",
        "![图1. 28天死亡率森林图](../figures/forest_plot.png)",
        "## 参考文献\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_figure_legends(manuscript)

    figure_section = backfilled.split("### 图1. 28天死亡率森林图", 1)[1].split("## 参考文献", 1)[0]
    references = backfilled.split("## 参考文献", 1)[1]
    assert "图注：" in figure_section
    assert "森林图" in figure_section
    assert "图注：" not in references


def test_publication_table_note_backfill_handles_chinese_table_heading() -> None:
    manuscript = "\n\n".join([
        "# 稿件",
        "## 结果\n主要Meta分析纳入2项研究。",
        "## 表格",
        "### 表1. 研究层面效应量",
        "| 研究 | OR | 95% CI |",
        "|---|---:|---|",
        "| 研究1 | 0.66 | 0.53 to 0.82 |",
        "## 参考文献\n[1] Smith J. Trial report.",
    ])

    backfilled = WritingAgent._backfill_publication_table_notes(manuscript)

    table_section = backfilled.split("### 表1. 研究层面效应量", 1)[1].split("## 参考文献", 1)[0]
    references = backfilled.split("## 参考文献", 1)[1]
    assert "注：" in table_section
    assert "OR=优势比" in table_section
    assert "CI=置信区间" in table_section
    assert "注：" not in references


def test_validate_manuscript_does_not_treat_covid_19_as_patient_total() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 7},
        "primary_effect": {"n_studies": 7, "pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
        "primary_population": {"selected_total_participants": 1703},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Results\n"
        "The primary meta-analysis included 7 trials totaling 1,703 participants. "
        "The pooled estimate was consistent with the WHO REACT benchmark estimate for critically ill COVID-19 patients. "
        "OR 0.66 (95% CI 0.53 to 0.82)."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert "COVID-19 patients" in repaired
    assert "COVID-1,703" not in repaired
    assert not any(item["kind"] == "patient_total_mismatch" for item in report["issues"])


def test_validate_manuscript_removes_engineering_tone_from_publication_draft() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 7},
        "primary_effect": {"n_studies": 7, "pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
        "primary_population": {"selected_total_participants": 1703},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Methods\n"
        "This review was generated as a reproducibility benchmark for an automated systematic-review pipeline. "
        "The primary analysis included 1,703 participants.\n"
        "## Discussion\n"
        "This generated manuscript remains transparent about its limitations. "
        "The manuscript should remain in review status until conflicts are manually cleared. "
        "This user-facing review uses the source of truth and hard validation to produce a first-pass manuscript. "
        "If reviewer changes are made, the writing step should rerun from stored records. "
        "OR 0.66 (95% CI 0.53 to 0.82)."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "reproducibility benchmark" not in repaired
    assert "automated systematic-review pipeline" not in repaired
    assert "generated manuscript" not in repaired
    assert "manuscript should remain in review status" not in repaired.lower()
    assert "user-facing review" not in repaired
    assert "source of truth" not in repaired
    assert "hard validation" not in repaired
    assert "first-pass manuscript" not in repaired
    assert "reviewer changes" not in repaired
    assert "writing step" not in repaired
    assert "stored records" not in repaired
    assert "The primary analysis included 1,703 participants." in repaired
    assert any(item["kind"] == "publication_tone" for item in report["issues"])
    assert "publication draft" not in " ".join(item.get("message", "") for item in report["issues"]).lower()


def test_validate_manuscript_removes_chinese_workflow_tone_from_publication_draft() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## 引言\n"
        "本稿采用事实锁定写作，把选定主要行和结构化数据文件连接起来。来源核验字段来自结构化证据表。\n"
        "## 讨论\n"
        "这种写法的核心价值是可审计性，审稿意见能定位至具体数据行。"
        "若出现人工修正，全文都应随数据重新生成。"
        "合并HR为0.81（95% CI 0.74至0.88）。"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert "事实锁定写作" not in repaired
    assert "结构化数据文件" not in repaired
    assert "可审计性" not in repaired
    assert "具体数据行" not in repaired
    assert "来源核验字段" not in repaired
    assert "结构化证据表" not in repaired
    assert "全文都应随数据重新生成" not in repaired
    assert "人工修正" not in repaired
    assert "合并HR为0.81" in repaired
    assert not any(item["kind"] == "primary_ci_not_found" for item in report["issues"])
    assert any(item["kind"] == "publication_tone" for item in report["issues"])


def test_validate_manuscript_removes_process_framed_discussion_and_conclusion_only() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Discussion\n"
        "The pooled HR was 0.81 and should be interpreted through baseline risk and endpoint composition.\n\n"
        "The main strength is that all values are traceable to source quotes, extraction rows, "
        "calculation records, and the review package.\n\n"
        "Safety, kidney function, cost, patient preference, and follow-up capacity remain central to clinical use.\n\n"
        "## Conclusion\n"
        "For submission preparation, the final question is not whether sentences are fluent but whether the evidence chain is complete. "
        "SGLT2 inhibitors may reduce the primary composite outcome, but decisions should remain individualized.\n\n"
        "## Supplementary Materials\n"
        "The source audit table retains source quotes and extraction rows for reviewer checking.\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)
    main_text = repaired.split("## Supplementary Materials", 1)[0]
    supplement = repaired.split("## Supplementary Materials", 1)[1]

    assert "pooled HR was 0.81" in main_text
    assert "Safety, kidney function" in main_text
    assert "SGLT2 inhibitors may reduce" in main_text
    assert "traceable to source quotes" not in main_text
    assert "extraction rows" not in main_text
    assert "review package" not in main_text
    assert "submission preparation" not in main_text.lower()
    assert "evidence chain" not in main_text.lower()
    assert "source audit table retains source quotes" in supplement
    issue = next(item for item in report["issues"] if item["kind"] == "process_framed_discussion")
    assert issue["removed_sentences"] >= 2
    assert set(issue["sections"]) == {"Conclusion", "Discussion"}


def test_validate_manuscript_removes_chinese_process_framed_discussion_only() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## 讨论\n"
        "来源提示：3条记录使用了受限来源文本，但这些记录只用于筛选或背景。\n\n"
        "安全性解释尤其需要独立处理，容量不足、肾功能短期变化和感染风险可能影响净获益。\n\n"
        "对审稿和投稿准备而言，最后需要确认的不是语句是否流畅，而是证据链是否完整。\n\n"
        "## 结论\n"
        "SGLT2抑制剂可能降低主要复合终点风险，但仍需结合基线风险和患者偏好。\n\n"
        "## 补充材料\n"
        "来源提示：补充材料保留受限来源说明和来源核验记录。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)
    main_text = repaired.split("## 补充材料", 1)[0]
    supplement = repaired.split("## 补充材料", 1)[1]

    assert "安全性解释尤其需要独立处理" in main_text
    assert "SGLT2抑制剂可能降低" in main_text
    assert "来源提示" not in main_text
    assert "审稿和投稿准备" not in main_text
    assert "语句是否流畅" not in main_text
    assert "证据链" not in main_text
    assert "来源提示：补充材料保留" in supplement
    assert any(item["kind"] == "process_framed_discussion" for item in report["issues"])


def test_validate_manuscript_preserves_markdown_image_references() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## 图表\n"
        "### 图1. PRISMA流程图\n\n"
        "![图1. PRISMA流程图](../figures/prisma_diagram.png)\n\n"
        "图注：该流程图概述记录识别、去重、筛选、全文评估、排除原因以及纳入定量综合的研究。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert "![图1. PRISMA流程图](../figures/prisma_diagram.png)" in repaired
    assert "! [图1" not in repaired
    assert ". png" not in repaired
    assert report["passed"] is True


def test_validate_manuscript_ignores_single_study_enrollment_counts() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Results\n"
        "Two trials reported full sample sizes: EMPEROR-Preserved enrolled 5,988 participants, "
        "and DELIVER enrolled 6,263 participants. "
        "The primary synthesis included 12,251 participants."
    )

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"] == "patient_total_mismatch" for item in report["issues"])


def test_validate_manuscript_flags_primary_ci_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 3},
        "primary_effect": {"n_studies": 3, "pooled_effect": 0.73, "ci_lower": 0.62, "ci_upper": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nThe primary analysis included 1535 patients. RR 0.73 (95% CI 0.50 to 0.90)."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is False
    issue = next(item for item in report["issues"] if item["kind"] == "primary_ci_mismatch")
    assert issue["reported_ci_lower"] == 0.5
    assert issue["expected_ci_lower"] == 0.62


def test_validate_manuscript_accepts_source_backed_primary_ci() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 3},
        "primary_effect": {"n_studies": 3, "pooled_effect": 0.73, "ci_lower": 0.62, "ci_upper": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nThe primary analysis included 1535 patients. RR 0.73 (95% CI 0.62 to 0.86)."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"] == "primary_ci_mismatch" for item in report["issues"])


def test_validate_manuscript_repairs_missing_figure_reference() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = """
## Results

The pooled analysis is shown in Figure 2.

**Figure 1.** Study flow.
"""

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    issue = next(item for item in report["issues"] if item["kind"] == "missing_figure_reference")
    assert issue["severity"] == "fixed"
    assert issue["reference_number"] == 2
    assert issue["defined_figures"] == [1]
    assert "Figure 2" not in repaired


def test_validate_manuscript_repairs_missing_table_reference() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = """
## Results

Baseline characteristics are summarized in Table 2.

### Table 1

| Study | N |
|---|---:|
| Smith 2020 | 100 |
"""

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    issue = next(item for item in report["issues"] if item["kind"] == "missing_table_reference")
    assert issue["severity"] == "fixed"
    assert issue["reference_number"] == 2
    assert issue["defined_tables"] == [1]
    assert "Table 2" not in repaired


def test_validate_manuscript_repairs_word_number_primary_contribution_claim() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
        "primary_population": {"selected_total_participants": 12251},
        "prisma": {"studies_included": 7},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nSeven RCTs contributed data to the primary outcome analysis. HR 0.81 (95% CI 0.74 to 0.88)."

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Seven RCTs contributed data" not in repaired
    assert "Although 7 studies met review eligibility criteria, 2 contributed analyzable data" in repaired
    assert any(item["kind"] == "primary_availability_claim_repaired" for item in report["issues"])
    assert not any(item["kind"] == "primary_count_mismatch" for item in report["issues"])


def test_validate_manuscript_accepts_defined_figure_and_table_references() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = """
## Results

Figure 1 shows the forest plot, and Table 1 summarizes included studies.

![Figure 1: Forest plot](data:image/png;base64,abc)

### Table 1

| Study | N |
|---|---:|
| Smith 2020 | 100 |
"""

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"] == "missing_figure_reference" for item in report["issues"])
    assert not any(item["kind"] == "missing_table_reference" for item in report["issues"])


def test_writing_agent_prisma_checklist_uses_only_available_figure_refs() -> None:
    writer = WritingAgent()

    no_figures = writer._generate_prisma_checklist(
        rob_results=[StudyRoB(study_id="S1", tool_used="RoB 2")],
        grade_profile=None,
        figures_b64={},
    )
    with_figures = writer._generate_prisma_checklist(
        rob_results=[StudyRoB(study_id="S1", tool_used="RoB 2")],
        grade_profile=None,
        figures_b64={"prisma_diagram": "data:image/png;base64,a", "forest_plot": "data:image/png;base64,b"},
    )

    assert "Figure 1" not in no_figures
    assert "Figure 2" not in no_figures
    assert "Figure 4" not in no_figures
    assert "Results, Figure 1" in with_figures
    assert "Results, Figure 2" in with_figures
    assert "Results, Figure 3" not in with_figures


def test_validate_manuscript_repairs_non_primary_study_claimed_as_primary() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {
            "primary_analysis_labels": ["Smith 2020", "Jones 2021"],
            "non_primary_review_labels": ["Brown 2022"],
        },
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nBrown 2022 and Smith 2020 contributed to the primary meta-analysis."

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    issue = next(item for item in report["issues"] if item["kind"] == "non_primary_study_claim_repaired")
    assert issue["study_labels"] == ["Brown 2022"]
    assert issue["primary_analysis_labels"] == ["Smith 2020", "Jones 2021"]
    assert "Brown 2022" not in repaired
    assert not any(item["kind"] == "non_primary_study_in_primary_claim" for item in report["issues"])


def test_validate_manuscript_allows_non_primary_study_explicitly_marked_not_pooled() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {
            "primary_analysis_labels": ["Smith 2020", "Jones 2021"],
            "non_primary_review_labels": ["Brown 2022"],
        },
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Results\n"
        "Brown 2022 was included in the review but did not contribute to the primary meta-analysis. "
        "Smith 2020 and Jones 2021 contributed analyzable data to the primary meta-analysis."
    )

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"] == "non_primary_study_in_primary_claim" for item in report["issues"])


def test_validate_manuscript_allows_non_primary_study_exclusion_sensitivity_context() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {
            "primary_analysis_labels": ["Smith 2020", "Jones 2021"],
            "non_primary_review_labels": ["Gerasimos 2023"],
        },
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Results\n"
        "Sensitivity analysis showed that exclusion of Gerasimos 2023 from the broader candidate set "
        "did not materially change the pooled estimate."
    )

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"] == "non_primary_study_in_primary_claim" for item in report["issues"])


def test_validate_manuscript_flags_secondary_effect_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "secondary_effects": [
            {
                "outcome_name": "Withdrawal symptoms",
                "effect_measure": "MD",
                "pooled_effect": 18.71,
                "ci_lower": 18.58,
                "ci_upper": 18.84,
            }
        ],
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nWithdrawal symptoms: MD 12.00 (95% CI 10.00 to 15.00)."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is False
    assert any(item["kind"] == "secondary_effect_mismatch" for item in report["issues"])
    assert any(item["kind"] == "secondary_ci_mismatch" for item in report["issues"])


def test_validate_manuscript_accepts_source_backed_secondary_effect() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "secondary_effects": [
            {
                "outcome_name": "Withdrawal symptoms",
                "effect_measure": "MD",
                "pooled_effect": 18.71,
                "ci_lower": 18.58,
                "ci_upper": 18.84,
            }
        ],
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nWithdrawal symptoms: MD 18.71 (95% CI 18.58 to 18.84)."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"].startswith("secondary_") for item in report["issues"])


def test_validate_manuscript_secondary_effects_do_not_bleed_from_previous_outcome() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "secondary_effects": [
            {
                "outcome_name": "Cardiovascular death alone",
                "effect_measure": "HR",
                "pooled_effect": 0.89,
                "ci_lower": 0.79,
                "ci_upper": 1.01,
            },
            {
                "outcome_name": "First hospitalization for heart failure alone",
                "effect_measure": "HR",
                "pooled_effect": 0.76,
                "ci_lower": 0.68,
                "ci_upper": 0.84,
            },
            {
                "outcome_name": "All-cause mortality",
                "effect_measure": "HR",
                "pooled_effect": 0.97,
                "ci_lower": 0.88,
                "ci_upper": 1.06,
            },
        ],
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Results\n"
        "Cardiovascular death alone (HR=0.89, 95% CI: 0.79 to 1.01). "
        "First hospitalization for heart failure alone showed a reduction "
        "(HR=0.76, 95% CI: 0.68 to 0.84). "
        "All-cause mortality did not differ significantly "
        "(HR=0.97, 95% CI: 0.88 to 1.06)."
    )

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert not any(item["kind"].startswith("secondary_") for item in report["issues"])


def test_validate_manuscript_flags_subgroup_effect_mismatch() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {},
        "subgroup_effects": [
            {
                "analysis_group": "country",
                "outcome_name": "Smoking abstinence at 6 months - USA",
                "effect_measure": "OR",
                "pooled_effect": 1.48,
                "ci_lower": 1.10,
                "ci_upper": 1.99,
            }
        ],
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## Results\nSmoking abstinence at 6 months - USA: OR 1.20 (95% CI 0.90 to 1.60)."

    _, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is False
    issue = next(item for item in report["issues"] if item["kind"] == "subgroup_effect_mismatch")
    assert issue["analysis_group"] == "country"
    assert issue["expected_effect"] == 1.48


def test_validate_and_repair_manuscript_removes_unsafe_claims_and_adds_notes(tmp_path: Path) -> None:
    project = Project("facts", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 10})
    project.save_json("text_source_warnings.json", [{"pmid": "123"}])
    _save_verified_effect_selection(project)
    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 10},
            "screening": {"title_abstract_screened": 29},
            "eligibility": {"full_text_assessed": 5},
            "included": {"studies_included": 5},
        },
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Very low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="serious", rationale="Some concerns"),
                    GRADEDomain(domain="inconsistency", rating="serious", rationale="Wide prediction interval"),
                    GRADEDomain(domain="imprecision", rating="no concern", rationale="CI excludes null"),
                    GRADEDomain(domain="indirectness", rating="no concern", rationale="Direct population"),
                ],
            )
        ]),
    )
    manuscript = """
## Methods

    Two independent reviewers searched PubMed. Data were extracted from PubMed and an internal literature database. Publication bias was assessed via Egger's test. Formal assessment (e.g., funnel plots, ’s test) was not performed. ’s test indicated no small-study bias (*p* = 0.820). Given the small number of included studies (*n* = 5), formal assessment of publication bias (e.g., funnel plots, Egger's test) was not performed. Given fewer than 10 studies contributed to the primary analysis (*k* = 3), formal assessment of publication bias was not performed. g., funnel plots or Egger's test) was not performed, per Cochrane guidance. Publication bias was not formally assessed due to the small number of included RCTs (n = 5), consistent with Cochrane guidance. Formal assessment of publication bias was not conducted, as the number of included RCTs (*n* = 5) falls below the recommended minimum. Formal assessment of publication bias (e.g., via funnel plot, ’s test, or ) was not performed, as the number of included studies was fewer than 10.

## Results

Results: Of 5 studies screened, 3 met criteria as direct_eligible_rct and were included. No evidence of publication bias was detected. GRADE assessment rated certainty as very low, due to serious risk of bias, imprecision, and indirectness.
All five trials contributed data to the primary outcome analysis.
A random-effects meta-analysis of the five eligible RCTs yielded a pooled risk ratio.

## Discussion

The pooled RR was 0.86.
This meta-analysis of four eligible randomized controlled trials suggests benefit, with limitations in study design and precision.
"""

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "direct_eligible_rct" not in repaired
    assert "Two independent reviewers" not in repaired
    assert "searched PubMed" not in repaired
    assert "PubMed and an internal literature database" not in repaired
    assert "Information sources included OpenAlex" in repaired
    assert "Data were extracted from records retrieved via OpenAlex" in repaired
    assert "Information sources included OpenAlex." in repaired
    assert "Source audit note" not in repaired
    assert "manuscript_facts.json" not in repaired
    assert "Evidence source note" not in repaired
    assert "not formally assessed" in repaired
    assert "’s test" not in repaired
    assert "Of 29 records screened at title/abstract level" in repaired
    assert "indirectness" not in repaired
    assert "fewer than 10 studies contributed" in repaired
    assert "small number of included studies (*n* = 5)" not in repaired
    assert "small number of included RCTs (n = 5)" not in repaired
    assert "number of included RCTs (*n* = 5)" not in repaired
    assert "five eligible RCTs yielded" not in repaired
    assert "3 analyzable RCTs yielded" in repaired
    assert "or )" not in repaired
    assert "g., funnel plots" not in repaired
    assert "3 contributed analyzable data to the primary meta-analysis" in repaired
    assert "All five trials contributed data" not in repaired
    assert "four eligible randomized controlled trials" not in repaired


def test_validate_and_repair_preserves_explicit_prospero_nonregistration_statement() -> None:
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2, "pooled_effect": 0.8, "ci_lower": 0.7, "ci_upper": 0.9},
        "studies": {"primary_analysis_count": 2},
        "prisma": {"title_abstract_screened": 4, "full_text_assessed": 2, "studies_included": 2},
    }
    manuscript = (
        "## Declarations\n\n"
        "### Registration and protocol\n"
        "This review was not prospectively registered in PROSPERO. "
        "The protocol-defining PICO is preserved in protocol.json.\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert "This review was not prospectively registered in PROSPERO" in repaired
    assert not any(issue["kind"] == "unsupported_registration_claim" for issue in report["issues"])


def test_validate_manuscript_keeps_screening_only_limited_source_note_out_of_body() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": ["OpenAlex"]},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2},
        "text_sources": {
            "abstract_only_count": 3,
            "metadata_only_count": 0,
            "limited_source_count": 3,
        },
        "evidence_readiness": {
            "blockers": [],
            "warnings": [
                {
                    "code": "limited_text_sources_present",
                    "scope": "non_primary_records",
                    "action_required": False,
                }
            ],
        },
    }
    manuscript = "## Methods\nSearch methods.\n\n## Discussion\nInterpretation."

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Evidence source note" not in repaired
    assert "limited source text/metadata" not in repaired
    assert "screening/context records only" not in repaired
    assert "all extracted values from those records require manual verification" not in repaired
    issue = next(item for item in report["issues"] if item["kind"] == "limited_text_source_warning_suppressed")
    assert issue["action_required"] is False
    assert "package review" in issue["message"]


def test_validate_manuscript_inserts_publication_style_search_source_sentence() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": ["PubMed", "OpenAlex"]},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Methods\n"
        "The search strategy and eligibility criteria were prespecified.\n\n"
        "## Results\n"
        "The primary analysis included 2 studies."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Information sources included PubMed and OpenAlex." in repaired
    assert "Source audit note" not in repaired
    assert "pipeline search/retrieval record" not in repaired
    assert "manuscript_facts.json" not in repaired
    assert any(issue["kind"] == "search_source_mismatch" for issue in report["issues"])


def test_validate_manuscript_replaces_legacy_search_source_audit_note() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": ["PubMed", "OpenAlex"]},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Methods\n\n"
        "Source audit note: The pipeline search/retrieval record includes PubMed, OpenAlex. "
        "Manuscript source descriptions should be interpreted according to the accompanying "
        "manuscript_facts.json audit file.\n\n"
        "The search strategy and eligibility criteria were prespecified.\n\n"
        "## Results\n"
        "The primary analysis included 2 studies."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Information sources included PubMed and OpenAlex." in repaired
    assert "Source audit note" not in repaired
    assert "pipeline search/retrieval record" not in repaired
    assert "manuscript_facts.json" not in repaired
    assert any(issue["kind"] == "search_source_mismatch" for issue in report["issues"])


def test_validate_manuscript_uses_chinese_search_source_note_for_chinese_manuscript() -> None:
    facts = {
        "output_language": "zh",
        "report_type": "meta",
        "search": {"source_names": ["internal literature database", "OpenAlex"]},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = "## 方法\n检索覆盖内部文献库。\n\n## 结果\n主要分析纳入2项研究。"

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "检索和来源获取覆盖医学文献索引、OpenAlex。" in repaired
    assert "来源审计提示" not in repaired
    assert "内部文献库" not in repaired
    assert "manuscript_facts.json" not in repaired
    assert "Source audit note" not in repaired
    assert "internal literature database" not in repaired
    issue = next(item for item in report["issues"] if item["kind"] == "search_source_mismatch")
    assert "OpenAlex" in issue["message"]


def test_validate_manuscript_replaces_overstated_limited_source_caution() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": ["OpenAlex"]},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {"n_studies": 2},
        "text_sources": {
            "abstract_only_count": 3,
            "metadata_only_count": 0,
            "limited_source_count": 3,
        },
        "evidence_readiness": {
            "blockers": [],
            "warnings": [
                {
                    "code": "limited_text_sources_present",
                    "scope": "non_primary_records",
                    "action_required": False,
                }
            ],
        },
    }
    manuscript = (
        "## Methods\nSearch methods.\n\n"
        "Evidence source caution: 3 retrieved/screened record(s) used limited source text/metadata "
        "because publisher full text/PDF or registry outcome data could not be retrieved automatically; "
        "all extracted values from those records require manual verification before external use, and "
        "metadata-only records require user-uploaded full text before extraction.\n\n"
        "## Discussion\nInterpretation."
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Evidence source note" not in repaired
    assert "screening/context records only" not in repaired
    assert "limited source text/metadata" not in repaired
    assert "all extracted values from those records require manual verification" not in repaired
    assert any(item["kind"] == "limited_text_source_warning_repaired" for item in report["issues"])


def test_evidence_readiness_blocks_publication_style_report_for_unverified_primary_row(tmp_path: Path) -> None:
    project = Project("readiness", output_dir=tmp_path)
    project.save_json("text_source_warnings.json", [{"pmid": "S1", "title": "Blocked PDF"}])
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {
                "rows_requiring_review": 2,
                "conflict_rows": 1,
            }
        },
        subdir="extraction",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "Mortality was lower in the treatment arm.",
                "source_location": "Abstract",
                "source_quote_verified": False,
                "extraction_confidence": "medium",
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:0",
                "study_id": "S2",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )
    repaired, report = validate_and_repair_manuscript("## Results\n\nPooled RR was 0.86.", facts)

    assert facts["report_type"] == "evidence_gap"
    assert facts["evidence_readiness"]["status"] == "blocked"
    assert {
        "abstract_only_primary_effect",
        "unverified_primary_source_quote",
        "low_confidence_primary_extraction",
        "primary_timepoint_not_source_verified",
    }.issubset(set(facts["evidence_readiness"]["blocker_codes"]))
    assert report["passed"] is False
    assert "Evidence readiness warning" in repaired
    assert any(issue["kind"] == "evidence_readiness_blocker" for issue in report["issues"])


def test_evidence_readiness_allows_explicit_timepoint_adjudication_with_warning(tmp_path: Path) -> None:
    project = Project("timepoint-adjudication", output_dir=tmp_path)
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "The primary outcome was 21-day mortality or respiratory support: 2/10 vs 3/20.",
                "source_location": "Abstract",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "accepted_timepoint": "21-day mortality or respiratory support",
                "timepoint_adjudication_note": "Accepted closest CAPE COVID endpoint per protocol review.",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:0",
                "study_id": "S2",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported: 2/10 vs 3/20.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S3:0",
                "study_id": "S3",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported: 2/10 vs 3/20.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    assert facts["report_type"] == "meta"
    assert readiness["status"] == "needs_review"
    assert "primary_timepoint_not_source_verified" not in readiness["blocker_codes"]
    assert any(item["code"] == "primary_timepoint_adjudicated" for item in readiness["warnings"])
    assert readiness["selected_primary_rows"][0]["timepoint_adjudication_note"].startswith("Accepted closest")


def test_evidence_readiness_blocks_when_primary_counts_are_not_source_backed(tmp_path: Path) -> None:
    project = Project("count-source", output_dir=tmp_path)
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported with 2 deaths in treatment and 3 deaths in control.",
                "source_location": "Abstract",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:0",
                "study_id": "S2",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported: 2/10 vs 3/20.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S3:0",
                "study_id": "S3",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "28-day mortality was reported: 2/10 vs 3/20.",
                "source_location": "Table 2",
                "source_quote_verified": True,
                "extraction_confidence": "high",
                "events_intervention": 2,
                "total_intervention": 10,
                "events_control": 3,
                "total_control": 20,
                "in_final_primary_analysis": True,
            },
        ],
        subdir="analysis",
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    assert facts["report_type"] == "evidence_gap"
    assert "primary_counts_not_source_verified" in readiness["blocker_codes"]
    blocker = next(item for item in readiness["blockers"] if item["code"] == "primary_counts_not_source_verified")
    assert blocker["row_id"] == "S1:0"
    assert "total_intervention=10" in blocker["missing_values"]
    assert "total_control=20" in blocker["missing_values"]


def test_evidence_readiness_inherits_selected_row_review_flags_from_extraction_audit(tmp_path: Path) -> None:
    project = Project("selected-review-join", output_dir=tmp_path)
    project.save_json(
        "extraction_audit.json",
        {
            "summary": {"rows_requiring_review": 1, "conflict_rows": 1},
            "rows": [
                {
                    "row_id": "S1:0",
                    "study_id": "S1",
                    "outcome_name": "28-day all-cause mortality",
                    "source_quote": "28-day mortality was reported: 2/10 vs 3/20.",
                    "source_quote_verified": True,
                    "requires_review": True,
                    "conflicts": [
                        {
                            "field": "events_intervention",
                            "message": "Abstract says 2 deaths; table appears to say 3 deaths.",
                        }
                    ],
                }
            ],
        },
        subdir="extraction",
    )
    _save_verified_effect_selection(project)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    readiness = facts["evidence_readiness"]
    warning_codes = {item["code"] for item in readiness["warnings"]}
    selected_s1 = next(row for row in readiness["selected_primary_rows"] if row["row_id"] == "S1:0")
    assert facts["report_type"] == "meta"
    assert readiness["status"] == "needs_review"
    assert "unresolved_extraction_review_rows" in warning_codes
    assert "unresolved_extraction_conflicts" in warning_codes
    assert readiness["extraction_backlog"]["selected_primary_review_rows"] == 1
    assert readiness["extraction_backlog"]["selected_primary_conflict_rows"] == 1
    assert selected_s1["requires_review"] is True
    assert selected_s1["conflicts"][0]["field"] == "events_intervention"


def test_evidence_readiness_blocks_when_primary_effect_audit_is_missing(tmp_path: Path) -> None:
    project = Project("missing-audit", output_dir=tmp_path)
    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )
    assert facts["report_type"] == "evidence_gap"
    assert "missing_primary_effect_audit" in facts["evidence_readiness"]["blocker_codes"]


def test_writing_agent_routes_evidence_gap_to_deterministic_report_without_llm(tmp_path: Path) -> None:
    project = Project("writing-gap", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 10})
    project.save_json("text_source_warnings.json", [{"pmid": "S1", "title": "Blocked PDF"}])
    project.add_warning(
        "fulltext_retrieval",
        "JAMA PDF returned HTTP 403",
        code="publisher_pdf_forbidden",
        context={"doi": "10.1001/jama.2020.17023"},
    )
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 1, "conflict_rows": 1}},
        subdir="extraction",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "study_id": "S1",
                "outcome_name": "28-day all-cause mortality",
                "source_quote": "Mortality was lower in the treatment arm.",
                "source_location": "Abstract",
                "source_quote_verified": False,
                "extraction_confidence": "medium",
                "in_final_primary_analysis": True,
            }
        ],
        subdir="analysis",
    )

    writer = WritingAgent()

    def fail_llm(*args, **kwargs):
        raise AssertionError("evidence-gap writing should not call the LLM")

    writer.call_llm = fail_llm
    writer.call_llm_structured = fail_llm
    manuscript = writer.run(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 10, "records_after_dedup": 10},
            "screening": {"title_abstract_screened": 10},
            "eligibility": {"full_text_assessed": 2},
            "included": {"studies_included": 2},
        },
        project=project,
    )
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    saved = project.load_text("draft.md", subdir="manuscript")

    assert "Systematic Review Evidence-Gap Report" in manuscript
    assert "Blocking Reasons" in manuscript
    assert "Retrieval and Processing Notes" in manuscript
    assert "publisher_pdf_forbidden" in manuscript
    assert "abstract_only_primary_effect" in manuscript
    assert "## Abstract" not in manuscript
    assert validation["facts_summary"]["pipeline_warning_count"] == 1
    assert validation["passed"] is False
    assert validation["facts_summary"]["report_type"] == "evidence_gap"
    assert saved == manuscript


def test_evidence_gap_warning_note_is_idempotent_across_validation_passes() -> None:
    manuscript = """# Evidence-gap report

## Retrieval and Processing Notes
1 run-level warning was recorded.

## Recommended Next Actions
Recover the primary sources.
"""
    repaired, issues = _ensure_pipeline_warning_note(
        manuscript,
        {
            "report_type": "evidence_gap",
            "pipeline_warnings": [{"stage": "retrieval", "code": "source_unavailable"}],
        },
    )
    assert repaired == manuscript
    assert issues == []
    assert repaired.count("## Retrieval and Processing Notes") == 1


def test_writing_agent_falls_back_to_deterministic_meta_report_when_llm_fails(tmp_path: Path) -> None:
    project = Project("writing-meta-fallback", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 12, "ClinicalTrials.gov": 1})
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_verified_effect_selection(project)

    writer = WritingAgent()

    def fail_llm(*args, **kwargs):
        raise RuntimeError("provider unavailable")

    writer.call_llm = fail_llm
    writer.call_llm_structured = fail_llm
    manuscript = writer.run(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 12, "records_after_dedup": 10},
            "screening": {"title_abstract_screened": 10},
            "eligibility": {"full_text_assessed": 4},
            "included": {"studies_included": 3},
        },
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Low",
            )
        ]),
    )
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")

    assert facts["report_type"] == "meta"
    assert facts["evidence_readiness"]["blocker_codes"] == []
    assert "## Abstract" in manuscript
    assert "## Methods" in manuscript
    assert "## Results" in manuscript
    assert "RR 0.86" in manuscript
    assert "ClinicalTrials.gov" in manuscript
    assert "Evidence-Gap" not in manuscript
    assert validation["passed"] is True


def test_writing_agent_uses_fact_locked_meta_writer_before_llm_for_ready_runs(tmp_path: Path) -> None:
    project = Project("writing-fact-locked-first", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 12, "ClinicalTrials.gov": 1})
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_verified_effect_selection(project)

    calls = {"count": 0}
    writer = WritingAgent()

    def fail_if_called(*args, **kwargs):
        calls["count"] += 1
        raise RuntimeError("provider unavailable")

    writer.call_llm = fail_if_called
    writer.call_llm_structured = fail_if_called
    manuscript = writer.run(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 12, "records_after_dedup": 10},
            "screening": {"title_abstract_screened": 10},
            "eligibility": {"full_text_assessed": 4},
            "included": {"studies_included": 3},
        },
        search_query="COVID-19 AND corticosteroids AND mortality",
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Low",
            )
        ]),
    )
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    semantic_audit = project.load_json("manuscript_semantic_edit_audit.json", subdir="manuscript")

    assert calls["count"] > 0
    assert "## Abstract" in manuscript
    assert "## Methods" in manuscript
    assert "## Results" in manuscript
    assert "RR 0.86" in manuscript
    assert validation["passed"] is True
    assert semantic_audit["status"] == "failed"


def test_writing_agent_uses_generic_fact_locked_writer_for_non_covid_meta(tmp_path: Path) -> None:
    project = Project("writing-generic-fact-locked", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 20})
    project.save_json("meta_results.json", _sglt2_meta().model_dump(), subdir="analysis")
    project.add_warning(
        "retrieval",
        "ClinicalTrials.gov fallback had 2 failed request(s); registry-first trials may be missing.",
        code="clinicaltrials_fallback_failed",
    )
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_sglt2_effect_selection(project)
    ref_manager = ReferenceManager()
    ref_manager.add(
        {
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "authors": ["Anker SD"],
            "journal": "New England Journal of Medicine",
            "year": 2021,
            "doi": "10.1056/NEJMoa2107038",
            "pmid": "34449189",
        },
        study_id="34449189",
    )
    ref_manager.add(
        {
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "authors": ["Solomon SD"],
            "journal": "New England Journal of Medicine",
            "year": 2022,
            "doi": "10.1056/NEJMoa2206286",
            "pmid": "36027570",
        },
        study_id="36027570",
    )

    calls = {"count": 0}
    writer = WritingAgent()

    def fail_if_called(*args, **kwargs):
        calls["count"] += 1
        raise RuntimeError("provider unavailable")

    writer.call_llm = fail_if_called
    writer.call_llm_structured = fail_if_called
    manuscript = writer.run(
        protocol=_sglt2_protocol(),
        meta_results=_sglt2_meta(),
        prisma_data={
            "identification": {"records_identified": 781, "records_after_dedup": 20, "duplicates_removed": 761},
            "screening": {"title_abstract_screened": 20},
            "eligibility": {"full_text_assessed": 10},
            "included": {"studies_included": 2},
        },
        search_query="SGLT2 inhibitors AND HFpEF AND cardiovascular death",
        project=project,
        ref_manager=ref_manager,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
                n_studies=2,
                effect_summary="HR 0.81 (95% CI 0.74 to 0.88)",
                certainty="Low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="some concerns", rationale="Some concerns require review"),
                    GRADEDomain(domain="inconsistency", rating="no concern", rationale="I-squared=0%"),
                    GRADEDomain(domain="indirectness", rating="serious", rationale="Directness fields require verification"),
                    GRADEDomain(domain="imprecision", rating="no concern", rationale="Total N=12251 vs OIS=600"),
                    GRADEDomain(domain="publication_bias", rating="no concern", rationale="Not formally assessed because fewer than 10 studies contributed"),
                ],
            )
        ]),
    )
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    warnings = project.load_json("pipeline_warnings.json") or []
    semantic_audit = project.load_json("manuscript_semantic_edit_audit.json", subdir="manuscript")

    assert calls["count"] > 0
    assert semantic_audit["status"] == "failed"
    assert len(manuscript.split()) > 3800
    title = manuscript.splitlines()[0]
    assert title == "# SGLT2 inhibitors for cardiovascular death or heart failure hospitalization in heart failure with mildly reduced or preserved ejection fraction: a systematic review and meta-analysis"
    abstract = manuscript.split("## Introduction", 1)[0]
    assert "SGLT2 inhibitors compared with placebo" in abstract
    assert "SGLT2 inhibitors may reduce the risk" in abstract
    assert "SGLT2 inhibitors was associated" not in abstract
    assert "cardiovascular death or heart failure hospitalization" in abstract
    assert "at any approved dose" not in abstract
    assert "standard background heart failure therapy" not in abstract
    assert "SGLT2 inhibitors" in manuscript
    assert "HFpEF" in manuscript or "preserved ejection fraction" in manuscript
    assert "HR 0.81" in manuscript
    assert "12,251 participants" in manuscript
    assert "927/6128" in manuscript
    assert "1121/6123" in manuscript
    assert "Empagliflozin in Heart Failure with a Preserved Ejection Fraction" in manuscript
    assert "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction" in manuscript
    assert "Systemic corticosteroids" not in manuscript
    assert "critically ill adults with COVID-19" not in manuscript
    assert "deaths in the corticosteroid groups" not in manuscript
    assert "data:image/" not in manuscript
    assert "artifact" not in manuscript.lower()
    assert "published-anchor" not in manuscript
    main_body = _main_body_before_supplement(manuscript).lower()
    for phrase in (
        "automated",
        "user-facing",
        "source-linked",
        "source-audit",
        "source-review",
        "source of truth",
        "fact-locked",
        "fact table",
        "hard validation",
        "first-pass",
        "stored records",
        "reviewer changes",
        "writing step",
        "checkpointed",
        "trust chain",
        "pipeline",
        "retrieval warnings",
        "extraction record",
        "candidate primary row",
        "review item",
        "pdf parser",
        "source checking",
        "documentation status",
        "effect-size layers",
        "the manuscript therefore",
        "for a manuscript",
        "manuscript tables",
    ):
        assert phrase not in main_body
    assert "retrieval and processing notes" not in manuscript.lower()
    assert "clinicaltrials_fallback_failed" not in manuscript
    assert validation["facts_summary"]["pipeline_warning_count"] == 1
    assert any(item.get("code") == "clinicaltrials_fallback_failed" for item in warnings)
    assert "source documentation for included primary comparisons" in manuscript.lower()
    assert validation["passed"] is True


def test_writing_agent_semantic_editor_accepts_fact_preserving_open_section_patch(tmp_path: Path) -> None:
    writer = WritingAgent()
    project = Project("semantic editor", output_dir=tmp_path)
    manuscript = (
        "# Title\n\n"
        "## Introduction\n\n"
        "The review addressed mortality [1].\n\n"
        "## Methods\n\n"
        "Methods are fact locked.\n\n"
        "## Results\n\n"
        "RR 0.86 (95% CI 0.75 to 1.00) [1].\n\n"
        "## Discussion\n\n"
        "The pooled RR was 0.86 [1].\n\n"
        "## Conclusion\n\n"
        "The pooled RR was 0.86 [1].\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )
    facts = {
        "report_type": "meta",
        "output_language": "en",
        "primary_effect": {"n_studies": 3, "effect_measure": "RR", "pooled_effect": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "grade": {"outcomes": [{"certainty": "Low", "effect_summary": "RR 0.86 (95% CI 0.75 to 1.00)"}]},
        "study_cards": [],
        "evidence_readiness": {"warnings": []},
    }

    def semantic_response(query, schema, **kwargs):
        return schema(
            summary="Discussion needed a clinical interpretive sentence.",
            patches=[
                {
                    "heading": "Discussion",
                    "replacement_markdown": (
                        "The pooled RR was 0.86 [1]. The estimate remains tied to the enrolled trial populations, "
                        "so interpretation should also consider baseline risk and the certainty of evidence."
                    ),
                    "reason": "Add clinical interpretation without changing protected facts.",
                }
            ],
            issues=[],
        )

    writer.call_llm_structured = semantic_response

    edited, audit = writer._semantic_edit_open_sections(manuscript, facts, project=project)

    assert audit["accepted_patches"] == 1
    assert audit["rejected_patches"] == 0
    assert "baseline risk" in edited
    assert "0.86 [1]" in edited
    assert "Methods are fact locked" in edited


def test_writing_agent_semantic_editor_uses_llm_clinical_review_brief(tmp_path: Path) -> None:
    writer = WritingAgent()
    project = Project("semantic editor review brief", output_dir=tmp_path)
    manuscript = (
        "# Title\n\n"
        "## Introduction\n\n"
        "The review addressed mortality [1].\n\n"
        "## Methods\n\n"
        "Methods were prespecified.\n\n"
        "## Results\n\n"
        "RR 0.86 (95% CI 0.75 to 1.00) [1].\n\n"
        "## Discussion\n\n"
        "The pooled RR was 0.86 [1].\n\n"
        "## Conclusion\n\n"
        "The pooled RR was 0.86 [1].\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )
    facts = {
        "report_type": "meta",
        "output_language": "en",
        "primary_effect": {"n_studies": 3, "effect_measure": "RR", "pooled_effect": 0.86},
        "primary_population": {"selected_total_participants": 1535},
        "grade": {"outcomes": [{"certainty": "Low", "effect_summary": "RR 0.86 (95% CI 0.75 to 1.00)"}]},
        "study_cards": [{"study_id": "Trial 1", "distinctive_feature": "open-label pragmatic trial"}],
        "evidence_readiness": {"warnings": []},
    }
    prompts: list[str] = []

    def semantic_response(query, schema, **kwargs):
        prompts.append(query)
        if schema.__name__ == "ClinicalManuscriptReview":
            return schema(
                summary="Discussion lacks a clinical limitation.",
                priority_issues=[
                    {
                        "heading": "Discussion",
                        "severity": "major",
                        "problem": "Limitation is too generic.",
                        "revision_instruction": "Make the limitation concrete using the open-label trial feature.",
                        "evidence_basis": "study_cards[0].distinctive_feature",
                    }
                ],
                global_editing_instructions=["Avoid template-like method commentary."],
                unsafe_to_fix_without_new_sources=[],
                citation_or_source_concerns=[],
            )
        if schema.__name__ == "SemanticGuardAdjudication":
            return schema(
                accept=True,
                reason="The added open-label context is present in the structured study card and does not alter the effect.",
            )
        return schema(
            summary="Applied clinical review brief.",
            patches=[
                {
                    "heading": "Discussion",
                    "replacement_markdown": (
                        "The pooled RR was 0.86 [1]. The estimate should be interpreted with attention to the "
                        "open-label pragmatic trial context already represented in the included evidence."
                    ),
                    "reason": "Make limitation concrete without changing protected facts.",
                }
            ],
            issues=[],
        )

    writer.call_llm_structured = semantic_response

    edited, audit = writer._semantic_edit_open_sections(manuscript, facts, project=project)

    assert audit["clinical_review"]["status"] == "ok"
    assert audit["clinical_review"]["priority_issue_count"] == 1
    assert audit["accepted_patches"] == 1
    assert "open-label pragmatic trial context" in edited
    assert any("CLINICAL REVIEW BRIEF" in prompt for prompt in prompts)
    assert any("Make the limitation concrete" in prompt for prompt in prompts)


def test_final_manuscript_readiness_prompt_is_peer_review_not_rewrite() -> None:
    writer = WritingAgent()
    prompt = writer._final_manuscript_readiness_prompt(
        "# Title\n\n## Abstract\n\n**Results:** HR 0.81.\n\n## Discussion\n\nClinical interpretation.",
        {
            "report_type": "meta",
            "manuscript_mode": "clinical_meta_analysis",
            "primary_effect": {"n_studies": 2, "effect_measure": "HR", "pooled_effect": 0.81},
            "source_provenance": {"counts": {"primary_report": 2}, "publication_blocking_count": 0},
            "grade": {"outcomes": [{"certainty": "High"}]},
            "evidence_readiness": {"status": "ready", "blocker_codes": [], "warnings": []},
        },
        validation={"passed": True, "issues": []},
        quality_gate={"passed": True, "summary": {"issue_count": 0}, "issues": []},
        submission_quality_gate={"status": "pass", "failed_count": 0, "warning_count": 0, "checks": []},
    )

    assert "final senior peer reviewer" in prompt
    assert "not a rewrite task" in prompt
    assert "primary-source provenance" in prompt
    assert "citation support" in prompt
    assert "Do NOT mention AI, automation, pipelines" in prompt
    assert "If fewer than three studies contribute" in prompt
    assert "DECISION DEFINITIONS" in prompt
    assert "major_revision" in prompt
    assert "not_ready" in prompt
    assert "submission_quality_gate" in prompt
    assert "do not mark the manuscript ready" in prompt


def test_final_readiness_sanitizer_blocks_ready_when_submission_gate_fails() -> None:
    review = {
        "decision": "ready",
        "safe_to_submit_without_human_review": True,
        "issues": [],
    }
    sanitized = WritingAgent._sanitize_final_readiness_review_payload(
        review,
        validation={"passed": True},
        quality_gate={"passed": True},
        submission_quality_gate={
            "status": "fail",
            "checks": [
                {
                    "name": "claim_map_authoring",
                    "status": "fail",
                    "message": "claim_map_authoring_audit.json is required.",
                }
            ],
        },
        citation_audit={"passed": True},
    )

    assert sanitized["decision"] == "not_ready"
    assert sanitized["safe_to_submit_without_human_review"] is False
    assert any(issue.get("code") == "submission_quality_gate_failed" for issue in sanitized["issues"])


def test_semantic_paragraph_targets_low_k_heterogeneity_overinterpretation() -> None:
    paragraph = (
        "No formal small-study-effect inference is appropriate from such a sparse set of contributing trials. "
        "The absence of a strong heterogeneity signal is reassuring for direction, but it cannot rule out clinical differences."
    )
    softened_but_still_wrong = (
        "The absence of a strong heterogeneity signal supports the direction of effect, but it cannot rule out clinical differences."
    )

    assert WritingAgent._semantic_paragraph_needs_llm_edit(paragraph) is True
    assert WritingAgent._semantic_paragraph_needs_llm_edit(softened_but_still_wrong) is True


def test_semantic_paragraph_delete_is_limited_to_redundant_nonfactual_text() -> None:
    assert WritingAgent._semantic_paragraph_deletion_is_safe(
        "Clinical use should consider baseline risk and patient preferences.",
        reason="Redundant caveat already consolidated in the preceding paragraph.",
    ) is True
    assert WritingAgent._semantic_paragraph_deletion_is_safe(
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88) [1].",
        reason="Redundant caveat.",
    ) is False
    assert WritingAgent._semantic_paragraph_deletion_is_safe(
        "Applied to observed risk, the effect corresponds to NNTB 31.",
        reason="Redundant caveat.",
    ) is False


def test_final_readiness_issue_mentions_expand_paragraph_edit_headings() -> None:
    headings = WritingAgent._final_issue_mentioned_headings({
        "section": "Discussion",
        "problem": "Safety caveats are repeated in Introduction and Results.",
        "evidence": "The Introduction and Results both mention the same limitation.",
        "action": "Consolidate this point in the limitations paragraph.",
    })

    assert "Discussion" in headings
    assert "Introduction" in headings
    assert "Results" in headings


def test_final_review_subsection_targets_discussion_clinical_application() -> None:
    writer = WritingAgent()
    manuscript = (
        "## Discussion\n\n"
        "Opening paragraph.\n\n"
        "### Clinical application\n\n"
        "Clinical use should translate the pooled HR into absolute risk. "
        "Applicability depends on baseline risk and safety monitoring.\n\n"
        "### Strengths and limitations\n\n"
        "Safety outcomes require separate interpretation.\n"
    )
    review = {
        "issues": [{
            "severity": "minor",
            "section": "Discussion",
            "problem": "Repetition in the Clinical application subsection.",
            "evidence": "Clinical application repeats safety and applicability caveats.",
            "action": "Consolidate the Clinical application subsection into one cohesive paragraph.",
            "requires_new_source": False,
        }]
    }

    targets = writer._final_review_subsection_targets(manuscript, review)

    assert targets
    assert targets[0]["parent_heading"] == "Discussion"
    assert targets[0]["subsection_heading"] == "Clinical application"


def test_final_review_subsection_targets_ignore_comparison_section_mentions() -> None:
    writer = WritingAgent()
    manuscript = (
        "## Methods\n\n"
        "### Information sources and search strategy\n\n"
        "The search covered PubMed.\n\n"
        "## Discussion\n\n"
        "### Clinical application\n\n"
        "Clinical use should translate the pooled HR into absolute risk.\n"
    )
    review = {
        "issues": [{
            "severity": "minor",
            "section": "Discussion",
            "problem": "Citation density is lower than in Methods.",
            "evidence": "Quality gate warning: Discussion citation density is lower than Methods citation density.",
            "action": "Add support to Discussion interpretive claims in Clinical application.",
            "requires_new_source": False,
        }]
    }

    targets = writer._final_review_subsection_targets(manuscript, review)

    assert targets
    assert {target["parent_heading"] for target in targets} == {"Discussion"}


def test_replace_h3_subsection_body_only_replaces_requested_subsection() -> None:
    manuscript = (
        "## Discussion\n\n"
        "Opening paragraph.\n\n"
        "### Clinical application\n\n"
        "Old body.\n\n"
        "### Strengths and limitations\n\n"
        "Limitations body.\n"
    )

    repaired = WritingAgent._replace_h3_subsection_body(
        manuscript,
        parent_heading="Discussion",
        subsection_heading="Clinical application",
        replacement_body="New body.",
    )

    assert "### Clinical application\n\nNew body." in repaired
    assert "### Strengths and limitations\n\nLimitations body." in repaired
    assert "Old body." not in repaired


def test_citation_grounding_guard_allows_only_existing_citation_additions() -> None:
    original = "Clinical use should account for baseline risk and monitoring needs."
    replacement = "Clinical use should account for baseline risk and monitoring needs [3]."

    assert WritingAgent._citation_grounding_guard_issues(original, replacement, {1, 2, 3}) == []
    assert WritingAgent._citation_grounding_guard_issues(original, replacement, {1, 2})[0]["code"] == "invalid_reference_number"
    changed = "Clinical use should account for baseline risk, cost, and monitoring needs [3]."
    assert any(
        issue["code"] == "citation_patch_changed_text"
        for issue in WritingAgent._citation_grounding_guard_issues(original, changed, {1, 2, 3})
    )


def test_citation_grounding_guard_allows_new_anchor_for_existing_reference_numbers() -> None:
    original = (
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88). "
        "The included trials contributed 12,251 participants [1,2]."
    )
    replacement = (
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88) [1,2]. "
        "The included trials contributed 12,251 participants [1,2]."
    )

    assert WritingAgent._citation_grounding_guard_issues(original, replacement, {1, 2}) == []


def test_citation_grounding_targets_follow_final_review_issue_order() -> None:
    writer = WritingAgent()
    manuscript = (
        "## Methods\n\n"
        "The protocol reference is reported in the appendix [20].\n\n"
        "Method paragraph two has enough words to be a citation target if selected.\n\n"
        "## Discussion\n\n"
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88). The included studies were cited later [1,2].\n\n"
        "## References\n\n"
        "[1] Trial one.\n[2] Trial two.\n[20] Protocol.\n"
    )
    review = {
        "issues": [
            {
                "section": "Discussion",
                "problem": "Numeric effect claim lacks citation.",
                "action": "Add inline citations [1,2] to the pooled HR sentence.",
                "requires_new_source": False,
            },
            {
                "section": "Methods",
                "problem": "Protocol reference clarity.",
                "action": "Check reference [20].",
                "requires_new_source": False,
            },
        ]
    }

    targets, _paragraphs = writer._citation_grounding_targets(manuscript, review, max_targets=1)

    assert targets[0]["heading"] == "Discussion"


def test_citation_grounding_targets_are_distributed_across_issue_sections() -> None:
    writer = WritingAgent()
    discussion_paragraphs = "\n\n".join(
        f"Discussion paragraph {idx} reports HR 0.81 and needs support [1,2]."
        for idx in range(1, 8)
    )
    manuscript = (
        "## Discussion\n\n"
        f"{discussion_paragraphs}\n\n"
        "## Conclusion\n\n"
        "The conclusion reports HR 0.81 (95% CI 0.74 to 0.88).\n\n"
        "## References\n\n"
        "[1] Trial one.\n[2] Trial two.\n"
    )
    review = {
        "issues": [
            {
                "section": "Discussion",
                "problem": "Numeric effect claim lacks citation.",
                "action": "Add inline citations [1,2].",
                "requires_new_source": False,
            },
            {
                "section": "Conclusion",
                "problem": "Numeric effect claim lacks citation.",
                "action": "Add inline citations [1,2].",
                "requires_new_source": False,
            },
        ]
    }

    targets, _paragraphs = writer._citation_grounding_targets(manuscript, review, max_targets=6)
    headings = [target["heading"] for target in targets]

    assert "Discussion" in headings
    assert "Conclusion" in headings
    assert headings.index("Conclusion") <= 4


def test_reference_inventory_from_manuscript_parses_numbered_entries() -> None:
    manuscript = (
        "## References\n"
        "[1] Trial report. *Journal*. 2021.\n\n"
        "[2] Guideline statement. *Journal*. 2022.\n"
    )

    refs = WritingAgent._reference_inventory_from_manuscript(manuscript)

    assert refs == [
        {"number": 1, "entry": "Trial report. *Journal*. 2021."},
        {"number": 2, "entry": "Guideline statement. *Journal*. 2022."},
    ]


def test_quality_gate_blocks_low_k_heterogeneity_reassurance() -> None:
    manuscript = (
        "## Results\n\n"
        "The absence of a strong heterogeneity signal is reassuring for direction, but it cannot rule out clinical differences.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    gate = manuscript_quality_gate(manuscript, {"primary_effect": {"n_studies": 2}})

    assert gate["passed"] is False
    assert any(issue.get("code") == "low_k_heterogeneity_overinterpretation" for issue in gate["issues"])


def test_validate_and_repair_reframes_low_k_chinese_heterogeneity_claim() -> None:
    manuscript = (
        "## 结果\n\n"
        "**异质性与证据质量：** 统计异质性较低（I²=0.0%，tau²=0.000），但仅有2项研究入池。\n\n"
        "**证据局限性：** 尽管异质性低（I²=0.0%）且偏倚风险低，但研究数量有限。\n\n"
        "## 参考文献\n\n"
        "[1] 试验报告。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, {"primary_effect": {"n_studies": 2}})
    gate = manuscript_quality_gate(repaired, {"primary_effect": {"n_studies": 2}})

    assert "统计异质性较低" not in repaired
    assert "异质性低（I²=0.0%）" not in repaired
    assert "异质性统计量仅作描述性参考" in repaired
    assert any(issue.get("kind") == "low_k_heterogeneity_claim_repaired" for issue in report["issues"])
    assert gate["passed"] is True


def test_validate_and_repair_rephrases_single_workflow_adjudication_files() -> None:
    facts = {"primary_effect": {"n_studies": 2}}
    manuscript = (
        "## Methods\n\n"
        "This run used a single review workflow with screening, extraction, and adjudication files retained for author verification.\n\n"
        "## 方法\n\n"
        "本次运行采用单流程综述工作流完成这些步骤，并保留筛选、提取和裁决资料供作者复核。"
        "题名/摘要筛选、全文筛选和数据提取分别完成。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert "adjudication files retained" not in repaired
    assert "Screening and data collection followed prespecified criteria" in repaired
    assert "extraction records" not in repaired
    assert "裁决资料供作者复核" not in repaired
    assert "核查记录供作者复核" in repaired
    assert "单流程综述工作流" not in repaired
    assert "数据提取分别完成" not in repaired
    assert "按预设流程依次完成" not in repaired
    assert "筛选和数据提取按预设标准完成" in repaired
    assert any(issue.get("kind") == "unsupported_human_review_claim" for issue in report["issues"])


def test_validate_and_repair_fixes_broken_inline_citation_and_grade_limit_language() -> None:
    facts = {
        "primary_effect": {"n_studies": 2},
        "grade": {"outcomes": [{"certainty": "Moderate"}]},
    }
    manuscript = (
        "## 讨论\n\n"
        "由于各研究在终点具体定义（住院 vs［1，2］. 恶化/紧急就诊）上存在差异。\n\n"
        "## 结论\n\n"
        "现有有限证据提示治疗可能降低风险，但结论尚需进一步验证。"
        "然而，鉴于纳入研究数量有限且终点定义存在差异，证据仍有限，尚需进一步验证。"
        "证据仍属有限，证据基础相对有限。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)
    kinds = {issue.get("kind") for issue in report["issues"]}

    assert "vs［1，2］. 恶化" not in repaired
    assert "住院 vs 恶化/紧急就诊" in repaired
    assert "证据仍有限" not in repaired
    assert "证据仍属有限" not in repaired
    assert "证据基础相对有限" not in repaired
    assert "现有有限证据提示" not in repaired
    assert "结论尚需进一步验证" not in repaired
    assert "证据确定性为中等" in repaired
    assert "现有中等确定性证据提示" in repaired
    assert "broken_inline_citation_artifact_repaired" in kinds
    assert "grade_certainty_language_repaired" in kinds


def test_validate_and_repair_translates_grade_audit_terms_to_reader_language() -> None:
    manuscript = (
        "## Results\n\n"
        "The imprecision rationale was Total N=12251 vs OIS=600; CI width=0.174; CI crosses null=False.\n\n"
        "## 结果\n\n"
        "尽管总样本量满足最优信息量（OIS）要求，未在“不精确性”领域降级。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, {"primary_effect": {"n_studies": 2}})
    gate = manuscript_quality_gate(repaired, {"primary_effect": {"n_studies": 2}})
    kinds = {issue.get("kind") for issue in report["issues"]}

    assert "OIS" not in repaired
    assert "最优信息量" not in repaired
    assert "CI crosses null" not in repaired
    assert "prespecified information-size requirement" in repaired
    assert "预设信息量" in repaired
    assert "grade_reader_language_repaired" in kinds
    assert gate["passed"] is True


def test_validate_and_repair_localizes_internal_source_and_eligible_rct_terms() -> None:
    manuscript = (
        "## 摘要\n\n"
        "主要Meta分析纳入2项直接 eligible RCT。\n\n"
        "## 方法\n\n"
        "检索覆盖医学文献索引、OpenAlex；各来源初检记录数为医学文献索引: 438; OpenAlex: 343。\n"
    )

    repaired, _ = validate_and_repair_manuscript(
        manuscript,
        {"search": {"source_names": ["internal literature database", "OpenAlex"]}},
    )

    assert "直接 eligible RCT" not in repaired
    assert "直接相关随机对照试验" in repaired
    assert "医学文献索引" in repaired
    assert "本地整理文献索引" not in repaired


def test_deterministic_meta_fallback_is_full_manuscript_with_tables_and_references(tmp_path: Path) -> None:
    project = Project("writing-full-meta-fallback", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 12, "ClinicalTrials.gov": 1})
    project.save_json("meta_results.json", _meta().model_dump(), subdir="analysis")
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_verified_effect_selection(project)
    ref_manager = ReferenceManager()
    for idx, study_id in enumerate(("S1", "S2", "S3"), 1):
        ref_manager.add(
            {
                "title": f"Trial {idx} of systemic corticosteroids",
                "authors": [f"Author{idx} Example"],
                "journal": "Journal of Critical Care",
                "year": 2020 + idx,
                "doi": f"10.1000/example{idx}",
                "pmid": study_id,
            },
            study_id=study_id,
        )

    writer = WritingAgent()

    def fail_llm(*args, **kwargs):
        raise RuntimeError("provider unavailable")

    writer.call_llm = fail_llm
    writer.call_llm_structured = fail_llm
    manuscript = writer.run(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 12, "records_after_dedup": 10, "duplicates_removed": 2},
            "screening": {"title_abstract_screened": 10},
            "eligibility": {"full_text_assessed": 4},
            "included": {"studies_included": 3},
        },
        search_query="COVID-19 AND corticosteroids AND mortality",
        project=project,
        ref_manager=ref_manager,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI 0.75 to 1.00)",
                certainty="Low",
                domains=[
                    GRADEDomain(domain="risk_of_bias", rating="serious", rationale="Some concerns"),
                    GRADEDomain(domain="inconsistency", rating="no concern", rationale="I-squared=16%"),
                    GRADEDomain(domain="indirectness", rating="serious", rationale="Population definition requires review"),
                    GRADEDomain(domain="imprecision", rating="no concern", rationale="Total N=900 vs OIS=600; CI crosses null=False."),
                ],
            )
        ]),
    )

    assert len(manuscript.split()) > 3800
    assert "### Table 1. Characteristics of primary analysis data" in manuscript
    assert "### Table 2. Trial-level RR estimates and weights" in manuscript
    assert "### Table 3. GRADE summary of findings" in manuscript
    assert "### Appendix 1. Full search query" in manuscript
    assert "COVID-19 AND corticosteroids AND mortality" in manuscript
    assert "Trial 1 of systemic corticosteroids" in manuscript
    assert "## References" in manuscript
    assert "[1]" in manuscript
    assert "### Protocol and reporting framework" in manuscript
    assert "### Study selection and extraction" in manuscript
    assert "### Clinical interpretation" in manuscript
    assert "### Clinical application" in manuscript
    assert "## Declarations" in manuscript
    assert "### Ethics approval" in manuscript
    assert "### Data and code availability" in manuscript
    assert "### Funding" in manuscript
    assert "### Competing interests" in manuscript
    assert "source documentation for included primary comparisons" in manuscript.lower()
    manuscript_lower = manuscript.lower()
    assert "risk of bias" in manuscript_lower
    assert "indirectness" in manuscript_lower
    assert "imprecision" in manuscript_lower
    engineering_phrases = [
        "reproducibility benchmark",
        "automated systematic-review pipeline",
        "machine-readable record",
        "generated manuscript",
        "debugging afterthought",
        "remaining weakness is narrative polish",
        "manuscript should remain in review status",
    ]
    for phrase in engineering_phrases:
        assert phrase not in manuscript
    assert "pipeline" not in manuscript.lower()
    assert "reproducibility benchmark" not in manuscript.lower()
    assert "artifact" not in manuscript.lower()
    assert "manuscript/manuscript_facts.json" in manuscript
    main_body = _main_body_before_supplement(manuscript).lower()
    for phrase in (
        "automated",
        "user-facing",
        "source-adjudicated",
        "source-linked",
        "source-audit",
        "source-review",
        "source of truth",
        "fact-locked",
        "fact table",
        "hard validation",
        "first-pass",
        "stored records",
        "reviewer changes",
        "writing step",
        "checkpointed",
        "trust chain",
        "pipeline",
    ):
        assert phrase not in main_body
    assert "source documentation for included primary comparisons" in manuscript.lower()
    assert "remaining extraction conflicts" not in manuscript
    assert "still flags unresolved" not in manuscript
    assert "should be resolved before journal submission" not in manuscript
    assert "unresolved extraction-review" not in manuscript
    for phrase in (
        "manuscript draft",
        "draft manuscript",
        "before submission",
        "journal submission",
        "accompanying package",
        "review package",
        "submission-ready",
        "submitting authors",
    ):
        assert phrase not in manuscript.lower()


def test_generic_meta_fallback_conclusion_uses_concise_pico_labels(tmp_path: Path) -> None:
    project = Project("generic concise conclusion", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"PubMed": 2})
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_sglt2_effect_selection(project)
    protocol = ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve heart failure outcomes?",
        pico=PICO(
            population=(
                "Adults (≥18 years) with heart failure and left ventricular ejection fraction (LVEF) ≥40% "
                "including both heart failure with mildly reduced ejection fraction and heart failure with "
                "preserved ejection fraction, confirmed by echocardiography, cardiac MRI, or radionuclide ventriculography"
            ),
            intervention=(
                "Sodium-glucose cotransporter-2 (SGLT2) inhibitor at any approved dose and formulation, "
                "administered as monotherapy or as the index intervention in combination with standard background therapy"
            ),
            comparator=(
                "Placebo, no pharmacological treatment, sham intervention, or standard of care without an SGLT2 inhibitor "
                "including background therapy with beta-blockers, MRAs, ARNIs, ACEi/ARB, diuretics, or other therapies"
            ),
            outcome_primary="Composite of cardiovascular death or first hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="random",
    )

    writer = WritingAgent()
    writer.call_llm = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("provider unavailable"))
    writer.call_llm_structured = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("provider unavailable"))
    manuscript = writer.run(
        protocol=protocol,
        meta_results=_sglt2_meta(),
        prisma_data={
            "identification": {"records_identified": 2, "records_after_dedup": 2},
            "eligibility": {"full_text_assessed": 2},
            "included": {"studies_included": 2},
        },
        search_query="SGLT2 inhibitors AND HFpEF",
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
                n_studies=2,
                effect_summary="HR 0.81 (95% CI 0.74 to 0.88)",
                certainty="High",
                domains=[GRADEDomain(domain="risk_of_bias", rating="no concern", rationale="Low risk")],
            )
        ]),
    )

    conclusion = manuscript.split("## Conclusion", 1)[1].split("## Tables", 1)[0]
    introduction = manuscript.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = manuscript.split("## Methods", 1)[1].split("## Results", 1)[0]
    discussion = manuscript.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    assert "SGLT2 inhibitors" in conclusion
    assert "compared with placebo" in conclusion
    assert "cardiovascular death or heart failure hospitalization" in conclusion
    assert "confirmed by echocardiography" not in conclusion
    assert "background therapy with beta-blockers" not in conclusion
    assert "confirmed by echocardiography" not in discussion
    assert "radionuclide ventriculography" not in discussion
    assert "background therapy with beta-blockers" not in discussion
    assert "Placebo, no pharmacological treatment, sham intervention" not in discussion
    assert "confirmed by echocardiography" not in methods
    assert "radionuclide ventriculography" not in methods
    assert "at any approved dose" not in methods
    assert "standard background therapy" not in methods
    assert "Placebo, no pharmacological treatment, sham intervention" not in methods
    assert "at any approved dose" not in introduction
    assert "standard background therapy" not in introduction
    assert "Placebo, no pharmacological treatment, sham intervention" not in introduction
    assert len(conclusion.split()) < 120
    for phrase in (
        "manuscript draft",
        "draft manuscript",
        "before submission",
        "journal submission",
        "accompanying package",
        "review package",
        "submission-ready",
        "submitting authors",
    ):
        assert phrase not in manuscript.lower()


def test_chinese_generic_meta_methods_use_concise_pico_labels(tmp_path: Path) -> None:
    project = Project("generic zh concise methods", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"PubMed": 2})
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_sglt2_effect_selection(project)
    protocol = ResearchProtocol(
        research_question=(
            "In adults with heart failure with mildly reduced or preserved ejection fraction, "
            "do SGLT2 inhibitors compared with placebo reduce cardiovascular death or hospitalization for heart failure?"
        ),
        pico=PICO(
            population=(
                "Adults (≥18 years) with heart failure and left ventricular ejection fraction (LVEF) ≥40% "
                "including both heart failure with mildly reduced ejection fraction and heart failure with "
                "preserved ejection fraction, confirmed by echocardiography, cardiac MRI, or radionuclide ventriculography"
            ),
            intervention=(
                "Sodium-glucose cotransporter-2 (SGLT2) inhibitor at any approved dose and formulation, "
                "administered as monotherapy or as the index intervention in combination with standard background therapy"
            ),
            comparator=(
                "Placebo, no pharmacological treatment, sham intervention, or standard of care without an SGLT2 inhibitor "
                "including background therapy with beta-blockers, MRAs, ARNIs, ACEi/ARB, diuretics, or other therapies"
            ),
            outcome_primary="Composite of cardiovascular death or first hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="random",
    )

    facts = {
        "report_type": "meta",
        "primary_effect": {
            "outcome_name": "cardiovascular death or hospitalization for heart failure",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
            "p_value": 0.0001,
            "i_squared": 0.0,
            "tau_squared": 0.0,
            "model": "random",
            "studies": [
                {"study_id": "DELIVER", "effect": 0.82, "se": 0.05, "weight": 48.0},
                {"study_id": "EMPEROR", "effect": 0.79, "se": 0.04, "weight": 52.0},
            ],
        },
        "studies": {"primary_analysis_count": 2},
        "prisma": {
            "records_identified": 2,
            "records_after_dedup": 2,
            "title_abstract_screened": 2,
            "full_text_assessed": 2,
            "studies_included": 2,
        },
        "search": {"source_names": ["PubMed"], "source_counts": {"PubMed": 2}, "query": "SGLT2 inhibitors AND HFpEF"},
        "primary_population": {
            "selected_total_participants": 12251,
            "selected_events_intervention": 927,
            "selected_total_intervention": 6128,
            "selected_events_control": 1121,
            "selected_total_control": 6123,
        },
        "evidence_readiness": {
            "status": "ready",
            "blockers": [],
            "warnings": [],
            "selected_primary_rows": [],
        },
        "grade": {"outcomes": [{"outcome_name": "cardiovascular death or hospitalization for heart failure", "certainty": "High"}]},
        "writing_constraints": {"publication_min_main_words": 100},
    }
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=protocol,
        facts=facts,
        prisma_data={
            "records_identified": 2,
            "records_after_dedup": 2,
            "title_abstract_screened": 2,
            "full_text_assessed": 2,
            "studies_included": 2,
        },
        grade_profile=None,
        project=project,
        ref_manager=None,
    )

    abstract = manuscript.split("## 摘要", 1)[1].split("## 引言", 1)[0]
    methods = manuscript.split("## 方法", 1)[1].split("## 结果", 1)[0]
    supplement = manuscript.split("## 补充材料", 1)[1]
    assert "\n**目的：**" in abstract
    assert "\n**资料来源：**" in abstract
    assert "完整检索式如下" not in methods
    assert "```text" not in methods
    assert "### 附录1. 完整检索式" in supplement
    assert "SGLT2 inhibitors AND HFpEF" in supplement
    introduction = manuscript.split("## 引言", 1)[1].split("## 方法", 1)[0]
    assert "在射血分数轻度降低或保留的心力衰竭患者中，SGLT2抑制剂相较于安慰剂是否影响心血管死亡或心力衰竭住院" in introduction
    assert "In adults with heart failure" not in introduction
    assert "射血分数轻度降低或保留的心力衰竭患者" in methods
    assert "SGLT2抑制剂" in methods
    assert "安慰剂" in methods
    assert "心血管死亡或心力衰竭住院" in methods
    assert "SGLT2 inhibitors相较于placebo" not in manuscript
    assert "cardiovascular death or heart failure hospitalization风险" not in manuscript
    assert "confirmed by echocardiography" not in methods
    assert "radionuclide ventriculography" not in methods
    assert "Sodium-glucose cotransporter-2" not in methods
    assert "Placebo, no pharmacological treatment, sham intervention" not in methods
    assert "background therapy with beta-blockers" not in methods
    _, validation = validate_and_repair_manuscript(
        manuscript,
        {**facts, "writing_constraints": {"publication_min_main_words": 2500}},
    )
    assert not any(item["kind"] == "publication_length_too_short" for item in validation["issues"])


def test_chinese_generic_meta_localizes_sources_model_and_grade_table(tmp_path: Path) -> None:
    project = Project("generic zh localized fields", output_dir=tmp_path)
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}},
        subdir="extraction",
    )
    _save_sglt2_effect_selection(project)
    protocol = _sglt2_protocol()
    facts = {
        "report_type": "meta",
        "primary_effect": {
            "outcome_name": "cardiovascular death or hospitalization for heart failure",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
            "p_value": 0.0001,
            "i_squared": 0.0,
            "tau_squared": 0.0,
            "model": "random",
            "studies": [
                {"study_id": "DELIVER", "effect": 0.82, "se": 0.05, "weight": 48.0},
                {"study_id": "EMPEROR", "effect": 0.79, "se": 0.04, "weight": 52.0},
            ],
        },
        "studies": {"primary_analysis_count": 2},
        "prisma": {
            "records_identified": 781,
            "records_after_dedup": 2,
            "title_abstract_screened": 781,
            "full_text_assessed": 2,
            "studies_included": 2,
        },
        "search": {
            "source_names": ["internal literature database", "OpenAlex"],
            "source_counts": {"internal literature database": 438, "OpenAlex": 343},
            "query": "SGLT2 inhibitors AND HFpEF",
        },
        "primary_population": {
            "selected_total_participants": 12251,
            "selected_events_intervention": 927,
            "selected_total_intervention": 6128,
            "selected_events_control": 1121,
            "selected_total_control": 6123,
        },
            "evidence_readiness": {
                "status": "ready",
                "blockers": [],
                "warnings": [],
                "selected_primary_rows": [],
            },
            "model_decision": {
                "primary_model": "random",
                "primary_engine_model": "fixed",
                "tau_estimator": "DL",
                "k": 2,
                "low_k_random_fallback": True,
                "reason": "generic random-effects synthesis was requested, but fewer than three studies contributed",
            },
            "grade": {
                "outcomes": [
                {
                    "outcome_name": "Composite of cardiovascular death or first hospitalization for heart failure",
                    "effect_summary": "HR 0.81 (95% CI: 0.74 to 0.88)",
                    "certainty": "High",
                    "domains": [
                        {
                            "domain": "risk_of_bias",
                            "rating": "no concern",
                            "rationale": (
                                "RoB assessments were available for 2/2 contributing studies: "
                                "0/2 studies at high risk, 0/2 with some concerns, 2/2 at low risk."
                            ),
                        },
                        {
                            "domain": "inconsistency",
                            "rating": "no concern",
                            "rationale": (
                                "We did not downgrade for inconsistency. There is no statistical heterogeneity among "
                                "the included studies, as indicated by an I² of 0.0% and a non-significant Chi² test "
                                "(p = 0.6783)."
                            ),
                        },
                        {
                            "domain": "imprecision",
                            "rating": "no concern",
                            "rationale": "Total N=12251 (extracted arm totals) vs OIS=600; CI width=0.174; CI crosses null=False.",
                        },
                        {
                            "domain": "publication_bias",
                            "rating": "no concern",
                            "rationale": "Not formally assessed because fewer than 10 studies contributed.",
                        },
                    ],
                }
            ]
        },
        "writing_constraints": {"publication_min_main_words": 100},
    }

    manuscript = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=protocol,
        facts=facts,
        prisma_data=facts["prisma"],
        grade_profile=None,
        project=project,
        ref_manager=None,
    )

    assert "医学文献索引、OpenAlex" in manuscript
    assert "医学文献索引: 438; OpenAlex: 343" in manuscript
    assert "内部文献库" not in manuscript
    assert "internal literature database" not in manuscript
    main_body = manuscript.split("## 补充材料", 1)[0]
    for phrase in (
        "本次运行",
        "候选主要行",
        "效应量审计",
        "提取置信度",
        "来源核验采用",
        "可追踪",
        "复核过程中",
        "可获得性标记",
        "核验状态",
    ):
        assert phrase not in main_body
    assert "固定效应逆方差估计" in manuscript
    assert "随机效应逆方差模型" not in manuscript
    assert "random逆方差模型" not in manuscript
    assert "证据确定性评为高" in manuscript
    assert "评为High" not in manuscript
    grade_section = manuscript.split("### 表3. GRADE证据概要", 1)[1].split("## 图", 1)[0]
    assert "心血管死亡或心力衰竭住院" in grade_section
    assert "偏倚风险" in grade_section
    assert "无严重问题" in grade_section
    assert "高" in grade_section
    assert "HR 0.81（95% CI 0.74至0.88）" in grade_section
    for raw in (
        "Composite of cardiovascular death",
        "risk_of_bias",
        "no concern",
        "RoB assessments were available",
        "There is no statistical heterogeneity",
        "Total N=12251 vs OIS=600",
        "Not formally assessed because",
        "95% CI: 0.74 to 0.88",
        "结构化GRADE理由已记录",
    ):
        assert raw not in grade_section
    assert "2/2项贡献研究有偏倚风险评价" in grade_section
    assert "统计异质性很低" in grade_section
    assert "I²=0.0%" in grade_section
    assert "总样本量12251" in grade_section
    assert "少于10项研究" in grade_section


def test_writing_agent_grade_downgrade_text_uses_current_domain_ratings() -> None:
    text = WritingAgent._fallback_grade_downgrade_text({
        "domains": [
            {"domain": "risk_of_bias", "rating": "serious"},
            {"domain": "indirectness", "rating": "serious"},
            {"domain": "imprecision", "rating": "no concern"},
            {"domain": "publication_bias", "rating": "no concern"},
        ]
    })

    assert text == "risk of bias and indirectness"


def test_build_manuscript_facts_preserves_grade_domain_details(tmp_path: Path) -> None:
    project = Project("grade details", output_dir=tmp_path)

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
        grade_profile=GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=3,
                effect_summary="RR 0.86 (95% CI: 0.75 to 1.00)",
                certainty="Moderate",
                domains=[
                    GRADEDomain(
                        domain="indirectness",
                        rating="serious",
                        rationale="Rule-based P/I/C/O directness check: population mismatch in 1/3.",
                        details={
                            "method": "rule_based_pico_directness_v1",
                            "n_contributing": 3,
                            "dimensions": {"population": {"mismatch": 1, "unverified": 0, "total": 3}},
                        },
                    )
                ],
            )
        ]),
    )

    indirectness = facts["grade"]["outcomes"][0]["domains"][0]
    assert indirectness["details"]["method"] == "rule_based_pico_directness_v1"
    assert indirectness["details"]["dimensions"]["population"]["mismatch"] == 1


def test_writing_agent_keeps_context_only_warnings_out_of_abstract_text() -> None:
    text = WritingAgent._fallback_warning_text([
        {
            "code": "limited_text_sources_present",
            "message": "3 retrieved/screened record(s) use limited source text (3 abstract-only).",
            "scope": "non_primary_records",
            "action_required": False,
        }
    ])

    assert text == ""
    assert "evidence-readiness audit still flagged" not in text


def test_writing_agent_formats_registry_first_references_for_submission() -> None:
    covid_steroid = WritingAgent._format_reference_entry(1, {
        "title": "COVID STEROID (NCT04348305)",
        "authors": ["COVID STEROID"],
    })
    steroids_sari = WritingAgent._format_reference_entry(2, {
        "title": "Steroids-SARI",
        "authors": ["Steroids-SARI"],
        "url": "https://clinicaltrials.gov/study/NCT04244591",
    })
    covid_nma = WritingAgent._format_reference_entry(3, {
        "title": "Steroids-SARI trial living-data record",
        "authors": ["COVID-NMA initiative"],
        "url": "https://covid-nma.com/living_data/infos_participants_pharmaco.php?i=167",
    })

    assert "ClinicalTrials.gov. Low-dose Hydrocortisone" in covid_steroid
    assert "Identifier NCT04348305" in covid_steroid
    assert "ClinicalTrials.gov. Glucocorticoid Therapy" in steroids_sari
    assert "Identifier NCT04244591" in steroids_sari
    assert "COVID-NMA initiative. Steroids-SARI trial living-data record" in covid_nma


def test_writing_agent_keeps_supplemental_references_in_bibtex_sync() -> None:
    ref_manager = ReferenceManager()
    refs_text, _ = WritingAgent()._fallback_references(ref_manager)

    numbered_count = len(re.findall(r"^\[\d+\]", refs_text, flags=re.M))
    bibtex = ref_manager.to_bibtex()

    assert "EU Clinical Trials Register. COVID STEROID trial results" in refs_text
    assert "2020-001395-15" in bibtex
    assert bibtex.count("@article{") == numbered_count


def test_covid_fallback_reports_review_included_and_primary_analysis_counts() -> None:
    writer = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")
    facts = {
        "model": "fixed",
        "search": {"source_names": ["PubMed"], "source_counts": {}, "query": "COVID-19 AND corticosteroids"},
        "studies": {"primary_analysis_count": 7},
        "prisma": {
            "records_identified": 197,
            "duplicates_removed": 77,
            "records_after_dedup": 120,
            "title_abstract_screened": 120,
            "full_text_assessed": 26,
            "studies_included": 15,
        },
        "primary_effect": {
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.659,
            "ci_lower": 0.532,
            "ci_upper": 0.817,
            "p_value": 0.0001,
            "i_squared": 15.6,
            "tau_squared": 0.0214,
            "studies": [],
        },
        "primary_population": {
            "selected_events_intervention": 222,
            "selected_total_intervention": 678,
            "selected_events_control": 425,
            "selected_total_control": 1025,
            "selected_total_participants": 1703,
        },
        "evidence_readiness": {"selected_primary_rows": [], "warnings": [], "extraction_backlog": {}},
        "grade": {"outcomes": []},
    }

    manuscript = writer._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    assert "15 full-text records as eligible or contextual evidence" in manuscript
    assert "The primary meta-analysis included 7 studies" in manuscript
    assert "remaining 8 retained records" in manuscript


def test_covid_topic_specific_template_is_legacy_opt_in() -> None:
    writer = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 7},
        "writing_constraints": {},
    }

    assert writer._resolve_manuscript_mode(_protocol(), facts) == "clinical_meta_analysis"

    facts["writing_constraints"] = {"allow_legacy_topic_template": True}
    assert writer._resolve_manuscript_mode(_protocol(), facts) == "clinical_meta_analysis_with_published_anchor"

    facts["report_type"] = "benchmark_reconstruction"
    facts["writing_constraints"] = {}
    assert writer._resolve_manuscript_mode(_protocol(), facts) == "benchmark_reconstruction"


def test_generic_title_marks_benchmark_reconstruction_without_topic_template() -> None:
    writer = WritingAgent()

    title = writer._generic_title(
        _protocol(),
        "Systemic corticosteroids",
        "28-day all-cause mortality",
        report_type="benchmark_reconstruction",
    )

    assert "benchmark reconstruction" in title
    assert "systematic review and meta-analysis" not in title
    shortened = WritingAgent._shorten(
        "Adults with confirmed SARS-CoV-2 infection who are critically ill and require respiratory support",
        70,
    )
    assert shortened.endswith("...")
    assert " crit..." not in shortened
    assert " respiratory..." not in shortened


def test_generic_title_uses_llm_candidate_when_fact_safe(monkeypatch) -> None:
    writer = WritingAgent()

    def fake_structured(prompt, schema, **kwargs):
        assert schema is ManuscriptTitleCandidate
        assert "Report type: benchmark_reconstruction" in prompt
        return ManuscriptTitleCandidate(
            title="Systemic corticosteroids for mortality in critically ill COVID-19: a benchmark reconstruction and meta-analysis",
            rationale="Uses only intervention, population, outcome, and benchmark report type.",
        )

    monkeypatch.setattr(writer, "call_llm_structured", fake_structured)
    title = writer._generic_title(
        _protocol(),
        "Systemic corticosteroids",
        "28-day all-cause mortality",
        report_type="benchmark_reconstruction",
        facts={"primary_effect": {"n_studies": 7, "effect_measure": "OR"}},
        allow_llm=True,
    )

    assert title.startswith("Systemic corticosteroids for mortality")
    assert "benchmark reconstruction" in title
    assert "who are:" not in title


def test_generic_title_rejects_unsafe_llm_candidate(monkeypatch) -> None:
    writer = WritingAgent()

    def fake_structured(prompt, schema, **kwargs):
        return ManuscriptTitleCandidate(
            title="Systemic corticosteroids for adults who are:",
            rationale="Dangling title.",
        )

    monkeypatch.setattr(writer, "call_llm_structured", fake_structured)
    title = writer._generic_title(
        _protocol(),
        "Systemic corticosteroids",
        "28-day all-cause mortality",
        report_type="benchmark_reconstruction",
        facts={"primary_effect": {"n_studies": 7, "effect_measure": "OR"}},
        allow_llm=True,
    )

    assert "who are:" not in title
    assert "benchmark reconstruction" in title


def test_semantic_edit_includes_abstract_for_llm_review() -> None:
    assert "Abstract" in WritingAgent()._semantic_edit_allowed_headings()
    assert WritingAgent()._canonical_semantic_heading("摘要") == "Abstract"
    assert "摘要" in WritingAgent(lang="zh")._semantic_edit_allowed_headings()
    assert WritingAgent(lang="zh")._canonical_semantic_heading("abstract") == "摘要"


def test_semantic_edit_prompt_treats_abstract_as_editable_prose() -> None:
    writer = WritingAgent()
    prompt = writer._semantic_edit_prompt(
        {"report_type": "meta", "primary_effect": {"n_studies": 2}},
        {
            "Abstract": "**Importance:** Long definitional abstract.",
            "Introduction": "Clinical background.",
        },
    )

    assert "Abstract narrative fields" in prompt
    assert "For Abstract, preserve structured labels" in prompt
    assert "## Abstract" in prompt


def test_semantic_edit_prompt_allows_llm_journal_style_condensation() -> None:
    writer = WritingAgent()
    prompt = writer._semantic_edit_prompt(
        {"report_type": "meta", "primary_effect": {"n_studies": 2}},
        {
            "Methods": (
                "Search strategy details are reported here. "
                "The same full query is preserved in Appendix 1."
            ),
            "Results": "The pooled HR was 0.81 (95% CI 0.74 to 0.88).",
        },
    )

    assert "prefer journal-style concision" in prompt
    assert "full search query blocks when the same material is preserved in Appendix 1" in prompt
    assert "Preserve citation support for every remaining claim" in prompt
    assert "Keep at least 75%" not in prompt


def test_semantic_paragraph_edit_prioritizes_final_review_issue(monkeypatch) -> None:
    writer = WritingAgent()
    manuscript = (
        "## Introduction\n\n"
        "The analysis describes a clinical question in a template-like way.\n\n"
        "## Conclusion\n\n"
        "The estimate reflects empagliflozin and dapagliflozin, but class effect wording needs clarification.\n"
    )
    clinical_review = writer._clinical_review_from_final_readiness({
        "status": "ok",
        "decision": "minor_revision",
        "issues": [{
            "severity": "minor",
            "section": "Conclusion",
            "problem": "Class effect wording needs clarification.",
            "evidence": "The conclusion mentions class effect uncertainty.",
            "action": "Clarify the class effect wording in the Conclusion.",
            "requires_new_source": False,
        }],
    })
    captured = {}

    def fake_structured(prompt, schema, **kwargs):
        captured["prompt"] = prompt
        return SemanticParagraphRevision(summary="No patch needed.", patches=[])

    monkeypatch.setattr(writer, "call_llm_structured", fake_structured)

    writer._semantic_edit_style_paragraphs(
        manuscript,
        {"primary_effect": {"n_studies": 2}},
        clinical_review=clinical_review,
        max_targets=1,
    )

    assert '"heading": "Conclusion"' in captured["prompt"]
    assert '"heading": "Introduction"' not in captured["prompt"]


def test_final_minor_review_skips_full_section_rewrite_for_local_issues() -> None:
    local_review = {
        "status": "ok",
        "decision": "minor_revision",
        "issues": [{
            "severity": "minor",
            "section": "Discussion",
            "problem": "Safety caveats are repeated across paragraphs.",
            "evidence": "Clinical application and limitations both mention monitoring.",
            "action": "Consolidate repeated safety caveats.",
            "requires_new_source": False,
        }],
    }
    section_review = {
        "status": "ok",
        "decision": "minor_revision",
        "issues": [{
            "severity": "minor",
            "section": "Discussion",
            "problem": "There is a contradiction across sections about the primary result.",
            "evidence": "Results and Discussion point in different directions.",
            "action": "Rewrite the section to resolve the contradiction across sections.",
            "requires_new_source": False,
        }],
    }

    assert WritingAgent._final_review_needs_section_rewrite(local_review) is False
    assert WritingAgent._final_review_needs_section_rewrite(section_review) is True


def test_final_minor_review_can_fix_auto_revisable_issues_even_with_user_inputs() -> None:
    review = {
        "status": "ok",
        "decision": "minor_revision",
        "required_user_inputs": ["Confirm screening and extraction execution mode."],
        "issues": [
            {
                "severity": "minor",
                "section": "Methods",
                "problem": "Screening execution mode is not documented.",
                "evidence": "No reviewer mode appears in structured facts.",
                "action": "Ask the user to confirm the execution mode.",
                "requires_new_source": True,
            },
            {
                "severity": "minor",
                "section": "Discussion",
                "problem": "The same low-study-count caveat is repeated in several paragraphs.",
                "evidence": "Discussion and limitations both repeat the same caveat.",
                "action": "Consolidate the repeated caveat without adding new facts.",
                "requires_new_source": False,
            },
        ],
    }

    assert WritingAgent._final_review_can_auto_revise(review) is True
    sanitized = WritingAgent._auto_revisable_final_review(review)
    assert sanitized["required_user_inputs"] == []
    assert len(sanitized["issues"]) == 1
    assert sanitized["issues"][0]["section"] == "Discussion"


def test_final_minor_review_can_repair_major_local_issue_when_overall_decision_is_minor() -> None:
    review = {
        "status": "ok",
        "decision": "minor_revision",
        "issues": [{
            "severity": "major",
            "section": "Discussion",
            "problem": "The Safety scope subsection ends abruptly with an incomplete sentence.",
            "evidence": "Visible text ends with a semicolon.",
            "action": "Complete the sentence using existing safety notes and structured facts.",
            "requires_new_source": False,
        }],
    }

    assert WritingAgent._final_review_can_auto_revise(review) is True
    sanitized = WritingAgent._auto_revisable_final_review(review)
    assert len(sanitized["issues"]) == 1
    assert sanitized["issues"][0]["severity"] == "major"


def test_section_missing_citations_routes_to_llm_citation_resolver() -> None:
    citation_audit = {
        "passed": False,
        "issues": [{
            "code": "section_citations_missing",
            "severity": "fail",
            "section": "Discussion",
            "message": "Discussion has no in-text citation despite source-backed claims.",
        }],
    }

    assert WritingAgent._citation_audit_has_repairable_grounding_issues(citation_audit) is True


def test_semantic_paragraph_needs_llm_edit_for_long_nonabstract_paragraph() -> None:
    paragraph = (
        "The search covered PubMed. Records were deduplicated. Full text was assessed. "
        "Data were extracted. Values were verified. Certainty was assessed. Sources were archived."
    )
    abstract = (
        "**Importance:** Background. **Objective:** Objective. **Data sources:** Sources. "
        "**Study selection:** Selection. **Results:** Results. **Conclusions and relevance:** Conclusion."
    )

    assert WritingAgent._semantic_paragraph_needs_llm_edit(paragraph) is True
    assert WritingAgent._semantic_paragraph_needs_llm_edit(abstract) is False


def test_semantic_guard_lets_llm_judge_open_section_condensation() -> None:
    issues = [
        {"code": "rewrite_overcompressed"},
        {"code": "numeric_tokens_changed"},
        {"code": "citations_changed"},
    ]

    assert WritingAgent._semantic_guard_can_be_llm_adjudicated(issues, heading="Methods") is True
    assert WritingAgent._semantic_guard_can_be_llm_adjudicated(issues, heading="Tables") is False


def test_normalize_structured_abstract_spacing_keeps_fields_on_separate_lines() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = (
        "# 标题\n\n"
        "## 摘要\n\n"
        "**重要性：** 背景。 **目的：** 目的。 **资料来源：** PubMed。 "
        "**结果：** OR 0.66。 **结论和意义：** 结论。\n\n"
        "## 引言\n\n正文。"
    )

    repaired = writer._normalize_structured_abstract_spacing(manuscript)

    assert "**重要性：** 背景。\n**目的：** 目的。" in repaired
    assert "\n**资料来源：** PubMed。" in repaired
    assert "\n**结果：** OR 0.66。" in repaired
    assert "\n**结论和意义：** 结论。" in repaired


def test_semantic_paragraph_prompt_passes_style_gate_issues_to_llm() -> None:
    writer = WritingAgent()
    prompt = writer._semantic_paragraph_edit_prompt(
        {"report_type": "meta", "primary_effect": {"n_studies": 7}},
        [
            {
                "heading": "Discussion",
                "paragraph_index": 1,
                "text": "The review found an association. The pooled estimate was precise.",
                "style_signals": {"abstract_subject_examples": ["The review", "The pooled estimate"]},
            }
        ],
        style_issue_brief=[
            {
                "code": "abstract_subject_overuse",
                "message": "Abstract manuscript subjects appear 15 times.",
            }
        ],
    )

    assert "STYLE ISSUES" in prompt
    assert "abstract_subject_overuse" in prompt
    assert "subject is a patient group, intervention, trial, outcome" in prompt


def test_clinical_review_prompt_does_not_recommend_automation_as_method_fix() -> None:
    writer = WritingAgent()
    prompt = writer._clinical_manuscript_review_prompt(
        {"report_type": "meta", "primary_effect": {"n_studies": 7}},
        {
            "Methods": (
                "Assessments were conducted independently by two reviewers. "
                "Disagreements were resolved through manual adjudication."
            )
        },
    )

    assert "neutral source-documentation wording" in prompt
    assert "do not recommend wording that advertises automation" in prompt
    assert "pipelines, parsers, or internal review machinery" in prompt


def test_zh_generic_methods_template_uses_publication_language_for_source_checks() -> None:
    source = Path("new_meta/agents/writing_agent.py").read_text()

    assert "经来源核对后需要修订" in source
    assert "进一步来源核实前" in source
    assert "统计计算按预设统计方法完成" in source
    assert "报告字段不完整" in source
    assert "经人工确认后需要修订" not in source
    assert "人工裁决前" not in source
    assert "程序化实现完成" not in source
    assert "元数据缺失" not in source
    assert "机械降级" not in source


def test_covid_fallback_cites_grade_certainty_discussion_sentence() -> None:
    writer = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")
    facts = {
        "model": "fixed",
        "search": {"source_names": ["PubMed"], "source_counts": {}, "query": "COVID-19 AND corticosteroids"},
        "studies": {"primary_analysis_count": 7},
        "prisma": {
            "records_identified": 197,
            "duplicates_removed": 77,
            "records_after_dedup": 120,
            "title_abstract_screened": 120,
            "full_text_assessed": 26,
            "studies_included": 15,
        },
        "primary_effect": {
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.659,
            "ci_lower": 0.532,
            "ci_upper": 0.817,
            "p_value": 0.0001,
            "i_squared": 15.6,
            "tau_squared": 0.0214,
            "studies": [],
        },
        "primary_population": {
            "selected_events_intervention": 222,
            "selected_total_intervention": 678,
            "selected_events_control": 425,
            "selected_total_control": 1025,
            "selected_total_participants": 1703,
        },
        "evidence_readiness": {"selected_primary_rows": [], "warnings": [], "extraction_backlog": {}},
        "grade": {"outcomes": [{"certainty": "Moderate", "domains": [{"domain": "risk_of_bias", "rating": "serious"}]}]},
    }

    manuscript = writer._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    match = re.search(r"Certainty was rated moderate[^.]*\.", manuscript)
    assert match is not None
    assert "risk of bias" in match.group(0).lower()


def test_covid_fallback_respects_chinese_output_without_hf_template_leakage() -> None:
    writer = WritingAgent(lang="zh", topic="危重型COVID-19患者使用全身性糖皮质激素降低死亡率")
    protocol = ResearchProtocol(
        research_question="What is the effect of systemic corticosteroids on 28-day all-cause mortality in critical COVID-19?",
        pico=PICO(
            population=(
                "Adults (≥18 years) with confirmed or suspected SARS-CoV-2 infection who are critically ill, "
                "defined as requiring intensive care unit admission, invasive mechanical ventilation, or high-flow oxygen."
            ),
            intervention="Systemic corticosteroids",
            comparator="Usual care or placebo",
            outcome_primary="All-cause mortality at 28 days post-randomization or initiation of treatment.",
        ),
        effect_measure="OR",
        model_preference="fixed",
    )
    facts = {
        "model": "fixed",
        "search": {"source_names": ["PubMed"], "source_counts": {"PubMed": 12}, "query": "COVID-19 AND corticosteroids"},
        "studies": {"primary_analysis_count": 7},
        "prisma": {
            "records_identified": 197,
            "duplicates_removed": 77,
            "records_after_dedup": 120,
            "title_abstract_screened": 120,
            "full_text_assessed": 26,
            "studies_included": 15,
        },
        "primary_effect": {
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.659,
            "ci_lower": 0.532,
            "ci_upper": 0.817,
            "p_value": 0.0001,
            "i_squared": 15.6,
            "tau_squared": 0.0214,
            "model": "fixed",
            "studies": [],
        },
        "primary_population": {
            "selected_events_intervention": 222,
            "selected_total_intervention": 678,
            "selected_events_control": 425,
            "selected_total_control": 1025,
            "selected_total_participants": 1703,
        },
        "evidence_readiness": {"selected_primary_rows": [], "warnings": [], "extraction_backlog": {}},
        "grade": {"outcomes": [{"certainty": "Moderate"}]},
    }

    manuscript = writer._write_meta_fallback_report(
        protocol=protocol,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    assert "## 摘要" in manuscript
    assert "**重要性：**" in manuscript
    assert "全身性糖皮质激素" in manuscript
    assert "危重型COVID-19患者" in manuscript
    assert "28天全因死亡率" in manuscript
    assert "最终纳入15项研究" in manuscript
    assert "其中7项研究进入主要Meta分析" in manuscript
    assert "7项研究的研究层面估计方向" in manuscript
    assert "两项研究的研究层面估计方向" not in manuscript
    assert "主要局限是合并研究数仅为7项" in manuscript
    assert "SARS-CoV-2 infection who are critically ill" not in manuscript
    assert "Systemic corticosteroids were rapidly evaluated" not in manuscript
    assert "**Importance:**" not in manuscript
    assert "不提高确定性" not in manuscript
    assert "SGLT2" not in manuscript
    assert "心衰" not in manuscript
    assert "射血分数" not in manuscript
    assert "酮症酸中毒" not in manuscript


def test_writing_agent_scrubs_internal_source_labels_for_tables() -> None:
    row = {
        "row_id": "benchmark_source:covid_steroid:0",
        "source_location": "uploaded benchmark source: who_react_figure2_transcribed.txt",
    }
    known_row = {
        "row_id": "known_source:steroids_sari:0",
        "study_id": "known_source:steroids_sari",
        "source_location": "WHO REACT Working Group. JAMA 2020 Figure 2",
        "source_quote": "Steroids-SARI (NCT04244591): deaths/total were 13/24 in the steroid arm and 13/23 in the no-steroid arm.",
        "events_intervention": 13,
        "total_intervention": 24,
        "events_control": 13,
        "total_control": 23,
    }

    assert WritingAgent._fallback_source_location(row) == "COVID STEROID trial report/registry result"
    assert WritingAgent._fallback_row_id(row) == "source:covid_steroid:0"
    assert WritingAgent._fallback_row_id(known_row) == "source:steroids_sari:0"
    assert WritingAgent._fallback_trial_label(known_row) == "Steroids-SARI (NCT04244591)"
    assert "13/24" in WritingAgent()._fallback_source_quote(known_row)


def test_writing_agent_passes_background_citation_context_to_introduction_prompt() -> None:
    writer = WritingAgent()
    prompts: list[str] = []
    writer.call_llm = lambda prompt, **kwargs: prompts.append(prompt) or "Clinical context is cited [4]."
    writer._background_citation_context = "- [4] 2024 heart failure guideline: summarizes current care."

    intro = writer._write_introduction(_sglt2_protocol())

    assert intro == "Clinical context is cited [4]."
    assert "[4] 2024 heart failure guideline" in prompts[0]
    assert "Use these citations" in prompts[0]
    assert "Do NOT cite specific studies" not in prompts[0]


def test_writing_agent_retries_section_generation_before_fallback() -> None:
    writer = WritingAgent()
    attempts = {"count": 0}

    def flaky_section() -> str:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("temporary provider failure")
        return "Recovered section"

    assert writer._write_section_with_retry("Abstract", flaky_section) == "Recovered section"
    assert attempts["count"] == 2


def test_writing_agent_methods_backfills_exact_search_query_when_llm_omits_it() -> None:
    writer = WritingAgent()
    exact_query = '("heart failure"[tiab] AND SGLT2[tiab]) AND placebo[tiab]'

    def omit_query(prompt, **kwargs):
        return (
            "## Methods\n"
            "The search strategy, eligibility criteria, screening, data extraction, risk of bias, "
            "statistical analysis, GRADE, PRISMA, and publication bias methods were prespecified."
        )

    writer.call_llm = omit_query

    methods = writer._write_methods(
        _sglt2_protocol(),
        {
            "identification": {"records_identified": 2, "records_after_dedup": 2},
            "screening": {"title_abstract_screened": 2},
            "eligibility": {"full_text_assessed": 2},
            "included": {"studies_included": 2},
        },
        exact_query,
        [],
        "2026-05-22",
    )

    assert exact_query in methods
    assert "Full search query" in methods


def test_writing_agent_uses_formal_length_section_token_budgets() -> None:
    writer = WritingAgent()
    observed = []

    def capture_tokens(prompt, **kwargs):
        observed.append(kwargs.get("max_tokens"))
        return "section text"

    writer.call_llm = capture_tokens

    writer._write_introduction(_sglt2_protocol())
    writer._write_methods(
        _sglt2_protocol(),
        {
            "identification": {"records_identified": 2, "records_after_dedup": 2},
            "screening": {"title_abstract_screened": 2},
            "eligibility": {"full_text_assessed": 2},
            "included": {"studies_included": 2},
        },
        '"heart failure" AND SGLT2',
        [],
        "2026-05-22",
    )
    writer._write_results(_sglt2_protocol(), _sglt2_meta(), [], [], {}, citation_map="")
    writer._write_discussion(_sglt2_protocol(), _sglt2_meta(), [], citation_map="")

    assert observed
    assert min(observed) >= 8192


def test_validate_manuscript_warns_on_short_publication_style_meta_report() -> None:
    manuscript = "\n\n".join([
        "# Short meta-analysis",
        "## Abstract",
        "The review found a pooled OR of 0.66.",
        "## Introduction",
        "This is brief.",
        "## Methods",
        "The methods are brief.",
        "## Results",
        "Two trials were included.",
        "## Discussion",
        "The discussion is brief.",
    ])
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"status": "ready", "blockers": [], "warnings": []},
        "writing_constraints": {"publication_min_main_words": 3000},
    }

    _, report = validate_and_repair_manuscript(manuscript, facts)
    issue = next(item for item in report["issues"] if item["kind"] == "publication_length_too_short")

    assert report["passed"] is True
    assert issue["severity"] == "warning"
    assert issue["main_word_count"] < issue["minimum_main_words"]


def test_validate_manuscript_uses_smaller_length_target_for_two_study_meta() -> None:
    two_study_article = "\n\n".join([
        "# Meta-analysis",
        "## Abstract",
        " ".join(["abstract"] * 250),
        "## Introduction",
        " ".join(["introduction"] * 1200),
        "## Methods",
        " ".join(["methods"] * 1200),
        "## Results",
        " ".join(["results"] * 900),
        "## Discussion",
        " ".join(["discussion"] * 1450),
    ])
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"status": "ready", "blockers": [], "warnings": []},
    }

    _, report = validate_and_repair_manuscript(two_study_article, facts)

    assert report["facts_summary"]["main_word_count"] >= 4500
    assert not any(item["kind"] == "publication_length_too_short" for item in report["issues"])


def test_validate_manuscript_migrates_legacy_default_length_for_two_study_meta() -> None:
    two_study_article = "\n\n".join([
        "# Meta-analysis",
        "## Abstract",
        " ".join(["abstract"] * 250),
        "## Introduction",
        " ".join(["introduction"] * 1200),
        "## Methods",
        " ".join(["methods"] * 1200),
        "## Results",
        " ".join(["results"] * 900),
        "## Discussion",
        " ".join(["discussion"] * 1450),
    ])
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"status": "ready", "blockers": [], "warnings": []},
        "writing_constraints": {"publication_min_main_words": 6000},
    }

    _, report = validate_and_repair_manuscript(two_study_article, facts)

    assert not any(item["kind"] == "publication_length_too_short" for item in report["issues"])


def test_validate_manuscript_respects_user_length_override_for_two_study_meta() -> None:
    two_study_article = "\n\n".join([
        "# Meta-analysis",
        "## Abstract",
        " ".join(["abstract"] * 250),
        "## Introduction",
        " ".join(["introduction"] * 1200),
        "## Methods",
        " ".join(["methods"] * 1200),
        "## Results",
        " ".join(["results"] * 900),
        "## Discussion",
        " ".join(["discussion"] * 1450),
    ])
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "evidence_readiness": {"status": "ready", "blockers": [], "warnings": []},
        "writing_constraints": {
            "publication_min_main_words": 6000,
            "publication_min_main_words_source": "user",
        },
    }

    _, report = validate_and_repair_manuscript(two_study_article, facts)

    issue = next(item for item in report["issues"] if item["kind"] == "publication_length_too_short")
    assert issue["minimum_main_words"] == 6000


def test_validate_manuscript_uses_quality_length_floor_by_default() -> None:
    long_but_not_full_article = "\n\n".join([
        "# Meta-analysis",
        "## Abstract",
        " ".join(["abstract"] * 250),
        "## Introduction",
        " ".join(["introduction"] * 1500),
        "## Methods",
        " ".join(["methods"] * 1400),
        "## Results",
        " ".join(["results"] * 1000),
        "## Discussion",
        " ".join(["discussion"] * 1200),
    ])
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 3},
        "evidence_readiness": {"status": "ready", "blockers": [], "warnings": []},
    }

    _, report = validate_and_repair_manuscript(long_but_not_full_article, facts)

    assert not any(item["kind"] == "publication_length_too_short" for item in report["issues"])
    assert report["passed"] is True


def test_validate_manuscript_length_gate_skips_evidence_gap_reports() -> None:
    _, report = validate_and_repair_manuscript(
        "## Evidence Gap\n\nNo eligible studies were found.",
        {
            "report_type": "evidence_gap",
            "evidence_readiness": {"status": "blocked", "blockers": [{"code": "no_direct_evidence"}]},
            "writing_constraints": {"publication_min_main_words": 3000},
        },
    )

    assert not any(item["kind"] == "publication_length_too_short" for item in report["issues"])


def test_writing_agent_retries_with_fact_locked_template_when_publication_draft_is_too_short() -> None:
    validation = {
        "passed": False,
        "issues": [
            {
                "kind": "publication_length_too_short",
                "severity": "warning",
                "main_word_count": 400,
                "minimum_main_words": 3000,
            }
        ],
    }

    assert WritingAgent._needs_fact_locked_rewrite(validation) is True


def test_section_fact_contract_includes_claim_map_and_study_cards() -> None:
    writer = WritingAgent()
    writer._manuscript_claim_map = [
        {
            "id": "primary_effect",
            "section": "Results/Conclusion",
            "claim": "The pooled HR was 0.81 (95% CI 0.74 to 0.88).",
            "support_source": "analysis.meta_results.primary_outcome",
        },
        {
            "id": "background_only",
            "section": "Introduction",
            "claim": "HFpEF is common.",
            "support_source": "background_reference_pool",
        },
    ]
    writer._manuscript_facts = {
        "report_type": "meta",
        "manuscript_mode": "clinical_meta_analysis",
        "primary_effect": {
            "outcome_name": "Composite endpoint",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
        },
        "primary_population": {"selected_total_participants": 12251},
        "evidence_readiness": {"status": "ready", "selected_primary_rows": [{"row_id": "A:0"}]},
        "source_provenance": {"counts": {"primary_report": 2}, "publication_ready": True},
        "study_cards": [
            {
                "display_name": "EMPEROR-Preserved",
                "study_label": "Anker 2021",
                "intervention": "empagliflozin",
                "analysis_population": "HFpEF/HFmrEF",
                "distinctive_feature": "large event-driven RCT",
                "source_provenance_tier": "primary_report",
            }
        ],
    }

    block = writer._section_fact_contract_block("results")

    assert "Fact-grounded writing contract" in block
    assert "primary_effect" in block
    assert "The pooled HR was 0.81" in block
    assert "HFpEF is common" not in block
    assert "EMPEROR-Preserved" in block
    assert "primary_report" in block


def test_evidence_understanding_cards_merge_into_study_cards_without_overriding_numeric_facts() -> None:
    base_cards = [
        {
            "study_id": "RECOVERY",
            "display_name": "RECOVERY",
            "weight": 82.5,
            "analysis_population": "Adults hospitalized with COVID-19",
            "effect_measure": "OR",
            "effect": 0.64,
        }
    ]
    evidence_understanding = {
        "study_cards": [
            {
                "study_id": "RECOVERY",
                "display_name": "RECOVERY Collaborative Group",
                "design": "Open-label platform randomized trial",
                "population": "Hospitalized adults, including a respiratory-support subgroup",
                "primary_outcome": "28-day mortality",
                "outcome_window": "28 days",
                "distinctive_feature": "Dominant weight trial with pragmatic platform design",
                "clinical_quirks": ["Open-label treatment but mortality outcome is less subjective."],
                "risk_notes": ["Protocol-driven platform design should be discussed separately from blinding."],
                "source_backed_claims": [
                    {
                        "claim": "RECOVERY supplied the largest share of deaths.",
                        "source_location": "Table 2",
                        "source_quote": "Deaths were reported by respiratory support subgroup.",
                    }
                ],
            }
        ],
        "cross_study_claims": [],
    }

    merged = _merge_evidence_understanding_study_cards(base_cards, evidence_understanding)

    assert merged[0]["effect"] == 0.64
    assert merged[0]["analysis_population"] == "Adults hospitalized with COVID-19"
    assert merged[0]["llm_population"].startswith("Hospitalized adults")
    assert merged[0]["design_note"] == "Open-label platform randomized trial"
    assert merged[0]["clinical_quirks"] == ["Open-label treatment but mortality outcome is less subjective."]
    assert merged[0]["source_backed_claims"][0]["source_location"] == "Table 2"
    assert merged[0]["evidence_understanding_available"] is True


def test_llm_claim_map_uses_evidence_understanding_before_authoring() -> None:
    writer = WritingAgent()

    def fake_structured(prompt, schema, **kwargs):
        assert "Build a claim map before prose writing" in prompt
        assert schema is ManuscriptClaimMap
        return ManuscriptClaimMap(
            summary="Focused claim map from study cards.",
            claims=[
                ManuscriptClaimItem(
                    id="clinical_boundary",
                    section="Discussion",
                    argument_step="applicability",
                    claim="The finding applies most directly to patients requiring oxygen or ICU-level support.",
                    support_source="study_cards.RECOVERY.source_backed_claims",
                    source_study_id="RECOVERY",
                    source_location="Table 2",
                    source_quote="Respiratory support subgroup deaths were reported.",
                    manuscript_use="main",
                    can_write_main_text=True,
                )
            ],
            excluded_or_deferred_claims=[
                ManuscriptClaimItem(
                    id="unsupported_guideline",
                    section="Discussion",
                    argument_step="practice_implication",
                    claim="The result changes guideline recommendations.",
                    support_source="not provided",
                    manuscript_use="exclude",
                    can_write_main_text=False,
                )
            ],
            clinical_argument_chain=["applicability"],
            authoring_strategy=["Lead with clinical boundary, then uncertainty."],
        )

    writer.call_llm_structured = fake_structured
    claims, audit = writer._llm_build_manuscript_claim_map(
        _protocol(),
        {
            "study_cards": [
                {
                    "study_id": "RECOVERY",
                    "display_name": "RECOVERY",
                    "evidence_understanding_available": True,
                    "source_backed_claims": [{"claim": "Respiratory support subgroup deaths were reported."}],
                }
            ],
            "evidence_understanding": {"cross_study_claims": []},
            "primary_effect": {"pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
            "primary_population": {"selected_total_participants": 1703},
        },
        [{"id": "base", "claim": "Base claim", "support_source": "facts"}],
    )

    assert audit["status"] == "ok"
    assert audit["claim_count"] == 2
    assert audit["excluded_or_deferred_count"] == 1
    assert claims[0]["id"] == "clinical_boundary"
    assert claims[0]["source_location"] == "Table 2"
    assert any(item["id"] == "conc_primary_effect" for item in claims)


def test_background_evidence_context_feeds_claim_map_and_controversy_candidates() -> None:
    protocol = ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve HFpEF outcomes?",
        pico=PICO(
            population="Adults with HFpEF or HFmrEF",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Composite of cardiovascular death or heart failure hospitalization",
        ),
        effect_measure="HR",
    )
    background = _compact_background_evidence_context({
        "status": "ok",
        "query": "SGLT2 HFpEF guideline controversy",
        "references": [
            {
                "study_id": "pubmed_background:1",
                "source_type": "pubmed_background",
                "citation": "[3]",
                "title": "Heart failure with preserved ejection fraction: everything the clinician needs to know.",
                "summary": "HFpEF is a complex clinical syndrome shaped by age, obesity, diabetes, and other comorbidities.",
                "paper": {
                    "pmid": "1",
                    "year": 2024,
                    "journal": "Lancet",
                    "pub_types": ["Review"],
                },
            },
            {
                "study_id": "pubmed_background:2",
                "source_type": "pubmed_background",
                "citation": "[4]",
                "title": "2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure.",
                "summary": "The guideline provides recommendations for heart failure treatment based on contemporary evidence.",
                "paper": {
                    "pmid": "2",
                    "year": 2022,
                    "journal": "Circulation",
                    "pub_types": ["Practice Guideline"],
                },
            },
        ],
    })
    candidates = _domain_controversy_candidates(
        protocol=protocol,
        background_evidence=background,
        evidence_understanding={},
        study_cards=[],
    )

    assert background["reference_count"] == 2
    assert background["references"][0]["source_quote"].startswith("HFpEF is a complex")
    assert any(item["kind"] == "endpoint_interpretation" for item in candidates)
    assert any(item["kind"] == "guideline_context" for item in candidates)
    assert any(item["kind"] == "applicability" for item in candidates)


def test_llm_claim_map_uses_background_evidence_without_study_cards() -> None:
    writer = WritingAgent()
    seen_prompt = {}

    def fake_structured(prompt, schema, **kwargs):
        seen_prompt["text"] = prompt
        assert "background_evidence" in prompt
        assert "domain_controversy_candidates" in prompt
        assert schema is ManuscriptClaimMap
        return ManuscriptClaimMap(
            summary="Background-informed claim map.",
            claims=[
                ManuscriptClaimItem(
                    id="background_hfpef_complexity",
                    section="Introduction",
                    claim_type="background",
                    argument_step="clinical_problem",
                    claim="HFpEF is clinically heterogeneous and shaped by comorbidities.",
                    support_source="background_evidence.references.pubmed_background:1",
                    source_study_id="pubmed_background:1",
                    source_location="Heart failure with preserved ejection fraction review",
                    source_quote="HFpEF is a complex clinical syndrome shaped by age, obesity, diabetes, and other comorbidities.",
                    manuscript_use="main",
                    can_write_main_text=True,
                ),
                ManuscriptClaimItem(
                    id="endpoint_tension",
                    section="Discussion",
                    claim_type="controversy",
                    argument_step="endpoint_interpretation",
                    claim="Composite endpoints require component-level interpretation.",
                    support_source="domain_controversy_candidates.endpoint_interpretation",
                    source_study_id="protocol.pico",
                    source_location="Primary outcome",
                    source_quote="Composite of cardiovascular death or heart failure hospitalization",
                    manuscript_use="main",
                    can_write_main_text=True,
                ),
            ],
            excluded_or_deferred_claims=[],
            clinical_argument_chain=["clinical_problem", "objective", "endpoint_interpretation"],
            authoring_strategy=["Use background evidence for Introduction, then endpoint tension in Discussion."],
        )

    writer.call_llm_structured = fake_structured
    claims, audit = writer._llm_build_manuscript_claim_map(
        _protocol(),
        {
            "study_cards": [],
            "evidence_understanding": {},
            "background_evidence": {
                "references": [
                    {
                        "study_id": "pubmed_background:1",
                        "title": "HFpEF review",
                        "summary": "HFpEF is a complex clinical syndrome shaped by age, obesity, diabetes, and other comorbidities.",
                    }
                ]
            },
            "domain_controversy_candidates": [
                {
                    "kind": "endpoint_interpretation",
                    "candidate_claim": "Composite endpoints require component-level interpretation.",
                    "support_source": "protocol.pico.outcome_primary",
                    "source_quote": "Composite of cardiovascular death or heart failure hospitalization",
                }
            ],
            "primary_effect": {"pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
            "primary_population": {"selected_total_participants": 12251},
        },
        [{"id": "base", "claim": "Base claim", "support_source": "facts"}],
    )

    assert audit["status"] == "ok"
    assert audit["background_evidence_count"] == 1
    assert audit["domain_controversy_candidate_count"] == 1
    assert audit["argument_step_counts"]["clinical_problem"] == 1
    assert audit["argument_step_counts"]["endpoint_interpretation"] == 1
    assert audit["clinical_argument_chain"] == ["clinical_problem", "objective", "endpoint_interpretation"]
    assert {item["claim_type"] for item in claims} == {"background", "controversy", "conclusion"}
    assert {"clinical_problem", "endpoint_interpretation"}.issubset({item["argument_step"] for item in claims})
    assert "HFpEF is clinically heterogeneous" in claims[0]["claim"]
    assert "claim_type" in seen_prompt["text"]
    assert "argument_step" in seen_prompt["text"]
    assert "clinical_argument_chain" in seen_prompt["text"]


def test_llm_claim_map_expands_thin_clinical_argument_chain() -> None:
    writer = WritingAgent()
    calls = []

    def fake_structured(prompt, schema, **kwargs):
        assert schema is ManuscriptClaimMap
        calls.append(prompt)
        if len(calls) == 1:
            return ManuscriptClaimMap(
                summary="Thin map.",
                claims=[
                    ManuscriptClaimItem(
                        id="objective",
                        section="Introduction",
                        claim_type="objective",
                        argument_step="objective",
                        claim="This review evaluates treatment versus placebo.",
                        support_source="protocol.pico",
                        source_quote="PICO",
                    ),
                    ManuscriptClaimItem(
                        id="primary",
                        section="Results",
                        claim_type="result",
                        argument_step="primary_finding",
                        claim="The pooled effect favored treatment.",
                        support_source="analysis.meta_results.primary_outcome",
                        source_quote="HR 0.81",
                    ),
                ],
                clinical_argument_chain=["objective", "primary_finding"],
            )
        assert "THINNESS DIAGNOSIS" in prompt
        return ManuscriptClaimMap(
            summary="Expanded clinical argument map.",
            claims=[
                ManuscriptClaimItem(id="problem", section="Introduction", claim_type="background", argument_step="clinical_problem", claim="HFpEF is common and clinically heterogeneous.", support_source="background_evidence", source_quote="HFpEF is complex."),
                ManuscriptClaimItem(id="gap", section="Introduction", claim_type="background", argument_step="evidence_gap", claim="The treatment question remains clinically specific.", support_source="protocol.pico", source_quote="PICO"),
                ManuscriptClaimItem(id="objective", section="Introduction", claim_type="objective", argument_step="objective", claim="This review evaluates treatment versus placebo.", support_source="protocol.pico", source_quote="PICO"),
                ManuscriptClaimItem(id="primary", section="Results", claim_type="result", argument_step="primary_finding", claim="The pooled effect favored treatment.", support_source="analysis.meta_results.primary_outcome", source_quote="HR 0.81"),
                ManuscriptClaimItem(id="meaning", section="Discussion", claim_type="result", argument_step="clinical_significance", claim="The result is clinically relevant because the outcome captures major heart failure events.", support_source="primary_effect + protocol.pico", source_quote="Composite outcome"),
                ManuscriptClaimItem(id="endpoint", section="Discussion", claim_type="controversy", argument_step="endpoint_interpretation", claim="The composite endpoint requires component-level interpretation.", support_source="protocol.pico.outcome_primary", source_quote="Composite of cardiovascular death or hospitalization."),
                ManuscriptClaimItem(id="apply", section="Discussion", claim_type="applicability", argument_step="applicability", claim="The finding applies to adults with LVEF at least 40%.", support_source="protocol.pico.population", source_quote="LVEF ≥40%"),
                ManuscriptClaimItem(id="limit", section="Discussion", claim_type="limitation", argument_step="evidence_limit", claim="Few contributing studies limit small-study-effect assessment.", support_source="grade.publication_bias", source_quote="Only two studies."),
                ManuscriptClaimItem(id="practice", section="Discussion", claim_type="conclusion", argument_step="practice_implication", claim="The result supports cautious clinical interpretation alongside baseline risk.", support_source="primary_effect + grade", source_quote="HR 0.81; moderate certainty."),
                ManuscriptClaimItem(id="future", section="Conclusion", claim_type="conclusion", argument_step="future_research", claim="Further evidence should clarify components and longer-term safety.", support_source="domain_controversy_candidates", source_quote="Component interpretation and safety."),
            ],
            clinical_argument_chain=[
                "clinical_problem", "evidence_gap", "objective", "primary_finding",
                "clinical_significance", "endpoint_interpretation", "applicability",
                "evidence_limit", "practice_implication", "future_research",
            ],
        )

    writer.call_llm_structured = fake_structured
    claims, audit = writer._llm_build_manuscript_claim_map(
        _protocol(),
        {
            "study_cards": [],
            "evidence_understanding": {},
            "background_evidence": {"references": [{"study_id": "bg:1", "summary": "HFpEF is complex."}]},
            "domain_controversy_candidates": [
                {
                    "kind": "endpoint_interpretation",
                    "candidate_claim": "The composite endpoint requires component-level interpretation.",
                    "support_source": "protocol.pico.outcome_primary",
                    "source_quote": "Composite outcome",
                }
            ],
            "primary_effect": {"pooled_effect": 0.81, "ci_lower": 0.74, "ci_upper": 0.88},
            "primary_population": {"selected_total_participants": 12251},
        },
        [{"id": "base", "claim": "Base claim", "support_source": "facts"}],
    )

    assert len(calls) == 2
    assert audit["claim_map_development"]["status"] == "expanded"
    assert audit["claim_count"] == 11
    assert audit["primary_conclusion_claim_inserted"] is True
    assert audit["argument_step_counts"]["clinical_significance"] == 1
    assert audit["argument_step_counts"]["practice_implication"] == 2
    assert any(item["argument_step"] == "endpoint_interpretation" for item in claims)


def test_claim_map_preserves_available_safety_notes_as_positive_scope_claim() -> None:
    writer = WritingAgent()
    claims = [
        {
            "id": "bad_safety",
            "section": "Discussion",
            "claim_type": "safety",
            "argument_step": "safety_scope",
            "claim": "Structured safety notes were not provided for meta-analysis.",
            "support_source": "Absence of safety_notes in structured data",
            "source_quote": "No safety_notes provided for quantitative pooling",
        }
    ]
    facts = {
        "study_cards": [
            {
                "display_name": "Solomon 2022",
                "safety_notes": [
                    "Serious adverse events occurred in 43.5% of dapagliflozin vs 45.5% of placebo.",
                    "Adverse events leading to discontinuation were similar between groups.",
                ],
            }
        ]
    }

    repaired, inserted = writer._ensure_safety_scope_claim(claims, facts)

    assert inserted is True
    assert len(repaired) == 1
    assert repaired[0]["id"] == "safety_scope"
    assert "not quantitatively pooled" in repaired[0]["claim"]
    assert "43.5%" in repaired[0]["source_quote"]
    assert "not provided" not in repaired[0]["claim"].lower()


def test_claim_map_authoring_rewrites_only_open_argument_sections() -> None:
    writer = WritingAgent()
    manuscript = "\n".join([
        "# Title",
        "",
        "## Introduction",
        "",
        "Old introduction.",
        "",
        "## Methods",
        "",
        "Methods must stay deterministic.",
        "",
        "## Results",
        "",
        "Results must stay deterministic.",
        "",
        "## Discussion",
        "",
        "Old discussion.",
        "",
        "## Conclusion",
        "",
        "Old conclusion.",
        "",
        "## References",
        "",
        "1. Example reference.",
    ])

    def fake_structured(prompt, schema, **kwargs):
        if schema is SemanticGuardAdjudication:
            return SemanticGuardAdjudication(
                accept=True,
                reason="The candidate is supported by the supplied claim map and structured facts.",
            )
        assert schema is ClaimMapAuthoredSections
        assert "Do not write Methods" in prompt
        assert "clinical_argument_chain" in prompt
        assert "argument_step" in prompt
        return ClaimMapAuthoredSections(
            summary="Re-authored open clinical argument sections.",
            sections=[
                ClaimMapSectionDraft(
                    heading="Introduction",
                    replacement_markdown="New introduction grounded in the study cards.",
                    claims_used=["objective"],
                ),
                ClaimMapSectionDraft(
                    heading="Methods",
                    replacement_markdown="This should be rejected.",
                    claims_used=["method_claim"],
                ),
                ClaimMapSectionDraft(
                    heading="Discussion",
                    replacement_markdown="New discussion interprets the same effect estimate through clinical boundaries.",
                    claims_used=["clinical_boundary"],
                ),
                ClaimMapSectionDraft(
                    heading="Conclusion",
                    replacement_markdown="New conclusion states the supported clinical takeaway without new facts.",
                    claims_used=["takeaway"],
                ),
            ],
            unsupported_claims_not_used=["Guideline adoption was not supported by supplied sources."],
        )

    writer.call_llm_structured = fake_structured
    repaired, audit = writer._llm_author_open_sections_from_claim_map(
        manuscript,
        {
            "claim_map": [
                {
                    "id": "objective",
                    "section": "Introduction",
                    "argument_step": "objective",
                    "claim": "Supported objective",
                    "support_source": "protocol",
                }
            ],
            "clinical_argument_chain": ["objective", "applicability", "practice_implication"],
            "study_cards": [{"study_id": "RECOVERY", "evidence_understanding_available": True}],
            "evidence_understanding": {"cross_study_claims": []},
            "primary_effect": {"pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
            "primary_population": {"selected_total_participants": 1703},
            "grade": {"outcomes": [{"certainty": "moderate"}]},
        },
    )

    assert audit["accepted_sections"] == 3
    assert audit["rejected_sections"] == 1
    assert "New introduction grounded in the study cards." in repaired
    assert "Methods must stay deterministic." in repaired
    assert "This should be rejected." not in repaired
    assert "Results must stay deterministic." in repaired
    assert "unsupported_claims_not_used" in audit


def test_claim_map_authoring_guard_uses_claim_map_not_old_template(monkeypatch) -> None:
    writer = WritingAgent()
    manuscript = "\n".join([
        "# Title",
        "",
        "## Introduction",
        "",
        "Old template-heavy introduction with citations [1,2] and many extra numeric tokens 1 2 3.",
        "",
        "## Discussion",
        "",
        "Old discussion.",
    ])

    def fake_structured(prompt, schema, **kwargs):
        if schema is ClaimMapAuthoredSections:
            return ClaimMapAuthoredSections(
                summary="Claim-map authoring.",
                sections=[
                    ClaimMapSectionDraft(
                        heading="Introduction",
                        replacement_markdown="This review evaluates treatment for mortality in adults, using the approved claim map.",
                        claims_used=["objective"],
                        rationale="Replace old template prose with evidence-grounded objective.",
                    )
                ],
            )
        raise AssertionError(f"Unexpected structured schema: {schema}")

    writer.call_llm_structured = fake_structured
    monkeypatch.setattr(
        writing_module,
        "preservation_guard_issues",
        lambda original, replacement, heading: [
            {"code": "rewrite_overcompressed", "message": "Candidate is shorter than old template."},
            {"code": "citations_changed", "message": "Citation markers changed."},
        ],
    )
    monkeypatch.setattr(
        writer,
        "_adjudicate_claim_map_authoring_guard",
        lambda **kwargs: SemanticGuardAdjudication(
            accept=True,
            reason="Candidate is supported by the approved claim map and does not add unsupported facts.",
        ),
    )

    repaired, audit = writer._llm_author_open_sections_from_claim_map(
        manuscript,
        {
            "claim_map": [
                {
                    "id": "objective",
                    "section": "Introduction",
                    "claim": "This review evaluates treatment for mortality in adults.",
                    "support_source": "protocol.pico",
                    "can_write_main_text": True,
                    "manuscript_use": "main",
                }
            ],
            "study_cards": [{"study_id": "S1", "evidence_understanding_available": True}],
            "evidence_understanding": {"cross_study_claims": []},
            "primary_effect": {"outcome_name": "Mortality", "n_studies": 2},
            "primary_population": {"selected_total_participants": 200},
            "grade": {"outcomes": [{"certainty": "moderate"}]},
        },
    )

    assert audit["accepted_sections"] == 1
    assert audit["rejected_sections"] == 0
    assert "authoring_evidence_judge_accepted" in {
        item.get("code") for item in audit["issues"]
    }
    assert "approved claim map" in repaired


def test_claim_map_authoring_judge_does_not_receive_old_template_guard_noise() -> None:
    writer = WritingAgent()
    seen_prompt = {}

    def fake_structured(prompt, schema, **kwargs):
        assert schema is SemanticGuardAdjudication
        seen_prompt["text"] = prompt
        return SemanticGuardAdjudication(
            accept=True,
            reason="The candidate is grounded in the section claims.",
        )

    writer.call_llm_structured = fake_structured
    decision = writer._adjudicate_claim_map_authoring_guard(
        heading="Introduction",
        candidate_body="HFpEF is clinically complex. This review evaluates SGLT2 inhibitors versus placebo.",
        guard_issues=[
            {"code": "rewrite_overcompressed", "message": "Candidate is shorter than old template."},
            {"code": "clinical_entities_changed", "message": "Old template clinical entities changed."},
        ],
        facts={
            "claim_map": [
                {
                    "id": "intro_bg",
                    "section": "Introduction",
                    "claim": "HFpEF is clinically complex.",
                    "source_quote": "HFpEF is recognised as a complex clinical syndrome.",
                    "support_source": "background evidence",
                },
                {
                    "id": "intro_obj",
                    "section": "Introduction",
                    "claim": "This review evaluates SGLT2 inhibitors versus placebo.",
                    "support_source": "protocol.pico",
                },
            ],
            "study_cards": [{"study_id": "S1"}],
            "primary_effect": {"n_studies": 2},
            "primary_population": {"selected_total_participants": 100},
            "grade": {"outcomes": [{"certainty": "moderate"}]},
        },
        claims_used=["intro_bg", "intro_obj"],
        rationale="Use approved introduction claims.",
    )

    assert decision and decision.accept
    assert "DETERMINISTIC GUARD WARNINGS" not in seen_prompt["text"]
    assert "Candidate is shorter than old template" not in seen_prompt["text"]
    assert "Do not compare the candidate against the old section" in seen_prompt["text"]


def test_claim_map_authoring_repairs_rejected_section_with_claim_map_feedback(monkeypatch) -> None:
    writer = WritingAgent()
    manuscript = "\n".join([
        "# Title",
        "",
        "## Introduction",
        "",
        "Old template introduction.",
        "",
        "## Discussion",
        "",
        "Old discussion.",
    ])
    calls = []

    def fake_structured(prompt, schema, **kwargs):
        calls.append(schema)
        if schema is ClaimMapAuthoredSections:
            return ClaimMapAuthoredSections(
                summary="Initial claim-map authoring with one unsupported flourish.",
                sections=[
                    ClaimMapSectionDraft(
                        heading="Introduction",
                        replacement_markdown=(
                            "This review evaluates treatment for mortality in adults. "
                            "The findings should immediately change guideline practice."
                        ),
                        claims_used=["objective"],
                        rationale="Use the objective but the first draft overreached.",
                    )
                ],
            )
        if schema is ClaimMapSectionDraft:
            assert "EVIDENCE REVIEW REJECTION REASON" in prompt
            assert "SECTION CLAIMS" in prompt
            assert "reviewer checklist" in prompt
            assert "Do not remove the primary effect" in prompt
            return ClaimMapSectionDraft(
                heading="Introduction",
                replacement_markdown="This review evaluates treatment for mortality in adults.",
                claims_used=["objective"],
                rationale="Removed the unsupported guideline implication.",
            )
        raise AssertionError(f"Unexpected structured schema: {schema}")

    writer.call_llm_structured = fake_structured
    monkeypatch.setattr(
        writing_module,
        "preservation_guard_issues",
        lambda original, replacement, heading: (
            [{"code": "unsupported_source_characterization", "message": "Guideline claim is unsupported."}]
            if "guideline practice" in replacement
            else []
        ),
    )
    def fake_claim_map_judge(**kwargs):
        if "guideline practice" in kwargs.get("candidate_body", ""):
            return SemanticGuardAdjudication(
                accept=False,
                reason="The candidate adds a guideline implication not present in the claim map.",
            )
        return SemanticGuardAdjudication(
            accept=True,
            reason="The revised section is grounded in the approved claim map.",
        )

    monkeypatch.setattr(writer, "_adjudicate_claim_map_authoring_guard", fake_claim_map_judge)
    monkeypatch.setattr(
        writer,
        "_adjudicate_semantic_guard",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("semantic guard should not decide claim-map authoring")),
    )

    repaired, audit = writer._llm_author_open_sections_from_claim_map(
        manuscript,
        {
            "claim_map": [
                {
                    "id": "objective",
                    "section": "Introduction",
                    "claim": "This review evaluates treatment for mortality in adults.",
                    "support_source": "protocol.pico",
                    "can_write_main_text": True,
                    "manuscript_use": "main",
                }
            ],
            "study_cards": [{"study_id": "S1", "evidence_understanding_available": True}],
            "evidence_understanding": {"cross_study_claims": []},
            "primary_effect": {"outcome_name": "Mortality", "n_studies": 2},
            "primary_population": {"selected_total_participants": 200},
            "grade": {"outcomes": [{"certainty": "moderate"}]},
        },
    )

    assert calls == [ClaimMapAuthoredSections, ClaimMapSectionDraft]
    assert audit["accepted_sections"] == 1
    assert audit["rejected_sections"] == 0
    assert "claim_map_authoring_repaired_and_accepted" in {
        item.get("code") for item in audit["issues"]
    }
    assert "guideline practice" not in repaired
    assert "evaluates treatment for mortality" in repaired


def test_claim_map_authoring_audit_records_rejected_repair(monkeypatch) -> None:
    writer = WritingAgent()
    manuscript = "\n".join([
        "# Title",
        "",
        "## Discussion",
        "",
        "Old discussion with the correct core result.",
    ])

    def fake_structured(prompt, schema, **kwargs):
        if schema is ClaimMapAuthoredSections:
            return ClaimMapAuthoredSections(
                summary="Initial draft overreached.",
                sections=[
                    ClaimMapSectionDraft(
                        heading="Discussion",
                        replacement_markdown="The intervention proves benefit and should change guidelines.",
                        claims_used=["finding"],
                        rationale="Overreached beyond the approved claim.",
                    )
                ],
            )
        if schema is ClaimMapSectionDraft:
            return ClaimMapSectionDraft(
                heading="Discussion",
                replacement_markdown="The intervention proves benefit.",
                claims_used=["finding"],
                rationale="Still overstates certainty.",
            )
        raise AssertionError(f"Unexpected structured schema: {schema}")

    writer.call_llm_structured = fake_structured
    monkeypatch.setattr(
        writing_module,
        "preservation_guard_issues",
        lambda original, replacement, heading: [
            {"code": "unsupported_source_characterization", "message": "Claim strength is too strong."}
        ],
    )
    monkeypatch.setattr(
        writer,
        "_adjudicate_claim_map_authoring_guard",
        lambda **kwargs: SemanticGuardAdjudication(
            accept=False,
            reason="The candidate intensifies the approved cautious claim.",
        ),
    )
    monkeypatch.setattr(
        writer,
        "_adjudicate_semantic_guard",
        lambda **kwargs: SemanticGuardAdjudication(
            accept=False,
            reason="The candidate intensifies the approved cautious claim.",
        ),
    )

    repaired, audit = writer._llm_author_open_sections_from_claim_map(
        manuscript,
        {
            "claim_map": [
                {
                    "id": "finding",
                    "section": "Discussion",
                    "claim": "The intervention may reduce the outcome in the pooled analysis.",
                    "support_source": "primary_effect",
                    "can_write_main_text": True,
                    "manuscript_use": "main",
                }
            ],
            "study_cards": [{"study_id": "S1", "evidence_understanding_available": True}],
            "evidence_understanding": {"cross_study_claims": []},
            "primary_effect": {"outcome_name": "Mortality", "n_studies": 2},
            "primary_population": {"selected_total_participants": 200},
            "grade": {"outcomes": [{"certainty": "moderate"}]},
        },
    )

    assert repaired == manuscript
    assert audit["accepted_sections"] == 0
    assert audit["rejected_sections"] == 1
    codes = {item.get("code") for item in audit["issues"]}
    assert "claim_map_authoring_repair_rejected" in codes
    assert "authoring_evidence_judge_rejected" in codes


def test_claim_section_citations_use_claim_level_contract() -> None:
    writer = WritingAgent()
    writer._lang = "zh"
    entries = [
        {
            "number": 1,
            "text": "Anker SD, et al. Empagliflozin in Heart Failure with a Preserved Ejection Fraction. PMID: 34449189.",
        },
        {
            "number": 2,
            "text": "Solomon SD, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. PMID: 36027570.",
        },
    ]
    facts = {
        "claim_map": [
            {
                "id": "disc_trial_scope",
                "section": "讨论",
                "claim": "Anker 2021和Solomon 2022提供了主要分析证据。",
                "source_study_id": "34449189, 36027570",
                "source_location": "Primary reports",
                "support_source": "trial reports",
            },
            {
                "id": "disc_primary_effect",
                "section": "讨论",
                "claim": "合并分析显示SGLT2抑制剂可能降低主要复合终点风险。",
                "source_study_id": "34449189, 36027570",
                "source_location": "Primary meta-analysis",
                "support_source": "primary_effect data",
            }
        ],
        "evidence_readiness": {
            "selected_primary_rows": [
                {"study_id": "34449189", "study_label": "Anker 2021"},
                {"study_id": "36027570", "study_label": "Solomon 2022"},
            ]
        },
    }
    refs_text = "\n\n".join(f"[{entry['number']}] {entry['text']}" for entry in entries)
    writer._current_claim_citation_facts = facts
    writer._claim_map_reference_entries = entries
    writer._claim_map_references_text = refs_text
    writer._claim_map_citation_contract = writer._claim_citation_contract(entries, facts, refs_text)

    body = "Anker 2021和Solomon 2022提供了主要分析证据。合并分析显示SGLT2抑制剂可能降低主要复合终点风险。"
    restored = writer._apply_claim_section_citations("讨论", body, facts)

    assert "［1，2］" in restored
    assert writer._claim_map_citation_contract["disc_trial_scope"]["reference_numbers"] == [1, 2]
    assert writer._claim_map_citation_contract["disc_primary_effect"]["reference_numbers"] == [1, 2]

    contract_doc = writer._citation_contract_document(facts)
    assert contract_doc.status == "ok"
    assert {item.claim_id for item in contract_doc.items} == {"disc_trial_scope", "disc_primary_effect"}
    primary_item = next(item for item in contract_doc.items if item.claim_id == "disc_primary_effect")
    assert primary_item.reference_numbers == [1, 2]
    assert primary_item.reference_ids == ["pmid:34449189", "pmid:36027570"]
    assert primary_item.source_spans
    assert primary_item.source_spans[0].source_id == "34449189, 36027570"
    assert primary_item.source_spans[0].support_strength == "indirect"


def test_claim_citation_contract_keeps_structured_fact_claims_without_reference_numbers() -> None:
    writer = WritingAgent()
    writer._lang = "en"
    facts = {
        "claim_map": [
            {
                "id": "intro_obj",
                "section": "Introduction",
                "claim": "This review evaluates the prespecified PICO question.",
                "support_source": "Research question and PICO definition",
                "source_spans": [
                    {
                        "source_id": "pico",
                        "source_type": "structured_fact",
                        "location": "Protocol PICO",
                        "quote": "Population, intervention, comparator, and outcome were prespecified.",
                        "verified": True,
                        "support_strength": "structured",
                    }
                ],
            }
        ]
    }

    writer._claim_map_reference_entries = []
    writer._claim_map_references_text = ""
    writer._claim_map_citation_contract = writer._claim_citation_contract([], facts, "")

    assert "intro_obj" in writer._claim_map_citation_contract
    assert writer._claim_map_citation_contract["intro_obj"]["reference_numbers"] == []
    contract_doc = writer._citation_contract_document(facts)
    assert contract_doc.status == "ok"
    assert len(contract_doc.items) == 1
    assert contract_doc.items[0].claim_id == "intro_obj"
    assert contract_doc.items[0].citation == ""
    assert contract_doc.items[0].source_spans[0].source_type == "structured_fact"


def test_claim_map_citations_do_not_backfill_uncited_internal_claims() -> None:
    writer = WritingAgent()
    writer._lang = "en"
    entries = [
        {
            "number": 4,
            "text": "HFpEF Review. Heart failure with preserved ejection fraction clinical syndrome. PMID: 38367642.",
        }
    ]
    refs_text = "\n\n".join(f"[{entry['number']}] {entry['text']}" for entry in entries)
    facts = {
        "claim_map": [
            {
                "id": "intro_bg",
                "section": "Introduction",
                "claim": "HFpEF is recognised as a complex clinical syndrome.",
                "support_source": "background_evidence.references",
                "source_study_id": "pubmed_background:38367642",
                "source_location": "HFpEF Review",
                "source_quote": "HFpEF is recognised as a complex clinical syndrome.",
            },
            {
                "id": "intro_obj",
                "section": "Introduction",
                "claim": "This review evaluates SGLT2 inhibitors versus placebo.",
                "support_source": "pico_definition",
                "source_location": "PICO Definition",
            },
        ]
    }
    writer._claim_map_reference_entries = entries
    writer._claim_map_references_text = refs_text
    writer._claim_map_citation_candidates = {"Introduction": ["[4]"]}
    writer._claim_map_citation_contract = writer._claim_citation_contract(entries, facts, refs_text)

    body = (
        "HFpEF is recognised as a complex clinical syndrome. "
        "This review evaluates SGLT2 inhibitors versus placebo."
    )
    restored = writer._apply_claim_section_citations("Introduction", body, facts)

    assert "syndrome [4]." in restored or "syndrome[4]." in restored
    assert "placebo [4]." not in restored
    assert "placebo[4]." not in restored


def test_claim_citation_sentence_splitter_preserves_common_abbreviations() -> None:
    writer = WritingAgent()
    sentence = (
        "The absolute effect may be larger in higher-risk populations "
        "(e.g., recently discharged patients). The estimate remains contextual."
    )

    spans = [sentence[start:end] for start, end in writer._sentence_spans_for_claim_citations(sentence)]

    assert spans == [
        "The absolute effect may be larger in higher-risk populations (e.g., recently discharged patients). ",
        "The estimate remains contextual.",
    ]


def test_claim_section_matching_handles_cross_language_composite_sections() -> None:
    writer = WritingAgent()
    writer._lang = "zh"

    assert writer._claim_section_matches_heading("Results/Discussion", "讨论")
    assert writer._claim_section_matches_heading("结果/讨论", "Discussion")
    assert not writer._claim_section_matches_heading("Methods", "讨论")


def test_llm_claim_source_alignment_revises_unsupported_applicability_phrase() -> None:
    writer = WritingAgent()
    writer._lang = "zh"

    def fake_structured(prompt, schema, **kwargs):
        assert schema is ClaimSourceAlignmentReview
        assert "semantic source-alignment" in prompt
        assert "Examples introduced with" in prompt
        assert "Do not intensify evidentiary strength" in prompt
        assert "specific diagnostic scores" in prompt
        return ClaimSourceAlignmentReview(
            summary="Narrowed applicability to supplied PICO and endpoint caveat.",
            items=[
                ClaimSourceAlignmentItem(
                    id="disc_applicability",
                    decision="revise",
                    revised_claim=(
                        "该合并结果最直接适用于射血分数轻度降低或保留的成人心力衰竭患者；"
                        "若用于临床决策，应结合当地急诊就诊阈值和随访方式判断绝对获益。"
                    ),
                    reason="The diagnostic scoring tools were not supported by the source quote.",
                    unsupported_phrases=["HFA-PEFF", "H2FPEF"],
                )
            ],
        )

    writer.call_llm_structured = fake_structured
    claims, audit = writer._llm_align_claim_sources(
        [
            {
                "id": "disc_applicability",
                "section": "Discussion",
                "claim_type": "applicability",
                "argument_step": "applicability",
                "claim": "该合并结果最直接适用于符合当代诊断标准（如HFA-PEFF或H2FPEF评分）的HFmrEF和HFpEF成人患者。",
                "support_source": "endpoint_definition_discussion & pico",
                "source_location": "Discussion Context",
                "source_quote": "若用于患者沟通或指南推荐，应结合当地急诊就诊、住院阈值和随访方式判断绝对获益。",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ],
        {
            "pico": {"population": "Adults with HFmrEF or HFpEF"},
            "research_question": "SGLT2 inhibitors in HFmrEF/HFpEF",
            "primary_effect": {"pooled_effect": 0.81},
        },
    )

    assert audit["changed"] is True
    assert audit["reviewed_claim_ids"] == ["disc_applicability"]
    assert len(audit["alignment_input_hash"]) == 64
    assert audit["revised_claims"][0]["id"] == "disc_applicability"
    assert "HFA-PEFF" not in claims[0]["claim"]
    assert "射血分数轻度降低或保留" in claims[0]["claim"]


def test_llm_claim_source_alignment_contract_covers_examples_and_overstrength() -> None:
    writer = WritingAgent()
    writer._lang = "zh"
    seen_prompt = {}

    def fake_structured(prompt, schema, **kwargs):
        assert schema is ClaimSourceAlignmentReview
        seen_prompt["text"] = prompt
        return ClaimSourceAlignmentReview(
            summary="Clinical examples and evidence strength were narrowed to the cited source.",
            items=[
                ClaimSourceAlignmentItem(
                    id="intro_bg",
                    decision="revise",
                    revised_claim="HFpEF是复杂的临床综合征，其诊断和管理具有挑战性。",
                    reason="The source did not explicitly support the obesity and diabetes examples.",
                    unsupported_phrases=["肥胖", "糖尿病"],
                ),
                ClaimSourceAlignmentItem(
                    id="intro_hfref",
                    decision="revise",
                    revised_claim="既往HFrEF试验报告SGLT2抑制剂可降低心血管死亡或心力衰竭住院复合风险。",
                    reason="The source reported trial findings but did not support stronger certainty wording.",
                    unsupported_phrases=["已证实"],
                ),
            ],
        )

    writer.call_llm_structured = fake_structured
    claims, audit = writer._llm_align_claim_sources(
        [
            {
                "id": "intro_bg",
                "section": "Introduction",
                "claim": "HFpEF因病理生理多样性及合并症（如肥胖、糖尿病）而具有挑战性。",
                "support_source": "background evidence",
                "source_quote": (
                    "HFpEF is recognised as a complex clinical syndrome. Its diagnosis and management "
                    "are challenging due to diverse pathophysiology."
                ),
                "can_write_main_text": True,
                "manuscript_use": "main",
            },
            {
                "id": "intro_hfref",
                "section": "Introduction",
                "claim": "SGLT2抑制剂在HFrEF患者中已证实可降低心血管死亡或心力衰竭住院风险。",
                "support_source": "background evidence",
                "source_quote": "DAPA-HF and EMPEROR-Reduced showed reduced combined risk in HFrEF.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            },
        ],
        {"pico": {"population": "Adults with HFmrEF or HFpEF"}},
    )

    assert audit["changed"] is True
    assert "Examples introduced with" in seen_prompt["text"]
    assert "Do not intensify evidentiary strength" in seen_prompt["text"]
    assert "肥胖" not in claims[0]["claim"]
    assert "糖尿病" not in claims[0]["claim"]
    assert "已证实" not in claims[1]["claim"]
    assert "报告" in claims[1]["claim"]


def test_quality_gate_blocks_methods_tutorial_prose_in_results() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The aggregate event counts help readers understand burden, but the pooled odds ratio "
        "was calculated from study-level effects rather than from one collapsed table. "
        "This distinction matters because baseline mortality differed across trials.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    gate = manuscript_quality_gate(manuscript, {"report_type": "meta"})

    assert gate["passed"] is False
    issue = next(item for item in gate["issues"] if item["code"] == "methodology_meta_prose_in_body_section")
    assert issue["severity"] == "error"
    assert issue["section"] == "Results"


def test_embed_figures_uses_relative_files_not_base64(tmp_path: Path) -> None:
    project = Project("figure-paths", output_dir=tmp_path)
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    (figures_dir / "forest_plot.png").write_bytes(b"png")

    section = WritingAgent()._embed_figures(
        {"forest_plot": "data:image/png;base64,abc"},
        project=project,
    )

    assert "data:image/" not in section
    assert "![Figure 1. Forest plot](../figures/forest_plot.png)" in section


def test_quality_gate_blocks_base64_figure_data_uri() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "Figure 1 shows the primary analysis.\n\n"
        "## Figures\n\n"
        "![Figure 1. Forest plot](data:image/png;base64,abc)\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    gate = manuscript_quality_gate(manuscript, {"report_type": "meta"})

    assert gate["passed"] is False
    assert any(item["code"] == "embedded_base64_image_in_manuscript" for item in gate["issues"])


def test_validate_manuscript_repairs_process_notes_nr_total_and_pub_bias_overclaim() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {
            "outcome_name": "Composite endpoint",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
        },
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "# Title\n\n"
        "## Abstract\n\n"
        "The total sample size of the included eligible RCTs was not fully reported (NR). "
        "Publication bias was not significant.\n\n"
        "## Methods\n\n"
        "Data extraction was performed using an automated system with self-verification capabilities. "
        "No manual hand-extraction by human reviewers was explicitly described beyond the automated verification steps.\n\n"
        "## Results\n\n"
        "> **Methodological note**: Due to heterogeneity in outcome measurement, pooled results should be interpreted with caution.\n\n"
        "HR 0.81 (95% CI 0.74 to 0.88).\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "not fully reported (NR)" not in repaired
    assert "12,251 participants" in repaired
    assert "Publication bias was not significant" not in repaired
    assert "fewer than 10 studies" in repaired
    assert "automated system" not in repaired
    assert "self-verification" not in repaired
    assert "No manual hand-extraction" not in repaired
    assert "Methodological note" not in repaired
    kinds = {item["kind"] for item in report["issues"]}
    assert "sample_size_nr_repaired" in kinds
    assert "publication_bias_overclaim" in kinds
    assert "machine_note_removed" in kinds


def test_validate_manuscript_repairs_file_path_spacing_and_reviewer_process_artifacts() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {
            "outcome_name": "Composite endpoint",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
        },
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Methods\n\n"
        "the review process screened the records against criteria. "
        "Assessments were conducted independently by two reviewers. "
        "Any disagreements in risk of bias judgments were resolved through discussion.\n\n"
        "## Declarations\n\n"
        "Data are available at protocol. json, manuscript/manuscript_facts. json, and references. bib. "
        "The primary report is available at https://www. nejm. org/doi/pdf/10.1056/NEJMoa2107038? articleTools=true. "
        "Examples included e. g. trial reports. Does the intervention reduce events? The answer is reported below.\n\n"
        "## Results\n\n"
        "HR 0.81 (95% CI 0.74 to 0.88).\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "the review process screened" not in repaired
    assert "independently by two reviewers" not in repaired
    assert "Any disagreements" not in repaired
    assert "protocol.json" in repaired
    assert "manuscript/manuscript_facts.json" in repaired
    assert "references.bib" in repaired
    assert "https://www.nejm.org/doi/pdf/10.1056/NEJMoa2107038?articleTools=true" in repaired
    assert "reduce events? The answer" in repaired
    assert "reduce events?The answer" not in repaired
    assert "e.g." in repaired
    kinds = {item["kind"] for item in report["issues"]}
    assert "unsupported_human_review_claim" in kinds
    assert "file_path_spacing_repaired" in kinds


def test_validate_manuscript_removes_external_citations_from_self_pooled_result_sentences() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {
            "outcome_name": "Composite endpoint",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
        },
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## 结果\n\n"
        "主要分析纳入2项研究、共12,251名参与者［1，2］。\n\n"
        "## 讨论\n\n"
        "This meta-analysis found that treatment produced a pooled HR of 0.81 [1,2].\n\n"
        "The primary pooled estimate was HR 0.81 (95% CI 0.74 to 0.88) [1,2].\n\n"
        "本系统综述和Meta分析显示，SGLT2抑制剂相较于安慰剂对心血管死亡或心力衰竭住院的合并HR为0.81，95% CI为0.74至0.88［1，2］。\n\n"
        "本系统综述和Meta分析显示，SGLT2抑制剂相较于安慰剂对心血管死亡或心力衰竭住院的合并HR为0.81，95% CI为0.74至0.88 [1,2]。\n\n"
        "## 结论\n\n"
        "在射血分数轻度降低或保留的心力衰竭患者中，SGLT2抑制剂相较于安慰剂与心血管死亡或心力衰竭住院风险降低相关，合并结果为HR 0.81（95% CI 0.74至0.88）［1，2］。\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "共12,251名参与者［1，2］" in repaired
    assert "This meta-analysis found that treatment produced a pooled HR of 0.81 [1,2]" not in repaired
    assert "The primary pooled estimate was HR 0.81 (95% CI 0.74 to 0.88) [1,2]" not in repaired
    assert "合并HR为0.81，95% CI为0.74至0.88［1，2］" not in repaired
    assert "合并HR为0.81，95% CI为0.74至0.88 [1,2]" not in repaired
    assert "合并结果为HR 0.81（95% CI 0.74至0.88）［1，2］" not in repaired
    assert "合并HR为0.81，95% CI为0.74至0.88。" in repaired
    assert "合并结果为HR 0.81（95% CI 0.74至0.88）。" in repaired
    kinds = {item["kind"] for item in report["issues"]}
    assert "self_result_external_citation_removed" in kinds


def test_validate_manuscript_repairs_real_draft_mechanical_fragments() -> None:
    facts = {
        "report_type": "meta",
        "search": {"source_names": []},
        "prisma": {"full_text_assessed": 10, "studies_included": 2},
        "studies": {"primary_analysis_count": 2},
        "primary_effect": {
            "outcome_name": "Composite endpoint",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.88,
        },
        "primary_population": {"selected_total_participants": 12251},
        "text_sources": {},
        "evidence_readiness": {"blockers": [], "warnings": []},
    }
    manuscript = (
        "## Methods\n\n"
        "Protocol and The review protocol predefined the eligibility criteria. "
        "Studies were excluded if they enrolled only HFrEF without a prespecified for HFmrEF or HFpEF. "
        "Heterogeneity and: Statistical heterogeneity was assessed. "
        "formal subgroup analyses and were not performed. "
        "Software and computational methods: All statistical analyses and meta-analytic computations were performed using Python with a custom meta-analysis engine.\n\n"
        "## Results\n\n"
        "No additional records were obtained from user uploads or other external sources. "
        "Of these, 2 studies were excluded at the full-text stage. The primary reasons were protocols. "
        "Ultimately, 2 randomized controlled trials met all inclusion criteria and were included in the quantitative synthesis. "
        "These results pooled results should be interpreted with caution. "
        "Standard statistical tests for publication bias, such as funnel plots or ’s regression test, require a minimum of 2 studies. "
        "Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k=2) to be a major issue despite the inability to test it formally, given prospective registration. "
        "There were no serious concerns regarding risk of bias, inconsistency, indirectness, imprecision, or publication bias [18]. "
        "Therefore, Figures 5 and 6 are not applicable or generated for this review.\n\n"
        "## Figures\n\n"
        "![Figure 1. PRISMA flow diagram](../figures/prisma_diagram.png)\n\n"
        "## Declarations\n\n"
        "### Author contributions The project metadata did not contain named author roles.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    repaired, report = validate_and_repair_manuscript(manuscript, facts)

    assert report["passed"] is True
    assert "Protocol and The" not in repaired
    assert "without a prespecified" not in repaired
    assert "Heterogeneity and:" not in repaired
    assert "subgroup analyses and were" not in repaired
    assert "custom meta-analysis engine" not in repaired
    assert "user uploads" not in repaired
    assert "Of these, 8 full-text record(s) were excluded" in repaired
    assert "results pooled results" not in repaired.lower()
    assert "’s regression" not in repaired
    assert "minimum of 2 studies" not in repaired
    assert "to be a major issue" not in repaired
    assert "or publication bias [18]" not in repaired
    assert "Figures 5 and 6" not in repaired
    assert "### Author contributions\nThe project metadata" in repaired
    kinds = {item["kind"] for item in report["issues"]}
    assert "mechanical_phrase_repaired" in kinds
    assert "full_text_exclusion_count_repaired" in kinds
    assert "missing_figure_reference" in kinds


def test_quality_gate_blocks_process_notes_and_automation_traces() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "Data extraction was performed using an automated system with self-verification capabilities.\n\n"
        "## Results\n\n"
        "> **PICO consistency note**: primary outcome mismatching review scope.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    gate = manuscript_quality_gate(manuscript, {"report_type": "meta"})

    assert gate["passed"] is False
    assert any(item["code"] == "internal_grade_or_pipeline_jargon" for item in gate["issues"])


def test_writing_agent_normalizes_glued_figure_section_spacing() -> None:
    text = (
        "## Figures![Figure 1. PRISMA flow diagram](../figures/prisma_diagram.png)\n"
        "*Figure 1. PRISMA flow diagram*![Figure 2. Forest plot](../figures/forest_plot.png)\n"
        "**Figure 2.** Forest plot.## Declarations ### Author contributions\n"
    )

    normalized = WritingAgent._normalize_figure_heading_spacing(text)

    assert "## Figures![" not in normalized
    assert "*![Figure 2" not in normalized
    assert "plot.\n\n## Declarations" in normalized
    assert "## Declarations\n\n### Author contributions" in normalized


def test_writing_agent_repairs_spaced_markdown_image_syntax() -> None:
    text = (
        "## Figures! [Figure 1. PRISMA flow diagram](.. /figures/prisma_diagram. png)\n"
        "*Figure 1. PRISMA flow diagram*! [Figure 2. Forest plot](.. /figures/forest_plot. png)\n"
    )

    repaired = WritingAgent._repair_markdown_image_syntax(text)

    assert "! [Figure" not in repaired
    assert ".. /figures" not in repaired
    assert ". png" not in repaired
    assert "![Figure 1. PRISMA flow diagram](../figures/prisma_diagram.png)" in repaired
    assert "\n\n![Figure 2. Forest plot](../figures/forest_plot.png)" in repaired


def test_quality_gate_blocks_malformed_image_and_low_k_bias_overclaim() -> None:
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "primary_population": {"selected_total_participants": 12251},
    }
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "No evidence of small-study effects or publication bias was detected via graphical or statistical methods. "
        "The total sample size was not fully reported in the aggregate metadata.\n\n"
        "The lack of detected publication bias further strengthens the confidence in these findings.\n\n"
        "## Figures! [Figure 1. Forest plot](.. /figures/forest_plot. png)\n\n"
        "## Declarations ### Author contributions\n\n"
        "Data are available in protocol. json and https://www. nejm. org/x? y=z.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    gate = manuscript_quality_gate(manuscript, facts)

    assert gate["passed"] is False
    codes = {item["code"] for item in gate["issues"]}
    assert "malformed_markdown_image_reference" in codes
    assert "publication_bias_overclaim_for_low_k" in codes
    assert "residual_sample_size_nr_claim" in codes
    assert "file_path_spacing_corruption" in codes
    assert "glued_markdown_headings" in codes


def test_quality_gate_blocks_mechanical_real_draft_fragments() -> None:
    facts = {
        "report_type": "meta",
        "primary_effect": {"n_studies": 2},
        "prisma": {"full_text_assessed": 10, "studies_included": 2},
    }
    manuscript = (
        "## Methods\n\n"
        "Protocol and The review protocol was used. Heterogeneity and: tests were planned.\n\n"
        "## Results\n\n"
        "Of these, 2 studies were excluded at the full-text stage. "
        "The results pooled results should be interpreted with caution. "
        "Standard statistical tests for publication bias require a minimum of 2 studies.\n\n"
        "## Declarations\n\n"
        "### Author contributions The project metadata did not contain named author roles.\n"
    )

    gate = manuscript_quality_gate(manuscript, facts)

    assert gate["passed"] is False
    assert any(item["code"] == "mechanical_manuscript_phrase" for item in gate["issues"])


def test_table_abbreviation_detection_is_case_sensitive_for_or() -> None:
    block = (
        "| Study | Population | Intervention | Primary Outcome |\n"
        "|---|---|---|---|\n"
        "| Trial | HFmrEF or HFpEF | Empagliflozin | Composite endpoint |\n"
    )

    assert "OR=odds ratio" not in WritingAgent._table_abbreviation_definitions(block)
    assert "HR=hazard ratio" in WritingAgent._table_abbreviation_definitions("| Effect | HR |\n|---|---|\n")


def test_writing_agent_validation_blocked_report_is_not_publication_style() -> None:
    writer = WritingAgent()
    manuscript = writer._write_validation_blocked_report(
        protocol=_protocol(),
        facts={
            "report_type": "meta",
            "primary_effect": {
                "outcome_name": "28-day all-cause mortality",
                "effect_measure": "RR",
                "n_studies": 3,
                "pooled_effect": 0.86,
                "ci_lower": 0.75,
                "ci_upper": 1.00,
            },
            "primary_population": {"selected_total_participants": 1535},
            "evidence_readiness": {"warnings": []},
        },
        validation={
            "passed": False,
            "issues": [
                {
                    "kind": "patient_total_mismatch",
                    "severity": "error",
                    "message": "Manuscript claims 1703 participants, but selected rows sum to 1535.",
                }
            ],
        },
    )

    assert "Manuscript Validation Blocked" in manuscript
    assert "patient_total_mismatch" in manuscript
    assert "RR 0.86" in manuscript
    assert "1535" in manuscript
    assert "## Abstract" not in manuscript
    assert "## Methods" not in manuscript
    assert "## Results" not in manuscript


def test_writing_agent_honors_legacy_report_state_evidence_gap(tmp_path: Path) -> None:
    project = Project("legacy-gap", output_dir=tmp_path)
    project.save_json("search_source_counts.json", {"OpenAlex": 10})

    class ReportStateLike:
        report_type = "evidence_gap"
        n_direct_eligible = 0
        n_meta_eligible = 0

    writer = WritingAgent()
    writer.call_llm = lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("legacy evidence-gap report_state should not call the LLM")
    )
    writer.call_llm_structured = lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("legacy evidence-gap report_state should not call the LLM")
    )
    manuscript = writer.run(
        protocol=_protocol(),
        meta_results=_meta(),
        prisma_data={
            "identification": {"records_identified": 10, "records_after_dedup": 10},
            "screening": {"title_abstract_screened": 10},
            "eligibility": {"full_text_assessed": 2},
            "included": {"studies_included": 2},
        },
        project=project,
        report_state=ReportStateLike(),
    )
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")

    assert "Systematic Review Evidence-Gap Report" in manuscript
    assert facts["report_type"] == "evidence_gap"
    assert "evidence_gate_evidence_gap" in facts["evidence_readiness"]["blocker_codes"]
    assert validation["passed"] is False


def test_writing_agent_does_not_turn_narrative_report_state_into_evidence_gap(tmp_path: Path) -> None:
    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=None,
    )

    class ReportStateLike:
        n_analyzable_primary = 1

    WritingAgent._force_report_state_narrative(facts, ReportStateLike())

    assert facts["report_type"] == "narrative"
    assert facts["evidence_readiness"]["report_type"] == "narrative"
    assert "insufficient_primary_effects" not in facts["evidence_readiness"]["blocker_codes"]
    assert facts["evidence_readiness"]["status"] == "ready"


def test_fallback_grade_table_polishes_available_rob_assessment_denominator() -> None:
    writer = WritingAgent()

    table = writer._fallback_grade_table(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_summary": "OR 0.66 (95% CI: 0.53 to 0.82)",
            "certainty": "Low",
            "domains": [
                {
                    "domain": "risk_of_bias",
                    "rating": "serious",
                    "rationale": (
                        "1/5 contributing study RoB assessments were not formally assessed because "
                        "full text or required methods detail was unavailable. 2/7 contributing "
                        "studies lacked formal RoB assessments and require human review."
                    ),
                }
            ],
        }
    )

    assert "Among the 5 available RoB assessments, 1 was not formally assessed" in table
    assert "1/5 contributing study RoB assessments" not in table
    assert "2/7 contributing studies lacked formal RoB assessments" in table


def test_fallback_grade_table_renders_chinese_inconsistency_without_internal_fallback() -> None:
    writer = WritingAgent(lang="zh")

    table = writer._fallback_grade_table(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_summary": "OR 0.66 (95% CI: 0.53 to 0.82)",
            "certainty": "Moderate",
            "domains": [
                {
                    "domain": "inconsistency",
                    "rating": "no concern",
                    "rationale": (
                        "We did not downgrade for inconsistency. Statistical heterogeneity was low "
                        "and not statistically significant (I² = 15.6%; Chi² p = 0.31), and the "
                        "individual trial estimates were clinically compatible with the pooled effect."
                    ),
                }
            ],
        }
    )

    assert "结构化GRADE理由已记录" not in table
    assert "请结合证据审计文件复核" not in table
    assert "统计异质性很低" in table
    assert "I²=15.6%" in table
    assert "p=0.31" in table


def test_model_selection_defaults_generic_to_random_reml_and_records_fixed_sensitivity() -> None:
    protocol = _protocol()
    protocol.effect_measure = "OR"
    protocol.model_preference = "random"
    protocol.tau_estimator = "REML"
    effects = [
        StudyEffect(study_id="S1", study_label="A", yi=-0.40, vi=0.05, se=0.2236),
        StudyEffect(study_id="S2", study_label="B", yi=-0.20, vi=0.06, se=0.2449),
        StudyEffect(study_id="S3", study_label="C", yi=-0.10, vi=0.07, se=0.2646),
    ]

    primary, decision, sensitivity = build_model_decision_and_sensitivity(
        study_effects=effects,
        protocol=protocol,
    )

    assert decision["primary_model"] == "random"
    assert decision["generic_default"] == "random_REML"
    assert primary.model == "random"
    assert "fixed" in sensitivity
    assert "random" in sensitivity
    assert sensitivity["fixed"]["model"] == "fixed"


def test_model_selection_honors_known_source_fixed_only_as_benchmark() -> None:
    protocol = _protocol()
    protocol.effect_measure = "OR"
    protocol.model_preference = "fixed"
    effects = [
        StudyEffect(study_id="S1", study_label="A", yi=-0.40, vi=0.05, se=0.2236),
        StudyEffect(study_id="S2", study_label="B", yi=-0.20, vi=0.06, se=0.2449),
        StudyEffect(study_id="S3", study_label="C", yi=-0.10, vi=0.07, se=0.2646),
    ]

    primary, decision, sensitivity = build_model_decision_and_sensitivity(
        study_effects=effects,
        protocol=protocol,
        known_source_preferences={"source_label": "WHO REACT Working Group JAMA 2020"},
    )

    assert primary.model == "fixed"
    assert decision["benchmark_mode"] is True
    assert "benchmark" in decision["reason"]
    assert sensitivity["random"]["model"] == "random"


def test_grade_input_snapshot_uses_selected_effect_rows_and_repairs_profile_total(tmp_path: Path) -> None:
    project = Project("grade snapshot", output_dir=tmp_path)
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:primary",
                "study_id": "S1",
                "outcome_name": "28-day all-cause mortality",
                "total_intervention": 324,
                "total_control": 683,
                "source_quote_verified": True,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S2:primary",
                "study_id": "S2",
                "outcome_name": "28-day all-cause mortality",
                "total_intervention": 75,
                "total_control": 73,
                "source_quote_verified": True,
                "in_final_primary_analysis": True,
            },
            {
                "row_id": "S1:secondary",
                "study_id": "S1",
                "outcome_name": "any adverse event",
                "total_intervention": 3000,
                "total_control": 3000,
                "source_quote_verified": True,
                "in_final_primary_analysis": False,
            },
        ],
        subdir="analysis",
    )
    meta = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="28-day all-cause mortality",
            n_studies=2,
            effect_measure="OR",
            pooled_effect=0.66,
            ci_lower=0.53,
            ci_upper=0.82,
            p_value=0.001,
            studies=[
                StudyEffect(study_id="S1", study_label="A", yi=-0.4, vi=0.05, se=0.2236),
                StudyEffect(study_id="S2", study_label="B", yi=-0.2, vi=0.06, se=0.2449),
            ],
        )
    )
    profile = GRADEProfile(
        outcomes=[
            GRADEOutcome(
                outcome_name="28-day all-cause mortality",
                n_studies=2,
                effect_summary="OR 0.66 (95% CI 0.53 to 0.82)",
                certainty="High",
                domains=[
                    GRADEDomain(
                        domain="imprecision",
                        rating="no concern",
                        rationale="The variance proxy included 7164 participants; no downgrade was applied.",
                        details={
                            "n_studies": 2,
                            "total_n": 7164,
                            "matched_count": 7,
                            "total_source": "variance proxy",
                            "ois": 600,
                            "ci_width": 0.428,
                            "crosses_null": False,
                            "effect_measure": "OR",
                        },
                    )
                ],
            )
        ]
    )

    snapshot = build_grade_input_snapshot(
        project=project,
        protocol=_protocol(),
        meta_results=meta,
        rob_results=[],
        extracted_studies=[],
    )
    repaired = repair_grade_profile_with_snapshot(profile, snapshot)
    domain = repaired.outcomes[0].domains[0]

    assert snapshot["selected_total_n"] == 1155
    assert snapshot["selected_source_verified_count"] == 2
    assert domain.details["total_n"] == 1155
    assert "1155 participants" in domain.rationale
    assert "7164" not in domain.rationale


def test_positioning_saved_and_loaded_into_manuscript_facts(tmp_path: Path) -> None:
    project = Project("positioning", output_dir=tmp_path)
    project.save_json(
        "known_source_protocol_preferences.json",
        {
            "source_id": "who_react_2020",
            "source_label": "WHO REACT Working Group JAMA 2020",
            "model_preference": "fixed",
        },
        subdir="extraction",
    )
    meta = _meta()

    positioning = ensure_review_positioning(
        project=project,
        protocol=_protocol(),
        extracted_studies=[],
        meta_results=meta,
    )
    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=meta,
        project=project,
    )

    assert positioning["category"] == "reproduction_or_benchmark_alignment"
    assert facts["positioning"]["category"] == "reproduction_or_benchmark_alignment"
    assert "Benchmark-aligned reproduction" in facts["positioning"]["manuscript_stance"]


def test_build_manuscript_facts_loads_model_decision_and_grade_inputs(tmp_path: Path) -> None:
    project = Project("facts model artifacts", output_dir=tmp_path)
    project.save_json("model_decision.json", {"primary_model": "random", "reason": "random-effects REML"}, subdir="analysis")
    project.save_json("model_sensitivity.json", {"fixed": {"pooled_effect": 0.70}, "random": {"pooled_effect": 0.72}}, subdir="analysis")
    project.save_json("grade_inputs_snapshot.json", {"selected_total_n": 1703, "snapshot_hash": "abc"}, subdir="analysis")

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=_meta(),
        project=project,
    )

    assert facts["model_decision"]["primary_model"] == "random"
    assert facts["model_sensitivity"]["random"]["pooled_effect"] == 0.72
    assert facts["grade_inputs"]["selected_total_n"] == 1703


def test_model_decision_records_fixed_primary_when_low_k_random_falls_back() -> None:
    protocol = _protocol()
    studies = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.2236),
    ]

    primary, decision, sensitivity = build_model_decision_and_sensitivity(
        study_effects=studies,
        protocol=protocol,
    )

    assert primary.model == "fixed"
    assert decision["requested_model"] == "random"
    assert decision["primary_model"] == "fixed"
    assert decision["primary_engine_model"] == "fixed"
    assert decision["low_k_random_fallback"] is True
    assert sensitivity["random"]["model"] == "fixed"


def test_build_manuscript_facts_prefers_actual_engine_model_over_stale_result_label(tmp_path: Path) -> None:
    project = Project("facts low k model label", output_dir=tmp_path)
    project.save_json(
        "model_decision.json",
        {
            "primary_model": "fixed",
            "primary_engine_model": "fixed",
            "requested_model": "random",
            "low_k_random_fallback": True,
        },
        subdir="analysis",
    )
    studies = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.2236),
    ]
    stale_primary = PooledEffect(
        outcome_name="28-day all-cause mortality",
        n_studies=2,
        effect_measure="RR",
        model="random",
        pooled_effect=0.86,
        ci_lower=0.75,
        ci_upper=1.00,
        p_value=0.052,
        studies=studies,
    )

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=MetaAnalysisResults(primary_outcome=stale_primary),
        project=project,
    )

    assert facts["model"] == "fixed"
    assert facts["requested_model"] == "random"
    assert facts["primary_effect"]["model"] == "fixed"
    assert "reported_model_from_result" not in facts["primary_effect"]


def test_manuscript_facts_downgrades_publication_bias_for_two_study_grade_cache(tmp_path: Path) -> None:
    project = Project("facts sparse grade cache", output_dir=tmp_path)
    grade = GRADEProfile(outcomes=[
        GRADEOutcome(
            outcome_name="28-day mortality",
            n_studies=2,
            effect_summary="RR 0.80",
            certainty="High",
            domains=[
                GRADEDomain(domain="risk_of_bias", rating="no concern", rationale="Low risk"),
                GRADEDomain(domain="publication_bias", rating="no concern", rationale="Too few studies; no downgrade."),
            ],
        )
    ])

    facts = build_manuscript_facts(
        protocol=_protocol(),
        meta_results=MetaAnalysisResults(
            primary_outcome=PooledEffect(
                outcome_name="28-day mortality",
                n_studies=2,
                effect_measure="RR",
                pooled_effect=0.8,
                ci_lower=0.7,
                ci_upper=0.9,
                p_value=0.01,
                studies=[
                    StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
                    StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.2236),
                ],
            )
        ),
        project=project,
        grade_profile=grade,
    )

    outcome = facts["grade"]["outcomes"][0]
    pub_bias = next(item for item in outcome["domains"] if item["domain"] == "publication_bias")
    assert pub_bias["rating"] == "serious"
    assert outcome["certainty"] == "Moderate"


def test_remove_near_duplicate_sentences_preserves_references() -> None:
    manuscript = (
        "## Results\n\n"
        "The pooled estimate favored treatment. The pooled estimate favored treatment. "
        "The confidence interval did not cross the null.\n\n"
        "## References\n\n"
        "1. The pooled estimate favored treatment. Journal. 2020.\n"
    )

    cleaned = remove_near_duplicate_sentences(manuscript)

    assert cleaned.count("The pooled estimate favored treatment.") == 2
    assert "1. The pooled estimate favored treatment. Journal. 2020." in cleaned


def test_writing_agent_renders_positioning_and_model_artifacts() -> None:
    facts = {
        "positioning": {
            "category": "reproduction_or_benchmark_alignment",
            "anchor_review": {"label": "WHO REACT Working Group JAMA 2020"},
        },
        "model_decision": {
            "primary_model": "random",
            "primary_engine_model": "random",
            "tau_estimator": "REML",
            "reason": "random-effects REML selected for the primary generic synthesis",
        },
        "model_sensitivity": {
            "fixed": {"pooled_effect": 0.66, "ci_lower": 0.53, "ci_upper": 0.82},
            "random": {"pooled_effect": 0.68, "ci_lower": 0.50, "ci_upper": 0.91},
        },
    }

    en = WritingAgent()
    zh = WritingAgent(lang="zh")

    assert "benchmark-aligned reconstruction" in en._positioning_paragraph(facts)
    assert "random-effects (REML)" in en._model_decision_paragraph(facts)
    assert "fixed-effect sensitivity estimate was 0.66" in en._model_sensitivity_sentence(facts)
    assert "基准对照" in zh._positioning_paragraph(facts)
    assert "随机效应" in zh._model_decision_paragraph(facts)
    assert "固定效应敏感性估计为0.66" in zh._model_sensitivity_sentence(facts)

    low_k_facts = {
        "model_decision": {
            "primary_model": "random",
            "primary_engine_model": "fixed",
            "tau_estimator": "DL",
            "k": 2,
            "low_k_random_fallback": True,
            "reason": "generic random-effects synthesis was requested, but fewer than three studies contributed",
        }
    }
    low_k_en = en._model_decision_paragraph(low_k_facts)
    low_k_zh = zh._model_decision_paragraph(low_k_facts)
    assert "fixed-effect inverse-variance estimate" in low_k_en
    assert "tau-squared estimation and prediction intervals unstable" in low_k_en
    assert "random-effects (DL)" not in low_k_en
    assert "固定效应逆方差估计" in low_k_zh
    assert "随机效应（DL）" not in low_k_zh
