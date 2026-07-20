"""Shared result types for the normalization layer."""

from __future__ import annotations

from pydantic import BaseModel, Field


class NormalizationCandidate(BaseModel):
    """One possible normalized term, best first."""

    term: str
    source: str  # e.g. "rule", "brand-map", "openfda", "llm-fallback"
    score: float = Field(ge=0.0, le=1.0)


class NormalizationResult(BaseModel):
    """Outcome of normalizing one free-text query.

    ``normalized`` is the term to use for downstream openFDA queries; it is
    None when nothing could be resolved (callers then answer 400, never
    crash). ``confidence`` mirrors the strength of the evidence.
    """

    query: str
    normalized: str | None
    candidates: list[NormalizationCandidate] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
