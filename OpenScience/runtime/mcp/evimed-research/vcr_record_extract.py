#!/usr/bin/env python3
"""Text extraction for a patient record document, run in a disposable container.

「虚拟临研」 accepts hospital records as PDF and Word. They are converted to text
INSIDE the deployment: the control plane starts this script in a bounded,
network-less container (``apps/server/src/vcrIntakeController.mjs``) that sees
exactly two paths -- ``/input/document.<pdf|docx>``, the one file, read-only, and
``/output``, an empty directory -- both inside the VCR data plane's scratch area,
and nothing else: no model, no workspace, no credential, and no view of the rest
of the plane. It reads the file, writes ``text.txt`` and ``result.json``, and
exits.

The runtime controller that starts the container never reads the file (it does
not mount the plane), so the file is not taken on trust: the script's first act is
to open it without following a link, require a regular file of exactly the size
it was told, read it ONCE, and require the bytes to hash to the SHA-256 it was
told. Any mismatch is a refusal (``request_invalid``), and nothing else is read
from the file afterwards than those very bytes -- the document is parsed from the
verified copy in memory, so the file cannot change between the check and the use.

The script measures; the control plane decides. It reports how many pages the
document has and how many non-blank characters each one yielded, and the
control plane applies its own threshold to call a document scanned, so the
rule lives in one place (``vcrRecordExtract.mjs``) and is configured there.

- PDF: ``pypdf``'s text layer, page by page. A page that yields no text stays in
  the count as a page with zero characters, which is how a scan reads.
- Word (``.docx``): the main document part, read directly as XML. One paragraph
  is one line and one table row is one line with its cells joined by `` | ``,
  so a value a person can quote from a cell is a value a program can find in the
  text. Deleted tracked changes are left out, the text of insertions stays, and
  a text box is read once (the DrawingML ``Choice`` of an ``AlternateContent``,
  never its VML fallback). Headers, footers and footnotes are separate parts and
  are not read.

Hidden knowledge: a ``.docx`` is a zip and its XML is untrusted. Word never
writes a DOCTYPE, so one is refused (no entity expansion is ever attempted); the
declared size of every member is summed before anything is inflated; an
encrypted member, an absurd member count and nesting beyond what any document
reaches are refused by name. None of this protects the host -- the container
does -- it makes the refusal a reason a reader can act on instead of a killed
process.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import signal
import stat
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NAME = "evimed-record-extract"
VERSION = "1.0.0"
PROTOCOL = 1

# A document part larger than this (uncompressed) is not a record. The request's
# own `maxXmlBytes` can only lower it.
DEFAULT_MAX_XML_BYTES = 24 * 1024 * 1024
MAX_ZIP_MEMBERS = 4000
MAX_ZIP_UNPACKED_BYTES = 256 * 1024 * 1024
MAX_XML_DEPTH = 200

W_SKIP = frozenset({
    "rPr", "pPr", "tblPr", "trPr", "tcPr", "sectPr", "tblGrid", "sdtPr", "sdtEndPr", "instrText", "delText", "del", "moveFrom",
    "bookmarkStart", "bookmarkEnd", "proofErr", "commentRangeStart", "commentRangeEnd", "fldChar", "footnoteReference",
    "endnoteReference", "commentReference", "annotationRef", "drawing", "pict", "object", "numPr", "rPrChange", "pPrChange",
})
TEXTBOX_HOSTS = frozenset({"drawing", "pict", "object"})
# Elements whose children are read in place (containers that hold runs or blocks).
CONTAINERS = frozenset({"body", "sdt", "sdtContent", "hyperlink", "smartTag", "customXml", "ins", "moveTo", "fldSimple", "r", "txbxContent", "docPartBody"})


class Refusal(Exception):
    """A document this script will not read, with the reason the control plane maps."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _local(tag: object) -> str:
    text = tag if isinstance(tag, str) else ""
    return text.rsplit("}", 1)[-1]


def clean_text(raw: str) -> str:
    """Newlines normalized, control characters dropped, runs of blank lines folded.

    Nothing else is touched: no Unicode normalization, no re-flowing. What the
    reader quotes is what the control plane stores.
    """
    text = raw.replace("\r\n", "\n").replace("\r", "\n").replace(" ", "\n").replace(" ", "\n").replace("\f", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0e-\x1f\x7f]", "", text)
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n")


def significant_chars(text: str) -> int:
    """Non-whitespace characters: what 'this page has text' is measured in."""
    return len(re.sub(r"\s+", "", text))


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------


def extract_pdf(data: bytes, max_pages: int, max_chars: int) -> dict:
    """The text layer of every page, and how much each page had.

    Returns ``{pages, pageChars, text, truncated, pageErrors}``. A document with
    more pages than ``max_pages`` is refused before a page is read.
    """
    try:
        from pypdf import PdfReader  # imported late: the module is also imported where pypdf is absent
    except ImportError as error:  # pragma: no cover - the image ships pypdf
        raise Refusal("converter_missing", "pypdf is not installed") from error
    if b"%PDF-" not in data[:1024]:
        raise Refusal("not_pdf")
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            # An owner-password-only PDF opens with the empty user password.
            if not reader.decrypt(""):
                raise Refusal("encrypted")
        pages = len(reader.pages)
    except Refusal:
        raise
    except Exception as error:  # noqa: BLE001 - pypdf raises a wide family; the reason is what matters
        name = type(error).__name__
        if "Dependency" in name or "encrypt" in str(error).lower() or "password" in str(error).lower():
            raise Refusal("encrypted", name) from error
        raise Refusal("corrupt", name) from error
    if pages < 1:
        raise Refusal("corrupt", "no pages")
    if pages > max_pages:
        raise Refusal("too_many_pages", str(pages))
    chunks: list[str] = []
    page_chars: list[int] = []
    page_errors = 0
    total = 0
    truncated = False
    for index in range(pages):
        try:
            extracted = reader.pages[index].extract_text() or ""
        except Exception:  # noqa: BLE001 - one unreadable page is a page without text, not a failed document
            extracted = ""
            page_errors += 1
        cleaned = clean_text(extracted)
        page_chars.append(significant_chars(cleaned))
        total += len(cleaned)
        if total > max_chars:
            truncated = True
            break
        chunks.append(cleaned)
    if truncated:
        # The control plane refuses the document as too large; the count it is
        # told is only a lower bound.
        page_chars.extend([0] * (pages - len(page_chars)))
    return {"pages": pages, "pageChars": page_chars, "text": "\n\n".join(chunk for chunk in chunks if chunk), "truncated": truncated, "pageErrors": page_errors}


# ---------------------------------------------------------------------------
# Word
# ---------------------------------------------------------------------------


def _parse_xml(data: bytes) -> ET.Element:
    """An OOXML part as a tree, after the checks that make entity tricks impossible.

    Word writes UTF-8 and never a DOCTYPE, so anything else is refused outright:
    a UTF-16 part or a declared exotic encoding could hide the bytes of a DOCTYPE
    from the scan below, and a DOCTYPE is the only place an entity can be defined.
    """
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in data[:256]:
        raise Refusal("corrupt", "encoding")
    declared = re.match(rb"\s*<\?xml[^>]*?encoding\s*=\s*[\"']([A-Za-z0-9_.-]+)[\"']", data)
    if declared and declared.group(1).lower() not in (b"utf-8", b"utf8"):
        raise Refusal("corrupt", "encoding")
    if re.search(rb"<!(?:doctype|entity)", data, re.IGNORECASE):
        raise Refusal("corrupt", "dtd")
    try:
        return ET.fromstring(data)
    except ET.ParseError as error:
        raise Refusal("corrupt", "xml") from error


def _main_part(archive: zipfile.ZipFile) -> str:
    """The package's main document part: what `_rels/.rels` names, else the usual path."""
    try:
        info = archive.getinfo("_rels/.rels")
        if info.file_size > 65536:
            return "word/document.xml"
        rels = _parse_xml(archive.read(info))
    except KeyError:
        return "word/document.xml"
    for relation in rels:
        if str(relation.get("Type", "")).endswith("/officeDocument"):
            target = str(relation.get("Target", "")).lstrip("/")
            if target:
                return target
    return "word/document.xml"


def _cell_text(cell: ET.Element, depth: int) -> str:
    parts: list[str] = []
    for child in cell:
        name = _local(child.tag)
        if name == "p":
            line = _paragraph_text(child, depth + 1).strip()
            if line:
                parts.append(line)
        elif name == "tbl":
            nested = _table_lines(child, depth + 1)
            if nested:
                parts.append(" ; ".join(nested))
        elif name == "sdt":
            content = next((item for item in child if _local(item.tag) == "sdtContent"), None)
            if content is not None:
                inner = _cell_text(content, depth + 1)
                if inner:
                    parts.append(inner)
    return " ".join(parts)


def _table_lines(table: ET.Element, depth: int) -> list[str]:
    lines: list[str] = []
    for row in table:
        if _local(row.tag) != "tr":
            continue
        cells = [_cell_text(cell, depth + 1) for cell in row if _local(cell.tag) == "tc"]
        if any(cells):
            lines.append(" | ".join(cells))
    return lines


def _paragraph_text(paragraph: ET.Element, depth: int) -> str:
    if depth > MAX_XML_DEPTH:
        raise Refusal("corrupt", "nesting")
    out: list[str] = []
    for node in paragraph:
        _inline_text(node, out, depth + 1)
    return "".join(out)


def _inline_text(node: ET.Element, out: list[str], depth: int) -> None:
    if depth > MAX_XML_DEPTH:
        raise Refusal("corrupt", "nesting")
    name = _local(node.tag)
    if name in W_SKIP:
        # A text box lives in a `drawing`/`pict`/`object`; it is read through its
        # own `txbxContent`, so the container is skipped but not what it carries.
        if name in TEXTBOX_HOSTS:
            for found in _textboxes(node, 0):
                lines = _block_lines(found, depth + 1)
                if lines:
                    out.append("\n" + "\n".join(lines) + "\n")
        return
    if name == "t":
        out.append(node.text or "")
    elif name == "tab":
        out.append("\t")
    elif name in ("br", "cr"):
        out.append("\n")
    elif name == "noBreakHyphen":
        out.append("-")
    elif name == "AlternateContent":
        choice = next((item for item in node if _local(item.tag) == "Choice"), None)
        if choice is not None:
            for child in choice:
                _inline_text(child, out, depth + 1)
    elif name in CONTAINERS:
        for child in node:
            _inline_text(child, out, depth + 1)


def _textboxes(node: ET.Element, depth: int) -> list[ET.Element]:
    if depth > MAX_XML_DEPTH:
        raise Refusal("corrupt", "nesting")
    found: list[ET.Element] = []
    for child in node:
        name = _local(child.tag)
        if name == "txbxContent":
            found.append(child)
        elif name == "Fallback":
            continue
        else:
            found.extend(_textboxes(child, depth + 1))
    return found


def _block_lines(container: ET.Element, depth: int) -> list[str]:
    """Paragraphs and tables of a block container, one line each."""
    if depth > MAX_XML_DEPTH:
        raise Refusal("corrupt", "nesting")
    lines: list[str] = []
    for child in container:
        name = _local(child.tag)
        if name == "p":
            lines.append(_paragraph_text(child, depth + 1))
        elif name == "tbl":
            lines.extend(_table_lines(child, depth + 1))
        elif name == "sdt":
            content = next((item for item in child if _local(item.tag) == "sdtContent"), None)
            if content is not None:
                lines.extend(_block_lines(content, depth + 1))
        elif name in ("txbxContent", "docPartBody", "customXml", "ins", "moveTo"):
            lines.extend(_block_lines(child, depth + 1))
        elif name == "AlternateContent":
            choice = next((item for item in child if _local(item.tag) == "Choice"), None)
            if choice is not None:
                lines.extend(_block_lines(choice, depth + 1))
    return lines


def extract_docx(data: bytes, max_chars: int, max_xml_bytes: int = DEFAULT_MAX_XML_BYTES) -> dict:
    """The main document part of a .docx as text, one paragraph or table row per line."""
    if data[:4] != b"PK\x03\x04":
        # An OLE compound file is an old .doc, or an encrypted package: neither is read.
        raise Refusal("not_docx")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise Refusal("corrupt", "zip") from error
    with archive:
        members = archive.infolist()
        if len(members) > MAX_ZIP_MEMBERS:
            raise Refusal("corrupt", "members")
        if sum(member.file_size for member in members) > MAX_ZIP_UNPACKED_BYTES:
            raise Refusal("corrupt", "unpacked size")
        if any(member.flag_bits & 0x1 for member in members):
            raise Refusal("encrypted")
        names = {member.filename for member in members}
        if "[Content_Types].xml" not in names:
            raise Refusal("not_docx")
        part = _main_part(archive)
        if part not in names:
            raise Refusal("not_docx", "no main part")
        info = archive.getinfo(part)
        if info.file_size > max_xml_bytes:
            raise Refusal("too_large", "document part")
        with archive.open(info) as stream:
            xml = stream.read(max_xml_bytes + 1)
        pages = None
        if "docProps/app.xml" in names:
            try:
                app = archive.read("docProps/app.xml")[:65536].decode("utf-8", "replace")
                found = re.search(r"<Pages>\s*(\d{1,5})\s*</Pages>", app)
                pages = int(found.group(1)) if found else None
            except (KeyError, ValueError):
                pages = None
    if len(xml) > max_xml_bytes:
        raise Refusal("too_large", "document part")
    root = _parse_xml(xml)
    body = next((child for child in root if _local(child.tag) == "body"), root)
    lines = _block_lines(body, 0)
    text = clean_text("\n".join(lines))
    truncated = len(text) > max_chars
    return {"pages": pages, "pageChars": [], "text": text[:max_chars] if truncated else text, "truncated": truncated, "pageErrors": 0}


# ---------------------------------------------------------------------------
# The container's entry
# ---------------------------------------------------------------------------


def _libraries() -> dict:
    versions: dict[str, str] = {}
    try:
        import pypdf  # noqa: PLC0415

        versions["pypdf"] = str(getattr(pypdf, "__version__", "unknown"))
    except ImportError:  # pragma: no cover
        versions["pypdf"] = "missing"
    versions["python"] = "%d.%d.%d" % sys.version_info[:3]
    return versions


def read_verified(source: Path, expectation: dict) -> bytes:
    """The staged file's bytes, read once, and only if they are the file that was digested.

    The controller that started this container cannot look at the file, so this is
    where "the file I was told about" is made true: opened without following a
    link, a regular file (never a directory, a device or a FIFO), exactly the
    expected size, and bytes that hash to the expected SHA-256. One read serves
    both the check and the parse, so nothing can change in between. Every failure
    is ``request_invalid``; the detail names which check, never the content.
    """
    expected_hash = str(expectation.get("sha256") or "")
    expected_bytes = expectation.get("bytes")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash) or isinstance(expected_bytes, bool) or not isinstance(expected_bytes, int) or expected_bytes < 1:
        raise Refusal("request_invalid", "expectation")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(str(source), flags)
    except OSError as error:
        raise Refusal("request_invalid", "file") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_bytes:
            raise Refusal("request_invalid", "file")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            # One byte past the expectation: a file that grew is caught by length.
            data = handle.read(expected_bytes + 1)
    finally:
        os.close(descriptor)
    if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_hash:
        raise Refusal("request_invalid", "hash")
    return data


def run(request: dict, source: Path, output_dir: Path) -> dict:
    """One extraction: the request carries the format, the file's expected digest and size, and the limits."""
    data = read_verified(source, request.get("file") or {})
    form = str(request.get("format") or "")
    limits = request.get("limits") or {}
    max_pages = int(limits.get("maxPages", 300))
    max_chars = int(limits.get("maxChars", 1024 * 1024))
    max_xml = min(int(limits.get("maxXmlBytes", DEFAULT_MAX_XML_BYTES)), DEFAULT_MAX_XML_BYTES)
    if form == "pdf":
        got = extract_pdf(data, max_pages, max_chars)
    elif form == "docx":
        got = extract_docx(data, max_chars, max_xml)
    else:
        raise Refusal("request_invalid", "format")
    text = got["text"]
    out = text.encode("utf-8")
    (output_dir / "text.txt").write_bytes(out)
    return {
        "protocol": PROTOCOL,
        "outcome": "text",
        "extractor": {"name": NAME, "version": VERSION, "libraries": _libraries()},
        "format": form,
        "pages": got["pages"],
        "pageChars": got["pageChars"],
        "pageErrors": got["pageErrors"],
        "chars": significant_chars(text),
        "textBytes": len(out),
        "textSha256": hashlib.sha256(out).hexdigest(),
        "truncated": bool(got["truncated"]),
    }


def _write_result(output_dir: Path, result: dict) -> None:
    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--file", required=True, help="the one staged file, bound read-only")
    parser.add_argument("--format", required=True, choices=["pdf", "docx"])
    parser.add_argument("--expect-sha256", required=True, help="the SHA-256 the file must have")
    parser.add_argument("--expect-bytes", required=True, type=int, help="the size in bytes the file must have")
    parser.add_argument("--max-pages", type=int, default=300)
    parser.add_argument("--max-chars", type=int, default=1024 * 1024)
    parser.add_argument("--max-xml-bytes", type=int, default=DEFAULT_MAX_XML_BYTES)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--deadline", type=int, default=0, help="seconds after which the script ends itself (0 = none)")
    args = parser.parse_args(argv)
    output_dir = Path(args.output_dir)
    base = {"protocol": PROTOCOL, "extractor": {"name": NAME, "version": VERSION, "libraries": _libraries()}}

    def on_alarm(_signal: int, _frame: object) -> None:
        raise Refusal("deadline")

    if args.deadline > 0 and hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(args.deadline)
    try:
        request = {
            "format": args.format,
            "file": {"sha256": args.expect_sha256, "bytes": args.expect_bytes},
            "limits": {"maxPages": args.max_pages, "maxChars": args.max_chars, "maxXmlBytes": args.max_xml_bytes},
        }
        result = run(request, Path(args.file), output_dir)
    except Refusal as refusal:
        result = {**base, "outcome": "refused", "reason": refusal.reason, "format": None}
    except MemoryError:
        result = {**base, "outcome": "refused", "reason": "memory"}
    except Exception as error:  # noqa: BLE001 - the control plane is told the class, never the message (it may quote the document)
        result = {**base, "outcome": "refused", "reason": "failed", "errorClass": type(error).__name__}
    finally:
        if args.deadline > 0 and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
    _write_result(output_dir, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
