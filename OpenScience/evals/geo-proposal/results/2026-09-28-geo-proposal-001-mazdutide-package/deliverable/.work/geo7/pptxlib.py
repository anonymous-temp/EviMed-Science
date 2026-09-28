#!/usr/bin/env python3
"""Minimal multi-slide 16:9 PPTX writer (stdlib only), following the platform's OOXML baseline."""
from __future__ import annotations
import re
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
CX, CY = 12192000, 6858000  # 16:9


def _t(value) -> str:
    return escape(_ILLEGAL.sub("", str(value)))


def _runs(lines, size, bold=False, color="1F2937"):
    out = []
    for line in lines:
        weight = ' b="1"' if bold else ""
        out.append(
            f'<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="{size}"{weight} dirty="0">'
            f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
            f'<a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr>'
            f'<a:t>{_t(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="{size}"/></a:p>')
    return "".join(out)


def box(sid, name, lines, x, y, cx, cy, size=1400, bold=False, color="1F2937", fill=None):
    fill_xml = (f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>' if fill else "<a:noFill/>")
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{_t(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{fill_xml}</p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/>'
        f'{_runs(lines, size, bold, color)}</p:txBody></p:sp>')


def slide_xml(slide: dict, number: int) -> str:
    shapes = [box(1, "Title", [slide["title"]], 609600, 342900, 10972800, 800100, 2400, True, "1F4E79")]
    y = 1257300
    if slide.get("subtitle"):
        shapes.append(box(2, "Subtitle", [slide["subtitle"]], 609600, 1143000, 10972800, 320000, 1300, False, "6B7280"))
    uid = 3
    blocks = slide.get("blocks", [])
    budget = CY - y - 700000  # keep the footer band clear
    wants = [min(int(len(b["lines"]) * b.get("size", 1300) * 2.29) + 120000, 2200000) for b in blocks]
    total = sum(wants) + 60000 * max(len(blocks) - 1, 0)
    scale = min(1.0, budget / total) if total else 1.0
    for para, want in zip(blocks, wants):
        lines = para["lines"]
        height = max(int(want * scale), 200000)
        shapes.append(box(uid, f'Body{uid}', lines, 609600, y, 10972800, height,
                          para.get("size", 1300), para.get("bold", False), para.get("color", "1F2937")))
        uid += 1
        y += height + 60000
    shapes.append(box(uid, "Footer", [slide.get("footer", "")], 609600, CY - 560000, 10000000, 320000, 1000, False, "9CA3AF"))
    shapes.append(box(uid + 1, "Page", [str(number)], CX - 900000, CY - 560000, 300000, 320000, 1000, False, "9CA3AF"))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="0" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            + "".join(shapes) +
            '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')


def write_pptx(path: str, slides: list[dict]) -> None:
    n = len(slides)
    overrides = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, n + 1))
    contents = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
                '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
                '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
                f'{overrides}</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
            '</Relationships>')
    sld_ids = "".join(f'<p:sldId id="{255 + i}" r:id="rId{i + 1}"/>' for i in range(1, n + 1))
    presentation = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
                    f'<p:sldIdLst>{sld_ids}</p:sldIdLst>'
                    f'<p:sldSz cx="{CX}" cy="{CY}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
    pres_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
                 + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>' for i in range(1, n + 1))
                 + '</Relationships>')
    layout = ('<?xml version="1.0" encoding="UTF-8"?>'
              '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank">'
              '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
              '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
              '</p:spTree></p:cSld></p:sldLayout>')
    master = ('<?xml version="1.0" encoding="UTF-8"?>'
              '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>'
              '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
              '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
              '</p:spTree></p:cSld>'
              '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>'
              '<p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>')
    theme = ('<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="EviMed">'
             '<a:themeElements><a:clrScheme name="EviMed">'
             '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
             '<a:dk2><a:srgbClr val="1F4E79"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>'
             '<a:accent1><a:srgbClr val="1F4E79"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2>'
             '<a:accent3><a:srgbClr val="9333EA"/></a:accent3><a:accent4><a:srgbClr val="C2410C"/></a:accent4>'
             '<a:accent5><a:srgbClr val="0369A1"/></a:accent5><a:accent6><a:srgbClr val="4D7C0F"/></a:accent6>'
             '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
             '<a:fontScheme name="EviMed"><a:majorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont>'
             '<a:minorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
             '<a:fmtScheme name="EviMed"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
             '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
             '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
             '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>')

    def member(name, text):
        info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, text.encode("utf-8"))

    with ZipFile(path, "w") as archive:
        member("[Content_Types].xml", contents)
        member("_rels/.rels", rels)
        member("ppt/presentation.xml", presentation)
        member("ppt/_rels/presentation.xml.rels", pres_rels)
        member("ppt/slideLayouts/slideLayout1.xml", layout)
        member("ppt/slideLayouts/_rels/slideLayout1.xml.rels",
               '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>')
        member("ppt/slideMasters/slideMaster1.xml", master)
        member("ppt/slideMasters/_rels/slideMaster1.xml.rels",
               '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
               '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>')
        member("ppt/theme/theme1.xml", theme)
        for i, slide in enumerate(slides, start=1):
            member(f"ppt/slides/slide{i}.xml", slide_xml(slide, i))
            member(f"ppt/slides/_rels/slide{i}.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>')
