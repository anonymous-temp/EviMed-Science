from pathlib import Path
import json
import zipfile

import pytest

import new_meta.core.artifact_package as artifact_package_module
from new_meta.core.artifact_package import create_artifact_package
from new_meta.core.project import Project
from new_meta.core.release_contract import (
    ReleaseBlockedError,
    ReleaseStatus,
    build_release_decision,
    load_release_decision,
    persist_release_decision,
    require_releasable,
)


def test_release_contract_blocks_missing_or_failed_submission_review(tmp_path: Path) -> None:
    missing = build_release_decision(None, package_path=tmp_path / "review.zip")
    failed = build_release_decision(
        {
            "status": "blocked",
            "passed": False,
            "gates": [
                {"id": "calculation", "status": "fail", "detail": "source mismatch"},
                {"id": "citation", "status": "pass", "detail": "ok"},
            ],
        },
        package_path=tmp_path / "review.zip",
    )

    assert missing["status"] == ReleaseStatus.BLOCKED.value
    assert "missing_submission_readiness_review" in missing["blocker_codes"]
    assert failed["status"] == ReleaseStatus.BLOCKED.value
    assert failed["ready_for_submission"] is False
    assert failed["blocker_codes"] == ["calculation"]
    assert failed["next_actions"]


def test_release_contract_preserves_ready_with_warnings(tmp_path: Path) -> None:
    decision = build_release_decision(
        {
            "status": "ready_with_warnings",
            "passed": True,
            "gates": [
                {"id": "benchmark", "status": "warn", "detail": "not attached"},
            ],
        },
        package_path=tmp_path / "review.zip",
    )

    assert decision["status"] == ReleaseStatus.READY_WITH_WARNINGS.value
    assert decision["ready_for_submission"] is True
    assert decision["requires_review"] is True
    assert decision["warning_codes"] == ["benchmark"]


def test_release_messages_do_not_create_a_submission_approval_workflow(tmp_path: Path) -> None:
    decisions = [
        build_release_decision(
            {"status": "ready", "passed": True, "gates": []},
            package_path=tmp_path / "article.zip",
        ),
        build_release_decision(
            {
                "status": "ready_with_warnings",
                "passed": True,
                "gates": [{"id": "style", "status": "warn", "detail": "minor"}],
            },
            package_path=tmp_path / "article.zip",
        ),
    ]

    messages = " ".join(
        str(item)
        for decision in decisions
        for item in [decision["summary"], *(decision["next_actions"] or [])]
    ).lower()

    assert "signed package" not in messages
    assert "explicitly accept" not in messages
    assert "release approval" not in messages
    assert all("article" in decision["summary"].lower() for decision in decisions)


def test_persisted_blocked_release_is_terminal(tmp_path: Path) -> None:
    project = Project("blocked release", output_dir=tmp_path / "project")
    decision = build_release_decision(
        {
            "status": "blocked",
            "passed": False,
            "gates": [{"id": "rob", "status": "fail", "detail": "missing RoB"}],
        },
        package_path=project.get_path("metaagent_export.zip", subdir="package"),
    )
    persist_release_decision(project, decision)

    assert load_release_decision(project) == decision
    with pytest.raises(ReleaseBlockedError) as exc:
        require_releasable(project)
    assert exc.value.decision["blocker_codes"] == ["rob"]


def test_artifact_package_persists_and_embeds_release_decision(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("blocked package", output_dir=tmp_path / "project")
    submission = {
        "status": "blocked",
        "passed": False,
        "gates": [{"id": "calculation", "status": "fail", "detail": "mismatch"}],
    }
    monkeypatch.setattr(artifact_package_module, "export_manuscript_docx", lambda project: None)
    monkeypatch.setattr(artifact_package_module, "export_manuscript_pdf", lambda project: None)
    monkeypatch.setattr(artifact_package_module, "_iter_package_entries", lambda project: iter(()))
    monkeypatch.setattr(
        artifact_package_module,
        "_generated_review_entries",
        lambda project: [("review/submission_readiness_review.json", submission)],
    )

    package_path = create_artifact_package(project)

    decision = load_release_decision(project)
    persisted_manifest = project.load_json("package_manifest.json", subdir="package")
    persisted_submission = project.load_json("submission_readiness_review.json", subdir="package")
    with zipfile.ZipFile(package_path) as zf:
        embedded_decision = json.loads(zf.read("review/release_decision.json"))
        embedded_manifest = json.loads(zf.read("package_manifest.json"))

    assert decision["status"] == "blocked"
    assert decision["blocker_codes"] == ["calculation"]
    assert embedded_decision == decision
    assert embedded_manifest["release"] == decision
    assert persisted_manifest["release"] == decision
    assert persisted_submission == submission
