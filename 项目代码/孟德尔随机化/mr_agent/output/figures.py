# [IN] MRAnalysisResult
# [OUT] Formatted text tables/figures
# [POS] mr_agent/output/figures.py - Figure and table handling
"""Figure and table output handling."""

from __future__ import annotations

from pathlib import Path

from mr_agent.models import MRAnalysisResult, find_ivw


def format_results_table(results: list[MRAnalysisResult]) -> str:
    """Format MR results as a text table."""
    header = (
        f"{'Method':<25} {'nSNP':>5} {'Beta':>10} {'SE':>10} "
        f"{'P-value':>12} {'OR':>8} {'95% CI':>18}"
    )
    separator = "-" * len(header)
    lines = [separator, header, separator]
    for result in results:
        for mr in result.mr_results:
            ci = ""
            if mr.ci_lower is not None and mr.ci_upper is not None:
                ci = f"[{mr.ci_lower:.3f}-{mr.ci_upper:.3f}]"
            or_val = f"{mr.or_value:.3f}" if mr.or_value is not None else "N/A"
            line = (
                f"{mr.method:<25} {mr.nsnp:>5} {mr.beta:>10.4f} "
                f"{mr.se:>10.4f} {mr.pval:>12.2e} {or_val:>8} {ci:>18}"
            )
            lines.append(line)
    lines.append(separator)
    return "\n".join(lines)


def format_summary_card(result: MRAnalysisResult, lang: str = "zh") -> str:
    """Format a compact summary card for display."""
    lines = []
    title = f"{result.exposure_name} → {result.outcome_name}"
    lines.append(f"{'='*50}")
    lines.append(title)
    lines.append(f"{'='*50}")
    lines.append(f"GWAS: {result.exposure_id} → {result.outcome_id}")
    lines.append(f"IVs: {result.n_instruments}")
    if result.f_statistic_mean is not None:
        lines.append(f"Mean F-stat: {result.f_statistic_mean:.1f}")
    ivw = find_ivw(result.mr_results)
    if ivw:
        sig = "***" if ivw.pval < 0.001 else "**" if ivw.pval < 0.01 else "*" if ivw.pval < 0.05 else "ns"
        or_str = f"OR={ivw.or_value:.3f}" if ivw.or_value is not None else f"beta={ivw.beta:.4f}"
        lines.append(f"IVW: {or_str}, p={ivw.pval:.2e} {sig}")
    if result.pleiotropy:
        p = result.pleiotropy
        lines.append(f"Pleiotropy: p={p.pval:.4f}")
    lines.append(f"{'='*50}")
    return "\n".join(lines)


def format_forest_summary(results: list[MRAnalysisResult]) -> str:
    """Format a text-based summary forest plot across all results."""
    header = (
        f"{'Pair':<40} {'OR':>8} {'95% CI':>18} {'P-value':>12} {'Dir':>5}"
    )
    separator = "-" * len(header)
    lines = [separator, "Summary Forest Plot (IVW)", separator, header, separator]
    for r in results:
        ivw = find_ivw(r.mr_results)
        if not ivw:
            continue
        pair = f"{r.exposure_name} → {r.outcome_name}"
        if len(pair) > 38:
            pair = pair[:35] + "..."
        or_str = f"{ivw.or_value:.3f}" if ivw.or_value is not None else "N/A"
        ci = ""
        if ivw.ci_lower is not None and ivw.ci_upper is not None:
            ci = f"[{ivw.ci_lower:.3f}-{ivw.ci_upper:.3f}]"
        direction = "+" if ivw.beta > 0 else "-"
        sig = "*" if ivw.pval < 0.05 else ""
        line = (
            f"{pair:<40} {or_str:>8} {ci:>18} "
            f"{ivw.pval:>12.2e} {direction+sig:>5}"
        )
        lines.append(line)
    lines.append(separator)
    return "\n".join(lines)
