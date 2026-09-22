"""Per-host buckets: spacing, daily caps (persisted), pauses, bounded waits, key-dependent rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from knowledge_plugin.budget import HostBudget, HostRule, MemoryCounterStore, PgCounterStore, host_rules
from knowledge_plugin.model import FetchError

NOW = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)


class FakeTime:
    def __init__(self):
        self.mono = 1000.0
        self.slept: list[float] = []

    def monotonic(self):
        return self.mono

    async def sleep(self, seconds):
        self.slept.append(seconds)
        self.mono += seconds


def budget_with(rules, time: FakeTime, store=None, **kwargs):
    return HostBudget(store or MemoryCounterStore(), rules, clock=lambda: NOW, monotonic=time.monotonic,
                      sleep=time.sleep, **kwargs)


async def test_spacing_between_request_starts():
    time = FakeTime()
    budget = budget_with({"api.crossref.org": HostRule(1.2, 3000)}, time)
    for _ in range(3):
        async with budget.slot("api.crossref.org"):
            pass
    assert time.slept == [pytest.approx(1.2), pytest.approx(1.2)]


async def test_daily_cap_refuses_with_time_to_midnight():
    time = FakeTime()
    budget = budget_with({"api.fda.gov": HostRule(0.0, 2)}, time)
    for _ in range(2):
        async with budget.slot("api.fda.gov"):
            pass
    with pytest.raises(FetchError) as refused:
        async with budget.slot("api.fda.gov"):
            pass
    assert refused.value.outcome == "host-budget" and refused.value.detail == "daily_cap"
    assert refused.value.retry_after_s == pytest.approx(16 * 3600)


async def test_pause_refuses_the_whole_host():
    time = FakeTime()
    store = MemoryCounterStore()
    budget = budget_with({}, time, store=store)
    await budget.pause("www.example.org", 120, "http_429")
    with pytest.raises(FetchError) as refused:
        async with budget.slot("www.example.org"):
            pass
    assert refused.value.detail == "host_paused" and refused.value.retry_after_s == pytest.approx(120)
    assert "www.example.org" in store.pauses          # persisted, so a restart keeps it
    fresh = budget_with({}, time, store=store)
    await fresh.load()
    assert fresh.paused_until("www.example.org") is not None


async def test_long_wait_is_refused_as_host_busy():
    time = FakeTime()
    budget = budget_with({"slow.example.org": HostRule(0.0, None)}, time, max_wait_s=60)
    budget.observe_crawl_delay("slow.example.org", 600)
    async with budget.slot("slow.example.org"):
        pass
    with pytest.raises(FetchError) as refused:
        async with budget.slot("slow.example.org"):
            pass
    assert refused.value.detail == "host_busy" and refused.value.retry_after_s > 60


def test_rules_follow_the_optional_keys():
    anonymous = host_rules(ncbi_key=False, openfda_key=False)
    keyed = host_rules(ncbi_key=True, openfda_key=True)
    assert anonymous["eutils.ncbi.nlm.nih.gov"].min_interval_s == 0.4 and keyed["eutils.ncbi.nlm.nih.gov"].min_interval_s == 0.15
    assert anonymous["api.fda.gov"].daily_cap == 300 and keyed["api.fda.gov"].daily_cap == 800
    assert anonymous["api.crossref.org"] == HostRule(1.2, 3000)
    assert anonymous["api.medrxiv.org"].timeout_s == 30.0


@pytest.mark.db
async def test_daily_counts_are_persisted(pool):
    store = PgCounterStore(pool)
    day = NOW.date()
    assert await store.reserve("api.fda.gov", day, 2)
    assert await store.reserve("api.fda.gov", day, 2)
    assert not await store.reserve("api.fda.gov", day, 2)
    assert (await PgCounterStore(pool).counts(day))["api.fda.gov"] == 2      # a new instance sees the spend
    assert await store.reserve("api.fda.gov", day + timedelta(days=1), 2)    # a new UTC day starts at zero
    await store.pause("api.crossref.org", datetime.now(timezone.utc) + timedelta(minutes=5), "http_429")
    assert "api.crossref.org" in await PgCounterStore(pool).load_pauses()


async def test_robots_fetches_do_not_take_the_crawl_delay_slot():
    """Crawl-delay 3600: the hourly robots.txt refresh must not spend the one hourly page slot."""
    time = FakeTime()
    budget = budget_with({"blog.example.org": HostRule(1.5, None)}, time)
    async with budget.slot("blog.example.org", robots=True):          # robots.txt first
        pass
    budget.observe_crawl_delay("blog.example.org", 3600)
    async with budget.slot("blog.example.org"):                        # the page: base spacing only
        pass
    assert time.slept == [pytest.approx(1.5)]
    time.mono += 3600 - 10                                             # an hour later, robots refreshes first
    async with budget.slot("blog.example.org", robots=True):
        pass
    time.mono += 10
    async with budget.slot("blog.example.org"):                        # and the page still gets its slot
        pass
    with pytest.raises(FetchError) as refused:                         # a second page within the hour waits
        async with budget.slot("blog.example.org"):
            pass
    assert refused.value.detail == "host_busy"
