"""``/text`` enrichment of journal, preprint and trial entries, replayed from recorded answers.

The rows are entries the adapters parsed out of recorded adapter cases (real DOIs, PMIDs, NCT ids);
``ReplayFetcher`` serves exactly the requests the code made when the case was recorded
(2026-09-22) and fails the test on any other request.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from knowledge_plugin.enrich import enrich_batch, kind_of
from knowledge_plugin.model import ENRICHMENT_TYPES, OPEN_ACCESS, TRIAL_FACT_TYPES
from replay import ReplayFetcher, load_case

ISO_ALPHA2 = re.compile(r"^[A-Z]{2}$")


def recorded_now(case):
    """The recording time: the clock the text rule's 5-day horizon is measured against in these tests."""
    return datetime.fromisoformat(case.provenance["recorded_at"])


async def run(name):
    case = load_case(name)
    fetcher = ReplayFetcher(case)
    results = await enrich_batch(case.rows, fetcher, None, now=recorded_now(case))
    return case, fetcher, {row.get("doi") or row["external_key"]: result for row, result in zip(case.rows, results, strict=True)}


def assert_contract_shape(result):
    assert result.status in ("available", "pending", "unavailable")
    assert set(result.enrichment) <= set(ENRICHMENT_TYPES)
    for key, value in result.enrichment.items():
        assert isinstance(value, ENRICHMENT_TYPES[key]), key
    if "open_access" in result.enrichment:
        assert result.enrichment["open_access"] in OPEN_ACCESS
    for code in result.enrichment.get("affiliation_countries", []):
        assert ISO_ALPHA2.match(code)
    for key, value in (result.enrichment.get("trial_facts") or {}).items():
        assert isinstance(value, TRIAL_FACT_TYPES[key])


async def test_journal_batch_shares_one_pubmed_round_trip():
    case, fetcher, results = await run("enrich/journal-batch")
    assert [kind_of(row) for row in case.rows] == ["article"] * 5
    # 11 recorded on 2026-09-22, 8 more by the paper text chain on 2026-10-22 (the case's ``extensions``)
    assert len(fetcher.calls) == len(case.exchanges) == 19  # nothing asked that was not asked when recorded
    urls = [url for _, url, _ in fetcher.calls]
    assert sum("esearch.fcgi" in u for u in urls) == 1 and sum("efetch.fcgi" in u for u in urls) == 1
    api_calls = [(url, source_id) for _, url, source_id in fetcher.calls
                 if not url.startswith(("http://www.nejm.org", "https://www.frontiersin.org"))]
    assert all(source_id is None for _, source_id in api_calls)  # API calls carry no source allowed_hosts
    for result in results.values():
        assert_contract_shape(result)

    rct = results["10.1056/nejmoa2605659"]
    assert (rct.status, rct.text_kind, rct.fetched_from) == ("available", "abstract", "pubmed")
    assert rct.abstract.startswith("BACKGROUND: Immune responses leading to food allergy")
    assert rct.fetched_at == datetime(2026, 9, 22, 9, 33, 14, tzinfo=timezone.utc)
    assert rct.enrichment["publication_types"] == ["Journal Article", "Randomized Controlled Trial", "Multicenter Study"]
    assert rct.enrichment["authors_short"] == "Palmer DJ, Campbell DE, Nanan R, et al."
    assert rct.enrichment["affiliation_countries"] == ["AU"]
    assert rct.enrichment["open_access"] == "closed"
    assert "Humans" in rct.enrichment["mesh"]

    image = results["10.1056/nejmicm2609443"]  # an NEJM Clinical Image: in PubMed, no abstract (yet)
    assert (image.status, image.text_kind) == ("pending", "none")  # the text rule: no abstract -> pending
    # Its landing page answered a challenge: an answer, recorded for the host, so the Perspective after it does not ask.
    assert image.retry_after_s == 12 * 3600
    assert image.notes == ["landing_challenge:direct", "landing_challenge", "indexed_without_abstract"]
    assert results["10.1056/nejmp2605442"].notes == ["landing_challenge_cached", "indexed_without_abstract"]
    assert image.enrichment["publication_types"] == ["Case Reports", "Journal Article"]
    assert image.enrichment["affiliation_countries"] == ["PH"]

    # Registered that day: its Crossref abstract, and — no index knowing it yet (Unpaywall 404, OpenAlex 404) — its
    # landing page, which states CC BY and carries the article: the whole text.
    frontiers = results["10.3389/fphar.2026.1852584"]
    assert (frontiers.status, frontiers.text_kind, frontiers.fetched_from) == ("available", "full", "landing")
    # Crossref's abstract was stored as one line (the entry's summary); the page says the same with its sections.
    assert frontiers.abstract.startswith("Background: This randomized controlled trial")
    assert "\nMethods: In this prospective randomized controlled trial" in frontiers.abstract
    # The page's abstract leads the whole text, its run-in headings read as sections (Frontiers writes them glued in
    # citation_abstract, "BackgroundThis …", and as <strong> runs in the page).
    assert frontiers.body_text.startswith("## Abstract\n\nBackground: This randomized controlled trial")
    assert "\n\n## 1 Introduction\n\n" in frontiers.body_text and "\n\n## 4.6 Conclusions\n\n" in frontiers.body_text
    assert "## References" not in frontiers.body_text
    assert frontiers.body_excerpt == frontiers.body_text[:len(frontiers.body_excerpt)] and len(frontiers.body_excerpt) <= 12_000
    # Unpaywall 404 (not tracked yet); OpenAlex: gold, and its PDF.
    assert frontiers.enrichment == {"open_access": "gold", "oa_pdf_url":
                                    "https://www.frontiersin.org/journals/pharmacology/articles/10.3389/fphar.2026.1852584/pdf"}

    trial = results["10.1056/nejmoa2604166"]
    assert trial.enrichment["trial_facts"]["status"]  # NCT03643276 from the record's DataBank, looked up
    assert "Clinical Trial, Phase III" in trial.enrichment["publication_types"]
    assert set(trial.enrichment["affiliation_countries"]) >= {"DE", "IT", "AU"}


async def test_crossref_abstract_for_a_feed_entry_with_a_doi():
    case, fetcher, results = await run("enrich/crossref-abstract")
    (result,) = results.values()
    assert case.rows[0]["source_access"] == "rss" and case.rows[0]["summary"] is None
    assert [url.split("?")[0] for _, url, _ in fetcher.calls] == [
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",        # PubMed: not indexed yet (no efetch)
        "https://www.ebi.ac.uk/europepmc/webservices/rest/search",           # Europe PMC: not there either
        "https://api.crossref.org/works/10.3389/fphar.2026.1747506",         # the publisher's JATS abstract
        "https://api.unpaywall.org/v2/10.3389/fphar.2026.1747506",           # 404: not tracked yet
        "https://api.openalex.org/works/doi:10.3389/fphar.2026.1747506",     # may be open, no PMC id: ask OpenAlex
        "https://doi.org/api/handles/10.3389/fphar.2026.1747506",            # where the landing page is
        "https://www.frontiersin.org/articles/10.3389/fphar.2026.1747506/full"]   # the page the handle names
    # The landing page states CC BY and carries the article: the whole text; the Crossref abstract stays the abstract.
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "full", "landing")
    # JATS sections are paragraphs "Title: text" (structured_abstract), not one run-on line.
    assert result.abstract.startswith("Background: Current guidelines advise against routine use of parenteral")
    assert "\n\nMethods: " in result.abstract or "\nMethods: " in result.abstract
    assert "<jats" not in result.abstract and "jats:" not in result.abstract
    # Unpaywall did not track it yet (404); OpenAlex did: gold, and its PDF.
    assert result.enrichment == {"journal": "Frontiers in Pharmacology", "open_access": "gold",
                                 "oa_pdf_url": "https://www.frontiersin.org/journals/pharmacology/articles/10.3389/fphar.2026.1747506/pdf"}
    assert result.fetched_at == datetime(2026, 9, 22, 9, 33, 54, tzinfo=timezone.utc)


async def test_preprints_go_to_europe_pmc_and_find_their_published_version():
    case, fetcher, results = await run("enrich/preprint-links")
    assert not any("eutils" in url for _, url, _ in fetcher.calls)  # PubMed does not index medRxiv
    fresh = results["10.64898/2026.09.18.26363418"]
    assert (fresh.status, fresh.text_kind, fresh.fetched_from) == ("available", "abstract", "europepmc")
    assert fresh.enrichment["publication_types"] == ["Preprint"] and fresh.enrichment["journal"] == "medRxiv"
    assert fresh.enrichment["open_access"] == "green"
    published = results["10.64898/2026.08.25.26361362"]
    assert published.enrichment["published_version_doi"] == "10.1371/journal.pgph.0007216"  # Europe PMC "Preprint of"
    for result in results.values():
        assert_contract_shape(result)


async def test_trial_entry_gets_registry_facts_and_its_description():
    case, fetcher, results = await run("enrich/trial")
    (result,) = results.values()
    assert kind_of(case.rows[0]) == "trial"
    (call,) = fetcher.calls
    assert call[1].startswith("https://clinicaltrials.gov/api/v2/studies/NCT07110077?fields=")
    assert result.status == "available" and result.text_kind == "excerpt"
    assert result.enrichment == {"trial_facts": {"phase": "NA", "status": "COMPLETED", "enrollment": 166,
                                                 "sponsor": "University of Buea"}}
    assert result.body_excerpt.startswith("PROBLEM STATEMENT Due to its limited inclusion")
    assert len(result.body_excerpt) <= 12_000
