"""The reaction clause must count what the ranking counted (R054), the tier a
run used must be named (R053), and ROR/PRR must have one implementation (R055).
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.openfda.client import CountTerm
from safety_agent.openfda.queries import (
    FIELD_REACTION,
    FIELD_REACTION_EXACT,
    reaction_clause,
)
from safety_agent.signals import analyze, build_table_from_counts, evaluate

ENGINE_ROOT = Path(__file__).resolve().parents[1] / "safety_agent"


class RecordingOpenFDA:
    """Counts by term, the way openFDA's .exact field does.

    The non-exact field tokenises, so "anaemia" also matches "aplastic
    anaemia". Live openFDA on 2026-09-10 shows the same shape for a commoner
    pair: reactionmeddrapt:"Pain" = 2,213,074 reports against
    reactionmeddrapt.exact:"Pain" = 607,158.
    """

    EXACT_COUNTS = {"anaemia": 600, "aplastic anaemia": 300, "nausea": 400}

    def __init__(self, *, drug_total: int = 1000, grand_total: int = 20000,
                 known: dict[str, int] | None = None):
        self._drug_total = drug_total
        self._grand_total = grand_total
        self._known = known if known is not None else dict(self.EXACT_COUNTS)
        self.searches: list[str | None] = []

    def _term(self, search: str) -> str | None:
        for field in (FIELD_REACTION_EXACT, FIELD_REACTION):
            marker = f'{field}:"'
            if marker in search:
                start = search.index(marker) + len(marker)
                return search[start:search.index('"', start)].casefold()
        return None

    def _event_total(self, search: str) -> int:
        term = self._term(search)
        if term is None:
            return 0
        if FIELD_REACTION_EXACT in search:
            return self._known.get(term, 0)
        # tokenised: every stored term containing the requested one
        return sum(count for stored, count in self._known.items() if term in stored)

    async def count_total(self, search: str | None = None) -> int:
        self.searches.append(search)
        if search is None:
            return self._grand_total
        drug = "medicinalproduct" in search or "generic_name" in search
        reaction = FIELD_REACTION in search
        if drug and reaction:
            return min(50, self._event_total(search))
        if drug:
            if "receivedate" in search or "patientonsetage" in search or "seriousness" in search:
                return 10
            return self._drug_total
        if reaction:
            return self._event_total(search)
        return self._grand_total

    async def count_terms(self, field: str, search: str | None = None, *, limit: int = 100):
        if field == FIELD_REACTION_EXACT:
            return [CountTerm("Anaemia", 600), CountTerm("Nausea", 400)]
        if field.endswith("medicinalproduct.exact"):
            return [CountTerm("ATORVASTATIN", 1000)]
        if field == "patient.patientsex":
            return [CountTerm("1", 5), CountTerm("2", 5)]
        return [CountTerm("us", 10)]

    async def search_labels(self, drug=None, *, search=None, limit=3):
        return []


def _pipeline(openfda, **kwargs):
    return AnalysisPipeline(openfda=openfda, llm=None, evidence=None, **kwargs)


# --------------------------------------------------------------------- R054

def test_reaction_clause_can_ask_for_the_exact_field():
    assert reaction_clause("Pain", exact=True) == f'{FIELD_REACTION_EXACT}:"Pain"'
    assert reaction_clause("Pain") == f'{FIELD_REACTION}:"Pain"'


async def test_signal_counts_use_the_field_the_ranking_used():
    openfda = RecordingOpenFDA()
    result = await _pipeline(openfda).run("Atorvastatin", ["anaemia"])

    reaction_searches = [
        s for s in openfda.searches if s and FIELD_REACTION in s
    ]
    assert reaction_searches, "no reaction query was issued"
    assert all(FIELD_REACTION_EXACT in s for s in reaction_searches), (
        "a reaction count still used the tokenised field: "
        + str([s for s in reaction_searches if FIELD_REACTION_EXACT not in s])
    )
    row = next(r for r in result.signals if r.reaction.casefold() == "anaemia")
    # 600 (.exact), not 900 (anaemia + aplastic anaemia).
    assert row.a + row.c == 600


async def test_a_reaction_with_no_faers_report_produces_no_row():
    """A term that normalises to a real PT but that no FAERS report used."""
    openfda = RecordingOpenFDA(known={"anaemia": 600, "aplastic anaemia": 300})
    result = await _pipeline(openfda).run("Atorvastatin", ["nausea"])

    assert [r.reaction for r in result.signals if r.source == "user-specified"] == []
    assert result.unmatched_reactions == ["nausea"]
    assert any("无任何匹配报告" in note for note in result.degradation_notes)


async def test_the_unmatched_term_is_emitted_as_a_degraded_stage():
    stages: list[tuple[str, str, dict]] = []

    def on_stage(stage, status, detail):
        stages.append((stage, status, detail))

    await _pipeline(
        RecordingOpenFDA(known={"anaemia": 600}), on_stage=on_stage
    ).run("Atorvastatin", ["nausea"])
    degraded = [d for s, status, d in stages if s == "signals" and status == "degraded"]
    assert degraded and degraded[0]["reason"] == "unmatched_reaction_terms"


def test_an_unmatched_pt_row_would_have_reported_ror_equal_to_d_over_b():
    """Why the row is dropped rather than published: a=0 and c=0 are Haldane
    corrected to 0.5, and ROR collapses to d/b."""
    table = build_table_from_counts(joint=0, drug_total=120_000, event_total=0,
                                    grand_total=18_000_000)
    metrics = analyze(table)
    assert metrics.haldane_anscombe_applied is True
    assert metrics.ror.value == pytest.approx(table.d / table.b, rel=1e-4)
    assert metrics.ror.value > 100
    assert evaluate(metrics).is_signal is False  # but the row still printed


# --------------------------------------------------------------------- R053

def test_a_missing_snapshot_is_a_named_condition_not_silence():
    source = (ENGINE_ROOT / "api" / "service.py").read_text(encoding="utf-8")
    assert 'self.snapshot_status = (' in source
    assert '"faers_snapshot_not_configured"' in source
    assert 'self.data_tier = ' in source


def test_class_analysis_names_the_missing_snapshot_in_its_error():
    source = (ENGINE_ROOT / "api" / "service.py").read_text(encoding="utf-8")
    marker = source.index("drug-class analysis requires")
    window = source[marker - 200:marker + 200]
    assert "faers_snapshot_not_configured" in window
    assert "FAERS_SNAPSHOT_PATH" in window


async def test_the_signal_csv_header_names_the_tier(tmp_path):
    from safety_agent.analysis.runner import write_artifacts
    from safety_agent.report.markdown import signal_provenance

    result = await _pipeline(RecordingOpenFDA()).run("Atorvastatin", ["anaemia"])
    provenance = signal_provenance(result)
    assert provenance["data_source"] == "openfda_live"
    assert provenance["gps_prior_fitted"] == "false"

    artifacts = write_artifacts(result, tmp_path, stem="safety-report")
    assert artifacts["provenance"].is_file()
    written = json.loads(artifacts["provenance"].read_text(encoding="utf-8"))
    assert written["data_source"] == "openfda_live"
    first_line = artifacts["csv"].read_text(encoding="utf-8").splitlines()[0]
    assert first_line.startswith("# data_source=openfda_live")


def test_the_runner_reports_the_tier_in_result_json():
    source = (ENGINE_ROOT.parent / "evimed_runner.py").read_text(encoding="utf-8")
    assert '"dataSource": provenance.get("data_source"' in source
    assert '"gpsPriorFitted"' in source
    assert '"snapshotId"' in source


# --------------------------------------------------------------------- R055

def _defines_ratio(path: Path) -> list[str]:
    """Function names in this file that compute ROR or PRR."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in {"ror", "prr", "reporting_odds_ratio", "proportional_reporting_ratio"}
    ]


def test_the_engine_has_exactly_one_ror_and_one_prr():
    """The MCP server ships a second implementation with a different drug field,
    role filter, chi-square, zero-cell rule and decision rule
    (OpenScience/runtime/mcp/evimed-research/public_sources.py, adr_signal).
    That file is outside this repository; inside the engine there is one."""
    definitions: dict[str, list[str]] = {}
    for path in ENGINE_ROOT.rglob("*.py"):
        names = _defines_ratio(path)
        if names:
            definitions[str(path.relative_to(ENGINE_ROOT))] = names
    assert definitions == {"signals/disproportionality.py": ["ror", "prr"]}


def test_every_engine_caller_goes_through_the_shared_entry_points():
    """No module may assemble its own 2x2 arithmetic instead of calling
    build_table_from_counts + analyze."""
    offenders = []
    for path in ENGINE_ROOT.rglob("*.py"):
        if path.name in {"disproportionality.py", "tables.py", "mgps_fit.py", "_gamma.py"}:
            continue
        body = path.read_text(encoding="utf-8")
        if re.search(r"(?<![\w.])(?<!def )analyze\(", body) and (
            "build_table_from_counts" not in body and "contingency" not in body
        ):
            offenders.append(str(path.relative_to(ENGINE_ROOT)))
    assert offenders == []


# ------------------------------------------------- module ledger (class D)

async def test_the_ledger_names_the_tier_and_every_degraded_step():
    from safety_agent.analysis.runner import module_ledger, module_ledger_is_degraded

    result = await _pipeline(RecordingOpenFDA()).run("Atorvastatin", ["anaemia"])
    modules = module_ledger(result)

    assert modules["dataSource"]["status"] == "ok"
    assert "tier=openfda_live" in modules["dataSource"]["reason"]
    assert modules["disproportionality"]["status"] == "ok"
    assert modules["reactionMatching"]["status"] == "ok"
    # No key configured in the test fixture, so the model step is skipped, and
    # the starting prior is not a fitted one: both are named, not implied.
    assert modules["llmInterpretation"]["status"] == "skipped"
    assert modules["gpsPrior"]["status"] == "degraded"
    assert module_ledger_is_degraded(modules) is True
    assert not any(entry.get("fatal") for entry in modules.values())


async def test_an_unmatched_reaction_appears_in_the_ledger():
    from safety_agent.analysis.runner import module_ledger

    result = await _pipeline(
        RecordingOpenFDA(known={"anaemia": 600})
    ).run("Atorvastatin", ["nausea"])
    entry = module_ledger(result)["reactionMatching"]
    assert entry["status"] == "degraded"
    assert "nausea" in entry["reason"]


async def test_the_written_provenance_carries_the_ledger(tmp_path):
    from safety_agent.analysis.runner import write_artifacts

    result = await _pipeline(RecordingOpenFDA()).run("Atorvastatin", ["anaemia"])
    artifacts = write_artifacts(result, tmp_path, stem="safety-report")
    written = json.loads(artifacts["provenance"].read_text(encoding="utf-8"))
    assert written["modules"]["dataSource"]["status"] == "ok"
    assert written["data_source"] == "openfda_live"


def test_the_runner_derives_degraded_from_the_ledger():
    source = (ENGINE_ROOT.parent / "evimed_runner.py").read_text(encoding="utf-8")
    assert '"modules": provenance.get("modules", {})' in source
    assert '"degraded": any(' in source
