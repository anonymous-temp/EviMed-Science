"""PubMed by DOI: the ``[doi]`` over-return trap and its two defences, on recorded answers.

Both cases search the same 40 DOIs — the 2026-09-21 dry run's batch 37, which unquoted named 200
PMIDs of which 175 carried a DOI nobody asked for. Re-asked on 2026-09-22: the dry run's unquoted
form (``pubmed-doi-unquoted``) matched 285 records, and 15 of the first 40 carry foreign DOIs
(Elsevier article numbers such as ``…2026.100446``); the quoted form ``esearch_url`` builds
(``pubmed-doi-realign``) matched exactly the 25 indexed ones. ``realign`` drops the rest anyway.
"""

from __future__ import annotations

import json

from knowledge_plugin.adapters.eutils import parse_pubmed_xml
from knowledge_plugin.enrich import pubmed as pubmed_step
from knowledge_plugin.enrich.common import Endpoints, Trace
from replay import ReplayFetcher, load_case


def test_the_unquoted_search_over_returns_and_realign_drops_it():
    case = load_case("enrich/pubmed-doi-unquoted")
    asked = case.provenance["dois"]
    search = json.loads(case.exchanges[0].result.body)["esearchresult"]
    assert int(search["count"]) == 285 and len(asked) == 40
    records = parse_pubmed_xml(case.exchanges[1].result.body)
    assert len(records) == 40
    foreign = [r for r in records if r["doi"] not in asked]
    assert len(foreign) == 15
    assert ("42668520", "10.1016/j.fochms.2026.100446") in [(r["pmid"], r["doi"]) for r in foreign]
    keyed, dropped = pubmed_step.realign(records, dois=asked, pmids=[])
    assert dropped == 15
    assert {key[4:] for key in keyed} <= set(asked) and len(keyed) == 25


async def test_the_quoted_search_asks_exactly_and_lookup_keys_by_doi():
    case = load_case("enrich/pubmed-doi-realign")
    asked = case.provenance["dois"]
    assert case.exchanges[0].spec.url == pubmed_step.esearch_url(Endpoints(), sorted({d.lower() for d in asked}))
    assert "%2210.1542%2Fpeds.2026-077055%22%5Bdoi%5D" in case.exchanges[0].spec.url  # "<doi>"[doi]
    trace = Trace()
    records = await pubmed_step.lookup(ReplayFetcher(case), Endpoints(), dois=asked, pmids=[], trace=trace)
    assert len(records) == 25 and trace.notes == []
    assert all(key.startswith("doi:") and key[4:] in asked for key in records)
    record = records[sorted(records)[0]]
    assert record["fetched_at"] is not None and record["publication_types"]


def test_enrichment_values_of_a_record():
    case = load_case("enrich/pubmed-doi-realign")
    records = parse_pubmed_xml(case.exchanges[1].result.body)
    values = pubmed_step.record_enrichment(records[0])
    assert set(values) <= {"publication_types", "mesh", "journal", "authors_short", "affiliation_countries"}
    assert all(len(code) == 2 and code.isupper() for code in values.get("affiliation_countries", []))


async def test_europe_pmc_bare_answer_is_transient_in_enrichment_too():
    from knowledge_plugin.enrich import europepmc as europepmc_step

    fault = load_case("europepmc/hitcount-probe").exchanges[0].result  # the recorded {"version":"6.9"}

    class FaultFetcher:  # serves that recorded answer to whatever Europe PMC query is asked
        async def fetch(self, spec, **_):
            assert spec.url.startswith("https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI%3A")
            return fault

    trace = Trace()
    found = await europepmc_step.by_dois(FaultFetcher(), Endpoints(), ["10.3389/fphar.2026.1747506"], trace)
    assert found == {} and trace.transient is True
    assert trace.notes == ["europepmc_doi_http-error:europepmc_missing_hitcount"]
