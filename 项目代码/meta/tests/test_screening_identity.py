"""Offline regressions for source-bound full-text screening decisions."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from new_meta.agents import screening_agent
from new_meta.core.project import Project
from new_meta.core.extraction_status import require_complete_screening
from new_meta.schemas.protocol import PICO, ResearchProtocol


PAPER = {
    "pmid": "35861630",
    "doi": "10.1111/jdi.13888",
    "title": "Effect of canagliflozin on the decline of estimated glomerular filtration rate in chronic kidney disease patients with type 2 diabetes mellitus",
    "authors": ["Wada Takashi"], "year": 2022,
    "trial_registration": "NCT03436693", "pdf_path": "papers/35861630.pdf",
}
CRITERION = "Main trial report identified by PMID 30990260 or PMID 35861630."
FULL_TEXT = (
    "Wada et al. NCT03436693. Canagliflozin 100 mg versus placebo. "
    "The renal composite (ESRD, DoSC or renal death; HR 0.38, 95% CI 0.12–1.22) "
    "was a secondary end-point. The primary end-point was a 30% eGFR decline."
)
# Verbatim decision from the stopped real run. This is deliberately unstructured
# legacy output, not a manually repaired decision or a source of extracted data.
LEGACY_REASON = (
    "This is neither of the two prespecified main reports (PMID 30990260 or PMID 35861630) required by the bounded replication protocol. "
    "It is a separate, independent phase III trial (NCT03436693, Wada et al., J Diabetes Investig 2022) of canagliflozin 100 mg vs placebo in Japanese patients with type 2 diabetes and CKD. "
    "Although it is a randomized, double-blind, placebo-controlled parallel-group trial using canagliflozin 100 mg once daily and does report a renal composite (ESRD, DoSC or renal death; HR 0.38, 95% CI 0.12–1.22) as a secondary end-point, its primary end-point is a 30% eGFR decline, and the protocol explicitly excludes 'any report other than the two specified main reports, including secondary publications, pooled analyses, subgroup reports, and post hoc analyses.' "
    "Therefore it fails the bounded-replication inclusion criterion requiring the report to be identified by PMID 30990260 or PMID 35861630."
)


def protocol():
    return ResearchProtocol(
        research_question="Prespecified replication using the two main reports.",
        pico=PICO(population="Adults with type 2 diabetes and albuminuric CKD",
                  intervention="Canagliflozin 100 mg daily", comparator="Placebo",
                  outcome_primary="ESKD, doubling of creatinine or renal death; excludes cardiovascular death"),
        inclusion_criteria=[CRITERION], exclusion_criteria=["Secondary publications"],
    )


def identity(paper=PAPER):
    return {"record_id": paper["pmid"], "pmid": paper["pmid"], "doi": paper["doi"],
            "trial_registration": paper["trial_registration"]}


def response(**changes):
    payload = {
        "decision": "include", "reason_code": "eligible", "reason": "Main randomized report contains the specified renal endpoint, reported as a secondary trial endpoint.",
        "exclusion_criterion": None, "confidence": "high", "source_identity": identity(),
        "publication_role": "primary_publication", "target_outcome_priority": "secondary",
        "full_text_identity_status": "consistent",
        "publication_identity_checks": [{"identifier_type": "pmid", "requirement": "any_of",
            "identifiers": ["30990260", "35861630"], "protocol_criterion": CRITERION}],
    }
    payload.update(changes)
    return SimpleNamespace(**payload, model_dump=lambda: deepcopy(payload))


def run_screen(tmp_path, responses, paper=None):
    paper = deepcopy(paper or PAPER)
    project = Project("source identity", output_dir=tmp_path)
    agent = screening_agent.ScreeningAgent(dual_screening=False)
    calls = []

    def mock(prompt, schema, **kwargs):
        calls.append(prompt)
        item = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    agent.call_llm_structured = mock
    return agent, project, calls, paper


def test_actual_legacy_identity_contradiction_gets_one_source_bound_reassessment(tmp_path):
    legacy = screening_agent.ScreeningDecision(decision="exclude", reason=LEGACY_REASON,
        exclusion_criterion="Any report other than the two specified main reports", confidence="high")
    agent, project, calls, paper = run_screen(tmp_path, [legacy, response()])
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == []
    assert len(calls) == 2
    assert '"pmid": "35861630"' in calls[0]
    assert '"trial_registration": "NCT03436693"' in calls[0]
    assert "secondary endpoint" in calls[0].lower()
    assert FULL_TEXT in calls[0] and FULL_TEXT in calls[1]
    assert LEGACY_REASON in calls[1]
    row = project.load_json("full_text_screening.json", subdir="screening")[0]
    assert row["screening_attempts"][0]["response"]["reason"] == LEGACY_REASON
    assert row["source_identity"] == identity()


def test_typed_identity_exclusion_cannot_contradict_exact_pmid_match(tmp_path):
    contradiction = response(decision="exclude", reason_code="publication_identity",
        reason=LEGACY_REASON, exclusion_criterion=CRITERION)
    agent, project, calls, paper = run_screen(tmp_path, [contradiction, response()])
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == [] and len(calls) == 2
    assert "satisfied" in calls[1]


@pytest.mark.parametrize("bad", [
    response(decision="exclude", reason_code="publication_identity", reason=LEGACY_REASON,
             exclusion_criterion=CRITERION),
    response(source_identity={**identity(), "pmid": "30990260"}),
    response(decision="exclude", reason_code="publication_identity", publication_identity_checks=[],
             exclusion_criterion=CRITERION),
    response(full_text_identity_status="conflicting"),
    response(decision="exclude", reason_code="publication_type", exclusion_criterion="Secondary publications"),
    response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "any_of",
             "identifiers": ["3586163"], "protocol_criterion": CRITERION}]),
    response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "any_of",
             "identifiers": ["35861630"], "protocol_criterion": "Invented protocol criterion"}]),
    response(decision="review_required", reason_code="uncertain"),
    RuntimeError("offline model failure"),
])
def test_unresolved_screening_is_persisted_for_review_never_normal_exclusion(tmp_path, bad):
    agent, project, calls, paper = run_screen(tmp_path, [bad])
    with pytest.raises(Exception) as raised:
        agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert raised.value.__class__.__name__ == "ScreeningReviewRequired"
    assert raised.value.phase.phase.value == "screening"
    assert raised.value.phase.status.value == "needs_input"
    assert len(calls) == 2
    row = project.load_json("full_text_screening.json", subdir="screening")[0]
    assert row["decision"] == "review_required" and row["paper"]["pmid"] == PAPER["pmid"]
    assert len(row["screening_attempts"]) == 2
    assert project.prisma.full_text_excluded == 0
    assert project.prisma.studies_included == 0
    assert not project.is_step_done("ft_screening")


@pytest.mark.parametrize("reason_code", ["outcome", "population", "intervention"])
def test_allowed_publication_identity_does_not_override_clinical_exclusion(tmp_path, reason_code):
    decision = response(decision="exclude", reason_code=reason_code,
        reason="The full text does not meet the specified clinical criterion.", exclusion_criterion="Clinical mismatch")
    agent, project, calls, paper = run_screen(tmp_path, [decision])
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [] and excluded == [paper] and len(calls) == 1


def test_wrong_publication_is_excluded_without_force_inclusion(tmp_path):
    paper = {**PAPER, "pmid": "99999999"}
    decision = response(decision="exclude", reason_code="publication_identity", source_identity=identity(paper),
        reason="This publication is outside the two allowed main reports.", exclusion_criterion=CRITERION)
    agent, project, calls, paper = run_screen(tmp_path, [decision], paper)
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [] and excluded == [paper] and len(calls) == 1


def test_secondary_publication_stays_excluded_even_when_identifier_is_allowed(tmp_path):
    decision = response(decision="exclude", reason_code="publication_type", publication_role="secondary_analysis",
        reason="This publication reports only a selected subgroup.", exclusion_criterion="Secondary publications")
    agent, project, calls, paper = run_screen(tmp_path, [decision])
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [] and excluded == [paper] and len(calls) == 1


def test_out_of_scope_inclusion_requires_reassessment_instead_of_silent_override(tmp_path):
    paper = {**PAPER, "pmid": "99999999"}
    incorrect = response(source_identity=identity(paper))
    corrected = response(decision="exclude", reason_code="publication_identity", source_identity=identity(paper),
        reason="The paper is not in the bounded publication set.", exclusion_criterion=CRITERION)
    agent, project, calls, paper = run_screen(tmp_path, [incorrect, corrected], paper)
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [] and excluded == [paper] and len(calls) == 2
    rows = project.load_json("full_text_screening.json", subdir="screening")
    assert rows[0]["screening_attempts"][0]["response"]["decision"] == "include"


def test_missing_source_text_is_review_required_without_calling_model(tmp_path):
    agent, project, calls, paper = run_screen(tmp_path, [response()])
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], protocol(), {}, project)
    assert calls == []
    assert project.load_json("full_text_screening.json", subdir="screening")[0]["decision"] == "review_required"


def test_successful_reassessment_replaces_pending_phase_status(tmp_path):
    bad = response(source_identity={**identity(), "pmid": "30990260"})
    agent, project, calls, paper = run_screen(tmp_path, [bad])
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    agent.call_llm_structured = lambda *args, **kwargs: response()
    included, excluded = agent.screen_full_text([paper], protocol(), {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == []
    assert project.load_json("full_text_screening_status.json", subdir="screening")["status"] == "succeeded"
    require_complete_screening(project)


def test_doi_only_publication_constraint_uses_case_insensitive_exact_equality(tmp_path):
    paper = {**PAPER, "pmid": "", "doi": "10.9999/Study-A"}
    expected = {**identity(paper), "record_id": paper["doi"]}
    criterion = "Only the main report DOI 10.9999/study-a is eligible."
    decision = response(source_identity=expected, publication_identity_checks=[{
        "identifier_type": "doi", "requirement": "any_of", "identifiers": ["10.9999/study-a"],
        "protocol_criterion": criterion,
    }])
    scoped = protocol()
    scoped.inclusion_criteria = [criterion]
    agent, project, calls, paper = run_screen(tmp_path, [decision], paper)
    included, excluded = agent.screen_full_text([paper], scoped, {paper["doi"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == [] and len(calls) == 1


@pytest.mark.parametrize("omission", ["alternative", "entire_check", "research_question"])
def test_incomplete_publication_constraint_coverage_never_finalizes_a_decision(tmp_path, omission):
    paper = deepcopy(PAPER)
    scoped = protocol()
    if omission == "alternative":
        bad = response(decision="exclude", reason_code="publication_identity", exclusion_criterion=CRITERION,
            publication_identity_checks=[{"identifier_type": "pmid", "requirement": "any_of",
                "identifiers": ["30990260"], "protocol_criterion": CRITERION}])
    elif omission == "entire_check":
        paper["pmid"] = "99999999"
        bad = response(source_identity=identity(paper), publication_identity_checks=[])
    else:
        scoped.research_question = "Replicate only the main report PMID 35861630."
        bad = response()
    agent, project, calls, paper = run_screen(tmp_path, [bad], paper)
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert len(calls) == 2
    assert project.load_json("full_text_screening.json", subdir="screening")[0]["decision"] == "review_required"


@pytest.mark.parametrize("suffix", ["study-a", "study.a", "study/a", "study_a", "study(2022)"])
def test_doi_prefix_is_not_a_complete_protocol_identifier(tmp_path, suffix):
    paper = {**PAPER, "pmid": "", "doi": "10.9999/" + suffix}
    expected = {**identity(paper), "record_id": paper["doi"]}
    criterion = f"Only the main report DOI {paper['doi']} is eligible."
    scoped = protocol()
    scoped.inclusion_criteria = [criterion]
    bad = response(decision="exclude", reason_code="publication_identity", exclusion_criterion=criterion,
        source_identity=expected, publication_identity_checks=[{"identifier_type": "doi", "requirement": "any_of",
            "identifiers": ["10.9999/study"], "protocol_criterion": criterion}])
    agent, project, calls, paper = run_screen(tmp_path, [bad], paper)
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], scoped, {paper["doi"]: {"full_text": FULL_TEXT}}, project)
    assert len(calls) == 2


def test_unrestricted_protocol_accepts_empty_publication_constraint_list(tmp_path):
    scoped = protocol()
    scoped.inclusion_criteria = ["Randomized placebo-controlled trials with reported renal outcomes."]
    agent, project, calls, paper = run_screen(tmp_path, [response(publication_identity_checks=[])])
    included, excluded = agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == [] and len(calls) == 1


@pytest.mark.parametrize("criterion", [
    "Main reports PMIDs: 30990260, 35861630.",
    "Main reports PMID 30990260 or 35861630.",
    "Main reports PMID 30990260 and PMID 35861630.",
    "Main reports (PMID30990260;35861630).",
    "Main reports PMID 30990260 / 35861630.",
    "Main reports PMID **30990260** or PMID **35861630**.",
    "Main reports PMID `30990260` or PMID `35861630`.",
    "Main reports PMID *30990260* or PMID *35861630*.",
    "Main reports PMID _30990260_ or PMID _35861630_.",
    "Main reports **PMID** **30990260** or **PMID** **35861630**.",
])
def test_complete_shared_label_pmid_alternatives_are_accepted(tmp_path, criterion):
    scoped = protocol()
    scoped.inclusion_criteria = [criterion]
    valid = response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "any_of",
        "identifiers": ["30990260", "35861630"], "protocol_criterion": criterion}])
    agent, project, calls, paper = run_screen(tmp_path, [valid])
    included, excluded = agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == [] and len(calls) == 1


def test_repeated_identifier_mentions_each_receive_a_complete_assessment(tmp_path):
    scoped = protocol()
    scoped.research_question = "Replicate the main reports PMID 30990260 and PMID 35861630."
    valid = response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "any_of",
        "identifiers": ["30990260", "35861630"], "protocol_criterion": criterion}
        for criterion in [CRITERION, scoped.research_question]])
    agent, project, calls, paper = run_screen(tmp_path, [valid])
    included, excluded = agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [paper] and excluded == [] and len(calls) == 1


@pytest.mark.parametrize("context_reason", [None, "The cited review motivates the question; it does not limit eligible trial publications."])
def test_contextual_citation_needs_an_explicit_semantic_assessment(tmp_path, context_reason):
    scoped = protocol()
    scoped.research_question = "Review renal outcomes; the review PMID 12345678 provides background only."
    scoped.inclusion_criteria = ["Randomized controlled trials with reported renal outcomes."]
    valid = response(publication_identity_checks=[{"identifier_type": "pmid", "requirement": "context_only",
        "identifiers": ["12345678"], "protocol_criterion": scoped.research_question, "context_reason": context_reason}])
    agent, project, calls, paper = run_screen(tmp_path, [valid])
    if context_reason:
        included, excluded = agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
        assert included == [paper] and excluded == [] and len(calls) == 1
    else:
        with pytest.raises(screening_agent.ScreeningReviewRequired):
            agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
        assert len(calls) == 2


def test_complete_forbidden_publication_set_retains_semantic_exclusion(tmp_path):
    scoped = protocol()
    scoped.inclusion_criteria = []
    criterion = "Exclude the reports PMID 30990260 or PMID 35861630."
    scoped.exclusion_criteria = [criterion]
    valid = response(decision="exclude", reason_code="publication_identity", exclusion_criterion=criterion,
        publication_identity_checks=[{"identifier_type": "pmid", "requirement": "none_of",
            "identifiers": ["30990260", "35861630"], "protocol_criterion": criterion}])
    agent, project, calls, paper = run_screen(tmp_path, [valid])
    included, excluded = agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert included == [] and excluded == [paper] and len(calls) == 1


@pytest.mark.parametrize("criterion", [
    "Main reports PMID **30990260** or PMID **35861630**.",
    "Main reports PMID `30990260` or PMID `35861630`.",
    "Main reports PMID *30990260* or PMID _35861630_.",
])
def test_markdown_pmid_constraints_cannot_disappear_from_coverage(tmp_path, criterion):
    scoped = protocol()
    scoped.inclusion_criteria = [criterion]
    paper = {**PAPER, "pmid": "99999999"}
    bad = response(source_identity=identity(paper), publication_identity_checks=[])
    agent, project, calls, paper = run_screen(tmp_path, [bad], paper)
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert len(calls) == 2


@pytest.mark.parametrize("criterion", [
    "Only PMID 12345678901 is allowed.",
    "Only PMID 35861630extra is allowed.",
    "Only PMIDs 30990260 or 12345678901 are allowed.",
    "Only PMID **12345678901** is allowed.",
])
def test_malformed_pmid_tokens_never_become_an_unrestricted_protocol(tmp_path, criterion):
    scoped = protocol()
    scoped.inclusion_criteria = [criterion]
    paper = {**PAPER, "pmid": "99999999"}
    bad = response(source_identity=identity(paper), publication_identity_checks=[])
    agent, project, calls, paper = run_screen(tmp_path, [bad], paper)
    with pytest.raises(screening_agent.ScreeningReviewRequired):
        agent.screen_full_text([paper], scoped, {paper["pmid"]: {"full_text": FULL_TEXT}}, project)
    assert project.load_json("full_text_screening.json", subdir="screening")[0]["decision"] == "review_required"
