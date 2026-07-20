from pathlib import Path

from new_meta.core.artifact_package import _build_risk_of_bias_completeness_review
from new_meta.core.project import Project


def _domain(index: int) -> dict:
    return {
        "domain": f"RoB 2 domain {index}",
        "judgment": "Low risk",
        "support": "The report provided sufficient information.",
        "source_quote": "Participants were randomly assigned and followed as prespecified.",
        "source_page": 3,
    }


def _project(tmp_path: Path, *, result_status: str, requires_adjudication: bool) -> Project:
    project = Project("result rob release", output_dir=tmp_path / result_status)
    project.save_json(
        "meta_results.json",
        {
            "primary_outcome": {
                "outcome_name": "28-day mortality",
                "studies": [{"study_id": "S1", "study_label": "Smith 2024"}],
            }
        },
        subdir="analysis",
    )
    project.save_json(
        "effect_selection_audit.json",
        [
            {
                "row_id": "S1:0",
                "result_id": "result:s1:0",
                "study_id": "S1",
                "in_final_primary_analysis": True,
            }
        ],
        subdir="analysis",
    )
    project.save_json(
        "rob_results.json",
        [
            {
                "study_id": "S1",
                "tool_used": "RoB 2",
                "domains": [_domain(index) for index in range(1, 6)],
                "overall_judgment": "Low risk",
                "is_synthetic": False,
            }
        ],
        subdir="risk_of_bias",
    )
    project.save_json(
        "rob_result_assessments.json",
        [
            {
                "assessment_id": "rob:result:s1:0",
                "result_id": "result:s1:0",
                "study_id": "S1",
                "outcome_name": "28-day mortality",
                "tool_used": "RoB 2",
                "tool_version": "RoB 2 v2 (2019)",
                "target_effect": "assignment",
                "assessment_status": result_status,
                "domains": [_domain(index) for index in range(1, 6)],
                "overall_judgment": "Low risk",
                "requires_adjudication": requires_adjudication,
                "is_result_specific": True,
                "is_synthetic": False,
            }
        ],
        subdir="risk_of_bias",
    )
    return project


def test_legacy_study_rob_cannot_release_a_pending_result_level_assessment(tmp_path: Path) -> None:
    review = _build_risk_of_bias_completeness_review(
        _project(tmp_path, result_status="draft", requires_adjudication=True)
    )

    assert review["passed"] is False
    assert review["summary"]["result_specific_rob"] == 0
    assert review["summary"]["pending_result_rob"] == 1
    assert review["issues"][0]["code"] == "primary_result_rob_pending_adjudication"


def test_adjudicated_result_level_assessment_passes_release_gate(tmp_path: Path) -> None:
    review = _build_risk_of_bias_completeness_review(
        _project(tmp_path, result_status="adjudicated", requires_adjudication=False)
    )

    assert review["passed"] is True
    assert review["summary"]["formal_rob"] == 1
    assert review["summary"]["result_specific_rob"] == 1
    assert review["summary"]["pending_result_rob"] == 0
