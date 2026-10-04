"""A paper's supplementary files, by version: what the article declares, what Europe PMC sends, and what survives checking.

Hidden knowledge, all from the live wire (2026-10-04):

- **The article names its own files, with their digests.** PMC's JATS carries each
  supplementary file as `<media xlink:href="Data_Sheet_1.PDF">` with processing
  instructions `<?suppdata-name?>`, `<?suppdata-size?>` and `<?suppdata-md5?>`. So
  what Europe PMC sends can be checked against what the article says it is: a file
  whose md5 matches is the file; one that does not is kept and labelled, never
  silently swapped or dropped. A file the article does not declare and that is an
  image is an article figure (Europe PMC's zip includes inline images by default)
  and is not a supplement.
- **`supplementaryFiles` is a zip built as it streams.** 33 s to the first byte and
  136 s for 3.5 MB on one article, a few seconds on another. The entries use data
  descriptors (flag 0x0808: sizes and CRC come after each entry's data) and the
  central directory is last, so a download that stops partway has no directory but
  does hold every entry that finished. The zip is therefore read by walking its
  local headers, which yields the whole entries of a complete archive and of a cut
  one alike; the partial result is labelled and each entry is verified on its own.
- **Errors arrive as HTTP 200 XML.** An article that is not open access answers an
  `errorBean` ("... is not open access one") and an open-access article with no
  supplementary files answers an empty `fullTextXMLBean`. Neither is a zip, and the
  first is a refusal (`denied`) and the second an honest `no_results`.

What is preserved is the files themselves and one `supplements.json`: the declared
list, what arrived, each file's sha256 and whether its md5 matched the article's.
The bytes carry no timestamp, so the same supplements are the same capture, and a
file that changed is a new version beside the old.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
import xml.etree.ElementTree as ET
import zlib
from pathlib import PurePosixPath

import public_sources
import source_outcome
import source_transport as transport

MAX_ENTRIES = 200
MAX_PRESERVED_FILES = 60
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
IMAGE_SUFFIXES = frozenset({".gif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".svg", ".bmp"})
RESERVED_NAMES = frozenset({"capture.json", "supplements.json"})
_XLINK = "{http://www.w3.org/1999/xlink}"
_PI = re.compile(r"^suppdata-([a-z0-9-]+)\s+(.*)$", re.S)


def _local(node):
    return node.tag.rsplit("}", 1)[-1] if isinstance(node.tag, str) else ""


def _text(node):
    if node is None:
        return ""
    return re.sub(r"\s+", " ", " ".join(node.itertext())).strip()


# ----------------------------------------------------------------------------
# What the article declares
# ----------------------------------------------------------------------------
def declared_supplements(xml_payload):
    """The files a JATS article declares as supplementary, and its external links.

    Parsed with a parser that keeps processing instructions, which is where PMC
    writes each file's name, size and md5. (The prose renderer parses the same
    bytes without them: with them kept, an element's text would include the
    instruction text.) Returns `{files: [...], links: [...]}`; a field the article
    does not give is absent, never guessed.
    """
    try:
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_pis=True))
        root = ET.fromstring(xml_payload, parser=parser)
    except ET.ParseError:
        return {"files": [], "links": []}
    files, links = [], []
    for material in root.iter():
        if _local(material) != "supplementary-material":
            continue
        label = next((_text(child) for child in material if _local(child) == "label"), "")
        caption = next((_text(child) for child in material if _local(child) == "caption"), "")
        for child in material:
            kind = _local(child)
            href = (child.attrib.get(_XLINK + "href") or "").strip()
            if kind in ("media", "inline-supplementary-material") and href:
                pis = {}
                for node in child:
                    if not isinstance(node.tag, str) and node.text:
                        found = _PI.match(node.text.strip())
                        if found:
                            pis[found.group(1)] = found.group(2).strip()
                entry = {"id": material.attrib.get("id") or None, "label": label or None, "caption": caption or None, "name": pis.get("name") or PurePosixPath(href).name}
                if re.fullmatch(r"\d+", pis.get("size", "")):
                    entry["sizeBytes"] = int(pis["size"])
                if re.fullmatch(r"[0-9a-fA-F]{32}", pis.get("md5", "")):
                    entry["md5"] = pis["md5"].lower()
                if pis.get("mime-type"):
                    entry["mimeType"] = "%s/%s" % (pis["mime-type"], pis["mime-sub-type"]) if pis.get("mime-sub-type") else pis["mime-type"]
                files.append({key: value for key, value in entry.items() if value is not None})
            elif kind in ("ext-link", "uri") and href.startswith(("http://", "https://")):
                links.append({"label": label or None, "url": href})
    # The article's own links to a publisher's supplement page are not files.
    for node in root.iter():
        if _local(node) == "ext-link" and "supplement" in (node.attrib.get(_XLINK + "href") or "").casefold():
            url = (node.attrib.get(_XLINK + "href") or "").strip()
            if url.startswith(("http://", "https://")) and not any(entry["url"] == url for entry in links):
                links.append({"label": None, "url": url})
    unique, seen = [], set()
    for entry in files:
        key = (entry.get("name"), entry.get("md5"))
        if key not in seen:
            seen.add(key)
            unique.append(entry)
    return {"files": unique, "links": links}


# ----------------------------------------------------------------------------
# The zip, read by its local headers
# ----------------------------------------------------------------------------
def _inflate(view, start, limit):
    """Inflate one raw-deflate stream starting at `start`, bounded: `(payload | None, next offset | None, too_large)`.

    `payload` is None when the entry is larger than `limit` (it is still walked
    past); the offset is None when the stream ends before its end marker, which
    is a download cut short inside this entry.
    """
    decompressor = zlib.decompressobj(-15)
    parts, produced, too_large = [], 0, False
    offset = start
    while offset < len(view) and not decompressor.eof:
        piece = view[offset:offset + (1 << 20)]
        out = decompressor.decompress(piece, 1 << 20)
        while True:
            produced += len(out)
            if not too_large:
                if produced > limit:
                    too_large, parts = True, []
                else:
                    parts.append(out)
            tail = decompressor.unconsumed_tail
            if decompressor.eof or not tail:
                break
            out = decompressor.decompress(tail, 1 << 20)
        if decompressor.eof:
            offset += len(piece) - len(decompressor.unused_data)
            break
        offset += len(piece)
    if not decompressor.eof:
        return None, None, too_large
    return (None if too_large else b"".join(parts)), offset, too_large


def read_zip(data):
    """The entries of a zip, walking its local headers.

    Returns `(entries, skipped, ended)`. `entries` are `{zipPath, name, payload,
    crcOk}` for every entry that arrived whole (`crcOk` None when the archive was
    cut before the entry's data descriptor); `skipped` are `{zipPath, reason}`;
    `ended` is why the walk stopped: `end_of_archive` (the central directory was
    reached, so the archive is whole), or `end_of_data`, `cut_in_header`,
    `cut_in_entry`, `too_large`, `unsupported` or `unrecognised` for one that is not.
    """
    view = memoryview(data)
    pos, total = 0, 0
    entries, skipped = [], []
    while True:
        if len(entries) + len(skipped) >= MAX_ENTRIES:
            return entries, skipped, "too_large"
        if pos + 4 > len(data):
            return entries, skipped, "end_of_data"
        signature = bytes(view[pos:pos + 4])
        if signature in (b"PK\x01\x02", b"PK\x05\x06", b"PK\x06\x06"):
            return entries, skipped, "end_of_archive"
        if signature != b"PK\x03\x04":
            return entries, skipped, "unrecognised"
        if pos + 30 > len(data):
            return entries, skipped, "cut_in_header"
        _version, flag, method, _time, _date, crc, csize, _usize, name_length, extra_length = struct.unpack_from("<HHHHHIIIHH", data, pos + 4)
        data_start = pos + 30 + name_length + extra_length
        if data_start > len(data):
            return entries, skipped, "cut_in_header"
        raw = bytes(view[pos + 30:pos + 30 + name_length])
        zip_path = raw.decode("utf-8" if flag & 0x800 else "cp437", "replace")
        has_descriptor = bool(flag & 0x08)
        if method == 0 and not has_descriptor:
            end = data_start + csize
            if end > len(data):
                return entries, skipped, "cut_in_entry"
            payload, next_pos = bytes(view[data_start:end]), end
        elif method == 8:
            if has_descriptor:
                payload, next_pos, big = _inflate(view, data_start, MAX_ENTRY_BYTES)
            else:
                end = data_start + csize
                if end > len(data):
                    return entries, skipped, "cut_in_entry"
                payload, next_pos, big = _inflate(view[:end], data_start, MAX_ENTRY_BYTES)
            if next_pos is None:
                return entries, skipped, "cut_in_entry"
            if big:
                skipped.append({"zipPath": zip_path, "reason": "larger_than_%d_bytes" % MAX_ENTRY_BYTES})
        else:
            return entries, skipped, "unsupported"
        pos = next_pos
        recorded_crc = crc
        if has_descriptor:
            if bytes(view[pos:pos + 4]) == b"PK\x07\x08":
                pos += 4
            if pos + 12 <= len(data):
                recorded_crc = struct.unpack_from("<I", data, pos)[0]
                pos += 12
            else:
                recorded_crc = None
                pos = len(data)
        if payload is None:
            continue
        total += len(payload)
        if total > MAX_TOTAL_BYTES:
            return entries, skipped, "too_large"
        if zip_path.endswith("/"):
            continue
        entries.append({
            "zipPath": zip_path, "name": PurePosixPath(zip_path.replace("\\", "/")).name, "payload": payload,
            "crcOk": None if recorded_crc is None else (zlib.crc32(payload) & 0xFFFFFFFF) == recorded_crc,
        })


def _is_image(name):
    return PurePosixPath(name).suffix.casefold() in IMAGE_SUFFIXES


def _safe_name(name, taken):
    """A plain file name for a capture: no path, not a reserved name, unique."""
    base = PurePosixPath(name.replace("\\", "/")).name.strip().lstrip(".") or "file"
    candidate = base
    counter = 1
    while candidate in taken or candidate in RESERVED_NAMES:
        counter += 1
        stem, dot, suffix = base.rpartition(".")
        candidate = ("%s-%d.%s" % (stem, counter, suffix)) if dot else "%s-%d" % (base, counter)
    taken.add(candidate)
    return candidate


def reconcile(declared, entries, skipped, *, complete, ended):
    """What to preserve, and the account of every file: declared against received.

    A declared file is `verified` (md5 matches the article's), `md5_mismatch` (kept,
    labelled), `unverified` (no md5 declared) or `not_received`. A received file the
    article does not declare is kept unless it is an image (an article figure), and
    is `undeclared`. A corrupt entry (its own CRC fails) is never kept.
    Returns `(preserved, files, left_out)`: the capture's `{name: bytes}`, one
    record per file, and what was received and not kept.
    """
    by_name = {entry["name"].casefold(): entry for entry in declared}
    preserved, files, left_out, taken = {}, [], [], set()
    seen_declared = set()
    for entry in entries:
        digest_md5 = hashlib.md5(entry["payload"], usedforsecurity=False).hexdigest()
        declared_entry = by_name.get(entry["name"].casefold())
        record = {"name": entry["name"], "zipPath": entry["zipPath"], "bytes": len(entry["payload"]), "sha256": hashlib.sha256(entry["payload"]).hexdigest(), "md5": digest_md5}
        if entry["crcOk"] is False:
            left_out.append({**record, "status": "corrupt", "reason": "the zip entry's own CRC does not match its bytes"})
            continue
        if declared_entry is None and _is_image(entry["name"]):
            left_out.append({**record, "status": "article_figure", "reason": "an image the article does not declare as a supplement"})
            continue
        if len(preserved) >= MAX_PRESERVED_FILES:
            left_out.append({**record, "status": "not_kept", "reason": "more than %d files; the rest stay in the zip's count only" % MAX_PRESERVED_FILES})
            continue
        if declared_entry is None:
            record["status"] = "undeclared"
        else:
            seen_declared.add(declared_entry["name"].casefold())
            record["declared"] = {key: value for key, value in declared_entry.items() if key in ("id", "label", "sizeBytes", "md5", "mimeType")}
            if declared_entry.get("md5"):
                record["md5Verified"] = declared_entry["md5"] == digest_md5
                record["status"] = "verified" if record["md5Verified"] else "md5_mismatch"
            else:
                record["md5Verified"] = None
                record["status"] = "unverified"
            if declared_entry.get("sizeBytes") is not None and declared_entry["sizeBytes"] != len(entry["payload"]):
                record["sizeMatchesDeclared"] = False
        if entry["crcOk"] is None:
            record["crcChecked"] = False
        stored = _safe_name(entry["name"], taken)
        record["preservedAs"] = stored
        preserved[stored] = entry["payload"]
        files.append(record)
    for entry in declared:
        if entry["name"].casefold() not in seen_declared:
            files.append({
                "name": entry["name"], "status": "not_received",
                "reason": ("the download ended before this file (%s)" % ended) if not complete else "the archive does not contain it",
                "declared": {key: value for key, value in entry.items() if key in ("id", "label", "sizeBytes", "md5", "mimeType")},
            })
    return preserved, files, left_out


def manifest_bytes(pmcid, pmc_version, declared, files, left_out, *, complete, ended):
    """`supplements.json`: deterministic (no timestamp), so the same supplements are the same capture."""
    return (json.dumps({
        "schemaVersion": 1, "pmcid": pmcid, "pmcVersion": pmc_version,
        "source": "europe-pmc supplementaryFiles", "archiveComplete": complete, "walkEnded": ended,
        "declared": declared, "files": files, "notKept": left_out,
    }, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode("utf-8")


# ----------------------------------------------------------------------------
# The retrieval
# ----------------------------------------------------------------------------
def retrieve(pmcid, *, deadline, max_bytes):
    """Europe PMC's supplementary zip for a PMCID inside `deadline`.

    Returns `(download, None)` for a zip (possibly partial: see `Download.complete`),
    or `(None, outcome_block)` for an answer in words: no supplementary files
    (`no_results`). Raises `SourceError` for a refusal (`denied`: not open access),
    a deadline spent before the first byte (`timeout`) or an unreachable source.
    """
    scope = "Europe PMC"
    result = transport.download("epmc-supplements", {"pmcid": pmcid}, deadline=deadline, scope=scope, max_bytes=max_bytes)
    if result.content_type == "application/zip":
        if result.received == 0:
            state = "timeout" if result.reason in ("deadline", "read_stalled") else "unavailable"
            raise source_outcome.SourceError(
                state,
                "Europe PMC sent no part of the supplementary-file archive (%s)." % (result.reason or "empty answer"),
                scope=scope, reason=result.reason or "empty_answer", retryable=True,
            )
        return result, None
    # An answer in words: Europe PMC writes its refusals and its "nothing here" as XML with status 200.
    text = result.body.decode("utf-8", "replace")
    message = re.search(r"<errMsg>(.*?)</errMsg>", text, re.S)
    if "errorBean" in text or message:
        reason = (message.group(1).strip() if message else "")[:200]
        if "not open access" in reason.casefold():
            raise source_outcome.denied("Europe PMC does not serve the supplementary files of %s: it is not an open-access article." % pmcid,
                scope=scope, reason="not_open_access", retryable=False,
            )
        raise source_outcome.unavailable("Europe PMC answered with an error instead of the supplementary files (%s)." % (reason or "no message"),
            scope=scope, reason="error_bean", retryable=False,
        )
    if "fullTextXMLBean" in text:
        return None, source_outcome.no_results(
            reason="no_supplementary_files",
            how="Europe PMC holds no supplementary files for %s; if the article lists some on the publisher's site, they are not in PMC." % pmcid,
        )
    raise source_outcome.unavailable("Europe PMC answered with XML that is neither a file archive nor a refusal.",
        scope=scope, reason="unexpected_answer", retryable=False,
    )


__all__ = ["declared_supplements", "read_zip", "reconcile", "manifest_bytes", "retrieve", "public_sources"]
