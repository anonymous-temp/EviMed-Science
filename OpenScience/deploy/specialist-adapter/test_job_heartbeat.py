"""A running job's state advances while its engine works, and stops when it ends.

On 2026-09-27 a research-topic job PubMed was throttling ran for 21 minutes.
Its state was written at start and at completion only, so the run polling it
saw `updatedAt` frozen at the start time after 15 minutes, recorded the job as
dead and delivered a fallback six minutes before the job succeeded.
"""
from __future__ import annotations

import json
import os
import stat
import threading
import time
from pathlib import Path

from test_mr_inputs import queue_job, setup_mr, write_sources
from test_service import _NeverStarts, _load_service, _token

BEAT = 0.1


def _waiting_runner(release: Path, *, progress: dict | None = None) -> str:
    """A fake engine that reports its stage, then works until released."""
    return (
        "import argparse,json,os,time\nfrom pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
        + (
            f"Path(os.environ['EVIMED_JOB_PROGRESS_FILE']).write_text({json.dumps(progress)!r})\n"
            if progress is not None
            else ""
        )
        + f"release=Path({str(release)!r});deadline=time.time()+30\n"
        "while not release.exists() and time.time()<deadline: time.sleep(0.02)\n"
        "out=Path(a.output_dir);(out/'report.md').write_text('# Report',encoding='utf-8')\n"
        "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n"
    )


def _wait_until(predicate, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return None


def _start_bibliometric(module, client, secret, workspace) -> tuple[str, Path]:
    original_popen = module.subprocess.Popen
    module.subprocess.Popen = lambda *args, **kwargs: _NeverStarts()
    try:
        job_id = client.post(
            "/api/v1/evimed/bibliometric-analysis",
            json={"action": "start", "topic": "heartbeat"},
            headers={"Authorization": f"Bearer {_token(secret)}"},
        ).json()["data"]["jobId"]
    finally:
        module.subprocess.Popen = original_popen
    return job_id, workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json"


def _running_state(state_path: Path) -> dict | None:
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return state if state.get("status") == "running" else None


def test_a_running_job_advances_while_its_engine_works(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_HEARTBEAT_SECONDS", BEAT)
    release = tmp_path / "release"
    (Path(os.environ["EVIMED_AGENT_ROOT"]) / "evimed_runner.py").write_text(
        _waiting_runner(release, progress={"stage": "多源并行检索", "percent": 10}), encoding="utf-8"
    )
    job_id, state_path = _start_bibliometric(module, client, secret, workspace)
    outcome: list[int] = []
    worker = threading.Thread(target=lambda: outcome.append(module.run_job(str(state_path))))
    worker.start()
    try:
        first = _wait_until(lambda: _running_state(state_path))
        assert first is not None, "the worker never started"
        advanced = _wait_until(
            lambda: (state := _running_state(state_path))
            and state["updatedAt"] != first["updatedAt"]
            and state.get("progress")
            and state
        )
        assert advanced is not None, "updatedAt stayed at the worker's start while the engine worked"
        assert advanced["progress"] == {"stage": "多源并行检索", "percent": 10}
        assert isinstance(advanced["elapsedSeconds"], int)
        polled = client.post(
            "/api/v1/evimed/bibliometric-analysis",
            json={"action": "status", "jobId": job_id},
            headers={"Authorization": f"Bearer {_token(secret)}"},
        ).json()
    finally:
        release.touch()
        worker.join(30)
    assert outcome == [0]

    data = polled["data"]
    assert data["jobStatus"] == "running"
    assert "heartbeatSeconds" in data
    assert 0 <= data["secondsSinceUpdate"] <= 5
    assert 0 <= data["elapsedSeconds"] <= 30
    assert data["progress"] == {"stage": "多源并行检索", "percent": 10}

    # Ended is ended: no beat after the terminal write, no progress file left.
    terminal = json.loads(state_path.read_text(encoding="utf-8"))
    time.sleep(BEAT * 4)
    assert json.loads(state_path.read_text(encoding="utf-8")) == terminal
    assert terminal["status"] == "succeeded"
    assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    assert not state_path.with_name(f"{job_id}.progress.json").exists()
    assert not list(state_path.parent.glob(".*.tmp"))
    finished = client.post(
        "/api/v1/evimed/bibliometric-analysis",
        json={"action": "status", "jobId": job_id},
        headers={"Authorization": f"Bearer {_token(secret)}"},
    ).json()
    assert finished["status"] == "success"
    assert isinstance(finished["data"]["elapsedSeconds"], int)


def test_a_beat_never_revives_a_job_someone_else_ended(tmp_path, monkeypatch) -> None:
    """The status handler fails a job whose worker it cannot see; a beat must not undo that."""
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "_HEARTBEAT_SECONDS", BEAT)
    release = tmp_path / "release"
    (Path(os.environ["EVIMED_AGENT_ROOT"]) / "evimed_runner.py").write_text(
        _waiting_runner(release), encoding="utf-8"
    )
    _, state_path = _start_bibliometric(module, client, secret, workspace)
    worker = threading.Thread(target=module.run_job, args=(str(state_path),))
    worker.start()
    try:
        running = _wait_until(lambda: _running_state(state_path))
        assert running is not None
        module._atomic_json(state_path, {**running, "status": "failed", "error": "worker not found"})
        time.sleep(BEAT * 5)
        assert json.loads(state_path.read_text(encoding="utf-8"))["status"] == "failed"
    finally:
        release.touch()
        worker.join(30)
    log = state_path.with_suffix(".log").read_text(encoding="utf-8")
    assert "heartbeat stopped" not in log, "a job someone else ended is not a heartbeat failure"


def test_a_running_mr_job_advances_under_the_protected_store(tmp_path, monkeypatch) -> None:
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    monkeypatch.setattr(service, "_HEARTBEAT_SECONDS", BEAT)
    write_sources(workspace, "rs101")
    release = tmp_path / "release"
    runner = tmp_path / "agent" / "evimed_runner.py"
    body = runner.read_text()
    runner.write_text(body.replace(
        "out=Path(a.output_dir);",
        f"import time\nrelease=Path({str(release)!r});deadline=time.time()+30\n"
        "while not release.exists() and time.time()<deadline: time.sleep(0.02)\n"
        "out=Path(a.output_dir);",
        1,
    ))
    state_path, job_id = queue_job(service, client, secret, monkeypatch)
    # The start stored a stand-in worker without poll(); the status handler
    # has to see a live one while run_job runs in this process.
    service._WORKERS[job_id] = _NeverStarts()
    store = service._mr_store()
    outcome: list[int] = []
    worker = threading.Thread(target=lambda: outcome.append(service.run_job(str(state_path))))
    worker.start()
    try:
        first = _wait_until(lambda: (state := store.read(state_path))["status"] == "running" and state)
        assert first is not None
        advanced = _wait_until(
            lambda: (state := store.read(state_path))["updatedAt"] != first["updatedAt"] and state
        )
        assert advanced is not None, "the MR job's state stayed at its start while the engine worked"
        polled = service._status({"jobId": job_id}, workspace)
        info = state_path.stat()
        assert stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
    finally:
        release.touch()
        worker.join(30)
    assert outcome == [0]
    assert polled["data"]["jobStatus"] == "running"
    assert 0 <= polled["data"]["secondsSinceUpdate"] <= 5
    for key in ("queueContext", "queueGeneration", "request", "sourceEvidence", "outputRoot"):
        assert advanced[key] == first[key], f"a beat changed accepted MR authority: {key}"
    terminal = store.read(state_path)
    assert terminal["status"] == "succeeded"
    time.sleep(BEAT * 4)
    assert store.read(state_path) == terminal
    assert "heartbeat stopped" not in (state_path.with_suffix(".log").read_text() if state_path.with_suffix(".log").exists() else "")
