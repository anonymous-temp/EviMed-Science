"""Route order, bounds and provenance of automatic full-text retrieval (offline)."""
import logging
from pathlib import Path

import pytest

from fulltext_http_fixture import (
    FakeResponse,
    FakeWeb,
    cloudflare_403,
    epmc_search,
    html,
    jats_xml,
    not_found,
    pdf,
)
from new_meta.agents.paper_retriever import PaperRetriever
from new_meta.core.project import Project
from new_meta.tools import fulltext_retrieval, multi_search, pdf_downloader
from new_meta.tools.fulltext_retrieval import retrieve_paper_text
from new_meta.tools.pdf_downloader import HostMemo, PaperBudget

EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
OPENALEX = "https://api.openalex.org/works/doi:"
UNPAYWALL = "https://api.unpaywall.org/v2/"
HANDLES = "https://doi.org/api/handles/"
SECRET_EMAIL = "operator-contact@hospital.example"


@pytest.fixture
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(pdf_downloader.requests, "get", fake.get)
    monkeypatch.setattr(fulltext_retrieval, "SCIHUB_ENABLED", False)
    return fake


def _handle(target):
    return FakeResponse(200, json_data={"values": [{"type": "URL", "data": {"value": target}}]})


def _long_abstract_record(**extra):
    record = {
        "pmid": "900",
        "title": "Tranexamic acid in total knee arthroplasty",
        "abstractText": "Blood loss outcome. " * 60,
    }
    record.update(extra)
    return record


def test_pmc_paper_uses_europe_pmc_xml_before_any_pdf(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search({"pmid": "27760536", "pmcid": "PMC5069893"})
    web.routes["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC5069893/fullTextXML"] = jats_xml()
    paper = {"pmid": "27760536", "doi": "10.1186/s12891-016-1293-3"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo())

    assert paper["fulltext_route"] == "europe_pmc_xml"
    assert paper["fulltext_source"] == "europe_pmc_fulltext"
    assert paper["text_availability"] == "full_text"
    assert paper["pmcid"] == "PMC5069893"
    assert "SOURCE: Europe PMC fullTextXML" in Path(paper["fulltext_path"]).read_text(encoding="utf-8")
    # the Europe PMC lookup pins the MEDLINE record, then goes straight to XML
    assert "SRC:MED" in web.calls[0]
    assert len(web.calls) == 2
    assert paper["fulltext_attempts"][-1]["outcome"] == "text"


def test_europe_pmc_render_pdf_when_xml_is_missing(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search({"pmid": "1", "pmcid": "PMC1"})
    web.routes["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML"] = not_found()
    web.routes["https://europepmc.org/articles/PMC1?pdf=render"] = pdf()
    paper = {"pmid": "1"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo())

    assert paper["fulltext_route"] == "europe_pmc_pdf"
    assert paper["fulltext_source"] == "pdf"
    assert Path(paper["pdf_path"]).read_bytes().startswith(b"%PDF")
    assert not any("ncbi.nlm.nih.gov" in call for call in web.calls)


def test_openalex_extensionless_pdf_url_is_used(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(None)
    web.routes[OPENALEX] = FakeResponse(200, json_data={
        "open_access": {"oa_url": "https://www.mdpi.com/1648-9144/60/12/1964/pdf?version=1"},
        "best_oa_location": {"is_oa": True, "pdf_url": "https://www.mdpi.com/1648-9144/60/12/1964/pdf?version=1",
                             "landing_page_url": "https://doi.org/10.3390/medicina60121964"},
        "locations": [{"is_oa": False, "landing_page_url": "https://pubmed.ncbi.nlm.nih.gov/39768845"}],
    })
    web.routes["https://www.mdpi.com/1648-9144/60/12/1964/pdf"] = pdf()
    paper = {"doi": "10.3390/medicina60121964"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email="")

    assert paper["fulltext_route"] == "openalex_pdf"
    assert not web.hosts_called("pubmed.ncbi")


def test_openalex_helpers_read_every_location_and_the_pmcid() -> None:
    work = {
        "ids": {"pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/4130961"},
        "open_access": {"oa_url": "https://www.bmj.com/content/349/bmj.g4829"},
        "best_oa_location": {"is_oa": True, "pdf_url": "https://www.bmj.com/content/bmj/349/bmj.g4829.full.pdf",
                             "landing_page_url": "https://doi.org/10.1136/bmj.g4829"},
        "primary_location": {"is_oa": True, "pdf_url": None, "landing_page_url": "https://www.bmj.com/content/349/bmj.g4829"},
        "locations": [
            {"is_oa": True, "pdf_url": "https://repo.example/bmj.pdf", "landing_page_url": "https://repo.example/record/1"},
            {"is_oa": True, "pdf_url": None, "landing_page_url": "https://www.ncbi.nlm.nih.gov/pmc/articles/4130961"},
            {"is_oa": False, "pdf_url": None, "landing_page_url": "https://pubmed.ncbi.nlm.nih.gov/25116268"},
        ],
    }

    assert multi_search._openalex_pdf_urls(work) == [
        "https://www.bmj.com/content/bmj/349/bmj.g4829.full.pdf",
        "https://repo.example/bmj.pdf",
    ]
    assert multi_search._openalex_landing_urls(work) == [
        "https://www.bmj.com/content/349/bmj.g4829",
        "https://repo.example/record/1",
    ]
    assert multi_search._openalex_pmcid(work) == "PMC4130961"


def test_openalex_pmcid_sends_paper_back_to_europe_pmc_xml(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search({"pmid": "5"})
    web.routes[OPENALEX] = FakeResponse(200, json_data={"ids": {"pmcid": "https://www.ncbi.nlm.nih.gov/pmc/articles/77"}})
    web.routes["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC77/fullTextXML"] = jats_xml()
    paper = {"pmid": "5", "doi": "10.1000/x"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email="")

    assert paper["fulltext_route"] == "europe_pmc_xml"
    assert paper["pmcid"] == "PMC77"


def test_unpaywall_is_skipped_without_an_email(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(None)
    paper = {"doi": "10.1000/closed"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email="")

    assert not web.hosts_called("api.unpaywall.org")
    assert paper["fulltext_route"] == "none"
    assert paper["pdf_path"] is None and paper["fulltext_path"] is None


def test_unpaywall_pdf_then_landing_with_email_never_logged(web, tmp_path, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    web.routes[EPMC_SEARCH] = epmc_search(None)
    web.routes[UNPAYWALL] = FakeResponse(200, json_data={
        "best_oa_location": {"url_for_pdf": "https://repo.example/blocked.pdf",
                             "url_for_landing_page": "https://repo.example/record/9"},
        "oa_locations": [
            {"url_for_pdf": "https://repo.example/blocked.pdf", "url_for_landing_page": "https://repo.example/record/9"},
            {"url_for_pdf": None, "url_for_landing_page": "https://journal.example/article/9"},
        ],
    })
    web.routes["https://repo.example/blocked.pdf"] = FakeResponse(404)
    web.routes["https://repo.example/record/9"] = html("<html><head></head><body>no pdf here</body></html>")
    web.routes["https://journal.example/article/9"] = html(
        '<head><meta name="citation_pdf_url" content="/article/9.pdf"></head>'
    )
    web.routes["https://journal.example/article/9.pdf"] = pdf()
    paper = {"doi": "10.1000/oa"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email=SECRET_EMAIL)

    assert paper["fulltext_route"] == "oa_landing+citation_pdf_url"
    unpaywall_calls = web.hosts_called("api.unpaywall.org")
    assert len(unpaywall_calls) == 1 and "10.1000/oa" in unpaywall_calls[0]
    assert SECRET_EMAIL not in caplog.text
    assert all(SECRET_EMAIL not in str(attempt) for attempt in paper["fulltext_attempts"])


def test_unpaywall_failure_logs_no_email(monkeypatch, caplog) -> None:
    caplog.set_level(logging.DEBUG)

    def boom(url, params=None, **kwargs):
        raise RuntimeError(f"Connection refused: {url}?email={params['email']}")

    monkeypatch.setattr(fulltext_retrieval.requests, "get", boom)

    assert fulltext_retrieval.get_unpaywall_locations("10.1/x", SECRET_EMAIL)["pdf_urls"] == []
    assert SECRET_EMAIL not in caplog.text


def test_doi_landing_citation_pdf_url(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(None)
    web.routes[HANDLES] = _handle("https://link.springer.com/10.1186/s1")
    web.routes["https://link.springer.com/10.1186/s1"] = html(
        '<meta name="citation_pdf_url" content="https://link.springer.com/content/pdf/10.1186/s1.pdf">',
        url="https://link.springer.com/article/10.1186/s1",
    )
    web.routes["https://link.springer.com/content/pdf/10.1186/s1.pdf"] = pdf()
    paper = {"doi": "https://doi.org/10.1186/s1"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email="")

    assert paper["fulltext_route"] == "doi+citation_pdf_url"
    assert paper["fulltext_source"] == "pdf"


def test_bot_walled_publisher_is_asked_once_per_run(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(None)
    web.routes[HANDLES] = lambda url: _handle("https://www.sciencedirect.com/science/article/pii/" + url.rsplit("/", 1)[-1])
    web.routes["https://www.sciencedirect.com/"] = cloudflare_403()
    memo = HostMemo()

    first = {"doi": "10.1016/a"}
    second = {"doi": "10.1016/b"}
    retrieve_paper_text(first, tmp_path, memo=memo, unpaywall_email="")
    retrieve_paper_text(second, tmp_path, memo=memo, unpaywall_email="")

    assert len(web.hosts_called("sciencedirect.com")) == 1
    assert second["fulltext_attempts"][-1]["outcome"] == "skipped_bot_wall_403"
    assert second["fulltext_route"] == "none"


def test_ncbi_pmc_is_last_resort_and_blocked_after_one_answer(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = lambda url: epmc_search({"pmid": url.split("EXT_ID:")[1].split(" ")[0], "pmcid": "PMC" + url.split("EXT_ID:")[1].split(" ")[0]})
    web.routes["https://www.ebi.ac.uk/europepmc/webservices/rest/"] = not_found()
    web.routes["https://europepmc.org/"] = cloudflare_403()
    web.routes["https://pmc.ncbi.nlm.nih.gov/"] = cloudflare_403()
    memo = HostMemo()

    papers = [{"pmid": str(n)} for n in (11, 12, 13)]
    for paper in papers:
        retrieve_paper_text(paper, tmp_path, memo=memo, unpaywall_email="")

    assert len(web.hosts_called("pmc.ncbi.nlm.nih.gov")) == 1
    assert len(web.hosts_called("europepmc.org/articles")) == 1
    routes = [a["route"] for a in papers[0]["fulltext_attempts"]]
    assert routes.index("ncbi_pmc_pdf") > routes.index("europe_pmc_pdf")
    assert set(memo.snapshot()) == {"europepmc.org", "pmc.ncbi.nlm.nih.gov"}


def test_retrieval_respects_the_per_paper_attempt_cap(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(None)
    paper = {"doi": "10.1000/many", "pdf_urls": [f"https://repo{n}.example/p.pdf" for n in range(10)]}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), budget=PaperBudget(max_attempts=3), unpaywall_email="")

    fetched = [call for call in web.calls if ".example/" in call]
    assert len(fetched) == 3
    assert paper["fulltext_retrieval_stopped"] == "attempt_cap"
    assert paper["fulltext_route"] == "none"
    # after the cap no further request goes out, not even the DOI lookups
    assert not web.hosts_called("api.openalex.org")
    assert not web.hosts_called("doi.org")


def test_abstract_fallback_reuses_the_europe_pmc_record(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = epmc_search(_long_abstract_record())
    paper = {"pmid": "900"}

    retrieve_paper_text(paper, tmp_path, memo=HostMemo(), unpaywall_email="")

    assert paper["fulltext_route"] == "europe_pmc_abstract"
    assert paper["text_availability"] == "abstract_only"
    assert len(web.hosts_called(EPMC_SEARCH)) == 1


def test_download_pdfs_records_routes_and_writes_summary(web, tmp_path) -> None:
    web.routes[EPMC_SEARCH] = lambda url: epmc_search({"pmid": "1", "pmcid": "PMC1"}) if "EXT_ID:1 " in url else epmc_search(None)
    web.routes["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML"] = jats_xml()
    project = Project("fulltext routes", output_dir=tmp_path)

    with_text, without_text = PaperRetriever().download_pdfs(
        [{"pmid": "1", "title": "PMC trial"}, {"pmid": "2", "title": "Closed trial"}],
        project,
    )

    assert [p["pmid"] for p in with_text] == ["1"]
    assert without_text[0]["fulltext_route"] == "none"
    summary = project.load_json("fulltext_retrieval_summary.json")
    assert summary["by_route"] == {"europe_pmc_xml": 1, "none": 1}
    assert {row["pmid"]: row["route"] for row in summary["per_paper"]} == {"1": "europe_pmc_xml", "2": "none"}
