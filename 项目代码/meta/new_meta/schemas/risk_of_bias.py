"""Risk of bias data models."""
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class RoBTargetEffect(str, Enum):
    ASSIGNMENT = "assignment"
    ADHERENCE = "adherence"
    EXPOSURE = "exposure"
    DIAGNOSTIC_ACCURACY = "diagnostic_accuracy"
    PROGNOSTIC_ASSOCIATION = "prognostic_association"
    PREDICTION_MODEL = "prediction_model"
    PREVALENCE = "prevalence"
    INCIDENCE = "incidence"


class RoBAssessmentStatus(str, Enum):
    DRAFT = "draft"
    COMPLETE = "complete"
    ADJUDICATED = "adjudicated"
    INSUFFICIENT_INFORMATION = "insufficient_information"


class RoBDomain(BaseModel):
    """A single domain in a risk-of-bias assessment."""
    domain: str  # e.g. "Randomization process"
    judgment: str  # "Low risk" / "Some concerns" / "High risk"
    support: str  # Evidence from the paper supporting the judgment
    source_page: int | None = None
    source_section: str | None = None
    source_quote: str = ""
    signaling_questions: dict[str, str] = Field(default_factory=dict)


class StudyRoB(BaseModel):
    """Risk of bias assessment for a single study."""
    study_id: str
    tool_used: str  # "RoB 2" / "Newcastle-Ottawa Scale"
    domains: list[RoBDomain] = Field(default_factory=list)
    overall_judgment: str = ""  # "Low risk" / "Some concerns" / "High risk"
    is_synthetic: bool = False  # True when generated because full text was unavailable


class ResultRoBAssessment(StudyRoB):
    """Tool-versioned risk-of-bias judgment for one estimand/result."""

    schema_version: int = 1
    assessment_id: str = Field(min_length=1)
    result_id: str = Field(min_length=1)
    outcome_name: str = Field(min_length=1)
    timepoint: str = ""
    subgroup: str = ""
    analysis_population: str = ""
    tool_version: str = Field(min_length=1)
    target_effect: RoBTargetEffect
    assessment_status: RoBAssessmentStatus = RoBAssessmentStatus.DRAFT
    assessed_by: str = ""
    adjudicated_by: str = ""
    assessment_origin: str = Field(default="result_specific", min_length=1)
    requires_adjudication: bool = False
    is_result_specific: Literal[True] = True

    @model_validator(mode="after")
    def validate_completed_assessment(self):
        if self.assessment_status in {
            RoBAssessmentStatus.COMPLETE,
            RoBAssessmentStatus.ADJUDICATED,
        }:
            has_source_evidence = bool(self.domains) and all(
                bool(domain.source_quote.strip())
                and (domain.source_page is not None or bool((domain.source_section or "").strip()))
                for domain in self.domains
            )
            if not self.overall_judgment.strip() or not has_source_evidence:
                raise ValueError(
                    "complete result-level assessment requires domain source evidence and overall judgment"
                )
        if self.assessment_status is RoBAssessmentStatus.ADJUDICATED and not self.adjudicated_by.strip():
            raise ValueError("adjudicated result-level assessment requires adjudicated_by")
        if self.assessment_status is RoBAssessmentStatus.ADJUDICATED and self.requires_adjudication:
            raise ValueError("adjudicated assessment cannot still require adjudication")
        return self
