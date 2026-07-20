"""File discovery for submission artifact packages."""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

from new_meta.core.project import Project


ROOT_PACKAGE_FILES = [
    "references.bib",
    "pipeline_warnings.json",
    "protocol_overrides.json",
    "llm_usage_manifest.json",
    "text_source_warnings.json",
    "search_query.txt",
    "search_strategy_report.txt",
    "search_source_counts.json",
    "prisma_flow.json",
    "pdf_intake_manifest.json",
]

PACKAGE_SUBDIR_FILES = {
    "manuscript": [
        "draft.md",
        "draft.docx",
        "draft.pdf",
        "manuscript_facts.json",
        "manuscript_validation.json",
        "manuscript_quality_gate.json",
        "submission_quality_gate.json",
        "quality_gate.json",
        "manuscript_llm_readiness_review.json",
        "manuscript_polish_audit.json",
        "manuscript_semantic_edit_audit.json",
        "manuscript_style_audit.json",
        "low_k_methodology_review_audit.json",
        "manuscript_citation_fixes.json",
        "claim_map.json",
        "claim_map_audit.json",
        "manuscript_plan.json",
        "claim_source_resolution_audit.json",
        "claim_source_alignment_audit.json",
        "citation_contract.json",
        "claim_map_citation_plan.json",
        "final_claim_map_citation_plan.json",
        "claim_map_authoring_audit.json",
        "citation_audit_review.json",
        "citation_grounding_audit.json",
    ],
    "extraction": [
        "extraction_audit.json",
        "extraction_audit.md",
        "extraction_overrides.json",
        "all_extractions.json",
    ],
    "analysis": [
        "effect_selection_audit.json",
        "effect_sizes.json",
        "meta_results.json",
        "grade_profile.json",
        "influence_diagnostics.json",
        "p_curve.json",
    ],
    "risk_of_bias": [
        "rob_results.json",
        "rob_summary.json",
        "rob_result_assessments.json",
        "rob_result_readiness.json",
        "rob_adjudications.json",
    ],
    "benchmark": [
        "benchmark_report.json",
        "benchmark_summary_card.json",
        "benchmark_registry_augmentation.json",
        "benchmark_source_manifest.json",
        "benchmark_source_decisions.json",
        "benchmark_source_applications.json",
    ],
}


def iter_existing_package_files(project: Project) -> Iterable[tuple[Path, str]]:
    """Yield non-empty project files that should be included in the handoff zip."""
    seen: set[str] = set()

    for filename in ROOT_PACKAGE_FILES:
        yield from entry_if_exists(project.base_dir / filename, filename, seen)

    for subdir, filenames in PACKAGE_SUBDIR_FILES.items():
        for filename in filenames:
            yield from entry_if_exists(project.base_dir / subdir / filename, f"{subdir}/{filename}", seen)

    figures_dir = project.base_dir / "figures"
    if figures_dir.exists():
        for path in sorted(figures_dir.glob("*.png")):
            yield from entry_if_exists(path, f"figures/{path.name}", seen)

    benchmark_parsed_dir = project.base_dir / "benchmark" / "source_parsed"
    if benchmark_parsed_dir.exists():
        for path in sorted(benchmark_parsed_dir.glob("*.json")):
            yield from entry_if_exists(path, f"benchmark/source_parsed/{path.name}", seen)


def entry_if_exists(path: Path, arcname: str, seen: set[str]) -> Iterable[tuple[Path, str]]:
    """Yield one archive entry when the source file exists, is non-empty, and is unique."""
    if not path.exists() or not path.is_file() or path.stat().st_size <= 0 or arcname in seen:
        return
    seen.add(arcname)
    yield path, arcname
