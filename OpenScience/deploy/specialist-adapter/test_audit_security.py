"""Review regressions for MR job observations and single-execution ownership."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from test_audit_receipt import AUDIT, completed, setup_audit, start_job


def test_a_retired_readonly_key_setting_is_ignored(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    setup[-1].chmod(0o400)
    result, _ = completed(setup, monkeypatch)
    assert result["data"]["auditReceipt"]["evidenceKind"] == "worker-observation"
    assert "attestation" not in result["data"]["auditReceipt"]


def test_terminal_job_cannot_be_reexecuted_or_rewritten(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    result, state_path = completed(setup, monkeypatch)
    before = state_path.read_bytes()
    setup[0].run_job(str(state_path))
    assert state_path.read_bytes() == before
    state = setup[0]._read_state(state_path)
    state["auditReceipt"]["completedAt"] = "2000-01-01T00:00:00Z"
    with pytest.raises(ValueError, match="terminal|Terminal"):
        setup[0]._write_state(state_path, state)
    assert setup[0]._status({"jobId": result["data"]["jobId"]}, setup[3])["data"] == result["data"]


def test_running_job_claim_rejects_reentrant_execution(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    state_path, _ = start_job(setup, monkeypatch)
    store = setup[0]._mr_store()
    with store.claim(state_path) as claimed:
        assert claimed["status"] == "running"
        with store.claim(state_path) as duplicate:
            assert duplicate is None
        before = state_path.read_bytes()
        assert setup[0].run_job(str(state_path)) != 0
        assert state_path.read_bytes() == before


@pytest.mark.parametrize("name", ["Dockerfile", "Dockerfile.evidence", "requirements.txt"])
def test_each_shipped_deployment_input_is_bound_to_current_evidence(tmp_path, monkeypatch, name):
    setup_audit(tmp_path, monkeypatch)
    from evimed_specialist_adapter import audit_receipt
    adapter = tmp_path / "adapter"
    shutil.copytree(Path(__file__).parent / "evimed_specialist_adapter", adapter / "evimed_specialist_adapter")
    for filename in ("Dockerfile", "Dockerfile.evidence", "requirements.txt"):
        (adapter / filename).write_bytes((Path(__file__).parent / filename).read_bytes())
    before = audit_receipt.current_evidence(tmp_path / "agent", adapter / "evimed_specialist_adapter")
    (adapter / name).write_bytes((adapter / name).read_bytes() + b"\n# changed deployment input\n")
    assert audit_receipt.current_evidence(tmp_path / "agent", adapter / "evimed_specialist_adapter") != before


def test_adapter_engines_and_meta_use_their_actual_producer_evidence_rule(tmp_path, monkeypatch):
    setup_audit(tmp_path, monkeypatch)
    import hosted_receipts
    from evimed_specialist_adapter import audit_receipt
    adapter_package = AUDIT.parents[1] / "deploy/specialist-adapter/evimed_specialist_adapter"
    assert hosted_receipts.current_evidence("peer_review") == audit_receipt.current_evidence(
        AUDIT.parents[2] / "项目代码/论文审稿", adapter_package)
    assert hosted_receipts.current_evidence("meta_analysis") == hosted_receipts.meta_observation().current_evidence()






def test_concurrent_claims_have_one_winner(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    setup = setup_audit(tmp_path, monkeypatch)
    path, _ = start_job(setup, monkeypatch)
    barrier = Barrier(4)

    def claim():
        barrier.wait(timeout=5)
        with setup[0]._mr_store().claim(path) as state:
            return state is not None

    with ThreadPoolExecutor(max_workers=4) as pool:
        winners = list(pool.map(lambda _: claim(), range(4)))
    assert winners.count(True) == 1
    assert setup[0]._read_state(path)["status"] == "running"


def test_unsigned_jobs_need_no_privilege_drop(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch, simulate_isolation=False)
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE")
    result, _ = completed(setup, monkeypatch)
    assert result["data"]["auditReceipt"]["evidenceKind"] == "worker-observation"




def test_image_manifest_detects_deployment_changes_without_reading_private_state(tmp_path, monkeypatch):
    setup_audit(tmp_path, monkeypatch)
    from evimed_specialist_adapter import audit_receipt
    target = tmp_path / "image/evimed_specialist_adapter"
    shutil.copytree(Path(__file__).parent / "evimed_specialist_adapter", target)
    for name in audit_receipt.DEPLOYMENT_INPUTS:
        (target.parent / name).write_bytes((Path(__file__).parent / name).read_bytes())
    manifest = audit_receipt.adapter_manifest(target)
    (target.parent / "adapter-evidence.json").write_bytes(audit_receipt.canonical(manifest) + b"\n")
    audit_receipt.adapter_evidence(target)
    (target.parent / "requirements.txt").write_text("changed dependency")
    with pytest.raises(audit_receipt.AuditReceiptUnavailable, match="manifest_changed"):
        audit_receipt.adapter_evidence(target)


def test_status_race_preserves_worker_terminal_receipt(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    path, job_id = start_job(setup, monkeypatch)
    service = setup[0]
    monkeypatch.setattr(service, "_managed_worker_alive", lambda *_: False)
    write = service._write_state
    injected = []

    def race(state_path, state, **kwargs):
        if state.get("status") == "failed" and not injected:
            injected.append(True)
            assert service.run_job(str(path)) == 0
        return write(state_path, state, **kwargs)

    monkeypatch.setattr(service, "_write_state", race)
    result = service._status({"jobId": job_id}, setup[3])
    assert result["status"] == "success"
    assert result["data"]["auditReceipt"] == service._read_state(path)["auditReceipt"]
