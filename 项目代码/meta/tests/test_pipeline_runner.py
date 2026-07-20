from pathlib import Path

from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project


class _FakeRoBAgent:
    def __init__(self, events: list[tuple[str, object]], results: list[object]):
        self.events = events
        self.results = results

    def run(self, extracted_studies, parsed_papers, project, required_study_ids=None):
        self.events.append(
            (
                "rob",
                {
                    "studies": extracted_studies,
                    "parsed": parsed_papers,
                    "required": required_study_ids,
                    "project": project,
                },
            )
        )
        return self.results


def test_runner_assesses_risk_before_selecting_primary_effects(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("shared primary inputs", output_dir=tmp_path / "project")
    runner = PipelineRunner(project)
    events: list[tuple[str, object]] = []
    rob_results = [object()]
    effects = [object()]
    audit = [{"decision": "selected_within_study"}]
    studies = [object()]
    parsed_papers = {"S1": {"full_text": "trial report"}}
    included_papers = [{"pmid": "S1", "text_availability": "full_text"}]
    protocol = object()

    def fake_select(*, protocol, extracted_studies, rob_results, included_papers):
        events.append(
            (
                "selection",
                {
                    "protocol": protocol,
                    "studies": extracted_studies,
                    "rob": rob_results,
                    "included": included_papers,
                },
            )
        )
        return effects, audit

    monkeypatch.setattr(runner, "compute_primary_effect_selection", fake_select)

    result = runner.assess_risk_and_select_primary_effects(
        protocol=protocol,
        extracted_studies=studies,
        parsed_papers=parsed_papers,
        included_papers=included_papers,
        required_study_ids=["S1"],
        rob_agent=_FakeRoBAgent(events, rob_results),
    )

    assert result == (rob_results, effects, audit)
    assert [name for name, _ in events] == ["rob", "selection"]
    assert events[1][1]["rob"] is rob_results
    assert events[1][1]["included"] is included_papers
    assert project.is_step_done("rob") is True
    assert project.is_step_done("effect_sizes") is True

