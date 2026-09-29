"""Only a few reader-protecting checks can block a package; nothing reruns on a finding.

Owner complaint of 2026-09-29: MetaAgent was always stopped by its own release
gate and rerun. Measured on 27 real packages before the tier table: 26 blocked,
0 ready; the blockers were style heuristics, bookkeeping and completeness a
reader can see. These tests hold the class fix: one tier table, advisory by
default, and no path that runs the job or the writer again because of one.
"""
from __future__ import annotations

import inspect
import json

import new_meta.main as main_module
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package_submission import (
    _reference_resolution_gate,
    build_submission_readiness_review,
)
from new_meta.core.project import Project
from new_meta.core.release_contract import build_release_decision
from new_meta.core.release_tiers import (
    ADVISORY,
    BLOCKING,
    BLOCKING_GATES,
    NO_MANUSCRIPT_CODE,
    apply_release_tiers,
    gate_tier,
)

_DRAFT = "\n".join([
    "# Tranexamic acid in knee arthroplasty",
    "## Results",
    "Pooled MD -251.06 (95% CI -345.34 to -156.77) across 2 trials ［1］［2］.",
    "## References",
    "［1］ Trial one.",
    "［2］ Trial two.",
    "",
])
_POOLED_MANUSCRIPT = {
    "included": True, "markdown": True, "docx": True, "pdf": True,
    "requires_publication_length_gate": True, "report_type": "meta",
}
_CALCULATION = {"summary": {
    "row_count": 2, "n_studies": 2, "source_rows_matched": 2, "source_quote_verified_rows": 2,
    "formula_inputs_complete_rows": 2, "effect_measure": "MD",
}}


def _readiness(project: Project, draft: str, **audits):
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json("manuscript_validation.json", {"passed": True, "issues": []}, subdir="manuscript")
    names = [name for name in inspect.signature(build_submission_readiness_review).parameters
             if name not in {"project", "manuscript"}]
    return build_submission_readiness_review(
        project, manuscript=dict(_POOLED_MANUSCRIPT), **{name: audits.get(name) for name in names})


def test_the_tier_table_names_at_most_six_blocking_checks_and_defaults_to_advisory(tmp_path) -> None:
    assert set(BLOCKING_GATES) == {"calculation_audit", "primary_result", "reference_resolution"}
    assert len(BLOCKING_GATES) + 1 <= 6  # plus the decision-level "no manuscript" blocker
    assert NO_MANUSCRIPT_CODE == "missing_submission_readiness_review"
    assert gate_tier("a_gate_nobody_named") == ADVISORY

    readiness = _readiness(Project("tier walk", output_dir=tmp_path), _DRAFT)
    emitted = {gate["id"] for gate in readiness["gates"]}
    assert len(emitted) >= 25, "the walk must see the whole gate list"  # proves it walked
    assert BLOCKING_GATES.keys() <= emitted
    for gate in readiness["gates"]:
        assert gate["tier"] == (BLOCKING if gate["id"] in BLOCKING_GATES else ADVISORY), gate["id"]


def test_style_and_bookkeeping_failures_never_block_and_keep_their_findings() -> None:
    advisory_failures = [
        "readability", "manuscript_language", "publication_tone", "abstract_polish",
        "clinical_interpretation", "declarations", "citation_coverage", "claim_support",
        "project_submission_quality_gate", "manuscript_validation", "risk_of_bias_completeness",
        "evidence_readiness", "primary_source_context", "compiled_method_release", "manuscript_formats",
    ]
    readiness = {"status": "blocked", "gates": [
        {"id": gate_id, "status": "fail", "detail": f"{gate_id} detail",
         "locations": [{"code": f"{gate_id}_issue", "excerpt": "where it was found"}]}
        for gate_id in advisory_failures
    ]}

    decision = build_release_decision(readiness)

    assert decision["status"] == "ready_with_warnings"
    assert decision["blocker_codes"] == []
    assert decision["warning_codes"] == advisory_failures
    assert decision["deliverable"] is True and decision["ready_for_submission"] is True
    for gate in decision["warning_gates"]:
        assert gate["check_status"] == "fail" and gate["status"] == "warn" and gate["tier"] == ADVISORY
        assert gate["detail"] == f"{gate['id']} detail"
        assert gate["locations"][0]["excerpt"] == "where it was found"
    assert readiness["gates"][0]["status"] == "fail", "the caller's readiness is not mutated"


def test_the_measured_single_sentence_block_is_advisory() -> None:
    """ma-001 production replay, 2026-09-29: one 138-unit sentence blocked the release."""
    saved = {"status": "blocked", "gates": [
        {"id": "readability", "status": "fail",
         "detail": "scanned_sections=6; scanned_words=4382; overlong_sentences=1; failed_issues=1."},
        {"id": "project_submission_quality_gate", "status": "warn", "detail": "status=warn"},
        {"id": "citation_coverage", "status": "warn", "detail": "publication_min_references=14"},
        {"id": "benchmark", "status": "warn", "detail": "No benchmark attached."},
        {"id": "primary_result", "status": "pass", "detail": "matched_fields=4"},
        {"id": "calculation_audit", "status": "pass", "detail": "rows=2"},
    ]}
    assert build_release_decision(saved)["status"] == "ready_with_warnings"


def test_an_unresolved_citation_number_blocks() -> None:
    gate = _reference_resolution_gate(_DRAFT.replace("［1］［2］.", "［1］［3］."), pooled_review=True)
    assert gate["status"] == "fail"
    assert gate["locations"] == [{"code": "citation_number_unresolved", "citation_number": 3}]

    decision = build_release_decision({"gates": [gate]})

    assert decision["status"] == "blocked"
    assert decision["blocker_codes"] == ["reference_resolution"]
    assert "citation number" in decision["summary"]
    assert decision["deliverable"] is True  # delivered as unverified, not withheld


def test_a_pooled_review_with_an_empty_reference_list_blocks() -> None:
    """The 2026-09-28 production stub: a pooled review whose text had no reference list."""
    stub = "# Manuscript Validation Blocked\n\nPooled MD -251.06 (95% CI -345.34 to -156.77).\n"
    assert _reference_resolution_gate(stub, pooled_review=True)["status"] == "fail"
    assert _reference_resolution_gate(stub, pooled_review=False)["status"] == "pass"  # an evidence gap may cite nothing


def test_a_pooled_result_the_manuscript_contradicts_blocks(tmp_path) -> None:
    from new_meta.core.artifact_package import _build_primary_result_audit_review

    project = Project("number contradiction", output_dir=tmp_path)
    contradicting = _DRAFT.replace("-251.06 (95% CI -345.34 to -156.77)", "-210.00 (95% CI -300.00 to -120.00)")
    project.save_text("draft.md", contradicting, subdir="manuscript")
    calculation = {"summary": {**_CALCULATION["summary"],
                               "pooled_effect": -251.06, "ci_lower": -345.34, "ci_upper": -156.77}}
    primary_result = _build_primary_result_audit_review(project, calculation)

    readiness = _readiness(project, contradicting, calculation_audit=calculation, primary_result_audit=primary_result)
    decision = build_release_decision(readiness)

    assert decision["status"] == "blocked"
    assert decision["blocker_codes"] == ["primary_result"]
    gate = decision["failed_gates"][0]
    assert {location["field"] for location in gate["locations"]} == {"pooled_effect", "ci_lower", "ci_upper"}


def test_tiering_is_idempotent_and_no_decision_asks_for_a_rerun() -> None:
    readiness = {"gates": [{"id": "readability", "status": "fail", "detail": "d"}]}
    once = json.loads(json.dumps(apply_release_tiers(readiness)))
    assert apply_release_tiers(readiness) == once

    decisions = [
        build_release_decision(None),
        build_release_decision({"status": "ready", "gates": [{"id": "benchmark", "status": "pass"}]}),
        build_release_decision({"gates": [{"id": "readability", "status": "fail"}]}),
        build_release_decision({"gates": [{"id": "calculation_audit", "status": "fail"}]}),
    ]
    assert [decision["status"] for decision in decisions] == ["blocked", "ready", "ready_with_warnings", "blocked"]
    for decision in decisions:
        text = " ".join([decision["summary"], *decision["next_actions"]]).lower()
        assert "rerun" not in text and "resolve the blocking issues" not in text
        assert "diagnostic artifact" not in text


def test_the_final_review_is_a_notice_that_drives_no_rewrite(tmp_path, monkeypatch) -> None:
    project = Project("final review notice", output_dir=tmp_path)
    project.save_text("draft.md", _DRAFT, subdir="manuscript")
    project.save_json("manuscript_facts.json", {"report_type": "meta"}, subdir="manuscript")
    monkeypatch.setattr(main_module, "LLM_API_KEY", "test-key")
    calls: list[str] = []

    def review(self, manuscript, facts, **kwargs):
        calls.append("review")
        return {"status": "ok", "decision": "minor_revision", "issues": [{
            "severity": "minor", "section": "Discussion", "problem": "A citation is repeated.",
            "action": "Consolidate the citation.", "requires_new_source": False,
        }]}

    def forbidden(self, *args, **kwargs):
        raise AssertionError("an advisory review must not rewrite the saved draft")

    monkeypatch.setattr(WritingAgent, "_llm_final_manuscript_readiness_review", review)
    monkeypatch.setattr(WritingAgent, "_llm_apply_final_minor_revision", forbidden)
    monkeypatch.setattr(WritingAgent, "_llm_ground_existing_reference_citations", forbidden)

    saved = main_module._run_final_manuscript_llm_readiness_review(project, model=None, lang="en")

    assert calls == ["review"]
    assert saved["decision"] == "minor_revision"
    assert project.load_text("draft.md", subdir="manuscript") == _DRAFT


def test_a_citation_audit_finding_is_not_sent_back_to_the_model(tmp_path, monkeypatch) -> None:
    import new_meta.agents.writing_agent as writing_agent_module

    project = Project("citation finding", output_dir=tmp_path)
    audit = {"passed": True, "summary": {}, "issues": [{
        "code": "section_citations_missing", "severity": "warn", "section": "Discussion",
        "message": "Discussion has no in-text citation.",
    }]}
    monkeypatch.setattr(writing_agent_module, "build_citation_audit_review", lambda _project: audit)

    def forbidden(self, *args, **kwargs):
        raise AssertionError("an advisory citation finding must not reach the model")

    monkeypatch.setattr(WritingAgent, "_llm_ground_citation_audit_issues", forbidden)
    agent = WritingAgent(lang="en")

    validation, _, _ = agent._quality_checked_validation(_DRAFT, {}, {"passed": True, "issues": []}, project=project)

    assert validation["citation_audit"]["summary"] == {}
    assert not (project.base_dir / "manuscript" / "citation_grounding_audit.json").exists()
