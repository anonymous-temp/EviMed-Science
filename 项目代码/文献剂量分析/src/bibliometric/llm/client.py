"""Shared DeepSeek V4 client for sync, async, JSON, and streaming calls."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv


_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_ROOT / ".env", override=False)
load_dotenv(_ROOT / "deploy.env", override=False)

logger = logging.getLogger(__name__)


class DeepSeekClient:
    """One routing and reliability contract for all bibliometric LLM calls."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        flash_model: str | None = None,
        pro_model: str | None = None,
        pro_reasoning_reserve_tokens: int | None = None,
        max_output_tokens: int | None = None,
        pro_timeout_seconds: float | None = None,
    ):
        self.api_key = api_key if api_key is not None else os.getenv("DEEPSEEK_API_KEY", "")
        self.base_url = base_url or os.getenv(
            "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
        )
        self.flash_model = flash_model or os.getenv(
            "DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"
        )
        self.pro_model = pro_model or os.getenv(
            "DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"
        )
        self.pro_reasoning_reserve_tokens = (
            pro_reasoning_reserve_tokens
            if pro_reasoning_reserve_tokens is not None
            else int(os.getenv("DEEPSEEK_PRO_REASONING_RESERVE_TOKENS", "4096"))
        )
        self.max_output_tokens = (
            max_output_tokens
            if max_output_tokens is not None
            else int(os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "384000"))
        )
        self.pro_timeout_seconds = (
            pro_timeout_seconds
            if pro_timeout_seconds is not None
            else float(os.getenv("DEEPSEEK_PRO_TIMEOUT_SECONDS", "300"))
        )
        self.flash_timeout_seconds = float(
            os.getenv("DEEPSEEK_FLASH_TIMEOUT_SECONDS", "60")
        )
        self._sync_client = None
        self._async_client = None

    @classmethod
    def from_config(cls, config) -> "DeepSeekClient":
        """Build a client from the bibliometric Config dataclass."""
        return cls(
            api_key=config.deepseek_api_key,
            base_url=config.deepseek_base_url,
            flash_model=config.deepseek_flash_model,
            pro_model=config.deepseek_pro_model,
            pro_reasoning_reserve_tokens=config.deepseek_pro_reasoning_reserve_tokens,
            max_output_tokens=config.deepseek_max_output_tokens,
            pro_timeout_seconds=config.deepseek_pro_timeout_seconds,
        )

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _require_key(self) -> None:
        if not self.api_key:
            raise ValueError("DEEPSEEK_API_KEY is not configured")

    def model_for_tier(self, tier: str = "pro") -> str:
        if tier == "flash":
            return self.flash_model
        if tier == "pro":
            return self.pro_model
        raise ValueError(f"Unsupported DeepSeek model tier: {tier}")

    def effective_max_tokens(self, model: str, answer_tokens: int) -> int:
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
        if model != self.pro_model:
            return current_tokens
        return min(self.max_output_tokens, current_tokens * 2)

    def _get_sync_client(self):
        self._require_key()
        if self._sync_client is None:
            import httpx
            from openai import OpenAI

            self._sync_client = OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                http_client=httpx.Client(
                    trust_env=False,
                    timeout=self.pro_timeout_seconds,
                ),
            )
        return self._sync_client

    def _get_async_client(self):
        self._require_key()
        if self._async_client is None:
            import httpx
            from openai import AsyncOpenAI

            self._async_client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                http_client=httpx.AsyncClient(
                    trust_env=False,
                    timeout=self.pro_timeout_seconds,
                ),
            )
        return self._async_client

    def _request_kwargs(
        self,
        messages: list[dict[str, str]],
        *,
        tier: str,
        temperature: float,
        max_tokens: int,
        json_mode: bool,
        stream: bool,
    ) -> tuple[str, dict[str, Any]]:
        model = self.model_for_tier(tier)
        is_pro = model == self.pro_model
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": self.effective_max_tokens(model, max_tokens),
            "stream": stream,
            "timeout": (
                self.pro_timeout_seconds if is_pro else self.flash_timeout_seconds
            ),
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
        if stream:
            kwargs["stream_options"] = {"include_usage": True}
        return model, kwargs

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        tier: str = "pro",
        temperature: float = 0.3,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        """Run a synchronous completion with one Pro truncation expansion."""
        start_time = time.perf_counter()
        model, kwargs = self._request_kwargs(
            messages,
            tier=tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
            stream=False,
        )
        budgets = [kwargs["max_tokens"]]
        expanded = self.expanded_max_tokens(model, kwargs["max_tokens"])
        if expanded > kwargs["max_tokens"]:
            budgets.append(expanded)

        last_issue = ""
        client = self._get_sync_client()
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
            self._log_completion(
                model, tier, finish_reason, response, time.perf_counter() - start_time
            )
            return content
        raise RuntimeError(last_issue)

    async def acomplete(
        self,
        messages: list[dict[str, str]],
        *,
        tier: str = "pro",
        temperature: float = 0.3,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        """Run an asynchronous completion with one Pro truncation expansion."""
        start_time = time.perf_counter()
        model, kwargs = self._request_kwargs(
            messages,
            tier=tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
            stream=False,
        )
        budgets = [kwargs["max_tokens"]]
        expanded = self.expanded_max_tokens(model, kwargs["max_tokens"])
        if expanded > kwargs["max_tokens"]:
            budgets.append(expanded)

        last_issue = ""
        client = self._get_async_client()
        for budget in budgets:
            kwargs["max_tokens"] = budget
            response = await client.chat.completions.create(**kwargs)
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
            self._log_completion(
                model, tier, finish_reason, response, time.perf_counter() - start_time
            )
            return content
        raise RuntimeError(last_issue)

    async def astream(
        self,
        messages: list[dict[str, str]],
        *,
        tier: str = "pro",
        temperature: float = 0.3,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> AsyncIterator[str]:
        """Yield final-answer deltas and validate the completed stream."""
        start_time = time.perf_counter()
        model, kwargs = self._request_kwargs(
            messages,
            tier=tier,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
            stream=True,
        )
        stream = await self._get_async_client().chat.completions.create(**kwargs)
        has_content = False
        finish_reason = None
        input_tokens = 0
        output_tokens = 0
        async for chunk in stream:
            usage = getattr(chunk, "usage", None)
            if usage:
                input_tokens = getattr(usage, "prompt_tokens", input_tokens)
                output_tokens = getattr(usage, "completion_tokens", output_tokens)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if getattr(choice, "finish_reason", None):
                finish_reason = choice.finish_reason
            content = getattr(choice.delta, "content", None)
            if content:
                has_content = True
                yield content
        if finish_reason == "length":
            raise RuntimeError(
                "DeepSeek stream was truncated "
                f"(model={model}, request_max_tokens={kwargs['max_tokens']})"
            )
        if not has_content:
            raise RuntimeError(
                "DeepSeek returned empty stream "
                f"(model={model}, request_max_tokens={kwargs['max_tokens']})"
            )
        logger.info(
            "DeepSeek stream completed: service=bibliometric_analysis model=%s "
            "tier=%s thinking=%s latency_seconds=%.3f input_tokens=%s "
            "output_tokens=%s finish_reason=%s",
            model,
            tier,
            "enabled" if tier == "pro" else "disabled",
            time.perf_counter() - start_time,
            input_tokens,
            output_tokens,
            finish_reason,
        )

    @staticmethod
    def parse_json(text: str) -> dict | list:
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```", 2)[1]
            if text.startswith("json"):
                text = text[4:]
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            for start_char, end_char in (("{", "}"), ("[", "]")):
                start, end = text.find(start_char), text.rfind(end_char)
                if start >= 0 and end > start:
                    try:
                        return json.loads(text[start : end + 1])
                    except json.JSONDecodeError:
                        continue
        raise ValueError("DeepSeek response did not contain valid JSON")

    @staticmethod
    def _log_completion(
        model: str,
        tier: str,
        finish_reason: str | None,
        response,
        latency_seconds: float,
    ) -> None:
        usage = getattr(response, "usage", None)
        logger.info(
            "DeepSeek call completed: service=bibliometric_analysis model=%s "
            "tier=%s thinking=%s latency_seconds=%.3f input_tokens=%s "
            "output_tokens=%s finish_reason=%s",
            model,
            tier,
            "enabled" if tier == "pro" else "disabled",
            latency_seconds,
            getattr(usage, "prompt_tokens", 0) if usage else 0,
            getattr(usage, "completion_tokens", 0) if usage else 0,
            finish_reason,
        )
