"""Research protocol and PICO data models."""
from __future__ import annotations

from pydantic import BaseModel, model_validator


class PICO(BaseModel):
    """Population, Intervention, Comparator, Outcome framework."""
    population: str
    intervention: str
    comparator: str
    outcome_primary: str
    outcomes_secondary: list[str] = []


class ResearchProtocol(BaseModel):
    """Full research protocol derived from PICO and user input."""
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
    language: str = "English"
    effect_measure: str = "MD"  # "OR" / "RR" / "RD" / "MD" / "SMD" / "HR" / "PROP" / "COR" / "IRR"
    model_preference: str = "random"  # "fixed" / "random"
    tau_estimator: str = "DL"  # "DL" / "REML" / "HKSJ"
    subgroup_variables: list[str] = []
    # Versioned method-planning fields. Empty review_family retains deterministic
    # backward-compatible inference for legacy protocols.
    review_family: str = ""
    primary_outcome_type: str = ""
    protocol_version: str = "1.0"
    # NMA support
    interventions: list[str] = []  # Multiple interventions for network meta-analysis
    analysis_type: str = "pairwise"  # "pairwise" / "network"
