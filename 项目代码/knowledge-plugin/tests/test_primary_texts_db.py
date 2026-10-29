"""A top journal's research paper in the store (c3-primary, 2026-10-25): the twenty-one days, the daily cadence, the claim
order, and the sweep that asks again what the fourteen-day rule gave up on — against the scratch database."""

from __future__ import annotations

from datetime import timedelta

import pytest

from knowledge_plugin import text_policy
from knowledge_plugin.enrich import apply_text_rule
from knowledge_plugin.model import EntryTextResult, NormalizedEntry, ParseOutput
from knowledge_plugin.store import claim_texts, reopen_top_journal_texts, schedule_text, text_deadline, text_row

from test_scheduler_db import T0, Clock, ScriptedAdapter, ScriptedFetcher, crawler_for, poll_now, seed, source

pytestmark = pytest.mark.db


def papers(prefix, *keys):
    return [NormalizedEntry(external_key=f"10.1056/{prefix}{k}", url=f"https://doi.org/10.1056/{prefix}{k}", title=f"Paper {prefix}{k}",
                            summary=None, published_at=T0 - timedelta(hours=6), doi=f"10.1056/{prefix}{k}") for k in keys]


async def two_journals(settings, pool, clock, enricher):
    CLOCK["now"] = lambda: clock.now
    top = source("j-top", source_type="journal", authority=5)
    low = source("j-low", source_type="journal", authority=2)
    await seed(pool, low, top)
    adapter = ScriptedAdapter(pages={top.config["url"]: ParseOutput(entries=papers("top", "1")),
                                     low.config["url"]: ParseOutput(entries=papers("low", "1"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(top.config["url"])
    fetcher.ok(low.config["url"])
    crawler = crawler_for(settings, pool, clock, adapter, fetcher, enricher=enricher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT entry_id, revision, source_id FROM evimed_knowledge.entries")).fetchall()
        for row in rows:
            await schedule_text(conn, row["entry_id"], row["revision"], clock.now, reset=False)
    return crawler


async def statuses(pool):
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            """SELECT e.source_id, e.text_status, t.next_attempt_at, t.attempts, t.last_error
                 FROM evimed_knowledge.entries e JOIN evimed_knowledge.entry_texts t USING (entry_id)""")).fetchall()
    return {row["source_id"]: row for row in rows}


CLOCK = {}


async def nothing(job, fetcher_, settings_):
    """What the chain answers for a paper no index has an abstract for, the text rule applied as ``enrich_batch`` applies it."""
    answer = EntryTextResult(status="pending", retry_after_s=12 * 3600, notes=["indexed_without_abstract"])
    return apply_text_rule(job, answer, CLOCK["now"]())


async def test_the_deadline_of_a_top_journal_paper_is_twenty_one_days_the_others_fourteen(settings, pool):
    clock = Clock()
    await two_journals(settings, pool, clock, nothing)
    async with pool.connection() as conn:
        jobs = await claim_texts(conn, 10, clock.now, 600)
    by_source = {job["source_id"]: job for job in jobs}
    assert by_source["j-top"]["source_authority"] == 5 and by_source["j-low"]["source_authority"] == 2
    assert text_deadline(by_source["j-top"], clock.now) - by_source["j-top"]["first_seen_at"] == timedelta(days=21)
    assert text_deadline(by_source["j-low"], clock.now) - by_source["j-low"]["first_seen_at"] == timedelta(days=14)


async def test_the_top_journals_entry_is_claimed_first_though_it_is_not_the_oldest_due(settings, pool):
    clock = Clock()
    await two_journals(settings, pool, clock, nothing)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.entry_texts t SET next_attempt_at = %s FROM evimed_knowledge.entries e "
                           "WHERE e.entry_id = t.entry_id AND e.source_id = 'j-low'", (clock.now - timedelta(hours=5),))
        await conn.execute("UPDATE evimed_knowledge.entry_texts t SET next_attempt_at = %s FROM evimed_knowledge.entries e "
                           "WHERE e.entry_id = t.entry_id AND e.source_id = 'j-top'", (clock.now - timedelta(minutes=5),))
        (first,) = await claim_texts(conn, 1, clock.now, 600)
    assert first["source_id"] == "j-top"


async def test_at_day_fifteen_the_top_journal_paper_is_still_pending_and_asked_daily_the_other_is_given_up(settings, pool):
    clock = Clock()
    crawler = await two_journals(settings, pool, clock, nothing)
    clock.advance(days=15)
    for _ in range(3):
        await crawler._text_tick()
    got = await statuses(pool)
    assert got["j-low"]["text_status"] == "unavailable" and "text_horizon_passed" in got["j-low"]["last_error"]
    assert got["j-top"]["text_status"] == "pending"
    assert got["j-top"]["next_attempt_at"] - clock.now == timedelta(days=1)          # a day, not the twelve-hour cap
    clock.advance(days=7)
    for _ in range(3):
        await crawler._text_tick()
    assert (await statuses(pool))["j-top"]["text_status"] == "unavailable"


async def test_the_sweep_asks_again_what_the_fourteen_day_rule_gave_up_on_once(settings, pool):
    clock = Clock()
    crawler = await two_journals(settings, pool, clock, nothing)
    async with pool.connection() as conn:
        # as production holds them: ended by the old rule at fourteen days, ten and twenty-three days after first sight
        await conn.execute("UPDATE evimed_knowledge.entries SET text_status = 'unavailable', first_seen_at = %s", (clock.now - timedelta(days=16),))
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET last_error = 'indexed_without_abstract,text_horizon_passed', "
                           "next_attempt_at = NULL, attempts = 13")
        reopened = await reopen_top_journal_texts(conn, clock.now)
    assert reopened == 1                                               # the top journal's only
    got = await statuses(pool)
    assert got["j-top"]["text_status"] == "pending" and got["j-top"]["next_attempt_at"] == clock.now
    assert got["j-low"]["text_status"] == "unavailable"
    async with pool.connection() as conn:
        assert await reopen_top_journal_texts(conn, clock.now) == 0     # nothing left to take
    await crawler._text_tick()
    got = await statuses(pool)
    assert got["j-top"]["text_status"] == "pending" and "text_horizon_passed" not in (got["j-top"]["last_error"] or "")
    async with pool.connection() as conn:                               # an entry past the longer horizon, or PubMed-typed, or final, is not taken
        await conn.execute("UPDATE evimed_knowledge.entries SET text_status = 'unavailable', first_seen_at = %s", (clock.now - timedelta(days=23),))
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET last_error = 'text_horizon_passed'")
        assert await reopen_top_journal_texts(conn, clock.now) == 0
        await conn.execute("UPDATE evimed_knowledge.entries SET first_seen_at = %s", (clock.now - timedelta(days=16),))
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET enrichment = '{\"publication_types\": [\"Editorial\"]}'")
        assert await reopen_top_journal_texts(conn, clock.now) == 0
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET enrichment = '{}', last_error = 'pubmed_record_complete,text_horizon_passed'")
        assert await reopen_top_journal_texts(conn, clock.now) == 0
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET last_error = 'text_horizon_passed', abstract = 'An abstract.'")
        assert await reopen_top_journal_texts(conn, clock.now) == 0


def test_the_policy_names_the_minimum_authority_the_sql_uses():
    assert text_policy.MIN_AUTHORITY == 4
