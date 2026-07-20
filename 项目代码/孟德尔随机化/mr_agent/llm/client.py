# [IN] models.py
# [OUT] LLM responses (text, structured)
# [POS] mr_agent/llm/client.py - DeepSeek V4 API abstraction
"""DeepSeek V4 client with structured output and tiered model routing."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

MAX_RETRIES = 5
RETRY_DELAY = 3.0


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

        self.flash_model = os.getenv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash")
        self.pro_model = model or os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro")
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

    def effective_max_tokens(self, model: str, answer_tokens: int) -> int:
        """Reserve room for Pro reasoning while preserving the answer budget."""
        if model != self.pro_model:
            return answer_tokens
        return min(
            self.max_output_tokens,
            max(
                answer_tokens * 2,
                answer_tokens + self.pro_reasoning_reserve_tokens,
            ),
        )

    def expanded_max_tokens(self, model: str, current_tokens: int) -> int:
        """Expand a truncated Pro request once, without exceeding the API cap."""
        if model != self.pro_model:
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
        return self._with_retry(
            lambda: self._chat_openai(
                messages,
                system,
                temperature,
                max_tokens,
                model,
                json_mode,
            )
        )

    def _chat_openai(
        self,
        messages: list[dict[str, str]],
        system: str,
        temperature: float,
        max_tokens: int,
        model: str,
        json_mode: bool,
    ) -> str:
        """Call the DeepSeek OpenAI-compatible Chat Completions API."""
        start_time = time.perf_counter()
        client = self._get_openai_client()
        request_max_tokens = self.effective_max_tokens(model, max_tokens)
        all_messages: list[dict[str, str]] = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)

        is_pro = model == self.pro_model
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": all_messages,
            "max_tokens": request_max_tokens,
            "extra_body": {
                "thinking": {"type": "enabled" if is_pro else "disabled"}
            },
        }
        if is_pro:
            kwargs["reasoning_effort"] = "high"
        else:
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        budgets = [request_max_tokens]
        expanded_tokens = self.expanded_max_tokens(model, request_max_tokens)
        if expanded_tokens > request_max_tokens:
            budgets.append(expanded_tokens)

        last_issue = ""
        for budget in budgets:
            kwargs["max_tokens"] = budget
            response = client.chat.completions.create(**kwargs)
            choice = response.choices[0]
            content = choice.message.content
            finish_reason = getattr(choice, "finish_reason", None)
            if finish_reason == "length":
                last_issue = (
                    "DeepSeek response was truncated "
                    f"(model={model}, request_max_tokens={budget})"
                )
                continue
            if not content or not content.strip():
                last_issue = (
                    "DeepSeek returned empty content "
                    f"(model={model}, request_max_tokens={budget})"
                )
                continue
            logger.info(
                "DeepSeek call completed: service=mendelian_randomization "
                "model=%s tier=%s thinking=%s latency_seconds=%.3f "
                "input_tokens=%s output_tokens=%s finish_reason=%s",
                model,
                "pro" if is_pro else "flash",
                "enabled" if is_pro else "disabled",
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
        logger.warning("DeepSeek call failed (attempt %s): %s", attempt + 1, error)
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
