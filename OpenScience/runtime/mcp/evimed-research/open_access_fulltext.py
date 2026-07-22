"""Bounded open-access full-text retrieval for the EviMed runtime."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import public_sources


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
EUROPE_PMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest"
USER_AGENT = "EviMed-Research/1.2 open-access-fulltext"


class FullTextError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _request_bytes(url: str, accept: str) -> bytes:
    try:
        with public_sources._open_remote(url, (accept,), timeout_seconds=60) as response:
            content_type = response.headers.get_content_type()
            if content_type != accept:
                raise FullTextError(
                    "full_text_upstream_invalid",
                    "Europe PMC returned unexpected content type %s." % content_type,
                    True,
                )
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_RESPONSE_BYTES:
                raise FullTextError("full_text_too_large", "The open-access full text exceeds the managed size limit.")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except FullTextError:
        raise
    except Exception as error:
        raise FullTextError("full_text_upstream_unavailable", "Europe PMC full-text retrieval failed.", True) from error
    if len(payload) > MAX_RESPONSE_BYTES:
        raise FullTextError("full_text_too_large", "The open-access full text exceeds the managed size limit.")
    return payload


def _request_json(url: str) -> dict:
    try:
        value = json.loads(_request_bytes(url, "application/json").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FullTextError("full_text_upstream_invalid", "Europe PMC returned an invalid metadata response.", True) from error
    if not isinstance(value, dict):
        raise FullTextError("full_text_upstream_invalid", "Europe PMC returned an invalid metadata response.", True)
    return value


def _normalize_pmcid(value: str) -> str | None:
    match = re.fullmatch(r"\s*(?:PMCID\s*:\s*)?(PMC)?(\d{3,12})\s*", value, re.I)
    if not match or not match.group(1):
        return None
    return "PMC" + match.group(2)


def _resolve(identifier: str) -> dict:
    direct = _normalize_pmcid(identifier)
    if direct:
        return {"pmcid": direct, "id": direct, "doi": "", "title": "", "isOpenAccess": "Y"}

    clean = identifier.strip()
    pmid = re.fullmatch(r"(?:PMID\s*:\s*)?(\d{5,12})", clean, re.I)
    if pmid:
        query = "EXT_ID:%s" % pmid.group(1)
    else:
        doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", clean, flags=re.I)
        doi = re.sub(r"^doi:\s*", "", doi, flags=re.I)
        if not doi.startswith("10.") or any(character.isspace() for character in doi):
            raise FullTextError(
                "full_text_identifier_invalid",
                "identifier must be a PMCID, PMID, or DOI.",
            )
        query = 'DOI:"%s"' % doi

    url = "%s/search?%s" % (
        EUROPE_PMC_API,
        urllib.parse.urlencode({"query": query, "format": "json", "resultType": "core", "pageSize": 5}),
    )
    response = _request_json(url)
    results = response.get("resultList", {}).get("result", [])
    if not isinstance(results, list):
        results = []
    for result in results:
        if isinstance(result, dict) and isinstance(result.get("pmcid"), str):
            return result
    raise FullTextError(
        "full_text_not_available",
        "No Europe PMC open-access full text was found for this identifier.",
    )


def _tag(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def _text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return re.sub(r"\s+", " ", " ".join(node.itertext())).strip()


def _first(root: ET.Element, tag: str) -> str:
    return next((_text(node) for node in root.iter() if _tag(node) == tag and _text(node)), "")


def _article_id(root: ET.Element, id_type: str) -> str:
    return next(
        (
            _text(node)
            for node in root.iter()
            if _tag(node) == "article-id"
            and node.attrib.get("pub-id-type", "").casefold() == id_type.casefold()
            and _text(node)
        ),
        "",
    )


def _append_content(lines: list[str], node: ET.Element, level: int) -> None:
    tag = _tag(node)
    if tag == "sec":
        title = next((_text(child) for child in node if _tag(child) == "title"), "Untitled section")
        lines.extend(["", "%s %s" % ("#" * min(level, 6), title), ""])
        for child in node:
            if _tag(child) != "title":
                _append_content(lines, child, level + 1)
    elif tag in {"p", "disp-quote", "boxed-text", "statement"}:
        value = _text(node)
        if value:
            lines.extend([value, ""])
    elif tag in {"fig", "table-wrap", "supplementary-material"}:
        label = next((_text(child) for child in node if _tag(child) == "label"), tag)
        caption = next((_text(child) for child in node if _tag(child) == "caption"), "")
        value = _text(node)
        lines.extend(["**%s.** %s" % (label, caption or value), ""])
    elif tag == "list":
        for item in node.iter():
            if _tag(item) == "list-item":
                value = _text(item)
                if value:
                    lines.append("- " + value)
        lines.append("")
    elif tag not in {"title", "label", "caption", "table", "xref"}:
        for child in node:
            _append_content(lines, child, level)


def _render_markdown(xml_payload: bytes, metadata: dict) -> tuple[str, dict]:
    try:
        root = ET.fromstring(xml_payload)
    except ET.ParseError as error:
        raise FullTextError("full_text_xml_invalid", "Europe PMC returned malformed full-text XML.", True) from error
    article = next((node for node in root.iter() if _tag(node) == "article"), root)
    title = _first(article, "article-title") or str(metadata.get("title") or "Untitled article")
    doi = str(metadata.get("doi") or _article_id(article, "doi"))
    pmcid = str(metadata.get("pmcid") or "")
    lines = [
        "# " + title,
        "",
        "- PMCID: " + pmcid,
        "- DOI: " + (doi or "not supplied"),
        "- Primary source: https://europepmc.org/articles/%s" % pmcid,
        "- Retrieved: " + datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "",
    ]
    abstract = next((node for node in article.iter() if _tag(node) == "abstract"), None)
    if abstract is not None:
        lines.extend(["## Abstract", "", _text(abstract), ""])
    body = next((node for node in article if _tag(node) == "body"), None)
    if body is None:
        body = next((node for node in article.iter() if _tag(node) == "body"), None)
    if body is None:
        raise FullTextError("full_text_body_missing", "The retrieved XML did not contain an article body.")
    for child in body:
        _append_content(lines, child, 2)
    references = [
        _text(node)
        for node in article.iter()
        if _tag(node) == "ref" and _text(node)
    ]
    if references:
        lines.extend(["", "## References", ""])
        lines.extend("%d. %s" % (index, value) for index, value in enumerate(references, 1))
    markdown = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"
    return markdown, {"title": title, "doi": doi, "pmcid": pmcid, "references": len(references)}


def _workspace() -> Path:
    raw = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise FullTextError("full_text_workspace_invalid", "The managed project workspace is unavailable.")
    candidate = Path(raw)
    if candidate.is_symlink():
        raise FullTextError("full_text_workspace_invalid", "The managed project workspace is unavailable.")
    workspace = candidate.resolve()
    if not workspace.is_dir():
        raise FullTextError("full_text_workspace_invalid", "The managed project workspace is unavailable.")
    return workspace


def _safe_directory(workspace: Path, relative: Path) -> Path:
    current = workspace
    for part in relative.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise FullTextError("full_text_output_invalid", "Managed full-text paths must not contain symbolic links.")
        current.mkdir(mode=0o700, exist_ok=True)
    return current


def _atomic_write(path: Path, payload: bytes) -> None:
    if path.exists() and path.is_symlink():
        raise FullTextError("full_text_output_invalid", "Managed full-text files must not be symbolic links.")
    temporary = path.with_name(".%s.%s.tmp" % (path.name, secrets.token_hex(8)))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def fetch(arguments: dict) -> dict:
    identifier = str(arguments.get("identifier") or "").strip()
    try:
        metadata = _resolve(identifier)
        pmcid = str(metadata.get("pmcid") or "").upper()
        if not re.fullmatch(r"PMC\d{3,12}", pmcid):
            raise FullTextError("full_text_not_available", "The resolved record has no PMCID full text.")
        url = "%s/%s/fullTextXML" % (EUROPE_PMC_API, pmcid)
        xml_payload = _request_bytes(url, "application/xml")
        markdown, details = _render_markdown(xml_payload, {**metadata, "pmcid": pmcid})
        workspace = _workspace()
        relative_root = Path(".evimed-sources") / pmcid
        output_root = _safe_directory(workspace, relative_root)
        markdown_path = output_root / "fulltext.md"
        xml_path = output_root / "fulltext.xml"
        markdown_payload = markdown.encode("utf-8")
        _atomic_write(markdown_path, markdown_payload)
        _atomic_write(xml_path, xml_payload)
        markdown_relative = markdown_path.relative_to(workspace).as_posix()
        xml_relative = xml_path.relative_to(workspace).as_posix()
        source = {
            "id": pmcid,
            "title": details["title"],
            "url": "https://europepmc.org/articles/%s" % pmcid,
            "source": "europe-pmc-fulltext",
            "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        return {
            "status": "success",
            "summary": "Retrieved the complete open-access article into the managed workspace.",
            "data": {
                **details,
                "markdownPath": markdown_relative,
                "xmlPath": xml_relative,
                "artifactSha256s": {
                    markdown_relative: hashlib.sha256(markdown_payload).hexdigest(),
                    xml_relative: hashlib.sha256(xml_payload).hexdigest(),
                },
                "markdownCharacters": len(markdown),
                "xmlBytes": len(xml_payload),
            },
            "sources": [source],
            "artifacts": [markdown_relative, xml_relative],
        }
    except FullTextError as error:
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": [
                "Verify the identifier and open-access status, or stop rather than infer missing full-text facts."
            ],
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": "No verified open-access full text was written to the workspace.",
            },
        }
