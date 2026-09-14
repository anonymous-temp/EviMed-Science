"""Bounded private retention does not preserve free-text metadata or unsafe paths."""
import json

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
