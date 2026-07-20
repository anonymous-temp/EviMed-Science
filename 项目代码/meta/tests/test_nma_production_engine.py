import math

import pytest

from new_meta.engines.nma import NMAEngine, run_network_meta


def _inconsistent_triangle():
    rows = []
    for index, effect in enumerate([0.02, -0.03, 0.01], start=1):
        rows.append({
            "study_id": f"AB{index}", "treatment": "B", "comparator": "A",
            "yi": effect, "vi": 0.02,
        })
    for index, effect in enumerate([0.01, -0.02, 0.03], start=1):
        rows.append({
            "study_id": f"AC{index}", "treatment": "C", "comparator": "A",
            "yi": effect, "vi": 0.02,
        })
    for index, effect in enumerate([1.2, 1.1, 1.3], start=1):
        rows.append({
            "study_id": f"BC{index}", "treatment": "C", "comparator": "B",
            "yi": effect, "vi": 0.02,
        })
    return rows


def test_nma_uses_design_by_treatment_global_inconsistency_model() -> None:
    engine = NMAEngine(_inconsistent_triangle(), ["A", "B", "C"], reference="A")

    result = engine.fit_random_effects()
    global_test = result.diagnostics["design_by_treatment"]

    assert global_test["method"] == "design_by_treatment_interaction"
    assert global_test["df"] == 1
    assert global_test["q_inconsistency"] > 20
    assert global_test["p_value"] < 0.001
    assert result.inconsistency_p == pytest.approx(global_test["p_value"])


def test_node_split_refits_an_independent_indirect_network() -> None:
    engine = NMAEngine(_inconsistent_triangle(), ["A", "B", "C"], reference="A")
    engine.fit_random_effects()

    split = engine.node_splitting()["A vs B"]

    assert split["method"] == "separate_indirect_network"
    assert split["direct"] == pytest.approx(-0.0, abs=0.03)
    assert split["indirect"] == pytest.approx(1.2, abs=0.08)
    assert split["p_value"] < 0.001
    assert split["direct_studies"] == 3
    assert split["indirect_contrasts"] == 6


def test_network_meta_requires_explicit_transitivity_assessment() -> None:
    records = [
        {
            "result_id": f"r{index}",
            "study_id": row["study_id"],
            "design": "parallel_rct",
            "measure": "RR",
            "estimate": row["yi"],
            "standard_error": math.sqrt(row["vi"]),
            "scale": "log",
            "precision_basis": "reported_effect",
            "estimand_id": "network-response",
            "treatment": row["treatment"],
            "comparator": row["comparator"],
            "contrast_id": f"{row['study_id']}:contrast",
        }
        for index, row in enumerate(_inconsistent_triangle())
    ]

    with pytest.raises(ValueError, match="transitivity assessment"):
        run_network_meta(records, reference="A")

    result = run_network_meta(
        records,
        reference="A",
        transitivity_assessment={
            "status": "adequate",
            "effect_modifiers": ["baseline severity", "follow-up duration"],
            "rationale": "The distributions were sufficiently comparable across treatment comparisons.",
        },
    )

    assert result.measure == "RR"
    assert result.n_studies == 9
    assert result.reference == "A"
    assert len(result.league_table) == 3
    assert all(item["effect"] > 0 for item in result.league_table)
    assert result.transitivity_assessment["status"] == "adequate"
    assert result.diagnostics["design_by_treatment"]["p_value"] < 0.001


def test_network_meta_rejects_transitivity_concern_instead_of_pooling() -> None:
    records = [
        {
            "result_id": f"r{index}", "study_id": row["study_id"],
            "design": "parallel_rct", "measure": "RR", "estimate": row["yi"],
            "standard_error": math.sqrt(row["vi"]), "scale": "log",
            "precision_basis": "reported_effect", "estimand_id": "network-response",
            "treatment": row["treatment"], "comparator": row["comparator"],
            "contrast_id": f"{row['study_id']}:contrast",
        }
        for index, row in enumerate(_inconsistent_triangle())
    ]

    with pytest.raises(ValueError, match="transitivity was not established"):
        run_network_meta(
            records,
            reference="A",
            transitivity_assessment={
                "status": "concern",
                "effect_modifiers": ["baseline severity"],
                "rationale": "Severity was systematically higher in one comparison.",
            },
        )
