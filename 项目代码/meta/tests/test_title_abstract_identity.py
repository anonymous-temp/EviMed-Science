"""Offline title/abstract identity and high-recall routing regressions."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from new_meta.agents.screening_agent import ScreeningAgent
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


CRITERION = "Use only main publications PMID 11111111 or PMID 22222222."
PAPER = {
    "pmid": "22222222", "doi": "10.9999/Main-B", "trial_registration": "NCT00000002",
    "title": "Treatment B in chronic disease", "authors": ["Smith A"], "year": 2024,
    "abstract": "A randomized trial compared B with placebo. The primary outcome was biomarker change.",
}


def protocol(criterion=CRITERION):
    return ResearchProtocol(
        research_question="A bounded replication of main randomized reports.",
        pico=PICO(population="Adults with chronic disease", intervention="B",
                  comparator="Placebo", outcome_primary="Clinical events"),
        inclusion_criteria=[criterion], exclusion_criteria=["Secondary publications"],
    )


def response(paper=PAPER, **changes):
    result = {
        "decision": "include", "priority_tier": "uncertain", "reason_code": "eligible",
        "reason": "The main report may contain clinical events beyond its abstract.",
        "exclusion_criterion": None, "confidence": "medium",
        "source_identity": ScreeningAgent._screening_source_identity(paper),
        "publication_role": "primary_publication", "target_outcome_evidence": "not_mentioned",
        "outcome_evidence_quote": None,
        "publication_identity_checks": [{"identifier_type": "pmid", "requirement": "any_of",
            "identifiers": ["11111111", "22222222"], "protocol_criterion": CRITERION}],
    }
    result.update(changes)
    return result


def model_result(payload):
    return SimpleNamespace(**deepcopy(payload), model_dump=lambda: deepcopy(payload))


def execute(path, payload, paper=None, scoped=None):
    paper = deepcopy(PAPER if paper is None else paper)
    scoped = scoped or protocol()
    agent = ScreeningAgent()
    calls = []

    def single(prompt, schema, **kwargs):
        calls.append(prompt)
        if isinstance(payload, Exception):
            raise payload
        if path == "batch":
            return SimpleNamespace(decisions=[deepcopy(payload)])
        return model_result(payload)

    def temperature(messages, schema, **kwargs):
        return single(messages[-1]["content"], schema, **kwargs)

    agent.call_llm_structured = single
    agent.llm.structured_output = temperature
    if path == "single":
        rows = agent._screen_title_abstract([paper], scoped)
    elif path == "temperature":
        rows = agent._screen_ta_with_temp([paper], scoped, 0.3)
    elif path == "dual":
        rows = agent._dual_screen_title_abstract([paper], scoped)
    else:
        rows = agent._screen_title_abstract_batched([paper], scoped)
    assert len(rows) == 1
    return rows[0], calls


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_every_path_supplies_authoritative_identity_and_complete_inventory(path):
    row, calls = execute(path, response())
    assert row["decision"] == "include"
    for prompt in calls:
        assert '"record_id": "22222222"' in prompt
        assert '"doi": "10.9999/Main-B"' in prompt
        assert '"trial_registration": "NCT00000002"' in prompt
        assert "Complete Protocol Identifier Inventory" in prompt
        assert '"identifiers": ["11111111", "22222222"]' in prompt
        assert "secondary endpoint is not a secondary publication" in prompt
        assert "absence from the abstract does not prove absence from the full text" in prompt


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_matching_publication_cannot_be_excluded_as_a_different_publication(path):
    payload = response(decision="exclude", reason_code="publication_identity",
                       reason="This is neither specified main report.", exclusion_criterion=CRITERION)
    row, _ = execute(path, payload)
    assert row["decision"] == "include" and row["priority_tier"] == "uncertain"
    assert row["full_text_review_required"] is True
    assert row["screening_attempts"][0]["response"] == payload
    assert "constraints are absent or satisfied" in row["screening_attempts"][0]["validation_error"]
    if path == "dual":
        assert len(row["reviewer_decisions"]) == 2
        assert all(r["screening_attempts"][0]["response"] == payload for r in row["reviewer_decisions"])


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_valid_publication_mismatch_remains_excluded(path):
    paper = {**PAPER, "pmid": "33333333"}
    payload = response(paper, decision="exclude", reason_code="publication_identity",
                       reason="A different publication outside the bounded set.", exclusion_criterion=CRITERION)
    row, _ = execute(path, payload, paper=paper)
    assert row["decision"] == "exclude"
    assert row["publication_identity_checks_verified"][0]["satisfied"] is False


@pytest.mark.parametrize("changes", [
    {"publication_identity_checks": []},
    {"source_identity": {**ScreeningAgent._screening_source_identity(PAPER), "pmid": "11111111"}},
    {"publication_identity_checks": [{"identifier_type": "pmid", "requirement": "any_of",
        "identifiers": ["11111111"], "protocol_criterion": CRITERION}]},
    {"decision": "unrecognized"},
])
def test_missing_or_contradictory_identity_is_forwarded_without_fabricating_exclusion(changes):
    row, _ = execute("single", response(**changes))
    assert row["decision"] == "include" and row["priority_tier"] == "uncertain"
    assert row["full_text_review_required"] is True


def test_contextual_identifier_is_not_a_publication_whitelist():
    criterion = "Background motivation comes from PMID 99999999; publications are unrestricted."
    payload = response(publication_identity_checks=[{
        "identifier_type": "pmid", "requirement": "context_only", "identifiers": ["99999999"],
        "protocol_criterion": criterion, "context_reason": "The citation motivates the question only.",
    }])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["decision"] == "include" and not row.get("full_text_review_required")
    assert row["publication_identity_checks_verified"][0]["satisfied"] is None


def test_negated_identifier_constraint_stays_a_blacklist():
    criterion = "Do not include publications PMID 11111111 or PMID 22222222."
    payload = response(decision="exclude", reason_code="publication_identity",
                       exclusion_criterion=criterion, publication_identity_checks=[{
        "identifier_type": "pmid", "requirement": "none_of", "identifiers": ["11111111", "22222222"],
        "protocol_criterion": criterion,
    }])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["decision"] == "exclude"
    assert row["publication_identity_checks_verified"][0]["satisfied"] is False


@pytest.mark.parametrize("reason_code", ["outcome", "data_unavailable"])
@pytest.mark.parametrize("abstract", ["", PAPER["abstract"]])
def test_outcome_absent_from_abstract_cannot_prove_it_is_absent_from_main_report(reason_code, abstract):
    paper = {**PAPER, "abstract": abstract}
    payload = response(paper, decision="exclude", reason_code=reason_code,
                       exclusion_criterion="Clinical event outcome is not reported",
                       reason="The abstract only reports the primary biomarker outcome.")
    row, _ = execute("single", payload, paper=paper)
    assert row["decision"] == "include" and row["full_text_review_required"] is True
    assert row["screening_attempts"][0]["response"] == payload


def test_source_supported_clinical_exclusion_is_not_overridden_by_publication_match():
    row, _ = execute("single", response(decision="exclude", reason_code="population",
        reason="The trial only enrolled children.", exclusion_criterion="Adults only"))
    assert row["decision"] == "exclude"


def test_secondary_endpoint_does_not_make_a_main_report_a_secondary_publication():
    row, _ = execute("single", response(decision="exclude", reason_code="publication_type",
        reason="The target outcome is secondary.", exclusion_criterion="Secondary publications"))
    assert row["decision"] == "include" and row["full_text_review_required"] is True


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_provider_failure_retains_candidate_for_full_text_instead_of_counting_exclusion(path):
    row, _ = execute(path, RuntimeError("controlled offline transport failure"))
    assert row["decision"] == "include" and row["priority_tier"] == "uncertain"
    assert row["full_text_review_required"] is True


def test_doi_only_batch_records_are_bound_independently_without_empty_pmid_collision():
    papers = [{**PAPER, "pmid": "", "doi": f"10.9999/study-{i}"} for i in range(2)]
    scoped = protocol("Original randomized reports.")
    agent = ScreeningAgent()
    payloads = [response(p, publication_identity_checks=[]) for p in papers]
    agent.call_llm_structured = lambda *a, **k: SimpleNamespace(decisions=deepcopy(payloads))
    rows = agent._screen_title_abstract_batched(papers, scoped)
    assert [r["paper"]["doi"] for r in rows] == [p["doi"] for p in papers]
    assert all(not r.get("full_text_review_required") for r in rows)


def test_dual_reviewer_original_assessments_are_saved_even_when_decisions_agree(tmp_path):
    agent = ScreeningAgent()
    first = response(reason="Reviewer one assessment.")
    second = response(reason="Reviewer two assessment.")
    agent.call_llm_structured = lambda *a, **k: model_result(first)
    agent.llm.structured_output = lambda *a, **k: model_result(second)
    project = Project("TA identity", output_dir=tmp_path)
    included, excluded = agent.screen_title_abstract([deepcopy(PAPER)], protocol(), project)
    assert len(included) == 1 and excluded == []
    row = project.load_json("title_abstract_screening.json", subdir="screening")[0]
    assert [r["screening_attempts"][0]["response"] for r in row["reviewer_decisions"]] == [first, second]
    assert project.prisma.title_abstract_excluded == 0


@pytest.mark.parametrize("quote", [None, "", "Clinical events were not measured."])
def test_explicit_outcome_absence_needs_an_actual_abstract_quote(quote):
    payload = response(decision="exclude", reason_code="outcome", exclusion_criterion="No clinical events",
                       target_outcome_evidence="explicitly_not_measured", outcome_evidence_quote=quote)
    row, _ = execute("single", payload)
    assert row["decision"] == "include" and row["full_text_review_required"] is True


def test_explicit_source_supported_nonmeasurement_can_remain_a_clinical_exclusion():
    quote = "Clinical events were not measured."
    paper = {**PAPER, "abstract": PAPER["abstract"] + " " + quote}
    payload = response(paper, decision="exclude", reason_code="outcome", exclusion_criterion="No clinical events",
                       target_outcome_evidence="explicitly_not_measured", outcome_evidence_quote=quote)
    row, _ = execute("single", payload, paper=paper)
    assert row["decision"] == "exclude"


def test_real_secondary_publication_can_be_excluded_with_a_matching_identifier():
    payload = response(decision="exclude", reason_code="publication_type",
                       publication_role="secondary_analysis", exclusion_criterion="Secondary publications",
                       reason="This publication is a subgroup-only analysis.")
    row, _ = execute("single", payload)
    assert row["decision"] == "exclude"


@pytest.mark.parametrize("reason_code", ["publication_identity", "eligible"])
def test_contextual_citation_cannot_justify_publication_identity_exclusion(reason_code):
    criterion = "Background: PMID 99999999."
    payload = response(decision="exclude", reason_code=reason_code, exclusion_criterion=criterion,
        publication_identity_checks=[{"identifier_type": "pmid", "requirement": "context_only",
        "identifiers": ["99999999"], "protocol_criterion": criterion, "context_reason": "Background only."}])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["decision"] == "include" and row["full_text_review_required"] is True


def test_contextual_citation_requires_a_semantic_rationale():
    criterion = "Background: PMID 99999999."
    payload = response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "context_only",
        "identifiers": ["99999999"], "protocol_criterion": criterion}])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["decision"] == "include" and row["full_text_review_required"] is True


def test_nonmatching_blacklist_does_not_justify_excluding_an_allowed_publication():
    criterion = "Do not include publication PMID 99999999."
    payload = response(decision="exclude", reason_code="publication_identity", exclusion_criterion=criterion,
        publication_identity_checks=[{"identifier_type": "pmid", "requirement": "none_of",
        "identifiers": ["99999999"], "protocol_criterion": criterion}])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["decision"] == "include" and row["full_text_review_required"] is True


def test_doi_equality_is_case_insensitive_but_not_prefix_matching():
    criterion = "Only use DOI 10.9999/main-b."
    payload = response(publication_identity_checks=[{"identifier_type": "doi", "requirement": "any_of",
        "identifiers": ["10.9999/main-b"], "protocol_criterion": criterion}])
    row, _ = execute("single", payload, scoped=protocol(criterion))
    assert row["publication_identity_checks_verified"][0]["satisfied"] is True
    bad = deepcopy(payload)
    bad["publication_identity_checks"][0]["identifiers"] = ["10.9999/main"]
    row, _ = execute("single", bad, scoped=protocol(criterion))
    assert row["full_text_review_required"] is True


def test_duplicate_batch_observations_preserve_both_and_forward_once():
    first = response()
    second = response(decision="exclude", reason_code="population", exclusion_criterion="Adults only")
    agent = ScreeningAgent()
    agent.call_llm_structured = lambda *a, **k: SimpleNamespace(decisions=[first, second])
    rows = agent._screen_title_abstract_batched([deepcopy(PAPER)], protocol())
    assert len(rows) == 1 and rows[0]["decision"] == "include"
    assert rows[0]["full_text_review_required"] is True
    assert [a["response"] for a in rows[0]["screening_attempts"]] == [first, second]


def test_unknown_batch_identity_is_preserved_when_missing_record_gets_one_reassessment():
    alien = response({**PAPER, "pmid": "99999999"})
    agent = ScreeningAgent()
    calls = []

    def call(prompt, schema, **kwargs):
        calls.append(prompt)
        return SimpleNamespace(decisions=[alien]) if len(calls) == 1 else model_result(response())

    agent.call_llm_structured = call
    rows = agent._screen_title_abstract_batched([deepcopy(PAPER)], protocol())
    assert len(rows) == 1 and len(calls) == 2
    assert rows[0]["batch_screening_observations"] == [alien]
    assert rows[0]["screening_attempts"][0]["response"] == response()


def test_dual_disagreement_preserves_original_exclusion_and_inclusion():
    agent = ScreeningAgent()
    first = response()
    second = response(decision="exclude", reason_code="population", exclusion_criterion="Adults only")
    agent.call_llm_structured = lambda *a, **k: model_result(first)
    agent.llm.structured_output = lambda *a, **k: model_result(second)
    rows = agent._dual_screen_title_abstract([deepcopy(PAPER)], protocol())
    assert len(rows) == 1 and rows[0]["decision"] == "include"
    assert rows[0]["full_text_review_required"] is True
    assert [r["screening_attempts"][0]["response"] for r in rows[0]["reviewer_decisions"]] == [first, second]


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_every_ta_path_supplies_the_exact_identity_item_schema(path):
    import json
    from new_meta.schemas.screening import PublicationIdentityCheck
    _row, prompts = execute(path, response())
    schema = PublicationIdentityCheck.model_json_schema()
    assert set(schema["required"]) == {"identifier_type", "requirement", "identifiers", "protocol_criterion"}
    rendered = json.dumps(schema, ensure_ascii=False)
    assert prompts and all(rendered in prompt for prompt in prompts)


@pytest.mark.parametrize("observation_index", [0, 1, 2])
@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_observed_requirement_aliases_remain_unvalidated_and_unchanged(observation_index, path):
    import hashlib
    import json
    from pathlib import Path
    fixture = json.loads((Path(__file__).parent / "fixtures/ta_identity_requirement_observations.json").read_text())
    observation = fixture["observations"][observation_index]
    raw = observation["raw_response"]
    before = deepcopy(raw)
    assert hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() == observation["raw_response_sha256"]
    assert all("requirement" not in item for item in raw["publication_identity_checks"])
    row, _ = execute(path, raw, paper=observation["paper"], scoped=ResearchProtocol.model_validate(fixture["protocol"]))
    assert row["decision"] == "include" and row["priority_tier"] == "uncertain"
    assert row["full_text_review_required"] is True
    attempts = row["reviewer_decisions"][0]["screening_attempts"] if path == "dual" else row["screening_attempts"]
    assert attempts[0]["response"] == before == raw
    assert ".requirement" in attempts[0]["validation_error"]
    if path == "batch": assert row["batch_screening_observations"] == [before]


@pytest.mark.parametrize("path", ["single", "temperature", "dual", "batch"])
def test_exact_requirement_field_keeps_a_legitimate_identity_exclusion(path):
    paper = {**PAPER, "pmid": "33333333", "doi": "10.9999/other"}
    payload = response(paper, decision="exclude", priority_tier="indirect", reason_code="publication_identity",
        reason="This publication is outside the explicitly permitted publication IDs.", exclusion_criterion=CRITERION)
    row, _ = execute(path, payload, paper=paper)
    assert row["decision"] == "exclude"
    assert not row.get("full_text_review_required", False)
    assert payload["publication_identity_checks"][0]["requirement"] == "any_of"
