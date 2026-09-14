"""Failed diagnostics survive scratch cleanup without becoming deliverables."""
import json

import pytest

from test_mr_inputs import queue_job, setup_mr, write_sources


def failed_runner(tmp_path, *, unsafe=False):
    diagnostic = {
        "schema_version": 1, "phase": "interpretation", "omitted_results": 0,
        "failures": [{"result_index": 0, "failure": {
            "error_type": "RuntimeError", "status_code": None, "finish_reason": "length",
            "category": "truncated", "sdk_call_attempts": 1, "calls": [{
                "sdk_call": 1, "retry_attempt": 1, "request_max_tokens": 6096,
                "category": "truncated", "error_type": None, "status_code": None,
                "finish_reason": "length", "content_present": False,
                "prompt_tokens": 100, "completion_tokens": 6096, "total_tokens": 6196,
                "reasoning_tokens": 6096,
            }], "raw_exception": "PRIVATE_PROVIDER_SECRET"}}],
        "provider_body": "PRIVATE_PROVIDER_SECRET",
    }
    result = {"status": "failed", "errorCode": "mr_interpretation_failed",
              "error": "PRIVATE_PROVIDER_SECRET", "failureDiagnostics": diagnostic}
    body = (
        "import json,os,sys\nfrom pathlib import Path\n"
        "os.fchdir(int(sys.argv[-1]))\n"
        "Path('analysis-data/pair').mkdir(parents=True)\n"
        "Path('analysis-data/pair/mr_results.csv').write_text('method,b,se,pval,exposure\\nInverse variance weighted,0.3,0.04,0.001,PRIVATE_PROVIDER_SECRET\\n')\n"
        "Path('provider-response.txt').write_text('PRIVATE_PROVIDER_SECRET')\n"
        + ("Path('analysis-data/pair/scatter_plot.pdf').symlink_to('/etc/passwd')\n" if unsafe else "")
        + "Path('result.json').write_text(" + repr(json.dumps(result)) + ")\n"
        "sys.exit(1)\n"
    )
    (tmp_path / "agent/evimed_runner.py").write_text(body)


def test_failed_mr_retains_only_private_typed_diagnostics_and_numeric_projection(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    failed_runner(tmp_path)
    monkeypatch.setattr(service.audit_receipt, "produce", lambda *args: pytest.fail("failed result was signed"))
    state_path, job_id = queue_job(service, client, secret, monkeypatch)

    assert service.run_job(str(state_path)) == 1

    state = json.loads(state_path.read_text())
    assert state["status"] == "failed" and state["artifacts"] == []
    assert state["errorCode"] == "mr_interpretation_failed"
    assert "auditReceipt" not in state
    assert "PRIVATE_PROVIDER_SECRET" not in json.dumps(state)
    retained = state_path.parent / f"{job_id}.diagnostics"
    summary = json.loads((retained / "diagnostic.json").read_text())
    assert summary["failed"] is True and summary["diagnosticOnly"] is True
    assert summary["failureDiagnostics"]["failures"][0]["failure"]["calls"][0]["request_max_tokens"] == 6096
    numeric = retained / "pair-001/mr_results.csv"
    assert numeric.exists() and "0.3" in numeric.read_text()
    assert "exposure" not in numeric.read_text() and "PRIVATE_PROVIDER_SECRET" not in numeric.read_text()
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in retained.rglob('*') if p.is_file())
    assert not list((workspace / "mendelian-randomization-runs" / job_id / "output").iterdir())
    assert not any(p.name == "provider-response.txt" for p in retained.rglob('*'))
    response = service._status({"jobId": job_id}, workspace)
    assert response["error"]["code"] == "mr_interpretation_failed"
    assert response["data"]["jobStatus"] == "failed"
    assert "artifacts" not in response and "auditReceipt" not in response


def test_unsafe_diagnostic_artifact_cannot_replace_original_failure(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    failed_runner(tmp_path, unsafe=True)
    state_path, job_id = queue_job(service, client, secret, monkeypatch)
    assert service.run_job(str(state_path)) == 1
    state = json.loads(state_path.read_text())
    assert state["errorCode"] == "mr_interpretation_failed" and state["status"] == "failed"
    assert state["failureDiagnosticReceipt"]["artifactRetentionError"] == "mr_diagnostic_artifacts_invalid"
    retained = state_path.parent / f"{job_id}.diagnostics"
    assert (retained / "diagnostic.json").is_file()
    assert not (retained / "pair-001/scatter_plot.pdf").exists()


def test_diagnostic_directory_refuses_existing_or_symlink_destination(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    state_path, job_id = queue_job(service, client, secret, monkeypatch)
    victim = tmp_path / "victim"
    victim.mkdir()
    target = state_path.parent / f"{job_id}.diagnostics"
    target.symlink_to(victim, target_is_directory=True)
    with pytest.raises((OSError, ValueError)):
        with service._mr_store().diagnostic_directory(state_path):
            pytest.fail("unsafe diagnostic destination accepted")
    assert list(victim.iterdir()) == []
