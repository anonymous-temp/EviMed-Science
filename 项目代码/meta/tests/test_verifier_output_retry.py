"""The verifier's own unusable output is re-asked, never read as a disagreement.

ma-001 on production (2026-09-28, job meta-20260928154619): one LLMOutputError,
JSONDecodeError or ValueError from the independent verifier on its first
attempt left two extracted results unverified, and the unattended synthesis
left them out. A response that is not JSON, or not the schema, says nothing
about the source; it is asked again (bounded), and only when every attempt
fails is the row left out - as a verification that could not complete, not
as one that did not match. An unverified number is still never pooled.
"""
from __future__ import annotations

import hashlib
import json

import pytest

from test_extraction_verification import SOURCE, checked_row, protocol, study


def _run(tmp_path, monkeypatch, script):
    """Drive _verify_alignment with a scripted verifier: "bad-json", "off-schema" or "ok"."""
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.project import Project
    from new_meta.schemas.study import ExtractionReferenceEnvelope
    from extraction_source_fixture import observed_check

    project = Project("verifier output retry", output_dir=tmp_path)
    path = project.base_dir / "papers" / "source.txt"
    path.write_text(SOURCE)
    agent = DataExtractionAgent()
    steps = iter(script)
    calls = []

    def check(text, extracted, current_protocol, indices, feedback, observe=None, catalogue=None,
              strict_output=False):
        calls.append({"strict_output": strict_output, "feedback": list(feedback)})
        step = next(steps)
        if step == "bad-json":
            raw = '{"score": 9, "data_issues": [], "primary_analysis_alignment": [{"outcome_index": 0,'
            observe({"content": raw, "finish_reason": "stop", "provider_response_ordinal": 1})
            json.loads(raw)  # what structured_output does with it: JSONDecodeError
        if step == "off-schema":
            raw = json.dumps({"verdict": "looks fine"})
            observe({"content": raw, "finish_reason": "stop", "provider_response_ordinal": 1})
            return ExtractionReferenceEnvelope.model_validate(json.loads(raw))
        return observed_check(ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[checked_row()]),
                              text, observe, catalogue)

    monkeypatch.setattr(agent, "_check_extraction", check)
    result = agent._verify_alignment(study(), {"fulltext_path": str(path)},
                                     {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()},
                                     protocol(), project)
    return project, result, calls


def test_malformed_output_twice_then_valid_is_verified(tmp_path, monkeypatch):
    from new_meta.core.primary_analysis_alignment import alignment_status

    project, result, calls = _run(tmp_path, monkeypatch, ["bad-json", "off-schema", "ok"])
    assert len(calls) == 3
    # The first ask is the ordinary one; the re-asks hold the form, not the judgment.
    assert [call["strict_output"] for call in calls] == [False, True, True]
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"


def test_malformed_output_every_time_is_left_out_as_not_completed(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import VERIFICATION_OUTPUT_UNUSABLE, VERIFIER_OUTPUT_ATTEMPTS
    from new_meta.core.extraction_ledger import result_entity_id
    from new_meta.core.primary_analysis_alignment import (
        UNATTENDED_RUN_FILE, alignment_status, report_unverified_results_left_out, unattended_unverified_results,
    )

    project, result, calls = _run(tmp_path, monkeypatch, ["bad-json", "off-schema", "bad-json", "ok", "ok", "ok"])
    # Bounded: one round's attempts, then the round ends - it is not re-run
    # until some later attempt happens to parse.
    assert len(calls) == VERIFIER_OUTPUT_ATTEMPTS
    status = alignment_status(project, protocol(), result, 0)
    assert status["status"] == "unknown"
    assert status["reason"] == "verification_could_not_complete"

    project.save_json("all_extractions.json", [result], subdir="extraction")
    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    result_id = result_entity_id(result, 0)
    left_out = unattended_unverified_results(project, protocol(), [result_id])
    assert left_out == {result_id: "verification_could_not_complete"}
    report_unverified_results_left_out(project, left_out)
    warning = next(item for item in project.load_json("pipeline_warnings.json")
                   if item["code"] == "unverified_results_left_out")
    assert "could not complete" in warning["message"]
    assert "did not match" not in warning["message"]
    records = [json.loads(item.read_text()) for item in (project.base_dir / "extraction/verification").glob("*.json")]
    assert any(reason.get("code") == VERIFICATION_OUTPUT_UNUSABLE
               for record in records for reason in record.get("reasons") or [])


def test_a_clinical_nonmatch_is_not_re_asked(tmp_path, monkeypatch):
    """Re-asking is for the form of the answer only: a response that recorded a
    mismatch and then failed is never asked again until it says match."""
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import alignment_status
    from extraction_source_fixture import wire_payload

    project = Project("verifier nonmatch", output_dir=tmp_path)
    path = project.base_dir / "papers" / "source.txt"
    path.write_text(SOURCE)
    agent = DataExtractionAgent()
    calls = []
    mismatch = checked_row()
    mismatch["outcome"]["status"] = "mismatch"

    def check(text, extracted, current_protocol, indices, feedback, observe=None, catalogue=None, strict_output=False):
        calls.append(strict_output)
        payload = wire_payload(ExtractionCheckResult(data_issues=[], score=3, primary_analysis_alignment=[mismatch]),
                               text, catalogue)
        observe({"content": json.dumps(payload), "finish_reason": "stop", "provider_response_ordinal": 1})
        raise ValueError("a failure after the clinical judgment was observed")

    monkeypatch.setattr(agent, "_check_extraction", check)
    result = agent._verify_alignment(study(), {"fulltext_path": str(path)},
                                     {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()},
                                     protocol(), project)
    assert calls == [False]
    assert alignment_status(project, protocol(), result, 0)["status"] != "match"


@pytest.mark.parametrize("error, unusable", [
    (json.JSONDecodeError("Expecting value", "x", 0), True),
    (ValueError("Independent verification did not return its durably observed source response"), True),
    (OSError("disk"), False),
])
def test_what_counts_as_the_verifier_failing(error, unusable):
    from new_meta.agents.data_extraction_agent import verifier_output_unusable
    from new_meta.core.llm import LLMOutputError
    assert verifier_output_unusable(error) is unusable
    assert verifier_output_unusable(LLMOutputError("LLM returned empty text after retries."))
