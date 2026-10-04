"""Every MetaAgent run has a wall clock, as every other engine's job does.

With one specialist slot a MetaAgent run that hangs held it until it died, and every
waiting job of every engine ended at the wait bound. The wall clock is the
deployment's one key (``EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS``, read by
``job_slots.execution_timeout()``, the module held byte-identical with the specialist
adapter's): when it runs out the engine is stopped, what it had written is kept
(principle 19), the job ends by a named code and the slot is released. A run that
had already written a readable manuscript is delivered as a partial completion, as
any process that ends early with one always was.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from new_meta import evimed_adapter
from new_meta.core import job_slots
from test_evimed_adapter import _post
from test_evimed_job_slots import meta, start, state_file  # noqa: F401  (the fixture and the helpers)


def hangs(ran, *, draft: bool):
    """A `subprocess.run` whose engine writes something and then never ends: it raises when the clock runs out."""
    def run(command, **kwargs):
        ran.append(kwargs)
        project = Path(command[command.index("--output-dir") + 1]) / "project"
        (project / "manuscript").mkdir(parents=True, exist_ok=True)
        (project / "package").mkdir(parents=True, exist_ok=True)
        if draft:
            (project / "manuscript" / "draft.md").write_text("# A readable synthesis\n\nEvidence so far.\n", encoding="utf-8")
        (project / "evidence.json").write_text("{}", encoding="utf-8")
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])
    return run


def test_the_engine_is_given_the_configured_wall_clock(meta, monkeypatch):
    client, workspace, _ = meta
    monkeypatch.setenv(job_slots.TIMEOUT_ENV, "7200")
    job_id = start(client)
    ran = []
    monkeypatch.setattr(evimed_adapter.subprocess, "run", hangs(ran, draft=False))
    evimed_adapter.run_job(str(state_file(workspace, job_id)))
    assert ran[0]["timeout"] == 7200.0


def test_a_run_that_hangs_ends_by_a_named_code_keeps_its_files_and_frees_the_slot(meta, monkeypatch):
    client, workspace, _ = meta
    monkeypatch.setenv(job_slots.TIMEOUT_ENV, "3600")
    job_id = start(client)
    monkeypatch.setattr(evimed_adapter.subprocess, "run", hangs([], draft=False))

    assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 124

    state = json.loads(state_file(workspace, job_id).read_text())
    assert state["status"] == "failed" and state["errorCode"] == "meta_agent_job_timeout"
    assert state["retryable"] is True and state["returnCode"] == 124
    assert "was stopped after 3600 seconds" in state["error"]
    polled = _post(client, {"action": "status", "jobId": job_id}).json()
    assert polled["status"] == "error" and polled["error"]["code"] == "meta_agent_job_timeout"
    assert polled["error"]["retryable"] is True
    assert "was stopped after 3600 seconds" in polled["error"]["message"]
    assert "resumes from the last completed step" in polled["error"]["message"]
    # What the engine wrote is where it was written; the job names it.
    assert (workspace / "meta-analysis-runs" / job_id / "output" / "project" / "evidence.json").is_file()
    assert job_slots.snapshot()["running"] == 0, "a job the clock stopped holds nothing"
    # The next request is a new job and is not kept waiting behind the one that hung.
    assert start(client) != job_id


def test_a_run_stopped_after_a_readable_manuscript_is_delivered_as_a_partial_completion(meta, monkeypatch):
    client, workspace, _ = meta
    job_id = start(client)
    monkeypatch.setattr(evimed_adapter.subprocess, "run", hangs([], draft=True))

    assert evimed_adapter.run_job(str(state_file(workspace, job_id))) == 0

    state = json.loads(state_file(workspace, job_id).read_text())
    assert state["status"] == "succeeded" and state["completion"] == "partial" and state["verification"] == "unverified"
    assert "meta_agent_job_timeout" in state["warningReasons"] and "partial_process_completion" in state["warningReasons"]
    assert "stopped at the deployment's execution limit" in state["releaseSummary"]
    assert "errorCode" not in state, "a delivered manuscript is not a failed job"
    assert job_slots.snapshot()["running"] == 0
