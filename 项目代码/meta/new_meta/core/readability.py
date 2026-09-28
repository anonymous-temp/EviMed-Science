"""The sentence-length rule, held once for the writer and the readability gate.

The release gate's readability check counts text units per sentence in the
interpretive sections (Discussion and Conclusion). The writer is told the same
limit, and :func:`split_overlong_sentences` shortens only what can be split
without touching a word: a top-level semicolon between two complete clauses
becomes a full stop. Anything else is left for a language model to split under
a fact-preservation check, or stays as the gate's finding.
"""
from __future__ import annotations

import re
from typing import Any

# Sections whose sentences the readability gate measures (H2 heading, lowered).
OVERLONG_SENTENCE_SECTIONS = frozenset({
    "discussion",
    "conclusion",
    "conclusions",
    "讨论",
    "结论",
})

# Maximum text units per sentence (see ``text_unit_count``).
OVERLONG_SENTENCE_THRESHOLDS = {
    "en": 55,
    "zh": 100,
}

# A split must leave both halves at least this long, so it never produces a
# fragment that reads as a heading or a dangling clause.
_MIN_SPLIT_UNITS = {"en": 8, "zh": 15}

_OPENING_BRACKETS = "（([［【「『《“‘"
_CLOSING_BRACKETS = "）)]］】」』》”’"


def text_unit_count(text: str) -> int:
    """Count CJK characters, Latin words/numbers, and symbol runs as one unit each."""
    raw = str(text or "")
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[一-鿿]|[%./+-]+", raw))


def readability_language_for_text(text: str) -> str:
    raw = str(text or "")
    cjk_chars = len(re.findall(r"[一-鿿]", raw))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return "zh" if cjk_chars >= max(1, latin_words * 2) else "en"


def sentence_length_limit(language: str) -> int:
    return OVERLONG_SENTENCE_THRESHOLDS.get(language, OVERLONG_SENTENCE_THRESHOLDS["en"])


def sentence_length_rule(language: str) -> str:
    """The writer's instruction for the limit the readability gate enforces."""
    if language == "zh":
        return (
            "In Discussion and Conclusion, keep every sentence (ending with 。！？) within "
            f"{sentence_length_limit('zh')} counted units, where each Chinese character, number, or Latin "
            "word counts as one. Write long reasoning as separate sentences instead of chaining clauses "
            "with semicolons or colon-led lists."
        )
    return (
        "In Discussion and Conclusion, keep every sentence within "
        f"{sentence_length_limit('en')} words. Write long reasoning as separate sentences instead of "
        "chaining clauses with semicolons."
    )


def _prose_line(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not (
        stripped.startswith("#")
        or stripped.startswith("|")
        or stripped.startswith("![")
        or re.match(r"^[-*]\s+", stripped)
    )


def readability_sentence_segments(text: str) -> list[str]:
    """Split section prose into the sentences the readability gate measures."""
    raw = str(text or "")
    kept_lines = [line.strip() for line in raw.splitlines() if _prose_line(line)]
    plain = " ".join(kept_lines)
    if not plain:
        return []
    parts = re.split(r"(?<=[。！？])|(?<=[!?])\s+|(?<=[.])\s+(?=[A-Z0-9])", plain)
    return [re.sub(r"\s+", " ", part).strip() for part in parts if part and part.strip()]


def overlong_sentences(text: str, *, language: str | None = None) -> list[dict[str, Any]]:
    """Return the sentences of a section body that exceed the gate's limit."""
    language = language or readability_language_for_text(text)
    limit = sentence_length_limit(language)
    found = []
    for sentence in readability_sentence_segments(text):
        units = text_unit_count(sentence)
        if units > limit:
            found.append({"sentence": sentence, "units": units, "threshold": limit, "language": language})
    return found


def line_sentences(line: str) -> list[str]:
    """Split one prose line into sentences, keeping every character."""
    pieces = re.split(r"(?<=[。！？])|(?<=[.!?])(?=\s+[A-Z0-9])", line)
    return [piece for piece in pieces if piece]


def _top_level_positions(sentence: str, marks: str) -> list[tuple[int, str]]:
    depth = 0
    positions: list[tuple[int, str]] = []
    for index, char in enumerate(sentence):
        if char in _OPENING_BRACKETS:
            depth += 1
        elif char in _CLOSING_BRACKETS:
            depth = max(0, depth - 1)
        elif depth == 0 and char in marks:
            positions.append((index, char))
    return positions


def _safe_split_points(sentence: str, language: str) -> list[int]:
    """Top-level semicolons whose two sides are complete, independent clauses.

    A semicolon after a top-level colon separates the items of a colon-led list
    ("并不一致：一项研究……；另一项研究……"); a full stop there would cut the
    items off the clause that introduces them, so no point after a colon is safe.
    """
    minimum = _MIN_SPLIT_UNITS.get(language, _MIN_SPLIT_UNITS["en"])
    marks = "；;:："
    points: list[int] = []
    for index, char in _top_level_positions(sentence, marks):
        if char in ":：":
            break
        if language == "zh" and char != "；":
            continue
        if language == "en":
            if char != ";":
                continue
            following = sentence[index + 1:]
            if not re.match(r"\s+[a-z][a-z]+\b", following):
                continue
        before, after = sentence[:index], sentence[index + 1:]
        if text_unit_count(before) < minimum or text_unit_count(after) < minimum:
            continue
        points.append(index)
    return points


def _split_at(sentence: str, index: int, language: str) -> tuple[str, str]:
    before, after = sentence[:index], sentence[index + 1:]
    if language == "zh":
        return before + "。", after.lstrip()
    after = after.lstrip()
    return before + ".", after[:1].upper() + after[1:]


def _split_sentence(sentence: str, language: str, limit: int) -> list[str]:
    if text_unit_count(sentence) <= limit:
        return [sentence]
    points = _safe_split_points(sentence, language)
    if not points:
        return [sentence]
    total = text_unit_count(sentence)
    # Split where the two halves are most even; each half is split again if needed.
    best = min(points, key=lambda index: abs(text_unit_count(sentence[:index]) - total / 2))
    first, second = _split_at(sentence, best, language)
    return _split_sentence(first, language, limit) + _split_sentence(second, language, limit)


def split_overlong_sentences(section_body: str, *, language: str | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Split overlong sentences of a section body where no word needs to change.

    Only prose lines are touched; headings, tables, images, lists and fenced
    blocks are copied unchanged. Each split replaces one top-level semicolon
    with a full stop (capitalizing the next English word), so every number,
    citation marker and word stays byte-identical.
    """
    body = str(section_body or "")
    language = language or readability_language_for_text(body)
    limit = sentence_length_limit(language)
    splits: list[dict[str, Any]] = []
    out_lines: list[str] = []
    in_fence = False
    for line in body.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if in_fence or not _prose_line(line):
            out_lines.append(line)
            continue
        rebuilt: list[str] = []
        for sentence in line_sentences(line):
            core = sentence.strip()
            if text_unit_count(core) <= limit:
                rebuilt.append(sentence)
                continue
            parts = _split_sentence(core, language, limit)
            if len(parts) == 1:
                rebuilt.append(sentence)
                continue
            leading = sentence[: len(sentence) - len(sentence.lstrip())]
            joiner = "" if language == "zh" else " "
            rebuilt.append(leading + joiner.join(parts))
            splits.append({"original": core, "parts": parts, "language": language, "threshold": limit})
        out_lines.append("".join(rebuilt))
    return "\n".join(out_lines), splits


# ── document level ─────────────────────────────────────────────────────────


def _interpretive_section_spans(manuscript: str) -> list[tuple[str, int, int]]:
    """(heading, body start, body end) of the H2 sections the gate measures.

    Only the main article is measured: the scan stops at the supplementary
    material or the reference list, as the gate's does.
    """
    from new_meta.core.artifact_package_manifest import _main_article_text_before_supplement

    text = str(manuscript or "")
    limit = len(_main_article_text_before_supplement(text))
    headings = [match for match in re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.M) if match.start() < limit]
    spans: list[tuple[str, int, int]] = []
    for index, match in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else limit
        heading = match.group(1).strip()
        if heading.lower() in OVERLONG_SENTENCE_SECTIONS:
            spans.append((heading, match.end(), min(end, limit)))
    return spans


def split_interpretive_sections(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Apply :func:`split_overlong_sentences` to every section the gate measures."""
    text = str(manuscript or "")
    splits: list[dict[str, Any]] = []
    for heading, start, end in reversed(_interpretive_section_spans(text)):
        body = text[start:end]
        language = readability_language_for_text(re.sub(r"```.*?```", "", body, flags=re.S))
        new_body, section_splits = split_overlong_sentences(body, language=language)
        for item in section_splits:
            item["section"] = heading
        splits = section_splits + splits
        text = text[:start] + new_body + text[end:]
    return text, splits


def overlong_interpretive_sentences(manuscript: str) -> list[dict[str, Any]]:
    """The sentences the readability gate would report as overlong."""
    text = str(manuscript or "")
    found: list[dict[str, Any]] = []
    for heading, start, end in _interpretive_section_spans(text):
        body = re.sub(r"```.*?```", "", text[start:end], flags=re.S)
        for item in overlong_sentences(body):
            found.append({**item, "section": heading})
    return found


# ── a model's split, checked ──────────────────────────────────────────────

# Words whose loss or gain would change what a sentence claims.
_ZH_MEANING_MARKERS = ("不", "未", "无", "非", "没", "否", "可能", "或", "尚")
_EN_MEANING_MARKERS = ("not", "no", "never", "without", "cannot", "may", "might", "could", "or", "only")
_CITATION_MARKER = re.compile(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]")


def _citation_anchors(text: str) -> list[tuple[str, str]]:
    """Each citation marker with the four word characters it is attached to."""
    anchors = []
    for match in _CITATION_MARKER.finditer(text):
        before = re.sub(r"[^\w一-鿿]", "", text[: match.start()])[-4:]
        anchors.append((re.sub(r"\s+", "", match.group(0)), before))
    return anchors


def sentence_split_issues(original: str, replacement: str, *, language: str) -> list[str]:
    """Return why ``replacement`` is not a faithful split of ``original`` (empty when it is).

    A faithful split keeps every number, citation marker (attached to the same
    words), table or figure reference, protected term, Latin word, negation and
    hedge; it may change punctuation and add or drop a few connective
    characters; and every resulting sentence is within the limit.
    """
    from collections import Counter

    from new_meta.core.manuscript_polish import (
        _numeric_tokens,
        _protected_factual_terms,
        _table_or_figure_refs,
    )

    issues: list[str] = []
    original = str(original or "").strip()
    replacement = str(replacement or "").strip()
    if not replacement or replacement == original:
        return ["unchanged"]
    limit = sentence_length_limit(language)
    sentences = readability_sentence_segments(replacement)
    if len(sentences) < 2:
        issues.append("not_split")
    if any(text_unit_count(sentence) > limit for sentence in sentences):
        issues.append("still_overlong")
    if _numeric_tokens(original) != _numeric_tokens(replacement):
        issues.append("numbers_changed")
    if _citation_anchors(original) != _citation_anchors(replacement):
        issues.append("citations_changed_or_moved")
    if _table_or_figure_refs(original) != _table_or_figure_refs(replacement):
        issues.append("cross_references_changed")
    if sorted(_protected_factual_terms(original)) != sorted(_protected_factual_terms(replacement)):
        issues.append("protected_terms_changed")
    original_words = Counter(word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'-]*", original))
    replacement_words = Counter(word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'-]*", replacement))
    if language == "zh":
        if original_words != replacement_words:
            issues.append("latin_words_changed")
        markers = [(marker, original.count(marker), replacement.count(marker)) for marker in _ZH_MEANING_MARKERS]
        original_cjk = Counter(re.findall(r"[一-鿿]", original))
        replacement_cjk = Counter(re.findall(r"[一-鿿]", replacement))
        dropped = sum((original_cjk - replacement_cjk).values())
        added = sum((replacement_cjk - original_cjk).values())
        if dropped > 4 or added > max(8, int(0.1 * sum(original_cjk.values()))):
            issues.append("wording_changed")
    else:
        if original_words - replacement_words:
            issues.append("words_dropped")
        if sum((replacement_words - original_words).values()) > 4:
            issues.append("words_added")
        markers = [
            (marker, original_words.get(marker, 0), replacement_words.get(marker, 0))
            for marker in _EN_MEANING_MARKERS
        ]
    if any(before != after for _marker, before, after in markers):
        issues.append("negation_or_hedge_changed")
    return issues
