import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel

import new_meta.core.llm as llm_module
from new_meta.core.llm import (
    LLMClient,
    get_llm_usage_manifest,
    llm_usage_scope,
    reset_llm_usage,
    write_llm_usage_manifest,
    _dashscope_extra_body,
    _repair_json_text,
)
from new_meta.core.project import Project
from new_meta.schemas.study import OutcomeData, StudyCharacteristics


def test_study_characteristics_coerces_llm_list_and_mapping_shapes() -> None:
    parsed = StudyCharacteristics.model_validate({
        "country": ["United Kingdom", "United States"],
        "sample_size_intervention": {"fixed-dose": 137, "shock-dependent": 146},
        "sample_size_control": "101",
    })

    assert parsed.country == "United Kingdom; United States"
    assert parsed.sample_size_intervention == 283
    assert parsed.sample_size_control == 101


def test_outcome_data_sums_count_mappings_for_combined_arms() -> None:
    parsed = OutcomeData.model_validate({
        "outcome_name": "In-hospital all-cause mortality",
        "events_intervention": {"fixed-dose": 29, "shock-dependent": 49},
        "total_intervention": {"fixed-dose": 137, "shock-dependent": 141},
        "events_control": 33,
        "total_control": 101,
    })

    assert parsed.events_intervention == 78
    assert parsed.total_intervention == 278
    assert parsed.events_control == 33


def test_outcome_data_never_turns_rates_into_event_counts() -> None:
    parsed = OutcomeData.model_validate({
        "outcome_name": "28-day mortality",
        "events_intervention": "29.3%",
        "total_intervention": "324",
        "events_control": 41.4,
        "total_control": "683.0",
    })

    assert parsed.events_intervention is None
    assert parsed.events_control is None
    assert parsed.total_intervention == 324
    assert parsed.total_control == 683
    assert {note.field for note in parsed.conflicts} == {"events_intervention", "events_control"}


def test_outcome_data_uses_explicit_events_not_denominator_from_rate_mapping() -> None:
    parsed = OutcomeData.model_validate({
        "outcome_name": "28-day mortality",
        "events_intervention": {
            "rate": "29.3%",
            "denominator": 324,
        },
        "events_control": {
            "rate": "40.7%",
            "events": 278,
            "total": 683,
        },
        "total_control": {
            "rate": "40.7%",
            "denominator": 683,
        },
    })

    assert parsed.events_intervention is None
    assert parsed.events_control == 278
    assert parsed.total_control == 683
    assert [note.field for note in parsed.conflicts] == ["events_intervention"]


def test_outcome_data_sums_nested_arm_event_and_total_mappings() -> None:
    parsed = OutcomeData.model_validate({
        "outcome_name": "In-hospital all-cause mortality",
        "events_intervention": {
            "fixed-dose": {"events": 29, "total": 137},
            "shock-dependent": {"events": 49, "total": 141},
        },
        "total_intervention": {
            "fixed-dose": {"events": 29, "total": 137},
            "shock-dependent": {"events": 49, "total": 141},
        },
    })

    assert parsed.events_intervention == 78
    assert parsed.total_intervention == 278


def test_outcome_data_drops_multi_value_continuous_scalars_instead_of_summing() -> None:
    parsed = OutcomeData.model_validate({
        "outcome_name": "Ventilator-free days",
        "outcome_type": "continuous",
        "median_intervention": [0, 0, 0],
        "q1_intervention": [-1, -1, -1],
        "q3_intervention": [15, 13, 11],
        "median_control": [0],
    })

    assert parsed.median_intervention is None
    assert parsed.q1_intervention is None
    assert parsed.q3_intervention is None
    assert parsed.median_control == 0


def test_repair_json_extracts_balanced_object_and_removes_trailing_commas() -> None:
    repaired = _repair_json_text('Here is the JSON:\n{"outcomes": [{"a": 1,},],}\nDone.')

    assert json.loads(repaired) == {"outcomes": [{"a": 1}]}


def test_dashscope_extra_body_carries_search_and_non_thinking_flags() -> None:
    body = _dashscope_extra_body(
        enable_search=True,
        enable_thinking=False,
        force_search=True,
        search_strategy="agent_max",
    )

    assert body == {
        "enable_thinking": False,
        "enable_search": True,
        "search_options": {
            "forced_search": True,
            "search_strategy": "agent_max",
        },
    }


def test_deepseek_v4_thinking_uses_provider_contract_without_temperature() -> None:
    class Choice:
        class Message:
            content = "answer"

        message = Message()
        finish_reason = "stop"

    class Response:
        choices = [Choice()]
        usage = None

    client = LLMClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
    )
    client.enable_thinking = True
    client.reasoning_effort = "high"
    client.stream = False
    captured = {}

    def chat_create(**kwargs):
        captured.update(kwargs)
        return Response()

    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "hello"}], max_tokens=128) == "answer"
    assert "temperature" not in captured
    assert captured["reasoning_effort"] == "high"
    assert captured["extra_body"] == {"thinking": {"type": "enabled"}}


def test_deepseek_v4_default_thinking_is_enabled_when_config_is_unspecified() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-v4-pro",
    )
    client.enable_thinking = None
    client.reasoning_effort = "high"

    assert client._chat_extra_body(model="deepseek-v4-pro") == {
        "thinking": {"type": "enabled"},
    }
    assert client._chat_reasoning_effort(model="deepseek-v4-pro") == "high"
    assert client._chat_supports_temperature(model="deepseek-v4-pro") is False


def test_deepseek_v4_can_disable_thinking_and_restore_temperature() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
    )
    client.enable_thinking = False
    client.reasoning_effort = "high"

    assert client._chat_extra_body(model="deepseek-v4-flash") == {
        "thinking": {"type": "disabled"},
    }
    assert client._chat_reasoning_effort(model="deepseek-v4-flash") is None
    assert client._chat_supports_temperature(model="deepseek-v4-flash") is True


def test_non_deepseek_chat_contract_remains_unchanged() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://example.test/v1",
        model="example-model",
    )
    client.enable_thinking = True
    client.reasoning_effort = "high"

    assert client._chat_extra_body(model="example-model") is None
    assert client._chat_reasoning_effort(model="example-model") is None
    assert client._chat_supports_temperature(model="example-model") is True


def test_llm_client_uses_chat_completions_search_for_dashscope_qwen36_by_default() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True
    client.enable_thinking = None
    client.use_responses_api = False

    assert client._should_use_responses_api(
        model="qwen3.6-plus",
        messages=[{"role": "user", "content": "latest trial results"}],
        response_format=None,
    ) is False
    assert client._chat_extra_body(model="qwen3.6-plus") == {
        "enable_search": True,
    }


def test_llm_client_can_opt_into_responses_api_for_dashscope_qwen36_search() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True
    client.use_responses_api = True

    assert client._should_use_responses_api(
        model="qwen3.6-plus",
        messages=[{"role": "user", "content": "latest trial results"}],
        response_format=None,
    ) is True
    assert (client._chat_extra_body(model="qwen3.6-plus") or {}).get("enable_search") is not True


def test_llm_client_keeps_chat_completions_for_structured_output_even_on_dashscope() -> None:
    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True

    assert client._should_use_responses_api(
        model="qwen3.6-plus",
        messages=[{"role": "user", "content": "latest trial results"}],
        response_format={"type": "json_object"},
    ) is False


def test_llm_client_falls_back_to_chat_search_when_dashscope_responses_needs_workspace() -> None:
    class Choice:
        class Message:
            content = "fallback ok"

        message = Message()
        finish_reason = "stop"

    class Response:
        choices = [Choice()]
        usage = None

    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True
    client.enable_thinking = False
    client.use_responses_api = True
    client.stream = False
    captured = {}

    def fail_responses(**kwargs):
        raise RuntimeError("Missing required parameter: 'workspaceid'")

    def chat_create(**kwargs):
        captured.update(kwargs)
        return Response()

    client.client.responses.create = fail_responses
    client.client.chat.completions.create = chat_create

    text = client.chat([{"role": "user", "content": "search please"}], max_tokens=128)

    assert text == "fallback ok"
    assert captured["model"] == "qwen3.6-plus"
    assert captured["extra_body"]["enable_search"] is True
    assert captured["extra_body"]["enable_thinking"] is False


def test_llm_client_disables_dashscope_responses_after_empty_fallback(monkeypatch) -> None:
    class EmptyResponsesOutput:
        output_text = ""
        status = "completed"
        usage = None

    class Choice:
        class Message:
            content = "fallback ok"

        message = Message()
        finish_reason = "stop"

    class ChatResponse:
        choices = [Choice()]
        usage = None

    monkeypatch.setattr("new_meta.core.llm.LLM_MAX_RETRIES", 1)
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    llm_module._RESPONSES_API_DISABLED_MODELS.clear()
    reset_llm_usage()
    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True
    client.use_responses_api = True
    client.stream = False
    response_calls = []
    chat_calls = []

    def responses_create(**kwargs):
        response_calls.append(kwargs)
        return EmptyResponsesOutput()

    def chat_create(**kwargs):
        chat_calls.append(kwargs)
        return ChatResponse()

    client.client.responses.create = responses_create
    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "first"}], max_tokens=128) == "fallback ok"
    assert client.chat([{"role": "user", "content": "second"}], max_tokens=128) == "fallback ok"

    assert len(response_calls) == 1
    assert len(chat_calls) == 2
    assert chat_calls[0]["extra_body"]["enable_search"] is True
    assert chat_calls[1]["extra_body"]["enable_search"] is True


def test_llm_client_uses_configured_granular_http_timeouts(monkeypatch) -> None:
    captured: dict = {}

    class FakeHTTPClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(llm_module, "LLM_CONNECT_TIMEOUT_SECONDS", 3.0)
    monkeypatch.setattr(llm_module, "LLM_READ_TIMEOUT_SECONDS", 31.0)
    monkeypatch.setattr(llm_module, "LLM_WRITE_TIMEOUT_SECONDS", 7.0)
    monkeypatch.setattr(llm_module, "LLM_POOL_TIMEOUT_SECONDS", 3.0)
    monkeypatch.setattr(llm_module.httpx, "Client", FakeHTTPClient)
    monkeypatch.setattr(llm_module, "OpenAI", FakeOpenAI)

    LLMClient(api_key="test-key", base_url="https://example.test/v1", model="qwen3.6-plus")

    timeout = captured["http_client"].kwargs["timeout"]
    assert timeout.connect == 3.0
    assert timeout.read == 31.0
    assert timeout.write == 7.0
    assert timeout.pool == 3.0


def test_dashscope_responses_empty_fallback_is_shared_across_clients(monkeypatch) -> None:
    class EmptyResponsesOutput:
        output_text = ""
        status = "completed"
        usage = None

    class Choice:
        class Message:
            content = "fallback ok"

        message = Message()
        finish_reason = "stop"

    class ChatResponse:
        choices = [Choice()]
        usage = None

    if hasattr(llm_module, "_RESPONSES_API_DISABLED_MODELS"):
        llm_module._RESPONSES_API_DISABLED_MODELS.clear()
    monkeypatch.setattr("new_meta.core.llm.LLM_MAX_RETRIES", 1)
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)

    first = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    first.enable_search = True
    first.use_responses_api = True
    first.stream = False
    first_responses_calls = []
    first_chat_calls = []

    def first_responses_create(**kwargs):
        first_responses_calls.append(kwargs)
        return EmptyResponsesOutput()

    def first_chat_create(**kwargs):
        first_chat_calls.append(kwargs)
        return ChatResponse()

    first.client.responses.create = first_responses_create
    first.client.chat.completions.create = first_chat_create

    assert first.chat([{"role": "user", "content": "first"}], max_tokens=128) == "fallback ok"

    second = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    second.enable_search = True
    second.use_responses_api = True
    second.stream = False
    second_responses_calls = []
    second_chat_calls = []

    def second_responses_create(**kwargs):
        second_responses_calls.append(kwargs)
        return EmptyResponsesOutput()

    def second_chat_create(**kwargs):
        second_chat_calls.append(kwargs)
        return ChatResponse()

    second.client.responses.create = second_responses_create
    second.client.chat.completions.create = second_chat_create

    assert second.chat([{"role": "user", "content": "second"}], max_tokens=128) == "fallback ok"

    assert len(first_responses_calls) == 1
    assert len(first_chat_calls) == 1
    assert second_responses_calls == []
    assert len(second_chat_calls) == 1
    assert second_chat_calls[0]["extra_body"]["enable_search"] is True


def test_dashscope_responses_empty_fallback_uses_short_retry_budget(monkeypatch) -> None:
    class EmptyResponsesOutput:
        output_text = ""
        status = "completed"
        usage = None

    class Choice:
        class Message:
            content = "fallback ok"

        message = Message()
        finish_reason = "stop"

    class ChatResponse:
        choices = [Choice()]
        usage = None

    if hasattr(llm_module, "_RESPONSES_API_DISABLED_MODELS"):
        llm_module._RESPONSES_API_DISABLED_MODELS.clear()
    monkeypatch.setattr("new_meta.core.llm.LLM_MAX_RETRIES", 5)
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)

    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.enable_search = True
    client.use_responses_api = True
    client.stream = False
    response_calls = []
    chat_calls = []

    def responses_create(**kwargs):
        response_calls.append(kwargs)
        return EmptyResponsesOutput()

    def chat_create(**kwargs):
        chat_calls.append(kwargs)
        return ChatResponse()

    client.client.responses.create = responses_create
    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "search"}], max_tokens=128) == "fallback ok"

    assert len(response_calls) == 2
    assert len(chat_calls) == 1
    assert chat_calls[0]["extra_body"]["enable_search"] is True


def test_llm_client_records_token_usage_and_estimated_cost_for_chat_completion() -> None:
    class Choice:
        class Message:
            content = "answer"

        message = Message()
        finish_reason = "stop"

    class Usage:
        prompt_tokens = 1000
        completion_tokens = 2000
        total_tokens = 3000

    class Response:
        choices = [Choice()]
        usage = Usage()

    reset_llm_usage()
    client = LLMClient(
        api_key="test-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen3.6-plus",
    )
    client.stream = False
    client.enable_search = False
    client.client.chat.completions.create = lambda **kwargs: Response()

    assert client.chat([{"role": "user", "content": "hello"}], max_tokens=4096) == "answer"

    manifest = get_llm_usage_manifest()
    assert manifest["summary"]["total_calls"] == 1
    assert manifest["summary"]["total_tokens"] == 3000
    assert manifest["summary"]["prompt_tokens"] == 1000
    assert manifest["summary"]["completion_tokens"] == 2000
    assert manifest["summary"]["estimated_cost_usd"] > 0
    event = manifest["events"][0]
    assert event["model"] == "qwen3.6-plus"
    assert event["endpoint"] == "chat.completions"
    assert event["prompt_tokens"] == 1000
    assert event["completion_tokens"] == 2000
    assert event["max_tokens"] == 4096
    assert event["cost_is_estimate"] is True


def test_llm_usage_manifest_summary_counts_output_reliability_risks() -> None:
    reset_llm_usage()
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="unknown-model")
    client._record_usage(
        model="unknown-model",
        endpoint="chat.completions",
        usage={"prompt_tokens": 10, "completion_tokens": 61, "total_tokens": 71},
        max_tokens=64,
        finish_reason="length",
        retryable_output_issue="truncated",
    )
    client._record_usage(
        model="unknown-model",
        endpoint="chat.completions",
        usage={"prompt_tokens": 9, "completion_tokens": 12, "total_tokens": 21},
        max_tokens=128,
        finish_reason="stop",
    )

    manifest = get_llm_usage_manifest()

    assert manifest["summary"]["near_truncation_events"] == 1
    assert manifest["summary"]["retryable_output_issues"] == 1
    assert manifest["summary"]["output_reliability_warnings"] == 1


def test_llm_client_retries_empty_chat_completion(monkeypatch) -> None:
    class Choice:
        def __init__(self, content: str):
            class Message:
                pass

            self.message = Message()
            self.message.content = content
            self.finish_reason = "stop"

    class Usage:
        prompt_tokens = 10
        completion_tokens = 0
        total_tokens = 10

    class Response:
        def __init__(self, content: str):
            self.choices = [Choice(content)]
            self.usage = Usage()

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.stream = False
    calls = []

    def chat_create(**kwargs):
        calls.append(kwargs)
        return Response("" if len(calls) == 1 else "recovered")

    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "hello"}], max_tokens=128) == "recovered"
    assert len(calls) == 2
    assert get_llm_usage_manifest()["summary"]["total_calls"] == 2


def test_llm_client_records_retryable_api_errors_in_usage_manifest(monkeypatch) -> None:
    class Choice:
        def __init__(self, content: str):
            class Message:
                pass

            self.message = Message()
            self.message.content = content
            self.finish_reason = "stop"

    class Usage:
        prompt_tokens = 6
        completion_tokens = 2
        total_tokens = 8

    class Response:
        choices = [Choice("recovered")]
        usage = Usage()

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.stream = False
    calls = []

    def chat_create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("temporary provider failure")
        return Response()

    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "hello"}], max_tokens=128) == "recovered"
    events = get_llm_usage_manifest()["events"]
    assert len(events) == 2
    assert events[0]["retryable_output_issue"] == "api_error"
    assert events[0]["error_type"] == "RuntimeError"
    assert "temporary provider failure" in events[0]["error_message"]
    assert events[1]["retryable_output_issue"] == ""


def test_llm_client_retries_truncated_chat_completion_with_more_tokens(monkeypatch) -> None:
    class Choice:
        def __init__(self, content: str, finish_reason: str):
            class Message:
                pass

            self.message = Message()
            self.message.content = content
            self.finish_reason = finish_reason

    class Usage:
        prompt_tokens = 25
        completion_tokens = 128
        total_tokens = 153

    class Response:
        def __init__(self, content: str, finish_reason: str):
            self.choices = [Choice(content, finish_reason)]
            self.usage = Usage()

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.stream = False
    calls = []

    def chat_create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return Response('{"answer":', "length")
        return Response('{"answer": 42}', "stop")

    client.client.chat.completions.create = chat_create

    assert client.chat([{"role": "user", "content": "hello"}], max_tokens=128) == '{"answer": 42}'
    assert len(calls) == 2
    assert calls[1]["max_tokens"] > calls[0]["max_tokens"]
    events = get_llm_usage_manifest()["events"]
    assert events[0]["finish_reason"] == "length"
    assert events[0]["retryable_output_issue"] == "truncated"


def test_llm_client_continues_truncated_text_completion_without_repeating(monkeypatch) -> None:
    class Choice:
        def __init__(self, content: str, finish_reason: str):
            class Message:
                pass

            self.message = Message()
            self.message.content = content
            self.finish_reason = finish_reason

    class Usage:
        prompt_tokens = 20
        completion_tokens = 64
        total_tokens = 84

    class Response:
        def __init__(self, content: str, finish_reason: str):
            self.choices = [Choice(content, finish_reason)]
            self.usage = Usage()

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.stream = False
    calls = []

    def chat_create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return Response("The methods section begins with eligibility criteria ", "length")
        return Response("and continues with statistical analysis details.", "stop")

    client.client.chat.completions.create = chat_create

    result = client.chat([{"role": "user", "content": "write a long methods section"}], max_tokens=64)

    assert result == (
        "The methods section begins with eligibility criteria "
        "and continues with statistical analysis details."
    )
    assert len(calls) == 2
    assert calls[1]["messages"][-2]["role"] == "assistant"
    assert calls[1]["messages"][-2]["content"].endswith("eligibility criteria ")
    assert "Continue exactly from where you stopped" in calls[1]["messages"][-1]["content"]
    events = get_llm_usage_manifest()["events"]
    assert events[0]["retryable_output_issue"] == "truncated"


def test_llm_client_continues_truncated_streaming_chat_completion(monkeypatch) -> None:
    class Delta:
        def __init__(self, content=None):
            self.content = content

    class Choice:
        def __init__(self, content=None, finish_reason=None):
            self.delta = Delta(content)
            self.finish_reason = finish_reason

    class Usage:
        prompt_tokens = 20
        completion_tokens = 64
        total_tokens = 84

    class Chunk:
        def __init__(self, content=None, finish_reason=None, usage=None):
            self.choices = [Choice(content, finish_reason)] if content is not None or finish_reason else []
            self.usage = usage

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.stream = True
    calls = []

    def chat_create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return [
                Chunk("First half of a long discussion "),
                Chunk(finish_reason="length"),
                Chunk(usage=Usage()),
            ]
        return [
            Chunk("continues cleanly to the conclusion."),
            Chunk(finish_reason="stop"),
            Chunk(usage=Usage()),
        ]

    client.client.chat.completions.create = chat_create

    result = client.chat([{"role": "user", "content": "write a long discussion"}], max_tokens=64)

    assert result == "First half of a long discussion continues cleanly to the conclusion."
    assert len(calls) == 2
    assert calls[1]["stream"] is True
    assert calls[1]["messages"][-2]["content"] == "First half of a long discussion "
    events = get_llm_usage_manifest()["events"]
    assert events[0]["finish_reason"] == "length"
    assert events[0]["retryable_output_issue"] == "truncated"


def test_write_llm_usage_manifest_persists_summary_to_project(tmp_path: Path) -> None:
    reset_llm_usage()
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="unknown-model")
    client._record_usage(
        model="unknown-model",
        endpoint="chat.completions",
        usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
        max_tokens=64,
        finish_reason="stop",
    )
    project = Project("llm usage", output_dir=tmp_path / uuid4().hex)

    path = write_llm_usage_manifest(project)

    assert path == project.base_dir / "llm_usage_manifest.json"
    saved = project.load_json("llm_usage_manifest.json")
    assert saved["summary"]["total_calls"] == 1
    assert saved["summary"]["total_tokens"] == 18
    assert saved["summary"]["estimated_cost_usd"] == 0
    assert saved["events"][0]["price_source"] == "unpriced"


def test_write_llm_usage_manifest_preserves_existing_project_manifest_on_resume_without_new_calls(tmp_path: Path) -> None:
    reset_llm_usage()
    project = Project("llm resume usage", output_dir=tmp_path / uuid4().hex)
    project.save_json(
        "llm_usage_manifest.json",
        {
            "schema_version": 1,
            "project_dir": str(project.base_dir),
            "summary": {
                "total_calls": 1,
                "prompt_tokens": 10,
                "completion_tokens": 4,
                "total_tokens": 14,
                "estimated_cost_usd": 0.001,
                "cost_is_estimate": True,
            },
            "by_model": {"qwen3.6-plus": {"calls": 1, "total_tokens": 14}},
            "events": [
                {
                    "timestamp": "2026-05-23T00:00:00Z",
                    "project_dir": str(project.base_dir),
                    "model": "qwen3.6-plus",
                    "endpoint": "chat.completions",
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "total_tokens": 14,
                    "retryable_output_issue": "",
                }
            ],
        },
    )

    write_llm_usage_manifest(project)

    saved = project.load_json("llm_usage_manifest.json")
    assert saved["summary"]["total_calls"] == 1
    assert saved["summary"]["total_tokens"] == 14
    assert saved["events"][0]["model"] == "qwen3.6-plus"


def test_write_llm_usage_manifest_merges_existing_project_manifest_with_resume_calls(tmp_path: Path) -> None:
    reset_llm_usage()
    project = Project("llm resume merge", output_dir=tmp_path / uuid4().hex)
    project.save_json(
        "llm_usage_manifest.json",
        {
            "schema_version": 1,
            "project_dir": str(project.base_dir),
            "summary": {
                "total_calls": 1,
                "prompt_tokens": 10,
                "completion_tokens": 4,
                "total_tokens": 14,
                "estimated_cost_usd": 0.001,
                "cost_is_estimate": True,
            },
            "by_model": {"qwen3.6-plus": {"calls": 1, "total_tokens": 14}},
            "events": [
                {
                    "timestamp": "2026-05-23T00:00:00Z",
                    "project_dir": str(project.base_dir),
                    "model": "qwen3.6-plus",
                    "endpoint": "chat.completions",
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "total_tokens": 14,
                    "retryable_output_issue": "",
                }
            ],
        },
    )
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="qwen3.6-plus")
    client._record_usage(
        model="qwen3.6-plus",
        endpoint="chat.completions",
        usage={"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
        max_tokens=64,
        finish_reason="stop",
    )

    write_llm_usage_manifest(project)

    saved = project.load_json("llm_usage_manifest.json")
    assert saved["summary"]["total_calls"] == 2
    assert saved["summary"]["total_tokens"] == 24
    assert [event["total_tokens"] for event in saved["events"]] == [14, 10]


def test_write_llm_usage_manifest_keeps_project_scopes_isolated(tmp_path: Path) -> None:
    reset_llm_usage()
    project_a = Project("usage a", output_dir=tmp_path / "a")
    project_b = Project("usage b", output_dir=tmp_path / "b")
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="unknown-model")

    with llm_usage_scope(project_a):
        client._record_usage(
            model="model-a",
            endpoint="chat.completions",
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            max_tokens=64,
            finish_reason="stop",
        )
    with llm_usage_scope(project_b):
        client._record_usage(
            model="model-b",
            endpoint="chat.completions",
            usage={"prompt_tokens": 20, "completion_tokens": 7, "total_tokens": 27},
            max_tokens=64,
            finish_reason="stop",
        )

    write_llm_usage_manifest(project_a)
    write_llm_usage_manifest(project_b)

    saved_a = project_a.load_json("llm_usage_manifest.json")
    saved_b = project_b.load_json("llm_usage_manifest.json")
    assert saved_a["summary"]["total_calls"] == 1
    assert saved_a["summary"]["total_tokens"] == 15
    assert saved_a["events"][0]["model"] == "model-a"
    assert saved_a["events"][0]["project_dir"] == str(project_a.base_dir)
    assert saved_b["summary"]["total_calls"] == 1
    assert saved_b["summary"]["total_tokens"] == 27
    assert saved_b["events"][0]["model"] == "model-b"
    assert saved_b["events"][0]["project_dir"] == str(project_b.base_dir)


def test_project_creation_sets_default_llm_usage_scope(tmp_path: Path) -> None:
    reset_llm_usage()
    project = Project("scoped run", output_dir=tmp_path / uuid4().hex)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="unknown-model")

    client._record_usage(
        model="auto-scoped-model",
        endpoint="chat.completions",
        usage={"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
        max_tokens=64,
        finish_reason="stop",
    )
    write_llm_usage_manifest(project)

    saved = project.load_json("llm_usage_manifest.json")
    assert saved["summary"]["total_calls"] == 1
    assert saved["events"][0]["model"] == "auto-scoped-model"
    assert saved["events"][0]["project_dir"] == str(project.base_dir)


def test_llm_usage_manifest_includes_worker_thread_events_for_client_scope(tmp_path: Path) -> None:
    reset_llm_usage()
    project = Project("threaded usage", output_dir=tmp_path / uuid4().hex)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")

    client._record_usage(
        model="test-model",
        endpoint="chat.completions",
        usage={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        max_tokens=64,
        finish_reason="stop",
    )

    def record_from_worker() -> None:
        client._record_usage(
            model="test-model",
            endpoint="chat.completions",
            usage={"prompt_tokens": 7, "completion_tokens": 11, "total_tokens": 18},
            max_tokens=64,
            finish_reason="stop",
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(record_from_worker).result()

    write_llm_usage_manifest(project)
    saved = project.load_json("llm_usage_manifest.json")

    assert saved["summary"]["total_calls"] == 2
    assert saved["summary"]["total_tokens"] == 23
    assert {event["project_dir"] for event in saved["events"]} == {str(project.base_dir)}


def test_collect_streaming_response_text_concatenates_deltas() -> None:
    class Event:
        def __init__(self, event_type, delta="", response=None):
            self.type = event_type
            self.delta = delta
            self.response = response

    text = LLMClient._collect_streaming_response_text(
        [
            Event("response.output_text.delta", "Hello "),
            Event("response.output_text.delta", "world"),
            Event("response.completed"),
        ]
    )

    assert text == "Hello world"


def test_llm_client_retries_streaming_responses_incomplete_with_more_tokens(monkeypatch) -> None:
    class Usage:
        prompt_tokens = 11
        completion_tokens = 64
        total_tokens = 75

    class Response:
        def __init__(self, status):
            self.status = status
            self.usage = Usage()

    class Event:
        def __init__(self, event_type, delta="", response=None):
            self.type = event_type
            self.delta = delta
            self.response = response

    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    client.use_responses_api = True
    client.stream = True
    client.enable_search = False
    calls = []

    def responses_create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return [
                Event("response.output_text.delta", "partial answer "),
                Event("response.incomplete", response=Response("incomplete")),
            ]
        return [
            Event("response.output_text.delta", "complete answer"),
            Event("response.completed", response=Response("completed")),
        ]

    client.client.responses.create = responses_create

    assert client.chat([{"role": "user", "content": "write a complete answer"}], max_tokens=64) == "complete answer"
    assert len(calls) == 2
    assert calls[1]["max_output_tokens"] > calls[0]["max_output_tokens"]
    events = get_llm_usage_manifest()["events"]
    assert events[0]["endpoint"] == "responses"
    assert events[0]["finish_reason"] == "incomplete"
    assert events[0]["retryable_output_issue"] == "status:incomplete"
    assert events[0]["total_tokens"] == 75


def test_collect_streaming_chat_completion_text_concatenates_deltas_and_usage() -> None:
    class Delta:
        def __init__(self, content):
            self.content = content

    class Choice:
        def __init__(self, content):
            self.delta = Delta(content)

    class Usage:
        total_tokens = 17

    class Chunk:
        def __init__(self, content=None, usage=None):
            self.choices = [Choice(content)] if content is not None else []
            self.usage = usage

    text, usage, finish_reason = LLMClient._collect_streaming_chat_completion_text(
        [
            Chunk("Hello "),
            Chunk("world"),
            Chunk(None, Usage()),
        ]
    )

    assert text == "Hello world"
    assert usage["total_tokens"] == 17
    assert finish_reason is None


def test_structured_output_retries_with_json_repair_prompt_after_parse_failure() -> None:
    class Payload(BaseModel):
        answer: int

    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    calls = []

    def fake_call(messages, **kwargs):
        calls.append({
            "messages": messages,
            "kwargs": kwargs,
        })
        if len(calls) == 1:
            return '{"answer": "not an integer"}'
        return '{"answer": 42}'

    client._call = fake_call

    parsed = client.structured_output(
        [{"role": "user", "content": "Return the answer."}],
        Payload,
    )

    assert parsed.answer == 42
    assert len(calls) == 2
    assert "repair" in calls[1]["messages"][-1]["content"].lower()
    assert "Return ONLY corrected JSON" in calls[1]["messages"][-1]["content"]


def test_structured_output_retries_original_prompt_with_more_tokens_for_incomplete_json() -> None:
    class Payload(BaseModel):
        answer: int

    client = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="test-model")
    calls = []

    def fake_call(messages, **kwargs):
        calls.append({
            "messages": messages,
            "kwargs": kwargs,
        })
        if len(calls) == 1:
            return '{"answer":'
        return '{"answer": 42}'

    client._call = fake_call

    parsed = client.structured_output(
        [{"role": "user", "content": "Return the answer."}],
        Payload,
        max_tokens=128,
    )

    assert parsed.answer == 42
    assert len(calls) == 2
    assert calls[1]["kwargs"]["max_tokens"] > calls[0]["kwargs"]["max_tokens"]
    assert calls[1]["messages"][-1]["content"].startswith("Return the answer.")
    assert "Previous response was incomplete" in calls[1]["messages"][-1]["content"]
