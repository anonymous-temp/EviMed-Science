#!/usr/bin/env python3
"""Structural check of a DOCX, PPTX or XLSX, standard library only.

Until DSH 0.2.1 the kernel's own `@deepseek-ai/dsh-skill-office` shipped `assets/scripts/check_office.py`, and
`office_kit.py check` ran it. 0.2.1 split that package into instruction-only skills (`office-docx`, `office-xlsx`, …)
whose check is "reopen the file and verify the content", and the script is gone, so the `check` step our skills
name failed with "the checker is not installed". This is that check, kept beside the kit wrapper: it reads the file
without changing it, parses every XML part, follows each internal relationship to a part that exists, reports
paragraphs / slides / sheets, and optionally asserts required text or a slide count. A pass says the file is sound and
holds the text, not that it looks right or that its formulas are calculated.

    python3 office_check.py contract.docx --contains "Payment is due within 30 days"
    python3 office_check.py deck.pptx --count 11
"""
from __future__ import annotations

import argparse
import json
import posixpath
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _parts(package: zipfile.ZipFile, failures: list[str]) -> dict[str, ElementTree.Element]:
    parsed: dict[str, ElementTree.Element] = {}
    for name in package.namelist():
        if name.endswith((".xml", ".rels")):
            try:
                parsed[name] = ElementTree.fromstring(package.read(name))
            except ElementTree.ParseError as error:
                failures.append(f"{name} is not well-formed XML: {error}")
    if "[Content_Types].xml" not in parsed:
        failures.append("[Content_Types].xml is missing")
    names = set(package.namelist())
    for name, root in parsed.items():
        if not name.endswith(".rels"):
            continue
        base = posixpath.dirname(posixpath.dirname(name))
        for relationship in root.iter(f"{PR}Relationship"):
            if relationship.get("TargetMode") == "External":
                continue
            target = relationship.get("Target") or ""
            resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            if resolved not in names:
                failures.append(f"{name} points at {target}, which is not in the package")
    return parsed


def _docx(parts: dict[str, ElementTree.Element]) -> tuple[dict, str]:
    body = parts.get("word/document.xml")
    paragraphs = [] if body is None else ["".join(text.text or "" for text in paragraph.iter(f"{W}t")) for paragraph in body.iter(f"{W}p")]
    return {"paragraphs": len(paragraphs)}, "\n".join(paragraphs)


def _pptx(parts: dict[str, ElementTree.Element]) -> tuple[dict, str]:
    presentation = parts.get("ppt/presentation.xml")
    slides = [] if presentation is None else list(presentation.iter(f"{P}sldId"))
    texts = []
    for name in sorted(parts, key=lambda item: (len(item), item)):
        if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
            texts.append("\n".join("".join(text.text or "" for text in paragraph.iter(f"{A}t")) for paragraph in parts[name].iter(f"{A}p")))
    return {"slides": len(slides)}, "\n".join(texts)


def _xlsx(parts: dict[str, ElementTree.Element]) -> tuple[dict, str]:
    book = parts.get("xl/workbook.xml")
    sheets = [] if book is None else [{"name": sheet.get("name") or ""} for sheet in book.iter(f"{S}sheet")]
    strings = parts.get("xl/sharedStrings.xml")
    texts = [] if strings is None else ["".join(text.text or "" for text in item.iter(f"{S}t")) for item in strings.iter(f"{S}si")]
    for name, root in parts.items():
        if name.startswith("xl/worksheets/") and name.endswith(".xml"):
            texts += ["".join(text.text or "" for text in cell.iter(f"{S}t")) for cell in root.iter(f"{S}is")]
    return {"sheets": sheets}, "\n".join(texts)


def check(path: str | Path, contains: list[str] | None = None, count: int | None = None) -> tuple[dict, int]:
    """The report and the exit status (0 = every check passed)."""
    path = Path(path)
    failures: list[str] = []
    kind = path.suffix.lower().lstrip(".")
    summary: dict = {}
    text = ""
    try:
        with zipfile.ZipFile(path) as package:
            parts = _parts(package, failures)
    except (OSError, zipfile.BadZipFile) as error:
        failures.append(f"{path.name} is not an Office package: {error}")
        parts = {}
    if parts:
        reader = {"docx": _docx, "pptx": _pptx, "xlsx": _xlsx}.get(kind)
        if reader is None:
            failures.append(f"{path.name}: only .docx, .pptx and .xlsx are checked")
        else:
            summary, text = reader(parts)
    flat = " ".join(text.split())
    missing = [needle for needle in contains or [] if " ".join(needle.split()) not in flat]
    failures += [f"the text {needle!r} is not in the file" for needle in missing]
    if count is not None and kind == "pptx" and summary.get("slides") != count:
        failures.append(f"{summary.get('slides')} slides, not {count}")
    report = {"file": path.name, "format": kind, "verdict": "fail" if failures else "pass", "summary": summary, "failures": failures}
    return report, 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file")
    parser.add_argument("--contains", action="append", default=[])
    parser.add_argument("--count", type=int)
    args = parser.parse_args()
    report, status = check(args.file, args.contains, args.count)
    print(json.dumps(report, ensure_ascii=False))
    return status


if __name__ == "__main__":
    sys.exit(main())
