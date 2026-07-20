from pathlib import Path
from uuid import uuid4

import pytest

from start import META_ROOT, _save_result_rob_adjudication_payload
from new_meta.core.project import Project


def _project() -> Project:
    root = META_ROOT / "output" / "pytest_result_rob" / uuid4().hex
    project = Project("result rob web", output_dir=root)
    project.save_json(
        "rob_result_assessments.json",
        [
            {
                "assessment_id": "rob:result:s1:0:draft",
                "result_id": "result:s1:0",
                "study_id": "S1",
                "outcome_name": "28-day mortality",
                "tool_used": "RoB 2",
                "tool_version": "RoB 2 v2 (2019)",
                "target_effect": "assignment",
                "assessment_status": "draft",
                "domains": [],
                "overall_judgment": "",
                "assessment_origin": "study_level_projection",
                "requires_adjudication": True,
            }
        ],
        subdir="risk_of_bias",
    )
    return project


def _payload(project: Project, *, result_id: str = "result:s1:0") -> dict:
    return {
        "project_dir": str(project.base_dir),
        "expected_revision": 0,
        "reason": "Checked all signaling questions against the report and protocol.",
        "assessment": {
            "assessment_id": f"rob:{result_id}:adjudicated",
            "result_id": result_id,
            "study_id": "S1",
            "outcome_name": "28-day mortality",
            "timepoint": "28 days",
            "analysis_population": "intention-to-treat",
            "tool_used": "RoB 2",
            "tool_version": "RoB 2 v2 (2019)",
            "target_effect": "assignment",
            "assessment_status": "adjudicated",
            "domains": [
                {
                    "domain": "Randomization process",
                    "judgment": "Low risk",
                    "support": "Allocation was concealed.",
                    "source_quote": "The allocation sequence was concealed in opaque envelopes.",
                    "source_page": 3,
                }
            ],
            "overall_judgment": "Low risk",
            "assessment_origin": "human_adjudication",
            "requires_adjudication": False,
        },
    }


def test_web_payload_saves_attributed_result_rob_adjudication() -> None:
    project = _project()

    result = _save_result_rob_adjudication_payload(
        _payload(project),
        user_id="reviewer-7",
    )

    assert result["ok"] is True
    assert result["current_revision"] == 1
    assert result["readiness"]["status"] == "ready"
    assert result["assessment"]["adjudicated_by"] == "reviewer-7"
    assert "effect_sizes" in result["cleared_checkpoints"] or result["cleared_checkpoints"] == []


def test_web_payload_rejects_result_id_not_in_review_queue() -> None:
    project = _project()

    with pytest.raises(ValueError, match="not present in the result-level RoB review queue"):
        _save_result_rob_adjudication_payload(
            _payload(project, result_id="result:other:0"),
            user_id="reviewer-7",
        )
