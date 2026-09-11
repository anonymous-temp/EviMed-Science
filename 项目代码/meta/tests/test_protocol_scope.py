
import json
from functools import wraps

import pytest

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.llm import LLMOutputError
from new_meta.core.project import Project
from new_meta.core.protocol_scope import ensure_project_protocol_scope, scope_fields, scope_receipt
from new_meta.schemas.protocol import PICO, ResearchProtocol, ProtocolScopeAssessment, ProtocolScopeReferenceAssessment

TOPIC = "SGLT2 inhibitors versus placebo for chronic kidney disease progression; write the manuscript in English."


def proposal():
    return ResearchProtocol(research_question=TOPIC, pico=PICO(population="Chronic kidney disease",
        intervention="SGLT2 inhibitors", comparator="Placebo", outcome_primary="Kidney disease progression"),
        study_designs=["parallel_rct"], review_family="intervention_rct", effect_measure="HR",
        primary_outcome_type="time_to_event", inclusion_criteria=["Randomized assigned-arm comparisons"],
        language="No language restriction")


def assessment(protocol, *, topic=TOPIC, changes=None):
    rows = [{"field": field, "status": "match", "basis": "not_explicit", "original_quote": topic,
             "rationale": "The independent reviewer finds this field consistent with the original question."}
            for field in scope_fields(protocol)]
    for row in rows:
        row.update((changes or {}).get(row["field"], {}))
    return ProtocolScopeAssessment.model_validate({"fields": rows})


def batch_assessment(messages, protocol, **kwargs):
    fields = json.loads(messages[1]["content"].split(
        "Assess only the following batch fields exactly once:\n", 1)[1].split("\n\n", 1)[0])
    reviewed = assessment(protocol, **kwargs)
    sources = json.loads(messages[1]["content"].split(
        "Original source catalogue (exact runtime slices):\n", 1)[1].split("\n\n", 1)[0])
    return ProtocolScopeReferenceAssessment(fields=[{
        **row.model_dump(exclude={"original_quote"}), "source_id": sources[0]["source_id"],
    } for row in reviewed.fields if row.field in fields])


def scope_response_mock(response_fn):
    """Give isolated controller tests explicit synthetic provider observations.

    The source-faithful integration suite separately mocks only SDK create calls.
    Production code must never infer an observation from a final typed result.
    """
    @wraps(response_fn)
    def respond(*args, **kwargs):
        result = response_fn(*args, **kwargs)
        observe = kwargs.get("on_raw_response")
        if observe is not None:
            raw = result.model_dump_json() if hasattr(result, "model_dump_json") else json.dumps(result)
            try:
                observe({"content": raw, "finish_reason": "stop", "provider_response_ordinal": 1})
            except Exception as exc:
                raise LLMOutputError("Synthetic provider observer failed") from exc
        return result
    return respond


@pytest.mark.parametrize("field,value", [
    ("pico.comparator", "Placebo or active treatments"),
    ("pico.population", "All adults including those without kidney disease"),
    ("inclusion_criteria", ["Full-text publications in English only"]),
    ("language", "English only"),
    ("date_range", "Inception to December 2024"),
])
def test_independent_scope_rejects_material_drift(field, value, monkeypatch):
    protocol = proposal()
    target = protocol.pico if field.startswith("pico.") else protocol
    setattr(target, field.split(".")[-1], value)
    planner = ResearchPlanner()
    calls = []
    @scope_response_mock
    def check(messages, schema, **kwargs):
        calls.append(messages)
        return batch_assessment(messages, protocol, changes={field: {"status": "mismatch", "basis": "explicit",
            "rationale": "The candidate broadens or invents an explicit eligibility constraint."}})
    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired, match="preserve"):
        planner.check_scope(TOPIC, protocol)
    assert TOPIC in calls[0][1]["content"]
    assert "No language restriction" in calls[0][1]["content"] or field == "language"


@pytest.mark.parametrize("damage", ["missing", "duplicate", "forged_quote", "uncertain", "blank_rationale"])
def test_incomplete_or_unanchored_scope_never_matches(damage):
    protocol = proposal()
    result = assessment(protocol).model_dump()
    if damage == "missing": result["fields"].pop()
    if damage == "duplicate": result["fields"].append(result["fields"][0])
    if damage == "forged_quote": result["fields"][0]["original_quote"] = "SGLT2 inhibitors versus active treatments"
    if damage == "uncertain": result["fields"][0]["status"] = "uncertain"
    if damage == "blank_rationale": result["fields"][0]["rationale"] = "  "
    with pytest.raises(ValueError):
        scope_receipt(TOPIC, protocol, result)


def test_scope_cache_requires_original_topic_and_exact_current_proposal(tmp_path, monkeypatch):
    protocol = proposal()
    project = Project(TOPIC, output_dir=tmp_path)
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    ensure_project_protocol_scope(project, protocol)
    loaded = ResearchProtocol.model_validate(protocol.model_dump())
    class Reviewer:
        def check_scope(self, topic, candidate):
            assert topic == TOPIC  # Never the generated research_question or resume label.
            raise ProtocolInputRequired("scope changed", protocol=candidate)
    loaded.pico.comparator = "Active treatments"
    with pytest.raises(ProtocolInputRequired, match="scope changed"):
        ensure_project_protocol_scope(project, loaded, planner=Reviewer())
    assert project.load_json("protocol_input_status.json", subdir="analysis")["status"] == "needs_input"


def test_scope_missing_original_cannot_use_generated_question(tmp_path):
    project = Project(TOPIC, output_dir=tmp_path)
    (project.base_dir / project.TOPIC_FILE).unlink()
    with pytest.raises(ProtocolInputRequired, match="original project question"):
        ensure_project_protocol_scope(project, proposal())


def test_planner_repairs_known_design_label_then_independently_checks_scope(monkeypatch):
    planner = ResearchPlanner()
    invalid = proposal(); invalid.study_designs = ["secondary_analysis_of_rcts"]
    corrected = proposal()
    responses = iter([invalid, corrected]); prompts = []
    def generate(prompt, *args, **kwargs):
        prompts.append(prompt)
        return next(responses)
    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda messages, *args, **kwargs: batch_assessment(messages, corrected)))
    result = planner.run(TOPIC)
    assert result.study_designs == ["parallel_rct"]
    assert "secondary_analysis_of_rcts" in prompts[1]
    assert "Never drop unsupported requested designs" in prompts[1]
    assert result._scope_receipt["assessor"] == "independent_protocol_scope_sources_v1"


def test_repeated_unsupported_proposal_is_preserved_not_executable(monkeypatch):
    planner = ResearchPlanner(); invalid = proposal(); invalid.study_designs = ["RCT", "non randomized controlled trial"]
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: invalid.model_copy(deep=True))
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.run(TOPIC)
    assert "non randomized controlled trial" in caught.value.phase.data["proposal"]["study_designs"]


def test_read_only_retry_preserves_all_protocol_fields():
    from new_meta.main import _broaden_protocol_for_retry
    protocol = proposal(); before = protocol.model_dump()
    _broaden_protocol_for_retry(protocol)
    assert protocol.model_dump() == before


def test_refinement_without_original_cannot_elevate_generated_question():
    with pytest.raises(ProtocolInputRequired, match="original question"):
        ResearchPlanner().refine(proposal(), "broaden the comparison")


@pytest.mark.parametrize("topic,quote,valid", [
    ("研究对象为慢性肾脏病患者，比较达格列净与安慰剂的疗效。", "安慰剂", True),
    ("研究250毫克每日一次与安慰剂的疗效。", "50毫克", False),
    ("研究250毫克每日一次与安慰剂的疗效。", "250毫克", True),
    ("Compare 250 mg daily with placebo.", "50 mg", False),
])
def test_original_quote_supports_continuous_scripts_without_numeric_clipping(topic, quote, valid):
    protocol = proposal()
    result = assessment(protocol, topic=topic).model_dump()
    result["fields"][0]["original_quote"] = quote
    result["fields"][0]["basis"] = "explicit"
    if valid:
        assert scope_receipt(topic, protocol, result)["assessor"]
    else:
        with pytest.raises(ValueError): scope_receipt(topic, protocol, result)


def test_cli_admission_persists_real_block_and_never_checkpoints_invalid_proposal(tmp_path):
    from new_meta.main import _admit_cli_protocol
    from new_meta.core.release_contract import ReleaseBlockedError
    project = Project(TOPIC, output_dir=tmp_path)
    protocol = proposal(); protocol.study_designs = ["secondary_analysis_of_rcts"]
    with pytest.raises(ReleaseBlockedError):
        _admit_cli_protocol(project, protocol, enforce=True)
    decision = project.load_json("release_decision.json", subdir="package")
    assert decision["status"] == "blocked"
    assert decision["ready_for_submission"] is False
    assert not project.is_step_done("protocol")
    assert project.load_json("protocol_rejected_proposal.json", subdir="analysis")["proposal"]["study_designs"] == ["secondary_analysis_of_rcts"]


@pytest.mark.parametrize("entry", ["_run_phase1_sync", "_run_pipeline_sync"])
def test_web_unsupported_planning_stops_before_search(monkeypatch, tmp_path, entry):
    import start
    protocol = proposal(); protocol.study_designs = ["secondary_analysis_of_rcts"]
    monkeypatch.setattr(ResearchPlanner, "run", lambda self, topic: protocol)
    def no_search(*args, **kwargs): raise AssertionError("Invalid proposal reached search")
    monkeypatch.setattr("new_meta.agents.query_builder.QueryBuilder.run", no_search)
    events = []
    getattr(start, entry)(TOPIC, str(tmp_path), lambda kind, data: events.append((kind, data)))
    assert events[-1][0] == "method_decision_required"
    assert events[-1][1]["phase"]["status"] == "needs_input"
    assert not any(kind in {"phase1_done", "done", "error"} for kind, _ in events)


def test_web_internal_planner_error_stays_failed(monkeypatch, tmp_path):
    import start
    def fail(*args, **kwargs): raise RuntimeError("provider connection fault")
    monkeypatch.setattr(ResearchPlanner, "run", fail)
    events=[]
    with pytest.raises(RuntimeError, match="provider connection fault"):
        start._run_phase1_sync(TOPIC, str(tmp_path), lambda *event: events.append(event))
    assert events[-1] == ("error", "provider connection fault")



def test_not_explicit_requires_the_full_original_question():
    protocol = proposal()
    result = assessment(protocol).model_dump()
    result["fields"][0]["original_quote"] = "SGLT2 inhibitors"
    with pytest.raises(ValueError, match="full original question"):
        scope_receipt(TOPIC, protocol, result)


def test_scope_inventory_covers_operational_fields_and_each_treatment():
    protocol = proposal(); protocol.interventions = ["Drug A", "Drug B"]
    fields = scope_fields(protocol)
    assert {"analysis_type", "review_family", "effect_measure", "primary_outcome_type", "interventions", "interventions[0]", "interventions[1]"} <= set(fields)


def test_scope_rejects_proposal_mutation_during_check(monkeypatch):
    planner = ResearchPlanner(); protocol = proposal()
    reviewed = assessment(protocol)
    @scope_response_mock
    def response(*args, **kwargs):
        protocol.pico.comparator = "Active treatment"
        return reviewed
    monkeypatch.setattr(planner.llm, "structured_output", response)
    with pytest.raises(ProtocolInputRequired, match="changed during"):
        planner.check_scope(TOPIC, protocol)



def test_missing_original_stays_missing_after_reopening_with_checkpoints(tmp_path):
    from new_meta.core.protocol_scope import original_project_topic
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_checkpoint("protocol")
    (project.base_dir / project.TOPIC_FILE).unlink()
    reopened = Project("generated replacement question", resume_dir=project.base_dir)
    assert not (reopened.base_dir / reopened.TOPIC_FILE).exists()
    with pytest.raises(ProtocolInputRequired, match="original project question"):
        original_project_topic(reopened)


def test_cli_missing_original_blocks_before_reading_resume_checkpoint(tmp_path, monkeypatch):
    import sys
    from new_meta.main import main
    from new_meta.core.release_contract import ReleaseBlockedError
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_checkpoint("protocol")
    (project.base_dir / project.TOPIC_FILE).unlink()
    monkeypatch.setattr(sys, "argv", ["meta", "--topic", "generated replacement question", "--resume", str(project.base_dir)])
    with pytest.raises(ReleaseBlockedError): main()
    decision = project.load_json("release_decision.json", subdir="package")
    assert "protocol_scope_original_missing" in decision["blocker_codes"]


def test_scope_receipt_symlink_does_not_overwrite_outside_file(tmp_path):
    protocol = proposal(); project = Project(TOPIC, output_dir=tmp_path)
    outside = tmp_path / "outside.json"; outside.write_text("preserve outside")
    target = project.base_dir / "analysis" / "protocol_scope.json"
    target.symlink_to(outside)
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    with pytest.raises(ProtocolInputRequired):
        ensure_project_protocol_scope(project, protocol, allow_recheck=False)
    assert target.is_symlink() and outside.read_text() == "preserve outside"
    calls = []
    class Reviewer:
        def check_scope(self, topic, candidate):
            calls.append(topic)
            return scope_receipt(topic, candidate, assessment(candidate, topic=topic))
    ensure_project_protocol_scope(project, protocol, planner=Reviewer())
    assert calls == [TOPIC]
    assert outside.read_text() == "preserve outside"
    assert not target.is_symlink()


@pytest.mark.parametrize("operation", ["receipt", "diagnostic"])
def test_scope_writes_refuse_symlinked_analysis_parent(tmp_path, operation):
    protocol = proposal(); project = Project(TOPIC, output_dir=tmp_path)
    outside = tmp_path / "outside"; outside.mkdir()
    folder = project.base_dir / "analysis"; folder.rmdir(); folder.symlink_to(outside, target_is_directory=True)
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    class Reviewer:
        def check_scope(self, topic, candidate):
            return scope_receipt(topic, candidate, assessment(candidate, topic=topic))
    with pytest.raises(OSError):
        if operation == "receipt": ensure_project_protocol_scope(project, protocol, planner=Reviewer())
        else: ProtocolInputRequired("unsupported", protocol=protocol, project=project)
    assert list(outside.iterdir()) == []


def test_successful_admission_resolves_only_protocol_input_status(tmp_path):
    from new_meta.core.method_planning import admit_project_protocol
    project = Project(TOPIC, output_dir=tmp_path); protocol = proposal()
    ProtocolInputRequired("old unsupported input", protocol=protocol, project=project)
    project.save_json("primary_alignment_status.json", {"status": "needs_input"}, subdir="analysis")
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    admit_project_protocol(project, protocol, enforce=True)
    assert project.load_json("protocol_input_status.json", subdir="analysis")["status"] == "succeeded"
    assert project.load_json("primary_alignment_status.json", subdir="analysis")["status"] == "needs_input"
    assert project.load_json("protocol_rejected_proposal.json", subdir="analysis")["proposal"]


def test_review_refresh_cannot_repackage_missing_original_scope(tmp_path, monkeypatch):
    import start
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_json("protocol.json", proposal())
    package = project.get_path("metaagent_export.zip", subdir="package"); package.write_bytes(b"prior artifact")
    result = start._refresh_review_decision_artifacts(project)
    assert result["artifacts_refreshed"] is False
    assert result["execution"]["error_code"] == "protocol_scope_unverified"
    assert package.read_bytes() == b"prior artifact"



def test_reconciled_design_cannot_change_explicit_scope_even_without_numeric_pool(tmp_path, monkeypatch):
    from new_meta.main import _admit_cli_protocol
    from new_meta.core.llm import LLMClient
    from new_meta.core.release_contract import ReleaseBlockedError
    topic = TOPIC + " Include only individually randomized parallel-group trials."
    project = Project(topic, output_dir=tmp_path); protocol = proposal()
    protocol._scope_receipt = scope_receipt(topic, protocol, assessment(protocol, topic=topic))
    ensure_project_protocol_scope(project, protocol)
    protocol.study_designs = ["cluster_rct"]; protocol.study_design = "cluster_rct"
    checked = assessment(protocol, topic=topic, changes={"study_designs": {
        "status": "mismatch", "basis": "explicit", "rationale": "Detected cluster design is outside the original individual-randomization scope."}})
    monkeypatch.setattr(LLMClient, "structured_output", scope_response_mock(lambda self, messages, *args, **kwargs:
                        batch_assessment(messages, protocol, topic=topic, changes={row.field: row.model_dump() for row in checked.fields})))
    with pytest.raises(ReleaseBlockedError):
        _admit_cli_protocol(project, protocol, enforce=True)
    assert not project.get_path("meta_results.json", subdir="analysis").exists()
    assert project.load_json("protocol_input_status.json", subdir="analysis")["error_code"] == "protocol_scope_input_required"


def test_narrative_branch_readmits_after_extraction_before_authoring():
    import inspect
    from new_meta.main import main
    source = inspect.getsource(main)
    branch = source[source.index("if len(included_papers) < 2"):source.index("# Step 8:")]
    assert branch.index("extractor.run(") < branch.index("_admit_cli_protocol(") < branch.index("_write_narrative_manuscript_from_artifacts(")



def test_existing_planner_loop_repairs_scope_drift_against_original_not_feedback(monkeypatch):
    planner = ResearchPlanner(); broad = proposal(); broad.pico.comparator = "Placebo or active treatments"
    corrected = proposal(); candidates = iter([broad, corrected]); current = {}; calls = []
    def generate(prompt, *args, **kwargs):
        calls.append(prompt); current["protocol"] = next(candidates)
        return current["protocol"]
    @scope_response_mock
    def independent(messages, *args, **kwargs):
        candidate = current["protocol"]
        assert TOPIC in messages[1]["content"]
        changes = {"pico.comparator": {"status": "mismatch", "basis": "explicit",
                   "rationale": "The original question specifies placebo, not active comparators."}} if candidate is broad else {}
        return batch_assessment(messages, candidate, changes=changes)
    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", independent)
    result = planner.run(TOPIC)
    assert result.pico.comparator == "Placebo"
    assert len(calls) == 2 and "Validation feedback (not new user intent)" in calls[1]
    assert "protocol_scope_input_required" in calls[1]


def test_explicit_publication_language_requirement_is_preserved(monkeypatch):
    planner = ResearchPlanner(); protocol = proposal(); protocol.language = "English only"
    protocol.inclusion_criteria = ["English-language publications only"]
    topic = "SGLT2 inhibitors versus placebo for kidney disease progression; include English-language publications only."
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: protocol)
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda messages, *args, **kwargs: batch_assessment(messages, protocol, topic=topic)))
    result = planner.run(topic)
    assert result.language == "English only"
    assert result.inclusion_criteria == ["English-language publications only"]


def test_model_cannot_supply_runtime_scope_receipt():
    payload = proposal().model_dump()
    payload["_scope_receipt"] = {"assessor": "independent_protocol_scope_v1", "status": "match"}
    assert ResearchProtocol.model_validate(payload)._scope_receipt == {}
    assert "_scope_receipt" not in ResearchProtocol.model_json_schema()["properties"]
