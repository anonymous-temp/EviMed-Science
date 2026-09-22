"""europepmc against recorded Europe PMC answers (2026-09-22) and the plan's traps.

Traps covered: a 200 answer without ``hitCount`` is a retryable failure, never "zero preprints"
(recorded twice for real on 2026-09-22 — the first request of the stream case and the probe);
the window is on ``FIRST_IDATE``; a future first-publication date yields to the index date;
deep paging follows ``nextCursorMark`` while pages come back full.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.adapters.europepmc import europepmc_published_at
from knowledge_plugin.model import FetchError
from replay import load_case

ADAPTER = REGISTRY["europepmc"]


def test_missing_hitcount_is_a_retryable_failure():
    for name in ("europepmc/hitcount-probe", "europepmc/medrxiv-preprints"):
        case = load_case(name)
        answer = case.exchanges[0].result
        assert answer.status == 200 and json.loads(answer.body) == {"version": "6.9"}
        with pytest.raises(FetchError) as raised:
            ADAPTER.parse(answer, case.source, case.now or datetime.now(timezone.utc))
        assert raised.value.outcome == "http-error"
        assert raised.value.detail == "europepmc_missing_hitcount"
        assert raised.value.retry_after_s == 2  # the scheduler retries the same request once, in the same poll


def test_retry_then_two_cursor_pages():
    case = load_case("europepmc/medrxiv-preprints")
    retried, page1, page2 = case.exchanges
    assert page1.spec.url == retried.spec.url  # the very same request after the fault
    first = ADAPTER.parse(page1.result, case.source, case.now)
    assert len(first.entries) == 50
    assert query_param(first.next.url, "cursorMark") == json.loads(page1.result.body)["nextCursorMark"]
    second = ADAPTER.parse(page2.result, case.source, case.now)
    assert len(second.entries) == 48 and second.next is None
    keys = {e.external_key for e in first.entries + second.entries}
    assert len(keys) == 98 == json.loads(page1.result.body)["hitCount"]


def test_preprint_entry_fields():
    case = load_case("europepmc/medrxiv-preprints")
    entries = ADAPTER.parse(case.exchanges[1].result, case.source, case.now).entries
    entry = next(e for e in entries if e.external_key == "PPR:PPR1324244")
    assert entry.doi == "10.64898/2026.09.18.26363418"
    assert entry.url == "https://doi.org/10.64898/2026.09.18.26363418"
    assert entry.published_at == datetime(2026, 9, 21, tzinfo=timezone.utc) and entry.date_precision == "day"
    assert entry.facts == {"journal": "medRxiv", "author_count": 21}
    assert entry.summary.startswith("BACKGROUND: Postoperative increases in cerebrospinal fluid")
    assert "<h4>" not in entry.summary


def test_plan_windows_on_first_idate_and_restarts_the_cursor():
    case = load_case("europepmc/medrxiv-preprints")
    url = ADAPTER.plan(case.source, replace(case.state, cursor={"cursor": "AoIIQ-old"}), case.now)[0].url
    assert "FIRST_IDATE:%5B2026-09-20%20TO%202026-09-22%5D" in url
    assert query_param(url, "cursorMark") == "*"
    assert query_param(url, "pageSize") == "50"
    broken = replace(case.source, config={**case.source.config,
                                          "url": case.source.config["url"].replace("FIRST_IDATE", "FIRST_PDATE")})
    assert any("FIRST_IDATE" in p for p in ADAPTER.validate_config(broken))


def test_future_publication_date_yields_to_the_index_date():
    # Constructed input for the date rule (the recorded preprints carry no future date; newly
    # indexed MEDLINE records do, a median 46 days ahead — research/upstream-limits 2026-09-21).
    assert europepmc_published_at({"firstPublicationDate": "2026-11-01", "firstIndexDate": "2026-09-21"}) == \
        datetime(2026, 9, 21, tzinfo=timezone.utc)
    assert europepmc_published_at({"firstPublicationDate": "2026-09-01", "firstIndexDate": "2026-09-17"}) == \
        datetime(2026, 9, 1, tzinfo=timezone.utc)
