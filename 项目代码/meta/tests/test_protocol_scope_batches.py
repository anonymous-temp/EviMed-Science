"""Bounded checker recovery preserves independent scope evidence and full coverage."""
import json
import math

import pytest

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.primary_analysis_alignment import digest
from new_meta.core.project import Project
from new_meta.core.protocol_scope import (
    ensure_project_protocol_scope, protocol_hash, scope_fields, scope_receipt,
)
from new_meta.core.protocol_scope_sources import source_catalogue, replay_scope_sources
from tests.test_protocol_scope import TOPIC, assessment, batch_assessment, proposal, scope_response_mock


def test_each_batch_sees_the_full_question_and_protocol_and_merges_every_field(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    protocol.inclusion_criteria += [f"Clinical criterion {index}" for index in range(17)]
    before = protocol.model_dump()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        prompt = messages[1]["content"]
        assert TOPIC in prompt
        assert protocol.model_dump_json(indent=2) in prompt
        result = batch_assessment(messages, protocol)
        assert 1 <= len(result.fields) <= 8
        assert all(row.source_id == source_catalogue(TOPIC, protocol)["sources"][0]["source_id"] for row in result.fields)
        assert kwargs["max_tokens"] == 16384
        calls.append([row.field for row in result.fields])
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    receipt = planner.check_scope(TOPIC, protocol)
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8)
    assert [row["field"] for row in receipt["assessment"]["fields"]] == list(scope_fields(protocol))
    assert protocol.model_dump() == before
    assert receipt["assessment"] == scope_receipt(TOPIC, protocol, receipt["assessment"])["assessment"]
    assert replay_scope_sources(TOPIC, protocol, receipt["source_provenance"]).model_dump(mode="json") == receipt["assessment"]


@pytest.mark.parametrize("damage", ["wrong_field", "wrong_index", "duplicate", "missing", "unknown_source_id", "blank_rationale", "short_absence_context"])
def test_invalid_batch_gets_one_same_protocol_retry_without_regenerating_plan(monkeypatch, damage):
    planner = ResearchPlanner()
    protocol = proposal()
    question = TOPIC + " Compare 250 mg daily with placebo."
    generation_calls = []
    checker_calls = []

    def generate(*args, **kwargs):
        assert kwargs["max_tokens"] == 8192
        generation_calls.append(args)
        return protocol

    @scope_response_mock
    def check(messages, schema, **kwargs):
        checker_calls.append(messages)
        result = batch_assessment(messages, protocol, topic=question)
        if len(checker_calls) == 1:
            row = result.fields[0]
            if damage == "wrong_field": row.field = "not_a_protocol_field"
            if damage == "wrong_index": row.field = "inclusion_criteria[999]"
            if damage == "duplicate": result.fields[-1] = row.model_copy()
            if damage == "missing": result.fields.pop()
            if damage == "unknown_source_id": row.basis = "explicit"; row.source_id = "unknown-source"
            if damage == "blank_rationale": row.rationale = " "
            if damage == "short_absence_context": row.source_id = source_catalogue(question, protocol)["sources"][1]["source_id"]
        return result

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", check)
    result = planner.run(question)
    assert result._scope_receipt
    assert len(generation_calls) == 1
    assert len(checker_calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1
    assert checker_calls[0][1]["content"] in checker_calls[1][1]["content"]
    assert "checker validation feedback" in checker_calls[1][1]["content"].lower()
    assert all(question in call[1]["content"] for call in checker_calls)


def test_repeated_bad_source_id_preserves_real_diagnostic_without_replanning(monkeypatch, tmp_path):
    planner = ResearchPlanner()
    protocol = proposal()
    generated = []
    checks = []

    def generate(*args, **kwargs):
        generated.append(True)
        return protocol

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        result.fields[0].source_id = "invented-source-id"
        checks.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    assert len(generated) == 1 and len(checks) == 2
    assert caught.value.phase.data["original_question"] == TOPIC
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert [row["reference_response"] for row in attempts] == checks
    assert all("source_id" not in field for record in attempts for field in record["resolved_assessment"]["fields"])
    assert all(checks[0]["fields"][0]["field"] not in [field["field"] for field in record["resolved_assessment"]["fields"]] for record in attempts)
    assert all(row["topic_sha256"] == digest(TOPIC) for row in attempts)
    assert all(row["protocol_sha256"] == protocol_hash(protocol) for row in attempts)
    assert attempts[-1]["validation"]["code"] == "scope_source_id_unknown"
    caught.value.persist(Project(TOPIC, output_dir=tmp_path))
    saved = caught.value.project.load_json("protocol_rejected_proposal.json", subdir="analysis")
    assert saved["scope_check_attempts"] == attempts


@pytest.mark.parametrize("status", ["mismatch", "uncertain"])
def test_valid_semantic_conflict_is_not_retried_into_approval(monkeypatch, status):
    planner = ResearchPlanner()
    protocol = proposal()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        calls.append(messages)
        return batch_assessment(messages, protocol, changes={"pico.comparator": {
            "basis": "explicit", "status": status, "original_quote": "placebo",
            "rationale": "Independent reviewer found a comparator scope conflict.",
        }})

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8)
    assert caught.value.phase.error_code == "protocol_scope_input_required"
    findings = caught.value.phase.issues[0].context["scope_findings"]
    assert findings[0]["status"] == status


def test_protocol_mutation_in_a_later_batch_cannot_create_a_receipt(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        calls.append(messages)
        if len(calls) == 2:
            protocol.pico.comparator = "Active treatment"
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired, match="changed during"):
        planner.check_scope(TOPIC, protocol)
    assert len(calls) == 2
    assert protocol._scope_receipt == {}


@pytest.mark.parametrize("error", [RuntimeError("provider connection fault"), ValueError("internal failure")])
def test_provider_and_internal_failures_remain_failures(monkeypatch, error):
    planner = ResearchPlanner()
    calls = []

    @scope_response_mock
    def check(*args, **kwargs):
        calls.append(True)
        raise error

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(type(error), match=str(error)) as caught:
        planner.check_scope(TOPIC, proposal())
    assert caught.value is error and len(calls) == 1
    assert not isinstance(caught.value, ProtocolInputRequired)


def test_malformed_response_diagnostic_does_not_fabricate_an_assessment(monkeypatch):
    planner = ResearchPlanner()
    calls = []

    def malformed(*args, **kwargs):
        calls.append(True)
        try:
            json.loads("not-json-sensitive-raw-output")
        except json.JSONDecodeError as cause:
            raise ValueError("raw SDK response must not be persisted") from cause

    monkeypatch.setattr(planner.llm, "structured_output", malformed)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, proposal())
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert len(calls) == 1 and attempts == []
    assert "raw SDK" not in json.dumps(attempts) and "not-json-sensitive" not in json.dumps(attempts)


def test_old_whole_assessment_and_cached_receipt_remain_compatible(tmp_path):
    protocol = proposal()
    project = Project(TOPIC, output_dir=tmp_path)
    receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    project.save_json("protocol_scope.json", receipt, subdir="analysis")
    assert ensure_project_protocol_scope(project, protocol, allow_recheck=False) == receipt
    partial = assessment(protocol).model_dump()
    partial["fields"] = partial["fields"][:8]
    with pytest.raises(ValueError, match="every proposal field exactly once"):
        scope_receipt(TOPIC, protocol, partial)


def test_three_semantic_replans_keep_bounded_diagnostics_and_compact_feedback(monkeypatch):
    from new_meta.agents.research_planner import SCOPE_DIAGNOSTIC_MAX_BYTES, SCOPE_DIAGNOSTIC_MAX_ATTEMPTS

    planner = ResearchPlanner()
    protocol = proposal()
    protocol.inclusion_criteria += [f"Clinical criterion {index}" for index in range(75)]
    topic = TOPIC + " Additional original clinical context." * 45
    generation_prompts = []

    def generate(prompt, *args, **kwargs):
        generation_prompts.append(prompt)
        return protocol

    @scope_response_mock
    def check(messages, schema, **kwargs):
        return batch_assessment(messages, protocol, topic=topic, changes={"pico.comparator": {
            "status": "mismatch", "rationale": "The original question restricts the comparator.",
        }})

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(topic)
    assert len(generation_prompts) == 3
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert len(attempts) <= SCOPE_DIAGNOSTIC_MAX_ATTEMPTS
    assert len(json.dumps(attempts, ensure_ascii=False).encode()) <= SCOPE_DIAGNOSTIC_MAX_BYTES
    assert caught.value.phase.data["scope_check_attempts_omitted"] > 0
    for prompt in generation_prompts[1:]:
        feedback = prompt.split("Validation feedback (not new user intent):\n", 1)[1]
        assert "pico.comparator" in feedback and "mismatch" in feedback
        assert "scope_check_attempts" not in feedback and "original_quote" not in feedback
        assert topic not in feedback and len(feedback) < 4000


def test_oversized_typed_assessment_is_explicitly_omitted_never_clipped_into_evidence(monkeypatch):
    from new_meta.agents.research_planner import SCOPE_ASSESSMENT_MAX_BYTES

    planner = ResearchPlanner()
    protocol = proposal()
    returned = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        result.fields[0].source_id = "fabricated-id " * SCOPE_ASSESSMENT_MAX_BYTES
        returned.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert len(attempts) == 2
    for record, actual in zip(attempts, returned):
        assert "reference_response" not in record
        assert record["reference_response_omitted"] == "diagnostic_size_limit"
        assert record["reference_response_sha256"] == digest(actual)
        assert record["reference_response_size_bytes"] > SCOPE_ASSESSMENT_MAX_BYTES


def test_partial_original_context_is_rejected_in_a_later_batch(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        calls.append(result.fields[0].field)
        if len(calls) >= 2:
            result.fields[0].source_id = source_catalogue(TOPIC, protocol)["sources"][1]["source_id"]
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    assert len(calls) == 3 and calls[1] == calls[2]
    assert caught.value.phase.data["scope_check_attempts"][-1]["validation"]["code"] == "scope_absence_source_not_whole"


def test_unknown_criterion_reference_retries_only_its_batch(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    protocol.inclusion_criteria += [f"Clinical criterion {index}" for index in range(5)]
    before = protocol.model_dump()
    damaged_batches = []
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        names = [row.field for row in result.fields]
        calls.append(names)
        for row in result.fields:
            if row.field == "inclusion_criteria[5]":
                damaged_batches.append(names)
                if len(damaged_batches) == 1:
                    row.basis = "explicit"
                    row.source_id = "unknown-criterion-reference"
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    assert planner.check_scope(TOPIC, protocol)["assessment"]
    assert len(damaged_batches) == 2 and damaged_batches[0] == damaged_batches[1]
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1
    assert protocol.model_dump() == before


def test_later_method_normalization_failure_retains_prior_scope_assessments(monkeypatch):
    planner = ResearchPlanner()
    initial = proposal()
    unsupported = proposal()
    unsupported.review_family = "unrecognized_family"
    proposals = iter([initial, unsupported, unsupported])
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, initial, changes={"pico.comparator": {
            "status": "mismatch", "rationale": "Independent reviewer found comparator scope drift.",
        }})
        calls.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: next(proposals))
    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    assert caught.value.phase.error_code == "protocol_method_input_required"
    assert caught.value.phase.data["proposal"]["review_family"] == "unrecognized_family"
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert [record["reference_response"] for record in attempts] == calls
    assert all(record["protocol_sha256"] == protocol_hash(initial) for record in attempts)


@pytest.mark.parametrize("status", ["mismatch", "uncertain"])
def test_format_retry_cannot_erase_another_fields_valid_semantic_conflict(monkeypatch, status):
    planner = ResearchPlanner()
    protocol = proposal()
    protocol.pico.comparator = "Active treatments"
    calls = []
    conflict = {"field": "pico.comparator", "status": status, "basis": "explicit",
                "original_quote": TOPIC, "rationale": "The requested placebo comparator is not preserved."}

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        if not calls:
            result.fields[0].source_id = "fabricated-unrelated-id"
            for row in result.fields:
                if row.field == conflict["field"]:
                    for key, value in conflict.items():
                        if key != "original_quote": setattr(row, key, value)
        calls.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    assert caught.value.phase.error_code == "protocol_scope_input_required"
    assert caught.value.phase.issues[0].context["scope_findings"] == [conflict]
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert attempts[1]["retained_nonmatch_fields"] == ["pico.comparator"]
    assert all(row["status"] == "match" for row in attempts[1]["reference_response"]["fields"])
    assert [record["reference_response"] for record in attempts] == calls
    assert attempts[1]["field_origins"]["pico.comparator"] == {"batch": 1, "attempt": 1, "provider_response_ordinal": 1}


def test_retained_conflict_uses_normal_planner_correction_on_a_new_proposal(monkeypatch):
    planner = ResearchPlanner()
    broad = proposal()
    broad.pico.comparator = "Active treatments"
    corrected = proposal()
    candidates = iter([broad, corrected])
    generated = []
    check_count = []

    def generate(*args, **kwargs):
        candidate = next(candidates)
        generated.append(candidate)
        return candidate

    @scope_response_mock
    def check(messages, schema, **kwargs):
        candidate = generated[-1]
        result = batch_assessment(messages, candidate)
        if not check_count:
            result.fields[0].source_id = "fabricated-unrelated-id"
            for row in result.fields:
                if row.field == "pico.comparator":
                    row.status = "mismatch"
                    row.basis = "explicit"
        check_count.append(True)
        return result

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", check)
    accepted = planner.run(TOPIC)
    assert generated == [broad, corrected]
    assert accepted.pico.comparator == "Placebo" and accepted._scope_receipt


@pytest.mark.parametrize("damage", ["duplicate", "duplicate_invalid_id", "unanchored", "unknown"])
def test_unverified_conflict_fields_cannot_be_retained_as_valid_judgments(monkeypatch, damage):
    planner = ResearchPlanner()
    protocol = proposal()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        if not calls:
            row = next(row for row in result.fields if row.field == "pico.comparator")
            row.status = "mismatch"
            row.basis = "explicit"
            if damage == "duplicate": result.fields.append(row.model_copy(deep=True))
            if damage == "duplicate_invalid_id":
                sibling = row.model_copy(deep=True); sibling.source_id = "unknown-sibling-id"
                result.fields.append(sibling)
            if damage == "unanchored": row.source_id = "fabricated-comparator-id"
            if damage == "unknown": row.field = "unknown_comparator"
        calls.append(True)
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    receipt = planner.check_scope(TOPIC, protocol)
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1
    assert all(row["status"] == "match" for row in receipt["assessment"]["fields"])
