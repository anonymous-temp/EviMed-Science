"""Deterministic disproportionality statistics (ROR/PRR/chi2/IC/EBGM)."""

from .disproportionality import (
    DEFAULT_MGPS_PRIOR,
    ChiSquareResult,
    EBGMResult,
    ICResult,
    MGPSPrior,
    RatioMetric,
    SignalMetrics,
    analyze,
    analyze_dataframe,
    chi_square,
    ebgm,
    information_component,
    prr,
    ror,
)
from .rules import DEFAULT_CRITERIA, SignalCriteria, SignalDecision, evaluate
from .mgps_fit import (
    MGPSFitResult,
    fit_mgps_prior,
    gps_prior_fit_id,
    gps_scope_fingerprint,
    load_gps_prior_artifact,
    write_gps_fit_artifact,
)
from .tables import (
    HALDANE_ANSCOMBE,
    ContingencyTable2x2,
    build_table_from_counts,
    fetch_contingency_table,
)

__all__ = [
    "ChiSquareResult",
    "ContingencyTable2x2",
    "DEFAULT_CRITERIA",
    "DEFAULT_MGPS_PRIOR",
    "EBGMResult",
    "HALDANE_ANSCOMBE",
    "ICResult",
    "MGPSPrior",
    "MGPSFitResult",
    "RatioMetric",
    "SignalCriteria",
    "SignalDecision",
    "SignalMetrics",
    "analyze",
    "analyze_dataframe",
    "build_table_from_counts",
    "chi_square",
    "ebgm",
    "evaluate",
    "fetch_contingency_table",
    "fit_mgps_prior",
    "gps_prior_fit_id",
    "gps_scope_fingerprint",
    "load_gps_prior_artifact",
    "information_component",
    "prr",
    "ror",
    "write_gps_fit_artifact",
]
