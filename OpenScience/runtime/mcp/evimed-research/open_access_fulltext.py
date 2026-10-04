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

import open_access_supplements as supplements
import public_sources
import source_intake
import source_outcome
import source_transport as transport
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
# One time budget per call, inside the 180 s the kernel allows a tool call. A
# call that fetches the supplementary files gets the most: Europe PMC builds
# that zip as it streams it (33 s to the first byte, 136 s for 3.5 MB on one
# article), and the budget is what turns a slow answer into a timeout that says
# how far it got.
DEADLINE_SECONDS = 110.0
DEADLINE_WITH_SUPPLEMENTS_SECONDS = 150.0
SUPPLEMENT_MAX_BYTES = 16 * 1024 * 1024


class FullTextError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, not_configured=None, source_error=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        # The retrieval failure this summarises (`source_outcome.SourceError`):
        # it says what the model should do next in the words of its state.
        self.source_error = source_error
        # Set when the gateway refused because a data source nobody configured
        # for this researcher was needed (`SourceNotConfigured`): the result then
        # says so plainly and tells the model to go on without it.
        self.not_configured = not_configured


def _request_bytes(url: str, accept: str, *, deadline=None, per_attempt: float = 60) -> bytes:
    """One Europe PMC body inside the call's deadline (`source_transport`).

    A refusal, an expired budget and an unreachable source are the three failure
    names, not "retrieval failed": `FullTextError.code` is `source_access_denied`,
    `source_timeout` or `source_unavailable`, and `.source_error` carries what to do.
    """
    deadline = deadline or transport.Deadline(DEADLINE_SECONDS)
    try:
        return transport.fetch(
            url, (accept,), deadline=deadline, scope="Europe PMC", max_bytes=MAX_RESPONSE_BYTES, per_attempt=per_attempt,
        ).body
    except public_sources.SourceNotConfigured as error:
        raise FullTextError(error.code, str(error), False, not_configured=error) from error
    except source_outcome.SourceError as error:
        raise FullTextError(error.code, str(error), error.retryable, source_error=error) from error
    except source_outcome.Truncated as error:
        raise FullTextError("full_text_too_large", "The open-access full text exceeds the managed size limit.") from error


def _request_json(url: str, *, deadline=None) -> dict:
    try:
        value = json.loads(_request_bytes(url, "application/json", deadline=deadline, per_attempt=25).decode("utf-8"))
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


def _resolve(identifier: str, *, deadline=None) -> dict:
    direct = _normalize_pmcid(identifier)
    if direct:
        # Nothing is known about a PMCID asked for by itself, and the record is
        # not looked up unless the XML fails (`_explain_xml_failure`): "open
        # access" is not claimed here.
        return {"pmcid": direct, "id": direct, "doi": "", "title": ""}

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
    response = _request_json(url, deadline=deadline)
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
            failure = {}
        # Unpaywall nobody configured: told by name, with what to do about it.
        not_configured = public_sources._not_configured_from_failure(failure)  # noqa: SLF001
        if not_configured is not None:
            raise FullTextError(not_configured.code, str(not_configured), False, not_configured) from error
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
        "resourceId": str(pdf.get("resourceId") or ""),
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
    # A comment or a processing instruction has a function for a tag.
    return node.tag.rsplit("}", 1)[-1] if isinstance(node.tag, str) else ""


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


MAX_TABLE_ROWS = 2000
MAX_TABLES_JSON_BYTES = 4 * 1024 * 1024


def _cell(node: ET.Element) -> dict:
    cell = {"text": _text(node)}
    for attribute in ("colspan", "rowspan"):
        value = node.attrib.get(attribute, "")
        if value.isdigit() and int(value) > 1:
            cell[attribute] = int(value)
    return cell


def _table_record(wrap: ET.Element) -> dict | None:
    """One JATS `table-wrap` as a record: label, caption, header and body rows of cells, footnotes.

    The text of a cell is its own, not the table's: spans are kept as `colspan` and
    `rowspan` on the cell instead of being repeated into its neighbours. A table that
    is a picture (`graphic`, no `table`) has no rows and says so by being None.
    """
    table = next((node for node in wrap.iter() if _tag(node) == "table"), None)
    if table is None:
        return None

    def rows_of(container):
        return [
            [_cell(cell) for cell in row if _tag(cell) in ("th", "td")]
            for row in container if _tag(row) == "tr" and any(_tag(cell) in ("th", "td") for cell in row)
        ]

    header, body = [], []
    for child in table:
        tag = _tag(child)
        if tag == "thead":
            header.extend(rows_of(child))
        elif tag in ("tbody", "tfoot"):
            body.extend(rows_of(child))
        elif tag == "tr":
            cells = [cell for cell in child if _tag(cell) in ("th", "td")]
            if cells and not body and all(_tag(cell) == "th" for cell in cells):
                header.extend(rows_of([child]))
            else:
                body.extend(rows_of([child]))
    foot = next((node for node in wrap if _tag(node) == "table-wrap-foot"), None)
    record = {
        "id": wrap.attrib.get("id") or None,
        "label": next((_text(child) for child in wrap if _tag(child) == "label"), "") or None,
        "caption": next((_text(child) for child in wrap if _tag(child) == "caption"), "") or None,
        "header": header,
        "rows": body[:MAX_TABLE_ROWS],
        "rowCount": len(body),
        "footnotes": [_text(note) for note in foot.iter() if _tag(note) == "p" and _text(note)] if foot is not None else [],
    }
    if len(body) > MAX_TABLE_ROWS:
        record["rowsTruncated"] = True
    return {key: value for key, value in record.items() if value is not None and (value != [] or key in ("header", "rows"))}


def _grid(rows: list[list[dict]], *, spread: bool) -> list[list[str]]:
    """Cells placed on their real columns, honouring `colspan` and `rowspan`.

    A cell that spans takes its text once; the columns and rows it covers are
    empty (`spread=False`, body rows) or repeat the text (`spread=True`, header
    rows, where "Events" over two columns names both). Without this a rowspan cell
    pushes the next row's cells one column left and every header lands over the
    wrong data.
    """
    placed: dict[tuple[int, int], str] = {}
    width = 0
    for r, row in enumerate(rows):
        column = 0
        for cell in row:
            while (r, column) in placed:
                column += 1
            colspan, rowspan = cell.get("colspan", 1), cell.get("rowspan", 1)
            for dr in range(rowspan):
                for dc in range(colspan):
                    placed[(r + dr, column + dc)] = cell["text"] if (spread or (dr == 0 and dc == 0)) else ""
            column += colspan
            width = max(width, column)
    height = len(rows)
    return [[placed.get((r, c), "") for c in range(width)] for r in range(height)]


def _markdown_table(record: dict) -> list[str]:
    """A record as a pipe table the quote check can read; header rows are joined per column."""
    def line(texts):
        return "| " + " | ".join(text.replace("|", "\\|").replace("\n", " ") for text in texts) + " |"

    header, body = record["header"], record["rows"]
    body_grid = _grid(body, spread=False)
    if header:
        head_grid = _grid(header, spread=True)
        head = [" / ".join(dict.fromkeys(value for value in column if value)) for column in zip(*head_grid)]
    elif body_grid:
        head, body_grid = body_grid[0], body_grid[1:]
    else:
        return []
    lines = [line(head), "| " + " | ".join("---" for _ in head) + " |"]
    lines.extend(line(row + [""] * (len(head) - len(row))) for row in body_grid)
    if record.get("rowsTruncated"):
        lines.append("")
        lines.append("_(%d more rows are in tables.json)_" % (record["rowCount"] - len(record["rows"])))
    return lines


def _tables_bytes(tables: list[dict], pmcid: str) -> bytes:
    payload = json.dumps({"schemaVersion": 1, "pmcid": pmcid, "tables": tables}, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8") + b"\n"
    return payload


def _append_content(lines: list[str], node: ET.Element, level: int, tables: list | None = None) -> None:
    tag = _tag(node)
    if tag == "sec":
        title = next((_text(child) for child in node if _tag(child) == "title"), "Untitled section")
        lines.extend(["", "%s %s" % ("#" * min(level, 6), title), ""])
        for child in node:
            if _tag(child) != "title":
                _append_content(lines, child, level + 1, tables)
    elif tag in {"p", "disp-quote", "boxed-text", "statement"}:
        value = _text(node)
        if value:
            lines.extend([value, ""])
    elif tag == "table-wrap":
        # The caption, then the cells: a number in a table is quotable only if it
        # is in the text, and this used to keep the caption and drop every cell.
        label = next((_text(child) for child in node if _tag(child) == "label"), tag)
        caption = next((_text(child) for child in node if _tag(child) == "caption"), "")
        record = _table_record(node)
        lines.extend(["**%s.** %s" % (label, caption or ("" if record is not None else _text(node))), ""])
        if record is not None:
            if tables is not None:
                tables.append(record)
            table_lines = _markdown_table(record)
            if table_lines:
                lines.extend(table_lines + [""])
            for note in record.get("footnotes", []):
                lines.extend([note, ""])
    elif tag in {"fig", "supplementary-material"}:
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
            _append_content(lines, child, level, tables)


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
    tables: list[dict] = []
    for child in body:
        _append_content(lines, child, 2, tables)
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
        # The tables as structured cells, for the caller to preserve beside the text.
        "_tables": tables,
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


def _fetch_open_access_pdf(metadata: dict, workspace: Path, *, intake: bool = False, deadline=None, xml_failure: "FullTextError | None" = None) -> dict:
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
    earlier = _capture_directories(workspace, relative_root)
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
    digest = Path(markdown_relative).parent.name
    changed = bool(earlier) and digest not in earlier
    data = {
        **details,
        "route": "open-access-pdf",
        # What the text is: a parser's reading, or the PDF's own text layer, of the
        # open-access PDF. Never an abstract, and never the publisher's XML.
        "contentLevel": "full_text_pdf_parsed" if parsed is not None else "full_text_pdf_text_layer",
        "openAccessOrigin": provenance.get("origin", ""),
        "openAccessVersion": provenance.get("version", ""),
        "license": provenance.get("license", ""),
        "documentResourceId": provenance.get("resourceId", ""),
        "markdownPath": markdown_relative,
        "pdfPath": pdf_relative,
        "artifactSha256s": {
            markdown_relative: hashlib.sha256(markdown_payload).hexdigest(),
            pdf_relative: hashlib.sha256(payload).hexdigest(),
        },
        "markdownCharacters": len(markdown),
        "pdfBytes": len(payload),
        # The version of the paper this PDF is (the repository's own label:
        # published, accepted or submitted version) and of this capture.
        "version": {
            "openAccessVersion": provenance.get("version", "") or None,
            "capture": {
                "pdfSha256": hashlib.sha256(payload).hexdigest(), "directory": digest, "earlierVersions": len(earlier),
                "new": digest not in earlier, "changedSinceEarlierCapture": changed,
            },
        },
        "supplementaryFiles": {"retrieval": "not_available_for_pdf_route"},
        **_reading_map(markdown, markdown_relative),
    }
    summary = "Retrieved the open-access PDF and extracted its text into the managed workspace."
    if xml_failure is not None:
        data["fallbackFrom"] = {
            "route": "europe-pmc-xml", "code": xml_failure.code, "message": str(xml_failure),
            **({"state": xml_failure.source_error.state, "reason": xml_failure.source_error.reason} if xml_failure.source_error is not None else {}),
        }
        summary = "Europe PMC would not serve the publisher's XML (%s); " % (
            xml_failure.source_error.reason.replace("_", " ") if xml_failure.source_error is not None and xml_failure.source_error.reason else xml_failure.code
        ) + "the open-access PDF was read instead."
    if changed:
        summary += " The bytes differ from the version preserved earlier; both are kept."
    warnings = []
    if intake:
        data["intake"] = _intake_section(_doi_slug(doi.casefold()), [pdf_relative], deadline)
        if not data["intake"].get("available"):
            warnings.append(data["intake"].get("how") or "Source intake was not available.")
    data["outcome"] = source_outcome.complete()
    result = {
        "status": "warning" if warnings else "success",
        "summary": summary,
        "data": data,
        "sources": [{
            "id": doi,
            "title": details["title"],
            "url": "https://doi.org/" + doi,
            "source": "open-access-pdf",
            "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "evidenceAccess": "full_text",
        }],
        "artifacts": [markdown_relative, pdf_relative],
    }
    if warnings:
        result["warnings"] = warnings
        result["next_actions"] = ["The full text itself was retrieved; add the PDF to the knowledge base by uploading it if you need it there."]
    return result


_HEX_DIGEST = re.compile(r"[0-9a-f]{64}")
_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"


def _capture_directories(workspace: Path, relative_root: Path) -> list[str]:
    """The versions already preserved under a capture root: their digest directory names."""
    try:
        return sorted(
            entry.name for entry in (workspace / relative_root).iterdir()
            if entry.is_dir() and not entry.is_symlink() and _HEX_DIGEST.fullmatch(entry.name)
        )
    except OSError:
        return []


def _jats_date(event: ET.Element) -> str | None:
    date = next((child for child in event if _tag(child) == "date"), None)
    if date is None:
        return None
    iso = (date.attrib.get("iso-8601-date") or "").strip()
    if iso:
        return iso.split(" ", 1)[0]
    parts = {_tag(child): _text(child) for child in date}
    if parts.get("year", "").isdigit() and parts.get("month", "").isdigit() and parts.get("day", "").isdigit():
        return "%04d-%02d-%02d" % (int(parts["year"]), int(parts["month"]), int(parts["day"]))
    return None


def _version_facts(xml_payload: bytes) -> tuple[dict, dict]:
    """What a PMC article says about its own version and license: `(version, license)`.

    PMC writes `pmcid-ver` (`PMC6454835.1`), an `article-version` of type
    `pmc-version`, and a `pub-history` of release, live and last-change events.
    A fact the article does not state is absent, never inferred.
    """
    try:
        root = ET.fromstring(xml_payload)
    except ET.ParseError:
        return {}, {}
    article = next((node for node in root.iter() if _tag(node) == "article"), root)
    ids = {node.attrib.get("pub-id-type", "").casefold(): _text(node) for node in article.iter() if _tag(node) == "article-id" and _text(node)}
    version = {}
    if ids.get("pmcid-ver"):
        version["pmcVersion"] = ids["pmcid-ver"]
    number = next((_text(node) for node in article.iter() if _tag(node) == "article-version" and node.attrib.get("article-version-type") == "pmc-version" and _text(node)), None)
    if number:
        version["articleVersion"] = number
    events = {node.attrib.get("event-type"): _jats_date(node) for node in article.iter() if _tag(node) == "event"}
    for key, name in (("released", "pmc-release"), ("live", "pmc-live"), ("lastChange", "pmc-last-change")):
        if events.get(name):
            version[key] = events[name]
    meta = {}
    for node in article.iter():
        if _tag(node) == "custom-meta":
            name = next((_text(child) for child in node if _tag(child) == "meta-name"), "")
            value = next((_text(child) for child in node if _tag(child) == "meta-value"), "")
            if name:
                meta[name] = value
    license_node = next((node for node in article.iter() if _tag(node) == "license"), None)
    license_url = None
    if license_node is not None:
        license_url = (license_node.attrib.get(_XLINK_HREF) or "").strip() or next((_text(child) for child in license_node.iter() if _tag(child) == "license_ref" and _text(child)), None)
    license_info = {}
    if license_url:
        license_info["url"] = license_url
    flag = {"yes": True, "no": False}.get(meta.get("pmc-prop-open-access", "").casefold())
    if flag is not None:
        license_info["openAccess"] = flag
    return version, license_info


def _explain_xml_failure(error: FullTextError, metadata: dict, pmcid: str, deadline) -> FullTextError:
    """Say why Europe PMC would not serve the XML, when its answer alone does not.

    Recorded 2026-10-04: `fullTextXML` answers HTTP 500, not 403 or 404, both for a
    PMC article that is not open access and for a PMCID that does not exist. A 500
    from it is therefore ambiguous (a real fault is a 500 too), and the article's own
    record settles it: `isOpenAccess: N` is a refusal (`denied`, and retrying cannot
    help), no record at all is "not available", and an open-access record with a
    500 is the source being down.
    """
    source = error.source_error
    if source is None or source.state != "unavailable" or source.reason != "upstream_error":
        return error
    flag = str(metadata.get("isOpenAccess") or "").upper()
    if not flag:
        try:
            looked_up = _request_json("%s/search?%s" % (EUROPE_PMC_API, urllib.parse.urlencode({
                "query": "PMCID:%s" % pmcid, "format": "json", "resultType": "lite", "pageSize": 1,
            })), deadline=deadline)
        except FullTextError:
            return error
        records = looked_up.get("resultList", {}).get("result", [])
        if not isinstance(records, list) or not records:
            return FullTextError("full_text_not_available", "Europe PMC holds no record of %s." % pmcid)
        flag = str((records[0] or {}).get("isOpenAccess") or "").upper() if isinstance(records[0], dict) else ""
    if flag == "N":
        denied = source_outcome.SourceError(
            "denied", "Europe PMC serves the full-text XML only for open-access articles; %s is in PMC without an open license." % pmcid,
            scope="Europe PMC", reason="not_open_access", retryable=False,
        )
        return FullTextError(denied.code, str(denied), False, source_error=denied)
    return error


def _supplements_section(arguments: dict, workspace: Path, pmcid: str, version: dict, xml_payload: bytes, metadata: dict, deadline) -> dict:
    """The supplementary files of one article: what it declares, and when asked, what was fetched, checked and preserved.

    Returns `{section, artifacts, failures, warnings, paths}`: `section` is
    `data.supplementaryFiles`, `artifacts` maps each preserved path to its sha256,
    `failures` are `data.outcome.failed` entries, `paths` the preserved files.
    """
    declared = supplements.declared_supplements(xml_payload)
    listed = [{key: value for key, value in entry.items() if key != "caption"} | ({"caption": entry["caption"][:200]} if entry.get("caption") else {}) for entry in declared["files"]]
    section = {"declaredCount": len(declared["files"]), "declared": listed[:50], "links": declared["links"][:10]}
    if metadata.get("hasSuppl"):
        section["europePmcSaysHasSupplementaryFiles"] = str(metadata["hasSuppl"]).upper() == "Y"
    if len(listed) > 50:
        section["declaredOutcome"] = source_outcome.truncated(
            kept=50, limit=50, unit="declared files listed", how="The article declares %d files; the rest are in fulltext.xml and are fetched with the archive." % len(listed),
        )
    result = {"section": section, "artifacts": {}, "failures": [], "warnings": [], "paths": []}
    if arguments.get("supplements") is not True:
        section["retrieval"] = "not_requested"
        return result
    scope = "Europe PMC supplementary files"
    if not declared["files"] and str(metadata.get("hasSuppl") or "").upper() == "N":
        section["retrieval"] = "none"
        section["outcome"] = source_outcome.no_results(
            reason="none_declared", how="The article declares no supplementary files and Europe PMC does not list any.",
        )
        return result
    try:
        download, empty = supplements.retrieve(pmcid, deadline=deadline, max_bytes=SUPPLEMENT_MAX_BYTES)
    except public_sources.SourceNotConfigured as error:
        failure = source_outcome.SourceError("denied", str(error), scope=scope, reason="not_configured", retryable=False)
        section["retrieval"] = "failed"
        result["failures"].append(failure.entry())
        result["warnings"].append(str(failure))
        return result
    except source_outcome.SourceError as error:
        error.scope = scope
        section["retrieval"] = "failed"
        result["failures"].append(error.entry())
        result["warnings"].append(str(error))
        return result
    except source_outcome.Truncated as error:
        section["retrieval"] = "failed"
        section["outcome"] = source_outcome.truncated(
            kept=0, limit=error.limit or SUPPLEMENT_MAX_BYTES, unit="bytes of archive",
            how="The archive is larger than the %d MiB this tool keeps. Open the paper's supplementary files on the publisher's page and add the ones you need to the knowledge base." % (SUPPLEMENT_MAX_BYTES // (1024 * 1024)),
            received=error.received,
        )
        result["warnings"].append("The supplementary-file archive exceeds the size this tool keeps; nothing from it was preserved.")
        return result
    if empty is not None:
        section["retrieval"] = "none"
        section["outcome"] = empty
        return result
    entries, skipped, walk_ended = supplements.read_zip(download.body)
    complete = download.complete and walk_ended == "end_of_archive"
    ended = walk_ended if download.complete else (download.reason or walk_ended)
    preserved, files, left_out = supplements.reconcile(declared["files"], entries, skipped, complete=complete, ended=ended)
    section["archive"] = {
        "bytesReceived": download.received, "complete": complete, "walkEnded": walk_ended,
        "seconds": round(download.elapsed, 1), **({"declaredLength": download.declared} if download.declared is not None else {}),
    }
    if not download.complete:
        state = {"deadline": "timeout", "read_stalled": "timeout", "size_limit": "truncated"}.get(download.reason, "unavailable")
        kept = len(preserved)
        if state == "truncated":
            section["outcome"] = source_outcome.truncated(
                kept=download.received, limit=SUPPLEMENT_MAX_BYTES, unit="bytes of archive",
                how="The archive passed the %d MiB this tool keeps; the %d file(s) that arrived whole are preserved. Add the rest from the publisher's page." % (SUPPLEMENT_MAX_BYTES // (1024 * 1024), kept),
            )
        else:
            how = (
                "The archive stopped arriving after %d bytes (%s): %d file(s) arrived whole and are preserved. Europe PMC builds this archive slowly; "
                "ask again later for the rest, or add the missing files from the publisher's page."
            ) % (download.received, download.reason.replace("_", " "), kept)
            failure = source_outcome.failed_part(scope, state, download.reason, how, partial={"bytesReceived": download.received, "filesKept": kept})
            result["failures"].append(failure)
        result["warnings"].append("The supplementary-file archive did not arrive whole (%s); %d file(s) are preserved." % (download.reason.replace("_", " "), kept))
    if not preserved:
        section["retrieval"] = "nothing_kept"
        section["notKept"] = left_out[:20]
        if complete:
            section["outcome"] = source_outcome.no_results(
                reason="no_supplements_in_archive", how="Europe PMC's archive held only article figures and no declared supplement.",
            )
        return result
    manifest = supplements.manifest_bytes(pmcid, version.get("pmcVersion"), declared["files"], files, left_out, complete=complete, ended=ended)
    try:
        paths = preserve(workspace, Path(".evimed-sources") / pmcid / "supplements", {**preserved, "supplements.json": manifest})
    except ImmutableCaptureError as error:
        raise FullTextError("full_text_output_invalid", str(error)) from error
    kept_files = []
    for record in files:
        stored = record.get("preservedAs")
        if stored:
            record = {**record, "path": paths[stored]}
            result["artifacts"][paths[stored]] = record["sha256"]
            result["paths"].append(paths[stored])
        kept_files.append(record)
    result["artifacts"][paths["supplements.json"]] = hashlib.sha256(manifest).hexdigest()
    result["paths"].append(paths["supplements.json"])
    section["retrieval"] = "complete" if complete else "partial"
    section["capturePath"] = str(Path(paths["supplements.json"]).parent)
    section["manifestPath"] = paths["supplements.json"]
    section["files"] = [{key: value for key, value in record.items() if key not in ("zipPath", "declared")} for record in kept_files][:supplements.MAX_PRESERVED_FILES + 20]
    if left_out:
        section["notKept"] = [{key: value for key, value in record.items() if key in ("name", "status", "reason", "bytes")} for record in left_out][:20]
    section["verified"] = sum(1 for record in files if record.get("status") == "verified")
    mismatched = [record["name"] for record in files if record.get("status") == "md5_mismatch"]
    missing = [record["name"] for record in files if record.get("status") == "not_received"]
    section["mismatched"] = len(mismatched)
    section["notReceived"] = len(missing)
    if mismatched:
        result["warnings"].append("%d supplementary file(s) do not match the md5 the article declares and are kept labelled md5_mismatch: %s." % (len(mismatched), ", ".join(mismatched[:5])))
    if missing and complete:
        result["warnings"].append("%d declared supplementary file(s) are not in Europe PMC's archive: %s." % (len(missing), ", ".join(missing[:5])))
    return result


def _intake_section(group: str, files: list[str], deadline) -> dict:
    """The hand-off to source intake, as `data.intake`: never fails the retrieval it came from."""
    return source_intake.hand_off(group, files, deadline=deadline)


def fetch(arguments: dict) -> dict:
    identifier = str(arguments.get("identifier") or "").strip()
    with_supplements = arguments.get("supplements") is True
    with_intake = arguments.get("intake") is True
    deadline = transport.Deadline(DEADLINE_WITH_SUPPLEMENTS_SECONDS if with_supplements else DEADLINE_SECONDS)
    try:
        metadata = _resolve(identifier, deadline=deadline)
        pmcid = str(metadata.get("pmcid") or "").upper()
        workspace = _workspace()
        if not re.fullmatch(r"PMC\d{3,12}", pmcid):
            return _fetch_open_access_pdf(metadata, workspace, intake=with_intake, deadline=deadline)
        url = "%s/%s/fullTextXML" % (EUROPE_PMC_API, pmcid)
        try:
            xml_payload = _request_bytes(url, "application/xml", deadline=deadline)
        except FullTextError as failure:
            # A PMCID only means Europe PMC indexes the record, not that it may
            # serve the text: subscription articles have one and refuse the XML.
            # Those are exactly the records worth trying the open-access route
            # for, so a refusal here is a reason to continue, not to stop.
            failure = _explain_xml_failure(failure, metadata, pmcid, deadline)
            if metadata.get("doi"):
                return _fetch_open_access_pdf(metadata, workspace, intake=with_intake, deadline=deadline, xml_failure=failure)
            raise failure
        markdown, details = _render_markdown(xml_payload, {**metadata, "pmcid": pmcid})
        tables = details.pop("_tables", [])
        version, license_info = _version_facts(xml_payload)
        relative_root = Path(".evimed-sources") / pmcid
        earlier = _capture_directories(workspace, relative_root)
        markdown_payload = markdown.encode("utf-8")
        capture_artifacts = {"fulltext.md": markdown_payload, "fulltext.xml": xml_payload}
        tables_payload = _tables_bytes(tables, pmcid) if tables and len(_tables_bytes(tables, pmcid)) <= MAX_TABLES_JSON_BYTES else None
        if tables_payload is not None:
            capture_artifacts["tables.json"] = tables_payload
        artifacts = _with_sidecar(capture_artifacts, {
            "id": pmcid, "title": details["title"], "url": "https://europepmc.org/articles/%s" % pmcid,
            "publicationTypes": _publication_types(metadata), "articleType": details.get("articleType"),
        })
        try:
            paths = preserve(workspace, relative_root, artifacts)
        except ImmutableCaptureError as error:
            raise FullTextError("full_text_output_invalid", str(error)) from error
        markdown_relative = paths["fulltext.md"]
        xml_relative = paths["fulltext.xml"]
        digest = Path(markdown_relative).parent.name
        is_new = digest not in earlier
        changed = bool(earlier) and is_new
        version["capture"] = {
            "xmlSha256": hashlib.sha256(xml_payload).hexdigest(), "directory": digest,
            "earlierVersions": len(earlier), "new": is_new, "changedSinceEarlierCapture": changed,
        }
        sha256s = {
            markdown_relative: hashlib.sha256(markdown_payload).hexdigest(),
            xml_relative: hashlib.sha256(xml_payload).hexdigest(),
        }
        preserved_paths = [markdown_relative, xml_relative]
        if tables_payload is not None:
            sha256s[paths["tables.json"]] = hashlib.sha256(tables_payload).hexdigest()
            preserved_paths.append(paths["tables.json"])
        extra = _supplements_section(arguments, workspace, pmcid, version, xml_payload, metadata, deadline)
        sha256s.update(extra["artifacts"])
        preserved_paths.extend(extra["paths"])
        failures, warnings = list(extra["failures"]), list(extra["warnings"])
        data = {
            **details,
            "route": "europe-pmc-xml",
            # What the text is: the whole article as the publisher's XML, never an abstract.
            "contentLevel": "full_text_xml",
            "markdownPath": markdown_relative,
            "xmlPath": xml_relative,
            "artifactSha256s": sha256s,
            "markdownCharacters": len(markdown),
            "xmlBytes": len(xml_payload),
            "version": version,
            **({"license": license_info["url"]} if license_info.get("url") else {}),
            **({"openAccess": license_info["openAccess"]} if "openAccess" in license_info else {}),
            "tables": {"count": len(tables), "withCells": sum(1 for table in tables if table.get("rows")), **({"path": paths["tables.json"]} if tables_payload is not None else {})},
            "supplementaryFiles": extra["section"],
            **_reading_map(markdown, markdown_relative),
        }
        if tables and tables_payload is None:
            data["tables"]["outcome"] = source_outcome.truncated(
                kept=0, limit=MAX_TABLES_JSON_BYTES, unit="bytes of tables.json",
                how="The tables are larger than the file this tool writes; their cells are in fulltext.md and fulltext.xml.",
            )
        if with_intake:
            intake_files = [markdown_relative, *[path for path in extra["paths"] if not path.endswith("/supplements.json")]]
            data["intake"] = _intake_section(pmcid, intake_files, deadline)
            if not data["intake"].get("available"):
                warnings.append(data["intake"].get("how") or "Source intake was not available.")
        data["outcome"] = source_outcome.with_failures(source_outcome.complete(), failures)
        source = {
            "id": pmcid,
            "title": details["title"],
            "url": "https://europepmc.org/articles/%s" % pmcid,
            "source": "europe-pmc-fulltext",
            "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "evidenceAccess": "full_text",
        }
        summary = "Retrieved the complete open-access article into the managed workspace."
        if changed:
            summary += " Europe PMC now serves different text than the version preserved earlier; both are kept."
        result = {
            "status": "warning" if warnings else "success",
            "summary": summary,
            "data": data,
            "sources": [source],
            "artifacts": preserved_paths,
        }
        if warnings:
            result["warnings"] = warnings
            result["next_actions"] = [
                action for entry in failures for action in [entry.get("how")] if action
            ] or ["Check the files the warnings name before relying on them; the full text itself was retrieved whole."]
        return result
    except FullTextError as error:
        left_out = error.not_configured
        source_error = error.source_error
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": left_out.next_actions() if left_out is not None else (
                source_error.next_actions() if source_error is not None else [
                    "Verify the identifier and open-access status, or stop rather than infer missing full-text facts."
                ]
            ),
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": (
                    "No open-access full text could be fetched because this source is not configured for this account; "
                    "retrying cannot change that."
                    if left_out is not None
                    else (source_error.stop_reason() if source_error is not None else "No verified open-access full text was written to the workspace.")
                ),
            },
        }
