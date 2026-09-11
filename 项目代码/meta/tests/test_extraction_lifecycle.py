from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from new_meta.agents.data_extraction_agent import DataExtractionAgent, OutcomeList
from new_meta.core.extraction_status import ExtractionIncomplete, require_complete_extraction
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def protocol():
    return ResearchProtocol(research_question="Does treatment reduce renal events?",
                            pico=PICO(population="adults", intervention="drug", comparator="placebo",
                                      outcome_primary="renal events"), effect_measure="HR")


def study(study_id="S1"):
    return ExtractedStudy(characteristics=StudyCharacteristics(study_id=study_id, pmid=study_id),
                          outcomes=[OutcomeData(outcome_name="renal events", outcome_type="time_to_event",
                                                effect_size=0.66, ci_lower=0.53, ci_upper=0.81)])


class ProviderUnavailable(RuntimeError):
    status_code = 502


@pytest.mark.parametrize("partial", [False, True])
def test_provider_failure_preserves_partial_extraction_and_stops_pipeline(tmp_path, monkeypatch, partial, caplog):
    project = Project("extraction lifecycle", output_dir=tmp_path)
    for step in ("extraction", "rob", "effect_sizes", "meta_analysis", "manuscript"):
        project.save_checkpoint(step)
    agent = DataExtractionAgent()
    papers = [{"pmid": "S2", "fulltext_source": "pdf"}]
    if partial:
        papers.insert(0, {"pmid": "S1", "fulltext_source": "pdf"})
    parsed = {row["pmid"]: {"full_text": row["pmid"] + " full article"} for row in papers}

    def llm(prompt, schema, **kwargs):
        if schema is StudyCharacteristics:
            return StudyCharacteristics()
        if "S2 full article" in prompt:
            raise ProviderUnavailable("private provider body must not enter diagnostics")
        return OutcomeList(outcomes=study().outcomes)

    monkeypatch.setattr(agent, "call_llm_structured", llm)
    verifier = Mock(side_effect=AssertionError("No verification after incomplete extraction"))
    monkeypatch.setattr(agent, "_verify_alignment", verifier)
    with pytest.raises(ExtractionIncomplete) as caught:
        agent.run(papers, parsed, protocol(), project)
    phase = caught.value.phase
    assert phase.status.value == "failed" and phase.retryable
    assert phase.metrics["completed_studies"] == int(partial)
    assert phase.data["failures"][0]["schema"] == "OutcomeList"
    assert [row["status_code"] for row in phase.data["failures"][0]["attempts"]] == [502, 502, 502]
    assert "private provider body" not in phase.model_dump_json()
    assert "private provider body" not in caplog.text
    assert len(project.load_json("all_extractions.json", subdir="extraction")) == int(partial)
    assert not project.is_step_done("extraction") and not project.is_step_done("manuscript")
    assert project.load_step_manifest()["steps"]["extraction"]["status"] == "incomplete"
    decision = project.load_json("release_decision.json", subdir="package")
    assert decision["phaseStatus"] == "failed" and decision["retryable"]
    assert "failed_gates" not in decision
    verifier.assert_not_called()

    # A smaller downstream list cannot omit the failed source to gain admission.
    runner = PipelineRunner(project)
    rob = Mock()
    with pytest.raises(ExtractionIncomplete):
        runner.assess_risk_and_select_primary_effects(protocol=protocol(), extracted_studies=[study()],
                                                     parsed_papers={}, included_papers=[], rob_agent=rob)
    rob.run.assert_not_called()
    assert runner.run_primary_effect_selection(protocol=protocol(), extracted_studies=[study()]).status.value == "failed"
    assert runner.run_compiled_method_synthesis().status.value == "failed"

    if partial:
        # Re-extracting only the successful study cannot erase the missing source.
        with pytest.raises(ExtractionIncomplete) as smaller_retry:
            agent.run(papers[:1], parsed, protocol(), project)
        assert smaller_retry.value.phase.data["required_study_ids"] == ["S1", "S2"]

    # A genuine successful retry replaces only this phase's transient failure.
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kw:
                        StudyCharacteristics() if schema is StudyCharacteristics else OutcomeList(outcomes=study().outcomes))
    monkeypatch.setattr(agent, "_verify_alignment", lambda value, *args: value)
    completed = agent.run(papers, parsed, protocol(), project)
    require_complete_extraction(project, completed, papers)
    assert len(completed) == len(papers)
    assert project.load_json("extraction_status.json", subdir="extraction")["status"] == "succeeded"


def test_valid_empty_outcomes_require_review_without_claiming_provider_failure(tmp_path, monkeypatch):
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kw: schema())
    project = Project("no outcomes", output_dir=tmp_path)
    with pytest.raises(ExtractionIncomplete) as caught:
        agent.run([{"pmid": "S1"}], {"S1": {"full_text": "Full report without outcome data"}}, protocol(), project)
    assert caught.value.phase.status.value == "needs_input"
    assert not caught.value.phase.retryable
    assert caught.value.phase.issues[0].code == "extraction_outcomes_empty"


@pytest.mark.parametrize("rows", [[], [ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1"))], [study()]])
def test_cached_empty_or_partial_extractions_block_cli_api_and_shared_methods(tmp_path, rows):
    project = Project("legacy cache", output_dir=tmp_path)
    project.save_json("all_extractions.json", rows, subdir="extraction")
    project.save_json("full_text_screening.json", [{"decision": "include", "paper": {"pmid": sid}}
                                                  for sid in ("S1", "S2")], subdir="screening")
    from new_meta.main import _load_cached_resume_inputs
    with pytest.raises(ExtractionIncomplete):
        _load_cached_resume_inputs(project, SimpleNamespace())
    from new_meta.api import _release_phase_result
    assert _release_phase_result(project).phase.value == "extraction"
    from new_meta.core.method_executor import MethodExecutor
    with pytest.raises(ExtractionIncomplete):
        MethodExecutor().execute_project(None, project=project, result_ids=[])


def test_legacy_failed_record_cannot_be_hidden_by_passing_a_successful_subset(tmp_path):
    project = Project("legacy partial", output_dir=tmp_path)
    failed = ExtractedStudy(characteristics=StudyCharacteristics(study_id="S2"), quality_notes="EXTRACTION_FAILED")
    project.save_json("all_extractions.json", [study(), failed], subdir="extraction")
    result = PipelineRunner(project).run_primary_effect_selection(protocol=protocol(), extracted_studies=[study()])
    assert result.status.value == "failed"
    assert result.data["failures"][0]["study_id"] == "S2"


def test_required_sources_accept_web_screening_wrappers_without_requiring_exclusions(tmp_path):
    project = Project("screening source wrappers", output_dir=tmp_path)
    rows = [{"decision": "include", "paper": {"pmid": "S1"}},
            {"decision": "exclude", "paper": {"pmid": "S2"}}]
    require_complete_extraction(project, [study()], rows)


def test_web_downstream_rerun_returns_phase_before_generation(tmp_path, monkeypatch):
    import start
    project = Project("downstream failure", output_dir=tmp_path)
    project.save_json("all_extractions.json", [], subdir="extraction")
    monkeypatch.setattr(start, "_resolve_project_dir", lambda *args, **kwargs: project.base_dir)
    result = start._run_downstream_after_overrides_payload({"project_dir": str(project.base_dir)})
    assert result["ok"] is False and result["phase"]["phase"] == "extraction"
    assert result["phase"]["status"] == "needs_input"


def test_initial_extraction_keeps_results_in_middle_of_complete_source(tmp_path, monkeypatch):
    agent = DataExtractionAgent()
    source = "Introduction " + "a " * 15000 + "MIDDLE_RESULT HR 0.66 95% CI 0.53 to 0.81" + " z" * 16000
    prompts = []

    def llm(prompt, schema, **kwargs):
        prompts.append(prompt)
        return StudyCharacteristics() if schema is StudyCharacteristics else OutcomeList(outcomes=study().outcomes)

    monkeypatch.setattr(agent, "call_llm_structured", llm)
    agent._extract_single({"pmid": "S1"}, {"full_text": source}, protocol(), Project("complete source", output_dir=tmp_path))
    assert len(prompts) == 2
    assert all(source in prompt for prompt in prompts)


def test_overlimit_source_blocks_before_llm_call(tmp_path, monkeypatch):
    agent = DataExtractionAgent()
    llm = Mock(side_effect=AssertionError("Source cannot be truncated"))
    monkeypatch.setattr(agent, "call_llm_structured", llm)
    with pytest.raises(ExtractionIncomplete) as caught:
        agent.run([{"pmid": "S1"}], {"S1": {"full_text": "x" * 128001}}, protocol(),
                  Project("source limit", output_dir=tmp_path))
    assert caught.value.phase.issues[0].code == "extraction_source_context_unavailable"
    assert caught.value.phase.status.value == "needs_input" and not caught.value.phase.retryable
    llm.assert_not_called()


@pytest.mark.parametrize("status, retryable, code", [("failed", True, 75), ("failed", False, 1), ("needs_input", False, 2)])
def test_cli_incomplete_phase_uses_temporary_failure_or_input_exit_code(tmp_path, status, retryable, code, capsys):
    from new_meta.core.extraction_status import IncompletePhaseError
    from new_meta.main import _finish_incomplete_cli_phase
    from new_meta.schemas.phase_result import PhaseIssue, PhaseResult
    phase = PhaseResult(run_id="test", phase="extraction", status=status, retryable=retryable,
                        summary="Extraction stopped", error_code="extraction_incomplete",
                        issues=[PhaseIssue(code="test_incomplete", message="Incomplete", blocking=True)])
    with pytest.raises(SystemExit) as caught:
        _finish_incomplete_cli_phase(IncompletePhaseError(phase, Project("cli", output_dir=tmp_path)))
    assert caught.value.code == code
    assert "Extraction stopped" in capsys.readouterr().out


def test_matched_user_pdf_retains_upload_origin(tmp_path, monkeypatch):
    from new_meta.agents.paper_retriever import PaperRetriever
    import new_meta.agents.pdf_parser as parser
    monkeypatch.setattr(parser, "parse_pdf", lambda _: {"full_text": "Matched trial article"})
    monkeypatch.setattr(parser, "extract_pdf_title", lambda _: "Matched trial")
    paper = {"pmid": "30990260", "title": "Matched trial", "source_type": "pubmed"}
    matched, extra, _ = PaperRetriever().match_user_pdfs([paper], [str(tmp_path / "30990260.pdf")])
    assert matched == 1 and not extra
    assert DataExtractionAgent._source_type(paper) == "user_upload"


@pytest.mark.parametrize("with_status", [False, True])
def test_unresolved_screening_blocks_reuse_of_existing_extractions(tmp_path, with_status):
    from new_meta.agents.screening_agent import ScreeningReviewRequired
    from new_meta.core.method_executor import MethodExecutor
    from new_meta.main import _load_cached_resume_inputs
    from new_meta.api import _release_phase_result
    project = Project("screening cache", output_dir=tmp_path)
    project.save_json("all_extractions.json", [study()], subdir="extraction")
    records = [{"decision": "review_required", "reason": "Source identity unresolved", "paper": {"pmid": "S1"}}]
    project.save_json("full_text_screening.json", records, subdir="screening")
    if with_status:
        phase = ScreeningReviewRequired(records, project).phase
        project.save_json("full_text_screening_status.json", phase, subdir="screening")
    for step in ("ft_screening", "extraction", "rob", "effect_sizes", "meta_analysis"):
        project.save_checkpoint(step)
    runner = PipelineRunner(project)
    phase = runner.run_primary_effect_selection(protocol=protocol(), extracted_studies=[study()])
    assert phase.phase.value == "screening" and phase.status.value == "needs_input"
    assert runner.run_compiled_method_synthesis().phase.value == "screening"
    assert _release_phase_result(project).phase.value == "screening"
    with pytest.raises(ScreeningReviewRequired):
        _load_cached_resume_inputs(project, SimpleNamespace())
    with pytest.raises(ScreeningReviewRequired):
        MethodExecutor().execute_project(None, project=project, result_ids=[])
    assert not project.is_step_done("ft_screening") and not project.is_step_done("effect_sizes")


@pytest.mark.parametrize("metadata, expected", [
    ({"pdf_path": "/managed/paper.pdf", "fulltext_source": "pdf"}, "database"),
    ({"pdf_path": "/managed/paper.pdf", "retrieval_sources": ["pubmed"]}, "database"),
    ({"pdf_path": "/local/unknown.pdf"}, "unknown"),
    ({"pmid": "user_pdf_1", "pdf_path": "/upload/paper.pdf"}, "user_upload"),
    ({"source_type": "database", "user_uploaded_full_text": True}, "user_upload"),
    ({"fulltext_source": "user_upload", "pmid": "30990260"}, "user_upload"),
])
def test_origin_comes_from_ingestion_not_llm_or_path(metadata, expected):
    characteristics = StudyCharacteristics(source_type="user_upload")
    DataExtractionAgent()._apply_paper_metadata(characteristics, metadata, "S1")
    assert characteristics.source_type == expected


@pytest.mark.parametrize("entry", ["_run_phase2_sync", "_run_pipeline_sync"])
def test_web_stops_with_typed_phase_and_no_completed_step(tmp_path, monkeypatch, entry):
    import start
    from new_meta.core.extraction_status import extraction_failure, extraction_incomplete
    project = Project("web failure", output_dir=tmp_path)
    error = extraction_incomplete(project, [extraction_failure("S1", "study_extraction_failed", retryable=True)])
    inner = "_run_phase2_inner" if entry == "_run_phase2_sync" else "_run_pipeline_inner"
    monkeypatch.setattr(start, inner, Mock(side_effect=error))
    events = []
    result = getattr(start, entry)({} if entry == "_run_phase2_sync" else "topic", str(tmp_path),
                                   push=lambda kind, payload: events.append((kind, payload)))
    assert result is None
    assert [kind for kind, _ in events] == ["phase_incomplete"]
    assert events[0][1]["phase"]["status"] == "failed"
    assert events[0][1]["retryable"] and not events[0][1]["input_required"]
