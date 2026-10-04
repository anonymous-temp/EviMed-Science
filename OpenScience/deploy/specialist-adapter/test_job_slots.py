"""The deployment-wide cap on specialist jobs: slots shared through flock-ed files.

The module is stdlib-only and is the same bytes in the Meta engine's image, so
what is proved here is proved for both. The behaviors that matter on a shared
host are the ones a real process can show: a holder that is killed leaves no
slot taken, a waiter that is killed blocks nobody, and no number of processes
can run more jobs than the cap.
"""
from __future__ import annotations

import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from evimed_specialist_adapter import job_slots

ADAPTER = Path(__file__).resolve().parent
#: Every acquisition in these tests is bounded: a test that waits forever is a hung suite.
FAST = {"poll": 0.01, "report_every": 0.05, "wait_seconds": 15.0}


def acquire(job, kind="x", **options):
    return job_slots.acquire(job, kind, **{**FAST, **options})


@pytest.fixture
def slots(tmp_path, monkeypatch):
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv(job_slots.LIMIT_ENV, "1")
    monkeypatch.delenv(job_slots.WAIT_ENV, raising=False)
    return tmp_path / ".openscience" / "specialist-slots"


def wait_until(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    return None


def child(code: str, *arguments: str) -> subprocess.Popen:
    """A separate process on the same slot directory, as another engine container would be."""
    script = f"import sys, time, json\nsys.path.insert(0, {str(ADAPTER)!r})\nfrom evimed_specialist_adapter import job_slots\n" + code
    return subprocess.Popen([sys.executable, "-c", script, *arguments], stdout=subprocess.PIPE, text=True, env=dict(os.environ))


# ---------------------------------------------------------------------------
# No cap: today's behavior, and not a file touched.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("setting", [None, "", "0", "-3", "one"])
def test_without_a_cap_nothing_is_touched(tmp_path, monkeypatch, setting):
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path))
    if setting is None:
        monkeypatch.delenv(job_slots.LIMIT_ENV, raising=False)
    else:
        monkeypatch.setenv(job_slots.LIMIT_ENV, setting)
    with acquire("bibliometric-0001", "bibliometric-analysis") as slot:
        assert slot.held is False and slot.waited == 0
    assert not (tmp_path / ".openscience").exists()
    report = job_slots.snapshot()
    assert report == {"limit": 0, "running": 0, "waiting": 0, **({"invalidSetting": setting} if setting in {"-3", "one"} else {})}


def test_a_capped_health_read_creates_nothing(slots, tmp_path):
    report = job_slots.snapshot()
    assert report == {"limit": 1, "running": 0, "waiting": 0, "waitSeconds": 10800}
    assert not (tmp_path / ".openscience").exists(), "the evidence adapter mounts the volume read-only; a health read must not need to write"


def test_the_wait_bound_setting_is_clamped_to_something_usable(monkeypatch):
    monkeypatch.delenv(job_slots.WAIT_ENV, raising=False)
    assert job_slots.wait_bound() == 10800
    for raw, expected in (("600", 600), ("1", 1), ("0", 10800), ("-5", 10800), ("soon", 10800), ("999999", 10800)):
        monkeypatch.setenv(job_slots.WAIT_ENV, raw)
        assert job_slots.wait_bound() == expected, raw


# ---------------------------------------------------------------------------
# Turns.
# ---------------------------------------------------------------------------

def test_a_second_job_waits_for_the_first_and_then_runs(slots):
    first = job_slots.acquire("mr-job-first-0001", "mendelian-randomization")
    assert first.held and first.waited == 0
    reports, granted = [], []

    def second():
        with acquire("review-job-0002", "peer-review", on_wait=reports.append) as slot:
            granted.append(slot.waited)

    thread = threading.Thread(target=second)
    thread.start()
    assert wait_until(lambda: reports), "a job that must wait says so as soon as it knows"
    assert reports[0]["limit"] == 1 and reports[0]["running"] == 1 and reports[0]["ahead"] == 0
    assert "1 of 1 running" in job_slots.describe(reports[0])
    assert not granted
    assert job_slots.snapshot()["running"] == 1 and job_slots.snapshot()["waiting"] == 1
    first.release()
    thread.join(10)
    assert granted and granted[0] > 0, "the second job ran after the first, and knows how long it waited"
    assert job_slots.snapshot()["running"] == 0 and job_slots.snapshot()["waiting"] == 0


def test_waiting_jobs_are_served_in_the_order_they_arrived(slots):
    holder = job_slots.acquire("job-holder-00000", "x")
    granted, threads = [], []

    def waiter(name):
        with acquire(name, "x"):
            granted.append(name)
            time.sleep(0.05)

    for index in range(3):
        name = f"job-waiter-{index:05d}"
        thread = threading.Thread(target=waiter, args=(name,))
        thread.start()
        threads.append(thread)
        assert wait_until(lambda n=index + 1: job_slots.snapshot()["waiting"] == n)
    holder.release()
    for thread in threads:
        thread.join(15)
    assert granted == [f"job-waiter-{index:05d}" for index in range(3)]


def test_a_cap_of_two_runs_two_at_once(slots, monkeypatch):
    monkeypatch.setenv(job_slots.LIMIT_ENV, "2")
    first = acquire("job-first-000001", "x")
    second = acquire("job-second-00002", "x")
    assert first.waited == 0 and second.waited == 0 and job_slots.snapshot()["running"] == 2
    with pytest.raises(job_slots.SlotsUnavailable) as refused:
        acquire("job-third-000003", "x", wait_seconds=0.2)
    assert refused.value.code == "slot_wait_expired"
    first.release()
    assert acquire("job-third-000004", "x").held
    second.release()


def test_a_lowered_limit_never_admits_beyond_what_already_runs(slots, monkeypatch):
    monkeypatch.setenv(job_slots.LIMIT_ENV, "3")
    held = [acquire(f"job-held-{index:06d}", "x") for index in range(3)]
    monkeypatch.setenv(job_slots.LIMIT_ENV, "2")
    for name in ("job-over-000001", "job-over-000002"):
        with pytest.raises(job_slots.SlotsUnavailable):
            acquire(name, "x", wait_seconds=0.15)
        if name.endswith("1"):
            held[0].release()  # three running became two: still at the new cap
    held[1].release()
    assert acquire("job-fits-000003", "x").held, "one running, cap two"


# ---------------------------------------------------------------------------
# Release: on success, on failure, on death.
# ---------------------------------------------------------------------------

def test_a_slot_is_released_when_the_job_ends_either_way(slots):
    with job_slots.acquire("job-done-0000001", "x"):
        assert job_slots.snapshot()["running"] == 1
    assert job_slots.snapshot()["running"] == 0 and not list(slots.glob("running-*"))
    with pytest.raises(RuntimeError):
        with job_slots.acquire("job-failing-00001", "x"):
            raise RuntimeError("the engine failed")
    assert job_slots.snapshot()["running"] == 0 and not list(slots.glob("running-*"))
    with pytest.raises(KeyboardInterrupt):
        with job_slots.acquire("job-stopped-00001", "x"):
            raise KeyboardInterrupt
    assert job_slots.snapshot()["running"] == 0
    after = acquire("job-next-00000001", "x")
    assert after.waited == 0
    after.release()
    after.release()  # idempotent
    # A Slot dropped without `with` must not starve the queue until its process exits.
    acquire("job-dropped-00001", "x")
    assert job_slots.snapshot()["running"] == 0


@pytest.mark.parametrize("how", [signal.SIGKILL, signal.SIGTERM])
def test_a_slot_is_released_when_its_holder_dies(slots, how):
    holder = child("slot = job_slots.acquire('job-doomed-00001', 'x')\nprint('held', flush=True)\ntime.sleep(60)\n")
    assert holder.stdout.readline().strip() == "held"
    assert job_slots.snapshot()["running"] == 1
    with pytest.raises(job_slots.SlotsUnavailable) as blocked:
        acquire("job-blocked-00002", "x", wait_seconds=0.2)
    assert blocked.value.code == "slot_wait_expired", "while the holder lives nobody else runs"
    os.kill(holder.pid, how)
    holder.wait(10)
    assert job_slots.snapshot()["running"] == 0, "the kernel dropped the lock with the process"
    with acquire("job-after-0000003", "x") as slot:
        assert slot.held
    assert not list(slots.glob("running-job-doomed*")), "the corpse was deleted by the pass that counted"


def test_a_job_that_dies_while_waiting_blocks_nobody(slots):
    holder = job_slots.acquire("job-holder-00000", "x")
    dying = child("slot = job_slots.acquire('job-dying-000001', 'x', poll=0.01)\n")
    assert wait_until(lambda: job_slots.snapshot()["waiting"] == 1)
    granted = []
    thread = threading.Thread(target=lambda: granted.append(acquire("job-behind-00002", "x")))
    thread.start()
    assert wait_until(lambda: job_slots.snapshot()["waiting"] == 2)
    os.kill(dying.pid, signal.SIGKILL)
    dying.wait(10)
    assert job_slots.snapshot()["waiting"] == 1, "a dead waiter is not counted"
    holder.release()
    thread.join(10)
    assert granted and granted[0].held, "the dead waiter was ahead in line and the line moved on"
    granted[0].release()


# ---------------------------------------------------------------------------
# Waiting is visible and bounded.
# ---------------------------------------------------------------------------

def test_the_wait_is_bounded_and_a_job_that_gave_up_is_no_longer_waiting(slots):
    holder = job_slots.acquire("job-holder-00000", "x")
    started = time.monotonic()
    with pytest.raises(job_slots.SlotsUnavailable) as expired:
        acquire("job-late-000001", "x", wait_seconds=0.3)
    assert expired.value.code == "slot_wait_expired"
    assert "did not start" in str(expired.value) and "1 of 1 in use" in str(expired.value)
    assert 0.25 <= time.monotonic() - started < 5
    assert job_slots.snapshot()["waiting"] == 0
    holder.release()


def test_a_job_can_abandon_its_wait(slots):
    holder = job_slots.acquire("job-holder-00000", "x")

    def stop(_info):
        raise job_slots.StopWaiting

    with pytest.raises(job_slots.StopWaiting):
        acquire("job-gone-0000001", "x", on_wait=stop)
    assert job_slots.snapshot()["waiting"] == 0
    holder.release()


def test_a_report_that_cannot_be_written_does_not_stop_the_wait(slots):
    holder = job_slots.acquire("job-holder-00000", "x")
    calls, granted = [], []

    def broken(info):
        calls.append(info)
        raise OSError("the state file cannot be written")

    thread = threading.Thread(target=lambda: granted.append(acquire("job-patient-0001", "x", on_wait=broken)))
    thread.start()
    assert wait_until(lambda: len(calls) >= 2), "reports keep coming at the report cadence"
    holder.release()
    thread.join(10)
    assert granted and granted[0].held
    granted[0].release()


# ---------------------------------------------------------------------------
# The directory.
# ---------------------------------------------------------------------------

def test_an_unusable_slot_directory_is_named_and_never_hangs(tmp_path, monkeypatch):
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv(job_slots.LIMIT_ENV, "1")
    (tmp_path / ".openscience").write_text("a file where the directory belongs")
    with pytest.raises(job_slots.SlotsUnavailable) as error:
        acquire("job-nowhere-00001", "x")
    assert error.value.code == "slot_directory_unavailable"
    assert str(tmp_path) not in str(error.value), "a message, never a path"
    assert job_slots.snapshot()["error"] == "slot_directory_unavailable"


def test_a_job_id_that_could_name_a_path_is_refused(slots):
    for bad in ("../escape", "a/b", "", "x" * 200):
        with pytest.raises(job_slots.SlotsUnavailable) as error:
            acquire(bad, "x")
        assert error.value.code == "slot_job_invalid"
    assert not [path for path in slots.parent.rglob("*") if path.name.startswith(("running-", "waiting-"))]


def test_the_slot_files_are_private_and_say_who_holds_them(slots):
    with job_slots.acquire("job-private-00001", "peer-review"):
        (path,) = slots.glob("running-*")
        assert stat.S_IMODE(slots.stat().st_mode) == 0o700
        assert stat.S_IMODE(path.stat().st_mode) == 0o600 and path.stat().st_nlink == 1
        record = json.loads(path.read_text())
        assert record["job"] == "job-private-00001" and record["kind"] == "peer-review" and record["pid"] == os.getpid()


# ---------------------------------------------------------------------------
# The property the whole mechanism is for.
# ---------------------------------------------------------------------------

def test_no_number_of_processes_runs_more_jobs_than_the_cap(slots, monkeypatch):
    monkeypatch.setenv(job_slots.LIMIT_ENV, "2")
    work = (
        "with job_slots.acquire(sys.argv[1], 'x', poll=0.005):\n"
        "    before = job_slots.snapshot()['running']\n"
        "    time.sleep(0.25)\n"
        "    print(json.dumps({'before': before, 'after': job_slots.snapshot()['running']}), flush=True)\n"
    )
    processes = [child(work, f"job-stress-{index:05d}") for index in range(8)]
    seen = []
    for process in processes:
        out, _ = process.communicate(timeout=60)
        assert process.returncode == 0
        seen.append(json.loads(out))
    assert len(seen) == 8
    assert max(max(item["before"], item["after"]) for item in seen) == 2, "the cap was reached, and never passed"
    assert job_slots.snapshot()["running"] == 0 and job_slots.snapshot()["waiting"] == 0


def test_the_meta_engines_copy_is_byte_identical():
    twin = ADAPTER.parents[2] / "项目代码/meta/new_meta/core/job_slots.py"
    assert twin.read_bytes() == (ADAPTER / "evimed_specialist_adapter/job_slots.py").read_bytes()
