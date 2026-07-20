from new_meta.tools.multi_search import (
    _openalex_abstract,
    _openalex_pdf_url,
    _openalex_pdf_urls,
    get_openalex_pdf_urls_for_doi,
)


def test_openalex_abstract_reconstruction() -> None:
    abstract = _openalex_abstract(
        {
            "COVID-19": [0],
            "mortality": [3],
            "corticosteroids": [1],
            "reduced": [2],
        }
    )

    assert abstract == "COVID-19 corticosteroids reduced mortality"


def test_openalex_pdf_url_prefers_primary_location() -> None:
    work = {
        "open_access": {"oa_url": "https://example.org/oa.pdf"},
        "primary_location": {"pdf_url": "https://example.org/primary.pdf"},
        "locations": [{"pdf_url": "https://example.org/backup.pdf"}],
    }

    assert _openalex_pdf_url(work) == "https://example.org/primary.pdf"
    assert _openalex_pdf_urls(work) == [
        "https://example.org/primary.pdf",
        "https://example.org/oa.pdf",
        "https://example.org/backup.pdf",
    ]


def test_openalex_pdf_url_falls_back_to_oa_pdf() -> None:
    work = {
        "open_access": {"oa_url": "https://example.org/oa.pdf"},
        "primary_location": {"pdf_url": None},
    }

    assert _openalex_pdf_url(work) == "https://example.org/oa.pdf"


def test_openalex_pdf_url_handles_null_oa_url() -> None:
    work = {
        "open_access": {"oa_url": None},
        "primary_location": {"pdf_url": None},
        "locations": [{"pdf_url": "https://repo.org/paper.pdf"}],
    }

    assert _openalex_pdf_url(work) == "https://repo.org/paper.pdf"


def test_get_openalex_pdf_urls_for_doi_fetches_work(monkeypatch) -> None:
    from new_meta.tools import multi_search

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "primary_location": {"pdf_url": "https://publisher.org/paper.pdf"},
                "locations": [{"pdf_url": "https://repo.org/paper.pdf"}],
            }

    seen = {}

    def fake_get(url, **kwargs):
        seen["url"] = url
        return Response()

    monkeypatch.setattr(multi_search.requests, "get", fake_get)

    assert get_openalex_pdf_urls_for_doi("10.1000/example") == [
        "https://publisher.org/paper.pdf",
        "https://repo.org/paper.pdf",
    ]
    assert seen["url"].endswith("/doi:10.1000/example")
