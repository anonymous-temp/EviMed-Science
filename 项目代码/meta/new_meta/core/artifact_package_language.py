"""Shared language helpers for artifact package reviews."""
from __future__ import annotations

from typing import Any


def normalize_review_language(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"zh", "cn", "chinese", "中文", "汉语", "简体中文"}:
        return "zh"
    if raw in {"en", "eng", "english", "英文"}:
        return "en"
    return ""


def is_zh_review_language(language: str) -> bool:
    return normalize_review_language(language) == "zh"


def html_lang(language: str) -> str:
    return "zh" if is_zh_review_language(language) else "en"
