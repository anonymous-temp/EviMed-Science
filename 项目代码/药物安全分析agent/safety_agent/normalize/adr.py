"""ADR-term normalization: Chinese/English free text -> MedDRA PT.

Resolution order:
1. exact hit in the built-in Chinese map (``adr_map.ZH_TO_PT``);
2. exact hit in the English alias map, or the term already being a known PT;
3. unresolved: return fuzzy candidates (``difflib`` over known PTs) with
   confidence 0.0 so the caller can ask the user to pick — and, from P4 on,
   optionally consult the LLM fallback before giving up.
"""

from __future__ import annotations

import difflib

from safety_agent.core.logging import get_logger

from .adr_map import EN_ALIAS_TO_PT, ZH_TO_PT, all_known_pts
from .drugs import contains_cjk
from .types import NormalizationCandidate, NormalizationResult

logger = get_logger(__name__)


def normalize_adr(query: str) -> NormalizationResult:
    """Normalize one ADR query; never raises on ordinary bad input."""
    raw = query or ""
    cleaned = " ".join(raw.split())
    if not cleaned:
        return NormalizationResult(
            query=raw, normalized=None, candidates=[], confidence=0.0, method="empty"
        )

    zh_hit = ZH_TO_PT.get(cleaned)
    if zh_hit is not None:
        return NormalizationResult(
            query=raw,
            normalized=zh_hit,
            candidates=[NormalizationCandidate(term=zh_hit, source="zh-map", score=1.0)],
            confidence=1.0,
            method="zh-map",
        )

    lowered = cleaned.lower()
    alias_hit = EN_ALIAS_TO_PT.get(lowered)
    if alias_hit is not None:
        return NormalizationResult(
            query=raw,
            normalized=alias_hit,
            candidates=[NormalizationCandidate(term=alias_hit, source="en-alias", score=1.0)],
            confidence=1.0,
            method="en-alias",
        )
    if lowered in all_known_pts():
        return NormalizationResult(
            query=raw,
            normalized=lowered,
            candidates=[NormalizationCandidate(term=lowered, source="pt-direct", score=1.0)],
            confidence=1.0,
            method="pt-direct",
        )

    # Unresolved: fuzzy candidates only, no silent guessing.
    pool = sorted(all_known_pts())
    close = difflib.get_close_matches(lowered, pool, n=5, cutoff=0.6)
    contains = [pt for pt in pool if lowered in pt and pt not in close][:5]
    candidates = [
        NormalizationCandidate(term=pt, source="fuzzy", score=round(score, 4))
        for pt, score in zip(close, _scores(lowered, close), strict=True)
    ]
    candidates.extend(
        NormalizationCandidate(term=pt, source="substring", score=0.5) for pt in contains
    )
    return NormalizationResult(
        query=raw,
        normalized=None,
        candidates=candidates,
        confidence=0.0,
        method="unresolved",
    )


class AdrTermLLMFallback:
    """LLM seam for unmapped ADR terms (see llm/fallbacks.py). Protocol."""

    async def suggest_adr_pt(self, query: str) -> str | None: ...


async def normalize_adr_async(
    query: str, *, llm_fallback: "AdrTermLLMFallback | None" = None
) -> NormalizationResult:
    """normalize_adr plus an optional LLM translation fallback for CJK terms.

    Deterministic resolution runs first (map/alias/fuzzy). Only when the
    query is unresolved AND carries CJK characters is the fallback asked
    for a MedDRA PT; the suggested PT is then re-validated through the
    same deterministic checks (it may itself be a known PT or alias).
    Failures keep the unresolved result — never a silent guess.
    """
    result = normalize_adr(query)
    if result.normalized is not None or llm_fallback is None:
        return result
    cleaned = " ".join((query or "").split())
    if not cleaned or not contains_cjk(cleaned):
        return result
    try:
        suggestion = await llm_fallback.suggest_adr_pt(cleaned)
    except Exception as exc:  # LLM is advisory; degradation must be visible
        logger.warning("LLM ADR-term fallback failed: %s", exc)
        return result
    if not suggestion:
        return result
    # The translated term goes through the deterministic resolver again so
    # casing/aliases stay consistent with the rest of the pipeline.
    re_resolved = normalize_adr(suggestion)
    if re_resolved.normalized is not None:
        return NormalizationResult(
            query=query or "",
            normalized=re_resolved.normalized,
            candidates=[
                NormalizationCandidate(
                    term=re_resolved.normalized, source="llm-fallback", score=0.6
                )
            ],
            confidence=0.6,
            method="llm-fallback",
        )
    # Unknown but plausible English PT: accept at low confidence — the
    # downstream openFDA query decides whether any reports exist.
    lowered = " ".join(suggestion.lower().split())
    return NormalizationResult(
        query=query or "",
        normalized=lowered,
        candidates=[NormalizationCandidate(term=lowered, source="llm-fallback", score=0.4)],
        confidence=0.4,
        method="llm-fallback",
    )


def _scores(query: str, matches: list[str]) -> list[float]:
    return [difflib.SequenceMatcher(None, query, m).ratio() for m in matches]
