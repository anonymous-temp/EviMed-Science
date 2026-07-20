from pathlib import Path

import start
from new_meta.core.project import Project
from new_meta.core.release_contract import build_release_decision, persist_release_decision


def test_web_terminal_outcome_emits_blocked_instead_of_done(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("blocked Web release", output_dir=tmp_path / "project")
    package_path = project.get_path("metaagent_export.zip", subdir="package")

    def fake_package(project_arg):
        package_path.parent.mkdir(parents=True, exist_ok=True)
        package_path.write_bytes(b"review package")
        persist_release_decision(
            project_arg,
            build_release_decision(
                {
                    "status": "blocked",
                    "passed": False,
                    "gates": [{"id": "citation", "status": "fail", "detail": "unsupported"}],
                },
                package_path=package_path,
            ),
        )
        return package_path

    monkeypatch.setattr("new_meta.core.artifact_package.create_artifact_package", fake_package)
    monkeypatch.setattr("new_meta.core.llm.write_llm_usage_manifest", lambda project: None)
    events: list[tuple[str, object]] = []

    decision = start._finalize_web_release(
        project,
        manuscript="# Draft",
        push=lambda kind, payload: events.append((kind, payload)),
    )

    assert decision["status"] == "blocked"
    assert [kind for kind, _ in events] == ["blocked"]
    assert events[0][1]["blocker_codes"] == ["citation"]
    assert events[0][1]["package_path"] == str(package_path)


def test_web_terminal_outcome_emits_done_only_for_releasable_package(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("ready Web release", output_dir=tmp_path / "project")
    package_path = project.get_path("metaagent_export.zip", subdir="package")

    def fake_package(project_arg):
        package_path.parent.mkdir(parents=True, exist_ok=True)
        package_path.write_bytes(b"submission package")
        persist_release_decision(
            project_arg,
            build_release_decision(
                {"status": "ready", "passed": True, "gates": []},
                package_path=package_path,
            ),
        )
        return package_path

    monkeypatch.setattr("new_meta.core.artifact_package.create_artifact_package", fake_package)
    monkeypatch.setattr("new_meta.core.llm.write_llm_usage_manifest", lambda project: None)
    events: list[tuple[str, object]] = []

    decision = start._finalize_web_release(
        project,
        manuscript="# Final manuscript",
        push=lambda kind, payload: events.append((kind, payload)),
    )

    assert decision["status"] == "ready"
    assert events == [("done", "# Final manuscript")]

