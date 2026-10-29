"""Hot lists (contract 1.7.0, c2-leads 2026-10-25): the five public boards read every round, their snapshots kept 72 hours
and served at ``GET /v1/hot-lists``; a board that fails is recorded and skipped.

The parsers read the boards' real answers (``fixtures/hot-lists/``, fetched once on 2026-10-25); the network of the loop
is a scripted fetcher; the store and the API are the real code against the scratch database.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
import yaml

from knowledge_plugin.hotlists import (BOARDS, HotListReader, configured_boards, parse_baidu, parse_google_trends, parse_since,
                                       parse_toutiao, parse_weibo, parse_wikipedia)
from knowledge_plugin.model import CONTRACT_VERSION, FetchError, FetchResult
from knowledge_plugin.settings import Settings, SettingsError

FIXTURES = Path(__file__).parent / "fixtures" / "hot-lists"
NOW = datetime(2026, 10, 25, 4, 30, tzinfo=timezone.utc)
TOKEN = "Bearer test-token-0123456789"


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def assert_entries(entries: list, *, heat: bool, desc: bool = False, minimum: int = 20) -> None:
    assert minimum <= len(entries) <= 50
    assert [entry["rank"] for entry in entries] == list(range(1, len(entries) + 1)), "ranked 1..n in board order"
    for entry in entries:
        assert set(entry) == {"rank", "title", "heat", "desc", "url"}
        assert entry["title"] and len(entry["title"]) <= 200
        assert entry["url"] is None or entry["url"].startswith("https://")
        if heat:
            assert isinstance(entry["heat"], float) and entry["heat"] >= 0
    if desc:
        assert sum(1 for entry in entries if entry["desc"]) >= len(entries) // 2


# ------------------------------------------------------------------------------------ the boards' real answers


def test_baidu_the_pc_board_with_its_description_and_heat_the_pinned_entry_left_out():
    entries = parse_baidu(fixture("baidu.json"))
    assert_entries(entries, heat=True, desc=True)
    assert entries[0]["title"] == "张雪在家乡刷新吉尼斯纪录"
    assert entries[0]["heat"] == 7808462.0 and entries[0]["desc"].startswith("10月25日")


def test_toutiao_the_board_in_order_with_its_heat_and_its_topic_page():
    entries = parse_toutiao(fixture("toutiao.json"))
    assert_entries(entries, heat=True)
    assert entries[0]["title"] == "张雪机车刷新水上漂吉尼斯世界纪录" and entries[0]["heat"] == 17540072.0
    assert entries[0]["url"] == "https://www.toutiao.com/trending/7700435988002295305/"
    assert all("永葆赶考清醒" not in entry["title"] for entry in entries), "the pinned entry is not ranked"


def test_weibo_the_hot_search_in_order_the_sponsored_entry_left_out():
    entries = parse_weibo(fixture("weibo.json"))
    assert_entries(entries, heat=True)
    assert entries[0]["title"] == "日剧Vivant抹黑中国" and entries[0]["heat"] == 1172742.0
    assert entries[0]["url"].startswith("https://s.weibo.com/weibo?q=%23")
    assert all(entry["title"] != "网传涉巴青地震这些内容不实" for entry in entries), "is_ad entries are left out"


def test_wikipedia_the_articles_only():
    entries = parse_wikipedia(fixture("wikipedia-en.json"))
    assert_entries(entries, heat=True)
    titles = [entry["title"] for entry in entries]
    assert "Main Page" not in titles and not any(title.startswith(("Special:", "Wikipedia:")) for title in titles)
    assert titles[0] == "Clayface (film)" and "Elizabeth Holmes" in titles
    assert entries[0]["url"] == "https://en.wikipedia.org/wiki/Clayface_(film)"


def test_google_trends_the_trending_searches_with_their_first_headline():
    entries = parse_google_trends(fixture("google-trends.xml"))
    assert_entries(entries, heat=True, desc=True, minimum=10)   # the feed carries ten
    assert entries[0]["title"] == "sec standings" and entries[0]["heat"] == 2000.0
    assert entries[0]["url"].startswith("https://www.on3.com/")


def test_an_answer_that_is_no_board_is_an_error_not_an_empty_board():
    for parse, body in ((parse_baidu, b'{"success": false, "data": {}}'), (parse_toutiao, b'{"status": "error"}'),
                        (parse_weibo, b'{"ok": -100, "url": "https://passport.weibo.com/"}'), (parse_wikipedia, b'{"type": "not_found"}'),
                        (parse_google_trends, b"<html><body>sorry</body></html>")):
        with pytest.raises(ValueError):
            parse(body)


def test_the_contract_names_the_boards_and_the_route():
    spec = yaml.safe_load(open("contract/knowledge-plugin-openapi.yaml", encoding="utf-8"))
    assert CONTRACT_VERSION == spec["info"]["version"] == "1.7.0"
    assert spec["components"]["schemas"]["HotBoard"]["enum"] == list(BOARDS)
    assert "/v1/hot-lists" in spec["paths"]
    assert spec["components"]["schemas"]["HotListEntry"]["required"] == ["rank", "title", "heat", "desc", "url"]
    assert spec["components"]["schemas"]["Manifest"]["properties"]["capabilities"]["properties"]["hot_lists"]
    # The platform's vocabulary names the same boards (packages/domain/src/frontierTopics.mjs FRONTIER_HOT_BOARDS).
    domain = Path(__file__).resolve().parents[3] / "OpenScience" / "packages" / "domain" / "src" / "frontierTopics.mjs"
    if domain.exists():
        text = domain.read_text(encoding="utf-8")
        assert "FRONTIER_HOT_BOARDS = Object.freeze(['baidu', 'toutiao', 'weibo', 'wikipedia-en', 'google-trends'])" in text


def test_the_boards_setting():
    base = {"KNOWLEDGE_PLUGIN_DATABASE_URL": "postgresql://unused"}
    settings = Settings.from_env(base)
    assert settings.hot_lists_enabled is True and settings.hot_lists_interval_s == 1800 and settings.hot_lists_boards == ()
    assert configured_boards(settings) == list(BOARDS)
    chosen = Settings.from_env({**base, "KNOWLEDGE_PLUGIN_HOT_LISTS_BOARDS": "weibo, baidu,weibo", "KNOWLEDGE_PLUGIN_HOT_LISTS": "0",
                                "KNOWLEDGE_PLUGIN_HOT_LISTS_INTERVAL_S": "900"})
    assert chosen.hot_lists_boards == ("weibo", "baidu") and chosen.hot_lists_enabled is False and chosen.hot_lists_interval_s == 900
    with pytest.raises(SettingsError, match="douyin"):
        Settings.from_env({**base, "KNOWLEDGE_PLUGIN_HOT_LISTS_BOARDS": "baidu,douyin"})
    assert BOARDS["wikipedia-en"].egress == "relay" and BOARDS["google-trends"].egress == "relay"
    assert {BOARDS[name].egress for name in ("baidu", "toutiao", "weibo")} == {"direct"}
    assert BOARDS["weibo"].headers["Referer"] == "https://weibo.com/"
    assert BOARDS["wikipedia-en"].url(NOW).endswith("/2026/10/24"), "yesterday's full UTC day"


def test_since():
    assert parse_since(None, NOW) == NOW - timedelta(hours=72)
    assert parse_since("2026-10-25T04:00:00Z", NOW) == datetime(2026, 10, 25, 4, tzinfo=timezone.utc)
    assert parse_since("2026-10-01T00:00:00Z", NOW) == NOW - timedelta(hours=72), "never past the retention"
    with pytest.raises(ValueError):
        parse_since("yesterday", NOW)


# ------------------------------------------------------------------------------------ the loop and the route


class Boards:
    """Answers each board's address with its recorded body, or raises what it is told to."""

    def __init__(self, failing: dict | None = None):
        self.failing = failing or {}
        self.calls: list[tuple[str, str, bool, dict]] = []

    def egress_configured(self, egress):
        return True

    async def fetch(self, spec, *, source_id=None, egress="direct", allowed_hosts=None, **_):
        self.calls.append((spec.url, egress, spec.api, dict(spec.headers)))
        for name, board in BOARDS.items():
            if spec.url == board.url(NOW):
                if name in self.failing:
                    raise self.failing[name]
                body = fixture("google-trends.xml" if name == "google-trends" else f"{name}.json")
                return FetchResult(request=spec, final_url=spec.url, status=200, headers={}, body=body, fetched_at=NOW)
        raise FetchError("http-error", "http_404", status=404)


async def test_a_round_keeps_each_board_and_records_the_one_that_failed(settings, pool):
    fetcher = Boards({"weibo": FetchError("blocked", "http_403", status=403)})
    reader = HotListReader(settings, pool, fetcher, clock=lambda: NOW)
    result = await reader.tick()
    assert sorted(result["read"]) == ["baidu", "google-trends", "toutiao", "wikipedia-en"]
    assert result["failed"] == {"weibo": "blocked:http_403"}
    assert all(api for _, _, api, _ in fetcher.calls), "an API: robots.txt is not consulted"
    assert {url: egress for url, egress, _, _ in fetcher.calls}[BOARDS["google-trends"].url(NOW)] == "relay"
    async with pool.connection() as conn:
        rows = await (await conn.execute("SELECT board, fetched_at, jsonb_array_length(entries) AS n FROM evimed_knowledge.hot_lists ORDER BY board")).fetchall()
        assert [row["board"] for row in rows] == ["baidu", "google-trends", "toutiao", "wikipedia-en"]
        assert all(row["n"] >= (10 if row["board"] == "google-trends" else 20) for row in rows)
        boards = {row["board"]: row for row in await (await conn.execute("SELECT * FROM evimed_knowledge.hot_list_boards")).fetchall()}
    assert boards["weibo"]["last_ok_at"] is None and boards["weibo"]["last_error"] == "blocked:http_403"
    assert boards["baidu"]["last_ok_at"] == NOW and boards["baidu"]["last_error"] is None
    # The next round: weibo answers, and a snapshot older than 72 hours is gone.
    later = NOW + timedelta(hours=72, minutes=15)
    async with pool.connection() as conn:
        await conn.execute("UPDATE evimed_knowledge.hot_lists SET fetched_at = fetched_at - interval '1 hour' WHERE board = 'baidu'")
    again = HotListReader(replace(settings, hot_lists_boards=("weibo",)), pool, Boards(), clock=lambda: NOW + timedelta(minutes=30))
    assert (await again.tick())["failed"] == {}
    gone = HotListReader(replace(settings, hot_lists_boards=("weibo",)), pool, Boards({"weibo": FetchError("timeout", "read")}), clock=lambda: later)
    await gone.tick()
    async with pool.connection() as conn:
        left = await (await conn.execute("SELECT board FROM evimed_knowledge.hot_lists ORDER BY board")).fetchall()
        weibo = await (await conn.execute("SELECT * FROM evimed_knowledge.hot_list_boards WHERE board = 'weibo'")).fetchone()
    assert [row["board"] for row in left] == ["weibo"], "kept 72 hours, then deleted"
    assert weibo["last_ok_at"] == NOW + timedelta(minutes=30) and weibo["last_error"] == "timeout:read", "a failure keeps the last good read"


async def test_the_route_serves_the_snapshots_since_a_time_and_health_says_how_each_board_read(settings, pool):
    from knowledge_plugin.api import create_app

    await HotListReader(settings, pool, Boards({"google-trends": FetchError("blocked", "egress_unavailable")}), clock=lambda: NOW).tick()
    await HotListReader(replace(settings, hot_lists_boards=("baidu",)), pool, Boards(), clock=lambda: NOW + timedelta(minutes=30)).tick()
    app = create_app(settings, pool=pool, clock=lambda: NOW + timedelta(minutes=40))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        assert (await http.get("/v1/hot-lists")).status_code == 401
        http.headers["Authorization"] = TOKEN
        everything = (await http.get("/v1/hot-lists")).json()
        assert [(b["board"], b["fetched_at"]) for b in everything["boards"]] == [
            ("baidu", "2026-10-25T04:30:00.000Z"), ("toutiao", "2026-10-25T04:30:00.000Z"), ("weibo", "2026-10-25T04:30:00.000Z"),
            ("wikipedia-en", "2026-10-25T04:30:00.000Z"), ("baidu", "2026-10-25T05:00:00.000Z")]
        assert everything["boards"][0]["entries"][0] == {"rank": 1, "title": "张雪在家乡刷新吉尼斯纪录", "heat": 7808462.0,
                                                          "desc": everything["boards"][0]["entries"][0]["desc"],
                                                          "url": everything["boards"][0]["entries"][0]["url"]}
        newer = (await http.get("/v1/hot-lists", params={"since": "2026-10-25T04:30:00.000Z"})).json()
        assert [(b["board"], b["fetched_at"]) for b in newer["boards"]] == [("baidu", "2026-10-25T05:00:00.000Z")], "after, not at"
        bad = await http.get("/v1/hot-lists", params={"since": "soon"})
        assert bad.status_code == 400 and bad.json()["details"] == {"field": "since"}
        health = (await http.get("/v1/health")).json()
        assert health["hot_lists"]["google-trends"] == {"last_ok_at": None, "last_error": "blocked:egress_unavailable"}
        assert health["hot_lists"]["baidu"]["last_ok_at"] == "2026-10-25T05:00:00.000Z"
        assert (await http.get("/v1/manifest")).json()["capabilities"]["hot_lists"] is True
    off = create_app(replace(settings, hot_lists_enabled=False), pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=off), base_url="http://plugin") as http:
        http.headers["Authorization"] = TOKEN
        refused = await http.get("/v1/hot-lists")
        assert refused.status_code == 501 and refused.json()["code"] == "capability_unavailable"
        assert "hot_lists" not in (await http.get("/v1/health")).json()
