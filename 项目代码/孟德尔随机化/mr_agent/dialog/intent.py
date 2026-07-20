# [IN] models.py, llm/client.py, llm/prompts.py
# [OUT] Intent classification result
# [POS] mr_agent/dialog/intent.py - Intent recognition
"""Intent recognition from user messages."""

from __future__ import annotations

import logging

from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import INTENT_RECOGNITION, INTENT_SCHEMA, SYSTEM_DIALOG
from mr_agent.models import Intent

logger = logging.getLogger(__name__)


def recognize_intent(
    message: str,
    llm: LLMClient,
) -> dict:
    """Recognize user intent and extract entities from message."""
    prompt = INTENT_RECOGNITION.format(message=message)
    result = llm.chat_structured(
        prompt=prompt,
        schema=INTENT_SCHEMA,
        system=SYSTEM_DIALOG,
        model_tier="flash",
    )
    return _normalize_result(result)


def _normalize_result(result: dict) -> dict:
    """Ensure result has all expected fields, merging outcomes array."""
    intent_str = result.get("intent", "unknown")
    try:
        Intent(intent_str)
    except ValueError:
        intent_str = "unknown"
    # Merge outcome (single) + outcomes (array) into deduplicated list
    outcomes_raw = list(result.get("outcomes", []))
    single_outcome = result.get("outcome")
    if single_outcome and single_outcome not in outcomes_raw:
        outcomes_raw.insert(0, single_outcome)
    # Primary outcome is first in list
    primary_outcome = outcomes_raw[0] if outcomes_raw else None
    additional = outcomes_raw[1:] if len(outcomes_raw) > 1 else []
    return {
        "intent": intent_str,
        "exposure": result.get("exposure"),
        "outcome": primary_outcome,
        "outcomes": additional,
        "preferences": result.get("preferences", {}),
        "confidence": result.get("confidence", 0.5),
    }


def is_affirmative(message: str) -> bool:
    """Check if message is affirmative. Negative takes priority."""
    msg = message.strip().lower()
    if _is_negative_lowered(msg):
        return False
    # Exact match for short messages
    exact = {
        "yes", "y", "ok", "是", "对", "好", "嗯",
        "sure", "yeah", "yep", "go", "confirm",
    }
    if msg in exact:
        return True
    # Substring match for longer phrases
    phrases = [
        "是的", "对的", "好的", "没问题", "可以", "确认",
        "开始", "start", "proceed", "correct", "right",
    ]
    return any(kw in msg for kw in phrases)


def _is_negative_lowered(msg: str) -> bool:
    """Check if already-lowered message is negative."""
    exact = {"no", "n", "不", "否", "nope", "nah", "停"}
    if msg in exact:
        return True
    phrases = [
        "不是", "不对", "不要", "取消", "不行", "算了",
        "cancel", "stop",
    ]
    return any(kw in msg for kw in phrases)


def is_negative(message: str) -> bool:
    """Check if message is a negative response."""
    return _is_negative_lowered(message.strip().lower())
