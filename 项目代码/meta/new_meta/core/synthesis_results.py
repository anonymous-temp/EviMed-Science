"""Persistence helpers for the review-family-neutral synthesis contract."""
from __future__ import annotations

from new_meta.schemas.method_policy import MethodPlan
from new_meta.schemas.synthesis_result import SynthesisResultEnvelope


def persist_pairwise_synthesis_envelope(
    project,
    *,
    plan: MethodPlan,
    results,
) -> SynthesisResultEnvelope:
    audit = project.load_json("effect_selection_audit.json", subdir="analysis") or []
    result_ids = list(dict.fromkeys(
        str(row.get("result_id"))
        for row in audit
        if row.get("in_final_primary_analysis") and str(row.get("result_id") or "").strip()
    ))
    envelope = SynthesisResultEnvelope.from_pairwise_meta(
        plan=plan,
        results=results,
        input_result_ids=result_ids,
    )
    project.save_json("synthesis_result.json", envelope, subdir="analysis")
    return envelope
