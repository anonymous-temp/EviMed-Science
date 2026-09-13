"""Pairwise synthesis must certify exact result-level RoB before GRADE/writing."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from new_meta.core.pairwise_result_rob import ensure_pairwise_result_rob, validated_pairwise_result_rob
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.primary_analysis_alignment import (
    PrimaryAlignmentRequired, digest, record_checked_alignments, save_pool_binding,
)
from new_meta.core.extraction_ledger import result_entity_id
from new_meta.core.result_rob import build_result_rob_drafts
from new_meta.core.rob_policy import resolve_rob_policy
from new_meta.engines.meta_engine import fixed_effect
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.risk_of_bias import RoBAssessmentStatus, RoBDomain, StudyRoB
from test_primary_analysis_alignment import SOURCE, assessment_payload, stamp_fixture


def prepared(tmp_path):
    project, protocol, first, source = stamp_fixture(tmp_path)
    second = first.model_copy(deep=True)
    second.characteristics.study_id = "S2"
    second.outcomes[0].events_intervention = 6
    second.outcomes[0].primary_analysis_alignment = None
    record_checked_alignments(project, protocol, second,
        [assessment_payload(source_outcome=second.outcomes[0], study_id="S2")],
        source_text=SOURCE, source_path=source)
    studies = [first, second]
    legacy = [StudyRoB(study_id=s.characteristics.study_id, tool_used="RoB 2", overall_judgment="Low risk") for s in studies]
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    project.save_json("rob_results.json", legacy, subdir="risk_of_bias")
    project.save_json("rob_result_assessments.json", build_result_rob_drafts(studies, legacy), subdir="risk_of_bias")
    phase = PipelineRunner(project).run_primary_effect_selection(
        protocol=protocol, extracted_studies=studies, rob_results=legacy)
    assert phase.status.value == "succeeded"
    meta = MetaAnalysisResults(primary_outcome=fixed_effect(phase.data["effects"], "RR", protocol.pico.outcome_primary))
    project.save_json("meta_results.json", meta, subdir="analysis")
    save_pool_binding(project, meta)
    return project, protocol, studies, legacy, meta


class Completor:
    def __init__(self, *, omit=False, pending=False, synthetic=False, duplicate=False):
        self.calls = []
        self.omit, self.pending, self.synthetic, self.duplicate = omit, pending, synthetic, duplicate

    def complete_result_level_assessments(self, **kwargs):
        self.calls.append(kwargs)
        policy = resolve_rob_policy(family="intervention_rct")
        records = build_result_rob_drafts(kwargs["extracted_studies"], kwargs["study_assessments"])
        selected = [item for item in records if item.result_id in kwargs["required_result_ids"]]
        complete = [item.model_copy(update={
            "assessment_status": RoBAssessmentStatus.DRAFT if self.pending else RoBAssessmentStatus.COMPLETE,
            "requires_adjudication": self.pending, "is_synthetic": self.synthetic,
            "tool_used": policy.tool_name, "tool_version": policy.tool_version,
            "target_effect": policy.target_effect, "assessment_origin": "llm_result_specific",
            "overall_judgment": "High risk",
            "domains": [RoBDomain(domain=name, judgment="High risk", support="Source-grounded fixture.",
                                   source_quote="Participants all had chronic kidney disease. Drug was compared with placebo.",
                                   source_section="Methods")
                        for name in policy.domain_names],
        }) for item in selected]
        if self.omit:
            complete = complete[:-1]
        if self.duplicate:
            complete.append(complete[0])
        kwargs["project"].save_json("rob_result_assessments.json", complete, subdir="risk_of_bias")
        kwargs["project"].save_json("rob_result_source_observations.json", [], subdir="risk_of_bias")
        return complete


def complete(project, protocol, studies, legacy, meta, agent):
    return ensure_pairwise_result_rob(project, protocol=protocol, meta_results=meta,
        extracted_studies=studies, study_assessments=legacy, agent_factory=lambda: agent)


def test_fresh_completion_refreshes_only_unchanged_selection_and_reuses_bound_high(tmp_path):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    before = project.load_json("primary_alignment_selection.json", subdir="analysis")
    agent = Completor()
    records = complete(project, protocol, studies, legacy, meta, agent)
    assert len(records) == 2 and all(item.overall_judgment == "High risk" for item in records)
    assert len(agent.calls) == 1
    assert agent.calls[0]["required_result_ids"] == [result_entity_id(study, 0) for study in studies]
    assert agent.calls[0]["study_assessments"] == []
    assert all(item["full_text"] == SOURCE for item in agent.calls[0]["parsed_papers"].values())
    after = project.load_json("primary_alignment_selection.json", subdir="analysis")
    assert before["selection_gate_sha256"] != after["selection_gate_sha256"]
    assert {k: v for k, v in before.items() if k != "selection_gate_sha256"} == {
        k: v for k, v in after.items() if k != "selection_gate_sha256"}
    assert project.load_json("primary_alignment_pool.json", subdir="analysis")["selection_sha256"] == digest(after)
    assert complete(project, protocol, studies, legacy, meta, agent) == records
    assert validated_pairwise_result_rob(project, protocol=protocol, meta_results=meta, extracted_studies=studies) == records
    assert len(agent.calls) == 1
    assert all(item.overall_judgment == "Low risk" for item in legacy)


@pytest.mark.parametrize("mode", ["omit", "pending", "synthetic", "duplicate"])
def test_incomplete_result_records_block_before_receipt_and_preserve_saved_observations(tmp_path, mode):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, Completor(**{mode: True}))
    assert not project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").exists()
    assert project.get_path("rob_result_assessments.json", subdir="risk_of_bias").exists()


@pytest.mark.parametrize("damage", ["source", "row", "protocol", "meta", "receipt", "observations", "rob"])
def test_stale_state_blocks_before_any_more_model_calls(tmp_path, damage):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    agent = Completor()
    complete(project, protocol, studies, legacy, meta, agent)
    if damage == "source":
        (project.base_dir / "papers" / "trial.txt").write_text(SOURCE + " changed")
    elif damage == "row":
        studies[0].outcomes[0].events_intervention = 9
    elif damage == "protocol":
        protocol.pico.population = "Different population"
    elif damage == "meta":
        meta.primary_outcome.pooled_effect = 0.123
    else:
        filename = {"receipt": "pairwise_result_rob_receipt.json", "observations": "rob_result_source_observations.json",
                    "rob": "rob_result_assessments.json"}[damage]
        project.save_json(filename, {}, subdir="risk_of_bias")
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, agent)
    assert len(agent.calls) == 1


def test_unbound_complete_high_is_not_rejudged_or_replaced(tmp_path):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    agent = Completor()
    complete(project, protocol, studies, legacy, meta, agent)
    project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").unlink()
    before = project.get_path("rob_result_assessments.json", subdir="risk_of_bias").read_bytes()
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, agent)
    assert project.get_path("rob_result_assessments.json", subdir="risk_of_bias").read_bytes() == before
    assert len(agent.calls) == 1


def test_unavailable_ancillary_statistics_keep_existing_pool_serialization(tmp_path):
    from new_meta.schemas.meta_result import PublicationBiasResult
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    meta.publication_bias = PublicationBiasResult(egger_p_value=float("nan"))
    project.save_json("meta_results.json", meta, subdir="analysis")
    save_pool_binding(project, meta)
    assert len(complete(project, protocol, studies, legacy, meta, Completor())) == 2


def test_selector_change_after_completion_does_not_rebind_previous_pool(tmp_path, monkeypatch):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    before_pool = project.load_json("primary_alignment_pool.json", subdir="analysis")
    original = PipelineRunner.run_primary_effect_selection

    def changed(self, **kwargs):
        result = original(self, **kwargs)
        result.data["effects"][0].yi = -2.0
        return result

    monkeypatch.setattr(PipelineRunner, "run_primary_effect_selection", changed)
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, Completor())
    assert project.load_json("primary_alignment_pool.json", subdir="analysis") == before_pool
    assert not project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").exists()


def test_pool_binding_alone_cannot_certify_different_contributor_numbers(tmp_path):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    meta.primary_outcome.studies[0].yi = -2.0
    project.save_json("meta_results.json", meta, subdir="analysis")
    save_pool_binding(project, meta)
    agent = Completor()
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, agent)
    assert agent.calls == []


def test_pending_source_observation_blocks_before_model_and_preserves_bytes(tmp_path):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    pending = [{"input_hash": "a" * 64, "study_id": "S1", "target_result": "fixture target",
                "tool_version": "RoB 2 v2 (2019)", "status": "pending",
                "raw_responses": [], "high_risk_domains": []}]
    project.save_json("rob_result_source_observations.json", pending, subdir="risk_of_bias")
    path = project.get_path("rob_result_source_observations.json", subdir="risk_of_bias")
    original = path.read_bytes()
    agent = Completor()
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, agent)
    assert agent.calls == []
    assert path.read_bytes() == original


def test_grounded_legacy_low_about_another_endpoint_cannot_be_promoted_to_selected_result(tmp_path, monkeypatch):
    from new_meta.agents.rob_agent import RoBAgent
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    policy = resolve_rob_policy(family="intervention_rct")
    quote = "Participants all had chronic kidney disease. Drug was compared with placebo."
    for item in legacy:
        item.domains = [RoBDomain(domain=name, judgment="Low risk",
            support="This study-level judgment concerns a different follow-up endpoint.",
            source_quote=quote, source_section="Methods") for name in policy.domain_names]
    assert RoBAgent._grounded_study_rob(legacy[0], SOURCE) is not None
    project.save_json("rob_results.json", legacy, subdir="risk_of_bias")
    PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=studies, rob_results=legacy)
    save_pool_binding(project, meta)
    legacy_path = project.get_path("rob_results.json", subdir="risk_of_bias")
    original = legacy_path.read_bytes()
    targeted = []

    def assess(self, *, study, outcome, full_text, rob_policy, project):
        targeted.append((study.characteristics.study_id, outcome.outcome_name))
        return StudyRoB(study_id=study.characteristics.study_id, tool_used=rob_policy.tool_name,
            overall_judgment="High risk", domains=[RoBDomain(domain=name, judgment="High risk",
                support="The target-specific assessment identifies a bias concern.", source_quote=quote,
                source_section="Methods") for name in rob_policy.domain_names])

    monkeypatch.setattr(RoBAgent, "_assess_result_specific_rob", assess)
    records = complete(project, protocol, studies, legacy, meta, RoBAgent())
    assert targeted == [(study.characteristics.study_id, study.outcomes[0].outcome_name) for study in studies]
    assert all(item.overall_judgment == "High risk" for item in records)
    assert all(item.assessment_origin == "llm_result_specific" for item in records)
    assert legacy_path.read_bytes() == original


@pytest.mark.parametrize("damage", ["study", "outcome", "quote", "domains"])
def test_formal_looking_records_still_require_exact_target_and_source_domains(tmp_path, damage):
    project, protocol, studies, legacy, meta = prepared(tmp_path)

    class WrongTarget(Completor):
        def complete_result_level_assessments(self, **kwargs):
            records = super().complete_result_level_assessments(**kwargs)
            if damage == "study":
                records[0].study_id = "different-study"
            elif damage == "outcome":
                records[0].outcome_name = "Different secondary outcome"
            elif damage == "quote":
                records[0].domains[0].source_quote = "This quotation is absent from the report."
            else:
                records[0].domains[1].domain = records[0].domains[0].domain
            project.save_json("rob_result_assessments.json", records, subdir="risk_of_bias")
            return records

    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, WrongTarget())
    assert not project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").exists()


def test_unbound_adjudicated_high_is_not_rejudged_or_replaced(tmp_path):
    from new_meta.core.result_rob import save_result_rob_adjudication
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    agent = Completor()
    records = complete(project, protocol, studies, legacy, meta, agent)
    adjudicated = records[0].model_copy(update={"assessment_status": RoBAssessmentStatus.ADJUDICATED,
                                               "adjudicated_by": "source-reviewer"})
    save_result_rob_adjudication(project, adjudicated, expected_revision=0, reason="Reviewed exact source result.")
    PipelineRunner(project).run_primary_effect_selection(protocol=protocol, extracted_studies=studies, rob_results=legacy)
    save_pool_binding(project, meta)
    project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").unlink()
    path = project.get_path("rob_result_assessments.json", subdir="risk_of_bias")
    original = path.read_bytes()
    with pytest.raises(PrimaryAlignmentRequired):
        complete(project, protocol, studies, legacy, meta, agent)
    assert path.read_bytes() == original
    assert len(agent.calls) == 1


def patch_grade_and_plot(monkeypatch, agent):
    import new_meta.main as main
    from new_meta.schemas.grade import GRADEProfile
    captured = {"grade": [], "plot": []}
    monkeypatch.setattr(main, "RoBAgent", lambda **_kwargs: agent)

    class Grade:
        def __init__(self, **kwargs):
            pass

        def run(self, **kwargs):
            captured["grade"].append(kwargs)
            return GRADEProfile(outcomes=[])

    def plot(summary, path, **kwargs):
        captured["plot"].append(summary)
        Path(path).write_bytes(b"completed-high-risk-figure")

    monkeypatch.setattr(main, "GRADEAgent", Grade)
    monkeypatch.setattr(main.visualization, "rob_summary_plot", plot)
    return main, captured


def test_grade_cache_still_checks_current_result_rob_and_refreshes_stale_low_plot(tmp_path, monkeypatch):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    agent = Completor()
    main, captured = patch_grade_and_plot(monkeypatch, agent)
    kwargs = dict(protocol=protocol, meta_results=meta, rob_results=legacy, extracted_studies=studies)
    main._run_grade_from_cached_meta(project, None, **kwargs)
    assert all(row.overall_judgment == "High risk" for row in captured["grade"][0]["rob_results"])
    assert len(captured["grade"][0]["rob_results"]) == 2
    (project.base_dir / "figures" / "rob_summary.png").write_bytes(b"stale-low-risk-figure")
    main._run_grade_from_cached_meta(project, None, **kwargs)
    assert len(agent.calls) == 1 and len(captured["grade"]) == 1
    assert (project.base_dir / "figures" / "rob_summary.png").read_bytes() == b"completed-high-risk-figure"
    assert all(row["overall"] == "High risk" for row in captured["plot"][-1])
    project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").unlink()
    from new_meta.core.release_contract import ReleaseBlockedError
    with pytest.raises(ReleaseBlockedError):
        main._run_grade_from_cached_meta(project, None, **kwargs)
    assert len(captured["grade"]) == 1
    assert project.load_json("primary_alignment_status.json", subdir="analysis")["status"] == "needs_input"


@pytest.mark.parametrize("route", ["_resume_from_cached_meta_analysis", "_resume_from_cached_effect_sizes", "_resume_direct_to_manuscript"])
def test_all_cached_routes_complete_selected_rob_before_grade_and_writer(tmp_path, monkeypatch, route):
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    main, captured = patch_grade_and_plot(monkeypatch, Completor())
    monkeypatch.setattr(main, "_load_cached_resume_inputs", lambda *_args: (protocol, "query", studies, legacy, [], {}, "en"))
    monkeypatch.setattr(main, "_ensure_cached_model_artifacts", lambda *_args: meta)
    monkeypatch.setattr(main, "_run_meta_analysis_from_effects", lambda *_args, **_kwargs: meta)
    monkeypatch.setattr(main, "_generate_figures_from_cached_meta", lambda *_args, **_kwargs: None)
    for name in ("_add_benchmark_references", "_add_evidence_context_references", "_add_methodology_references",
                 "_run_final_manuscript_llm_readiness_review", "_finalize_cli_release"):
        monkeypatch.setattr(main, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "_evaluate_evidence_gate_for_report", lambda *_args: (SimpleNamespace(evidence_classes=[]), {}))
    monkeypatch.setattr(main, "ensure_review_positioning", lambda **_kwargs: {"category": "fixture"})
    monkeypatch.setattr(main, "_polish_project_manuscript", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "create_artifact_package", lambda *_args: "fixture-package")

    class Writer:
        def __init__(self, **kwargs):
            pass

        def run(self, **kwargs):
            captured["writer"] = kwargs
            return "verified manuscript"

    monkeypatch.setattr(main, "WritingAgent", Writer)
    result = getattr(main, route)(project, SimpleNamespace(topic="fixture"), None)
    assert result == "verified manuscript"
    assert len(captured["writer"]["rob_results"]) == 2
    assert all(row.overall_judgment == "High risk" for row in captured["writer"]["rob_results"])
    assert len(captured["plot"]) == 1


def test_fresh_and_cached_writer_share_the_validated_result_only_boundary(tmp_path, monkeypatch):
    import inspect
    import new_meta.main as main
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    complete(project, protocol, studies, legacy, meta, Completor())
    captured = {}
    writer = SimpleNamespace(run=lambda **kwargs: captured.update(kwargs) or "written")
    assert main._run_verified_pairwise_writer(writer, project=project, protocol=protocol,
        meta_results=meta, extracted_studies=studies, rob_results=legacy) == "written"
    assert all(item.overall_judgment == "High risk" for item in captured["rob_results"])
    assert "_run_verified_pairwise_writer(writer," in inspect.getsource(main.main)
    assert "_run_verified_pairwise_writer(writer," in inspect.getsource(main._write_manuscript_from_artifacts)


@pytest.mark.parametrize("existing", ["complete", "adjudicated", "receipt", "corrupt", "null_records", "null_receipt"])
@pytest.mark.parametrize("clear_downstream", [False, True])
def test_forced_study_refresh_cannot_overwrite_result_history(tmp_path, monkeypatch, existing, clear_downstream):
    import new_meta.main as main
    from new_meta.core.release_contract import ReleaseBlockedError
    from new_meta.core.result_rob import save_result_rob_adjudication
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    records = complete(project, protocol, studies, legacy, meta, Completor())
    if existing == "adjudicated":
        adjudicated = records[0].model_copy(update={"assessment_status": RoBAssessmentStatus.ADJUDICATED,
                                                   "adjudicated_by": "source-reviewer"})
        save_result_rob_adjudication(project, adjudicated, expected_revision=0, reason="Preserve reviewed High risk.")
    elif existing == "receipt":
        project.save_json("rob_result_assessments.json", build_result_rob_drafts(studies, legacy), subdir="risk_of_bias")
    elif existing == "corrupt":
        project.get_path("rob_result_assessments.json", subdir="risk_of_bias").write_text("{corrupt history")
    elif existing == "null_records":
        project.get_path("rob_result_assessments.json", subdir="risk_of_bias").write_text("null")
        project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").unlink()
    elif existing == "null_receipt":
        project.save_json("rob_result_assessments.json", build_result_rob_drafts(studies, legacy), subdir="risk_of_bias")
        project.get_path("pairwise_result_rob_receipt.json", subdir="risk_of_bias").write_text("null")
    project.save_json("rob_result_source_observations.json", [{"historical_high_risk_observation": "preserve"}], subdir="risk_of_bias")
    before = {path.name: path.read_bytes() for path in (project.base_dir / "risk_of_bias").glob("*.json")}
    monkeypatch.setattr(main, "RoBAgent", lambda **_kwargs: pytest.fail("Study model must not be constructed"))
    monkeypatch.setattr(project, "clear_downstream", lambda *_args, **_kwargs: pytest.fail("History must not be cleared"))
    with pytest.raises(ReleaseBlockedError):
        main._run_study_rob_refresh(project, None, studies, {}, clear_downstream=clear_downstream)
    assert {path.name: path.read_bytes() for path in (project.base_dir / "risk_of_bias").glob("*.json")} == before
    assert project.load_json("primary_alignment_status.json", subdir="analysis")["status"] == "needs_input"


def test_fresh_study_refresh_is_allowed_without_completed_history(tmp_path, monkeypatch):
    import inspect
    import new_meta.main as main
    from new_meta.core.project import Project
    project = Project("Fresh study RoB", output_dir=tmp_path)
    calls = []
    monkeypatch.setattr(main, "RoBAgent", lambda **_kwargs: SimpleNamespace(
        run=lambda *args: calls.append(args) or []))
    assert main._run_study_rob_refresh(project, None, [], {}) == []
    assert len(calls) == 1
    assert inspect.getsource(main.main).count("_run_study_rob_refresh(") == 2


def test_protected_result_history_remains_usable_on_cached_path(tmp_path):
    from new_meta.core.pairwise_result_rob import require_study_rob_refresh_safe
    project, protocol, studies, legacy, meta = prepared(tmp_path)
    records = complete(project, protocol, studies, legacy, meta, Completor())
    with pytest.raises(PrimaryAlignmentRequired):
        require_study_rob_refresh_safe(project)
    assert validated_pairwise_result_rob(project, protocol=protocol, meta_results=meta, extracted_studies=studies) == records
