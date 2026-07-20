"""Async openFDA HTTP client: drug/event.json and drug/label.json.

Properties:
- exponential backoff with jitter on HTTP 429 / 5xx / transport errors
  (Retry-After honored when present), then a typed exception;
- two-level cache (memory + disk, default 24 h TTL) keyed by endpoint +
  canonical params, so repeated count queries cost no network calls;
- 404 NOT_FOUND maps to :class:`NoResults` — "zero matching reports" is a
  first-class outcome, not an error;
- responses are parsed defensively (``.get`` chains + explicit shape
  checks); any payload surprise raises :class:`OpenFDAError` with a
  sanitized message instead of a bare ``KeyError``/``TypeError``.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from safety_agent.core.cache import TwoLevelCache
from safety_agent.core.config import Settings
from safety_agent.core.exceptions import (
    NoResults,
    OpenFDAError,
    OpenFDARateLimited,
    OpenFDAUnavailable,
)

from .queries import EventQuery

logger = logging.getLogger("safety_agent.openfda")

EVENT_ENDPOINT = "drug/event.json"
LABEL_ENDPOINT = "drug/label.json"

# Label sections relevant to pharmacovigilance cross-checks.
_LABEL_SECTION_FIELDS = (
    "boxed_warning",
    "adverse_reactions",
    "warnings",
    "warnings_and_cautions",
)


@dataclass(frozen=True)
class CountTerm:
    term: str
    count: int


@dataclass(frozen=True)
class EventSearchResult:
    total: int
    search: str
    reports: tuple[dict[str, Any], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class DrugLabel:
    """One drug/label.json record reduced to the safety-relevant fields."""

    set_id: str
    effective_time: str | None
    brand_names: tuple[str, ...]
    generic_names: tuple[str, ...]
    boxed_warning: tuple[str, ...]
    adverse_reactions: tuple[str, ...]
    warnings: tuple[str, ...]
    warnings_and_cautions: tuple[str, ...]


class OpenFDAClient:
    """Thin async wrapper around the openFDA REST API."""

    def __init__(
        self,
        base_url: str = "https://api.fda.gov",
        *,
        api_key: str | None = None,
        cache: TwoLevelCache | None = None,
        timeout: float = 30.0,
        max_retries: int = 4,
        backoff_initial: float = 0.5,
        backoff_cap: float = 8.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if max_retries < 1:
            raise OpenFDAError("max_retries must be >= 1")
        self._cache = cache
        self._max_retries = max_retries
        self._backoff_initial = backoff_initial
        self._backoff_cap = backoff_cap
        self._sleep = sleep
        default_params: dict[str, str] = {}
        if api_key:
            default_params["api_key"] = api_key
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            params=default_params,
            headers={"Accept": "application/json"},
            transport=transport,
        )

    @classmethod
    def from_settings(cls, settings: Settings, **overrides: Any) -> "OpenFDAClient":
        """Build a client wired to the configured two-level cache."""
        cache = TwoLevelCache(settings.resolved_cache_dir, settings.cache_ttl_seconds)
        api_key = settings.openfda_api_key.get_secret_value() or None
        return cls(settings.openfda_base_url, api_key=api_key, cache=cache, **overrides)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "OpenFDAClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # -- high-level queries ----------------------------------------------

    async def count_total(self, search: str | None = None) -> int:
        """Total number of FAERS reports matching ``search`` (None = whole DB)."""
        params: dict[str, Any] = {"limit": 1}
        if search:
            params["search"] = search
        payload = await self._get_cached(EVENT_ENDPOINT, params)
        meta = payload.get("meta")
        results = meta.get("results") if isinstance(meta, dict) else None
        total = results.get("total") if isinstance(results, dict) else None
        if not isinstance(total, int) or total < 0:
            raise OpenFDAError(
                "openFDA response did not carry meta.results.total",
                detail=f"payload keys: {sorted(payload) if isinstance(payload, dict) else type(payload)}",
            )
        return total

    async def count_terms(
        self,
        count_field: str,
        search: str | None = None,
        *,
        limit: int = 100,
    ) -> list[CountTerm]:
        """``count=<field>.exact`` aggregation, e.g. reaction PT frequencies."""
        params: dict[str, Any] = {"count": count_field, "limit": limit}
        if search:
            params["search"] = search
        payload = await self._get_cached(EVENT_ENDPOINT, params)
        raw = payload.get("results")
        if not isinstance(raw, list):
            raise OpenFDAError(
                "openFDA count response did not carry a results list",
                detail=f"payload keys: {sorted(payload) if isinstance(payload, dict) else type(payload)}",
            )
        terms: list[CountTerm] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            term, count = item.get("term"), item.get("count")
            # term is a string for text fields (.exact) but an int for
            # numeric-coded fields such as patient.patientsex.
            if isinstance(term, str) and isinstance(count, int):
                terms.append(CountTerm(term=term, count=count))
            elif isinstance(term, int) and not isinstance(term, bool) and isinstance(count, int):
                terms.append(CountTerm(term=str(term), count=count))
        return terms

    async def search_events(
        self,
        query: EventQuery,
        *,
        limit: int = 10,
        skip: int = 0,
    ) -> EventSearchResult:
        """Fetch de-identified FAERS reports matching the structured query."""
        if not 1 <= limit <= 1000:
            raise OpenFDAError(f"limit {limit} out of openFDA range 1..1000")
        if skip < 0:
            raise OpenFDAError(f"skip {skip} must be >= 0")
        search = query.build_search()
        payload = await self._get_cached(
            EVENT_ENDPOINT, {"search": search, "limit": limit, "skip": skip}
        )
        total = self._payload_total(payload)
        reports = tuple(
            report
            for record in self._payload_results(payload)
            for report in [_parse_event_record(record)]
            if report is not None
        )
        return EventSearchResult(total=total, search=search, reports=reports)

    async def search_labels(
        self,
        drug: str | None = None,
        *,
        search: str | None = None,
        limit: int = 3,
    ) -> list[DrugLabel]:
        """FDA label records; ``drug`` matches generic or brand name."""
        if search is None:
            if not drug:
                raise OpenFDAError("search_labels needs a drug name or an explicit search")
            from .queries import quoted_term

            search = (
                f'({quoted_term("openfda.generic_name", drug)}'
                f' OR {quoted_term("openfda.brand_name", drug)})'
            )
        payload = await self._get_cached(LABEL_ENDPOINT, {"search": search, "limit": limit})
        labels: list[DrugLabel] = []
        for record in self._payload_results(payload):
            parsed = _parse_label_record(record)
            if parsed is not None:
                labels.append(parsed)
        return labels

    # -- transport with retry/backoff/cache --------------------------------

    async def _get_cached(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        key_parts = [endpoint] + [f"{k}={params[k]}" for k in sorted(params)]
        cache_key = TwoLevelCache.make_key(*key_parts)
        if self._cache is not None:
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.debug("cache hit for %s", endpoint)
                return cached
        payload = await self._get(endpoint, params)
        if self._cache is not None:
            self._cache.set(cache_key, payload)
        return payload

    async def _get(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        saw_rate_limit = False
        for attempt in range(self._max_retries):
            try:
                response = await self._client.get(endpoint, params=params)
            except httpx.TransportError as exc:
                last_error = exc
                logger.warning("openFDA transport error (attempt %d): %s", attempt + 1, exc)
                await self._backoff(attempt)
                continue
            if response.status_code == 200:
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise OpenFDAError("openFDA returned invalid JSON") from exc
                if not isinstance(payload, dict):
                    raise OpenFDAError("openFDA returned a non-object JSON payload")
                return payload
            if response.status_code == 404:
                raise NoResults(search=str(params.get("search", "")))
            if response.status_code == 429:
                saw_rate_limit = True
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                logger.warning(
                    "openFDA rate limited (attempt %d), retry_after=%s",
                    attempt + 1,
                    retry_after,
                )
                await self._backoff(attempt, retry_after=retry_after)
                continue
            if 500 <= response.status_code < 600:
                # openFDA reports malformed aggregations (e.g. counting a text
                # field without .exact) as 500 + illegal_argument_exception —
                # that is a query bug, not an outage; retrying cannot help.
                if "illegal_argument_exception" in response.text:
                    raise OpenFDAError(
                        "openFDA rejected the query (illegal argument, HTTP 500)",
                        status_code=response.status_code,
                        detail=_truncate(response.text),
                    )
                last_error = OpenFDAUnavailable(
                    "openFDA server error", status_code=response.status_code
                )
                logger.warning(
                    "openFDA %d (attempt %d)", response.status_code, attempt + 1
                )
                await self._backoff(attempt)
                continue
            # Remaining 4xx are client errors; retrying cannot help. The
            # upstream message goes to detail (logs), never verbatim to callers.
            raise OpenFDAError(
                f"openFDA rejected the query (HTTP {response.status_code})",
                status_code=response.status_code,
                detail=_truncate(response.text),
            )
        if saw_rate_limit and last_error is None:
            raise OpenFDARateLimited()
        if isinstance(last_error, OpenFDAUnavailable):
            raise OpenFDAUnavailable(
                "openFDA unavailable after retries",
                status_code=last_error.status_code,
            ) from last_error
        if saw_rate_limit:
            raise OpenFDARateLimited()
        raise OpenFDAUnavailable(
            "openFDA unreachable after retries",
            detail=str(last_error) if last_error else None,
        ) from last_error

    async def _backoff(self, attempt: int, retry_after: float | None = None) -> None:
        delay = min(self._backoff_cap, self._backoff_initial * (2**attempt))
        if retry_after is not None:
            delay = max(delay, min(retry_after, self._backoff_cap))
        delay += random.uniform(0.0, 0.25 * delay)
        await self._sleep(delay)

    # -- defensive payload helpers ------------------------------------------

    @staticmethod
    def _payload_results(payload: dict[str, Any]) -> list[Any]:
        results = payload.get("results")
        if results is None:
            return []
        if not isinstance(results, list):
            raise OpenFDAError("openFDA results field is not a list")
        return results

    @staticmethod
    def _payload_total(payload: dict[str, Any]) -> int:
        meta = payload.get("meta")
        results = meta.get("results") if isinstance(meta, dict) else None
        total = results.get("total") if isinstance(results, dict) else None
        return total if isinstance(total, int) and total >= 0 else 0


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def _truncate(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[:limit] + "..."


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _parse_event_record(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        return None
    report_id = record.get("safetyreportid")
    if not isinstance(report_id, str) or not report_id.strip():
        return None
    patient = record.get("patient")
    patient = patient if isinstance(patient, dict) else {}
    reactions = patient.get("reaction")
    drugs = patient.get("drug")
    return {
        "safetyreportid": report_id.strip(),
        "receivedate": record.get("receivedate"),
        "serious": record.get("serious"),
        "occurcountry": record.get("occurcountry"),
        "patientsex": patient.get("patientsex"),
        "patientonsetage": patient.get("patientonsetage"),
        "patientonsetageunit": patient.get("patientonsetageunit"),
        "reactions": [
            item.get("reactionmeddrapt")
            for item in (reactions if isinstance(reactions, list) else [])
            if isinstance(item, dict) and isinstance(item.get("reactionmeddrapt"), str)
        ],
        "drugs": [
            item.get("medicinalproduct")
            for item in (drugs if isinstance(drugs, list) else [])
            if isinstance(item, dict) and isinstance(item.get("medicinalproduct"), str)
        ],
    }


def _parse_label_record(record: Any) -> DrugLabel | None:
    if not isinstance(record, dict):
        return None
    openfda = record.get("openfda")
    openfda = openfda if isinstance(openfda, dict) else {}
    set_id = record.get("set_id") or record.get("id") or ""
    brand_names = _string_list(openfda.get("brand_name"))
    generic_names = _string_list(openfda.get("generic_name"))
    if not set_id and not brand_names and not generic_names:
        return None
    sections = {
        name: _string_list(record.get(name)) for name in _LABEL_SECTION_FIELDS
    }
    return DrugLabel(
        set_id=str(set_id),
        effective_time=record.get("effective_time") if isinstance(record.get("effective_time"), str) else None,
        brand_names=brand_names,
        generic_names=generic_names,
        boxed_warning=sections["boxed_warning"],
        adverse_reactions=sections["adverse_reactions"],
        warnings=sections["warnings"],
        warnings_and_cautions=sections["warnings_and_cautions"],
    )
