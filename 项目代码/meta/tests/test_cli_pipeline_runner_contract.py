import inspect
from pathlib import Path

import new_meta.main as main_module
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.phase_result import ExecutionStatus, PhaseName, PhaseResult


def test_cli_effect_selection_phase_delegates_to_pipeline_runner(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("cli shared selection", output_dir=tmp_path / "project")
    expected = PhaseResult(
        run_id="run-1",
        phase=PhaseName.EFFECT_SELECTION,
        status=ExecutionStatus.SUCCEEDED,
        summary="Selection complete",
        data={"effects": [object()], "selection_audit": [{"decision": "selected_within_study"}]},
    )
    observed = {}

    def fake_select(self, **kwargs):
        observed["runner"] = self
        observed.update(kwargs)
        return expected

    monkeypatch.setattr(PipelineRunner, "run_primary_effect_selection", fake_select)

    result = main_module._compute_cli_primary_effect_selection(
        project=project,
        protocol="protocol",
        extracted_studies=["study"],
        rob_results=["rob"],
        included_papers=["paper"],
    )

    assert result is expected
    assert observed["runner"].project is project
    assert observed["protocol"] == "protocol"
    assert observed["extracted_studies"] == ["study"]
    assert observed["rob_results"] == ["rob"]
    assert observed["included_papers"] == ["paper"]


def test_cli_main_has_no_inline_primary_effect_selector() -> None:
    source = inspect.getsource(main_module.main)

    assert "_compute_cli_primary_effect_selection(" in source
    assert "selection_result.data[\"effects\"]" in source
    assert "primary_candidates = []" not in source
