#!/usr/bin/env python3
"""Search the researcher's own knowledge base, through the server's gateway.

A tool the model chooses, never a retrieval forced into a turn (principle 12).
The description stays short because it rides every request; what to do with
an answer — read a small library whole, quote a snippet verbatim, read the
file for context — is carried in the answer itself (principle 16).

The runtime does not know where the index lives or how it ranks: it posts a
question to the server's own route with the same runtime token as the
public-source gateway, and the server answers from the documents of the
project this runtime belongs to and its owner's personal library. With the
deployment's switch off the route is absent, and the tool says so instead of
the run reading silence as an empty knowledge base.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

import public_sources

MAX_QUERY = 512
MAX_LIMIT = 20
MAX_SOURCE_IDS = 50
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
SOURCE_ID = re.compile(r"^src_[a-f0-9]{32}$")

TOOL_NAMES = ("kb_search",)


class KbSearchError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def tool_definitions():
    return [
        {
            "name": "kb_search",
            "description": (
                "Search the researcher's own knowledge base (this project's uploaded documents and their personal library) "
                "for passages. Answers with quotable snippets, the document, page and character offsets; a small library is "
                "answered with the files to read instead."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": MAX_QUERY},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT},
                    "sourceIds": {
                        "type": "array",
                        "maxItems": MAX_SOURCE_IDS,
                        "items": {"type": "string", "pattern": SOURCE_ID.pattern},
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }
    ]


def _gateway():
    url = os.environ.get("EVIMED_KB_SEARCH_GATEWAY_URL", "").strip()
    if not url:
        raise KbSearchError(
            "kb_search_disabled",
            "Knowledge-base search is not enabled for this deployment. The documents are still in the workspace "
            "under .evimed-knowledge/: read or grep them directly.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise KbSearchError("kb_search_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise KbSearchError("kb_search_unconfigured", "The managed gateway token is unavailable.")
    return url, settings[1]


def _validated(arguments: dict) -> dict:
    query = str(arguments.get("query") or "").strip()
    if not query or len(query) > MAX_QUERY:
        raise KbSearchError("kb_search_query_invalid", "A non-empty query of at most %d characters is required." % MAX_QUERY)
    payload = {"query": query}
    limit = arguments.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            raise KbSearchError("kb_search_limit_invalid", "limit must be an integer between 1 and %d." % MAX_LIMIT)
        payload["limit"] = limit
    source_ids = arguments.get("sourceIds")
    if source_ids is not None:
        if not isinstance(source_ids, list) or len(source_ids) > MAX_SOURCE_IDS or not all(
            isinstance(value, str) and SOURCE_ID.match(value) for value in source_ids
        ):
            raise KbSearchError("kb_search_source_ids_invalid", "sourceIds must be at most %d source ids (src_…)." % MAX_SOURCE_IDS)
        payload["sourceIds"] = source_ids
    return payload


def _summary(data: dict) -> tuple[str, list[str], list[str]]:
    mode = data.get("mode")
    library = data.get("library") or {}
    if mode == "small-library":
        files = data.get("files") or []
        return (
            "The knowledge base is small (about %s tokens in %d documents): read the %d listed files directly."
            % (library.get("tokens"), library.get("searchable") or len(files), len(files)),
            [],
            ["Read the files at the listed paths; they are the documents whole, which a search would only show in fragments."],
        )
    if mode in ("empty", "indexing"):
        return (
            str(data.get("note") or "No searchable document yet."),
            [],
            ["Read any listed document directly at its path, or continue without the knowledge base."],
        )
    hits = data.get("hits") or []
    warnings = []
    if mode == "keyword":
        warnings.append("Searched by terms only (no semantic leg on this deployment): a passage worded differently from the question can be missed.")
    if not hits:
        return (
            "No passage in the knowledge base matched %r." % data.get("query"),
            warnings + ["No match is not evidence the documents are silent; read them if the answer must be certain."],
            ["Rephrase with the document's own terms (drug names, abbreviations), or read the documents directly."],
        )
    return (
        "Found %d passage(s) in the knowledge base (%s search)." % (len(hits), mode),
        warnings,
        [
            "Quote a snippet verbatim; start/end are its UTF-16 offsets in the document's parsed text.",
            "Read the document at `path` around the snippet before relying on it.",
        ],
    )


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
            "user-agent": "EviMed-Research/1.2 (runtime knowledge-base search)",
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
        raise KbSearchError(
            detail or "kb_search_upstream_error",
            "The knowledge-base search gateway returned HTTP %d." % error.code,
            retryable=error.code in (429, 502, 503, 504),
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise KbSearchError("kb_search_unavailable", "The knowledge-base search gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise KbSearchError("kb_search_response_too_large", "The knowledge-base search answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KbSearchError("kb_search_response_invalid", "The knowledge-base search gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise KbSearchError("kb_search_response_invalid", "The knowledge-base search gateway returned no data.")
    summary, warnings, next_actions = _summary(data)
    return {
        "status": "success" if (data.get("hits") or data.get("files")) else "warning",
        "summary": summary,
        "data": data,
        "warnings": warnings,
        "next_actions": next_actions,
    }
