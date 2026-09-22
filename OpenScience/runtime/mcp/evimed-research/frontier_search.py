#!/usr/bin/env python3
"""Search 「前沿动态」, the platform's feed of recent medical developments,
through the server's gateway.

A tool the model chooses, never a retrieval forced into a turn (principle 12):
nothing tells the model to call it first, and a question about settled
knowledge is answered without it. The description is three sentences because
it rides every request (principle 16) -- what it searches, when it helps, and
that its results are leads; how to use an answer travels in the answer.

Leads, not evidence (plan 2026-09-21 §4.8). Each item points at a primary
text -- a paper, a regulator's notice, a guideline, a company release -- with
the feed's own Chinese title, short digest and reason to read it. The feed's
pipeline checked the digest's numbers against the source, but an answer must
not rest on a digest: the model reads the original through the returned
address or identifiers and cites that original. So the result carries no
`sources` (the run's evidence ledger records what is read next, not this
list), and a preprint's flag says 「尚未经同行评议」 in the words an answer
has to use for it.

The runtime does not know where the feed lives. It posts to the server's own
route with the same runtime token as the public-source gateway, and the
server answers from the module's published items as the account running this
conversation sees them on its page. With the module off -- or not open to
this account yet -- the runtime is given no route and the tool answers
`frontier_disabled` without a request; the conversation carries on with the
other tools.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone

import public_sources

MAX_QUERY = 200
MAX_LIMIT = 20
MAX_RESPONSE_BYTES = 1024 * 1024
# The gateway answers within five seconds or says it timed out; this only
# bounds a server that never answers at all.
TIMEOUT_SECONDS = 15
# The feed's closed vocabularies, as `packages/domain/src/frontierVocabulary.mjs`
# defines them. `apps/server/test/evimedMcp.test.mjs` asks this server for the
# schema and holds these copies equal to the domain's.
LANES = ("evidence", "guideline", "regulatory", "safety", "pipeline", "public-health", "research", "ai")
SPECIALTIES = (
    "cardiology", "oncology", "endocrinology", "neurology", "psychiatry", "infectious-disease", "respiratory",
    "critical-care", "gastroenterology", "nephrology", "rheumatology", "hematology", "pediatrics",
    "obstetrics-gynecology", "geriatrics", "surgery-anesthesia", "radiology", "pharmacy", "tcm", "public-health",
    "general-practice",
)
WINDOWS = ("24h", "3d", "7d", "30d")
MODES = ("selected", "all")
GATEWAY_CODE = re.compile(r"^frontier_[a-z0-9_]{1,60}$")
# How a flag reads to the model. The feed's own label for a preprint is
# 「未经同行评议」; an answer has to say 「尚未经同行评议」, so the flag says it
# in those words (plan §4.8).
FLAG_WORDING = {"preprint": "预印本，尚未经同行评议"}
SAFETY_ALERT = "安全警示"
CAUTION_FLAGS = ("retracted", "expression-of-concern")


class FrontierSearchError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def tool_definitions():
    return [
        {
            "name": "frontier_search",
            "description": (
                "Search 前沿动态, EviMed's screened feed of recent medical developments (journal papers, guidelines, "
                "regulatory and safety notices, trial and industry news) from the last 24 hours to 30 days. "
                "Use it when a question asks what is new or recent; settled knowledge does not need it. "
                "Results are leads, not evidence: read the original through the returned DOI or link and cite that, never this feed."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_QUERY,
                        "description": "Keywords: drug, disease, trial, agency (Chinese or English). Omit to list the newest items.",
                    },
                    "lane": {"type": "string", "enum": list(LANES)},
                    "specialty": {"type": "string", "enum": list(SPECIALTIES)},
                    "window": {"type": "string", "enum": list(WINDOWS), "default": "30d"},
                    "mode": {
                        "type": "string",
                        "enum": list(MODES),
                        "default": "selected",
                        "description": "selected: the editors' picks; all: everything collected.",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "default": 8},
                },
                "additionalProperties": False,
            },
        }
    ]


def _gateway():
    url = os.environ.get("EVIMED_FRONTIER_GATEWAY_URL", "").strip()
    if not url:
        raise FrontierSearchError(
            "frontier_disabled",
            "前沿动态 (the frontier feed) is not available in this conversation: the deployment has it switched off "
            "or has not opened it to this account. Answer with the literature, guideline and regulatory tools.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise FrontierSearchError("frontier_search_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise FrontierSearchError("frontier_search_unconfigured", "The managed gateway token is unavailable.")
    return url, settings[1]


def _validated(arguments: dict) -> dict:
    payload = {}
    q = arguments.get("q")
    if q is not None:
        text = " ".join(q.split()) if isinstance(q, str) else ""
        if not text or len(text) > MAX_QUERY or any(ord(character) < 32 or ord(character) == 127 for character in text):
            raise FrontierSearchError(
                "frontier_search_query_invalid", "q must be non-empty text of at most %d characters." % MAX_QUERY
            )
        payload["q"] = text
    for field, allowed, code in (
        ("lane", LANES, "frontier_search_lane_invalid"),
        ("specialty", SPECIALTIES, "frontier_search_specialty_invalid"),
        ("window", WINDOWS, "frontier_search_window_invalid"),
        ("mode", MODES, "frontier_search_mode_invalid"),
    ):
        value = arguments.get(field)
        if value is None:
            continue
        if value not in allowed:
            raise FrontierSearchError(code, "%s must be one of: %s." % (field, ", ".join(allowed)))
        payload[field] = value
    limit = arguments.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            raise FrontierSearchError("frontier_search_limit_invalid", "limit must be an integer between 1 and %d." % MAX_LIMIT)
        payload["limit"] = limit
    return payload


def _instant(value):
    """An ISO instant with its zone, in UTC; anything else is no instant."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.astimezone(timezone.utc) if moment.tzinfo else None


def _minute(value):
    """An instant to the minute, in UTC: `2026-09-21T02:13Z`."""
    moment = _instant(value)
    return moment.strftime("%Y-%m-%dT%H:%MZ") if moment else None


def _published(entry):
    moment = _instant(entry.get("publishedAt"))
    if moment is None:
        return None
    # A day is all a day-precision (or inferred) date knows -- the feed keeps
    # it as that day's UTC midnight -- and a time of day would be invented.
    return moment.strftime("%Y-%m-%dT%H:%MZ") if entry.get("datePrecision") == "instant" else moment.strftime("%Y-%m-%d")


def _item(entry: dict) -> dict:
    """One lead as the model is shown it: absent facts are left out, not
    filled with nulls, so eight items stay near six thousand characters."""
    source = entry.get("source") if isinstance(entry.get("source"), dict) else {}
    title = entry.get("title") or entry.get("titleRaw")
    shown = {"title": title}
    if entry.get("titleRaw") and entry.get("titleRaw") != title:
        shown["originalTitle"] = entry["titleRaw"]
    for key in ("summary", "reason"):
        if entry.get(key):
            shown[key] = entry[key]
    if source.get("name"):
        shown["source"] = source["name"]
    if source.get("typeLabel") or source.get("type"):
        shown["sourceType"] = source.get("typeLabel") or source.get("type")
    if entry.get("evidenceTypeLabel") or entry.get("evidenceType"):
        shown["evidenceType"] = entry.get("evidenceTypeLabel") or entry.get("evidenceType")
    published = _published(entry)
    if published:
        shown["publishedAt"] = published
    collected = _minute(entry.get("visibleAt"))
    if collected:
        shown["collectedAt"] = collected
    for key in ("url", "doi", "pmid"):
        if entry.get(key):
            shown[key] = entry[key]
    if entry.get("registryIds"):
        shown["registryIds"] = entry["registryIds"]
    flags = [SAFETY_ALERT] if entry.get("safetyAlert") else []
    for flag in entry.get("flags") or []:
        if isinstance(flag, dict) and flag.get("key"):
            flags.append(FLAG_WORDING.get(flag["key"], flag.get("label") or flag["key"]))
    if flags:
        shown["flags"] = flags
    shown["selected"] = bool(entry.get("selected"))
    return shown


def _scope(query: dict) -> str:
    """The filters an answer covers, in the words of its summary line."""
    parts = ["the editors' picks" if query.get("mode") == "selected" else "all collected items"]
    for key in ("specialty", "lane"):
        if query.get(key):
            parts.append("%s %s" % (key, query[key]))
    parts.append("last %s" % query.get("window", "30d"))
    return ", ".join(parts)


def _answer(data: dict) -> dict:
    query = data.get("query") if isinstance(data.get("query"), dict) else {}
    entries = [entry for entry in data.get("items") or [] if isinstance(entry, dict)]
    items = [_item(entry) for entry in entries]
    scope = _scope(query)
    search_mode = data.get("searchMode")
    skipped = data.get("unselectedSkipped")
    subject = ' for "%s"' % query["q"] if query.get("q") else ""
    warnings = []
    next_actions = []
    if query.get("q") and search_mode == "keyword":
        warnings.append(
            "Matched by terms only (no semantic leg on this deployment): an item worded differently from the question can be missed."
        )
    if isinstance(skipped, int) and skipped > 0:
        warnings.append(
            '%d more item(s) matched outside the editors\' picks; call again with mode "all" to see them.' % skipped
        )
    if not items:
        summary = "No item in 前沿动态%s (%s)." % (subject, scope)
        warnings.append(
            "An empty feed is not evidence that nothing happened: it holds only what its sources published in the window."
        )
        next_actions.append(
            "Widen the window or the mode, or answer with the literature, guideline and regulatory tools."
        )
    else:
        summary = "Found %d item(s) in 前沿动态%s (%s%s)%s." % (
            len(items),
            subject,
            scope,
            "; %s search" % search_mode if query.get("q") and search_mode else "",
            "; more match" if data.get("more") else "",
        )
        next_actions.append(
            "These are leads: read the original through its url, doi or pmid before relying on an item, and cite that "
            "original, never this feed or its digest."
        )
        flags = [flag for item in items for flag in item.get("flags", [])]
        if FLAG_WORDING["preprint"] in flags:
            next_actions.append("Say 「尚未经同行评议」 wherever a preprint is used.")
        cautions = [entry for entry in entries if any(
            isinstance(flag, dict) and flag.get("key") in CAUTION_FLAGS for flag in entry.get("flags") or []
        )]
        if cautions:
            warnings.append("%d item(s) are retracted or under an expression of concern: do not use them as support." % len(cautions))
    body = {
        "query": query,
        "searchMode": search_mode,
        "asOf": _minute(data.get("asOf")),
        "count": len(items),
        "more": bool(data.get("more")),
        "items": items,
    }
    if isinstance(skipped, int):
        body["unselectedSkipped"] = skipped
    return {
        "status": "success" if items else "warning",
        "summary": summary,
        "data": body,
        "warnings": warnings,
        "next_actions": next_actions,
    }


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
            "user-agent": "EviMed-Research/1.2 (runtime frontier search)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = ""
        message = ""
        try:
            parsed_error = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code = parsed_error.get("code", "") if isinstance(parsed_error, dict) else ""
            message = parsed_error.get("error", "") if isinstance(parsed_error, dict) else ""
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code = ""
        # Only this gateway's own words reach the run: a code from anything else
        # on the path (a proxy, a misrouted request) is not one the run's
        # verdict knows how to read.
        if not isinstance(code, str) or not GATEWAY_CODE.match(code):
            code = "frontier_search_upstream_error"
        if not isinstance(message, str) or not message.strip() or len(message) > 300:
            message = "The 前沿动态 search gateway returned HTTP %d." % error.code
        raise FrontierSearchError(
            code,
            message,
            retryable=error.code in (429, 502, 503, 504) and code != "frontier_disabled",
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise FrontierSearchError("frontier_search_unavailable", "The 前沿动态 search gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise FrontierSearchError("frontier_search_response_too_large", "The 前沿动态 search answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrontierSearchError("frontier_search_response_invalid", "The 前沿动态 search gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise FrontierSearchError("frontier_search_response_invalid", "The 前沿动态 search gateway returned no items.")
    return _answer(data)
