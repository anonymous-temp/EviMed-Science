"""Optional source facts must survive without turning assumptions into measurements."""
import json

import pytest

from mr_agent.models import DataSource, MRAnalysisResult
from mr_agent.tools.gwas import _dict_to_gwas_entry
from mr_agent.analysis.validators import ValidationReport, _check_sample_overlap


@pytest.mark.parametrize("unit,transformation", [(None, None), ("SD", None), ("kg/m2", None), (None, "inverse_normal")])
def test_repository_scale_is_explicit_and_roundtrips_without_guessing(unit, transformation):
    row = {"id": "ieu-a-1", "trait": "BMI", "unit": unit, "transformation": transformation}
    entry = _dict_to_gwas_entry(row)
    scale = entry.effect_scale
    assert scale["unit"] == unit
    assert scale["transformation"] == transformation
    assert scale["status"] == ("repository_reported" if unit or transformation else "unknown")
    assert json.loads(entry.model_dump_json())["effect_scale"] == scale
    assert scale["raw_fields"] == {key: value for key, value in row.items() if key in {"unit", "transformation"} and value}


def test_declared_scale_cannot_upgrade_or_erase_a_conflicting_repository_unit():
    from mr_agent.source_context import declared_scale, merge_scale
    declared = declared_scale({"unit": "SD", "evidence": "Supplied data dictionary"})
    repository = _dict_to_gwas_entry({"id": "ieu-a-1", "trait": "BMI", "unit": "kg/m2"}).effect_scale
    merged = merge_scale(declared, repository)
    assert declared["status"] == "declared"
    assert merged["status"] == "conflicting"
    assert {item["unit"] for item in merged["sources"]} == {"SD", "kg/m2"}
    assert DataSource().effect_scale["status"] == "unknown"


@pytest.mark.parametrize("ids,status", [(("ieu-a-1", "ieu-b-2"), "possible"), (("ieu-a-1", "ukb-b-2"), "unknown")])
def test_prefix_overlap_never_measures_participants_or_bias_direction(ids, status):
    result = MRAnalysisResult(exposure_id=ids[0], outcome_id=ids[1])
    report = ValidationReport()
    _check_sample_overlap(result, report)
    assert result.sample_overlap["status"] == status
    assert result.sample_overlap["bias_direction"] == "unestablished"
    assert result.sample_overlap["overlap_participants"] is None
    assert "MR-LAP" not in " ".join(report.warnings)


def test_catalogue_and_variant_n_are_distinct_observations():
    from mr_agent.source_context import variant_sample_summary, scientific_context
    result = MRAnalysisResult(exposure_id="x", outcome_id="y", sample_size_exposure=238944,
                              exposure_metadata={"sample_size_total": 238944, "metadata_source": "gwas_catalog"})
    result.variant_sample_sizes["exposure"] = variant_sample_summary([218359, 339205, None], scope="harmonised_rows")
    context = scientific_context(result)
    exposure = context["sample_sizes"]["exposure"]
    assert exposure["catalogue_n"] == 238944
    assert exposure["variants"] == {"scope": "harmonised_rows", "rows": 3, "reported": 2, "minimum": 218359, "maximum": 339205, "complete": False}
    assert exposure["ancestry_linkage"] == "unknown"
    assert context["exposure_scale"]["status"] == "unknown"
    assert context["overlap"]["bias_direction"] == "unestablished"


def test_limitations_prompt_does_not_require_unobserved_findings():
    from mr_agent.llm.prompts import PAPER_LIMITATIONS
    assert "F-statistic > 10 confirms" not in PAPER_LIMITATIONS
    assert "MR-PRESSO showed no evidence" not in PAPER_LIMITATIONS
    assert "GWAS data predominantly from European" not in PAPER_LIMITATIONS
    assert "ideally separate" not in PAPER_LIMITATIONS
    assert "extent and direction" in PAPER_LIMITATIONS
    assert "skipped" in PAPER_LIMITATIONS
