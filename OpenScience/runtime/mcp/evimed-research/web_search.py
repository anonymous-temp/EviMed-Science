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

MAX_QUERY = 512
MAX_RESULTS = 25
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
CATEGORIES = ("general", "science", "news", "it", "files")
TIME_RANGES = ("day", "week", "month", "year")


class WebSearchError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _gateway():
    url = os.environ.get("EVIMED_WEB_SEARCH_GATEWAY_URL", "").strip()
    if not url:
        raise WebSearchError(
            "web_search_unconfigured",
            "Open-web search is not enabled for this deployment. The bibliographic channels "
            "(PubMed, Europe PMC, OpenAlex, Semantic Scholar, Crossref, preprints) remain available.",
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
        detail = ""
        try:
            detail = json.loads(error.read(64 * 1024).decode("utf-8", "replace")).get("code", "")
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            detail = ""
        raise WebSearchError(
            detail or "web_search_upstream_error",
            "The web-search gateway returned HTTP %d." % error.code,
            retryable=error.code in (429, 502, 503, 504),
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
