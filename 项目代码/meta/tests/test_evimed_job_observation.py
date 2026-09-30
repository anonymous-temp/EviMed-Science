"""Hosted Meta observations bind the admitted job to actual retained bytes."""
from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from new_meta import evimed_adapter as adapter
from test_evimed_adapter import _fixture, _post


AUDIT = Path(__file__).resolve().parents[3] / "OpenScience/evals/capability-audit"


def start(tmp_path, monkeypatch, *, with_inputs=False):
    client, workspace = _fixture(tmp_path, monkeypatch)
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", raising=False)
    monkeypatch.syspath_prepend(str(AUDIT))
    receipts = importlib.import_module("hosted_receipts")
    spawned = []
    monkeypatch.setattr(adapter.subprocess, "Popen", lambda argv, **kwargs:
                        spawned.append(argv) or SimpleNamespace(wait=lambda **kwargs: 0))
    request = {"topic": "  Intervention A   versus B\nfor mortality", "maxPapers": 4}
    if with_inputs:
        (workspace / "papers/nested").mkdir(parents=True)
        (workspace / "papers/trial.pdf").write_bytes(b"%PDF-original-admitted-source")
        (workspace / "papers/nested/ignored.pdf").write_bytes(b"not read by Meta")
        (workspace / "papers/private.env").write_text("do-not-observe")
        (workspace / "data").mkdir()
        (workspace / "data/ipd.json").write_text('{"studies": []}')
        request.update(userPdfDirectory="papers", ipdData="data/ipd.json")
    response = _post(client, {"action": "start", **request}).json()
    assert response["status"] == "warning", response
    job = response["data"]["jobId"]
    return client, workspace, request, job, Path(spawned[0][-1]), receipts


def complete(monkeypatch, state_path, *, code=0, manuscript=True, release="ready"):
    def run(argv, **kwargs):
        project = Path(argv[argv.index("--output-dir") + 1]) / "review"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package/release_decision.json").write_text(json.dumps({"status": release, "deliverable": manuscript}))
        (project / "protocol.json").write_text('{"question": "retained protocol"}')
        if manuscript:
            (project / "manuscript").mkdir(exist_ok=True)
            (project / "manuscript/draft.md").write_text("# Supported review\n\nEvidence remains usable.\n")
        return SimpleNamespace(returncode=code)

    monkeypatch.setattr(adapter.subprocess, "run", run)
    return adapter.run_job(str(state_path))


@pytest.mark.parametrize("code,release", [(0, "ready"), (2, "blocked"), (75, "ready_with_warnings")])
def test_real_terminal_response_captures_unsigned_observation(tmp_path, monkeypatch, code, release):
    client, workspace, request, job, state_path, receipts = start(tmp_path, monkeypatch, with_inputs=True)
    admitted = json.loads(state_path.read_text())
    assert admitted["sourceEvidence"] == receipts.current_evidence("meta_analysis")
    assert complete(monkeypatch, state_path, code=code, release=release) == 0
    response = _post(client, {"action": "status", "jobId": job}).json()
    proof = response["data"]["auditReceipt"]
    assert proof["schemaVersion"] == 2 and proof["evidenceKind"] == "worker-observation"
    assert proof["jobId"] == job and proof["jobStatus"] == "succeeded"
    assert proof["releaseStatus"] == release
    assert proof["inputs"] == admitted["inputReceipts"]
    assert [row["path"] for row in proof["inputs"]] == ["data/ipd.json", "papers/trial.pdf"]
    assert "attestation" not in proof and str(tmp_path) not in json.dumps(proof)
    assert "test-key-never-persist" not in json.dumps(proof)
    scope = {"userId": "user-1", "projectId": "project-1", "activeWorkspace": ""}
    relative = receipts.capture_receipt(workspace, "meta_analysis", request, response, scope, expected_job_id=job)
    value = json.loads((workspace / relative).read_text())
    receipts.validate_receipt(value, workspace, "meta_analysis", 1)
    with pytest.raises(receipts.ReceiptError, match="started_job_mismatch"):
        receipts.capture_receipt(workspace, "meta_analysis", request, response, scope, expected_job_id="meta-other-job")
    # A poll never creates or refreshes a receipt from changed output bytes.
    (workspace / proof["artifacts"][0]["path"]).write_text("changed after completion")
    assert _post(client, {"action": "status", "jobId": job}).json()["data"]["auditReceipt"] == proof
    with pytest.raises(receipts.ReceiptError, match="artifact_changed"):
        receipts.validate_receipt(value, workspace, "meta_analysis", 1)


@pytest.mark.parametrize("change", ["input", "source", "missing-admission"])
def test_unavailable_observation_never_withholds_supported_output(tmp_path, monkeypatch, change):
    client, workspace, _, job, state_path, _ = start(tmp_path, monkeypatch, with_inputs=True)
    if change == "input":
        (workspace / "papers/trial.pdf").write_bytes(b"%PDF-changed")
    elif change == "source":
        monkeypatch.setattr(adapter.job_observation, "current_evidence", lambda: {"changed": True})
    else:
        state = json.loads(state_path.read_text())
        state.pop("sourceEvidence")
        state_path.write_text(json.dumps(state))
    assert complete(monkeypatch, state_path, code=75) == 0
    response = _post(client, {"action": "status", "jobId": job}).json()
    assert response["data"]["jobStatus"] == "succeeded" and response["artifacts"]
    assert "auditReceipt" not in response["data"]


def test_failed_job_keeps_actual_partial_files_without_success_observation(tmp_path, monkeypatch):
    client, workspace, _, job, state_path, _ = start(tmp_path, monkeypatch)
    assert complete(monkeypatch, state_path, code=75, manuscript=False) == 75
    state = json.loads(state_path.read_text())
    response = _post(client, {"action": "status", "jobId": job}).json()
    assert state["status"] == "failed" and state["sourceEvidence"]
    assert "auditReceipt" not in state
    assert response["artifacts"] and any(row["kind"] == "protocol" for row in response["artifacts"])
    assert all((workspace / row["path"]).exists() for row in response["artifacts"])


def test_terminal_worker_reentry_does_not_rewrite_original_observation(tmp_path, monkeypatch):
    _, _, _, _, state_path, _ = start(tmp_path, monkeypatch)
    complete(monkeypatch, state_path)
    before = state_path.read_bytes()
    monkeypatch.setattr(adapter.subprocess, "run", lambda *args, **kwargs: pytest.fail("terminal job executed twice"))
    assert adapter.run_job(str(state_path)) == 0
    assert state_path.read_bytes() == before
