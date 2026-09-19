# [IN] models.py
# [OUT] LLM responses (text, structured)
# [POS] mr_agent/llm/client.py - DeepSeek V4 API abstraction
"""DeepSeek V4 client with structured output and tiered model routing."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

from dotenv import load_dotenv

from . import usage as provider_usage

load_dotenv()
logger = logging.getLogger(__name__)

MAX_RETRIES = 5
RETRY_DELAY = 3.0


def _safe_attribute(value, name):
    try:
        return getattr(value, name, None)
    except Exception:
        return None


def _counter(value):
    return value if type(value) is int and 0 <= value <= 1_000_000_000 else None


def _error_type(error):
    name = type(error).__name__
    return name if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name) else "Exception"


def _observe_call(calls, retry_attempt, budget, *, response=None, choice=None, error=None, category):
    """No message, request, provider body or exception text enters this record."""
    usage = _safe_attribute(response, "usage")
    details = _safe_attribute(usage, "completion_tokens_details")
    content = _safe_attribute(_safe_attribute(choice, "message"), "content")
    finish = _safe_attribute(choice, "finish_reason")
    if not isinstance(finish, str) or finish not in {"stop", "length", "content_filter", "tool_calls", "function_call"}:
        finish = None
    status = _safe_attribute(error if error is not None else response, "status_code")
    status = status if type(status) is int and 100 <= status <= 599 else None
    if error is not None:
        names = {cls.__name__ for cls in type(error).__mro__}
        category = ("http_error" if status is not None else "timeout" if names & {
            "TimeoutError", "APITimeoutError", "TimeoutException"} else
            "connection" if "APIConnectionError" in names else "response_error")
    if len(calls) >= 10:
        return
    calls.append({
        "sdk_call": len(calls) + 1, "retry_attempt": retry_attempt,
        "request_max_tokens": _counter(budget), "category": category,
        "error_type": _error_type(error) if error is not None else None,
        "status_code": status, "finish_reason": finish,
        "content_present": isinstance(content, str) and bool(content.strip()) if choice is not None else None,
        "prompt_tokens": _counter(_safe_attribute(usage, "prompt_tokens")),
        "completion_tokens": _counter(_safe_attribute(usage, "completion_tokens")),
        "total_tokens": _counter(_safe_attribute(usage, "total_tokens")),
        "reasoning_tokens": _counter(_safe_attribute(details, "reasoning_tokens")),
    })


class LLMClient:
    """DeepSeek V4 client with structured output and retry support."""

    def __init__(
        self,
        provider: str = "deepseek",
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ):
        self.provider = provider
        if self.provider != "deepseek":
            raise ValueError(f"Unsupported LLM provider: {self.provider}")

        self.flash_model = os.getenv("DEEPSEEK_FLASH_MODEL", "deepseek-flash")
        self.pro_model = model or os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-flash")
        self.pro_reasoning_reserve_tokens = int(
            os.getenv("DEEPSEEK_PRO_REASONING_RESERVE_TOKENS", "4096")
        )
        self.max_output_tokens = int(
            os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "384000")
        )
        self.pro_timeout_seconds = float(
            os.getenv("DEEPSEEK_PRO_TIMEOUT_SECONDS", "300")
        )
        self.api_key = api_key or os.getenv("DEEPSEEK_API_KEY", "")
        self.base_url = base_url or os.getenv(
            "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
        )
        # The managed launcher supplies the gateway policy independently of logical tier.
        self._gateway_high_thinking = os.getenv("EVIMED_MODEL_GATEWAY_POLICY") == "high-thinking"
        self._client = None
        self._validate_key()

    def _validate_key(self) -> None:
        """Fail fast if no API key is configured."""
        if not self.api_key:
            raise ValueError(
                "No API key found. Set DEEPSEEK_API_KEY or pass api_key parameter."
            )

    def model_for_tier(self, model_tier: str = "pro") -> str:
        """Select the DeepSeek V4 model for a validated task tier."""
        if model_tier == "flash":
            return self.flash_model
        if model_tier == "pro":
            return self.pro_model
        raise ValueError(f"Unsupported DeepSeek model tier: {model_tier}")

    def _uses_reasoning(self, model_tier: str) -> bool:
        return self._gateway_high_thinking or model_tier == "pro"

    def effective_max_tokens(self, model_tier: str, answer_tokens: int) -> int:
        """Reserve room for enabled reasoning while preserving the answer budget."""
        if not self._uses_reasoning(model_tier):
            return answer_tokens
        return min(
            self.max_output_tokens,
            max(
                answer_tokens * 2,
                answer_tokens + self.pro_reasoning_reserve_tokens,
            ),
        )

    def expanded_max_tokens(self, model_tier: str, current_tokens: int) -> int:
        """Expand a truncated reasoning request once, without exceeding the API cap."""
        if not self._uses_reasoning(model_tier):
            return current_tokens
        return min(self.max_output_tokens, current_tokens * 2)

    def _get_openai_client(self):
        if self._client is None:
            import httpx
            import openai

            self._client = openai.OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=self.pro_timeout_seconds,
                http_client=httpx.Client(
                    trust_env=False,
                    timeout=self.pro_timeout_seconds,
                ),
            )
        return self._client

    def chat(
        self,
        messages: list[dict[str, str]],
        system: str = "",
        temperature: float = 0.3,
        max_tokens: int = 4096,
        model_tier: str = "pro",
        json_mode: bool = False,
    ) -> str:
        """Send messages through the selected DeepSeek V4 tier."""
        model = self.model_for_tier(model_tier)
        observations = []
        retry_attempt = 0

        def call():
            nonlocal retry_attempt
            retry_attempt += 1
            return self._chat_openai(
                messages,
                system,
                temperature,
                max_tokens,
                model,
                json_mode,
                model_tier,
                observations=observations,
                retry_attempt=retry_attempt,
            )
        try:
            return self._with_retry(call)
        except Exception as error:
            error.mr_diagnostics = {
                "sdk_call_attempts": len(observations),
                "category": observations[-1]["category"] if observations else "client_error",
                "calls": observations,
            }
            raise

    def _chat_openai(
        self,
        messages: list[dict[str, str]],
        system: str,
        temperature: float,
        max_tokens: int,
        model: str,
        json_mode: bool,
        model_tier: str,
        *, observations: list | None = None, retry_attempt: int = 1,
    ) -> str:
        """Call the DeepSeek OpenAI-compatible Chat Completions API."""
        start_time = time.perf_counter()
        client = self._get_openai_client()
        request_max_tokens = self.effective_max_tokens(model_tier, max_tokens)
        all_messages: list[dict[str, str]] = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)

        thinking_enabled = self._uses_reasoning(model_tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": all_messages,
            "max_tokens": request_max_tokens,
            "extra_body": {
                "thinking": {"type": "enabled" if thinking_enabled else "disabled"}
            },
        }
        if thinking_enabled:
            kwargs["reasoning_effort"] = "high"
        else:
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        budgets = [request_max_tokens]
        expanded_tokens = self.expanded_max_tokens(model_tier, request_max_tokens)
        if expanded_tokens > request_max_tokens:
            budgets.append(expanded_tokens)

        last_issue = ""
        observations = [] if observations is None else observations
        for budget in budgets:
            kwargs["max_tokens"] = budget
            response = choice = None
            try:
                response = client.chat.completions.create(**kwargs)
                # Billed whether or not the answer is usable, a truncated one
                # included, so counted first (evimed_runner reports totals).
                provider_usage.record(getattr(response, "usage", None), model)
                choice = response.choices[0]
                content = choice.message.content
                finish_reason = getattr(choice, "finish_reason", None)
                empty_content = finish_reason != "length" and (not content or not content.strip())
            except Exception as error:
                _observe_call(observations, retry_attempt, budget, response=response, choice=choice,
                              error=error, category="response_error")
                raise
            if finish_reason == "length":
                _observe_call(observations, retry_attempt, budget, response=response, choice=choice,
                              category="truncated")
                last_issue = (
                    "DeepSeek response was truncated "
                    f"(model={model}, request_max_tokens={budget})"
                )
                continue
            if empty_content:
                _observe_call(observations, retry_attempt, budget, response=response, choice=choice,
                              category="empty_content")
                last_issue = (
                    "DeepSeek returned empty content "
                    f"(model={model}, request_max_tokens={budget})"
                )
                continue
            _observe_call(observations, retry_attempt, budget, response=response, choice=choice,
                          category="completed")
            logger.info(
                "DeepSeek call completed: service=mendelian_randomization "
                "model=%s tier=%s thinking=%s latency_seconds=%.3f "
                "input_tokens=%s output_tokens=%s finish_reason=%s",
                model,
                model_tier,
                "enabled" if thinking_enabled else "disabled",
                time.perf_counter() - start_time,
                getattr(getattr(response, "usage", None), "prompt_tokens", 0),
                getattr(getattr(response, "usage", None), "completion_tokens", 0),
                finish_reason,
            )
            return content
        raise RuntimeError(last_issue)

    def chat_json(
        self,
        messages: list[dict[str, str]],
        system: str = "",
        temperature: float = 0.1,
        max_tokens: int = 4096,
        model_tier: str = "pro",
    ) -> dict | list:
        """Request DeepSeek JSON output and parse it defensively."""
        if not system:
            system = "You are a helpful biomedical scientist."
        system = (
            "CRITICAL OUTPUT FORMAT: Respond with ONLY valid JSON. "
            "No markdown, no prose, no text outside the JSON object.\n\n"
            + system
        )
        raw = self.chat(
            messages,
            system,
            temperature,
            max_tokens,
            model_tier=model_tier,
            json_mode=True,
        )
        return self._extract_json(raw)

    def _extract_json(self, text: str) -> dict | list:
        """Robustly extract JSON from an LLM response."""
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        result = self._try_bracket_extraction(text)
        if result is not None:
            return result
        logger.warning("Failed to parse JSON from DeepSeek response")
        return {}

    def _try_bracket_extraction(self, text: str) -> dict | list | None:
        """Try extracting JSON by finding matching brackets."""
        for start_char, end_char in [("{", "}"), ("[", "]")]:
            start, end = text.find(start_char), text.rfind(end_char)
            if start == -1 or end <= start:
                continue
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
        return None

    def chat_structured(
        self,
        prompt: str,
        schema: dict[str, Any],
        system: str = "You are a helpful biomedical scientist.",
        temperature: float = 0.1,
        max_tokens: int = 4096,
        model_tier: str = "pro",
    ) -> dict:
        """Request and normalize structured DeepSeek JSON output."""
        raw = self.chat_json(
            [{"role": "user", "content": prompt}],
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            model_tier=model_tier,
        )
        return self._ensure_dict(raw, schema)

    def _ensure_dict(self, result: Any, schema: dict) -> dict:
        """Guarantee a dict, wrapping a bare list using the schema's array key."""
        if isinstance(result, dict):
            return result
        if isinstance(result, list):
            for key, definition in schema.get("properties", {}).items():
                if definition.get("type") == "array":
                    return {key: result}
            return {"items": result}
        return {}

    def _with_retry(self, fn, retries: int = MAX_RETRIES) -> Any:
        """Retry a call with exponential backoff."""
        last_error: Exception | None = None
        for attempt in range(max(retries, 1)):
            try:
                return fn()
            except Exception as error:
                last_error = error
                self._log_retry(attempt, retries, error)
        raise last_error  # type: ignore[misc]

    def _log_retry(self, attempt: int, retries: int, error: Exception) -> None:
        delay = RETRY_DELAY * (2**attempt)
        status = _safe_attribute(error, "status_code")
        status = status if type(status) is int and 100 <= status <= 599 else None
        logger.warning("DeepSeek call failed (attempt %s): type=%s status=%s", attempt + 1, _error_type(error), status)
        if attempt < retries - 1:
            time.sleep(delay)


def get_llm(
    provider: str | None = None,
    model: str | None = None,
    **kwargs,
) -> LLMClient:
    """Create the configured DeepSeek V4 client."""
    provider = provider or os.getenv("LLM_PROVIDER", "deepseek")
    return LLMClient(provider=provider, model=model, **kwargs)
