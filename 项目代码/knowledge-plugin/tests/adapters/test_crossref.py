"""crossref-issn against recorded Crossref answers (2026-09-22) and the plan's traps.

Traps covered (plan 10.2.4): ``rows=100`` silently truncates → cursor paging (Frontiers in
Pharmacology 123 works, Nature Communications 212 in one 7-day window); the journal route refuses
``select=subtype/language`` (a real 400); ``update-to`` notices and exact-title mastheads are
flagged, never dropped (Kidney International's week); dates are Crossref's ``created``.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.adapters.crossref import crossref_work_entry
from knowledge_plugin.model import FetchError, SourceState
from replay import load_case

ADAPTER = REGISTRY["crossref-issn"]


def entries_of(case):
    out = []
    for result in case.results():
        out += ADAPTER.parse(result, case.source, case.now).entries
    return out


def test_nejm_week_maps_every_work():
    case = load_case("crossref-issn/nejm")
    output = ADAPTER.parse(case.results()[0], case.source, case.now)
    assert output.next is None  # 23 works, one page
    assert len(output.entries) == 23
    for entry in output.entries:
        assert entry.doi.startswith("10.1056/") and entry.external_key == entry.doi
        assert entry.url == f"https://doi.org/{entry.doi}"
        assert entry.facts["journal"] == "New England Journal of Medicine"
        assert entry.facts["issn"] == "0028-4793"
        assert entry.facts["crossref_type"] == "journal-article"
        assert entry.date_precision == "instant" and entry.published_at.tzinfo is not None
        assert entry.summary is None and entry.defects == ["no-summary"]  # NEJM deposits no abstracts
    first = next(e for e in output.entries if e.doi == "10.1056/nejmicm2609443")
    assert first.title == "Cerebral Schistosomiasis"
    assert first.published_at == datetime(2026, 9, 19, 11, 30, 30, tzinfo=timezone.utc)
    assert first.facts["author_count"] == 2


def test_rows_truncation_is_followed_by_cursor_paging():
    case = load_case("crossref-issn/frontiers-pharmacology-paging")
    first, second = case.results()
    assert json.loads(first.body)["message"]["total-results"] == 123
    page1 = ADAPTER.parse(first, case.source, case.now)
    assert len(page1.entries) == 100
    assert page1.next is not None
    assert query_param(page1.next.url, "cursor") == json.loads(first.body)["message"]["next-cursor"]
    page2 = ADAPTER.parse(second, case.source, case.now)
    assert len(page2.entries) == 23
    assert page2.next is None  # Crossref still sends a next-cursor on the last page; a short page ends the chain
    dois = {e.doi for e in page1.entries + page2.entries}
    assert len(dois) == 123
    assert sum(1 for e in page1.entries + page2.entries if e.summary) == 117


def test_three_page_chain_and_author_corrections():
    case = load_case("crossref-issn/nature-communications-notices")
    outputs = [ADAPTER.parse(r, case.source, case.now) for r in case.results()]
    assert [len(o.entries) for o in outputs] == [100, 100, 12]
    assert [o.next is not None for o in outputs] == [True, True, False]
    entries = [e for o in outputs for e in o.entries]
    notices = [e for e in entries if e.facts.get("is_correction_notice")]
    assert len(notices) == 13
    notice = next(e for e in notices if e.doi == "10.1038/s41467-026-77856-8")
    assert notice.title.startswith("Author Correction:")
    assert notice.facts["update_to"] == [{"type": "correction", "doi": "10.1038/s41467-022-34005-1", "date": "2026-09-21"}]
    trial = next(e for e in entries if e.doi == "10.1038/s41467-026-77714-7")
    assert trial.registry_ids == ["ISRCTN18097249"]  # read from the abstract: clusters the paper with its registration


def test_mastheads_and_corrigenda_are_flagged_not_dropped():
    case = load_case("crossref-issn/kidney-international-masthead")
    entries = entries_of(case)
    assert len(entries) == 34
    mastheads = sorted(e.title for e in entries if e.facts.get("is_masthead"))
    assert mastheads == ["Editorial Board", "Subscription Information", "Table of Contents", "in this issue"]
    assert all(e.facts["author_count"] == 0 for e in entries if e.facts.get("is_masthead"))
    corrigenda = [e for e in entries if e.facts.get("is_correction_notice")]
    assert len(corrigenda) == 3
    assert all(e.title.startswith("Corrigendum to") for e in corrigenda)
    assert {u["type"] for e in corrigenda for u in e.facts["update_to"]} == {"erratum"}
    assert not any(e.facts.get("is_masthead") for e in corrigenda)


def test_refused_select_is_named_not_swallowed():
    case = load_case("crossref-issn/select-refused")
    exchange = case.exchanges[0]
    assert exchange.result.status == 400 and exchange.error.detail == "http_400"
    with pytest.raises(FetchError) as raised:
        ADAPTER.parse(exchange.result, case.source, datetime.now(timezone.utc))
    assert raised.value.outcome == "http-error"
    assert raised.value.detail == "crossref_select_not_available"


def test_plan_windows_and_never_reuses_a_stored_cursor():
    case = load_case("crossref-issn/nejm")
    now = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
    first_contact = ADAPTER.plan(case.source, SourceState(None, None, None, None, None, {}), now)[0]
    assert "from-created-date:2026-09-15" in first_contact.url  # 7-day look-back
    incremental = ADAPTER.plan(case.source, SourceState(None, None, None, now - timedelta(hours=3), None,
                                                        {"cursor": "stale-cursor-from-an-old-poll"}), now)[0]
    assert "from-created-date:2026-09-21" in incremental.url  # last success minus the 1-day overlap
    assert query_param(incremental.url, "cursor") == "*"
    assert incremental.api is True and incremental.conditional is False
    assert query_param(incremental.url, "rows") == "100"


def test_plan_strips_refused_select_fields_and_validation_names_them():
    case = load_case("crossref-issn/nejm")
    source = case.source
    config = dict(source.config)
    config["url"] = config["url"].replace("select=DOI,", "select=subtype,language,DOI,")
    broken = replace(source, config=config)
    problems = ADAPTER.validate_config(broken)
    assert any("subtype" in p for p in problems) and any("language" in p for p in problems)
    url = ADAPTER.plan(broken, SourceState(None, None, None, None, None, {}), case.now)[0].url
    select = query_param(url, "select").split(",")
    assert "subtype" not in select and "language" not in select and "update-to" in select


def test_work_without_doi_or_title_is_skipped():
    case = load_case("crossref-issn/nejm")
    work = json.loads(case.results()[0].body)["message"]["items"][0]
    assert crossref_work_entry({**work, "title": []}, source=case.source) is None
    assert crossref_work_entry({**work, "DOI": ""}, source=case.source) is None
