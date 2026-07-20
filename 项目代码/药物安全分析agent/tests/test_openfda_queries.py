"""openFDA search-clause builder tests."""

from __future__ import annotations

import pytest

from safety_agent.core.exceptions import SafetyAgentError
from safety_agent.openfda.queries import (
    EventQuery,
    age_range_clause,
    country_clause,
    date_range_clause,
    drug_clause,
    outcome_clause,
    quoted_term,
    reaction_clause,
    serious_clause,
    sex_clause,
)


def test_drug_clause_uses_fully_qualified_path():
    # openFDA drug/event 404s on bare ``medicinalproduct:...`` queries.
    assert drug_clause("atorvastatin") == 'patient.drug.medicinalproduct:"atorvastatin"'


def test_reaction_clause():
    assert reaction_clause("myalgia") == 'patient.reaction.reactionmeddrapt:"myalgia"'


def test_quoting_escapes_quotes_and_backslashes():
    assert quoted_term("f", 'we"ird\\name') == 'f:"we\\"ird\\\\name"'


def test_empty_term_rejected():
    with pytest.raises(SafetyAgentError):
        quoted_term("f", "   ")


def test_date_range_defaults_and_normalization():
    assert date_range_clause("2020-01-01", "2020-12-31") == "receivedate:[20200101 TO 20201231]"
    assert date_range_clause(None, None).startswith("receivedate:[20040101 TO ")


def test_invalid_date_range_rejected():
    with pytest.raises(SafetyAgentError):
        date_range_clause("2021-01-01", "2020-01-01")


def test_sex_clause():
    assert sex_clause("female") == "patient.patientsex:2"
    with pytest.raises(SafetyAgentError):
        sex_clause("unknown")


def test_age_range_clause():
    assert age_range_clause(18, 65) == "patient.patientonsetage:[18 TO 65]"
    assert age_range_clause(None, 12) == "patient.patientonsetage:[0 TO 12]"
    with pytest.raises(SafetyAgentError):
        age_range_clause(65, 18)


def test_outcome_and_serious_clauses():
    assert outcome_clause("death") == "seriousnessdeath:1"
    assert serious_clause() == "serious:1"
    with pytest.raises(SafetyAgentError):
        outcome_clause("everything")


def test_country_clause():
    assert country_clause("US") == "occurcountry:us"
    assert country_clause("cn", primary_source=True) == "primarysourcecountry:cn"
    with pytest.raises(SafetyAgentError):
        country_clause("USA")


def test_event_query_joins_with_and():
    query = EventQuery(
        drug="atorvastatin",
        reaction="myalgia",
        date_from="2020-01-01",
        sex="female",
        serious_only=True,
        country="us",
    )
    search = query.build_search()
    assert 'patient.drug.medicinalproduct:"atorvastatin"' in search
    assert 'patient.reaction.reactionmeddrapt:"myalgia"' in search
    assert "receivedate:[20200101 TO " in search
    assert "patient.patientsex:2" in search
    assert "serious:1" in search
    assert "occurcountry:us" in search
    assert search.count(" AND ") == 5


def test_event_query_requires_at_least_one_filter():
    with pytest.raises(SafetyAgentError):
        EventQuery().build_search()
