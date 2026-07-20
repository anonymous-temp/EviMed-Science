"""Study characteristics and outcome data models."""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, field_validator, model_validator


def _parse_p_value_string(val: str) -> float | None:
    """Parse p-value strings like 'p<0.01', '<0.05', 'P = 0.03', '>.05', etc."""
    low = val.strip().lower().replace("＜", "<").replace("＞", ">").replace("＝", "=")
    # Strip leading 'p' and whitespace: "p<0.01" → "<0.01", "p = 0.03" → "= 0.03"
    low = re.sub(r'^p\s*', '', low).strip()
    if low.startswith(("<", "≤")):
        try:
            return float(low.lstrip("<≤").strip())
        except ValueError:
            return None
    if low.startswith((">", "≥")):
        try:
            return float(low.lstrip(">≥").strip())
        except ValueError:
            return None
    if low.startswith("="):
        low = low.lstrip("=").strip()
    try:
        return float(low)
    except ValueError:
        return None


def _coerce_llm_number(value, *, integer: bool = False):
    """Coerce common LLM numeric shapes into a scalar.

    LLMs sometimes return arm-specific mappings such as
    {"fixed-dose": 137, "shock-dependent": 146} for sample-size fields. For
    count-like schema fields this is recoverable: sum numeric leaves instead of
    failing validation and forcing a full extraction retry.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if integer and isinstance(value, float) and not value.is_integer():
            return None
        return int(value) if integer else float(value)
    if isinstance(value, dict):
        for key in ("exact_value", "value", "n", "total", "sample_size"):
            if key in value:
                coerced = _coerce_llm_number(value[key], integer=integer)
                if coerced is not None:
                    return coerced
        nums = [
            _coerce_llm_number(v, integer=integer)
            for v in value.values()
        ]
        nums = [n for n in nums if n is not None]
        if nums:
            total = sum(nums)
            return int(total) if integer else float(total)
        return None
    if isinstance(value, (list, tuple)):
        nums = [_coerce_llm_number(v, integer=integer) for v in value]
        nums = [n for n in nums if n is not None]
        if nums:
            total = sum(nums)
            return int(total) if integer else float(total)
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower() in {
            "", "not reported", "nr", "n/a", "na", "unknown", "unclear",
            "none", "-", "not applicable", "ns", "not significant",
        }:
            return None
        if integer and "%" in stripped:
            return None
        try:
            num = float(stripped.replace(",", ""))
            if integer and not num.is_integer():
                return None
            return int(num) if integer else num
        except (ValueError, TypeError):
            return None
    return None


def _field_in(mapping: dict, keys: set[str]):
    for key, value in mapping.items():
        normalized = re.sub(r"[^a-z0-9]+", "_", str(key).strip().lower()).strip("_")
        if normalized in keys:
            return value
    return None


def _has_rate_like_key(mapping: dict) -> bool:
    return any(
        any(marker in re.sub(r"[^a-z0-9]+", "_", str(key).strip().lower()) for marker in (
            "percent", "percentage", "proportion", "rate", "risk", "ratio",
        ))
        for key in mapping
    )


def _coerce_event_count(value):
    """Coerce only explicit integer event counts, never percentages or rates."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, str)):
        return _coerce_llm_number(value, integer=True)
    if isinstance(value, dict):
        event_value = _field_in(value, {
            "events", "event", "event_count", "n_events", "number_events", "count",
        })
        if event_value is not None:
            return _coerce_llm_number(event_value, integer=True)
        if _has_rate_like_key(value):
            return None
        nums = [_coerce_event_count(v) for v in value.values()]
        nums = [n for n in nums if n is not None]
        return sum(nums) if nums else None
    if isinstance(value, (list, tuple)):
        nums = [_coerce_event_count(v) for v in value]
        nums = [n for n in nums if n is not None]
        return sum(nums) if nums else None
    return None


def _coerce_total_count(value):
    """Coerce integer denominators/sample sizes, preserving summed arm mappings."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, str)):
        return _coerce_llm_number(value, integer=True)
    if isinstance(value, dict):
        total_value = _field_in(value, {
            "n", "total", "total_n", "sample_size", "denominator", "participants",
        })
        if total_value is not None:
            return _coerce_llm_number(total_value, integer=True)
        if _has_rate_like_key(value):
            return None
        nums = [_coerce_total_count(v) for v in value.values()]
        nums = [n for n in nums if n is not None]
        return sum(nums) if nums else None
    if isinstance(value, (list, tuple)):
        nums = [_coerce_total_count(v) for v in value]
        nums = [n for n in nums if n is not None]
        return sum(nums) if nums else None
    return None


def _coerce_llm_scalar_number(value, *, integer: bool = False):
    """Coerce a single numeric value without summing unrelated list entries."""
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            return None
        return _coerce_llm_scalar_number(value[0], integer=integer)
    if isinstance(value, dict):
        for key in ("exact_value", "value", "n", "total", "sample_size"):
            if key in value:
                return _coerce_llm_scalar_number(value[key], integer=integer)
        return None
    return _coerce_llm_number(value, integer=integer)


def _coerce_llm_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple, set)):
        return "; ".join(str(v) for v in value if v is not None and str(v).strip())
    if isinstance(value, dict):
        parts = []
        for key, val in value.items():
            if val is None or str(val).strip() == "":
                continue
            parts.append(f"{key}: {val}")
        return "; ".join(parts)
    return str(value)


class StudyCharacteristics(BaseModel):
    """Characteristics of a single included study."""
    study_id: str = ""
    title: str = ""
    authors: list[str] = []
    year: int = 0
    journal: str = ""
    doi: str = ""
    pmid: str = ""
    study_design: str = ""
    country: str = ""
    sample_size_intervention: int | None = None
    sample_size_control: int | None = None
    total_sample_size: int | None = None
    population_description: str = ""
    intervention_description: str = ""
    control_description: str = ""
    follow_up_duration: str = ""
    funding: str | None = None
    source_type: str = ""        # e.g. pubmed, user_upload, internal_db
    pdf_path: str = ""
    metadata_source: str = ""    # e.g. pubmed, llm_extracted_from_pdf

    @model_validator(mode="before")
    @classmethod
    def coerce_none_strings(cls, data):
        """Convert None to defaults for all fields; coerce non-numeric strings
        to None for numeric fields (LLM sometimes returns 'not reported')."""
        if not isinstance(data, dict):
            return data
        # list fields: None → []
        if "authors" in data and data["authors"] is None:
            data["authors"] = []
        # str fields: None → ""
        str_fields = {
            "study_id", "title", "journal", "doi", "pmid",
            "study_design", "country", "population_description",
            "intervention_description", "control_description", "follow_up_duration",
            "source_type", "pdf_path", "metadata_source",
        }
        for key in str_fields:
            if key in data:
                data[key] = _coerce_llm_text(data[key])
        # year: None or non-numeric string → 0
        if "year" in data:
            v = data["year"]
            if v is None:
                data["year"] = 0
            elif isinstance(v, str):
                try:
                    data["year"] = int(float(v.strip()))
                except (ValueError, TypeError):
                    data["year"] = 0
        # Coerce non-numeric strings to None for numeric-optional fields
        _numeric_fields = {
            "sample_size_intervention", "sample_size_control", "total_sample_size",
        }
        for key in _numeric_fields:
            if key in data:
                data[key] = _coerce_total_count(data[key])
        return data

    @field_validator("year")
    @classmethod
    def year_reasonable(cls, v):
        if v != 0 and (v < 1900 or v > 2100):
            raise ValueError(f"Year {v} is out of reasonable range (1900-2100)")
        return v


class ConflictNote(BaseModel):
    """A review note for internally conflicting or uncertain extracted data."""
    field: str = ""
    message: str = ""
    severity: str = "warning"
    observed_values: dict[str, Any] = {}
    sources: list[str] = []


class OutcomeData(BaseModel):
    """Outcome data extracted from a study, supporting multiple outcome types."""
    outcome_name: str = ""
    outcome_type: str = ""  # "continuous" / "dichotomous" / "time-to-event" / "proportion" / "correlation"

    @model_validator(mode="before")
    @classmethod
    def coerce_none_strings(cls, data):
        if not isinstance(data, dict):
            return data
        if data.get("adjustment_covariates") is None:
            data["adjustment_covariates"] = []
        str_fields = {
            "outcome_name", "outcome_type", "source_location", "source_quote",
            "reported_effect_measure", "reported_effect_scale",
            "prediction_model_id", "prediction_model_version",
            "prediction_validation_type", "prediction_performance_measure",
            "comparative_design", "contrast_id", "estimand_id", "precision_basis",
            "dose_response_design", "dose_unit",
        }
        for key in str_fields:
            if key in data and data[key] is None:
                data[key] = ""
        # Coerce non-numeric strings and recoverable count mappings to None/scalars.
        _numeric_fields = {
            "mean_intervention", "sd_intervention", "n_intervention",
            "mean_control", "sd_control", "n_control",
            "median_intervention", "q1_intervention", "q3_intervention",
            "min_intervention", "max_intervention",
            "median_control", "q1_control", "q3_control",
            "min_control", "max_control",
            "events_intervention", "total_intervention",
            "events_control", "total_control",
            "effect_size", "ci_lower", "ci_upper", "p_value",
            "source_page", "hazard_ratio", "hr_ci_lower", "hr_ci_upper", "hr_se",
            "events", "total_n", "correlation_r", "correlation_n",
            "pyears_intervention", "pyears_control",
            "true_positive", "false_negative", "false_positive", "true_negative",
            "person_time",
            "reported_effect_standard_error",
            "prediction_performance_estimate", "prediction_performance_se",
            "prediction_performance_ci_lower", "prediction_performance_ci_upper",
            "prediction_sample_size", "prediction_events", "prediction_expected_events",
            "intracluster_correlation", "mean_cluster_size",
            "dose_value", "reference_dose_value",
        }
        _nullish = {"", "not reported", "nr", "n/a", "na", "unknown", "unclear",
                     "none", "-", "not applicable", "ns", "not significant"}
        _event_fields = {
            "events_intervention", "events_control", "events",
            "true_positive", "false_negative", "false_positive", "true_negative",
            "prediction_events",
        }
        _total_fields = {
            "n_intervention", "n_control", "total_intervention", "total_control",
            "total_n", "correlation_n",
            "prediction_sample_size",
        }
        _integer_scalar_fields = {"source_page"}
        def _is_nullish_count_value(value) -> bool:
            if value is None:
                return True
            if isinstance(value, str):
                return value.strip().lower() in _nullish
            return False

        def _append_count_conflict(field: str, original_value) -> None:
            if _is_nullish_count_value(original_value):
                return
            conflicts = data.setdefault("conflicts", [])
            if isinstance(conflicts, list):
                conflicts.append({
                    "field": field,
                    "severity": "warning",
                    "message": (
                        "Count fields require explicit whole-number counts. "
                        "Percentages, rates, proportions, and fractional values were not used."
                    ),
                    "observed_values": {field: original_value},
                    "sources": ["schema_count_validation"],
                })

        for key in _numeric_fields:
            val = data.get(key)
            if val is None:
                continue
            if key in _event_fields:
                coerced = _coerce_event_count(val)
                data[key] = coerced
                if coerced is None:
                    _append_count_conflict(key, val)
                continue
            if key in _total_fields:
                coerced = _coerce_total_count(val)
                data[key] = coerced
                if coerced is None:
                    _append_count_conflict(key, val)
                continue
            if key in _integer_scalar_fields:
                data[key] = _coerce_llm_scalar_number(val, integer=True)
                continue
            if isinstance(val, (dict, list, tuple)):
                data[key] = _coerce_llm_scalar_number(val, integer=False)
                continue
            if not isinstance(val, str):
                continue
            stripped = val.strip()
            if not stripped:
                data[key] = None
                continue
            low = stripped.lower().replace("＜", "<").replace("＞", ">")
            # p_value: use dedicated parser for formats like "p<0.01", "<0.05", "P = 0.03"
            if key == "p_value":
                parsed = _parse_p_value_string(stripped)
                data[key] = parsed
                continue
            # Nullish strings → None
            if low in _nullish:
                data[key] = None
                continue
            # Try numeric conversion
            try:
                num = float(stripped)
                data[key] = int(num) if key.startswith(("n_", "events", "total_", "source_page", "correlation_n")) else num
            except (ValueError, TypeError):
                data[key] = None
        return data
    # Continuous outcome fields
    mean_intervention: float | None = None
    sd_intervention: float | None = None
    n_intervention: int | None = None
    mean_control: float | None = None
    sd_control: float | None = None
    n_control: int | None = None
    # Median/IQR or median/range fields for continuous outcomes
    median_intervention: float | None = None
    q1_intervention: float | None = None
    q3_intervention: float | None = None
    min_intervention: float | None = None
    max_intervention: float | None = None
    median_control: float | None = None
    q1_control: float | None = None
    q3_control: float | None = None
    min_control: float | None = None
    max_control: float | None = None
    # Dichotomous outcome fields
    events_intervention: int | None = None
    total_intervention: int | None = None
    events_control: int | None = None
    total_control: int | None = None
    # Pre-computed effect size (if reported directly)
    effect_size: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None
    p_value: float | None = None
    reported_effect_measure: str = ""
    reported_effect_standard_error: float | None = None
    reported_effect_scale: str = "original"
    reported_effect_adjusted: bool = False
    adjustment_covariates: list[str] = []
    # Evidence traceability
    source_location: str = ""  # e.g. "Table 2, page 5"
    source_quote: str = ""     # verbatim quote from paper
    source_page: int | None = None       # From [PAGE N] markers
    source_section: str | None = None    # e.g. "Results", "Table 2"
    source_quote_verified: bool | None = None
    source_quote_match: str | None = None
    extraction_confidence: str | None = None
    conflicts: list[ConflictNote] = []
    user_override_applied: bool = False
    override_revision: int | None = None
    timepoint: str | None = None
    accepted_timepoint: str | None = None
    timepoint_adjudication: str | None = None
    timepoint_adjudication_note: str | None = None
    manual_adjudication: bool | None = None
    # Subgroup info
    subgroup: str | None = None
    # Time-to-event (HR) fields
    hazard_ratio: float | None = None
    hr_ci_lower: float | None = None
    hr_ci_upper: float | None = None
    hr_se: float | None = None
    # Proportion fields (single-arm)
    events: int | None = None
    total_n: int | None = None
    # Correlation fields
    correlation_r: float | None = None
    correlation_n: int | None = None
    # Incidence rate fields (person-years for IRR)
    pyears_intervention: float | None = None
    pyears_control: float | None = None
    # Single-arm incidence rate fields
    person_time: float | None = None
    person_time_unit: str = "person_years"
    # Diagnostic accuracy 2x2 table
    true_positive: int | None = None
    false_negative: int | None = None
    false_positive: int | None = None
    true_negative: int | None = None
    diagnostic_threshold: str = ""
    # Prediction-model external validation performance
    prediction_model_id: str = ""
    prediction_model_version: str = ""
    prediction_validation_type: str = ""
    prediction_performance_measure: str = ""
    prediction_performance_estimate: float | None = None
    prediction_performance_se: float | None = None
    prediction_performance_ci_lower: float | None = None
    prediction_performance_ci_upper: float | None = None
    prediction_sample_size: int | None = None
    prediction_events: int | None = None
    prediction_expected_events: float | None = None
    # NMA fields
    treatment_arm: str | None = None
    reference_arm: str | None = None
    # Design-aware comparative-effect fields for complex RCTs and NMA.
    comparative_design: str = ""
    contrast_id: str = ""
    estimand_id: str = ""
    precision_basis: str = ""
    covariance_with: dict[str, float] = {}
    paired_analysis: bool = False
    intracluster_correlation: float | None = None
    mean_cluster_size: float | None = None
    # Aggregate categorical dose-response fields.
    dose_response_design: str = ""
    dose_value: float | None = None
    reference_dose_value: float | None = None
    dose_unit: str = ""
    # Provenance for arm denominators when not quoted verbatim (e.g. recovered
    # deterministically from reported arm percentages). Empty when totals are
    # taken directly from the source text.
    denominator_source: str = ""

    @field_validator("sd_intervention", "sd_control")
    @classmethod
    def sd_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError(f"Standard deviation must be non-negative, got {v}")
        return v

    @field_validator("n_intervention", "n_control", "total_intervention", "total_control")
    @classmethod
    def sample_size_positive(cls, v):
        if v is not None and v <= 0:
            raise ValueError(f"Sample size must be positive, got {v}")
        return v

    @field_validator("ci_upper")
    @classmethod
    def ci_order(cls, v, info):
        ci_lower = info.data.get("ci_lower")
        if v is not None and ci_lower is not None and v < ci_lower:
            raise ValueError(f"CI upper ({v}) must be >= CI lower ({ci_lower})")
        return v

    @field_validator("p_value")
    @classmethod
    def p_value_valid(cls, v):
        if v is not None and (v < 0 or v > 1):
            raise ValueError(f"p-value must be between 0 and 1, got {v}")
        return v

    @field_validator("correlation_r")
    @classmethod
    def correlation_range(cls, v):
        if v is not None and (v < -1 or v > 1):
            raise ValueError(f"Correlation must be between -1 and 1, got {v}")
        return v


class ExtractedStudy(BaseModel):
    """Complete extracted data for one study."""
    characteristics: StudyCharacteristics
    outcomes: list[OutcomeData] = []
    quality_notes: str = ""
