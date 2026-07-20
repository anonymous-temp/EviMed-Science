"""Typed, result-level entities for the canonical evidence ledger."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, model_validator


class ActorType(str, Enum):
    HUMAN = "human"
    LLM = "llm"
    DETERMINISTIC = "deterministic"
    IMPORT = "import"


class EvidenceState(str, Enum):
    DRAFT = "draft"
    EXTRACTED = "extracted"
    VERIFIED = "verified"
    ADJUDICATED = "adjudicated"
    REJECTED = "rejected"


class EntityKind(str, Enum):
    REPORT = "report"
    STUDY = "study"
    ARM = "arm"
    OUTCOME = "outcome"
    RESULT = "result"


class LedgerAction(str, Enum):
    CREATE = "create"
    SUPERSEDE = "supersede"
    ADJUDICATE = "adjudicate"


class EvidenceActor(BaseModel):
    actor_id: str = Field(min_length=1)
    actor_type: ActorType
    model_name: str = ""
    prompt_version: str = ""
    code_version: str = ""


class SourceLocator(BaseModel):
    document_id: str = Field(min_length=1)
    file_path: str = ""
    file_sha256: str = Field(default="", pattern=r"^(?:[0-9a-fA-F]{64})?$")
    page: int | None = Field(default=None, ge=1)
    section: str = ""
    table: str = ""
    figure: str = ""
    row: str = ""
    column: str = ""
    char_start: int | None = Field(default=None, ge=0)
    char_end: int | None = Field(default=None, ge=0)
    bounding_box: tuple[float, float, float, float] | None = None
    quote: str = ""
    quote_verified: bool = False

    @model_validator(mode="after")
    def validate_span(self):
        if self.char_start is not None and self.char_end is not None and self.char_end < self.char_start:
            raise ValueError("char_end must not precede char_start")
        return self


class LedgerEntity(BaseModel):
    schema_version: int = 1
    entity_id: str = Field(min_length=1)
    review_id: str = Field(min_length=1)
    kind: EntityKind
    evidence_state: EvidenceState = EvidenceState.DRAFT
    tags: list[str] = Field(default_factory=list)


class ReportEntity(LedgerEntity):
    kind: Literal[EntityKind.REPORT] = EntityKind.REPORT
    title: str = Field(min_length=1)
    doi: str = ""
    pmid: str = ""
    registry_id: str = ""
    publication_year: int | None = Field(default=None, ge=1600, le=2200)
    file_sha256: str = Field(default="", pattern=r"^(?:[0-9a-fA-F]{64})?$")


class StudyEntity(LedgerEntity):
    kind: Literal[EntityKind.STUDY] = EntityKind.STUDY
    title: str = Field(min_length=1)
    design: str = Field(min_length=1)
    report_ids: list[str] = Field(default_factory=list)
    registration_ids: list[str] = Field(default_factory=list)
    population_description: str = ""
    setting: str = ""


class ArmEntity(LedgerEntity):
    kind: Literal[EntityKind.ARM] = EntityKind.ARM
    study_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    role: str = Field(min_length=1)
    sample_size: int | None = Field(default=None, ge=0)
    intervention_description: str = ""


class OutcomeEntity(LedgerEntity):
    kind: Literal[EntityKind.OUTCOME] = EntityKind.OUTCOME
    name: str = Field(min_length=1)
    outcome_type: str = Field(min_length=1)
    direction: str = Field(min_length=1)
    unit: str = ""
    scale: str = ""
    definition: str = ""


class DichotomousData(BaseModel):
    data_type: Literal["dichotomous"] = "dichotomous"
    events_intervention: int = Field(ge=0)
    total_intervention: int = Field(gt=0)
    events_control: int = Field(ge=0)
    total_control: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_events(self):
        if self.events_intervention > self.total_intervention:
            raise ValueError("intervention events cannot exceed total")
        if self.events_control > self.total_control:
            raise ValueError("control events cannot exceed total")
        return self


class ContinuousData(BaseModel):
    data_type: Literal["continuous"] = "continuous"
    mean_intervention: float
    sd_intervention: float = Field(gt=0)
    total_intervention: int = Field(gt=0)
    mean_control: float
    sd_control: float = Field(gt=0)
    total_control: int = Field(gt=0)


class SingleArmProportionData(BaseModel):
    data_type: Literal["single_arm_proportion"] = "single_arm_proportion"
    events: int = Field(ge=0)
    total: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_events(self):
        if self.events > self.total:
            raise ValueError("events cannot exceed total")
        return self


class IncidenceRateData(BaseModel):
    data_type: Literal["incidence_rate"] = "incidence_rate"
    events: int = Field(ge=0)
    person_time: float = Field(gt=0)
    time_unit: str = Field(min_length=1)


class DiagnosticAccuracyData(BaseModel):
    data_type: Literal["diagnostic_accuracy"] = "diagnostic_accuracy"
    true_positive: int = Field(ge=0)
    false_negative: int = Field(ge=0)
    false_positive: int = Field(ge=0)
    true_negative: int = Field(ge=0)
    threshold: str = ""

    @model_validator(mode="after")
    def validate_strata(self):
        if self.true_positive + self.false_negative <= 0:
            raise ValueError("diseased denominator must be positive")
        if self.false_positive + self.true_negative <= 0:
            raise ValueError("non-diseased denominator must be positive")
        return self


class CorrelationData(BaseModel):
    data_type: Literal["correlation"] = "correlation"
    correlation: float = Field(ge=-1, le=1)
    total: int = Field(gt=3)


class ComparativeEffectData(BaseModel):
    """Design and dependency metadata attached to a reported comparative effect."""

    data_type: Literal["comparative_effect"] = "comparative_effect"
    design: str = Field(min_length=1)
    treatment: str = Field(min_length=1)
    comparator: str = Field(min_length=1)
    contrast_id: str = Field(min_length=1)
    estimand_id: str = Field(min_length=1)
    precision_basis: str = Field(min_length=1)
    covariance_with: dict[str, float] = Field(default_factory=dict)
    paired_analysis: bool = False
    intracluster_correlation: float | None = Field(default=None, ge=0, lt=1)
    mean_cluster_size: float | None = Field(default=None, gt=1)

    @model_validator(mode="after")
    def validate_comparison(self):
        if self.treatment.strip().casefold() == self.comparator.strip().casefold():
            raise ValueError("comparative effect treatment and comparator must differ")
        if self.contrast_id in self.covariance_with:
            raise ValueError("a contrast cannot declare covariance with itself")
        return self


class DoseResponseData(BaseModel):
    data_type: Literal["dose_response"] = "dose_response"
    design: str = Field(min_length=1)
    dose: float = Field(ge=0)
    reference_dose: float = Field(ge=0)
    dose_unit: str = Field(min_length=1)
    contrast_id: str = Field(min_length=1)
    covariance_with: dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_dose_contrast(self):
        if self.dose == self.reference_dose:
            raise ValueError("dose-response contrast dose must differ from its reference dose")
        if self.contrast_id in self.covariance_with:
            raise ValueError("a dose contrast cannot declare covariance with itself")
        return self


class IPDParticipantData(BaseModel):
    """One source row from a participant-level study dataset."""

    participant_id: str = Field(min_length=1)
    treatment: Literal[0, 1]
    outcome: float | None = None
    time: float | None = Field(default=None, gt=0)
    event: Literal[0, 1] | None = None
    covariates: dict[str, float] = Field(default_factory=dict)


class IPDStudyData(BaseModel):
    """Typed participant rows for one parallel randomized study."""

    data_type: Literal["ipd_study"] = "ipd_study"
    design: Literal["parallel_rct"] = "parallel_rct"
    outcome_type: Literal["binary", "continuous", "time_to_event"]
    participants: list[IPDParticipantData] = Field(min_length=4)

    @model_validator(mode="after")
    def validate_participant_rows(self):
        identifiers = [item.participant_id for item in self.participants]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("participant identifiers must be unique within each study")
        if {item.treatment for item in self.participants} != {0, 1}:
            raise ValueError("IPD study data must contain both randomized treatment arms")
        if self.outcome_type in {"binary", "continuous"}:
            if any(item.outcome is None for item in self.participants):
                raise ValueError("binary/continuous IPD requires a complete outcome column")
            if self.outcome_type == "binary" and any(
                item.outcome not in {0.0, 1.0} for item in self.participants
            ):
                raise ValueError("binary IPD outcome must be coded 0/1")
        elif any(item.time is None or item.event is None for item in self.participants):
            raise ValueError("time-to-event IPD requires complete time and event columns")
        return self


class PredictionPerformanceData(BaseModel):
    data_type: Literal["prediction_performance"] = "prediction_performance"
    model_id: str = Field(min_length=1)
    model_version: str = Field(min_length=1)
    validation_type: str = Field(min_length=1)
    metric: str = Field(min_length=1)
    estimate: float | None = None
    standard_error: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    sample_size: int | None = Field(default=None, gt=1)
    events: int | None = Field(default=None, ge=0)
    expected_events: float | None = Field(default=None, gt=0)
    time_horizon: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_metric(self):
        metric = self.metric.upper()
        if self.ci_lower is not None and self.ci_upper is not None:
            if self.ci_upper <= self.ci_lower:
                raise ValueError("prediction performance confidence interval must be ordered")
        if metric == "C_STATISTIC":
            if self.estimate is None:
                raise ValueError("C_STATISTIC requires an estimate")
            if not 0 < self.estimate < 1:
                raise ValueError("c-statistic must lie strictly between zero and one")
            if self.ci_lower is not None and not 0 < self.ci_lower < 1:
                raise ValueError("c-statistic lower confidence limit must be in (0, 1)")
            if self.ci_upper is not None and not 0 < self.ci_upper < 1:
                raise ValueError("c-statistic upper confidence limit must be in (0, 1)")
            if self.standard_error is None and (
                self.ci_lower is None or self.ci_upper is None
            ) and (self.sample_size is None or self.events is None):
                raise ValueError("prediction performance requires reported or restorable precision")
            if self.sample_size is not None and self.events is not None:
                if not 0 < self.events < self.sample_size:
                    raise ValueError("prediction events must be between zero and sample size")
        elif metric == "OE_RATIO":
            if self.ci_lower is not None and self.ci_lower <= 0:
                raise ValueError("O:E lower confidence limit must be positive")
            if self.ci_upper is not None and self.ci_upper <= 0:
                raise ValueError("O:E upper confidence limit must be positive")
            has_raw = (
                self.sample_size is not None
                and self.events is not None
                and self.expected_events is not None
            )
            has_reported = self.estimate is not None and (
                self.standard_error is not None
                or (self.ci_lower is not None and self.ci_upper is not None)
            )
            if not has_raw and not has_reported:
                raise ValueError(
                    "OE_RATIO requires observed/expected events with sample size, "
                    "or a reported ratio with SE/CI"
                )
            if self.estimate is not None and self.estimate <= 0:
                raise ValueError("O:E ratio must be positive")
            if has_raw and self.events is not None and self.sample_size is not None:
                if self.events > self.sample_size:
                    raise ValueError("observed events cannot exceed sample size")
                if self.events == 0 and not has_reported:
                    raise ValueError(
                        "zero observed events require a reported O:E estimate with precision"
                    )
        elif metric == "CALIBRATION_SLOPE":
            if self.estimate is None:
                raise ValueError("CALIBRATION_SLOPE requires a reported estimate")
            if self.standard_error is None and (
                self.ci_lower is None or self.ci_upper is None
            ):
                raise ValueError("calibration slope requires a source-reported SE or CI")
        else:
            raise ValueError(f"unsupported prediction performance metric: {metric}")
        return self


class UnstructuredResultData(BaseModel):
    """Lossless migration envelope for data awaiting a method-family schema."""

    data_type: Literal["unstructured"] = "unstructured"
    fields: dict[str, Any] = Field(min_length=1)
    reason: str = "legacy_result_requires_typed_conversion"


class EffectEstimate(BaseModel):
    measure: str = Field(min_length=1)
    estimate: float
    standard_error: float | None = Field(default=None, gt=0)
    variance: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    scale: str = "original"
    adjusted: bool = False
    adjusted_covariates: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_precision(self):
        if self.standard_error is None and self.variance is None and (
            self.ci_lower is None or self.ci_upper is None
        ):
            raise ValueError("effect estimate requires SE, variance, or confidence interval")
        if self.ci_lower is not None and self.ci_upper is not None and self.ci_upper < self.ci_lower:
            raise ValueError("ci_upper must not be less than ci_lower")
        return self


class ResultEntity(LedgerEntity):
    kind: Literal[EntityKind.RESULT] = EntityKind.RESULT
    study_id: str = Field(min_length=1)
    report_id: str = Field(min_length=1)
    outcome_id: str = Field(min_length=1)
    arm_ids: list[str] = Field(min_length=1)
    cohort_id: str = ""
    timepoint: str = ""
    subgroup: str = ""
    analysis_population: str = ""
    effect_measure: str = Field(min_length=1)
    raw_data: (
        DichotomousData
        | ContinuousData
        | SingleArmProportionData
        | IncidenceRateData
        | DiagnosticAccuracyData
        | CorrelationData
        | ComparativeEffectData
        | DoseResponseData
        | IPDStudyData
        | PredictionPerformanceData
        | UnstructuredResultData
        | None
    ) = None
    estimate: EffectEstimate | None = None
    source_locators: list[SourceLocator] = Field(min_length=1)
    derivation: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_result_evidence(self):
        if self.raw_data is None and self.estimate is None:
            raise ValueError("result requires raw data or an effect estimate")
        if self.evidence_state in {EvidenceState.VERIFIED, EvidenceState.ADJUDICATED} and not any(
            locator.quote_verified and bool(locator.quote.strip()) for locator in self.source_locators
        ):
            raise ValueError("verified result requires at least one verified source locator")
        return self


EvidenceEntity = Annotated[
    Union[ReportEntity, StudyEntity, ArmEntity, OutcomeEntity, ResultEntity],
    Field(discriminator="kind"),
]


class LedgerEvent(BaseModel):
    schema_version: int = 1
    event_id: str
    sequence: int = Field(ge=1)
    review_id: str
    entity_id: str
    entity_kind: EntityKind
    entity_version: int = Field(ge=1)
    action: LedgerAction
    actor: EvidenceActor
    reason: str = ""
    occurred_at: datetime
    previous_hash: str = ""
    payload: dict[str, Any]
    event_hash: str


class LedgerVerification(BaseModel):
    valid: bool
    event_count: int
    head_hash: str = ""
    errors: list[str] = Field(default_factory=list)
