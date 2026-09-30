"""Worker job evidence is available without an operator signing key."""
from __future__ import annotations

import copy

import pytest

from test_job_receipts import _complete, _setup, _wrapper


def test_completed_job_records_need_no_signing_key(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, receipts = _setup(
        tmp_path, monkeypatch, isolated=False
    )
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE")
    arguments = {"topic": "antimicrobial stewardship", "maxRecords": 20}
    code, job_id, status = _complete(
        module, client, secret, arguments, monkeypatch,
        "/api/v1/evimed/bibliometric-analysis",
    )
    assert code == 0 and status["status"] == "success", status
    proof = status["data"].get("auditReceipt")
    assert proof is not None, "a normal completed job retains evidence without a signing key"
    assert proof["schemaVersion"] == 2
    assert proof["evidenceKind"] == "worker-observation"
    assert "attestation" not in proof
    value = _wrapper("bibliometric_analysis", arguments, status)
    receipts.validate_receipt(value, workspace, "bibliometric_analysis", 1,
                              expected=module._source_evidence(agent))
    changed = copy.deepcopy(value)
    changed["scope"]["userId"] = "another-account"
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(changed, workspace, "bibliometric_analysis", 1,
                                  expected=module._source_evidence(agent))
    (workspace / f"bibliometric-analysis-runs/{job_id}/output/report.md").write_text("changed")
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(value, workspace, "bibliometric_analysis", 1,
                                  expected=module._source_evidence(agent))


def test_a_retired_signing_key_setting_cannot_refuse_an_ordinary_job(tmp_path, monkeypatch):
    module, client, secret, _, _, _, _ = _setup(tmp_path, monkeypatch, isolated=False)
    monkeypatch.setenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", "/not-an-existing-signing-key")
    code, _, status = _complete(
        module, client, secret, {"topic": "sepsis"}, monkeypatch,
        "/api/v1/evimed/bibliometric-analysis",
    )
    assert code == 0 and status["status"] == "success", status
    assert "attestation" not in status["data"]["auditReceipt"]
