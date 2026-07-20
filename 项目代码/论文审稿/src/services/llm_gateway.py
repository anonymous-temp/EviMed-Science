"""
LLM Gateway Service - Unified interface for LLM API calls with retry, caching, and model tiering
"""
import json
import hashlib
import logging
import time
import os
from typing import Optional, Dict, Any, List, AsyncIterator
from enum import Enum
import asyncio
from functools import wraps

import aiohttp

from dotenv import load_dotenv
load_dotenv()
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# 全局并发控制（同进程内所有 LLMGateway 实例共享）
# LLM_MAX_CONCURRENT: 同时向 LLM API 发出的最大请求数，超出则排队等待
# ──────────────────────────────────────────────────────────────────────────────
_LLM_SEMAPHORE = asyncio.Semaphore(int(os.getenv("LLM_MAX_CONCURRENT", "8")))


# ──────────────────────────────────────────────────────────────────────────────
# 熔断器（Circuit Breaker）
# 连续失败 FAILURE_THRESHOLD 次后进入 OPEN 状态，拒绝请求 RECOVERY_TIMEOUT 秒
# RECOVERY_TIMEOUT 后自动尝试一次（HALF_OPEN），成功则关闭熔断器
# ──────────────────────────────────────────────────────────────────────────────
class _CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = int(os.getenv("LLM_CB_FAILURE_THRESHOLD", "5")),
        recovery_timeout: int = int(os.getenv("LLM_CB_RECOVERY_TIMEOUT", "60")),
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._failure_count = 0
        self._last_failure_time: float = 0.0
        self._state = "closed"   # closed | open | half_open
        self._lock = asyncio.Lock()

    @property
    def state(self) -> str:
        if self._state == "open":
            if time.time() - self._last_failure_time >= self.recovery_timeout:
                self._state = "half_open"
        return self._state

    async def record_success(self) -> None:
        async with self._lock:
            self._failure_count = 0
            self._state = "closed"

    async def record_failure(self) -> None:
        async with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.time()
            if self._failure_count >= self.failure_threshold:
                self._state = "open"

    def is_allowed(self) -> bool:
        """Return True if a call should be attempted."""
        s = self.state
        return s in ("closed", "half_open")


_llm_circuit_breaker = _CircuitBreaker()

# ──────────────────────────────────────────────────────────────────────────────
# 持久化 HTTP 连接池（由 FastAPI lifespan 注入，避免每次 LLM 调用重新握手）
# ──────────────────────────────────────────────────────────────────────────────
_http_connector: Optional[aiohttp.TCPConnector] = None


def set_http_connector(connector: aiohttp.TCPConnector) -> None:
    """由 FastAPI lifespan 在启动时注入共享连接池"""
    global _http_connector
    _http_connector = connector


def _make_session(timeout_sec: int) -> aiohttp.ClientSession:
    """创建 ClientSession；若已有连接池则复用，否则临时创建独立 Session"""
    timeout = aiohttp.ClientTimeout(total=timeout_sec)
    if _http_connector and not _http_connector.closed:
        return aiohttp.ClientSession(
            connector=_http_connector,
            connector_owner=False,  # 不在 Session 关闭时销毁共享连接池
            timeout=timeout,
        )
    return aiohttp.ClientSession(timeout=timeout)

class ModelTier(str, Enum):
    """Model tier for selecting appropriate LLM based on task complexity"""
    FAST = "fast"  # Lightweight tasks, use cheaper/faster models
    STANDARD = "standard"  # Standard complexity tasks
    ADVANCED = "advanced"  # Complex reasoning, use most capable models

class LLMProvider(str, Enum):
    """Supported LLM providers"""
    DEEPSEEK = "deepseek"


class LLMGateway:
    """
    Unified gateway for all LLM API calls.
    Handles authentication, retry logic, caching, and model selection.
    """

    def __init__(
        self,
        provider: LLMProvider = LLMProvider.DEEPSEEK,
        api_key: Optional[str] = None,
        enable_cache: bool = True,
        max_retries: int = 3,
        timeout: int = 120
    ):
        self.provider = provider
        self.enable_cache = enable_cache
        self.max_retries = max_retries
        self.timeout = timeout
        self._cache: Dict[str, Any] = {}
        self.pro_reasoning_reserve_tokens = int(
            os.getenv("DEEPSEEK_PRO_REASONING_RESERVE_TOKENS", "4096")
        )
        self.max_output_tokens = int(
            os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "384000")
        )
        self.pro_timeout = int(os.getenv("DEEPSEEK_PRO_TIMEOUT_SECONDS", "300"))

        if provider == LLMProvider.DEEPSEEK:
            self.deepseek_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
            if not self.deepseek_api_key:
                raise ValueError("DEEPSEEK requires api_key or DEEPSEEK_API_KEY env variable")
            self.deepseek_base_url = os.getenv(
                "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
            ).rstrip("/")
            self.deepseek_endpoint = f"{self.deepseek_base_url}/chat/completions"
        else:
            raise ValueError(f"Unsupported provider: {provider}")

        self.model_mapping = self._get_model_mapping()

    def _get_model_mapping(self) -> Dict[ModelTier, str]:
        """Get model names based on provider and tier"""
        if self.provider == LLMProvider.DEEPSEEK:
            return {
                ModelTier.FAST: os.getenv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"),
                ModelTier.STANDARD: os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
                ModelTier.ADVANCED: os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
            }

        return {}

    def _effective_max_tokens(self, model: str, answer_tokens: int) -> int:
        """Reserve output room for Pro reasoning without exceeding the API cap."""
        if model != self.model_mapping[ModelTier.ADVANCED]:
            return answer_tokens
        return min(
            self.max_output_tokens,
            max(
                answer_tokens * 2,
                answer_tokens + self.pro_reasoning_reserve_tokens,
            ),
        )

    def _expanded_max_tokens(self, model: str, current_tokens: int) -> int:
        """Expand a truncated Pro request once."""
        if model != self.model_mapping[ModelTier.ADVANCED]:
            return current_tokens
        return min(self.max_output_tokens, current_tokens * 2)

    def _get_cache_key(self, messages: List[Dict], model: str, temperature: float) -> str:
        """Generate cache key from request parameters"""
        content = json.dumps({
            "messages": messages,
            "model": model,
            "temperature": temperature
        }, sort_keys=True)
        return hashlib.sha256(content.encode()).hexdigest()

    @staticmethod
    def _log_completion(result: Dict[str, Any]) -> None:
        """Log operational metadata only; never log prompts, papers, or credentials."""
        logger.info(
            "DeepSeek call completed: service=paper_review model=%s tier=%s "
            "thinking=%s latency_seconds=%.3f input_tokens=%s "
            "output_tokens=%s finish_reason=%s from_cache=%s",
            result.get("model", ""),
            result.get("tier", ""),
            result.get("thinking", ""),
            float(result.get("latency_seconds", 0)),
            result.get("input_tokens", 0),
            result.get("output_tokens", 0),
            result.get("finish_reason"),
            result.get("from_cache", False),
        )

    async def call_with_retry(
        self,
        messages: List[Dict[str, str]],
        model_tier: ModelTier = ModelTier.STANDARD,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        response_format: Optional[Dict] = None,
        timeout_sec: Optional[int] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Call LLM with exponential backoff retry logic.

        Args:
            messages: List of message dicts with 'role' and 'content'
            model_tier: Complexity tier for model selection
            temperature: Sampling temperature (0.0-1.0)
            max_tokens: Maximum tokens in response
            response_format: Optional response format specification (e.g., {"type": "json_object"})
            **kwargs: Additional provider-specific parameters

        Returns:
            Dict containing response text and metadata
        """
        model = self.model_mapping.get(model_tier, self.model_mapping[ModelTier.STANDARD])

        # Check cache first
        if self.enable_cache:
            cache_key = self._get_cache_key(messages, model, temperature)
            if cache_key in self._cache:
                cached_result = dict(self._cache[cache_key])
                cached_result["from_cache"] = True
                cached_result["latency_seconds"] = 0
                self._log_completion(cached_result)
                return cached_result

        # Retry logic with exponential backoff
        last_exception = None
        for attempt in range(self.max_retries):
            # ── 熔断器检查 ──────────────────────────────────────────────
            if not _llm_circuit_breaker.is_allowed():
                raise RuntimeError(
                    "LLM circuit breaker is OPEN — too many recent failures. "
                    f"Will retry in {_llm_circuit_breaker.recovery_timeout}s."
                )
            # ───────────────────────────────────────────────────────────
            try:
                result = await self._call_llm(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_format=response_format,
                    timeout_sec=timeout_sec,
                    **kwargs
                )

                # Cache successful result
                if self.enable_cache:
                    self._cache[cache_key] = result

                await _llm_circuit_breaker.record_success()
                self._log_completion(result)
                return result

            except Exception as e:
                last_exception = e
                await _llm_circuit_breaker.record_failure()
                if attempt < self.max_retries - 1:
                    # Exponential backoff: 2s, 4s, 8s
                    wait_time = 2 ** (attempt + 1)
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    # Max retries exceeded
                    raise RuntimeError(
                        f"LLM call failed after {self.max_retries} attempts: {str(last_exception)}"
                    )

    async def _call_llm(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int = 4096,
        response_format: Optional[Dict] = None,
        timeout_sec: Optional[int] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Internal method to make actual LLM API call"""
        start_time = time.time()
        effective_timeout = timeout_sec or self.timeout
        request_max_tokens = self._effective_max_tokens(model, max_tokens)
        is_pro = model == self.model_mapping[ModelTier.ADVANCED]
        if is_pro:
            effective_timeout = max(effective_timeout, self.pro_timeout)

        if self.provider == LLMProvider.DEEPSEEK:
            deepseek_messages = [
                {"role": msg["role"], "content": msg["content"]}
                for msg in messages
            ]

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.deepseek_api_key}",
            }

            payload = {
                "model": model,
                "messages": deepseek_messages,
                "max_tokens": request_max_tokens,
                "stream": False,
                "thinking": {"type": "enabled" if is_pro else "disabled"},
            }
            if is_pro:
                payload["reasoning_effort"] = "high"
            else:
                payload["temperature"] = temperature

            if response_format and response_format.get("type") == "json_object":
                payload["response_format"] = {"type": "json_object"}

            try:
                async with _LLM_SEMAPHORE:
                    # 进入信号量后再次检查熔断器，防止排队期间熔断器打开仍被执行
                    if not _llm_circuit_breaker.is_allowed():
                        raise RuntimeError(
                            "LLM circuit breaker is OPEN — too many recent failures. "
                            f"Will retry in {_llm_circuit_breaker.recovery_timeout}s."
                        )
                    budgets = [request_max_tokens]
                    expanded_tokens = self._expanded_max_tokens(model, request_max_tokens)
                    if expanded_tokens > request_max_tokens:
                        budgets.append(expanded_tokens)

                    async with _make_session(effective_timeout) as session:
                        last_issue = ""
                        for budget in budgets:
                            payload["max_tokens"] = budget
                            async with session.post(
                                self.deepseek_endpoint,
                                headers=headers,
                                json=payload,
                            ) as resp:
                                if resp.status != 200:
                                    error_text = await resp.text()
                                    raise RuntimeError(
                                        f"DeepSeek API Error {resp.status}: {error_text}"
                                    )

                                data = await resp.json()
                                choice = data["choices"][0]
                                content = choice["message"].get("content")
                                finish_reason = choice.get("finish_reason")
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

                                return {
                                    "content": content,
                                    "model": model,
                                    "tier": "pro" if is_pro else "flash",
                                    "thinking": "enabled" if is_pro else "disabled",
                                    "finish_reason": finish_reason,
                                    "input_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                                    "output_tokens": data.get("usage", {}).get("completion_tokens", 0),
                                    "latency_seconds": time.time() - start_time,
                                    "from_cache": False,
                                }

                        raise RuntimeError(last_issue)
            except asyncio.TimeoutError:
                raise RuntimeError(
                    f"LLM request timed out after {effective_timeout}s "
                    f"(model={model}, max_tokens={max_tokens}). "
                    "Consider increasing timeout_sec for large generation tasks."
                )
            except aiohttp.ClientConnectorError as e:
                raise RuntimeError(
                    f"Connection failed to {self.deepseek_endpoint}. "
                    f"Check network/DNS. Detail: {str(e)}"
                )

        raise ValueError(f"Unsupported provider: {self.provider}")

    async def stream_text(
        self,
        messages: List[Dict[str, str]],
        model_tier: ModelTier = ModelTier.STANDARD,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncIterator[str]:
        """
        流式调用 LLM，逐块 yield 文本片段（delta）。
        用法：async for chunk in gateway.stream_text(messages): ...
        """
        model = self.model_mapping.get(model_tier, self.model_mapping[ModelTier.STANDARD])
        start_time = time.perf_counter()
        request_max_tokens = self._effective_max_tokens(model, max_tokens)
        is_pro = model == self.model_mapping[ModelTier.ADVANCED]
        effective_timeout = max(self.timeout, self.pro_timeout) if is_pro else self.timeout

        if self.provider == LLMProvider.DEEPSEEK:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.deepseek_api_key}",
                "Accept": "text/event-stream",
            }
            payload = {
                "model": model,
                "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
                "max_tokens": request_max_tokens,
                "stream": True,
                "stream_options": {"include_usage": True},
                "thinking": {"type": "enabled" if is_pro else "disabled"},
            }
            if is_pro:
                payload["reasoning_effort"] = "high"
            else:
                payload["temperature"] = temperature

            async with _LLM_SEMAPHORE:
                has_content = False
                finish_reason = None
                input_tokens = 0
                output_tokens = 0
                # 检查熔断器（stream_text 不经过 call_with_retry，需在此检查）
                if not _llm_circuit_breaker.is_allowed():
                    raise RuntimeError(
                        "LLM circuit breaker is OPEN — too many recent failures. "
                        f"Will retry in {_llm_circuit_breaker.recovery_timeout}s."
                    )
                async with _make_session(effective_timeout) as session:
                    async with session.post(
                        self.deepseek_endpoint,
                        headers=headers,
                        json=payload,
                    ) as resp:
                        if resp.status != 200:
                            error_text = await resp.text()
                            raise RuntimeError(f"Stream API Error {resp.status}: {error_text}")

                        async for raw_line in resp.content:
                            line = raw_line.decode("utf-8").strip()
                            if not line or not line.startswith("data:"):
                                continue
                            data_str = line[5:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                usage = chunk.get("usage") or {}
                                input_tokens = usage.get("prompt_tokens", input_tokens)
                                output_tokens = usage.get("completion_tokens", output_tokens)
                                if not chunk.get("choices"):
                                    continue
                                choice = chunk["choices"][0]
                                if choice.get("finish_reason"):
                                    finish_reason = choice["finish_reason"]
                                delta = choice["delta"].get("content", "")
                                if delta:
                                    has_content = True
                                    yield delta
                            except (json.JSONDecodeError, KeyError, IndexError):
                                continue
                if finish_reason == "length":
                    raise RuntimeError(
                        "DeepSeek stream was truncated "
                        f"(model={model}, request_max_tokens={request_max_tokens})"
                    )
                if not has_content:
                    raise RuntimeError(
                        "DeepSeek returned empty stream "
                        f"(model={model}, request_max_tokens={request_max_tokens})"
                    )
                self._log_completion({
                    "model": model,
                    "tier": "pro" if is_pro else "flash",
                    "thinking": "enabled" if is_pro else "disabled",
                    "latency_seconds": time.perf_counter() - start_time,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "finish_reason": finish_reason,
                    "from_cache": False,
                })
            return

        raise ValueError(f"Unsupported provider: {self.provider}")

    async def call_with_json_response(
        self,
        messages: List[Dict[str, str]],
        model_tier: ModelTier = ModelTier.STANDARD,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Call LLM and parse JSON response.

        Returns:
            Dict containing parsed JSON from response and metadata
        """

        if self.provider == LLMProvider.DEEPSEEK:
            # DeepSeek supports OpenAI-compatible JSON output.
            result = await self.call_with_retry(
                messages=messages,
                model_tier=model_tier,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
                **kwargs
            )
        else:
            # For other providers, instruct in prompt
            messages = messages.copy()
            if messages and messages[0]["role"] == "system":
                messages[0]["content"] += "\n\nYou must respond with valid JSON only."
            else:
                messages.insert(0, {"role": "system", "content": "You must respond with valid JSON only."})

            result = await self.call_with_retry(
                messages=messages,
                model_tier=model_tier,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs
            )

        # Parse JSON from content
        try:
            parsed_content = json.loads(result["content"])
            result["parsed_json"] = parsed_content
            return result
        except json.JSONDecodeError as e:
            content = result["content"]
            # 尝试从 markdown 代码块提取
            if "```json" in content:
                try:
                    json_str = content.split("```json")[1].split("```")[0].strip()
                    parsed_content = json.loads(json_str)
                    result["parsed_json"] = parsed_content
                    return result
                except (IndexError, json.JSONDecodeError):
                    pass

            # 尝试修复被截断的 JSON：找到最后一个完整字段并补全闭合括号
            try:
                # 截断位置往前搜索最近一个完整的 key:value 对结尾（逗号或引号+逗号）
                truncated = content
                # 找最后一个完整的 JSON 字段边界（以 ", 或 ",\n 结尾的位置）
                for end_pat in ('",\n', '",', '"\n', '"'):
                    idx = truncated.rfind(end_pat)
                    if idx > 0:
                        candidate = truncated[:idx + len(end_pat)].rstrip(',').rstrip() + "\n}"
                        try:
                            parsed_content = json.loads(candidate)
                            result["parsed_json"] = parsed_content
                            result["json_truncated"] = True
                            return result
                        except json.JSONDecodeError:
                            continue
            except Exception:
                pass

            raise ValueError(f"Failed to parse JSON from LLM response: {str(e)}\nContent: {content[:500]}")
    def clear_cache(self):
        """Clear the response cache"""
        self._cache.clear()

    def get_cache_stats(self) -> Dict[str, int]:
        """Get cache statistics"""
        return {
            "cache_size": len(self._cache),
            "cache_enabled": self.enable_cache
        }
