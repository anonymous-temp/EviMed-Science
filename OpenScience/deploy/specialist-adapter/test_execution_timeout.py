"""Every engine job has a wall clock, and a hung engine no longer holds the only slot.

With ``OPEN_SCIENCE_SPECIALIST_MAX_CONCURRENT_JOBS=1`` a hung engine of any kind but
MR kept its slot until it died, and every waiting job ended at the wait bound; only
MR had a wall clock of its own (10800 s, a constant). Now the worker stops the
engine's process group when the clock runs out, publishes what the engine had
written (principle 19), ends the job by a named code and releases the slot.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from evimed_specialist_adapter import isolated_job, job_slots
from test_job_receipts import RUNNER, _complete, _setup

BIBLIOMETRIC = "/api/v1/evimed/bibliometric-analysis"
HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# The setting: one key, the name the managed-local executor already used.
# ---------------------------------------------------------------------------

def test_the_wall_clock_is_three_hours_bounded_to_the_control_planes_run_monitor(monkeypatch) -> None:
    monkeypatch.delenv(job_slots.TIMEOUT_ENV, raising=False)
    assert job_slots.TIMEOUT_ENV == "EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS"
    assert job_slots.execution_timeout() == 10800.0
    for raw, expected in [("", 10800.0), ("  ", 10800.0), ("2400", 2400.0), ("2400.5", 2400.5),
                          ("5", 60.0), ("0", 60.0), ("-3", 60.0), ("99999", 14400.0),
                          ("soon", 10800.0), ("nan", 10800.0), ("inf", 14400.0)]:
        monkeypatch.setenv(job_slots.TIMEOUT_ENV, raw)
        assert job_slots.execution_timeout() == expected, raw


def test_the_default_wait_plus_run_is_exactly_the_engine_credentials_lifetime() -> None:
    # The two defaults and the credential's TTL are held together here: raising
    # one without the others lets a job start with a model credential that has run out.
    assert job_slots.DEFAULT_WAIT_SECONDS + job_slots.DEFAULT_TIMEOUT_SECONDS == 21600
    compose = (HERE.parent / "web/docker-compose.yml").read_text(encoding="utf-8")
    assert compose.count("EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS: ${OPEN_SCIENCE_SPECIALIST_EXECUTION_TIMEOUT_SECONDS:-10800}") == 6


# ---------------------------------------------------------------------------
# The runner: the engine's whole process group is stopped, and nothing is left.
# ---------------------------------------------------------------------------

def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_a_hung_engine_and_what_it_spawned_are_stopped_when_the_clock_runs_out(tmp_path) -> None:
    pids = tmp_path / "pids"
    engine = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
        f"open({str(pids)!r}, 'w').write(f'{{os.getpid()}} {{child.pid}}')\n"
        "time.sleep(600)\n"
    )
    started = time.monotonic()
    with pytest.raises(isolated_job.ExecutionTimeout):
        isolated_job.run([sys.executable, "-c", engine], credentials={}, cwd=str(tmp_path), env=dict(os.environ),
                         log=subprocess.DEVNULL, timeout=1.0)
    assert time.monotonic() - started < 10, "the wait is bounded by the clock, not by the engine"
    engine_pid, child_pid = (int(value) for value in pids.read_text().split())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and (_alive(engine_pid) or _alive(child_pid)):
        time.sleep(0.05)
    assert not _alive(engine_pid) and not _alive(child_pid), "nothing the engine started outlives the job"


def test_an_engine_that_finishes_in_time_is_unaffected_and_no_clock_is_the_old_behaviour(tmp_path) -> None:
    ok = [sys.executable, "-c", "raise SystemExit(0)"]
    failing = [sys.executable, "-c", "raise SystemExit(7)"]
    for timeout in (30.0, None):
        assert isolated_job.run(ok, credentials={}, cwd=str(tmp_path), env=dict(os.environ), log=subprocess.DEVNULL,
                                timeout=timeout) == 0
        assert isolated_job.run(failing, credentials={}, cwd=str(tmp_path), env=dict(os.environ), log=subprocess.DEVNULL,
                                timeout=timeout) == 7


# ---------------------------------------------------------------------------
# The job: named code, partial files kept, slot released, the next job starts.
# ---------------------------------------------------------------------------

HANGS = RUNNER.replace(
    "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n",
    "import time\ntime.sleep(600)\n",
)


def _with_one_slot(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv(job_slots.LIMIT_ENV, "1")
    monkeypatch.setenv(job_slots.WAIT_ENV, "5")


def test_a_hung_engine_job_ends_by_a_named_code_with_its_partial_files_and_frees_the_slot(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    _with_one_slot(monkeypatch, tmp_path)
    (agent / "evimed_runner.py").write_text(HANGS, encoding="utf-8")
    monkeypatch.setattr(module.job_slots, "execution_timeout", lambda: 1.0)

    started = time.monotonic()
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch, BIBLIOMETRIC)

    assert time.monotonic() - started < 30
    assert code == 124
    assert status["status"] == "error" and status["error"]["code"] == "specialist_job_timeout"
    assert status["error"]["retryable"] is True
    assert "was stopped after 1 seconds" in status["error"]["message"]
    assert "Files it had already written are kept" in status["error"]["message"]
    # Principle 19: what the engine had written before it was stopped is published and named.
    assert any(row["path"].endswith("report.md") for row in status["artifacts"])
    assert any("partial" in warning.lower() for warning in status["warnings"])
    state = json.loads((workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text())
    assert state["status"] == "failed" and state["errorCode"] == "specialist_job_timeout" and state["returnCode"] == 124
    assert state["artifacts"] == status["artifacts"]
    assert (workspace / "bibliometric-analysis-runs" / job_id / "output" / "report.md").read_text().startswith("# Verified report")
    assert job_slots.snapshot()["running"] == 0, "the slot went with the worker"


def test_the_next_job_starts_at_once_after_a_timed_out_one(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    _with_one_slot(monkeypatch, tmp_path)
    monkeypatch.setenv(job_slots.WAIT_ENV, "2")  # a slot that was not freed would end the next job at this bound
    (agent / "evimed_runner.py").write_text(HANGS, encoding="utf-8")
    monkeypatch.setattr(module.job_slots, "execution_timeout", lambda: 1.0)
    _complete(module, client, secret, {"topic": "first"}, monkeypatch, BIBLIOMETRIC)

    (agent / "evimed_runner.py").write_text(RUNNER, encoding="utf-8")
    code, job_id, status = _complete(module, client, secret, {"topic": "second"}, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success", status
    state = json.loads((workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text())
    assert "slotWaitedSeconds" not in state, "a free slot on the first look is no wait at all"


def test_a_job_that_finishes_inside_its_clock_is_untouched(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace, _, _, _ = _setup(tmp_path, monkeypatch)
    monkeypatch.setattr(module.job_slots, "execution_timeout", lambda: 600.0)
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success", status
    state = json.loads((workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text())
    assert "errorCode" not in state


# ---------------------------------------------------------------------------
# MR: its own wall clock now reads the same key, and its code is a registered one.
# ---------------------------------------------------------------------------

def test_the_mr_engine_is_given_the_same_configured_bound() -> None:
    tree = ast.parse((HERE / "evimed_specialist_adapter/service.py").read_text(encoding="utf-8"))
    run = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "_run_isolated_mr")
    jobs = [call for call in ast.walk(run) if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
            and call.func.attr == "Job"]
    assert len(jobs) == 1
    timeout = next((keyword.value for keyword in jobs[0].keywords if keyword.arg == "timeout"), None)
    assert timeout is not None and ast.unparse(timeout) == "int(job_slots.execution_timeout())", (
        "MR's wall clock was a constant in the engine; one key bounds every engine")


def test_the_timeout_codes_are_registered_and_have_a_sentence() -> None:
    domain = HERE.parents[1] / "packages/domain/src/errorCodes.mjs"
    source = domain.read_text(encoding="utf-8")
    for code in ("specialist_job_timeout", "meta_agent_job_timeout", "mr_analysis_timeout"):
        assert f'"{code}",' in source, f"{code} is not in the registry's recoverable set"
        assert f"  {code}:\n" in source, f"{code} has no sentence for a reader"
