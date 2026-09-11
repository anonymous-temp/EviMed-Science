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
    return ExtractedStudy(characteristics=StudyCharacteristics(study_id="trial-paper"), outcomes=[
        OutcomeData(outcome_name="Renal endpoint", outcome_type="time_to_event", hazard_ratio=0.38,
                    hr_ci_lower=0.12, hr_ci_upper=1.22, reported_effect_measure="HR",
                    source_quote="The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22).", source_location="Table 3", source_quote_verified=True)])


SOURCE = ("Adults with CKD were randomized to Drug or placebo in trial NCT03436693. "
          "The renal endpoint was kidney failure, creatinine doubling, or renal death. "
          "The renal endpoint HR was 0.38 (95% CI 0.12 to 1.22). "
          "The treatment model adjusted only for baseline eGFR and included the randomized cohort.")


def checked_row(index=0):
    return {"outcome_index": index,
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


def run_verifier(tmp_path, monkeypatch, responses, *, candidate=None, content=SOURCE, repair=None):
    import hashlib
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.project import Project
    project = Project("verifier regression", output_dir=tmp_path)
    path = project.base_dir / "papers" / "source.txt"; path.write_text(content)
    agent = DataExtractionAgent(); calls = []
    iterator = iter(responses)
    def check(text, extracted, current_protocol, indices, feedback):
        calls.append((text, list(indices), list(feedback)))
        return next(iterator)
    monkeypatch.setattr(agent, "_check_extraction", check)
    if repair is not None: monkeypatch.setattr(agent, "_refine_extraction", repair)
    result = agent._verify_alignment(candidate or study(), {"fulltext_path": str(path)},
        {"full_text": content, "_source_sha256": hashlib.sha256(content.encode()).hexdigest()}, protocol(), project)
    return project, result, calls


def test_checker_repairs_missing_coverage_before_stamping(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, result, calls = run_verifier(tmp_path, monkeypatch,
        [ExtractionCheckResult(score=10), ExtractionCheckResult(score=9, primary_analysis_alignment=[checked_row()])])
    assert len(calls) == 2 and calls[1][2][0]["code"] == "verification_index_coverage"
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert len(list((project.base_dir / "extraction/verification").glob("*.json"))) == 2


def test_high_score_with_numeric_error_requires_fresh_corrected_verification(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    wrong = study(); wrong.outcomes[0].hr_ci_upper = .78
    checked = ExtractionCheckResult(score=10, issues=["Incorrect upper CI; use the full Results value."], primary_analysis_alignment=[checked_row()])
    good = ExtractionCheckResult(score=10, primary_analysis_alignment=[checked_row()])
    repairs = []
    def repair(content, candidate, response, current_protocol, indices, feedback):
        repairs.append(feedback)
        fixed = candidate.model_copy(deep=True); fixed.outcomes[0].hr_ci_upper = 1.22
        return fixed
    project, result, calls = run_verifier(tmp_path, monkeypatch, [checked, good], candidate=wrong, repair=repair)
    assert len(calls) == 2 and repairs
    assert result.outcomes[0].hr_ci_upper == 1.22
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"


def test_source_middle_is_preserved_and_batch_indices_are_original(tmp_path, monkeypatch):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    content = "Retained introduction. " * 900 + SOURCE + "Retained appendix. " * 1600
    candidate = study(); candidate.outcomes = [candidate.outcomes[0].model_copy(deep=True) for _ in range(5)]
    responses = [ExtractionCheckResult(score=9, primary_analysis_alignment=[checked_row(i) for i in range(4)]),
                 ExtractionCheckResult(score=9, primary_analysis_alignment=[checked_row(4)])]
    project, result, calls = run_verifier(tmp_path, monkeypatch, responses, candidate=candidate, content=content)
    assert all(item[0] == content for item in calls)
    assert [item[1] for item in calls] == [[0, 1, 2, 3], [4]]
    assert all(alignment_status(project, protocol(), result, i)["status"] == "match" for i in range(5))


def test_exhausted_incomplete_verification_has_precise_runtime_reasons(tmp_path, monkeypatch):
    import json
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.primary_analysis_alignment import alignment_status
    project, result, calls = run_verifier(tmp_path, monkeypatch, [ExtractionCheckResult(score=10) for _ in range(3)])
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
    errors = validate_check_batch(candidate, [0], [PrimaryAlignmentAssessment.model_validate(checked_row())], SOURCE, protocol())
    assert any(item["code"] == "numeric_field_coverage" and "p_value" in item["expected"]
               and "covariance_with[another_contrast]" in item["expected"] for item in errors)


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
    responses = iter([json.dumps({"score": 9, "primary_analysis_alignment": [invalid]}),
                      json.dumps({"score": 9, "primary_analysis_alignment": [checked_row()]})])
    calls = []; agent = DataExtractionAgent()
    def fake_call(**kwargs):
        calls.append(kwargs["messages"])
        return next(responses)
    monkeypatch.setattr(agent.llm, "_call", fake_call)
    result = agent._verify_alignment(study(), {"fulltext_path": str(path)},
        {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol(), project)
    assert len(calls) == 2
    assert all(any(SOURCE in message["content"] for message in messages) for messages in calls)
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
    return item


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
    candidate = ExtractedStudy(characteristics=StudyCharacteristics(study_id="35861630", pmid="35861630", title="Japanese phase III trial", authors=["Wada Takashi"], year=2022),
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
    candidate = ExtractedStudy(characteristics=StudyCharacteristics(study_id="39704168", pmid="39704168", title="Reduced CREDENCE analysis", authors=["Ferrannini Ele"], year=2024), outcomes=outcomes)
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
    response=ExtractionCheckResult(score=10, primary_analysis_alignment=[item])
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
    monkeypatch.setattr(agent,"call_llm_structured",lambda *args,**kwargs:ExtractionRefinement(outcomes=[{"outcome_index":0,"outcome":correction}]))
    refined=agent._refine_extraction(SOURCE,candidate,ExtractionCheckResult(score=9),protocol(),[0],[])
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
