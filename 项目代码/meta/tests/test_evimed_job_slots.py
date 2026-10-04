"""One specialist job at a time across engines, as the MetaAgent adapter applies it.

The host is shared and an engine container may use 2 GB while a job runs, so
the deployment caps how many specialist jobs run at once across all six engine
containers (``EVIMED_SPECIALIST_MAX_CONCURRENT_JOBS``). MetaAgent ships in its
own image, so it carries its own copy of the slot module, held byte-identical
with the specialist adapter's; what that module guarantees is proved in the
adapter's tests, and what is proved here is that this adapter applies it: a job
over the cap stays queued and says why, it starts by itself, and the slot is
released however the job ends.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from new_meta import evimed_adapter
from new_meta.core import job_slots
from test_evimed_adapter import _LiveWorker, _fixture, _post


def wait_until(predicate, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    return None


@pytest.fixture
def meta(tmp_path, monkeypatch):
    client, workspace = _fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv(job_slots.LIMIT_ENV, "1")
    monkeypatch.delenv(job_slots.WAIT_ENV, raising=False)
    monkeypatch.setattr(job_slots, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(job_slots, "REPORT_SECONDS", 0.05)
    evimed_adapter._WORKERS.clear()
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: _LiveWorker())
    return client, workspace, tmp_path


def start(client, topic="Intervention A versus B for outcome C"):
    response = _post(client, {"action": "start", "topic": topic}).json()
    assert response["status"] == "warning", response
    return response["data"]["jobId"]


def state_file(workspace, job_id):
    return workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"


def writes_a_release(ran, code=0):
    def run(command, **kwargs):
        ran.append(command)
        project = Path(command[command.index("--output-dir") + 1]) / "project"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(json.dumps({"status": "ready", "next_actions": []}))
        return SimpleNamespace(returncode=code)
    return run


def test_a_meta_job_over_the_cap_waits_queued_with_a_reason_and_runs_when_a_slot_frees(meta, monkeypatch):
    client, workspace, _ = meta
    held = job_slots.acquire("mr-in-another-container-1", "mendelian-randomization")  # another engine is running
    job_id = start(client)
    ran = []
    monkeypatch.setattr(evimed_adapter.subprocess, "run", writes_a_release(ran))
    path = state_file(workspace, job_id)
    outcome = []
    thread = threading.Thread(target=lambda: outcome.append(evimed_adapter.run_job(str(path))))
    thread.start()
    try:
        queued = wait_until(lambda: "slotWait" in (state := json.loads(path.read_text())) and state)
        assert queued, "a waiting job says so in its own state"
        assert queued["status"] == "queued" and "startedAt" not in queued
        assert queued["slotWait"]["limit"] == 1 and queued["slotWait"]["running"] == 1
        polled = _post(client, {"action": "status", "jobId": job_id}).json()
        assert polled["status"] == "warning" and polled["data"]["jobStatus"] == "queued", polled
        assert polled["data"]["progress"] == {"stage": "Waiting for a free specialist slot: 1 of 1 running."}
        assert polled["summary"].startswith(f"MetaAgent job {job_id} is queued.") and "has not started" in polled["warnings"][0]
        assert 0 <= polled["data"]["secondsSinceUpdate"] <= 5, "a waiting job heartbeats, so it does not look hung"
        assert not ran, "MetaAgent has not been started"
        assert TestClient(_service_app()).get("/health").json()["specialistSlots"] == {
            "limit": 1, "running": 1, "waiting": 1, "waitSeconds": 10800}
    finally:
        held.release()
        thread.join(30)
    assert outcome == [0] and len(ran) == 1
    done = json.loads(path.read_text())
    assert done["status"] == "succeeded" and "slotWait" not in done and done["slotWaitedSeconds"] >= 0
    assert job_slots.snapshot()["running"] == 0


def test_the_slot_is_released_when_metaagent_fails(meta, monkeypatch):
    client, workspace, _ = meta
    job_id = start(client)
    monkeypatch.setattr(evimed_adapter.subprocess, "run", lambda command, **kwargs: SimpleNamespace(returncode=1))
    assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 1
    assert json.loads(state_file(workspace, job_id).read_text())["status"] == "failed"
    assert job_slots.snapshot()["running"] == 0, "a failed job holds nothing"


def test_a_meta_job_that_waits_past_the_bound_ends_retryable_and_never_ran(meta, monkeypatch):
    client, workspace, _ = meta
    monkeypatch.setenv(job_slots.WAIT_ENV, "1")
    held = job_slots.acquire("mr-in-another-container-1", "mendelian-randomization")
    job_id = start(client)
    ran = []
    monkeypatch.setattr(evimed_adapter.subprocess, "run", writes_a_release(ran))
    try:
        assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 1
    finally:
        held.release()
    state = json.loads(state_file(workspace, job_id).read_text())
    assert state["status"] == "failed" and state["retryable"] is True and state["slotError"] == "slot_wait_expired"
    assert "within 1 seconds" in state["error"] and "startedAt" not in state and not ran
    polled = _post(client, {"action": "status", "jobId": job_id}).json()
    assert polled["status"] == "error" and polled["error"]["code"] == "meta_agent_worker_unavailable"
    assert polled["error"]["retryable"] is True and "again later" in polled["next_actions"][0]
    assert job_slots.snapshot()["waiting"] == 0
    # The same request, asked again once capacity is back, is a new job.
    retried = start(client)
    assert retried != job_id


def test_an_unusable_slot_directory_fails_the_job_by_name(meta, monkeypatch, tmp_path):
    client, workspace, root = meta
    (root / ".openscience").write_text("not a directory")
    job_id = start(client)
    monkeypatch.setattr(evimed_adapter.subprocess, "run", writes_a_release([]))
    assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 1
    state = json.loads(state_file(workspace, job_id).read_text())
    assert state["status"] == "failed" and state["slotError"] == "slot_directory_unavailable" and state["retryable"] is True
    assert TestClient(_service_app()).get("/health").json()["specialistSlots"]["error"] == "slot_directory_unavailable"


def test_without_a_cap_nothing_waits_and_no_slot_file_exists(meta, monkeypatch):
    client, workspace, root = meta
    monkeypatch.delenv(job_slots.LIMIT_ENV)
    job_id = start(client)
    ran = []
    monkeypatch.setattr(evimed_adapter.subprocess, "run", writes_a_release(ran))
    assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 0 and len(ran) == 1
    assert not (root / ".openscience").exists()
    assert TestClient(_service_app()).get("/health").json()["specialistSlots"] == {"limit": 0, "running": 0, "waiting": 0}


def test_the_slot_module_is_the_specialist_adapters_byte_for_byte():
    # Each image carries its own copy, the way engine_model.py is carried; a drifted
    # copy would apply a different cap to the same shared directory.
    root = Path(__file__).resolve().parents[3]
    shared = root / "OpenScience/deploy/specialist-adapter/evimed_specialist_adapter/job_slots.py"
    assert Path(job_slots.__file__).read_bytes() == shared.read_bytes()


def _service_app():
    from new_meta.evimed_service import app
    return app
