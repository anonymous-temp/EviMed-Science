"""Bounded open-access full-text retrieval for the EviMed runtime."""

from __future__ import annotations

import hashlib
import io
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
# Below this, a PDF has effectively no text layer and is a scan.
MIN_PDF_TEXT_CHARS = 2_000
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
    # No PMC copy. Keep whatever Europe PMC does know — above all the DOI — so
    # the caller can still try the open-access PDF route instead of stopping at
    # the PMC subset, which is what left syntheses with more eligible records
    # than readable ones.
    for result in results:
        if isinstance(result, dict) and result.get("doi"):
            return result
    if query.startswith("DOI:"):
        return {"pmcid": "", "doi": query[5:-1], "id": "", "title": ""}
    raise FullTextError(
        "full_text_not_available",
        "No Europe PMC record was found for this identifier.",
    )


def _pdf_markdown(payload: bytes, metadata: dict, provenance: dict) -> tuple[str, dict]:
    """Extract the text layer of an open-access PDF into the same markdown shape
    the Europe PMC XML path produces, so downstream consumers see one format."""
    try:
        import pypdf
    except ImportError as error:  # pragma: no cover - depends on the runtime image
        raise FullTextError(
            "full_text_pdf_reader_missing",
            "No PDF text extractor is installed in this runtime.",
        ) from error
    try:
        reader = pypdf.PdfReader(io.BytesIO(payload))
        if getattr(reader, "is_encrypted", False):
            raise FullTextError("full_text_pdf_encrypted", "The open-access PDF is encrypted and cannot be read.")
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except FullTextError:
        raise
    except Exception as error:
        raise FullTextError("full_text_pdf_unreadable", "The open-access PDF could not be parsed.") from error

    body = "\n\n".join(page for page in pages if page)
    # A scanned article parses without error and yields almost nothing. Saying so
    # is the difference between an honest gap and a silently empty evidence base.
    if len(body) < MIN_PDF_TEXT_CHARS:
        raise FullTextError(
            "full_text_pdf_not_machine_readable",
            "The open-access PDF carries %d characters of extractable text over %d page(s); it is most likely a scan."
            % (len(body), len(pages)),
        )
    doi = str(metadata.get("doi") or "")
    title = str(metadata.get("title") or "").strip() or doi or "Open-access article"
    header = [
        "# " + title,
        "",
        "- DOI: " + doi,
        "- Retrieved from: " + (provenance.get("origin") or "the registered open-access location"),
        "- Open-access version: " + (provenance.get("version") or "unspecified"),
        "- License: " + (provenance.get("license") or "unspecified"),
        "- Extracted from PDF text layer (%d pages)" % len(pages),
        "",
        "> Text below is the PDF's own text layer. Page order is preserved; "
        "tables and figures are not reconstructed, so verify any number against the page it came from.",
        "",
    ]
    return "\n".join(header) + "\n" + body, {
        "title": title,
        "doi": doi,
        "pmcid": "",
        "pages": len(pages),
        "references": 0,
    }


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


def _doi_slug(doi: str) -> str:
    """A filesystem-safe directory name that still identifies the article."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", doi).strip("-.")[:96]
    return slug or "open-access-article"


def _fetch_open_access_pdf(metadata: dict, workspace: Path) -> dict:
    doi = str(metadata.get("doi") or "").strip()
    if not doi:
        raise FullTextError(
            "full_text_not_available",
            "The record has no PMC full text and no DOI to resolve an open-access copy.",
        )
    try:
        payload, provenance = public_sources.open_access_pdf_bytes(doi, MAX_RESPONSE_BYTES)
    except public_sources.PublicSourceError as error:
        raise FullTextError(getattr(error, "code", "full_text_not_available"), str(error)) from error
    except Exception as error:
        raise FullTextError("full_text_upstream_unavailable", "Open-access PDF retrieval failed.", True) from error

    markdown, details = _pdf_markdown(payload, metadata, provenance)
    relative_root = Path(".evimed-sources") / _doi_slug(doi)
    output_root = _safe_directory(workspace, relative_root)
    markdown_path = output_root / "fulltext.md"
    pdf_path = output_root / "fulltext.pdf"
    markdown_payload = markdown.encode("utf-8")
    _atomic_write(markdown_path, markdown_payload)
    _atomic_write(pdf_path, payload)
    markdown_relative = markdown_path.relative_to(workspace).as_posix()
    pdf_relative = pdf_path.relative_to(workspace).as_posix()
    return {
        "status": "success",
        "summary": "Retrieved the open-access PDF and extracted its text into the managed workspace.",
        "data": {
            **details,
            "route": "open-access-pdf",
            "openAccessOrigin": provenance.get("origin", ""),
            "openAccessVersion": provenance.get("version", ""),
            "license": provenance.get("license", ""),
            "markdownPath": markdown_relative,
            "pdfPath": pdf_relative,
            "artifactSha256s": {
                markdown_relative: hashlib.sha256(markdown_payload).hexdigest(),
                pdf_relative: hashlib.sha256(payload).hexdigest(),
            },
            "markdownCharacters": len(markdown),
            "pdfBytes": len(payload),
        },
        "sources": [{
            "id": doi,
            "title": details["title"],
            "url": "https://doi.org/" + doi,
            "source": "open-access-pdf",
            "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }],
        "artifacts": [markdown_relative, pdf_relative],
    }


def fetch(arguments: dict) -> dict:
    identifier = str(arguments.get("identifier") or "").strip()
    try:
        metadata = _resolve(identifier)
        pmcid = str(metadata.get("pmcid") or "").upper()
        workspace = _workspace()
        if not re.fullmatch(r"PMC\d{3,12}", pmcid):
            return _fetch_open_access_pdf(metadata, workspace)
        url = "%s/%s/fullTextXML" % (EUROPE_PMC_API, pmcid)
        try:
            xml_payload = _request_bytes(url, "application/xml")
        except FullTextError:
            # A PMCID only means Europe PMC indexes the record, not that it may
            # serve the text: subscription articles have one and refuse the XML.
            # Those are exactly the records worth trying the open-access route
            # for, so a refusal here is a reason to continue, not to stop.
            if metadata.get("doi"):
                return _fetch_open_access_pdf(metadata, workspace)
            raise
        markdown, details = _render_markdown(xml_payload, {**metadata, "pmcid": pmcid})
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
                "route": "europe-pmc-xml",
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
