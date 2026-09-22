"""Scheduling rules: spreading, adaptive cadence, backoff, health, drift, priority, full rescans."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from knowledge_plugin import policy

NOW = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)


def test_next_slot_keeps_a_fixed_phase_and_a_minimum_gap():
    interval = 10800
    slot = policy.next_slot("j-0028-4793", interval, NOW)
    assert slot >= NOW + timedelta(seconds=interval / 2)
    assert slot < NOW + timedelta(seconds=interval * 1.5 + 1)
    assert int(slot.timestamp()) % interval == policy.phase_of("j-0028-4793", interval)
    # polled at its slot, the next one is exactly one interval later
    assert policy.next_slot("j-0028-4793", interval, slot) == slot + timedelta(seconds=interval)


def test_journals_spread_over_the_window():
    interval = 10800
    phases = sorted(policy.phase_of(f"j-{n:04d}", interval) for n in range(154))
    buckets = {p // 1800 for p in phases}        # six half-hour buckets in three hours
    assert buckets == set(range(6))
    assert len(set(phases)) > 140


def test_adaptive_cadence():
    floor, ceiling = 3600, 21600
    interval, empty = 3600, 0
    for _ in range(2):
        interval, empty = policy.adapt_interval(interval, floor, ceiling, 0, empty)
    assert (interval, empty) == (3600, 2)
    interval, empty = policy.adapt_interval(interval, floor, ceiling, 0, empty)
    assert (interval, empty) == (5400, 0)                       # x1.5 after three empty polls
    for _ in range(30):
        interval, empty = policy.adapt_interval(interval, floor, ceiling, 0, empty)
    assert interval == ceiling                                  # never past the ceiling
    assert policy.adapt_interval(interval, floor, ceiling, 3, empty) == (floor, 0)   # new entries: back to the floor


def test_failure_backoff_doubles_and_caps_at_six_hours():
    assert [policy.failure_delay_s(1800, n) for n in (1, 2, 3, 4, 5, 9)] == [1800, 3600, 7200, 14400, 21600, 21600]
    assert policy.failure_delay_s(86400, 1) == 1800             # base is min(floor, 30 min)
    assert policy.failure_delay_s(300, 1) == 300


def test_health_states():
    kwargs = dict(enabled=True, last_ok_at=NOW, failing_since=None, now=NOW, success_rate_24h=1.0, drifted=False)
    assert policy.health_state(**kwargs) == "healthy"
    assert policy.health_state(**{**kwargs, "enabled": False}) == "disabled"
    assert policy.health_state(**{**kwargs, "last_ok_at": None}) == "new"
    assert policy.health_state(**{**kwargs, "last_ok_at": None, "failing_since": NOW}) == "degraded"
    assert policy.health_state(**{**kwargs, "success_rate_24h": 0.79}) == "degraded"
    assert policy.health_state(**{**kwargs, "failing_since": NOW - timedelta(days=3)}) == "unreadable"
    assert policy.health_state(**{**kwargs, "failing_since": NOW - timedelta(days=2, hours=23)}) != "unreadable"
    assert policy.health_state(**{**kwargs, "drifted": True}) == "drifted"


def test_drift_only_for_list_reads():
    assert policy.is_drifted("html-list", NOW, 2, False, 0)
    assert policy.is_drifted("rss", NOW, 0, True, 2)
    assert not policy.is_drifted("html-list", NOW, 1, False, 0)
    assert not policy.is_drifted("html-list", None, 5, False, 0)           # never had items: not a drift
    assert not policy.is_drifted("json-api", NOW, 9, True, 9)               # quiet windows are normal for APIs


def test_priority_order():
    assert policy.priority(safety_feed=True, source_type="media", access="rss") == 0
    assert policy.priority(safety_feed=False, source_type="regulator", access="html-list") == 0
    assert policy.priority(safety_feed=False, source_type="journal", access="crossref-issn") == 1
    assert policy.priority(safety_feed=False, source_type="evidence-body", access="json-api") == 1
    assert policy.priority(safety_feed=False, source_type="media", access="rss") == 2
    assert policy.priority(safety_feed=False, source_type="evidence-body", access="rss") == 3


def test_full_rescan_once_a_day_for_incremental_queries():
    assert policy.wants_full_rescan({"incremental": True}, None, NOW)
    assert not policy.wants_full_rescan({"incremental": True}, NOW - timedelta(hours=23), NOW)
    assert policy.wants_full_rescan({"incremental": True}, NOW - timedelta(hours=24), NOW)
    assert not policy.wants_full_rescan({}, None, NOW)



def test_full_walk_timing():
    config = {"full_walk_every_s": 604800}
    assert policy.wants_full_walk(config, None, None, NOW)
    assert not policy.wants_full_walk(config, NOW - timedelta(days=6), None, NOW)
    assert policy.wants_full_walk(config, NOW - timedelta(days=7), None, NOW)
    assert not policy.wants_full_walk(config, NOW - timedelta(days=8), NOW - timedelta(hours=23), NOW)   # failed today
    assert policy.wants_full_walk(config, NOW - timedelta(days=8), NOW - timedelta(hours=25), NOW)
    assert not policy.wants_full_walk({}, None, None, NOW)
