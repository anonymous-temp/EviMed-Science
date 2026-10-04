"""One specialist job at a time across engines, as the adapter's workers apply it.

The host is shared and an engine container may use 2 GB while a job runs, so the
deployment caps how many run at once (``EVIMED_SPECIALIST_MAX_CONCURRENT_JOBS``).
These tests drive real workers: a job over the cap stays ``queued`` and says why
through the field a poller already reads, it starts by itself, the slot is
released however the job ends, and a job whose worker is killed frees it. MR's
own queue keeps its authority: the wait happens before its ``claim()``.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from evimed_specialist_adapter import job_slots
from test_service import _NeverStarts, _load_service, _token

BIBLIOMETRIC = "/api/v1/evimed/bibliometric-analysis"
ENGINE = "bibliometric-analysis"


def wait_until(predicate, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    return None


@pytest.fixture
def engine(tmp_path, monkeypatch):
    """A bibliometric adapter whose fake engine holds while its topic is `hold` and fails when it is `fail`."""
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    release = tmp_path / "release"
    (tmp_path / "agent" / "evimed_runner.py").write_text(
        "import argparse,json,time\n"
        "from pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
        "request=json.loads(Path(a.request).read_text())\n"
        f"release=Path({str(release)!r});deadline=time.time()+25\n"
        "while request.get('topic')=='hold' and not release.exists() and time.time()<deadline: time.sleep(0.02)\n"
        "fail=request.get('topic')=='fail'\n"
        "out=Path(a.output_dir);(out/'report.md').write_text('# Report',encoding='utf-8')\n"
        "(out/'result.json').write_text(json.dumps({'status':'failed' if fail else 'succeeded','error':'the engine failed'}),encoding='utf-8')\n"
        "raise SystemExit(1 if fail else 0)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(job_slots, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(job_slots, "REPORT_SECONDS", 0.05)
    monkeypatch.delenv(job_slots.WAIT_ENV, raising=False)
    yield module, client, secret, workspace, release
    release.touch()  # whatever a test left holding lets go


def cap(monkeypatch, value="1"):
    monkeypatch.setenv(job_slots.LIMIT_ENV, value)


def start(engine, topic):
    module, client, secret, workspace, _ = engine
    spawned = []
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(module.subprocess, "Popen", lambda command, **kwargs: spawned.append((command, kwargs)) or _NeverStarts())
        started = client.post(BIBLIOMETRIC, json={"action": "start", "topic": topic},
                              headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    assert started["status"] == "warning", started
    return started["data"]["jobId"], spawned[0]


def state_of(engine, job_id):
    workspace = engine[3]
    return json.loads((workspace / "bibliometric-analysis-runs/.jobs" / f"{job_id}.json").read_text())


def status_of(engine, job_id):
    module, client, secret, *_ = engine
    return client.post(BIBLIOMETRIC, json={"action": "status", "jobId": job_id},
                       headers={"Authorization": f"Bearer {_token(secret)}"}).json()


def run_in_thread(engine, command):
    results = []
    thread = threading.Thread(target=lambda: results.append(engine[0].run_job(command[0][-1])))
    thread.start()
    return thread, results


def slot_directory(engine):
    return Path(os.environ["EVIMED_DATA_ROOT"]) / ".openscience" / "specialist-slots"


# ---------------------------------------------------------------------------

def test_a_job_over_the_cap_is_queued_with_a_reason_and_starts_by_itself(engine, monkeypatch):
    cap(monkeypatch)
    module, client, secret, workspace, release = engine
    first, first_command = start(engine, "hold")
    second, second_command = start(engine, "second")
    holder, held = run_in_thread(engine, first_command)
    assert wait_until(lambda: state_of(engine, first)["status"] == "running")
    waiter, waited = run_in_thread(engine, second_command)
    queued = wait_until(lambda: "slotWait" in state_of(engine, second) and state_of(engine, second))
    assert queued, "a waiting job says so in its own state"
    assert queued["status"] == "queued" and "startedAt" not in queued, "it has not started, and does not claim to have"
    assert queued["slotWait"]["limit"] == 1 and queued["slotWait"]["running"] == 1 and queued["slotWait"]["ahead"] == 0

    # What the runtime's polling gets back: the existing state vocabulary, and the reason.
    polled = status_of(engine, second)
    assert polled["status"] == "warning" and polled["data"]["jobStatus"] == "queued", polled
    assert polled["data"]["progress"] == {"stage": "Waiting for a free specialist slot: 1 of 1 running."}
    assert polled["summary"].startswith(f"Bibliometric analysis job {second} is queued.")
    assert "has not started" in polled["warnings"][0]
    assert 0 <= polled["data"]["secondsSinceUpdate"] <= 5, "a waiting job heartbeats, so it does not look hung"
    # And the first, which runs, is unaffected.
    assert status_of(engine, first)["data"]["jobStatus"] == "running" and "progress" not in status_of(engine, first)["data"]

    health = client.get("/health").json()
    assert health["specialistSlots"] == {"limit": 1, "running": 1, "waiting": 1, "waitSeconds": 10800}
    assert health["status"] == "ok" and health["serving"] is True

    release.touch()
    holder.join(30)
    waiter.join(30)
    assert held == [0] and waited == [0]
    done = state_of(engine, second)
    assert done["status"] == "succeeded" and "slotWait" not in done
    assert done["slotWaitedSeconds"] >= 0 and "slotWaitedSeconds" not in state_of(engine, first)
    assert status_of(engine, second)["status"] == "success"
    assert client.get("/health").json()["specialistSlots"]["running"] == 0
    assert "slot: acquired after" in (workspace / "bibliometric-analysis-runs/.jobs" / f"{second}.log").read_text()


def test_the_slot_is_released_when_the_engine_fails(engine, monkeypatch):
    cap(monkeypatch)
    first, first_command = start(engine, "fail")
    second, second_command = start(engine, "second")
    assert engine[0].run_job(first_command[0][-1]) == 1
    assert state_of(engine, first)["status"] == "failed"
    assert job_slots.snapshot()["running"] == 0, "a failed job holds nothing"
    assert engine[0].run_job(second_command[0][-1]) == 0
    assert state_of(engine, second)["status"] == "succeeded" and "slotWaitedSeconds" not in state_of(engine, second)


def test_without_a_cap_jobs_run_together_and_no_slot_file_exists(engine, monkeypatch):
    monkeypatch.delenv(job_slots.LIMIT_ENV, raising=False)
    first, first_command = start(engine, "hold")
    second, second_command = start(engine, "second")
    holder, _ = run_in_thread(engine, first_command)
    assert wait_until(lambda: state_of(engine, first)["status"] == "running")
    assert engine[0].run_job(second_command[0][-1]) == 0, "today's behavior: the second job does not wait for the first"
    assert state_of(engine, first)["status"] == "running" and state_of(engine, second)["status"] == "succeeded"
    assert not slot_directory(engine).parent.exists()
    health = engine[1].get("/health").json()
    assert health["specialistSlots"] == {"limit": 0, "running": 0, "waiting": 0}
    engine[4].touch()
    holder.join(30)


def test_a_job_that_waits_past_the_bound_ends_retryable_and_never_ran(engine, monkeypatch):
    cap(monkeypatch)
    monkeypatch.setenv(job_slots.WAIT_ENV, "1")
    module, client, secret, workspace, release = engine
    first, first_command = start(engine, "hold")
    second, second_command = start(engine, "second")
    holder, _ = run_in_thread(engine, first_command)
    assert wait_until(lambda: state_of(engine, first)["status"] == "running")
    assert module.run_job(second_command[0][-1]) == 1
    state = state_of(engine, second)
    assert state["status"] == "failed" and state["retryable"] is True
    assert state["errorCode"] == "specialist_worker_unavailable" and state["slotError"] == "slot_wait_expired"
    assert "within 1 seconds" in state["error"] and "this job did not start" in state["error"]
    assert "startedAt" not in state and "slotWait" not in state
    output = workspace / "bibliometric-analysis-runs" / second / "output"
    assert list(output.iterdir()) == [], "the engine never ran"
    polled = status_of(engine, second)
    assert polled["status"] == "error" and polled["error"]["code"] == "specialist_worker_unavailable"
    assert polled["error"]["retryable"] is True and "data" not in polled
    assert "again later" in polled["next_actions"][0], "the advice for capacity is to wait, not to inspect partial outputs"
    assert "artifacts" not in polled
    assert job_slots.snapshot()["waiting"] == 0, "a job that gave up no longer waits"
    release.touch()
    holder.join(30)


def test_an_unusable_slot_directory_fails_the_job_by_name_and_not_the_container(engine, monkeypatch):
    cap(monkeypatch)
    module, client, secret, workspace, _ = engine
    (Path(os.environ["EVIMED_DATA_ROOT"]) / ".openscience").write_text("not a directory")
    job, command = start(engine, "second")
    assert module.run_job(command[0][-1]) == 1
    state = state_of(engine, job)
    assert state["status"] == "failed" and state["retryable"] is True
    assert state["errorCode"] == "specialist_worker_unavailable" and state["slotError"] == "slot_directory_unavailable"
    health = client.get("/health").json()
    assert health["specialistSlots"]["error"] == "slot_directory_unavailable"
    assert health["status"] == "ok" and health["serving"] is True, "the container stays healthy; its web service must still start"


def test_a_status_poll_does_not_end_a_job_that_is_only_waiting(engine, monkeypatch):
    cap(monkeypatch)
    first, first_command = start(engine, "hold")
    second, second_command = start(engine, "second")
    holder, _ = run_in_thread(engine, first_command)
    assert wait_until(lambda: state_of(engine, first)["status"] == "running")
    waiter, _ = run_in_thread(engine, second_command)
    assert wait_until(lambda: "slotWait" in state_of(engine, second))
    for _ in range(5):
        assert status_of(engine, second)["data"]["jobStatus"] == "queued"
        time.sleep(0.05)
    engine[4].touch()
    holder.join(30)
    waiter.join(30)
    assert state_of(engine, second)["status"] == "succeeded"


def test_a_worker_process_that_is_killed_frees_its_slot(engine, monkeypatch, tmp_path):
    """The real worker, as a separate process: killed, it leaves nothing taken."""
    cap(monkeypatch)
    module, client, secret, workspace, release = engine
    first, (command, kwargs) = start(engine, "hold")
    scratch = tmp_path / "scratch"  # the killed worker cannot clean its stage: keep it inside the test's own tree
    scratch.mkdir()
    worker = subprocess.Popen(command, cwd=kwargs["cwd"], env={**kwargs["env"], "TMPDIR": str(scratch)},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        assert wait_until(lambda: job_slots.snapshot()["running"] == 1), "the worker took the slot"
        assert wait_until(lambda: state_of(engine, first)["status"] == "running"), "the slot comes first, then the job runs"
        os.killpg(worker.pid, signal.SIGKILL)  # the worker and its engine, as a container kill would
        worker.wait(10)
        assert job_slots.snapshot()["running"] == 0, "the kernel dropped the lock with the process"
        second, second_command = start(engine, "second")
        assert module.run_job(second_command[0][-1]) == 0
        assert "slotWaitedSeconds" not in state_of(engine, second), "the next job did not wait"
    finally:
        release.touch()


# ---------------------------------------------------------------------------
# MR keeps its own queue authority: the wait is before its claim.
# ---------------------------------------------------------------------------

def test_an_mr_job_over_the_cap_waits_queued_before_its_claim_and_keeps_its_authority(tmp_path, monkeypatch):
    from test_mr_inputs import queue_job, setup_mr, write_sources

    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    monkeypatch.setattr(job_slots, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(job_slots, "REPORT_SECONDS", 0.05)
    cap(monkeypatch)
    write_sources(workspace, "rs101")
    held = job_slots.acquire("another-engine-job-0001", "peer-review")  # an engine in another container is running
    state_path, job_id = queue_job(service, client, secret, monkeypatch)
    service._WORKERS[job_id] = _NeverStarts()
    admitted = service._read_state(state_path)
    outcome = []
    thread = threading.Thread(target=lambda: outcome.append(service.run_job(str(state_path))))
    thread.start()
    try:
        queued = wait_until(lambda: "slotWait" in (state := service._read_state(state_path)) and state)
        assert queued, "the waiting MR worker records its wait in the protected queue"
        assert queued["status"] == "queued" and "startedAt" not in queued, "claim() has not run: the queue still owns the job"
        for key in ("queueContext", "queueGeneration", "request", "sourceEvidence", "outputRoot", "mrInputBindings", "createdAt"):
            assert queued[key] == admitted[key], f"waiting changed accepted MR authority: {key}"
        polled = service._status({"jobId": job_id}, workspace)
        assert polled["data"]["jobStatus"] == "queued" and "Waiting for a free specialist slot" in polled["data"]["progress"]["stage"]
        assert 0 <= polled["data"]["secondsSinceUpdate"] <= 5
    finally:
        held.release()
        thread.join(30)
    assert outcome == [0]
    done = service._read_state(state_path)
    assert done["status"] == "succeeded" and "slotWait" not in done and done["slotWaitedSeconds"] >= 0
    assert done["queueContext"] == admitted["queueContext"] and done["request"] == admitted["request"]
    assert job_slots.snapshot()["running"] == 0


def test_an_mr_job_that_is_not_queued_does_not_wait_for_a_slot(tmp_path, monkeypatch):
    """A duplicate worker is refused by the claim at once; it never queues behind the cap."""
    from test_mr_inputs import queue_job, setup_mr, write_sources

    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    cap(monkeypatch)
    write_sources(workspace, "rs101")
    state_path, _ = queue_job(service, client, secret, monkeypatch)
    held = job_slots.acquire("another-engine-job-0001", "peer-review")
    try:
        with service._mr_store().claim(state_path) as claimed:
            assert claimed["status"] == "running"
            started = time.monotonic()
            assert service.run_job(str(state_path)) == 1
            assert time.monotonic() - started < 5, "refused by the claim, not left waiting for a slot"
    finally:
        held.release()


def test_every_engine_kind_reports_the_slot_counters(tmp_path, monkeypatch):
    cap(monkeypatch, "3")
    for kind, marker in (("peer-review", "src/main_v2.py"), ("drug-safety-analysis", "safety_agent/analysis/pipeline.py"),
                         ("research-topic-selection", "services/task_service.py")):
        module, client, _, _ = _load_service(tmp_path / kind, monkeypatch, kind=kind)
        agent = tmp_path / kind / "agent"
        (agent / marker).parent.mkdir(parents=True, exist_ok=True)
        (agent / marker).write_text("# marker\n")
        health = client.get("/health").json()
        assert health["specialistSlots"] == {"limit": 3, "running": 0, "waiting": 0, "waitSeconds": 10800}, kind
