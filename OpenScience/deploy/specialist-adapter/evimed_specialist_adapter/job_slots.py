"""One cap on the specialist jobs that run at once, across every engine container.

Why. The production host is shared with other products. An engine container may
use up to 2 GB while a job runs and there are six of them, so six jobs at once
do not fit. Engines idle at 20-45 MB, which means nothing needs stopping: jobs
only need to take turns.

How. Every engine container mounts the same data volume, so the cap lives
there as ``flock``-ed files and needs no service of its own:

    <EVIMED_DATA_ROOT>/.openscience/specialist-slots/
        admission.lock                 a mutex held for milliseconds while a job
                                       registers, takes a slot or is counted
        waiting-<job>-<pid>.lock       held from the moment a job starts waiting
                                       until it has a slot or gives up
        running-<job>-<pid>.lock       held for as long as the job holds a slot

A lock is an advisory ``flock`` on an open file. The kernel drops it when its
holder exits, however it exits (finished, failed, cancelled, killed, the
container gone), so a dead worker can never leave a slot taken: its file is
simply unheld, and the next job that counts deletes it. Nothing here needs a
cleanup pass to be correct.

The directory is under ``.openscience``, which no tenant runtime mounts, so a
runtime can neither see the files nor hold a slot. All engine containers run as
the same user (root, no capabilities), which is what lets them open each
other's lock files.

Order is first come, first served: a job takes a slot only when fewer than the
limit are running and no live waiter registered before it. A job that dies while
waiting stops being ahead of anyone the moment it is gone.

A slot belongs to the worker process. Workers stop their engine's process group
on every exit they get to handle; an engine whose worker alone was SIGKILLed
would outlive its slot, and the container's own memory and pid limits bound
that case.

The limit is ``EVIMED_SPECIALIST_MAX_CONCURRENT_JOBS`` (the deployment's
``OPEN_SCIENCE_SPECIALIST_MAX_CONCURRENT_JOBS``); ``0`` or unset is no cap and
touches nothing. A job waits at most ``EVIMED_SPECIALIST_SLOT_WAIT_SECONDS``
(default 10800): with the three-hour limit an MR analysis already runs under,
wait plus run fits inside the six-hour lifetime of the engine's model credential
that was issued when the job was admitted.

This file is held byte-identical with ``项目代码/meta/new_meta/core/job_slots.py``
(the Meta engine ships in its own image and cannot import the adapter), the
way ``engine_model.py`` is; keep it to the standard library.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

LIMIT_ENV = "EVIMED_SPECIALIST_MAX_CONCURRENT_JOBS"
WAIT_ENV = "EVIMED_SPECIALIST_SLOT_WAIT_SECONDS"
DEFAULT_WAIT_SECONDS = 10800.0
MAX_WAIT_SECONDS = 86400.0
#: How often a waiting job looks again, and how often it tells its record it is
#: still waiting (the same cadence a running job's heartbeat uses, so a poller
#: reads a waiting job as alive for the same reason it reads a running one so).
POLL_SECONDS = 1.0
REPORT_SECONDS = 30.0
RUNNING = "running-"
WAITING = "waiting-"
_JOB = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


class SlotsUnavailable(RuntimeError):
    """The cap could not be applied to this job: the wait ran out or the directory is unusable.

    ``code`` is stable for callers and logs; the message is for a reader and
    names no path.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class StopWaiting(Exception):
    """Raised by an ``on_wait`` callback: this job no longer needs a slot (someone else ended it)."""


def configured_limit() -> tuple[int, str | None]:
    """The cap and, when the setting is not a whole number of at least 0, the text that was wrongly set.

    A setting nobody can parse means no cap, and says so: a limit that quietly
    does nothing is the failure this deployment keeps meeting.
    """
    raw = os.getenv(LIMIT_ENV, "").strip()
    if not raw:
        return 0, None
    try:
        value = int(raw)
    except ValueError:
        return 0, raw[:64]
    return (value, None) if value >= 0 else (0, raw[:64])


def limit() -> int:
    return configured_limit()[0]


def wait_bound() -> float:
    """Seconds a job may wait for a slot before it ends as retryable."""
    raw = os.getenv(WAIT_ENV, "").strip()
    try:
        value = float(raw) if raw else DEFAULT_WAIT_SECONDS
    except ValueError:
        return DEFAULT_WAIT_SECONDS
    return value if 1 <= value <= MAX_WAIT_SECONDS else DEFAULT_WAIT_SECONDS


def directory() -> Path:
    return Path(os.getenv("EVIMED_DATA_ROOT", "/data")) / ".openscience" / "specialist-slots"


def _unavailable(message: str = "The specialist slot directory is unavailable.") -> SlotsUnavailable:
    return SlotsUnavailable("slot_directory_unavailable", message)


def _ensure(path: Path) -> str:
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        info = os.lstat(path)
    except OSError:
        raise _unavailable() from None
    if not stat.S_ISDIR(info.st_mode):  # a file or a link where the directory belongs
        raise _unavailable()
    return str(path)


@contextmanager
def _admission(location: str, timeout: float = 10.0) -> Iterator[None]:
    """The mutex every registration, slot grant and counting pass runs under."""
    try:
        descriptor = os.open(os.path.join(location, "admission.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise _unavailable() from None
    try:
        _lock(descriptor, timeout, "The specialist slot directory is busy.")
        yield
    finally:
        os.close(descriptor)


def _lock(descriptor: int, timeout: float, busy: str) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise _unavailable(busy) from None
            time.sleep(0.005)
        except OSError:
            raise _unavailable() from None


def _taken(descriptor: int) -> int:
    """When the holder registered, from what it wrote; the file's own time when that is unreadable."""
    try:
        return int(json.loads(os.pread(descriptor, 512, 0))["since"])
    except (OSError, ValueError, KeyError, TypeError):
        try:
            return os.fstat(descriptor).st_mtime_ns
        except OSError:
            return 0


def _live(location: str, prefix: str, *, purge: bool) -> list[tuple[int, str]]:
    """The lock files with this prefix that someone holds, oldest first.

    A file nobody holds belongs to a process that is gone. Counting passes that
    run under the admission mutex delete such files; a read-only pass (the health
    counters) only ignores them.
    """
    try:
        names = sorted(os.listdir(location))
    except FileNotFoundError:
        return []
    except OSError:  # a file where the directory belongs, a permission: /health must say so, not raise
        raise _unavailable() from None
    live = []
    for name in names:
        if not (name.startswith(prefix) and name.endswith(".lock")):
            continue
        path = os.path.join(location, name)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            continue
        except OSError:
            raise _unavailable() from None
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                live.append((_taken(descriptor), name))
            else:
                if purge:
                    try:
                        os.unlink(path)
                    except FileNotFoundError:
                        pass
        finally:
            os.close(descriptor)
    return sorted(live)


class _Registration:
    def __init__(self, path: str, descriptor: int):
        self.path = path
        self.name = os.path.basename(path)
        self._descriptor: int | None = descriptor

    def release(self) -> None:
        """Unlink first, so counts drop the moment the slot is free, then close, which drops the lock."""
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is None:
            return
        try:
            os.unlink(self.path)
        except OSError:
            pass
        try:
            os.close(descriptor)
        except OSError:
            pass


def _register(location: str, prefix: str, job_id: str, kind: str) -> _Registration:
    if not _JOB.fullmatch(job_id):
        raise SlotsUnavailable("slot_job_invalid", "The job id cannot name a specialist slot.")
    path = os.path.join(location, f"{prefix}{job_id}-{os.getpid()}.lock")
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise _unavailable() from None
    try:
        # A health probe may hold a shared lock on the new file for an instant.
        _lock(descriptor, 2.0, "The specialist slot directory is busy.")
        os.write(descriptor, json.dumps(
            {"job": job_id, "kind": kind, "pid": os.getpid(), "since": time.time_ns()}).encode("utf-8"))
    except BaseException:
        try:
            os.unlink(path)
        except OSError:
            pass
        os.close(descriptor)
        raise
    return _Registration(path, descriptor)


class Slot:
    """What a job holds while it runs.

    ``with`` releases it; so does ``release()``, and the kernel does if the
    process dies first. ``Slot()`` holds nothing: what an unlimited deployment
    hands every job, so the caller has one code path.
    """

    def __init__(self, registration: _Registration | None = None, waited: float = 0.0):
        self._registration = registration
        #: Seconds this job waited for the slot; 0 when one was free at once.
        self.waited = waited

    @property
    def held(self) -> bool:
        return self._registration is not None

    def release(self) -> None:
        registration, self._registration = self._registration, None
        if registration is not None:
            registration.release()

    def __enter__(self) -> "Slot":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()

    def __del__(self) -> None:
        # Insurance, not the mechanism: a Slot dropped without `with` must not
        # hold one of the deployment's few slots until its process exits.
        try:
            self.release()
        except Exception:  # noqa: BLE001 — a finalizer must not raise
            pass


def describe(info: dict[str, Any]) -> str:
    """One line for a poller on why a job has not started."""
    text = f"Waiting for a free specialist slot: {info['running']} of {info['limit']} running"
    return text + (f", {info['ahead']} queued ahead." if info["ahead"] else ".")


def stage_of(wait: Any) -> str | None:
    """The line for a persisted ``slotWait``, or None when there is none or it is not one.

    A job's state is read back from disk, so what it says about a wait is
    checked before it is shown to a poller.
    """
    if not isinstance(wait, dict) or any(type(wait.get(key)) is not int or wait[key] < 0 for key in ("limit", "running", "ahead")):
        return None
    return describe(wait)


def acquire(
    job_id: str,
    kind: str,
    *,
    on_wait: Callable[[dict[str, Any]], None] | None = None,
    wait_seconds: float | None = None,
    poll: float | None = None,
    report_every: float | None = None,
) -> Slot:
    """A slot for this job, waiting its turn for one; ``Slot()`` at once when there is no cap.

    While the job waits, ``on_wait`` is called as soon as it knows it must wait
    and then every ``report_every`` seconds with ``{"limit", "running",
    "waiting", "ahead", "waited"}``. It may raise `StopWaiting` to abandon the
    wait; any other error it raises is ignored, because a record that cannot be
    written must not stop a queue. Raises `SlotsUnavailable` when the wait runs
    out (``slot_wait_expired``) or the directory cannot be used.
    """
    cap = limit()
    if cap == 0:
        return Slot()
    bound = wait_bound() if wait_seconds is None else wait_seconds
    interval = POLL_SECONDS if poll is None else poll
    cadence = REPORT_SECONDS if report_every is None else report_every
    location = _ensure(directory())
    started = time.monotonic()
    registered: _Registration | None = None
    last_report: float | None = None
    attempts = 0
    try:
        while True:
            with _admission(location):
                attempts += 1
                running = _live(location, RUNNING, purge=True)
                queue = _live(location, WAITING, purge=True)
                if registered is None:
                    registered = _register(location, WAITING, job_id, kind)
                    queue = _live(location, WAITING, purge=False)
                ahead = [name for _, name in queue].index(registered.name)
                if len(running) < cap and ahead == 0:
                    slot = _register(location, RUNNING, job_id, kind)
                    registered.release()
                    registered = None
                    # A free slot on the first look is no wait at all: 0, not the milliseconds it took.
                    return Slot(slot, waited=0.0 if attempts == 1 else time.monotonic() - started)
                info = {"limit": cap, "running": len(running), "waiting": len(queue), "ahead": ahead,
                        "waited": time.monotonic() - started}
            if info["waited"] >= bound:
                raise SlotsUnavailable(
                    "slot_wait_expired",
                    f"No specialist slot became free within {int(bound)} seconds "
                    f"({info['running']} of {cap} in use, {info['waiting']} job(s) waiting); this job did not start.")
            if on_wait is not None and (last_report is None or time.monotonic() - last_report >= cadence):
                last_report = time.monotonic()
                try:
                    on_wait(info)
                except StopWaiting:
                    raise
                except Exception:  # noqa: BLE001 — a record that cannot be written must not stop the queue
                    pass
            time.sleep(max(0.0, min(interval, bound - info["waited"])))
    finally:
        if registered is not None:  # gave up, expired, was superseded or crashed: no longer waiting
            registered.release()


def snapshot() -> dict[str, Any]:
    """What /health reports: the cap, and how many jobs hold a slot or wait for one, deployment-wide.

    Read-only: it creates nothing (the evidence adapter mounts the volume
    read-only and has no jobs) and deletes nothing. With no cap nothing is
    counted. A setting that was not a number is echoed, not silently ignored.
    """
    cap, invalid = configured_limit()
    report: dict[str, Any] = {"limit": cap, "running": 0, "waiting": 0}
    if invalid is not None:
        report["invalidSetting"] = invalid
    if cap == 0:
        return report
    report["waitSeconds"] = int(wait_bound())
    try:
        location = str(directory())
        report["running"] = len(_live(location, RUNNING, purge=False))
        report["waiting"] = len(_live(location, WAITING, purge=False))
    except SlotsUnavailable as error:
        report["error"] = error.code
    return report
