from pathlib import Path

import pytest

from new_meta.core.project import Project
from new_meta.core.release_contract import (
    ReleaseBlockedError,
    build_release_decision,
    persist_release_decision,
)
from new_meta.main import _finalize_cli_release


def test_cli_release_raises_before_printing_complete_when_blocked(
    tmp_path: Path,
    capsys,
) -> None:
    project = Project("blocked CLI", output_dir=tmp_path / "project")
    package_path = project.get_path("metaagent_export.zip", subdir="package")
    persist_release_decision(
        project,
        build_release_decision(
            {
                "status": "blocked",
                "passed": False,
                "gates": [{"id": "rob", "status": "fail", "detail": "missing"}],
            },
            package_path=package_path,
        ),
    )

    with pytest.raises(ReleaseBlockedError):
        _finalize_cli_release(project, package_path, success_label="Complete!")

    output = capsys.readouterr().out
    assert "BLOCKED" in output
    assert "Complete!" not in output
    assert "rob" in output


def test_cli_release_prints_complete_only_when_releasable(tmp_path: Path, capsys) -> None:
    project = Project("ready CLI", output_dir=tmp_path / "project")
    package_path = project.get_path("metaagent_export.zip", subdir="package")
    persist_release_decision(
        project,
        build_release_decision(
            {"status": "ready", "passed": True, "gates": []},
            package_path=package_path,
        ),
    )

    decision = _finalize_cli_release(project, package_path, success_label="Complete!")

    output = capsys.readouterr().out
    assert decision["status"] == "ready"
    assert "Complete!" in output
    assert "BLOCKED" not in output



@pytest.mark.parametrize("status", ["needs_input", "blocked"])
def test_cli_method_domain_block_preserves_phase_and_publishes_blocked_release(tmp_path, status):
    import new_meta.main as main_module
    from new_meta.schemas.phase_result import PhaseResult

    project = Project("method domain block", output_dir=tmp_path)
    phase = PhaseResult.model_validate({
        "run_id": project.base_dir.name,
        "phase": "synthesis",
        "status": status,
        "summary": "No verified or adjudicated typed results are available for synthesis.",
        "error_code": "verified_method_inputs_required",
        "issues": [
            {"code": "source_note", "message": "A nonblocking note.", "blocking": False},
            {"code": "verified_method_inputs_required", "message": "Review source locators.", "blocking": True},
        ],
        "next_actions": [{"action_id": "adjudicate_extraction_results", "title": "Adjudicate extracted result rows"}],
    })

    persist_release_decision(project, build_release_decision({"status": "ready", "gates": []}))
    with pytest.raises(ReleaseBlockedError) as caught:
        main_module._require_cli_method_delivery(project, phase)

    decision = project.load_json("release_decision.json", subdir="package")
    assert caught.value.decision == decision
    assert decision["status"] == "blocked"
    assert decision["ready_for_submission"] is False
    assert decision["requires_review"] is True
    assert decision["summary"] == phase.summary
    assert decision["blocker_codes"] == ["verified_method_inputs_required"]
    assert decision["next_actions"] == ["Adjudicate extracted result rows"]
    assert decision["artifacts"] == []
    assert project.load_json("method_delivery_status.json", subdir="analysis") == phase.model_dump(mode="json")
    assert not (project.base_dir / "manuscript" / "draft.md").exists()
    assert not (project.base_dir / "analysis" / "synthesis_result.json").exists()


def test_cli_method_failure_remains_execution_failure(tmp_path):
    import new_meta.main as main_module
    from new_meta.core.method_delivery import MethodDeliveryBlocked
    from new_meta.schemas.phase_result import PhaseResult

    project = Project("method failure", output_dir=tmp_path)
    phase = PhaseResult.model_validate({
        "run_id": project.base_dir.name, "phase": "synthesis", "status": "failed",
        "summary": "The deterministic engine failed.", "error_code": "engine_internal_error",
    })
    with pytest.raises(MethodDeliveryBlocked) as caught:
        main_module._require_cli_method_delivery(project, phase)
    assert caught.value.phase is phase
    assert not isinstance(caught.value, ReleaseBlockedError)
    assert project.load_json("method_delivery_status.json", subdir="analysis") == phase.model_dump(mode="json")
    assert not (project.base_dir / "package" / "release_decision.json").exists()


def test_cli_method_success_does_not_certify_submission_readiness(tmp_path):
    import new_meta.main as main_module
    from new_meta.schemas.phase_result import PhaseResult

    project = Project("method success", output_dir=tmp_path)
    phase = PhaseResult.model_validate({
        "run_id": project.base_dir.name, "phase": "synthesis", "status": "succeeded",
        "summary": "The deterministic engine completed.",
    })
    assert main_module._require_cli_method_delivery(project, phase) is None
    assert not (project.base_dir / "package" / "release_decision.json").exists()
    assert not (project.base_dir / "analysis" / "method_delivery_status.json").exists()



def test_cli_method_release_persistence_error_remains_failure(tmp_path, monkeypatch):
    import new_meta.main as main_module
    from new_meta.schemas.phase_result import PhaseResult

    project = Project("method persistence failure", output_dir=tmp_path)
    phase = PhaseResult.model_validate({
        "run_id": project.base_dir.name, "phase": "synthesis", "status": "needs_input",
        "summary": "Adjudication required.", "error_code": "verified_method_inputs_required",
        "next_actions": [{"action_id": "adjudicate_extraction_results", "title": "Adjudicate extracted result rows"}],
    })
    save_json = project.save_json

    def failing_save(filename, value, subdir=None):
        if filename == "release_decision.json":
            raise OSError("release write failed")
        return save_json(filename, value, subdir=subdir)

    monkeypatch.setattr(project, "save_json", failing_save)
    with pytest.raises(OSError, match="release write failed"):
        main_module._require_cli_method_delivery(project, phase)
    assert project.load_json("method_delivery_status.json", subdir="analysis") == phase.model_dump(mode="json")
    assert not (project.base_dir / "package" / "release_decision.json").exists()
