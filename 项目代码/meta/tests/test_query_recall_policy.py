from types import SimpleNamespace

from new_meta.agents.query_builder import (
    ConceptBlock,
    FreeTerm,
    QueryBuilder,
    QueryCompiler,
    StructuredQueryPlan,
    _high_recall_logic_expression,
    _normalized_pubmed_language_filter,
    _review_preserves_high_recall_contract,
    _study_design_filter,
)
from new_meta.agents.research_planner import ResearchPlanner
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _block(block_id: str, label: str) -> ConceptBlock:
    return ConceptBlock(
        block_id=block_id,
        canonical_label=label,
        free_terms=[FreeTerm(term=label)],
    )


def test_high_recall_logic_keeps_comparator_and_outcome_out_of_database_query() -> None:
    sqp = StructuredQueryPlan(
        logic_expression="P1 AND I1 AND C1 AND O1 AND S1",
        blocks=[
            _block("P1", "chronic kidney disease"),
            _block("I1", "SGLT2 inhibitor"),
            _block("C1", "placebo"),
            _block("O1", "kidney disease progression"),
            _block("S1", "randomized controlled trial"),
        ],
    )

    sqp.logic_expression = _high_recall_logic_expression(sqp)
    query = QueryCompiler(sqp).compile()

    assert sqp.logic_expression == "P1 AND I1"
    assert '"chronic kidney disease"[tiab]' in query
    assert '"SGLT2 inhibitor"[tiab]' in query
    assert '"randomized controlled trial"[tiab]' not in query
    assert "placebo" not in query
    assert "kidney disease progression" not in query


def test_high_recall_logic_combines_alternative_blocks_with_or() -> None:
    sqp = StructuredQueryPlan(
        blocks=[
            _block("P1", "heart failure"),
            _block("I1", "dapagliflozin"),
            _block("I2", "empagliflozin"),
            _block("S1", "randomized controlled trial"),
        ]
    )

    assert _high_recall_logic_expression(sqp) == "P1 AND (I1 OR I2)"


def test_no_language_restriction_is_not_emitted_as_a_pubmed_language() -> None:
    for value in (
        "all",
        "No language restriction",
        "no-language-restrictions",
        "unrestricted",
        "不限语言",
    ):
        assert _normalized_pubmed_language_filter(value) == ""

    builder = object.__new__(QueryBuilder)
    protocol = SimpleNamespace(
        study_design="",
        date_range="",
        language="No language restriction",
    )
    query = builder._apply_filters('"kidney disease"[tiab]', protocol)
    assert '"No language restriction"[la]' not in query
    assert "[la]" not in query


def test_specific_language_is_still_emitted() -> None:
    builder = object.__new__(QueryBuilder)
    protocol = SimpleNamespace(study_design="", date_range="", language="English")

    query = builder._apply_filters('"kidney disease"[tiab]', protocol)

    assert query.endswith('AND "English"[la]')


def test_llm_review_cannot_reintroduce_comparator_outcome_or_language_blocks() -> None:
    sqp = StructuredQueryPlan(
        blocks=[
            _block("P1", "chronic kidney disease"),
            _block("I1", "SGLT2 inhibitor"),
            _block("C1", "placebo"),
            _block("O1", "kidney disease progression"),
            _block("S1", "randomized controlled trial"),
        ]
    )
    sqp.logic_expression = _high_recall_logic_expression(sqp)
    compiled = QueryCompiler(sqp).compile()

    assert _review_preserves_high_recall_contract(
        reviewed=compiled,
        compiled_query=compiled,
        sqp=sqp,
    )
    assert not _review_preserves_high_recall_contract(
        reviewed=f'({compiled}) AND ("placebo"[tiab])',
        compiled_query=compiled,
        sqp=sqp,
    )
    assert not _review_preserves_high_recall_contract(
        reviewed=f'({compiled}) AND "English"[la]',
        compiled_query=compiled,
        sqp=sqp,
    )


def test_llm_review_must_retain_population_and_intervention() -> None:
    sqp = StructuredQueryPlan(
        blocks=[
            _block("P1", "chronic kidney disease"),
            _block("I1", "SGLT2 inhibitor"),
            _block("S1", "randomized controlled trial"),
        ]
    )
    sqp.logic_expression = _high_recall_logic_expression(sqp)
    compiled = QueryCompiler(sqp).compile()

    assert not _review_preserves_high_recall_contract(
        reviewed='"randomized controlled trial"[tiab]',
        compiled_query=compiled,
        sqp=sqp,
    )


def test_planner_cannot_invent_an_english_only_restriction() -> None:
    protocol = ResearchProtocol(
        research_question="SGLT2 inhibitors for chronic kidney disease",
        pico=PICO(
            population="adults with chronic kidney disease",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="kidney disease progression",
        ),
        language="English",
    )

    ResearchPlanner._apply_language_scope_rules(protocol, protocol.research_question)

    assert protocol.language == "No language restriction"


def test_explicit_user_language_restriction_is_preserved() -> None:
    protocol = ResearchProtocol(
        research_question="English-language trials of SGLT2 inhibitors",
        pico=PICO(
            population="adults",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="kidney disease progression",
        ),
        language="English",
    )

    ResearchPlanner._apply_language_scope_rules(protocol, protocol.research_question)

    assert protocol.language == "English"


def test_natural_language_rct_design_emits_canonical_pubmed_filter() -> None:
    for value in (
        "RCT",
        "randomized controlled trial",
        "Randomised controlled trials (RCTs)",
    ):
        design_filter = _study_design_filter(value)
        assert '"randomized controlled trial"[pt]' in design_filter
        assert '"randomly"[tiab]' in design_filter


def test_apply_filters_handles_planner_rct_phrase() -> None:
    builder = object.__new__(QueryBuilder)
    protocol = SimpleNamespace(
        study_design="Randomized controlled trials",
        date_range="",
        language="No language restriction",
    )

    query = builder._apply_filters('"kidney disease"[tiab]', protocol)

    assert '"randomized controlled trial"[pt]' in query
    assert '"randomly"[tiab]' in query
