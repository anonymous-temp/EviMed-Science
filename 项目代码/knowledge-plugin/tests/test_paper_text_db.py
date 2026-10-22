"""The paper text chain in the store (rt-papers, 2026-10-22): the 14-day horizon, the upgrade of a provisional text, and
``retext --kinds journal`` — against the scratch database, the chain itself scripted (its readers are tested on recorded
answers in ``tests/enrich``)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from knowledge_plugin import retext
from knowledge_plugin.model import EntryTextResult, NormalizedEntry, ParseOutput
from knowledge_plugin.store import schedule_text, text_row

from test_scheduler_db import T0, Clock, ScriptedAdapter, ScriptedFetcher, crawler_for, poll_now, seed, source

pytestmark = pytest.mark.db

TEASER = "This cross-sectional study uses US pharmacy data to examine national and county-level opioid dispensing."
ABSTRACT = "Importance: Opioid dispensing fell.\nObjective: To examine it.\nConclusions: It fell further."
STORED = ABSTRACT.replace("\n", "\n\n")              # paragraphs as the store keeps them (``clean_body``)


def papers(*keys):
    return [NormalizedEntry(external_key=f"10.1001/jama.2026.{k}", url=f"https://doi.org/10.1001/jama.2026.{k}",
                            title=f"Paper {k}", summary=None, published_at=T0 - timedelta(hours=6),
                            doi=f"10.1001/jama.2026.{k}") for k in keys]


async def rows_by_key(pool):
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            """SELECT e.entry_id, e.external_key, e.text_status, e.revision, e.seq, t.abstract, t.body_excerpt, t.text_kind,
                      t.fetched_from, t.next_attempt_at
                 FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)""")).fetchall()
    return {row["external_key"].rsplit(".", 1)[-1]: row for row in rows}


async def journal_crawler(settings, pool, clock, enricher, *keys):
    src = source("j-jama", source_type="journal")
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=papers(*keys))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"])
    crawler = crawler_for(settings, pool, clock, adapter, fetcher, enricher=enricher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        for row in (await rows_by_key(pool)).values():
            await schedule_text(conn, row["entry_id"], row["revision"], clock.now, reset=False)
    return crawler


async def test_a_provisional_text_answers_at_once_and_an_index_s_abstract_replaces_it(settings, pool):
    clock = Clock()
    asked: list[tuple[str, bool]] = []

    async def chain(job, fetcher_, settings_):
        key = job["external_key"].rsplit(".", 1)[-1]
        asked.append((key, bool(job.get("upgrade"))))
        if not job.get("upgrade"):     # the first pass: the journal's feed had a summary
            return EntryTextResult(status="available", text_kind="excerpt", body_excerpt=TEASER,
                                   fetched_from="publisher-feed", retry_after_s=12 * 3600)
        if key == "1" and clock.now >= T0 + timedelta(days=1, hours=12):     # PubMed indexed it on day two
            return EntryTextResult(status="available", text_kind="abstract", abstract=ABSTRACT, fetched_from="pubmed",
                                   notes=["upgraded"])
        return EntryTextResult(status="available", retry_after_s=12 * 3600, notes=["upgrade_not_yet"])

    crawler = await journal_crawler(settings, pool, clock, chain, "1", "2")
    await crawler._text_tick()                        # text_concurrency 2: both at once
    first = await rows_by_key(pool)
    for key in ("1", "2"):
        assert (first[key]["text_status"], first[key]["text_kind"], first[key]["body_excerpt"]) == ("available", "excerpt", TEASER)
        assert first[key]["next_attempt_at"] == clock.now + timedelta(hours=12)       # provisional: asked again

    clock.advance(hours=13)
    await crawler._text_tick()                        # nothing new yet: the teaser stays, nothing delivered again
    second = await rows_by_key(pool)
    assert second["1"]["revision"] == first["1"]["revision"] and second["1"]["body_excerpt"] == TEASER
    assert second["1"]["next_attempt_at"] == clock.now + timedelta(hours=12)

    clock.advance(days=1, hours=1)                    # day two: the abstract is in PubMed
    await crawler._text_tick()
    third = await rows_by_key(pool)
    assert (third["1"]["abstract"], third["1"]["text_kind"], third["1"]["fetched_from"]) == (STORED, "abstract", "pubmed")
    assert third["1"]["revision"] == first["1"]["revision"] + 1 and third["1"]["seq"] > first["1"]["seq"]
    assert third["1"]["next_attempt_at"] is None and third["1"]["text_status"] == "available"
    assert third["2"]["revision"] == first["2"]["revision"] and third["2"]["next_attempt_at"] is not None

    clock.advance(days=13)                            # past the horizon: the provisional text is final
    await crawler._text_tick()
    last = await rows_by_key(pool)
    assert last["2"]["next_attempt_at"] is None and last["2"]["body_excerpt"] == TEASER
    assert ("1", True) in asked and ("2", True) in asked and asked.count(("1", False)) == 1


async def test_retext_journal_reads_the_entries_left_without_text_and_delivers_what_it_finds(settings, pool, monkeypatch):
    clock = Clock()

    async def nothing(job, fetcher_, settings_):
        return EntryTextResult(status="pending", notes=["not_indexed_yet"])

    crawler = await journal_crawler(settings, pool, clock, nothing, "1", "2", "3")
    clock.advance(days=15)                            # past the horizon: answered unavailable without text
    for _ in range(3):                                # the worker takes text_concurrency (2) jobs a tick
        await crawler._text_tick()
    async with pool.connection() as conn:             # what GET /text marks; entry 3 got its abstract the old way
        await conn.execute("UPDATE evimed_knowledge.entries SET text_requested_at = %s", (T0,))
        row3 = (await rows_by_key(pool))["3"]
        await conn.execute("UPDATE evimed_knowledge.entry_texts SET abstract = 'An abstract.', text_kind = 'abstract', "
                           "fetched_at = %s WHERE entry_id = %s", (T0, row3["entry_id"]))
        await conn.execute("UPDATE evimed_knowledge.entries SET text_status = 'available' WHERE entry_id = %s",
                           (row3["entry_id"],))
    before = await rows_by_key(pool)
    assert before["1"]["text_status"] == before["2"]["text_status"] == "unavailable"

    since, cutoff = T0 - timedelta(days=1), clock.now
    report = await retext.report(_NoCollector(), pool, clock.now, ["journal"], since=since, before=cutoff)
    assert report["summary"]["candidates"] == 2 and report["summary"]["journal"] == 2

    seen: list[dict] = []

    async def chain(row, fetcher_, settings_, now=None):
        seen.append(row)
        if row["external_key"].endswith(".1"):
            return EntryTextResult(status="available", text_kind="abstract", abstract=ABSTRACT, fetched_from="landing")
        return EntryTextResult(status="unavailable", notes=["landing_challenge"])

    monkeypatch.setattr(retext, "enrich", chain)
    outcome = await retext.apply(_NoCollector(), pool, None, settings, lambda: clock.now, ["journal"], since=since,
                                 before=cutoff)
    assert outcome["summary"] == {"candidates": 2, "redelivered": 1, "same": 0, "kept": 1}
    assert all(row["attempts"] == 0 for row in seen)          # read as a first attempt: the landing page too
    after = await rows_by_key(pool)
    assert (after["1"]["text_status"], after["1"]["abstract"], after["1"]["fetched_from"]) == ("available", STORED, "landing")
    assert after["1"]["revision"] == before["1"]["revision"] + 1
    assert after["2"]["text_status"] == "unavailable" and after["2"]["revision"] == before["2"]["revision"]
    async with pool.connection() as conn:
        assert (await text_row(conn, after["3"]["entry_id"]))["abstract"] == "An abstract."      # never a candidate

    again = await retext.report(_NoCollector(), pool, clock.now, ["journal"], since=since, before=cutoff)
    assert again["summary"]["candidates"] == 1, "what was found is not read again; what was not is"


async def test_the_table_takes_every_source_the_contract_names(pool):
    from knowledge_plugin.model import FETCHED_FROM

    async with pool.connection() as conn:
        definition = (await (await conn.execute(
            """SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
                WHERE conrelid = 'evimed_knowledge.entry_texts'::regclass AND conname = 'entry_texts_fetched_from_check'"""
        )).fetchone())["d"]
    assert all(f"'{value}'" in definition for value in FETCHED_FROM)


class _NoCollector:
    class dajiala:
        configured = False

    async def wechat_text(self, row, now):
        raise AssertionError("no WeChat entry here")
