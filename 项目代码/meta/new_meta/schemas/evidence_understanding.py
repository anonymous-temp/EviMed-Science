"""LLM-generated evidence understanding models for manuscript authoring."""
from __future__ import annotations

from pydantic import BaseModel, Field


class SourceBackedClaim(BaseModel):
    """A manuscript-relevant claim grounded in a concrete source excerpt."""

    source_study_id: str = Field(default="", description="Study/source identifier supporting the claim.")
    reference_id: str = Field(default="", description="Reference identifier or PMID/DOI when available.")
    citation_marker: str = Field(default="", description="Approved citation marker once assigned.")
    claim: str = Field(default="", description="Concise claim that may be used in manuscript prose.")
    claim_type: str = Field(default="", description="background, study_design, result, safety, risk_of_bias, applicability, limitation, or interpretation.")
    support_level: str = Field(default="direct", description="direct, indirect, interpretive, or unsupported.")
    manuscript_use: str = Field(default="main", description="main, supplement, background, or exclude.")
    source_location: str = ""
    source_page: int | None = None
    source_quote: str = ""
    caveat: str = ""


class StudyIntelligenceCard(BaseModel):
    """A source-grounded study card created after the LLM has read the full text."""

    study_id: str = ""
    display_name: str = ""
    title: str = ""
    design: str = ""
    country_or_setting: str = ""
    population: str = ""
    intervention: str = ""
    comparator: str = ""
    follow_up: str = ""
    primary_outcome: str = ""
    outcome_window: str = ""
    distinctive_feature: str = ""
    clinical_quirks: list[str] = Field(default_factory=list)
    risk_notes: list[str] = Field(default_factory=list)
    safety_notes: list[str] = Field(default_factory=list)
    applicability_notes: list[str] = Field(default_factory=list)
    source_backed_claims: list[SourceBackedClaim] = Field(default_factory=list)
    unresolved_questions: list[str] = Field(default_factory=list)
    audit_notes: list[str] = Field(default_factory=list)


class EvidenceUnderstandingReport(BaseModel):
    """Project-level evidence understanding packet for writing and human review."""

    schema_version: int = 1
    status: str = "ok"
    study_cards: list[StudyIntelligenceCard] = Field(default_factory=list)
    cross_study_claims: list[SourceBackedClaim] = Field(default_factory=list)
    authoring_priorities: list[str] = Field(default_factory=list)
    unresolved_questions: list[str] = Field(default_factory=list)
    audit_notes: list[str] = Field(default_factory=list)
