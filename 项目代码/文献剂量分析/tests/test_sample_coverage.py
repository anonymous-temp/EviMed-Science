# [IN] selected PubMed records with distinct search and issue dates
# [OUT] regression checks for observed counts and scoped interpretation
# [POS] tests/test_sample_coverage.py
from datetime import datetime

import pandas as pd
import pytest

from bibliometric.analysis import statistics
from bibliometric.insight.ai_narrator import _build_data_summary
from bibliometric.insight.templates import template_results_trends, template_results_trends_zh
from bibliometric.pubmed.parser import parse_articles
from bibliometric.report.generator import _build_context
from bibliometric.report.results_sections import _results_overview


@pytest.mark.parametrize("replay_year", [2026, 2029])
def test_later_issue_year_is_observed_sample_not_calendar_projection(monkeypatch, replay_year):
    class Clock:
        @staticmethod
        def now():
            return datetime(replay_year, 9, 30)
    monkeypatch.setattr(statistics, "datetime", Clock, raising=False)
    articles = [{"year": "2026", "year_basis": "journal_issue_year"}] * 93
    stats = statistics.compute_statistics(articles, date_to="2025")
    trend = stats["year_trend"]
    assert trend.iloc[0]["count"] == 93
    assert "annualized_count" not in trend.columns
    assert "is_partial" not in trend.columns
    assert stats["trend_coverage"]["status"] == "selected_records"
    assert stats["trend_coverage"]["query_to"] == "2025"
    summary = _build_data_summary("test", articles, stats, {})
    assert "journal_issue_year" in summary and "2025" in summary
    for lang in ["en", "zh"]:
        ctx = _build_context("test", "2021", "2025", articles, stats, {}, ".")
        ctx["lang"] = lang
        prose = _results_overview(ctx) + (template_results_trends(stats) if lang == "en" else template_results_trends_zh(stats))
        assert "93" in prose
        assert "selected" in prose.lower() if lang == "en" else "样本" in prose
        for unsupported in ["~124", "Jan–", "截至09月", "complete calendar years", "完整自然年"]:
            assert unsupported not in prose


def test_explicit_query_window_remains_distinct_from_ascertainment():
    stats = statistics.compute_statistics([{"year": "2026"}], date_from="2026/01/01", date_to="2026/09/30")
    coverage = stats["trend_coverage"]
    assert coverage["query_from"] == "2026/01/01"
    assert coverage["query_to"] == "2026/09/30"
    assert coverage["query_date_field"] == "pdat"
    assert coverage["status"] == "selected_records"
    assert coverage["year_basis_counts"] == {"unknown": 1}


@pytest.mark.parametrize("pubdate,completed,basis,year", [
    ("<Year>2026</Year>", "", "journal_issue_year", "2026"),
    ("<MedlineDate>2026 Jan-Feb</MedlineDate>", "", "journal_medline_date", "2026"),
    ("", "<DateCompleted><Year>2025</Year></DateCompleted>", "index_completion_year", "2025"),
    ("", "", "unknown", ""),
])
def test_parser_preserves_year_basis(pubdate, completed, basis, year):
    xml = f"<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID>{completed}<Article><Journal><JournalIssue><PubDate>{pubdate}</PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"
    article = parse_articles([xml])[0]
    assert article["year"] == year
    assert article["year_basis"] == basis


def test_network_context_distinguishes_selected_graph_from_all_named_authors(tmp_path):
    from bibliometric.analysis.network_analyzer import analyze_networks
    edges = pd.DataFrame([
        {"source": "A", "target": "B", "weight": 2, "source_freq": 8, "target_freq": 7},
        {"source": "C", "target": "D", "weight": 1, "source_freq": 2, "target_freq": 1},
    ])
    network = analyze_networks({"author_collaboration": edges}, tmp_path, max_nodes={"author": 2})["author"]
    assert network["node_count"] == 2
    assert network["scope"]["candidate_nodes"] == 4
    assert network["scope"]["max_nodes"] == 2
    summary = _build_data_summary("test", [{"authors_normalized": ["A", "B", "C", "D", "E"]}], {}, {"author": network})
    assert "5" in summary and "selected" in summary.lower()
    assert "name" in summary.lower()


def test_legacy_chart_columns_do_not_authorize_calendar_claims(tmp_path, monkeypatch):
    from matplotlib.axes import Axes
    from bibliometric.visualization.trend_charts import _plot_annual_trend
    calls = []
    original = Axes.bar
    def capture(self, x, height, *args, **kwargs):
        calls.append((list(height), kwargs.get("label")))
        return original(self, x, height, *args, **kwargs)
    monkeypatch.setattr(Axes, "bar", capture)
    frame = pd.DataFrame([{"year": "2026", "count": 93, "is_partial": True, "annualized_count": 124}])
    result = _plot_annual_trend(frame, tmp_path, {"annual_xlabel": "Recorded year", "annual_ylabel": "Count"})
    assert result and calls == [([93], "Selected records")]


def test_declining_sample_discussion_does_not_invent_sustained_growth():
    from bibliometric.report.generator import _discussion
    articles = [{"year": year} for year, count in [("2023", 30), ("2024", 20), ("2025", 10)] for _ in range(count)]
    stats = statistics.compute_statistics(articles)
    ctx = _build_context("test", "2023", "2025", articles, stats, {}, ".")
    ctx["lang"] = "en"
    prose = _discussion(ctx)
    assert "sustained growth" not in prose
    assert "selected" in prose.lower()


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_template_narratives_keep_scope_in_the_complete_report(tmp_path, monkeypatch, lang):
    from bibliometric.insight.ai_narrator import _smart_template_narratives
    from bibliometric.insight.miner import _detect_maturity
    from bibliometric.report import generator
    articles = [{"year": year, "authors_normalized": ["A. Author"]}
                for year, count in [("2023", 30), ("2024", 20), ("2025", 10)] for _ in range(count)]
    stats = statistics.compute_statistics(articles)
    stats["insights"] = _detect_maturity(articles, stats)
    stats["ai_narratives"] = _smart_template_narratives("test", articles, stats, {}, lang=lang)
    monkeypatch.setattr(generator, "_generate_topic_intro_llm", lambda *args: "")
    report = generator.generate_report("test", "2023", "2025", articles, stats, {}, str(tmp_path), lang=lang)
    text = __import__("pathlib").Path(report).read_text()
    assert "reveals a nascent research field" not in text
    assert "研究近年来持续增长" not in text and "研究领域整体处于" not in text
    for section in ["introduction", "discussion", "conclusion"]:
        content = stats["ai_narratives"][section]
        assert "selected" in content.lower() if lang == "en" else "样本" in content
    assert "hypothesis" in stats["ai_narratives"]["discussion"] if lang == "en" else "假设" in stats["ai_narratives"]["discussion"]


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_author_frequency_alone_does_not_establish_a_collaboration_core(lang):
    from bibliometric.report.generator import _discussion
    articles = [{"year": "2025", "authors_normalized": ["A. Author"]}]
    ctx = _build_context("test", "2025", "2025", articles, statistics.compute_statistics(articles), {}, ".")
    ctx["lang"] = lang
    text = _discussion(ctx)
    assert "A. Author" in text
    for invented in ["stable research teams", "core group", "核心作者群体已经形成", "稳定的研究团队"]:
        assert invented not in text


def test_missing_coverage_is_unknown_not_explicitly_unbounded():
    from bibliometric.analysis.statistics import trend_coverage_note
    assert "unbounded" not in trend_coverage_note({})
    assert "未限定" not in trend_coverage_note({}, "zh")
    explicit = statistics.compute_statistics([])
    assert "unbounded" in trend_coverage_note(explicit)


@pytest.mark.parametrize("coverage", [{}, {"status": "unknown"}, {"query_to": "2025"}, {"query_from": None, "query_to": None}])
def test_partial_coverage_keeps_missing_bounds_unknown(coverage):
    from bibliometric.analysis.statistics import trend_coverage_note
    for lang in ["en", "zh"]:
        note = trend_coverage_note({"trend_coverage": coverage}, lang)
        assert "unbounded" not in note and "未限定" not in note
        if coverage.get("query_to") == "2025":
            assert "2025" in note
