"""Versioned selection of one clinically coherent result stratum for synthesis."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class AnalysisSetCandidate(BaseModel):
    candidate_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    outcome_id: str = Field(min_length=1)
    outcome_name: str = Field(min_length=1)
    outcome_type: str = Field(min_length=1)
    timepoint: str = ""
    subgroup: str = ""
    effect_measure: str = Field(min_length=1)
    result_ids: list[str] = Field(min_length=1)
    study_ids: list[str] = Field(min_length=1)
    eligible: bool = True
    issues: list[str] = Field(default_factory=list)


class AnalysisSetCandidates(BaseModel):
    schema_version: int = 1
    plan_fingerprint: str = Field(min_length=1)
    ledger_head_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidates: list[AnalysisSetCandidate] = Field(default_factory=list)


class AnalysisSetDecision(BaseModel):
    schema_version: int = 1
    revision: int = Field(default=0, ge=0)
    status: Literal["automatic", "adjudicated"]
    plan_fingerprint: str = Field(min_length=1)
    ledger_head_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    outcome_id: str = Field(min_length=1)
    outcome_name: str = Field(min_length=1)
    outcome_type: str = Field(min_length=1)
    timepoint: str = ""
    subgroup: str = ""
    effect_measure: str = Field(min_length=1)
    result_ids: list[str] = Field(min_length=1)
    selected_by: str = Field(min_length=1)
    reason: str = Field(min_length=1)
