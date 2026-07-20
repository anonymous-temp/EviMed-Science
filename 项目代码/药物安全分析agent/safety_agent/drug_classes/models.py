"""Serializable results for deterministic drug-class signal analyses."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ClassSignalRow(BaseModel):
    target_id: str
    comparator: str
    reaction: str
    a: float
    b: float
    c: float
    d: float
    n: float
    overlap_excluded: int = 0
    ror: float
    ror_ci95_lower: float
    ror_ci95_upper: float
    prr: float
    chi2: float
    ic: float
    ic025: float
    ebgm: float
    eb05: float
    expected_count: float
    gps_prior_id: str | None = None
    haldane_anscombe_applied: bool
    is_signal: bool


class EventTaxonomyRow(BaseModel):
    reaction: str
    soc: str | None = None
    smqs: list[str] = Field(default_factory=list)
    is_ime: bool = False
    source: str


class TherapyStrataResult(BaseModel):
    definition: str
    monotherapy: int
    polytherapy: int


class TimeToOnsetResult(BaseModel):
    reaction: str
    observed: int
    missing: int
    median_days: float | None = None
    q1_days: float | None = None
    q3_days: float | None = None


class ApprovalSensitivityResult(BaseModel):
    member_id: str
    date_from: str
    date_to: str
    report_count: int
    signal_count: int


class ClassAnalysisResult(BaseModel):
    class_id: str
    class_name: str
    definition_version: str
    atc_codes: list[str]
    members: list[str]
    member_report_counts: dict[str, int]
    members_without_reports: list[str]
    excluded_products: list[str]
    definition_sources: list[str]
    reactions: list[str]
    unavailable_reactions: list[str]
    total_reports: int
    comparisons: list[ClassSignalRow]
    shared_signals: list[str]
    unique_signals: dict[str, list[str]]
    taxonomy: list[EventTaxonomyRow]
    taxonomy_coverage: float
    therapy_strata: TherapyStrataResult | None = None
    time_to_onset: list[TimeToOnsetResult] = Field(default_factory=list)
    approval_sensitivity: list[ApprovalSensitivityResult] = Field(default_factory=list)
    data_source: str = "frozen_faers"
    suspect_binding: str = "same_drug_object"
    suspect_roles: list[str]
    study_date_from: str | None = None
    study_date_to: str | None = None
    snapshot_id: str
    snapshot_source: str
    snapshot_sha256: str | None = None
    statistics_version: str = "gps-v2"
    gps_prior_fitted: bool = False
    gps_prior_id: str | None = None
    time_to_onset_available: bool = True
    limitations: list[str] = Field(default_factory=list)
