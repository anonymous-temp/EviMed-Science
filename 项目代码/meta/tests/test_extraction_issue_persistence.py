"""Unresolved source defects survive checker silence, rebuilds, and review."""
import hashlib
import json

import pytest

from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
from new_meta.core.primary_analysis_alignment import (
    alignment_status, digest, ensure_review_context, recover_issue_history,
)
from new_meta.schemas.study import ExtractedStudy
from test_extraction_verification import SOURCE, checked_row, protocol, run_verifier, study


def issue(index=0, *, conflict=False):
    return {"outcome_index": index,
        "field": "hr_ci_upper" if conflict else "reported_effect_scale",
        "kind": "source_conflict" if conflict else "incorrect_metadata",
        "rationale": "The source contains conflicting values." if conflict else "The HR is an original-scale ratio.",
        "quote": "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).",
        "source_location": "Table 3"}


def response(*issues, count=1):
    return ExtractionCheckResult(score=10, data_issues=list(issues),
        primary_analysis_alignment=[checked_row(index) for index in range(count)])


def pending(tmp_path, monkeypatch, *, conflict=False):
    candidate = study()
    candidate.outcomes[0].reported_effect_scale = "log"
    return run_verifier(tmp_path, monkeypatch, [response(issue(conflict=conflict))] * 3,
                        candidate=candidate, repair=lambda _text, current, *_args: current)[:2]


def reverify(project, candidate, monkeypatch, *, current_protocol=None, parsed=None):
    path = project.base_dir / "papers/source.txt"
    current = path.read_text() if path.exists() else SOURCE
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_check_extraction", lambda *_args: response())
    monkeypatch.setattr(agent, "_refine_extraction", lambda _text, row, *_args: row)
    return agent._verify_alignment(candidate, {"fulltext_path": str(path)}, parsed or {
        "full_text": current, "_source_sha256": hashlib.sha256(current.encode()).hexdigest()},
        current_protocol or protocol(), project)


def persist(project, candidate, current_protocol=None):
    project.save_json("protocol.json", current_protocol or protocol())
    project.save_json("all_extractions.json", [candidate], subdir="extraction")


@pytest.mark.parametrize("repeat_conflict", [False, True])
def test_mixed_batch_repair_cannot_erase_another_rows_source_conflict(tmp_path, monkeypatch, repeat_conflict):
    candidate = study()
    candidate.outcomes.append(candidate.outcomes[0].model_copy(deep=True))
    candidate.outcomes[1].reported_effect_scale = "log"

    def repair(_text, current, _checked, _protocol, indices, _feedback):
        assert indices == [1]
        result = current.model_copy(deep=True)
        result.outcomes[1].reported_effect_scale = "original"
        return result

    project, result, calls = run_verifier(tmp_path, monkeypatch,
        [response(issue(conflict=True), issue(1), count=2),
         response(*([issue(conflict=True)] if repeat_conflict else []), count=2)], candidate=candidate, repair=repair)
    assert len(calls) == 2
    proof = result.outcomes[0].primary_analysis_alignment
    assert [entry.issue.kind for entry in proof.unresolved_data_issues] == ["source_conflict"]
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert result.outcomes[1].primary_analysis_alignment.unresolved_data_issues == []
    assert alignment_status(project, protocol(), result, 1)["status"] == "match"


@pytest.mark.parametrize("edit", ["none", "unrelated", "correct"])
def test_only_implicated_field_correction_plus_fresh_check_resolves_issue(tmp_path, monkeypatch, edit):
    project, candidate = pending(tmp_path, monkeypatch)
    origin = candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0]
    persist(project, candidate)
    candidate = ExtractedStudy.model_validate(project.load_json("all_extractions.json", subdir="extraction")[0])
    if edit == "unrelated":
        candidate.outcomes[0].source_location = "Results, Table 3"
    elif edit == "correct":
        candidate.outcomes[0].reported_effect_scale = "original"
    result = reverify(project, candidate, monkeypatch)
    status = alignment_status(project, protocol(), result, 0)
    assert status["status"] == ("match" if edit == "correct" else "unknown")
    history, available = recover_issue_history(project, result, 0)
    assert available
    if edit != "correct":
        assert history == [origin]


def test_human_dimension_review_cannot_erase_unchanged_metadata_issue(tmp_path, monkeypatch):
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    project, candidate = pending(tmp_path, monkeypatch)
    persist(project, candidate)
    versions = ensure_review_context(project, protocol(), candidate, 0)
    with pytest.raises(ValueError, match="row-data issues"):
        save_extraction_review_decision(project, ExtractionReviewDecision(
            row_id="trial-paper:0", resolves_conflicts=True, alignment_assessment=checked_row(),
            alignment_protocol_sha256=versions["protocol_sha256"],
            alignment_row_sha256=versions["row_sha256"], alignment_source_sha256=versions["source_sha256"],
        ), alignment_assessor_id="reviewer-a")
    assert alignment_status(project, protocol(), candidate, 0)["status"] == "unknown"


@pytest.mark.parametrize("change", ["row", "protocol", "source"])
def test_context_rebuild_preserves_original_issue_versions(tmp_path, monkeypatch, change):
    project, candidate = pending(tmp_path, monkeypatch, conflict=True)
    origin = candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0].model_copy(deep=True)
    current_protocol = protocol()
    source = project.base_dir / "papers/source.txt"
    if change == "row":
        candidate.outcomes[0].hr_ci_upper = 1.02
    elif change == "protocol":
        current_protocol.pico.population = "Adults with CKD"
    else:
        source.write_text(SOURCE + " A corrected source version is available.")
    project.save_json("parsed_papers.json", {"trial-paper": {
        "full_text": source.read_text(), "_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}, subdir="papers")
    project.save_json("pdf_download_results.json", [{"study_id": "trial-paper", "fulltext_path": str(source)}])
    status = ensure_review_context(project, current_protocol, candidate, 0)
    assert status["reason"] == "verification_data_issues_unresolved"
    assert candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues == [origin]
    if change == "source":
        assert status["source_sha256"] != origin.source_sha256


@pytest.mark.parametrize("damage", ["missing_artifact", "tampered_artifact", "tampered_payload", "missing_field"])
def test_unavailable_issue_provenance_cannot_be_reset_by_fresh_check(tmp_path, monkeypatch, damage):
    project, candidate = pending(tmp_path, monkeypatch)
    proof = candidate.outcomes[0].primary_analysis_alignment
    persist(project, candidate)
    path = project.base_dir / "extraction/primary_alignment" / f"{proof.proof_id}.json"
    if damage == "missing_artifact":
        path.unlink()
    elif damage == "tampered_artifact":
        data = json.loads(path.read_text()); data["unresolved_data_issues"] = []
        path.write_text(json.dumps(data))
    elif damage == "tampered_payload":
        proof.unresolved_data_issues.clear()
    else:
        candidate.outcomes[0].primary_analysis_alignment = None
    result = reverify(project, candidate, monkeypatch)
    assert alignment_status(project, protocol(), result, 0)["reason"] == "verification_issue_history_required"
    assert recover_issue_history(project, result, 0)[1] is False


@pytest.mark.parametrize("failure", ["source_limit", "source_read", "parser_version"])
def test_early_failures_retain_issue_history_and_revoke_previous_approval(tmp_path, monkeypatch, failure):
    project, candidate = pending(tmp_path, monkeypatch)
    origin = candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0]
    path = project.base_dir / "papers/source.txt"
    parsed = {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}
    if failure == "source_limit":
        parsed["full_text"] = SOURCE + "x" * 128_000
    elif failure == "source_read":
        path.unlink()
    else:
        parsed["_source_sha256"] = "0" * 64
    result = reverify(project, candidate, monkeypatch, parsed=parsed)
    assert recover_issue_history(project, result, 0) == ([origin], True)
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert result.outcomes[0].primary_analysis_alignment.assessor == "pending-review-v1"


def test_source_limit_cannot_leave_old_clean_approval_current(tmp_path, monkeypatch):
    project, candidate, _ = run_verifier(tmp_path, monkeypatch, [response()])
    assert alignment_status(project, protocol(), candidate, 0)["status"] == "match"
    result = reverify(project, candidate, monkeypatch, parsed={"full_text": SOURCE + "x" * 128_000,
        "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()})
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


def test_pending_issue_proof_blocks_compiled_and_cached_primary_analysis(tmp_path, monkeypatch):
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.core.primary_analysis_alignment import cached_alignment_is_current
    project, candidate = pending(tmp_path, monkeypatch)
    persist(project, candidate)
    phase = PipelineRunner(project).run_primary_effect_selection(protocol=protocol(), extracted_studies=[candidate])
    assert phase.status.value == "needs_input"
    assert not phase.data.get("effects")
    assert not cached_alignment_is_current(project)


def test_unresolved_issue_values_and_source_hashes_are_exact(tmp_path, monkeypatch):
    project, candidate = pending(tmp_path, monkeypatch)
    entry = candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0]
    assert entry.field_sha256 == digest("log")
    assert entry.source_sha256 == hashlib.sha256(SOURCE.encode()).hexdigest()
    assert entry.checked_source_sha256 == hashlib.sha256(SOURCE.encode()).hexdigest()


def test_interrupted_check_resumes_with_the_observed_issue_checkpoint(tmp_path, monkeypatch):
    from new_meta.core.project import Project
    project = Project("interrupted verifier", output_dir=tmp_path)
    path = project.base_dir / "papers/source.txt"
    path.write_text(SOURCE)
    candidate = study()
    candidate.outcomes[0].reported_effect_scale = "log"
    agent = DataExtractionAgent()
    calls = []

    def check(*_args):
        calls.append(True)
        if len(calls) == 1:
            return response(issue())
        raise KeyboardInterrupt

    monkeypatch.setattr(agent, "_check_extraction", check)
    monkeypatch.setattr(agent, "_refine_extraction", lambda _text, current, *_args: current)
    with pytest.raises(KeyboardInterrupt):
        agent._verify_alignment(candidate, {"fulltext_path": str(path)}, {
            "full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol(), project)
    resumed = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    assert resumed.outcomes[0].primary_analysis_alignment.unresolved_data_issues
    result = reverify(project, resumed, monkeypatch)
    assert alignment_status(project, protocol(), result, 0)["reason"] == "verification_data_issues_unresolved"


def test_reextraction_preserves_prior_source_conflict_origin(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import OutcomeList
    project, candidate = pending(tmp_path, monkeypatch, conflict=True)
    origin = candidate.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0]
    fresh = study()
    responses = iter([fresh.characteristics, OutcomeList(outcomes=fresh.outcomes)])
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "_extract_with_retry", lambda *_args: next(responses))
    result = agent._extract_single({"pmid": "trial-paper"}, {"full_text": SOURCE}, protocol(), project)
    assert result.outcomes[0].primary_analysis_alignment.unresolved_data_issues == [origin]
    assert result.outcomes[0].primary_analysis_alignment.assessor == "pending-review-v1"
