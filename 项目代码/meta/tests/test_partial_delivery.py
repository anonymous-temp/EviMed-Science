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
    from new_meta.core.agent_base import BaseAgent
    monkeypatch.setattr(BaseAgent, "call_llm_structured", Mock(side_effect=ValueError("offline judgment unavailable")))
    from test_primary_analysis_alignment import stamp_fixture
    project, protocol, study, _ = stamp_fixture(tmp_path)
    unattended(project)
    monkeypatch.setattr(alignment, "project_trial_unit_issues", lambda *args, **kwargs: [
        {"row_id": "S1:0", "reason": "trial_identity_required"}])
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=[study],
        rob_results=[StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2", domains=[])])
    selected_ids = {row["study_id"] for row in audit if row["in_final_primary_analysis"]}
    assert {effect.study_id for effect in effects} == selected_ids


def _uncertain_pairwise(tmp_path):
    from test_primary_analysis_alignment import alignment_fixture, SOURCE
    from new_meta.schemas.study import ExtractedStudy
    project, protocol, first, _ = alignment_fixture(tmp_path)
    unattended(project)
    first.outcomes[0].protocol_outcome_role = "primary"
    second = ExtractedStudy.model_validate(first.model_dump())
    second.characteristics.study_id = "S2"
    second.outcomes[0].events_intervention = 6
    studies = [first, second]
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    project.save_json("parsed_papers.json", {"S1": {"full_text": SOURCE}, "S2": {"full_text": SOURCE}}, subdir="papers")
    return project, protocol, studies


def _model_decisions(studies, *, same_trial=False, bad_quote=False):
    from new_meta.core.autonomous_analysis import AnalysisJudgment, RowJudgment
    from new_meta.core.extraction_verification import calculation_fields
    from test_primary_analysis_alignment import SOURCE
    from test_primary_analysis_alignment import alignment_fixture
    from new_meta.schemas.protocol import ResearchProtocol
    # This mock chooses source rows and quotes; it never supplies a new number.
    def respond(self, prompt, schema, **kwargs):
        import json
        request = json.loads(prompt.split("REQUEST_JSON\n", 1)[1])
        study = next(item for item in studies if item.characteristics.study_id == request["study_id"])
        protocol = ResearchProtocol.model_validate(request["protocol"])
        return AnalysisJudgment(rows=[RowJudgment(
            outcome_index=0, include=True, rationale="Use the results-section estimate despite unresolved source comparison.",
            assumptions=["Publication is treated as one trial; independent verification remains incomplete."],
            trial_id="S1" if same_trial else study.characteristics.study_id,
            numeric_quotes={field: ("no numbers here" if bad_quote and study.characteristics.study_id == "S2" else SOURCE)
                            for field in calculation_fields(study.outcomes[0], protocol)},
        )])
    return respond


def test_model_selected_uncertain_rows_with_missing_rob_remain_numeric_and_unverified(tmp_path, monkeypatch):
    from new_meta.core.autonomous_analysis import resolve_analysis_judgments
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.effect_selection import compute_study_effect
    import logging
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    before = [row.model_dump() for row in studies]
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    resolve_analysis_judgments(project, protocol, studies)
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert len(effects) == 2
    assert [(effect.yi, effect.vi) for effect in effects] == [
        (expected.yi, expected.vi) for row in studies
        for expected in [compute_study_effect(row, row.outcomes[0], protocol, logging.getLogger(__name__))]]
    assert [row.model_dump() for row in studies] == before
    assert all(row["alignment"]["status"] == "unknown" for row in audit)
    assert all(row["in_final_primary_analysis"] for row in audit)
    warnings = project.load_json("pipeline_warnings.json")
    assert any(row["code"] == "analysis_assumptions" for row in warnings)
    assert any(row["code"] == "risk_of_bias_unavailable" for row in warnings)


def test_unanchored_numeric_input_affects_only_that_estimate(tmp_path, monkeypatch):
    from new_meta.core.autonomous_analysis import resolve_analysis_judgments
    from new_meta.core.agent_base import BaseAgent
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies, bad_quote=True))
    resolve_analysis_judgments(project, protocol, studies)
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert [effect.study_id for effect in effects] == ["S1"]
    assert next(row for row in audit if row["study_id"] == "S2")["in_final_primary_analysis"] is False
    assert studies[1].outcomes[0].events_intervention == 6


def test_two_reports_of_one_model_identified_trial_contribute_once(tmp_path, monkeypatch):
    from new_meta.core.autonomous_analysis import resolve_analysis_judgments
    from new_meta.core.agent_base import BaseAgent
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies, same_trial=True))
    resolve_analysis_judgments(project, protocol, studies)
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert len(effects) == 1
    assert sum(row["in_final_primary_analysis"] for row in audit) == 1
    assert any("overlap" in row.get("reason", "") for row in audit)


def test_uncertain_selection_can_be_reused_without_claiming_verified_proofs(tmp_path, monkeypatch):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.primary_analysis_alignment import cached_alignment_is_current
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert cached_alignment_is_current(project)
    studies[0].outcomes[0].events_intervention = 7
    project.save_json("all_extractions.json", studies, subdir="extraction")
    assert not cached_alignment_is_current(project)


def test_compiled_review_preserves_uncertain_trial_and_renders_limitations(tmp_path, monkeypatch):
    import json
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.autonomous_analysis import AnalysisJudgment, RowJudgment
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    from new_meta.core.extraction_verification import calculation_fields
    from new_meta.core.method_delivery import run_method_delivery
    from new_meta.core.primary_analysis_alignment import require_current_compiled_alignment
    from new_meta.schemas.protocol import ResearchProtocol
    from test_unattended_primary_analysis_set import _production_studies, _project
    studies = _production_studies()
    project, _ = _project(tmp_path, studies, unattended=True)
    protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    source = project.get_path(studies[0].outcomes[0].primary_analysis_alignment.checked_source_path).read_text()
    studies[0].outcomes[0].primary_analysis_alignment = None
    studies[0].outcomes[0].source_quote_verified = False
    project.save_json("parsed_papers.json", {"22053253": {"full_text": source}}, subdir="papers")
    project.save_json("all_extractions.json", studies, subdir="extraction")
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    def choose(self, prompt, schema, **kwargs):
        request = json.loads(prompt.split("REQUEST_JSON\n", 1)[1])
        return AnalysisJudgment(rows=[RowJudgment(outcome_index=0, include=True, trial_id=request["study_id"],
            rationale="Results-section data support the estimate; verifier unavailable.", assumptions=["Trial identity is uncertain."],
            numeric_quotes={field: source for field in calculation_fields(studies[0].outcomes[0], protocol)})])
    monkeypatch.setattr(BaseAgent, "call_llm_structured", choose)
    delivery = run_method_delivery(project=project, protocol=protocol, extracted_studies=studies, rob_results=[],
        prisma_data=project.prisma.to_dict(), search_query="TXA TKA", lang="en", auto_resolve_uncertainty=True)
    assert delivery.phase.status.value == "succeeded", delivery.phase.summary
    result = project.load_json("synthesis_result.json", subdir="analysis")
    assert result["engine_payload"]["n_studies"] == 4
    assert result["engine_payload"]["n_contrasts"] == 6
    assert "verifier unavailable" in delivery.manuscript and "Trial identity is uncertain" in delivery.manuscript
    assert "verified contrasts" not in delivery.manuscript
    assert "verified aggregate contrasts" not in delivery.manuscript
    assert project.get_path("draft.md", subdir="manuscript").exists()
    assert studies[0].outcomes[0].primary_analysis_alignment is None
    require_current_compiled_alignment(project)


def test_compiled_estimator_label_describes_the_interval_actually_returned():
    """Live ma-001 labelled a normal REML CI as HKSJ; the primary math stays unchanged."""
    from new_meta.engines.complex_rct import run_complex_rct
    from test_method_executor import _complex_rct_records
    records = _complex_rct_records()
    records.append({**records[0], "study_id": "S3", "result_id": "S3:0", "contrast_id": "S3:0", "estimate": 1.1})
    result = run_complex_rct(records)
    assert result.estimator == "DESIGN_AWARE_REML"
    assert result.diagnostics["primary_interval"] == "normal_wald"
    assert result.diagnostics["sensitivity_interval"] == "HKSJ"
    assert result.sensitivity["HKSJ"]["ci_lower"] != result.ci_lower


def test_unattended_cli_preserves_data_and_writes_partial_manuscript_on_unresolved_method(tmp_path, monkeypatch):
    from new_meta.main import _require_cli_method_delivery
    from new_meta.schemas.protocol import ResearchProtocol
    from test_extraction_lifecycle import protocol, study
    project = unattended(Project("partial report", output_dir=tmp_path))
    project.save_json("protocol.json", protocol())
    project.save_json("all_extractions.json", [study()], subdir="extraction")
    phase = PhaseResult(run_id=project.base_dir.name, phase="synthesis", status="blocked",
        summary="Network comparability remains uncertain.", error_code="transitivity_assessment_required",
        issues=[PhaseIssue(code="transitivity_assessment_required", message="No adequate comparison.", blocking=True)])
    # Packaging is separately covered; this oracle checks the pre-package report contract.
    monkeypatch.setattr("new_meta.main.create_artifact_package", lambda project: project.base_dir / "package")
    with pytest.raises(SystemExit) as done:
        _require_cli_method_delivery(project, phase)
    assert done.value.code == 0
    draft = project.get_path("draft.md", subdir="manuscript").read_text()
    assert "Network comparability remains uncertain" in draft
    assert "S1" in draft and "0.66" in draft
    assert project.load_json("all_extractions.json", subdir="extraction")[0]["outcomes"][0]["effect_size"] == 0.66
    assert project.load_json("release_decision.json", subdir="package")["deliverable"] is True


def test_missing_result_rob_does_not_stop_the_unattended_pairwise_writer(tmp_path, monkeypatch):
    import new_meta.main as cli
    from new_meta.core.primary_analysis_alignment import PrimaryAlignmentRequired, needs_input_phase
    project = unattended(Project("missing result rob", output_dir=tmp_path))
    monkeypatch.setattr(cli, "validated_pairwise_result_rob", Mock(side_effect=PrimaryAlignmentRequired(
        needs_input_phase(project, [], reason="pairwise_result_rob_incomplete"))))
    monkeypatch.setattr("new_meta.core.primary_analysis_alignment.require_current_cached_alignment", lambda *args, **kwargs: None)
    writer = Mock()
    writer.run.return_value = "Readable manuscript"
    assert cli._run_verified_pairwise_writer(writer, project=project, protocol=object(), meta_results=object(),
        extracted_studies=[], rob_results=[]) == "Readable manuscript"
    assert writer.run.call_args.kwargs["rob_results"] == []
    assert any(item["code"] == "risk_of_bias_unavailable" for item in project.load_json("pipeline_warnings.json"))


def test_model_identity_cannot_double_count_an_already_verified_trial(tmp_path, monkeypatch):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from test_primary_analysis_alignment import SOURCE, assessment_payload
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    record_checked_alignments(project, protocol, studies[0], [assessment_payload()], source_text=SOURCE,
                              issue_histories={0: ([], True)})
    from new_meta.core.primary_analysis_alignment import alignment_status
    assert alignment_status(project, protocol, studies[0], 0)["status"] == "match"
    project.save_json("all_extractions.json", studies, subdir="extraction")
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies, same_trial=True))
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert [effect.study_id for effect in effects] == ["S1"]
    assert next(row for row in audit if row["study_id"] == "S2")["reason"] == "overlapping_trial_publication"


def test_new_publication_context_invalidates_previous_identity_judgment(tmp_path, monkeypatch):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.autonomous_analysis import resolve_analysis_judgments, judgment_for_row
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    resolve_analysis_judgments(project, protocol, studies)
    assert judgment_for_row(project, protocol, studies[0], 0)["include"]
    studies[1].characteristics.title = "Secondary publication of S1"
    project.save_json("all_extractions.json", studies, subdir="extraction")
    assert judgment_for_row(project, protocol, studies[0], 0) is None


def test_model_source_resolution_replays_an_existing_negative_verification(tmp_path, monkeypatch):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.primary_analysis_alignment import record_checked_alignments, cached_alignment_is_current
    from test_primary_analysis_alignment import SOURCE, assessment_payload
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    record_checked_alignments(project, protocol, studies[0], [assessment_payload(contrast="mismatch")], source_text=SOURCE,
                              issue_histories={0: ([], True)})
    project.save_json("all_extractions.json", studies, subdir="extraction")
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert len(effects) == 2
    assert audit[0]["alignment"]["status"] == "mismatch"
    assert cached_alignment_is_current(project)


def test_pairwise_manuscript_keeps_analysis_assumptions_in_readable_prose():
    from new_meta.core.manuscript_facts import _ensure_pipeline_warning_note
    draft = "# Review\n\n## Results\n\nTwo estimates were pooled.\n\n## References\n"
    rendered, _ = _ensure_pipeline_warning_note(draft, {"report_type": "meta", "pipeline_warnings": [
        {"code": "analysis_assumptions", "stage": "synthesis", "message": "Trial identity remains uncertain for S1."},
        {"code": "risk_of_bias_unavailable", "stage": "synthesis", "message": "Risk of bias is unknown for S1."}]})
    assert "Trial identity remains uncertain for S1" in rendered
    assert "Risk of bias is unknown for S1" in rendered
    assert "analysis_assumptions" not in rendered


def test_live_ma001_numeric_replay_changes_only_the_primary_method_label():
    import json
    from pathlib import Path
    from new_meta.engines.complex_rct import run_complex_rct
    fixture = json.loads((Path(__file__).parent / "fixtures" / "ma001_complex_rct_numeric_inputs.json").read_text())
    result = run_complex_rct(fixture["records"])
    assert result.estimator == "DESIGN_AWARE_REML"
    for field, expected in fixture["expected"].items():
        assert getattr(result, field) == expected


def test_known_registration_overlap_cannot_be_overridden_by_model_publication_ids(tmp_path, monkeypatch):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from test_primary_analysis_alignment import SOURCE, assessment_payload
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    for study in studies:
        # Two reports name the same registration; a differing publication ID
        # cannot turn them into independent trials.
        record_checked_alignments(project, protocol, study,
            [assessment_payload(source_outcome=study.outcomes[0], contrast="uncertain")],
            source_text=SOURCE, issue_histories={0: ([], True)})
    project.save_json("all_extractions.json", studies, subdir="extraction")
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert len(effects) == 1
    assert sum(row["in_final_primary_analysis"] for row in audit) == 1


def test_unsupported_method_admission_keeps_available_evidence_report(tmp_path, monkeypatch):
    import new_meta.main as cli
    from new_meta.core.method_planning import MethodCapabilityBlockedError
    from test_method_executor import _complex_rct_plan
    from test_extraction_lifecycle import protocol, study
    project = unattended(Project("unsupported specific method", output_dir=tmp_path))
    project.save_json("protocol.json", protocol())
    project.save_json("all_extractions.json", [study()], subdir="extraction")
    plan = _complex_rct_plan().model_copy(update={"execution_allowed": False, "blocking_reasons": ["unsupported covariance model"]})
    monkeypatch.setattr("new_meta.core.method_planning.admit_project_protocol", Mock(side_effect=MethodCapabilityBlockedError(plan, project)))
    monkeypatch.setattr(cli, "create_artifact_package", lambda project: project.base_dir / "package")
    with pytest.raises(SystemExit) as done:
        cli._admit_cli_protocol(project, protocol())
    assert done.value.code == 0
    assert "unsupported covariance model" in project.get_path("draft.md", subdir="manuscript").read_text()


@pytest.mark.parametrize("hyphen", ["\u2010", "\u2011", "\u2212"])
@pytest.mark.parametrize("verified_first", [False, True])
def test_trial_identity_uses_existing_source_normalization(tmp_path, monkeypatch, hyphen, verified_first):
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from test_primary_analysis_alignment import SOURCE, assessment_payload
    from endpoint_binding_fixture import bind_components
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    quote = "Registration " + "ChiCTR-INR-16010287".replace("-", hyphen) + "."
    source = SOURCE + "\n" + quote
    for index, study in enumerate(studies):
        assessment = assessment_payload(source_outcome=study.outcomes[0], contrast="match" if verified_first and index == 0 else "uncertain")
        assessment["verification"]["trial_units"][0].update(registry_id="ChiCTR-INR-16010287", quote=quote)
        assessment = bind_components(assessment, source)
        assert record_checked_alignments(project, protocol, study, [assessment], source_text=source,
                                         issue_histories={0: ([], True)}) == []
    project.save_json("all_extractions.json", studies, subdir="extraction")
    monkeypatch.setattr(BaseAgent, "call_llm_structured", _model_decisions(studies))
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert len(effects) == sum(row["in_final_primary_analysis"] for row in audit) == 1


@pytest.mark.parametrize("source_number", ["15", "5.8", "-5"])
def test_numeric_support_cannot_clip_a_larger_signed_or_decimal_token(tmp_path, monkeypatch, source_number):
    from new_meta.core.agent_base import BaseAgent
    from test_primary_analysis_alignment import SOURCE
    project, protocol, studies = _uncertain_pairwise(tmp_path)
    source = SOURCE.replace("5/100", source_number + "/100").replace("50%", "40%")
    project.save_json("parsed_papers.json", {sid: {"full_text": source} for sid in ("S1", "S2")}, subdir="papers")
    choose = _model_decisions(studies)
    def clipped(self, prompt, schema, **kwargs):
        response = choose(self, prompt, schema, **kwargs)
        judgment = response.rows[0]
        judgment.numeric_quotes = {field: source for field in judgment.numeric_quotes}
        if judgment.trial_id == "S1":
            judgment.numeric_quotes["events_intervention"] = "5"
        return response
    monkeypatch.setattr(BaseAgent, "call_llm_structured", clipped)
    effects, audit = PipelineRunner(project).compute_primary_effect_selection(protocol=protocol, extracted_studies=studies)
    assert [effect.study_id for effect in effects] == ["S2"]
    assert audit[0]["reason"] == "numeric_support_unavailable"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_partial_report_keeps_finite_evidence_when_one_numeric_value_is_unusable(tmp_path, value):
    from new_meta.core.partial_delivery import write_partial_report
    from test_extraction_lifecycle import study, protocol
    project = unattended(Project("unusable number", output_dir=tmp_path))
    row = study()
    row.outcomes[0].effect_size = value
    project.save_json("all_extractions.json", [row], subdir="extraction")
    project.save_json("protocol.json", protocol())
    phase = PhaseResult(run_id=project.base_dir.name, phase="synthesis", status="blocked",
                        summary="The effect estimate cannot be computed.", error_code="method_inputs_invalid",
                        issues=[PhaseIssue(code="invalid_number", message="Nonfinite estimate", blocking=True)])
    assert write_partial_report(project, phase)
    draft = project.get_path("draft.md", subdir="manuscript").read_text()
    assert "effect_size" in draft and "unusable" in draft
    assert "0.53" in draft
