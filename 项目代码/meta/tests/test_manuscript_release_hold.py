"""No gate replaces the manuscript with a stub; the release report names what holds it back.

Coordinator ruling of 2026-09-29 (platform principles 13 and 19). Until then a
failed manuscript check replaced the draft with a one-page "Manuscript
Validation Blocked" stub and every other gate measured the stub: production
ma-001 reported 17 failed gates and 0 references, a local ma-001 run 18.
"""
from __future__ import annotations

import inspect

from new_meta.core.project import Project


def _readiness(project, validation):
    from new_meta.core.artifact_package_submission import build_submission_readiness_review
    project.save_json("manuscript_validation.json", validation, subdir="manuscript")
    names = [name for name in inspect.signature(build_submission_readiness_review).parameters
             if name not in {"project", "manuscript"}]
    return build_submission_readiness_review(
        project, manuscript={"included": True, "markdown": True, "docx": True, "pdf": True},
        **{name: None for name in names})


def test_the_validation_gate_names_its_blocking_reasons(tmp_path):
    project = Project("release hold", output_dir=tmp_path)
    (project.base_dir / "manuscript").mkdir(exist_ok=True)
    (project.base_dir / "manuscript" / "draft.md").write_text("# Title\n\n## Abstract\n\nText.\n")
    review = _readiness(project, {"passed": False, "issues": [
        {"kind": "citation_audit", "severity": "error", "message": "A reference number is missing."}]})
    gate = next(item for item in review["gates"] if item["id"] == "manuscript_validation")
    assert gate["status"] == "fail"
    assert "Blocking: citation_audit - A reference number is missing." in gate["detail"]


def test_without_any_draft_text_gates_say_not_evaluated(tmp_path):
    project = Project("no draft", output_dir=tmp_path)
    (project.base_dir / "manuscript").mkdir(exist_ok=True)
    (project.base_dir / "manuscript" / "draft.md").write_text("")
    review = _readiness(project, {"passed": False, "issues": []})
    by_id = {item["id"]: item for item in review["gates"]}
    assert by_id["references"]["status"] == "not_evaluated"
    assert by_id["references"]["detail"] == "not evaluated: no manuscript draft was written."
    assert review["status"] == "blocked"  # other gates still fail; nothing is passed on nothing


def test_no_writer_path_swaps_in_the_stub():
    from pathlib import Path
    import new_meta.agents.writing as writing
    sources = [Path(writing.__file__).parent.glob("*.py"), [Path(writing.__file__).parent.parent / "writing_agent.py"]]
    scanned = 0
    for group in sources:
        for path in group:
            text = path.read_text(encoding="utf-8")
            scanned += 1
            assert "_write_validation_blocked_report(" not in text, path
            assert '"draft.rejected.md"' not in text, path
    assert scanned > 5  # the walk found the writer modules
