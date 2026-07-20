from pathlib import Path

import pandas as pd

from bibliometric.report import generator


def test_report_abstract_preserves_source_counts():
    articles = [
        {"year": "2023", "journal": {"title": "A"}, "countries": ["China"]},
        {"year": "2024", "journal": {"title": "B"}, "countries": ["US"]},
        {"year": "2024", "journal": {"title": "B"}, "countries": ["US"]},
    ]
    stats = {
        "year_trend": pd.DataFrame(
            [{"year": 2023, "count": 1}, {"year": 2024, "count": 2}]
        ),
        "top_countries": pd.DataFrame(
            [{"countries": "US", "count": 2}]
        ),
        "top_authors": pd.DataFrame(
            [{"authors_normalized": "A. Author", "count": 2}]
        ),
    }
    ctx = generator._build_context(
        "diabetes", "2023", "2024", articles, stats, {}, "."
    )
    ctx["lang"] = "zh"

    abstract = generator._abstract(ctx)

    assert "3篇文献" in abstract
    assert "2024年（2篇）" in abstract
    assert "US（2篇）" in abstract
    assert ctx["n"] == len(articles)


def test_report_separates_search_filter_from_observed_bibliographic_years():
    articles = [
        {"year": "2025", "journal": {"title": "A"}, "countries": []},
        {"year": "2026", "journal": {"title": "B"}, "countries": []},
    ]
    ctx = generator._build_context(
        "osimertinib", "2021", "2025", articles, {}, {}, "."
    )
    ctx["lang"] = "en"

    abstract = generator._abstract(ctx)

    assert ctx["search_year_range"] == "2021–2025"
    assert ctx["year_range"] == "2025–2026"
    assert "search filter: 2021–2025" in abstract
    assert "publications (2025–2026)" in abstract
    assert "are distinct fields" in abstract


def test_topic_intro_uses_pro(monkeypatch):
    class _FakeClient:
        available = True
        call = None

        def complete(self, messages, **kwargs):
            type(self).call = (messages, kwargs)
            return "generated introduction"

    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _FakeClient)

    assert generator._generate_topic_intro_llm("diabetes") == "generated introduction"
    assert _FakeClient.call[1]["tier"] == "pro"


def test_generate_report_writes_markdown_without_llm(tmp_path, monkeypatch):
    monkeypatch.setattr(generator, "_generate_topic_intro_llm", lambda *args: "")
    report_path = generator.generate_report(
        query="diabetes",
        date_from="2024",
        date_to="2024",
        articles=[],
        stats={},
        networks={},
        output_dir=str(tmp_path),
        lang="en",
    )
    path = Path(report_path)
    assert path.exists()
    assert "# A Bibliometric Analysis" in path.read_text(encoding="utf-8")
