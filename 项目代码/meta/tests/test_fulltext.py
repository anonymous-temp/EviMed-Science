from new_meta.tools import fulltext


def test_html_to_text_removes_scripts_and_keeps_article_text() -> None:
    html = """
    <html><head><script>ignore()</script><style>.x{}</style></head>
    <body><article><h1>Title</h1><p>Abstract text.</p><p>Results text.</p></article></body></html>
    """

    text = fulltext.html_to_text(html)

    assert "ignore" not in text
    assert "Title" in text
    assert "Abstract text." in text
    assert "Results text." in text


def test_jats_xml_to_text_keeps_abstract_body_and_table_text() -> None:
    xml = """
    <article>
      <front>
        <article-meta>
          <title-group><article-title>Trial Title</article-title></title-group>
          <abstract><p>Mortality was lower in the intervention arm.</p></abstract>
        </article-meta>
      </front>
      <body>
        <sec><title>Results</title><p>Primary outcome data were reported.</p>
        <table><tr><th>Arm</th><th>Deaths</th></tr><tr><td>Treatment</td><td>2/34</td></tr></table>
        </sec>
      </body>
    </article>
    """

    text = fulltext.jats_xml_to_text(xml)

    assert "Trial Title" in text
    assert "Mortality was lower" in text
    assert "Primary outcome data" in text
    assert "Treatment" in text
    assert "2/34" in text


def test_fetch_europe_pmc_fulltext_uses_fulltext_xml_before_html(monkeypatch, tmp_path) -> None:
    calls = []

    class SearchResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"resultList": {"result": [{"pmcid": "PMC123"}]}}

    class XMLResponse:
        status_code = 200
        text = "<article><body><p>" + ("Full text mortality data. " * 80) + "</p></body></article>"

        def raise_for_status(self):
            return None

    def fake_get(url, *args, **kwargs):
        calls.append(url)
        if "fullTextXML" in url:
            return XMLResponse()
        return SearchResponse()

    monkeypatch.setattr(fulltext.requests, "get", fake_get)
    save_path = tmp_path / "fulltext.txt"

    ok = fulltext.fetch_europe_pmc_fulltext(pmid="123", save_path=str(save_path))

    assert ok is True
    assert "fullTextXML" in calls[1]
    saved = save_path.read_text(encoding="utf-8")
    assert "SOURCE: Europe PMC fullTextXML" in saved
    assert "Full text mortality data" in saved


def test_fetch_europe_pmc_fulltext_falls_back_to_pmc_html(monkeypatch, tmp_path) -> None:
    calls = []

    class SearchResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"resultList": {"result": [{"pmcid": "PMC123"}]}}

    class NotFoundXMLResponse:
        status_code = 404
        text = ""

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError("404")

    class EuropePMCResponse:
        status_code = 200
        text = "<html><body><div>shell</div></body></html>"

        def raise_for_status(self):
            return None

    class PMCHtmlResponse:
        status_code = 200
        text = (
            "<html><body><article><h1>CoDEX</h1><p>"
            + ("Mortality and ventilator-free outcome text. " * 80)
            + "</p></article></body></html>"
        )

        def raise_for_status(self):
            return None

    def fake_get(url, *args, **kwargs):
        calls.append(url)
        if "fullTextXML" in url:
            return NotFoundXMLResponse()
        if "europepmc.org/articles" in url:
            return EuropePMCResponse()
        if "pmc.ncbi.nlm.nih.gov/articles/PMC123/" in url:
            return PMCHtmlResponse()
        return SearchResponse()

    monkeypatch.setattr(fulltext.requests, "get", fake_get)
    save_path = tmp_path / "pmc-fallback.txt"

    ok = fulltext.fetch_europe_pmc_fulltext(pmid="123", save_path=str(save_path))

    assert ok is True
    assert any("pmc.ncbi.nlm.nih.gov/articles/PMC123/" in url for url in calls)
    saved = save_path.read_text(encoding="utf-8")
    assert "SOURCE: PMC article HTML" in saved
    assert "Mortality and ventilator-free outcome text" in saved


def test_find_europe_pmc_html_url_prefers_free_html(monkeypatch) -> None:
    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "resultList": {
                    "result": [
                        {
                            "fullTextUrlList": {
                                "fullTextUrl": [
                                    {
                                        "availabilityCode": "S",
                                        "documentStyle": "doi",
                                        "site": "DOI",
                                        "url": "https://doi.org/x",
                                    },
                                    {
                                        "availabilityCode": "F",
                                        "documentStyle": "html",
                                        "site": "Europe_PMC",
                                        "url": "https://europepmc.org/articles/PMC1",
                                    },
                                ]
                            }
                        }
                    ]
                }
            }

    monkeypatch.setattr(fulltext.requests, "get", lambda *args, **kwargs: Response())

    assert fulltext.find_europe_pmc_html_url(pmid="123") == "https://europepmc.org/articles/PMC1"


def test_europe_pmc_fulltext_links_extracts_pdf_html_and_pmcid() -> None:
    record = {
        "pmcid": "PMC123",
        "fullTextUrlList": {
            "fullTextUrl": [
                {
                    "availabilityCode": "S",
                    "documentStyle": "doi",
                    "url": "https://doi.org/x",
                },
                {
                    "availabilityCode": "OA",
                    "documentStyle": "html",
                    "url": "https://europepmc.org/articles/PMC123",
                },
                {
                    "availabilityCode": "OA",
                    "documentStyle": "pdf",
                    "url": "https://europepmc.org/articles/PMC123?pdf=render",
                },
            ]
        },
    }

    links = fulltext.europe_pmc_fulltext_links(record)

    assert links["pmcid"] == "PMC123"
    assert links["html_url"] == "https://europepmc.org/articles/PMC123"
    assert links["pdf_urls"] == ["https://europepmc.org/articles/PMC123?pdf=render"]


def test_europe_pmc_fulltext_links_adds_render_pdf_from_pmcid() -> None:
    links = fulltext.europe_pmc_fulltext_links({"pmcid": "PMC999"})

    assert links["pdf_urls"] == ["https://europepmc.org/articles/PMC999?pdf=render"]
    assert links["html_url"] == "https://europepmc.org/articles/PMC999"


def test_europe_pmc_record_to_text_marks_abstract_only_source() -> None:
    record = {
        "title": "Trial Title",
        "journalTitle": "JAMA",
        "pubYear": "2020",
        "pmid": "123",
        "doi": "10.1000/example",
        "pmcid": "PMC1",
        "abstractText": "<h4>Results</h4>Mortality was 10 of 100 vs 20 of 100.",
    }

    text = fulltext.europe_pmc_record_to_text(record)

    assert "SOURCE: Europe PMC structured abstract only" in text
    assert "SOURCE_LIMITATION" in text
    assert "Mortality was 10 of 100 vs 20 of 100" in text


def test_fetch_europe_pmc_abstract_text_saves_long_structured_abstract(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        fulltext,
        "fetch_europe_pmc_record",
        lambda **kwargs: {
            "title": "Trial Title",
            "pmid": "123",
            "abstractText": "<h4>Results</h4>" + ("Mortality outcome. " * 40),
        },
    )
    save_path = tmp_path / "abstract.txt"

    ok = fulltext.fetch_europe_pmc_abstract_text(pmid="123", save_path=str(save_path))

    assert ok is True
    assert save_path.exists()
    assert "abstract only" in save_path.read_text(encoding="utf-8")
