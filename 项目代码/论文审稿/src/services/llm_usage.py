"""What this process spent at the model provider, for the EviMed runner.

EviMed's control plane records every model call in its usage ledger, and this
engine calls DeepSeek itself, so none of its tokens reached that ledger. The
client adds each response's provider-reported usage here; ``evimed_runner.py``
writes the totals into ``result.json`` as ``usage``, and the specialist adapter
forwards them to the control plane, which records one settled row per job
(purpose ``engine``). A job is one runner process, so process totals are job
totals.
"""

from __future__ import annotations

import threading
from collections import Counter
from typing import Any

_LOCK = threading.Lock()
_TOTALS = {"requests": 0, "cacheHitTokens": 0, "cacheMissTokens": 0, "outputTokens": 0}
_MODELS: Counter[str] = Counter()


def _field(usage: Any, name: str) -> Any:
    return usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def record(usage: Any, model: str | None = None) -> None:
    """Add one provider response's usage; a response that carried none adds nothing."""
    if usage is None:
        return
    prompt = _count(_field(usage, "prompt_tokens"))
    hit = _count(_field(usage, "prompt_cache_hit_tokens"))
    reported_miss = _field(usage, "prompt_cache_miss_tokens")
    # DeepSeek splits the prompt into cache hits and misses. A response that
    # does not is charged whole at the miss rate, the one that cannot flatter
    # what the job cost.
    miss = _count(reported_miss) if reported_miss is not None else max(0, prompt - hit)
    with _LOCK:
        _TOTALS["requests"] += 1
        _TOTALS["cacheHitTokens"] += hit
        _TOTALS["cacheMissTokens"] += miss
        _TOTALS["outputTokens"] += _count(_field(usage, "completion_tokens"))
        if model:
            _MODELS[str(model)] += 1


def snapshot() -> dict[str, Any]:
    """The totals as the runner reports them.

    A managed job runs one model (the adapter pins it); should a job use more
    than one, the most-used names the report, which is the one a single price
    can be read against.
    """
    with _LOCK:
        model = _MODELS.most_common(1)[0][0] if _MODELS else ""
        return {**_TOTALS, "model": model}


def reset() -> None:
    with _LOCK:
        for key in _TOTALS:
            _TOTALS[key] = 0
        _MODELS.clear()
