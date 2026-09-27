"""A managed job's heartbeat, and what a poller reads from it.

A managed job's state used to change twice: when its worker started and when
it finished. On 2026-09-27 a research-topic job PubMed was throttling ran for
21 minutes; the run polling it saw `updatedAt` still at the start time after
15, recorded the job as dead and delivered a fallback six minutes before the
job succeeded. While the engine works, its worker now rewrites `updatedAt`
every HEARTBEAT_SECONDS, and a worker that dies stops doing so. The hosted
adapters (deploy/specialist-adapter and the MetaAgent adapter) keep the same
rule for the same fields.
"""

from __future__ import annotations

import json
import os
import stat
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

HEARTBEAT_SECONDS = 30.0
#: Where an engine that knows its own stage says so: `{"stage", "percent"}`.
PROGRESS_ENV = "EVIMED_JOB_PROGRESS_FILE"
PROGRESS_LIMIT = 4 * 1024
MANIFEST_LIMIT = 256 * 1024


def moment(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def seconds_since(value, now):
    parsed = moment(value)
    return None if parsed is None else max(0, int((now - parsed).total_seconds()))


def liveness(state):
    """What a poller needs to tell a slow job from a dead one."""
    now = datetime.now(timezone.utc)
    facts = {"updatedAt": state.get("updatedAt"), "heartbeatSeconds": int(HEARTBEAT_SECONDS)}
    for key, field in (("secondsSinceUpdate", "updatedAt"), ("elapsedSeconds", "createdAt")):
        seconds = seconds_since(state.get(field), now)
        if seconds is not None:
            facts[key] = seconds
    if isinstance(state.get("progress"), dict):
        facts["progress"] = state["progress"]
    return facts


def duration(state):
    """Seconds from the job's creation to its end, when both are recorded."""
    finished = moment(state.get("finishedAt"))
    return seconds_since(state.get("createdAt"), finished) if finished else None


def _bounded_json(path, limit):
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            return None
        value = json.loads(os.read(descriptor, limit + 1).decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    finally:
        os.close(descriptor)
    return value if isinstance(value, dict) else None


def engine_progress(path):
    """The engine's own `{"stage", "percent"}`, when it reports one; None otherwise."""
    value = _bounded_json(path, PROGRESS_LIMIT) if path is not None else None
    stage = (value or {}).get("stage")
    if not isinstance(stage, str) or not stage.strip() or len(stage) > 200 or not stage.isprintable():
        return None
    progress = {"stage": stage.strip()}
    if type(value.get("percent")) is int and 0 <= value["percent"] <= 100:
        progress["percent"] = value["percent"]
    return progress


def step_manifest_progress(output_root):
    """Where MetaAgent is, from the step manifest its pipeline keeps: the first
    step not yet complete, and the share of steps that are."""
    try:
        projects = sorted(
            (entry for entry in output_root.iterdir() if entry.is_dir() and not entry.is_symlink()),
            key=lambda entry: entry.stat().st_mtime_ns,
            reverse=True,
        )
    except OSError:
        return None
    for project in projects:
        # Written in place by the pipeline, so a read can meet half a file.
        manifest = _bounded_json(project / "step_manifest.json", MANIFEST_LIMIT)
        if manifest is None:
            continue
        steps, records = manifest.get("pipeline_steps"), manifest.get("steps")
        if (
            not isinstance(steps, list)
            or not steps
            or not all(isinstance(step, str) and step.isidentifier() for step in steps)
            or not isinstance(records, dict)
        ):
            return None
        done = [
            step for step in steps
            if isinstance(records.get(step), dict) and records[step].get("status") == "complete"
        ]
        pending = next((step for step in steps if step not in done), steps[-1])
        return {"stage": pending, "percent": int(100 * len(done) / len(steps))}
    return None


def _log_line(log_path, text):
    try:
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "ab", buffering=0) as log:
            log.write(("\n%s\n" % text).encode("utf-8"))
    except OSError:
        pass


@contextmanager
def heartbeat(state_path, state, *, read, write, log_path, progress=None):
    """Advance a running job's `updatedAt` while its engine works.

    The state keeps one writer at a time: the worker writes before this starts
    and after it has stopped, and a status poll writes only for a worker that
    is gone. Each beat still re-reads first and stops as soon as the state on
    disk is not this worker's running job, so a beat does not revive a job
    someone else has ended. A beat that cannot be written stops the
    heartbeat and says why in the job log; the engine goes on and the job ends
    as it would have.
    """
    stop = threading.Event()
    pid = os.getpid()

    def beat():
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                current = read(state_path)
                if current.get("status") != "running" or current.get("workerPid") != pid:
                    return
                state["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                elapsed = seconds_since(state.get("createdAt"), datetime.now(timezone.utc))
                if elapsed is not None:
                    state["elapsedSeconds"] = elapsed
                reported = progress() if progress is not None else None
                if reported is not None:
                    state["progress"] = reported
                write(state_path, state)
            except Exception as error:  # noqa: BLE001 — the engine keeps running; the log says why the state stopped advancing
                _log_line(log_path, "heartbeat stopped: %s: %s" % (type(error).__name__, error))
                return

    thread = threading.Thread(target=beat, name="evimed-job-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()
