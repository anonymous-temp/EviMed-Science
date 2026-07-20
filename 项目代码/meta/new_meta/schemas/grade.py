"""GRADE (Grading of Recommendations, Assessment, Development and Evaluations) data models."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class GRADEDomain(BaseModel):
    """Assessment of a single GRADE domain."""
    domain: str  # "risk_of_bias" / "inconsistency" / "indirectness" / "imprecision" / "publication_bias"
    rating: str  # "no concern" / "serious" / "very serious"
    rationale: str
    details: dict[str, Any] = Field(default_factory=dict)


class GRADEOutcome(BaseModel):
    """GRADE assessment for a single outcome."""
    outcome_name: str
    n_studies: int
    effect_summary: str  # e.g. "OR 0.72 (95% CI: 0.58 to 0.89)"
    certainty: str  # "High" / "Moderate" / "Low" / "Very low"
    domains: list[GRADEDomain] = []
    footnotes: list[str] = []


class GRADEProfile(BaseModel):
    """Complete GRADE evidence profile for all outcomes."""
    outcomes: list[GRADEOutcome] = []
