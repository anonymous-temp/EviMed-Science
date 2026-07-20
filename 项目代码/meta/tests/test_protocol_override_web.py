from uuid import uuid4

from start import META_ROOT, _save_protocol_override_payload
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_save_protocol_override_payload_updates_analysis_fields_and_clears_downstream() -> None:
    project = Project(
        "protocol override web",
        output_dir=META_ROOT / "output" / "pytest_protocol_override" / uuid4().hex,
    )
    project.save_json(
        "protocol.json",
        ResearchProtocol(
            research_question="Steroids for COVID mortality",
            pico=PICO(
                population="critically ill adults with COVID-19",
                intervention="systemic corticosteroids",
                comparator="usual care",
                outcome_primary="28-day mortality",
            ),
            effect_measure="RR",
            model_preference="random",
            tau_estimator="REML",
        ),
    )
    for step in ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    result = _save_protocol_override_payload(
        {
            "type": "protocol_override",
            "project_dir": str(project.base_dir),
            "fields": {
                "effect_measure": "OR",
                "model_preference": "fixed",
                "tau_estimator": "DL",
            },
            "reason": "Align with WHO REACT/JAMA published benchmark anchor.",
        },
        user_id="tester",
    )

    protocol = project.load_json("protocol.json")
    manifest = project.load_json("protocol_overrides.json")

    assert result["ok"] is True
    assert result["changed_fields"] == {
        "effect_measure": {"old": "RR", "new": "OR"},
        "model_preference": {"old": "random", "new": "fixed"},
        "tau_estimator": {"old": "REML", "new": "DL"},
    }
    assert result["cleared_checkpoints"] == ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]
    assert result["requires_rerun"] is True
    assert protocol["effect_measure"] == "OR"
    assert protocol["model_preference"] == "fixed"
    assert protocol["tau_estimator"] == "DL"
    assert project.is_step_done("effect_sizes") is False
    assert manifest["current_revision"] == 1
    assert manifest["overrides"][0]["updated_by"] == "tester"
    assert manifest["overrides"][0]["fields"]["effect_measure"]["new"] == "OR"


def test_save_protocol_override_payload_rejects_unsupported_fields() -> None:
    project = Project(
        "protocol override rejects",
        output_dir=META_ROOT / "output" / "pytest_protocol_override_rejects" / uuid4().hex,
    )
    project.save_json(
        "protocol.json",
        ResearchProtocol(
            research_question="Steroids for COVID mortality",
            pico=PICO(
                population="critically ill adults",
                intervention="systemic corticosteroids",
                comparator="usual care",
                outcome_primary="mortality",
            ),
        ),
    )

    try:
        _save_protocol_override_payload(
            {
                "project_dir": str(project.base_dir),
                "fields": {"population": "all adults"},
            }
        )
    except ValueError as exc:
        assert "Unsupported protocol override field" in str(exc)
    else:
        raise AssertionError("unsupported protocol override fields must be rejected")
