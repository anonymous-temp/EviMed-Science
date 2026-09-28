"""A DeepSeek thinking call's budget covers its reasoning, and truncation retries are bounded.

On 2026-09-28 a local run of brief ma-001 with the production model settings
(deepseek-flash, thinking, effort high) had its planning call truncated at
8,192 and then at 16,384 completion tokens, each a full generation discarded
before the retry doubled the budget, and nothing stopped a doubling past what
the provider accepts.
"""
from __future__ import annotations

import pytest

from new_meta.core import llm as llm_module
from new_meta.core.llm import LLMClient, LLMOutputError, reset_llm_usage


class _Usage:
    prompt_tokens = 10
    completion_tokens = 10
    total_tokens = 20


class _Response:
    def __init__(self, content: str, finish_reason: str):
        class Message:
            pass

        class Choice:
            pass

        choice = Choice()
        choice.message = Message()
        choice.message.content = content
        choice.finish_reason = finish_reason
        self.choices = [choice]
        self.usage = _Usage()


def _client(base_url="https://api.deepseek.com", thinking=True) -> LLMClient:
    client = LLMClient(api_key="test-key", base_url=base_url, model="deepseek-flash")
    client.enable_thinking = thinking
    client.stream = False
    return client


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    reset_llm_usage()
    monkeypatch.setattr("new_meta.core.llm.time.sleep", lambda seconds: None)
    monkeypatch.setattr(llm_module, "LLM_THINKING_MIN_MAX_TOKENS", 32768)
    monkeypatch.setattr(llm_module, "LLM_MAX_TOKENS_CAP", 65536)


def test_a_thinking_call_starts_at_the_floor_that_covers_its_reasoning() -> None:
    client = _client()
    calls = []
    client.client.chat.completions.create = lambda **kwargs: calls.append(kwargs) or _Response("ok", "stop")
    assert client.chat([{"role": "user", "content": "plan"}], max_tokens=8192) == "ok"
    assert calls[0]["max_tokens"] == 32768


def test_a_non_thinking_or_other_provider_call_keeps_its_budget() -> None:
    for client in (_client(thinking=False), _client(base_url="https://example.test/v1")):
        calls = []
        client.client.chat.completions.create = lambda **kwargs: calls.append(kwargs) or _Response("ok", "stop")
        client.chat([{"role": "user", "content": "plan"}], max_tokens=8192)
        assert calls[0]["max_tokens"] == 8192


def test_truncation_retries_stop_at_the_cap() -> None:
    client = _client()
    calls = []

    def always_truncated(**kwargs):
        calls.append(kwargs["max_tokens"])
        return _Response("partial", "length")

    client.client.chat.completions.create = always_truncated
    with pytest.raises(LLMOutputError, match="max_tokens=65536"):
        client.chat([{"role": "user", "content": "plan"}], max_tokens=8192)
    # 32,768 then 65,536, and no third identical generation at the cap.
    assert calls == [32768, 65536]


def test_the_expanded_budget_never_passes_the_cap() -> None:
    assert LLMClient._expanded_max_tokens(40000) == 65536
    assert LLMClient._expanded_max_tokens(65536) == 65536
    assert LLMClient._expanded_max_tokens(1024) == 2048
