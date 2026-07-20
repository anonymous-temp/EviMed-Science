"""Async DeepSeek chat client (OpenAI-compatible) over plain httpx.

Two-tier routing via settings: ``flash`` (DEEPSEEK_FLASH_MODEL, default
deepseek-chat) for cheap tasks like label cross-checks, ``pro``
(DEEPSEEK_PRO_MODEL, default deepseek-reasoner) for report interpretation.

Hard rules enforced here:
- the key is read from settings (SecretStr) and only ever placed in the
  Authorization header — never logged, never embedded in payloads;
- 429/5xx/transport errors get exponential backoff with jitter, then a
  typed exception; 401/403 and other 4xx fail fast;
- ``complete_json`` strips markdown fences, parses JSON and validates it
  against a pydantic schema; on failure it retries exactly once with a
  repair instruction, then raises :class:`LLMResponseError`.

The LLM never computes statistics — it only receives finished numbers and
produces narrative text or verbatim label quotes.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from safety_agent.core.config import Settings
from safety_agent.core.exceptions import (
    LLMAuthError,
    LLMError,
    LLMRateLimited,
    LLMResponseError,
    LLMUnavailable,
)
from safety_agent.core.logging import get_logger

logger = get_logger(__name__)

Tier = Literal["flash", "pro"]

SchemaT = TypeVar("SchemaT", bound=BaseModel)

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(?P<body>.*?)\s*```\s*$", re.DOTALL)


class DeepSeekClient:
    """Minimal async wrapper for the DeepSeek chat completions API."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        *,
        flash_model: str = "deepseek-chat",
        pro_model: str = "deepseek-reasoner",
        timeout: float = 120.0,
        max_retries: int = 3,
        backoff_initial: float = 1.0,
        backoff_cap: float = 20.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise LLMAuthError("DeepSeek API key is empty")
        if max_retries < 1:
            raise LLMError("max_retries must be >= 1")
        self._flash_model = flash_model
        self._pro_model = pro_model
        self._max_retries = max_retries
        self._backoff_initial = backoff_initial
        self._backoff_cap = backoff_cap
        self._sleep = sleep
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            transport=transport,
        )

    @classmethod
    def from_settings(cls, settings: Settings, **overrides: Any) -> "DeepSeekClient":
        return cls(
            settings.deepseek_api_key.get_secret_value(),
            settings.deepseek_base_url,
            flash_model=settings.deepseek_flash_model,
            pro_model=settings.deepseek_pro_model,
            **overrides,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "DeepSeekClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    def model_for(self, tier: Tier) -> str:
        return self._flash_model if tier == "flash" else self._pro_model

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        tier: Tier = "flash",
        temperature: float = 0.2,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        """One chat completion; returns the assistant message content."""
        payload: dict[str, Any] = {
            "model": self.model_for(tier),
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        body = await self._post("/chat/completions", payload)
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMResponseError("DeepSeek response carried no choices")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise LLMResponseError("DeepSeek response carried empty content")
        usage = body.get("usage")
        if isinstance(usage, dict):
            logger.info(
                "DeepSeek %s tokens: prompt=%s completion=%s",
                payload["model"],
                usage.get("prompt_tokens"),
                usage.get("completion_tokens"),
            )
        return content

    async def complete_json(
        self,
        messages: list[dict[str, str]],
        *,
        schema: type[SchemaT],
        tier: Tier = "flash",
        temperature: float = 0.2,
        max_tokens: int = 4096,
    ) -> SchemaT:
        """Chat completion constrained to JSON, validated against ``schema``.

        Exactly one repair retry is attempted when the first output fails
        fence-stripping, JSON parsing or schema validation.
        """
        attempts: list[list[dict[str, str]]] = [messages]
        last_error: str | None = None
        for attempt in range(2):
            content = await self.complete(
                attempts[-1], tier=tier, temperature=temperature,
                max_tokens=max_tokens, json_mode=True,
            )
            try:
                return schema.model_validate(_parse_json_object(content))
            except (ValueError, ValidationError) as exc:
                last_error = str(exc)
                logger.warning(
                    "LLM JSON output invalid (attempt %d): %s", attempt + 1, last_error
                )
                if attempt == 0:
                    attempts.append(
                        messages
                        + [
                            {"role": "assistant", "content": content},
                            {
                                "role": "user",
                                "content": (
                                    "Your previous reply was not valid for the required JSON "
                                    f"schema ({last_error}). Reply with ONLY a corrected JSON "
                                    "object, no markdown fences, no commentary."
                                ),
                            },
                        ]
                    )
        raise LLMResponseError(
            "LLM failed to produce schema-valid JSON after one repair retry",
            detail=last_error,
        )

    # -- transport ---------------------------------------------------------

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        saw_rate_limit = False
        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                response = await self._client.post(path, json=payload)
            except httpx.TransportError as exc:
                last_error = exc
                logger.warning("DeepSeek transport error (attempt %d): %s", attempt + 1, exc)
                await self._backoff(attempt)
                continue
            if response.status_code == 200:
                try:
                    body = response.json()
                except ValueError as exc:
                    raise LLMResponseError("DeepSeek returned invalid JSON") from exc
                if not isinstance(body, dict):
                    raise LLMResponseError("DeepSeek returned a non-object JSON payload")
                return body
            if response.status_code in (401, 403):
                raise LLMAuthError(
                    f"DeepSeek authentication failed (HTTP {response.status_code})"
                )
            if response.status_code == 429:
                saw_rate_limit = True
                logger.warning("DeepSeek rate limited (attempt %d)", attempt + 1)
                await self._backoff(attempt)
                continue
            if 500 <= response.status_code < 600:
                last_error = LLMUnavailable(
                    "DeepSeek server error", detail=f"HTTP {response.status_code}"
                )
                logger.warning("DeepSeek %d (attempt %d)", response.status_code, attempt + 1)
                await self._backoff(attempt)
                continue
            raise LLMError(
                f"DeepSeek rejected the request (HTTP {response.status_code})",
                detail=_truncate(response.text),
            )
        if saw_rate_limit:
            raise LLMRateLimited("DeepSeek rate limit persisted after retries")
        raise LLMUnavailable(
            "DeepSeek unreachable after retries",
            detail=str(last_error) if last_error else None,
        ) from last_error

    async def _backoff(self, attempt: int) -> None:
        delay = min(self._backoff_cap, self._backoff_initial * (2**attempt))
        delay += random.uniform(0.0, 0.25 * delay)
        await self._sleep(delay)


def _parse_json_object(content: str) -> Any:
    """Strip optional markdown fences and parse a JSON object."""
    text = content.strip()
    match = _FENCE_RE.match(text)
    if match:
        text = match.group("body").strip()
    parsed = json.loads(text)  # raises ValueError -> handled by caller
    if not isinstance(parsed, (dict, list)):
        raise ValueError("JSON output is not an object or array")
    return parsed


def _truncate(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[:limit] + "..."
