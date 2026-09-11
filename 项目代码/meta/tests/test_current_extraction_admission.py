"""Current per-study verification controls every synthesis entry point."""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.primary_analysis_alignment import (
    PrimaryAlignmentRequired, alignment_status, cached_alignment_is_current,
    recover_issue_history, require_current_compiled_alignment,
)
from new_meta.schemas.study import ExtractedStudy
from test_primary_analysis_alignment import stamp_fixture


def observe_conflict(project, protocol, candidate, monkeypatch, *, interrupt=False):
    proof = candidate.outcomes[0].primary_analysis_alignment
    content = (project.base_dir / proof.checked_source_path).read_text()
    source = project.base_dir / proof.source_path
    assessment = proof.assessment.model_copy(deep=True)
    finding = assessment.verification.numeric_findings[0]
    defect = {"outcome_index": 0, "field": finding.field, "kind": "source_conflict",
              "rationale": "The current source contains unresolved conflicting values.",
              "quote": finding.quote, "source_location": finding.source_location}
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_check_extraction", lambda *_args: ExtractionCheckResult(
        score=10, data_issues=[defect], primary_analysis_alignment=[assessment]))
    if interrupt:
        import new_meta.core.primary_analysis_alignment as alignment
        original = alignment._write_scoped_once

        def interrupted(project_arg, path, payload):
            if path.startswith("extraction/verification/"):
                raise KeyboardInterrupt
            return original(project_arg, path, payload)

        monkeypatch.setattr(alignment, "_write_scoped_once", interrupted)
    return agent._verify_alignment(candidate, {"fulltext_path": str(source)}, {
        "full_text": content, "_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}, protocol, project)


def reload_aggregate(project):
    return [ExtractedStudy.model_validate(item) for item in project.load_json("all_extractions.json", subdir="extraction")]


@pytest.mark.parametrize("interrupt", [False, True])
def test_stale_aggregate_cannot_bypass_current_pending_checkpoint(tmp_path, monkeypatch, interrupt):
    from new_meta.schemas.risk_of_bias import StudyRoB
    project, protocol, candidate, _ = stamp_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [candidate], subdir="extraction")
    rob = [StudyRoB(study_id="S1", overall_judgment="Low risk", tool_used="RoB 2")]
    ready = PipelineRunner(project).run_primary_effect_selection(
        protocol=protocol, extracted_studies=[candidate], rob_results=rob)
    assert ready.status.value == "succeeded" and cached_alignment_is_current(project)
    aggregate_before = project.get_path("all_extractions.json", subdir="extraction").read_bytes()
    if interrupt:
        with pytest.raises(KeyboardInterrupt):
            observe_conflict(project, protocol, candidate, monkeypatch, interrupt=True)
    else:
        observe_conflict(project, protocol, candidate, monkeypatch)
    assert project.get_path("all_extractions.json", subdir="extraction").read_bytes() == aggregate_before
    assert not cached_alignment_is_current(project)
    # No held mutable candidate is needed: loading only the old aggregate must
    # still consult the authoritative, newer individual checkpoint.
    stale = reload_aggregate(project)
    assert alignment_status(project, protocol, stale[0], 0)["reason"] == "current_extraction_checkpoint_changed"
    issues, complete = recover_issue_history(project, stale[0], 0)
    assert complete and len(issues) == 1 and issues[0].issue.kind == "source_conflict"
    blocked = PipelineRunner(project).run_primary_effect_selection(
        protocol=protocol, extracted_studies=stale, rob_results=rob)
    assert blocked.status.value == "needs_input" and not blocked.data.get("effects")


@pytest.mark.parametrize("damage", ["delete", "tamper"])
def test_current_checkpoint_is_required_even_for_a_valid_immutable_proof(tmp_path, damage):
    project, protocol, candidate, _ = stamp_fixture(tmp_path)
    path = project.base_dir / candidate.outcomes[0].primary_analysis_alignment.current_checkpoint_path
    if damage == "delete":
        path.unlink()
    else:
        path.write_text('{"outcomes": []}')
    assert alignment_status(project, protocol, candidate, 0)["reason"] == "current_extraction_checkpoint_required"
    assert recover_issue_history(project, candidate, 0)[1] is False


def test_stale_human_alignment_review_cannot_replace_a_newer_pending_issue(tmp_path, monkeypatch):
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    from new_meta.core.primary_analysis_alignment import ensure_review_context
    project, protocol, candidate, _ = stamp_fixture(tmp_path)
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [candidate], subdir="extraction")
    assessment = candidate.outcomes[0].primary_analysis_alignment.assessment
    observe_conflict(project, protocol, candidate, monkeypatch)
    stale = reload_aggregate(project)[0]
    version = ensure_review_context(project, protocol, stale, 0)
    project.save_json("all_extractions.json", [stale], subdir="extraction")
    assert version["reason"] == "verification_data_issues_unresolved"
    with pytest.raises(ValueError, match="row-data issues"):
        save_extraction_review_decision(project, ExtractionReviewDecision(
            row_id="S1:0", alignment_assessment=assessment, resolves_conflicts=True,
            alignment_protocol_sha256=version["protocol_sha256"], alignment_row_sha256=version["row_sha256"],
            alignment_source_sha256=version["source_sha256"]), alignment_assessor_id="reviewer-a")


@pytest.mark.parametrize("sync_aggregate", [False, True])
def test_authenticated_method_execution_and_compiled_cache_require_current_verification(tmp_path, monkeypatch, sync_aggregate):
    from new_meta.api import create_api_router
    from test_complex_rct_delivery import _prepared_project
    project, protocol, studies, _, _, phase = _prepared_project(tmp_path)
    assert phase.status.value == "succeeded"
    require_current_compiled_alignment(project)
    app = FastAPI()
    app.include_router(create_api_router(tmp_path))
    monkeypatch.setenv("METAAGENT_API_TOKEN", "synthetic-review-token")
    client = TestClient(app)
    request = {"project_dir": str(project.base_dir),
               "result_ids": project.load_json("method_result.json", subdir="analysis")["input_result_ids"]}
    headers = {"Authorization": "Bearer synthetic-review-token"}
    assert client.post("/api/v1/projects/method-executions", headers=headers, json=request).status_code == 200
    observe_conflict(project, protocol, studies[0], monkeypatch)
    if sync_aggregate:
        project.save_json("all_extractions.json", studies, subdir="extraction")
    with pytest.raises(PrimaryAlignmentRequired):
        require_current_compiled_alignment(project)
    blocked = client.post("/api/v1/projects/method-executions", headers=headers, json=request)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["status"] == "needs_input"
    assert "payload" not in blocked.json()
    assert PipelineRunner(project).run_compiled_method_synthesis().status.value == "needs_input"


def test_method_executor_rechecks_current_verification_before_publishing(tmp_path, monkeypatch):
    from new_meta.core.method_executor import MethodExecutor
    from test_complex_rct_delivery import _prepared_project
    project, protocol, studies, _, plan, _ = _prepared_project(tmp_path)
    result_ids = project.load_json("method_result.json", subdir="analysis")["input_result_ids"]
    result_path = project.get_path("method_result.json", subdir="analysis")
    before = result_path.read_bytes()
    executor = MethodExecutor()
    execute = executor.execute

    def concurrent_update(*args, **kwargs):
        result = execute(*args, **kwargs)
        observe_conflict(project, protocol, studies[0], monkeypatch)
        return result

    monkeypatch.setattr(executor, "execute", concurrent_update)
    with pytest.raises(PrimaryAlignmentRequired):
        executor.execute_project(plan, project=project, result_ids=result_ids)
    assert result_path.read_bytes() == before


@pytest.mark.parametrize("field,value", [("effect_size", 0.9), ("ci_upper", 1.1)])
def test_freshly_verified_correction_requires_explicit_ledger_refresh(tmp_path, monkeypatch, field, value):
    from new_meta.api import create_api_router
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    from test_complex_rct_delivery import _prepared_project
    project, protocol, studies, _, _, _ = _prepared_project(tmp_path)
    app = FastAPI(); app.include_router(create_api_router(tmp_path))
    monkeypatch.setenv("METAAGENT_API_TOKEN", "synthetic-review-token")
    client = TestClient(app)
    request = {"project_dir": str(project.base_dir),
        "result_ids": project.load_json("method_result.json", subdir="analysis")["input_result_ids"]}
    headers = {"Authorization": "Bearer synthetic-review-token"}
    candidate = studies[0]
    proof = candidate.outcomes[0].primary_analysis_alignment
    old_value = getattr(candidate.outcomes[0], field)
    content = (project.base_dir / proof.checked_source_path).read_text().replace(str(old_value), str(value))
    corrected_source = project.base_dir / "papers/corrected-C1.txt"
    corrected_source.write_text(content)
    assessment = proof.assessment.model_copy(deep=True)
    setattr(candidate.outcomes[0], field, value)
    candidate.outcomes[0].source_quote = candidate.outcomes[0].source_quote.replace(str(old_value), str(value))
    for finding in assessment.verification.numeric_findings:
        finding.quote = finding.quote.replace(str(old_value), str(value))
        if finding.field == field:
            finding.reported_value = value
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_check_extraction", lambda *_args: ExtractionCheckResult(
        score=10, data_issues=[], primary_analysis_alignment=[assessment]))
    studies[0] = agent._verify_alignment(candidate, {"fulltext_path": str(corrected_source)}, {
        "full_text": content, "_source_sha256": hashlib.sha256(content.encode()).hexdigest()}, protocol, project)
    assert alignment_status(project, protocol, studies[0], 0)["status"] == "match"
    project.save_json("all_extractions.json", studies, subdir="extraction")
    ledger_path = project.get_path("ledger.jsonl", subdir="evidence")
    result_path = project.get_path("method_result.json", subdir="analysis")
    old_ledger, old_result = ledger_path.read_bytes(), result_path.read_bytes()
    blocked = client.post("/api/v1/projects/method-executions", headers=headers, json=request)
    assert blocked.status_code == 409
    assert "Refresh the evidence ledger" in blocked.json()["detail"]["summary"]
    assert ledger_path.read_bytes() == old_ledger and result_path.read_bytes() == old_result
    # Explicitly use the existing producer. The executor never updates source
    # entities or rewrites an analysis choice on its own.
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    accepted = client.post("/api/v1/projects/method-executions", headers=headers, json=request)
    assert accepted.status_code == 200
    inputs = project.load_json("method_input_audit.json", subdir="analysis")["inputs"]
    corrected = next(item for item in inputs if item["result_id"] == request["result_ids"][0])
    assert corrected["estimate"]["estimate" if field == "effect_size" else field] == value
    assert corrected["entity_version"] >= 2


def test_ledger_binding_still_compares_actual_typed_materialization(tmp_path):
    from new_meta.core.evidence_ledger import EvidenceLedger
    from new_meta.core.extraction_ledger import current_extraction_matches_result, extraction_result_binding
    from new_meta.schemas.evidence_ledger import ResultEntity
    from test_complex_rct_delivery import _prepared_project
    project, protocol, studies, _, plan, _ = _prepared_project(tmp_path)
    result_id = project.load_json("method_result.json", subdir="analysis")["input_result_ids"][0]
    ledger = EvidenceLedger(project.get_path("ledger.jsonl", subdir="evidence"), review_id=plan.review_id)
    entity = ledger.current(result_id, model=ResultEntity)
    assert current_extraction_matches_result(studies[0], 0, protocol, entity)
    entity.estimate.estimate = 0.9
    entity.derivation["extraction_binding"] = extraction_result_binding(studies[0], 0, protocol, entity)
    assert not current_extraction_matches_result(studies[0], 0, protocol, entity)
