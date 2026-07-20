"""EviMed evidence retrieval API client (指南检索).

Contract per 接口文档/EviMed医学证据检索.md (V1.0):
``POST {base}/review/api/guide`` with ``Authorization: Bearer <key>``,
body ``{query, count?, startYear?, endYear?, publishers?, language?}``,
response ``{code, msg, data: {total, list}}``; 401/403/429/500 map to
typed failures.

The layer is optional: when the URL or both credential sources
(``EVIMED_EVIDENCE_SEARCH_KEY_FILE`` and ``EVIMED_EVIDENCE_SEARCH_KEY``) are
unset, the client reports ``enabled=False`` and callers skip the layer with a
visible note instead of failing.
"""

from __future__ import annotations

from typing import Any

import httpx

from safety_agent.core.config import Settings
from safety_agent.core.exceptions import EvidenceSearchError
from safety_agent.core.logging import get_logger

from .models import EvidenceItem

logger = get_logger(__name__)

_GUIDE_PATH = "/review/api/guide"


class EviMedEvidenceClient:
    """Thin async client for the EviMed guideline retrieval endpoint."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._enabled = bool(base_url and api_key)
        self._client: httpx.AsyncClient | None = None
        if self._enabled:
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
    def from_settings(cls, settings: Settings, **overrides: Any) -> "EviMedEvidenceClient":
        return cls(
            settings.evimed_evidence_search_url,
            settings.resolved_evimed_evidence_search_key.get_secret_value(),
            **overrides,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def search_guidelines(
        self,
        query: str,
        *,
        count: int = 5,
        language: str = "zh",
        start_year: int | None = None,
        end_year: int | None = None,
        publishers: list[str] | None = None,
    ) -> list[EvidenceItem]:
        """Retrieve guideline records; raises EvidenceSearchError on failure."""
        if not self._enabled or self._client is None:
            raise EvidenceSearchError("EviMed evidence client is not configured")
        body: dict[str, Any] = {"query": query, "count": count, "language": language}
        if start_year is not None:
            body["startYear"] = start_year
        if end_year is not None:
            body["endYear"] = end_year
        if publishers:
            body["publishers"] = publishers
        try:
            response = await self._client.post(_GUIDE_PATH, json=body)
        except httpx.TransportError as exc:
            raise EvidenceSearchError("EviMed evidence API unreachable", detail=str(exc)) from exc
        if response.status_code != 200:
            raise EvidenceSearchError(
                f"EviMed evidence API answered HTTP {response.status_code}",
                detail=_truncate(response.text),
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise EvidenceSearchError("EviMed evidence API returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise EvidenceSearchError("EviMed evidence API returned a non-object payload")
        code = payload.get("code")
        if code != 200:
            raise EvidenceSearchError(
                f"EviMed evidence API returned code {code}",
                detail=str(payload.get("msg", ""))[:300],
            )
        data = payload.get("data")
        items = data.get("list") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise EvidenceSearchError("EviMed evidence API payload misses data.list")
        results = [item for raw in items if (item := _parse_item(raw)) is not None]
        logger.info("EviMed evidence search %r returned %d items", query, len(results))
        return results


def _parse_item(raw: Any) -> EvidenceItem | None:
    if not isinstance(raw, dict):
        return None
    title = raw.get("title") or raw.get("name") or raw.get("guideName")
    if not isinstance(title, str) or not title.strip():
        return None
    year = raw.get("year") or raw.get("publishYear")
    url = raw.get("url") or raw.get("link")
    publisher = raw.get("publisher") or raw.get("organization") or raw.get("source")
    return EvidenceItem(
        title=title.strip(),
        publisher=publisher if isinstance(publisher, str) else None,
        year=year if isinstance(year, int) else None,
        url=url if isinstance(url, str) else None,
        raw=raw,
    )


def _truncate(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[:limit] + "..."
