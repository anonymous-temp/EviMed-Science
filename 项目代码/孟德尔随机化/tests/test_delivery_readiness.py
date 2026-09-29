"""Interpretation and usable figures are required before reporting completion."""
import json
from types import SimpleNamespace

import pytest

from mr_agent.analysis.pipeline import MRPipeline
from mr_agent.models import MRAnalysisResult, MRResult, SessionState


def numeric_result(**changes):
    return MRAnalysisResult(
        exposure_id="exposure", outcome_id="outcome", n_instruments=8,
        mr_results=[MRResult(method="Inverse variance weighted", nsnp=8,
                             beta=0.3, se=0.04, pval=0.001)], **changes,
    )


def test_late_r_failure_keeps_completed_primary_numbers_and_original_failure(tmp_path, monkeypatch):
    from mr_agent.tools import mr_executor
    from mr_agent.analysis.delivery import MRDeliveryError, require_report_ready
    def failed(script, output):
        (output / "mr_results.csv").write_text("method,nsnp,b,se,pval\nInverse variance weighted,8,0.3,0.04,0.001\n")
        (output / "mr_error.json").write_text('{"code":"analysis_failed","error":"Late optional step failed"}')
        return False
    monkeypatch.setattr(mr_executor, "_execute_r_script", failed)
    result = mr_executor.run_mr_analysis("x", "y", tmp_path)
    assert result.mr_results[0].beta == 0.3 and result.n_instruments == 8
    assert result.analysis_status == "partial" and result.analysis_error_code == "analysis_failed"
    with pytest.raises(MRDeliveryError) as caught:
        require_report_ready([result])
    assert caught.value.module == "primaryEstimate"


@pytest.mark.parametrize("row", ["IVW,8,,0.04,0.001", "IVW,8,0.3,,0.001", "IVW,8,0.3,0.04,", "IVW,8,0.3,0.04"])
def test_half_written_primary_csv_does_not_fabricate_zero_effect_or_null_p_value(tmp_path, row):
    from mr_agent.tools import mr_executor
    (tmp_path / "mr_results.csv").write_text("method,nsnp,b,se,pval\n" + row + "\n")
    result = mr_executor._parse_results("x", "y", tmp_path)
    assert result.mr_results == []
    assert result.module_status["primaryEstimate"]["status"] == "unavailable"


def test_unchanged_old_primary_file_is_not_copied_as_a_failed_retries_partial_result(tmp_path, monkeypatch):
    from mr_agent.tools import mr_executor
    from evimed_runner import _copy_release_artifacts
    raw = tmp_path / "raw"; raw.mkdir()
    (raw / "mr_results.csv").write_text("method,nsnp,b,se,pval\nIVW,8,0.3,0.04,0.001\n")
    monkeypatch.setattr(mr_executor, "_execute_r_script", lambda *args: False)
    result = mr_executor.run_mr_analysis("x", "y", raw)
    assert result.mr_results == []
    target = tmp_path / "output"; target.mkdir()
    copied = _copy_release_artifacts(target, SimpleNamespace(output_dir=raw), [result], include_reports=False)
    assert not any(path.endswith("mr_results.csv") for path in copied)


@pytest.mark.parametrize("fresh_rows", [None, "empty", "populated"])
def test_row_snapshots_and_variant_n_belong_to_current_attempt(tmp_path, monkeypatch, fresh_rows):
    from mr_agent.tools import mr_executor
    from evimed_runner import _copy_release_artifacts

    raw = tmp_path / "raw"; raw.mkdir()
    rows_header = "SNP,beta.exposure,se.exposure,pval.exposure,samplesize.exposure,samplesize.outcome\n"
    for name in ("selected-source-rows.csv", "harmonised-rows.csv"):
        (raw / name).write_text(rows_header + "rs1,0.2,0.01,1e-9,123,456\n")

    def failed(script, output):
        (output / "mr_results.csv").write_text("method,nsnp,b,se,pval\nIVW,8,0.3,0.04,0.001\n")
        if fresh_rows is not None:
            for name in ("selected-source-rows.csv", "harmonised-rows.csv"):
                (output / name).write_text(rows_header + ("rs2,0.3,0.01,1e-9,789,987\n" if fresh_rows == "populated" else ""))
        return False

    monkeypatch.setattr(mr_executor, "_execute_r_script", failed)
    result = mr_executor.run_mr_analysis("x", "y", raw)
    assert result.mr_results[0].beta == 0.3 and result.n_instruments == 8
    assert result.analysis_status == "partial"
    if fresh_rows is None:
        assert result.variant_sample_sizes == {}
    else:
        observed = result.variant_sample_sizes["exposure"]
        assert observed["rows"] == (1 if fresh_rows == "populated" else 0)
        assert observed["maximum"] == (789 if fresh_rows == "populated" else None)
    target = tmp_path / "output"; target.mkdir()
    copied = _copy_release_artifacts(target, SimpleNamespace(output_dir=raw), [result], include_reports=False)
    assert any(path.endswith("mr_results.csv") for path in copied)
    for name in ("selected-source-rows.csv", "harmonised-rows.csv"):
        assert any(path.endswith(name) for path in copied) == (fresh_rows is not None)
    assert (raw / "harmonised-rows.csv").exists()


@pytest.mark.parametrize("response", [None, "", "   ", RuntimeError("private-provider-detail")])
def test_interpretation_failure_is_typed_and_retains_numerical_results(response):
    from mr_agent.analysis.delivery import MRDeliveryError

    def chat(**kwargs):
        if isinstance(response, Exception):
            raise response
        return response

    state = SessionState()
    result = numeric_result()
    pipeline = MRPipeline(SimpleNamespace(chat=chat), state)
    with pytest.raises(MRDeliveryError) as caught:
        pipeline._step9_interpret([result])
    assert caught.value.code == "mr_interpretation_failed"
    assert "private-provider-detail" not in str(caught.value)
    assert state.analysis_results == [result]
    assert result.mr_results[0].beta == 0.3
    assert result.interpretation_status == "failed"
    assert result.interpretation_error_code == "mr_interpretation_failed"
    assert result.interpretation == ""
    assert result.interpretation_failure.error_type == (
        "RuntimeError" if isinstance(response, Exception) else "EmptyInterpretationError"
    )
    assert state.last_completed_step != 5


def test_successful_interpretation_is_recorded_explicitly():
    state = SessionState()
    result = numeric_result()
    pipeline = MRPipeline(SimpleNamespace(chat=lambda **kwargs: "A bounded interpretation."), state)
    assert pipeline._step9_interpret([result]) == [result]
    assert result.interpretation_status == "succeeded"
    assert result.interpretation_error_code == ""


def test_interpretation_failure_keeps_observed_sdk_metadata(monkeypatch):
    from mr_agent.analysis.delivery import MRDeliveryError
    from test_llm_failure_diagnostics import client_with, response

    client = client_with(monkeypatch, lambda **kwargs: response("private provider text", "length"))
    state = SessionState()
    result = numeric_result()
    with pytest.raises(MRDeliveryError):
        MRPipeline(client, state)._step9_interpret([result])
    failure = result.interpretation_failure
    assert failure.sdk_call_attempts == 10
    assert failure.category == "truncated"
    assert failure.calls[-1].request_max_tokens == 12192
    assert failure.finish_reason == "length"
    assert "private provider text" not in result.model_dump_json()


def test_legacy_interpretation_text_is_not_completion_evidence():
    from mr_agent.analysis.delivery import MRDeliveryError, require_report_ready

    result = numeric_result(interpretation="Old text without generation status.")
    with pytest.raises(MRDeliveryError) as caught:
        require_report_ready([result])
    assert caught.value.code == "mr_interpretation_incomplete"


def test_fixed_runner_preserves_failed_interpretation_diagnostics(tmp_path, monkeypatch):
    import sys
    from types import ModuleType
    import evimed_runner
    from test_hosted_runner import prepared_job

    output, request_path, request, authority = prepared_job(tmp_path)
    raw = tmp_path / "numeric-output"
    raw.mkdir()
    (raw / "mr_results.csv").write_text("method,b,se,pval\nIVW,0.3,0.04,0.001\n")
    paper_calls = []

    class Agent:
        def __init__(self, language):
            self.state = SessionState()
            self.state.output_dir = raw

        def _run_analysis(self):
            from mr_agent.analysis.delivery import MRDeliveryError
            result = numeric_result(raw_data_path=raw,
                exposure_source_type="local_file", outcome_source_type="local_file")
            result.exposure_id = "exposure.csv"
            result.outcome_id = "outcome.csv"
            def fail(**kwargs):
                raise RuntimeError("private-provider-detail")
            try:
                MRPipeline(SimpleNamespace(chat=fail), self.state)._step9_interpret([result])
            except MRDeliveryError as error:
                self.state.error_code = error.code
                self.state.errors.append(str(error))
            return "Analysis did not complete."

        def _run_paper_generation(self):
            paper_calls.append(True)

    module = ModuleType("mr_agent.core.engine")
    module.MRAgent = Agent
    monkeypatch.setitem(sys.modules, "mr_agent.core.engine", module)
    assert evimed_runner.run(request_path, output, input_authority=authority) == 1
    receipt = json.loads((output / "result.json").read_text())
    assert receipt["status"] == "failed"
    assert receipt["errorCode"] == "mr_interpretation_failed"
    assert receipt["modules"]["interpretation"]["fatal"] is True
    assert receipt["diagnosticOnly"] is True
    assert receipt["failureDiagnostics"]["phase"] == "interpretation"
    assert receipt["failureDiagnostics"]["failures"][0]["failure"]["error_type"] == "RuntimeError"
    assert paper_calls == []
    assert "mendelian-randomization-run.json" in receipt["artifacts"]
    assert any(path.endswith("mr_results.csv") for path in receipt["artifacts"])
    rows = json.loads((output / "mendelian-randomization-run.json").read_text())
    assert rows[0]["mr_results"][0]["beta"] == 0.3
    assert rows[0]["interpretation_status"] == "failed"
    assert rows[0]["interpretation_failure"]["error_type"] == "RuntimeError"
    assert "private-provider-detail" not in json.dumps(receipt)
    assert "private-provider-detail" not in json.dumps(rows)
    assert not (output / "mendelian-randomization-report.md").exists()


@pytest.mark.parametrize("status", ["pending", "failed"])
def test_finalize_existing_cannot_promote_missing_or_failed_interpretation(tmp_path, status):
    import evimed_runner
    result = numeric_result(interpretation="Old text", interpretation_status=status)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"exposure": "BMI", "outcome": "CHD"}))
    analysis = tmp_path / "mendelian-randomization-run.json"
    analysis.write_text(json.dumps([result.model_dump(mode="json")]))
    report = tmp_path / "mendelian-randomization-report.md"
    report.write_text("# Existing diagnostic report\n")
    original = (analysis.read_bytes(), report.read_bytes())
    assert evimed_runner.finalize_existing(request, tmp_path) == 1
    receipt = json.loads((tmp_path / "result.json").read_text())
    assert receipt["errorCode"].startswith("mr_interpretation_")
    assert receipt["status"] == "failed"
    assert (analysis.read_bytes(), report.read_bytes()) == original


@pytest.mark.parametrize("corruption", ["zero_pages", "missing_png", "blank_png", "missing_manifest", "false_skip"])
def test_bad_diagnostic_artifacts_cannot_pass_delivery(tmp_path, corruption):
    from PIL import Image
    from PyPDF2 import PdfWriter
    from delivery_fixture import ready_delivery
    from mr_agent.analysis.delivery import MRDeliveryError, require_report_ready

    result = ready_delivery(numeric_result(), tmp_path)
    require_report_ready([result])
    if corruption == "zero_pages":
        with (tmp_path / "scatter_plot.pdf").open("wb") as handle:
            PdfWriter().write(handle)
    elif corruption == "missing_png":
        (tmp_path / "scatter_plot.png").unlink()
    elif corruption == "blank_png":
        Image.new("RGB", (200, 200), "white").save(tmp_path / "scatter_plot.png")
    elif corruption == "missing_manifest":
        (tmp_path / "diagnostic-plots.json").unlink()
    else:
        path = tmp_path / "diagnostic-plots.json"
        ledger = json.loads(path.read_text())
        ledger["scatter_plot"] = {"status": "skipped", "reason_code": "insufficient_instruments", "pages": 0}
        path.write_text(json.dumps(ledger))
    with pytest.raises(MRDeliveryError) as caught:
        require_report_ready([result])
    assert caught.value.code == "mr_plot_generation_failed"


def test_optional_inapplicable_diagnostic_remains_explicit(tmp_path):
    import evimed_runner
    from delivery_fixture import ready_delivery
    from mr_agent.analysis.delivery import require_report_ready

    result = ready_delivery(numeric_result(), tmp_path)
    result.n_instruments = 2
    ledger_path = tmp_path / "diagnostic-plots.json"
    ledger = json.loads(ledger_path.read_text())
    ledger["loo_plot"] = {"status": "skipped", "reason_code": "insufficient_instruments", "pages": 0}
    ledger_path.write_text(json.dumps(ledger))
    for ext in ("pdf", "png"):
        (tmp_path / f"loo_plot.{ext}").unlink()
        result.plots.pop(f"loo_plot_{ext}")
    require_report_ready([result])
    modules = evimed_runner._module_ledger([result], False)
    assert modules["diagnosticPlots"]["status"] == "degraded"
    assert not modules["diagnosticPlots"].get("fatal")


@pytest.mark.parametrize("stale", ["files_and_refs", "files_only", "refs_only"])
def test_skipped_diagnostic_cannot_promote_stale_figures(tmp_path, stale):
    import evimed_runner
    from delivery_fixture import ready_delivery
    from mr_agent.analysis.delivery import MRDeliveryError, require_report_ready
    from mr_agent.paper.generator import PaperGenerator
    from mr_agent.paper.sections import _describe_sensitivity

    raw = tmp_path / "analysis"
    result = ready_delivery(numeric_result(), raw)
    result.n_instruments = 2
    path = raw / "diagnostic-plots.json"
    ledger = json.loads(path.read_text())
    ledger["loo_plot"] = {"status": "skipped", "reason_code": "insufficient_instruments", "pages": 0}
    path.write_text(json.dumps(ledger))
    for ext in ("pdf", "png"):
        if stale == "files_only":
            result.plots.pop(f"loo_plot_{ext}")
        if stale == "refs_only":
            (raw / f"loo_plot.{ext}").unlink()
    with pytest.raises(MRDeliveryError):
        require_report_ready([result])
    description = _describe_sensitivity(result).casefold()
    assert "leave-one-out" not in description
    generator = PaperGenerator(object(), SessionState(analysis_results=[result]))
    assert "leave-one-out" not in generator._grounded_methods([result]).casefold()
    output = tmp_path / "diagnostics"
    output.mkdir()
    copied = evimed_runner._copy_release_artifacts(
        output, SimpleNamespace(output_dir=None), [result], include_reports=False,
    )
    assert all("loo_plot" not in name for name in copied)
    assert all("loo_plot" not in name for name in result.plots)
    assert any("forest_plot" in name for name in copied)


def test_sensitivity_description_only_names_observed_methods_and_figures(tmp_path):
    from delivery_fixture import ready_delivery
    from mr_agent.paper.sections import _describe_sensitivity
    result = numeric_result()
    before = _describe_sensitivity(result).casefold()
    assert "leave-one-out" not in before and "funnel" not in before
    assert "egger" not in before and "weighted median" not in before
    ready_delivery(result, tmp_path)
    after = _describe_sensitivity(result).casefold()
    assert "leave-one-out" in after and "funnel" in after


def test_report_entry_renders_validated_figures_and_rejects_failed_interpretation(tmp_path):
    from PyPDF2 import PdfReader
    from delivery_fixture import ready_delivery
    from mr_agent.analysis.delivery import MRDeliveryError
    from mr_agent.output.report import generate_pdf_report

    result = ready_delivery(numeric_result(), tmp_path / "analysis")
    state = SessionState(analysis_results=[result])
    report = generate_pdf_report(state, tmp_path / "report")
    assert len(PdfReader(report).pages) >= 5
    result.interpretation_status = "failed"
    with pytest.raises(MRDeliveryError):
        generate_pdf_report(state, tmp_path / "failed-report")
    assert not (tmp_path / "failed-report").exists()


def test_paper_generation_rejects_incomplete_interpretation_before_model_call():
    from mr_agent.analysis.delivery import MRDeliveryError
    from mr_agent.paper.generator import PaperGenerator

    state = SessionState(analysis_results=[numeric_result()])
    generator = PaperGenerator(object(), state)
    with pytest.raises(MRDeliveryError) as caught:
        generator.generate()
    assert caught.value.code == "mr_interpretation_incomplete"


def test_finalize_existing_accepts_completed_generation_and_real_figures(tmp_path):
    import evimed_runner
    from PyPDF2 import PdfReader
    from delivery_fixture import ready_delivery
    from test_release_grounding import _result

    result = ready_delivery(_result(), tmp_path / "analysis")
    result.presso_global_pval = 0.01
    result.radial_pval = 0.03
    result.conmix_pval = 0.02
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"exposure": "LDL cholesterol", "outcome": "CHD", "outputLanguage": "en"}))
    (tmp_path / "mendelian-randomization-run.json").write_text(json.dumps([result.model_dump(mode="json")]))
    (tmp_path / "mendelian-randomization-report.md").write_text("# Existing report\n\n## Abstract\nBounded result interpretation.\n")
    assert evimed_runner.finalize_existing(request, tmp_path) == 0
    receipt = json.loads((tmp_path / "result.json").read_text())
    assert receipt["status"] == "succeeded"
    assert receipt["modules"]["interpretation"]["status"] == "ok"
    assert receipt["modules"]["diagnosticPlots"]["status"] == "ok"
    assert len(PdfReader(tmp_path / "mendelian-randomization-report.pdf").pages) >= 5


@pytest.mark.parametrize("status,finish,expected", [
    (429, "length", (429, "length")), (True, "private-provider-detail", (None, None)),
    (999, {"response": "private-provider-detail"}, (None, None)),
])
def test_failure_preserves_only_existing_bounded_exception_metadata(status, finish, expected):
    from mr_agent.analysis.delivery import MRDeliveryError
    error = RuntimeError("private-provider-detail")
    error.status_code = status
    error.finish_reason = finish
    def fail(**kwargs):
        raise error
    result = numeric_result()
    with pytest.raises(MRDeliveryError):
        MRPipeline(SimpleNamespace(chat=fail), SessionState())._step9_interpret([result])
    assert (result.interpretation_failure.status_code, result.interpretation_failure.finish_reason) == expected
    assert "private-provider-detail" not in result.model_dump_json()
