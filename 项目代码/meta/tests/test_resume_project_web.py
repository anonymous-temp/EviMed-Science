from __future__ import annotations

import subprocess
from pathlib import Path
from uuid import uuid4

from start import META_ROOT, _resume_project_payload
from new_meta.core.project import PIPELINE_STEPS, Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _project_under_output() -> Project:
    root = META_ROOT / "output" / "pytest_resume_project" / uuid4().hex
    return Project("resume after full text", output_dir=root)


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve heart failure outcomes?",
        pico=PICO(
            population="adults with heart failure",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="composite cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
    )


def test_resume_project_payload_uses_cli_resume_and_returns_evidence(monkeypatch) -> None:
    project = _project_under_output()
    project.save_json("protocol.json", _protocol())
    for step in ["protocol", "search_query", "search", "ta_screening", "pdf_download"]:
        project.save_checkpoint(step)

    calls = []

    def fake_runner(cmd: list[str], *, timeout_seconds: int):
        calls.append((cmd, timeout_seconds))
        assert cmd[:3] == [cmd[0], "-m", "new_meta.main"]
        assert "--resume" in cmd
        assert str(project.base_dir) in cmd
        assert "--skip-confirm" in cmd
        assert "Do SGLT2 inhibitors improve heart failure outcomes?" in cmd
        for step in PIPELINE_STEPS:
            project.save_checkpoint(step)
        project.save_text("draft.md", "# Draft", subdir="manuscript")
        project.save_json(
            "manuscript_facts.json",
            {
                "report_type": "meta",
                "evidence_readiness": {
                    "status": "ready",
                    "blocker_codes": [],
                    "blockers": [],
                    "warnings": [],
                },
            },
            subdir="manuscript",
        )
        return subprocess.CompletedProcess(cmd, 0, stdout="resume complete", stderr="")

    monkeypatch.setattr("start._run_resume_subprocess", fake_runner)

    result = _resume_project_payload({"project_dir": str(project.base_dir)})

    assert result["ok"] is True
    assert result["resume_step_before"] == "pdf_parsing"
    assert result["resume_step_after"] is None
    assert result["report_type"] == "meta"
    assert result["evidence_readiness"]["status"] == "ready"
    assert result["stdout_tail"] == "resume complete"
    assert result["package_path"].endswith("metaagent_export.zip")
    assert project.get_path("metaagent_export.zip", subdir="package").exists()
    assert len(calls) == 1


def test_resume_project_payload_records_cli_failure(monkeypatch) -> None:
    project = _project_under_output()
    project.save_json("protocol.json", _protocol())
    project.save_checkpoint("protocol")

    def fake_runner(cmd: list[str], *, timeout_seconds: int):
        return subprocess.CompletedProcess(cmd, 2, stdout="partial", stderr="LLM key missing")

    monkeypatch.setattr("start._run_resume_subprocess", fake_runner)

    result = _resume_project_payload({"project_dir": str(project.base_dir)})
    warnings = project.load_json("pipeline_warnings.json")

    assert result["ok"] is False
    assert result["error"] == "resume_failed"
    assert result["returncode"] == 2
    assert result["stdout_tail"] == "partial"
    assert result["stderr_tail"] == "LLM key missing"
    assert warnings[-1]["code"] == "resume_failed"
    assert warnings[-1]["severity"] == "error"


def test_resume_project_payload_skips_when_project_is_already_complete(monkeypatch) -> None:
    project = _project_under_output()
    project.save_json("protocol.json", _protocol())
    project.save_text("draft.md", "# Done", subdir="manuscript")
    project.save_json(
        "manuscript_facts.json",
        {"report_type": "evidence_gap", "evidence_readiness": {"status": "blocked"}},
        subdir="manuscript",
    )
    for step in PIPELINE_STEPS:
        project.save_checkpoint(step)

    def fail_runner(cmd: list[str], *, timeout_seconds: int):
        raise AssertionError("completed projects should not start a resume subprocess")

    monkeypatch.setattr("start._run_resume_subprocess", fail_runner)

    result = _resume_project_payload({"project_dir": str(project.base_dir)})

    assert result["ok"] is True
    assert result["skipped"] is True
    assert result["resume_step_before"] is None
    assert result["report_type"] == "evidence_gap"
    assert result["package_path"].endswith("metaagent_export.zip")


def test_resume_project_payload_can_force_manuscript_only_rerun(monkeypatch) -> None:
    project = _project_under_output()
    project.save_json("protocol.json", _protocol())
    for step in PIPELINE_STEPS:
        project.save_checkpoint(step)
    project.save_text("draft.md", "# Old draft", subdir="manuscript")

    calls = []

    def fake_runner(cmd: list[str], *, timeout_seconds: int):
        calls.append(cmd)
        assert "--rerun-manuscript-only" in cmd
        project.save_text("draft.md", "# New draft", subdir="manuscript")
        project.save_json(
            "manuscript_facts.json",
            {
                "report_type": "meta",
                "evidence_readiness": {"status": "needs_review", "blocker_codes": [], "blockers": [], "warnings": []},
            },
            subdir="manuscript",
        )
        return subprocess.CompletedProcess(cmd, 0, stdout="manuscript rerun complete", stderr="")

    monkeypatch.setattr("start._run_resume_subprocess", fake_runner)

    result = _resume_project_payload(
        {"project_dir": str(project.base_dir), "rerun_manuscript_only": True}
    )

    assert result["ok"] is True
    assert result["skipped"] is False
    assert result["report_type"] == "meta"
    assert result["stdout_tail"] == "manuscript rerun complete"
    assert len(calls) == 1
