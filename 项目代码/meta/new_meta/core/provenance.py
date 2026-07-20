"""Source-provenance classification for primary synthesis rows.

The manuscript can display a recovered trial/registry source, but quality
gates must still know where the selected row originally came from.  This module
keeps that decision deterministic and shared by CLI, Web, facts, and validators.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Any


PRIMARY_ALLOWED_TIERS = {"primary_report", "trial_registry", "living_data"}
BENCHMARK_ALLOWED_TIERS = PRIMARY_ALLOWED_TIERS | {"secondary_meta_figure"}


def annotate_source_provenance(row: dict[str, Any]) -> dict[str, Any]:
    """Annotate a selected-effect row in-place and return it.

    ``source_location`` is allowed to be rewritten later for display, so the
    first location observed is preserved as ``source_location_original``.  If a
    row already carries a provenance tier, the tier is not downgraded by later
    display-source rewrites.
    """
    if not isinstance(row, dict):
        return row

    current_location = str(row.get("source_location") or "")
    original_location = str(row.get("source_location_original") or row.get("benchmark_source_location") or current_location)
    if current_location and not row.get("source_location_original"):
        row["source_location_original"] = current_location
    if original_location and not row.get("source_location_raw"):
        row["source_location_raw"] = original_location

    source_text = " ".join(
        str(row.get(key) or "")
        for key in (
            "source_location_original",
            "benchmark_source_location",
            "source_location_raw",
            "source_location",
            "source_section",
            "source_quote",
            "source_role",
        )
    )
    if row.get("source_provenance_tier"):
        tier = str(row.get("source_provenance_tier") or "unknown")
        reason = str(row.get("source_provenance_reason") or _reason_for_tier(tier))
    else:
        tier, reason = classify_source_provenance(source_text)
        row["source_provenance_tier"] = tier
        row["source_provenance_reason"] = reason

    row["source_allowed_in_publication"] = tier in PRIMARY_ALLOWED_TIERS
    row["source_allowed_in_benchmark"] = tier in BENCHMARK_ALLOWED_TIERS
    return row


def classify_source_provenance(text: str) -> tuple[str, str]:
    raw = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    if not raw:
        return "unknown", "No source text was available."

    if "who react" in raw or (
        "figure 2" in raw and re.search(r"\b(meta-analysis|meta analysis|pooled|published synthesis)\b", raw)
    ):
        return "secondary_meta_figure", "Source points to a published secondary meta-analysis figure."
    if re.search(r"\bclinicaltrials\.gov\b|\bnct\d{8}\b|\beudract\b|clinicaltrialsregister\.eu", raw):
        return "trial_registry", "Source points to a trial registry or registry results record."
    if re.search(r"\bcovid-nma\b|\bliving data\b|\bliving systematic review\b|\bliving platform\b", raw):
        return "living_data", "Source points to a living-data record."
    if re.search(r"\bprotocol\b", raw) and not re.search(r"\bresults?\b|\btable\b|\bfigure\b", raw):
        return "protocol", "Source appears to be a protocol without primary results."
    if re.search(r"\b(table|figure|supplement|appendix|results?|findings?|abstract)\b", raw):
        return "primary_report", "Source appears to be a primary report location."
    return "unknown", "Source type could not be classified deterministically."


def source_provenance_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    annotated = [annotate_source_provenance(row) for row in rows or [] if isinstance(row, dict)]
    counts = Counter(str(row.get("source_provenance_tier") or "unknown") for row in annotated)
    blocked = [
        {
            "row_id": row.get("row_id") or row.get("study_id") or "",
            "study_id": row.get("study_id") or "",
            "study_label": row.get("study_label") or "",
            "source_location": row.get("source_location") or "",
            "source_location_original": row.get("source_location_original") or row.get("benchmark_source_location") or "",
            "source_provenance_tier": row.get("source_provenance_tier") or "unknown",
            "source_provenance_reason": row.get("source_provenance_reason") or "",
        }
        for row in annotated
        if str(row.get("source_provenance_tier") or "unknown") not in PRIMARY_ALLOWED_TIERS
    ]
    return {
        "counts": dict(sorted(counts.items())),
        "publication_blocking_rows": blocked,
        "publication_blocking_count": len(blocked),
    }


def _reason_for_tier(tier: str) -> str:
    if tier == "secondary_meta_figure":
        return "Source points to a published secondary meta-analysis figure."
    if tier == "trial_registry":
        return "Source points to a trial registry or registry results record."
    if tier == "living_data":
        return "Source points to a living-data record."
    if tier == "primary_report":
        return "Source appears to be a primary report location."
    if tier == "protocol":
        return "Source appears to be a protocol without primary results."
    return "Source type could not be classified deterministically."
