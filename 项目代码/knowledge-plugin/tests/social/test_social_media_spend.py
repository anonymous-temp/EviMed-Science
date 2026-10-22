"""The media store and the provider ledger (contract 1.5.0)."""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from knowledge_plugin.social.media import MAX_BYTES, MediaRefused, MediaStore, media_egress, reencode
from knowledge_plugin.social.spend import (DAJIALA, SOCIAL_CRAWL, SOCIALDATA, Cap, ProviderLedger, SpendCapReached,
                                           day_window)

from social_fakes import FakeFetcher, png_bytes

NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)   # 14:00 in Shanghai


def test_reencode_keeps_an_image_and_drops_what_is_not_one():
    data, kind, width, height = reencode(png_bytes((300, 200)))
    assert kind == "image/jpeg" and (width, height) == (300, 200) and len(data) <= MAX_BYTES
    transparent, kind, *_ = reencode(png_bytes((40, 40), mode="RGBA"))
    assert kind == "image/png", "an image with transparency stays a PNG while it fits"
    with pytest.raises(MediaRefused) as refused:
        reencode(b"<html>not an image</html>")
    assert refused.value.reason == "not_an_image"


def test_reencode_strips_metadata_and_bounds_the_size():
    from PIL import Image

    with_exif = png_bytes((120, 80), exif=True)
    assert b"Exif" in with_exif
    data, *_ = reencode(with_exif)
    assert b"Exif" not in data, "the stored bytes carry no EXIF block"
    noisy = Image.effect_noise((3000, 3000), 120).convert("RGB")
    out = io.BytesIO()
    noisy.save(out, format="PNG")
    assert len(out.getvalue()) > MAX_BYTES
    data, kind, width, height = reencode(out.getvalue())
    assert len(data) <= MAX_BYTES and max(width, height) <= 2048 and kind == "image/jpeg"


def test_x_images_take_the_relay_when_there_is_one():
    assert media_egress("https://pbs.twimg.com/media/a.jpg", True) == "relay"
    assert media_egress("https://pbs.twimg.com/media/a.jpg", False) == "direct"
    assert media_egress("https://mmbiz.qpic.cn/x.jpg", True) == "direct"


@pytest.mark.db
async def test_store_reuses_by_address_serves_by_id_and_evicts_least_recently_served(social_settings, pool):
    from dataclasses import replace

    image = png_bytes((80, 60))
    fetcher = FakeFetcher({("GET", "https://pbs.twimg.com/"): lambda spec: (200, image, {"content-type": "image/png"})},
                          relay=True)
    clock = [NOW]
    store = MediaStore(social_settings, pool, fetcher=fetcher, clock=lambda: clock[0])
    first = await store.ensure("https://pbs.twimg.com/media/one.jpg", alt="a chart")
    assert first["kind"] == "image" and first["alt"] == "a chart" and first["original_url"].endswith("one.jpg")
    assert fetcher.calls[0]["egress"] == "relay" and fetcher.calls[0]["source_id"] == "media"
    again = await store.ensure("https://pbs.twimg.com/media/one.jpg")
    assert again["id"] == first["id"] and len(fetcher.calls) == 1, "a stored address is not fetched again"
    content, content_type = await store.read(first["id"])
    assert content_type == "image/jpeg" and content[:2] == b"\xff\xd8"
    assert Path(social_settings.media_dir, first["id"][:2], first["id"]).exists()

    other = png_bytes((90, 70), color=(10, 200, 10))
    fetcher.routes[("GET", "https://mmbiz.qpic.cn/")] = lambda spec: (200, other, {"content-type": "image/png"})
    clock[0] = NOW + timedelta(minutes=5)
    second = await store.ensure("https://mmbiz.qpic.cn/two.png")
    assert fetcher.calls[-1]["egress"] == "direct"
    clock[0] = NOW + timedelta(minutes=10)
    await store.read(second["id"])                      # the second was served last: the first goes first
    tiny = replace(social_settings, media_cap_mb=16)
    small = MediaStore(tiny, pool, fetcher=fetcher, clock=lambda: clock[0])
    async with pool.connection() as conn:               # make the store hold more than 16 MB on paper
        await conn.execute("UPDATE evimed_knowledge.media SET bytes = 1500000")
        await conn.execute("""INSERT INTO evimed_knowledge.media (id, content_type, bytes, original_url, stored_at)
                              SELECT md5(g::text) || md5(g::text), 'image/jpeg', 1500000, 'https://x/' || g, %s
                                FROM generate_series(1, 10) g""", (NOW + timedelta(minutes=8),))
    evicted = await small.evict()
    assert evicted >= 1
    assert await store.read(first["id"]) is None, "the least recently served image went first and answers nothing"
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT evicted_at, original_url FROM evimed_knowledge.media WHERE id = %s",
                                        (first["id"],))).fetchone()
    assert row["evicted_at"] is not None and row["original_url"].endswith("one.jpg"), "the record stays"
    kept = await store.ensure("https://pbs.twimg.com/media/one.jpg")
    assert kept["id"] == first["id"], "an evicted image is still named by its id and original address"


@pytest.mark.db
async def test_store_remembers_a_failure_for_a_day(social_settings, pool):
    fetcher = FakeFetcher({("GET", "https://pbs.twimg.com/"): lambda spec: (200, b"<html>login</html>", {"content-type": "text/html"})})
    clock = [NOW]
    store = MediaStore(social_settings, pool, fetcher=fetcher, clock=lambda: clock[0])
    assert await store.ensure("https://pbs.twimg.com/media/x.jpg") is None
    assert await store.ensure("https://pbs.twimg.com/media/x.jpg") is None
    assert len(fetcher.calls) == 1, "a refused original is not fetched again the same day"
    clock[0] = NOW + timedelta(days=1, minutes=1)
    await store.ensure("https://pbs.twimg.com/media/x.jpg")
    assert len(fetcher.calls) == 2


@pytest.mark.db
async def test_without_a_directory_nothing_is_stored(settings, pool):
    store = MediaStore(settings, pool, fetcher=FakeFetcher(), clock=lambda: NOW)
    assert not store.configured and await store.ensure("https://pbs.twimg.com/media/x.jpg") is None


def test_the_day_is_shanghais():
    start, end = day_window(datetime(2026, 10, 22, 15, 59, tzinfo=timezone.utc))   # 23:59 Shanghai
    assert start == datetime(2026, 10, 21, 16, 0, tzinfo=timezone.utc) and end - start == timedelta(days=1)
    start, _ = day_window(datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc))      # 00:00 Shanghai, the next day
    assert start == datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc)


@pytest.mark.db
async def test_ledger_caps_by_the_shanghai_day_and_reports_health(pool):
    ledger = ProviderLedger(pool, lambda: NOW)
    cap = Cap(DAJIALA, 0.5)
    for _ in range(3):
        await ledger.check(cap, 0.14)
        await ledger.record(DAJIALA, purpose="post_history", outcome="ok", amount=0.14, remaining=29.58)
    with pytest.raises(SpendCapReached) as reached:
        await ledger.check(cap, 0.14)
    assert reached.value.retry_at == datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc), "it waits until the next day"
    await ledger.check(cap, 0.03), "a smaller call still fits"
    await ledger.record(SOCIALDATA, purpose="search", outcome="ok", objects=40, amount=0.008)
    await ledger.record(SOCIALDATA, purpose="search", outcome="balance", error="http_402")
    await ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="ok", amount=1)
    tomorrow = ProviderLedger(pool, lambda: NOW + timedelta(hours=10))   # 00:00 the next Shanghai day
    await tomorrow.check(cap, 0.5)
    health = {row["name"]: row for row in await ledger.health({DAJIALA: cap, SOCIAL_CRAWL: Cap(SOCIAL_CRAWL, 120)})}
    assert health[DAJIALA]["calls_24h"] == 3 and health[DAJIALA]["spend_24h"] == {"amount": 0.42, "currency": "CNY"}
    assert health[DAJIALA]["remaining"] == {"amount": 29.58, "currency": "CNY"}, "the provider's own balance"
    assert health[DAJIALA]["daily_cap"] == {"amount": 0.5, "currency": "CNY"}
    assert health[SOCIALDATA]["spend_24h"] == {"amount": 0.008, "currency": "USD"} and health[SOCIALDATA]["last_error"] == "http_402"
    assert health[SOCIAL_CRAWL]["remaining"] == {"amount": 119, "currency": "requests"}
    assert "last_error" not in health[DAJIALA]
