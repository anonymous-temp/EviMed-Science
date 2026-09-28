#!/usr/bin/env python3
"""Minimal multi-sheet XLSX writer: header row first, wrapped text, sane column widths."""
from __future__ import annotations
import re
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _clean(value) -> str:
    if value is None:
        return ""
    text = _ILLEGAL.sub("", str(value))
    return text


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _col(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _width(sheet: dict) -> dict:
    widths = {}
    for row in sheet["rows"][:200]:
        for idx, cell in enumerate(row):
            text = _clean(cell)
            if not text:
                continue
            longest = max(len(line) + sum(1 for ch in line if ord(ch) > 0x2E80) for line in text.split("\n"))
            widths[idx] = min(max(widths.get(idx, 8), min(longest + 2, sheet.get("maxWidth", 46))), 60)
    return widths


def _cell_xml(ref: str, value, style: int) -> str:
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if _is_num(value):
        return f'<c r="{ref}" s="{style}"><v>{value}</v></c>'
    text = escape(_clean(value))
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def _sheet_xml(sheet: dict) -> str:
    widths = _width(sheet)
    cols = "".join(
        f'<col min="{i+1}" max="{i+1}" width="{widths.get(i, 12)}" customWidth="1"/>'
        for i in range(max(len(widths), 1))
    )
    rows = []
    for r, row in enumerate(sheet["rows"], start=1):
        style = 1 if r == 1 else 2
        cells = "".join(_cell_xml(f"{_col(c)}{r}", value, style) for c, value in enumerate(row))
        size = ' ht="30" customHeight="1"' if r == 1 else ""
        rows.append(f'<row r="{r}" spans="1:{max(len(row), 1)}"{size}>{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>'
        f'<sheetViews><sheetView workbookViewId="0" tabSelected="{1 if sheet.get("first") else 0}">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '</sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f'<cols>{cols}</cols><sheetData>{"".join(rows)}</sheetData>'
        '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
        '</worksheet>'
    )


def write_xlsx(path: str, sheets: list[dict]) -> None:
    """sheets: [{'name': str, 'rows': [[cell,...],...], 'maxWidth': int}]"""
    index = []
    rendered = []
    for i, sheet in enumerate(sheets):
        name = _clean(sheet["name"])[:31]
        index.append((i + 1, name))
        prepared = dict(sheet)
        prepared["first"] = i == 0
        rendered.append(_sheet_xml(prepared))

    overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i, _ in index
    )
    contents = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        f'{overrides}</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                + "".join(f'<sheet name="{escape(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, n in index)
                + '</sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i, _ in index)
               + f'<Relationship Id="rId{len(index)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
               + '</Relationships>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="2"><font><sz val="11"/><name val="微软雅黑"/></font>'
              '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="3">'
              '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
              '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
              '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')

    def member(name: str, text: str) -> None:
        info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, text.encode("utf-8"))

    with ZipFile(path, "w") as archive:
        member("[Content_Types].xml", contents)
        member("_rels/.rels", rels)
        member("xl/workbook.xml", workbook)
        member("xl/_rels/workbook.xml.rels", wb_rels)
        member("xl/styles.xml", styles)
        for i, _ in index:
            member(f"xl/worksheets/sheet{i}.xml", rendered[i - 1])
