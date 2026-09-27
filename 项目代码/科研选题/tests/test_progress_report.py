"""The runner publishes the task's phase for the adapter polling it from outside.

On 2026-09-27 a job PubMed was throttling spent 21 minutes in retrieval. The
phase existed only in this process's memory, so the run polling the job saw
nothing move and recorded a live job as dead.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

import evimed_runner
from models.schemas import TaskStatus


class _Service:
    """Moves one task through two phases, then fails without a report."""

    def __init__(self, target, seen):
        self.target, self.seen = target, seen

    async def create_task(self, direction, context):
        self.task = SimpleNamespace(task_id="task-1", current_phase=None, progress_percentage=0)
        return self.task

    async def process_task(self, task_id):
        for phase, percent in (("多源并行检索", 0), ("执行模块:\nM3_evidence", 40)):
            self.task.current_phase, self.task.progress_percentage = phase, percent
            await asyncio.sleep(0.1)
            if self.target is not None:
                self.seen.append(json.loads(self.target.read_text(encoding="utf-8")))
        return SimpleNamespace(status=TaskStatus.FAILED, report=None, error_message="", blueprint=None)


def test_the_task_phase_is_published_while_the_job_runs(tmp_path, monkeypatch):
    target = tmp_path / "topic-1.progress.json"
    monkeypatch.setenv(evimed_runner.PROGRESS_ENV, str(target))
    monkeypatch.setattr(evimed_runner, "PROGRESS_INTERVAL_SECONDS", 0.01)
    seen = []

    with pytest.raises(RuntimeError, match="did not complete"):
        asyncio.run(evimed_runner._analyze_with_service(
            {"researchDirection": "Dialysis adherence"}, tmp_path, _Service(target, seen)))

    assert seen == [
        {"stage": "多源并行检索", "percent": 0},
        {"stage": "执行模块: M3_evidence", "percent": 40},
    ]
    assert [path.name for path in tmp_path.iterdir()] == [target.name], "no temporary file is left behind"


def test_without_an_adapter_nothing_is_written(tmp_path, monkeypatch):
    monkeypatch.delenv(evimed_runner.PROGRESS_ENV, raising=False)
    monkeypatch.setattr(evimed_runner, "PROGRESS_INTERVAL_SECONDS", 0.01)

    with pytest.raises(RuntimeError, match="did not complete"):
        asyncio.run(evimed_runner._analyze_with_service(
            {"researchDirection": "Dialysis adherence"}, tmp_path, _Service(None, [])))

    assert list(tmp_path.iterdir()) == []
