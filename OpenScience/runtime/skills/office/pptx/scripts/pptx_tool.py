#!/usr/bin/env python3
"""Restructure an existing deck: the operations python-pptx has no call for.

    pptx_tool.py outline deck.pptx
    pptx_tool.py duplicate deck.pptx --slide 3 --out deck2.pptx            # copy of slide 3 right after it
    pptx_tool.py delete-shapes deck2.pptx --slide 3 --ids 5,6 --out deck3.pptx
    pptx_tool.py set-text deck3.pptx --slide 4 --shape 2 --text "New title" --out deck4.pptx
    pptx_tool.py move deck4.pptx --slide 4 --to 2 --out deck5.pptx
    pptx_tool.py delete deck5.pptx --slide 9 --out deck6.pptx
    pptx_tool.py theme deck6.pptx --mode dark --out deck-dark.pptx

Slides and positions count from 1; shape ids are the ones `outline` prints. Without --out a command
edits the deck itself (through a temporary file, so a failure leaves it untouched); with --out it writes
a new file and the previous version stays. The deck is
opened and saved by python-pptx, which keeps layouts, masters, notes, images and charts it knows;
animation and SmartArt it cannot read are the things a rebuild would lose, so edit rather than
rebuild whenever the deck already exists.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.parts.chart import ChartPart
from pptx.util import Emu

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"a": A, "p": P}


def save(deck, args: argparse.Namespace) -> str:
    """Write to --out, or replace the file itself (through a temporary file in the same folder) when --out is absent."""
    target = args.out or args.file
    scratch = target.with_name(f".{target.name}.{os.getpid()}.part")
    deck.save(scratch)
    os.replace(scratch, target)
    return str(target)


def kind_of(shape) -> str:
    if shape.is_placeholder:
        return "placeholder"
    for name in ("chart", "table"):
        if getattr(shape, f"has_{name}", False):
            return name
    return {13: "picture", 6: "group", 17: "textbox"}.get(int(shape.shape_type or 0), "shape")


def title_of(slide) -> str:
    if slide.shapes.title is not None and slide.shapes.title.has_text_frame:
        return slide.shapes.title.text_frame.text.strip()
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            return shape.text_frame.text.strip().splitlines()[0]
    return ""


def inches(value) -> float:
    return round(Emu(value or 0).inches, 2)


def cmd_outline(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    width, height = deck.slide_width, deck.slide_height
    print(f"{args.file.name}: {len(deck.slides)} slides, {inches(width)} x {inches(height)} in, {len(deck.slide_masters)} master(s)")
    for number, slide in enumerate(deck.slides, 1):
        print(f"S{number} [{slide.slide_layout.name}] {title_of(slide)[:80]}")
        for shape in slide.shapes:
            text = shape.text_frame.text.replace("\n", " / ")[:70] if shape.has_text_frame else ""
            outside = ""
            if shape.left is not None and (shape.left < 0 or shape.top < 0 or shape.left + shape.width > width or shape.top + shape.height > height):
                outside = "  OUTSIDE SLIDE"
            print(f"   id={shape.shape_id} {kind_of(shape)} '{shape.name}' @({inches(shape.left)},{inches(shape.top)}) {inches(shape.width)}x{inches(shape.height)}{outside} {text}")
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            print(f"   notes: {slide.notes_slide.notes_text_frame.text.strip()[:100]}")
    return 0


def clone_chart(source_part, package) -> ChartPart:
    """A new chart part with its own embedded workbook, so editing one copy leaves the other alone."""
    partname = package.next_partname("/ppt/charts/chart%d.xml")
    copy_part = ChartPart.load(partname, source_part.content_type, package, source_part.blob)
    for external in copy_part._element.findall("{http://schemas.openxmlformats.org/drawingml/2006/chart}externalData"):
        copy_part._element.remove(external)
    workbook = source_part.chart_workbook.xlsx_part
    if workbook is not None:
        copy_part.chart_workbook.update_from_xlsx_blob(workbook.blob)
    return copy_part


def duplicate_slide(deck, index: int):
    source = deck.slides[index]
    fresh = deck.slides.add_slide(source.slide_layout)
    tree = fresh.shapes._spTree
    for shape in list(fresh.shapes):
        tree.remove(shape._element)
    mapping: dict[str, str] = {}

    def remap(rid: str) -> str:
        if rid not in mapping:
            rel = source.part.rels[rid]
            if rel.is_external:
                mapping[rid] = fresh.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
            elif rel.reltype == RT.CHART:
                mapping[rid] = fresh.part.relate_to(clone_chart(rel.target_part, deck.part.package), RT.CHART)
            else:
                mapping[rid] = fresh.part.relate_to(rel.target_part, rel.reltype)
        return mapping[rid]

    for shape in source.shapes:
        element = copy.deepcopy(shape._element)
        for node in element.iter():
            for key, value in list(node.attrib.items()):
                if key.startswith(f"{{{R}}}") and value in source.part.rels:
                    node.set(key, remap(value))
        tree.append(element)
    background = source._element.find(".//p:bg", NS)
    if background is not None:
        for node in background.iter():
            for key, value in list(node.attrib.items()):
                if key.startswith(f"{{{R}}}") and value in source.part.rels:
                    node.set(key, remap(value))
        fresh._element.find("p:cSld", NS).insert(0, copy.deepcopy(background))
    if source.has_notes_slide:
        fresh.notes_slide.notes_text_frame.text = source.notes_slide.notes_text_frame.text
    # add_slide appended it; put it right after the source
    items = deck.slides._sldIdLst
    entry = list(items)[-1]
    items.remove(entry)
    items.insert(index + 1, entry)
    return fresh


def need_slide(deck, number: int) -> int:
    if not 1 <= number <= len(deck.slides):
        raise SystemExit(json.dumps({"ok": False, "error": f"the deck has {len(deck.slides)} slides; there is no slide {number}"}))
    return number - 1


def cmd_duplicate(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    index = need_slide(deck, args.slide)
    duplicate_slide(deck, index)
    out = save(deck, args)
    print(json.dumps({"ok": True, "new_slide": index + 2, "slides": len(deck.slides), "out": out}))
    return 0


def cmd_move(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    index = need_slide(deck, args.slide)
    need_slide(deck, args.to)
    items = deck.slides._sldIdLst
    entry = list(items)[index]
    items.remove(entry)
    items.insert(args.to - 1, entry)
    out = save(deck, args)
    print(json.dumps({"ok": True, "moved": args.slide, "to": args.to, "out": out}))
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    index = need_slide(deck, args.slide)
    items = deck.slides._sldIdLst
    entry = list(items)[index]
    deck.part.drop_rel(entry.rId)
    items.remove(entry)
    out = save(deck, args)
    print(json.dumps({"ok": True, "slides": len(deck.slides), "out": out}))
    return 0


def prune_relationships(slide) -> None:
    """Drop what no shape on the slide points at any more (a deleted chart's part and workbook, a picture), so nothing is left orphaned in the file."""
    used = {value for node in slide._element.iter() for key, value in node.attrib.items() if key.startswith(f"{{{R}}}")}
    for rid, rel in list(slide.part.rels.items()):
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE) or rid in used:
            continue
        slide.part.drop_rel(rid)


def find_shape(slide, shape_id: int):
    for shape in slide.shapes:
        if shape.shape_id == shape_id:
            return shape
    raise SystemExit(json.dumps({"ok": False, "error": f"no shape with id {shape_id} on that slide; run outline"}))


def cmd_delete_shapes(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    slide = deck.slides[need_slide(deck, args.slide)]
    for shape_id in [int(x) for x in args.ids.split(",") if x.strip()]:
        element = find_shape(slide, shape_id)._element
        element.getparent().remove(element)
    prune_relationships(slide)
    out = save(deck, args)
    print(json.dumps({"ok": True, "shapes_left": len(slide.shapes), "out": out}))
    return 0


def cmd_set_text(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    shape = find_shape(deck.slides[need_slide(deck, args.slide)], args.shape)
    if not shape.has_text_frame:
        raise SystemExit(json.dumps({"ok": False, "error": "that shape has no text"}))
    lines = args.text.split("\\n") if "\\n" in args.text else args.text.split("\n")
    frame = shape.text_frame
    first = frame.paragraphs[0]
    template = copy.deepcopy(first._p)
    for extra in frame.paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
    runs = first.runs
    if runs:
        runs[0].text = lines[0]
        for run in runs[1:]:
            run._r.getparent().remove(run._r)
    else:
        first.add_run().text = lines[0]
    for line in lines[1:]:
        clone = copy.deepcopy(template)
        frame._txBody.append(clone)
        paragraph = frame.paragraphs[-1]
        if paragraph.runs:
            paragraph.runs[0].text = line
            for run in paragraph.runs[1:]:
                run._r.getparent().remove(run._r)
        else:
            paragraph.add_run().text = line
    out = save(deck, args)
    print(json.dumps({"ok": True, "out": out}))
    return 0


def luminance(hex_value: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_value[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(first: str, second: str) -> float:
    a, b = sorted((luminance(first), luminance(second)), reverse=True)
    return (a + 0.05) / (b + 0.05)


PALETTES = {
    # dk1/lt1 are the two scheme roles that carry the page and the text; the master's colour map decides which is which.
    "dark": {"dk1": "0F172A", "lt1": "F8FAFC", "dk2": "1E293B", "lt2": "CBD5E1", "map": {"bg1": "dk1", "tx1": "lt1", "bg2": "dk2", "tx2": "lt2"}},
    "light": {"dk1": "111827", "lt1": "FFFFFF", "dk2": "334155", "lt2": "F1F5F9", "map": {"bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2"}},
}


def cmd_theme(args: argparse.Namespace) -> int:
    deck = Presentation(args.file)
    palette = dict(PALETTES[args.mode])
    if args.background:
        palette["dk1" if args.mode == "dark" else "lt1"] = args.background.lstrip("#").upper()
    if args.text:
        palette["lt1" if args.mode == "dark" else "dk1"] = args.text.lstrip("#").upper()
    page = palette["dk1"] if args.mode == "dark" else palette["lt1"]
    ink = palette["lt1"] if args.mode == "dark" else palette["dk1"]
    for master in deck.slide_masters:
        mapping = master._element.find("p:clrMap", NS)
        for role, value in palette["map"].items():
            mapping.set(role, value)
        theme = master.part.part_related_by(RT.THEME)
        root = etree.fromstring(theme.blob)
        scheme = root.find(".//a:clrScheme", NS)
        for role in ("dk1", "lt1", "dk2", "lt2"):
            slot = scheme.find(f"a:{role}", NS)
            for child in list(slot):
                slot.remove(child)
            etree.SubElement(slot, f"{{{A}}}srgbClr", val=palette[role])
        if args.accent:
            slot = scheme.find("a:accent1", NS)
            for child in list(slot):
                slot.remove(child)
            etree.SubElement(slot, f"{{{A}}}srgbClr", val=args.accent.lstrip("#").upper())
        theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    recolored, review = 0, []
    for number, slide in enumerate(deck.slides, 1):
        for node in slide._element.iter(f"{{{A}}}srgbClr"):
            parent = node.getparent().getparent()
            role = etree.QName(parent).localname
            value = node.get("val").upper()
            if role == "rPr" or role == "defRPr" or role == "endParaRPr":
                if contrast(value, page) < 3:
                    if args.recolor:
                        node.set("val", ink)
                        recolored += 1
                    else:
                        review.append(f"S{number}: text colour {value} on the {args.mode} page")
            elif role in ("spPr", "tcPr") and args.recolor and args.mode == "dark" and luminance(value) > 0.7:
                node.set("val", palette["dk2"])
                recolored += 1
            elif role in ("spPr", "tcPr") and args.recolor and args.mode == "light" and luminance(value) < 0.1:
                node.set("val", palette["lt2"])
                recolored += 1
    out = save(deck, args)
    print(json.dumps({"ok": True, "mode": args.mode, "masters": len(deck.slide_masters), "explicit_colours_recoloured": recolored,
                      "explicit_colours_to_review": review[:20], "out": out}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    outline = sub.add_parser("outline", help="slides, layouts, shapes (ids, positions, text), notes")
    outline.add_argument("file", type=Path)
    for name, helptext in (("duplicate", "copy a slide, charts and pictures included, right after it"), ("move", "move a slide to another position"),
                           ("delete", "remove a slide"), ("delete-shapes", "remove shapes from a slide by id"),
                           ("set-text", "replace a shape's text, keeping its first run's formatting"), ("theme", "switch the whole deck to a dark or a light palette")):
        command = sub.add_parser(name, help=helptext)
        command.add_argument("file", type=Path)
        command.add_argument("--out", type=Path, help="write a new file; without it the deck is edited in place")
        if name != "theme":
            command.add_argument("--slide", type=int, required=True)
        if name == "move":
            command.add_argument("--to", type=int, required=True)
        if name == "delete-shapes":
            command.add_argument("--ids", required=True, help="comma-separated shape ids")
        if name == "set-text":
            command.add_argument("--shape", type=int, required=True)
            command.add_argument("--text", required=True, help="use \\n between paragraphs")
        if name == "theme":
            command.add_argument("--mode", choices=sorted(PALETTES), required=True)
            command.add_argument("--background", help="hex colour of the page (default per mode)")
            command.add_argument("--text", help="hex colour of the text (default per mode)")
            command.add_argument("--accent", help="hex colour for accent 1")
            command.add_argument("--recolor", action="store_true", help="also fix explicit colours that clash with the new page")
    args = parser.parse_args()
    return {"outline": cmd_outline, "duplicate": cmd_duplicate, "move": cmd_move, "delete": cmd_delete, "delete-shapes": cmd_delete_shapes,
            "set-text": cmd_set_text, "theme": cmd_theme}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
