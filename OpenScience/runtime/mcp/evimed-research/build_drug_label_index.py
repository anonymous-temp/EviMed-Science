#!/usr/bin/env python3
"""Build the read-only EviMed drug-label index from exported label workbooks.

    python3 build_drug_label_index.py --source-root <dir of .xlsx exports> --output <file>.sqlite

The workbooks are read with the standard library alone (zipfile + iterparse):
each worksheet row is parsed, kept or refused, and released before the next is
read, and a workbook's shared strings are spilled to a scratch SQLite table
instead of being held in memory. The 543 MB of exports this was written for
build in a few minutes at about 120 MB of memory.

One label per approval number (批准文号). When the exports hold several
versions of one approval — packaging rows, brand variants, a change of holder,
the same label in both databases — the kept version is the one with the most of
the core sections, then the newer export, then the longer text; every trade
name, product name and holder seen for the approval stays searchable. Rows
whose approval is not a drug approval (health foods, devices, placeholders)
are counted and left out.

The output is written to a temporary file beside it and renamed into place
read-only, and an existing file is never overwritten. Its release id is the
hash of what it contains, so two builds of the same exports carry the same id.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import html
import json
import os
import posixpath
import re
import sqlite3
import stat
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree
from xml.etree.ElementTree import iterparse

import drug_label_index as index

BUILDER_VERSION = 1
MAX_WORKBOOK_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
MAX_ROWS_PER_WORKBOOK = 1_000_000
MAX_ROWS = 2_000_000
MAX_SHARED_STRINGS = 20_000_000
MAX_COLUMNS = 64
MAX_CELL_CHARS = 100_000
MAX_INDEX_BYTES = 3 * 1024 * 1024 * 1024
TRUNCATION_LENGTHS = (200, 500, 1000)

_SECTION = "section:"
# Every column of every export, mapped or deliberately ignored: an export whose
# columns differ is refused, because a silently dropped column is a silently
# dropped label section.
DATASETS = (
    {
        "id": "315jiage",
        "site": "https://www.315jiage.cn",
        "files": ("药品详细信息_总.xlsx",),
        "columns": {
            "产品名称": "product_name",
            "包装规格": _SECTION + "specification",
            "批准文号": "approval",
            "生产厂家": "manufacturer",
            "药品类型": "rx_class",
            "主分类": "category",
            "子分类": "therapeutic_area",
            "详情链接": "source_url",
            "商品名/商标": "trade_name",
            "成份": _SECTION + "composition",
            "性状": _SECTION + "description",
            "功能主治/适应症": _SECTION + "indications",
            "用法用量": _SECTION + "dosage",
            "不良反应": _SECTION + "adverse-reactions",
            "禁忌": _SECTION + "contraindications",
            "注意事项": _SECTION + "precautions",
            "儿童用药": _SECTION + "pediatric",
            "老年患者用药": _SECTION + "geriatric",
            "孕妇及哺乳期妇女用药": _SECTION + "pregnancy-lactation",
            "药理毒理": _SECTION + "pharmacology-toxicology",
            "药物相互作用": _SECTION + "interactions",
            "药代动力学": _SECTION + "pharmacokinetics",
            "药物过量": _SECTION + "overdose",
            "贮藏": _SECTION + "storage",
            "有效期": _SECTION + "shelf-life",
            "药品本位码": "national_code",
        },
        "ignored": ("药品图片", "价格", "条形码"),
        # This export writes line breaks as line breaks.
        "line_separator": None,
    },
    {
        "id": "yaozs",
        "site": "https://www.yaozs.com",
        "files": tuple("药品说明书数据库_医药数据查询(%d).xlsx" % number for number in range(1, 8)),
        "columns": {
            "标题": "title",
            "标题链接": "source_url",
            "通用名称": "generic_name",
            "商品名称": "trade_name",
            "汉语拼音": "pinyin",
            "批准文号": "approval",
            "药品分类": "category",
            "生产企业": "manufacturer",
            "药品性质": "rx_class",
            "相关疾病": "related_conditions",
            "性状": _SECTION + "description",
            "主要成份": _SECTION + "composition",
            "适应症": _SECTION + "indications",
            "规格": _SECTION + "specification",
            "不良反应": _SECTION + "adverse-reactions",
            "用法用量": _SECTION + "dosage",
            "禁忌": _SECTION + "contraindications",
            "注意事项": _SECTION + "precautions",
            "孕妇及哺乳期妇女用药": _SECTION + "pregnancy-lactation",
            "儿童用药": _SECTION + "pediatric",
            "老人用药": _SECTION + "geriatric",
            "药物相互作用": _SECTION + "interactions",
            "药理毒理": _SECTION + "pharmacology-toxicology",
            "药代动力学": _SECTION + "pharmacokinetics",
            "贮藏": _SECTION + "storage",
            "有效期": _SECTION + "shelf-life",
        },
        # 编号 is the site's record number (sometimes the approval again, or
        # 无此药); r3 is a truncated copy of the indications.
        "ignored": ("编号", "r3"),
        # This export wrote line breaks as `|`.
        "line_separator": "|",
    },
)
# The newer export wins a tie on completeness.
ORIGIN_RANK = {"315jiage": 0, "yaozs": 1}

_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_RELATIONSHIP = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PACKAGE = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_CORE_MODIFIED = "{http://purl.org/dc/terms/}modified"

_XML_ESCAPE = re.compile(r"_x([0-9A-Fa-f]{4})_")
_CONTROL = re.compile("[%s-%s%s-%s%s]" % (chr(0), chr(8), chr(11), chr(31), chr(127)))
_BREAK_TAG = re.compile(r"<br\s*/?>", re.I)
_PARAGRAPH_TAG = re.compile(r"</?p(?:\s[^<>]*)?>", re.I)
_PLACEHOLDER = re.compile(r"[\s\-_*/\\.。·•—－]*")
_SENTENCE_END = frozenset("。．.!！?？;；)）]】」』\"”'’…")
_REVISION = re.compile(r"(?:修订|修改|核准)日期[:：\s]*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?")
_SHAPE_DIGITS = re.compile(r"\d+")


class BuildError(ValueError):
    """The exports cannot be turned into an index this reader would trust."""


# ---------------------------------------------------------------------------
# Workbook streaming
# ---------------------------------------------------------------------------
def _column_index(reference: str) -> int:
    number = 0
    for character in reference:
        if "A" <= character <= "Z":
            number = number * 26 + (ord(character) - 64)
        else:
            break
    return number - 1


def _string_item(element) -> str:
    """The text of a shared-string or inline-string item; phonetic runs are
    pronunciation hints, not text."""
    parts = []
    for child in element:
        if child.tag == _MAIN + "t":
            parts.append(child.text or "")
        elif child.tag == _MAIN + "r":
            text = child.find(_MAIN + "t")
            if text is not None:
                parts.append(text.text or "")
    return "".join(parts)


def _number_text(value: str) -> str:
    # Long codes stored as numbers come back as 8.6904735001458E+13.
    try:
        number = Decimal(value)
    except InvalidOperation:
        return value
    if number == number.to_integral_value():
        return str(number.quantize(Decimal(1)))
    return value


def _checked_member(archive: zipfile.ZipFile, name: str) -> zipfile.ZipInfo:
    try:
        info = archive.getinfo(name)
    except KeyError as error:
        raise BuildError("workbook part %s is missing" % name) from error
    if info.file_size > MAX_MEMBER_BYTES:
        raise BuildError("workbook part %s is larger than %d bytes" % (name, MAX_MEMBER_BYTES))
    if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
        raise BuildError("workbook part %s decompresses implausibly far" % name)
    return info


def _first_sheet(archive: zipfile.ZipFile) -> str:
    workbook = ElementTree.fromstring(archive.read(_checked_member(archive, "xl/workbook.xml")))
    sheets = workbook.find(_MAIN + "sheets")
    sheet = sheets.find(_MAIN + "sheet") if sheets is not None else None
    if sheet is None:
        raise BuildError("the workbook has no worksheet")
    relationship_id = sheet.get(_RELATIONSHIP + "id")
    relationships = ElementTree.fromstring(archive.read(_checked_member(archive, "xl/_rels/workbook.xml.rels")))
    for relationship in relationships.findall(_PACKAGE + "Relationship"):
        if relationship.get("Id") == relationship_id:
            target = relationship.get("Target") or ""
            member = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            _checked_member(archive, member)
            return member
    raise BuildError("the workbook's first worksheet cannot be located")


def _exported_at(archive: zipfile.ZipFile) -> str | None:
    """When the export was last saved, from its own document properties."""
    try:
        core = ElementTree.fromstring(archive.read(_checked_member(archive, "docProps/core.xml")))
    except (BuildError, ElementTree.ParseError):
        return None
    modified = core.find(_CORE_MODIFIED)
    return modified.text.strip() if modified is not None and modified.text else None


def _spill_shared_strings(archive: zipfile.ZipFile, scratch: sqlite3.Connection) -> int:
    scratch.execute("DROP TABLE IF EXISTS shared_strings")
    scratch.execute("CREATE TABLE shared_strings(i INTEGER PRIMARY KEY, t TEXT NOT NULL)")
    if "xl/sharedStrings.xml" not in archive.namelist():
        return 0
    _checked_member(archive, "xl/sharedStrings.xml")
    count = 0
    batch = []
    with archive.open("xl/sharedStrings.xml") as stream:
        root = None
        for event, element in iterparse(stream, events=("start", "end")):
            if event == "start":
                if root is None:
                    root = element
                continue
            if element.tag != _MAIN + "si":
                continue
            batch.append((count, _string_item(element)))
            count += 1
            root.clear()
            if count > MAX_SHARED_STRINGS:
                raise BuildError("the workbook has more than %d shared strings" % MAX_SHARED_STRINGS)
            if len(batch) >= 20_000:
                scratch.executemany("INSERT INTO shared_strings VALUES (?, ?)", batch)
                batch.clear()
    scratch.executemany("INSERT INTO shared_strings VALUES (?, ?)", batch)
    return count


def iter_rows(archive: zipfile.ZipFile, scratch: sqlite3.Connection):
    """(row number, hidden, {column index: text}) for each worksheet row, in
    order, one row in memory at a time."""
    member = _first_sheet(archive)
    with archive.open(member) as stream:
        sheet_data = None
        for event, element in iterparse(stream, events=("start", "end")):
            if event == "start":
                if element.tag == _MAIN + "sheetData":
                    sheet_data = element
                continue
            if element.tag != _MAIN + "row":
                continue
            cells, shared = {}, {}
            position = -1
            for cell in element:
                if cell.tag != _MAIN + "c":
                    continue
                reference = cell.get("r")
                position = _column_index(reference) if reference else position + 1
                if position < 0 or position >= MAX_COLUMNS:
                    continue
                kind = cell.get("t")
                if kind == "s":
                    value = cell.find(_MAIN + "v")
                    try:
                        shared[position] = int(value.text) if value is not None and value.text else None
                    except ValueError:
                        shared[position] = None
                elif kind == "inlineStr":
                    item = cell.find(_MAIN + "is")
                    cells[position] = _string_item(item) if item is not None else ""
                elif kind in (None, "n", "str"):
                    value = cell.find(_MAIN + "v")
                    text = value.text if value is not None and value.text is not None else ""
                    cells[position] = _number_text(text) if kind != "str" and text else text
            wanted = sorted({value for value in shared.values() if value is not None})
            if wanted:
                found = dict(scratch.execute(
                    "SELECT i, t FROM shared_strings WHERE i IN (%s)" % ",".join("?" * len(wanted)), wanted
                ))
                for column, value in shared.items():
                    cells[column] = found.get(value, "")
            number = element.get("r")
            hidden = element.get("hidden") in ("1", "true")
            yield (int(number) if number and number.isdigit() else None), hidden, cells
            if sheet_data is not None:
                sheet_data.clear()


# ---------------------------------------------------------------------------
# Rows to label candidates
# ---------------------------------------------------------------------------
def clean(text: str, line_separator: str | None = None) -> str:
    """A cell's text as a reader should see it: spreadsheet escapes decoded,
    leftover HTML entities and line-break tags turned back into characters,
    one kind of line break, placeholders ("-", "----") emptied."""
    text = _XML_ESCAPE.sub(lambda match: chr(int(match.group(1), 16)), text)
    if "&" in text:
        text = html.unescape(text)
    if "<" in text:
        text = _PARAGRAPH_TAG.sub("\n", _BREAK_TAG.sub("\n", text))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if line_separator:
        text = text.replace(line_separator, "\n")
    text = _CONTROL.sub("", text)
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
    return "" if _PLACEHOLDER.fullmatch(text) else text


def possibly_truncated(text: str) -> bool:
    """Cut at a round length mid-sentence: both exports capped some fields at
    200, 500 or 1000 characters. A flag for the reader, not a correction."""
    return len(text) in TRUNCATION_LENGTHS and text[-1] not in _SENTENCE_END


def revision_date(sections: dict) -> str | None:
    """A revision date the label's own text states (修订/修改/核准日期), if any."""
    for text in sections.values():
        match = _REVISION.search(text)
        if match:
            year, month, day = match.group(1), int(match.group(2)), match.group(3)
            if 1 <= month <= 12 and (day is None or 1 <= int(day) <= 31):
                return "%s-%02d" % (year, month) + ("-%02d" % int(day) if day else "")
    return None


def _generic_name(fields: dict) -> str:
    if fields.get("generic_name"):
        return fields["generic_name"]
    product, trade = fields.get("product_name", ""), fields.get("trade_name", "")
    # 315jiage writes the brand after the name: 去氧孕烯炔雌醇片(先安诺).
    if trade:
        for opening, closing in (("(", ")"), ("（", "）")):
            suffix = opening + trade + closing
            if product.endswith(suffix) and len(product) > len(suffix):
                return product[: -len(suffix)].strip()
    return product or fields.get("title", "")


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def label_candidate(dataset: dict, headers: dict, cells: dict) -> tuple[dict | None, str | None]:
    """A row as a label candidate, or (None, why it was left out)."""
    fields, sections = {}, {}
    for column, header in headers.items():
        target = dataset["columns"].get(header)
        if target is None:
            continue
        raw = cells.get(column, "")
        if len(raw) > MAX_CELL_CHARS:
            raise BuildError("a %s cell is longer than %d characters" % (header, MAX_CELL_CHARS))
        text = clean(raw, dataset["line_separator"] if target.startswith(_SECTION) else None)
        if not text:
            continue
        if target.startswith(_SECTION):
            sections[target[len(_SECTION):]] = text
        else:
            fields[target] = text
    if not fields and not sections:
        return None, "blank"
    approval = index.canonical_approval(fields.get("approval"))
    if approval is None:
        shape = _SHAPE_DIGITS.sub(lambda match: "9{%d}" % len(match.group(0)), fields.get("approval", "")[:40]) or "(none)"
        return None, "not a drug approval: %s" % shape
    if not sections:
        return None, "no label text"
    grouped = {key: value for key, value in sections.items() if key != "specification"}
    candidate = {
        "approval": approval,
        "genericName": _generic_name(fields),
        "tradeName": fields.get("trade_name", ""),
        "productName": fields.get("product_name") or fields.get("title", ""),
        "manufacturer": fields.get("manufacturer", ""),
        "category": fields.get("category", ""),
        "therapeuticArea": fields.get("therapeutic_area", ""),
        "rxClass": fields.get("rx_class", ""),
        "nationalCode": fields.get("national_code", ""),
        "pinyin": fields.get("pinyin", ""),
        "relatedConditions": fields.get("related_conditions", ""),
        "sourceUrl": fields.get("source_url", "") if fields.get("source_url", "").startswith("https://") else "",
        "sections": sections,
        "revisedAt": revision_date(sections),
        "groupVersion": _digest(grouped),
        "completeness": sum(1 for key in index.CORE_SECTIONS if key in sections),
        "totalChars": sum(len(value) for value in sections.values()),
    }
    return candidate, None


# ---------------------------------------------------------------------------
# The build
# ---------------------------------------------------------------------------
_OUTPUT_DDL = """
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources(
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  exported_at TEXT,
  rows_read INTEGER NOT NULL,
  rows_kept INTEGER NOT NULL
);
CREATE TABLE labels(
  id INTEGER PRIMARY KEY,
  approval TEXT NOT NULL UNIQUE,
  generic_name TEXT NOT NULL,
  trade_name TEXT,
  product_name TEXT,
  manufacturer TEXT,
  category TEXT,
  rx_class TEXT,
  national_code TEXT,
  origin TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_row INTEGER,
  source_url TEXT,
  version TEXT NOT NULL,
  revised_at TEXT,
  alternates INTEGER NOT NULL CHECK(alternates >= 0),
  aliases_json TEXT NOT NULL
);
CREATE TABLE texts(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE sections(
  label INTEGER NOT NULL REFERENCES labels(id),
  section TEXT NOT NULL,
  text INTEGER NOT NULL REFERENCES texts(id),
  chars INTEGER NOT NULL CHECK(chars > 0),
  flags TEXT,
  PRIMARY KEY(label, section)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE labels_fts USING fts5(names, body, content='', tokenize='unicode61 remove_diacritics 2');
"""

_SCRATCH_DDL = """
CREATE TABLE candidates(
  approval TEXT NOT NULL,
  completeness INTEGER NOT NULL,
  origin_rank INTEGER NOT NULL,
  total_chars INTEGER NOT NULL,
  group_version TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_row INTEGER,
  origin TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE TABLE aliases(approval TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(approval, kind, value)) WITHOUT ROWID;
CREATE TABLE text_ids(digest BLOB PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID;
"""

_ALIAS_KINDS = (("tradeName", "tradeNames"), ("productName", "productNames"), ("manufacturer", "manufacturers"), ("genericName", "genericNames"))
# Collected from every row of an approval like the names, but only searched:
# a romanisation is a way in, not something a reader needs listed.
_SEARCH_ONLY_KINDS = ("pinyin",)


def _source_file(root: Path, file_name: str) -> Path:
    path = root / file_name
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as error:
        raise BuildError("expected export %s is missing from %s" % (file_name, root)) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise BuildError("export is not a regular file: %s" % file_name)
    if metadata.st_size <= 0 or metadata.st_size > MAX_WORKBOOK_BYTES:
        raise BuildError("export size is out of bounds: %s" % file_name)
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _headers(dataset: dict, cells: dict, file_name: str) -> dict:
    headers = {column: str(text or "").strip() for column, text in cells.items() if str(text or "").strip()}
    names = set(headers.values())
    known = set(dataset["columns"]) | set(dataset["ignored"])
    unexpected = sorted(names - known)
    missing = sorted(set(dataset["columns"]) - names)
    if unexpected or missing:
        raise BuildError(
            "%s has a different layout than the %s export this builder maps (unexpected: %s; missing: %s)"
            % (file_name, dataset["id"], ", ".join(unexpected) or "none", ", ".join(missing) or "none")
        )
    return headers


def _stage(source_root: Path, scratch: sqlite3.Connection, datasets, report: dict) -> list[dict]:
    manifest = []
    total_rows = 0
    excluded = collections.Counter()
    for dataset in datasets:
        for file_name in dataset["files"]:
            path = _source_file(source_root, file_name)
            source_id = "%s:%s" % (dataset["id"], file_name)
            rows_read = rows_kept = rows_hidden = 0
            with zipfile.ZipFile(path) as archive:
                exported_at = _exported_at(archive)
                _spill_shared_strings(archive, scratch)
                headers = None
                candidates, aliases = [], []
                for row_number, hidden, cells in iter_rows(archive, scratch):
                    if headers is None:
                        headers = _headers(dataset, cells, file_name)
                        continue
                    rows_read += 1
                    total_rows += 1
                    if rows_read > MAX_ROWS_PER_WORKBOOK or total_rows > MAX_ROWS:
                        raise BuildError("the exports hold more rows than this builder is bounded to")
                    rows_hidden += hidden
                    candidate, reason = label_candidate(dataset, headers, cells)
                    if candidate is None:
                        excluded[reason] += 1
                        continue
                    rows_kept += 1
                    candidates.append((
                        candidate["approval"], candidate["completeness"], ORIGIN_RANK.get(dataset["id"], len(ORIGIN_RANK)),
                        candidate["totalChars"], candidate["groupVersion"], source_id, row_number, dataset["id"],
                        json.dumps(candidate, ensure_ascii=False, separators=(",", ":")),
                    ))
                    for field in (*(field for field, _kind in _ALIAS_KINDS), *_SEARCH_ONLY_KINDS):
                        if candidate[field]:
                            aliases.append((candidate["approval"], field, candidate[field]))
                    if len(candidates) >= 5_000:
                        scratch.executemany("INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", candidates)
                        scratch.executemany("INSERT OR IGNORE INTO aliases VALUES (?, ?, ?)", aliases)
                        candidates.clear()
                        aliases.clear()
                if headers is None:
                    raise BuildError("%s has no header row" % file_name)
                scratch.executemany("INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", candidates)
                scratch.executemany("INSERT OR IGNORE INTO aliases VALUES (?, ?, ?)", aliases)
                scratch.execute("DROP TABLE IF EXISTS shared_strings")
                scratch.commit()
            manifest.append({
                "id": source_id, "origin": dataset["id"], "file": file_name, "sha256": _sha256_file(path),
                "bytes": path.stat().st_size, "exportedAt": exported_at, "rowsRead": rows_read,
                "rowsKept": rows_kept, "rowsHidden": rows_hidden,
            })
    report["rows"] = {
        "read": total_rows,
        "kept": sum(item["rowsKept"] for item in manifest),
        "hiddenInSource": sum(item["rowsHidden"] for item in manifest),
        "excluded": sum(excluded.values()),
        "excludedReasons": dict(excluded.most_common(12)),
    }
    return manifest


def _snapshots(datasets, manifest: list[dict], source_root: Path) -> dict:
    """What each origin's text is a snapshot of, in words a reader can use."""
    snapshots = {}
    for dataset in datasets:
        entries = [item for item in manifest if item["origin"] == dataset["id"]]
        exported = sorted(item["exportedAt"][:10] for item in entries if item.get("exportedAt"))
        if exported:
            when = "exported %s" % exported[-1]
        else:
            dates = sorted(
                datetime.fromtimestamp((source_root / item["file"]).stat().st_mtime, timezone.utc).date().isoformat()
                for item in entries
            )
            when = "file dated %s" % dates[-1] if dates else "undated"
        snapshots[dataset["id"]] = "%s, %s" % (dataset["site"].replace("https://", ""), when)
    return snapshots


def _publish_labels(scratch: sqlite3.Connection, output: sqlite3.Connection, report: dict) -> str:
    """Write the kept version of every approval, returning the content hash."""
    scratch.execute(
        "CREATE INDEX candidates_rank ON candidates(approval, completeness DESC, origin_rank, total_chars DESC, group_version)"
    )
    scratch.execute(
        """
        CREATE TABLE kept AS
        SELECT candidate, approval FROM (
          SELECT rowid AS candidate, approval,
                 ROW_NUMBER() OVER (
                   PARTITION BY approval
                   ORDER BY completeness DESC, origin_rank, total_chars DESC, group_version, rowid
                 ) AS position
          FROM candidates
        ) WHERE position = 1
        """
    )
    scratch.execute(
        "CREATE TABLE versions AS SELECT approval, COUNT(DISTINCT group_version) - 1 AS alternates FROM candidates GROUP BY approval"
    )
    scratch.execute("CREATE UNIQUE INDEX versions_approval ON versions(approval)")
    content = hashlib.sha256()
    labels = sections = distinct_texts = truncated = revised = 0
    section_counts = collections.Counter()
    cursor = scratch.execute(
        """
        SELECT c.approval, c.source_id, c.source_row, c.origin, c.record_json, v.alternates
        FROM kept k JOIN candidates c ON c.rowid = k.candidate JOIN versions v ON v.approval = k.approval
        ORDER BY k.approval
        """
    )
    for approval, source_id, source_row, origin, record_json, alternates in cursor:
        record = json.loads(record_json)
        aliases = collections.defaultdict(list)
        for field, kind in _ALIAS_KINDS:
            for (value,) in scratch.execute(
                "SELECT value FROM aliases WHERE approval = ? AND kind = ? ORDER BY value", (approval, field)
            ):
                if value != record[field] and len(aliases[kind]) < 20:
                    aliases[kind].append(value)
        served = {key: record["sections"][key] for key in sorted(record["sections"], key=lambda key: index.SECTION_ORDER.get(key, 99))}
        version = _digest(served)
        labels += 1
        revised += bool(record["revisedAt"])
        output.execute(
            """
            INSERT INTO labels(id, approval, generic_name, trade_name, product_name, manufacturer, category, rx_class,
                               national_code, origin, source_id, source_row, source_url, version, revised_at,
                               alternates, aliases_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                labels, approval, record["genericName"] or approval, record["tradeName"] or None, record["productName"] or None,
                record["manufacturer"] or None, record["category"] or None, record["rxClass"] or None,
                record["nationalCode"] or None, origin, source_id, source_row, record["sourceUrl"] or None, version,
                record["revisedAt"], alternates, json.dumps(dict(aliases), ensure_ascii=False, sort_keys=True),
            ),
        )
        for section, body in served.items():
            digest = hashlib.sha256(body.encode("utf-8")).digest()[:16]
            found = scratch.execute("SELECT id FROM text_ids WHERE digest = ?", (digest,)).fetchone()
            if found is None:
                distinct_texts += 1
                output.execute("INSERT INTO texts(id, body) VALUES (?, ?)", (distinct_texts, body))
                scratch.execute("INSERT INTO text_ids VALUES (?, ?)", (digest, distinct_texts))
                text_id = distinct_texts
            else:
                text_id = found[0]
            flag = "possibly-truncated" if possibly_truncated(body) else None
            truncated += flag is not None
            output.execute(
                "INSERT INTO sections(label, section, text, chars, flags) VALUES (?, ?, ?, ?, ?)",
                (labels, section, text_id, len(body), flag),
            )
            sections += 1
            section_counts[section] += 1
        every = lambda field, kind: [record[field], *aliases.get(kind, [])]  # noqa: E731
        romanised = [value for (value,) in scratch.execute(
            "SELECT value FROM aliases WHERE approval = ? AND kind = 'pinyin' ORDER BY value LIMIT 20", (approval,)
        )]
        names = index.search_text([
            approval, re.sub("^国药准字", "", approval), *every("genericName", "genericNames"),
            *every("tradeName", "tradeNames"), *every("productName", "productNames"),
            *every("manufacturer", "manufacturers"), *romanised, record["nationalCode"],
        ])
        body = index.search_text([
            record["sections"].get("composition", ""), record["category"], record["therapeuticArea"],
            record["rxClass"], record["relatedConditions"],
        ])
        output.execute("INSERT INTO labels_fts(rowid, names, body) VALUES (?, ?, ?)", (labels, names, body))
        content.update((json.dumps(
            [approval, version, record["genericName"], record["tradeName"], record["productName"], record["manufacturer"],
             record["category"], record["rxClass"], record["nationalCode"], origin, record["sourceUrl"],
             record["revisedAt"], alternates, dict(aliases), romanised],
            ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ) + "\n").encode("utf-8"))
        if labels % 20_000 == 0:
            output.commit()
    if labels == 0:
        raise BuildError("the exports contain no drug label this builder can keep")
    report["labels"] = labels
    report["sections"] = sections
    report["distinctSectionTexts"] = distinct_texts
    report["sectionsPossiblyTruncated"] = truncated
    report["labelsWithRevisionDate"] = revised
    report["sectionCoverage"] = {section: section_counts.get(section, 0) for section, _title in index.SECTIONS}
    report["labelsByOrigin"] = dict(output.execute("SELECT origin, COUNT(*) FROM labels GROUP BY origin").fetchall())
    report["labelsWithAlternates"] = output.execute("SELECT COUNT(*) FROM labels WHERE alternates > 0").fetchone()[0]
    return content.hexdigest()


def build(source_root: Path, output: Path, datasets=DATASETS, scratch_dir: Path | None = None) -> dict:
    started = time.monotonic()
    if source_root.is_symlink() or not source_root.is_dir():
        raise BuildError("source root must be a directory, not a symlink")
    source_root = source_root.resolve(strict=True)
    if output.exists() or output.is_symlink():
        raise FileExistsError("refusing to overwrite an existing index: %s" % output)
    output.parent.mkdir(parents=True, exist_ok=True)
    scratch_parent = scratch_dir or output.parent
    descriptor, temporary_name = tempfile.mkstemp(prefix=".drug-label-index-", suffix=".sqlite", dir=output.parent)
    os.close(descriptor)
    descriptor, scratch_name = tempfile.mkstemp(prefix=".drug-label-scratch-", suffix=".sqlite", dir=scratch_parent)
    os.close(descriptor)
    temporary, scratch_path = Path(temporary_name), Path(scratch_name)
    report: dict = {}
    database = scratch = None
    try:
        scratch = sqlite3.connect(scratch_path)
        scratch.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -32768;" + _SCRATCH_DDL)
        manifest = _stage(source_root, scratch, datasets, report)
        database = sqlite3.connect(temporary)
        database.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -32768;" + _OUTPUT_DDL)
        content_sha256 = _publish_labels(scratch, database, report)
        database.executemany(
            "INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(item["id"], item["origin"], item["file"], item["sha256"], item["bytes"], item.get("exportedAt"),
              item["rowsRead"], item["rowsKept"]) for item in manifest],
        )
        release = "drug-labels-%s" % content_sha256[:12]
        snapshots = _snapshots(datasets, manifest, source_root)
        manifest_sha256 = _digest([[item["file"], item["sha256"], item["bytes"]] for item in manifest])
        metadata = {
            "schema": index.SCHEMA,
            "release": release,
            "content_sha256": content_sha256,
            "source_manifest_sha256": manifest_sha256,
            "builder_version": str(BUILDER_VERSION),
            "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "label_count": str(report["labels"]),
            "section_count": str(report["sections"]),
            "text_count": str(report["distinctSectionTexts"]),
            "jurisdiction": index.JURISDICTION,
            "snapshots_json": json.dumps(snapshots, ensure_ascii=False, sort_keys=True),
            "scope": "snapshot-of-public-label-databases-not-the-current-official-label",
        }
        database.executemany("INSERT INTO metadata VALUES (?, ?)", sorted(metadata.items()))
        database.commit()
        database.execute("INSERT INTO labels_fts(labels_fts) VALUES ('optimize')")
        database.commit()
        if database.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise BuildError("the built index failed SQLite's integrity check")
        database.execute("INSERT INTO labels_fts(labels_fts) VALUES ('integrity-check')")
        database.commit()
        database.execute("PRAGMA journal_mode = DELETE")
        database.execute("VACUUM")
        database.close()
        database = None
        size = temporary.stat().st_size
        if size > MAX_INDEX_BYTES:
            raise BuildError("the built index is %d bytes, over the %d-byte bound" % (size, MAX_INDEX_BYTES))
        os.replace(temporary, output)
        if os.name != "nt":
            output.chmod(0o444)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        for connection in (database, scratch):
            if connection is not None:
                connection.close()
        scratch_path.unlink(missing_ok=True)
    report.update({
        "release": release,
        "path": str(output),
        "bytes": output.stat().st_size,
        "seconds": round(time.monotonic() - started, 1),
        "sources": manifest,
        "snapshots": snapshots,
    })
    try:
        import resource

        report["peakMemoryMB"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except (ImportError, AttributeError):
        pass
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--source-root", required=True, type=Path, help="directory holding the label .xlsx exports")
    parser.add_argument("--output", required=True, type=Path, help="index file to create (never overwritten)")
    parser.add_argument("--scratch-dir", type=Path, help="where the scratch database goes (default: beside the output)")
    arguments = parser.parse_args()
    print(json.dumps(build(arguments.source_root, arguments.output, scratch_dir=arguments.scratch_dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
