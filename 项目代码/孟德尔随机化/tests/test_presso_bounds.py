"""Permutation p-value bounds must survive parsing and report rendering."""

from types import SimpleNamespace

import pytest

from mr_agent.analysis.validators import ValidationReport, _check_presso
from mr_agent.models import MRAnalysisResult, SessionState
from mr_agent.paper.generator import PaperGenerator
from mr_agent.tools.mr_executor import _parse_presso_csv


@pytest.mark.parametrize("value", ["<0.001", "< 1e-3"])
def test_presso_retains_the_bound_without_claiming_an_exact_value(tmp_path, value):
    (tmp_path / "mrpresso.csv").write_text(f'global_p,n_outliers\n"{value}",2\n', encoding="utf-8")
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome")
    _parse_presso_csv(result, tmp_path)
    assert result.presso_global_pval == 0.001
    assert result.presso_global_pval_relation == "<"
    assert result.presso_n_outliers == 2
    generator = PaperGenerator(SimpleNamespace(), SessionState(analysis_results=[result]), language="en")
    abstract = generator._grounded_abstract([result])
    assert "global p<" in abstract
    assert "global p=" not in abstract
    report = ValidationReport()
    _check_presso(result, report)
    assert any("p<" in warning for warning in report.warnings)


def test_a_strict_upper_bound_at_the_threshold_is_still_below_it(tmp_path):
    (tmp_path / "mrpresso.csv").write_text('global_p,n_outliers\n"<0.05",0\n', encoding="utf-8")
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome")
    _parse_presso_csv(result, tmp_path)
    report = ValidationReport()
    _check_presso(result, report)
    assert report.warnings


@pytest.mark.parametrize("value", ["not available", "<0", "-0.1", "1.1", "NaN", "Inf"])
def test_invalid_presso_probability_does_not_become_a_reported_test(tmp_path, value):
    (tmp_path / "mrpresso.csv").write_text(f'global_p,n_outliers\n"{value}",0\n', encoding="utf-8")
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome")
    _parse_presso_csv(result, tmp_path)
    assert result.presso_global_pval is None


def test_exact_presso_probability_preserves_existing_semantics(tmp_path):
    (tmp_path / "mrpresso.csv").write_text('global_p,n_outliers\n0.05,0\n', encoding="utf-8")
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome")
    _parse_presso_csv(result, tmp_path)
    assert result.presso_global_pval == 0.05
    assert result.presso_global_pval_relation == "="
    report = ValidationReport()
    _check_presso(result, report)
    assert not report.warnings
