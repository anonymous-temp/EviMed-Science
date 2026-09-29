"""Unattended runs preserve usable evidence instead of requesting adjudication."""
from unittest.mock import Mock

import pytest

from new_meta.core.pipeline_runner import PipelineRunner, compiled_synthesis_falls_back_to_narrative
from new_meta.core.primary_analysis_alignment import UNATTENDED_RUN_FILE
from new_meta.core.project import Project
from new_meta.schemas.phase_result import PhaseIssue, PhaseResult


def unattended(project):
    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    return project


def test_mixed_extraction_verifies_the_usable_subset_and_preserves_prior_artifacts(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.extraction_status import require_complete_extraction
    from test_extraction_lifecycle import protocol, study, ProviderUnavailable
    project = unattended(Project("partial extraction", output_dir=tmp_path))
    project.save_text("manuscript.md", "Existing usable draft", subdir="manuscript")
    agent = DataExtractionAgent()
    def extract(paper, *args, **kwargs):
        if paper["pmid"] == "S2":
            raise ProviderUnavailable("provider failure")
        return study(paper["pmid"])
    monkeypatch.setattr(agent, "_extract_single", extract)
    verify = Mock(side_effect=lambda row, *args: row)
    monkeypatch.setattr(agent, "_verify_alignment", verify)
    results = agent.run([{"pmid": "S1"}, {"pmid": "S2"}], {}, protocol(), project, unattended=True)
    assert [row.characteristics.study_id for row in results] == ["S1"]
    assert results[0].outcomes[0].effect_size == 0.66
    verify.assert_called_once()
    require_complete_extraction(project, results)
    status = project.load_json("extraction_status.json", subdir="extraction")
    assert status["data"]["failures"][0]["study_id"] == "S2"
    assert status["metrics"]["incomplete_studies"] == 1
    assert not any(item["blocking"] for item in status["issues"])
    assert project.get_path("manuscript.md", subdir="manuscript").read_text() == "Existing usable draft"
    assert any(row["code"] == "partial_extraction" for row in project.load_json("pipeline_warnings.json"))


def test_unresolved_screening_retains_pending_sources_without_blocking_successful_subset(tmp_path):
    from new_meta.core.extraction_status import require_complete_screening
    project = unattended(Project("partial screening", output_dir=tmp_path))
    records = [{"paper": {"pmid": "S1"}, "decision": "include"},
               {"paper": {"pmid": "S2"}, "decision": "review_required", "reason": "Model output unavailable"}]
    project.save_json("full_text_screening.json", records, subdir="screening")
    require_complete_screening(project)
    assert project.load_json("full_text_screening.json", subdir="screening") == records
    assert any(row["code"] == "partial_screening" for row in project.load_json("pipeline_warnings.json"))


def test_scope_checker_unavailable_preserves_executable_proposal(tmp_path, monkeypatch):
    from new_meta.agents.research_planner import ResearchPlanner
    from new_meta.core.method_planning import admit_project_protocol
    from test_protocol_scope import TOPIC, proposal
    planner = ResearchPlanner()
    candidate = proposal()
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: candidate)
    monkeypatch.setattr(planner, "check_scope", Mock(side_effect=RuntimeError("checker unavailable")))
    generated = planner.run(TOPIC)
    assert generated.model_dump() == candidate.model_dump()
    assert generated._scope_receipt["status"] == "unverified"
    project = unattended(Project(TOPIC, output_dir=tmp_path))
    admit_project_protocol(project, generated)
    receipt = project.load_json("protocol_scope.json", subdir="analysis")
    assert receipt["status"] == "unverified" and "assessment" not in receipt
    assert any(row["code"] == "protocol_scope_unverified" for row in project.load_json("pipeline_warnings.json"))


@pytest.mark.parametrize("code", ["trial_independence_required", "analysis_set_adjudication_required", "transitivity_assessment_required", "method_inputs_invalid", "method_execution_blocked"])
def test_unsupported_specific_calculation_keeps_narrative_delivery(code):
    phase = PhaseResult(run_id="run", phase="synthesis", status="blocked", summary="Cannot calculate this estimate.",
                        error_code=code, issues=[PhaseIssue(code=code, message="Inputs unresolved.", blocking=True)])
    assert compiled_synthesis_falls_back_to_narrative(phase, unattended=True)


def test_pairwise_excluded_trial_never_survives_in_numeric_inputs(tmp_path, monkeypatch):
    import new_meta.core.primary_analysis_alignment as alignment
    from new_meta.schemas.risk_of_bias import StudyRoB
    from test_primary_analysis_alignment import stamp_fixture
    project, protocol, study, _ = stamp_fixture(tmp_path)
    unattended(project)
    monkeypatch.setattr(alignment, "project_trial_unit_issues", lambda *args, **kwargs: [
        {"row_id": "S1:0", "reason": "trial_identity_required"}])
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=[study],
        rob_results=[StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])])
    selected_ids = {row["study_id"] for row in audit if row["in_final_primary_analysis"]}
    assert {effect.study_id for effect in effects} == selected_ids
