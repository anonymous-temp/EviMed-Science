"""Hosted Meta observations bind the admitted job to actual retained bytes."""
from __future__ import annotations

import importlib
import json
import os
import shutil
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


@pytest.mark.parametrize("change", ["changed", "added", "symlink", "hardlink"])
def test_input_mutation_during_engine_execution_does_not_become_fresh_evidence(tmp_path, monkeypatch, change):
    client, workspace, _, job, state_path, _ = start(tmp_path, monkeypatch, with_inputs=True)
    original_complete = adapter.job_observation.complete

    def mutate_then_observe(state):
        target = workspace / "papers/trial.pdf"
        if change == "changed":
            target.write_bytes(b"%PDF-changed-during-execution")
        elif change == "added":
            (workspace / "papers/new.pdf").write_bytes(b"%PDF-not-admitted")
        else:
            target.unlink()
            if change == "symlink":
                target.symlink_to(workspace / "data/ipd.json")
            else:
                os.link(workspace / "data/ipd.json", target)
        return original_complete(state)

    monkeypatch.setattr(adapter.job_observation, "complete", mutate_then_observe)
    assert complete(monkeypatch, state_path) == 0
    response = _post(client, {"action": "status", "jobId": job}).json()
    assert response["artifacts"] and response["data"]["jobStatus"] == "succeeded"
    assert "auditReceipt" not in response["data"]


def test_admission_observation_failure_does_not_prevent_start_or_delivery(tmp_path, monkeypatch):
    def unavailable():
        raise OSError("private path must never be copied")

    monkeypatch.setattr(adapter.job_observation, "current_evidence", unavailable)
    client, _, _, job, state_path, _ = start(tmp_path, monkeypatch)
    assert complete(monkeypatch, state_path) == 0
    response = _post(client, {"action": "status", "jobId": job}).json()
    assert response["artifacts"] and "auditReceipt" not in response["data"]
    assert "private path" not in state_path.read_text()


def test_scope_uses_original_named_workspace_and_request(tmp_path, monkeypatch):
    _, workspace, _, _, _, _ = start(tmp_path, monkeypatch)
    named = workspace / "Research 1"
    named.mkdir()
    request = {"topic": "question", "action": "start", "waitSeconds": 5, "jobId": "ignored-transport-id"}
    owner = {"userId": "user-1", "projectId": "project-1"}
    observed = adapter.job_observation.admission(request, named, owner)
    assert observed["auditScope"] == {**owner, "activeWorkspace": "Research 1"}
    assert observed["auditRequest"] == {"topic": "question"}
    assert "sourceEvidence" not in adapter.job_observation.admission(request, named, {**owner, "projectId": "other"})


def test_source_formula_covers_shipped_inputs_and_ignores_runtime_secrets(tmp_path):
    observation = adapter.job_observation
    root = tmp_path / "image"
    (root / "new_meta/data").mkdir(parents=True)
    for name in ("evimed_adapter.py", "evimed_job_observation.py", "main.py"):
        (root / "new_meta" / name).write_text("# deployed source\n")
    for name in ("requirements.txt", "requirements.lock", "pyproject.toml"):
        (root / name).write_text("dependency declaration\n")
    (root / "new_meta/data/source.json").write_text("{}")
    before = observation.current_evidence(root)
    (root / ".env").write_text("must-not-hash")
    (root / "new_meta/.env.json").write_text("must-not-hash")
    (root / "outputs").mkdir()
    (root / "outputs/research.json").write_text("must-not-hash")
    assert observation.current_evidence(root) == before
    for name in ("new_meta/main.py", "new_meta/data/source.json", "requirements.txt", "requirements.lock", "pyproject.toml"):
        original = (root / name).read_bytes()
        (root / name).write_bytes(original + b"\n")
        assert observation.current_evidence(root) != before
        (root / name).write_bytes(original)
    # Site-packages/build caches are not part of the image's source identity.
    clone = tmp_path / "other-image"
    shutil.copytree(root, clone)
    (clone / "new_meta/__pycache__").mkdir()
    (clone / "new_meta/__pycache__/main.py").write_text("ignored generated cache")
    assert observation.current_evidence(clone) == before


@pytest.mark.parametrize("path", ["../secret.json", ".jobs/state.json", "secrets/provider.json", "data//ipd.json"])
def test_observation_reader_never_hashes_private_or_escaping_paths(tmp_path, path):
    with pytest.raises(ValueError, match="path_invalid"):
        adapter.job_observation.file_receipt(tmp_path, path)
