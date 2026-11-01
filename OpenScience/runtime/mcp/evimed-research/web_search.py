#!/usr/bin/env python3
"""Open-web search, through the server's metasearch gateway.

Every other connector here answers about indexed literature. This one answers
about what the indexes do not carry — a funding call, a conference programme, a
society's own recommendation page, a registry a field uses, a method a lab
describes only on its own site — which is what widens a research direction
before it is narrowed.

The runtime does not know which aggregator or which engines sit behind the
gateway, and does not construct a search URL: it posts a query to the server's
own route and receives normalized results. The same runtime token as the
public-source gateway authorizes it, and when the deployment has no metasearch
backend the call fails with a stated reason rather than returning nothing and
letting a run read that as an empty field.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import public_sources
import source_transport

MAX_QUERY = 512
MAX_RESULTS = 25
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
CATEGORIES = ("general", "science", "news", "it", "files")
TIME_RANGES = ("day", "week", "month", "year")


class WebSearchError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        # How long the gateway asked the caller to wait (whole seconds), for a refusal that is a pace and not a verdict.
        self.retry_after = retry_after


def _gateway():
    url = os.environ.get("EVIMED_WEB_SEARCH_GATEWAY_URL", "").strip()
    if not url:
        raise WebSearchError(
            "web_search_unconfigured",
            "Open-web search is not enabled for this deployment. A page whose address is known can still be read "
            "with web_read.",
        )
    settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    if settings is None:
        raise WebSearchError("web_search_unconfigured", "The managed gateway token is unavailable.")
    return url, settings[1]


def _validated(arguments: dict) -> dict:
    query = str(arguments.get("query") or "").strip()
    if not query or len(query) > MAX_QUERY:
        raise WebSearchError("web_search_query_invalid", "A non-empty query of at most %d characters is required." % MAX_QUERY)
    payload = {"query": query}

    limit = arguments.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS:
            raise WebSearchError("web_search_limit_invalid", "limit must be an integer between 1 and %d." % MAX_RESULTS)
        payload["limit"] = limit

    categories = arguments.get("categories")
    if categories:
        values = categories if isinstance(categories, list) else [categories]
        for value in values:
            if value not in CATEGORIES:
                raise WebSearchError("web_search_categories_invalid", "categories must be drawn from: %s." % ", ".join(CATEGORIES))
        payload["categories"] = values

    language = arguments.get("language")
    if language:
        payload["language"] = str(language).strip()

    time_range = arguments.get("timeRange")
    if time_range:
        if time_range not in TIME_RANGES:
            raise WebSearchError("web_search_time_range_invalid", "timeRange must be one of: %s." % ", ".join(TIME_RANGES))
        payload["timeRange"] = time_range
    return payload


def _refusal(error: urllib.error.HTTPError):
    """What the gateway said of a refusal: its code, its sentence and how long it asked the caller to wait.

    The gateway answers `{error: <sentence>, code, retryAfterSeconds?}` and a `Retry-After` header; the nested envelope the
    public-source gateway uses is read too. Whatever cannot be read is left out: the status is the finding, not the parse.
    """
    code, said, wait = "", "", None
    try:
        body = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
        if isinstance(body, dict):
            nested = body.get("error") if isinstance(body.get("error"), dict) else {}
            code = body.get("code") or nested.get("code") or ""
            said = body.get("error") if isinstance(body.get("error"), str) else (nested.get("message") or body.get("message") or "")
            seconds = body.get("retryAfterSeconds", nested.get("retryAfterSeconds"))
            if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
                wait = seconds
    except Exception:  # noqa: BLE001
        pass
    if wait is None:
        wait = source_transport.parse_retry_after(error.headers.get("Retry-After") if getattr(error, "headers", None) is not None else None)
    if isinstance(wait, (int, float)):
        wait = min(max(int(wait), 0), source_transport.MAX_RETRY_AFTER_SECONDS)
    return (code if isinstance(code, str) else ""), (said if isinstance(said, str) else ""), wait


def search(arguments: dict) -> dict:
    payload = _validated(arguments)
    url, token = _gateway()
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.2 (runtime web search)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=60) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code, said, wait = _refusal(error)
        message = "The web-search gateway returned HTTP %d" % error.code
        message += (": %s" % said.rstrip(".")) if said else ""
        raise WebSearchError(
            code or "web_search_upstream_error",
            message + ".",
            retryable=error.code in (429, 502, 503, 504),
            retry_after=wait,
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise WebSearchError("web_search_unavailable", "The web-search gateway is unreachable.", retryable=True) from error

    if len(body) > MAX_RESPONSE_BYTES:
        raise WebSearchError("web_search_response_too_large", "The web-search response exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WebSearchError("web_search_response_invalid", "The web-search gateway returned a non-JSON response.") from error

    data = parsed.get("data") or {}
    results = data.get("results") or []
    warnings = list(parsed.get("warnings") or [])
    engines = data.get("engines") or []
    if engines:
        warnings.append("Answered by: %s. Engine availability is a deployment fact; a thin result set may mean few engines answered, not few pages exist." % ", ".join(engines))
    return {
        "status": "success" if results else "warning",
        "summary": "Open-web search returned %d result(s) for %r." % (len(results), data.get("query")),
        "data": data,
        "warnings": warnings,
        "next_actions": [
            "Treat every result as an unreviewed page: follow it to the primary record before any claim from it enters a report.",
            "For anything that is published literature, re-find it through evimed_biomedical_source_search so it carries an identifier.",
        ],
    }
