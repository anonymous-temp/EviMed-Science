"""Artifact isolation for compiled synthesis routes.

Compiled methods and the legacy pairwise route share one project directory.
This module removes only derived outputs whose semantics are specific to the
legacy pairwise route so a resumed compiled-method run cannot accidentally
package or cite stale analyses and figures.
"""
from __future__ import annotations

from pathlib import Path


PAIRWISE_ANALYSIS_ARTIFACTS = (
    "effect_sizes.json",
    "meta_results.json",
    "grade_inputs_snapshot.json",
    "grade_profile.json",
    "influence_diagnostics.json",
    "model_decision.json",
    "model_sensitivity.json",
    "p_curve.json",
    "publication_bias.json",
    "meta_regression.json",
)

PAIRWISE_FIGURE_ARTIFACTS = (
    "forest_plot.png",
    "funnel_plot.png",
    "contour_funnel_plot.png",
    "baujat_plot.png",
    "cumulative_forest.png",
    "galbraith_plot.png",
    "sensitivity.png",
    "nma_network.png",
    "nma_league_table.png",
    "dose_response_curve.png",
    "rob_summary.png",
)

STALE_MANUSCRIPT_ARTIFACTS = (
    "draft.md",
    "draft.rejected.md",
    "draft.docx",
    "draft.pdf",
    "manuscript_facts.json",
    "manuscript_validation.json",
    "manuscript_style_audit.json",
    "manuscript_quality_gate.json",
    "quality_gate.json",
    "submission_quality_gate.json",
    "claim_map.json",
    "claim_map_audit.json",
    "claim_source_alignment_audit.json",
    "claim_source_resolution_audit.json",
    "claim_map_citation_plan.json",
    "final_claim_map_citation_plan.json",
    "claim_map_authoring_audit.json",
    "citation_contract.json",
    "citation_audit_review.json",
    "manuscript_semantic_edit_audit.json",
    "low_k_methodology_review_audit.json",
    "manuscript_final_citation_grounding_audit.json",
    "manuscript_llm_readiness_review.json",
    "manuscript_polish_audit.json",
)


def clear_stale_compiled_method_outputs(project) -> list[str]:
    """Delete stale, reproducible outputs before a compiled-method run.

    Evidence, extracted data, the ledger, protocol, search results, and all
    compiled-method inputs are intentionally outside this allow-list.
    """
    roots = (
        (Path(project.base_dir) / "analysis", PAIRWISE_ANALYSIS_ARTIFACTS),
        (Path(project.base_dir) / "figures", PAIRWISE_FIGURE_ARTIFACTS),
        (Path(project.base_dir) / "manuscript", STALE_MANUSCRIPT_ARTIFACTS),
    )
    removed: list[str] = []
    for directory, names in roots:
        for name in names:
            path = directory / name
            if not path.is_file():
                continue
            path.unlink()
            removed.append(str(path.relative_to(project.base_dir)))
    return removed
