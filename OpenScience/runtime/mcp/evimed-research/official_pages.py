"""Bounded retrieval of allowlisted official medical and regulatory web pages."""

from __future__ import annotations

import hashlib
import re
import urllib.parse
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

import public_sources
import source_types
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve


MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# The approved authorities and the paths of their documents. Mirrored, path for
# path, by `officialDocumentPaths` in the server's public-source gateway, which
# refuses anything else; `apps/server/test/officialPages.test.mjs` holds the two
# equal. A host belongs here only when one plain GET returns the document's own
# text as server-rendered HTML: NMPA, NHC and CDE answer a JavaScript challenge
# (412/202), ChiCTR a firewall 405, ClinicalTrials.gov study pages and the
# guideline registries an empty app shell, BNF only inside the UK — measured
# 2026-09-18 from outside China, so every host here still needs one live check
# from the production host before a run relies on it.
OFFICIAL_PATHS = {
    "www.cochrane.org": ("/evidence/", "/zh-hans/evidence/"),
    "www.acc.org": ("/latest-in-cardiology/",),
    "professional.heart.org": ("/en/science-news/",),
    "cpr.heart.org": ("/en/resuscitation-science/",),
    "www.nhs.uk": ("/symptoms/chest-pain/",),
    "www.ccfdie.org": ("/zryyxxw/",),
    "mpa.hunan.gov.cn": ("/mpa/",),
    # Guidelines.
    "www.nice.org.uk": ("/guidance/",),
    "www.uspreventiveservicestaskforce.org": ("/uspstf/recommendation/",),
    "www.sign.ac.uk": ("/guidelines/",),
    "www.who.int": ("/publications/i/item/",),
    # Regulators: EPARs, referrals, DHPCs and PRAC highlights; FDA drug safety
    # communications and the Drugs@FDA approval record; the State Council's
    # policy library, which carries NHC and NMPA notices as plain HTML.
    "www.ema.europa.eu": (
        "/en/medicines/human/EPAR/",
        "/en/medicines/human/referrals/",
        "/en/medicines/dhpc/",
        "/en/news/meeting-highlights-pharmacovigilance-risk-assessment-committee-prac-",
    ),
    "www.fda.gov": ("/drugs/drug-safety-communications/", "/drugs/drug-safety-and-availability/"),
    "www.accessdata.fda.gov": ("/scripts/cder/daf/",),
    "www.gov.cn": ("/zhengce/zhengceku/",),
    # US labels, whole: indications, boxed warning, dosing, interactions.
    "dailymed.nlm.nih.gov": ("/dailymed/drugInfo.cfm", "/dailymed/lookup.cfm"),
}


class OfficialPageError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class _VisibleContentParser(HTMLParser):
    hidden_tags = {"script", "style", "svg", "noscript", "form", "nav", "footer", "header"}
    block_tags = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "td", "th"}

    def __init__(self, require_primary: bool):
        super().__init__(convert_charrefs=True)
        self.require_primary = require_primary
        self.primary_depth = 0
        self.hidden_depth = 0
        self.title_depth = 0
        self.title_parts: list[str] = []
        self.block_stack: list[tuple[str, list[str]]] = []
        self.lines: list[str] = []

    def handle_starttag(self, tag, _attrs):
        tag = tag.casefold()
        if tag in {"main", "article"}:
            self.primary_depth += 1
        if tag in self.hidden_tags:
            self.hidden_depth += 1
        if tag == "title":
            self.title_depth += 1
        if tag in self.block_tags and self.hidden_depth == 0 and (self.primary_depth or not self.require_primary):
            self.block_stack.append((tag, []))

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if tag in self.block_tags and self.block_stack and self.block_stack[-1][0] == tag:
            block_tag, parts = self.block_stack.pop()
            value = re.sub(r"\s+", " ", " ".join(parts)).strip()
            if value:
                prefix = "#" * int(block_tag[1]) + " " if re.fullmatch(r"h[1-6]", block_tag) else "- " if block_tag == "li" else ""
                self.lines.append(prefix + value)
        if tag == "title" and self.title_depth:
            self.title_depth -= 1
        if tag in self.hidden_tags and self.hidden_depth:
            self.hidden_depth -= 1
        if tag in {"main", "article"} and self.primary_depth:
            self.primary_depth -= 1

    def handle_data(self, data):
        value = data.strip()
        if not value or self.hidden_depth:
            return
        if self.title_depth:
            self.title_parts.append(value)
        if self.block_stack and (self.primary_depth or not self.require_primary):
            self.block_stack[-1][1].append(value)

    @property
    def title(self):
        return re.sub(r"\s+", " ", " ".join(self.title_parts)).strip()


def _validated_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as error:
        raise OfficialPageError("official_page_url_invalid", "The official-page URL is invalid.") from error
    prefixes = OFFICIAL_PATHS.get((parsed.hostname or "").casefold())
    if (
        parsed.scheme != "https"
        or not prefixes
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.fragment
        or not any(parsed.path.startswith(prefix) for prefix in prefixes)
    ):
        raise OfficialPageError("official_page_url_forbidden", "The URL is not an approved official document.")
    return parsed.geturl()


def _workspace() -> Path:
    try:
        return managed_workspace()
    except ImmutableCaptureError as error:
        raise OfficialPageError("official_page_workspace_invalid", str(error)) from error


def _extract(payload: bytes) -> tuple[str, str]:
    try:
        html = payload.decode("utf-8")
    except UnicodeDecodeError:
        html = payload.decode("utf-8", errors="replace")
    parser = _VisibleContentParser(require_primary=True)
    parser.feed(html)
    if len("\n".join(parser.lines)) < 200:
        fallback = _VisibleContentParser(require_primary=False)
        fallback.feed(html)
        parser = fallback
    text = "\n\n".join(dict.fromkeys(parser.lines)).strip()
    if len(text) < 200:
        raise OfficialPageError("official_page_content_missing", "The official page contained too little extractable content.", True)
    return parser.title or next((line.lstrip("# ") for line in parser.lines if line.startswith("#")), "Official document"), text


def fetch(arguments: dict) -> dict:
    try:
        url = _validated_url(str(arguments.get("url") or "").strip())
        try:
            with public_sources._open_remote(url, ("text/html",), timeout_seconds=60) as response:
                if response.headers.get_content_type() != "text/html":
                    raise OfficialPageError("official_page_response_invalid", "The official source did not return HTML.", True)
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_RESPONSE_BYTES:
                    raise OfficialPageError("official_page_too_large", "The official page exceeds the managed size limit.")
                payload = response.read(MAX_RESPONSE_BYTES + 1)
        except OfficialPageError:
            raise
        except Exception as error:
            raise OfficialPageError("official_page_upstream_unavailable", "The official page could not be retrieved.", True) from error
        if len(payload) > MAX_RESPONSE_BYTES:
            raise OfficialPageError("official_page_too_large", "The official page exceeds the managed size limit.")
        title, content = _extract(payload)
        digest = hashlib.sha256(payload).hexdigest()
        retrieved_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        # The approved URL is source identity: equal HTML at different URLs
        # retains separate attribution. Acquisition time belongs to the result.
        markdown = "\n".join([
            "# " + title,
            "",
            "- Source: " + url,
            "- SHA-256: " + digest,
            "",
            content,
            "",
        ])
        workspace = _workspace()
        markdown_payload = markdown.encode("utf-8")
        artifacts = {"page.md": markdown_payload}
        # What the page is, beside it (C8): decided by the authority's host and
        # path in the domain's table — a NICE guideline, an NMPA notice.
        sidecar = source_types.sidecar({
            "id": "official-page:" + digest[:16], "title": title, "url": url, "tool": "official_page_fetch",
        })
        if sidecar:
            artifacts[sidecar[0]] = sidecar[1]
        try:
            paths = preserve(workspace, Path(".evimed-sources") / "official-pages" / digest[:16], artifacts)
        except ImmutableCaptureError as error:
            raise OfficialPageError("official_page_output_invalid", str(error)) from error
        relative = paths["page.md"]
        source = {
            "id": "official-page:" + digest[:16],
            "title": title,
            "url": url,
            "source": "official-document",
            "retrievedAt": retrieved_at,
        }
        return {
            "status": "success",
            "summary": "Retrieved and preserved an approved official document.",
            "data": {
                "title": title,
                "url": url,
                "sha256": digest,
                "markdownPath": relative,
                "artifactSha256s": {relative: hashlib.sha256(markdown_payload).hexdigest()},
                "characters": len(content),
                "excerpt": content[:4000],
            },
            "sources": [source],
            "artifacts": [relative],
        }
    except OfficialPageError as error:
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": ["Use an approved official-document URL, or stop rather than infer inaccessible content."],
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": "No verified official-page artifact was written to the workspace.",
            },
        }
