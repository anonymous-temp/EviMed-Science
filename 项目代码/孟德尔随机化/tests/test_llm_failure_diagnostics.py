"""Observe the existing retry policy without recording provider text or secrets."""
import json
from types import SimpleNamespace

import httpx
import openai
import pytest

from mr_agent.llm.client import LLMClient


def client_with(monkeypatch, create):
    monkeypatch.setattr("mr_agent.llm.client.time.sleep", lambda _: None)
    client = LLMClient(api_key="synthetic-secret-never-retain")
    client._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return client


def response(content="", finish="length"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish)],
        usage=SimpleNamespace(prompt_tokens=120, completion_tokens=6096, total_tokens=6216,
                              completion_tokens_details=SimpleNamespace(reasoning_tokens=6000)),
    )


@pytest.mark.parametrize("finish,content,category", [
    ("length", "synthetic-private-provider-content", "truncated"),
    ("stop", "", "empty_content"),
])
def test_failed_responses_retain_bounded_observations_without_changing_budgets(
    monkeypatch, caplog, finish, content, category,
):
    budgets = []

    def create(**kwargs):
        budgets.append(kwargs["max_tokens"])
        return response(content, finish)

    client = client_with(monkeypatch, create)
    with pytest.raises(RuntimeError) as caught:
        client.chat([{"role": "user", "content": "synthetic-private-prompt"}], max_tokens=2000)

    assert budgets == [6096, 12192] * 5
    diagnostic = caught.value.mr_diagnostics
    assert diagnostic["sdk_call_attempts"] == 10
    assert diagnostic["category"] == category
    calls = diagnostic["calls"]
    assert len(calls) == 10
    assert [row["sdk_call"] for row in calls] == list(range(1, 11))
    assert [row["retry_attempt"] for row in calls] == [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
    assert calls[-1]["request_max_tokens"] == 12192
    assert calls[-1]["finish_reason"] == finish
    assert calls[-1]["content_present"] is bool(content)
    assert calls[-1]["prompt_tokens"] == 120
    assert calls[-1]["reasoning_tokens"] == 6000
    assert calls[-1]["status_code"] is None  # The parsed SDK response exposes no HTTP status.
    retained = json.dumps(diagnostic) + caplog.text
    assert "synthetic-secret" not in retained
    assert "synthetic-private" not in retained


@pytest.mark.parametrize("kind,status,category", [
    ("http", 401, "http_error"), ("http", 429, "http_error"),
    ("http", 503, "http_error"), ("timeout", None, "timeout"),
])
def test_transport_failure_records_only_typed_fields(monkeypatch, caplog, kind, status, category):
    request = httpx.Request("POST", "https://example.invalid", headers={"Authorization": "synthetic-secret"})
    if kind == "http":
        error = openai.APIStatusError("synthetic-private-error", response=httpx.Response(status, request=request),
                                      body={"secret": "synthetic-secret"})
    else:
        error = openai.APITimeoutError(request=request)

    def fail(**_kwargs):
        raise error

    client = client_with(monkeypatch, fail)
    with pytest.raises(type(error)) as caught:
        client.chat([{"role": "user", "content": "synthetic-private-prompt"}], max_tokens=2000)

    diagnostic = caught.value.mr_diagnostics
    assert diagnostic["sdk_call_attempts"] == 5
    assert diagnostic["category"] == category
    assert all(row["status_code"] == status for row in diagnostic["calls"])
    assert all(row["content_present"] is None for row in diagnostic["calls"])
    assert "synthetic-private" not in json.dumps(diagnostic) + caplog.text
    assert "synthetic-secret" not in json.dumps(diagnostic) + caplog.text


def test_success_after_truncation_keeps_existing_two_request_behavior(monkeypatch):
    budgets = []

    def create(**kwargs):
        budgets.append(kwargs["max_tokens"])
        return response("partial", "length") if len(budgets) == 1 else response("complete", "stop")

    client = client_with(monkeypatch, create)
    assert client.chat([], max_tokens=2000) == "complete"
    assert budgets == [6096, 12192]


@pytest.mark.parametrize("value", [
    SimpleNamespace(choices=[]),
    SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=123), finish_reason="stop")]),
])
def test_invalid_response_still_counts_the_observed_sdk_call(monkeypatch, value):
    client = client_with(monkeypatch, lambda **kwargs: value)
    with pytest.raises((IndexError, AttributeError)) as caught:
        client.chat([], max_tokens=2000)
    assert caught.value.mr_diagnostics["sdk_call_attempts"] == 5
    assert caught.value.mr_diagnostics["category"] == "response_error"


def test_unusable_usage_values_are_not_coerced_into_observed_counts(monkeypatch):
    value = response("", "length")
    value.usage = SimpleNamespace(prompt_tokens=True, completion_tokens="synthetic-secret", total_tokens=-1)
    client = client_with(monkeypatch, lambda **kwargs: value)
    with pytest.raises(RuntimeError) as caught:
        client.chat([], max_tokens=2000)
    last = caught.value.mr_diagnostics["calls"][-1]
    assert last["prompt_tokens"] is last["completion_tokens"] is last["total_tokens"] is None
    assert "synthetic-secret" not in json.dumps(caught.value.mr_diagnostics)
