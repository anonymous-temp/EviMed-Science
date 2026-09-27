"""The shipped FAERS reaction vocabulary, the crawl that regenerates it, and the
index that matches a query against it.

Offline: the crawl is driven through a fake fetch and a mocked HTTP transport.
"""

from __future__ import annotations

import json

import httpx
import pytest

from safety_agent.normalize import build_vocabulary as builder
from safety_agent.normalize.vocabulary import (
    VOCABULARY_PATH,
    VocabularyAmbiguity,
    VocabularyIndex,
    VocabularyMatch,
    canonical,
    inflection_variants,
    spelling_variants,
)

# -- the shipped file ------------------------------------------------------------


def test_vocabulary_file_is_the_harvest_it_claims():
    document = json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))
    terms = document["terms"]
    assert document["schemaVersion"] == 1
    assert "patient.reaction.reactionmeddrapt.exact" in document["source"]
    assert document["sourceLastUpdated"], "the openFDA data date must be recorded"
    assert document["stopReason"] is None, "a harvest openFDA cut short must not ship"
    assert document["termCount"] == len(terms)
    # Walk floor: the 119-term table this replaced would pass every check below.
    assert len(terms) >= 10_000
    assert all(key == canonical(key) for key in terms), "keys must be stored canonical"
    assert all(isinstance(count, int) and count > 0 for count in terms.values())
    assert list(terms) == sorted(terms), "sorted, so a regeneration diffs by term"


# -- the index -------------------------------------------------------------------


def test_canonical_folds_case_space_dashes_and_quotes():
    assert canonical("  Crohn’s   Disease. ") == "crohn's disease"
    assert canonical("Stevens–Johnson syndrome") == "stevens-johnson syndrome"


def test_rule_variants_are_proposals_the_index_confirms():
    assert "haemorrhagic stroke" in spelling_variants("hemorrhagic stroke")
    assert "oedema peripheral" in spelling_variants("edema peripheral")
    assert inflection_variants("muscle spasm")[0] == "muscle spasms"
    assert "seizure" in inflection_variants("seizures")


def test_a_rule_that_produces_no_vocabulary_term_changes_nothing():
    index = VocabularyIndex({"haemorrhage": 10})
    assert index.resolve("hemiparesis") is None  # hem- -> haem- yields no term
    assert index.resolve("hemorrhage") == VocabularyMatch("haemorrhage", "pt-spelling", 0.95)


def test_two_terms_matching_at_one_step_is_ambiguity_not_a_choice():
    index = VocabularyIndex({"x-ray abnormal": 5, "x ray abnormal": 3})
    match = index.resolve("x/ray abnormal")
    assert isinstance(match, VocabularyAmbiguity)
    assert match.terms == ("x-ray abnormal", "x ray abnormal")


def test_candidates_rank_near_spellings_first():
    index = VocabularyIndex({"bradycardia": 50_000, "sinus bradycardia": 900, "urticaria": 90_000})
    assert index.candidates("bradicardia")[0][0] == "bradycardia"


# -- the crawl -------------------------------------------------------------------


def test_words_worth_asking_about():
    assert builder.words_of("Electrocardiogram QT prolonged") == ["electrocardiogram", "prolonged"]
    assert builder.words_of("Injury of the 5th finger") == ["injury", "5th", "finger"]


def test_harvest_asks_globally_then_by_the_widest_family_and_stops_at_budget():
    asked: list[dict] = []
    responses = {
        None: [{"term": "CARDIAC FAILURE", "count": 90}, {"term": "CARDIAC ARREST", "count": 80},
               {"term": "NAUSEA", "count": 70}],
        'patient.reaction.reactionmeddrapt:"cardiac"': [
            {"term": "CARDIAC FAILURE CONGESTIVE", "count": 60}, {"term": "NAUSEA", "count": 75}],
        'patient.reaction.reactionmeddrapt:"failure"': [{"term": "RENAL FAILURE", "count": 50}],
    }

    def fetch(params):
        asked.append(params)
        return {"meta": {"last_updated": "2026-07-30"}, "results": responses.get(params.get("search"), [])}

    result = builder.harvest(fetch, budget=3, limit=999)

    assert [params.get("search") for params in asked] == [
        None,
        'patient.reaction.reactionmeddrapt:"cardiac"',
        'patient.reaction.reactionmeddrapt:"failure"',
    ]
    assert all(params["limit"] == "999" for params in asked)
    assert result.requests == 3
    assert result.terms["nausea"] == 75  # the largest count seen
    assert set(result.terms) == {
        "cardiac failure", "cardiac arrest", "nausea", "cardiac failure congestive", "renal failure",
    }
    document = builder.vocabulary_document(result, limit=999, budget=3)
    assert document["termCount"] == 5 and document["sourceLastUpdated"] == "2026-07-30"
    assert document["stopReason"] is None


def test_a_refused_harvest_keeps_what_it_found_and_says_why():
    calls = {"n": 0}

    def fetch(params):
        calls["n"] += 1
        if calls["n"] == 2:
            raise builder.HarvestStopped("openFDA refused the request (API_KEY_MISSING)")
        return {"results": [{"term": "RASH", "count": 5}]}

    result = builder.harvest(fetch, budget=10, limit=999)
    assert result.terms == {"rash": 5}
    assert result.stop_reason == "openFDA refused the request (API_KEY_MISSING)"


def test_http_fetch_retries_rate_limits_and_never_retries_a_refusal():
    statuses = iter([429, 200])

    def handler(request):
        assert "api_key" not in str(request.url)
        status = next(statuses)
        return httpx.Response(status, json={"results": []} if status == 200 else {})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    fetch = builder.http_fetch(client, api_key=None, sleep=lambda _s: None)
    assert fetch({"count": builder.COUNT_FIELD}) == {"results": []}

    refusing = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(403, json={"error": {"code": "API_KEY_MISSING"}})
        )
    )
    with pytest.raises(builder.HarvestStopped, match="API_KEY_MISSING"):
        builder.http_fetch(refusing, api_key=None, sleep=lambda _s: None)({"count": "x"})
