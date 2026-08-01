# [IN] None
# [OUT] All data models used across the project
# [POS] mr_agent/models.py - Foundation data models
"""Pydantic data models for MR Analysis Agent."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


# --- Enums ---

class AnalysisMode(str, Enum):
    DISCOVERY = "discovery"
    VALIDATION = "validation"


class MRMethod(str, Enum):
    STANDARD = "standard"
    MOE = "moe"
    MRLAP = "mrlap"
    MVMR = "mvmr"


class DataSourceType(str, Enum):
    OPENGWAS = "opengwas"
    LOCAL_FILE = "local_file"
    EQTL = "eqtl"
    PQTL = "pqtl"
    VCF = "vcf"


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


class MRResult(BaseModel):
    method: str
    nsnp: int
    beta: float
    se: float
    pval: float
    or_value: float | None = None
    ci_lower: float | None = None
    ci_upper: float | None = None


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


class PleiotopyResult(BaseModel):
    egger_intercept: float
    se: float
    pval: float


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
    steiger_correct: bool | None = None
    steiger_pval: float | None = None
    presso_global_pval: float | None = None
    presso_n_outliers: int | None = None
    radial_pval: float | None = None
    conmix_pval: float | None = None
    # Optional analyses that did not run, each as "name: reason". An empty list
    # means every optional analysis ran; it is not the same as a list that was
    # never populated, which is why the R side always writes this field.
    skipped_analyses: list[str] = Field(default_factory=list)
    sample_overlap_warning: bool = False
    sample_size_exposure: int | None = None
    sample_size_outcome: int | None = None
    exposure_metadata: dict[str, Any] = Field(default_factory=dict)
    outcome_metadata: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.now)


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
    last_completed_step: int = 0
    selected_gwas_ids: dict[str, list[str]] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=datetime.now)

    def add_message(self, role: str, content: str) -> None:
        self.conversation_history.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        })
