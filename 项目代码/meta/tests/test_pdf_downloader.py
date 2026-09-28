from pathlib import Path

import pytest

from fulltext_http_fixture import (
    FakeResponse,
    FakeWeb,
    cloudflare_403,
    html,
    pdf,
    plain_403,
)
from new_meta.tools import pdf_downloader
from new_meta.tools.pdf_downloader import HostMemo, PaperBudget, fetch_pdf_url, find_pdf_link


@pytest.fixture
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(pdf_downloader.requests, "get", fake.get)
    return fake


def test_candidate_urls_deduplicates_ordered_candidates() -> None:
    assert pdf_downloader._candidate_urls(["", "https://a.test/p.pdf", "https://a.test/p.pdf", "https://b.test/p.pdf"]) == [
        "https://a.test/p.pdf",
        "https://b.test/p.pdf",
    ]


def test_download_pdf_tries_url_candidates_until_success(web, tmp_path) -> None:
    web.routes["https://example.org/fail.pdf"] = FakeResponse(404)
    web.routes["https://example.org/success.pdf"] = pdf()

    ok = pdf_downloader.download_pdf(
        pmid="123",
        url=["https://example.org/fail.pdf", "https://example.org/success.pdf"],
        save_path=str(tmp_path / "paper.pdf"),
        max_retries=1,
    )

    assert ok is True
    assert web.calls == ["https://example.org/fail.pdf", "https://example.org/success.pdf"]
    assert (tmp_path / "paper.pdf").read_bytes().startswith(b"%PDF")


def test_download_pdf_does_not_try_scihub_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(pdf_downloader, "SCIHUB_ENABLED", False)
    monkeypatch.setattr(pdf_downloader, "_try_url_download", lambda *args, **kwargs: False)
    monkeypatch.setattr(pdf_downloader, "_try_doi_download", lambda *args, **kwargs: False)

    def fail_scihub(*args, **kwargs):
        raise AssertionError("Sci-Hub must not be called unless explicitly enabled")

    monkeypatch.setattr(pdf_downloader, "_try_scihub_download", fail_scihub)

    ok = pdf_downloader.download_pdf(
        doi="10.1000/test",
        pmid="123",
        save_path=str(tmp_path / "paper.pdf"),
        max_retries=1,
    )

    assert ok is False


def test_save_pdf_streams_with_tls_verification(monkeypatch, tmp_path) -> None:
    pdf_body = b"%PDF-1.7\n" + (b"x" * 1200)
    calls = []

    class FakeStreamResponse:
        status_code = 200
        headers = {"Content-Length": str(len(pdf_body))}

        def iter_content(self, chunk_size=65536):
            yield pdf_body

    def fake_get(url, **kwargs):
        calls.append(kwargs)
        return FakeStreamResponse()

    monkeypatch.setattr(pdf_downloader.requests, "get", fake_get)

    ok = pdf_downloader._save_pdf("https://example.org/paper.pdf", str(tmp_path / "paper.pdf"))

    assert ok is True
    assert calls[0]["stream"] is True
    assert calls[0].get("verify") is not False


def test_landing_page_citation_pdf_url_is_followed_once(web, tmp_path) -> None:
    landing = "https://link.springer.com/article/10.1186/s12891-016-1293-3"
    pdf_url = "https://link.springer.com/content/pdf/10.1186/s12891-016-1293-3.pdf"
    web.routes[landing] = html(
        '<html><head><meta name="citation_title" content="TXA">'
        f'<meta name="citation_pdf_url" content="{pdf_url}"></head><body>Abstract</body></html>'
    )
    web.routes[pdf_url] = pdf()
    budget = PaperBudget()

    route = fetch_pdf_url(landing, str(tmp_path / "p.pdf"), route="doi", memo=HostMemo(), budget=budget)

    assert route == "doi+citation_pdf_url"
    assert web.calls == [landing, pdf_url]
    assert [a["outcome"] for a in budget.attempts] == ["landing_page", "pdf"]
    assert (tmp_path / "p.pdf").read_bytes().startswith(b"%PDF")


def test_landing_hop_is_one_hop_only(web, tmp_path) -> None:
    web.routes["https://pub.example/landing"] = html(
        '<meta name="citation_pdf_url" content="https://pub.example/second-landing">'
    )
    web.routes["https://pub.example/second-landing"] = html(
        '<meta name="citation_pdf_url" content="https://pub.example/real.pdf">'
    )
    web.routes["https://pub.example/real.pdf"] = pdf()

    route = fetch_pdf_url("https://pub.example/landing", str(tmp_path / "p.pdf"), route="oa_landing",
                          memo=HostMemo(), budget=PaperBudget())

    assert route == ""
    assert "https://pub.example/real.pdf" not in web.calls
    assert not (tmp_path / "p.pdf").exists()


def test_find_pdf_link_reads_alternate_link_and_resolves_relative_href() -> None:
    page = '<html><head><link rel="alternate" type="application/pdf" href="/content/article.pdf"></head></html>'
    assert find_pdf_link(page, "https://www.frontiersin.org/articles/10.3389/x/full") == (
        "https://www.frontiersin.org/content/article.pdf"
    )
    assert find_pdf_link('<meta content="https://a.test/x.pdf" name="citation_pdf_url"/>', "https://a.test/") == (
        "https://a.test/x.pdf"
    )
    assert find_pdf_link('<meta name="citation_pdf_url" content="javascript:void(0)">', "https://a.test/") == ""


def test_html_is_not_mistaken_for_pdf(web, tmp_path) -> None:
    # A publisher answering a ".pdf" URL with an HTML login page and a PDF
    # content type must not produce a file.
    web.routes["https://pub.example/paper.pdf"] = FakeResponse(
        200, "<html><body>" + ("Sign in to read. " * 200) + "</body></html>",
        {"Content-Type": "application/pdf"},
    )
    budget = PaperBudget()

    route = fetch_pdf_url("https://pub.example/paper.pdf", str(tmp_path / "p.pdf"), route="record_pdf_url",
                          memo=HostMemo(), budget=budget, follow_landing=False)

    assert route == ""
    assert not (tmp_path / "p.pdf").exists()
    assert budget.attempts[-1]["outcome"] == "not_pdf"


def test_bot_wall_403_blocks_host_for_the_rest_of_the_run(web, tmp_path) -> None:
    web.routes["https://www.sciencedirect.com/"] = cloudflare_403()
    memo = HostMemo()

    first = PaperBudget()
    assert fetch_pdf_url("https://www.sciencedirect.com/a.pdf", str(tmp_path / "a.pdf"), route="doi",
                         memo=memo, budget=first) == ""
    second = PaperBudget()
    assert fetch_pdf_url("https://www.sciencedirect.com/b.pdf", str(tmp_path / "b.pdf"), route="doi",
                         memo=memo, budget=second) == ""

    assert web.calls == ["https://www.sciencedirect.com/a.pdf"]
    assert second.attempts[0]["outcome"] == "skipped_bot_wall_403"
    assert second.used == 0
    assert memo.snapshot() == {"www.sciencedirect.com": "bot_wall_403"}


def test_redirected_bot_wall_blocks_the_redirecting_host_but_never_doi_org(web, tmp_path) -> None:
    def redirected(url):
        return cloudflare_403(url="https://www.sciencedirect.com/science/article/pii/X")

    web.routes["https://linkinghub.elsevier.com/"] = redirected
    web.routes["https://doi.org/"] = redirected
    memo = HostMemo()

    fetch_pdf_url("https://linkinghub.elsevier.com/retrieve/pii/X", str(tmp_path / "a.pdf"), route="doi",
                  memo=memo, budget=PaperBudget())
    fetch_pdf_url("https://doi.org/10.1016/x", str(tmp_path / "b.pdf"), route="doi",
                  memo=memo, budget=PaperBudget())

    assert set(memo.snapshot()) == {"linkinghub.elsevier.com", "www.sciencedirect.com"}


def test_plain_403_blocks_only_after_repeats_and_never_a_host_that_served(web, tmp_path) -> None:
    web.routes["https://mixed.example/closed"] = plain_403()
    web.routes["https://mixed.example/open.pdf"] = pdf()
    web.routes["https://closed.example/"] = plain_403()
    memo = HostMemo(soft_limit=2)

    fetch_pdf_url("https://mixed.example/open.pdf", str(tmp_path / "o.pdf"), route="x", memo=memo, budget=PaperBudget())
    for index in range(3):
        fetch_pdf_url("https://mixed.example/closed", str(tmp_path / f"m{index}.pdf"), route="x",
                      memo=memo, budget=PaperBudget())
        fetch_pdf_url(f"https://closed.example/{index}.pdf", str(tmp_path / f"c{index}.pdf"), route="x",
                      memo=memo, budget=PaperBudget())

    assert memo.snapshot() == {"closed.example": "repeated_403"}
    assert len(web.hosts_called("mixed.example/closed")) == 3
    assert len(web.hosts_called("closed.example")) == 2


def test_budget_caps_attempts_per_paper(web, tmp_path) -> None:
    for index in range(5):
        web.routes[f"https://repo{index}.example/p.pdf"] = FakeResponse(404)
    budget = PaperBudget(max_attempts=2, deadline_seconds=60)

    for index in range(5):
        fetch_pdf_url(f"https://repo{index}.example/p.pdf", str(tmp_path / "p.pdf"), route="x",
                      memo=HostMemo(), budget=budget)

    assert len(web.calls) == 2
    assert [a["outcome"] for a in budget.attempts] == [
        "http_404", "http_404", "skipped_attempt_cap", "skipped_attempt_cap", "skipped_attempt_cap",
    ]


def test_budget_deadline_stops_new_attempts(web, tmp_path) -> None:
    now = {"t": 0.0}

    def slow(url):
        now["t"] += 30.0
        return FakeResponse(404)

    web.routes["https://slow.example/"] = slow
    budget = PaperBudget(max_attempts=10, deadline_seconds=45, clock=lambda: now["t"])

    for index in range(4):
        fetch_pdf_url(f"https://slow.example/{index}.pdf", str(tmp_path / "p.pdf"), route="x",
                      memo=HostMemo(), budget=budget)

    assert len(web.calls) == 2
    assert budget.attempts[-1]["outcome"] == "skipped_deadline"
    # the second request was given only the time left, not the full default
    assert web.kwargs[1]["timeout"] == pytest.approx(15.0)


def test_doi_download_resolves_handle_then_follows_landing(web, tmp_path) -> None:
    web.routes["https://doi.org/api/handles/10.1186/s12891-016-1293-3"] = FakeResponse(
        200, json_data={"values": [{"type": "URL", "data": {"value": "https://link.springer.com/10.1186/s12891-016-1293-3"}}]},
    )
    web.routes["https://link.springer.com/10.1186/"] = html(
        '<meta name="citation_pdf_url" content="https://link.springer.com/content/pdf/10.1186/s12891-016-1293-3.pdf">',
        url="https://link.springer.com/article/10.1186/s12891-016-1293-3",
    )
    web.routes["https://link.springer.com/content/pdf/"] = pdf()

    ok = pdf_downloader.download_pdf(doi="10.1186/s12891-016-1293-3", save_path=str(tmp_path / "p.pdf"))

    assert ok is True
    assert web.calls[0].startswith("https://doi.org/api/handles/")
    assert Path(tmp_path / "p.pdf").read_bytes().startswith(b"%PDF")


def test_200_client_challenge_page_blocks_host_and_is_not_a_pdf(web, tmp_path) -> None:
    challenge = html(
        "<!DOCTYPE html><html><head><title>Client Challenge</title></head>"
        "<body><noscript>JavaScript is disabled in your browser.</noscript></body></html>"
    )
    web.routes["https://link.springer.com/"] = challenge
    memo = HostMemo()
    budget = PaperBudget()

    assert fetch_pdf_url("https://link.springer.com/article/10.1186/x", str(tmp_path / "a.pdf"), route="doi",
                         memo=memo, budget=budget) == ""
    assert fetch_pdf_url("https://link.springer.com/content/pdf/10.1186/y.pdf", str(tmp_path / "b.pdf"),
                         route="openalex_pdf", memo=memo, budget=budget) == ""

    assert budget.attempts[0]["outcome"] == "challenge_page"
    assert budget.attempts[1]["outcome"] == "skipped_challenge_page"
    assert len(web.calls) == 1
    assert not (tmp_path / "a.pdf").exists()


def test_article_page_that_loads_a_captcha_script_is_not_a_wall() -> None:
    page = (
        "<html><head><title>Tranexamic acid in TKA | BMC Musculoskeletal Disorders</title>"
        '<script src="https://www.google.com/recaptcha/api.js"></script></head></html>'
    )
    assert pdf_downloader.is_challenge_page(page) is False
    assert pdf_downloader.is_challenge_page("<title>Just a moment...</title>") is True


def test_requests_identify_the_client_honestly(web, tmp_path) -> None:
    web.routes["https://pub.example/p.pdf"] = pdf()

    fetch_pdf_url("https://pub.example/p.pdf", str(tmp_path / "p.pdf"), route="x", memo=HostMemo(), budget=PaperBudget())

    assert web.kwargs[0]["headers"]["User-Agent"].startswith("MetaAgent/")


def test_body_that_breaks_mid_stream_is_an_answer_not_a_crash(web, tmp_path) -> None:
    class Broken(FakeResponse):
        def iter_content(self, chunk_size=65536):
            yield b"%PDF-1.7\n" + b"0" * 100
            raise ConnectionResetError("reset by peer")

    web.routes["https://pub.example/broken.pdf"] = Broken(200, b"", {"Content-Type": "application/pdf"})
    budget = PaperBudget()

    assert fetch_pdf_url("https://pub.example/broken.pdf", str(tmp_path / "p.pdf"), route="x",
                         memo=HostMemo(), budget=budget) == ""
    assert budget.attempts[-1]["outcome"] == "error_ConnectionResetError"
    assert not (tmp_path / "p.pdf").exists()
