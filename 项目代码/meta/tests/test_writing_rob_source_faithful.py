"""Clinical judgment regressions through the real OpenAI SDK, without network."""
import json
from types import SimpleNamespace

import httpx
from openai import OpenAI
import pytest

from new_meta.agents.rob_agent import RoBAgent
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.llm import LLMClient


@pytest.fixture
def provider(monkeypatch):
    clients = []

    def bind(agent, responses, endpoint="chat"):
        requests = []

        def handle(request):
            requests.append(json.loads(request.content))
            index = min(len(requests) - 1, len(responses) - 1)
            content, finish = responses[index]
            if endpoint == "responses":
                return httpx.Response(200, json={
                    "id": "resp-offline", "object": "response", "created_at": 1,
                    "model": "offline-model", "status": finish,
                    "output": [] if content is None else [{"id": "msg-offline", "type": "message",
                        "role": "assistant", "status": "completed", "content": [
                            {"type": "output_text", "text": content, "annotations": []}]}],
                    "usage": {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20},
                })
            return httpx.Response(200, json={
                "id": "chatcmpl-offline", "object": "chat.completion", "created": 1,
                "model": "offline-model", "choices": [{"index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": finish}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            })

        llm = LLMClient(api_key="offline-test-only", base_url="https://offline.invalid/v1", model="offline-model")
        llm.client.close()
        llm.client = OpenAI(api_key="offline-test-only", base_url="https://offline.invalid/v1",
                            max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handle)))
        llm.stream = False
        llm.enable_search = False
        llm.use_responses_api = False
        monkeypatch.setattr(llm, "_should_use_responses_api", lambda **kwargs: endpoint == "responses")
        monkeypatch.setattr(llm, "_sleep_before_retry", lambda *args, **kwargs: None)
        agent.llm = llm
        clients.append(llm.client)
        return requests

    yield bind
    for client in clients:
        client.close()


def _semantic(agent, kind, candidate="The treatment proves benefit.", facts=None):
    kwargs = {"heading": "Introduction", "candidate_body": candidate, "guard_issues": [],
              "facts": facts or {"claim_map": [{"id": "C1", "section": "Introduction",
                                                "claim": "The treatment may help."}]}}
    if kind == "semantic":
        return agent._adjudicate_semantic_guard(original_body="The treatment may help.", **kwargs)
    return agent._adjudicate_claim_map_authoring_guard(**kwargs)


def _claims():
    return [{"id": claim_id, "section": "Discussion", "claim": "Treatment proves benefit.",
             "source_quote": "Treatment may help.", "support_source": "trial report",
             "can_write_main_text": True, "manuscript_use": "main"} for claim_id in ("C1", "C2")]


def _alignment_item(claim_id, decision="accept"):
    return {"id": claim_id, "decision": decision, "reason": "Only a possible benefit is reported.",
            "unsupported_phrases": [] if decision == "accept" else ["proves"],
            "revised_claim": "Treatment may help." if decision == "revise" else ""}


def _rob_input():
    return {"study": SimpleNamespace(characteristics=SimpleNamespace(study_id="S1", pmid="",
             intervention_description="Drug", control_description="Placebo")),
            "outcome": SimpleNamespace(outcome_name="Mortality", accepted_timepoint="28 days",
             timepoint="28 days", subgroup="", treatment_arm="Drug", reference_arm="Placebo"),
            "full_text": "Treatment allocation was predictable before each participant enrolled. Outcome data were complete for all randomized participants.",
            "rob_policy": SimpleNamespace(tool_name="RoB 2", tool_version="2019",
             domain_names=("Randomization process", "Missing outcome data"),
             prompt_template="Assess PAPER CONTENT: {paper_content}")}


def _rob_response(high=True, broken=False):
    domains = [{"domain": "Randomization process", "judgment": "High risk" if high else "Low risk",
                "support": "Treatment allocation was predictable before each participant enrolled.", "source_quote": "Treatment allocation was predictable before each participant enrolled.",
                "source_section": "Methods"},
               {"domain": "Missing outcome data", "judgment": "Low risk",
                "support": "Outcome data were complete for all randomized participants.", "source_quote": "Outcome data were complete for all randomized participants.",
                "source_section": "Results"}]
    if broken:
        domains[1].pop("support")
    return {"study_id": "S1", "tool_used": "RoB 2", "domains": domains,
            "overall_judgment": "High risk" if high else "Low risk"}


@pytest.mark.parametrize("kind", ["semantic", "claim_map"])
def test_semantic_rejection_cannot_be_repaired_into_acceptance(provider, kind):
    agent = WritingAgent()
    raw = json.dumps({"accept": False, "reason": {"medical_reason": "Unsupported efficacy claim."}})
    requests = provider(agent, [(raw, "stop"), ('{"accept":true,"reason":"Looks supported."}', "stop")])
    result = _semantic(agent, kind)
    assert result is None or result.accept is False
    assert len(requests) == 1


@pytest.mark.parametrize("decision", ["exclude", "revise"])
def test_bad_alignment_sibling_cannot_erase_valid_negative_decision(provider, decision):
    agent = WritingAgent()
    bad = _alignment_item("C2")
    bad["unsupported_phrases"] = {"bad": "shape"}
    raw = json.dumps({"summary": "Review is incomplete.", "items": [_alignment_item("C1", decision), bad]})
    repaired = json.dumps({"items": [_alignment_item("C1"), _alignment_item("C2")]})
    requests = provider(agent, [(raw, "stop"), (repaired, "stop")])
    claims, audit = agent._llm_align_claim_sources(_claims(), {})
    assert audit["status"] == "failed"
    assert len(requests) == 1
    assert claims[1]["can_write_main_text"] is False
    if decision == "exclude":
        assert claims[0]["can_write_main_text"] is False
    else:
        assert claims[0]["claim"] == "Treatment may help."
    assert not any(c["can_write_main_text"] and c["claim"] == "Treatment proves benefit." for c in claims)


def test_partial_high_rob_cannot_be_repaired_or_rejudged_low(provider):
    agent = RoBAgent()
    raw = json.dumps(_rob_response(broken=True))
    requests = provider(agent, [(raw, "stop"), (json.dumps(_rob_response(high=False)), "stop")])
    result = agent._assess_result_specific_rob(**_rob_input())
    assert result is None
    assert len(requests) == 1
    assert agent._assess_result_specific_rob(**_rob_input()) is None
    assert len(requests) == 1
    audit = agent._result_rob_source_observations[0]
    assert audit["status"] == "incomplete"
    assert audit["raw_responses"][0]["content"] == raw
    assert audit["high_risk_domains"] == [_rob_response()["domains"][0] | {
        "source_page": None, "signaling_questions": {},
    }]
    assert "assessment" not in audit


@pytest.mark.parametrize("kind", ["semantic", "claim_map"])
@pytest.mark.parametrize("raw,finish", [
    ('{"accept":false,"reason":{"detail":"Unsupported."}}', "stop"),
    ('{"reason":"No decision supplied."}', "stop"),
    ('{"accept":true}', "stop"),
    ('{"accept":"true","reason":"Wrong type."}', "stop"),
    ('{"accept":true,"reason":""}', "stop"),
    ('{"accept":false,"accept":true,"reason":"Conflicting decisions."}', "stop"),
    ('{"accept":false,"reason":', "stop"),
    ('{"accept":false,"reason":"Unsupported."}', "length"),
    ('{"accept":true,"reason":"Supported."}', "length"),
])
def test_incomplete_semantic_judgment_stays_bound_to_candidate(provider, kind, raw, finish):
    agent = WritingAgent()
    requests = provider(agent, [(raw, finish), ('{"accept":true,"reason":"A changed candidate is supported."}', "stop")])
    assert _semantic(agent, kind) is None
    assert _semantic(agent, kind) is None
    assert len(requests) == 1
    record = agent._semantic_guard_observations[0]
    assert record["status"] == "incomplete"
    assert record["raw_responses"][0]["content"] == raw
    assert "decision" not in record
    changed = _semantic(agent, kind, candidate="The treatment may help.")
    assert changed.accept is True
    assert len(requests) == 2
    assert agent._semantic_guard_observations[1]["input_hash"] != record["input_hash"]


@pytest.mark.parametrize("kind", ["semantic", "claim_map"])
@pytest.mark.parametrize("accept", [False, True])
def test_valid_semantic_judgment_and_reason_are_preserved(provider, kind, accept):
    agent = WritingAgent()
    raw = json.dumps({"accept": accept, "reason": "The quoted finding supports only cautious wording."})
    requests = provider(agent, [(raw, "stop")])
    result = _semantic(agent, kind)
    assert result.model_dump() == json.loads(raw)
    assert agent._semantic_guard_observations[0]["decision"] == result.model_dump()
    assert len(requests) == 1


def test_semantic_same_candidate_cannot_be_approved_by_changing_editor_rationale(provider):
    agent = WritingAgent()
    requests = provider(agent, [('{"accept":false,"reason":"Unsupported wording."}', "stop"),
                                ('{"accept":true,"reason":"Accepted."}', "stop")])
    kwargs = {"heading": "Introduction", "candidate_body": "The treatment proves benefit.",
              "facts": {"claim_map": [{"id": "C1", "section": "Introduction", "claim": "It may help."}]}}
    first = agent._adjudicate_claim_map_authoring_guard(**kwargs, guard_issues=[], rationale="Initial draft")
    second = agent._adjudicate_claim_map_authoring_guard(**kwargs, guard_issues=[{"code": "changed_noise"}],
                                                       rationale="Repaired draft", claims_used=["C1"])
    assert first.accept is False and second.accept is False
    assert len(requests) == 1


def test_semantic_rejection_can_be_reassessed_when_source_facts_change(provider):
    agent = WritingAgent()
    requests = provider(agent, [('{"accept":false,"reason":"Unsupported wording."}', "stop"),
                                ('{"accept":true,"reason":"Updated facts support the wording."}', "stop")])
    assert _semantic(agent, "semantic").accept is False
    assert _semantic(agent, "semantic", facts={"primary_effect": {"n_studies": 4}}).accept is True
    assert len(requests) == 2


@pytest.mark.parametrize("bad_items", [
    [],
    [{"id": "C1", "reason": "Decision missing.", "unsupported_phrases": []}],
    [_alignment_item("C1", "revise") | {"revised_claim": ""}],
    [_alignment_item("C1", "accept") | {"unsupported_phrases": ["proves"]}],
    [_alignment_item("C1", "revise") | {"revised_claim": {"value": "Treatment may help."}}],
    [_alignment_item("C1", "unknown")],
    [_alignment_item("C1"), _alignment_item("C1", "exclude")],
    [_alignment_item("unknown")],
])
def test_unresolved_alignment_rows_are_never_writable(provider, bad_items):
    agent = WritingAgent()
    raw = json.dumps({"items": bad_items})
    requests = provider(agent, [(raw, "stop")])
    claims, audit = agent._llm_align_claim_sources(_claims(), {})
    assert audit["status"] == "failed"
    assert all(c["can_write_main_text"] is False for c in claims)
    assert all(c["claim"] == "Treatment proves benefit." for c in claims)
    assert audit["raw_responses"][0]["content"] == raw
    assert len(requests) == 1


@pytest.mark.parametrize("raw", ['{"items":', '{"items":[],"items":[{"id":"C1","decision":"accept"}]}'])
def test_malformed_alignment_json_is_withheld_without_regeneration(provider, raw):
    agent = WritingAgent()
    requests = provider(agent, [(raw, "stop")])
    claims, audit = agent._llm_align_claim_sources(_claims(), {})
    assert audit["status"] == "failed"
    assert all(c["can_write_main_text"] is False for c in claims)
    assert len(requests) == 1


def test_valid_alignment_accept_exclude_and_exact_revision(provider):
    agent = WritingAgent()
    claims = _claims()
    claims.append(claims[0] | {"id": "C3"})
    exact_revision = "  Treatment may help.  "
    raw = json.dumps({"summary": "All claims reviewed.", "items": [
        _alignment_item("C1"), _alignment_item("C2", "exclude"),
        _alignment_item("C3", "revise") | {"revised_claim": exact_revision},
    ]})
    requests = provider(agent, [(raw, "stop")])
    updated, audit = agent._llm_align_claim_sources(claims, {})
    assert audit["status"] == "ok"
    assert updated[0] == claims[0]
    assert updated[1]["can_write_main_text"] is False
    assert updated[2]["claim"] == exact_revision
    assert audit["revised_claims"][0]["original_claim"] == "Treatment proves benefit."
    assert audit["revised_claims"][0]["revised_claim"] == exact_revision
    assert len(requests) == 1


@pytest.mark.parametrize("decision", ["exclude", "revise"])
def test_alignment_same_input_retry_and_truncation_cannot_wash_negative(provider, decision):
    agent = WritingAgent()
    raw = json.dumps({"items": [_alignment_item("C1", decision), _alignment_item("C2")]})
    requests = provider(agent, [(raw, "length"), (json.dumps({"items": [_alignment_item("C1"), _alignment_item("C2")]}), "stop")])
    first, audit = agent._llm_align_claim_sources(_claims(), {})
    second, second_audit = agent._llm_align_claim_sources(_claims(), {})
    assert second == first and second_audit == audit
    assert audit["status"] == "failed"
    assert second[1]["can_write_main_text"] is False
    assert (second[0]["can_write_main_text"] is False or second[0]["claim"] == "Treatment may help.")
    assert len(requests) == 1


@pytest.mark.parametrize("high", [False, True])
def test_valid_grounded_result_rob_is_preserved(provider, high):
    agent = RoBAgent()
    response = _rob_response(high=high)
    requests = provider(agent, [(json.dumps(response), "stop")])
    result = agent._assess_result_specific_rob(**_rob_input())
    assert result.overall_judgment == response["overall_judgment"]
    assert result.domains[0].source_quote == response["domains"][0]["source_quote"]
    assert agent._result_rob_source_observations[0]["status"] == "complete"
    assert len(requests) == 1


@pytest.mark.parametrize("failure", ["missing_domain", "bad_quote", "duplicate_domain", "length", "low_overall"])
def test_high_risk_domain_with_incomplete_sibling_is_not_a_complete_assessment(provider, failure):
    agent = RoBAgent()
    response = _rob_response()
    finish = "stop"
    if failure == "missing_domain":
        response["domains"].pop()
    elif failure == "bad_quote":
        response["domains"][1]["source_quote"] = "An invented source quote that is not in the paper."
    elif failure == "duplicate_domain":
        response["domains"][1] = response["domains"][0] | {"judgment": "Low risk"}
    elif failure == "length":
        finish = "length"
    else:
        response["overall_judgment"] = "Low risk"
    requests = provider(agent, [(json.dumps(response), finish), (json.dumps(_rob_response(high=False)), "stop")])
    assert agent._assess_result_specific_rob(**_rob_input()) is None
    assert len(requests) == 1
    audit = agent._result_rob_source_observations[0]
    assert audit["status"] == "incomplete"
    assert audit["high_risk_domains"][0]["judgment"] == "High risk"
    assert "assessment" not in audit


def test_rejected_authoring_candidate_preserves_original_manuscript_and_audit(provider, monkeypatch):
    from new_meta.agents.writing.contracts import ClaimMapAuthoredSections

    agent = WritingAgent()
    raw = '{"accept":false,"reason":{"detail":"The benefit claim is unsupported."}}'
    requests = provider(agent, [(raw, "stop")])
    monkeypatch.setattr(agent, "call_llm_structured", lambda *args, **kwargs: ClaimMapAuthoredSections(
        sections=[{"heading": "Introduction", "replacement_markdown": "The treatment proves benefit.",
                   "claims_used": ["C1"]}],
    ))
    monkeypatch.setattr(agent, "_repair_claim_map_authoring_section_with_guard_feedback", lambda **kwargs: None)
    manuscript = "## Introduction\n\nThe original text remains.\n\n## Methods\n\nPrespecified methods.\n"
    facts = {"claim_map": [{"id": "C1", "section": "Introduction", "claim": "Treatment may help."}],
             "study_cards": [{"study_id": "S1", "evidence_understanding_available": True}]}
    text, audit = agent._llm_author_open_sections_from_claim_map(manuscript, facts)
    assert text == manuscript
    assert audit["accepted_sections"] == 0 and audit["rejected_sections"] == 1
    assert audit["semantic_guard_observations"][0]["raw_responses"][0]["content"] == raw
    assert len(requests) == 1


def test_partial_high_rob_uses_existing_outer_insufficient_and_adjudication_path(provider, tmp_path):
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.project import Project
    from new_meta.core.rob_policy import resolve_rob_policy
    from new_meta.schemas.protocol import PICO, ResearchProtocol
    from new_meta.schemas.risk_of_bias import RoBAssessmentStatus
    from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics

    project = Project("Observed partial RoB", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(research_question="Does Drug reduce mortality?",
        pico=PICO(population="Adults", intervention="Drug", comparator="Placebo", outcome_primary="Mortality"),
        review_family="intervention_rct", study_designs=["parallel RCT"], primary_outcome_type="dichotomous",
        effect_measure="RR")
    compile_project_method_plan(project, protocol, enforce=True)
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1", title="Trial one",
        study_design="randomized controlled trial"),
        outcomes=[OutcomeData(outcome_name="Mortality", outcome_type="dichotomous", timepoint="28 days")])
    policy = resolve_rob_policy(family="intervention_rct")
    response = _rob_response()
    response["domains"] = [response["domains"][0]] + [
        response["domains"][1] | {"domain": name} for name in policy.domain_names[1:]
    ]
    response["domains"][1].pop("support")
    agent = RoBAgent()
    raw = json.dumps(response)
    requests = provider(agent, [(raw, "stop")])
    results = agent.complete_result_level_assessments(project=project, extracted_studies=[study],
        parsed_papers={"S1": {"full_text": _rob_input()["full_text"]}}, study_assessments=[],
        required_result_ids=["result:s1:0"])
    assert len(results) == 1
    assert results[0].assessment_status is RoBAssessmentStatus.INSUFFICIENT_INFORMATION
    assert results[0].requires_adjudication is True
    assert results[0].domains == []
    assert project.load_json("rob_result_readiness.json", subdir="risk_of_bias")["status"] == "blocked"
    observations = project.load_json("rob_result_source_observations.json", subdir="risk_of_bias")
    assert observations[0]["raw_responses"][0]["content"] == raw
    assert observations[0]["high_risk_domains"][0]["judgment"] == "High risk"
    assert len(requests) == 1
    resumed = RoBAgent()
    resumed_requests = provider(resumed, [(json.dumps(_rob_response(high=False)), "stop")])
    resumed_results = resumed.complete_result_level_assessments(project=project, extracted_studies=[study],
        parsed_papers={"S1": {"full_text": _rob_input()["full_text"]}}, study_assessments=[],
        required_result_ids=["result:s1:0"])
    assert resumed_results[0].assessment_status is RoBAssessmentStatus.INSUFFICIENT_INFORMATION
    assert resumed_results[0].requires_adjudication is True
    assert resumed_requests == []
    assert project.load_json("rob_result_source_observations.json", subdir="risk_of_bias") == observations


@pytest.mark.parametrize("kind", ["semantic", "claim_map", "alignment", "rob"])
@pytest.mark.parametrize("empty", [None, "", "   "])
def test_missing_provider_content_can_retry_without_inventing_a_judgment(provider, kind, empty):
    agent = RoBAgent() if kind == "rob" else WritingAgent()
    if kind == "rob":
        healthy = json.dumps(_rob_response(high=False))
    elif kind == "alignment":
        healthy = json.dumps({"items": [_alignment_item("C1"), _alignment_item("C2")]})
    else:
        healthy = '{"accept":true,"reason":"The candidate is supported."}'
    requests = provider(agent, [(empty, "stop"), (healthy, "stop")])
    if kind == "rob":
        assert agent._assess_result_specific_rob(**_rob_input()).overall_judgment == "Low risk"
        audit = agent._result_rob_source_observations[0]
        assert audit["high_risk_domains"] == []
    elif kind == "alignment":
        updated, audit = agent._llm_align_claim_sources(_claims(), {})
        assert audit["status"] == "ok" and all(c["can_write_main_text"] for c in updated)
    else:
        assert _semantic(agent, kind).accept is True
        audit = agent._semantic_guard_observations[0]
    assert len(requests) == 2
    assert audit["raw_responses"][0]["missing_response"] is True
    assert audit["raw_responses"][0]["content"] == empty
    assert "observed_rejection" not in audit["raw_responses"][0]
    assert audit["raw_responses"][1]["provider_response_ordinal"] == 2


@pytest.mark.parametrize("kind", ["semantic", "claim_map", "alignment", "rob"])
def test_json_null_is_invalid_judgment_not_missing_provider_content(provider, kind):
    agent = RoBAgent() if kind == "rob" else WritingAgent()
    requests = provider(agent, [("null", "stop")])
    if kind == "rob":
        assert agent._assess_result_specific_rob(**_rob_input()) is None
    elif kind == "alignment":
        claims, audit = agent._llm_align_claim_sources(_claims(), {})
        assert audit["status"] == "failed"
        assert all(c["can_write_main_text"] is False for c in claims)
    else:
        assert _semantic(agent, kind) is None
    assert len(requests) == 1


def test_withheld_claims_are_absent_from_main_prose_authoring_and_judge_inputs(provider, monkeypatch):
    from new_meta.agents.writing.contracts import ClaimMapAuthoredSections, ClaimMapSectionDraft

    agent = WritingAgent()
    bad = _alignment_item("C2") | {"unsupported_phrases": {"invalid": "shape"}}
    requests = provider(agent, [(json.dumps({"items": [_alignment_item("C1", "exclude"), bad]}), "stop"),
                               ('{"accept":true,"reason":"Only the approved objective is present."}', "stop")])
    claims, alignment_audit = agent._llm_align_claim_sources(_claims(), {})
    assert alignment_audit["status"] == "failed"
    approved = {"id": "C3", "section": "Discussion", "claim": "This review evaluates treatment.",
                "can_write_main_text": True, "manuscript_use": "main"}
    facts = {"claim_map": claims + [approved],
             "study_cards": [{"study_id": "S1", "evidence_understanding_available": True}]}
    agent._manuscript_facts = facts
    agent._manuscript_claim_map = claims + [approved]
    contract = agent._section_fact_contract_block("discussion")
    assert "Treatment proves benefit." not in contract
    assert approved["claim"] in contract
    prompts = []

    def draft(prompt, schema, **kwargs):
        prompts.append(prompt)
        if schema is ClaimMapAuthoredSections:
            return schema(sections=[])
        assert schema is ClaimMapSectionDraft
        return schema(heading="Discussion", replacement_markdown=approved["claim"])

    monkeypatch.setattr(agent, "call_llm_structured", draft)
    agent._llm_author_open_sections_from_claim_map("## Discussion\n\nAn existing discussion.\n", facts)
    agent._repair_claim_map_authoring_section_with_guard_feedback(heading="Discussion", original_body="Original.",
        rejected_body="Rejected.", guard_issues=[], facts=facts, claims_used=["C1", "C3"])
    result = agent._adjudicate_claim_map_authoring_guard(heading="Discussion", candidate_body=approved["claim"],
        guard_issues=[], facts=facts, claims_used=["C1", "C3"])
    assert result.accept is True
    prompts.append(requests[-1]["messages"][-1]["content"])
    assert len(prompts) == 3
    assert all("Treatment proves benefit." not in prompt for prompt in prompts)
    assert all(approved["claim"] in prompt for prompt in prompts)


@pytest.mark.parametrize("kind", ["semantic", "claim_map", "alignment", "rob"])
@pytest.mark.parametrize("missing_first", [False, True])
def test_completed_responses_api_judgments_are_valid(provider, kind, missing_first):
    agent = RoBAgent() if kind == "rob" else WritingAgent()
    if kind == "rob":
        healthy = json.dumps(_rob_response(high=False))
    elif kind == "alignment":
        healthy = json.dumps({"items": [_alignment_item("C1"), _alignment_item("C2")]})
    else:
        healthy = '{"accept":true,"reason":"The candidate is supported."}'
    responses = ([(None, "completed")] if missing_first else []) + [(healthy, "completed")]
    requests = provider(agent, responses, endpoint="responses")
    if kind == "rob":
        assert agent._assess_result_specific_rob(**_rob_input()).overall_judgment == "Low risk"
        audit = agent._result_rob_source_observations[0]
    elif kind == "alignment":
        claims, audit = agent._llm_align_claim_sources(_claims(), {})
        assert audit["status"] == "ok" and all(claim["can_write_main_text"] for claim in claims)
    else:
        assert _semantic(agent, kind).accept is True
        audit = agent._semantic_guard_observations[0]
    assert audit["raw_responses"][-1]["finish_reason"] == "completed"
    assert len(requests) == 1 + missing_first


def _result_project(tmp_path, two_results=False):
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.project import Project
    from new_meta.core.rob_policy import resolve_rob_policy
    from new_meta.schemas.protocol import PICO, ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics

    project = Project("Retained result observations", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(research_question="Does Drug reduce mortality?",
        pico=PICO(population="Adults", intervention="Drug", comparator="Placebo", outcome_primary="Mortality"),
        review_family="intervention_rct", study_designs=["parallel RCT"], primary_outcome_type="dichotomous",
        effect_measure="RR")
    compile_project_method_plan(project, protocol, enforce=True)
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1", title="Trial one",
        study_design="randomized controlled trial"), outcomes=[
            OutcomeData(outcome_name="Mortality", outcome_type="dichotomous", timepoint="28 days")])
    if two_results:
        study.outcomes.append(OutcomeData(outcome_name="Readmission", outcome_type="dichotomous", timepoint="28 days"))
    policy = resolve_rob_policy(family="intervention_rct")
    response = _rob_response()
    response["domains"] = [response["domains"][0]] + [
        response["domains"][1] | {"domain": name} for name in policy.domain_names[1:]]
    low = response | {"overall_judgment": "Low risk", "domains": [
        domain | {"judgment": "Low risk"} for domain in response["domains"]]}
    response["domains"][1].pop("support")
    arguments = {"project": project, "extracted_studies": [study], "study_assessments": [],
        "parsed_papers": {"S1": {"full_text": _rob_input()["full_text"]}},
        "required_result_ids": [f"result:s1:{index}" for index in range(len(study.outcomes))]}
    return project, arguments, response, low


def test_resume_merges_same_input_empty_attempt_and_later_high_risk(provider, tmp_path):
    project, arguments, high, low = _result_project(tmp_path)
    agent = RoBAgent()
    provider(agent, [(None, "stop")])
    agent.complete_result_level_assessments(**arguments)
    provider(agent, [(json.dumps(high), "stop")])
    agent.complete_result_level_assessments(**arguments)
    before = project.load_json("rob_result_source_observations.json", subdir="risk_of_bias")
    assert len(before) == 2
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(low), "stop")])
    results = resumed.complete_result_level_assessments(**arguments)
    assert results[0].assessment_status.value == "insufficient_information"
    assert results[0].requires_adjudication is True
    assert calls == []
    assert project.load_json("rob_result_source_observations.json", subdir="risk_of_bias") == before


def test_retained_result_high_risk_blocks_study_level_low_fallback(provider, tmp_path):
    from new_meta.schemas.risk_of_bias import StudyRoB

    project, arguments, high, low = _result_project(tmp_path)
    agent = RoBAgent()
    provider(agent, [(json.dumps(high), "stop")])
    agent.complete_result_level_assessments(**arguments)
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(low), "stop")])
    results = resumed.complete_result_level_assessments(**(arguments | {"study_assessments": [StudyRoB.model_validate(low)]}))
    assert results[0].assessment_status.value == "insufficient_information"
    assert results[0].requires_adjudication is True
    assert calls == []


def test_partial_high_risk_survives_interrupt_before_second_result(provider, tmp_path, monkeypatch):
    project, arguments, high, low = _result_project(tmp_path, two_results=True)
    agent = RoBAgent()
    provider(agent, [(json.dumps(high), "stop")])
    original = agent._assess_result_specific_rob
    count = 0

    def interrupt_second(**kwargs):
        nonlocal count
        count += 1
        if count == 2:
            raise KeyboardInterrupt("Interrupted before the second result")
        return original(**kwargs)

    monkeypatch.setattr(agent, "_assess_result_specific_rob", interrupt_second)
    with pytest.raises(KeyboardInterrupt):
        agent.complete_result_level_assessments(**arguments)
    observed = project.load_json("rob_result_source_observations.json", subdir="risk_of_bias")
    assert observed and observed[0]["high_risk_domains"]
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(low), "stop")])
    results = resumed.complete_result_level_assessments(**arguments)
    assert results[0].assessment_status.value == "insufficient_information"
    assert results[0].requires_adjudication is True
    assert len(calls) == 1


@pytest.mark.parametrize("kind", ["semantic", "claim_map", "exclude", "revise", "rob"])
@pytest.mark.parametrize("missing_first", [False, True])
def test_responses_api_preserves_negative_judgments(provider, kind, missing_first):
    agent = RoBAgent() if kind == "rob" else WritingAgent()
    if kind == "rob":
        negative = json.dumps(_rob_response(broken=True))
    elif kind in {"exclude", "revise"}:
        negative = json.dumps({"items": [_alignment_item("C1", kind),
            _alignment_item("C2") | {"unsupported_phrases": {"bad": "shape"}}]})
    else:
        negative = '{"accept":false,"reason":"The candidate is unsupported."}'
    responses = ([(None, "completed")] if missing_first else []) + [(negative, "completed")]
    calls = provider(agent, responses, endpoint="responses")
    if kind == "rob":
        assert agent._assess_result_specific_rob(**_rob_input()) is None
        audit = agent._result_rob_source_observations[0]
        assert audit["high_risk_domains"][0]["judgment"] == "High risk"
    elif kind in {"exclude", "revise"}:
        claims, audit = agent._llm_align_claim_sources(_claims(), {})
        assert audit["status"] == "failed"
        assert claims[1]["can_write_main_text"] is False
        if kind == "exclude":
            assert claims[0]["can_write_main_text"] is False
        else:
            assert claims[0]["claim"] == "Treatment may help."
    else:
        assert _semantic(agent, kind).accept is False
        audit = agent._semantic_guard_observations[0]
    assert audit["raw_responses"][-1]["finish_reason"] == "completed"
    assert audit["raw_responses"][-1]["content"] == negative
    assert len(calls) == 1 + missing_first


def test_responses_api_accepts_complete_source_grounded_high_risk(provider):
    agent = RoBAgent()
    calls = provider(agent, [(json.dumps(_rob_response()), "completed")], endpoint="responses")
    result = agent._assess_result_specific_rob(**_rob_input())
    assert result.overall_judgment == "High risk"
    assert len(calls) == 1


@pytest.mark.parametrize("change", ["completed_cache", "unrecorded_adjudication", "adjudication", "new_source", "new_outcome"])
def test_retained_high_risk_precedes_cached_low_until_adjudication_or_new_input(provider, tmp_path, change):
    from new_meta.schemas.risk_of_bias import RoBAssessmentStatus, StudyRoB

    project, arguments, high, low = _result_project(tmp_path)
    agent = RoBAgent()
    provider(agent, [(json.dumps(high), "stop")])
    incomplete = agent.complete_result_level_assessments(**arguments)[0]
    if change in {"completed_cache", "unrecorded_adjudication", "adjudication"}:
        updated = incomplete.model_copy(update={"assessment_status": RoBAssessmentStatus.COMPLETE,
            "requires_adjudication": False, "domains": StudyRoB.model_validate(low).domains,
            "overall_judgment": "Low risk"})
        if change in {"unrecorded_adjudication", "adjudication"}:
            updated = updated.model_copy(update={"assessment_status": RoBAssessmentStatus.ADJUDICATED,
                "adjudicated_by": "reviewer-7", "assessment_origin": "human_adjudication"})
        if change == "adjudication":
            from new_meta.core.result_rob import save_result_rob_adjudication
            save_result_rob_adjudication(project, updated, expected_revision=0,
                                        reason="Reviewer independently checked the full source report.")
        else:
            project.save_json("rob_result_assessments.json", [updated], subdir="risk_of_bias")
    elif change == "new_source":
        arguments["parsed_papers"]["S1"]["full_text"] += " Additional prespecified methods were retrieved."
    else:
        arguments["extracted_studies"][0].outcomes[0].timepoint = "90 days"
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(low), "stop")])
    result = resumed.complete_result_level_assessments(**arguments)[0]
    if change in {"completed_cache", "unrecorded_adjudication"}:
        assert result.assessment_status is RoBAssessmentStatus.INSUFFICIENT_INFORMATION
        assert result.requires_adjudication is True and calls == []
    elif change == "adjudication":
        assert result.assessment_status is RoBAssessmentStatus.ADJUDICATED and calls == []
    else:
        assert result.assessment_status is RoBAssessmentStatus.COMPLETE
        assert result.overall_judgment == "Low risk" and len(calls) == 1


@pytest.mark.parametrize("retained_high", [False, True])
@pytest.mark.parametrize("recorded_adjudication", [False, True])
def test_adjudicated_shortcut_always_requires_matching_human_ledger(provider, tmp_path,
                                                                  retained_high, recorded_adjudication):
    from new_meta.core.result_rob import build_result_rob_drafts, save_result_rob_adjudication
    from new_meta.schemas.risk_of_bias import ResultRoBAssessment, RoBAssessmentStatus, StudyRoB

    project, arguments, high, low = _result_project(tmp_path)
    high["domains"][1]["support"] = low["domains"][1]["support"]
    if retained_high:
        agent = RoBAgent()
        first_calls = provider(agent, [(json.dumps(high), "stop")])
        base = agent.complete_result_level_assessments(**arguments)[0]
        assert base.assessment_status is RoBAssessmentStatus.COMPLETE
        assert base.overall_judgment == "High risk" and len(first_calls) == 1
    else:
        base = build_result_rob_drafts(arguments["extracted_studies"], [])[0]
    purported_adjudication = ResultRoBAssessment.model_validate(base.model_copy(update={
        "assessment_status": RoBAssessmentStatus.ADJUDICATED, "requires_adjudication": False,
        "adjudicated_by": "reviewer-7", "assessment_origin": "human_adjudication",
        "is_synthetic": False, "domains": StudyRoB.model_validate(low).domains,
        "overall_judgment": "Low risk",
    }).model_dump())
    if recorded_adjudication:
        save_result_rob_adjudication(project, purported_adjudication, expected_revision=0,
                                    reason="Reviewer checked the full report and adjudicated this result.")
    else:
        project.save_json("rob_result_assessments.json", [purported_adjudication], subdir="risk_of_bias")
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(high), "stop")])
    result = resumed.complete_result_level_assessments(**arguments)[0]
    if recorded_adjudication:
        assert result.assessment_status is RoBAssessmentStatus.ADJUDICATED
        assert result.overall_judgment == "Low risk" and calls == []
    else:
        assert result.assessment_status is RoBAssessmentStatus.COMPLETE
        assert result.overall_judgment == "High risk"
        assert result.adjudicated_by == ""
        assert len(calls) == (0 if retained_high else 1)


@pytest.mark.parametrize("write_index", [1, 2, 3, 4, 5])
@pytest.mark.parametrize("after_write", [False, True])
def test_result_observation_each_write_boundary_survives_interruption(provider, tmp_path, monkeypatch,
                                                                     write_index, after_write):
    project, arguments, high, low = _result_project(tmp_path, two_results=True)
    agent = RoBAgent()
    calls = provider(agent, [(json.dumps(high), "stop")])
    original = agent._persist_result_rob_observations
    count = 0

    def interrupt_write(current_project):
        nonlocal count
        count += 1
        if count == write_index and not after_write:
            raise KeyboardInterrupt("Interrupted before observation write")
        original(current_project)
        if count == write_index and after_write:
            raise KeyboardInterrupt("Interrupted after observation write")

    monkeypatch.setattr(agent, "_persist_result_rob_observations", interrupt_write)
    with pytest.raises(KeyboardInterrupt):
        agent.complete_result_level_assessments(**arguments)
    assert len(calls) == (0 if write_index == 1 else 1)
    saved = project.load_json("rob_result_source_observations.json", subdir="risk_of_bias")
    resumed = RoBAgent()
    resume_calls = provider(resumed, [(json.dumps(low), "stop")])
    results = resumed.complete_result_level_assessments(**arguments)
    if write_index == 1 and not after_write:
        assert saved is None
        assert len(resume_calls) == 2
        assert all(result.assessment_status.value == "complete" for result in results)
    else:
        assert results[0].assessment_status.value == "insufficient_information"
        assert results[0].requires_adjudication is True
        assert len(resume_calls) == (0 if write_index == 5 and after_write else 1)
        if write_index >= 3 or write_index == 2 and after_write:
            assert saved[0]["raw_responses"][0]["content"] == json.dumps(high)
            study = arguments["extracted_studies"][0]
            from new_meta.core.rob_policy import resolve_rob_policy
            request = resumed._result_rob_request(study=study, outcome=study.outcomes[0],
                full_text=arguments["parsed_papers"]["S1"]["full_text"],
                rob_policy=resolve_rob_policy(family="intervention_rct"))
            assert resumed._retained_result_rob_state(request, arguments["parsed_papers"]["S1"]["full_text"])[2]


def test_failed_atomic_raw_write_preserves_pending_bytes_and_blocks_low_resume(provider, tmp_path, monkeypatch):
    import new_meta.agents.rob_agent as module

    project, arguments, high, low = _result_project(tmp_path)
    path = project.get_path("rob_result_source_observations.json", subdir="risk_of_bias")
    agent = RoBAgent()
    calls = provider(agent, [(json.dumps(high), "stop")])
    original = module.os.replace
    writes = 0
    pending_bytes = None

    def fail_replace(source, target, *args, **kwargs):
        nonlocal writes, pending_bytes
        if target == path:
            writes += 1
            if writes > 1:
                pending_bytes = path.read_bytes()
                raise OSError("Simulated audit replace failure")
        return original(source, target, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(module.os, "replace", fail_replace)
        with pytest.raises(OSError, match="audit replace failure"):
            agent.complete_result_level_assessments(**arguments)
    assert len(calls) == 1
    assert path.read_bytes() == pending_bytes
    assert not list(path.parent.glob(".rob-observations-*"))
    resumed = RoBAgent()
    resume_calls = provider(resumed, [(json.dumps(low), "stop")])
    result = resumed.complete_result_level_assessments(**arguments)[0]
    assert result.assessment_status.value == "insufficient_information"
    assert result.requires_adjudication is True and resume_calls == []


@pytest.mark.parametrize("failure", ["truncated", "invalid", "unreadable", "overlimit"])
def test_bad_persisted_high_risk_audit_requires_recovery_without_overwriting(provider, tmp_path, monkeypatch, failure):
    import new_meta.agents.rob_agent as module
    from pathlib import Path

    project, arguments, high, low = _result_project(tmp_path)
    agent = RoBAgent()
    provider(agent, [(json.dumps(high), "stop")])
    agent.complete_result_level_assessments(**arguments)
    path = project.get_path("rob_result_source_observations.json", subdir="risk_of_bias")
    if failure == "truncated":
        path.write_bytes(path.read_bytes()[:-20])
    elif failure == "invalid":
        path.write_text('{"lost_list_wrapper":true}', encoding="utf-8")
    original = path.read_bytes()
    resumed = RoBAgent()
    calls = provider(resumed, [(json.dumps(low), "stop")])
    with monkeypatch.context() as patch:
        if failure == "unreadable":
            read_bytes = Path.read_bytes

            def fail_read(current_path):
                if current_path == path:
                    raise PermissionError("Simulated unreadable audit")
                return read_bytes(current_path)

            patch.setattr(Path, "read_bytes", fail_read)
        elif failure == "overlimit":
            patch.setattr(module, "_RESULT_ROB_AUDIT_MAX_BYTES", len(original) - 1)
        with pytest.raises((ValueError, PermissionError)):
            resumed.complete_result_level_assessments(**arguments)
    assert path.read_bytes() == original
    assert calls == []
