"""ADR-term normalization: Chinese/English free text -> MedDRA PT.

Deterministic resolution (``normalize_adr``), in order:
1. exact hit in the built-in Chinese map (``adr_map.ZH_TO_PT``);
2. exact hit in the English alias map (curated clinical synonyms);
3. the FAERS reaction vocabulary (``vocabulary.py``): the term itself, or a
   variant that differs only in punctuation, American/British spelling or a
   singular/plural word -- each variant confirmed by vocabulary membership;
4. unresolved: fuzzy candidates with confidence 0.0, never a silent guess.

``normalize_adr_async`` adds two confirmations for what the rules cannot
decide: an English term outside the shipped vocabulary is accepted when
openFDA counts at least one report under exactly that reaction; and a synonym
or lay term ("heart racing", 心慌) may be interpreted by the model, whose
answer is used only if it resolves deterministically in step 1-3 or openFDA
confirms it the same way. An unconfirmed model answer stays a candidate.
"""

from __future__ import annotations

from typing import Protocol

from safety_agent.core.exceptions import NoResults
from safety_agent.core.logging import get_logger

from .adr_map import EN_ALIAS_TO_PT, ZH_TO_PT
from .drugs import contains_cjk
from .types import NormalizationCandidate, NormalizationResult
from .vocabulary import VocabularyAmbiguity, VocabularyMatch, canonical, load_vocabulary

logger = get_logger(__name__)


def normalize_adr(query: str) -> NormalizationResult:
    """Normalize one ADR query; never raises on ordinary bad input."""
    raw = query or ""
    cleaned = " ".join(raw.split())
    if not cleaned:
        return NormalizationResult(
            query=raw, normalized=None, candidates=[], confidence=0.0, method="empty"
        )

    # Chinese terms carry no word spaces: "QT 间期延长" is "qt间期延长".
    zh_key = "".join(cleaned.split()).casefold() if contains_cjk(cleaned) else cleaned
    zh_hit = ZH_TO_PT.get(zh_key)
    if zh_hit is not None:
        return _resolved(raw, zh_hit, "zh-map", 1.0)

    lowered = canonical(cleaned)
    alias_hit = EN_ALIAS_TO_PT.get(lowered)
    if alias_hit is not None:
        return _resolved(raw, alias_hit, "en-alias", 1.0)

    vocabulary = load_vocabulary()
    match = vocabulary.resolve(cleaned)
    if isinstance(match, VocabularyMatch):
        return _resolved(raw, match.term, match.method, match.confidence)
    if isinstance(match, VocabularyAmbiguity):
        return NormalizationResult(
            query=raw,
            normalized=None,
            candidates=[
                NormalizationCandidate(term=term, source="ambiguous", score=0.5)
                for term in match.terms[:5]
            ],
            confidence=0.0,
            method="ambiguous",
        )

    # Unresolved: candidates only. A Chinese query has no English near-spelling.
    candidates = (
        []
        if contains_cjk(cleaned)
        else [
            NormalizationCandidate(
                term=term, source="fuzzy" if score > 0.5 else "substring", score=score
            )
            for term, score in vocabulary.candidates(cleaned)
        ]
    )
    return NormalizationResult(
        query=raw,
        normalized=None,
        candidates=candidates,
        confidence=0.0,
        method="unresolved",
    )


class AdrTermLLMFallback(Protocol):
    """LLM seam for terms the rules cannot map (see llm/fallbacks.py)."""

    async def suggest_adr_pt(self, query: str) -> str | None: ...


class ReactionCounter(Protocol):
    """The part of ``OpenFDAClient`` confirmation needs."""

    async def count_total(self, search: str | None = None) -> int: ...


async def confirmed_by_openfda(client: ReactionCounter | None, term: str) -> bool:
    """True when FAERS holds at least one report under exactly this reaction."""
    from safety_agent.openfda.queries import reaction_clause

    if client is None or not term or contains_cjk(term):
        return False
    try:
        return await client.count_total(reaction_clause(term, exact=True)) > 0
    except NoResults:
        return False
    except Exception as exc:  # confirmation is a lookup; its failure is visible, not fatal
        logger.warning("openFDA confirmation of reaction %r failed: %s", term, exc)
        return False


async def normalize_adr_async(
    query: str,
    *,
    llm_fallback: AdrTermLLMFallback | None = None,
    client: ReactionCounter | None = None,
) -> NormalizationResult:
    """normalize_adr, then openFDA confirmation, then a confirmed model reading.

    ``client`` is the openFDA client (``count_total``); without it only the
    shipped vocabulary can confirm a term. Every failure keeps the
    unresolved result and its candidates.
    """
    result = normalize_adr(query)
    if result.normalized is not None or result.method in {"empty", "ambiguous"}:
        return result
    cleaned = canonical(query)

    # An English term the vocabulary has not seen may still be a FAERS PT.
    if await confirmed_by_openfda(client, cleaned):
        return _resolved(query or "", cleaned, "openfda-confirmed", 0.9)

    if llm_fallback is None:
        return result
    try:
        suggestion = await llm_fallback.suggest_adr_pt(" ".join((query or "").split()))
    except Exception as exc:  # LLM is advisory; degradation must be visible
        logger.warning("LLM ADR-term fallback failed: %s", exc)
        return result
    if not suggestion:
        return result
    re_resolved = normalize_adr(suggestion)
    if re_resolved.normalized is not None:
        return _resolved(query or "", re_resolved.normalized, "llm-fallback", 0.6)
    proposed = canonical(suggestion)
    if await confirmed_by_openfda(client, proposed):
        return _resolved(query or "", proposed, "llm-fallback", 0.5)
    # Neither the vocabulary nor openFDA knows the model's answer: it is
    # offered for a person to confirm and never used as the analysed term.
    return NormalizationResult(
        query=query or "",
        normalized=None,
        candidates=[
            NormalizationCandidate(term=proposed, source="llm-unconfirmed", score=0.3),
            *result.candidates,
        ],
        confidence=0.0,
        method="unresolved",
    )


def _resolved(query: str, term: str, method: str, confidence: float) -> NormalizationResult:
    return NormalizationResult(
        query=query,
        normalized=term,
        candidates=[NormalizationCandidate(term=term, source=method, score=confidence)],
        confidence=confidence,
        method=method,
    )
