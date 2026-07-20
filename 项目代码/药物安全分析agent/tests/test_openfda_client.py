"""openFDA client tests: parsing, retry/backoff, caching, error semantics.

All HTTP traffic is mocked with respx against local sample payloads in
tests/data/ — no network access. Backoff sleeps are replaced by a recorder
so the suite never actually waits.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from safety_agent.core.cache import TwoLevelCache
from safety_agent.core.exceptions import (
    NoResults,
    OpenFDAError,
    OpenFDARateLimited,
    OpenFDAUnavailable,
)
from safety_agent.openfda.client import EVENT_ENDPOINT, LABEL_ENDPOINT, OpenFDAClient
from safety_agent.openfda.queries import EventQuery, drug_clause, reaction_clause
from safety_agent.signals.tables import fetch_contingency_table

DATA = Path(__file__).parent / "data"
BASE = "https://api.fda.gov"


def _load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


@pytest.fixture
def no_sleep():
    calls: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        calls.append(seconds)

    return calls, fake_sleep


def _client(**overrides) -> OpenFDAClient:
    return OpenFDAClient(BASE, backoff_initial=0.01, backoff_cap=0.05, **overrides)


# -- parsing -----------------------------------------------------------------


@respx.mock
async def test_count_total_parses_meta():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_total.json"))
    )
    async with _client() as client:
        total = await client.count_total(drug_clause("atorvastatin"))
    assert total == 12345


@respx.mock
async def test_count_terms_parses_and_skips_malformed():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_count.json"))
    )
    async with _client() as client:
        terms = await client.count_terms(
            "patient.reaction.reactionmeddrapt.exact", drug_clause("atorvastatin")
        )
    assert [(t.term, t.count) for t in terms] == [("MYALGIA", 100), ("RHABDOMYOLYSIS", 50)]


@respx.mock
async def test_search_events_parses_reports_defensively():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_search.json"))
    )
    async with _client() as client:
        result = await client.search_events(EventQuery(drug="atorvastatin", reaction="myalgia"))
    assert result.total == 2
    assert len(result.reports) == 2  # the id-less record is skipped, not fatal
    first = result.reports[0]
    assert first["safetyreportid"] == "20000001"
    assert first["reactions"] == ["Myalgia", "Blood creatine phosphokinase increased"]
    assert first["drugs"] == ["ATORVASTATIN CALCIUM", "ASPIRIN"]
    assert first["patientsex"] == "1"
    assert result.reports[1]["patientonsetage"] is None  # missing field -> None, no KeyError


@respx.mock
async def test_search_labels_extracts_safety_sections():
    respx.get(f"{BASE}/{LABEL_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("label.json"))
    )
    async with _client() as client:
        labels = await client.search_labels(drug="atorvastatin")
    assert len(labels) == 1
    label = labels[0]
    assert label.set_id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert label.brand_names == ("LIPITOR",)
    assert label.generic_names == ("ATORVASTATIN CALCIUM",)
    assert label.boxed_warning and "Sample boxed warning" in label.boxed_warning[0]
    assert "rhabdomyolysis" in label.warnings[0]
    assert label.adverse_reactions and label.warnings_and_cautions


# -- error semantics ------------------------------------------------------------


@respx.mock
async def test_count_terms_accepts_numeric_term_codes():
    """Numeric-coded fields (patient.patientsex) return int terms, not str."""
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(
            200,
            json={
                "meta": {"results": {"total": 307242}},
                "results": [
                    {"term": 1, "count": 157972},
                    {"term": 2, "count": 148884},
                    {"term": 0, "count": 386},
                ],
            },
        )
    )
    async with _client() as client:
        terms = await client.count_terms("patient.patientsex", drug_clause("atorvastatin"))
    assert [(t.term, t.count) for t in terms] == [
        ("1", 157972),
        ("2", 148884),
        ("0", 386),
    ]


@respx.mock
async def test_404_maps_to_no_results():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(404, json=_load("not_found.json"))
    )
    async with _client() as client:
        with pytest.raises(NoResults) as excinfo:
            await client.count_total(drug_clause("notadrugatall"))
    assert excinfo.value.status_code == 404


@respx.mock
async def test_other_4xx_fails_fast_without_retry(no_sleep):
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(400, text="invalid field name")
    )
    async with _client(sleep=fake_sleep) as client:
        with pytest.raises(OpenFDAError) as excinfo:
            await client.count_total("badfield:1")
    assert excinfo.value.status_code == 400
    assert route.call_count == 1  # no retries on client errors
    assert calls == []


@respx.mock
async def test_invalid_json_raises_openfda_error():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, text="<html>proxy error</html>")
    )
    async with _client() as client:
        with pytest.raises(OpenFDAError, match="invalid JSON"):
            await client.count_total(drug_clause("atorvastatin"))


@respx.mock
async def test_missing_meta_raises_not_keyerror():
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    async with _client() as client:
        with pytest.raises(OpenFDAError, match="meta.results.total"):
            await client.count_total(drug_clause("atorvastatin"))


# -- retry / backoff --------------------------------------------------------------


@respx.mock
async def test_429_retries_then_succeeds(no_sleep):
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0.02"}),
            httpx.Response(200, json=_load("event_total.json")),
        ]
    )
    async with _client(sleep=fake_sleep) as client:
        total = await client.count_total(drug_clause("atorvastatin"))
    assert total == 12345
    assert route.call_count == 2
    assert len(calls) == 1  # exactly one backoff between attempts


@respx.mock
async def test_429_exhaustion_raises_rate_limited(no_sleep):
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "0.01"})
    )
    async with _client(max_retries=3, sleep=fake_sleep) as client:
        with pytest.raises(OpenFDARateLimited):
            await client.count_total(drug_clause("atorvastatin"))
    assert route.call_count == 3
    assert len(calls) == 3


@respx.mock
async def test_5xx_retries_then_unavailable(no_sleep):
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(return_value=httpx.Response(503))
    async with _client(max_retries=2, sleep=fake_sleep) as client:
        with pytest.raises(OpenFDAUnavailable):
            await client.count_total(drug_clause("atorvastatin"))
    assert route.call_count == 2
    assert len(calls) == 2


@respx.mock
async def test_transport_error_retries_then_unavailable(no_sleep):
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        side_effect=httpx.ConnectError("connection refused")
    )
    async with _client(max_retries=2, sleep=fake_sleep) as client:
        with pytest.raises(OpenFDAUnavailable):
            await client.count_total(drug_clause("atorvastatin"))
    assert route.call_count == 2
    assert len(calls) == 2


@respx.mock
async def test_illegal_argument_500_fails_fast_without_retry(no_sleep):
    """openFDA answers 500+illegal_argument_exception for bad aggregations
    (e.g. count=occurcountry without .exact) — a query bug, not an outage."""
    calls, fake_sleep = no_sleep
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(
            500,
            json={
                "error": {
                    "code": "SERVER_ERROR",
                    "message": "Check your request and try again",
                    "details": "[illegal_argument_exception] Text fields are not optimised...",
                }
            },
        )
    )
    async with _client(sleep=fake_sleep) as client:
        with pytest.raises(OpenFDAError, match="illegal argument"):
            await client.count_terms("occurcountry", drug_clause("atorvastatin"))
    assert route.call_count == 1
    assert calls == []


# -- caching ------------------------------------------------------------------------


@respx.mock
async def test_memory_cache_avoids_second_request(tmp_path):
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_total.json"))
    )
    cache = TwoLevelCache(tmp_path, ttl_seconds=3600.0)
    async with _client(cache=cache) as client:
        first = await client.count_total(drug_clause("atorvastatin"))
        second = await client.count_total(drug_clause("atorvastatin"))
    assert first == second == 12345
    assert route.call_count == 1


@respx.mock
async def test_disk_cache_survives_new_client_instance(tmp_path):
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_total.json"))
    )
    async with _client(cache=TwoLevelCache(tmp_path, ttl_seconds=3600.0)) as client:
        await client.count_total(drug_clause("atorvastatin"))
    assert route.call_count == 1
    # Fresh client = empty memory cache; the disk level must still serve it.
    async with _client(cache=TwoLevelCache(tmp_path, ttl_seconds=3600.0)) as client2:
        total = await client2.count_total(drug_clause("atorvastatin"))
    assert total == 12345
    assert route.call_count == 1


@respx.mock
async def test_expired_cache_refetches(tmp_path):
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(200, json=_load("event_total.json"))
    )
    cache = TwoLevelCache(tmp_path, ttl_seconds=0.0)  # disabled
    async with _client(cache=cache) as client:
        await client.count_total(drug_clause("atorvastatin"))
        await client.count_total(drug_clause("atorvastatin"))
    assert route.call_count == 2


@respx.mock
async def test_no_results_is_not_cached(tmp_path):
    route = respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(
        return_value=httpx.Response(404, json=_load("not_found.json"))
    )
    cache = TwoLevelCache(tmp_path, ttl_seconds=3600.0)
    async with _client(cache=cache) as client:
        for _ in range(2):
            with pytest.raises(NoResults):
                await client.count_total(drug_clause("ghost-drug"))
    assert route.call_count == 2  # 404 must not poison the cache


def test_memory_cache_uses_a_bounded_lru_when_disk_is_disabled():
    cache = TwoLevelCache(None, ttl_seconds=3600.0, max_memory_entries=2)
    keys = [cache.make_key(str(index)) for index in range(3)]
    for index, key in enumerate(keys):
        cache.set(key, index)

    assert cache.get(keys[0]) is None
    assert cache.get(keys[1]) == 1
    assert cache.get(keys[2]) == 2


# -- 2x2 table from live-shaped count queries --------------------------------------


@respx.mock
async def test_fetch_contingency_table_builds_cells():
    totals = {
        "joint": 10,
        "drug": 100,
        "event": 30,
        "total": 2000,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        search = request.url.params.get("search", "")
        drug = 'patient.drug.medicinalproduct:"atorvastatin"' in search
        reaction = 'patient.reaction.reactionmeddrapt:"myalgia"' in search
        if drug and reaction:
            total = totals["joint"]
        elif drug:
            total = totals["drug"]
        elif reaction:
            total = totals["event"]
        elif not search:
            total = totals["total"]
        else:  # pragma: no cover - guards test wiring
            raise AssertionError(f"unexpected search: {search}")
        return httpx.Response(200, json={"meta": {"results": {"total": total}}, "results": []})

    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=handler)
    async with _client() as client:
        table = await fetch_contingency_table(
            client, drug_clause("atorvastatin"), reaction_clause("myalgia")
        )
    assert (table.a, table.b, table.c, table.d) == (10, 90, 20, 1880)
