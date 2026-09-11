"""Opt-in source observation is tested at the actual SDK boundary."""
import json
from types import SimpleNamespace

import pytest
import httpx
from openai import OpenAI
from pydantic import BaseModel

from new_meta.core.llm import LLMClient, LLMOutputError


class Payload(BaseModel):
    fields: list[dict]


def chat_response(content, finish_reason="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish_reason)], usage=None)


@pytest.fixture
def client(monkeypatch):
    result = LLMClient(api_key="test", base_url="https://example.invalid/v1", model="test-model")
    result.stream = True
    result.use_responses_api = False
    monkeypatch.setattr(result, "_sleep_before_retry", lambda *args, **kwargs: None)
    return result


def test_source_faithful_observes_every_length_response_before_retry_and_forces_nonstream(client, monkeypatch):
    values = [chat_response('{"fields":[{"status":"mismatch"}]}', "length"),
              chat_response('{"fields":[{"status":"match"}]}')]
    calls = []
    observed = []

    def create(**kwargs):
        assert len(observed) == len(calls)
        calls.append(kwargs)
        return values.pop(0)

    monkeypatch.setattr(client.client.chat.completions, "create", create)
    result = client.structured_output([{"role": "user", "content": "Assess the exact source."}], Payload,
        source_faithful=True, on_raw_response=lambda row: observed.append(dict(row)), max_tokens=100)
    assert result.fields == [{"status": "match"}]
    assert [row["finish_reason"] for row in observed] == ["length", "stop"]
    assert [row["provider_response_ordinal"] for row in observed] == [1, 2]
    assert all(call["stream"] is False for call in calls)
    assert client.stream is True


@pytest.mark.parametrize("raw", ['{"fields":', '{"fields":[],"fields":[{"status":"match"}]}',
                                 '```json\n{"fields":[]}\n```', '[{"status":"match"}]'])
def test_source_faithful_never_repairs_wraps_or_regenerates_invalid_json(client, monkeypatch, raw):
    calls = []
    seen = []
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs:
                        calls.append(kwargs) or chat_response(raw))
    with pytest.raises(ValueError):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=lambda row: seen.append(dict(row)))
    assert len(calls) == 1 and seen[0]["content"] == raw


def test_source_faithful_preserves_nested_values_instead_of_deep_cleaning(client, monkeypatch):
    raw = '{"fields":[{"rationale":{"value":"mismatch","source_section":"original"}}]}'
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs: chat_response(raw))
    result = client.structured_output([{"role": "user", "content": "Assess."}], Payload,
        source_faithful=True, on_raw_response=lambda row: None)
    assert result.model_dump() == json.loads(raw)


def test_source_observer_failure_is_not_retried_or_swallowed(client, monkeypatch):
    calls = []
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs:
                        calls.append(kwargs) or chat_response('{"fields":[]}', "length"))

    def fail(row):
        raise RuntimeError("observer persistence fault")

    with pytest.raises(LLMOutputError, match="observer"):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=fail)
    assert len(calls) == 1


def test_source_faithful_transport_errors_keep_existing_retries(client, monkeypatch):
    calls = []
    seen = []

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise ConnectionError("synthetic transport fault")
        return chat_response('{"fields":[]}')

    monkeypatch.setattr(client.client.chat.completions, "create", create)
    client.structured_output([{"role": "user", "content": "Assess."}], Payload,
        source_faithful=True, on_raw_response=lambda row: seen.append(dict(row)))
    assert len(calls) == 2 and len(seen) == 1 and seen[0]["provider_response_ordinal"] == 1


def test_default_structured_generation_keeps_existing_json_repair(client, monkeypatch):
    client.stream = False
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs:
                        chat_response('[{"rationale":{"value":"match","source_section":"original"}}]'))
    assert client.structured_output([{"role": "user", "content": "Assess."}], Payload).fields == [{"rationale": "match"}]


@pytest.mark.parametrize("observer", [None, "not-callable"])
def test_source_faithful_requires_observer_before_any_provider_call(client, monkeypatch, observer):
    def no_call(**kwargs):
        raise AssertionError("Provider must not be reached without an observer")
    monkeypatch.setattr(client.client.chat.completions, "create", no_call)
    with pytest.raises(ValueError, match="observer"):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=observer)


def test_responses_path_observes_incomplete_output_before_retry(client, monkeypatch):
    client.use_responses_api = True
    monkeypatch.setattr(client, "_should_use_responses_api", lambda **kwargs: True)
    responses = [SimpleNamespace(output_text='{"fields":[{"status":"mismatch"}]}', status="incomplete", usage=None),
                 SimpleNamespace(output_text='{"fields":[{"status":"match"}]}', status="completed", usage=None)]
    calls = []
    observed = []

    def create(**kwargs):
        assert len(calls) == len(observed)
        calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(client.client.responses, "create", create)
    result = client.structured_output([{"role": "user", "content": "Assess."}], Payload,
        source_faithful=True, on_raw_response=lambda row: observed.append(dict(row)))
    assert result.fields == [{"status": "match"}]
    assert [row["finish_reason"] for row in observed] == ["incomplete", "completed"]
    assert all(call["stream"] is False for call in calls)


def test_responses_observer_failure_cannot_fall_back_to_chat(client, monkeypatch):
    monkeypatch.setattr(client, "_should_use_responses_api", lambda **kwargs: True)
    calls = []
    monkeypatch.setattr(client.client.responses, "create", lambda **kwargs:
                        calls.append(kwargs) or SimpleNamespace(output_text='{"fields":[]}', status="incomplete", usage=None))

    def no_chat(**kwargs):
        raise AssertionError("Observer failure cannot fall back to another generation")

    def fail(row):
        raise RuntimeError("synthetic observer fault")

    monkeypatch.setattr(client.client.chat.completions, "create", no_chat)
    with pytest.raises(LLMOutputError):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=fail)
    assert len(calls) == 1 and not client._responses_api_disabled_for_session


def test_unsupported_provider_shape_is_observed_and_fails_closed(client, monkeypatch):
    response = chat_response({"unexpected": "object"})
    seen = []
    calls = []
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs: calls.append(kwargs) or response)
    with pytest.raises(LLMOutputError):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=lambda row: seen.append(dict(row)))
    assert len(calls) == len(seen) == 1


@pytest.mark.parametrize("empty", [SimpleNamespace(choices=[], usage=None), chat_response(None)])
def test_missing_provider_content_remains_observable_across_bounded_retry(client, monkeypatch, empty):
    seen = []
    responses = iter([empty, chat_response('{"fields":[]}')])
    monkeypatch.setattr(client.client.chat.completions, "create", lambda **kwargs: next(responses))
    client.structured_output([{"role": "user", "content": "Assess."}], Payload,
        source_faithful=True, on_raw_response=lambda row: seen.append(dict(row)))
    assert len(seen) == 2 and seen[0]["content"] is None
    assert seen[1]["provider_response_ordinal"] == 2


def sdk_json_response(endpoint, content, usage):
    if endpoint == "chat":
        return {"id": "chat-test", "object": "chat.completion", "created": 0, "model": "test-model",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
                "usage": usage}
    return {"id": "resp-test", "object": "response", "created_at": 0, "model": "test-model", "status": "completed",
            "output": [{"id": "msg-test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": content, "annotations": []}]}], "usage": usage}


def attach_sdk_transport(client, monkeypatch, endpoint, handler):
    client.client = OpenAI(api_key="test", base_url="https://example.invalid/v1",
                          http_client=httpx.Client(transport=httpx.MockTransport(handler), trust_env=False))
    monkeypatch.setattr(client, "_should_use_responses_api", lambda **kwargs: endpoint == "responses")


@pytest.mark.parametrize("endpoint", ["chat", "responses"])
def test_actual_sdk_invalid_usage_cannot_hide_observed_content_or_retry(client, monkeypatch, endpoint):
    import new_meta.core.llm as llm_module

    calls = []
    observed = []
    before = len(llm_module._LLM_USAGE_EVENTS)
    raw = '{"fields":[{"status":"mismatch"}]}'

    def handler(request):
        calls.append(request)
        usage = {"prompt_tokens": "unknown", "completion_tokens": 5, "total_tokens": 6} if endpoint == "chat" else {
            "input_tokens": "unknown", "output_tokens": 5, "total_tokens": 6}
        return httpx.Response(200, json=sdk_json_response(endpoint, raw, usage))

    attach_sdk_transport(client, monkeypatch, endpoint, handler)
    with pytest.raises(LLMOutputError, match="metadata"):
        client.structured_output([{"role": "user", "content": "Assess."}], Payload,
            source_faithful=True, on_raw_response=lambda row: observed.append(dict(row)))
    assert len(calls) == len(observed) == 1 and observed[0]["content"] == raw
    assert llm_module._LLM_USAGE_EVENTS[before:] == []  # Invalid counters are never replaced with invented zeroes.


@pytest.mark.parametrize("endpoint", ["chat", "responses"])
def test_actual_sdk_valid_usage_stays_exact_after_observation(client, monkeypatch, endpoint):
    import new_meta.core.llm as llm_module

    before = len(llm_module._LLM_USAGE_EVENTS)
    observed = []
    usage = {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8} if endpoint == "chat" else {
        "input_tokens": 3, "output_tokens": 5, "total_tokens": 8}
    attach_sdk_transport(client, monkeypatch, endpoint, lambda request:
                         httpx.Response(200, json=sdk_json_response(endpoint, '{"fields":[]}', usage)))

    def observe(row):
        assert len(llm_module._LLM_USAGE_EVENTS) == before
        observed.append(dict(row))

    client.structured_output([{"role": "user", "content": "Assess."}], Payload,
        source_faithful=True, on_raw_response=observe)
    event = llm_module._LLM_USAGE_EVENTS[-1]
    assert len(observed) == 1
    assert (event["prompt_tokens"], event["completion_tokens"], event["total_tokens"]) == (3, 5, 8)
    assert event["stream"] is False
