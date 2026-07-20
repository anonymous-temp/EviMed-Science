"""Label cross-check tests: parsing, verbatim-quote verification, degradation."""

from __future__ import annotations

import pytest

from safety_agent.core.exceptions import LLMUnavailable, NoResults
from safety_agent.evidence.label_check import (
    _LLMCheckOutput,
    check_label_coverage,
)
from safety_agent.openfda.client import DrugLabel

_LABEL = DrugLabel(
    set_id="set-1",
    effective_time="20240101",
    brand_names=("LIPITOR",),
    generic_names=("ATORVASTATIN CALCIUM",),
    boxed_warning=(),
    adverse_reactions=(
        "The most common adverse reactions are myalgia, diarrhea, and nausea.",
    ),
    warnings=("Skeletal muscle effects including rhabdomyolysis have been reported.",),
    warnings_and_cautions=(),
)


class _FakeOpenFDA:
    def __init__(self, labels=None, error: Exception | None = None):
        self._labels = labels if labels is not None else [_LABEL]
        self._error = error

    async def search_labels(self, drug=None, *, search=None, limit=3):
        if self._error is not None:
            raise self._error
        return self._labels


class _FakeLLM:
    def __init__(self, output: dict | None = None, error: Exception | None = None):
        self._output = output
        self._error = error
        self.calls = 0

    async def complete_json(self, messages, *, schema, tier, **kwargs):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return schema.model_validate(self._output)


def _llm_output(checks: list[dict]) -> dict:
    return {"checks": checks}


async def test_happy_path_parses_statuses_and_keeps_verbatim_quotes():
    llm = _FakeLLM(
        _llm_output(
            [
                {
                    "reaction": "myalgia",
                    "status": "labeled",
                    "quotes": [
                        {
                            "section": "adverse_reactions",
                            "sentence": "The most common adverse reactions are myalgia, diarrhea, and nausea.",
                        }
                    ],
                },
                {"reaction": "pneumonia", "status": "unlabeled", "quotes": []},
            ]
        )
    )
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["myalgia", "pneumonia"]
    )
    assert report.status == "ok"
    by_reaction = {c.reaction: c for c in report.checks}
    assert by_reaction["myalgia"].status == "labeled"
    assert len(by_reaction["myalgia"].quotes) == 1
    assert by_reaction["pneumonia"].status == "unlabeled"
    assert report.label_refs and "set-1" in report.label_refs[0]


async def test_fabricated_quotes_are_dropped_and_claim_downgraded():
    llm = _FakeLLM(
        _llm_output(
            [
                {
                    "reaction": "myalgia",
                    "status": "labeled",
                    "quotes": [
                        {
                            "section": "adverse_reactions",
                            "sentence": "This sentence was hallucinated and is not on the label.",
                        }
                    ],
                }
            ]
        )
    )
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["myalgia"]
    )
    assert report.status == "ok"
    check = report.checks[0]
    # positive claim without a verifiable quote is downgraded to unlabeled
    assert check.status == "unlabeled"
    assert check.quotes == []
    assert "防编造校验" in report.note


async def test_quote_citing_spl_heading_is_located_anyway():
    """The LLM often cites the SPL heading ("5.1 Myopathy...") instead of the
    API field name; verification falls back to searching every section."""
    llm = _FakeLLM(
        _llm_output(
            [
                {
                    "reaction": "rhabdomyolysis",
                    "status": "labeled",
                    "quotes": [
                        {
                            # exists in "warnings", mislabeled as "boxed_warning"
                            "section": "boxed_warning",
                            "sentence": "Skeletal muscle effects including rhabdomyolysis have been reported.",
                        }
                    ],
                }
            ]
        )
    )
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["rhabdomyolysis"]
    )
    assert report.checks[0].status == "labeled"
    assert len(report.checks[0].quotes) == 1


async def test_truly_fabricated_sentence_still_dropped():
    llm = _FakeLLM(
        _llm_output(
            [
                {
                    "reaction": "rhabdomyolysis",
                    "status": "labeled",
                    "quotes": [
                        {"section": "warnings", "sentence": "Completely invented text."}
                    ],
                }
            ]
        )
    )
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["rhabdomyolysis"]
    )
    assert report.checks[0].status == "unlabeled"


async def test_missing_reaction_is_noted():
    llm = _FakeLLM(
        _llm_output([{"reaction": "myalgia", "status": "unlabeled", "quotes": []}])
    )
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["myalgia", "myopathy"]
    )
    assert "myopathy" in report.note


async def test_llm_failure_degrades_to_llm_unavailable():
    llm = _FakeLLM(error=LLMUnavailable("backend down"))
    report = await check_label_coverage(
        _FakeOpenFDA(), llm, "atorvastatin", ["myalgia"]
    )
    assert report.status == "llm_unavailable"
    assert report.note
    assert llm.calls == 1


async def test_no_label_records():
    report = await check_label_coverage(
        _FakeOpenFDA(error=NoResults()), _FakeLLM(_llm_output([])), "ghost", ["myalgia"]
    )
    assert report.status == "no_label_data"


async def test_label_records_without_safety_sections():
    bare = DrugLabel(
        set_id="set-2",
        effective_time=None,
        brand_names=("X",),
        generic_names=("y",),
        boxed_warning=(),
        adverse_reactions=(),
        warnings=(),
        warnings_and_cautions=(),
    )
    report = await check_label_coverage(
        _FakeOpenFDA(labels=[bare]), _FakeLLM(_llm_output([])), "x", ["myalgia"]
    )
    assert report.status == "no_label_data"
    assert report.label_refs  # the record is still referenced


def test_llm_output_schema_validation():
    parsed = _LLMCheckOutput.model_validate(
        {"checks": [{"reaction": "x", "status": "labeled", "quotes": []}]}
    )
    assert parsed.checks[0].status == "labeled"
    with pytest.raises(ValueError):
        _LLMCheckOutput.model_validate(
            {"checks": [{"reaction": "x", "status": "bogus", "quotes": []}]}
        )
