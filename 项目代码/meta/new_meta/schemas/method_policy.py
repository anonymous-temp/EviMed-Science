"""Versioned method-policy schemas compiled before statistical execution."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator


class ReviewFamily(str, Enum):
    INTERVENTION_RCT = "intervention_rct"
    INTERVENTION_NRSI = "intervention_nrsi"
    PREVALENCE_INCIDENCE = "prevalence_incidence"
    DIAGNOSTIC_ACCURACY = "diagnostic_accuracy"
    PROGNOSTIC_FACTOR = "prognostic_factor"
    PREDICTION_MODEL = "prediction_model"
    NETWORK_META = "network_meta"
    IPD_META = "ipd_meta"
    DOSE_RESPONSE = "dose_response"
    NARRATIVE_SYNTHESIS = "narrative_synthesis"


class CapabilityStatus(str, Enum):
    PRODUCTION = "production"
    VALIDATING = "validating"
    BLOCKED = "blocked"


class ReviewDesignSpec(BaseModel):
    schema_version: int = 1
    review_id: str = Field(min_length=1)
    family: ReviewFamily
    study_designs: list[str] = Field(min_length=1)
    outcome_type: str = Field(min_length=1)
    requested_effect_measure: str = Field(min_length=1)
    requested_model: str = ""
    treatment_count: int | None = Field(default=None, ge=1)
    adjusted_estimates_required: bool = False
    individual_participant_data: bool = False
    protocol_version: str = ""

    @field_validator("study_designs")
    @classmethod
    def normalize_designs(cls, values: list[str]) -> list[str]:
        normalized = sorted({str(value).strip().lower() for value in values if str(value).strip()})
        if not normalized:
            raise ValueError("at least one study design is required")
        return normalized

    @field_validator("outcome_type", "requested_model")
    @classmethod
    def normalize_lower(cls, value: str) -> str:
        return str(value or "").strip().lower()

    @field_validator("requested_effect_measure")
    @classmethod
    def normalize_effect(cls, value: str) -> str:
        return str(value or "").strip().upper()

    @model_validator(mode="after")
    def validate_network_shape(self):
        if self.family is ReviewFamily.NETWORK_META and (
            self.treatment_count is None or self.treatment_count < 3
        ):
            raise ValueError("network meta-analysis requires at least three treatments")
        if self.family is ReviewFamily.IPD_META and not self.individual_participant_data:
            raise ValueError("IPD meta-analysis requires individual_participant_data=true")
        return self


class MethodPlugin(BaseModel):
    schema_version: int = 1
    family: ReviewFamily
    policy_version: str = Field(min_length=1)
    capability_status: CapabilityStatus
    supported_designs: list[str] = Field(min_length=1)
    supported_outcome_types: list[str] = Field(min_length=1)
    supported_effect_measures: list[str] = Field(min_length=1)
    primary_estimators: dict[str, str] = Field(min_length=1)
    sensitivity_estimators: list[str] = Field(default_factory=list)
    required_diagnostics: list[str] = Field(default_factory=list)
    hard_gates: list[str] = Field(default_factory=list)
    risk_of_bias_tool: str = Field(min_length=1)
    certainty_framework: str = Field(min_length=1)
    reporting_guidelines: list[str] = Field(min_length=1)
    engine_entrypoint: str = Field(min_length=1)
    validation_reference: str = Field(min_length=1)
    blocking_reason: str = ""

    @field_validator("supported_designs", "supported_outcome_types")
    @classmethod
    def normalize_lower_list(cls, values: list[str]) -> list[str]:
        return sorted({str(value).strip().lower() for value in values if str(value).strip()})

    @field_validator("supported_effect_measures")
    @classmethod
    def normalize_effects(cls, values: list[str]) -> list[str]:
        return sorted({str(value).strip().upper() for value in values if str(value).strip()})


class MethodPlan(BaseModel):
    schema_version: int = 1
    review_id: str
    family: ReviewFamily
    policy_version: str
    capability_status: CapabilityStatus
    plan_fingerprint: str
    protocol_version: str = ""
    study_designs: list[str] = Field(default_factory=list)
    outcome_type: str = ""
    effect_measure: str
    primary_estimator: str
    sensitivity_estimators: list[str] = Field(default_factory=list)
    required_diagnostics: list[str] = Field(default_factory=list)
    hard_gates: list[str] = Field(default_factory=list)
    risk_of_bias_tool: str
    certainty_framework: str
    reporting_guidelines: list[str] = Field(default_factory=list)
    engine_entrypoint: str
    validation_reference: str
    capability_id: str = ""
    validation_manifest_fingerprint: str = ""
    validation_evidence_ids: list[str] = Field(default_factory=list)
    execution_allowed: bool
    blocking_reasons: list[str] = Field(default_factory=list)


class MethodExecutionResult(BaseModel):
    schema_version: int = 1
    family: ReviewFamily
    policy_version: str
    plan_fingerprint: str
    estimator: str
    input_result_ids: list[str] = Field(default_factory=list)
    input_ledger_head_hash: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")
    payload: dict[str, Any]
    diagnostics: dict[str, Any] = Field(default_factory=dict)
