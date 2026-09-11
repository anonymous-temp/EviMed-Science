"""Scope admission exercises real structured output and actual SDK boundaries."""
import json
import math
from types import SimpleNamespace

import pytest
import httpx

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.protocol_scope import scope_fields
from new_meta.core.protocol_scope_sources import replay_scope_sources
from tests.test_llm_source_faithful import chat_response, sdk_json_response, attach_sdk_transport
from tests.test_protocol_scope import TOPIC, batch_assessment, proposal


@pytest.fixture
def planner(monkeypatch):
    result = ResearchPlanner()
    result.llm.stream = True
    result.llm.use_responses_api = False
    monkeypatch.setattr(result.llm, "_sleep_before_retry", lambda *args, **kwargs: None)
    # Keep the offline suite guard while exercising the real transport implementation.
    call = result.llm._call
    monkeypatch.setattr(result.llm, "_call", lambda **kwargs: call(**kwargs))
    return result


@pytest.mark.parametrize("damage", ["missing_source_id", "extra_original_quote"])
def test_valid_nonmatch_survives_a_schema_invalid_sibling_at_sdk_boundary(planner, monkeypatch, damage):
    protocol = proposal()
    protocol.pico.comparator = "Active treatments"
    calls = []

    def create(**kwargs):
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        if not calls:
            next(row for row in response["fields"] if row["field"] == "pico.comparator")["status"] = "mismatch"
            if damage == "missing_source_id": response["fields"][0].pop("source_id")
            else: response["fields"][0]["original_quote"] = "forbidden generated quote"
        calls.append(json.dumps(response))
        return chat_response(calls[-1])

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    assert caught.value.phase.error_code == "protocol_scope_input_required"
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert [row["raw_content"] for row in attempts] == calls
    assert attempts[1]["attempt"] == 2 and attempts[1]["provider_response_ordinal"] == 1
    assert attempts[1]["field_origins"]["pico.comparator"] == {"batch": 1, "attempt": 1, "provider_response_ordinal": 1}


def test_length_retry_keeps_provider_ordinals_and_valid_nonmatch(planner, monkeypatch):
    protocol = proposal()
    calls = []

    def create(**kwargs):
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        finish = "stop"
        if not calls:
            next(row for row in response["fields"] if row["field"] == "pico.comparator")["status"] = "uncertain"
            finish = "length"
        calls.append(kwargs)
        return chat_response(json.dumps(response), finish)

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert caught.value.phase.error_code == "protocol_scope_input_required"
    assert [(row["attempt"], row["provider_response_ordinal"], row["finish_reason"]) for row in attempts[:2]] == [(1, 1, "length"), (1, 2, "stop")]
    assert attempts[1]["field_origins"]["pico.comparator"]["provider_response_ordinal"] == 1
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1


@pytest.mark.parametrize("damage", ["duplicate_json_key", "invalid_json", "truncated_json", "observer_failure"])
def test_observation_failure_is_terminal_for_the_outer_planner(planner, monkeypatch, damage):
    protocol = proposal()
    generated = []
    raw_calls = []
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: generated.append(True) or protocol)
    if damage == "observer_failure":
        def fail(*args, **kwargs): raise RuntimeError("synthetic observer fault")
        monkeypatch.setattr("new_meta.agents.research_planner.evaluate_scope_references", fail)

    def create(**kwargs):
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        next(row for row in response["fields"] if row["field"] == "pico.comparator")["status"] = "mismatch"
        raw = json.dumps(response)
        if damage == "duplicate_json_key": raw = raw.replace('"fields": [', '"fields": [], "fields": [', 1)
        if damage == "invalid_json": raw += " trailing invalid text"
        if damage == "truncated_json": raw = raw[:-3]
        raw_calls.append(raw)
        return chat_response(raw, "length" if damage == "truncated_json" else "stop")

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    assert caught.value.phase.error_code == "protocol_scope_unverified"
    assert len(generated) == len(raw_calls) == 1
    assert caught.value.phase.data["scope_check_attempts"][0]["raw_content"] == raw_calls[0]
    assert protocol._scope_receipt == {}


def test_duplicate_field_counts_include_a_malformed_sibling_before_resolution(planner, monkeypatch):
    protocol = proposal()
    calls = []

    def create(**kwargs):
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        if not calls:
            row = next(row for row in response["fields"] if row["field"] == "pico.comparator")
            row["status"] = "mismatch"
            response["fields"].append({"field": row["field"], "status": "mismatch"})
        calls.append(kwargs)
        return chat_response(json.dumps(response))

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    receipt = planner.check_scope(TOPIC, protocol)
    assert len(calls) == math.ceil(len(scope_fields(protocol)) / 8) + 1
    assert replay_scope_sources(TOPIC, protocol, receipt["source_provenance"]).model_dump(mode="json") == receipt["assessment"]


def test_approved_provenance_retains_every_provider_length_observation(planner, monkeypatch):
    protocol = proposal()
    calls = []

    def create(**kwargs):
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        calls.append(kwargs)
        return chat_response(json.dumps(response), "length" if len(calls) == 1 else "stop")

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    receipt = planner.check_scope(TOPIC, protocol)
    provenance = receipt["source_provenance"]
    assert len(provenance["responses"]) == len(calls)
    assert provenance["field_origins"]["pico.comparator"] == {"batch": 1, "attempt": 1, "provider_response_ordinal": 2}
    assert replay_scope_sources(TOPIC, protocol, provenance).model_dump(mode="json") == receipt["assessment"]
    provenance["field_origins"]["pico.comparator"]["provider_response_ordinal"] = 1
    with pytest.raises(ValueError): replay_scope_sources(TOPIC, protocol, provenance)


def test_real_transport_failure_preserves_observations_without_reclassifying_as_input(planner, monkeypatch):
    import new_meta.core.llm as llm_module

    protocol = proposal()
    monkeypatch.setattr(llm_module, "LLM_MAX_RETRIES", 2)
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1: raise ConnectionError("synthetic transport failure")
        response = batch_assessment(kwargs["messages"], protocol).model_dump(mode="json")
        next(row for row in response["fields"] if row["field"] == "pico.comparator")["status"] = "mismatch"
        return chat_response(json.dumps(response), "length")

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    with pytest.raises(ConnectionError) as caught:
        planner.check_scope(TOPIC, protocol)
    assert len(calls) == 2
    assert len(caught.value.scope_check_data["scope_check_attempts"]) == 1


@pytest.mark.parametrize("missing", ["none", "zero_choices", "empty"])
def test_missing_provider_content_can_recover_without_fabricated_json_null(planner, monkeypatch, missing):
    protocol = proposal()
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            if missing == "zero_choices": return SimpleNamespace(choices=[], usage=None)
            return chat_response(None if missing == "none" else "")
        return chat_response(batch_assessment(kwargs["messages"], protocol).model_dump_json())

    monkeypatch.setattr(planner.llm.client.chat.completions, "create", create)
    receipt = planner.check_scope(TOPIC, protocol)
    provenance = receipt["source_provenance"]
    first = provenance["responses"][0]
    assert "response" not in first
    assert first["response_unavailable"] == ("empty_content" if missing == "empty" else "missing_content")
    assert provenance["field_origins"]["pico.comparator"]["provider_response_ordinal"] == 2
    assert replay_scope_sources(TOPIC, protocol, provenance).model_dump(mode="json") == receipt["assessment"]


def test_missing_content_exhaustion_is_terminal_after_existing_provider_budget(planner, monkeypatch):
    import new_meta.core.llm as llm_module

    protocol = proposal()
    generated = []
    calls = []
    monkeypatch.setattr(llm_module, "LLM_MAX_RETRIES", 2)
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: generated.append(True) or protocol)
    monkeypatch.setattr(planner.llm.client.chat.completions, "create", lambda **kwargs: calls.append(kwargs) or chat_response(None))
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert len(calls) == 2 and len(generated) == 1
    assert all(row["raw_content"] is None and "reference_response" not in row for row in attempts)
    assert all(row["validation"]["code"] == "scope_response_missing_content" for row in attempts)


def test_model_json_null_is_not_treated_as_missing_sdk_content(planner, monkeypatch):
    protocol = proposal()
    calls = []
    monkeypatch.setattr(planner.llm.client.chat.completions, "create", lambda **kwargs: calls.append(kwargs) or chat_response("null"))
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    attempt = caught.value.phase.data["scope_check_attempts"][0]
    assert len(calls) == 1
    assert attempt["raw_content"] == "null" and attempt["reference_response"] is None
    assert "response_unavailable" not in attempt


@pytest.mark.parametrize("endpoint", ["chat", "responses"])
def test_actual_sdk_bad_usage_is_terminal_for_planning_and_preserves_negative(planner, monkeypatch, endpoint):
    protocol = proposal()
    protocol.pico.comparator = "Active treatments"
    generated = []
    calls = []
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: generated.append(True) or protocol)

    def handler(request):
        payload = json.loads(request.content)
        messages = payload["messages"] if endpoint == "chat" else [
            {"role": item["role"], "content": "".join(part["text"] for part in item["content"])} for item in payload["input"]]
        response = batch_assessment(messages, protocol).model_dump(mode="json")
        if not calls:
            next(row for row in response["fields"] if row["field"] == "pico.comparator")["status"] = "mismatch"
        calls.append(response)
        usage = {"prompt_tokens": "unknown", "completion_tokens": 5, "total_tokens": 6} if endpoint == "chat" else {
            "input_tokens": "unknown", "output_tokens": 5, "total_tokens": 6}
        return httpx.Response(200, json=sdk_json_response(endpoint, json.dumps(response), usage))

    attach_sdk_transport(planner.llm, monkeypatch, endpoint, handler)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    assert caught.value.phase.error_code == "protocol_scope_unverified"
    assert len(generated) == len(calls) == 1
    attempts = caught.value.phase.data["scope_check_attempts"]
    assert len(attempts) == 1 and attempts[0]["reference_response"] == calls[0]
    assert next(row for row in attempts[0]["resolved_assessment"]["fields"] if row["field"] == "pico.comparator")["status"] == "mismatch"
    assert protocol._scope_receipt == {}
