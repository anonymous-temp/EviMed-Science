"""Request/response schemas for the REST API.

Validation lives here (pydantic) so route handlers never face malformed
input — validation failures become a clean 422 via the global handler,
never an NPE-style crash.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class AnalyzeRequest(BaseModel):
    drug: str = Field(min_length=1, max_length=200)
    reactions: list[str] = Field(default_factory=list, max_length=20)
    indication: str | None = Field(default=None, max_length=300)
    language: Literal["zh", "en"] = "zh"

    @field_validator("drug")
    @classmethod
    def drug_not_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("drug must not be blank")
        return cleaned

    @field_validator("reactions", mode="before")
    @classmethod
    def reactions_default_empty(cls, value: object) -> object:
        # null reactions are treated as "not provided", not an error
        return [] if value is None else value

    @field_validator("reactions")
    @classmethod
    def reactions_clean(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if isinstance(item, str) and item.strip()][:20]


class AnalyzeAccepted(BaseModel):
    jobId: str


class ErrorBody(BaseModel):
    code: int
    msg: str


class JobStatusResponse(BaseModel):
    status: Literal["queued", "running", "succeeded", "failed"]
    progress: int = Field(ge=0, le=100)
    stage: str
    error: str | None = None
    result: dict | None = None


class SignalRowOut(BaseModel):
    reaction: str
    a: float
    b: float
    c: float
    d: float
    n: float
    ror: float
    ror_ci95_lower: float
    ror_ci95_upper: float
    prr: float
    prr_ci95_lower: float
    prr_ci95_upper: float
    chi2: float
    ic: float
    ic025: float
    ebgm: float
    eb05: float
    expected_count: float
    haldane_anscombe_applied: bool
    gps_prior_id: str | None = None
    is_signal: bool


class SignalsResponse(BaseModel):
    drug: str
    drug_normalized: str
    drug_field_used: Literal["openfda_generic", "medicinalproduct", "frozen_normalized"]
    ps_only: bool
    data_source: Literal["openfda_live", "frozen_faers"]
    suspect_binding: Literal[
        "report_contains_suspect_approximation", "same_drug_object", "target_name_only"
    ]
    suspect_roles: list[str]
    snapshot_id: str | None = None
    snapshot_source: str | None = None
    snapshot_sha256: str | None = None
    snapshot_extracted_at: str | None = None
    snapshot_deduplication: str | None = None
    study_date_from: str | None = None
    study_date_to: str | None = None
    statistics_version: str = "gps-v2"
    gps_prior_fitted: bool = False
    gps_prior_id: str | None = None
    rows: list[SignalRowOut]
    query_urls: dict[str, str]
