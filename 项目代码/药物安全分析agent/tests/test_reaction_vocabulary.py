"""ADR normalization against the FAERS vocabulary, the confirmed model path,
and the 2026-09-15 incident they exist for.

On 2026-09-15 a production adr-analysis run lost 21 of its 27 engine jobs to
ADR normalization: the engine knew 119 built-in PTs, had no path for an
English term outside them, and one unrecognized term failed the whole job.
These tests hold the fixes: English terms resolve against a vocabulary
harvested from openFDA's own reaction field (test_build_vocabulary.py), rules
only ever pick a vocabulary term, a model reading is used only once the
vocabulary or an openFDA count confirms it, and an unresolvable term is set
aside with its candidates instead of failing the terms that did resolve.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.analysis.runner import module_ledger
from safety_agent.core.exceptions import NoResults, NormalizationError, OpenFDAUnavailable
from safety_agent.normalize.adr import normalize_adr, normalize_adr_async
from safety_agent.normalize.adr_map import EN_ALIAS_TO_PT, ZH_TO_PT
from safety_agent.normalize.vocabulary import VOCABULARY_PATH, VocabularyIndex, load_vocabulary
from safety_agent.openfda.client import CountTerm
from safety_agent.report.markdown import render_markdown

DATA = Path(__file__).parent / "data"
INCIDENT = json.loads((DATA / "adr_terms_2026_09_15.json").read_text(encoding="utf-8"))
DETERMINISTIC = {"pt-direct", "pt-punctuation", "pt-spelling", "pt-inflection", "en-alias", "zh-map"}


def _incident_terms() -> list[tuple[str, str]]:
    panel = [(row["term"], row["expected"]) for row in INCIDENT["auditProbePanel"]]
    jobs = [(row["term"], row["expected"]) for row in INCIDENT["jobTerms"]]
    reconstructed = [(row["term"], row["expected"]) for row in INCIDENT["reconstructedTerms"]["terms"]]
    brief = [(row["term"], row["expected"]) for row in INCIDENT["briefTerms"]["terms"]]
    return panel + jobs + reconstructed + brief


def test_every_curated_mapping_names_a_faers_term():
    """A value FAERS never carries matches no report under .exact. Seven did."""
    terms = json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))["terms"]
    curated = {**ZH_TO_PT, **EN_ALIAS_TO_PT}
    missing = sorted({pt for pt in curated.values() if pt not in terms})
    assert missing == []


def test_loaded_vocabulary_includes_the_curated_pts():
    vocabulary = load_vocabulary()
    assert len(vocabulary) >= 10_000
    assert all(pt in vocabulary for pt in ZH_TO_PT.values())


# -- the incident ------------------------------------------------------------------


@pytest.mark.parametrize("term,expected", _incident_terms())
def test_the_2026_09_15_terms_resolve_without_a_model(term, expected):
    result = normalize_adr(term)
    assert result.normalized == expected, (term, result)
    assert result.method in DETERMINISTIC
    assert result.confidence >= 0.85


def test_the_incident_case_walked_every_list():
    counts = {
        "panel": len(INCIDENT["auditProbePanel"]),
        "reconstructed": len(INCIDENT["reconstructedTerms"]["terms"]),
        "brief": len(INCIDENT["briefTerms"]["terms"]),
    }
    assert counts == {"panel": 7, "reconstructed": 16, "brief": 12}
    assert sum(1 for row in INCIDENT["auditProbePanel"] if row["failedOn"]) == 4


def test_bradycardia_is_no_longer_offered_urticaria():
    result = normalize_adr("bradycardia")
    assert result.normalized == "bradycardia"
    assert all(candidate.term != "urticaria" for candidate in result.candidates)


# -- deterministic variants --------------------------------------------------------


@pytest.mark.parametrize(
    "query,expected,method",
    [
        ("Ventricular Fibrillation", "ventricular fibrillation", "pt-direct"),
        ("  myocarditis. ", "myocarditis", "pt-direct"),
        ("Crohn’s disease", "crohn's disease", "pt-direct"),
        ("Stevens Johnson syndrome", "stevens-johnson syndrome", "pt-punctuation"),
        ("drug induced liver injury", "drug-induced liver injury", "pt-punctuation"),
        ("hemorrhagic stroke", "haemorrhagic stroke", "pt-spelling"),
        ("ischemic stroke", "ischaemic stroke", "pt-spelling"),
        ("esophagitis", "oesophagitis", "pt-spelling"),
        ("leukemia", "leukaemia", "pt-spelling"),
        ("hemolytic anemia", "haemolytic anaemia", "pt-spelling"),
        ("tumor lysis syndrome", "tumour lysis syndrome", "pt-spelling"),
        ("hospitalization", "hospitalisation", "pt-spelling"),
        ("palpitation", "palpitations", "pt-inflection"),
        ("muscle spasm", "muscle spasms", "pt-inflection"),
        ("seizures", "seizure", "pt-inflection"),
        ("hot flushes", "hot flush", "pt-inflection"),
    ],
)
def test_rule_variants_resolve_only_to_vocabulary_terms(query, expected, method):
    result = normalize_adr(query)
    assert (result.normalized, result.method) == (expected, method)


def test_a_wrong_letter_is_not_a_rule():
    result = normalize_adr("bradicardia")
    assert result.normalized is None
    assert result.method == "unresolved"
    assert result.candidates[0].term == "bradycardia"


def test_ambiguity_reaches_the_caller_as_candidates(monkeypatch):
    import safety_agent.normalize.adr as adr

    index = VocabularyIndex({"x-ray abnormal": 5, "x ray abnormal": 3})
    monkeypatch.setattr(adr, "load_vocabulary", lambda: index)
    result = adr.normalize_adr("x/ray abnormal")
    assert result.normalized is None
    assert result.method == "ambiguous"
    assert [c.term for c in result.candidates] == ["x-ray abnormal", "x ray abnormal"]


# -- confirmed model and openFDA paths ------------------------------------------


class _Counts:
    """openFDA count_total by exact reaction; everything else is no result."""

    def __init__(self, known: dict[str, int], *, error: Exception | None = None):
        self.known = known
        self.error = error
        self.searches: list[str | None] = []

    async def count_total(self, search: str | None = None) -> int:
        self.searches.append(search)
        if self.error is not None:
            raise self.error
        for term, count in self.known.items():
            if f'patient.reaction.reactionmeddrapt.exact:"{term}"' == search:
                return count
        raise NoResults(search=search)


class _Model:
    def __init__(self, answer: str | None):
        self.answer = answer
        self.queries: list[str] = []

    async def suggest_adr_pt(self, query: str) -> str | None:
        self.queries.append(query)
        return self.answer


RARE = "hypothetical rare reaction"  # not in the vocabulary by construction


async def test_an_english_term_outside_the_vocabulary_is_confirmed_by_openfda():
    assert normalize_adr(RARE).normalized is None
    result = await normalize_adr_async(RARE, client=_Counts({RARE: 3}))
    assert (result.normalized, result.method) == (RARE, "openfda-confirmed")


async def test_openfda_zero_or_failure_confirms_nothing():
    assert (await normalize_adr_async(RARE, client=_Counts({}))).normalized is None
    failing = _Counts({RARE: 3}, error=OpenFDAUnavailable("down"))
    result = await normalize_adr_async(RARE, client=failing)
    assert result.normalized is None
    assert result.method == "unresolved"


async def test_english_lay_terms_now_reach_the_model_and_its_answer_is_checked():
    model = _Model("palpitations")
    result = await normalize_adr_async("heart racing", llm_fallback=model, client=_Counts({}))
    assert model.queries == ["heart racing"]
    assert (result.normalized, result.method, result.confidence) == (
        "palpitations", "llm-fallback", 0.6,
    )


async def test_a_model_answer_only_openfda_knows_is_used_at_lower_confidence():
    result = await normalize_adr_async(
        "made-up lay phrase", llm_fallback=_Model(RARE), client=_Counts({RARE: 2})
    )
    assert (result.normalized, result.method, result.confidence) == (RARE, "llm-fallback", 0.5)


async def test_a_model_answer_nobody_confirms_is_only_a_candidate():
    result = await normalize_adr_async(
        "made-up lay phrase", llm_fallback=_Model(RARE), client=_Counts({})
    )
    assert result.normalized is None
    assert result.candidates[0].term == RARE
    assert result.candidates[0].source == "llm-unconfirmed"


async def test_a_deterministic_hit_never_asks_openfda_or_the_model():
    client, model = _Counts({}), _Model("must-not-be-used")
    result = await normalize_adr_async("Bradycardia", llm_fallback=model, client=client)
    assert result.normalized == "bradycardia"
    assert client.searches == [] and model.queries == []


async def test_chinese_is_never_sent_to_openfda_as_a_reaction():
    client = _Counts({})
    await normalize_adr_async("某种不存在的不良反应xyz", client=client)
    assert client.searches == []


# -- the pipeline keeps the terms it can compute ---------------------------------


class _PipelineOpenFDA:
    """Counts for atorvastatin; reaction-only counts exist for known PTs only."""

    async def count_total(self, search: str | None = None) -> int:
        if search is None:
            return 2000
        drug = 'patient.drug.medicinalproduct:"atorvastatin"' in search
        reaction = "patient.reaction.reactionmeddrapt" in search
        if reaction and not drug and "myalgia" not in search and "nausea" not in search:
            raise NoResults(search=search)
        if drug and reaction:
            return 10
        if drug:
            return 5 if "receivedate" in search else 100
        if reaction:
            return 30
        return 0

    async def count_terms(self, field: str, search: str | None = None, *, limit: int = 100):
        if field == "patient.reaction.reactionmeddrapt.exact":
            return [CountTerm("Nausea", 40)]
        if field == "patient.drug.medicinalproduct.exact":
            return [CountTerm("ATORVASTATIN", 100)]
        if field == "patient.patientsex":
            return [CountTerm("1", 55)]
        return [CountTerm("us", 80)]

    async def search_labels(self, drug=None, *, search=None, limit=3):
        return []


async def test_one_unresolvable_term_no_longer_fails_the_job():
    pipeline = AnalysisPipeline(openfda=_PipelineOpenFDA(), llm=None, evidence=None)
    result = await pipeline.run("atorvastatin", ["myalgia", "bradicardia"])

    assert [r.normalized for r in result.reactions] == ["myalgia"]
    assert [item.query for item in result.unresolved_reactions] == ["bradicardia"]
    assert "bradycardia" in result.unresolved_reactions[0].candidates
    assert any("bradicardia" in note for note in result.degradation_notes)
    ledger = module_ledger(result)["reactionMatching"]
    assert ledger["status"] == "degraded" and "bradicardia" in ledger["reason"]
    assert "未归一" in render_markdown(result)


async def test_every_requested_term_unresolvable_still_refuses_with_candidates():
    pipeline = AnalysisPipeline(openfda=_PipelineOpenFDA(), llm=None, evidence=None)
    with pytest.raises(NormalizationError) as refused:
        await pipeline.run("atorvastatin", ["bradicardia"])
    assert "bradycardia" in str(refused.value)
