# [IN] None
# [OUT] All data models used across the project
# [POS] mr_agent/models.py - Foundation data models
"""Pydantic data models for MR Analysis Agent."""

from __future__ import annotations

from mr_agent.source_context import unknown_scale, unknown_overlap

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

from mr_agent import number_display as shown


# --- Enums ---

class AnalysisMode(str, Enum):
    DISCOVERY = "discovery"
    VALIDATION = "validation"


class MRMethod(str, Enum):
    """Methods this engine can actually run.

    MOE and MR-LAP were removed on 2026-09-10: neither had ever produced a
    result (see the note in r_scripts/templates.py). Restoring a method means
    shipping its reference data and an end-to-end test, not re-adding a name.
    """

    STANDARD = "standard"
    MVMR = "mvmr"


class DataSourceType(str, Enum):
    OPENGWAS = "opengwas"
    LOCAL_FILE = "local_file"
    EQTL = "eqtl"
    PQTL = "pqtl"
    VCF = "vcf"
    #: Harmonised summary statistics read from the NHGRI-EBI GWAS Catalog by
    #: mr_agent/tools/open_sumstats.py into local files: analysed on the local
    #: path, reported as the catalogue study it came from.
    GWAS_CATALOG = "gwas_catalog"


class ColumnPreset(str, Enum):
    TWOSAMPLEMR = "twosamplemr"
    EQTLGEN = "eqtlgen"
    GTEX = "gtex"
    FINNGEN = "finngen"
    UKB_PPP = "ukb_ppp"
    GWAS_CATALOG = "gwas_catalog"
    CUSTOM = "custom"


class SessionPhase(str, Enum):
    GREETING = "greeting"
    INTENT_RECOGNITION = "intent_recognition"
    CLARIFICATION = "clarification"
    DATA_CONFIGURATION = "data_configuration"
    DATA_RETRIEVAL = "data_retrieval"
    ANALYSIS = "analysis"
    RESULTS = "results"
    QA = "qa"
    PAPER_OUTLINE = "paper_outline"
    PAPER_GENERATION = "paper_generation"
    COMPLETED = "completed"


class Intent(str, Enum):
    MR_ANALYSIS = "mr_analysis"
    EXPLAIN_RESULTS = "explain_results"
    GENERATE_PAPER = "generate_paper"
    MODIFY_ANALYSIS = "modify_analysis"
    GENERAL_QUESTION = "general_question"
    UNKNOWN = "unknown"


# --- Core Data Models ---

class ExposureOutcome(BaseModel):
    exposure: str
    outcome: str
    source_paper: str | None = None
    mr_exists: bool | None = None
    mr_study_title: str | None = None


class ColumnMapping(BaseModel):
    """Maps user file columns to TwoSampleMR expected names."""
    snp: str = "SNP"
    beta: str = "beta"
    se: str = "se"
    effect_allele: str = "effect_allele"
    other_allele: str = "other_allele"
    eaf: str = "eaf"
    pval: str = "pval"
    chr: str | None = None
    pos: str | None = None
    samplesize: str | None = None
    gene: str | None = None
    z_score_column: str | None = None
    log10p: str | None = None


class DataSource(BaseModel):
    """Describes a GWAS data source (remote API or local file)."""
    source_type: DataSourceType = DataSourceType.OPENGWAS
    gwas_id: str | None = None
    file_path: str | None = None
    column_mapping: ColumnMapping | None = None
    trait_name: str = ""
    sample_size: int | None = None
    population: str | None = None
    instruments_preclumped: bool = False
    clumping_provenance: str | None = Field(default=None, max_length=4000)
    #: How this engine itself selected the instruments (open-data path only):
    #: written verbatim to instrument-selection.json instead of the
    #: "provided by the supplier, not rechecked" declaration.
    selection: dict[str, Any] | None = None
    effect_scale: dict[str, Any] = Field(default_factory=unknown_scale)

    @model_validator(mode="after")
    def require_preclumped_provenance(self) -> "DataSource":
        if self.instruments_preclumped:
            if not self.is_local() or not self.clumping_provenance or not self.clumping_provenance.strip():
                raise ValueError("Preclumped local instruments require explicit source provenance.")
        return self

    def is_local(self) -> bool:
        return self.source_type != DataSourceType.OPENGWAS

    def display_id(self) -> str:
        if self.gwas_id:
            return self.gwas_id
        if self.file_path:
            return Path(self.file_path).name
        return self.trait_name or "unknown"


class GWASEntry(BaseModel):
    gwas_id: str
    trait: str
    year: int | None = None
    consortium: str | None = None
    sample_size: int | None = None
    nsnp: int | None = None
    population: str | None = None
    effect_scale: dict[str, Any] = Field(default_factory=unknown_scale)


# Every result that carries numbers carries `display` beside them: the strings
# a report states, rendered once by mr_agent.number_display. The raw values
# stay for machines. MR is a genetics study, so its p values below 0.001 are
# written in scientific notation.


class MRResult(BaseModel):
    method: str
    nsnp: int
    beta: float
    se: float
    pval: float
    or_value: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None

    @computed_field
    @property
    def display(self) -> dict[str, str | None]:
        odds = shown.interval(self.or_value, self.ci_lower, self.ci_upper, kind="ratio")
        return {
            "nsnp": shown.count(self.nsnp),
            "beta": shown.estimate(self.beta),
            "se": shown.estimate(self.se),
            "pval": shown.p_value(self.pval, genetic=True),
            "or_value": odds["estimate"],
            "ci_lower": odds["lower"],
            "ci_upper": odds["upper"],
            "or_ci": odds["interval"],
        }


def find_ivw(mr_results: list[MRResult]) -> MRResult | None:
    """Find the IVW result from a list of MR results, with fallback to first."""
    for mr in mr_results:
        method_lower = mr.method.lower()
        if "inverse variance weighted" in method_lower or "ivw" in method_lower:
            return mr
    return mr_results[0] if mr_results else None


class HeterogeneityResult(BaseModel):
    method: str
    q: float
    q_df: int
    q_pval: float

    @computed_field
    @property
    def display(self) -> dict[str, str | None]:
        return {
            "q": shown.estimate(self.q),
            "q_df": shown.count(self.q_df),
            "q_pval": shown.p_value(self.q_pval, genetic=True),
        }


class PleiotopyResult(BaseModel):
    egger_intercept: float
    se: float
    pval: float

    @computed_field
    @property
    def display(self) -> dict[str, str | None]:
        return {
            "egger_intercept": shown.estimate(self.egger_intercept),
            "se": shown.estimate(self.se),
            "pval": shown.p_value(self.pval, genetic=True),
        }


class MRPressoCorrection(BaseModel):
    """MR-PRESSO's outlier-corrected estimate, or the reason there is none.

    MR-PRESSO tests single variants only after a significant global test, and
    re-estimates without the variants its outlier test flags. `reason` is empty
    exactly when the corrected estimate exists.
    """

    n_distributions: int | None = None
    #: The smallest Bonferroni-corrected outlier p the draws can show
    #: (variants / draws); above the 0.05 threshold the outlier set is unstable.
    outlier_resolution: float | None = None
    outlier_snps: list[str] = Field(default_factory=list)
    beta: float | None = None
    se: float | None = None
    pval: float | None = None
    or_value: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None
    distortion_coefficient: float | None = None
    distortion_pval: float | None = Field(default=None, ge=0, le=1)
    distortion_pval_relation: Literal["=", "<"] = "="
    reason: str = ""


class LLMCallObservation(BaseModel):
    """One SDK create call, not the SDK's unobserved internal HTTP retries."""

    model_config = {"extra": "forbid"}
    sdk_call: int = Field(strict=True, ge=1, le=10)
    retry_attempt: int = Field(strict=True, ge=1, le=5)
    request_max_tokens: int | None = Field(default=None, strict=True, ge=0, le=1_000_000_000)
    category: Literal["http_error", "timeout", "connection", "response_error", "truncated", "empty_content", "completed"]
    error_type: str | None = Field(default=None, pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    status_code: int | None = Field(default=None, strict=True, ge=100, le=599)
    finish_reason: Literal["stop", "length", "content_filter", "tool_calls", "function_call"] | None = None
    content_present: bool | None = Field(default=None, strict=True)
    prompt_tokens: int | None = Field(default=None, strict=True, ge=0, le=1_000_000_000)
    completion_tokens: int | None = Field(default=None, strict=True, ge=0, le=1_000_000_000)
    total_tokens: int | None = Field(default=None, strict=True, ge=0, le=1_000_000_000)
    reasoning_tokens: int | None = Field(default=None, strict=True, ge=0, le=1_000_000_000)


class InterpretationFailure(BaseModel):
    """Bounded diagnostics from the failed call, without provider response text."""

    error_type: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    status_code: int | None = Field(default=None, strict=True, ge=100, le=599)
    finish_reason: Literal["stop", "length", "content_filter", "tool_calls", "function_call"] | None = None
    category: Literal["http_error", "timeout", "connection", "response_error", "truncated", "empty_content", "completed", "application_error", "client_error"] = "application_error"
    sdk_call_attempts: int | None = Field(default=None, strict=True, ge=0, le=10)
    calls: list[LLMCallObservation] = Field(default_factory=list, max_length=10)


class MRAnalysisResult(BaseModel):
    exposure_id: str
    outcome_id: str
    exposure_name: str = ""
    outcome_name: str = ""
    exposure_source_type: DataSourceType = DataSourceType.OPENGWAS
    outcome_source_type: DataSourceType = DataSourceType.OPENGWAS
    mr_results: list[MRResult] = Field(default_factory=list)
    heterogeneity: list[HeterogeneityResult] = Field(default_factory=list)
    pleiotropy: PleiotopyResult | None = None
    n_instruments: int = 0
    f_statistic_mean: float | None = None
    pval_threshold: float = 5e-8
    plots: dict[str, Path] = Field(default_factory=dict)
    raw_data_path: Path | None = None
    interpretation: str = ""
    # Legacy text alone cannot establish successful generation.
    interpretation_status: Literal["pending", "succeeded", "failed", "not_applicable"] = "pending"
    interpretation_error_code: Literal["", "mr_interpretation_failed"] = ""
    interpretation_failure: InterpretationFailure | None = None
    steiger_correct: bool | None = None
    steiger_pval: float | None = None
    # "not_computable" names the input the test lacks, never an empty result.
    steiger_status: Literal["not_run", "computed", "not_computable", "failed"] = "not_run"
    steiger_reason: str = ""
    steiger_r2_exposure: float | None = None
    steiger_r2_outcome: float | None = None
    presso_global_pval: float | None = Field(default=None, ge=0, le=1)
    # Permutation tests can report a strict upper bound, not an exact estimate.
    presso_global_pval_relation: Literal["=", "<"] = "="
    presso_n_outliers: int | None = None
    presso_correction: MRPressoCorrection | None = None
    radial_pval: float | None = None
    radial_n_outliers: int | None = None
    conmix_pval: float | None = None
    conmix_estimate: float | None = None
    conmix_ci_lower: float | None = None
    conmix_ci_upper: float | None = None
    conmix_n_intervals: int | None = None
    # Per-instrument F statistics (f_statistics.csv), summarised once here so a
    # report states them rather than recomputing them from the file.
    instrument_strength: dict[str, Any] = Field(default_factory=dict)
    # Optional analyses that did not run, each as "name: reason". An empty list
    # means every optional analysis ran; it is not the same as a list that was
    # never populated, which is why the R side always writes this field.
    skipped_analyses: list[str] = Field(default_factory=list)
    instrument_selection: dict[str, Any] = Field(default_factory=dict)
    #: Instruments that reached the analysis and why the rest did not (harmonisation.json).
    harmonisation: dict[str, Any] = Field(default_factory=dict)
    sample_overlap_warning: bool = False
    exposure_scale: dict[str, Any] = Field(default_factory=unknown_scale)
    outcome_scale: dict[str, Any] = Field(default_factory=unknown_scale)
    sample_overlap: dict[str, Any] = Field(default_factory=unknown_overlap)
    variant_sample_sizes: dict[str, Any] = Field(default_factory=dict)
    sample_size_exposure: int | None = None
    sample_size_outcome: int | None = None
    exposure_metadata: dict[str, Any] = Field(default_factory=dict)
    outcome_metadata: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.now)

    @model_validator(mode="after")
    def _a_verdict_was_computed(self) -> "MRAnalysisResult":
        if self.steiger_correct is not None and self.steiger_status == "not_run":
            self.steiger_status = "computed"
        return self

    @computed_field
    @property
    def display(self) -> dict[str, Any]:
        """The strings a report states for this result's scalar findings.

        Estimates, heterogeneity and pleiotropy carry their own `display`.
        """
        genetic = {"genetic": True}
        strength = self.instrument_strength or {}
        correction = self.presso_correction
        corrected = shown.interval(
            *((correction.or_value, correction.ci_lower, correction.ci_upper) if correction else (None,) * 3),
            kind="ratio",
        )
        conmix = shown.interval(self.conmix_estimate, self.conmix_ci_lower, self.conmix_ci_upper, kind="estimate")
        global_p = shown.bounded_p_value(
            f"<{self.presso_global_pval!r}" if self.presso_global_pval_relation == "<" else self.presso_global_pval,
            **genetic,
        )
        return {
            "convention": shown.CONVENTION,
            "n_instruments": shown.count(self.n_instruments),
            "sample_size_exposure": shown.count(self.sample_size_exposure),
            "sample_size_outcome": shown.count(self.sample_size_outcome),
            "f_statistic_mean": shown.estimate(self.f_statistic_mean),
            "instrument_strength": {
                key: (shown.count(value) if key in {"n", "below_10"} else shown.estimate(value))
                for key, value in strength.items() if not key.endswith("_snp")
            } | {key: value for key, value in strength.items() if key.endswith("_snp")},
            "steiger": {
                "status": self.steiger_status,
                "reason": self.steiger_reason,
                "correct_causal_direction": self.steiger_correct,
                "pval": shown.p_value(self.steiger_pval, **genetic),
                "r2_exposure": shown.estimate(self.steiger_r2_exposure),
                "r2_outcome": shown.estimate(self.steiger_r2_outcome),
            },
            "mr_presso": {
                "global_pval": global_p,
                "n_outliers": shown.count(self.presso_n_outliers),
                "outlier_snps": list(correction.outlier_snps) if correction else [],
                "outlier_resolution": shown.estimate(correction.outlier_resolution) if correction else None,
                "corrected_beta": shown.estimate(correction.beta) if correction else None,
                "corrected_se": shown.estimate(correction.se) if correction else None,
                "corrected_pval": shown.p_value(correction.pval, **genetic) if correction else None,
                "corrected_or": corrected["estimate"],
                "corrected_or_ci": corrected["interval"],
                "distortion_pval": None if correction is None else shown.bounded_p_value(
                    f"<{correction.distortion_pval!r}" if correction.distortion_pval_relation == "<"
                    else correction.distortion_pval,
                    **genetic,
                ),
                "reason": correction.reason if correction else "",
            },
            "radial": {
                "global_q_pval": shown.p_value(self.radial_pval, **genetic),
                "n_outliers": shown.count(self.radial_n_outliers),
            },
            "conmix": {
                "estimate": conmix["estimate"],
                "ci": conmix["interval"],
                "pval": shown.p_value(self.conmix_pval, **genetic),
                "n_intervals": shown.count(self.conmix_n_intervals),
            },
        }


class PaperReference(BaseModel):
    pmid: str | None = None
    doi: str | None = None
    title: str
    authors: str = ""
    journal: str = ""
    year: int | None = None
    abstract: str = ""


# --- Session State ---

class AnalysisSlots(BaseModel):
    """Slots to fill via conversation for MR analysis."""
    exposure: str | None = None
    outcome: str | None = None
    additional_outcomes: list[str] = Field(default_factory=list)
    mode: AnalysisMode = AnalysisMode.VALIDATION
    mr_method: MRMethod = MRMethod.STANDARD
    bidirectional: bool = False
    use_synonyms: bool = True
    population: str | None = None
    generate_paper: bool = True
    gwas_token: str | None = None
    exposure_source: DataSource | None = None
    outcome_source: DataSource | None = None
    covariates: list[str] = Field(default_factory=list)

    def all_outcomes(self) -> list[str]:
        """Return primary + additional outcomes (deduplicated)."""
        seen: set[str] = set()
        result: list[str] = []
        for o in [self.outcome, *self.additional_outcomes]:
            if o and o not in seen:
                seen.add(o)
                result.append(o)
        return result

    def missing_required(self) -> list[str]:
        missing = []
        if not self.exposure:
            missing.append("exposure")
        if not self.outcome:
            missing.append("outcome")
        return missing

    def is_complete(self) -> bool:
        return len(self.missing_required()) == 0

    def has_local_sources(self) -> bool:
        if self.exposure_source and self.exposure_source.is_local():
            return True
        if self.outcome_source and self.outcome_source.is_local():
            return True
        return False


class SessionState(BaseModel):
    """Complete session state - the single source of truth."""
    session_id: str = ""
    phase: SessionPhase = SessionPhase.GREETING
    slots: AnalysisSlots = Field(default_factory=AnalysisSlots)
    conversation_history: list[dict[str, Any]] = Field(default_factory=list)
    eo_pairs: list[ExposureOutcome] = Field(default_factory=list)
    gwas_entries: dict[str, list[GWASEntry]] = Field(default_factory=dict)
    analysis_results: list[MRAnalysisResult] = Field(default_factory=list)
    references: list[PaperReference] = Field(default_factory=list)
    paper_sections: dict[str, str] = Field(default_factory=dict)
    output_dir: Path | None = None
    errors: list[str] = Field(default_factory=list)
    # Classified code for the last failure ("opengwas_auth_failed", ...), so a
    # refused source does not reach the caller as an unlabelled message.
    error_code: str = ""
    last_completed_step: int = 0
    selected_gwas_ids: dict[str, list[str]] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=datetime.now)

    def add_message(self, role: str, content: str) -> None:
        self.conversation_history.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        })
