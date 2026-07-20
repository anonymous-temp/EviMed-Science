import math

import pytest

from new_meta.engines.complex_rct import run_complex_rct


def _records():
    return [
        {
            "result_id": "cluster-1",
            "study_id": "C1",
            "design": "cluster_rct",
            "measure": "RR",
            "estimate": 0.80,
            "ci_lower": 0.66,
            "ci_upper": 0.97,
            "scale": "original",
            "precision_basis": "reported_cluster_adjusted",
            "estimand_id": "drug-vs-control",
            "treatment": "Drug",
            "comparator": "Control",
            "contrast_id": "C1:drug-control",
        },
        {
            "result_id": "cross-1",
            "study_id": "X1",
            "design": "crossover_rct",
            "measure": "RR",
            "estimate": 0.74,
            "ci_lower": 0.58,
            "ci_upper": 0.95,
            "scale": "original",
            "precision_basis": "reported_paired_effect",
            "paired_analysis": True,
            "estimand_id": "drug-vs-control",
            "treatment": "Drug",
            "comparator": "Control",
            "contrast_id": "X1:drug-control",
        },
        {
            "result_id": "multi-1a",
            "study_id": "M1",
            "design": "multi_arm_rct",
            "measure": "RR",
            "estimate": math.log(0.70),
            "standard_error": 0.20,
            "scale": "log",
            "precision_basis": "reported_effect",
            "estimand_id": "drug-vs-control",
            "treatment": "Drug dose 1",
            "comparator": "Control",
            "contrast_id": "M1:dose1-control",
            "covariance_with": {"M1:dose2-control": 0.02},
        },
        {
            "result_id": "multi-1b",
            "study_id": "M1",
            "design": "multi_arm_rct",
            "measure": "RR",
            "estimate": math.log(0.76),
            "standard_error": 0.25,
            "scale": "log",
            "precision_basis": "reported_effect",
            "estimand_id": "drug-vs-control",
            "treatment": "Drug dose 2",
            "comparator": "Control",
            "contrast_id": "M1:dose2-control",
            "covariance_with": {"M1:dose1-control": 0.02},
        },
    ]


def test_complex_rct_pool_preserves_cluster_crossover_and_multiarm_designs() -> None:
    result = run_complex_rct(_records())

    assert result.measure == "RR"
    assert result.n_studies == 3
    assert result.n_contrasts == 4
    assert result.pooled_effect == pytest.approx(0.76, abs=0.08)
    assert result.design_counts == {
        "cluster_rct": 1,
        "crossover_rct": 1,
        "multi_arm_rct": 1,
    }
    multiarm = next(item for item in result.study_effects if item["study_id"] == "M1")
    assert multiarm["n_contrasts"] == 2
    assert multiarm["analysis_effect"] == pytest.approx(-0.33035875, abs=1e-6)
    assert multiarm["variance"] == pytest.approx(0.0336, abs=1e-6)
    assert result.diagnostics["multi_arm_covariance"] == "explicit_gls_consolidation"
    assert result.diagnostics["independent_study_units"] is True


def test_cluster_design_effect_adjusts_variance_before_pooling() -> None:
    records = _records()
    records[0].update({
        "standard_error": 0.10,
        "ci_lower": None,
        "ci_upper": None,
        "scale": "log",
        "estimate": math.log(0.8),
        "precision_basis": "design_effect_adjusted",
        "intracluster_correlation": 0.05,
        "mean_cluster_size": 11,
    })

    result = run_complex_rct(records)
    cluster = next(item for item in result.study_effects if item["study_id"] == "C1")

    assert cluster["design_effect"] == pytest.approx(1.5)
    assert cluster["variance"] == pytest.approx(0.015)


@pytest.mark.parametrize(
    ("index", "updates", "message"),
    [
        (0, {"precision_basis": "reported_effect"}, "cluster-adjusted precision"),
        (1, {"paired_analysis": False}, "paired analysis"),
        (2, {"covariance_with": {}}, "explicit covariance"),
    ],
)
def test_complex_rct_rejects_unresolved_design_dependencies(index, updates, message) -> None:
    records = _records()
    records[index].update(updates)
    if index == 2:
        records[3]["covariance_with"] = {}

    with pytest.raises(ValueError, match=message):
        run_complex_rct(records)


def test_complex_rct_rejects_mixed_estimands() -> None:
    records = _records()
    records[-1]["estimand_id"] = "other-dose-estimand"

    with pytest.raises(ValueError, match="same estimand"):
        run_complex_rct(records)
