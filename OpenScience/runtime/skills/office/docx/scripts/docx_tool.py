#!/usr/bin/env python3
"""Read a Word document, change one passage of it in place, and prove nothing else moved.

    docx_tool.py outline contract.docx
    docx_tool.py find contract.docx "30 days"
    docx_tool.py replace contract.docx --find "30 days" --with "45 days" --paragraph 12 --out contract-v2.docx
    docx_tool.py diff contract.docx contract-v2.docx

`replace` edits the package at the XML level: only the parts that hold a match are rewritten
(every other part is copied member for member), and inside a paragraph only the text of the
runs the match covers changes, so styles, numbering, headers, footers, comments, images and
the formatting of the neighbouring text stay as they were. With `--track-changes` the edit is
written as a real revision (a deletion and an insertion by `--author`) that Word shows in Review.
Paragraph numbers are the ones `outline` prints (every paragraph of the body in document order,
table cells included, counted from 1).
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import difflib
import json
import os
import sys
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML = "http://www.w3.org/XML/1998/namespace"
NS = {"w": W}
BODY = "word/document.xml"
EDITABLE = ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml")
EDITABLE_PREFIX = ("word/header", "word/footer")


def q(tag: str) -> str:
    return f"{{{W}}}{tag}"


def is_editable(name: str) -> bool:
    return name in EDITABLE or (name.startswith(EDITABLE_PREFIX) and name.endswith(".xml"))


def read_package(path: Path) -> dict[str, tuple[zipfile.ZipInfo, bytes]]:
    with zipfile.ZipFile(path) as archive:
        return {info.filename: (info, archive.read(info.filename)) for info in archive.infolist()}


def write_package(parts: dict[str, tuple[zipfile.ZipInfo, bytes]], replacements: dict[str, bytes], output: Path) -> None:
    """Copy every member as it was; only the named members get new bytes. Goes through a temporary file, so a failure leaves `output` as it was."""
    scratch = output.with_name(f".{output.name}.{os.getpid()}.part")
    with zipfile.ZipFile(scratch, "w") as archive:
        for name, (info, data) in parts.items():
            clone = zipfile.ZipInfo(info.filename, info.date_time)
            clone.compress_type = info.compress_type
            clone.external_attr = info.external_attr
            clone.comment = info.comment
            archive.writestr(clone, replacements.get(name, data))
    os.replace(scratch, output)


def serialize(root: etree._Element) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def put_text(node: etree._Element, text: str) -> None:
    """Set a text node's text; xml:space="preserve" only where whitespace at an edge would otherwise be lost (or was already declared)."""
    node.text = text
    if text != text.strip() or node.get(f"{{{XML}}}space") == "preserve":
        node.set(f"{{{XML}}}space", "preserve")


def paragraphs(root: etree._Element) -> list[etree._Element]:
    return list(root.iter(q("p")))


def text_nodes(paragraph: etree._Element) -> list[etree._Element]:
    """The `w:t` nodes that hold visible text, not counting text a revision has already deleted."""
    return [t for t in paragraph.iter(q("t")) if not any(parent.tag == q("del") for parent in t.iterancestors())]


def paragraph_text(paragraph: etree._Element) -> str:
    return "".join(t.text or "" for t in text_nodes(paragraph))


def style_of(paragraph: etree._Element) -> str:
    node = paragraph.find("w:pPr/w:pStyle", NS)
    return node.get(q("val")) if node is not None else "Normal"


def in_table(paragraph: etree._Element) -> bool:
    return any(parent.tag == q("tc") for parent in paragraph.iterancestors())


def load_root(parts: dict, name: str) -> etree._Element:
    return etree.fromstring(parts[name][1])


def cmd_outline(args: argparse.Namespace) -> int:
    parts = read_package(args.file)
    root = load_root(parts, BODY)
    items = paragraphs(root)
    print(f"{args.file.name}: {len(items)} paragraphs, {len(root.findall('.//w:tbl', NS))} tables")
    for number, paragraph in enumerate(items, 1):
        text = paragraph_text(paragraph)
        if not text.strip() and not args.all:
            continue
        shown = text if len(text) <= args.width else text[: args.width] + "..."
        print(f"P{number} [{style_of(paragraph)}{', table' if in_table(paragraph) else ''}] {shown}")
    for name in sorted(parts):
        if name.startswith(EDITABLE_PREFIX) and name.endswith(".xml"):
            note = " | ".join(paragraph_text(p) for p in paragraphs(load_root(parts, name)) if paragraph_text(p).strip())
            if note:
                print(f"{name}: {note[: args.width]}")
    return 0


def matches_in(paragraph: etree._Element, needle: str) -> list[int]:
    text, found, start = paragraph_text(paragraph), [], 0
    while needle and (hit := text.find(needle, start)) != -1:
        found.append(hit)
        start = hit + len(needle)
    return found


def cmd_find(args: argparse.Namespace) -> int:
    parts = read_package(args.file)
    total = 0
    for name in sorted(parts):
        if not is_editable(name):
            continue
        for number, paragraph in enumerate(paragraphs(load_root(parts, name)), 1):
            hits = matches_in(paragraph, args.text)
            if hits:
                total += len(hits)
                text = paragraph_text(paragraph)
                where = f"P{number}" if name == BODY else f"{name} P{number}"
                print(f"{where} x{len(hits)}: {text[: args.width]}")
    print(f"{total} match(es)")
    return 0 if total else 2


def split_run(run: etree._Element, offset: int) -> etree._Element:
    """Split a text run at `offset` characters; returns the second half (inserted right after the first).

    Whatever follows the run's text (a tab, a break) moves to the second half; whatever precedes it stays in the first.
    """
    node = run.find("w:t", NS)
    text = node.text or ""
    tail = etree.Element(run.tag, run.attrib)
    properties = run.find("w:rPr", NS)
    if properties is not None:
        tail.append(copy.deepcopy(properties))
    piece = etree.SubElement(tail, q("t"))
    for after in list(node.itersiblings()):
        tail.append(after)
    put_text(node, text[:offset])
    put_text(piece, text[offset:])
    run.addnext(tail)
    return tail


def simple_runs(paragraph: etree._Element) -> bool:
    """Tracked edits need every text node to sit directly in a run that holds exactly one of them."""
    for node in text_nodes(paragraph):
        run = node.getparent()
        if run.tag != q("r") or len(run.findall("w:t", NS)) != 1:
            return False
    return True


def replace_in_paragraph(paragraph: etree._Element, offset: int, old: str, new: str, track: bool, author: str, stamp: str, ids: list[int]) -> None:
    """Change `old` (found at `offset` in the paragraph text) into `new`.

    Only the part that differs is touched: the characters the two strings share at either end keep their runs, so changing
    "30 days" to "45 days" rewrites "30" and leaves " days" in its own formatting.
    """
    lead = 0
    while lead < min(len(old), len(new)) and old[lead] == new[lead]:
        lead += 1
    trail = 0
    while trail < min(len(old), len(new)) - lead and old[len(old) - 1 - trail] == new[len(new) - 1 - trail]:
        trail += 1
    offset, old, new = offset + lead, old[lead:len(old) - trail], new[lead:len(new) - trail]
    end = offset + len(old)
    nodes = text_nodes(paragraph)
    spans, cursor = [], 0
    for node in nodes:
        length = len(node.text or "")
        spans.append((node, cursor, cursor + length))
        cursor += length
    if not track:
        if not old:  # a pure insertion goes into the run that holds the character before it
            target = next((n for n, start, stop in spans if start < offset <= stop), spans[0][0] if spans else None)
            if target is not None:
                at = offset - next(start for n, start, stop in spans if n is target)
                put_text(target, (target.text or "")[:at] + new + (target.text or "")[at:])
            return
        placed = False
        for node, start, stop in spans:
            if stop <= offset or start >= end:
                continue
            text = node.text or ""
            lo, hi = max(offset, start) - start, min(end, stop) - start
            put_text(node, text[:lo] + ("" if placed else new) + text[hi:])
            placed = True
        return
    if not simple_runs(paragraph):
        raise ValueError("this paragraph holds runs that a tracked change cannot wrap; replace it without --track-changes")
    # Cut the runs at the boundaries of the changed span, wrap the covered runs in a deletion, and put the new text after it.
    for boundary in {end, offset}:
        cursor = 0
        for node in text_nodes(paragraph):
            length = len(node.text or "")
            if cursor < boundary < cursor + length:
                split_run(node.getparent(), boundary - cursor)
                break
            cursor += length
    covered, anchor, cursor = [], None, 0
    for node in text_nodes(paragraph):
        length = len(node.text or "")
        if length and cursor >= offset and cursor + length <= end and old:
            covered.append(node.getparent())
        if cursor + length <= offset and length:
            anchor = node.getparent()
        cursor += length
    properties = (covered[0] if covered else anchor)
    properties = properties.find("w:rPr", NS) if properties is not None else None
    ids[0] += 2
    insertion = None
    if new:
        insertion = etree.Element(q("ins"), {q("id"): str(ids[0] + 1), q("author"): author, q("date"): stamp})
        fresh = etree.SubElement(insertion, q("r"))
        if properties is not None:
            fresh.append(copy.deepcopy(properties))
        put_text(etree.SubElement(fresh, q("t")), new)
    if covered:
        deletion = etree.Element(q("del"), {q("id"): str(ids[0]), q("author"): author, q("date"): stamp})
        covered[0].addprevious(deletion)
        for run in covered:
            deletion.append(run)
            for t in run.findall("w:t", NS):
                t.tag = q("delText")
                put_text(t, t.text or "")
        if insertion is not None:
            deletion.addnext(insertion)
    elif insertion is not None:
        if anchor is not None:
            anchor.addnext(insertion)
        else:
            paragraph.append(insertion)


def cmd_replace(args: argparse.Namespace) -> int:
    parts = read_package(args.file)
    found, roots = [], {}
    for name in sorted(parts):
        if not is_editable(name):
            continue
        roots[name] = load_root(parts, name)
        for number, paragraph in enumerate(paragraphs(roots[name]), 1):
            if args.paragraph and (name != BODY or number != args.paragraph):
                continue
            for hit in matches_in(paragraph, args.find):
                found.append((name, number, paragraph, hit))
    if not found:
        print(json.dumps({"ok": False, "error": "no match", "find": args.find}, ensure_ascii=False))
        return 2
    if len(found) > 1 and not args.all:
        print(json.dumps({"ok": False, "error": "several matches; name the paragraph with --paragraph or pass --all",
                          "matches": [{"part": n, "paragraph": p, "text": paragraph_text(para)[:100]} for n, p, para, _ in found]}, ensure_ascii=False))
        return 3
    stamp, ids = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), [900]
    # Later offsets first, so an earlier replacement cannot shift a later one inside the same paragraph.
    try:
        for name, number, paragraph, hit in sorted(found, key=lambda item: (item[0], item[1], -item[3])):
            replace_in_paragraph(paragraph, hit, args.find, args.replacement, args.track_changes, args.author, stamp, ids)
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 4
    touched = sorted({name for name, *_ in found})
    target = args.out or args.file
    write_package(parts, {name: serialize(roots[name]) for name in touched}, target)
    print(json.dumps({"ok": True, "replaced": len(found), "parts_rewritten": touched, "parts_copied_unchanged": len(parts) - len(touched),
                      "tracked": args.track_changes, "out": str(target)}, ensure_ascii=False))
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    before, after = read_package(args.before), read_package(args.after)
    changed = sorted(n for n in set(before) & set(after) if before[n][1] != after[n][1])
    report = {"parts_only_in_before": sorted(set(before) - set(after)), "parts_only_in_after": sorted(set(after) - set(before)),
              "parts_changed": changed, "parts_identical": len(set(before) & set(after)) - len(changed), "paragraph_changes": []}
    for name in changed:
        if not name.endswith(".xml") or not is_editable(name):
            continue
        old, new = paragraphs(load_root(before, name)), paragraphs(load_root(after, name))
        matcher = difflib.SequenceMatcher(a=[paragraph_text(p) for p in old], b=[paragraph_text(p) for p in new], autojunk=False)
        for tag, a1, a2, b1, b2 in matcher.get_opcodes():
            if tag != "equal":
                report["paragraph_changes"].append({"part": name, "kind": tag, "before": [paragraph_text(p) for p in old[a1:a2]], "after": [paragraph_text(p) for p in new[b1:b2]]})
        same_text = [i for i, (a, b) in enumerate(zip(old, new)) if paragraph_text(a) == paragraph_text(b) and etree.tostring(a) != etree.tostring(b)]
        if same_text:
            report.setdefault("paragraphs_with_changed_formatting_only", []).extend(f"{name} P{i + 1}" for i in same_text)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    outline = sub.add_parser("outline", help="number and list the paragraphs")
    outline.add_argument("file", type=Path)
    outline.add_argument("--width", type=int, default=140)
    outline.add_argument("--all", action="store_true", help="include empty paragraphs")
    find = sub.add_parser("find", help="paragraphs that contain a text, even when it spans runs")
    find.add_argument("file", type=Path)
    find.add_argument("text")
    find.add_argument("--width", type=int, default=140)
    replace = sub.add_parser("replace", help="change a passage, keep everything else")
    replace.add_argument("file", type=Path)
    replace.add_argument("--find", required=True)
    replace.add_argument("--with", dest="replacement", required=True)
    replace.add_argument("--out", type=Path, help="write a new file; without it the document itself is edited in place")
    replace.add_argument("--paragraph", type=int, help="only this body paragraph, as numbered by outline")
    replace.add_argument("--all", action="store_true", help="replace every match")
    replace.add_argument("--track-changes", action="store_true", help="write a revision instead of silently changing the text")
    replace.add_argument("--author", default="Assistant")
    diff = sub.add_parser("diff", help="what differs between two versions of a document")
    diff.add_argument("before", type=Path)
    diff.add_argument("after", type=Path)
    args = parser.parse_args()
    return {"outline": cmd_outline, "find": cmd_find, "replace": cmd_replace, "diff": cmd_diff}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
