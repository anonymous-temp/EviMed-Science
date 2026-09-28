"""Complete source verification, without live model calls or historical mutations."""
import pytest

from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def protocol():
    return ResearchProtocol(research_question="Drug versus placebo for renal progression",
        pico=PICO(population="CKD", intervention="Drug", comparator="Placebo",
                  outcome_primary="Kidney failure, creatinine doubling, or renal death"),
        review_family="intervention_rct", primary_outcome_type="time_to_event", effect_measure="HR")


def study():
    return ExtractedStudy(characteristics=StudyCharacteristics(study_id="trial-paper", study_design="RCT"), outcomes=[
        OutcomeData(outcome_name="Renal endpoint", outcome_type="time_to_event", hazard_ratio=0.38,
                    hr_ci_lower=0.12, hr_ci_upper=1.22, reported_effect_measure="HR",
                    source_quote="The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", source_location="Table 3", source_quote_verified=True)])


SOURCE = ("Adults with CKD were randomized to Drug or placebo in trial NCT03436693. "
          "The renal endpoint was kidney failure, creatinine doubling, or renal death. "
          "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22). "
          "The treatment model adjusted only for baseline eGFR and included the randomized cohort.")


def checked_row(index=0):
    row = {"outcome_index": index,
        **{name: {"status": "match", "rationale": "The source supports this judgment.", "quote": SOURCE, "source_location": "Methods/Table 3"} for name in ["outcome", "population", "contrast"]},
        "verification": {
            "numeric_status": "verified", "numeric_findings": [
                {"field": name, "status": "match", "reported_value": value, "quote": "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", "source_location": "Table 3", "rationale": "Reported directly."}
                for name, value in [("hazard_ratio", .38), ("hr_ci_lower", .12), ("hr_ci_upper", 1.22)]],
            "endpoint_relation": "equivalent", "source_endpoint_definition": {"quote": "The renal endpoint was kidney failure, creatinine doubling, or renal death.", "source_location": "Methods"},
            "components": [{"source_component": name, "protocol_component": name, "relation": "match"} for name in ["kidney failure", "creatinine doubling", "renal death"]],
            "estimand_relation": "match", "randomized_comparison": True, "postrandomization_conditioning": False,
            "selection_timing": "baseline", "conditioning_variables": [{"name": "eGFR", "timing": "baseline", "quote": "The treatment model adjusted only for baseline eGFR and included the randomized cohort.", "source_location": "Methods"}],
            "estimand_support": {"quote": "The treatment model adjusted only for baseline eGFR and included the randomized cohort.", "source_location": "Methods"},
            "trial_coverage": "complete", "trial_units": [{"registry_id": "NCT03436693", "trial_name": "", "role": "contributing", "quote": "Adults with CKD were randomized to Drug or placebo in trial NCT03436693.", "source_location": "Methods"}],
        }}

    from endpoint_binding_fixture import bind_components
    return bind_components(row, SOURCE)


def test_healthy_direct_renal_effect_has_complete_verification():
    from new_meta.core.extraction_verification import validate_check_batch, verification_verdict
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = PrimaryAlignmentAssessment.model_validate(checked_row())
    assert validate_check_batch(study(), [0], [item], SOURCE, protocol()) == []
    assert verification_verdict(item, protocol())["status"] == "match"


def test_high_scoring_numeric_claim_cannot_override_reported_ci():
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = checked_row(); item["verification"]["numeric_findings"][2]["reported_value"] = 1.02
    wrong = study(); wrong.outcomes[0].hr_ci_upper = .78
    errors = validate_check_batch(wrong, [0], [PrimaryAlignmentAssessment.model_validate(item)], SOURCE, protocol())
    assert any(error["code"] == "numeric_value_mismatch" for error in errors)


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "wrong_index", "forged_anchor"])
def test_batch_requires_complete_unique_source_anchored_rows(mutation):
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    items = [checked_row()]
    if mutation == "missing": items = []
    if mutation == "duplicate": items *= 2
    if mutation == "wrong_index": items[0]["outcome_index"] = 1
    if mutation == "forged_anchor": items[0]["contrast"]["quote"] = "The study compared Drug with an active comparator."
    assert validate_check_batch(study(), [0], [PrimaryAlignmentAssessment.model_validate(x) for x in items], SOURCE, protocol())


@pytest.mark.parametrize("change", ["extra_component", "postrandomization", "uncertain_timing"])
def test_structured_clinical_facts_override_legacy_all_match(change):
    from new_meta.core.extraction_verification import verification_verdict
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = checked_row(); details = item["verification"]
    if change == "extra_component": details["components"].append({"source_component": "cardiovascular death", "protocol_component": "", "relation": "extra"})
    elif change == "postrandomization": details["conditioning_variables"][0]["timing"] = "postrandomization"
    else: details["postrandomization_conditioning"] = None
    result = verification_verdict(PrimaryAlignmentAssessment.model_validate(item), protocol())
    assert result["status"] == ("unknown" if change == "uncertain_timing" else "mismatch")


def test_two_verified_independent_trial_units_are_allowed():
    from new_meta.core.extraction_verification import trial_unit_issues
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    first, second = checked_row(), checked_row()
    second["verification"]["trial_units"][0]["registry_id"] = "NCT02065791"
    assert trial_unit_issues([("paperA:0", PrimaryAlignmentAssessment.model_validate(first)),
                              ("paperB:0", PrimaryAlignmentAssessment.model_validate(second))]) == []


@pytest.mark.parametrize("case", ["shared", "pooled", "unknown"])
def test_publications_do_not_establish_trial_independence(case):
    from new_meta.core.extraction_verification import trial_unit_issues
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    first, second = checked_row(), checked_row()
    if case == "pooled": second["verification"]["trial_units"].append({**second["verification"]["trial_units"][0], "registry_id": "NCT02065791"})
    if case == "unknown": second["verification"]["trial_units"] = []
    errors = trial_unit_issues([("paperA:0", PrimaryAlignmentAssessment.model_validate(first)),
                                ("paperB:0", PrimaryAlignmentAssessment.model_validate(second))])
    assert errors and errors[0]["reason"] == ("trial_identity_required" if case == "unknown" else "overlapping_trial_units")


def run_verifier(tmp_path, monkeypatch, responses, *, candidate=None, content=SOURCE, repair=None, batch_size=4):
    import hashlib
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.project import Project
    project = Project("verifier regression", output_dir=tmp_path)
    # Existing mixed-batch fixtures continue exercising batch isolation, even
    # when production sends one outcome per independently observed response.
    if batch_size is not None:
        monkeypatch.setattr("new_meta.agents.data_extraction_agent.VERIFICATION_BATCH_SIZE", batch_size)
    path = project.base_dir / "papers" / "source.txt"; path.write_text(content)
    agent = DataExtractionAgent(); calls = []
    iterator = iter(responses)
    def check(text, extracted, current_protocol, indices, feedback, observe=None, catalogue=None):
        from extraction_source_fixture import observed_check
        calls.append((text, list(indices), list(feedback)))
        return observed_check(next(iterator), text, observe, catalogue)
    monkeypatch.setattr(agent, "_check_extraction", check)
    if repair is not None: monkeypatch.setattr(agent, "_refine_extraction", repair)
    result = agent._verify_alignment(candidate or study(), {"fulltext_path": str(path)},
        {"full_text": content, "_source_sha256": hashlib.sha256(content.encode()).hexdigest()}, protocol(), project)
    return project, result, calls


def test_checker_repairs_missing_coverage_before_stamping(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, result, calls = run_verifier(tmp_path, monkeypatch,
        [ExtractionCheckResult(data_issues=[], score=10), ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[checked_row()])])
    assert len(calls) == 2 and calls[1][2][0]["code"] == "verification_index_coverage"
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert len([item for item in (project.base_dir / "extraction/verification").glob("*.json")
                if '"status": "observed"' not in item.read_text()]) == 2


def test_high_score_with_numeric_error_requires_fresh_corrected_verification(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    wrong = study(); wrong.outcomes[0].hr_ci_upper = .78
    checked = ExtractionCheckResult(data_issues=[], score=10, issues=["Incorrect upper CI; use the full Results value."], primary_analysis_alignment=[checked_row()])
    good = ExtractionCheckResult(data_issues=[], score=10, primary_analysis_alignment=[checked_row()])
    repairs = []
    def repair(content, candidate, response, current_protocol, indices, feedback):
        repairs.append(feedback)
        fixed = candidate.model_copy(deep=True); fixed.outcomes[0].hr_ci_upper = 1.22
        return fixed
    project, result, calls = run_verifier(tmp_path, monkeypatch, [checked, good], candidate=wrong, repair=repair)
    assert len(calls) == 2 and repairs
    assert result.outcomes[0].hr_ci_upper == 1.22
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"


def test_complete_clinical_mismatch_is_retained_despite_out_of_batch_advisories(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    payload = checked_row()
    payload["outcome"]["status"] = "mismatch"
    payload["verification"]["endpoint_relation"] = "source_narrower"
    payload["verification"]["components"].append({
        "source_component": "", "protocol_component": "sustained eGFR decline", "relation": "missing"})
    from endpoint_binding_fixture import bind_components
    payload = bind_components(payload, SOURCE)
    checked = ExtractionCheckResult(score=6, data_issues=[],
        issues=["The selected renal endpoint is narrower than the protocol outcome.",
                "Only one outcome row was extracted; the other study outcomes were not extracted."],
        primary_analysis_alignment=[payload])
    def forbidden_repair(*_args):
        pytest.fail("A complete clinical mismatch must not invoke numeric refinement")
    project, result, calls = run_verifier(tmp_path, monkeypatch, [checked], repair=forbidden_repair)
    assert len(calls) == 1
    assert alignment_status(project, protocol(), result, 0)["status"] == "mismatch"
    assert result.outcomes[0].hazard_ratio == .38


@pytest.mark.parametrize("index, field", [(1, "hr_ci_upper"), (0, "unregistered_numeric_operand")])
def test_invalid_row_data_issue_cannot_be_silently_ignored(tmp_path, monkeypatch, index, field):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    checked = ExtractionCheckResult(score=10, primary_analysis_alignment=[checked_row()], data_issues=[{
        "outcome_index": index, "field": field, "kind": "incorrect_value", "rationale": "An actual row value needs checking.",
        "quote": "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", "source_location": "Table 3"}])
    def forbidden_repair(*_args):
        pytest.fail("Malformed checker issues must retry verification, not mutate extracted values")
    project, result, calls = run_verifier(tmp_path, monkeypatch, [checked] * 3, repair=forbidden_repair)
    assert len(calls) == 3
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


def test_checker_must_explicitly_supply_typed_data_issues():
    from pydantic import ValidationError
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    with pytest.raises(ValidationError):
        ExtractionCheckResult.model_validate({"score": 10, "primary_analysis_alignment": [checked_row()]})


def test_typed_data_defect_repairs_only_its_named_row_then_reverifies(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    candidate = study()
    candidate.outcomes.append(candidate.outcomes[0].model_copy(deep=True))
    candidate.outcomes[1].reported_effect_scale = "log"
    defect = {"outcome_index": 1, "field": "reported_effect_scale", "kind": "incorrect_metadata",
        "rationale": "The reported HR is on the original ratio scale, not log scale.",
        "quote": "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", "source_location": "Table 3"}
    first = ExtractionCheckResult(score=9, data_issues=[defect],
        primary_analysis_alignment=[checked_row(0), checked_row(1)])
    second = ExtractionCheckResult(score=10, data_issues=[],
        primary_analysis_alignment=[checked_row(0), checked_row(1)])
    repaired = []
    def repair(_content, current, _response, _protocol, indices, _feedback):
        repaired.append(indices)
        fixed = current.model_copy(deep=True)
        fixed.outcomes[1].reported_effect_scale = "original"
        return fixed
    project, result, calls = run_verifier(tmp_path, monkeypatch, [first, second], candidate=candidate, repair=repair)
    assert repaired == [[1]] and len(calls) == 2
    assert all(alignment_status(project, protocol(), result, index)["status"] == "match" for index in [0, 1])


def test_typed_source_conflict_never_triggers_numeric_refinement(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    checked = ExtractionCheckResult(score=10, primary_analysis_alignment=[checked_row()], data_issues=[{
        "outcome_index": 0, "field": "hr_ci_upper", "kind": "source_conflict",
        "rationale": "This source value conflicts with another reported value and requires adjudication.",
        "quote": "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", "source_location": "Table 3"}])
    def forbidden_repair(*_args):
        pytest.fail("A source conflict must not be erased by automatic refinement")
    project, result, calls = run_verifier(tmp_path, monkeypatch, [checked], repair=forbidden_repair)
    assert len(calls) == 1
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


def test_source_middle_is_preserved_and_batch_indices_are_original(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    content = "Retained introduction. " * 900 + SOURCE + "Retained appendix. " * 1600
    candidate = study(); candidate.outcomes = [candidate.outcomes[0].model_copy(deep=True) for _ in range(5)]
    responses = [ExtractionCheckResult(data_issues=[], score=9, primary_analysis_alignment=[checked_row(i)])
                 for i in range(5)]
    project, result, calls = run_verifier(tmp_path, monkeypatch, responses, candidate=candidate,
                                        content=content, batch_size=None)
    assert all(item[0] == content for item in calls)
    assert [item[1] for item in calls] == [[0], [1], [2], [3], [4]]
    assert all(alignment_status(project, protocol(), result, i)["status"] == "match" for i in range(5))


@pytest.mark.parametrize("subgroups,secondary", [([], []), (["baseline kidney stage"], ["all-cause mortality"])])
def test_extraction_prompt_receives_exact_prespecified_result_scope(tmp_path, monkeypatch, subgroups, secondary):
    import json
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, OutcomeList
    from new_meta.core.project import Project
    current = protocol()
    current.subgroup_variables = subgroups
    current.pico.outcomes_secondary = secondary
    fixture = study()
    agent = DataExtractionAgent()
    prompts = []
    def extract(prompt, schema, _identity):
        prompts.append(prompt)
        return OutcomeList(outcomes=[item.model_dump(mode="json") for item in fixture.outcomes]) if schema is OutcomeList else fixture.characteristics
    monkeypatch.setattr(agent, "_extract_with_retry", extract)
    agent._extract_single({"pmid": "trial-paper"}, {"full_text": SOURCE}, current,
                          Project("scope extraction", output_dir=tmp_path))
    assert "- Prespecified Subgroup Analyses: " + json.dumps(subgroups) in prompts[1]
    assert "- Secondary Outcomes: " + json.dumps(secondary) in prompts[1]
    assert "extract overall and per-subgroup data" not in prompts[1]
    assert "only if the paper explicitly reports that SE" in prompts[1]


def test_exhausted_incomplete_verification_has_precise_runtime_reasons(tmp_path, monkeypatch):
    import json
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, result, calls = run_verifier(tmp_path, monkeypatch, [ExtractionCheckResult(data_issues=[], score=10) for _ in range(3)])
    assert len(calls) == 3
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert "verification_index_coverage" in result.outcomes[0].primary_analysis_alignment.assessment.outcome.rationale
    records = [json.loads(path.read_text()) for path in (project.base_dir / "extraction/verification").glob("*.json")]
    assert any(item["status"] == "needs_input" and item["attempt"] == 3 for item in records)


@pytest.mark.parametrize("value,quote,field,valid", [
    (1.22, "HR 0.38 (95% CI 0.12-1.22)", "hr_ci_upper", True),
    (1.02, "HR 0.73 (95% CI 0.53,1.02)", "hr_ci_upper", True),
    (4, "Events were 4/154 (2.6%).", "events_intervention", True),
    (154, "Events were 4/154 (2.6%).", "total_intervention", True),
    (154, "Events were 4/154 (2.6%).", "events_intervention", False),
    (2, "The ratio was 1/2.", "effect_size", False),
    (103, "Count 10³ cells.", "total_n", False),
    (3, "Count 10^3 cells.", "total_n", False),
    (5, "The estimate was -5.", "effect_size", False),
    (.78, "HR0.73;95%CI,0.53to1.02", "hr_ci_upper", False),
])
def test_numeric_field_scopes_preserve_roles_and_whole_numbers(value, quote, field, valid):
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert numeric_value_in_quote(value, quote, field) is valid


def test_p_value_and_covariance_cannot_bypass_numeric_coverage():
    from new_meta.core.extraction_verification import numeric_fields, validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    candidate = study(); candidate.outcomes[0].p_value = .00001
    candidate.outcomes[0].covariance_with = {"another_contrast": .01}
    fields = numeric_fields(candidate.outcomes[0])
    assert fields["p_value"] == .00001 and fields["covariance_with[another_contrast]"] == .01
    notices = []
    errors = validate_check_batch(candidate, [0], [PrimaryAlignmentAssessment.model_validate(checked_row())], SOURCE,
                                  protocol(), notices=notices)
    # An extracted covariance is always verified; the p-value this HR (with its CI) never reads is reported.
    assert any(item["code"] == "numeric_field_coverage" and "covariance_with[another_contrast]" in item["expected"]
               for item in errors)
    candidate.outcomes[0].covariance_with = {}
    notices = []
    assert validate_check_batch(candidate, [0], [PrimaryAlignmentAssessment.model_validate(checked_row())], SOURCE,
                                protocol(), notices=notices) == []
    assert [item["code"] for item in notices] == ["numeric_field_coverage"]
    # Without a CI this row computes nothing, and every number counts again.
    candidate.outcomes[0].hr_ci_lower = candidate.outcomes[0].hr_ci_upper = None
    errors = validate_check_batch(candidate, [0], [PrimaryAlignmentAssessment.model_validate(checked_row())], SOURCE, protocol())
    assert any(item["code"] == "numeric_field_coverage" and "p_value" in item["expected"] for item in errors)


def test_name_only_identity_cannot_be_assumed_distinct_from_registry_identity():
    from new_meta.core.extraction_verification import trial_unit_issues
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    first, second = checked_row(), checked_row()
    second["verification"]["trial_units"][0].update(registry_id="", trial_name="CREDENCE")
    issues = trial_unit_issues([("paperA:0", PrimaryAlignmentAssessment.model_validate(first)),
                               ("paperB:0", PrimaryAlignmentAssessment.model_validate(second))])
    assert any(item["row_id"] == "paperB:0" and item["reason"] == "trial_identity_required" for item in issues)


def test_registry_identity_uses_same_unicode_normalization_as_its_source_anchor():
    from new_meta.core.extraction_verification import trial_unit_issues, validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    first, second = checked_row(), checked_row()
    second["verification"]["trial_units"][0]["registry_id"] = "ＮＣＴ０３４３６６９３"
    second = PrimaryAlignmentAssessment.model_validate(second)
    assert validate_check_batch(study(), [0], [second], SOURCE, protocol()) == []
    issues = trial_unit_issues([("paperA:0", PrimaryAlignmentAssessment.model_validate(first)), ("paperB:0", second)])
    assert any(item["reason"] == "overlapping_trial_units" for item in issues)


def test_schema_retries_keep_the_complete_source_in_every_verifier_request(tmp_path, monkeypatch):
    import hashlib
    import json
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import alignment_status
    project = Project("source preserving schema repair", output_dir=tmp_path)
    path = project.base_dir / "papers/source.txt"; path.write_text(SOURCE)
    invalid = checked_row(); del invalid["verification"]["numeric_status"]
    from extraction_source_fixture import wire_payload
    responses = iter([json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [invalid]}, SOURCE)),
                      json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [checked_row()]}, SOURCE))])
    calls = []; agent = DataExtractionAgent()
    def fake_call(**kwargs):
        calls.append(kwargs["messages"])
        raw = next(responses)
        kwargs["on_raw_response"]({"content": raw, "finish_reason": "stop", "provider_response_ordinal": 1})
        return raw
    monkeypatch.setattr(agent.llm, "_call", fake_call)
    result = agent._verify_alignment(study(), {"fulltext_path": str(path)},
        {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol(), project)
    assert len(calls) == 2
    from new_meta.core.extraction_sources import source_catalogue, source_prompt
    rendered_source = source_prompt(SOURCE, source_catalogue(SOURCE, hashlib.sha256(SOURCE.encode()).hexdigest()))
    assert all(any(rendered_source in message["content"] for message in messages) for messages in calls)
    assert "numeric_status" in calls[1][-1]["content"]
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"



def test_all_generic_schema_repairs_retain_original_messages_without_mutation(monkeypatch):
    import copy
    import json
    from pydantic import BaseModel
    from new_meta.core.llm import LLMClient
    import new_meta.core.llm as llm_module
    class Response(BaseModel):
        count: int
    messages = [{"role": "system", "content": "Source-bound reviewer"},
                {"role": "user", "content": "COMPLETE_SOURCE_MARKER protocol and full text: " + "source " * 5000}]
    original = copy.deepcopy(messages); calls=[]
    responses = iter(['{}', '{}', '{"count": 7}'])
    client = LLMClient()
    monkeypatch.setattr(llm_module, "LLM_JSON_REPAIR_RETRIES", 2)
    def fake_call(**kwargs):
        calls.append(copy.deepcopy(kwargs["messages"]))
        return next(responses)
    monkeypatch.setattr(client, "_call", fake_call)
    assert client.structured_output(messages, Response).count == 7
    assert messages == original and len(calls) == 3
    assert all(any(original[1]["content"] in message["content"] for message in call) for call in calls)


def real_case(pmid):
    import json
    from pathlib import Path
    return json.loads((Path(__file__).parent / "fixtures/extraction_verification_cases.json").read_text())["cases"][pmid]


def case_source(case):
    return "\n\n".join(item["text"] for item in case["source_excerpt_spans"])


def source_piece(case, name):
    return next(item["text"] for item in case["source_excerpt_spans"] if item["name"] == name)


def case_assessment(case, candidate, index, numeric_name, *, incompatible=False):
    from new_meta.core.extraction_verification import numeric_fields
    item = checked_row(index)
    definition = source_piece(case, "endpoint_definition")
    population = source_piece(case, "population")
    causal = source_piece(case, "conditioning" if incompatible else "assignment")
    for dimension, quote in [("outcome", definition), ("population", population), ("contrast", causal)]:
        item[dimension].update(quote=quote, source_location="Original article Methods/Table")
    details = item["verification"]
    details["numeric_findings"] = [{"field": field, "status": "match", "reported_value": value,
        "quote": source_piece(case, numeric_name), "source_location": "Original article table",
        "rationale": "Directly reported estimate/count/precision in this table row."}
        for field, value in numeric_fields(candidate.outcomes[index]).items()]
    details["source_endpoint_definition"] = {"quote": definition, "source_location": "Original article Methods"}
    details["estimand_support"] = {"quote": causal, "source_location": "Original article model/assignment description"}
    details["conditioning_variables"] = [{"name": "year1 substrate change" if incompatible else "baseline eGFR",
        "timing": "postrandomization" if incompatible else "baseline", "quote": causal, "source_location": "Original article model description"}]
    details["postrandomization_conditioning"] = incompatible
    details["trial_units"] = [{"registry_id": "NCT02065791" if incompatible else "NCT03436693", "trial_name": "",
        "role": "contributing", "quote": source_piece(case, "trial"), "source_location": "Original article trial registration"}]
    if incompatible:
        details["endpoint_relation"] = "source_broader"
        details["components"].append({"source_component": "cardiovascular death", "protocol_component": "", "relation": "extra"})
    source_labels = (["end-stage kidney disease", "doubling of serum creatinine level", "kidney", "CV disease"]
                     if incompatible else ["ESRD", "DoSC", "renal death"])
    for component, label in zip(details["components"], source_labels):
        component["source_component"] = label
    from endpoint_binding_fixture import bind_components
    return bind_components(item, case_source(case))


def select_stamped(tmp_path, candidates):
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import record_checked_alignments
    from new_meta.core.pipeline_runner import PipelineRunner
    from new_meta.schemas.risk_of_bias import StudyRoB
    project = Project("verified candidate regression", output_dir=tmp_path)
    studies=[]
    for candidate, assessments, text in candidates:
        path = project.base_dir / "papers" / (candidate.characteristics.study_id + ".txt")
        path.write_text(text)
        from endpoint_binding_fixture import bind_components
        assessments = [bind_components(item, text) for item in assessments]
        record_checked_alignments(project, protocol(), candidate, assessments, source_text=text, source_path=path)
        studies.append(candidate)
    project.save_json("protocol.json", protocol())
    project.save_json("all_extractions.json", studies, subdir="extraction")
    rob = [StudyRoB(study_id=item.characteristics.study_id, overall_judgment="Low risk", tool_used="RoB 2", domains=[]) for item in studies]
    project.save_json("rob_results.json", rob, subdir="risk_of_bias")
    phase = PipelineRunner(project).run_primary_effect_selection(protocol=protocol(), extracted_studies=studies, rob_results=rob)
    return project, phase


def test_actual_japanese_renal_result_remains_selectable(tmp_path):
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    case = real_case("35861630"); data = case["row"]
    candidate = ExtractedStudy(characteristics=StudyCharacteristics(study_id="35861630", pmid="35861630", title="Japanese phase III trial", authors=["Wada Takashi"], year=2022, study_design="RCT"),
        outcomes=[OutcomeData(**data, outcome_type="time_to_event", reported_effect_measure="HR", source_quote=source_piece(case, "numeric"), source_location="Table 3", source_quote_verified=True)])
    assessment = case_assessment(case, candidate, 0, "numeric")
    errors = validate_check_batch(candidate, [0], [PrimaryAlignmentAssessment.model_validate(assessment)], case_source(case), protocol())
    assert errors == []
    project, phase = select_stamped(tmp_path, [(candidate, [assessment], case_source(case))])
    assert phase.status.value == "succeeded" and len(phase.data["effects"]) == 1
    assert phase.data["selection_audit"][0]["decision"] == "selected_within_study"
    assert candidate.outcomes[0].effect_size == .38
    assert candidate.outcomes[0].hr_ci_upper == 1.22
    assert candidate.outcomes[0].events_intervention == 4 and candidate.outcomes[0].total_intervention == 154


def test_actual_conditional_cardiorenal_rows_cannot_be_primary_choices(tmp_path):
    from new_meta.core.extraction_review import build_extraction_source_cards
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    case = real_case("39704168")
    # Preserve original indices; untested positions have no extracted numeric data.
    outcomes = [OutcomeData(outcome_name="Untested nonprimary biomarker", outcome_type="continuous") for _ in range(13)]
    for row in case["rows"]:
        index=row["outcome_index"]
        outcomes[index] = OutcomeData(**{key: value for key, value in row.items() if key != "outcome_index"}, outcome_type="time_to_event", reported_effect_measure="HR",
            source_quote=source_piece(case, f"numeric_{index}"), source_location="Table 5", source_quote_verified=True)
    candidate = ExtractedStudy(characteristics=StudyCharacteristics(study_id="39704168", pmid="39704168", title="Reduced CREDENCE analysis", authors=["Ferrannini Ele"], year=2024, study_design="RCT"), outcomes=outcomes)
    assessments = [case_assessment(case, candidate, index, f"numeric_{index}", incompatible=True) for index in range(8,13)]
    assert validate_check_batch(candidate, list(range(8,13)), [PrimaryAlignmentAssessment.model_validate(item) for item in assessments], case_source(case), protocol()) == []
    project, phase = select_stamped(tmp_path, [(candidate, assessments, case_source(case))])
    audit = project.load_json("effect_selection_audit.json", subdir="analysis")
    for row in audit:
        if 8 <= row["outcome_index"] <= 12:
            assert row["decision"] == "excluded" and row["reason"] == "primary_alignment_mismatch"
    project.save_json("extraction_audit.json", {"rows": audit, "summary": {}}, subdir="extraction")
    cards = build_extraction_source_cards(project)
    assert all("primary_choice_action" not in card["review_action"] for card in cards if card["row_id"] in {f"39704168:{i}" for i in range(8,13)})
    assert not phase.data.get("effects")


def test_actual_ci_error_is_not_overridden_by_a_high_checker_score(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    case = real_case("34272327")
    text = "Preserved introduction. " * 900 + case_source(case) + "Preserved appendix. " * 1600
    candidate=study(); candidate.outcomes[0].hazard_ratio=.73; candidate.outcomes[0].hr_ci_lower=.53; candidate.outcomes[0].hr_ci_upper=.78
    item=checked_row()
    for name in ["outcome", "population", "contrast"]: item[name].update(status="uncertain", quote="", source_location="", rationale="This numerical fixture does not claim a clinical admission judgment.")
    details=item["verification"]
    details.update(endpoint_relation="uncertain", source_endpoint_definition={"quote":"", "source_location":""}, components=[],
        estimand_relation="uncertain", randomized_comparison=None, postrandomization_conditioning=None, selection_timing="uncertain",
        conditioning_variables=[], estimand_support={"quote":"", "source_location":""}, trial_coverage="uncertain", trial_units=[])
    details["numeric_findings"]=[{"field":field,"status":"match","reported_value":value,"quote":source_piece(case,"results_primary_ci"),"source_location":"Results page 5","rationale":"Direct Results CI, rather than a conversion of damaged abstract text."}
        for field,value in [("hazard_ratio",.73),("hr_ci_lower",.53),("hr_ci_upper",1.02)]]
    from endpoint_binding_fixture import bind_components
    item = bind_components(item, text)
    response=ExtractionCheckResult(data_issues=[], score=10, primary_analysis_alignment=[item])
    project, result, calls=run_verifier(tmp_path,monkeypatch,[response,response,response],candidate=candidate,content=text,repair=lambda content,current,*_:current)
    assert len(calls)==3 and all(source_piece(case,"results_primary_ci") in call[0] for call in calls)
    assert result.outcomes[0].primary_analysis_alignment.assessor == "pending-review-v1"
    assert "numeric_value_mismatch" in result.outcomes[0].primary_analysis_alignment.assessment.outcome.rationale
    assert not project.get_path("effect_sizes.json", subdir="analysis").exists()


@pytest.mark.parametrize("overlap", [False, True])
def test_candidate_admission_requires_two_actual_independent_trial_units(tmp_path, overlap):
    import json
    first=study(); first.characteristics.study_id="paperA"
    second=study(); second.characteristics.study_id="paperB"
    second_id="NCT03436693" if overlap else "NCT02065791"
    other_text=SOURCE.replace("NCT03436693",second_id)
    other_assessment=json.loads(json.dumps(checked_row()).replace("NCT03436693",second_id))
    project, phase=select_stamped(tmp_path,[(first,[checked_row()],SOURCE),(second,[other_assessment],other_text)])
    if overlap:
        assert phase.status.value == "needs_input" and phase.error_code == "trial_independence_required"
        assert not project.get_path("effect_sizes.json",subdir="analysis").exists()
        assert all(row["reason"] == "overlapping_trial_units" for row in project.load_json("effect_selection_audit.json",subdir="analysis"))
    else:
        assert phase.status.value == "succeeded" and len(phase.data["effects"])==2


def test_verified_independent_trials_are_not_dropped_by_preprint_or_totals_heuristics(tmp_path):
    import json
    first=study(); first.characteristics.study_id="paperA"
    second=study(); second.characteristics.study_id="paperB"
    second.characteristics.title="Preliminary results of an independent randomized trial"
    for candidate in (first, second):
        candidate.outcomes[0].total_intervention=154; candidate.outcomes[0].total_control=154
    text=SOURCE + " Both arm denominators were 154 patients."
    other=text.replace("NCT03436693","NCT02065791")
    assessments=[]
    for identity, content in [("NCT03436693",text),("NCT02065791",other)]:
        item=json.loads(json.dumps(checked_row()).replace("NCT03436693",identity))
        item["verification"]["numeric_findings"].extend({"field":field,"status":"match","reported_value":154,
            "quote":"Both arm denominators were 154 patients.","source_location":"Methods","rationale":"Reported arm size."}
            for field in ["total_intervention","total_control"])
        assessments.append(item)
    _,phase=select_stamped(tmp_path,[(first,[assessments[0]],text),(second,[assessments[1]],other)])
    assert phase.status.value=="succeeded" and len(phase.data["effects"])==2


@pytest.mark.parametrize("value,field,valid",[(30,"mean_intervention",True),(10,"sd_intervention",True),(10,"mean_intervention",False),(30,"sd_intervention",False),(30,"total_n",False),(10,"hazard_ratio",False)])
def test_labelled_mean_plus_minus_sd_uses_explicit_field_roles(value,field,valid):
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert numeric_value_in_quote(value,"Mean ± SD: 30 ± 10",field) is valid


@pytest.mark.parametrize("expression",["10*100","10×100","10·100","1+2"])
def test_arithmetic_operands_are_not_reported_scalar_counts(expression):
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert not numeric_value_in_quote(10 if expression != "1+2" else 2,f"Total {expression} patients.","total_n")


def test_complete_power_remains_a_number():
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert numeric_value_in_quote(1000,"Total 10**3 patients.","total_n")
    assert not numeric_value_in_quote(10,"Total 10**3 patients.","total_n")


def test_postrandomization_outcome_measurement_does_not_mean_conditioning():
    from new_meta.core.extraction_verification import verification_verdict, validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    text=SOURCE + " Outcomes were measured at year 1 after randomization."
    item=checked_row(); item["outcome"]["quote"]=text
    from endpoint_binding_fixture import bind_components
    item = bind_components(item, text)
    assessment=PrimaryAlignmentAssessment.model_validate(item)
    assert validate_check_batch(study(),[0],[assessment],text,protocol())==[]
    assert verification_verdict(assessment,protocol())["status"]=="match"


@pytest.mark.parametrize("family",["intervention_nrsi","prevalence_incidence"])
def test_nonrandomized_method_applicability_is_not_a_randomized_contrast_failure(family):
    from new_meta.core.extraction_verification import numeric_fields, verification_verdict, validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    current=protocol(); current.review_family=family; current.study_designs=["cohort"]
    candidate=study(); text=SOURCE.replace("were randomized to Drug or placebo in trial NCT03436693", "were observed in a cohort")
    if family=="prevalence_incidence":
        current.effect_measure="PROP";current.primary_outcome_type="proportion"
        current.pico.intervention=current.pico.comparator="Not applicable"
        current.pico.population="Adults"
        current.pico.outcome_primary="Disease prevalence"
        text="Adults were observed in a single-arm prevalence cohort with no intervention comparison. There were 5 cases in 100 participants. The outcome was disease prevalence."
        candidate.outcomes=[OutcomeData(outcome_name="Disease prevalence",outcome_type="proportion",events=5,total_n=100)]
    if family=="intervention_nrsi":
        candidate.outcomes[0].reported_effect_adjusted = True
        candidate.outcomes[0].adjustment_covariates = ["baseline age", "baseline eGFR"]
        current.pico.intervention="Drug exposure";current.pico.comparator="Usual care"
        text=("Adults with CKD were observed in a nonrandomized cohort comparing Drug exposure with usual care. "
              "The renal endpoint was kidney failure, creatinine doubling, or renal death. "
              "The adjusted renal endpoint HR was 0.38 (95% CI 0.12 to 1.22). The model adjusted for baseline age and eGFR.")
    item=checked_row()
    for name in ["outcome","population","contrast"]:item[name]["quote"]=text
    details=item["verification"]
    if family=="prevalence_incidence":
        details["components"]=[{"source_component":"Disease prevalence","protocol_component":"Disease prevalence","relation":"match"}]
    details.update(randomized_comparison=None,postrandomization_conditioning=None,selection_timing="not_applicable",conditioning_variables=[],trial_coverage="not_applicable",trial_units=[],
        source_endpoint_definition={"quote":text,"source_location":"Methods"},estimand_support={"quote":text,"source_location":"Methods"})
    details["numeric_findings"]=[{"field":field,"status":"match","reported_value":value,"quote":text,"source_location":"Results","rationale":"Direct cohort result."} for field,value in numeric_fields(candidate.outcomes[0]).items()]
    from endpoint_binding_fixture import bind_components
    item = bind_components(item, text)
    assessment=PrimaryAlignmentAssessment.model_validate(item)
    assert validate_check_batch(candidate,[0],[assessment],text,current)==[]
    assert verification_verdict(assessment,current)["status"]=="match"


def test_known_numeric_conflict_blocks_even_when_bad_value_occurs_in_abstract():
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import ConflictNote, PrimaryAlignmentAssessment
    candidate=study(); candidate.outcomes[0].hr_ci_upper=.78
    candidate.outcomes[0].conflicts=[ConflictNote(field="hr_ci_upper",message="Abstract and Results disagree",observed_values={"abstract":.78,"results":1.02})]
    text=SOURCE + " Abstract upper CI 0.78. Results upper CI 1.02."
    item=checked_row(); finding=item["verification"]["numeric_findings"][2]
    finding.update(reported_value=.78,quote="Abstract upper CI 0.78.")
    errors=validate_check_batch(candidate,[0],[PrimaryAlignmentAssessment.model_validate(item)],text,protocol())
    assert any(error["code"]=="numeric_conflict_requires_adjudication" for error in errors)


def test_numeric_refinement_cannot_erase_preserved_conflict_notes(monkeypatch):
    from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult, ExtractionRefinement
    from new_meta.schemas.study import ConflictNote
    candidate=study(); candidate.outcomes[0].conflicts=[ConflictNote(field="hr_ci_upper",message="Source disagreement",observed_values={"abstract":.78,"results":1.02})]
    correction=candidate.outcomes[0].model_copy(deep=True); correction.conflicts=[]; correction.hr_ci_upper=1.02
    agent=DataExtractionAgent()
    monkeypatch.setattr(agent,"call_llm_structured",lambda *args,**kwargs:ExtractionRefinement(outcomes=[{"outcome_index":0,"outcome":correction.model_dump(mode="json")}]))
    refined=agent._refine_extraction(SOURCE,candidate,ExtractionCheckResult(data_issues=[], score=9),protocol(),[0],[])
    assert refined.outcomes[0].hr_ci_upper==1.02 and refined.outcomes[0].conflicts==candidate.outcomes[0].conflicts


def test_standardized_effect_is_not_compared_to_unstandardized_mean_difference():
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    candidate=study(); outcome=candidate.outcomes[0]
    outcome.effect_size=.5; outcome.mean_intervention=15; outcome.mean_control=10
    current=protocol(); current.effect_measure="SMD"
    DataExtractionAgent()._flag_internal_conflicts(outcome,current)
    assert outcome.conflicts==[]



def test_baseline_adjusted_md_is_not_an_unadjusted_arithmetic_conflict():
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.extraction_verification import numeric_fields, numeric_conflicts, validate_check_batch, verification_verdict
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    current=protocol();current.effect_measure="MD";current.primary_outcome_type="continuous";current.pico.outcome_primary="Change in blood pressure";current.pico.population="Adults"
    candidate=ExtractedStudy(characteristics=StudyCharacteristics(study_id="ANCOVA"),outcomes=[OutcomeData(
        outcome_name="Change in blood pressure",outcome_type="continuous",reported_effect_measure="MD",effect_size=3,
        mean_intervention=15,mean_control=10,reported_effect_adjusted=True,adjustment_covariates=["baseline blood pressure"])])
    text=("Adults were randomized to Drug or placebo in trial NCT03436693. The outcome was blood pressure change. "
          "Mean changes were 15 and 10; the baseline blood pressure-adjusted ANCOVA mean difference was 3. "
          "All randomized participants contributed and the model adjusted only for baseline blood pressure.")
    DataExtractionAgent()._flag_internal_conflicts(candidate.outcomes[0],current)
    assert numeric_conflicts(candidate.outcomes[0])==[]
    item=checked_row()
    for name in ["outcome","population","contrast"]:item[name]["quote"]=text
    details=item["verification"]
    details["numeric_findings"]=[{"field":field,"status":"match","reported_value":value,"quote":text,"source_location":"Results","rationale":"Direct baseline-adjusted model/arm summary."} for field,value in numeric_fields(candidate.outcomes[0]).items()]
    details["components"]=[{"source_component":"blood pressure change","protocol_component":"Change in blood pressure","relation":"match"}]
    details["source_endpoint_definition"]={"quote":text,"source_location":"Methods"}
    details["estimand_support"]={"quote":text,"source_location":"Methods"}
    details["conditioning_variables"]=[{"name":"baseline blood pressure","timing":"baseline","quote":text,"source_location":"Methods"}]
    details["trial_units"][0]["quote"]=text
    from endpoint_binding_fixture import bind_components
    item = bind_components(item, text)
    assessment=PrimaryAlignmentAssessment.model_validate(item)
    assert validate_check_batch(candidate,[0],[assessment],text,current)==[]
    assert verification_verdict(assessment,current)["status"]=="match"
    candidate.outcomes[0].reported_effect_adjusted=False
    DataExtractionAgent()._flag_internal_conflicts(candidate.outcomes[0],current)
    assert numeric_conflicts(candidate.outcomes[0])



@pytest.mark.parametrize("expression",["p<0.001","<0.001","P ≤ 0.001",">.05","p>=0.05","Ｐ＜0.001"])
def test_p_value_inequalities_never_become_exact_precision(expression):
    from new_meta.schemas.study import OutcomeData
    outcome=OutcomeData(p_value=expression)
    assert outcome.p_value is None and outcome.p_value_inequality==expression


def test_exact_and_absent_p_values_remain_distinct_from_inequalities():
    assert OutcomeData(p_value="P = 0.03").p_value==.03
    assert OutcomeData().p_value is None and OutcomeData().p_value_inequality==""
    assert OutcomeData(p_value=.001,p_value_inequality="p<0.001").p_value is None


def test_bounded_p_cannot_certify_the_scalar_used_by_se_fallback():
    from new_meta.core.extraction_verification import numeric_fields, validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    candidate=study();outcome=candidate.outcomes[0]
    outcome.hr_ci_lower=outcome.hr_ci_upper=None;outcome.p_value=.001
    text=SOURCE + " The study reported p<0.001."
    item=checked_row();item["verification"]["numeric_findings"]=[
        {"field":field,"status":"match","reported_value":value,"quote":text,"source_location":"Results","rationale":"Reported numeric value."}
        for field,value in numeric_fields(outcome).items()]
    errors=validate_check_batch(candidate,[0],[PrimaryAlignmentAssessment.model_validate(item)],text,protocol())
    assert any(error["code"]=="numeric_quote_not_anchored" and error["field"]=="p_value" for error in errors)


# ma-001 (2026-09-28): the checker quoted the right passage for numbers that are
# in it, and the anchoring refused them. The quotes below are from that run.
_DRAIN = ("Total drain output was 185.00 ± 38.92 mL in the TXA group compared to 298.33 ± 62.45 mL "
          "in the control group (P < 0.001), representing a 37.9% reduction ( Table 1 ).")


@pytest.mark.parametrize("value,field,quote", [
    (185.0, "mean_intervention", _DRAIN), (38.92, "sd_intervention", _DRAIN),
    (298.33, "mean_control", _DRAIN), (62.45, "sd_control", _DRAIN),
    (1182.45, "mean_control", "group C (1,182.45 ± 160.50 mL; and 965.47 ± 139.61 mL, respectively)"),
    (160.5, "sd_control", "TBL (mL) | 944.34 ± 130.88 | 995.20 ± 154.00 | 1182.45 ± 160.50 | 0 | 0.196 |"),
    (51.0, "sd_intervention", "Blood loss (mL) 406±36 422±51 494±73 <0.001"),
    (3.45, "sd_intervention", "The proportional hemoglobin loss was 14.19 ± 3.45% in the TXA group"),
])
def test_a_source_that_declares_mean_plus_minus_sd_anchors_unlabelled_pairs(value, field, quote):
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert numeric_value_in_quote(value, quote, field, plus_minus_sd=True)
    assert not numeric_value_in_quote(value, quote, field)  # undeclared: the quote must say it
    other = "sd_control" if field.startswith("mean_") else "mean_control"
    assert not numeric_value_in_quote(value, quote, other, plus_minus_sd=True)  # the other operand's role


@pytest.mark.parametrize("source,declared", [
    ("Blood loss and transfusion among groups (Means ± SD)", True),
    ("Values are expressed as mean ± standard deviation.", True),
    ("计量资料以均数±标准差表示", True),
    ("Data are mean ± SD; biomarkers are mean ± SEM.", False),
    ("Values are mean ± SD. Differences are given ± 95% CI.", False),
    ("Total drain output was 185.00 ± 38.92 mL.", False),
    ("all data expressed as mean (SD)", False),
])
def test_what_plus_minus_reports_is_read_from_the_source_notation(source, declared):
    from new_meta.core.extraction_verification import plus_minus_reports_sd
    assert plus_minus_reports_sd(source) is declared


@pytest.mark.parametrize("value,quote,field,valid", [
    (0, "No patient had clinical signs of deep vein thrombosis or pulmonary embolism.", "events_intervention", True),
    (0, "In our study, there was no patient with thromboembolic events.", "events_control", True),
    (0, "None of the patients developed a wound infection.", "events_control", True),
    (1, "Allogeneic blood transfusion was required for one patient (2%) in the control group.", "events_control", True),
    (0, "Allogeneic blood transfusion was required for one patient (2%) in the control group.", "events_intervention", False),
    (2, "No patient had clinical signs of deep vein thrombosis.", "events_intervention", False),
    (0, "No patient had clinical signs of deep vein thrombosis.", "mean_intervention", False),
    (0, "两组均无深静脉血栓形成。", "events_control", True),
    (2, "对照组两例患者需要输血。", "events_control", True),
    (1, "两组结果一致。", "events_control", False),
    (3, "Known complications occurred.", "events_control", False),
])
def test_an_event_count_written_as_a_word_is_in_the_quote(value, quote, field, valid):
    from new_meta.core.extraction_verification import numeric_value_in_quote
    assert numeric_value_in_quote(value, quote, field) is valid


@pytest.mark.parametrize("expression,source,anchored", [
    ("p<0.001", "Total drain output fell (P < 0.001).", True),
    ("p<0.001", "Total drain output fell (P<.001).", True),
    ("p<0.0001", "The difference was significant (p-value < 0.0001).", True),
    ("p≤0.05", "significant at P <= 0.05", True),
    ("p<0.001", "Total drain output fell (P < 0.01).", False),
    ("p<0.05", "The difference was P = 0.05.", False),
    ("p>0.05", "The difference was P < 0.05.", False),
    ("p<0.001", "Group sizes were 12 (ap < 0.001 as noted).", False),
])
def test_a_p_value_inequality_is_anchored_by_comparator_and_bound(expression, source, anchored):
    from new_meta.core.extraction_verification import p_inequality_is_anchored
    assert p_inequality_is_anchored(expression, source) is anchored


def test_a_finding_about_a_field_that_holds_no_number_is_not_a_coverage_break():
    """ma-001: the checker verified p_value_inequality beside the numeric fields."""
    from new_meta.core.extraction_verification import validate_check_batch
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = checked_row()
    item["verification"]["numeric_findings"].append({
        "field": "p_value_inequality", "status": "match", "reported_value": 0.001, "quote": SOURCE,
        "source_location": "Results", "rationale": "Reported inequality."})
    assert validate_check_batch(study(), [0], [PrimaryAlignmentAssessment.model_validate(item)], SOURCE, protocol()) == []
    item["verification"]["numeric_findings"][-1]["field"] = "no_such_field"
    errors = validate_check_batch(study(), [0], [PrimaryAlignmentAssessment.model_validate(item)], SOURCE, protocol())
    assert any(error["code"] == "numeric_field_coverage" for error in errors)


def test_a_binding_that_restates_its_components_judgment_is_not_a_schema_break():
    """ma-001: two responses repeated relation/protocol_component on a binding."""
    from new_meta.core.extraction_sources import _drop_restated_component_fields
    payload = {"primary_analysis_alignment": [{"verification": {
        "components": [{"protocol_component": "total blood loss", "relation": "match"},
                       {"protocol_component": "drain output", "relation": "extra"}],
        "component_bindings": [
            {"component_index": 0, "relation": "match", "protocol_component": "total blood loss"},
            {"component_index": 1, "relation": "match", "protocol_component": "drain output"}]}}]}
    _drop_restated_component_fields(payload)
    first, second = payload["primary_analysis_alignment"][0]["verification"]["component_bindings"]
    assert first == {"component_index": 0}
    # A binding that says something else than its component is left for the schema to refuse.
    assert second == {"component_index": 1, "relation": "match"}


# A verification finding blocks only the numbers the row's computation reads.
# ma-001 (2026-09-28): one trial's table printed the TBL p-value as a literal
# "0" beside "P < 0.05" in its text; the checker raised a source conflict on
# p_value, and the mean difference computed from the arm means, SDs and sizes -
# which never reads a p-value - was held with it.
def _md_study():
    return ExtractedStudy(characteristics=StudyCharacteristics(study_id="34668331", study_design="RCT"), outcomes=[
        OutcomeData(outcome_name="Total blood loss", outcome_type="continuous",
                    mean_intervention=944.34, sd_intervention=130.88, n_intervention=53,
                    mean_control=1182.45, sd_control=160.5, n_control=53, p_value=0.0,
                    source_quote="TBL (mL) | 944.34 ± 130.88 | 995.20 ± 154.00 | 1182.45 ± 160.50 | 0 |",
                    source_location="Table 2", source_quote_verified=True)])


def _md_protocol():
    return ResearchProtocol(research_question="Tranexamic acid versus placebo for total blood loss",
        pico=PICO(population="TKA", intervention="Tranexamic acid", comparator="Placebo", outcome_primary="Total blood loss"),
        review_family="intervention_rct", primary_outcome_type="continuous", effect_measure="MD")


def test_calculation_fields_are_the_numbers_the_effect_reads():
    from new_meta.core.extraction_verification import calculation_fields
    assert calculation_fields(_md_study().outcomes[0], _md_protocol()) == {
        "mean_intervention", "sd_intervention", "n_intervention", "mean_control", "sd_control", "n_control"}
    hr = study().outcomes[0]; hr.p_value = 0.04
    assert calculation_fields(hr, protocol()) == {"hazard_ratio", "hr_ci_lower", "hr_ci_upper"}
    hr.hr_ci_lower = hr.hr_ci_upper = None
    assert calculation_fields(hr, protocol()) is None  # it computes nothing, so every number counts
    assert calculation_fields(OutcomeData(outcome_name="Renal endpoint", outcome_type="time_to_event"), protocol()) is None


def test_a_finding_about_an_unread_number_is_a_notice_and_a_read_one_still_blocks():
    from new_meta.core.extraction_verification import validate_check_batch, verification_verdict
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = checked_row(); details = item["verification"]
    candidate = study(); candidate.outcomes[0].p_value = 0.0
    details["numeric_status"] = "incorrect"
    details["numeric_findings"].append({"field": "p_value", "status": "mismatch", "reported_value": 0.0, "quote": SOURCE,
                                        "source_location": "Table 3", "rationale": "The table's 0 contradicts the text."})
    assessment = PrimaryAlignmentAssessment.model_validate(item)
    notices = []
    assert validate_check_batch(candidate, [0], [assessment], SOURCE, protocol(), notices=notices) == []
    assert {entry["code"] for entry in notices} == {"numeric_status_unresolved", "numeric_value_mismatch"}
    assert verification_verdict(assessment, protocol(), candidate.outcomes[0])["status"] == "match"
    assert verification_verdict(assessment, protocol())["status"] == "unknown"  # without the row, every number counts
    details["numeric_findings"][0]["status"] = "mismatch"  # the hazard ratio itself
    assessment = PrimaryAlignmentAssessment.model_validate(item)
    assert any(error["code"] == "numeric_value_mismatch" and error["field"] == "hazard_ratio"
               for error in validate_check_batch(candidate, [0], [assessment], SOURCE, protocol()))
    assert verification_verdict(assessment, protocol(), candidate.outcomes[0])["status"] == "unknown"


@pytest.mark.parametrize("field,blocks", [("p_value", False), ("p_value_inequality", False), ("mean_control", True),
                                          ("sd_intervention", True), ("outcome_type", True), ("timepoint", True)])
def test_a_source_row_issue_blocks_only_within_the_calculation(field, blocks):
    from new_meta.core.extraction_verification import blocking_data_issues
    from new_meta.schemas.study import ExtractionDataIssue, ExtractionDataIssueEvidence
    evidence = ExtractionDataIssueEvidence(
        issue=ExtractionDataIssue(outcome_index=0, field=field, kind="source_conflict", rationale="Table and text differ.",
                                  quote="TBL (mL)", source_location="Table 2"),
        field_sha256="0" * 64, row_sha256="0" * 64, protocol_sha256="0" * 64, source_sha256="0" * 64,
        checked_source_sha256="0" * 64)
    assert bool(blocking_data_issues(_md_study().outcomes[0], _md_protocol(), [evidence])) is blocks


def test_a_source_conflict_about_an_unread_p_value_does_not_hold_the_row(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    from new_meta.schemas.study import ExtractionDataIssue
    sentence = "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22)."
    candidate = study(); candidate.outcomes[0].p_value = 0.0
    conflict = ExtractionDataIssue(outcome_index=0, field="p_value", kind="source_conflict", quote=sentence,
                                   source_location="Table 3", rationale="The table's p of 0 contradicts the text.")
    response = ExtractionCheckResult(data_issues=[conflict], score=9, primary_analysis_alignment=[checked_row()])
    project, result, calls = run_verifier(tmp_path, monkeypatch, [response] * 3, candidate=candidate)
    assert len(calls) == 1
    status = alignment_status(project, protocol(), result, 0)
    assert status["status"] == "match"
    assert [item["issue"]["field"] for item in status["unresolved_data_issues"]] == ["p_value"]  # kept, reported

    candidate = study(); candidate.outcomes[0].p_value = 0.0
    conflict = conflict.model_copy(update={"field": "hazard_ratio"})
    response = ExtractionCheckResult(data_issues=[conflict], score=9, primary_analysis_alignment=[checked_row()])
    project, result, calls = run_verifier(tmp_path / "read", monkeypatch, [response] * 3, candidate=candidate)
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


# ma-001 (2026-09-28): none of the eight included TXA trials reported a registry
# ID or a trial name, so no row could prove its trial independent of the others.
def _unregistered(row_id_units=None, coverage="uncertain", role="contributing"):
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    item = checked_row()
    item["verification"]["trial_coverage"] = coverage
    item["verification"]["trial_units"] = [] if role is None else [
        {**item["verification"]["trial_units"][0], "registry_id": "", "trial_name": "", "role": role}]
    return PrimaryAlignmentAssessment.model_validate(item)


def test_unregistered_primary_publications_stand_for_their_trials_only_when_allowed():
    from new_meta.core.extraction_verification import trial_unit_issues
    candidates = [("34668331:0", _unregistered()), ("26894222:1", _unregistered(coverage="complete")),
                  ("21253725:0", _unregistered(role=None))]
    issues = trial_unit_issues(candidates)
    assert {item["row_id"] for item in issues if item["reason"] == "trial_identity_required"} == {
        "34668331:0", "26894222:1", "21253725:0"}
    assumed = []
    units = {"34668331": "34668331", "26894222": "26894222", "21253725": "21253725"}
    assert trial_unit_issues(candidates, publication_units=units, assumed=assumed) == []
    assert assumed == ["34668331:0", "26894222:1", "21253725:0"]


def test_a_publication_stands_for_its_trial_only_without_any_named_or_uncertain_unit():
    from new_meta.core.extraction_verification import trial_unit_issues
    units = {"paperA": "paperA", "paperB": "paperB"}
    # An uncertain unit is the checker saying it cannot tell which trials contribute.
    assert trial_unit_issues([("paperA:0", _unregistered(role="uncertain"))], publication_units=units)
    # A publication outside the allowed set (not a primary publication) keeps the refusal.
    assert trial_unit_issues([("paperC:0", _unregistered())], publication_units=units)
    # A registered trial beside an unregistered publication: both stand.
    assert trial_unit_issues([("paperA:0", _registered()), ("paperB:0", _unregistered())],
                             publication_units=units) == []
    # A name-only unit still cannot be told apart from a registered one.
    named = checked_row(); named["verification"]["trial_units"][0].update(registry_id="", trial_name="CREDENCE")
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    assert trial_unit_issues([("paperA:0", PrimaryAlignmentAssessment.model_validate(named)),
                              ("paperB:0", _unregistered())], publication_units=units)


def _registered():
    from new_meta.schemas.study import PrimaryAlignmentAssessment
    return PrimaryAlignmentAssessment.model_validate(checked_row())


def test_publication_units_exist_only_in_an_unattended_run(tmp_path):
    from new_meta.core.primary_analysis_alignment import UNATTENDED_RUN_FILE, project_publication_units
    from new_meta.core.project import Project
    project = Project("trial identity", output_dir=tmp_path)
    project.save_json("full_text_screening.json", [
        {"paper": {"pmid": "34668331"}, "decision": "include", "publication_role": "primary_publication"},
        {"paper": {"pmid": "11111111"}, "decision": "include", "publication_role": "secondary_publication"},
        {"paper": {"pmid": "22222222"}, "decision": "exclude", "publication_role": "primary_publication"},
    ], subdir="screening")
    assert project_publication_units(project) is None
    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": False})
    assert project_publication_units(project) is None
    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    assert project_publication_units(project) == {"34668331": "34668331"}


def test_pairwise_selection_unattended_leaves_out_an_unverified_row(tmp_path):
    """The pairwise route's version of the same rule: a row with no verified
    match is excluded and named in an unattended run; a person is asked otherwise."""
    import json
    from new_meta.core.primary_analysis_alignment import UNATTENDED_RUN_FILE
    from new_meta.core.pipeline_runner import PipelineRunner
    first = study(); first.characteristics.study_id = "paperA"
    second = study(); second.characteristics.study_id = "paperB"
    third = study(); third.characteristics.study_id = "paperC"
    other_text = SOURCE.replace("NCT03436693", "NCT02065791")
    other_assessment = json.loads(json.dumps(checked_row()).replace("NCT03436693", "NCT02065791"))
    unverified = checked_row(); unverified["population"]["status"] = "uncertain"
    project, phase = select_stamped(tmp_path, [(first, [checked_row()], SOURCE), (second, [other_assessment], other_text),
                                               (third, [unverified], SOURCE.replace("NCT03436693", "NCT01111111"))])
    assert phase.status.value == "needs_input"

    project.save_json(UNATTENDED_RUN_FILE, {"schema_version": 1, "unattended": True})
    studies = [first, second, third]
    rob = project.load_json("rob_results.json", subdir="risk_of_bias")
    from new_meta.schemas.risk_of_bias import StudyRoB
    phase = PipelineRunner(project).run_primary_effect_selection(
        protocol=protocol(), extracted_studies=studies, rob_results=[StudyRoB.model_validate(item) for item in rob])
    assert phase.status.value == "succeeded" and len(phase.data["effects"]) == 2
    audit = {row["row_id"]: row for row in project.load_json("effect_selection_audit.json", subdir="analysis")}
    assert audit["paperC:0"]["decision"] == "excluded" and audit["paperC:0"]["reason"] == "unverified_in_unattended_run"
    warning = next(item for item in project.load_json("pipeline_warnings.json") if item["code"] == "unverified_results_left_out")
    assert list(warning["context"]["results"]) == ["paperC:0"]

