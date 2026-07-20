"""Adjudicable certainty contract for method-specific synthesis results."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from new_meta.schemas.method_policy import ReviewFamily
from new_meta.schemas.phase_result import NextAction


class MethodCertaintyStatus(str, Enum):
    DRAFT = "draft"
    NEEDS_INPUT = "needs_input"
    COMPLETED = "completed"


class CertaintyDomainRating(str, Enum):
    NO_CONCERN = "no_concern"
    SERIOUS = "serious"
    VERY_SERIOUS = "very_serious"
    NOT_ASSESSED = "not_assessed"


class MethodCertaintyDomain(BaseModel):
    domain: str = Field(min_length=1)
    rating: CertaintyDomainRating
    rationale: str = Field(min_length=1)
    evidence: dict[str, Any] = Field(default_factory=dict)
    requires_human_judgment: bool = False


class MethodCertaintyOutcome(BaseModel):
    outcome_id: str = Field(min_length=1)
    outcome_label: str = Field(min_length=1)
    starting_certainty: str = "high"
    certainty: str = "not_assessed"
    domains: list[MethodCertaintyDomain] = Field(min_length=1)


class MethodCertaintyAssessment(BaseModel):
    schema_version: int = 1
    revision: int = Field(default=0, ge=0)
    status: MethodCertaintyStatus
    family: ReviewFamily
    framework: str = Field(min_length=1)
    framework_note: str = Field(min_length=1)
    plan_fingerprint: str = Field(min_length=1)
    synthesis_fingerprint: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")
    input_ledger_head_hash: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")
    risk_of_bias_fingerprint: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")
    input_result_ids: list[str] = Field(min_length=1)
    outcomes: list[MethodCertaintyOutcome] = Field(min_length=1)
    next_actions: list[NextAction] = Field(default_factory=list)
    adjudicated_by: str = ""
    adjudication_reason: str = ""
