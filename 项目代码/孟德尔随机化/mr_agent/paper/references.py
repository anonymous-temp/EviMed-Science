# [IN] PaperReference list
# [OUT] Formatted reference strings
# [POS] mr_agent/paper/references.py - Reference management
"""Reference management for academic paper generation."""

from __future__ import annotations

import re

from mr_agent.models import PaperReference


def format_apa(ref: PaperReference) -> str:
    """Format a reference in Vancouver style (matches [N] in-text numbering).

    Pattern: Authors. Title. Journal. Year. https://doi.org/xxxxx
    Volume/issue/pages appended when available via extended fields.
    """
    authors = ref.authors or "Unknown"
    year = str(ref.year) if ref.year else "n.d."
    title = ref.title.rstrip(".")
    journal = ref.journal.rstrip(".")
    doi_raw = (ref.doi or "").removeprefix("https://doi.org/").removeprefix("http://doi.org/").strip()
    doi_part = f" https://doi.org/{doi_raw}" if doi_raw else ""
    volume_part = ""
    if getattr(ref, "volume", None):
        volume_part = f". {ref.volume}"
        if getattr(ref, "issue", None):
            volume_part += f"({ref.issue})"
        if getattr(ref, "pages", None):
            volume_part += f":{ref.pages}"
    return f"{authors}. {title}. {journal}{volume_part}. {year}.{doi_part}"


def format_numbered(refs: list[PaperReference]) -> str:
    """Format references as Vancouver-style numbered list with blank line separators."""
    lines = []
    for i, ref in enumerate(refs, 1):
        lines.append(f"[{i}] {format_apa(ref)}")
    return "\n\n".join(lines)


def deduplicate(refs: list[PaperReference]) -> list[PaperReference]:
    """Remove duplicate references by PMID or title."""
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    unique = []
    for ref in refs:
        key_id = ref.pmid or ref.doi or ""
        key_title = ref.title.lower().strip()
        if key_id and key_id in seen_ids:
            continue
        if key_title in seen_titles:
            continue
        if key_id:
            seen_ids.add(key_id)
        seen_titles.add(key_title)
        unique.append(ref)
    return unique


def build_reference_context(refs: list[PaperReference], max_refs: int = 20) -> str:
    """Build reference context string for LLM prompts."""
    refs = deduplicate(refs)[:max_refs]
    parts = []
    for i, ref in enumerate(refs, 1):
        entry = (
            f"[{i}] {ref.authors} ({ref.year}). {ref.title}. "
            f"{ref.journal}. PMID: {ref.pmid or 'N/A'}"
        )
        if ref.abstract:
            entry += f"\nAbstract: {ref.abstract[:300]}..."
        parts.append(entry)
    return "\n\n".join(parts)


def apply_citation_numbers(
    paper: dict[str, str], refs: list[PaperReference],
) -> dict[str, str]:
    """Replace author-year citations with [N] numbering."""
    patterns = _build_regex_patterns(refs)
    if not patterns:
        return paper
    updated = {}
    for key, text in paper.items():
        if key == "references":
            updated[key] = text
        else:
            updated[key] = _replace_citations(text, patterns)
    return updated


def _build_regex_patterns(
    refs: list[PaperReference],
) -> list[tuple[re.Pattern, str]]:
    """Build regex patterns for each reference's citation variants."""
    patterns: list[tuple[re.Pattern, str]] = []
    for i, ref in enumerate(refs, 1):
        ref_patterns = _patterns_for_ref(ref, i)
        patterns.extend(ref_patterns)
    return patterns


def _patterns_for_ref(
    ref: PaperReference, index: int,
) -> list[tuple[re.Pattern, str]]:
    """Generate all regex patterns for a single reference."""
    if not ref.authors or not ref.year:
        return []
    last_name = _extract_last_name(ref.authors)
    if not last_name:
        return []
    replacement = f"[{index}]"
    year = str(ref.year)
    esc = re.escape(last_name)
    raw_patterns = [
        rf"\({esc},?\s*{year}\)",
        rf"\({esc}\s+et\s+al\.?,?\s*{year}\)",
        rf"{esc}\s+et\s+al\.?\s*\({year}\)",
        rf"{esc}\s*\({year}\)",
        rf"\({esc}\s+and\s+\w+,?\s*{year}\)",
        rf"{esc}\s+et\s+al\.?,?\s*{year}(?!\d)",
    ]
    return [
        (re.compile(p, re.IGNORECASE), replacement)
        for p in raw_patterns
    ]


def _extract_last_name(authors: str) -> str:
    """Extract first author's last name from author string."""
    first = authors.split(",")[0].strip()
    return first.split()[-1] if first else ""


def _replace_citations(
    text: str, patterns: list[tuple[re.Pattern, str]],
) -> str:
    """Replace author-year citations with numbered references."""
    for pattern, replacement in patterns:
        text = pattern.sub(replacement, text)
    return text
