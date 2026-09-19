"""Bounded open-access full-text retrieval for the EviMed runtime."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import public_sources
import source_types
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
# The parse mode's answer: the PDF base64-encoded beside the parser's text.
MAX_PARSED_RESPONSE_BYTES = 48 * 1024 * 1024
# The parser reads a long or scanned PDF in minutes; the kernel abandons a tool
# call at 180 s, and past this the PDF's own text layer is read instead.
PARSE_TIMEOUT_SECONDS = 150
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


def _publication_types(metadata: dict) -> list[str]:
    """Europe PMC's `pubTypeList` (MEDLINE publication types) for a resolved record."""
    value = (metadata.get("pubTypeList") or {}).get("pubType") if isinstance(metadata.get("pubTypeList"), dict) else None
    if isinstance(value, str):
        value = [value]
    return [str(item).strip() for item in value or [] if str(item).strip()][:12]


def _with_sidecar(artifacts: dict, record: dict) -> dict:
    """The capture's artifacts plus `source.json`, what the text is (C8).

    Written into the same content-addressed capture as the text, so a reader
    holding only the text's path finds its type beside it."""
    sidecar = source_types.sidecar({**record, "tool": "open_access_full_text"})
    return {**artifacts, sidecar[0]: sidecar[1]} if sidecar else artifacts


def _open_access_pdf(doi: str) -> tuple[bytes, dict, dict | None, dict | None]:
    """The PDF Unpaywall vouches for, fetched by the server gateway, with the
    document parser's reading of it (the gateway's "via parse" mode, plan §2.3).

    Only the DOI crosses the boundary, as before: the gateway picks the host,
    holds the parser's key and returns the text with the PDF beside it. Returns
    (pdf bytes, provenance, parsed or None, the parser's refusal or None).
    """
    try:
        gateway = public_sources._gateway_settings()  # noqa: SLF001 - one token, one owner
    except public_sources.PublicSourceError as error:
        raise FullTextError(getattr(error, "code", "full_text_not_available"), str(error)) from error
    if gateway is None:
        raise FullTextError(
            "public_source_managed_gateway_required",
            "Open-access PDF retrieval requires the EviMed server gateway.",
        )
    gateway_url, token = gateway
    request = urllib.request.Request(
        gateway_url,
        data=json.dumps({"openAccessPdfDoi": doi, "parse": True}).encode("utf-8"),
        headers={
            "accept": "application/json",
            "authorization": "Bearer %s" % token,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with public_sources._OPENER.open(request, timeout=PARSE_TIMEOUT_SECONDS) as response:  # noqa: SLF001
            body = response.read(MAX_PARSED_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        # The gateway names every location it tried; passing that through is
        # the difference between "no full text" and "no full text, and why".
        code, detail = "public_source_pdf_unavailable", ""
        try:
            failure = json.loads(error.read(64 * 1024).decode("utf-8")).get("error") or {}
            code = str(failure.get("code") or code)
            detail = str(failure.get("message") or "")
        except Exception:  # noqa: BLE001 - the status is the finding
            pass
        raise FullTextError(code, detail or "No open-access PDF could be retrieved.") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise FullTextError("full_text_upstream_unavailable", "Open-access PDF retrieval failed.", True) from error
    if len(body) > MAX_PARSED_RESPONSE_BYTES:
        raise FullTextError("full_text_too_large", "The open-access full text exceeds the managed size limit.")
    try:
        payload = json.loads(body.decode("utf-8"))
        pdf = payload["pdf"]
        pdf_bytes = base64.b64decode(pdf["base64"], validate=True)
    except (UnicodeDecodeError, ValueError, KeyError, TypeError) as error:
        raise FullTextError("full_text_upstream_invalid", "The gateway returned an unreadable open-access answer.", True) from error
    if len(pdf_bytes) > MAX_RESPONSE_BYTES:
        raise FullTextError("full_text_too_large", "The open-access full text exceeds the managed size limit.")
    if hashlib.sha256(pdf_bytes).hexdigest() != str(pdf.get("sha256") or ""):
        raise FullTextError("full_text_upstream_invalid", "The open-access PDF does not match the digest the gateway reported.", True)
    provenance = {
        "origin": str(pdf.get("origin") or ""),
        "version": str(pdf.get("version") or ""),
        "license": str(pdf.get("license") or ""),
    }
    parsed = payload.get("parsed")
    if not (isinstance(parsed, dict) and isinstance(parsed.get("text"), str) and parsed["text"].strip()):
        parsed = None
    parse_error = payload.get("parseError") if isinstance(payload.get("parseError"), dict) else None
    return pdf_bytes, provenance, parsed, parse_error


def _parsed_markdown(parsed: dict, metadata: dict) -> tuple[str, dict]:
    """The document parser's text, in the same markdown shape as the other
    routes. The heading is not the parser's metadata: its title is read by a
    model and may differ between two readings of the same bytes, and a capture
    has to be the same file every time the same PDF is read."""
    doi = str(metadata.get("doi") or "")
    extractor = parsed.get("extractor") if isinstance(parsed.get("extractor"), dict) else {}
    page_map = parsed.get("pageMap") if isinstance(parsed.get("pageMap"), list) else []
    body = parsed["text"].strip()
    header = [
        "# Open-access article",
        "",
        "- DOI: " + doi.casefold(),
        "- Read by the document parser (%s %s)" % (extractor.get("name") or "parser", extractor.get("version") or ""),
        "",
        "> Text below is the document parser's reading of the PDF, tables and scanned pages included; "
        "verify any number against the page it came from in the PDF beside it.",
        "",
    ]
    return "\n".join(header) + "\n" + body, {
        "title": str(metadata.get("title") or "").strip() or doi or "Open-access article",
        "doi": doi,
        "pmcid": "",
        "pages": len(page_map) or None,
        "references": 0,
        "extractedBy": "document-parser",
    }


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
    canonical_title = str(getattr(getattr(reader, "metadata", None), "title", None) or "").strip() or "Open-access article"
    header = [
        "# " + canonical_title,
        "",
        "- DOI: " + doi.casefold(),
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
        "extractedBy": "pdf-text-layer",
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
        "# " + (_first(article, "article-title") or "Untitled article"),
        "",
        "- PMCID: " + pmcid,
        "- DOI: " + (_article_id(article, "doi") or "not supplied"),
        "- Primary source: https://europepmc.org/articles/%s" % pmcid,
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
    return markdown, {
        "title": title, "doi": doi, "pmcid": pmcid, "references": len(references),
        # JATS `article-type` ("review-article", "case-report", ...): the one
        # design fact a PMC full text states about itself.
        "articleType": str(article.attrib.get("article-type") or "").strip(),
    }


# The article is on disk; what enters the model's context is the run's choice.
# A 60 K-character full text read whole is the largest single thing a child
# puts into its context, and most of it — methods boilerplate, references —
# is never quoted. So the result carries the abstract and a map of the file:
# every heading with the line it starts on and how long its section runs, so
# a run reads the Results or the one table it needs by line range, and checks
# a quotation with `locate_quote` rather than by reading the article again.
MAX_ABSTRACT_CHARS = 3_000
MAX_OUTLINE_ENTRIES = 80


def _outline(markdown: str) -> list[dict]:
    lines = markdown.split("\n")
    headings = []
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,4})\s+(.+?)\s*$", line)
        if match:
            headings.append((index, len(match.group(1)), match.group(2)))
    outline = []
    for position, (index, level, title) in enumerate(headings[:MAX_OUTLINE_ENTRIES]):
        end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
        outline.append({
            "heading": title[:160],
            "level": level,
            "line": index + 1,
            "lines": end - index,
            "characters": sum(len(line) + 1 for line in lines[index:end]),
        })
    return outline


def _abstract(markdown: str) -> str:
    match = re.search(r"^## Abstract\s*\n(.*?)(?=^#{1,2} |\Z)", markdown, re.M | re.S)
    if not match:
        return ""
    text = " ".join(match.group(1).split())
    return text if len(text) <= MAX_ABSTRACT_CHARS else text[: MAX_ABSTRACT_CHARS - 1] + "…"


def _reading_map(markdown: str, markdown_relative: str) -> dict:
    return {
        "abstract": _abstract(markdown),
        "outline": _outline(markdown),
        "readingHint": (
            "The full text is at %s. Read only the sections you need by line range "
            "(the outline gives each section's first line and length), and confirm a "
            "quotation with locate_quote instead of re-reading the article." % markdown_relative
        ),
    }


def _workspace() -> Path:
    try:
        return managed_workspace()
    except ImmutableCaptureError as error:
        raise FullTextError("full_text_workspace_invalid", str(error)) from error


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
    parse_error = None
    try:
        payload, provenance, parsed, parse_error = _open_access_pdf(doi)
    except FullTextError as error:
        if not error.retryable:
            raise
        # The parse mode ran out of time or could not be reached: the PDF
        # itself, read by its own text layer here, is still the paper.
        parsed, parse_error = None, {"code": error.code, "message": str(error)}
        try:
            payload, provenance = public_sources.open_access_pdf_bytes(doi, MAX_RESPONSE_BYTES)
        except public_sources.PublicSourceError as fallback:
            raise FullTextError(getattr(fallback, "code", "full_text_not_available"), str(fallback)) from fallback
        except Exception as fallback:
            raise FullTextError("full_text_upstream_unavailable", "Open-access PDF retrieval failed.", True) from fallback

    # The parser when the deployment has one — it reads tables and scanned
    # pages the text layer cannot. The text layer (pypdf, in the image) when it
    # does not, or when the parser failed on this PDF: a parser outage must not
    # make an open-access paper unreadable, and a text layer is verbatim.
    if parsed is not None:
        markdown, details = _parsed_markdown(parsed, metadata)
    else:
        markdown, details = _pdf_markdown(payload, metadata, provenance)
        if parse_error:
            details["parserUnavailable"] = str(parse_error.get("code") or "source_parser_failed")
    relative_root = Path(".evimed-sources") / _doi_slug(doi.casefold())
    markdown_payload = markdown.encode("utf-8")
    artifacts = _with_sidecar({"fulltext.md": markdown_payload, "fulltext.pdf": payload}, {
        "id": doi, "title": details["title"], "url": "https://doi.org/" + doi,
        "publicationTypes": _publication_types(metadata),
    })
    try:
        paths = preserve(workspace, relative_root, artifacts)
    except ImmutableCaptureError as error:
        raise FullTextError("full_text_output_invalid", str(error)) from error
    markdown_relative = paths["fulltext.md"]
    pdf_relative = paths["fulltext.pdf"]
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
            **_reading_map(markdown, markdown_relative),
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
        markdown_payload = markdown.encode("utf-8")
        artifacts = _with_sidecar({"fulltext.md": markdown_payload, "fulltext.xml": xml_payload}, {
            "id": pmcid, "title": details["title"], "url": "https://europepmc.org/articles/%s" % pmcid,
            "publicationTypes": _publication_types(metadata), "articleType": details.get("articleType"),
        })
        try:
            paths = preserve(workspace, relative_root, artifacts)
        except ImmutableCaptureError as error:
            raise FullTextError("full_text_output_invalid", str(error)) from error
        markdown_relative = paths["fulltext.md"]
        xml_relative = paths["fulltext.xml"]
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
                **_reading_map(markdown, markdown_relative),
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
