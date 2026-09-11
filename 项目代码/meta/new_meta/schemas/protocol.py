"""Research protocol and PICO data models."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import PrivateAttr, BaseModel, Field, field_validator, model_validator


class PICO(BaseModel):
    """Population, Intervention, Comparator, Outcome framework."""
    population: str
    intervention: str
    comparator: str
    outcome_primary: str
    outcomes_secondary: list[str] = []


class ResearchProtocol(BaseModel):
    """Full research protocol derived from PICO and user input."""
    _scope_receipt: dict = PrivateAttr(default_factory=dict)
    research_question: str
    pico: PICO
    study_design: str = "RCT"  # "RCT" / "observational" / "both" — kept for backward compat
    study_designs: list[str] = []  # ["RCT", "cohort", "case-control", "cross-sectional", "case-series"]

    @model_validator(mode="after")
    def _sync_study_design(self):
        if self.study_designs and len(self.study_designs) > 1 or (
            self.study_designs and self.study_design == "RCT" and "RCT" not in self.study_designs
        ):
            object.__setattr__(self, "study_design", " / ".join(self.study_designs))
        elif self.study_designs and len(self.study_designs) == 1:
            object.__setattr__(self, "study_design", self.study_designs[0])
        return self
    inclusion_criteria: list[str] = []
    exclusion_criteria: list[str] = []
    databases: list[str] = ["PubMed"]
    date_range: str = ""  # e.g. "2010-2025"
    language: str = "No language restriction"
    effect_measure: str = "MD"  # "OR" / "RR" / "RD" / "MD" / "SMD" / "HR" / "PROP" / "COR" / "IRR"
    model_preference: str = "random"  # "fixed" / "random"
    tau_estimator: str = "DL"  # "DL" / "REML" / "HKSJ"
    subgroup_variables: list[str] = []
    # Versioned method-planning fields. Empty review_family retains deterministic
    # backward-compatible inference for legacy protocols.
    review_family: str = ""
    primary_outcome_type: Literal[
        "", "dichotomous", "continuous", "time_to_event", "count", "proportion",
        "incidence_rate", "diagnostic_accuracy", "discrimination", "calibration",
        "overall_performance", "any",
    ] = Field(
        default="",
        description=(
            "Statistical outcome type: choose exactly one canonical enum value. "
            "Keep disease names, composite endpoint components and time horizons in "
            "pico.outcome_primary, never append them to this type. Empty is reserved "
            "for legacy protocols whose type is inferred from the method fields."
        ),
    )

    @field_validator("primary_outcome_type", mode="before")
    @classmethod
    def _normalize_primary_outcome_type(cls, value):
        """Preserve the method normalizer's exact aliases; never infer from prose."""
        if not isinstance(value, str):
            return value
        if not value.strip():
            return ""
        normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
        aliases = {
            "binary": "dichotomous",
            "categorical": "dichotomous",
            "survival": "time_to_event",
            "time_event": "time_to_event",
            "incidence": "incidence_rate",
            "overall": "overall_performance",
        }
        return aliases.get(normalized, normalized) if normalized else value

    protocol_version: str = "1.0"
    # NMA support
    interventions: list[str] = []  # Multiple interventions for network meta-analysis
    analysis_type: str = "pairwise"  # "pairwise" / "network"


class ProtocolScopeField(BaseModel):
    field: str
    status: Literal["match", "mismatch", "uncertain"]
    basis: Literal["explicit", "not_explicit"]
    original_quote: str
    rationale: str


class ProtocolScopeAssessment(BaseModel):
    fields: list[ProtocolScopeField]
