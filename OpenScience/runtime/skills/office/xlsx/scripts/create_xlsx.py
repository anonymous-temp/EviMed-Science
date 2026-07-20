#!/usr/bin/env python3
"""Create a minimal XLSX workbook from CSV using the standard library."""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def write_member(archive: ZipFile, name: str, text: str) -> None:
    info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.compress_type = ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, text.encode("utf-8"))


def column_name(index: int) -> str:
    value = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        value = chr(65 + remainder) + value
    return value


def cell_xml(reference: str, value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"true", "false"}:
        return f'<c r="{reference}" t="b"><v>{1 if normalized == "true" else 0}</v></c>'
    try:
        number = float(value)
        if value.strip() and math.isfinite(number):
            return f'<c r="{reference}"><v>{escape(value.strip())}</v></c>'
    except ValueError:
        pass
    return f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{escape(value)}</t></is></c>'


def create_xlsx(rows: list[list[str]], output: Path, sheet: str) -> None:
    xml_rows = []
    for row_index, row in enumerate(rows, 1):
        cells = "".join(cell_xml(f"{column_name(column_index)}{row_index}", value) for column_index, value in enumerate(row, 1))
        xml_rows.append(f'<row r="{row_index}">{cells}</row>')
    worksheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(xml_rows)}</sheetData></worksheet>")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w") as archive:
        write_member(archive, "[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>')
        write_member(archive, "_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
        write_member(archive, "xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name={quoteattr(sheet)} sheetId="1" r:id="rId1"/></sheets></workbook>')
        write_member(archive, "xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '</Relationships>')
        write_member(archive, "xl/worksheets/sheet1.xml", worksheet)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sheet", default="Sheet1")
    args = parser.parse_args()
    if args.output.suffix.lower() != ".xlsx":
        parser.error("--output must end in .xlsx")
    if not args.sheet or len(args.sheet) > 31 or any(char in args.sheet for char in "[]:*?/\\"):
        parser.error("--sheet is not a valid worksheet name")
    with args.input.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))
    create_xlsx(rows, args.output, args.sheet)


if __name__ == "__main__":
    main()
