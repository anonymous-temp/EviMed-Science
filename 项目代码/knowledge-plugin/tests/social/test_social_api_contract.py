"""Contract 1.5.0 on the wire: a social post's fields in the stream and in ``/text``, the media route, ``providers``."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from knowledge_plugin.api import create_app
from knowledge_plugin.model import NormalizedEntry, SourceConfig
from knowledge_plugin.normalize import prepare
from knowledge_plugin.registry import source_from_row, sync_registry
from knowledge_plugin.registry import parse_registry
from knowledge_plugin.social.media import MediaStore
from knowledge_plugin.social.spend import DAJIALA, ProviderLedger
from knowledge_plugin.store import store_entries

from social_fakes import FakeFetcher, contract_validator, png_bytes

pytestmark = pytest.mark.db
NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)
SPEC, assert_schema = contract_validator()

X_ROW = {"id": "x-us-fda", "name": "FDA (X)", "homepage": "https://x.com/US_FDA", "lane": "mixed",
         "source_type": "regulator", "access": "socialdata", "egress": "api", "authority": 5, "safety_feed": False,
         "owner_entity": "U.S. Food and Drug Administration", "launch_tier": "P1", "language": "en", "region": "US",
         "poll_floor_s": 1800, "poll_ceiling_s": 3600, "enabled": True,
         "config": {"url": "https://x.com/US_FDA", "handle": "US_FDA", "mode": "editorial", "role": "organisation"}}
FEED_ROW = {"id": "fda-press", "name": "FDA press", "lane": "regulatory", "source_type": "regulator", "access": "rss",
            "egress": "direct", "authority": 5, "safety_feed": False, "owner_entity": "U.S. Food and Drug Administration",
            "launch_tier": "P0", "poll_floor_s": 1800, "poll_ceiling_s": 3600, "enabled": True,
            "config": {"url": "https://www.fda.gov/rss.xml"}}


@pytest.fixture()
async def app_client(social_settings, pool):
    rows = parse_registry({"sources": [X_ROW, FEED_ROW]})
    image = png_bytes((120, 90))
    fetcher = FakeFetcher({("GET", "https://pbs.twimg.com/"): lambda spec: (200, image, {"content-type": "image/png"})})
    store = MediaStore(social_settings, pool, fetcher=fetcher, clock=lambda: NOW)
    photo = await store.ensure("https://pbs.twimg.com/media/chart.jpg", alt="Approval chart")
    async with pool.connection() as conn:
        await sync_registry(conn, rows, NOW)
        sources = {r["id"]: source_from_row(r) for r in await (await conn.execute("SELECT * FROM evimed_knowledge.sources")).fetchall()}
        post = NormalizedEntry(
            external_key="1849999999999999999", url="https://x.com/US_FDA/status/1849999999999999999",
            title="FDA approves the first treatment for a rare disease", summary="FDA approves the first treatment for a rare disease.\nRead more.",
            published_at=NOW - timedelta(hours=2), language="en", channel="x", platform="x",
            author={"name": "U.S. FDA", "handle": "@US_FDA", "url": "https://x.com/US_FDA", "role": "organisation"},
            media=[photo], quoted={"author": {"name": "FDA Drug Info", "handle": "FDA_Drug_Info"},
                                   "text": "Today's approval in detail.", "url": "https://x.com/FDA_Drug_Info/status/1"},
            metrics={"likes": 120, "reposts": 30, "replies": 4, "views": 9000, "observed_at": NOW},
            body_text="FDA approves the first treatment for a rare disease.\n\nRead more.", body_from="x")
        await store_entries(conn, "x-us-fda", [prepare(post, sources["x-us-fda"])], now=NOW, first_contact=False)
        plain = NormalizedEntry(external_key="guid-1", url="https://www.fda.gov/news/1", title="FDA news", summary="A notice " * 20,
                                published_at=NOW - timedelta(hours=3))
        await store_entries(conn, "fda-press", [prepare(plain, sources["fda-press"])], now=NOW, first_contact=False)
        ledger = ProviderLedger(pool, lambda: NOW)
        await ledger.record(DAJIALA, purpose="post_history", outcome="ok", amount=0.14, remaining=29.86, now=NOW)
    app = create_app(social_settings, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        http.headers["Authorization"] = "Bearer test-token-0123456789"
        yield http, photo


async def test_a_post_carries_its_author_media_quote_and_counts(app_client):
    client, photo = app_client
    page = (await client.get("/v1/entries", params={"after": 0})).json()
    assert_schema(page, "EntryPage")
    post, plain = sorted(page["entries"], key=lambda entry: entry["source_id"] != "x-us-fda")
    assert post["channel"] == "x" and post["platform"] == "x"
    assert post["author"] == {"name": "U.S. FDA", "handle": "US_FDA", "url": "https://x.com/US_FDA", "role": "organisation"}
    assert post["media"] == [photo] and photo["width"] == 120 and photo["alt"] == "Approval chart"
    assert post["quoted"]["author"] == {"name": "FDA Drug Info", "handle": "FDA_Drug_Info"}
    assert post["metrics"] == {"likes": 120, "reposts": 30, "replies": 4, "views": 9000, "observed_at": "2026-10-22T06:00:00Z"}
    assert post["text_status"] == "available", "a post arrives with its own text"
    assert plain["channel"] == "regulator", "every other source's channel comes from its registry row"
    for absent in ("platform", "author", "media", "quoted", "metrics"):
        assert absent not in plain, f"{absent} is absent when unknown, never guessed"
    text = (await client.get(f"/v1/entries/{post['entry_id']}/text")).json()
    assert_schema(text, "EntryText")
    assert text["status"] == "available" and text["text_kind"] == "full" and text["fetched_from"] == "x"
    assert text["body_text"] == "FDA approves the first treatment for a rare disease.\n\nRead more."
    assert text["body_excerpt"] == text["body_text"]


async def test_media_is_served_by_its_id_with_its_type(app_client):
    client, photo = app_client
    response = await client.get(f"/v1/media/{photo['id']}")
    assert response.status_code == 200 and response.headers["content-type"] == "image/jpeg"
    assert response.headers["etag"] == f'"{photo["id"]}"' and "max-age=86400" in response.headers["cache-control"]
    assert response.content[:2] == b"\xff\xd8"
    missing = await client.get("/v1/media/" + "0" * 64)
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"
    assert (await client.get("/v1/media/not-a-hash")).status_code == 404
    refused = await client.get(f"/v1/media/{photo['id']}", headers={"Authorization": "Bearer wrong"})
    assert refused.status_code == 401


async def test_health_names_each_providers_calls_spend_and_balance(app_client):
    client, _ = app_client
    body = (await client.get("/v1/health", headers={"Authorization": ""})).json()
    assert_schema(body, "Health")
    providers = {row["name"]: row for row in body["providers"]}
    assert set(providers) == {"socialdata", "dajiala", "geo-social-crawl"}, "every configured provider is listed"
    assert providers["dajiala"]["spend_24h"] == {"amount": 0.14, "currency": "CNY"}
    assert providers["dajiala"]["remaining"] == {"amount": 29.86, "currency": "CNY"}
    assert providers["socialdata"]["daily_cap"] == {"amount": 5.0, "currency": "USD"} and providers["socialdata"]["calls_24h"] == 0
    assert providers["geo-social-crawl"]["remaining"] == {"amount": 120, "currency": "requests"}


async def test_manifest_names_the_new_fields_and_read_methods(app_client):
    client, _ = app_client
    body = (await client.get("/v1/manifest")).json()
    assert_schema(body, "Manifest")
    assert body["contract"]["version"] == SPEC["info"]["version"] == "1.5.0"
    assert {"channel", "platform", "author", "media", "quoted", "metrics"} <= set(body["fields"]["entry"])
    assert "socialdata" in body["vocabularies"]["access"]


async def test_health_without_providers_says_nothing_about_them(settings, pool):
    app = create_app(settings, pool=pool, clock=lambda: NOW)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plugin") as http:
        body = (await http.get("/v1/health")).json()
    assert "providers" not in body, "absent when the deployment configured none"
