"""Data model for one full analysis run.

Everything numeric in these models comes from the openFDA data layer and
the deterministic signals layer. LLM-produced fields are clearly separated
(:class:`Interpretation`) and may be absent when the run degraded.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from safety_agent.evidence.label_check import LabelCheckReport
from safety_agent.evidence.models import EvidenceLayerResult


class CountBucket(BaseModel):
    """One count-query bucket, e.g. (2021, 1234) for a yearly trend."""

    term: str
    count: int


class CaseOverview(BaseModel):
    """FAERS case-profile aggregates for the target drug."""

    total_reports: int
    yearly: list[CountBucket] = Field(default_factory=list)
    sex: list[CountBucket] = Field(default_factory=list)
    age_buckets: list[CountBucket] = Field(default_factory=list)
    outcomes: list[CountBucket] = Field(default_factory=list)
    countries: list[CountBucket] = Field(default_factory=list)
    concomitant_drugs: list[CountBucket] = Field(default_factory=list)
    indications: list[CountBucket] = Field(default_factory=list)


class NormalizedReaction(BaseModel):
    query: str
    normalized: str | None
    method: str
    confidence: float


class SignalRow(BaseModel):
    """One drug-ADR pair: 2x2 cells plus the full metrics panel."""

    reaction: str
    source: Literal["user-specified", "top-pt"]
    a: float
    b: float
    c: float
    d: float
    n: float
    haldane_anscombe_applied: bool
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
    is_signal: bool
    expected_count: float | None = None
    gps_prior_id: str | None = None


class FocusAdrInterpretation(BaseModel):
    reaction: str
    text: str


class Interpretation(BaseModel):
    """LLM narrative over the finished statistics (never new numbers)."""

    overview: str = ""
    demographics: str = ""
    outcomes: str = ""
    signal_commentary: str = ""
    label_commentary: str = ""
    focus_adrs: list[FocusAdrInterpretation] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    """Full pipeline output; the report layer renders exactly this."""

    drug_query: str
    drug_normalized: str
    drug_candidates: list[str] = Field(default_factory=list)
    reactions: list[NormalizedReaction]
    language: str = "zh"
    overview: CaseOverview
    signals: list[SignalRow]
    label_check: LabelCheckReport | None = None
    evidence: EvidenceLayerResult | None = None
    interpretation: Interpretation | None = None
    llm_status: Literal["ok", "degraded", "not_configured"] = "ok"
    degradation_notes: list[str] = Field(default_factory=list)
    query_urls: dict[str, str] = Field(default_factory=dict)
    # Query conventions actually applied (transparency for the report):
    drug_field: str = "openfda_generic"
    ps_only: bool = True
    drug_field_used: str | None = None  # differs from drug_field on fallback
    data_source: Literal["openfda_live", "frozen_faers"] = "openfda_live"
    suspect_binding: Literal[
        "report_contains_suspect_approximation", "same_drug_object", "target_name_only"
    ] = "report_contains_suspect_approximation"
    suspect_roles: list[str] = Field(default_factory=lambda: ["PS", "SS"])
    administration_routes: list[str] = Field(default_factory=list)
    study_date_from: str | None = None
    study_date_to: str | None = None
    background_date_from: str | None = None
    background_date_to: str | None = None
    snapshot_id: str | None = None
    snapshot_source: str | None = None
    snapshot_sha256: str | None = None
    snapshot_extracted_at: str | None = None
    snapshot_deduplication: str | None = None
    statistics_version: str = "gps-v2"
    gps_prior_fitted: bool = False
    gps_prior_id: str | None = None
    generated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
