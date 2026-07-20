from new_meta.tools import pdf_downloader


def test_candidate_urls_deduplicates_ordered_candidates() -> None:
    assert pdf_downloader._candidate_urls(["", "https://a.test/p.pdf", "https://a.test/p.pdf", "https://b.test/p.pdf"]) == [
        "https://a.test/p.pdf",
        "https://b.test/p.pdf",
    ]


def test_download_pdf_tries_url_candidates_until_success(monkeypatch, tmp_path) -> None:
    seen = []

    def fake_save_pdf(url, save_path):
        seen.append(url)
        return url.endswith("success.pdf")

    monkeypatch.setattr(pdf_downloader, "_save_pdf", fake_save_pdf)
    monkeypatch.setattr(pdf_downloader, "_try_pmc_download", lambda pmid, save_path: False)

    ok = pdf_downloader.download_pdf(
        pmid="123",
        url=["https://example.org/fail.pdf", "https://example.org/success.pdf"],
        save_path=str(tmp_path / "paper.pdf"),
        max_retries=1,
    )

    assert ok is True
    assert seen == ["https://example.org/fail.pdf", "https://example.org/success.pdf"]


def test_download_pdf_does_not_try_scihub_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(pdf_downloader, "SCIHUB_ENABLED", False)
    monkeypatch.setattr(pdf_downloader, "_try_url_download", lambda *args, **kwargs: False)
    monkeypatch.setattr(pdf_downloader, "_try_pmc_download", lambda *args, **kwargs: False)
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

    class FakeResponse:
        status_code = 200
        headers = {"Content-Length": str(len(pdf_body))}

        def iter_content(self, chunk_size=65536):
            yield pdf_body

    def fake_get(url, **kwargs):
        calls.append(kwargs)
        return FakeResponse()

    monkeypatch.setattr(pdf_downloader.requests, "get", fake_get)

    ok = pdf_downloader._save_pdf("https://example.org/paper.pdf", str(tmp_path / "paper.pdf"))

    assert ok is True
    assert calls[0]["stream"] is True
    assert calls[0].get("verify") is not False
