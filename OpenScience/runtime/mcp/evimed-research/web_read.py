"""Reading one public web page or online document for a run.

`web_read` is `official_page_fetch` extended and renamed (2026-09-20, plan
§3.5): one tool, reading any public page instead of twenty-odd allowlisted
hosts. The runtime still names only a URL. Everything that decides how the
page is fetched lives in the control plane's gateway (`webRead.mjs`): every
redirect hop checked and pinned to public addresses, robots.txt honoured, one
request per site per second, a page drawn in script opened in AgentBay's cloud
browser, a PDF or office attachment sent to the document parser. What comes back
is text plus a receipt, and this module does what `official_page_fetch` did with
it: preserve a snapshot in `.evimed-sources/` with its sha256, because a
preserved snapshot is what makes a web source citable under the quote gate.

Long text is paged here, not in the gateway: the snapshot holds the whole text,
the result carries one page of it, and `page=N` reads on from the same snapshot
— the boundaries are a pure function of the text, so page 2 is page 2 of the
text page 1 came from, not of whatever the site serves a minute later.

Pages from authorities carry `official: true`. The label is the gateway's,
from its own table; it says where a page comes from, for an evidence grade,
and never decides whether the page could be read.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from collections import OrderedDict
from pathlib import Path

import public_sources
import source_types
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve

# Characters of text one result carries. About three thousand tokens of
# English, fewer of Chinese: enough for a notice or a guideline section, small
# enough that reading a 300-page PDF is thirty deliberate calls rather than one
# that fills the context.
PAGE_CHARS = 12_000
# A list page's links are how a run reaches the notice it wants; forty is a
# page of a regulator's list, not a portal's whole navigation.
MAX_LINKS = 40
# The gateway returns at most two million characters of text plus receipts;
# CJK text is three bytes a character in UTF-8.
MAX_RESPONSE_BYTES = 24 * 1024 * 1024
# The gateway's own budget is 150 s and the kernel abandons a tool call at
# 180 s; waiting longer than the gateway would only hide its timeout.
TIMEOUT_SECONDS = 170
# Snapshots remembered for `page=N`, most recent first.
SNAPSHOT_CACHE = 64
SOURCES_ROOT = Path(".evimed-sources") / "web-pages"

_SNAPSHOTS: "OrderedDict[str, dict]" = OrderedDict()


class WebReadError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _gateway():
    try:
        settings = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise WebReadError(getattr(error, "code", "web_read_unconfigured"), str(error)) from error
    if settings is None:
        raise WebReadError(
            "web_read_unconfigured",
            "Web reading needs the EviMed server gateway, which this runtime was not given.",
        )
    return settings


def _fetch(url: str) -> dict:
    gateway_url, token = _gateway()
    request = urllib.request.Request(
        gateway_url,
        data=json.dumps({"webRead": {"url": url}}).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": "EviMed-Research/1.3 (runtime web read)",
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code, message = "web_read_failed", "The gateway could not read this page (HTTP %d)." % error.code
        try:
            failure = json.loads(error.read(64 * 1024).decode("utf-8", "replace")).get("error") or {}
            code = str(failure.get("code") or code)
            message = str(failure.get("message") or message)
        except Exception:  # noqa: BLE001 - the status is the finding, not the parse
            pass
        raise WebReadError(code, message, retryable=error.code in (429, 502, 503, 504)) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise WebReadError("web_read_unavailable", "The web-reading gateway is unreachable.", retryable=True) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise WebReadError("web_read_response_too_large", "The page's text exceeded the runtime's limit.")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WebReadError("web_read_response_invalid", "The gateway returned an unreadable answer.", retryable=True) from error
    receipt = payload.get("receipt") if isinstance(payload, dict) else None
    if not isinstance(receipt, dict) or not isinstance(payload.get("text"), str):
        raise WebReadError("web_read_response_invalid", "The gateway's answer carried no receipt.", retryable=True)
    if not str(receipt.get("sha256") or "").strip():
        raise WebReadError("web_read_response_invalid", "The gateway's receipt carried no digest.", retryable=True)
    return payload


def pages_of(text: str, size: int = PAGE_CHARS) -> list[str]:
    """Split text into pages of at most `size` characters, at paragraph
    boundaries where there are any, then at line boundaries, then hard. A pure
    function of the text: the same text always pages the same way."""
    if not text:
        return [""]
    pieces: list[str] = []
    for paragraph in text.split("\n\n"):
        if len(paragraph) <= size:
            pieces.append(paragraph)
            continue
        for line in paragraph.split("\n"):
            while len(line) > size:
                pieces.append(line[:size])
                line = line[size:]
            pieces.append(line)
    pages: list[str] = []
    current = ""
    for piece in pieces:
        candidate = piece if not current else current + "\n\n" + piece
        if len(candidate) <= size:
            current = candidate
        else:
            if current:
                pages.append(current)
            current = piece
    if current or not pages:
        pages.append(current)
    return pages


def _snapshot_markdown(receipt: dict, text: str) -> bytes:
    """The preserved page. Deterministic — no retrieval time — so reading the
    same bytes again reuses the same capture, as `official_page_fetch` did."""
    title = str(receipt.get("title") or receipt.get("site") or "Web page").strip()
    read_as = {"html": "HTML page", "text": "plain text", "document": "document"}.get(str(receipt.get("contentType")), "page")
    extractor = receipt.get("extractor") if isinstance(receipt.get("extractor"), dict) else {}
    lines = ["# " + title, "", "- Source: " + str(receipt.get("url") or "")]
    if receipt.get("finalUrl") and receipt.get("finalUrl") != receipt.get("url"):
        lines.append("- Final URL: " + str(receipt["finalUrl"]))
    lines.append("- Site: " + str(receipt.get("site") or ""))
    lines.append("- Official source: " + ("yes" if receipt.get("official") is True else "no"))
    if receipt.get("rendered") is True:
        lines.append("- Rendered in a browser before reading: yes")
    lines.append("- Read as: %s (%s; %s %s)" % (
        read_as, receipt.get("mediaType") or "unknown type", extractor.get("name") or "extractor", extractor.get("version") or "",
    ))
    lines.append("- SHA-256: " + str(receipt.get("sha256")))
    lines.extend(["", text, ""])
    return "\n".join(lines).encode("utf-8")


def _preserve(receipt: dict, text: str) -> dict:
    try:
        workspace = managed_workspace()
    except ImmutableCaptureError as error:
        raise WebReadError("web_read_workspace_invalid", str(error)) from error
    digest = str(receipt["sha256"])
    source_id = "web-page:" + digest[:16]
    markdown = _snapshot_markdown(receipt, text)
    artifacts = {"page.md": markdown}
    # What the page is, beside it (C8): decided by its host and path in the
    # domain's table — a NICE guideline, an NMPA notice, a trial registration.
    sidecar = source_types.sidecar({
        "id": source_id, "title": receipt.get("title"), "url": receipt.get("finalUrl") or receipt.get("url"), "tool": "web_read",
    })
    if sidecar:
        artifacts[sidecar[0]] = sidecar[1]
    try:
        paths = preserve(workspace, SOURCES_ROOT / digest[:16], artifacts)
    except ImmutableCaptureError as error:
        raise WebReadError("web_read_output_invalid", str(error)) from error
    relative = paths["page.md"]
    return {
        "sourceId": source_id,
        "markdownPath": relative,
        "markdownSha256": hashlib.sha256(markdown).hexdigest(),
    }


def _remember(url: str, snapshot: dict) -> None:
    _SNAPSHOTS[url] = snapshot
    _SNAPSHOTS.move_to_end(url)
    while len(_SNAPSHOTS) > SNAPSHOT_CACHE:
        _SNAPSHOTS.popitem(last=False)


def _requested_page(arguments: dict) -> int:
    value = arguments.get("page", 1)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WebReadError("web_read_page_invalid", "page must be a positive integer.")
    return value


def read(arguments: dict) -> dict:
    try:
        url = str(arguments.get("url") or "").strip()
        if not url or len(url) > 2048:
            raise WebReadError("web_read_url_invalid", "A URL of at most 2048 characters is required.")
        page = _requested_page(arguments)
        snapshot = _SNAPSHOTS.get(url) if page > 1 else None
        if snapshot is None:
            payload = _fetch(url)
            receipt = dict(payload["receipt"])
            text = payload["text"]
            snapshot = {
                "receipt": receipt,
                "pages": pages_of(text),
                "characters": len(text),
                "links": [
                    {"text": str(link.get("text") or "")[:160], "url": str(link.get("url") or "")}
                    for link in (payload.get("links") or [])[:MAX_LINKS]
                    if isinstance(link, dict) and str(link.get("url") or "").startswith(("http://", "https://"))
                ],
                "notice": str(payload.get("notice") or ""),
                **_preserve(receipt, text),
            }
            _remember(url, snapshot)
        total = len(snapshot["pages"])
        if page > total:
            raise WebReadError("web_read_page_out_of_range", "The page has %d page(s) of text; page %d does not exist." % (total, page))
        receipt = snapshot["receipt"]
        data = {
            "url": receipt.get("url"),
            "finalUrl": receipt.get("finalUrl"),
            "title": receipt.get("title"),
            "site": receipt.get("site"),
            "fetchedAt": receipt.get("fetchedAt"),
            "official": receipt.get("official") is True,
            "rendered": receipt.get("rendered") is True,
            "contentType": receipt.get("contentType"),
            "mediaType": receipt.get("mediaType"),
            "sha256": receipt.get("sha256"),
            "sourceId": snapshot["sourceId"],
            "markdownPath": snapshot["markdownPath"],
            "artifactSha256s": {snapshot["markdownPath"]: snapshot["markdownSha256"]},
            "characters": snapshot["characters"],
            "page": page,
            "pages": total,
            "nextPage": page + 1 if page < total else None,
            "content": snapshot["pages"][page - 1],
        }
        if page == 1 and snapshot["links"]:
            data["links"] = snapshot["links"]
        source = {
            "id": snapshot["sourceId"],
            "title": receipt.get("title"),
            "url": receipt.get("finalUrl") or receipt.get("url"),
            "source": "web-page",
            "official": receipt.get("official") is True,
            "retrievedAt": receipt.get("fetchedAt"),
        }
        result = {
            "status": "success",
            "summary": "Read %s and preserved it (page %d of %d)." % (receipt.get("site") or "the page", page, total),
            "data": data,
            "sources": [source],
            "artifacts": [snapshot["markdownPath"]],
        }
        if snapshot["notice"]:
            result["status"] = "warning"
            result["warnings"] = [snapshot["notice"]]
            result["next_actions"] = ["Prefer another source for anything the page may have left out."]
        return result
    except WebReadError as error:
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": [
                "Retry later." if error.retryable
                else "Use another source for this page; do not infer what it would have said.",
            ],
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": "No web page was read or preserved.",
            },
        }
