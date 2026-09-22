"""The crawl loop against a real database, with a scripted adapter, fetcher and clock."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from knowledge_plugin import policy
from knowledge_plugin.model import EntryTextResult, FetchError, FetchResult, NormalizedEntry, ParseOutput, RequestSpec, SourceConfig
from knowledge_plugin.registry import RegistryRow, sync_registry
from knowledge_plugin.scheduler import Crawler
from knowledge_plugin.store import schedule_text

pytestmark = pytest.mark.db

T0 = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **delta):
        self.now = self.now + timedelta(**delta)


class ScriptedAdapter:
    """``pages[url]`` is a ParseOutput, an exception, or a list consumed one per call."""

    def __init__(self, access="rss", pages=None):
        self.access = access
        self.pages = pages or {}
        self.states: list = []
        self.parsed: list[str] = []

    def plan(self, source, state, now):
        self.states.append(state)
        return [RequestSpec(url=source.config["url"], api=source.access != "rss")]

    def parse(self, result, source, now):
        self.parsed.append(result.request.url)
        value = self.pages[result.request.url]
        if isinstance(value, list):
            value = value.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class ScriptedFetcher:
    def __init__(self, clock):
        self.clock = clock
        self.responses: dict = {}
        self.calls: list[RequestSpec] = []
        self.extras: list[dict] = []

    def ok(self, url, body=b"<rss/>", headers=None, status=200):
        self.responses[url] = ("ok", body, headers or {}, status)

    async def fetch(self, spec, *, source_id=None, egress="direct", allowed_hosts=None, **extra):
        self.calls.append(spec)
        self.extras.append({"egress": egress, **extra})
        value = self.responses[spec.url]
        if isinstance(value, list):
            value = value.pop(0)
        if isinstance(value, FetchError):
            raise value
        if value == "304":
            return FetchResult(request=spec, final_url=spec.url, status=304, headers={}, body=b"", fetched_at=self.clock(), not_modified=True)
        _, body, headers, status = value
        return FetchResult(request=spec, final_url=spec.url, status=status, headers=headers, body=body, fetched_at=self.clock())


def source(sid="feed-a", access="rss", url=None, **overrides) -> SourceConfig:
    base = dict(id=sid, name=sid, homepage=None, lane="evidence", source_type="media", access=access, egress="direct",
                authority=3, safety_feed=False, owner_entity=sid, launch_tier="P0", language="en", region="US",
                poll_floor_s=3600, poll_ceiling_s=21600,
                config={"url": url or f"https://{sid}.example.org/feed", "max_pages": 3})
    base.update(overrides)
    return SourceConfig(**base)


def entries(*keys, age_days=1, now=T0):
    return [NormalizedEntry(external_key=k, url=f"https://x.example.org/{k}", title=f"Title {k}", summary="S" * 100,
                            published_at=now - timedelta(days=age_days)) for k in keys]


async def seed(pool, *sources: SourceConfig, now=T0):
    async with pool.connection() as conn:
        await sync_registry(conn, [RegistryRow(source=s, enabled=True, disabled_reason=None, category="test", sha256=f"{i:064x}")
                                   for i, s in enumerate(sources)], now)


async def state_of(pool, sid):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (sid,))).fetchone()


async def fetch_rows(pool, sid):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM evimed_knowledge.fetches WHERE source_id = %s ORDER BY id", (sid,))).fetchall()


def crawler_for(settings, pool, clock, adapter, fetcher, **kwargs):
    return Crawler(settings, pool, fetcher, adapters={adapter.access: adapter}, clock=clock,
                   enricher=kwargs.pop("enricher", None) or _no_enricher, **kwargs)


async def _no_enricher(job, fetcher, settings):
    return EntryTextResult(status="pending", notes=["test"])


async def poll_now(crawler):
    reports = await crawler.run_due()
    assert reports, "nothing was due"
    return reports


# ------------------------------------------------------------------ polls


async def test_first_poll_backfills_old_entries_and_records_everything(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("new1", "new2") + entries("old", age_days=40))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], headers={"etag": '"v1"', "last-modified": "Mon, 21 Sep 2026 10:00:00 GMT"})
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    [report] = await poll_now(crawler)
    assert (report.outcome, report.seen, report.new, report.backfilled) == ("ok", 3, 2, 1)
    row = await state_of(pool, src.id)
    assert row["first_contact_at"] == T0 and row["last_ok_at"] == T0 and row["last_new_entry_at"] == T0
    assert row["etag"] == '"v1"' and row["last_url"] == src.config["url"] and row["health"] == "healthy"
    assert row["lease_owner"] is None and row["next_poll_at"] >= T0 + timedelta(seconds=1800)
    [fetch] = await fetch_rows(pool, src.id)
    assert (fetch["outcome"], fetch["entries_seen"], fetch["entries_new"], fetch["http_status"]) == ("ok", 3, 3, 200)


async def test_validators_are_sent_back_and_304_is_not_parsed(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("a"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], headers={"etag": '"v1"'})
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    clock.advance(hours=3)
    fetcher.responses[src.config["url"]] = "304"
    [report] = await poll_now(crawler)
    assert report.outcome == "not-modified"
    assert fetcher.calls[-1].headers.get("If-None-Match") == '"v1"'
    assert adapter.parsed == [src.config["url"]]                     # parsed once only
    row = await state_of(pool, src.id)
    assert row["etag"] == '"v1"' and row["empty_polls"] == 1


async def test_an_unchanged_body_without_validators_is_not_parsed(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("a"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], body=b"<rss>same</rss>")
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    clock.advance(hours=3)
    [report] = await poll_now(crawler)
    assert report.outcome == "not-modified" and len(adapter.parsed) == 1


async def test_failures_back_off_and_become_unreadable_after_three_days(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter()
    fetcher = ScriptedFetcher(clock)
    fetcher.responses[src.config["url"]] = FetchError("http-error", "http_503", status=503)
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    [report] = await poll_now(crawler)
    assert (report.outcome, report.detail) == ("http-error", "http_503")
    row = await state_of(pool, src.id)
    assert row["consecutive_failures"] == 1 and row["failing_since"] == T0 and row["health"] == "degraded"
    assert row["next_poll_at"] == T0 + timedelta(seconds=policy.failure_delay_s(3600, 1))
    clock.advance(days=3, minutes=1)
    await poll_now(crawler)
    row = await state_of(pool, src.id)
    assert row["consecutive_failures"] == 2 and row["health"] == "unreadable"
    assert row["next_poll_at"] == clock.now + timedelta(seconds=policy.failure_delay_s(3600, 2))
    [first, second] = await fetch_rows(pool, src.id)
    assert first["outcome"] == second["outcome"] == "http-error" and first["error_detail"] == "http_503"


async def test_budget_refusals_are_not_the_sources_failure(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    fetcher = ScriptedFetcher(clock)
    fetcher.responses[src.config["url"]] = FetchError("host-budget", "daily_cap", retry_after_s=7200)
    crawler = crawler_for(settings, pool, clock, ScriptedAdapter(), fetcher)
    [report] = await poll_now(crawler)
    assert report.outcome == "host-budget"
    row = await state_of(pool, src.id)
    assert row["consecutive_failures"] == 0 and row["health"] == "new" and row["next_poll_at"] == T0 + timedelta(seconds=7200)
    assert (await fetch_rows(pool, src.id))[0]["outcome"] == "host-budget"


async def test_a_list_that_parses_to_nothing_twice_is_drifted(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    url = src.config["url"]
    adapter = ScriptedAdapter(pages={url: [ParseOutput(entries=entries("a")), ParseOutput(entries=[]), ParseOutput(entries=[])]})
    fetcher = ScriptedFetcher(clock)
    fetcher.responses[url] = [("ok", b"1", {}, 200), ("ok", b"2", {}, 200), ("ok", b"3", {}, 200)]
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    outcomes = []
    for _ in range(3):
        outcomes.append((await poll_now(crawler))[0].outcome)
        clock.advance(hours=7)
    assert outcomes == ["ok", "empty", "empty"]
    row = await state_of(pool, src.id)
    assert row["zero_streak"] == 2 and row["health"] == "drifted"


async def test_chains_are_followed_and_capped(settings, pool):
    clock = Clock()
    src = source(access="json-api", url="https://api.example.org/search")
    await seed(pool, src)
    step2 = "https://api.example.org/fetch?ids=1,2"
    adapter = ScriptedAdapter(access="json-api", pages={
        src.config["url"]: ParseOutput(entries=[], next=RequestSpec(url=step2, api=True)),
        step2: ParseOutput(entries=entries("p1", "p2")),
    })
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], body=b"{}")
    fetcher.ok(step2, body=b"<xml/>")
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    [report] = await poll_now(crawler)
    assert (report.outcome, report.requests, report.new) == ("ok", 2, 2)       # a chain step is not an empty page

    capped = source(sid="capped", access="json-api", url="https://api.example.org/capped")
    capped.config["max_pages"] = 1
    await seed(pool, src, capped)
    adapter.pages[capped.config["url"]] = ParseOutput(entries=entries("c1"), next=RequestSpec(url=step2, api=True))
    fetcher.ok(capped.config["url"], body=b"{}")
    reports = {r.source_id: r for r in await crawler.run_due()}
    assert reports["capped"].requests == 1 and reports["capped"].notes.get("max_pages_reached") == 1


async def test_a_short_retry_after_from_parse_is_retried_once(settings, pool):
    clock = Clock()
    src = source(access="europepmc", url="https://www.ebi.ac.uk/europepmc/x")
    await seed(pool, src)
    adapter = ScriptedAdapter(access="europepmc", pages={src.config["url"]: [
        FetchError("http-error", "europepmc_missing_hitcount", retry_after_s=0.01), ParseOutput(entries=entries("e1"))]})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], body=b"{}")
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    [report] = await poll_now(crawler)
    assert report.outcome == "ok" and report.new == 1 and report.notes.get("retried:europepmc_missing_hitcount") == 1


async def test_incremental_sources_rescan_their_full_window_daily(settings, pool):
    clock = Clock()
    src = source(access="json-api", url="https://api.example.org/window")
    src.config["incremental"] = True
    await seed(pool, src)
    adapter = ScriptedAdapter(access="json-api", pages={src.config["url"]: ParseOutput(entries=[])})
    fetcher = ScriptedFetcher(clock)
    fetcher.responses[src.config["url"]] = [("ok", f"{n}".encode(), {}, 200) for n in range(3)]
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(hours=1)
    await poll_now(crawler)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(hours=24)
    await poll_now(crawler)
    assert [s.last_ok_at for s in adapter.states] == [None, T0, None]          # first contact, incremental, daily full


async def test_claims_follow_priority_and_leases_hold(settings, pool):
    clock = Clock()
    media = source(sid="media-a")
    safety = source(sid="safety-a", safety_feed=True, source_type="regulator")
    await seed(pool, media, safety)
    crawler = crawler_for(settings, pool, clock, ScriptedAdapter(), ScriptedFetcher(clock))
    [first] = await crawler.claim(1)
    assert first["id"] == "safety-a" and first["lease_owner"] == "test-worker"
    [second] = await crawler.claim(5)
    assert second["id"] == "media-a"
    assert await crawler.claim(5) == []                                         # both leased
    clock.advance(minutes=11)                                                   # leases expire after 10 minutes
    assert {r["id"] for r in await crawler.claim(5)} == {"safety-a", "media-a"}


async def test_claims_spread_across_hosts(settings, pool):
    clock = Clock()
    same_host = [source(sid=f"journal-{n}", url=f"https://api.crossref.example/journals/{n}") for n in range(3)]
    other = source(sid="feed-b")
    await seed(pool, *same_host, other)
    crawler = crawler_for(settings, pool, clock, ScriptedAdapter(), ScriptedFetcher(clock))
    first = await crawler.claim(4)
    assert sorted(r["host"] for r in first) == ["api.crossref.example", "feed-b.example.org"]   # one per host
    assert await crawler.claim(4, busy_hosts=["api.crossref.example"]) == []   # a busy host waits its turn
    again = await crawler.claim(4)
    assert [r["host"] for r in again] == ["api.crossref.example"]


async def test_a_source_without_an_adapter_waits_without_failing(settings, pool):
    clock = Clock()
    src = source(access="atom")
    await seed(pool, src)
    crawler = crawler_for(settings, pool, clock, ScriptedAdapter(access="rss"), ScriptedFetcher(clock))
    [report] = await poll_now(crawler)
    assert (report.outcome, report.detail) == ("blocked", "adapter_unavailable")
    row = await state_of(pool, src.id)
    assert row["consecutive_failures"] == 0 and row["next_poll_at"] == T0 + timedelta(hours=1)


# ------------------------------------------------------------------ retention and texts


async def test_retention_purges_and_moves_the_watermark(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("a", "b", "c"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"])
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        seqs = [r["seq"] for r in await (await conn.execute("SELECT seq FROM evimed_knowledge.entries ORDER BY seq")).fetchall()]
        await conn.execute("UPDATE evimed_knowledge.entries SET delivered_at = %s WHERE seq = %s", (T0 - timedelta(days=31), seqs[0]))
        await conn.execute("UPDATE evimed_knowledge.entries SET delivered_at = %s, text_requested_at = %s WHERE seq = %s",
                           (T0 - timedelta(days=31), T0, seqs[1]))           # its text was asked for: 90 days
        await conn.execute("UPDATE evimed_knowledge.fetches SET fetched_at = %s", (T0 - timedelta(days=15),))
    done = await crawler.maintenance()
    assert done == {"fetches": 1, "entries": 1, "seen_keys": 0}
    async with pool.connection() as conn:
        left = [r["seq"] for r in await (await conn.execute("SELECT seq FROM evimed_knowledge.entries ORDER BY seq")).fetchall()]
        watermark = await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'purged_through_seq'")).fetchone()
        row = await (await conn.execute("SELECT entries_7d FROM evimed_knowledge.sources WHERE id = %s", (src.id,))).fetchone()
    assert left == seqs[1:] and watermark["value"] == seqs[0] and row["entries_7d"] == 2


async def test_text_worker_pending_then_available_then_horizon(settings, pool):
    clock = Clock()
    src = source()
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("a", "b"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"])
    answers = {"a": [EntryTextResult(status="pending", retry_after_s=60),
                     EntryTextResult(status="available", text_kind="abstract", abstract="The abstract.", fetched_from="pubmed")],
               "b": [EntryTextResult(status="pending", retry_after_s=3600)] * 3}

    async def enricher(job, fetcher_, settings_):
        assert job["source_access"] == "rss" and "attempts" in job
        return answers[job["external_key"]].pop(0)

    crawler = crawler_for(settings, pool, clock, adapter, fetcher, enricher=enricher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT entry_id, external_key, revision FROM evimed_knowledge.entries")).fetchall()
        for row in rows:
            await schedule_text(conn, row["entry_id"], row["revision"], clock.now, reset=False)
    await crawler._text_tick()
    status = await _text_statuses(pool)
    assert status == {"a": "pending", "b": "pending"}
    clock.advance(minutes=20)                                   # a asked to come back after 60 s (floor: 15 min)
    await crawler._text_tick()
    assert (await _text_statuses(pool))["a"] == "available"
    clock.advance(days=5, hours=1)                              # b is past the 5-day horizon
    await crawler._text_tick()
    assert (await _text_statuses(pool))["b"] == "unavailable"


async def _text_statuses(pool):
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT external_key, text_status FROM evimed_knowledge.entries")).fetchall()
    return {r["external_key"]: r["text_status"] for r in rows}


async def test_an_empty_html_shell_is_a_challenge_only_when_nothing_parses(settings, pool):
    """NHSA ships its list inside a <script> CDATA block: almost no visible text, yet the adapter reads
    it. Only a near-empty page that ALSO parses to nothing is a bot shell."""
    clock = Clock()
    shell_page = b"<html><head><script>var list = '<![CDATA[<li><a title=x href=/a>x</a></li>]]>';</script></head><body></body></html>"
    listed = source(sid="script-list")
    walled = source(sid="walled-list")
    await seed(pool, listed, walled)
    adapter = ScriptedAdapter(pages={listed.config["url"]: ParseOutput(entries=entries("s1", "s2")),
                                     walled.config["url"]: ParseOutput(entries=[])})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(listed.config["url"], body=shell_page, headers={"content-type": "text/html"})
    fetcher.ok(walled.config["url"], body=shell_page, headers={"content-type": "text/html"})
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    reports = {r.source_id: r for r in await crawler.run_due()}
    assert (reports["script-list"].outcome, reports["script-list"].new) == ("ok", 2)
    assert (reports["walled-list"].outcome, reports["walled-list"].detail) == ("challenge", "empty_shell")



async def test_a_deep_walk_runs_weekly_and_a_failed_one_at_most_daily(settings, pool):
    """STAR: the daily poll reads 3 pages; the weekly walk may read 160; a failed walk waits a day."""
    clock = Clock()
    src = source(sid="ratings", access="json-api", url="https://ratings.example.org/page/1")
    src.config.update({"max_pages": 3, "full_walk_every_s": 604800, "full_walk_max_pages": 8})
    await seed(pool, src)
    pages = {f"https://ratings.example.org/page/{n}": ParseOutput(
        entries=entries(f"r{n}"), next=RequestSpec(url=f"https://ratings.example.org/page/{n + 1}", api=True)) for n in range(1, 20)}
    adapter = ScriptedAdapter(access="json-api", pages=pages)
    fetcher = ScriptedFetcher(clock)
    for n in range(1, 20):
        fetcher.ok(f"https://ratings.example.org/page/{n}", body=f"{n}".encode())
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    [walk] = await poll_now(crawler)
    assert walk.requests == 8                                             # first contact: the full walk
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(days=1)
    for n in range(1, 20):                                                # new bodies, so nothing is "not modified"
        fetcher.ok(f"https://ratings.example.org/page/{n}", body=f"{n}-day2".encode())
    [daily] = await poll_now(crawler)
    assert daily.requests == 3                                            # the daily poll is capped
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(days=7)
    fetcher.responses["https://ratings.example.org/page/1"] = FetchError("http-error", "http_503", status=503)
    [failed_walk] = await poll_now(crawler)
    assert failed_walk.outcome == "http-error"
    row = await state_of(pool, "ratings")
    assert row["last_full_attempt_at"] == clock.now
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(hours=2)
    fetcher.ok("https://ratings.example.org/page/1", body=b"1-day9")
    [retry] = await poll_now(crawler)
    assert retry.requests == 3                                            # not another walk the same day


async def test_a_missing_exit_or_key_is_not_the_sources_failure(settings, pool):
    clock = Clock()
    relay_src = source(sid="relay-feed", egress="relay")
    keyed = source(sid="evimed-scan", access="json-api", url="https://www.evimed.com/api-evimed/medicine-api/ai-api/x")
    await seed(pool, relay_src, keyed)
    fetcher = ScriptedFetcher(clock)
    fetcher.responses[relay_src.config["url"]] = FetchError("blocked", "egress_unavailable")
    fetcher.responses[keyed.config["url"]] = FetchError("blocked", "evimed_api_key_unconfigured")
    crawler = Crawler(settings, pool, fetcher, adapters={"rss": ScriptedAdapter(), "json-api": ScriptedAdapter(access="json-api")},
                      clock=clock, enricher=_no_enricher)
    reports = {r.source_id: r for r in await crawler.run_due()}
    assert reports["relay-feed"].detail == "egress_unavailable" and reports["evimed-scan"].detail == "evimed_api_key_unconfigured"
    for sid in ("relay-feed", "evimed-scan"):
        row = await state_of(pool, sid)
        assert row["consecutive_failures"] == 0 and row["failing_since"] is None and row["health"] == "new"
        assert row["next_poll_at"] == T0 + timedelta(hours=1)
    assert [f["outcome"] for f in await fetch_rows(pool, "relay-feed")] == ["blocked"]


async def test_the_browser_exit_gets_the_list_selector(settings, pool):
    clock = Clock()
    src = source(sid="nmpa-like", access="rss", egress="browser")
    src.config["selectors"] = {"item": "ul.list li@title", "title": "a"}
    await seed(pool, src)
    adapter = ScriptedAdapter(pages={src.config["url"]: ParseOutput(entries=entries("b1"))})
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(src.config["url"], body=b"<html><body>" + b"x" * 400 + b"</body></html>", headers={"content-type": "text/html"})
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    assert fetcher.extras[-1] == {"egress": "browser", "wait_for": "ul.list li"}



async def test_a_plan_of_posts_to_one_url_is_never_short_cut(settings, pool):
    """20 ChiCTR queries are 20 POSTs to one URL: an unchanged first answer must not skip the rest."""
    clock = Clock()
    url = "https://api.example.org/search"
    src = source(sid="post-scan", access="json-api", url=url)
    await seed(pool, src)

    class TwoPosts(ScriptedAdapter):
        def plan(self, source_, state, now):
            self.states.append(state)
            return [RequestSpec(url=url, method="POST", body=f'{{"q": "{q}"}}'.encode(), conditional=False, api=True) for q in ("a", "b")]

        def parse(self, result, source_, now):
            self.parsed.append(result.request.body)
            return ParseOutput(entries=entries(result.request.body.decode()[8:9] + str(len(self.parsed))))

    adapter = TwoPosts(access="json-api")
    fetcher = ScriptedFetcher(clock)
    fetcher.ok(url, body=b'{"same": "answer"}')
    crawler = crawler_for(settings, pool, clock, adapter, fetcher)
    await poll_now(crawler)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at = %s", (clock.now,))
    clock.advance(hours=1)
    [second] = await poll_now(crawler)
    assert second.requests == 2 and len(adapter.parsed) == 4                 # both POSTs parsed on both polls
