"""A top journal's research paper waits longer and is asked on a decaying schedule (c3-primary, 2026-10-25).

The held items it is measured on are the NEJM, Lancet, JAMA and Gastroenterology papers of ``enrich/paper-primaries`` (recorded
on 2026-10-25 through the chain itself) and the feeds of ``enrich/paper-feeds-c3``; the rest is the rule on scripted answers.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from replay import ReplayFetcher, load_case

from knowledge_plugin import text_policy
from knowledge_plugin.budget import HostBudget, HostRule, MemoryCounterStore
from knowledge_plugin.enrich import apply_text_rule, enrich_batch, feeds
from knowledge_plugin.enrich.common import Trace
from knowledge_plugin.model import EntryTextResult, FetchError, FetchResult, RequestSpec

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)


def row(authority=5, source_type="journal", doi="10.1056/nejmoa0000001", age_days=1.0, **extra):
    return {"source_type": source_type, "source_authority": authority, "doi": doi, "pmid": None,
            "first_seen_at": NOW - timedelta(days=age_days), "attempts": 3, **extra}


def pending(*notes, retry=12 * 3600, **enrichment):
    return EntryTextResult(status="pending", retry_after_s=retry, notes=list(notes), enrichment=enrichment)


# ------------------------------------------------------------------------------------ who, how long, how often

def test_a_candidate_is_a_top_journal_paper_pubmed_has_not_typed_as_something_without_an_abstract():
    assert text_policy.is_primary_candidate(row())
    assert text_policy.is_primary_candidate(row(authority=4))
    assert not text_policy.is_primary_candidate(row(authority=3))
    assert not text_policy.is_primary_candidate(row(source_type="media"))
    assert not text_policy.is_primary_candidate(row(doi=None))
    assert text_policy.is_primary_candidate(row(doi=None, pmid="123"))
    assert not text_policy.is_primary_candidate(row(known_publication_types=["Journal Article", "Editorial"]))
    assert not text_policy.is_primary_candidate(row(), ["Letter"])            # what this attempt learned
    assert text_policy.is_primary_candidate(row(known_publication_types=["Journal Article"]))
    assert text_policy.is_primary_candidate(row(known_publication_types=None), None)


def test_the_cadence_decays_with_the_age_of_the_entry():
    day = 86400
    assert [text_policy.retry_delay_s(age) for age in (0, 11 * 3600, 13 * 3600, 47 * 3600, 3 * day, 6 * day, 8 * day, 20 * day)] \
        == [3600, 3600, 3 * 3600, 3 * 3600, 8 * 3600, 8 * 3600, day, day]
    assert text_policy.horizon(row(), timedelta(days=14)) == timedelta(days=21)
    assert text_policy.horizon(row(authority=2), timedelta(days=14)) == timedelta(days=14)


@pytest.mark.parametrize("age_days, retry", [(0.2, 3600), (1.5, 3 * 3600), (4, 8 * 3600), (10, 24 * 3600), (20, 24 * 3600)])
def test_a_candidate_is_asked_on_the_schedule_instead_of_every_twelve_hours(age_days, retry):
    result = apply_text_rule(row(age_days=age_days), pending("not_indexed_yet"), NOW)
    assert (result.status, result.retry_after_s) == ("pending", retry)


def test_a_candidate_is_not_given_up_at_fourteen_days_but_at_twenty_one():
    assert apply_text_rule(row(age_days=15), pending("indexed_without_abstract"), NOW).status == "pending"
    given_up = apply_text_rule(row(age_days=22), pending("indexed_without_abstract"), NOW)
    assert given_up.status == "unavailable" and "text_horizon_passed" in given_up.notes
    assert apply_text_rule(row(age_days=21.5), pending("not_indexed_yet"), NOW).status == "unavailable"


def test_the_others_keep_the_fourteen_days_and_the_twelve_hours():
    for other in (row(authority=3, age_days=10), row(age_days=10, known_publication_types=["Editorial"])):
        assert apply_text_rule(other, pending("not_indexed_yet"), NOW).retry_after_s == 12 * 3600
    for other in (row(authority=3, age_days=15), row(age_days=15, known_publication_types=["News"])):
        assert apply_text_rule(other, pending("not_indexed_yet"), NOW).status == "unavailable"
    # PubMed typed it in this very attempt
    assert apply_text_rule(row(age_days=15), pending("indexed_without_abstract", publication_types=["Letter"]), NOW).status == "unavailable"


def test_a_final_pubmed_record_without_an_abstract_ends_the_extension():
    final = apply_text_rule(row(age_days=15), pending("indexed_without_abstract", "pubmed_record_complete"), NOW)
    assert final.status == "unavailable"
    assert apply_text_rule(row(age_days=10), pending("indexed_without_abstract", "pubmed_record_complete"), NOW).retry_after_s == 12 * 3600


def test_a_failed_ask_is_repeated_soon_and_is_not_an_answer():
    result = apply_text_rule(row(age_days=10), pending("europepmc_doi_http-error:http_503", "not_indexed_yet", retry=3600), NOW)
    assert (result.status, result.retry_after_s) == ("pending", 3600)


def test_a_provisional_text_is_upgraded_on_the_schedule_too():
    teaser = EntryTextResult(status="available", text_kind="abstract", abstract="x" * 300, fetched_from="publisher-feed",
                             retry_after_s=12 * 3600)
    assert apply_text_rule(row(age_days=10), teaser, NOW).retry_after_s == 24 * 3600
    assert apply_text_rule(row(age_days=2.5), teaser, NOW).retry_after_s == 8 * 3600
    assert apply_text_rule(row(age_days=10, source_authority=2), teaser, NOW).retry_after_s == 12 * 3600


# ------------------------------------------------------------------------------------ a feed's own summary

@pytest.mark.parametrize("text, expected", [
    ("Chronic constipation is common.1,2 It limits assessment of temporality.5,6", "Chronic constipation is common.1,2 It limits assessment of temporality."),
    ("Insulinomas may be undetectable on CT imaging.3", "Insulinomas may be undetectable on CT imaging."),
    ("Prevalence ranges from 0.2% to 13% of the population.1–3", "Prevalence ranges from 0.2% to 13% of the population."),
    ("Result sentence.\nHOW THIS STUDY MIGHT AFFECT RESEARCH, PRACTICE OR POLICY", "Result sentence."),
    ("A dose of 12.5", "A dose of 12.5"),                                   # a decimal is not a reference mark
    ("keywords run together", "keywords run together"),
])
def test_a_feed_text_is_read_without_its_reference_marks_and_a_closing_heading(text, expected):
    assert feeds.without_tail(text) == expected


async def feed_item(doi, url):
    fetcher = ReplayFetcher(load_case("enrich/paper-feeds-c3"))
    trace = Trace()
    found = await feeds.feed_text(fetcher, {"source_id": "j-test", "source_egress": "direct", "source_config": {"abstract_feed": url}},
                                  doi, trace, cache=feeds.FeedCache())
    return found, trace


async def test_gastroenterologys_opening_paragraph_counts_though_its_last_words_are_reference_numbers():
    (kind, text), _ = await feed_item("10.1053/j.gastro.2026.09.022", "https://www.gastrojournal.org/inpress.rss")
    assert kind == "abstract" and text.startswith("Chronic constipation affects approximately 14% of adults worldwide")
    assert text.endswith("limiting assessment of temporality.") and len(text) >= 200


async def test_mayo_clinic_proceedings_letter_counts_too():
    (kind, text), _ = await feed_item("10.1016/j.mayocp.2026.09.020", "https://www.mayoclinicproceedings.org/inpress.rss")
    assert kind == "abstract" and text.startswith("To the Editor: Pancreatic neuroendocrine tumors") and text.endswith("CT imaging.")


async def test_guts_key_points_box_loses_its_closing_heading():
    (kind, text), _ = await feed_item("10.1136/gutjnl-2025-337845", "https://gut.bmj.com/rss/ahead.xml")
    assert kind == "abstract" and text.startswith("WHAT IS ALREADY KNOWN ON THIS TOPIC")
    assert not text.rstrip().endswith("POLICY") and text.rstrip().endswith(".")


async def test_a_subject_label_is_still_nothing():
    found, trace = await feed_item("10.1001/jamanetworkopen.2026.32903", "https://jamanetwork.com/rss/site_214/187.xml")
    assert found is None and trace.notes == ["feed_item_without_text"]


# ------------------------------------------------------------------------------------ the held papers, end to end

async def held_papers():
    case = load_case("enrich/paper-primaries")
    fetcher = PriorityFetcher(case)
    results = await enrich_batch(case.rows, fetcher, None, now=datetime.fromisoformat(case.provenance["recorded_at"]))
    return fetcher, {r["doi"]: result for r, result in zip(case.rows, results, strict=True)}


class PriorityFetcher(ReplayFetcher):
    def __init__(self, *cases):
        super().__init__(*cases)
        self.priorities: list[tuple[str, str]] = []

    async def fetch(self, spec, **kwargs):
        self.priorities.append((spec.url.split("/")[2], spec.priority))
        return await super().fetch(spec, **kwargs)


@pytest.fixture(autouse=True)
def single_file(monkeypatch):
    """The recorded cases ran their entries one at a time."""
    from knowledge_plugin import enrich as enrich_module

    monkeypatch.setattr(enrich_module, "ENTRY_CONCURRENCY", 1)


async def test_nejms_tarlatamab_trial_gets_the_abstract_openalex_has_a_day_after_first_sight():
    fetcher, results = await held_papers()
    trial = results["10.1056/nejmoa2609482"]
    assert (trial.status, trial.text_kind, trial.fetched_from) == ("available", "abstract", "openalex")
    assert trial.abstract.startswith("BackgroundPatients with extensive-stage small-cell lung cancer have poor outcomes")
    assert len(trial.abstract) == 2389 and trial.retry_after_s is None      # an index's abstract is final


async def test_the_nejm_letter_has_its_opening_as_text():
    _, results = await held_papers()
    letter = results["10.1056/nejmc2609433"]
    assert (letter.status, letter.fetched_from) == ("available", "openalex") and letter.abstract.startswith("To the Editor: Regarding the OPTIMAL")


async def test_the_lancet_comment_and_the_jama_trial_stay_pending_on_the_schedule_not_the_old_cadence():
    _, results = await held_papers()
    lancet, jama = results["10.1016/s0140-6736(26)02046-5"], results["10.1001/jama.2026.16509"]
    for result in (lancet, jama):
        assert result.status == "pending" and "indexed_without_abstract" in result.notes and "pubmed_record_complete" not in result.notes
    assert lancet.retry_after_s == 8 * 3600            # two days old: every eight hours
    assert jama.retry_after_s == 24 * 3600             # eleven days old: daily


async def test_gastroenterologys_cohort_is_text_from_its_journal_s_feed_and_asked_again_for_the_index_abstract():
    _, results = await held_papers()
    cohort = results["10.1053/j.gastro.2026.09.022"]
    assert (cohort.status, cohort.text_kind, cohort.fetched_from) == ("available", "abstract", "publisher-feed")
    assert cohort.abstract.endswith("limiting assessment of temporality.") and cohort.retry_after_s == 8 * 3600


async def test_every_pubmed_and_europe_pmc_lookup_for_these_papers_is_a_high_priority_request():
    fetcher, _ = await held_papers()
    index = [priority for host, priority in fetcher.priorities if host in ("eutils.ncbi.nlm.nih.gov", "www.ebi.ac.uk")]
    assert index and set(index) == {"high"}
    others = [priority for host, priority in fetcher.priorities if host not in ("eutils.ncbi.nlm.nih.gov", "www.ebi.ac.uk")]
    assert set(others) == {"normal"}


class Stub:
    """Answers every request with an empty search; remembers who asked as what."""

    def __init__(self, fail_hosts=()):
        self.asked: list[tuple[str, str, str]] = []
        self.fail_hosts = set(fail_hosts)

    async def fetch(self, spec: RequestSpec, **kwargs):
        host = spec.url.split("/")[2]
        self.asked.append((host, spec.url, spec.priority))
        if host in self.fail_hosts:
            raise FetchError("http-error", "http_503", status=503)
        body = {"eutils.ncbi.nlm.nih.gov": b'{"esearchresult": {"idlist": []}}',
                "www.ebi.ac.uk": b'{"hitCount": 0, "resultList": {"result": []}}'}.get(host, b"{}")
        return FetchResult(request=spec, final_url=spec.url, status=200, headers={}, body=body, fetched_at=NOW)


async def test_a_mixed_batch_asks_the_indexes_once_for_the_top_journals_and_once_for_the_rest():
    stub = Stub()
    rows = [{**row(doi="10.1056/nejmoa1"), "source_id": "a", "source_access": "crossref-issn", "source_egress": "direct"},
            {**row(authority=2, doi="10.1234/low.2"), "source_id": "b", "source_access": "crossref-issn", "source_egress": "direct"}]
    await enrich_batch(rows, stub, None, now=NOW)
    searches = [(url, priority) for host, url, priority in stub.asked if host == "eutils.ncbi.nlm.nih.gov" and "esearch" in url]
    assert len(searches) == 2
    high = [u for u, p in searches if p == "high"]
    assert len(high) == 1 and "nejmoa1" in high[0] and "low.2" not in high[0]
    assert any(p == "normal" and "low.2" in u for u, p in searches)
    epmc = [(url, priority) for host, url, priority in stub.asked if host == "www.ebi.ac.uk"]
    assert sorted(p for _, p in epmc) == ["high", "normal"]


async def test_a_503_from_the_indexes_is_a_retry_in_an_hour_and_never_not_indexed_yet_for_good():
    stub = Stub(fail_hosts={"www.ebi.ac.uk", "eutils.ncbi.nlm.nih.gov"})
    rows = [{**row(doi="10.1056/nejmoa1", age_days=16), "source_id": "a", "source_access": "crossref-issn", "source_egress": "direct"}]
    (result,) = await enrich_batch(rows, stub, None, now=NOW)
    assert result.status == "pending" and result.retry_after_s == 3600
    assert any("http_503" in note for note in result.notes)


# ------------------------------------------------------------------------------------ the host's daily cap

async def test_a_fifth_of_a_daily_cap_is_kept_for_the_high_priority_requests():
    store = MemoryCounterStore()
    budget = HostBudget(store, {"eutils.ncbi.nlm.nih.gov": HostRule(0.0, 10, reserved=0.2)}, clock=lambda: NOW,
                        monotonic=lambda: 0.0, sleep=_no_sleep)
    host = "eutils.ncbi.nlm.nih.gov"
    for _ in range(8):
        async with budget.slot(host):
            pass
    with pytest.raises(FetchError) as refused:
        async with budget.slot(host):
            pass
    assert (refused.value.outcome, refused.value.detail) == ("host-budget", "daily_cap")
    for _ in range(2):
        async with budget.slot(host, priority="high"):
            pass
    with pytest.raises(FetchError):
        async with budget.slot(host, priority="high"):
            pass
    usage = await budget.usage()
    assert usage[host] == {"used": 10, "cap": 10}


async def _no_sleep(seconds):
    return None


@pytest.mark.parametrize("outcome, detail, status, transient", [
    ("http-error", "http_503", 503, True), ("http-error", "http_500", 500, True), ("http-error", "rate_limited_429", 429, True),
    ("http-error", "http_408", 408, True), ("timeout", "timeout", None, True), ("host-budget", "daily_cap", None, True),
    ("http-error", "connect_failed", None, True), ("http-error", "europepmc_missing_hitcount", 200, True),
    ("http-error", "http_422", 422, False), ("http-error", "http_404", 404, False), ("http-error", "http_400", 400, False),
    ("challenge", "cloudflare", 403, False), ("blocked", "http_403", 403, False),
])
def test_a_5xx_is_a_failed_ask_to_repeat_and_another_4xx_is_the_host_s_answer(outcome, detail, status, transient):
    from knowledge_plugin.enrich.common import Attempt

    assert Attempt(error=FetchError(outcome, detail, status=status)).transient is transient
