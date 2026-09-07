"""Signed MR receipt producer integration; fake analysis, real protected queue.

A temporary toy manifest and key exercise the exact fixture policy without
network/model calls or dependence on downloaded public data. They are never
release trust anchors or release evidence.
"""
from __future__ import annotations

import copy
import importlib
import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_mr_inputs import setup_mr
from test_service import _token

AUDIT = Path(__file__).resolve().parents[2] / "evals/capability-audit"


def setup_audit(tmp_path, monkeypatch, *, simulate_isolation=True):
    monkeypatch.syspath_prepend(str(AUDIT))
    import hosted_receipts as receipts
    import public_mr_fixture as fixture

    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    manifest = fixture.load_manifest()
    prefix = fixture.fixture_prefix(manifest)
    target = workspace / prefix
    target.mkdir(parents=True)
    for index, item in enumerate(manifest["files"]):
        blob = f"test-only public fixture source {index}\n".encode()
        item.update(bytes=len(blob), sha256=receipts.digest(blob))
        (target / item["name"]).write_bytes(blob)
    for index, (name, metadata) in enumerate(manifest["outputs"].items()):
        blob = ("SNP,beta,se,effect_allele,other_allele,eaf,pval\n"
                f"rs1,0.{index + 2},0.01,A,G,0.2,1e-10\n").encode()
        metadata.update(bytes=len(blob), sha256=receipts.digest(blob))
        (target / name).write_bytes(blob)
    manifest_path = tmp_path / "test-public-mr.json"
    manifest_path.write_bytes(receipts.canonical(manifest))
    (target / "fixture-manifest.json").write_bytes(receipts.canonical(manifest) + b"\n")
    monkeypatch.setattr(fixture, "load_manifest", lambda: copy.deepcopy(manifest))
    # The first RED run reaches the real missing status field, not an import error.
    try:
        producer = importlib.import_module("evimed_specialist_adapter.audit_receipt")
    except ModuleNotFoundError:
        producer = None
    if producer:
        monkeypatch.setattr(producer, "FIXTURE_MANIFEST", manifest_path)
        if simulate_isolation:
            # This non-root contract fixture cannot change UID. The separate
            # Linux probe executes the real boundary, including EACCES.
            monkeypatch.setattr(producer, "analysis_credentials", lambda: {} if os.getenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE") else None)
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    key_file = tmp_path / "audit-test-key.pem"
    key_file.write_bytes(pem)
    key_file.chmod(0o600)
    monkeypatch.setenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", str(key_file))
    public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                          serialization.PublicFormat.SubjectPublicKeyInfo)
    return service, client, secret, workspace, fixture.arguments_for_manifest(manifest), receipts, public, key_file


def start_job(setup, monkeypatch, request=None):
    service, client, secret, workspace, arguments, *_ = setup
    queued = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    with monkeypatch.context() as patch:
        patch.setattr(service.subprocess, "Popen", lambda command, **_: queued.append(command) or Worker())
        response = client.post("/api/v1/evimed/mendelian-randomization",
            headers={"Authorization": f"Bearer {_token(secret)}"},
            json={"action": "start", **(request if request is not None else arguments)})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "warning", response.text
    return Path(queued[0][-1]), response.json()["data"]["jobId"]


def completed(setup, monkeypatch, request=None):
    service, client, secret, _, *_ = setup
    state_path, job_id = start_job(setup, monkeypatch, request)
    assert service.run_job(str(state_path)) == 0
    result = client.post("/api/v1/evimed/mendelian-randomization",
        headers={"Authorization": f"Bearer {_token(secret)}"},
        json={"action": "status", "jobId": job_id}).json()
    assert result["status"] == "success", result
    return result, state_path


def wrapper(setup, result):
    _, _, _, _, arguments, _, _, _ = setup
    proof = result["data"]["auditReceipt"]
    return {"schemaVersion": 1, "kind": "isolated-specialist-receipt",
        "tool": "mendelian_randomization", "startedJobId": result["data"]["jobId"],
        "scope": {"userId": "user1", "projectId": "project1", "activeWorkspace": ""},
        "request": arguments, "proof": proof,
        "response": {"status": result["status"], "jobId": result["data"]["jobId"],
            "jobStatus": result["data"]["jobStatus"], "artifacts": [row["path"] for row in result["artifacts"]]}}


def test_terminal_public_pair_has_stored_signature_accepted_by_clean_verifier(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    service, _, _, workspace, arguments, receipts, public, _ = setup
    result, state_path = completed(setup, monkeypatch)
    assert "auditReceipt" in result["data"]
    value = wrapper(setup, result)
    expected = service._source_evidence(tmp_path / "agent")
    receipts.validate_receipt(value, workspace, "mendelian_randomization", 1,
                              expected=expected, trustedPublicKey=public)
    assert value["proof"]["requestSha256"] == receipts.digest(receipts.canonical(arguments))
    assert len(state_path.read_bytes()) <= 256 * 1024
    assert str(tmp_path) not in json.dumps(value)
    # Mutating workspace files cannot change the protected terminal attestation.
    (workspace / arguments["exposureSource"]["path"]).write_text("changed input")
    after = service._status({"jobId": result["data"]["jobId"]}, workspace)
    assert after["data"]["auditReceipt"] == value["proof"]
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(value, workspace, "mendelian_randomization", 1,
                                  expected=expected, trustedPublicKey=public)


def test_health_reports_optional_signing_readiness_without_secret_paths(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    body = setup[1].get("/health").json()
    assert body["auditReceiptsReady"] is True
    assert str(tmp_path) not in json.dumps(body)


@pytest.mark.parametrize("invalid", ["missing", "mode", "symlink", "non_ed25519"])
def test_unavailable_signing_key_is_not_loaded_or_advertised(tmp_path, monkeypatch, invalid):
    setup = setup_audit(tmp_path, monkeypatch)
    key_file = setup[-1]
    if invalid == "missing":
        key_file.unlink()
    elif invalid == "mode":
        key_file.chmod(0o644)
    elif invalid == "symlink":
        moved = key_file.with_suffix(".moved")
        key_file.rename(moved)
        key_file.symlink_to(moved)
    else:
        from cryptography.hazmat.primitives.asymmetric import ec
        key_file.write_bytes(ec.generate_private_key(ec.SECP256R1()).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    from evimed_specialist_adapter import audit_receipt
    assert audit_receipt.signing_key() is None
    assert setup[1].get("/health").json()["auditReceiptsReady"] is False


def test_reversed_fixture_roles_never_receive_audit_attestation(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    request = copy.deepcopy(setup[4])
    request["exposure"], request["outcome"] = request["outcome"], request["exposure"]
    result, _ = completed(setup, monkeypatch, request)
    assert "auditReceipt" not in result["data"]


def test_artifact_mutation_is_detected_without_resigning(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    result, _ = completed(setup, monkeypatch)
    value = wrapper(setup, result)
    workspace = setup[3]
    (workspace / result["artifacts"][0]["path"]).write_text("swapped artifact")
    assert setup[0]._status({"jobId": result["data"]["jobId"]}, workspace)["data"]["auditReceipt"] == value["proof"]
    with pytest.raises(setup[5].ReceiptError):
        setup[5].validate_receipt(value, workspace, "mendelian_randomization", 1,
            expected=setup[0]._source_evidence(tmp_path / "agent"), trustedPublicKey=setup[6])


def test_full_agent_source_change_after_enqueue_fails_before_execution(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    source = tmp_path / "agent/mr_agent/algorithm.py"
    source.write_text("VERSION = 1\n")
    state_path, job_id = start_job(setup, monkeypatch)
    source.write_text("VERSION = 2\n")
    assert setup[0].run_job(str(state_path)) != 0
    result = setup[0]._status({"jobId": job_id}, setup[3])
    assert result["status"] == "error"
    assert "auditReceipt" not in result.get("data", {})


def test_worker_receipts_keep_original_bytes_after_workspace_input_changes(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    service, _, _, workspace, arguments, receipts, public, _ = setup
    original_helper = service._mr_inputs

    def wrapped_helper(root=None):
        helper = original_helper(root)
        prepare = helper.prepare_sources

        def prepare_then_mutate(*args, **kwargs):
            authority = prepare(*args, **kwargs)
            (workspace / arguments["exposureSource"]["path"]).write_text("replaced after authoritative read")
            return authority

        helper.prepare_sources = prepare_then_mutate
        return helper

    monkeypatch.setattr(service, "_mr_inputs", wrapped_helper)
    result, _ = completed(setup, monkeypatch)
    value = wrapper(setup, result)
    receipts.verify_attestation(value["proof"], public)
    expected = next(row for row in value["proof"]["inputs"] if row["path"] == arguments["exposureSource"]["path"])
    assert expected["sha256"] != receipts.digest((workspace / expected["path"]).read_bytes())
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(value, workspace, "mendelian_randomization", 1,
            expected=service._source_evidence(tmp_path / "agent"), trustedPublicKey=public)


def test_raw_license_mutation_omits_attestation(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    (setup[3] / setup[4]["exposureSource"]["path"]).parent.joinpath("LICENSE").write_text("replaced license")
    result, _ = completed(setup, monkeypatch)
    assert "auditReceipt" not in result["data"]


def test_signed_status_is_isolated_by_authenticated_account_and_project(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    result, _ = completed(setup, monkeypatch)
    for user, project in (("user2", "project1"), ("user1", "project2")):
        denied = setup[1].post("/api/v1/evimed/mendelian-randomization",
            headers={"Authorization": f"Bearer {_token(setup[2], user=user, project=project)}"},
            json={"action": "status", "jobId": result["data"]["jobId"]})
        assert "auditReceipt" not in denied.text
        assert denied.status_code != 200 or denied.json()["status"] != "success"


@pytest.mark.parametrize("attack", ["artifact_paths", "input_hash", "symlink_license", "hardlink_key"])
def test_untrusted_or_unsafe_material_is_never_signed(tmp_path, monkeypatch, attack):
    setup = setup_audit(tmp_path, monkeypatch)
    service = setup[0]
    if attack == "hardlink_key":
        import os
        os.link(setup[-1], setup[-1].with_suffix(".alias"))
    elif attack == "symlink_license":
        target = (setup[3] / setup[4]["exposureSource"]["path"]).parent / "LICENSE"
        moved = target.with_suffix(".original")
        target.rename(moved)
        target.symlink_to(moved)
    else:
        original_jobs = service._mr_job

        def wrapped_jobs(root):
            jobs = original_jobs(root)
            execute = jobs.execute

            def altered(*args, **kwargs):
                outcome = execute(*args, **kwargs)
                if attack == "artifact_paths":
                    outcome["artifacts"][0]["path"] = "../unowned.json"
                else:
                    outcome["inputReceipts"][0]["sha256"] = "0" * 64
                return outcome

            jobs.execute = altered
            return jobs

        monkeypatch.setattr(service, "_mr_job", wrapped_jobs)
    result, _ = completed(setup, monkeypatch)
    assert "auditReceipt" not in result["data"]


def test_source_change_during_runner_fails_without_signed_output(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    service = setup[0]
    original_jobs = service._mr_job

    def wrapped_jobs(root):
        jobs = original_jobs(root)
        execute = jobs.execute

        def mutate_source(*args, **kwargs):
            outcome = execute(*args, **kwargs)
            (root / "mr_agent/new_algorithm.py").write_text("VERSION = 2\n")
            return outcome

        jobs.execute = mutate_source
        return jobs

    monkeypatch.setattr(service, "_mr_job", wrapped_jobs)
    state, job_id = start_job(setup, monkeypatch)
    assert service.run_job(str(state)) == 1
    result = service._status({"jobId": job_id}, setup[3])
    assert result["status"] == "error"
    assert "auditReceipt" not in result.get("data", {})


def test_checked_in_fixture_contract_and_clean_source_evidence_share_producer(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(AUDIT))
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parent))
    import hosted_receipts
    import public_mr_fixture
    from evimed_specialist_adapter import audit_receipt

    manifest = json.loads((AUDIT / "fixtures/public_mr.json").read_text())
    request, binding, _, files = audit_receipt._fixture_contract(manifest)
    assert request == public_mr_fixture.arguments_for_manifest(manifest)
    assert binding == public_mr_fixture.fixture_binding(manifest)
    assert files == public_mr_fixture.fixture_file_receipts(manifest)
    agent = AUDIT.parents[2] / "项目代码/孟德尔随机化"
    assert hosted_receipts.current_evidence("mendelian_randomization") == audit_receipt.current_evidence(agent)


def test_signing_secret_locator_is_not_given_to_the_analysis_child(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    assert "EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE" not in setup[0]._child_environment()


def test_optional_receipt_never_overflows_protected_terminal_state(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    service = setup[0]
    state_path, job_id = start_job(setup, monkeypatch)
    state = service._read_state(state_path)
    state["testPadding"] = "x" * (252 * 1024 - len(json.dumps(state, ensure_ascii=False, indent=2).encode()))
    service._write_state(state_path, state)
    assert service.run_job(str(state_path)) == 0
    result = service._status({"jobId": job_id}, setup[3])
    assert result["status"] == "success"
    assert "auditReceipt" not in result["data"]
    assert len(state_path.read_bytes()) <= 256 * 1024


@pytest.mark.parametrize("analysis_success", [True, False])
def test_cleanup_error_is_visible_without_changing_analysis_result(tmp_path, monkeypatch, analysis_success):
    setup = setup_audit(tmp_path, monkeypatch)
    service = setup[0]
    if not analysis_success:
        runner = tmp_path / "agent/evimed_runner.py"
        runner.write_text(runner.read_text().replace("'status':'succeeded'", "'status':'failed','error':'deliberate-analysis-failure'"))
    original = service._mr_job
    diagnostic = {"code": "mr_analysis_cleanup_failed", "message": "Temporary analysis data could not be fully removed."}

    def wrapped(root):
        jobs = original(root)
        execute = jobs.execute

        def with_cleanup_error(*args, **kwargs):
            outcome = execute(*args, **kwargs)
            outcome["cleanupError"] = diagnostic
            return outcome

        jobs.execute = with_cleanup_error
        return jobs

    monkeypatch.setattr(service, "_mr_job", wrapped)
    state, job_id = start_job(setup, monkeypatch)
    assert service.run_job(str(state)) == (0 if analysis_success else 1)
    result = service._status({"jobId": job_id}, setup[3])
    assert result["status"] == ("success" if analysis_success else "error")
    assert result["data"]["cleanupError"] == diagnostic
    assert result["data"]["jobStatus"] == ("succeeded" if analysis_success else "failed")
    assert "auditReceipt" not in result["data"]
    assert service._read_state(state)["cleanupError"] == diagnostic
    if not analysis_success:
        assert "deliberate-analysis-failure" in json.dumps(result)
