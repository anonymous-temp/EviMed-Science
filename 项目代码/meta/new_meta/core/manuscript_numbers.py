"""The primary-analysis numbers as the engine renders them, for writers and a restore sweep.

The fact-locked article renders the pooled estimate, its confidence interval
and prediction interval with two decimals ("-303.23", "-504.52"). A model that
re-authors prose from the raw floats may round them ("-303.2"), which is a
different number to every check that compares the text with the computation
(principle 10c: numbers are rendered artifacts, not typed prose).

``rendered_primary_numbers`` gives writers the strings to copy.
``restore_rendered_primary_numbers`` is the sweep: in prose (never in a table
row or fenced block) a one-decimal rounding of exactly one of those values is
written back as the engine's two-decimal rendering. A token that could be
another fact's value is left alone.
"""
from __future__ import annotations

import re
from typing import Any

_PRIMARY_FACT_KEYS = ("pooled_effect", "ci_lower", "ci_upper", "prediction_lower", "prediction_upper")


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def rendered_primary_numbers(facts: dict | None) -> dict[str, str]:
    """The engine's two-decimal renderings of the primary estimate and its intervals."""
    primary = (facts or {}).get("primary_effect") if isinstance((facts or {}).get("primary_effect"), dict) else {}
    rendered: dict[str, str] = {}
    for key in _PRIMARY_FACT_KEYS:
        value = _float(primary.get(key))
        if value is not None:
            rendered[key] = f"{value:.2f}"
    return rendered


def _other_fact_numbers(facts: dict, excluded: set[float]) -> set[float]:
    """Every other number in the facts (study effects, counts), to avoid a false restore."""
    found: set[float] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            number = float(node)
            if number not in excluded:
                found.add(number)

    walk(facts)
    return found


def restore_rendered_primary_numbers(manuscript: str, facts: dict | None) -> tuple[str, list[dict[str, str]]]:
    """Write one-decimal roundings of the primary numbers back as the engine renders them."""
    text = str(manuscript or "")
    facts = facts if isinstance(facts, dict) else {}
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    values = {key: _float(primary.get(key)) for key in _PRIMARY_FACT_KEYS}
    values = {key: value for key, value in values.items() if value is not None}
    if not values:
        return text, []
    others = _other_fact_numbers(facts, set(values.values()))
    candidates: dict[str, str] = {}
    ambiguous: set[str] = set()
    for value in values.values():
        rounded = f"{value:.1f}"
        rendered = f"{value:.2f}"
        if rounded == rendered or rounded in ambiguous:
            continue
        clash = rounded in candidates and candidates[rounded] != rendered
        clash = clash or any(f"{other:.1f}" == rounded for other in others)
        clash = clash or any(f"{other:.2f}" == rounded for other in values.values())
        if clash:
            ambiguous.add(rounded)
            candidates.pop(rounded, None)
            continue
        candidates[rounded] = rendered
    if not candidates:
        return text, []
    pattern = re.compile(
        r"(?<![\d.\-])(" + "|".join(re.escape(token) for token in sorted(candidates, key=len, reverse=True)) + r")(?![\d])"
    )
    restored: list[dict[str, str]] = []
    out_lines: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
        if in_fence or stripped.startswith("```") or stripped.startswith("|"):
            out_lines.append(line)
            continue

        def replace(match: re.Match[str]) -> str:
            token = match.group(1)
            restored.append({"typed": token, "rendered": candidates[token]})
            return candidates[token]

        out_lines.append(pattern.sub(replace, line))
    return "\n".join(out_lines), restored
