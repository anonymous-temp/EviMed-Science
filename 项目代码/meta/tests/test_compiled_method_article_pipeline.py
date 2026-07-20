from pathlib import Path

from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.method_artifacts import clear_stale_compiled_method_outputs
from new_meta.core.method_figures import generate_method_figures
from new_meta.core.method_manuscript import merge_method_manuscript_validation
from new_meta.core.project import Project


def _project(tmp_path: Path) -> Project:
    return Project("compiled method article", output_dir=tmp_path / "project")


def test_compiled_route_removes_only_stale_derived_pairwise_outputs(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.save_json("meta_results.json", {"stale": True}, subdir="analysis")
    project.save_json("method_result.json", {"current": True}, subdir="analysis")
    project.save_json("ledger.json", {"evidence": True}, subdir="evidence")
    project.save_text("draft.md", "stale manuscript", subdir="manuscript")
    figures = project.base_dir / "figures"
    figures.mkdir(parents=True, exist_ok=True)
    (figures / "funnel_plot.png").write_bytes(b"stale")
    (figures / "prisma_diagram.png").write_bytes(b"current")

    removed = clear_stale_compiled_method_outputs(project)

    assert "analysis/meta_results.json" in removed
    assert "figures/funnel_plot.png" in removed
    assert "manuscript/draft.md" in removed
    assert project.load_json("method_result.json", subdir="analysis") == {"current": True}
    assert project.load_json("ledger.json", subdir="evidence") == {"evidence": True}
    assert (figures / "prisma_diagram.png").is_file()


def test_complex_rct_compiled_route_generates_design_aware_forest_plot(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.save_json(
        "synthesis_result.json",
        {
            "family": "intervention_rct",
            "estimator": "DESIGN_AWARE_REML_HKSJ",
            "n_studies": 2,
            "input_result_ids": ["result:a", "result:b"],
            "primary_estimates": [{
                "estimate_id": "pooled_design_aware_effect",
                "label": "Pooled design-aware treatment effect",
                "measure": "RR",
                "estimate": 0.70,
                "ci_lower": 0.55,
                "ci_upper": 0.90,
            }],
            "engine_payload": {
                "diagnostics": {"analysis_scale": "log"},
                "study_effects": [
                    {"study_id": "study:a", "analysis_effect": -0.30, "variance": 0.04},
                    {"study_id": "study:b", "analysis_effect": -0.45, "variance": 0.06},
                ],
            },
        },
        subdir="analysis",
    )

    created = generate_method_figures(project, lang="en")

    assert "forest_plot.png" in created
    assert (project.base_dir / "figures" / "forest_plot.png").stat().st_size > 1000
    assert not (project.base_dir / "figures" / "funnel_plot.png").exists()


def test_compiled_method_language_covers_all_requested_families() -> None:
    writer = WritingAgent(lang="en")
    base = {
        "synthesis_result": {
            "estimator": "REML",
            "n_studies": 4,
            "primary_estimates": [{
                "estimate_id": "x",
                "label": "A versus B",
                "measure": "RR",
                "estimate": 0.8,
                "ci_lower": 0.7,
                "ci_upper": 0.9,
            }],
            "engine_payload": {},
        }
    }
    expected = {
        "intervention_rct": ("shared-control covariance", "paired variance"),
        "network_meta": ("transitivity", "node-splitting"),
        "dose_response": ("restricted cubic splines", "covariance matrix"),
        "ipd_meta": ("within-study", "one-stage model"),
    }
    for family, phrases in expected.items():
        facts = {**base, "method_family": family}
        text = " ".join(writer._compiled_method_article_text(facts, zh=False).values()).lower()
        assert all(phrase in text for phrase in phrases)


def test_generic_validation_is_augmented_with_compiled_method_contract(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.save_json(
        "synthesis_result.json",
        {
            "schema_version": 1,
            "family": "intervention_rct",
            "policy_version": "1",
            "method_plan_fingerprint": "a" * 64,
            "route": "compiled_method",
            "estimator": "DESIGN_AWARE_REML_HKSJ",
            "n_studies": 2,
            "input_result_ids": ["result:a"],
            "primary_estimates": [{
                "estimate_id": "pooled_design_aware_effect",
                "label": "Pooled design-aware treatment effect",
                "measure": "RR",
                "scale": "ratio",
                "estimate": 0.70,
                "ci_lower": 0.60,
                "ci_upper": 0.80,
            }],
            "heterogeneity": {},
            "diagnostics": {},
            "engine_payload": {},
        },
        subdir="analysis",
    )
    project.save_json(
        "method_input_audit.json",
        {"inputs": [{
            "evidence_state": "verified",
            "source_locators": [{"quote_verified": True}],
        }]},
        subdir="analysis",
    )
    project.save_json(
        "method_certainty.json",
        {
            "revision": 2,
            "status": "completed",
            "synthesis_fingerprint": "b" * 64,
            "input_ledger_head_hash": "c" * 64,
        },
        subdir="analysis",
    )
    project.save_json(
        "manuscript_validation.json",
        {"passed": True, "issues": [], "facts_summary": {"main_word_count": 2500}},
        subdir="manuscript",
    )
    manuscript = """# Title
## Abstract
RR 0.70 (95% CI 0.60 to 0.80).
## Introduction
Text.
## Methods
Design-aware REML.
## Results
RR 0.70 (95% CI 0.60 to 0.80).
## Discussion
Text.
## Conclusion
Text.
## Declarations
Text.
"""

    merged = merge_method_manuscript_validation(
        project=project,
        manuscript=manuscript,
        lang="en",
    )

    assert merged["passed"] is True
    assert merged["method_family"] == "intervention_rct"
    assert merged["method_plan_fingerprint"] == "a" * 64
    assert merged["method_certainty_revision"] == 2
    assert merged["exact_result_values_present"] is True
