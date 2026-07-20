from __future__ import annotations

import asyncio

import pytest

from start import PipelineSlotLimiter


@pytest.mark.asyncio
async def test_pipeline_slot_limiter_reports_queue_position_and_started_status() -> None:
    limiter = PipelineSlotLimiter(max_sessions=1)
    events: list[dict] = []

    first = await limiter.acquire("phase1", status_cb=events.append)

    second_task = asyncio.create_task(limiter.acquire("phase2", status_cb=events.append))
    await asyncio.sleep(0)

    assert second_task.done() is False
    queued = events[-1]
    assert queued["type"] == "service_busy"
    assert queued["stage"] == "phase2"
    assert queued["status"] == "queued"
    assert queued["queue_position"] == 1
    assert queued["max_sessions"] == 1
    assert queued["running_sessions"] == 1
    assert queued["queued_sessions"] == 1
    assert queued["eta_seconds"] is None
    assert "排队" in queued["message"]

    await limiter.release(first)
    second = await asyncio.wait_for(second_task, timeout=1)

    started = events[-1]
    assert started["type"] == "service_busy"
    assert started["stage"] == "phase2"
    assert started["status"] == "started"
    assert started["queue_position"] == 0
    assert started["running_sessions"] == 1
    assert started["queued_sessions"] == 0
    assert "继续执行" in started["message"]

    await limiter.release(second)

