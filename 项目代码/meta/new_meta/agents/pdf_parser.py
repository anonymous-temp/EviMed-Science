"""PDF Parser — convert PDFs to structured text using pdfplumber (local) or MinEru (API)."""
from __future__ import annotations

import logging
import re
from pathlib import Path

from new_meta.config import MINERU_TOKEN

logger = logging.getLogger("metaagent.pdf_parser")

# 元数据行前缀，跳过这些行（不是标题）
_META_PREFIXES = re.compile(
    r"^\s*(doi|received|accepted|revised|published|email|copyright|"
    r"article\s+(type|no)|created\s+by|title\s*:|orcid|"
    r"\[page\s+\d+\]|research\s*:|section\s*:)",
    re.IGNORECASE,
)
# 作者行特征：含学位缩写、竖线分隔、上标数字+逗号
_AUTHOR_LINE = re.compile(r"\b(MD|PhD|RN|BSN|MRCP|FRCP|MSc|MPH|DrPH)\b|\|\s|\d{1,2}[,;]")


def extract_pdf_title(pdf_path: str) -> str:
    """Extract the title from a PDF's first page using pdfplumber.

    Returns the best-guess title string (may be empty if extraction fails).
    """
    try:
        import pdfplumber

        with pdfplumber.open(pdf_path) as pdf:
            if not pdf.pages:
                return ""
            first_page_text = pdf.pages[0].extract_text() or ""
            if len(pdf.pages) > 1:
                first_page_text += "\n" + (pdf.pages[1].extract_text() or "")
    except Exception as e:
        logger.debug(f"extract_pdf_title failed for {pdf_path}: {e}")
        return ""

    title_lines: list[str] = []
    for raw_line in first_page_text.splitlines():
        line = raw_line.strip()
        # 跳过空行、单字符行（旋转文字乱码）、元数据行
        if not line or len(line) < 4:
            continue
        if _META_PREFIXES.match(line):
            continue
        # 跳过明显的作者行
        if _AUTHOR_LINE.search(line):
            # 如果还没收集到标题行，说明这行在标题之前，继续
            if not title_lines:
                continue
            # 已有标题行，作者行出现则停止收集
            break
        # 跳过全大写短标签（如 SHORT REPORTS, ORIGINAL ARTICLE）
        if line.isupper() and len(line.split()) <= 3:
            continue
        # 收集标题行
        title_lines.append(line)
        # 最多取前 5 行（防止把摘要也包进来）
        if len(title_lines) >= 5:
            break

    return " ".join(title_lines).strip()


def parse_pdf(pdf_path: str) -> dict:
    """Parse a PDF and return structured content.

    Returns:
        {
            "full_text": str,       # Complete text content with [PAGE N] markers
            "sections": dict,       # {section_name: {"text": str, "start_page": int|None}}
            "tables": list[str],    # Extracted tables as markdown
            "abstract": str,
            "page_map": list[dict], # [{page_number, start_char, end_char}, ...]
        }
    """
    if MINERU_TOKEN:
        try:
            return _parse_with_mineru(pdf_path)
        except Exception as e:
            logger.warning(f"MinEru parsing failed, falling back to pdfplumber: {e}")

    return _parse_with_pdfplumber(pdf_path)


def parse_text_fulltext(text_path: str) -> dict:
    """Parse a saved plain-text full-text fallback file."""
    text = Path(text_path).read_text(encoding="utf-8", errors="ignore")
    full_text = f"[PAGE 1]\n{text}"
    page_map = [{"page_number": 1, "start_char": len("[PAGE 1]\n"), "end_char": len(full_text)}]
    sections = _split_sections(full_text, page_map)
    abstract_section = sections.get("Abstract", sections.get("ABSTRACT", {}))
    abstract = abstract_section.get("text", "") if isinstance(abstract_section, dict) else abstract_section or ""
    return {
        "full_text": full_text,
        "sections": sections,
        "tables": [],
        "abstract": abstract,
        "page_map": page_map,
    }


def get_page_for_position(char_offset: int, page_map: list[dict]) -> int | None:
    """Look up the page number for a given character offset in the full text.

    Args:
        char_offset: Character position in the full_text string.
        page_map: List of dicts with keys page_number, start_char, end_char.

    Returns:
        Page number (1-based) or None if offset is out of range.
    """
    for entry in page_map:
        if entry["start_char"] <= char_offset <= entry["end_char"]:
            return entry["page_number"]
    return None


def _rotated_direction(char: dict) -> str:
    """Read vertical glyphs in the direction encoded by their PDF matrix."""
    return "btt" if char["matrix"][1] > 0 else "ttb"


def _page_reading_text(page, page_number: int) -> tuple[str, list[dict]]:
    """Keep content-stream prose and rotated text separate without rebuilding cells."""
    upright = page.filter(
        lambda obj: obj.get("object_type") == "char" and obj.get("upright", True)
    )
    parts = [upright.extract_text(use_text_flow=True) or ""]
    warnings = []
    directions = {_rotated_direction(char) for char in page.chars if not char["upright"]}
    for direction in sorted(directions):
        rotated = page.filter(
            lambda obj: obj.get("object_type") == "char"
            and not obj.get("upright", True)
            and _rotated_direction(obj) == direction
        )
        # Geometric ordering inside an orientation preserves decimal/fraction
        # literals. Content-stream ordering breaks vertical words into letters.
        text = rotated.extract_text(char_dir_rotated=direction, line_dir_rotated="ltr") or ""
        if text:
            parts.append("[ROTATED TEXT: cell relationships are not inferred]\n" + text)
            warnings.append({
                "page_number": page_number,
                "code": "rotated_text_unstructured",
                "direction": direction,
            })
    return "\n\n".join(part for part in parts if part), warnings


def _table_has_rotated_text(table, chars: list[dict]) -> bool:
    left, top, right, bottom = table.bbox
    return any(
        not char["upright"]
        and char["x0"] < right and char["x1"] > left
        and char["top"] < bottom and char["bottom"] > top
        for char in chars
    )


def _parse_with_pdfplumber(pdf_path: str) -> dict:
    """Parse PDF using pdfplumber (local, no API needed)."""
    import pdfplumber

    full_text_parts = []
    tables_md = []
    page_map = []
    parse_warnings = []
    current_char = 0

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages, start=1):
            # Insert page marker
            marker = f"[PAGE {page_idx}]\n"
            full_text_parts.append(marker)
            current_char += len(marker)

            page_start = current_char

            # Extract text
            text, warnings = _page_reading_text(page, page_idx)
            parse_warnings.extend(warnings)
            if text:
                full_text_parts.append(text)
                current_char += len(text)

            page_end = current_char - 1 if current_char > page_start else page_start

            page_map.append({
                "page_number": page_idx,
                "start_char": page_start,
                "end_char": page_end,
            })

            # Separator between pages
            full_text_parts.append("\n\n")
            current_char += 2

            # Extract tables
            for table_idx, detected_table in enumerate(page.find_tables(), start=1):
                if _table_has_rotated_text(detected_table, page.chars):
                    parse_warnings.append({
                        "page_number": page_idx,
                        "table_number": table_idx,
                        "code": "rotated_table_unstructured",
                    })
                    continue
                table = detected_table.extract()
                if table:
                    md = _table_to_markdown(table)
                    if md:
                        tables_md.append(f"[PAGE {page_idx}] Table {table_idx}\n{md}")

    full_text = "".join(full_text_parts)
    sections = _split_sections(full_text, page_map)

    # Extract abstract — handle new section dict format
    abstract_section = sections.get("Abstract", sections.get("ABSTRACT", {}))
    if isinstance(abstract_section, dict):
        abstract = abstract_section.get("text", "")
    else:
        abstract = abstract_section or ""

    return {
        "full_text": full_text,
        "sections": sections,
        "tables": tables_md,
        "abstract": abstract,
        "page_map": page_map,
        "parse_warnings": parse_warnings,
    }


def _parse_with_mineru(pdf_path: str) -> dict:
    """Parse PDF using MinEru API."""
    try:
        from structai import read_pdf
    except ImportError:
        raise ImportError("structai not installed; cannot use MinEru parser")

    result = read_pdf(pdf_path)
    md_path = Path(pdf_path).parent / Path(pdf_path).stem / "full.md"

    full_text = ""
    if md_path.exists():
        full_text = md_path.read_text(encoding="utf-8")

    sections = _split_sections(full_text, page_map=[])

    # Extract abstract — handle new section dict format
    abstract_section = sections.get("Abstract", sections.get("ABSTRACT", {}))
    if isinstance(abstract_section, dict):
        abstract = abstract_section.get("text", "")
    else:
        abstract = abstract_section or ""

    return {
        "full_text": full_text,
        "sections": sections,
        "tables": [],
        "abstract": abstract,
        "page_map": [],
    }


def _table_to_markdown(table: list[list]) -> str:
    """Convert a pdfplumber table to markdown."""
    if not table or not table[0]:
        return ""

    # Clean cells
    clean = []
    for row in table:
        clean.append([str(cell).strip() if cell else "" for cell in row])

    # Build markdown
    header = "| " + " | ".join(clean[0]) + " |"
    separator = "| " + " | ".join("---" for _ in clean[0]) + " |"
    rows = [header, separator]
    for row in clean[1:]:
        # Pad if needed
        while len(row) < len(clean[0]):
            row.append("")
        rows.append("| " + " | ".join(row[:len(clean[0])]) + " |")

    return "\n".join(rows)


def _split_sections(text: str, page_map: list[dict]) -> dict:
    """Split full text into sections by common headings.

    Returns:
        {section_name: {"text": str, "start_page": int|None}}
    """
    import re

    # Pattern that matches common section headings at the start of a line
    heading_pattern = re.compile(
        r'^(Abstract|ABSTRACT|'
        r'Introduction|INTRODUCTION|Background|BACKGROUND|'
        r'Methods?|METHODS?|Materials?\s+and\s+Methods?|'
        r'Results?|RESULTS?|'
        r'Discussion|DISCUSSION|'
        r'Conclusions?|CONCLUSIONS?|'
        r'References?|REFERENCES?|Bibliography|'
        r'Supplementary|SUPPLEMENTARY|Appendix|APPENDIX)\s*$',
        re.MULTILINE | re.IGNORECASE,
    )

    # Find all heading positions in the original text
    headings = [(m.group(0).strip(), m.start()) for m in heading_pattern.finditer(text)]

    sections = {}

    if not headings:
        # No headings found — whole text is Preamble
        start_page = get_page_for_position(0, page_map) if page_map else None
        sections["Preamble"] = {"text": text.strip(), "start_page": start_page}
        return sections

    # Text before first heading → Preamble
    if headings[0][1] > 0:
        preamble_text = text[:headings[0][1]].strip()
        if preamble_text:
            start_page = get_page_for_position(0, page_map) if page_map else None
            sections["Preamble"] = {"text": preamble_text, "start_page": start_page}

    # Each heading → next heading (or end of text)
    for i, (name, start_pos) in enumerate(headings):
        # Section body starts after the heading line
        body_start = start_pos + len(name)
        body_end = headings[i + 1][1] if i + 1 < len(headings) else len(text)
        body = text[body_start:body_end].strip()

        start_page = get_page_for_position(start_pos, page_map) if page_map else None
        sections[name] = {"text": body, "start_page": start_page}

    return sections
