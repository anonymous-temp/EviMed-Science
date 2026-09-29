"""Bounded private retention does not preserve free-text metadata or unsafe paths."""
import io
import json
from pathlib import Path

import pytest

import evimed_local_inputs as inputs
import evimed_mr_job as jobs


@pytest.fixture
def directories(tmp_path):
    stage, retained = tmp_path / "stage", tmp_path / "retained"
    stage.mkdir(mode=0o700)
    retained.mkdir(mode=0o700)
    (stage / "analysis-data/pair").mkdir(parents=True)
    with inputs.directory_fd(stage) as source, inputs.directory_fd(retained) as destination:
        yield stage, retained, source, destination


@pytest.mark.parametrize("danger", ["symlink", "oversize", "total_size", "secret", "bad_format"])
def test_unsafe_artifacts_leave_safe_failure_metadata_only(directories, monkeypatch, danger):
    stage, retained, source, destination = directories
    candidate = stage / "analysis-data/pair/scatter_plot.pdf"
    if danger == "symlink":
        candidate.symlink_to(stage / "request.json")
        (stage / "request.json").write_text("PRIVATE_REQUEST")
    elif danger == "oversize":
        monkeypatch.setattr(jobs, "MAX_DIAGNOSTIC_FILE_BYTES", 16)
        candidate.write_bytes(b"%PDF-" + b"x" * 20)
    elif danger == "total_size":
        monkeypatch.setattr(jobs, "MAX_DIAGNOSTIC_BYTES", 16)
        candidate.write_bytes(b"%PDF-" + b"x" * 20)
    elif danger == "secret":
        candidate.write_bytes(b"%PDF-synthetic-provider-secret")
    else:
        candidate.write_bytes(b"not a PDF")
    result = jobs._retain_failure(inputs, source, destination, {"status": "failed"},
                                  {"LLM_API_KEY": "synthetic-provider-secret"})
    assert result["failed"] and result["diagnosticOnly"]
    assert result["artifactRetentionError"] == "mr_diagnostic_artifacts_invalid"
    assert list(retained.rglob("*.pdf")) == []
    assert "synthetic-provider-secret" not in (retained / "diagnostic.json").read_text()


def test_retained_numerical_projection_drops_all_unrecognized_text(directories):
    stage, retained, source, destination = directories
    (stage / "analysis-data/pair/mr_results.csv").write_text(
        "method,b,se,pval,prompt,environment\nIVW,0.4,0.1,0.001,PRIVATE_BODY,PRIVATE_KEY\n"
    )
    (stage / "provider-response.json").write_text('{"body":"PRIVATE_BODY"}')
    result = jobs._retain_failure(inputs, source, destination, {"status": "failed"}, {})
    assert len(result["artifacts"]) == 1
    body = (retained / "pair-001/mr_results.csv").read_text()
    assert body == "method,b,se,pval\nIVW,0.4,0.1,0.001\n"
    assert "PRIVATE_" not in body
    assert result["artifacts"][0]["numericProjection"] is True


def test_oversized_sdk_metadata_is_withheld_not_truncated_into_a_complete_claim(directories):
    _, retained, source, destination = directories
    raw = {"schema_version": 1, "phase": "interpretation", "failures": [{
        "result_index": 0, "failure": {"error_type": "RuntimeError", "calls": [{}] * 11},
    }]}
    result = jobs._retain_failure(inputs, source, destination, {"failureDiagnostics": raw}, {})
    assert result["diagnosticProjectionError"] == "mr_failure_diagnostic_invalid"
    assert result["failureDiagnostics"]["failures"] == []
    assert json.loads((retained / "diagnostic.json").read_text())["diagnosticOnly"]


def test_existing_private_diagnostic_is_never_overwritten(directories):
    _, retained, source, destination = directories
    original = retained / "diagnostic.json"
    original.write_text("prior evidence")
    with pytest.raises(ValueError):
        jobs._retain_failure(inputs, source, destination, {}, {})
    assert original.read_text() == "prior evidence"


def test_csv_parser_failure_retains_original_typed_failure(directories):
    stage, retained, source, destination = directories
    (stage / "analysis-data/pair/mr_results.csv").write_text("b,ignored\n0.4," + "x" * 150000 + "\n")
    result = jobs._retain_failure(inputs, source, destination, {"status": "failed"}, {})
    assert result["artifactRetentionError"] == "mr_diagnostic_artifacts_invalid"
    assert (retained / "diagnostic.json").exists()


def test_unconfirmed_process_shutdown_never_reads_its_artifacts(directories, monkeypatch):
    _, retained, source, destination = directories
    monkeypatch.setattr(jobs, "_inventory", lambda *args: pytest.fail("live analysis artifacts inspected"))
    result = jobs._retain_failure(inputs, source, destination, {"status": "failed"}, {}, artifacts_safe=False)
    assert result["artifactRetentionError"] == "mr_analysis_group_unconfirmed"
    assert (retained / "diagnostic.json").exists()


def test_the_runner_log_tail_is_kept_privately_from_a_whole_line(directories, monkeypatch):
    _, retained, source, destination = directories
    monkeypatch.setattr(jobs, "MAX_RUNNER_LOG_BYTES", 33)
    log = io.BytesIO(b"401 for synthetic-provider-secret\nMR runner failed\n")
    result = jobs._retain_failure(inputs, source, destination, {"errorCode": "mr_open_source_ambiguous"},
                                  {"LLM_API_KEY": "synthetic-provider-secret"}, runner_log=jobs._log_tail(log))
    # The 33-byte tail begins "provider-secret": the cut split a credential,
    # and the part left would pass the credential check. The partial first line
    # is dropped; the whole lines after it are kept.
    assert (retained / "runner.log").read_bytes() == b"MR runner failed\n"
    assert result["runnerLog"]["truncated"] is True and result["runnerLog"]["bytes"] == 17
    assert result["runnerErrorCode"] == "mr_open_source_ambiguous"
    assert json.loads((retained / "diagnostic.json").read_text())["runnerLog"] == result["runnerLog"]


def test_a_runner_log_holding_a_credential_is_withheld(directories):
    _, retained, source, destination = directories
    log = io.BytesIO(b"Traceback: 401 for synthetic-provider-secret\n")
    result = jobs._retain_failure(inputs, source, destination, {"errorCode": "free text, not a code"},
                                  {"LLM_API_KEY": "synthetic-provider-secret"}, runner_log=jobs._log_tail(log))
    assert result["runnerLogWithheld"] == "mr_sensitive_diagnostic_withheld"
    assert "runnerLog" not in result and "runnerErrorCode" not in result
    assert not (retained / "runner.log").exists()
    assert "synthetic-provider-secret" not in (retained / "diagnostic.json").read_text()


def test_public_partial_science_is_a_new_projection_not_access_to_private_diagnostics(directories, tmp_path):
    stage, retained, source, destination = directories
    (stage / "analysis-data/pair/mr_results.csv").write_text("method,nsnp,b,se,pval,prompt\nIVW,8,0.4,0.1,0.001,PRIVATE_BODY\n")
    (stage / "provider-response.json").write_text('{"body":"PRIVATE_BODY"}')
    jobs._retain_failure(inputs, source, destination, {"errorCode": "mr_interpretation_failed"}, {}, runner_log=(b"PRIVATE_LOG\n", False))
    private_before = {p.relative_to(retained).as_posix(): p.read_bytes() for p in retained.rglob("*") if p.is_file()}
    output = tmp_path / "public"; output.mkdir()
    with inputs.directory_fd(output) as target:
        artifacts, receipts = jobs._publish_partial_failure(inputs, source, target, Path("output"), "mr_interpretation_failed", {})
    assert artifacts and receipts
    public = "\n".join(p.read_text() for p in output.rglob("*") if p.is_file())
    assert "0.4" in public and "mr_interpretation_failed" in public
    assert "PRIVATE_" not in public and "runner.log" not in public and "failureDiagnostics" not in public
    summary = json.loads((output / "partial-research.json").read_text())
    assert summary["status"] == "partial"
    assert summary["primary_estimate_available"] is True
    assert {p.relative_to(retained).as_posix(): p.read_bytes() for p in retained.rglob("*") if p.is_file()} == private_before


def test_public_partial_does_not_read_unstopped_analysis(directories, tmp_path, monkeypatch):
    _, _, source, _ = directories
    monkeypatch.setattr(jobs, "_inventory", lambda *args: pytest.fail("live files inspected"))
    output = tmp_path / "public"; output.mkdir()
    with inputs.directory_fd(output) as target:
        assert jobs._publish_partial_failure(inputs, source, target, Path("output"), "mr_analysis_stop_failed", {}, artifacts_safe=False) == ([], [])
    assert not list(output.iterdir())


@pytest.mark.parametrize("row", ["IVW,8,0.4,,0.001", "IVW,8,NaN,0.1,0.001", "IVW,8,0.4,0.1", "Unknown provider message,8,0.4,0.1,0.001"])
def test_incomplete_primary_csv_never_becomes_completed_partial_statistics(directories, tmp_path, row):
    stage, _, source, _ = directories
    (stage / "analysis-data/pair/mr_results.csv").write_text("method,nsnp,b,se,pval\n" + row + "\n")
    output = tmp_path / "public"; output.mkdir()
    with inputs.directory_fd(output) as target:
        jobs._publish_partial_failure(inputs, source, target, Path("output"), "mr_analysis_failed", {})
    assert not list(output.iterdir())
    assert not list(output.rglob("mr_results.csv"))


def test_zero_iv_catalogue_projection_preserves_stage_and_does_not_claim_independence(directories, tmp_path):
    stage, _, source, _ = directories
    (stage / "inputs").mkdir()
    (stage / "inputs/open-exposure.csv").write_text("SNP,beta,se,pval\n")
    (stage / "mendelian-randomization-open-sources.json").write_text(json.dumps({
        "analysisStatus": "not_computed", "exposure": {"accession": "GCST000001"}, "outcome": {"accession": "GCST000002"},
        "instrumentSelection": {"stage": "candidates_before_clumping", "ldChecked": False, "genomeWideSignificantVariants": 0}}))
    output = tmp_path / "public"; output.mkdir()
    with inputs.directory_fd(output) as target:
        jobs._publish_partial_failure(inputs, source, target, Path("output"), "mr_open_no_instruments", {})
    summary = json.loads((output / "partial-research.json").read_text())
    assert summary["primary_estimate_available"] is False
    assert summary["selection"]["stage"] == "candidates_before_clumping"
    assert summary["selection"]["ldChecked"] is False
    assert summary["source_accessions"] == ["GCST000001", "GCST000002"]
