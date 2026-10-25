"""X's line of source discovery (c2-gplug 2026-10-25, review G7): a quoted account is validated by one SocialData user
lookup and one page of its posts (at most 20 accounts a day, inside the day's spend cap), then goes on the ordinary trial.

SocialData is faked: no test reaches it and no key file holds a real key. The answers have the shapes of the live ones
(``tools/verify_x_accounts.py``, 2026-10-22: ``id_str``, ``screen_name``, ``protected``, ``followers_count``; a search answers
``tweets`` with ``tweet_created_at`` and the author's ``user.id_str``; an unknown handle answers 404)."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from knowledge_plugin.discovery import Candidate, run_discovery, upsert_candidates
from knowledge_plugin.registry import parse_registry
from knowledge_plugin.social import x_discovery as xd
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher

NOW = datetime(2026, 10, 25, 6, 0, tzinfo=timezone.utc)
DAY = "2026-10-25"
USER = "https://api.socialdata.tools/twitter/user/"
SEARCH = "https://api.socialdata.tools/twitter/search"


# ------------------------------------------------------------------------------------ pure


def test_the_candidate_key_names_a_handle_or_nothing():
    assert xd.handle_of({"key": "x:jco_asco"}) == "jco_asco"
    assert xd.handle_of({"key": "x:@WHO"}) == "WHO"
    for key in ("x:Jae Myung Lee", "x:", "x:" + "a" * 16, "wechat:医学界", "https://example.org/"):
        assert xd.handle_of({"key": key}) is None, key


def test_the_trial_row_is_an_ordinary_x_row_read_hourly_in_a_shared_shard():
    user = {"id_str": "1255526396807561217", "screen_name": "US_FDA", "name": "FDA", "verified_type": "Government"}
    row = xd.trial_row(user, "US_FDA", [{"lang": "und"}, {"lang": "en"}, {"lang": "en"}], "social")
    parsed = parse_registry({"sources": [row]})[0].source
    assert parsed.access == "socialdata" and parsed.egress == "api" and parsed.id.startswith("discovered-x-")
    assert parsed.config == {"url": "https://x.com/US_FDA", "handle": "US_FDA", "user_id": "1255526396807561217",
                             "mode": "signal", "role": "organisation"}
    assert (parsed.poll_floor_s, parsed.poll_ceiling_s, parsed.language) == (3600, 7200, "en")
    person = xd.trial_row({"id_str": "7", "screen_name": "somedoctor", "name": "A. Doctor"}, "somedoctor", [{"lang": "zh"}], "social")
    assert person["config"]["role"] == "person" and person["language"] == "zh" and person["name"] == "A. Doctor（X @somedoctor）"


# ------------------------------------------------------------------------------------ the line, end to end

ACCOUNTS = {   # handle -> (user answer or None, the account's own posts: (id, days ago, retweet))
    "newdoc": ({"id_str": "9001", "screen_name": "newdoc", "name": "New Doc", "followers_count": 4200, "protected": False},
               [(9101, 2, False), (9102, 9, False)]),
    "quietdoc": ({"id_str": "9002", "screen_name": "quietdoc", "name": "Quiet Doc", "protected": False}, [(9201, 45, False)]),
    "retweeter": ({"id_str": "9003", "screen_name": "retweeter", "name": "Retweeter", "protected": False}, [(9301, 1, True)]),
    "privatedoc": ({"id_str": "9004", "screen_name": "privatedoc", "name": "Private", "protected": True}, []),
    "ghost": (None, []),
    "renamed": ({"id_str": "9006", "screen_name": "another_name", "name": "Renamed", "protected": False}, []),
    "olddoc": ({"id_str": "1255526396807561217", "screen_name": "olddoc", "name": "Old Doc", "protected": False}, [(9701, 1, False)]),
}


def tweet(user, tweet_id, days, retweet):
    body = {"id_str": str(tweet_id), "tweet_created_at": (NOW - timedelta(days=days)).isoformat().replace("+00:00", "Z"),
            "full_text": "A post.", "lang": "en", "user": {"id_str": user["id_str"], "screen_name": user["screen_name"]}}
    if retweet:
        body["retweeted_status"] = {"id_str": "1"}
    return body


def socialdata(status=None):
    """SocialData: ``/twitter/user/<handle>`` and ``/twitter/search?query=from:<handle> …`` answered from ``ACCOUNTS``."""
    asked = []

    def on_user(spec):
        handle = unquote(urlsplit(spec.url).path.rsplit("/", 1)[1])
        asked.append(("user", handle))
        if status:
            return status, {"status": "error"}
        user = ACCOUNTS.get(handle, (None, []))[0]
        return (200, user) if user else (404, {"status": "error", "message": "Not found"})

    def on_search(spec):
        query = parse_qs(urlsplit(spec.url).query)["query"][0]
        handle = query.split("from:", 1)[1].split(" ", 1)[0]
        asked.append(("search", query))
        user, posts = ACCOUNTS[handle]
        return 200, {"tweets": [tweet(user, *post) for post in posts], "next_cursor": None}

    return FakeFetcher({("GET", USER): on_user, ("GET", SEARCH): on_search}), asked


def x_listed_row(handle, user_id):
    return {"id": f"x-{handle.lower()}", "name": handle, "homepage": f"https://x.com/{handle}", "lane": "mixed",
            "source_type": "media", "access": "socialdata", "egress": "api", "authority": 3, "safety_feed": False,
            "owner_entity": handle, "launch_tier": "P1", "language": "en", "poll_floor_s": 3600, "poll_ceiling_s": 7200,
            "enabled": True, "config": {"url": f"https://x.com/{handle}", "handle": handle, "user_id": user_id, "mode": "signal",
                                        "role": "person"}}


@pytest.fixture()
def discovery_settings(social_settings, tmp_path, monkeypatch):
    registry = tmp_path / "sources.json"
    registry.write_text(json.dumps({"sources": []}))
    social = tmp_path / "social-sources.json"
    social.write_text(json.dumps({"sources": [x_listed_row("listed", "9999"), x_listed_row("olddoc_before", "1255526396807561217")]}))
    monkeypatch.setenv("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY", str(social))
    return replace(social_settings, registry_path=str(registry))


async def propose(pool, *handles, key=None):
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("social", "social", key or f"x:{handle}", name=handle,
                                                     hint={"platform": "x", "account": handle}) for handle in handles], NOW, DAY)


async def candidates(pool):
    async with pool.connection() as conn:
        return {row["key"]: row for row in await (await conn.execute(
            "SELECT * FROM evimed_knowledge.source_candidates ORDER BY key")).fetchall()}


async def discover(settings, pool, fetcher, *, now=NOW):
    from knowledge_plugin.dynamic_registry import sync_dynamic_registry
    from knowledge_plugin.registry import load_registry

    async with pool.connection() as conn:
        await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), now)
    return await run_discovery(settings, pool, fetcher, lambda: now, data={"exclude_hosts": [], "directories": []},
                               gather_lines=[])


@pytest.mark.db
async def test_quoted_accounts_are_validated_and_a_live_one_goes_on_trial(discovery_settings, pool):
    fetcher, asked = socialdata()
    await propose(pool, *ACCOUNTS, "listed")
    await propose(pool, "x", key="x:Jae Myung Lee")
    report = await discover(discovery_settings, pool, fetcher)
    found = await candidates(pool)
    reasons = {key.removeprefix("x:"): (row["state"], row["state_reason"]) for key, row in found.items()}
    assert reasons == {
        "newdoc": ("trial", None),
        "quietdoc": ("failed", "no_fresh_items"),
        "retweeter": ("failed", "no_fresh_items"),
        "privatedoc": ("failed", "x_protected"),
        "ghost": ("failed", "x_not_found"),
        "renamed": ("failed", "x_handle_mismatch"),
        "olddoc": ("failed", "known"),           # a different handle of an account we read by its user id
        "listed": ("failed", "known"),
        "Jae Myung Lee": ("failed", "x_key_invalid")}
    assert found["x:retweeter"]["validation"]["only_retweets"] is True
    assert found["x:quietdoc"]["validation"]["newest"].startswith("2026-09-10")
    assert report["validated"]["social"] == {"trial": 1, "failed": 8}
    handles = [value for kind, value in asked if kind == "user"]
    assert "listed" not in handles and "Jae Myung Lee" not in handles, "a known handle and a bad key are not asked about"
    assert sorted(v for k, v in asked if k == "search") == sorted(
        f"from:{h} -filter:replies since:2026-09-25" for h in ("newdoc", "quietdoc", "retweeter")), \
        "posts are asked for only after the lookup passed: not for a private, missing, renamed or known account"

    row = found["x:newdoc"]["row"]
    assert row["access"] == "socialdata" and row["config"] == {
        "url": "https://x.com/newdoc", "handle": "newdoc", "user_id": "9001", "mode": "signal", "role": "person"}
    async with pool.connection() as conn:
        source = await (await conn.execute("SELECT access, enabled FROM evimed_knowledge.sources WHERE id = %s",
                                           (row["id"],))).fetchone()
        calls = await (await conn.execute(
            """SELECT purpose, count(*) AS n, sum(objects) AS objects, round(sum(amount), 4) AS usd
                 FROM evimed_knowledge.provider_calls WHERE provider = 'socialdata' GROUP BY purpose ORDER BY purpose""")).fetchall()
    assert source["access"] == "socialdata" and source["enabled"], "the trial row is in the registry; the collector reads it"
    by_purpose = {call["purpose"]: call for call in calls}
    assert by_purpose["discovery-user"]["n"] == 7 and by_purpose["discovery-search"]["n"] == 3
    assert by_purpose["discovery-search"]["objects"] == 4 and float(by_purpose["discovery-search"]["usd"]) == 0.0008, \
        "newdoc's two posts, quietdoc's one, the retweet: booked at objects x $0.0002"


@pytest.mark.db
async def test_the_trial_account_is_read_like_a_listed_one(discovery_settings, pool):
    fetcher, _ = socialdata()
    await propose(pool, "newdoc")
    await discover(discovery_settings, pool, fetcher)
    collector = SocialCollector(discovery_settings, pool, fetcher, clock=lambda: NOW + timedelta(minutes=1))
    report = await collector.tick()
    assert report["x"] == {"ok": 1}
    async with pool.connection() as conn:
        mine = await (await conn.execute(
            "SELECT health, last_ok_at FROM evimed_knowledge.sources WHERE id LIKE 'discovered-x-%'")).fetchone()
    assert mine["last_ok_at"] is not None and mine["health"] == "healthy", "the shard that holds the discovered account was read"


@pytest.mark.db
async def test_twenty_accounts_a_day_and_the_rest_are_due_again_tomorrow(discovery_settings, pool):
    fetcher, asked = socialdata()
    async with pool.connection() as conn:
        for _ in range(xd.VALIDATIONS_PER_DAY):
            await conn.execute("""INSERT INTO evimed_knowledge.provider_calls (provider, called_at, purpose, outcome, objects, amount, currency)
                                  VALUES ('socialdata', %s, 'discovery-user', 'ok', 1, 0.0002, 'USD')""", (NOW - timedelta(hours=1),))
    await propose(pool, "newdoc")
    report = await discover(discovery_settings, pool, fetcher)
    assert asked == [], "the day's twenty are spent: nothing is asked"
    found = await candidates(pool)
    assert (found["x:newdoc"]["state"], found["x:newdoc"]["state_reason"]) == ("candidate", "x_validation_budget")
    assert NOW + timedelta(hours=12) < found["x:newdoc"]["next_check_at"] < NOW + timedelta(days=2), "tomorrow, not in a week"
    async with pool.connection() as conn:
        status = await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'source_discovery'")).fetchone()
    assert status["value"]["attempts"].get("social", 0) == 0, "a candidate that waited used none of the line's room"

    later = NOW + timedelta(days=1, hours=1)                      # the next Shanghai day
    report = await discover(discovery_settings, pool, fetcher, now=later)
    assert (await candidates(pool))["x:newdoc"]["state"] == "trial" and report["validated"]["social"] == {"trial": 1}


@pytest.mark.db
async def test_a_provider_that_is_out_of_money_or_capped_defers_without_failing(discovery_settings, pool):
    fetcher, asked = socialdata(status=402)
    await propose(pool, "newdoc")
    await discover(discovery_settings, pool, fetcher)
    found = await candidates(pool)
    assert (found["x:newdoc"]["state"], found["x:newdoc"]["state_reason"]) == ("candidate", "socialdata_balance")
    assert asked == [("user", "newdoc")], "the lookup that failed is the only call"

    capped = replace(discovery_settings, socialdata_daily_usd=0.0001)    # below the cost of one lookup
    fetcher, asked = socialdata()
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.source_candidates SET next_check_at = NULL")
        await conn.execute("DELETE FROM evimed_knowledge.meta WHERE key = 'source_discovery'")
    await discover(capped, pool, fetcher)
    assert (await candidates(pool))["x:newdoc"]["state_reason"] == "socialdata_daily_cap" and asked == []


@pytest.mark.db
async def test_without_a_socialdata_key_an_x_candidate_waits_and_is_due_at_once_when_the_key_comes(settings, pool, tmp_path, monkeypatch):
    registry = tmp_path / "sources.json"
    registry.write_text(json.dumps({"sources": []}))
    monkeypatch.setenv("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY", str(tmp_path / "none.json"))
    plain = replace(settings, registry_path=str(registry))
    await propose(pool, "newdoc")
    report = await run_discovery(plain, pool, FakeFetcher(), lambda: NOW, data={"exclude_hosts": [], "directories": []},
                                 gather_lines=[])
    assert report["validated"]["social"] == {"deferred": 1}
    found = await candidates(pool)
    assert found["x:newdoc"]["state_reason"] == "adapter_unavailable:x" and found["x:newdoc"]["next_check_at"] > NOW + timedelta(days=6)

    key = tmp_path / "socialdata.api-key"
    key.write_text("fake-socialdata-key\n")
    keyed = replace(plain, socialdata_key_file=str(key))
    fetcher, _ = socialdata()
    async with pool.connection() as conn:                        # the same day's next run: the week's wait is cancelled
        await conn.execute("DELETE FROM evimed_knowledge.meta WHERE key = 'source_discovery'")
    report = await run_discovery(keyed, pool, fetcher, lambda: NOW, data={"exclude_hosts": [], "directories": []}, gather_lines=[])
    assert (await candidates(pool))["x:newdoc"]["state"] == "trial" and report["validated"]["social"] == {"trial": 1}
