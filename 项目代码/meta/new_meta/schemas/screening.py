"""Source-bound full-text decisions; clinical eligibility remains a language task."""
from typing import Literal

from pydantic import BaseModel, Field


class ScreeningSourceIdentity(BaseModel):
    record_id: str
    pmid: str
    doi: str
    trial_registration: str


class PublicationIdentityCheck(BaseModel):
    """A model-interpreted protocol constraint evaluated by identifier equality."""

    identifier_type: Literal["pmid", "doi"]
    requirement: Literal["any_of", "none_of", "context_only"]
    identifiers: list[str] = Field(min_length=1)
    protocol_criterion: str = Field(min_length=1)
    context_reason: str | None = None


class FullTextScreeningDecision(BaseModel):
    decision: Literal["include", "exclude", "review_required"]
    reason_code: Literal[
        "eligible", "publication_identity", "population", "intervention", "comparator",
        "outcome", "study_design", "publication_type", "data_unavailable", "other", "uncertain",
    ]
    reason: str = Field(min_length=1)
    exclusion_criterion: str | None
    confidence: Literal["high", "medium", "low"]
    source_identity: ScreeningSourceIdentity
    publication_role: Literal[
        "primary_publication", "secondary_analysis", "design_or_protocol", "adjacent_outcome_trial", "other", "uncertain",
    ]
    target_outcome_priority: Literal["primary", "secondary", "exploratory", "not_reported", "uncertain"]
    full_text_identity_status: Literal["consistent", "conflicting", "uncertain"]
    publication_identity_checks: list[PublicationIdentityCheck]
