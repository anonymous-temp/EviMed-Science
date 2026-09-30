"""Failed diagnostics survive scratch cleanup without becoming deliverables."""
import json

import pytest

from test_mr_inputs import queue_job, setup_mr, write_sources


def failed_runner(tmp_path, *, unsafe=False, complete=False):
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
    if complete:
        body = body.replace("method,b,se,pval,exposure", "method,nsnp,b,se,pval,exposure").replace("weighted,0.3", "weighted,8,0.3")
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
    # The runtime's tool contract refuses `data` on an error result: with it,
    # this failure reached the run as adapter_contract_failure.
    assert "data" not in response
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


def test_failed_mr_publishes_completed_numeric_projection_through_error_contract(tmp_path, monkeypatch):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    failed_runner(tmp_path, complete=True)
    monkeypatch.setattr(service.audit_receipt, "produce", lambda *args: pytest.fail("failed result was signed"))
    state_path, job_id = queue_job(service, client, secret, monkeypatch)
    assert service.run_job(str(state_path)) == 1
    state = json.loads(state_path.read_text())
    response = service._status({"jobId": job_id}, workspace)
    assert state["status"] == "failed"
    assert response["status"] == "error" and response["error"]["code"] == "mr_interpretation_failed"
    assert response["artifacts"] == state["artifacts"]
    assert any(item["path"].endswith("partial-research.json") for item in response["artifacts"])
    assert "data" not in response and "sources" not in response and "auditReceipt" not in state
    for item in response["artifacts"]:
        content = (workspace / item["path"]).read_text()
        assert "PRIVATE_PROVIDER_SECRET" not in content and "request_max_tokens" not in content
    summary_path = next(item["path"] for item in response["artifacts"] if item["path"].endswith("partial-research.json"))
    assert json.loads((workspace / summary_path).read_text())["primary_estimate_available"] is True


@pytest.mark.parametrize("code", ["analysis_failed", "no_instruments", "no_outcome_data", "insufficient_harmonised_snps", "ld_clumping_failed", "mr_analysis_incomplete", "mr_no_instruments"])
def test_partial_result_keeps_the_fixed_engines_original_error_code(tmp_path, monkeypatch, code):
    service, _, _, _ = setup_mr(tmp_path, monkeypatch)
    actual, message = service._mr_runner_failure({"errorCode": code, "error": "PRIVATE_PROVIDER_SECRET"}, [])
    assert actual == code
    assert "PRIVATE_PROVIDER_SECRET" not in message


@pytest.mark.parametrize("secret", ["mr_analysis_synthetic_secret", "synthetic_private_credential_123456"])
def test_error_code_field_cannot_echo_a_provider_credential(tmp_path, monkeypatch, secret):
    service, _, _, _ = setup_mr(tmp_path, monkeypatch)
    code, message = service._mr_runner_failure({"errorCode": secret}, [secret.encode()])
    assert code is None
    assert secret not in message


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


# The three open-data refusals production returned on 2026-09-28, in shape:
# until the adapter admitted `mr_open_*`, each reached the run as "The fixed MR
# runner failed." with no code, and the runner's log was deleted with the job.
AMBIGUOUS = (
    "PubMed 30124842 has 2 GWAS Catalog studies with full summary statistics: "
    "GCST006900 (Body mass index; 456,426 European ancestry individuals); "
    "GCST006901 (Height; 456,426 European ancestry individuals). Choose one and give its accession."
)
CATALOG = ({"type": "gwas_catalog", "pubmedId": "30124842"}, {"type": "gwas_catalog", "pubmedId": "26343387"})


def refusing_runner(tmp_path, code, message):
    result = {"status": "failed", "errorCode": code, "error": message,
              "modules": {"primaryEstimate": {"status": "failed", "reason": code, "fatal": True}}}
    (tmp_path / "agent/evimed_runner.py").write_text(
        "import json,os,sys\nfrom pathlib import Path\n"
        "os.fchdir(int(sys.argv[-1]))\n"
        "Path('result.json').write_text(" + repr(json.dumps(result)) + ")\n"
        "print(" + repr(f"MR runner failed ({code}): {message}") + ", file=sys.stderr)\n"
        "sys.exit(1)\n"
    )


def run_refused(tmp_path, monkeypatch, code, message):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    refusing_runner(tmp_path, code, message)
    state_path, job_id = queue_job(service, client, secret, monkeypatch, sources=CATALOG)
    assert service.run_job(str(state_path)) == 1
    state = json.loads(state_path.read_text())
    retained = state_path.parent / f"{job_id}.diagnostics"
    return state, service._status({"jobId": job_id}, workspace), retained


def test_an_open_data_refusal_reaches_the_run_with_its_code_and_its_reason(tmp_path, monkeypatch):
    state, response, retained = run_refused(tmp_path, monkeypatch, "mr_open_source_ambiguous", AMBIGUOUS)

    assert state["status"] == "failed" and state["artifacts"] == []
    assert state["errorCode"] == "mr_open_source_ambiguous"
    assert response["error"]["code"] == "mr_open_source_ambiguous"
    # The studies to choose from are what the run corrects its request with.
    assert "GCST006900" in response["error"]["message"] and "GCST006901" in response["error"]["message"]
    assert "data" not in response
    # The runner's own log is kept privately beside the state; the state
    # carries only its description.
    log = (retained / "runner.log").read_text()
    assert "MR runner failed (mr_open_source_ambiguous)" in log
    summary = json.loads((retained / "diagnostic.json").read_text())
    assert summary["runnerErrorCode"] == "mr_open_source_ambiguous"
    assert summary["runnerLog"]["bytes"] == len(log.encode()) and summary["runnerLog"]["truncated"] is False
    assert state["failureDiagnosticReceipt"]["runnerLog"] == summary["runnerLog"]
    assert "MR runner failed" not in json.dumps(state["failureDiagnosticReceipt"])
    assert (retained / "runner.log").stat().st_mode & 0o777 == 0o600


def test_an_open_data_refusal_holding_a_credential_is_shown_by_code_only(tmp_path, monkeypatch):
    # "test-model-key" is the model credential the worker hands the runner.
    state, response, retained = run_refused(
        tmp_path, monkeypatch, "mr_open_source_unavailable", "EBI answered 401 for key test-model-key")

    assert response["error"]["code"] == "mr_open_source_unavailable"
    assert response["error"]["message"] == "The fixed MR runner failed."
    assert "test-model-key" not in json.dumps(state)
    assert not (retained / "runner.log").exists()
    summary = json.loads((retained / "diagnostic.json").read_text())
    assert summary["runnerLogWithheld"] == "mr_sensitive_diagnostic_withheld"
    assert "test-model-key" not in json.dumps(summary)


def test_a_code_the_adapter_does_not_forward_is_still_named(tmp_path, monkeypatch):
    state, response, _ = run_refused(tmp_path, monkeypatch, "mr_unrecognized_failure", "private engine detail")

    assert "errorCode" not in state
    assert response["error"]["code"] == "specialist_execution_failed"
    assert response["error"]["message"] == "The fixed MR runner failed (mr_unrecognized_failure)."
    assert "private engine detail" not in json.dumps(state)


def test_known_no_instruments_code_survives_failed_job_status(tmp_path, monkeypatch):
    state, response, _ = run_refused(tmp_path, monkeypatch, "mr_no_instruments", "no valid instruments")
    assert state["errorCode"] == response["error"]["code"] == "mr_no_instruments"
    assert response["error"]["message"] == "The fixed MR runner failed."
    assert "no valid instruments" not in json.dumps(state)


def test_an_open_data_refusal_is_one_bounded_line(tmp_path, monkeypatch):
    _, response, _ = run_refused(
        tmp_path, monkeypatch, "mr_open_source_invalid",
        "Exposure and outcome\n\tare the same\x1b[31m study. " + "x" * 5000)

    message = response["error"]["message"]
    assert message.startswith("Exposure and outcome are the same[31m study. ")
    assert len(message) == 2000 and message.endswith("…")
    assert "\n" not in message and "\x1b" not in message
