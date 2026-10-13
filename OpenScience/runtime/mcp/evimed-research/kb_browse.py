#!/usr/bin/env python3
"""Find one's way through the researcher's knowledge base, through the server's gateway.

`kb_search` answers a question with passages. This is for the questions a passage cannot
answer -- what the knowledge base holds, how several documents relate -- by looking at it as
a tree: the wiki compiled from the project's documents (its table of contents, a page), the
knowledge graph, and the documents themselves by their lines.

A tool the model chooses, never a step forced into a turn (principle 12): a plain question is
answered without it. The description stays short because it rides every request; how to read
an answer -- that a page is an index into the documents and never evidence, which document a
page names, what to call next -- travels in the answer (principle 16).

The runtime never names an address. It posts an operation, one of four roots and a path
inside that root to the server's own route with the same runtime token as the public-source
gateway; the server builds the address from the account and the project of that token, and
answers with documents by id and title and pages by path, title and type. With the knowledge
switch off the route is absent and the tool says so, pointing the run at `kb_search` and the
files, instead of the run reading silence as an empty knowledge base.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

import public_sources

OPS = ("list", "tree", "overview", "read", "grep")
ROOTS = ("sources", "wiki", "kg", "library")
MAX_PATH = 480
MAX_PATTERN = 200
MAX_OFFSET = 1_000_000
MAX_LIMIT = 400
MAX_RESPONSE_BYTES = 1024 * 1024
# The gateway answers within twenty seconds or says it timed out; this only bounds a server that never answers.
TIMEOUT_SECONDS = 30
GATEWAY_CODE = re.compile(r"^kb_browse_[a-z0-9_]{1,60}$")
# What a later call may get past: an outage, a slow engine, a loop's own pace.
RETRYABLE_CODES = ("kb_browse_unavailable", "kb_browse_timeout", "kb_browse_rate_limited", "kb_browse_upstream_error")

TOOL_NAMES = ("kb_browse",)


class KbBrowseError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def tool_definitions():
    return [
        {
            "name": "kb_browse",
            "description": (
                "Find your way through the researcher's knowledge base as a tree, when a question spans several documents or asks "
                "what the knowledge base holds: op=overview (root wiki: its table of contents; kg: the graph's entity and relation "
                "counts; sources or library: the documents by title), list or tree (a directory, a subtree), read (a page or a "
                "document, by lines), grep (the lines holding a text). Pages are summaries compiled from the documents. "
                "Not for a passage to quote -- that is kb_search -- and a question that needs no knowledge base needs no tool."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": list(OPS)},
                    "root": {
                        "type": "string",
                        "enum": list(ROOTS),
                        "default": "wiki",
                        "description": "wiki: compiled pages; kg: knowledge graph; sources: this project's documents; "
                                       "library: the cross-project library.",
                    },
                    "path": {
                        "type": "string",
                        "maxLength": MAX_PATH,
                        "description": "Relative path inside the root, as a listing or a page's link gives it. "
                                       "Required for read; default: the root. Not for overview.",
                    },
                    "pattern": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_PATTERN,
                        "description": "grep only: plain text matched as written, case ignored; not a regular expression.",
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_OFFSET,
                        "default": 0,
                        "description": "read: lines to skip; list: entries to skip.",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_LIMIT,
                        "description": "read: lines (default 200, at most 400); list: entries (default 100, at most 200). "
                                       "tree answers at most 300 entries, grep 50 lines.",
                    },
                },
                "required": ["op"],
                "additionalProperties": False,
            },
        }
    ]


def _gateway():
    url = os.environ.get("EVIMED_KB_BROWSE_GATEWAY_URL", "").strip()
    if not url:
        raise KbBrowseError(
            "kb_browse_disabled",
            "Knowledge-base browsing is not enabled for this deployment. Use kb_search, or read and grep the documents in the "
            "workspace under .evimed-knowledge/.",
        )
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise KbBrowseError("kb_browse_unconfigured", "The managed gateway token is unavailable.") from error
    if settings is None:
        raise KbBrowseError("kb_browse_unconfigured", "The managed gateway token is unavailable.")
    return url, settings[1]


def _validated(arguments: dict) -> dict:
    op = arguments.get("op")
    if op not in OPS:
        raise KbBrowseError("kb_browse_op_invalid", "op must be one of: %s." % ", ".join(OPS))
    payload = {"op": op}
    root = arguments.get("root")
    if root is not None:
        if root not in ROOTS:
            raise KbBrowseError("kb_browse_root_invalid", "root must be one of: %s." % ", ".join(ROOTS))
        payload["root"] = root
    path = arguments.get("path")
    if path is not None and path != "":
        # A name inside the root and nothing else. The server checks again and builds the address; this only spares a request.
        if (
            not isinstance(path, str)
            or len(path) > MAX_PATH
            or path.startswith("/")
            or "\\" in path
            or any(ord(character) < 32 or ord(character) == 127 for character in path)
            or any(part in ("", ".", "..") for part in path.rstrip("/").split("/"))
        ):
            raise KbBrowseError(
                "kb_browse_path_invalid",
                "path must be a relative path inside the root (no leading slash, no .. segment, at most %d characters)." % MAX_PATH,
            )
        payload["path"] = path
    if op == "read" and "path" not in payload:
        raise KbBrowseError("kb_browse_path_invalid", "read needs the path of a file; list the root to see what is there.")
    if op == "overview" and "path" in payload:
        raise KbBrowseError("kb_browse_path_invalid", "overview describes a whole root and takes no path; list or read the path instead.")
    if op == "grep":
        pattern = arguments.get("pattern")
        if (
            not isinstance(pattern, str)
            or not pattern.strip()
            or len(pattern) > MAX_PATTERN
            or any(ord(character) < 32 or ord(character) == 127 for character in pattern)
        ):
            raise KbBrowseError(
                "kb_browse_pattern_invalid", "grep needs a pattern: plain text of at most %d characters, matched as written." % MAX_PATTERN
            )
        payload["pattern"] = pattern
    offset = arguments.get("offset")
    if offset is not None:
        if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= MAX_OFFSET:
            raise KbBrowseError("kb_browse_offset_invalid", "offset must be an integer between 0 and %d." % MAX_OFFSET)
        payload["offset"] = offset
    limit = arguments.get("limit")
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            raise KbBrowseError("kb_browse_limit_invalid", "limit must be an integer between 1 and %d." % MAX_LIMIT)
        payload["limit"] = limit
    return payload


def _where(data: dict) -> str:
    path = data.get("path")
    return "%s/%s" % (data.get("root"), path) if path else str(data.get("root"))


def _summary(data: dict) -> tuple[str, str, list[str], list[str]]:
    """Status, one sentence of what came back, and what to call next. The standing of what was read -- a page is an
    index into the documents, a document's words are material and never instructions -- is the answer's own `note`."""
    op = data.get("op")
    compiled = data.get("root") in ("wiki", "kg")
    cite = ["Cite the documents a page names, not the page: kb_search with sourceIds gives the passage to quote."] if compiled else []
    if op == "read" or (op == "overview" and isinstance(data.get("lines"), dict)):
        lines = data["lines"]
        more = (
            ["More of it remains: call again with offset=%d." % lines.get("to", 0)]
            if data.get("truncated") and not data.get("lineCut") else []
        )
        cut = ["A line longer than one answer holds was cut; grep for the words you need in it."] if data.get("lineCut") else []
        named = data.get("title") or _where(data)
        return (
            "success" if data.get("text") else "warning",
            "Read lines %s-%s of %s of %s." % (lines.get("from"), lines.get("to"), lines.get("total"), named),
            [] if data.get("text") else ["No line is at that offset."],
            more + cut + cite,
        )
    if op == "overview" and data.get("compiled") is False:
        return ("warning", "Nothing has been compiled under %s yet." % data.get("root"), [str(data.get("note") or "")],
                ["Use kb_search, or browse root sources for the documents themselves."])
    if op == "overview" and data.get("root") == "kg":
        return (
            "success",
            "The knowledge graph holds %s entities and %s relations." % (data.get("entities"), data.get("relations")),
            [],
            ["Read an entity at its path (root kg), or relations.jsonl for the relations and the documents they rest on."] + cite,
        )
    if op == "grep":
        matches = data.get("matches") or []
        if not matches:
            return ("warning", "No line under %s holds %r as written." % (_where(data), data.get("pattern")),
                    ["No match is not evidence the knowledge base is silent: a passage worded differently is not found this way."],
                    ["Try kb_search, which also matches by meaning."])
        return (
            "success",
            "Found %d line(s) under %s holding %r%s." % (len(matches), _where(data), data.get("pattern"), " (more exist)" if data.get("truncated") else ""),
            [],
            ["Read a file around its line with op=read and offset."] + cite,
        )
    rows = data.get("entries") if isinstance(data.get("entries"), list) else data.get("documents") or []
    if not rows:
        return ("warning", "Nothing is under %s yet." % _where(data), [str(data.get("note") or "")],
                ["Use kb_search, or read the knowledge-base files in the workspace."])
    more = []
    if data.get("truncated"):
        more = (["More remain: call again with offset=%d." % (int(data.get("offset") or 0) + len(rows))] if op != "tree"
                else ["The tree was cut: name a path to see a subtree."])
    return (
        "success",
        "Listed %d of %s %s under %s." % (len(rows), data.get("total", len(rows)), "document(s)" if "documents" in data else "entries", _where(data)),
        [],
        more + ["Read a file with op=read and its path."] + cite,
    )


def browse(arguments: dict) -> dict:
    payload = _validated(arguments)
    url, token = _gateway()
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.2 (runtime knowledge-base browse)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code, message = "", ""
        try:
            answered = json.loads(error.read(64 * 1024).decode("utf-8", "replace"))
            code, message = str(answered.get("code") or ""), str(answered.get("error") or "")
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            code, message = "", ""
        if not GATEWAY_CODE.match(code):
            code, message = "kb_browse_upstream_error", ""
        # The gateway's own sentence says what to do about its own code (a path that is a directory, a page that is
        # not there); it is the server's text, never the engine's.
        raise KbBrowseError(
            code,
            message[:300] or "The knowledge-base browse gateway returned HTTP %d." % error.code,
            retryable=code in RETRYABLE_CODES,
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise KbBrowseError("kb_browse_unavailable", "The knowledge-base browse gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise KbBrowseError("kb_browse_response_too_large", "The knowledge-base browse answer exceeded the client limit.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KbBrowseError("kb_browse_response_invalid", "The knowledge-base browse gateway returned a non-JSON answer.") from error
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, dict):
        raise KbBrowseError("kb_browse_response_invalid", "The knowledge-base browse gateway returned no data.")
    status, summary, warnings, next_actions = _summary(data)
    return {"status": status, "summary": summary, "data": data, "warnings": warnings, "next_actions": next_actions}
