#!/usr/bin/env python3
"""Offline conversion of a frozen Markdown document through Pandoc and Chromium.

Only verified raster assets enter the Pandoc AST. Raw HTML/TeX, includes, filters,
remote images and script execution are unavailable. Each format has its own outcome.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
from html.parser import HTMLParser
import shutil
import subprocess
import tempfile
from pathlib import Path

VERSION = "pandoc-chromium-v1"
MIME = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "pdf": "application/pdf", "html": "text/html; charset=utf-8"}
CSS = """@page { size:A4; margin:20mm 16mm; } body { font:11pt 'Noto Sans CJK SC','Noto Sans',sans-serif; line-height:1.65; color:#17212b; overflow-wrap:anywhere; } h1,h2,h3 { break-after:avoid; } table { border-collapse:collapse; width:100%; font-size:9pt; } thead { display:table-header-group; } tr { break-inside:avoid; } th,td { border:1px solid #aaa; padding:5px; text-align:left; } img { max-width:100%; max-height:230mm; } pre { white-space:pre-wrap; } .pagebreak { break-before:page; }"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verified_assets(document: dict, root: Path) -> dict[str, str]:
    result = {}
    for asset in document.get("assets", []):
        relative = asset.get("path", "")
        parts = Path(relative).parts
        if not parts or Path(relative).is_absolute() or ".." in parts or "\\" in relative:
            raise ValueError("document_asset_invalid")
        target = root
        for part in parts:
            target = target / part
            if target.is_symlink():
                raise ValueError("document_asset_symlink")
        data = target.read_bytes()
        mime = asset.get("mime")
        if len(data) > 10 * 1024 * 1024 or sha256(data) != asset.get("sha256"):
            raise ValueError("document_asset_hash_mismatch")
        if not ((mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")) or (mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff"))):
            raise ValueError("document_asset_type_invalid")
        result[relative] = "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")
    return result


def pandoc(args: list[str], data: str) -> str:
    result = subprocess.run(["pandoc", *args], input=data, text=True, capture_output=True, timeout=60, check=False)
    if result.returncode:
        raise RuntimeError("document_converter_failed")
    return result.stdout



class VisibleHtmlText(HTMLParser):
    """Keep a raw block's readable text without carrying executable markup."""
    blocked = {"script", "style", "iframe", "object", "svg"}
    blocks = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "blockquote", "dt", "dd"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.suppressed: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.blocked:
            self.suppressed.append(tag)
        elif not self.suppressed and tag in self.blocks:
            self.parts.append("\n")
        elif not self.suppressed and tag in {"td", "th"}:
            self.parts.append("\t")
        elif not self.suppressed and tag == "img":
            self.parts.append((dict(attrs).get("alt") or "") + " [image unavailable]")

    def handle_endtag(self, tag: str) -> None:
        if self.suppressed and tag == self.suppressed[-1]:
            self.suppressed.pop()
        elif not self.suppressed and tag in self.blocks:
            self.parts.append("\n")
        elif not self.suppressed and tag in {"td", "th"}:
            self.parts.append("\t")

    def handle_data(self, data: str) -> None:
        if not self.suppressed:
            self.parts.append(data)


def raw_text(format_name: str, text: str) -> str:
    if format_name not in {"html", "html5"}:
        return text
    parser = VisibleHtmlText()
    parser.feed(text)
    parser.close()
    return "".join(parser.parts).strip()


def safe_ast(markdown: str, assets: dict[str, str], findings: list[str]) -> str:
    tree = json.loads(pandoc(["--from=markdown-raw_html-raw_tex", "--to=json"], markdown))

    def visit(node):
        if isinstance(node, list):
            # Pandoc Attr triples occur on headings, spans, code and tables.
            # Drop event/style attributes; retain only the fixed page break.
            if len(node) == 3 and isinstance(node[0], str) and isinstance(node[1], list) and isinstance(node[2], list):
                return [node[0] if re.fullmatch(r"[\w.-]{1,200}", node[0]) else "", ["pagebreak"] if "pagebreak" in node[1] else [], []]
            return [visit(child) for child in node]
        if not isinstance(node, dict):
            return node
        kind = node.get("t")
        if kind in {"RawBlock", "RawInline"}:
            findings.append("document_raw_markup_removed")
            text = raw_text(*node["c"])
            return {"t": "CodeBlock", "c": [["", [], []], text]} if kind == "RawBlock" else {"t": "Str", "c": text}
        if kind in ("Image", "Link"):
            content = node["c"]
            target = content[-1][0]
            if kind == "Image":
                if target not in assets:
                    findings.append("document_image_unavailable")
                    return {"t": "Span", "c": [["", [], []], visit(content[-2]) + [{"t": "Str", "c": " [image unavailable]"}]]}
                content[-1] = [assets[target], ""]
            elif not (target.startswith("https://") or target.startswith("http://") or target.startswith("#")):
                return {"t": "Span", "c": [["", [], []], visit(content[-2])]}
            content[0] = ["", [], []]
        return {key: visit(value) for key, value in node.items()}

    return json.dumps(visit(tree), ensure_ascii=False)



def docx_ast(ast: str) -> str:
    """Map the one supported page-break marker to fixed trusted Word XML."""
    def visit(node):
        if isinstance(node, list):
            return [visit(child) for child in node]
        if not isinstance(node, dict):
            return node
        if node.get("t") == "Div" and "pagebreak" in node["c"][0][1]:
            blocks = visit(node["c"][1])
            marker = {"t": "RawBlock", "c": ["openxml", "<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>"]}
            return {"t": "Div", "c": [["", [], []], [marker, *blocks]]}
        return {key: visit(value) for key, value in node.items()}
    return json.dumps(visit(json.loads(ast)), ensure_ascii=False)


def pdf(html_text: str, output: Path) -> None:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else None,
                                             args=["--no-sandbox", "--disable-dev-shm-usage"], headless=True)
        try:
            page = browser.new_page(java_script_enabled=False)
            page.route("**/*", lambda route: route.abort())
            page.set_content(html_text, wait_until="load", timeout=30000)
            page.pdf(path=str(output), format="A4", print_background=True, prefer_css_page_size=True)
        finally:
            browser.close()


def render(document: dict, root: Path, output: Path) -> dict:
    if document.get("version") != 1 or document.get("rendererVersion") != VERSION:
        raise ValueError("document_version_invalid")
    formats = document.get("formats", [])
    if not formats or any(fmt not in MIME for fmt in formats):
        raise ValueError("document_format_invalid")
    markdown = document.get("canonicalMarkdown", "")
    if not isinstance(markdown, str) or len(markdown.encode()) > 4 * 1024 * 1024:
        raise ValueError("document_text_invalid")
    output.mkdir(parents=True, exist_ok=True)
    findings = []
    assets = verified_assets(document, root)
    ast = safe_ast(markdown, assets, findings)
    markup = None
    markup_failure = None
    outcomes = {}
    manifest = {"version": 1, "rendererVersion": VERSION, "sourceDigest": document["sourceDigest"], "formats": outcomes, "findings": sorted(set(findings))}
    for fmt in formats:
        target = output / ("document." + fmt)
        code = "document_render_failed"
        try:
            if fmt == "docx":
                pandoc(["--from=json", "--to=docx", "--output=" + str(target)], docx_ast(ast))
            else:
                # DOCX never depends on HTML conversion. Cache a failed HTML
                # attempt as well, so PDF+HTML do not repeat the same failure.
                if markup is None and markup_failure is None:
                    try:
                        body = pandoc(["--from=json", "--to=html5", "--mathml"], ast)
                        markup = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                                  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
                                  '<title>' + html.escape(document.get("title", "Research report")) + '</title><style>'
                                  + CSS + '</style></head><body>' + body + '</body></html>')
                    except Exception as exc:
                        markup_failure = exc
                if markup_failure is not None:
                    code = "document_html_render_failed"
                    raise RuntimeError(code) from markup_failure
                if fmt == "html":
                    target.write_text(markup, encoding="utf-8")
                else:
                    pdf(markup, target)
            data = target.read_bytes()
            if not data:
                raise RuntimeError("document_output_empty")
            outcomes[fmt] = {"state": "ready", "path": target.name, "mime": MIME[fmt], "sha256": sha256(data), "bytes": len(data)}
        except Exception as exc:  # A failed format never removes another format's output.
            target.unlink(missing_ok=True)
            outcomes[fmt] = {"state": "failed", "code": code, "message": type(exc).__name__}
        # A timeout or process death during the next format still leaves a
        # complete receipt for every format already written.
        temporary = output / ".manifest.tmp"
        temporary.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, output / "manifest.json")
    return manifest


def render_text(text: str, output: Path, fmt: str) -> None:
    """Compatibility entry for the existing office command line wrappers."""
    with tempfile.TemporaryDirectory(prefix="evimed-document-") as directory:
        root = Path(directory)
        result = render({"version": 1, "rendererVersion": VERSION, "sourceDigest": sha256(text.encode()), "canonicalMarkdown": text, "assets": [], "formats": [fmt]}, root, root / "output")
        if result["formats"][fmt]["state"] != "ready":
            raise RuntimeError(result["formats"][fmt]["code"])
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / "output" / ("document." + fmt), output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    render(json.loads(args.input.read_text(encoding="utf-8")), args.input.parent, args.output_dir)


if __name__ == "__main__":
    main()
