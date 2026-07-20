"""Shared manuscript evidence-contract schemas.

These models describe the contract between evidence understanding, claim-map
construction, source resolution, citation assignment, and section authoring.
They are intentionally small: deterministic code enforces identity, provenance,
and citation consistency, while LLM steps handle semantic authoring against this
contract.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class SourceSpan(BaseModel):
    """A concrete source span supporting a manuscript claim."""

    source_id: str = ""
    reference_id: str = ""
    study_id: str = ""
    source_type: str = Field(default="", description="primary_report, registry, background_reference, structured_fact, study_card, or analysis.")
    location: str = ""
    page: int | None = None
    quote: str = ""
    verified: bool = False
    support_strength: str = Field(default="unverified", description="direct, indirect, structured, or unverified.")


class ManuscriptClaim(BaseModel):
    """A source-resolved claim available for manuscript authoring."""

    id: str = ""
    section: str = ""
    claim_type: str = ""
    argument_step: str = ""
    claim: str = ""
    support_source: str = ""
    source_spans: list[SourceSpan] = Field(default_factory=list)
    manuscript_use: str = "main"
    can_write_main_text: bool = True
    caveat: str = ""


class CitationContractItem(BaseModel):
    """Approved citation mapping for one manuscript claim."""

    claim_id: str = ""
    citation: str = ""
    reference_numbers: list[int] = Field(default_factory=list)
    reference_ids: list[str] = Field(default_factory=list)
    source_spans: list[SourceSpan] = Field(default_factory=list)
    support_source: str = ""


class CitationContract(BaseModel):
    """Claim-to-reference contract used by authoring and validation."""

    schema_version: int = 1
    status: str = "ok"
    items: list[CitationContractItem] = Field(default_factory=list)


class SectionPlanItem(BaseModel):
    """Planned paragraph/section unit grounded in approved claims."""

    section: str = ""
    paragraph_role: str = ""
    claim_ids_used: list[str] = Field(default_factory=list)
    new_information_delta: str = ""


class SectionPlan(BaseModel):
    """Language-neutral rhetorical plan for manuscript sections."""

    schema_version: int = 1
    output_language: str = ""
    sections: list[SectionPlanItem] = Field(default_factory=list)
