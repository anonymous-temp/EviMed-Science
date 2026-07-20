"""Multi-drug publication regression and complete output coverage audit."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from safety_agent.analysis.models import (
    AnalysisResult,
    CaseOverview,
    NormalizedReaction,
    SignalRow,
)
from safety_agent.faers import DrugScope
from safety_agent.signals import analyze, build_table_from_counts, evaluate

ROOT = Path(__file__).parent / "data" / "faers_regression" / "v1"


def _load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def _computed() -> dict[str, dict]:
    result = {}
    for panel in _load("multidrug_panels.json")["panels"]:
        table = build_table_from_counts(**panel["counts"])
        metrics = analyze(table)
        result[panel["id"]] = {
            "panel": panel,
            "table": table,
            "metrics": metrics,
            "signal": evaluate(metrics).is_signal,
        }
    return result


def _spearman(left: dict[str, float], right: dict[str, float]) -> float:
    assert left.keys() == right.keys()
    left_rank = _average_ranks(left)
    right_rank = _average_ranks(right)
    left_values = [left_rank[key] for key in left]
    right_values = [right_rank[key] for key in left]
    left_mean = sum(left_values) / len(left_values)
    right_mean = sum(right_values) / len(right_values)
    covariance = sum(
        (left_value - left_mean) * (right_value - right_mean)
        for left_value, right_value in zip(left_values, right_values, strict=True)
    )
    left_scale = sum((value - left_mean) ** 2 for value in left_values) ** 0.5
    right_scale = sum((value - right_mean) ** 2 for value in right_values) ** 0.5
    return round(covariance / (left_scale * right_scale), 15)


def _average_ranks(values: dict[str, float]) -> dict[str, float]:
    ordered = sorted(values.items(), key=lambda item: (item[1], item[0]))
    ranks: dict[str, float] = {}
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][1] == ordered[start][1]:
            end += 1
        average = ((start + 1) + end) / 2.0
        for key, _value in ordered[start:end]:
            ranks[key] = average
        start = end
    return ranks


@pytest.mark.parametrize(
    "panel",
    _load("multidrug_panels.json")["panels"],
    ids=lambda panel: panel["id"],
)
def test_multidrug_frozen_panel_metrics_do_not_drift(panel):
    table = build_table_from_counts(**panel["counts"])
    metrics = analyze(table)
    expected = panel["expected_project"]

    assert table.n == panel["counts"]["grand_total"]
    assert metrics.ror.value == pytest.approx(expected["ror"], rel=1e-12)
    assert metrics.prr.value == pytest.approx(expected["prr"], rel=1e-12)
    assert metrics.chi2.value == pytest.approx(expected["chi2"], rel=1e-12)
    assert metrics.ic.value == pytest.approx(expected["ic"], rel=1e-12)
    assert metrics.ic.ic025 == pytest.approx(expected["ic025"], rel=1e-12)
    assert metrics.ebgm.value == pytest.approx(expected["ebgm"], rel=1e-12)
    assert metrics.ebgm.eb05 == pytest.approx(expected["eb05"], rel=1e-12)
    assert evaluate(metrics).is_signal is expected["signal"]
    assert all(
        math.isfinite(value)
        for value in (
            metrics.ror.value,
            metrics.ror.ci95_lower,
            metrics.ror.ci95_upper,
            metrics.prr.value,
            metrics.prr.ci95_lower,
            metrics.prr.ci95_upper,
            metrics.chi2.value,
            metrics.ic.value,
            metrics.ic.ic025,
            metrics.ebgm.value,
            metrics.ebgm.eb05,
        )
    )


def test_publications_report_the_complete_comparable_signal_panel():
    required = {
        "cases",
        "ror",
        "ror_lower",
        "ror_upper",
        "prr",
        "chi2",
        "ic",
        "ic025",
        "ebgm",
        "eb05",
        "signal",
    }
    anchors = _load("multidrug_publication_anchors.json")["anchors"]

    assert len(anchors) == 4
    for anchor in anchors:
        assert anchor["source"].startswith("https://pmc.ncbi.nlm.nih.gov/")
        assert anchor["events"]
        assert "cohort" in anchor["method_compatibility"]
        for event in anchor["events"].values():
            assert required <= event.keys()
            assert event["ror_lower"] <= event["ror"] <= event["ror_upper"]
            assert event["cases"] >= 3


@pytest.mark.parametrize(
    "anchor",
    _load("multidrug_publication_anchors.json")["anchors"],
    ids=lambda anchor: anchor["id"],
)
def test_publication_direction_rank_and_declared_drift_are_stable(anchor):
    computed = _computed()
    current_ror = {
        panel_id: computed[panel_id]["metrics"].ror.value
        for panel_id in anchor["events"]
    }
    published_ror = {
        panel_id: event["ror"] for panel_id, event in anchor["events"].items()
    }
    signal_mismatches = sorted(
        panel_id
        for panel_id, event in anchor["events"].items()
        if computed[panel_id]["signal"] is not event["signal"]
    )
    case_drift = sorted(
        panel_id
        for panel_id, event in anchor["events"].items()
        if abs(computed[panel_id]["table"].a - event["cases"]) / event["cases"]
        > anchor["case_drift_threshold"]
    )
    ror_drift = sorted(
        panel_id
        for panel_id, event in anchor["events"].items()
        if abs(current_ror[panel_id] - event["ror"]) / event["ror"]
        > anchor["ror_drift_threshold"]
    )

    assert signal_mismatches == sorted(anchor["expected_signal_mismatches"])
    assert case_drift == sorted(anchor["expected_case_drift"])
    assert ror_drift == sorted(anchor["expected_ror_drift"])
    if anchor["minimum_ror_rank_spearman"] is not None:
        assert _spearman(current_ror, published_ror) >= anchor[
            "minimum_ror_rank_spearman"
        ]
    if anchor["comparison_mode"] != "method_incompatible_expected_mismatch":
        assert all(
            (computed[panel_id]["metrics"].prr.value > 1.0)
            == (event["prr"] > 1.0)
            for panel_id, event in anchor["events"].items()
        )


def test_paper_specific_scope_profiles_are_expressible_without_false_equivalence():
    anchors = {
        anchor["id"]: anchor
        for anchor in _load("multidrug_publication_anchors.json")["anchors"]
    }
    cefiderocol = DrugScope(
        names=tuple(anchors["cefiderocol-fang-2025"]["drug_names"]),
        role_codes=frozenset({"PS"}),
        date_from="2019-10-01",
        date_to="2024-09-30",
        background_date_from="2004-01-01",
        background_date_to="2024-09-30",
    )
    famciclovir = DrugScope(
        names=("famciclovir",),
        role_codes=frozenset({"PS"}),
        routes=("048",),
        date_from="2004-01-01",
        date_to="2023-06-30",
    )

    assert cefiderocol.background_date_from.isoformat() == "2004-01-01"
    assert cefiderocol.date_from.isoformat() == "2019-10-01"
    assert famciclovir.routes == ("048",)
    assert anchors["famciclovir-fang-2024"]["comparison_mode"] == (
        "method_incompatible_expected_mismatch"
    )


def test_every_analysis_output_field_has_an_explicit_validation_owner():
    coverage = _load("analysis_coverage_matrix.json")
    covered: list[str] = [
        field for group in coverage["groups"] for field in group["fields"]
    ]
    expected = set(AnalysisResult.model_fields) - {"reactions", "overview", "signals"}
    expected.update(f"reactions.{field}" for field in NormalizedReaction.model_fields)
    expected.update(f"overview.{field}" for field in CaseOverview.model_fields)
    expected.update(f"signals.{field}" for field in SignalRow.model_fields)

    assert len(covered) == len(set(covered)), "coverage fields must have one owner"
    assert set(covered) == expected
    for group in coverage["groups"]:
        assert group["tests"]
        if group["coverage_type"] == "deterministic_contract":
            assert group.get("limitation") or group["id"] == "normalization"
    publication_relationships = next(
        group for group in coverage["groups"] if group["id"] == "publication_signal_relationships"
    )
    assert set(publication_relationships["fields"]) == {
        "signals.reaction",
        "signals.a",
        "signals.ror",
        "signals.prr",
        "signals.is_signal",
    }
    assert not any(
        field.startswith(("signals.ror_ci", "signals.prr_ci"))
        or field in {"signals.ebgm", "signals.eb05"}
        for field in publication_relationships["fields"]
    )


def test_selected_papers_supply_context_for_overview_dimensions_except_concomitants():
    anchors = _load("multidrug_publication_anchors.json")["anchors"]
    overview_keys = {
        key
        for anchor in anchors
        for key in anchor.get("overview", {})
    }
    assert {
        "total_reports",
        "yearly",
        "sex",
        "age",
        "outcomes",
        "countries",
        "indications",
    } <= overview_keys
    assert "concomitant_drugs" not in overview_keys
