"""Optional manuscript proofreader adapters.

The polish pipeline uses these adapters for review-only style/grammar signals.
They never rewrite manuscript text or optimize for detector evasion.
"""
from __future__ import annotations

from typing import Any

import requests


def language_tool_code(language: str | None) -> str:
    """Map MetaAgent style-audit language labels to LanguageTool language codes."""
    normalized = str(language or "").strip().lower()
    if normalized == "zh":
        return "zh-CN"
    return "en-US"


class LanguageToolProofreader:
    """Small HTTP adapter for a self-hosted LanguageTool server."""

    def __init__(self, server_url: str, *, timeout_seconds: float = 8.0, max_issues: int = 50):
        self.server_url = str(server_url or "").rstrip("/")
        self.timeout_seconds = float(timeout_seconds)
        self.max_issues = max(1, int(max_issues or 50))

    def check(self, text: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.server_url:
            raise ValueError("LanguageTool server_url is required")
        meta = meta or {}
        language_code = language_tool_code(str(meta.get("language") or ""))
        response = requests.post(
            f"{self.server_url}/v2/check",
            data={"text": str(text or ""), "language": language_code},
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        matches = payload.get("matches") if isinstance(payload, dict) else []
        issues = [_normalize_language_tool_match(item) for item in (matches or [])[: self.max_issues] if isinstance(item, dict)]
        return {
            "provider": "languagetool",
            "language_code": language_code,
            "issue_count": len(issues),
            "issues": issues,
        }


def _normalize_language_tool_match(match: dict[str, Any]) -> dict[str, Any]:
    rule = match.get("rule") if isinstance(match.get("rule"), dict) else {}
    category = rule.get("category") if isinstance(rule.get("category"), dict) else {}
    replacements = [
        str(item.get("value") or "")
        for item in (match.get("replacements") or [])[:3]
        if isinstance(item, dict) and item.get("value")
    ]
    return {
        "rule_id": str(rule.get("id") or ""),
        "issue_type": str(rule.get("issueType") or ""),
        "category_id": str(category.get("id") or ""),
        "category": str(category.get("name") or ""),
        "message": str(match.get("message") or ""),
        "short_message": str(match.get("shortMessage") or ""),
        "offset": int(match.get("offset") or 0),
        "length": int(match.get("length") or 0),
        "sentence": str(match.get("sentence") or ""),
        "replacements": replacements,
    }
