"""A stop before the manuscript is the same defect as a gate that blocks delivery.

On 2026-09-28 five of eight production jobs stopped before writing anything:
three planner scope refusals (the question named co-primary outcomes; the
protocol holds one) and two compiled syntheses with one contrast from one
trial. Each cost a restart and one project delivered nothing. The rule now:
refuse only when nothing is decidable (no topic, no records); otherwise
record what differs and continue.
"""
from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.manuscript_facts import build_manuscript_facts, validate_and_repair_manuscript
from new_meta.core.method_executor import InsufficientSynthesisInputs, MethodExecutionBlocked, MethodExecutor
from new_meta.core.pipeline_runner import (
    INSUFFICIENT_STUDIES_CODE,
    PipelineRunner,
    compiled_synthesis_falls_back_to_narrative,
)
from new_meta.core.project import Project
from new_meta.core.protocol_scope import ensure_project_protocol_scope, scope_fields, scope_receipt
from new_meta.engines.complex_rct import run_complex_rct
from new_meta.engines.errors import InsufficientStudiesError
from new_meta.schemas.protocol import ProtocolScopeAssessment, ResearchProtocol

from test_method_executor import _complex_rct_plan, _complex_rct_records
from test_protocol_scope import TOPIC, batch_assessment, proposal, scope_response_mock
from test_unattended_primary_analysis_set import _production_studies, _project

_FIXTURE = Path(__file__).parent / "fixtures" / "ma001_scope_refusals_20260928.json"


def _production_cases():
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


def _assessment(topic, protocol, conflicts):
    by_field = {item["field"]: item for item in conflicts}
    rows = [by_field.get(field) or {
        "field": field, "status": "match", "basis": "not_explicit", "original_quote": topic,
        "rationale": "The independent reviewer finds this field consistent with the original question.",
    } for field in scope_fields(protocol)]
    return ProtocolScopeAssessment.model_validate({"fields": rows})


def _planner(monkeypatch, proposals, changes_for):
    planner = ResearchPlanner()
    queue = iter(proposals)
    current = {}
    calls = []

    def generate(prompt, *args, **kwargs):
        calls.append(prompt)
        current["protocol"] = next(queue)
        return current["protocol"]

    @scope_response_mock
    def independent(messages, *args, **kwargs):
        candidate = current["protocol"]
        return batch_assessment(messages, candidate, changes=changes_for(candidate))

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", independent)
    return planner, calls


@pytest.mark.parametrize("case", _production_cases(), ids=lambda case: case["job"])
def test_the_production_outcome_role_refusals_continue_after_one_feedback_round(monkeypatch, case) -> None:
    """The three 2026-09-28 refusals, replayed: final proposal and the checker's real non-matches."""
    proposal_payload = case["proposal"]
    conflicts = {row["field"]: row for row in case["conflicts"]}
    planner = ResearchPlanner()
    calls = []

    def generate(prompt, *args, **kwargs):
        calls.append(prompt)
        return ResearchProtocol.model_validate(proposal_payload)

    @scope_response_mock
    def independent(messages, *args, **kwargs):
        candidate = ResearchProtocol.model_validate(proposal_payload)
        return batch_assessment(messages, candidate, topic=case["topic"], changes=conflicts)

    monkeypatch.setattr(planner, "call_llm_structured", generate)
    monkeypatch.setattr(planner.llm, "structured_output", independent)
    protocol = planner.run(case["topic"])

    assert len(calls) == 2  # one feedback round, then recorded (it used to be four rounds and a refusal)
    receipt = protocol._scope_receipt
    assert {item["field"] for item in receipt["deviations"]} == set(conflicts)
    assert {item["kind"] for item in receipt["deviations"]} == {"outcome_role"}
    assert receipt["outcome_roles"]["primary"] == protocol.pico.outcome_primary
    assert receipt["outcome_roles"]["secondary"] == list(protocol.pico.outcomes_secondary)


def test_an_added_outcome_the_planner_drops_after_feedback_is_not_a_deviation(monkeypatch) -> None:
    inflated = proposal()
    inflated.pico.outcomes_secondary = ["Unrequested outcome"]
    added = {"status": "mismatch", "basis": "explicit", "rationale": "The question requests no secondary outcome."}
    planner, calls = _planner(monkeypatch, [inflated, proposal()], lambda candidate: (
        {"pico.outcomes_secondary": added, "pico.outcomes_secondary[0]": added}
        if candidate.pico.outcomes_secondary else {}))

    protocol = planner.run(TOPIC)

    assert len(calls) == 2 and "protocol_scope_input_required" in calls[1]
    assert protocol.pico.outcomes_secondary == [] and "deviations" not in protocol._scope_receipt


def test_scope_drift_is_repaired_while_attempts_remain_then_recorded(monkeypatch) -> None:
    from new_meta.config import PLANNER_MAX_ATTEMPTS

    drifted = [proposal() for _ in range(PLANNER_MAX_ATTEMPTS)]
    for candidate in drifted:
        candidate.pico.comparator = "Placebo or active treatments"
    drift = {"pico.comparator": {"status": "mismatch", "basis": "explicit",
                                 "rationale": "The question specifies placebo."}}
    planner, calls = _planner(monkeypatch, drifted, lambda _candidate: drift)

    protocol = planner.run(TOPIC)

    assert len(calls) == PLANNER_MAX_ATTEMPTS
    assert "protocol_scope_input_required" in calls[1]  # feedback while attempts remained
    assert protocol is drifted[-1]
    assert [item["field"] for item in protocol._scope_receipt["deviations"]] == ["pico.comparator"]
    assert protocol._scope_receipt["deviations"][0]["kind"] == "scope"


def test_a_recorded_deviation_is_admitted_once_into_the_run_record(tmp_path) -> None:
    case = _production_cases()[-1]  # 0928d: co-primary blood loss and transfusion
    protocol = ResearchProtocol.model_validate(case["proposal"])
    project = Project(case["topic"], output_dir=tmp_path)
    protocol._scope_receipt = scope_receipt(case["topic"], protocol,
                                            _assessment(case["topic"], protocol, case["conflicts"]), accept_all=True)

    ensure_project_protocol_scope(project, protocol)
    reloaded = ResearchProtocol.model_validate(protocol.model_dump())
    ensure_project_protocol_scope(project, reloaded, allow_recheck=False)  # a resume reads the stored receipt

    warnings = [item for item in project.load_json("pipeline_warnings.json")
                if item["code"] == "protocol_scope_deviation"]
    assert len(warnings) == 1 and warnings[0]["stage"] == "protocol"
    assert warnings[0]["context"]["fields"] == ["primary_outcome_type"]
    assert "Primary outcome analysed" in warnings[0]["message"]
    assert project.load_json("protocol_scope.json", subdir="analysis")["deviations"][0]["kind"] == "outcome_role"


def test_the_manuscript_states_the_deviation_at_the_end_of_methods(tmp_path) -> None:
    case = _production_cases()[0]  # 0928c: transfusion and VTE listed as primary and safety outcomes
    protocol = ResearchProtocol.model_validate(case["proposal"])
    project = Project(case["topic"], output_dir=tmp_path)
    protocol._scope_receipt = scope_receipt(case["topic"], protocol,
                                            _assessment(case["topic"], protocol, case["conflicts"]), accept_all=True)
    ensure_project_protocol_scope(project, protocol)
    facts = build_manuscript_facts(protocol=protocol, project=project)
    facts["output_language"] = "zh"
    draft = "# 标题\n\n## 方法\n\n检索与筛选。\n\n## 结果\n\n结果。\n"

    written, validation = validate_and_repair_manuscript(draft, facts)
    again, _ = validate_and_repair_manuscript(written, facts)

    methods, results = written.split("## 结果", 1)
    assert "### 方案偏离" in methods and protocol.pico.outcome_primary in methods
    assert all(outcome in methods for outcome in protocol.pico.outcomes_secondary)
    assert again.count("### 方案偏离") == 1
    assert any(issue["kind"] == "protocol_deviation_note" for issue in validation["issues"])


def test_one_contrast_from_one_trial_is_insufficient_evidence_not_a_stop() -> None:
    with pytest.raises(InsufficientStudiesError):
        run_complex_rct(_complex_rct_records()[:1])
    with pytest.raises(InsufficientSynthesisInputs):
        MethodExecutor().execute(_complex_rct_plan(), records=_complex_rct_records()[:1])
    assert issubclass(InsufficientSynthesisInputs, MethodExecutionBlocked)


def test_the_production_single_trial_synthesis_is_answered_with_the_narrative_report(tmp_path) -> None:
    project, _ = _project(tmp_path, _production_studies()[1:2], unattended=True)  # ma-001, 39673144 alone
    phase = PipelineRunner(project).run_compiled_method_synthesis()

    assert phase.error_code == INSUFFICIENT_STUDIES_CODE
    assert compiled_synthesis_falls_back_to_narrative(phase, unattended=True)
    assert compiled_synthesis_falls_back_to_narrative(phase, unattended=False)


def test_nothing_verified_is_an_evidence_gap_only_when_nobody_can_adjudicate() -> None:
    class Phase:
        error_code = "verified_method_inputs_required"

    assert compiled_synthesis_falls_back_to_narrative(Phase(), unattended=True)
    assert not compiled_synthesis_falls_back_to_narrative(Phase(), unattended=False)
    Phase.error_code = "method_execution_blocked"  # an integrity failure is not evidence
    assert not compiled_synthesis_falls_back_to_narrative(Phase(), unattended=True)


def test_the_compiled_route_writes_the_narrative_report_before_it_could_stop() -> None:
    from new_meta.main import main

    source = inspect.getsource(main)
    branch = source[source.index("method_delivery = run_method_delivery("):source.index("# Step 10: Effect Size")]
    fallback = branch.index("compiled_synthesis_falls_back_to_narrative(")
    assert fallback < branch.index("_write_narrative_manuscript_from_artifacts(") < branch.index(
        "_require_cli_method_delivery(project, method_delivery.phase)")
