from new_meta.main import _apply_topic_date_range, _broaden_protocol_for_retry, _unpack_query_result
from new_meta.agents.query_builder import QueryBuilder, normalize_pubmed_boolean_not_scope
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_unpack_query_result_accepts_legacy_and_current_shapes() -> None:
    assert _unpack_query_result("query") == ("query", "", False)
    assert _unpack_query_result(("query", "report")) == ("query", "report", False)
    assert _unpack_query_result(("query", "report", True)) == ("query", "report", True)


def test_broaden_protocol_for_retry_preserves_topic_terms() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for COVID-19 mortality",
        pico=PICO(
            population="critically ill COVID-19 patients",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
    )

    comparator = _broaden_protocol_for_retry(protocol)

    assert "systemic corticosteroids" in comparator
    assert "usual care" in comparator
    assert "metformin" not in comparator.lower()
    assert "antihyperglycemic" not in comparator.lower()


def test_apply_topic_date_range_fills_explicit_until_year() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for COVID-19 mortality through September 2020",
        pico=PICO(
            population="critically ill COVID-19 patients",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
    )

    _apply_topic_date_range(protocol, protocol.research_question)

    assert protocol.date_range == "to 2020"


def test_query_builder_reinserts_mandatory_covid_concept() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill SARS-CoV-2 patients in ICU",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
    )

    query, report = QueryBuilder()._enforce_required_concepts(
        protocol,
        '("critically ill"[tiab]) AND ("corticosteroids"[tiab])',
        "report",
    )

    assert "COVID-19" in query
    assert "SARS-CoV-2" in query
    assert "Deterministic Query Safety Checks" in report


def test_normalize_pubmed_boolean_not_scope_lifts_inline_not_terms_from_or_group() -> None:
    query = (
        '("HFpEF"[tiab] OR "HF-REF"[tiab] NOT '
        '"heart failure reduced ejection fraction"[tiab] NOT "HFrEF"[tiab]) '
        'AND ("dapagliflozin"[tiab])'
    )

    normalized, changed = normalize_pubmed_boolean_not_scope(query)

    assert changed is True
    assert (
        '(("HFpEF"[tiab] OR "HF-REF"[tiab]) NOT '
        '("heart failure reduced ejection fraction"[tiab] OR "HFrEF"[tiab]))'
    ) in normalized
    assert 'OR "HF-REF"[tiab] NOT' not in normalized


def test_query_builder_run_reports_boolean_not_scope_normalization(monkeypatch) -> None:
    protocol = ResearchProtocol(
        research_question="SGLT2 inhibitors in HFpEF",
        pico=PICO(
            population="heart failure with preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="cardiovascular death or HF hospitalization",
        ),
    )
    builder = QueryBuilder()
    monkeypatch.setattr(
        builder,
        "_build_with_sqp",
        lambda _protocol: (
            '("HFpEF"[tiab] OR "HF-REF"[tiab] NOT "HFrEF"[tiab]) AND ("SGLT2"[tiab])',
            "report",
        ),
    )

    query, report, _ = builder.run(protocol)

    assert 'OR "HF-REF"[tiab] NOT' not in query
    assert "Boolean NOT Scope Normalization" in report


def test_query_builder_run_uses_deterministic_emergency_query_when_llm_fallback_fails(monkeypatch) -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill SARS-CoV-2 patients in ICU",
            intervention="systemic corticosteroids including hydrocortisone",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        study_design="RCT",
    )
    builder = QueryBuilder()

    monkeypatch.setattr(builder, "_build_with_sqp", lambda _protocol: (_ for _ in ()).throw(RuntimeError("blocked")))
    monkeypatch.setattr(builder, "_build_fallback", lambda _protocol: (_ for _ in ()).throw(RuntimeError("blocked again")))

    query, report, single_drug = builder.run(protocol)

    assert isinstance(single_drug, bool)
    assert "COVID-19" in query
    assert "SARS-CoV-2" in query
    assert "hydrocortisone" in query
    assert "mortality" in query
    assert "randomized controlled trial" in query.lower()
    assert "SEARCH STRATEGY REPORT (EMERGENCY — DETERMINISTIC)" in report
