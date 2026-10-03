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


def _selection_context(tmp_path, lang, *, concepts=None, sort="relevance"):
    import json
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    (data / "search_metadata.json").write_text(json.dumps({
        "total_found": 348, "retrieved": 200, "total_fetched": 198,
        "after_dedup": 198, "max_records": 200, "truncated": True,
        "esearch_sort": sort,
        "search_strategy": {"formal_query": '"topic"[Title/Abstract]', "concepts": concepts or []},
    }))
    articles = [{"year": "2024"}] * 19 + [{"year": "2025"}] * 60 + [{"year": "2026"}] * 119
    stats = {"year_trend": pd.DataFrame([
        {"year": "2024", "count": 19}, {"year": "2025", "count": 60},
        {"year": "2026", "count": 119},
    ]), "trend_coverage": {"status": "selected_records"},
        "ai_narratives": {"results_trends": "UNSUPPORTED_FIELD_GROWTH_FROM_PARTIAL_YEARS"}}
    ctx = generator._build_context("topic", "", "", articles, stats, {}, str(tmp_path))
    ctx["lang"] = lang
    return ctx


def test_capped_relevance_selection_and_metadata_are_disclosed_in_both_languages(tmp_path):
    from bibliometric.report.results_sections import _results_overview
    for lang in ["en", "zh"]:
        text = _results_overview(_selection_context(tmp_path, lang))
        assert "relevance" in text and "200" in text and "198" in text
        assert "代表性样本" not in text and "Results represent a sample of the full literature" not in text
        assert "全文记录" not in text and "fetch of full records" not in text
        assert "bibliographic metadata" in text if lang == "en" else "书目元数据" in text
        assert "UNSUPPORTED_FIELD_GROWTH_FROM_PARTIAL_YEARS" not in text
        assert "119" in text


def test_query_description_follows_actual_mesh_and_failed_lookup(tmp_path):
    concepts = [{"label": "topic", "free_terms": ["topic"], "mesh_descriptor": None,
                 "mesh_lookup_failed": True}]
    for lang in ["en", "zh"]:
        text = generator._methods(_selection_context(tmp_path, lang, concepts=concepts))
        assert '"topic"[Title/Abstract]' in text
        assert "lookup failed" in text if lang == "en" else "查询失败" in text
        assert "combination of Medical Subject Headings" not in text
        assert "策略采用医学主题词（MeSH）和自由词" not in text


def test_llm_generated_query_does_not_invent_mesh_usage(tmp_path):
    concepts = [{"label": "topic", "llm_generated": True}]
    for lang in ["en", "zh"]:
        text = generator._methods(_selection_context(tmp_path, lang, concepts=concepts))
        assert "incorporating MeSH terms" not in text
        assert "包含MeSH主题词与自由词组合" not in text
        assert '"topic"[Title/Abstract]' in text


def test_unverified_calendar_coverage_never_authorizes_ai_growth_narrative(tmp_path):
    from bibliometric.report.results_sections import _results_overview
    for coverage in [{}, {"status": "selected_records"}, {"status": "unknown"},
                     {"status": "complete", "query_to": "2025"}]:
        ctx = _selection_context(tmp_path, "en")
        ctx["stats"]["trend_coverage"] = coverage
        assert "UNSUPPORTED_FIELD_GROWTH_FROM_PARTIAL_YEARS" not in _results_overview(ctx)


def test_preserved_mesh_query_and_missing_sort_are_not_reinterpreted(tmp_path):
    concepts = [{"label": "topic", "free_terms": ["topic"], "mesh_descriptor": "Diabetes Mellitus"}]
    for lang in ["en", "zh"]:
        ctx = _selection_context(tmp_path, lang, concepts=concepts, sort="")
        methods = generator._methods(ctx)
        assert '"Diabetes Mellitus"[MeSH Terms]' in methods
        assert "lookup failed" not in methods and "查询失败" not in methods
        from bibliometric.report.results_sections import _results_overview
        overview = _results_overview(ctx)
        assert "relevance" not in overview
        assert "not recorded" in overview if lang == "en" else "未记录" in overview


def test_incomplete_fetch_does_not_invent_a_cap_as_the_cause(tmp_path):
    import json
    from bibliometric.report.results_sections import _results_overview
    ctx = _selection_context(tmp_path, "en")
    path = tmp_path / "data/search_metadata.json"
    meta = json.loads(path.read_text())
    meta.update({"max_records": 500, "retrieved": 348, "truncated": False})
    path.write_text(json.dumps(meta))
    ctx = generator._build_context("topic", "", "", ctx["articles"], ctx["stats"], {}, str(tmp_path))
    ctx["lang"] = "en"
    text = _results_overview(ctx)
    assert "Due to the retrieval limit" not in text
    assert "500" in text and "198" in text


def test_frontier_rank_does_not_default_to_rapid_growth_in_fallbacks(tmp_path):
    from bibliometric.insight.ai_narrator import _smart_template_narratives
    for growth in [None, -0.4, 0, 0.8]:
        for lang in ["en", "zh"]:
            ctx = _selection_context(tmp_path, lang)
            ctx["stats"].pop("ai_narratives")
            row = {"keyword": "observed-topic", "frontier_score": .7}
            if growth is not None:
                row["growth_rate"] = growth
            ctx["stats"]["frontiers"] = {"top_frontiers": [row], "frontier_topics": pd.DataFrame([
                {"topic": "observed-topic", "frontier_score": .7, "growth_rate": growth or 0}])}
            ctx["stats"]["top_keywords"] = pd.DataFrame([{"keywords_merged": "observed-topic", "count": 8}])
            for text in [generator._discussion(ctx), _smart_template_narratives(
                    "topic", ctx["articles"], ctx["stats"], {}, lang=lang)["discussion"]]:
                assert "observed-topic" in text
                for unsupported in ["rapid recent growth", "particularly strong recent growth", "近期增长迅速", "增长势头强劲"]:
                    assert unsupported not in text
                assert "selected" in text.lower() if lang == "en" else "样本" in text


def test_real_narrative_prompt_contains_current_selection_and_actual_query(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from bibliometric.insight import ai_narrator
    ctx = _selection_context(tmp_path, "en", concepts=[{
        "label": "topic", "mesh_descriptor": None, "mesh_lookup_failed": True, "free_terms": ["topic"]}])
    captured = []
    def observe(summary, _config, lang="en"):
        captured.append(ai_narrator._build_llm_prompt(summary, lang))
        return {"discussion": "observed response"}
    monkeypatch.setattr(ai_narrator, "_try_deepseek_api", observe)
    for lang in ["en", "zh"]:
        ai_narrator.generate_ai_narratives("topic", ctx["articles"], ctx["stats"], {},
                                         config=SimpleNamespace(output_dir=tmp_path), lang=lang)
    for text in captured:
        assert "relevance" in text and "348" in text and "200" in text
        assert '\\"topic\\"[Title/Abstract]' in text or '"topic"[Title/Abstract]' in text
        assert "mesh_lookup_failed" in text
    assert "complete calendar-year" in captured[0]
    assert "全领域增长" in captured[1]
    assert "analysis of growth drivers" not in captured[0]
    assert "分析增长阶段拐点的驱动因素" not in captured[1]
