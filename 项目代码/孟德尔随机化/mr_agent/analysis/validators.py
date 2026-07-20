# [IN] MRAnalysisResult
# [OUT] Validation report
# [POS] mr_agent/analysis/validators.py - Result quality checks
"""MR result validation and quality control."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from statistics import NormalDist

from mr_agent.models import MRAnalysisResult

logger = logging.getLogger(__name__)


@dataclass
class ValidationReport:
    passed: bool = True
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)


def validate_result(result: MRAnalysisResult) -> ValidationReport:
    """Run all validation checks on MR result."""
    report = ValidationReport()
    _check_no_results(result, report)
    if report.errors:
        report.passed = False
        return report
    _check_instruments(result, report)
    _check_consistency(result, report)
    _check_pleiotropy(result, report)
    _check_heterogeneity(result, report)
    _check_steiger(result, report)
    _check_presso(result, report)
    _check_power(result, report)
    _check_effect_plausibility(result, report)
    _check_sample_overlap(result, report)
    report.passed = len(report.errors) == 0
    return report


def _check_no_results(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check if analysis produced any results at all."""
    if not result.mr_results:
        report.errors.append(
            f"No MR results for {result.exposure_id} → {result.outcome_id}. "
            "Possible causes: insufficient IVs, no GWAS overlap, or API error."
        )


def _check_instruments(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check instrumental variable quality."""
    if result.n_instruments < 3:
        report.errors.append(
            f"Too few instruments: {result.n_instruments} (minimum 3)"
        )
    elif result.n_instruments < 10:
        report.warnings.append(
            f"Low number of instruments: {result.n_instruments}"
        )
    if result.f_statistic_mean is not None:
        report.metrics["mean_f_statistic"] = result.f_statistic_mean
        if result.f_statistic_mean < 10:
            report.warnings.append(
                f"Weak instruments: mean F={result.f_statistic_mean:.1f} (<10)"
            )


def _check_consistency(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check consistency across MR methods."""
    if len(result.mr_results) < 2:
        return
    significant = [r for r in result.mr_results if r.pval < 0.05]
    directions = set()
    for r in result.mr_results:
        directions.add("positive" if r.beta > 0 else "negative")
    if len(directions) > 1:
        report.warnings.append("Inconsistent effect direction across methods")
    report.metrics["n_significant_methods"] = len(significant)
    report.metrics["n_total_methods"] = len(result.mr_results)


def _check_pleiotropy(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check for horizontal pleiotropy."""
    if not result.pleiotropy:
        return
    p = result.pleiotropy
    report.metrics["egger_intercept_pval"] = p.pval
    if p.pval < 0.05:
        report.warnings.append(
            f"Potential horizontal pleiotropy detected "
            f"(MR-Egger intercept p={p.pval:.4f})"
        )


def _check_heterogeneity(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check for heterogeneity in effects."""
    for h in result.heterogeneity:
        report.metrics[f"het_q_pval_{h.method}"] = h.q_pval
        if h.q_pval < 0.05:
            report.warnings.append(
                f"Significant heterogeneity ({h.method}: Q p={h.q_pval:.4f})"
            )


def _check_steiger(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check Steiger directionality test if available."""
    if result.steiger_correct is not None and not result.steiger_correct:
        report.warnings.append(
            "Steiger test suggests incorrect causal direction"
        )


def _check_presso(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check MR-PRESSO global pleiotropy test."""
    if result.presso_global_pval is None:
        return
    report.metrics["presso_global_pval"] = result.presso_global_pval
    if result.presso_global_pval < 0.05:
        msg = (
            f"MR-PRESSO detected significant global pleiotropy "
            f"(p={result.presso_global_pval:.4f})"
        )
        if result.presso_n_outliers:
            msg += f", {result.presso_n_outliers} outlier(s) detected"
        report.warnings.append(msg)


_normal = NormalDist()


def _calculate_power(
    n_ivs: int, r2: float | None, sample_size: int | None, alpha: float = 0.05,
) -> float | None:
    """Approximate MR statistical power using Brion 2013 formula.

    power ≈ Φ(√(N * R² / k) - z_{α/2})
    where N=sample_size, k=n_ivs, R²=variance explained.
    """
    if r2 is None or sample_size is None or n_ivs < 1:
        return None
    if r2 <= 0 or sample_size <= 0:
        return None
    z_alpha = _normal.inv_cdf(1 - alpha / 2)
    ncp = math.sqrt(sample_size * r2 / n_ivs)
    return _normal.cdf(ncp - z_alpha)


def _check_power(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check statistical power with Brion 2013 approximation."""
    if result.f_statistic_mean is None or result.n_instruments <= 0:
        return
    f_mean = result.f_statistic_mean
    k = result.n_instruments
    # Use actual sample size if available, otherwise fallback to heuristic
    sample_n = result.sample_size_outcome or result.sample_size_exposure
    if sample_n and sample_n > 0:
        # R² ≈ k*F / (k*F + N - k - 1)
        approx_r2 = k * f_mean / (k * f_mean + sample_n - k - 1)
        power = _calculate_power(k, approx_r2, sample_n, 0.05)
        if power is not None:
            report.metrics["statistical_power"] = power
            report.metrics["sample_size_used"] = float(sample_n)
            if power < 0.8:
                report.warnings.append(
                    f"Low statistical power: {power:.2f} (<0.80). "
                    f"Results may be underpowered (N={sample_n:,})."
                )
            return
    # Fallback: no real sample size available
    approx_r2 = k * f_mean / (k * f_mean + 10000)
    power = _calculate_power(k, approx_r2, 10000, 0.05)
    if power is not None:
        report.metrics["statistical_power"] = power
        if power < 0.8:
            report.warnings.append(
                f"Low statistical power: {power:.2f} (<0.80). "
                f"Results may be underpowered. "
                f"Note: actual sample size unavailable, using N=10000 estimate."
            )
        return
    # Final heuristic fallback
    if result.n_instruments < 5 and f_mean < 20:
        report.warnings.append(
            f"Potentially underpowered: only {result.n_instruments} IVs "
            f"with mean F={f_mean:.1f}"
        )


def _check_effect_plausibility(
    result: MRAnalysisResult, report: ValidationReport,
) -> None:
    """Flag implausible effect sizes (OR > 10 or OR < 0.1)."""
    for m in result.mr_results:
        if m.or_value is None:
            continue
        if m.or_value > 10:
            report.warnings.append(
                f"Implausibly large effect: {m.method} OR={m.or_value:.2f} (>10)"
            )
        elif m.or_value < 0.1:
            report.warnings.append(
                f"Implausibly large protective effect: "
                f"{m.method} OR={m.or_value:.3f} (<0.1)"
            )


def _check_sample_overlap(result: MRAnalysisResult, report: ValidationReport) -> None:
    """Check for potential sample overlap between exposure and outcome GWAS."""
    if not same_consortium_prefix(result.exposure_id, result.outcome_id):
        return
    prefix = result.exposure_id.lower().split("-")[0]
    result.sample_overlap_warning = True
    report.warnings.append(
        f"Potential sample overlap: both GWAS share consortium prefix "
        f"'{prefix}'. Consider MR-LAP or split-sample approaches."
    )


def same_consortium_prefix(id1: str, id2: str) -> bool:
    """Check if two GWAS IDs share the same consortium prefix."""
    p1 = id1.lower().split("-")[0] if "-" in id1 else ""
    p2 = id2.lower().split("-")[0] if "-" in id2 else ""
    return bool(p1) and p1 == p2


def format_validation_report(report: ValidationReport, lang: str = "zh") -> str:
    """Format validation report for display."""
    lines = []
    status = "PASS" if report.passed else "FAIL"
    lines.append(f"质量检查: {status}" if lang == "zh" else f"Quality Check: {status}")
    if report.errors:
        header = "错误:" if lang == "zh" else "Errors:"
        lines.append(header)
        lines.extend(f"  - {e}" for e in report.errors)
    if report.warnings:
        header = "警告:" if lang == "zh" else "Warnings:"
        lines.append(header)
        lines.extend(f"  - {w}" for w in report.warnings)
    if report.metrics:
        header = "关键指标:" if lang == "zh" else "Key Metrics:"
        lines.append(header)
        lines.extend(_format_metric(k, v) for k, v in report.metrics.items())
    return "\n".join(lines)


def _format_metric(key: str, value: float) -> str:
    """Format a single metric key-value pair."""
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return f"  {key}: N/A"
    if isinstance(value, int) or (isinstance(value, float) and value == int(value)):
        return f"  {key}: {int(value)}"
    return f"  {key}: {value:.4f}"
