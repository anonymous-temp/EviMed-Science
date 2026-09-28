"""Generate the main-text cross-references to a manuscript's own tables and figures.

Tables and figures are rendered by the assembler; the prose that introduces
them is written by the model and can drop "see Table 2" without noticing. The
cross-reference gate requires every defined table and figure to be cited in the
main text, so the reference is generated here from the defined items, never
typed: each unreferenced item gets one short sentence appended to the Results
paragraph that reports what it shows, or to the end of Results.

Placement is by the item's own title (the assembler's closed set of table and
figure titles) and by the facts the paragraph reports (the PRISMA count, the
pooled estimate, the certainty rating). The sentences carry no number other
than the item label, and avoid wording the citation audit reads as a
quantitative claim ("合并估计", "pooled estimate"); a Chinese sentence starts
with a CJK character so it is not read as part of the sentence before it.
"""
from __future__ import annotations

import re
from typing import Any

from new_meta.core.artifact_package_manifest import (
    _main_text_before_tables_and_figures,
    _numbered_heading_refs,
    _numbered_text_refs,
)

# (kind, title keywords). Ordered: the first matching kind wins.
_ITEM_KINDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("prisma", ("prisma", "流程", "flow diagram", "study selection")),
    ("forest", ("森林", "forest")),
    ("funnel", ("漏斗", "funnel")),
    ("sensitivity", ("剔除", "敏感", "leave-one-out", "sensitivity", "influence")),
    ("rob", ("偏倚", "risk of bias", "risk-of-bias", "rob ")),
    ("grade", ("grade", "证据概要", "certainty", "确定性")),
    ("absolute", ("绝对", "absolute")),
    ("effects", ("研究层", "study-level", "study level", "效应", "estimate", "effect", "weight")),
    ("characteristics", ("特征", "characteristic", "基本", "included stud")),
)

_SENTENCES = {
    "prisma": ("检索与筛选流程见{label}。", "The study selection flow is shown in {label}."),
    "characteristics": ("纳入研究的基本特征见{label}。", "Characteristics of the included studies are listed in {label}."),
    "effects": (
        "各研究的效应量、标准误和权重见{label}。",
        "Study-level effect sizes, standard errors, and weights are given in {label}.",
    ),
    "forest": ("各研究结果的森林图见{label}。", "The forest plot is shown in {label}."),
    "funnel": ("漏斗图见{label}。", "The funnel plot is shown in {label}."),
    "sensitivity": ("敏感性分析结果见{label}。", "Sensitivity analyses are shown in {label}."),
    "rob": ("偏倚风险评价见{label}。", "Risk-of-bias judgements are summarized in {label}."),
    "grade": ("证据确定性（GRADE）概要见{label}。", "The GRADE evidence profile is given in {label}."),
    "absolute": ("绝对效应换算见{label}。", "Absolute-effect estimates are given in {label}."),
}

_RESULTS_HEADINGS = {"结果", "results", "result"}


def _item_kind(title: str) -> str:
    lowered = f"{str(title or '').lower()} "
    for kind, keywords in _ITEM_KINDS:
        if any(keyword in lowered for keyword in keywords):
            return kind
    return "other"


def _label(kind: str, number: int, zh: bool) -> str:
    if zh:
        return f"{'表' if kind == 'table' else '图'}{number}"
    return f"{'Table' if kind == 'table' else 'Figure'} {number}"


def _sentence(item: dict[str, Any], zh: bool) -> str:
    label = _label(item["artifact"], item["number"], zh)
    template = _SENTENCES.get(item["kind"])
    if template:
        return (template[0] if zh else template[1]).format(label=label)
    title = str(item.get("title") or "").strip().rstrip("。.")
    if zh:
        return f"{title}见{label}。" if title else f"详见{label}。"
    return f"{title} is shown in {label}." if title else f"See {label}."


def _format_number_tokens(value: Any) -> list[str]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return []
    tokens = [f"{number:.2f}"]
    if number.is_integer():
        tokens.append(str(int(number)))
    return tokens


def _anchor_terms(kind: str, facts: dict[str, Any]) -> tuple[list[str], list[str]]:
    """(fact tokens, fallback keywords) that mark the paragraph reporting an item."""
    prisma = facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {}
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
    if kind == "prisma":
        return _format_number_tokens(prisma.get("records_identified"))[1:], ["检索", "筛选", "search", "screen"]
    if kind == "characteristics":
        tokens = _format_number_tokens(population.get("selected_total_participants"))[1:]
        return tokens, ["纳入研究", "参与者", "受试者", "患者", "participants", "included stud"]
    if kind in {"effects", "forest", "sensitivity", "funnel", "absolute"}:
        tokens = _format_number_tokens(primary.get("pooled_effect"))[:1]
        keywords = ["合并", "pooled"]
        if kind == "absolute":
            keywords = ["绝对", "absolute"] + keywords
        return tokens, keywords
    if kind in {"grade", "rob"}:
        keywords = ["GRADE", "确定性", "certainty"]
        if kind == "rob":
            keywords = ["偏倚风险", "RoB", "risk of bias", "risk-of-bias"] + keywords
        return [], keywords
    return [], []


def _results_span(manuscript: str) -> tuple[int, int] | None:
    headings = list(re.finditer(r"^##\s+(.+?)\s*$", manuscript, flags=re.M))
    for index, match in enumerate(headings):
        if match.group(1).strip().lower() in _RESULTS_HEADINGS:
            end = headings[index + 1].start() if index + 1 < len(headings) else len(manuscript)
            return match.end(), end
    return None


def _prose_blocks(body: str) -> list[tuple[int, int]]:
    """Spans (within body) of the last prose line of each paragraph block."""
    blocks: list[tuple[int, int]] = []
    offset = 0
    for chunk in re.split(r"(\n\s*\n)", body):
        if not chunk.strip() or re.fullmatch(r"\n\s*\n", chunk):
            offset += len(chunk)
            continue
        line_start = offset
        last_prose: tuple[int, int] | None = None
        for line in chunk.split("\n"):
            stripped = line.strip()
            if stripped and not (
                stripped.startswith("#")
                or stripped.startswith("|")
                or stripped.startswith("![")
                or stripped.startswith("```")
            ):
                last_prose = (line_start, line_start + len(line.rstrip()))
            line_start += len(line) + 1
        if last_prose:
            blocks.append(last_prose)
        offset += len(chunk)
    return blocks


def _paragraph_for(kind: str, facts: dict[str, Any], body: str, blocks: list[tuple[int, int]]) -> int:
    if not blocks:
        return -1
    paragraphs = []
    for index, (_start, end) in enumerate(blocks):
        start = blocks[index - 1][1] if index else 0
        paragraphs.append(body[start:end])
    tokens, keywords = _anchor_terms(kind, facts)
    for token in tokens:
        pattern = rf"(?<![\d.]){re.escape(token)}(?![\d])"
        for index, text in enumerate(paragraphs):
            if re.search(pattern, text):
                return index
    for keyword in keywords:
        for index, text in enumerate(paragraphs):
            if keyword.lower() in text.lower():
                return index
    return len(blocks) - 1


def generate_table_figure_cross_references(
    manuscript: str,
    facts: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Cite every defined table and figure the main text does not yet cite.

    Returns the manuscript and one record per generated reference. Items that
    are already cited, and manuscripts without a Results section, are left as
    they are.
    """
    text = str(manuscript or "")
    facts = facts if isinstance(facts, dict) else {}
    main_text = _main_text_before_tables_and_figures(text)
    cited = {
        "table": set(_numbered_text_refs(main_text, "Table")),
        "figure": set(_numbered_text_refs(main_text, "Figure")),
    }
    missing: list[dict[str, Any]] = []
    for artifact, label in (("table", "Table"), ("figure", "Figure")):
        seen: set[int] = set()
        for ref in _numbered_heading_refs(text, label):
            number = ref.get("number")
            if not isinstance(number, int) or number in cited[artifact] or number in seen:
                continue
            seen.add(number)
            missing.append({
                "artifact": artifact,
                "number": number,
                "title": ref.get("title") or "",
                "kind": _item_kind(ref.get("title") or ""),
            })
    if not missing:
        return text, []
    span = _results_span(text)
    if span is None:
        return text, []
    body_start, body_end = span
    body = text[body_start:body_end]
    zh = bool(re.search(r"^#{1,4}\s+[表图]\s*\d", text, flags=re.M))
    blocks = _prose_blocks(body)
    if not blocks:
        return text, []
    additions: dict[int, list[str]] = {}
    records: list[dict[str, Any]] = []
    for item in missing:
        index = _paragraph_for(item["kind"], facts, body, blocks)
        sentence = _sentence(item, zh)
        additions.setdefault(index, []).append(sentence)
        records.append({**item, "sentence": sentence, "paragraph_index": index + 1})
    new_body = body
    for index in sorted(additions, reverse=True):
        _start, end = blocks[index]
        joiner = "" if zh else " "
        new_body = new_body[:end] + joiner + joiner.join(additions[index]) + new_body[end:]
    return text[:body_start] + new_body + text[body_end:], records
