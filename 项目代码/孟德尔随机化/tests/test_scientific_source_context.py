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


def test_repository_transformation_does_not_confirm_or_erase_a_declared_unit():
    from mr_agent.source_context import declared_scale, merge_scale, repository_scale
    merged = merge_scale(declared_scale({"unit": "SD", "evidence": "Provided dictionary"}),
                         repository_scale({"transformation": "inverse_normal"}, source="GWAS metadata"))
    assert merged["unit"] == "SD" and merged["transformation"] == "inverse_normal"
    assert merged["status"] == "declared"
    assert merged["sources"][1]["unit"] is None


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


def test_bound_local_declaration_reaches_result_and_native_report(tmp_path):
    import evimed_local_inputs as inputs
    from test_hosted_inputs import source
    from mr_agent.source_context import declared_scale
    from mr_agent.paper.generator import PaperGenerator
    from mr_agent.models import SessionState
    request = {"exposure": "BMI", "outcome": "CHD", "exposureSource": source(), "outcomeSource": source("data/outcome.csv")}
    request["exposureSource"]["effectScale"] = {"unit": "kg/m2", "evidence": "Data dictionary"}
    assert inputs.validate_request(request)
    result = MRAnalysisResult(exposure_id="exposure.csv", outcome_id="outcome.csv", exposure_source_type="local_file", outcome_source_type="local_file")
    inputs.bind_result_provenance([result], {"exposure": request["exposureSource"], "outcome": request["outcomeSource"]}, request)
    assert result.exposure_scale == declared_scale(request["exposureSource"]["effectScale"])
    state = SessionState(); state.analysis_results = [result]
    generator = PaperGenerator.__new__(PaperGenerator); generator.state = state; generator.language = "en"
    report = generator._grounded_limitations([result])
    assert "kg/m2" in report
    assert "not independently verified" in report
    assert "extent and direction" in report
    assert "Significant heterogeneity was not detected" not in report  # No test was observed.


def test_repository_metadata_binds_source_scale_without_changing_effects():
    import evimed_local_inputs as inputs
    result = MRAnalysisResult(exposure_id="GCST900001", outcome_id="GCST900002", exposure_source_type="gwas_catalog", outcome_source_type="gwas_catalog")
    record = {role: {"accession": accession, "sampleMetadata": {"sampleSize": 238944, "effectScale": {"status": "repository_reported", "unit": "SD", "transformation": "inverse_normal", "source": "GWAS-SSF", "evidence": None, "raw_fields": {"unit": "SD", "transformation": "inverse_normal"}}}} for role, accession in (("exposure", "GCST900001"), ("outcome", "GCST900002"))}
    inputs.bind_open_metadata([result], record, {"exposure": "BMI", "outcome": "CHD"})
    assert result.exposure_scale["transformation"] == "inverse_normal"
    assert result.exposure_scale["status"] == "repository_reported"
    assert result.mr_results == []


def test_binding_catalogue_metadata_keeps_source_n_and_harmonised_n_separate():
    import evimed_local_inputs as inputs
    from mr_agent.source_context import variant_sample_summary, scientific_context
    result = MRAnalysisResult(exposure_id="GCST900001", outcome_id="GCST900002", exposure_source_type="gwas_catalog", outcome_source_type="gwas_catalog")
    harmonised = variant_sample_summary([238944, 218359], scope="harmonised_rows")
    source = variant_sample_summary([None, 218359, 339205], scope="selected_source_rows_before_catalogue_fill")
    result.variant_sample_sizes["exposure"] = harmonised
    record = {role: {"accession": accession, "sampleMetadata": {"sampleSize": 238944}, "sampleSize": {"originalVariantSampleSizes": source}}
              for role, accession in (("exposure", "GCST900001"), ("outcome", "GCST900002"))}
    inputs.bind_open_metadata([result], record, {"exposure": "BMI", "outcome": "CHD"})
    context = scientific_context(result)["sample_sizes"]["exposure"]
    assert context["variants"] == harmonised
    assert context["source_variants"] == source


def test_mixed_source_repository_read_retains_a_conflicting_declaration(monkeypatch):
    import evimed_local_inputs as inputs
    from mr_agent.source_context import declared_scale
    from mr_agent.tools import gwas
    source = DataSource(gwas_id="ieu-a-1", effect_scale=declared_scale({"unit": "SD", "evidence": "Provided unit"}))
    entry = _dict_to_gwas_entry({"id": "ieu-a-1", "trait": "BMI", "unit": "kg/m2", "sample_size": 10, "population": "unknown"}).model_dump()
    monkeypatch.setattr(gwas, "fetch_gwas_metadata", lambda identifier: entry)
    metadata = inputs.remote_metadata({"exposure": source})
    result = MRAnalysisResult(exposure_id="ieu-a-1", outcome_id="local.csv", outcome_source_type="local_file")
    inputs.bind_remote_metadata([result], metadata)
    assert result.exposure_scale["status"] == "conflicting"
    assert {item["unit"] for item in result.exposure_scale["sources"]} == {"SD", "kg/m2"}
