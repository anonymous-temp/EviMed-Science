from pathlib import Path

from new_meta.agents.rob_agent import RoBAgent
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package import (
    _build_calculation_audit_review,
    _build_evidence_readiness_review,
)
from new_meta.core.artifact_package_submission import _calculation_audit_is_complete
from new_meta.core.manuscript_facts import _absolute_effect_scenario
from new_meta.core.project import Project


def _project(tmp_path: Path) -> Project:
    return Project("compiled release bridge", output_dir=tmp_path / "project")


def test_result_rob_quote_verification_tolerates_pdf_column_interleaving_only() -> None:
    report = (
        "Random numbers were computer-generated in a 1:1 unrelated column words "
        "ratio with a block size of 4 using SAS 9.2 software. "
        "Allocation was concealed in sequen-\n"
        "tially numbered sealed opaque envelopes until the end of the trial."
    )
    quote = (
        "Random numbers were computer-generated in a 1:1 ratio with a block size of 4 "
        "using SAS 9.2 software... Allocation was concealed in sequentially numbered "
        "sealed opaque envelopes until the end of the trial."
    )

    assert RoBAgent._quote_occurs(quote, report) is True
    assert RoBAgent._quote_occurs(
        "The report showed robust randomization and adequate allocation concealment.",
        report,
    ) is False


def test_compiled_calculation_audit_uses_method_units_without_pairwise_results(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.save_json("synthesis_route.json", {"route": "method_plugin"}, subdir="analysis")
    project.save_json(
        "synthesis_result.json",
        {
            "family": "intervention_rct",
            "estimator": "DESIGN_AWARE_REML_HKSJ",
            "execution_converged": True,
            "n_studies": 2,
            "input_result_ids": ["result:S1:0", "result:S2:0"],
            "primary_estimates": [{
                "estimate_id": "pooled",
                "label": "Primary outcome",
                "measure": "RR",
                "estimate": 0.8,
                "ci_lower": 0.6,
                "ci_upper": 1.1,
                "prediction_lower": 0.4,
                "prediction_upper": 1.6,
            }],
            "heterogeneity": {"i_squared": 0.0, "tau_squared": 0.0},
            "engine_payload": {
                "design_counts": {"parallel_rct": 1, "multi_arm_rct": 1},
                "study_effects": [
                    {"study_id": "study:S1", "design": "parallel_rct", "analysis_effect": -0.2, "variance": 0.1},
                    {"study_id": "study:S2", "design": "multi_arm_rct", "analysis_effect": -0.3, "variance": 0.2},
                ],
            },
        },
        subdir="analysis",
    )
    audit_inputs = []
    selected_rows = []
    for index, study_id in enumerate(("S1", "S2"), start=1):
        result_id = f"result:{study_id}:0"
        quote = f"Primary outcome occurred in {index} of 10 versus {index + 1} of 10 participants."
        audit_inputs.append({
            "result_id": result_id,
            "study_id": f"study:{study_id}",
            "evidence_state": "verified",
            "source_locators": [{"section": "Results", "quote": quote, "quote_verified": True}],
            "derivation": {
                "events_intervention": index,
                "total_intervention": 10,
                "events_control": index + 1,
                "total_control": 10,
            },
        })
        selected_rows.append({
            "row_id": result_id,
            "study_id": f"study:{study_id}",
            "study_label": f"Study {study_id}",
            "outcome_name": "Primary outcome",
            "events_intervention": index,
            "total_intervention": 10,
            "events_control": index + 1,
            "total_control": 10,
            "source_section": "Results",
            "source_quote": quote,
            "source_quote_verified": True,
        })
    project.save_json("method_input_audit.json", {"inputs": audit_inputs}, subdir="analysis")
    project.save_json(
        "manuscript_facts.json",
        {
            "method_family": "intervention_rct",
            "primary_effect": {
                "outcome_name": "Primary outcome",
                "effect_measure": "RR",
                "studies": [
                    {"study_id": "study:S1", "study_label": "Study S1", "effect": 0.82},
                    {"study_id": "study:S2", "study_label": "Study S2", "effect": 0.74},
                ],
            },
            "evidence_readiness": {"selected_primary_rows": selected_rows},
        },
        subdir="manuscript",
    )

    audit = _build_calculation_audit_review(project)

    assert audit["summary"]["compiled_method"] is True
    assert audit["summary"]["compiled_method_integrity"] is True
    assert audit["summary"]["row_count"] == 2
    assert audit["summary"]["formula_inputs_complete_rows"] == 2
    assert _calculation_audit_is_complete(audit["summary"]) is True
    assert not project.get_path("meta_results.json", subdir="analysis").exists()


def test_method_source_context_resolves_prefixed_study_ids(tmp_path: Path) -> None:
    project = _project(tmp_path)
    quote = "Postoperative delirium occurred in 3 of 36 versus 2 of 36 participants."
    row = {
        "row_id": "result:12345678:0",
        "study_id": "study:12345678",
        "study_label": "Smith 2024",
        "outcome_name": "postoperative delirium",
        "events_intervention": 3,
        "total_intervention": 36,
        "events_control": 2,
        "total_control": 36,
        "source_page": 4,
        "source_section": "Results",
        "source_quote": quote,
        "source_quote_verified": True,
    }
    project.save_json("parsed_papers.json", {"12345678": {"full_text": quote}}, subdir="papers")
    project.save_json(
        "manuscript_facts.json",
        {
            "method_family": "intervention_rct",
            "report_type": "meta",
            "evidence_readiness": {
                "status": "ready",
                "blockers": [],
                "warnings": [],
                "selected_primary_rows": [row],
            },
            "grade": {"outcomes": []},
        },
        subdir="manuscript",
    )

    review = _build_evidence_readiness_review(project)

    assert review["summary"]["selected_primary_source_context_available_cards"] == 1
    assert review["summary"]["selected_primary_source_context_missing_cards"] == 0


def test_compiled_result_summary_reports_prediction_interval() -> None:
    writer = WritingAgent(lang="en")
    text = writer._compiled_method_article_text(
        {
            "method_family": "intervention_rct",
            "synthesis_result": {
                "estimator": "REML",
                "n_studies": 4,
                "primary_estimates": [{
                    "label": "Primary effect",
                    "measure": "RR",
                    "estimate": 0.8,
                    "ci_lower": 0.58,
                    "ci_upper": 1.10,
                    "prediction_lower": 0.39,
                    "prediction_upper": 1.61,
                }],
                "engine_payload": {},
            },
        },
        zh=False,
    )["result_summary"]

    assert "95% prediction interval 0.39 to 1.61" in text


def test_absolute_effect_does_not_create_finite_nnt_interval_across_null() -> None:
    scenario = _absolute_effect_scenario(
        label="Observed risk",
        baseline_risk=0.12,
        effect=0.80,
        ci_lower=0.58,
        ci_upper=1.10,
        effect_measure="RR",
    )
    writer = WritingAgent(lang="en")

    assert scenario["absolute_ci_crosses_null"] is True
    assert "nnt_ci_low" not in scenario
    assert "finite NNT interval is not defined" in writer._nnt_phrase(scenario)
    assert "fewer to" in writer._absolute_effect_phrase(scenario)
