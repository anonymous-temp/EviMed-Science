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

