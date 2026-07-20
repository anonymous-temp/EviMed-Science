"""Pipeline orchestration tests with stubbed openFDA / LLM / evidence layers.

The stub openFDA counts are chosen so every signal row reproduces the
hand-computed T1 panel from test_signals_known_answers (a=10, b=90, c=20,
d=1880, N=2000): joint=10, drug_total=100, event_total=30, grand=2000.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from safety_agent.analysis.models import Interpretation
from safety_agent.analysis.overview import OverviewBuilder
from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.core.exceptions import (
    LLMUnavailable,
    NoDataError,
    NoResults,
    NormalizationError,
)
from safety_agent.evidence.label_check import _LLMCheckOutput
from safety_agent.faers import FrozenFAERSSnapshot
from safety_agent.openfda.client import CountTerm

T1 = {"a": 10, "b": 90, "c": 20, "d": 1880}
T1_ROR = 10.4444444444
DATA = Path(__file__).parent / "data"


class StubOpenFDA:
    """Duck-typed OpenFDAClient with deterministic counts."""

    def __init__(self, *, drug_total: int = 100, grand_total: int = 2000):
        self._drug_total = drug_total
        self._grand_total = grand_total

    async def count_total(self, search: str | None = None) -> int:
        if search is None:
            return self._grand_total
        drug = 'patient.drug.medicinalproduct:"atorvastatin"' in search
        reaction = "patient.reaction.reactionmeddrapt" in search
        if drug and reaction:
            return T1["a"]
        if drug:
            if "receivedate" in search:
                return 5
            if "patientonsetage" in search:
                return 20
            if "seriousness" in search:
                return 30
            return self._drug_total
        if reaction:
            return T1["c"] + T1["a"]  # event_total = c + a
        return 0

    async def count_terms(self, field: str, search: str | None = None, *, limit: int = 100):
        if field == "patient.reaction.reactionmeddrapt.exact":
            return [CountTerm("Nausea", 40), CountTerm("Myalgia", 35), CountTerm("Headache", 20)]
        if field == "patient.drug.medicinalproduct.exact":
            return [CountTerm("ATORVASTATIN", 100), CountTerm("ASPIRIN", 50)]
        if field == "patient.patientsex":
            return [CountTerm("1", 55), CountTerm("2", 45)]
        return [CountTerm("us", 80)]

    async def search_labels(self, drug=None, *, search=None, limit=3):
        return []  # label check degrades to no_label_data without touching the LLM


class EmptyOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if search and "medicinalproduct" in search:
            return 0
        return await super().count_total(search)


class NoResultsOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if search and ("medicinalproduct" in search or "openfda.generic_name" in search):
            raise NoResults(search=search)
        return 2000


class EmptyPrelaunchYearOpenFDA(StubOpenFDA):
    """A marketed drug with a legitimate empty annual bucket."""

    async def count_total(self, search: str | None = None) -> int:
        if search and "receivedate:[20040101 TO 20041231]" in search:
            raise NoResults(search=search)
        return await super().count_total(search)


class MetforminNormalizationOpenFDA(StubOpenFDA):
    async def count_total(self, search: str | None = None) -> int:
        if search and "metformin" in search.casefold():
            return 10
        return await super().count_total(search)


class ScopeRecordingOpenFDA(StubOpenFDA):
    def __init__(self):
        super().__init__()
        self.searches: list[str | None] = []

    async def count_total(self, search: str | None = None) -> int:
        self.searches.append(search)
        if search is None:
            return 2000
        drug = "medicinalproduct" in search
        reaction = "reactionmeddrapt" in search
        if drug and reaction:
            return 10
        if drug:
            return 100
        if reaction:
            return 30
        return 2000

    async def count_terms(self, field: str, search: str | None = None, *, limit: int = 100):
        return []


class StubLLM:
    def __init__(self, *, error: Exception | None = None):
        self._error = error
        self.interpret_calls = 0

    async def complete_json(self, messages, *, schema, tier, **kwargs):
        if self._error is not None:
            raise self._error
        if schema is Interpretation:
            self.interpret_calls += 1
            return Interpretation(
                overview="总览文字",
                demographics="人口学文字",
                outcomes="结局文字",
                signal_commentary="信号解读文字",
                label_commentary="",
                focus_adrs=[{"reaction": "myalgia", "text": "重点段落"}],
            )
        if schema is _LLMCheckOutput:
            return _LLMCheckOutput(checks=[])
        raise AssertionError(f"unexpected schema {schema}")


def _pipeline(openfda, llm=None, stages=None, **kwargs):
    on_stage = None
    if stages is not None:
        def on_stage(stage, status, detail):
            stages.append((stage, status, detail))
    return AnalysisPipeline(
        openfda=openfda,
        llm=llm,
        evidence=None,
        on_stage=on_stage,
        **kwargs,
    )


async def test_full_run_numbers_match_known_panel():
    stages: list[tuple[str, str, dict]] = []
    pipeline = _pipeline(StubOpenFDA(), llm=StubLLM(), stages=stages)
    result = await pipeline.run("Atorvastatin", ["肌痛"])

    assert result.drug_normalized == "atorvastatin"
    assert result.overview.total_reports == 100
    assert result.llm_status == "ok"
    assert result.interpretation is not None

    rows = {row.reaction: row for row in result.signals}
    # user-specified PT plus top PTs (myalgia excluded from top list)
    assert "myalgia" in rows and rows["myalgia"].source == "user-specified"
    assert rows["myalgia"].a == T1["a"]
    assert rows["myalgia"].ror == pytest.approx(T1_ROR, rel=1e-6)
    assert rows["myalgia"].is_signal is True
    assert "nausea" in rows and rows["nausea"].source == "top-pt"
    # every row shares the stub marginals, so every row is the T1 panel
    for row in result.signals:
        assert (row.a, row.b, row.c, row.d, row.n) == (10, 90, 20, 1880, 2000)
    # user-specified rows come first
    assert result.signals[0].source == "user-specified"

    started = [s for s, status, _ in stages if status == "started"]
    assert started == ["normalize", "overview", "signals", "evidence", "interpret"]
    assert any(s == "interpret" and status == "finished" for s, status, _ in stages)


async def test_no_data_raises_business_error():
    pipeline = _pipeline(EmptyOpenFDA())
    with pytest.raises(NoDataError, match="未检索到"):
        await pipeline.run("atorvastatin", ["myalgia"])


async def test_openfda_404_maps_to_no_data():
    pipeline = _pipeline(NoResultsOpenFDA())
    with pytest.raises(NoDataError):
        await pipeline.run("atorvastatin", ["myalgia"])


async def test_empty_prelaunch_year_is_zero_not_drug_level_no_data():
    pipeline = _pipeline(EmptyPrelaunchYearOpenFDA())
    result = await pipeline.run("atorvastatin", ["myalgia"])
    yearly = {bucket.term: bucket.count for bucket in result.overview.yearly}
    assert yearly["2004"] == 0
    assert result.overview.total_reports == 100


async def test_frozen_snapshot_pipeline_uses_exact_same_object_role_binding():
    snapshot = FrozenFAERSSnapshot.from_path(DATA / "faers_report_binding.json")
    pipeline = _pipeline(
        MetforminNormalizationOpenFDA(),
        faers_snapshot=snapshot,
        top_pt_count=0,
        study_date_from="2020-01-01",
        study_date_to="2020-12-31",
    )

    result = await pipeline.run("metformin", ["nausea"])

    assert result.data_source == "frozen_faers"
    assert result.suspect_binding == "same_drug_object"
    assert result.suspect_roles == ["PS"]
    assert result.snapshot_id == "synthetic-binding-v1"
    assert result.study_date_from == "2020-01-01"
    assert result.study_date_to == "2020-12-31"
    assert result.overview.total_reports == 1
    row = result.signals[0]
    assert (row.a, row.b, row.c, row.d, row.n) == (1, 0, 0, 1, 2)


async def test_live_pipeline_applies_alias_route_target_and_background_scopes():
    openfda = ScopeRecordingOpenFDA()
    pipeline = _pipeline(
        openfda,
        drug_field="medicinalproduct",
        drug_aliases=("Lipitor",),
        drug_routes=("048",),
        study_date_from="2015-01-01",
        study_date_to="2020-12-31",
        background_date_from="2004-01-01",
        background_date_to="2020-12-31",
        top_pt_count=0,
    )

    result = await pipeline.run("atorvastatin", ["myalgia"])

    assert result.study_date_from == "2015-01-01"
    assert result.study_date_to == "2020-12-31"
    assert result.background_date_from == "2004-01-01"
    assert result.background_date_to == "2020-12-31"
    assert result.administration_routes == ["048"]
    assert result.signals[0].n == 2000
    drug_searches = [
        search
        for search in openfda.searches
        if search and "medicinalproduct" in search and "drugcharacterization" in search
    ]
    assert any('medicinalproduct:"Lipitor"' in search for search in drug_searches)
    assert all('drugadministrationroute:"048"' in search for search in drug_searches)
    assert all("receivedate:[20150101 TO 20201231]" in search for search in drug_searches)
    event_searches = [
        search
        for search in openfda.searches
        if search and "reactionmeddrapt" in search and "medicinalproduct" not in search
    ]
    assert event_searches
    assert all("receivedate:[20040101 TO 20201231]" in search for search in event_searches)


async def test_live_concomitant_list_excludes_generic_and_brand_aliases():
    class AliasTerms(StubOpenFDA):
        async def count_terms(
            self, field: str, search: str | None = None, *, limit: int = 100
        ):
            return [
                CountTerm("TAFAMIDIS MEGLUMINE", 100),
                CountTerm("VYNDAMAX", 90),
                CountTerm("VYNDAQEL", 80),
                CountTerm("FUROSEMIDE", 70),
            ]

    buckets = await OverviewBuilder(AliasTerms())._concomitant_drugs(
        "search",
        "tafamidis",
        drug_aliases=("tafamidis meglumine", "Vyndaqel", "Vyndamax"),
    )

    assert [(bucket.term, bucket.count) for bucket in buckets] == [
        ("FUROSEMIDE", 70)
    ]


async def test_live_concomitant_filter_does_not_expand_short_alias_substrings():
    class ShortAliasTerms(StubOpenFDA):
        async def count_terms(
            self, field: str, search: str | None = None, *, limit: int = 100
        ):
            return [CountTerm("AT", 100), CountTerm("ATORVASTATIN", 90)]

    buckets = await OverviewBuilder(ShortAliasTerms())._concomitant_drugs(
        "search", "target", drug_aliases=("at",)
    )

    assert [(bucket.term, bucket.count) for bucket in buckets] == [
        ("ATORVASTATIN", 90)
    ]


async def test_live_country_top_ten_keeps_an_explicit_missing_bucket():
    class CountryTerms(StubOpenFDA):
        async def count_total(self, search: str | None = None) -> int:
            if search and "occurcountry:*" in search:
                return 90
            return await super().count_total(search)

        async def count_terms(
            self, field: str, search: str | None = None, *, limit: int = 100
        ):
            assert field == "occurcountry.exact"
            assert limit == 10
            return [CountTerm("US", 70), CountTerm("JP", 20)]

    buckets = await OverviewBuilder(CountryTerms())._countries("search", 100)

    assert [(bucket.term, bucket.count) for bucket in buckets] == [
        ("US", 70),
        ("JP", 20),
        ("not reported", 10),
    ]


async def test_empty_drug_query_raises_normalization_error():
    pipeline = _pipeline(StubOpenFDA())
    with pytest.raises(NormalizationError):
        await pipeline.run("   ", ["myalgia"])


async def test_unresolvable_adr_raises_with_candidates():
    pipeline = _pipeline(StubOpenFDA())
    with pytest.raises(NormalizationError) as excinfo:
        await pipeline.run("atorvastatin", ["某种不存在的不良反应xyz"])
    assert "无法归一化" in excinfo.value.message


async def test_llm_failure_degrades_to_statistics_only():
    stages: list[tuple[str, str, dict]] = []
    llm = StubLLM(error=LLMUnavailable("backend down"))
    pipeline = _pipeline(StubOpenFDA(), llm=llm, stages=stages)
    result = await pipeline.run("atorvastatin", ["myalgia"])

    assert result.llm_status == "degraded"
    assert result.interpretation is None
    assert any("LLM 解读失败" in note for note in result.degradation_notes)
    # statistics are intact despite the LLM outage
    assert result.signals[0].ror == pytest.approx(T1_ROR, rel=1e-6)
    assert any(s == "interpret" and status == "degraded" for s, status, _ in stages)


async def test_no_llm_marks_not_configured():
    pipeline = _pipeline(StubOpenFDA(), llm=None)
    result = await pipeline.run("atorvastatin", ["myalgia"])
    assert result.llm_status == "not_configured"
    assert result.interpretation is None
    assert any("LLM 未配置" in note for note in result.degradation_notes)


async def test_evidence_layer_disabled_is_visible():
    pipeline = _pipeline(StubOpenFDA(), llm=StubLLM())
    result = await pipeline.run("atorvastatin", ["myalgia"])
    assert result.evidence is not None
    assert result.evidence.enabled is False
    assert "未启用" in result.evidence.note
    assert any("未启用" in note for note in result.degradation_notes)


async def test_label_check_degrades_without_label_records():
    pipeline = _pipeline(StubOpenFDA(), llm=StubLLM())
    result = await pipeline.run("atorvastatin", ["myalgia"])
    assert result.label_check is not None
    assert result.label_check.status == "no_label_data"


async def test_query_urls_cover_traceability():
    pipeline = _pipeline(StubOpenFDA(), llm=StubLLM())
    result = await pipeline.run("atorvastatin", ["myalgia"])
    urls = result.query_urls
    assert "drug_total" in urls and "grand_total" in urls
    assert "signal_joint[myalgia]" in urls
    assert "label_search" in urls
    assert urls["drug_total"].startswith("https://api.fda.gov/drug/event.json")


async def test_pipeline_timeout_enforced():
    class SlowOpenFDA(StubOpenFDA):
        async def count_total(self, search=None):
            import asyncio

            await asyncio.sleep(5)
            return 0

    pipeline = _pipeline(SlowOpenFDA(), timeout_seconds=0.2)
    with pytest.raises(TimeoutError):
        await pipeline.run("atorvastatin", ["myalgia"])
