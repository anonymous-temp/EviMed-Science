"""Deterministic, dependency-light draft quality scorer.

This module scores a generated manuscript WITHOUT any LLM or network access so
it can be used as a regression gate across many topics (including topics the
pipeline has never seen). It deliberately works on plain text plus the JSON
artifacts already written by the pipeline (``manuscript_facts.json`` and
``analysis/meta_results.json``); it does NOT require a live ``Project`` object,
so it can audit any existing ``output/.../manuscript/draft.md`` after the fact.

It reuses the existing primitives in :mod:`new_meta.core.manuscript_text_metrics`
(word count, style audit, hard quality gate, reference-section integrity) and
ADDS the checks that were previously done ad hoc or not at all:

* near-duplicate / robotic-doubling sentence detection (a known failure mode);
* citation-marker ↔ reference-entry consistency (unused / dangling references);
* prose ↔ ``manuscript_facts`` numeric consistency for the headline estimate.

The output is a single ``score`` (0-100) and a ``gate`` (pass/warn/fail) so that
batch runs over different topics are directly comparable.
"""
from __future__ import annotations

import difflib
import re
from typing import Any

from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    manuscript_quality_gate,
    manuscript_style_audit,
    publication_min_main_words,
)

# ─────────────────────────── text segmentation ───────────────────────────

_REFERENCE_HEADING = re.compile(
    r"^##\s+(?:References?|参考文献|引用文献|文献)\s*$", flags=re.M
)
_SUPPLEMENT_HEADING = re.compile(
    r"^##\s+(?:Supplementary Materials|Supplement|附录|补充材料)\s*$", flags=re.M
)
_CITATION_CLUSTER = re.compile(r"[\[［]\s*([0-9][0-9\s,，、;；\-–—至]*)\s*[\]］]")
_ABSTRACT_HEADING = re.compile(r"^##\s+(?:Abstract|摘要)\s*$", flags=re.M)


def _body_before_references(text: str) -> str:
    raw = str(text or "")
    match = _REFERENCE_HEADING.search(raw)
    return raw[: match.start()] if match else raw


def _drop_abstract(text: str) -> str:
    """Remove the Abstract section.

    The Abstract is, by definition, a condensed restatement of the body, so an
    Abstract sentence that echoes a Results/Conclusion sentence is correct
    manuscript structure, not a robotic doubling. Excluding the Abstract from
    duplicate detection prevents penalizing well-formed manuscripts and keeps
    the detector focused on genuine intra-body repetition.
    """
    raw = str(text or "")
    match = _ABSTRACT_HEADING.search(raw)
    if not match:
        return raw
    rest = raw[match.end():]
    nxt = re.search(r"^##\s+", rest, flags=re.M)
    return raw[: match.start()] + (rest[nxt.start():] if nxt else "")


def _main_prose_body(text: str) -> str:
    """Main narrative text only: drops tables, figures, supplements, refs, code."""
    raw = _body_before_references(text)
    sup = _SUPPLEMENT_HEADING.search(raw)
    if sup:
        raw = raw[: sup.start()]
    # Cut at Tables / Figures sections — those are not prose.
    cut = [
        pos
        for marker in ("## Tables", "## Figures", "## 表格", "## 图")
        if (pos := raw.find(marker)) >= 0
    ]
    if cut:
        raw = raw[: min(cut)]
    raw = re.sub(r"```.*?```", " ", raw, flags=re.S)
    return raw


def _prose_paragraphs(text: str) -> list[str]:
    paragraphs: list[str] = []
    for para in re.split(r"\n\s*\n+", str(text or "")):
        stripped = para.strip()
        if not stripped:
            continue
        # Headings are often adjacent to the first sentence in synthetic test
        # fixtures and some generated drafts. Drop only the heading line instead
        # of discarding the whole paragraph, otherwise cross-section duplicate
        # prose immediately after a heading becomes invisible to the audit.
        stripped = "\n".join(
            line for line in stripped.splitlines() if not line.lstrip().startswith("#")
        ).strip()
        if not stripped or stripped.startswith(("|", "![", "- ", "* ", "```", ">")):
            continue
        if "\n|" in stripped or stripped.startswith(("Legend:", "Note:", "图注", "注:")):
            continue
        paragraphs.append(re.sub(r"\s+", " ", stripped))
    return paragraphs


def _split_sentences(paragraph: str) -> list[str]:
    text = re.sub(r"\s+", " ", str(paragraph or "")).strip()
    if not text:
        return []
    return [
        item.strip()
        for item in re.split(r"(?<=[.!?。！？])\s+(?=[A-Z0-9一-鿿])", text)
        if item.strip()
    ]


# ─────────────────────────── citation consistency ───────────────────────────

def expand_citation_numbers(inner: str) -> list[int]:
    """Expand the inside of one citation cluster (e.g. ``5,8-10,12``)."""
    numbers: list[int] = []
    for token in re.split(r"[,，、;；\s]+", str(inner or "").strip()):
        if not token:
            continue
        range_match = re.fullmatch(r"(\d+)\s*[\-–—至]\s*(\d+)", token)
        if range_match:
            lo, hi = int(range_match.group(1)), int(range_match.group(2))
            if lo <= hi and hi - lo <= 200:
                numbers.extend(range(lo, hi + 1))
            continue
        if token.isdigit():
            numbers.append(int(token))
    return numbers


def cited_reference_numbers(text: str) -> set[int]:
    """All distinct reference numbers cited in the main body (not the ref list)."""
    body = _body_before_references(text)
    cited: set[int] = set()
    for match in _CITATION_CLUSTER.finditer(body):
        cited.update(expand_citation_numbers(match.group(1)))
    return cited


def _reference_entry_numbers(text: str) -> list[int]:
    raw = str(text or "")
    match = _REFERENCE_HEADING.search(raw)
    if not match:
        return []
    body = raw[match.end():]
    nxt = re.search(r"^##\s+", body, flags=re.M)
    if nxt:
        body = body[: nxt.start()]
    numbers: list[int] = []
    for entry in re.finditer(r"^[\[［](\d+)[\]］]", body, flags=re.M):
        numbers.append(int(entry.group(1)))
    return numbers


def citation_reference_consistency(text: str) -> dict:
    cited = cited_reference_numbers(text)
    entries = _reference_entry_numbers(text)
    entry_set = set(entries)
    max_entry = max(entry_set) if entry_set else 0
    unused = sorted(entry_set - cited)
    dangling = sorted(num for num in cited if num not in entry_set)
    return {
        "cited_unique": len(cited),
        "reference_entries": len(entries),
        "unused_references": unused,
        "dangling_citations": dangling,  # cited but no matching reference entry
        "max_reference_number": max_entry,
    }


# ─────────────────────────── duplicate sentences ───────────────────────────

def _normalize_sentence(sentence: str) -> str:
    text = re.sub(r"[\[［][^\]］]*[\]］]", " ", str(sentence or ""))  # drop citations
    text = text.lower()
    text = re.sub(r"[^a-z0-9一-鿿]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def find_near_duplicate_sentences(
    text: str,
    *,
    ratio_threshold: float = 0.82,
    min_chars: int = 40,
    max_sentences: int = 800,
) -> list[dict]:
    """Detect robotic doublings: exact (citation-stripped) or near-duplicate
    sentences in the main prose. Catches both 'same sentence twice in two
    sections' and 'two adjacent sentences that say the same thing'."""
    sentences: list[str] = []
    for paragraph in _prose_paragraphs(_drop_abstract(_main_prose_body(text))):
        sentences.extend(_split_sentences(paragraph))
        if len(sentences) >= max_sentences:
            break
    normalized = [_normalize_sentence(s) for s in sentences]

    findings: list[dict] = []
    seen_pairs: set[tuple[int, int]] = set()

    # 1) exact normalized duplicates (strongest signal)
    by_norm: dict[str, list[int]] = {}
    for idx, norm in enumerate(normalized):
        if len(norm) >= min_chars:
            by_norm.setdefault(norm, []).append(idx)
    for norm, idxs in by_norm.items():
        if len(idxs) >= 2:
            i, j = idxs[0], idxs[1]
            seen_pairs.add((i, j))
            findings.append({
                "type": "exact",
                "ratio": 1.0,
                "count": len(idxs),
                "a": sentences[i][:200],
                "b": sentences[j][:200],
            })

    # 2) high-ratio near-duplicates (paraphrased doublings)
    n = len(sentences)
    for i in range(n):
        if len(normalized[i]) < min_chars:
            continue
        # compare to a sliding window to keep it O(n*W) and bias toward
        # nearby duplications, but also check all for cross-section repeats.
        for j in range(i + 1, n):
            if len(normalized[j]) < min_chars:
                continue
            if (i, j) in seen_pairs:
                continue
            if abs(len(normalized[i]) - len(normalized[j])) > max(len(normalized[i]), len(normalized[j])) * 0.5:
                continue
            ratio = difflib.SequenceMatcher(None, normalized[i], normalized[j]).ratio()
            if ratio >= ratio_threshold:
                seen_pairs.add((i, j))
                findings.append({
                    "type": "near",
                    "ratio": round(ratio, 3),
                    "count": 2,
                    "a": sentences[i][:200],
                    "b": sentences[j][:200],
                })
    findings.sort(key=lambda f: (-f["ratio"], f["type"]))
    return findings


# ─────────────────────────── fact consistency ───────────────────────────

_OR_PATTERN = re.compile(
    r"\b(OR|RR|HR|SMD|MD|RD|IRR)\s*[:=]?\s*(-?\d+\.\d+)\s*"
    r"[\(（]\s*95%\s*CI[:=\s]*(-?\d+\.\d+)\s*(?:to|至|,|，|-|–|—)\s*(-?\d+\.\d+)",
    flags=re.I,
)
_I2_PATTERN = re.compile(r"I[²2]\s*[=＝]?\s*(\d+(?:\.\d+)?)\s*%?", flags=re.I)


def _round(value: Any, ndigits: int) -> float | None:
    try:
        return round(float(value), ndigits)
    except (TypeError, ValueError):
        return None


def fact_consistency(text: str, facts: dict | None) -> dict:
    """Compare the headline estimate written in prose against manuscript_facts."""
    facts = facts if isinstance(facts, dict) else {}
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    if not primary:
        return {"status": "no_facts", "mismatches": []}

    body = _main_prose_body(text)
    mismatches: list[dict] = []

    fact_point = _round(primary.get("pooled_effect"), 2)
    fact_lo = _round(primary.get("ci_lower"), 2)
    fact_hi = _round(primary.get("ci_upper"), 2)
    fact_measure = str(primary.get("effect_measure") or "").upper()

    or_match = _OR_PATTERN.search(body)
    if or_match and fact_point is not None:
        prose_measure = or_match.group(1).upper()
        prose_point = _round(or_match.group(2), 2)
        prose_lo = _round(or_match.group(3), 2)
        prose_hi = _round(or_match.group(4), 2)
        if fact_measure and prose_measure and prose_measure != fact_measure:
            mismatches.append({
                "field": "effect_measure",
                "prose": prose_measure,
                "facts": fact_measure,
            })
        for name, prose_val, fact_val in (
            ("pooled_effect", prose_point, fact_point),
            ("ci_lower", prose_lo, fact_lo),
            ("ci_upper", prose_hi, fact_hi),
        ):
            if prose_val is not None and fact_val is not None and abs(prose_val - fact_val) > 0.01:
                mismatches.append({"field": name, "prose": prose_val, "facts": fact_val})

    fact_i2 = _round(primary.get("i_squared"), 1)
    i2_match = _I2_PATTERN.search(body)
    if i2_match and fact_i2 is not None:
        prose_i2 = _round(i2_match.group(1), 1)
        if prose_i2 is not None and abs(prose_i2 - fact_i2) > 0.6:
            mismatches.append({"field": "i_squared", "prose": prose_i2, "facts": fact_i2})

    return {
        "status": "checked" if or_match else "no_estimate_in_prose",
        "mismatches": mismatches,
    }


# ─────────────────────────── orchestration / score ───────────────────────────

def audit_draft(
    draft_text: str,
    *,
    facts: dict | None = None,
    meta_results: dict | None = None,
) -> dict:
    """Score one manuscript. Returns metrics, issues, a 0-100 score and a gate."""
    text = str(draft_text or "")
    facts = facts if isinstance(facts, dict) else {}

    style = manuscript_style_audit(text)
    gate = manuscript_quality_gate(text, facts, style_audit=style)
    citations = citation_reference_consistency(text)
    duplicates = find_near_duplicate_sentences(text)
    facts_check = fact_consistency(text, facts)

    main_words = main_publication_word_count(text)
    min_words = publication_min_main_words(facts) if facts else 0

    hard_errors = [i for i in gate.get("issues", []) if i.get("severity") == "error"]
    fact_mismatches = facts_check.get("mismatches", [])
    exact_dups = [d for d in duplicates if d["type"] == "exact"]
    near_dups = [d for d in duplicates if d["type"] == "near"]

    # Distinguish a publication manuscript from an evidence-gap / narrative /
    # blocked report. The pipeline deliberately emits a non-publication report when
    # the evidence is not ready (e.g. only abstract-level data was recovered). That
    # report must NOT be scored as a publishable manuscript — otherwise a thin,
    # reference-less gap report scores as "pass" and the gate becomes untrustworthy.
    report_type = str(facts.get("report_type") or facts.get("manuscript_mode") or "").strip().lower()
    readiness = facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {}
    blocked = str(readiness.get("status") or "").strip().lower() == "blocked"
    non_publication = blocked or report_type in {"evidence_gap", "narrative", "blocked"}

    summary = {
        "report_type": report_type or ("meta" if not non_publication else "unknown"),
        "is_publication_manuscript": not non_publication,
        "main_word_count": main_words,
        "min_main_words": min_words,
        "reference_entries": citations["reference_entries"],
        "cited_unique": citations["cited_unique"],
        "unused_references": len(citations["unused_references"]),
        "dangling_citations": len(citations["dangling_citations"]),
        "exact_duplicate_sentences": len(exact_dups),
        "near_duplicate_sentences": len(near_dups),
        "fact_mismatches": len(fact_mismatches),
        "hard_errors": len(hard_errors),
        "long_paragraphs": int(style["summary"].get("long_paragraph_count") or 0),
    }
    common = {
        "schema_version": 1,
        "summary": summary,
        "fact_consistency": facts_check,
        "citation_consistency": citations,
        "duplicate_sentences": duplicates,
        "quality_gate_issues": gate.get("issues", []),
        "style_summary": style.get("summary", {}),
    }

    if non_publication:
        # Not a publishable manuscript: report its mode rather than a pass/fail score.
        return {**common, "score": None, "gate": report_type or "blocked"}

    # ---- weighted penalty model for publication manuscripts (tunable) ----
    no_references = citations["reference_entries"] == 0
    score = 100.0
    score -= 12.0 * len(hard_errors)              # reference corruption, jargon leak, etc.
    score -= 15.0 * len(fact_mismatches)          # wrong headline numbers: severe
    score -= 6.0 * len(exact_dups)                # verbatim doubling
    score -= 3.0 * min(len(near_dups), 8)         # paraphrased doubling (capped)
    score -= 2.0 * min(len(citations["dangling_citations"]), 10)
    score -= 1.0 * min(len(citations["unused_references"]), 10)
    score -= 2.0 * min(int(style["summary"].get("long_paragraph_count") or 0), 6)
    if min_words and main_words < min_words:
        score -= 5.0
    # A publication manuscript that renders no references is not publishable, even
    # if every other check is clean.
    if no_references:
        score -= 40.0
    elif citations["reference_entries"] < 5:
        score -= 10.0
    score = max(0.0, min(100.0, score))

    if hard_errors or fact_mismatches or exact_dups or no_references:
        gate_label = "fail"
    elif score >= 85.0:
        gate_label = "pass"
    elif score >= 70.0:
        gate_label = "warn"
    else:
        gate_label = "fail"

    return {**common, "score": round(score, 1), "gate": gate_label}


def audit_project_dir(project_dir: str) -> dict:
    """Audit an existing output directory (``.../<run>/`` containing manuscript/)."""
    import json
    from pathlib import Path

    base = Path(project_dir)
    draft_path = base / "manuscript" / "draft.md"
    if not draft_path.exists():
        return {"error": f"no manuscript/draft.md under {base}", "project_dir": str(base)}

    def _load(rel: str) -> dict | None:
        path = base / rel
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (ValueError, OSError):
            return None

    facts = _load("manuscript/manuscript_facts.json")
    meta_results = _load("analysis/meta_results.json")
    result = audit_draft(
        draft_path.read_text(encoding="utf-8", errors="replace"),
        facts=facts,
        meta_results=meta_results,
    )
    result["project_dir"] = str(base)
    result["has_facts"] = facts is not None
    return result
