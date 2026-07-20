"""OpenAI-compatible LLM client with retry, structured output, and vision support."""
from __future__ import annotations

import json
import os
import re
import time
import logging
import base64
import contextvars
import threading
from contextlib import contextmanager
from pathlib import Path

import httpx
from openai import OpenAI
from pydantic import BaseModel

from new_meta.config import (
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_CONNECT_TIMEOUT_SECONDS,
    LLM_ENABLE_SEARCH,
    LLM_ENABLE_THINKING,
    LLM_FORCE_SEARCH,
    LLM_JSON_REPAIR_RETRIES,
    LLM_MAX_RETRIES,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_POOL_TIMEOUT_SECONDS,
    LLM_READ_TIMEOUT_SECONDS,
    LLM_REASONING_EFFORT,
    LLM_RETRY_MAX_WAIT_SECONDS,
    LLM_SEARCH_STRATEGY,
    LLM_STREAM,
    LLM_TEMPERATURE,
    LLM_TRUST_ENV,
    LLM_WRITE_TIMEOUT_SECONDS,
    LLM_USE_RESPONSES_API,
)

logger = logging.getLogger("metaagent.llm")

LLM_USAGE_SCHEMA_VERSION = 1
_LLM_USAGE_LOCK = threading.Lock()
_LLM_USAGE_EVENTS: list[dict] = []
_LLM_USAGE_SCOPE = contextvars.ContextVar("llm_usage_scope", default="")
_RESPONSES_API_DISABLED_LOCK = threading.Lock()
_RESPONSES_API_DISABLED_MODELS: set[tuple[str, str]] = set()

_BUILT_IN_LLM_PRICES_USD_PER_1M = {
    # Estimates only. Runtime env vars override these values.
    "qwen3.6-plus": {"input": 0.276, "output": 1.65, "source": "built_in_qwen_estimate"},
    "qwen3.6-flash": {"input": 0.055, "output": 0.33, "source": "built_in_qwen_estimate"},
    "qwen3.7-max": {"input": 1.10, "output": 6.60, "source": "built_in_qwen_estimate"},
}


class LLMOutputError(RuntimeError):
    """Raised when the API returned a response that is not usable."""


def _is_dashscope_compatible_base_url(base_url: str) -> bool:
    text = str(base_url or "").lower()
    return "dashscope.aliyuncs.com/compatible-mode" in text


def _is_dashscope_responses_search_model(model: str) -> bool:
    model_name = str(model or "").strip().lower()
    return model_name in {"qwen3.6-plus", "qwen3.6-flash", "qwen3.7-max"}


def _is_deepseek_v4_chat(base_url: str, model: str) -> bool:
    base = str(base_url or "").rstrip("/").lower()
    model_name = str(model or "").strip().lower()
    return "api.deepseek.com" in base and model_name in {
        "deepseek-v4-flash",
        "deepseek-v4-pro",
    }


def _responses_disable_key(base_url: str, model: str) -> tuple[str, str]:
    return (str(base_url or "").rstrip("/").lower(), str(model or "").strip().lower())


def _responses_api_disabled_globally(base_url: str, model: str) -> bool:
    key = _responses_disable_key(base_url, model)
    with _RESPONSES_API_DISABLED_LOCK:
        return key in _RESPONSES_API_DISABLED_MODELS


def _disable_responses_api_globally(base_url: str, model: str) -> None:
    key = _responses_disable_key(base_url, model)
    with _RESPONSES_API_DISABLED_LOCK:
        _RESPONSES_API_DISABLED_MODELS.add(key)


def _messages_are_plain_text(messages: list[dict]) -> bool:
    return all(isinstance(item.get("content"), str) for item in messages)


def _dashscope_extra_body(*, enable_search: bool, enable_thinking: bool | None, force_search: bool, search_strategy: str) -> dict | None:
    body: dict[str, object] = {}
    if enable_thinking is not None:
        body["enable_thinking"] = enable_thinking
    if enable_search:
        body["enable_search"] = True
        search_options = {}
        if force_search:
            search_options["forced_search"] = True
        if search_strategy:
            search_options["search_strategy"] = search_strategy
        if search_options:
            body["search_options"] = search_options
    return body or None


def _deep_clean(obj):
    """Recursively clean LLM JSON artifacts.

    Handles common patterns:
    - Nested traceability objects: {"exact_value": x, "source_location": ...} -> x
    - {"value": x, "source_section": ...} -> x
    - None for required fields: converts to empty string for str, keeps None for Optional
    """
    if isinstance(obj, dict):
        # Check if this is a traceability wrapper (has value/exact_value + source_ keys)
        val_keys = {"exact_value", "value"}
        source_keys = {"source_location", "source_quote", "source_page", "source_section"}
        has_val = val_keys & set(obj.keys())
        has_source = source_keys & set(obj.keys())
        if has_val and (has_source or len(obj) == 1):
            key = next(iter(has_val))
            return _deep_clean(obj[key])
        # Normal dict — recurse
        return {k: _deep_clean(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_deep_clean(item) for item in obj]
    return obj


def _strip_markdown_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        nl_pos = text.find("\n")
        if nl_pos >= 0:
            text = text[nl_pos + 1:]
        else:
            text = text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].rstrip()
    return text.strip()


def _extract_balanced_json(text: str) -> str | None:
    """Extract the first balanced JSON object/array from a noisy LLM response."""
    start = -1
    opener = ""
    for i, ch in enumerate(text):
        if ch in "{[":
            start = i
            opener = ch
            break
    if start < 0:
        return None

    expected = {"{": "}", "[": "]"}
    stack = [expected[opener]]
    in_string = False
    escape = False
    for i in range(start + 1, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "{[":
            stack.append(expected[ch])
        elif stack and ch == stack[-1]:
            stack.pop()
            if not stack:
                return text[start:i + 1]
    return None


def _repair_json_text(text: str) -> str:
    """Best-effort repair for common JSON-mode failures."""
    stripped = _strip_markdown_fences(text)
    candidate = _extract_balanced_json(stripped) or stripped
    candidate = re.sub(r",(\s*[}\]])", r"\1", candidate)
    return candidate.strip()


def _looks_like_incomplete_json(text: str) -> bool:
    """Detect JSON-like output that ended before the first object/array closed."""
    stripped = _strip_markdown_fences(text or "")
    first_json = min(
        (idx for idx in (stripped.find("{"), stripped.find("[")) if idx >= 0),
        default=-1,
    )
    if first_json < 0:
        return False
    return _extract_balanced_json(stripped[first_json:]) is None


def reset_llm_usage() -> None:
    """Clear the process-wide LLM usage ledger, primarily for tests and new runs."""
    with _LLM_USAGE_LOCK:
        _LLM_USAGE_EVENTS.clear()
    _LLM_USAGE_SCOPE.set("")


def _llm_usage_scope_id(project_or_path) -> str:
    if project_or_path is None:
        return ""
    base_dir = getattr(project_or_path, "base_dir", project_or_path)
    return str(Path(base_dir))


@contextmanager
def llm_usage_scope(project_or_path):
    """Tag LLM usage events produced inside the block with a project directory."""
    token = _LLM_USAGE_SCOPE.set(_llm_usage_scope_id(project_or_path))
    try:
        yield
    finally:
        _LLM_USAGE_SCOPE.reset(token)


def set_llm_usage_scope(project_or_path):
    """Set the current context's default LLM usage project scope."""
    return _LLM_USAGE_SCOPE.set(_llm_usage_scope_id(project_or_path))


def _build_llm_usage_manifest(events: list[dict], *, project_dir: str = "") -> dict:
    """Build an LLM usage manifest from already-filtered events."""
    with _LLM_USAGE_LOCK:
        events = [dict(event) for event in events]
    prompt_tokens = sum(int(event.get("prompt_tokens") or 0) for event in events)
    completion_tokens = sum(int(event.get("completion_tokens") or 0) for event in events)
    total_tokens = sum(int(event.get("total_tokens") or 0) for event in events)
    estimated_cost = sum(float(event.get("estimated_cost_usd") or 0) for event in events)
    retryable_output_issues = sum(1 for event in events if str(event.get("retryable_output_issue") or "").strip())
    near_truncation_events = sum(1 for event in events if bool(event.get("near_truncation")))
    by_model: dict[str, dict] = {}
    for event in events:
        model = str(event.get("model") or "unknown")
        model_summary = by_model.setdefault(model, {
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "estimated_cost_usd": 0.0,
        })
        model_summary["calls"] += 1
        model_summary["prompt_tokens"] += int(event.get("prompt_tokens") or 0)
        model_summary["completion_tokens"] += int(event.get("completion_tokens") or 0)
        model_summary["total_tokens"] += int(event.get("total_tokens") or 0)
        model_summary["estimated_cost_usd"] += float(event.get("estimated_cost_usd") or 0)
    for model_summary in by_model.values():
        model_summary["estimated_cost_usd"] = round(model_summary["estimated_cost_usd"], 6)
    return {
        "schema_version": LLM_USAGE_SCHEMA_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project_dir": project_dir,
        "summary": {
            "total_calls": len(events),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "estimated_cost_usd": round(estimated_cost, 6),
            "cost_is_estimate": True,
            "retryable_output_issues": retryable_output_issues,
            "near_truncation_events": near_truncation_events,
            "output_reliability_warnings": len({
                index
                for index, event in enumerate(events)
                if str(event.get("retryable_output_issue") or "").strip() or bool(event.get("near_truncation"))
            }),
        },
        "by_model": by_model,
        "events": events,
    }


def get_llm_usage_manifest(scope: str | None = None) -> dict:
    """Return process-wide LLM usage and estimated cost summary."""
    with _LLM_USAGE_LOCK:
        events = [dict(event) for event in _LLM_USAGE_EVENTS]
    project_dir = ""
    if scope is not None:
        project_dir = str(scope)
        events = [event for event in events if str(event.get("project_dir") or "") == project_dir]
    return _build_llm_usage_manifest(events, project_dir=project_dir)


def write_llm_usage_manifest(project, filename: str = "llm_usage_manifest.json") -> Path:
    """Persist the current project's LLM usage manifest into its project directory."""
    project_dir = _llm_usage_scope_id(project)
    manifest = get_llm_usage_manifest(scope=project_dir)
    existing = project.load_json(filename) if hasattr(project, "load_json") else None
    if manifest["summary"]["total_calls"] == 0:
        all_manifest = get_llm_usage_manifest()
        all_events = all_manifest.get("events", [])
        if all_events and all(not event.get("project_dir") for event in all_events):
            manifest = all_manifest
            manifest["project_dir"] = project_dir
        elif _manifest_total_calls(existing) > 0:
            return project.base_dir / filename
    if _manifest_total_calls(existing) > 0 and manifest["summary"]["total_calls"] > 0:
        manifest = _merge_llm_usage_manifests(existing, manifest, project_dir=project_dir)
    project.save_json(filename, manifest)
    return project.base_dir / filename


def _manifest_total_calls(manifest) -> int:
    if not isinstance(manifest, dict):
        return 0
    summary = manifest.get("summary")
    if not isinstance(summary, dict):
        return 0
    try:
        return int(summary.get("total_calls") or 0)
    except (TypeError, ValueError):
        return 0


def _merge_llm_usage_manifests(existing, current: dict, *, project_dir: str) -> dict:
    existing_events = [
        dict(event)
        for event in (existing or {}).get("events", [])
        if isinstance(event, dict)
    ]
    current_events = [
        dict(event)
        for event in (current or {}).get("events", [])
        if isinstance(event, dict)
    ]
    merged_events: list[dict] = []
    seen: set[tuple] = set()
    for event in existing_events + current_events:
        event.setdefault("project_dir", project_dir)
        identity = _llm_usage_event_identity(event)
        if identity in seen:
            continue
        seen.add(identity)
        merged_events.append(event)
    return _build_llm_usage_manifest(merged_events, project_dir=project_dir)


def _llm_usage_event_identity(event: dict) -> tuple:
    return (
        event.get("timestamp") or "",
        event.get("project_dir") or "",
        event.get("model") or "",
        event.get("endpoint") or "",
        int(event.get("prompt_tokens") or 0),
        int(event.get("completion_tokens") or 0),
        int(event.get("total_tokens") or 0),
        int(event.get("max_tokens") or 0),
        event.get("finish_reason") or "",
        event.get("retryable_output_issue") or "",
        event.get("error_type") or "",
        event.get("error_message") or "",
    )


def _model_price_usd_per_1m(model: str) -> dict:
    input_override = os.getenv("LLM_PRICE_INPUT_PER_1M_USD") or os.getenv("LLM_PRICE_INPUT_PER_1M")
    output_override = os.getenv("LLM_PRICE_OUTPUT_PER_1M_USD") or os.getenv("LLM_PRICE_OUTPUT_PER_1M")
    if input_override or output_override:
        return {
            "input": float(input_override or 0),
            "output": float(output_override or 0),
            "source": os.getenv("LLM_PRICE_SOURCE", "env_override"),
        }
    normalised = str(model or "").strip().lower()
    return dict(_BUILT_IN_LLM_PRICES_USD_PER_1M.get(
        normalised,
        {"input": 0.0, "output": 0.0, "source": "unpriced"},
    ))


def _usage_dict_from_usage(usage, fallback_total: int | None = None) -> dict[str, int]:
    if isinstance(usage, dict):
        prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
        completion = usage.get("completion_tokens", usage.get("output_tokens"))
        total = usage.get("total_tokens")
    else:
        prompt = getattr(usage, "prompt_tokens", None)
        if prompt is None:
            prompt = getattr(usage, "input_tokens", None)
        completion = getattr(usage, "completion_tokens", None)
        if completion is None:
            completion = getattr(usage, "output_tokens", None)
        total = getattr(usage, "total_tokens", None)

    prompt_i = int(prompt or 0)
    completion_i = int(completion or 0)
    if total is None:
        total_i = prompt_i + completion_i if prompt_i or completion_i else int(fallback_total or 0)
    else:
        total_i = int(total or 0)
    return {
        "prompt_tokens": prompt_i,
        "completion_tokens": completion_i,
        "total_tokens": total_i,
    }


class LLMClient:
    """Unified LLM client supporting any OpenAI-compatible API."""

    def __init__(self, api_key: str = None, base_url: str = None, model: str = None):
        self.model = model or LLM_MODEL
        self.base_url = base_url or LLM_BASE_URL
        self.client = OpenAI(
            api_key=api_key or LLM_API_KEY,
            base_url=self.base_url,
            http_client=httpx.Client(
                trust_env=LLM_TRUST_ENV,
                timeout=httpx.Timeout(
                    connect=LLM_CONNECT_TIMEOUT_SECONDS,
                    read=LLM_READ_TIMEOUT_SECONDS,
                    write=LLM_WRITE_TIMEOUT_SECONDS,
                    pool=LLM_POOL_TIMEOUT_SECONDS,
                ),
            ),
        )
        self.total_tokens = 0
        self.total_calls = 0
        self._lock = threading.Lock()
        self.enable_search = LLM_ENABLE_SEARCH
        self.force_search = LLM_FORCE_SEARCH
        self.enable_thinking = LLM_ENABLE_THINKING
        self.reasoning_effort = LLM_REASONING_EFFORT
        self.stream = LLM_STREAM
        self.search_strategy = LLM_SEARCH_STRATEGY
        self.use_responses_api = LLM_USE_RESPONSES_API
        self.project_dir = _LLM_USAGE_SCOPE.get("")
        self._responses_api_disabled_for_session = False

    def _record_usage(
        self,
        *,
        model: str,
        endpoint: str,
        usage,
        max_tokens: int,
        finish_reason: str | None = None,
        retryable_output_issue: str = "",
    ) -> dict:
        usage_data = _usage_dict_from_usage(usage)
        price = _model_price_usd_per_1m(model)
        estimated_cost = (
            usage_data["prompt_tokens"] * float(price.get("input") or 0)
            + usage_data["completion_tokens"] * float(price.get("output") or 0)
        ) / 1_000_000
        near_truncation = (
            bool(max_tokens)
            and usage_data["completion_tokens"] > 0
            and usage_data["completion_tokens"] >= int(max_tokens * 0.95)
        )
        event = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "project_dir": _LLM_USAGE_SCOPE.get("") or self.project_dir,
            "model": model,
            "base_url": self.base_url,
            "endpoint": endpoint,
            "prompt_tokens": usage_data["prompt_tokens"],
            "completion_tokens": usage_data["completion_tokens"],
            "total_tokens": usage_data["total_tokens"],
            "max_tokens": max_tokens,
            "finish_reason": finish_reason or "",
            "retryable_output_issue": retryable_output_issue,
            "near_truncation": near_truncation,
            "estimated_cost_usd": round(estimated_cost, 6),
            "cost_is_estimate": True,
            "price_input_per_1m_usd": float(price.get("input") or 0),
            "price_output_per_1m_usd": float(price.get("output") or 0),
            "price_source": price.get("source") or "unpriced",
            "search_enabled": bool(self.enable_search),
            "stream": bool(self.stream),
        }
        with self._lock:
            self.total_calls += 1
            self.total_tokens += usage_data["total_tokens"]
        with _LLM_USAGE_LOCK:
            _LLM_USAGE_EVENTS.append(event)
        return event

    def _record_api_error(
        self,
        *,
        model: str,
        endpoint: str,
        max_tokens: int,
        error: Exception,
        attempt: int,
        max_retries: int,
    ) -> dict:
        event = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "project_dir": _LLM_USAGE_SCOPE.get("") or self.project_dir,
            "model": model,
            "base_url": self.base_url,
            "endpoint": endpoint,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "max_tokens": max_tokens,
            "finish_reason": "",
            "retryable_output_issue": "api_error",
            "near_truncation": False,
            "estimated_cost_usd": 0.0,
            "cost_is_estimate": True,
            "price_input_per_1m_usd": 0.0,
            "price_output_per_1m_usd": 0.0,
            "price_source": "not_applicable",
            "search_enabled": bool(self.enable_search),
            "stream": bool(self.stream),
            "error_type": type(error).__name__,
            "error_message": str(error)[:500],
            "attempt": attempt,
            "max_retries": max_retries,
        }
        with _LLM_USAGE_LOCK:
            _LLM_USAGE_EVENTS.append(event)
        return event

    @staticmethod
    def _expanded_max_tokens(max_tokens: int) -> int:
        return max(int(max_tokens * 2), int(max_tokens) + 1024)

    @staticmethod
    def _retry_wait_seconds(attempt: int) -> float:
        return min(float(LLM_RETRY_MAX_WAIT_SECONDS), float(2 ** attempt))

    @staticmethod
    def _sleep_before_retry(attempt: int, *, reason: str) -> None:
        wait = LLMClient._retry_wait_seconds(attempt)
        logger.warning("%s Retrying in %.1fs...", reason, wait)
        if wait > 0:
            time.sleep(wait)

    @staticmethod
    def _should_continue_truncated_text(content: str, response_format: dict | None) -> bool:
        """Return True when a truncated response can be safely continued in-place."""
        if response_format is not None:
            return False
        stripped = (content or "").lstrip()
        if not stripped:
            return False
        # JSON-like payloads are safer to regenerate with a larger token budget;
        # appending a continuation usually produces invalid JSON.
        return not stripped.startswith(("{", "["))

    @staticmethod
    def _continuation_messages(messages: list[dict], partial_text: str) -> list[dict]:
        return list(messages) + [
            {"role": "assistant", "content": partial_text},
            {
                "role": "user",
                "content": (
                    "Continue exactly from where you stopped. Do not repeat, summarize, "
                    "or rewrite any earlier text. Start with the next word or character only "
                    "and finish the requested answer."
                ),
            },
        ]

    def chat(
        self,
        messages: list[dict],
        temperature: float = None,
        max_tokens: int = None,
        model: str = None,
    ) -> str:
        """Send a chat completion request and return the text response."""
        return self._call(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            model=model,
        )

    def structured_output(
        self,
        messages: list[dict],
        schema: type[BaseModel],
        temperature: float = None,
        max_tokens: int = None,
        model: str = None,
    ) -> BaseModel:
        """Get a structured output parsed into a Pydantic model.

        Uses JSON mode + explicit schema instructions in the prompt.
        The last user message gets a JSON schema appended.
        """
        schema_json = json.dumps(schema.model_json_schema(), indent=2, ensure_ascii=False)
        instruction = (
            f"\n\nYou MUST respond with a valid JSON object that conforms to this schema:\n"
            f"```json\n{schema_json}\n```\n"
            f"Respond ONLY with the JSON object, no other text."
        )

        augmented = list(messages)
        last = augmented[-1].copy()
        last["content"] = last["content"] + instruction
        augmented[-1] = last

        raw = self._call(
            messages=augmented,
            temperature=temperature,
            max_tokens=max_tokens,
            model=model,
            response_format={"type": "json_object"},
        )
        if _looks_like_incomplete_json(raw):
            retry_messages = list(augmented)
            retry_last = retry_messages[-1].copy()
            retry_last["content"] = (
                retry_last["content"]
                + "\n\nPrevious response was incomplete or truncated before the JSON object closed. "
                "Regenerate the complete JSON object from the original source material. "
                "Do not summarize, omit required fields, or include markdown fences."
            )
            retry_messages[-1] = retry_last
            expanded_max_tokens = self._expanded_max_tokens(max_tokens or LLM_MAX_TOKENS)
            logger.warning(
                "Structured LLM response for schema %s looked incomplete; retrying original prompt "
                "with max_tokens=%s.",
                schema.__name__,
                expanded_max_tokens,
            )
            raw = self._call(
                messages=retry_messages,
                temperature=temperature,
                max_tokens=expanded_max_tokens,
                model=model,
                response_format={"type": "json_object"},
            )

        try:
            return self._parse_structured_payload(raw, schema)
        except ValueError as first_error:
            last_error = first_error
            for attempt in range(LLM_JSON_REPAIR_RETRIES):
                logger.warning(
                    "Structured LLM response failed for schema %s; requesting JSON repair "
                    "(attempt %s/%s): %s",
                    schema.__name__,
                    attempt + 1,
                    LLM_JSON_REPAIR_RETRIES,
                    first_error,
                )
                repair_messages = [
                    {
                        "role": "system",
                        "content": (
                            "You repair invalid JSON for a structured-output API. "
                            "Return only syntactically valid JSON that matches the provided schema."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Repair this invalid structured-output response.\n\n"
                            f"Schema:\n```json\n{schema_json}\n```\n\n"
                            f"Error:\n{last_error}\n\n"
                            f"Invalid response:\n```text\n{raw[:12000]}\n```\n\n"
                            "Return ONLY corrected JSON. Do not include markdown fences or explanation."
                        ),
                    },
                ]
                try:
                    repaired_raw = self._call(
                        messages=repair_messages,
                        temperature=0,
                        max_tokens=max_tokens,
                        model=model,
                        response_format={"type": "json_object"},
                    )
                    return self._parse_structured_payload(repaired_raw, schema)
                except ValueError as repair_error:
                    last_error = repair_error
                    logger.warning(
                        "JSON repair attempt %s/%s failed for schema %s: %s",
                        attempt + 1,
                        LLM_JSON_REPAIR_RETRIES,
                        schema.__name__,
                        repair_error,
                    )
            raise last_error

    @staticmethod
    def _parse_structured_payload(text: str, schema: type[BaseModel]) -> BaseModel:
        text = _strip_markdown_fences(text or "")

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            repaired = _repair_json_text(text)
            if repaired and repaired != text:
                try:
                    data = json.loads(repaired)
                    logger.warning(
                        "Repaired invalid JSON response for schema %s: %s",
                        schema.__name__,
                        e,
                    )
                except json.JSONDecodeError as e2:
                    logger.error(f"LLM returned invalid JSON for schema {schema.__name__}: {e2}\nRaw response:\n{text[:500]}")
                    raise ValueError(f"LLM returned invalid JSON for {schema.__name__}: {e2}") from e2
            else:
                logger.error(f"LLM returned invalid JSON for schema {schema.__name__}: {e}\nRaw response:\n{text[:500]}")
                raise ValueError(f"LLM returned invalid JSON for {schema.__name__}: {e}") from e

        # Auto-wrap: if schema expects a dict but LLM returned a list, try to wrap it
        if isinstance(data, list) and not isinstance(data, dict):
            # Find the first list-type field in the schema and wrap
            schema_props = schema.model_json_schema().get("properties", {})
            for field_name, field_info in schema_props.items():
                if field_info.get("type") == "array" or "items" in field_info:
                    data = {field_name: data}
                    break

        # Clean LLM artifacts: unwrap nested objects like {"exact_value": x, "source_location": ...}
        data = _deep_clean(data)

        try:
            return schema.model_validate(data)
        except Exception as e:
            logger.error(f"Pydantic validation failed for {schema.__name__}: {e}\nData keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
            raise ValueError(f"Schema validation failed for {schema.__name__}: {e}") from e

    def vision(
        self,
        messages: list[dict],
        images: list[str],
        temperature: float = None,
        max_tokens: int = None,
        model: str = None,
    ) -> str:
        """Send a vision request with images (file paths or URLs)."""
        augmented = list(messages)
        last = augmented[-1].copy()

        content_parts = [{"type": "text", "text": last["content"]}]
        for img in images:
            if img.startswith("http"):
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": img},
                })
            else:
                b64 = self._encode_image(img)
                suffix = Path(img).suffix.lower().lstrip(".")
                mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}.get(suffix, "image/png")
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                })

        last["content"] = content_parts
        augmented[-1] = last

        return self._call(
            messages=augmented,
            temperature=temperature,
            max_tokens=max_tokens,
            model=model,
        )

    def _call(
        self,
        messages: list[dict],
        temperature: float = None,
        max_tokens: int = None,
        model: str = None,
        response_format: dict = None,
        max_retries: int | None = None,
    ) -> str:
        """Internal method with retry logic."""
        model = model or self.model
        temperature = temperature if temperature is not None else LLM_TEMPERATURE
        max_tokens = max_tokens or LLM_MAX_TOKENS
        max_retries = max_retries or LLM_MAX_RETRIES
        responses_disabled = (
            self._responses_api_disabled_for_session
            or _responses_api_disabled_globally(self.base_url, model)
        )

        if (
            not responses_disabled
            and self._should_use_responses_api(model=model, messages=messages, response_format=response_format)
        ):
            try:
                text = self._call_responses(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    model=model,
                    max_retries=self._responses_max_retries(max_retries, model),
                )
                if text.strip():
                    return text
                logger.warning(
                    "LLM Responses API returned empty text; falling back to chat completions for model %s.",
                    model,
                )
            except Exception as e:
                self._responses_api_disabled_for_session = True
                _disable_responses_api_globally(self.base_url, model)
                logger.warning(
                    "LLM Responses API unavailable for model %s; falling back to chat completions "
                    "and disabling Responses for this client session/model: %s",
                    model,
                    e,
                )
            return self._call_chat_completions(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                model=model,
                response_format=response_format,
                max_retries=max_retries,
                allow_search_for_responses_model=True,
            )

        return self._call_chat_completions(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            model=model,
            response_format=response_format,
            max_retries=max_retries,
            allow_search_for_responses_model=responses_disabled,
        )

    def _call_chat_completions(
        self,
        *,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
        model: str,
        response_format: dict | None,
        max_retries: int,
        allow_search_for_responses_model: bool,
    ) -> str:
        """Call chat completions, optionally using DashScope search as a Responses fallback."""

        kwargs = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if self._chat_supports_temperature(model=model):
            kwargs["temperature"] = temperature
        reasoning_effort = self._chat_reasoning_effort(model=model)
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
        if response_format:
            kwargs["response_format"] = response_format
        if self.stream:
            kwargs["stream"] = True
            kwargs["stream_options"] = {"include_usage": True}
        extra_body = self._chat_extra_body(
            model=model,
            allow_search_for_responses_model=allow_search_for_responses_model,
        )
        if extra_body:
            kwargs["extra_body"] = extra_body

        accumulated_content = ""
        for attempt in range(max_retries):
            try:
                response = self.client.chat.completions.create(**kwargs)
                if self.stream:
                    text, stream_usage, finish_reason = self._collect_streaming_chat_completion_text(response)
                    retryable_output_issue = ""
                    if finish_reason == "length":
                        retryable_output_issue = "truncated"
                    elif not text.strip():
                        retryable_output_issue = "empty_response"
                    self._record_usage(
                        model=model,
                        endpoint="chat.completions",
                        usage=stream_usage,
                        max_tokens=max_tokens,
                        finish_reason=finish_reason,
                        retryable_output_issue=retryable_output_issue,
                    )
                    if finish_reason == "length":
                        logger.warning("LLM stream stopped because max_tokens=%s was reached.", max_tokens)
                        if attempt < max_retries - 1:
                            kwargs["max_tokens"] = self._expanded_max_tokens(int(kwargs["max_tokens"]))
                            max_tokens = int(kwargs["max_tokens"])
                            if self._should_continue_truncated_text(text, response_format):
                                accumulated_content += text
                                kwargs["messages"] = self._continuation_messages(messages, accumulated_content)
                            self._sleep_before_retry(
                                attempt,
                                reason=(
                                    "LLM stream was truncated "
                                    f"(attempt {attempt + 1}/{max_retries}); expanded max_tokens to {max_tokens}."
                                ),
                            )
                            continue
                        raise LLMOutputError("LLM stream was truncated after retries.")
                    if not text.strip():
                        if attempt < max_retries - 1:
                            self._sleep_before_retry(
                                attempt,
                                reason=(
                                    "LLM stream returned empty text "
                                    f"(attempt {attempt + 1}/{max_retries})."
                                ),
                            )
                            continue
                        raise LLMOutputError("LLM stream returned empty text after retries.")
                    return accumulated_content + text
                choice = response.choices[0]
                finish_reason = getattr(choice, "finish_reason", None)
                content = choice.message.content or ""
                retryable_output_issue = ""
                if finish_reason == "length":
                    retryable_output_issue = "truncated"
                elif not content.strip():
                    retryable_output_issue = "empty_response"
                event = self._record_usage(
                    model=model,
                    endpoint="chat.completions",
                    usage=getattr(response, "usage", None),
                    max_tokens=max_tokens,
                    finish_reason=finish_reason,
                    retryable_output_issue=retryable_output_issue,
                )
                if event["near_truncation"]:
                    logger.warning(
                        "LLM response used %s/%s completion tokens; output may be near truncation.",
                        event["completion_tokens"],
                        max_tokens,
                    )
                if finish_reason == "length":
                    logger.warning("LLM response stopped because max_tokens=%s was reached.", max_tokens)
                    if attempt < max_retries - 1:
                        kwargs["max_tokens"] = self._expanded_max_tokens(int(kwargs["max_tokens"]))
                        max_tokens = int(kwargs["max_tokens"])
                        if self._should_continue_truncated_text(content, response_format):
                            accumulated_content += content
                            kwargs["messages"] = self._continuation_messages(messages, accumulated_content)
                        self._sleep_before_retry(
                            attempt,
                            reason=(
                                "LLM response was truncated "
                                f"(attempt {attempt + 1}/{max_retries}); expanded max_tokens to {max_tokens}."
                            ),
                        )
                        continue
                    raise LLMOutputError("LLM response was truncated after retries.")
                if not content.strip():
                    if attempt < max_retries - 1:
                        self._sleep_before_retry(
                            attempt,
                            reason=(
                                "LLM returned empty text "
                                f"(attempt {attempt + 1}/{max_retries})."
                            ),
                        )
                        continue
                    raise LLMOutputError("LLM returned empty text after retries.")
                return accumulated_content + content
            except LLMOutputError:
                raise
            except Exception as e:
                self._record_api_error(
                    model=model,
                    endpoint="chat.completions",
                    max_tokens=max_tokens,
                    error=e,
                    attempt=attempt + 1,
                    max_retries=max_retries,
                )
                if attempt < max_retries - 1:
                    self._sleep_before_retry(
                        attempt,
                        reason=f"LLM call failed (attempt {attempt + 1}/{max_retries}): {e}.",
                    )
                else:
                    raise

    def _should_use_responses_api(
        self,
        *,
        model: str,
        messages: list[dict],
        response_format: dict | None,
    ) -> bool:
        if response_format is not None:
            return False
        if not _messages_are_plain_text(messages):
            return False
        if self.use_responses_api:
            return True
        return False

    def _responses_max_retries(self, max_retries: int, model: str) -> int:
        """Bound Responses retries before falling back to chat completions.

        DashScope-compatible Responses search can return a successful HTTP
        response with empty streamed content. Retrying that endpoint five times
        adds a long delay before the reliable chat-completions fallback. Keep a
        small retry budget for transient empties, then fall back with search
        enabled via chat extra_body.
        """
        if (
            self.enable_search
            and _is_dashscope_compatible_base_url(self.base_url)
            and _is_dashscope_responses_search_model(model)
        ):
            return max(1, min(int(max_retries), 2))
        return max_retries

    def _chat_extra_body(self, *, model: str, allow_search_for_responses_model: bool = False) -> dict | None:
        if _is_deepseek_v4_chat(self.base_url, model):
            thinking_enabled = self.enable_thinking is not False
            return {
                "thinking": {
                    "type": "enabled" if thinking_enabled else "disabled",
                },
            }
        if not _is_dashscope_compatible_base_url(self.base_url):
            return None
        enable_search = self.enable_search and (
            allow_search_for_responses_model
            or not _is_dashscope_responses_search_model(model)
            or not self.use_responses_api
        )
        return _dashscope_extra_body(
            enable_search=enable_search,
            enable_thinking=self.enable_thinking,
            force_search=self.force_search,
            search_strategy=self.search_strategy,
        )

    def _chat_reasoning_effort(self, *, model: str) -> str | None:
        if not _is_deepseek_v4_chat(self.base_url, model):
            return None
        if self.enable_thinking is False:
            return None
        return self.reasoning_effort or "high"

    def _chat_supports_temperature(self, *, model: str) -> bool:
        return not (
            _is_deepseek_v4_chat(self.base_url, model)
            and self.enable_thinking is not False
        )

    def _call_responses(
        self,
        *,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
        model: str,
        max_retries: int,
    ) -> str:
        input_items = [
            {
                "role": item.get("role", "user"),
                "content": [{"type": "input_text", "text": str(item.get("content") or "")}],
            }
            for item in messages
        ]
        kwargs = {
            "model": model,
            "input": input_items,
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if self.stream:
            kwargs["stream"] = True
        if self.enable_search:
            kwargs["tools"] = [{"type": "web_search"}]
        extra_body = _dashscope_extra_body(
            enable_search=False,
            enable_thinking=self.enable_thinking,
            force_search=self.force_search,
            search_strategy=self.search_strategy,
        )
        if extra_body:
            kwargs["extra_body"] = extra_body

        for attempt in range(max_retries):
            try:
                response = self.client.responses.create(**kwargs)
                if self.stream:
                    text, stream_usage, stream_status = self._collect_streaming_response(response)
                    usage = stream_usage
                    status = stream_status
                else:
                    text = getattr(response, "output_text", None) or self._responses_output_to_text(response)
                    usage = getattr(response, "usage", None)
                    status = getattr(response, "status", None)
                retryable_output_issue = ""
                if not (text or "").strip():
                    retryable_output_issue = "empty_response"
                elif str(status or "").lower() in {"incomplete", "cancelled", "failed"}:
                    retryable_output_issue = f"status:{status}"
                self._record_usage(
                    model=model,
                    endpoint="responses",
                    usage=usage,
                    max_tokens=max_tokens,
                    finish_reason=status,
                    retryable_output_issue=retryable_output_issue,
                )
                if retryable_output_issue:
                    if retryable_output_issue == "status:incomplete" and attempt < max_retries - 1:
                        kwargs["max_output_tokens"] = self._expanded_max_tokens(int(kwargs["max_output_tokens"]))
                        max_tokens = int(kwargs["max_output_tokens"])
                    if attempt < max_retries - 1:
                        self._sleep_before_retry(
                            attempt,
                            reason=(
                                "LLM Responses API returned unusable output "
                                f"({retryable_output_issue}, attempt {attempt + 1}/{max_retries})."
                            ),
                        )
                        continue
                    raise LLMOutputError(
                        f"LLM Responses API returned unusable output after retries: {retryable_output_issue}"
                    )
                return text or ""
            except LLMOutputError:
                raise
            except Exception as e:
                if self._should_fallback_from_responses_error(e):
                    raise
                if attempt < max_retries - 1:
                    self._sleep_before_retry(
                        attempt,
                        reason=f"LLM responses call failed (attempt {attempt + 1}/{max_retries}): {e}.",
                    )
                else:
                    raise

    @staticmethod
    def _responses_output_to_text(response) -> str:
        chunks: list[str] = []
        for item in getattr(response, "output", []) or []:
            for content in getattr(item, "content", []) or []:
                text = getattr(content, "text", None)
                if text:
                    chunks.append(text)
        return "".join(chunks)

    @staticmethod
    def _collect_streaming_response(stream) -> tuple[str, dict[str, int], str | None]:
        chunks: list[str] = []
        usage_data = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        status = None
        for event in stream:
            event_type = getattr(event, "type", "")
            if event_type == "response.output_text.delta":
                delta = getattr(event, "delta", "")
                if delta:
                    chunks.append(delta)
            response = getattr(event, "response", None)
            if response is not None:
                response_status = getattr(response, "status", None)
                if response_status:
                    status = response_status
                usage = getattr(response, "usage", None)
                if usage:
                    usage_data = _usage_dict_from_usage(usage)
            usage = getattr(event, "usage", None)
            if usage:
                usage_data = _usage_dict_from_usage(usage)
            if event_type == "response.completed":
                output_text = getattr(response, "output_text", None)
                if output_text and not chunks:
                    chunks.append(output_text)
                status = status or "completed"
            elif event_type == "response.incomplete":
                status = status or "incomplete"
            elif event_type == "response.failed":
                status = status or "failed"
            elif event_type == "response.cancelled":
                status = status or "cancelled"
        return "".join(chunks), usage_data, status

    @staticmethod
    def _collect_streaming_response_text(stream) -> str:
        text, _usage, _status = LLMClient._collect_streaming_response(stream)
        return text

    @staticmethod
    def _collect_streaming_chat_completion_text(stream) -> tuple[str, dict[str, int], str | None]:
        chunks: list[str] = []
        usage_data = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        finish_reason = None
        for chunk in stream:
            for choice in getattr(chunk, "choices", []) or []:
                delta = getattr(choice, "delta", None)
                content = getattr(delta, "content", None)
                if content:
                    chunks.append(content)
                choice_finish = getattr(choice, "finish_reason", None)
                if choice_finish:
                    finish_reason = choice_finish
            usage = getattr(chunk, "usage", None)
            if usage and getattr(usage, "total_tokens", None):
                usage_data = _usage_dict_from_usage(usage)
        return "".join(chunks), usage_data, finish_reason

    @staticmethod
    def _should_fallback_from_responses_error(error: Exception) -> bool:
        text = str(error).lower()
        return "workspaceid" in text or "workspace id" in text or "missing required parameter" in text

    @staticmethod
    def _encode_image(path: str) -> str:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
