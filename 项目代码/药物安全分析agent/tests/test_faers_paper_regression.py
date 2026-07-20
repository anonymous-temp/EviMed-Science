"""Offline FAERS panel regression with published-study reference anchors."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from safety_agent.signals import analyze, build_table_from_counts, evaluate

ROOT = Path(__file__).parent / "data" / "faers_regression" / "v1"


def _load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def _computed_panels() -> dict[str, dict]:
    computed = {}
    for panel in _load("panels.json"):
        table = build_table_from_counts(**panel["counts"])
        metrics = analyze(table)
        decision = evaluate(metrics)
        computed[panel["id"]] = {
            "panel": panel,
            "table": table,
            "metrics": metrics,
            "signal": decision.is_signal,
        }
    return computed


def test_frozen_fixture_is_small_deidentified_and_explicit_about_binding():
    manifest = _load("manifest.json")
    panels = _load("panels.json")
    combined = "".join(path.read_text(encoding="utf-8") for path in ROOT.glob("*.json"))

    assert sum(path.stat().st_size for path in ROOT.glob("*.json")) < 100_000
    assert manifest["query_binding"] == "report_contains_target_and_suspect_approximation"
    assert "not same-object-bound" in manifest["role_semantics"]
    assert "primary_id" not in combined.casefold()
    assert "case_id" not in combined.casefold()
    assert len({panel["id"] for panel in panels}) == len(panels)
    for file_key, hash_key in (
        ("panels_file", "panels_sha256"),
        ("publication_anchors_file", "publication_anchors_sha256"),
    ):
        payload = (ROOT / manifest[file_key]).read_bytes()
        assert hashlib.sha256(payload).hexdigest() == manifest[hash_key]


@pytest.mark.parametrize("panel", _load("panels.json"), ids=lambda panel: panel["id"])
def test_frozen_panel_metrics_do_not_drift(panel):
    table = build_table_from_counts(**panel["counts"])
    metrics = analyze(table)
    decision = evaluate(metrics)
    expected = panel["expected_project"]

    assert table.n == panel["counts"]["grand_total"]
    assert metrics.ror.value == pytest.approx(expected["ror"], rel=1e-12)
    assert metrics.ror.ci95_lower == pytest.approx(expected["ror_lower"], rel=1e-12)
    assert metrics.prr.value == pytest.approx(expected["prr"], rel=1e-12)
    assert metrics.ebgm.value == pytest.approx(expected["ebgm"], rel=1e-12)
    assert metrics.ebgm.eb05 == pytest.approx(expected["eb05"], rel=1e-12)
    assert decision.is_signal is expected["signal"]


def test_semaglutide_publication_directions_and_declared_tolerances_match():
    computed = _computed_panels()
    anchor = _load("publication_anchors.json")[0]
    assert anchor["comparison_mode"] == "directional_with_tolerance"
    for panel_id, published in anchor["events"].items():
        current = computed[panel_id]
        assert current["signal"] is published["signal"]
        case_difference = abs(current["table"].a - published["cases"]) / published["cases"]
        ror_difference = abs(current["metrics"].ror.value - published["ror"]) / published["ror"]
        assert case_difference <= anchor["maximum_relative_case_difference"]
        assert ror_difference <= anchor["maximum_relative_ror_difference"]


def test_osimertinib_publication_mismatch_is_visible_and_stable():
    computed = _computed_panels()
    anchor = _load("publication_anchors.json")[1]
    mismatches = sorted(
        panel_id
        for panel_id, published in anchor["events"].items()
        if computed[panel_id]["signal"] is not published["signal"]
    )
    assert mismatches == sorted(anchor["expected_mismatches"])
    for panel_id, published in anchor["events"].items():
        current = computed[panel_id]
        case_difference = abs(current["table"].a - published["cases"]) / published["cases"]
        ror_difference = abs(current["metrics"].ror.value - published["ror"]) / published["ror"]
        assert case_difference <= anchor["maximum_relative_case_difference"]
        assert ror_difference <= anchor["maximum_relative_ror_difference"]


def test_metformin_anchor_is_qualitative_only_but_strongly_positive():
    computed = _computed_panels()
    anchor = _load("publication_anchors.json")[2]
    assert anchor["comparison_mode"] == "qualitative_only"
    panel_id = next(iter(anchor["events"]))
    current = computed[panel_id]
    metrics = current["metrics"]
    assert current["table"].a >= 3
    assert metrics.ror.ci95_lower > 1
    assert metrics.prr.value >= 2
    assert metrics.chi2.value >= 4
    assert metrics.ic.ic025 > 0
    assert current["signal"] is True
