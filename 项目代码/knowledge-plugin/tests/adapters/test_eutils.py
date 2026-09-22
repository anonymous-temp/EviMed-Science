"""eutils-query against recorded E-utilities answers (2026-09-22) and the plan's traps.

Traps covered: a misspelled ``datetype`` answers 200 with count 0 and the dates read as words
(recorded) → refused at config time and detected from ``querytranslation``; the history-server
chain never asks past ``count`` (efetch past the end is a 400) — it reads backwards from the end
of the window; DOIs/PMIDs/publication-type notices come from the records themselves.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.adapters.eutils import affiliation_country, parse_pubmed_xml
from knowledge_plugin.model import FetchError, SourceState
from replay import load_case

ADAPTER = REGISTRY["eutils-query"]


def test_esearch_then_one_efetch_page_for_a_small_window():
    case = load_case("eutils-query/rct-core-journals")
    search, fetch = case.results()
    first = ADAPTER.parse(search, case.source, case.now)
    assert first.entries == [] and first.next is not None  # a chain step, not an empty page
    assert query_param(first.next.url, "retstart") == "0" and query_param(first.next.url, "retmax") == "3"
    output = ADAPTER.parse(fetch, case.source, case.now)
    assert output.next is None
    by_pmid = {e.pmid: e for e in output.entries}
    assert sorted(by_pmid) == ["42748427", "42748428", "42748429"]
    trial = by_pmid["42748429"]
    assert trial.doi == "10.1056/nejmoa2605659"
    assert trial.url == "https://pubmed.ncbi.nlm.nih.gov/42748429/" and trial.external_key == "42748429"
    assert trial.title == "Trial of a Maternal Diet Rich in Eggs and Peanuts to Reduce Infant Allergy."
    assert trial.summary.startswith("BACKGROUND: Immune responses leading to food allergy")
    assert trial.published_at == datetime(2026, 9, 16, tzinfo=timezone.utc) and trial.date_precision == "day"
    assert trial.facts == {"journal": "The New England journal of medicine", "issn": "1533-4406", "author_count": 13}
    assert by_pmid["42748428"].registry_ids == ["NCT03643276"]  # from the record's DataBank / abstract


def test_backward_pages_cover_the_window_exactly_once():
    case = load_case("eutils-query/mendelian-randomization-backward-pages")
    assert json.loads(case.results()[0].body)["esearchresult"]["count"] == "90"
    starts = [(query_param(e.spec.url, "retstart"), query_param(e.spec.url, "retmax")) for e in case.exchanges[1:]]
    assert starts == [("75", "15"), ("50", "25"), ("25", "25"), ("0", "25")]
    pmids = []
    for result in case.results()[1:]:
        pmids += [e.pmid for e in ADAPTER.parse(result, case.source, case.now).entries]
    assert len(pmids) == 90 and len(set(pmids)) == 90


def test_the_window_is_capped_by_the_request_budget_and_says_so():
    case = load_case("eutils-query/mendelian-randomization-backward-pages")
    tight = replace(case.source, config={**case.source.config, "max_pages": 3})  # esearch + 2 efetch pages of 25
    output = ADAPTER.parse(case.results()[0], tight, case.now)
    assert "eutils_truncated count=90 read=50" in output.notes
    assert query_param(output.next.url, "retstart") == "25" and query_param(output.next.url, "retmax") == "25"


def test_electronic_date_beats_a_later_entrez_date():
    case = load_case("eutils-query/mendelian-randomization-backward-pages")
    records = [r for result in case.results()[1:] for r in parse_pubmed_xml(result.body)]
    record = next(r for r in records if r["pmid"] == "42738853")
    assert record["article_date"] == datetime(2026, 8, 28, tzinfo=timezone.utc)
    assert record["entrez_date"] > record["article_date"]
    entries = [e for result in case.results()[1:] for e in ADAPTER.parse(result, case.source, case.now).entries]
    entry = next(e for e in entries if e.pmid == "42738853")
    assert entry.published_at == datetime(2026, 8, 28, tzinfo=timezone.utc)  # not today's news: the 72-h rule places it in August


def test_retraction_stream_flags_notices():
    case = load_case("eutils-query/retractions")
    assert "mindate=2026/09/20" in case.exchanges[0].spec.url  # incremental: last success (09-21) minus one day
    entries = ADAPTER.parse(case.results()[1], case.source, case.now).entries
    assert len(entries) == 2
    assert all(e.facts.get("is_correction_notice") for e in entries)
    assert all(e.title.startswith("Expression of Concern:") for e in entries)


def test_a_misspelled_datetype_is_caught_twice():
    case = load_case("eutils-query/datetype-misspelled")
    answer = json.loads(case.results()[0].body)["esearchresult"]
    assert answer["count"] == "0" and '"2026/09/15"[All Fields]' in answer["querytranslation"]
    with pytest.raises(FetchError) as raised:
        ADAPTER.parse(case.results()[0], case.source, case.now or datetime.now(timezone.utc))
    assert raised.value.detail == "eutils_window_not_applied"
    source = case.source
    broken = replace(source, config={**source.config, "datetype": "edta",
                                     "url": source.config["url"].replace("datetype=edat", "datetype=edta")})
    assert any("datetype" in p for p in ADAPTER.validate_config(broken))
    with pytest.raises(ValueError):
        ADAPTER.plan(broken, SourceState(None, None, None, None, None, {}), datetime.now(timezone.utc))


def test_plan_puts_the_search_on_the_history_server():
    case = load_case("eutils-query/rct-core-journals")
    url = ADAPTER.plan(case.source, case.state, case.now)[0].url
    assert query_param(url, "usehistory") == "y" and query_param(url, "retmax") == "0"
    assert query_param(url, "datetype") == "edat"
    for credential in ("api_key", "email", "tool"):
        assert query_param(url, credential) is None  # the fetcher adds them per host


def test_affiliation_countries_are_iso_codes_from_a_closed_table():
    assert affiliation_country("Department of Oncology, Peking University, Beijing, China.") == "CN"
    assert affiliation_country("Harvard Medical School, Boston, MA 02115, USA. Electronic address: x@y.org") == "US"
    assert affiliation_country("Charité, Berlin, Germany") == "DE"
    assert affiliation_country("Hong Kong SAR") == "HK"
    assert affiliation_country("Some Institute, Atlantis") is None  # unknown names are dropped, never guessed
    case = load_case("eutils-query/rct-core-journals")
    record = next(r for r in parse_pubmed_xml(case.results()[1].body) if r["pmid"] == "42748429")
    assert record["affiliation_countries"] == ["AU"]
