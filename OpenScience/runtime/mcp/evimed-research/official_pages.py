"""Bounded retrieval of allowlisted official medical and regulatory web pages."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import urllib.parse
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

import public_sources


MAX_RESPONSE_BYTES = 4 * 1024 * 1024
OFFICIAL_PATHS = {
    "www.cochrane.org": ("/evidence/", "/zh-hans/evidence/"),
    "www.acc.org": ("/latest-in-cardiology/",),
    "professional.heart.org": ("/en/science-news/",),
    "cpr.heart.org": ("/en/resuscitation-science/",),
    "www.ccfdie.org": ("/zryyxxw/",),
    "mpa.hunan.gov.cn": ("/mpa/",),
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
    raw = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise OfficialPageError("official_page_workspace_invalid", "The managed project workspace is unavailable.")
    candidate = Path(raw)
    if candidate.is_symlink():
        raise OfficialPageError("official_page_workspace_invalid", "The managed project workspace is unavailable.")
    workspace = candidate.resolve()
    if not workspace.is_dir():
        raise OfficialPageError("official_page_workspace_invalid", "The managed project workspace is unavailable.")
    return workspace


def _safe_directory(workspace: Path, relative: Path) -> Path:
    current = workspace
    for part in relative.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise OfficialPageError("official_page_output_invalid", "Managed source paths must not contain symbolic links.")
        current.mkdir(mode=0o700, exist_ok=True)
    return current


def _atomic_write(path: Path, payload: bytes) -> None:
    if path.exists() and path.is_symlink():
        raise OfficialPageError("official_page_output_invalid", "Managed source files must not be symbolic links.")
    temporary = path.with_name(".%s.%s.tmp" % (path.name, secrets.token_hex(8)))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


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
        markdown = "\n".join([
            "# " + title,
            "",
            "- Source: " + url,
            "- Retrieved: " + retrieved_at,
            "- SHA-256: " + digest,
            "",
            content,
            "",
        ])
        workspace = _workspace()
        output_root = _safe_directory(workspace, Path(".evimed-sources") / "official-pages" / digest[:16])
        output_path = output_root / "page.md"
        _atomic_write(output_path, markdown.encode("utf-8"))
        relative = output_path.relative_to(workspace).as_posix()
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
