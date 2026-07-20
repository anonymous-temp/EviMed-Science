"""Markdown and CSV renderers for one drug-class analysis result."""

from __future__ import annotations

import csv
import io

from safety_agent.drug_classes.models import ClassAnalysisResult


def render_class_markdown(result: ClassAnalysisResult) -> str:
    lines = [
        f"# {result.class_name} -- FAERS class safety analysis",
        "",
        f"- Definition: `{result.class_id}` / {result.definition_version}",
        f"- Members: {', '.join(result.members)}",
        f"- ATC: {', '.join(result.atc_codes) or 'not specified'}",
        f"- Snapshot: {result.snapshot_id} ({result.snapshot_source})",
        f"- Matching class reports: {result.total_reports}",
        f"- Exact suspect binding: {result.suspect_binding}; roles: {', '.join(result.suspect_roles)}",
        f"- Statistics: {result.statistics_version}; GPS prior: "
        f"{'fitted' if result.gps_prior_fitted else 'unfitted exploratory'}"
        f"{f' ({result.gps_prior_id})' if result.gps_prior_id else ''}",
        "",
    ]
    if result.members_without_reports:
        lines.append(
            "- Members without reports (not estimated): "
            + ", ".join(result.members_without_reports)
        )
    if result.unavailable_reactions:
        lines.append(
            "- Requested PTs absent from snapshot (not estimated): "
            + ", ".join(result.unavailable_reactions)
        )
    lines.extend([
        "",
        "## Comparison matrix",
        "",
        "| Target | Comparator | PT | a | b | c | d | Overlap excluded | ROR [95% CI] | IC025 | EB05 | Signal |",
        "|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|",
    ])
    for row in result.comparisons:
        lines.append(
            f"| {row.target_id} | {row.comparator} | {row.reaction} | {row.a:g} | {row.b:g} | "
            f"{row.c:g} | {row.d:g} | {row.overlap_excluded} | {row.ror:.3f} "
            f"[{row.ror_ci95_lower:.3f}, {row.ror_ci95_upper:.3f}] | {row.ic025:.3f} | "
            f"{row.eb05:.3f} | {'yes' if row.is_signal else 'no'} |"
        )
    lines.extend(["", "## Shared and unique signals", ""])
    lines.append(f"- Shared by every member: {', '.join(result.shared_signals) or 'none'}")
    for member, signals in result.unique_signals.items():
        lines.append(f"- {member} only: {', '.join(signals) or 'none'}")
    lines.extend(["", "## SOC / SMQ / IME mapping", ""])
    lines.append(f"Mapping coverage: {result.taxonomy_coverage:.1%}")
    lines.extend(["", "| PT | SOC | SMQ | IME | Source |", "|---|---|---|---|---|"])
    for item in result.taxonomy:
        lines.append(
            f"| {item.reaction} | {item.soc or 'unmapped'} | {', '.join(item.smqs) or '--'} | "
            f"{'yes' if item.is_ime else 'no'} | {item.source} |"
        )
    lines.extend(["", "## Treatment strata and time-to-onset", ""])
    if result.therapy_strata:
        lines.append(
            f"- Monotherapy: {result.therapy_strata.monotherapy}; "
            f"polytherapy: {result.therapy_strata.polytherapy} ({result.therapy_strata.definition})"
        )
    for item in result.time_to_onset:
        lines.append(
            f"- {item.reaction}: observed={item.observed}, missing={item.missing}, "
            f"median={item.median_days if item.median_days is not None else '--'} days, "
            f"IQR={item.q1_days if item.q1_days is not None else '--'}--"
            f"{item.q3_days if item.q3_days is not None else '--'}"
        )
    lines.extend(["", "## First-year post-approval sensitivity", ""])
    lines.extend(
        f"- {item.member_id}: {item.date_from} to {item.date_to}; reports={item.report_count}; signals={item.signal_count}"
        for item in result.approval_sensitivity
    )
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in result.limitations)
    lines.extend(["", "## Definition provenance", ""])
    lines.extend(f"- {source}" for source in result.definition_sources)
    return "\n".join(lines) + "\n"


def class_signal_csv(result: ClassAnalysisResult) -> str:
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow([
        "target_id", "comparator", "reaction", "a", "b", "c", "d", "n",
        "overlap_excluded", "ror", "ror_ci95_lower", "ror_ci95_upper", "prr",
        "chi2", "ic", "ic025", "ebgm", "eb05", "expected_count", "gps_prior_id",
        "statistics_version", "gps_prior_fitted", "haldane_anscombe_applied", "is_signal",
    ])
    for row in result.comparisons:
        writer.writerow([
            row.target_id, row.comparator, row.reaction, row.a, row.b, row.c, row.d,
            row.n, row.overlap_excluded, row.ror, row.ror_ci95_lower,
            row.ror_ci95_upper, row.prr, row.chi2, row.ic, row.ic025, row.ebgm,
            row.eb05, row.expected_count, row.gps_prior_id, result.statistics_version,
            result.gps_prior_fitted, row.haldane_anscombe_applied, row.is_signal,
        ])
    return stream.getvalue()
