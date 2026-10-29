"""The paper text chain (rt-papers, 2026-10-22), replayed from answers recorded through it.

Each case is a real DOI from the frontier feed's text gap (``/home/coder/evimed-wt/scratch-body/missing-dois.txt``) or a
known open article, recorded by ``tests/fixtures/record_enrich.py`` with the chain's own requests: PubMed, Europe PMC,
Crossref, Unpaywall (asked without a contact address: 422), OpenAlex, the DOI handle record, the landing page (asked as
``text/html``), Europe PMC's ``fullTextXML``. ``ReplayFetcher`` fails a test on any request that was not recorded.
"""

from __future__ import annotations

from datetime import datetime

from knowledge_plugin.enrich import enrich_batch, landing
from knowledge_plugin.model import FETCHED_FROM
from replay import ReplayFetcher, load_case


async def run(name: str):
    case = load_case(name)
    fetcher = ReplayFetcher(case)
    results = await enrich_batch(case.rows, fetcher, None, now=datetime.fromisoformat(case.provenance["recorded_at"]))
    return case, fetcher, {row["doi"]: result for row, result in zip(case.rows, results, strict=True)}


def urls(fetcher) -> list[str]:
    return [url.split("?")[0] for _, url, _ in fetcher.calls]


async def test_openalex_rebuilds_the_abstract_no_index_has():
    case, fetcher, results = await run("enrich/paper-openalex")
    (result,) = results.values()
    assert len(fetcher.calls) == len(case.exchanges)
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "abstract", "openalex")
    assert result.abstract.startswith("Objective To study the reliability and validity of the Chinese version")
    assert len(result.abstract) == 1643 and "\n" not in result.abstract      # the index keeps no paragraph breaks
    assert result.enrichment["open_access"] == "gold"
    # Elsevier's linkinghub forwards to ScienceDirect, which refuses us (403): the answer, never got round.
    assert urls(fetcher)[-1] == "https://linkinghub.elsevier.com/retrieve/pii/S1001929422000074"
    assert result.notes == ["landing_blocked:direct", "landing_challenge"]
    assert "fetched_from" not in result.notes and result.fetched_from in FETCHED_FROM


async def test_a_springer_landing_page_gives_its_structured_abstract():
    _, fetcher, results = await run("enrich/paper-landing-springer")
    (result,) = results.values()
    assert urls(fetcher)[-2:] == ["https://doi.org/api/handles/10.1007/s00228-026-04200-w",
                                  "https://link.springer.com/article/10.1007/s00228-026-04200-w"]
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "abstract", "landing")
    # dc.description is the plain abstract; the page's #Abs1-content says the same with its sections.
    paragraphs = result.abstract.split("\n")
    assert paragraphs[0].startswith("Purpose: Fospropofol disodium (fospropofol) is a water-soluble prodrug")
    assert [p.split(":")[0] for p in paragraphs] == ["Purpose", "Methods", "Results", "Conclusions"]
    assert result.body_text is None              # a closed article: its abstract, never more


async def test_nature_an_article_published_today_and_a_news_piece():
    _, fetcher, results = await run("enrich/paper-landing-nature")
    article = results["10.1038/s41467-026-78936-5"]
    assert (article.status, article.text_kind, article.fetched_from) == ("available", "abstract", "landing")
    assert article.abstract.startswith("The nuclear pore complex (NPC) governs selective nucleocytoplasmic exchange")
    # Open (CC BY-NC-ND) but published the same day: the page is the abstract and its back matter, no body yet.
    assert article.body_text is None
    news = results["10.1038/d41586-026-03374-8"]
    assert (news.status, news.text_kind, news.fetched_from) == ("available", "excerpt", "landing")
    assert news.body_excerpt.startswith("The drug improved the ability to focus")
    assert news.abstract is None
    # Both are provisional for PubMed's abstract only if they are an excerpt or a feed's: the article's abstract is not.
    assert article.retry_after_s is None and news.retry_after_s == 12 * 3600


async def test_a_challenge_is_an_answer_and_is_remembered_for_the_host():
    case, fetcher, results = await run("enrich/paper-challenge")
    (result,) = results.values()
    assert urls(fetcher)[-1] == "https://jamanetwork.com/journals/jama/fullarticle/2855688"
    assert (result.status, result.text_kind) == ("pending", "none")
    assert result.notes == ["landing_challenge:direct", "landing_challenge", "not_indexed_yet"]
    assert result.retry_after_s == 12 * 3600
    assert landing.VERDICTS.refused("jamanetwork.com", "direct")
    # The same host's next article does not ask its page again while the answer stands.
    again = ReplayFetcher(case)
    (second,) = await enrich_batch(case.rows, again, None, now=datetime.fromisoformat(case.provenance["recorded_at"]))
    assert not any("jamanetwork.com" in url for _, url, _ in again.calls)
    assert "landing_challenge_cached" in second.notes and second.status == "pending"


async def test_europe_pmc_full_text_of_an_open_pmc_article():
    _, fetcher, results = await run("enrich/paper-fulltext-epmc")
    (result,) = results.values()
    assert urls(fetcher)[-1] == "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10905822/fullTextXML"
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "full", "europepmc-fulltext")
    assert result.abstract.startswith("BACKGROUND: A variety of methods exist")      # PubMed's, kept
    body = result.body_text
    paragraphs = body.split("\n\n")
    titles = [p for p in paragraphs if p.startswith("## ")]
    # 43,261 characters with its abstract leading: over the contract's 40,000, so the abstract section (its own field
    # already) is given up, then the figure and table captions, and the whole article fits — its last section too.
    assert titles[:2] == ["## Introduction", "## Data and methods"]
    assert titles[-1] == "## Discussions and conclusions"
    assert not any(p.startswith(("Fig. ", "Table ")) for p in paragraphs)
    assert "full_text_over_limit" not in result.notes
    assert not any(p.startswith(("## References", "## Acknowledg", "## Funding")) for p in paragraphs)
    assert all(not p.startswith("## ") or "\n" not in p for p in paragraphs)
    assert len(body) <= 40_000 and result.body_excerpt == body[:len(result.body_excerpt)]
    assert len(result.body_excerpt) <= 12_000


async def test_an_open_cc_landing_page_gives_the_whole_text():
    _, fetcher, results = await run("enrich/paper-oa-landing")
    (result,) = results.values()
    assert (result.status, result.text_kind, result.fetched_from) == ("available", "full", "landing")
    titles = [p for p in result.body_text.split("\n\n") if p.startswith("## ")]
    # An opinion piece: no abstract of its own (Frontiers' citation_abstract holds its text, 8,467 characters, not an
    # abstract), so the whole text starts with its first section.
    assert titles == ["## Introduction", "## A rising and unevenly distributed burden", "## Where the care pathway is weakest",
                      "## What the evidence supports, and where", "## The role of sequencing: legitimate, but not a panacea",
                      "## Discussion", "## Conclusion"]
    assert "Keywords" not in result.body_text and "© 2026" not in result.body_text
    assert result.enrichment["open_access"] == "gold"
