"""Meta-analysis result data models."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class StudyEffect(BaseModel):
    """Effect size for a single study (input to meta-analysis)."""
    study_id: str
    study_label: str  # e.g. "Smith 2020"
    yi: float         # point estimate (log-transformed for OR/RR/HR/IRR)
    vi: float         # variance
    se: float         # standard error
    weight: float = 0.0  # weight in the meta-analysis (computed)
    subgroup: str | None = None

    @field_validator("vi")
    @classmethod
    def variance_positive(cls, v):
        if v < 0:
            raise ValueError(f"Variance must be non-negative, got {v}")
        if v == 0:
            # Zero variance → assign tiny epsilon to avoid math errors downstream
            v = 1e-10
        return v

    @field_validator("se")
    @classmethod
    def se_positive(cls, v):
        if v < 0:
            raise ValueError(f"Standard error must be non-negative, got {v}")
        if v == 0:
            v = 1e-5
        return v


class PooledEffect(BaseModel):
    """Pooled effect from a meta-analysis."""
    outcome_name: str
    n_studies: int
    effect_measure: str  # "OR" / "RR" / "RD" / "MD" / "SMD" / "HR" / "PROP" / "COR" / "IRR"
    # Pooled result (on original scale for MD; exponentiated for OR/RR/HR/IRR)
    pooled_effect: float
    ci_lower: float
    ci_upper: float
    p_value: float
    # On log scale for OR/RR/HR/IRR
    pooled_log: float | None = None
    ci_lower_log: float | None = None
    ci_upper_log: float | None = None
    # Model info
    model: str = "random"  # "fixed" / "random"
    tau_estimator: str = "DL"  # "DL" / "REML" / "HKSJ"
    # Heterogeneity
    q_statistic: float = 0.0
    q_p_value: float = 0.0
    i_squared: float = 0.0
    tau_squared: float = 0.0
    h_squared: float = 0.0
    prediction_interval: tuple[float, float] | None = None
    subgroup_q_between: float | None = None
    subgroup_q_between_p: float | None = None
    # Per-study data
    studies: list[StudyEffect] = []


class LeaveOneOutResult(BaseModel):
    """Result of leaving one study out."""
    excluded_study_id: str
    excluded_study_label: str
    pooled_effect: float
    ci_lower: float
    ci_upper: float
    i_squared: float


class MetaRegressionResult(BaseModel):
    """Result of a meta-regression analysis."""
    covariate_name: str
    coefficient: float
    se: float
    ci_lower: float
    ci_upper: float
    p_value: float
    r_squared_analog: float  # proportion of τ² explained
    tau_squared_residual: float
    q_model: float
    q_model_p: float


class CumulativeResult(BaseModel):
    """Result of cumulative meta-analysis at one step."""
    study_label: str
    n_studies: int
    pooled_effect: float
    ci_lower: float
    ci_upper: float


class NMAContrast(BaseModel):
    """A single pairwise contrast for NMA."""
    treatment: str
    comparator: str
    effect: float
    ci_lower: float
    ci_upper: float
    p_value: float


class NMAResult(BaseModel):
    """Results from network meta-analysis."""
    treatments: list[str]
    reference: str
    model: str = "fixed"
    tau_squared: float = 0.0
    tau_estimator: str = "none"
    ranking_direction: str = "lower"
    league_table: list[NMAContrast] = Field(default_factory=list)
    sucra_rankings: dict[str, float] = Field(default_factory=dict)  # treatment → SUCRA score
    inconsistency_p: float | None = None  # global inconsistency test
    network_geometry: dict = Field(default_factory=dict)  # nodes, edges, connectivity info
    diagnostics: dict = Field(default_factory=dict)


class PublicationBiasResult(BaseModel):
    """Publication bias test results."""
    egger_intercept: float | None = None
    egger_se: float | None = None
    egger_p_value: float | None = None
    begg_tau: float | None = None
    begg_p_value: float | None = None
    trim_fill_missing: int | None = None
    trim_fill_adjusted_effect: float | None = None
    trim_fill_adjusted_ci_lower: float | None = None
    trim_fill_adjusted_ci_upper: float | None = None
    failsafe_n: int | None = None
    # PET-PEESE
    pet_intercept: float | None = None
    pet_p_value: float | None = None
    peese_intercept: float | None = None
    peese_p_value: float | None = None


class MetaAnalysisResults(BaseModel):
    """Complete meta-analysis results."""
    primary_outcome: PooledEffect
    secondary_outcomes: list[PooledEffect] = []
    leave_one_out: list[LeaveOneOutResult] = []
    subgroup_results: dict[str, list[PooledEffect]] = {}
    publication_bias: PublicationBiasResult | None = None
    meta_regression: list[MetaRegressionResult] = []
    cumulative: list[CumulativeResult] = []
    nma_result: NMAResult | None = None
    model_decision: dict = {}
    model_sensitivity: dict = {}
