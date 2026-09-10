"""DeepSeek client tests: parsing, JSON/schema validation, retry, errors.

All HTTP is mocked with respx; no real API key is used.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx
from pydantic import BaseModel

from safety_agent.core.exceptions import (
    LLMAuthError,
    LLMError,
    LLMRateLimited,
    LLMResponseError,
)
from safety_agent.llm.client import DeepSeekClient

BASE = "https://api.deepseek.com"


class _Schema(BaseModel):
    answer: str
    score: int


def _payload(content: str) -> dict:
    return {
        "id": "chatcmpl-1",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2},
    }


def _client(**overrides) -> DeepSeekClient:
    return DeepSeekClient(
        "test-key-not-real", BASE, backoff_initial=0.01, backoff_cap=0.02, **overrides
    )


@respx.mock
async def test_complete_returns_content_and_sends_auth():
    route = respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(200, json=_payload("PONG"))
    )
    async with _client() as llm:
        out = await llm.complete([{"role": "user", "content": "ping"}], tier="flash")
    assert out == "PONG"
    request = route.calls[0].request
    assert request.headers["Authorization"] == "Bearer test-key-not-real"
    assert '"model": "deepseek-flash"' in request.content.decode() or (
        '"model":"deepseek-flash"' in request.content.decode()
    )


@respx.mock
async def test_pro_tier_uses_reasoner_model():
    route = respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(200, json=_payload("ok"))
    )
    async with _client(flash_model="flash-x", pro_model="pro-y") as llm:
        await llm.complete([{"role": "user", "content": "ping"}], tier="pro")
    assert "pro-y" in route.calls[0].request.content.decode()


@respx.mock
async def test_complete_json_strips_fences_and_validates():
    fenced = '```json\n{"answer": "yes", "score": 7}\n```'
    respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(200, json=_payload(fenced))
    )
    async with _client() as llm:
        result = await llm.complete_json(
            [{"role": "user", "content": "give json"}], schema=_Schema
        )
    assert result.answer == "yes" and result.score == 7


@respx.mock
async def test_complete_json_repairs_once_then_succeeds():
    route = respx.post(f"{BASE}/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=_payload("not json at all")),
            httpx.Response(200, json=_payload('{"answer": "fixed", "score": 1}')),
        ]
    )
    async with _client() as llm:
        result = await llm.complete_json(
            [{"role": "user", "content": "give json"}], schema=_Schema
        )
    assert result.answer == "fixed"
    assert route.call_count == 2  # exactly one repair retry


@respx.mock
async def test_complete_json_two_bad_outputs_raise():
    route = respx.post(f"{BASE}/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=_payload('{"answer": "missing score"}')),
            httpx.Response(200, json=_payload("still not json")),
        ]
    )
    async with _client() as llm:
        with pytest.raises(LLMResponseError, match="repair retry"):
            await llm.complete_json([{"role": "user", "content": "x"}], schema=_Schema)
    assert route.call_count == 2


@respx.mock
async def test_schema_mismatch_triggers_retry():
    route = respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(200, json=_payload('{"wrong": "shape"}'))
    )
    async with _client() as llm:
        with pytest.raises(LLMResponseError):
            await llm.complete_json([{"role": "user", "content": "x"}], schema=_Schema)
    assert route.call_count == 2


@respx.mock
async def test_empty_content_raises():
    respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(200, json=_payload("   "))
    )
    async with _client() as llm:
        with pytest.raises(LLMResponseError, match="empty content"):
            await llm.complete([{"role": "user", "content": "x"}])


@respx.mock
async def test_401_fails_fast_without_retry():
    route = respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": {"message": "bad key"}})
    )
    async with _client() as llm:
        with pytest.raises(LLMAuthError):
            await llm.complete([{"role": "user", "content": "x"}])
    assert route.call_count == 1


@respx.mock
async def test_429_retries_then_succeeds():
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    route = respx.post(f"{BASE}/chat/completions").mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(200, json=_payload("PONG")),
        ]
    )
    async with _client(sleep=fake_sleep) as llm:
        out = await llm.complete([{"role": "user", "content": "x"}])
    assert out == "PONG"
    assert route.call_count == 2
    assert len(sleeps) == 1


@respx.mock
async def test_429_exhaustion_raises_rate_limited():
    async def fake_sleep(seconds: float) -> None:
        return None

    route = respx.post(f"{BASE}/chat/completions").mock(return_value=httpx.Response(429))
    async with _client(max_retries=2, sleep=fake_sleep) as llm:
        with pytest.raises(LLMRateLimited):
            await llm.complete([{"role": "user", "content": "x"}])
    assert route.call_count == 2


@respx.mock
async def test_other_4xx_fails_fast():
    route = respx.post(f"{BASE}/chat/completions").mock(
        return_value=httpx.Response(400, text="bad request")
    )
    async with _client() as llm:
        with pytest.raises(LLMError, match="HTTP 400"):
            await llm.complete([{"role": "user", "content": "x"}])
    assert route.call_count == 1


def test_empty_key_rejected():
    with pytest.raises(LLMAuthError):
        DeepSeekClient("", BASE)


@pytest.mark.parametrize("tier, thinking", [("flash", "disabled"), ("pro", "enabled")])
@respx.mock
async def test_shared_flash_model_preserves_logical_reasoning_tier(tier, thinking):
    route = respx.post(f"{BASE}/chat/completions").mock(return_value=httpx.Response(200, json=_payload("ok")))
    async with _client() as llm:
        await llm.complete([{"role": "user", "content": "ping"}], tier=tier, max_tokens=1000)
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "deepseek-flash"
    assert body["thinking"] == {"type": thinking}
    assert body["max_tokens"] == 1000
    assert ("temperature" in body) == (tier == "flash")
    assert body.get("reasoning_effort") == ("high" if tier == "pro" else None)



@pytest.mark.parametrize("policy", ["", "disabled", "high-thinking"])
@respx.mock
async def test_gateway_policy_reserves_flash_reasoning_without_affecting_direct_calls(monkeypatch, policy):
    monkeypatch.setenv("EVIMED_MODEL_GATEWAY_POLICY", policy)
    managed = policy == "high-thinking"
    route = respx.post(f"{BASE}/chat/completions").mock(return_value=httpx.Response(200, json=_payload("ok")))
    async with _client() as llm:
        assert await llm.complete([{"role": "user", "content": "ping"}], tier="flash", max_tokens=2000) == "ok"
    request = route.calls[0].request
    body = json.loads(request.content)
    assert body["model"] == "deepseek-flash"
    assert body["max_tokens"] == (6096 if managed else 2000)
    assert body["thinking"] == {"type": "enabled" if managed else "disabled"}
    assert body.get("reasoning_effort") == ("high" if managed else None)
    assert ("temperature" in body) is not managed
    assert request.extensions["timeout"]["read"] == (300.0 if managed else 120.0)


@respx.mock
async def test_gateway_flash_truncation_expands_once_then_rejects_partial_content(monkeypatch):
    monkeypatch.setenv("EVIMED_MODEL_GATEWAY_POLICY", "high-thinking")
    partial = _payload("partial")
    partial["choices"][0]["finish_reason"] = "length"
    route = respx.post(f"{BASE}/chat/completions").mock(return_value=httpx.Response(200, json=partial))
    async with _client() as llm:
        with pytest.raises(LLMResponseError, match="truncated"):
            await llm.complete([{"role": "user", "content": "ping"}], tier="flash", max_tokens=2000)
    assert [json.loads(call.request.content)["max_tokens"] for call in route.calls] == [6096, 12192]


@respx.mock
async def test_gateway_reasoning_budget_cap_prevents_duplicate_retry(monkeypatch):
    monkeypatch.setenv("EVIMED_MODEL_GATEWAY_POLICY", "high-thinking")
    monkeypatch.setenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "5000")
    partial = _payload("partial")
    partial["choices"][0]["finish_reason"] = "length"
    route = respx.post(f"{BASE}/chat/completions").mock(return_value=httpx.Response(200, json=partial))
    async with _client() as llm:
        with pytest.raises(LLMResponseError, match="truncated"):
            await llm.complete([{"role": "user", "content": "ping"}], tier="flash", max_tokens=4000)
    assert [json.loads(call.request.content)["max_tokens"] for call in route.calls] == [5000]


@respx.mock
async def test_gateway_flash_returns_complete_answer_after_expansion(monkeypatch):
    monkeypatch.setenv("EVIMED_MODEL_GATEWAY_POLICY", "high-thinking")
    partial = _payload("partial")
    partial["choices"][0]["finish_reason"] = "length"
    route = respx.post(f"{BASE}/chat/completions").mock(side_effect=[
        httpx.Response(200, json=partial), httpx.Response(200, json=_payload("complete")),
    ])
    async with _client() as llm:
        assert await llm.complete([{"role": "user", "content": "ping"}], tier="flash", max_tokens=2000) == "complete"
    assert [json.loads(call.request.content)["max_tokens"] for call in route.calls] == [6096, 12192]
