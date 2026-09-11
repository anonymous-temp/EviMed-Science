"""Exact original-source references preserve the existing quote-based scope gate."""
import json
from copy import deepcopy
from pathlib import Path

import pytest

from new_meta.agents.research_planner import ResearchPlanner
from new_meta.core.method_planning import ProtocolInputRequired
from new_meta.core.primary_analysis_alignment import digest
from new_meta.core.project import Project
from new_meta.core.protocol_scope import ensure_project_protocol_scope, scope_fields, scope_receipt
from new_meta.core.protocol_scope_sources import (
    SOURCE_ASSESSOR, source_catalogue, evaluate_scope_references, replay_scope_sources, scope_source_provenance,
)
from new_meta.schemas.protocol import ProtocolScopeReferenceAssessment, ResearchProtocol
from tests.test_protocol_scope import TOPIC, assessment, batch_assessment, proposal, scope_response_mock


def reference_rows(catalogue, fields, *, source=None, status="match", basis="not_explicit"):
    return ProtocolScopeReferenceAssessment(fields=[{
        "field": field, "status": status, "basis": basis,
        "source_id": (source or catalogue["sources"][0])["source_id"],
        "rationale": "Independent reviewer assessed this field against the original request.",
    } for field in fields])


def test_catalogue_slices_are_exact_unicode_and_repeated_paragraphs_are_distinct():
    topic = "  慢性肾脏病🙂\r\n第二行。\r\n\r\n重复段落。\n\n重复段落。\n"
    catalogue = source_catalogue(topic, proposal())
    assert catalogue["offset_unit"] == "unicode_codepoints"
    assert catalogue["sources"][0]["kind"] == "question"
    slices = [topic[row["start"]:row["end"]] for row in catalogue["sources"]]
    assert slices == [topic, "  慢性肾脏病🙂\r\n第二行。", "重复段落。", "重复段落。\n"]
    assert len({row["source_id"] for row in catalogue["sources"]}) == len(slices)
    assert source_catalogue(topic, proposal()) == catalogue


def test_identical_paragraph_text_is_bound_to_its_distinct_raw_location():
    catalogue = source_catalogue("重复段落。\n\n重复段落。", proposal())
    first, second = catalogue["sources"][1:]
    assert first["text_sha256"] == second["text_sha256"]
    assert first["source_id"] != second["source_id"] and first["start"] != second["start"]


@pytest.mark.parametrize("damage", ["unknown", "different_question", "different_proposal", "paragraph_absence"])
def test_invalid_source_ids_cannot_resolve_to_approved_evidence(damage):
    protocol = proposal()
    topic = TOPIC + "\n\nReport the limits."
    catalogue = source_catalogue(topic, protocol)
    result = reference_rows(catalogue, ["pico.comparator"])
    if damage == "unknown": result.fields[0].source_id = "unknown-source"
    if damage == "different_question":
        result.fields[0].source_id = source_catalogue(topic + " Changed.", protocol)["sources"][0]["source_id"]
    if damage == "different_proposal":
        changed = protocol.model_copy(deep=True); changed.pico.comparator = "Active treatments"
        result.fields[0].source_id = source_catalogue(topic, changed)["sources"][0]["source_id"]
    if damage == "paragraph_absence": result.fields[0].source_id = catalogue["sources"][1]["source_id"]
    evaluated = evaluate_scope_references(topic, catalogue, result, ["pico.comparator"])
    assert evaluated.reason is not None and evaluated.resolved.fields == []


def test_catalogue_for_a_different_raw_topic_cannot_be_reused_by_the_resolver():
    catalogue = source_catalogue(TOPIC, proposal())
    result = reference_rows(catalogue, ["pico.comparator"])
    evaluated = evaluate_scope_references("placebo", catalogue, result, ["pico.comparator"])
    assert evaluated.reason["code"] == "scope_source_catalogue_mismatch"
    assert evaluated.resolved.fields == []


def test_id_resolution_keeps_status_basis_and_rationale_and_uses_full_exact_slice():
    protocol = proposal()
    topic = "研究慢性肾脏病🙂。\n\nCompare placebo."
    catalogue = source_catalogue(topic, protocol)
    result = reference_rows(catalogue, ["pico.population"], source=catalogue["sources"][1], basis="explicit", status="uncertain")
    evaluated = evaluate_scope_references(topic, catalogue, result, ["pico.population"])
    assert evaluated.reason is None
    assert evaluated.resolved.fields[0].model_dump() == {
        "field": "pico.population", "status": "uncertain", "basis": "explicit",
        "original_quote": "研究慢性肾脏病🙂。", "rationale": result.fields[0].rationale,
    }


def test_legacy_quote_validation_still_rejects_missing_chronic_and_partial_absence():
    protocol = proposal()
    topic = "Include chronic kidney disease only."
    result = assessment(protocol, topic=topic).model_dump()
    result["fields"][0].update(basis="explicit", original_quote="Include kidney disease only.")
    with pytest.raises(ValueError): scope_receipt(topic, protocol, result)
    result["fields"][0].update(basis="not_explicit", original_quote="chronic kidney disease")
    with pytest.raises(ValueError): scope_receipt(topic, protocol, result)


def id_receipt(monkeypatch, *, topic=TOPIC, protocol=None):
    protocol = protocol or proposal()
    planner = ResearchPlanner()
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda messages, *args, **kwargs:
                        batch_assessment(messages, protocol, topic=topic)))
    return protocol, planner.check_scope(topic, protocol)


def test_receipt_separates_actual_id_response_from_resolved_evidence_and_replays(monkeypatch, tmp_path):
    protocol, receipt = id_receipt(monkeypatch)
    assert receipt["schema_version"] == 1 and receipt["assessor"] == SOURCE_ASSESSOR
    provenance = receipt["source_provenance"]
    assert set(provenance["field_origins"]) == set(scope_fields(protocol))
    for record in provenance["responses"]:
        assert record["response_sha256"] == digest(record["response"])
        assert all("source_id" in row and "original_quote" not in row for row in record["response"]["fields"])
    assert all("original_quote" in row and "source_id" not in row for row in receipt["assessment"]["fields"])
    assert replay_scope_sources(TOPIC, protocol, provenance).model_dump(mode="json") == receipt["assessment"]
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_json("protocol_scope.json", receipt, subdir="analysis")
    cached = ensure_project_protocol_scope(project, protocol, allow_recheck=False)
    assert cached == receipt and protocol._scope_receipt == receipt
    assert project.load_json("protocol_scope.json", subdir="analysis") == receipt


@pytest.mark.parametrize("damage", ["missing", "null", "catalogue", "catalogue_hash", "raw_source", "raw_rationale",
                                   "response_hash", "missing_response", "extra_response", "origin", "missing_origin",
                                   "resolved_quote", "resolved_status"])
def test_invalid_new_provenance_forces_recheck_even_with_a_valid_legacy_disk_cache(monkeypatch, tmp_path, damage):
    protocol, good = id_receipt(monkeypatch)
    broken = deepcopy(good)
    provenance = broken["source_provenance"]
    if damage == "missing": broken.pop("source_provenance")
    if damage == "null": broken["source_provenance"] = None
    if damage == "catalogue": provenance["catalogue"]["sources"][0]["start"] = 1
    if damage == "catalogue_hash": provenance["catalogue_sha256"] = "bad-hash"
    if damage in {"raw_source", "raw_rationale"}:
        record = provenance["responses"][0]
        record["response"]["fields"][0]["source_id" if damage == "raw_source" else "rationale"] = "changed"
        record["response_sha256"] = digest(record["response"])
    if damage == "response_hash": provenance["responses"][0]["response_sha256"] = "bad-hash"
    if damage == "missing_response": provenance["responses"].pop()
    if damage == "extra_response": provenance["responses"].append(deepcopy(provenance["responses"][-1]))
    if damage == "origin": provenance["field_origins"]["pico.comparator"]["attempt"] = 2
    if damage == "missing_origin": provenance["field_origins"].pop("pico.comparator")
    if damage == "resolved_quote": broken["assessment"]["fields"][0]["original_quote"] = "placebo"
    if damage == "resolved_status": broken["assessment"]["fields"][0]["status"] = "mismatch"
    project = Project(TOPIC, output_dir=tmp_path)
    legacy = scope_receipt(TOPIC, protocol, assessment(protocol))
    project.save_json("protocol_scope.json", legacy, subdir="analysis")
    protocol._scope_receipt = broken
    with pytest.raises(ProtocolInputRequired, match="lacks a matching"):
        ensure_project_protocol_scope(project, protocol, allow_recheck=False)
    calls = []

    class Reviewer:
        def check_scope(self, topic, candidate):
            calls.append((topic, candidate.model_dump()))
            return good

    assert ensure_project_protocol_scope(project, protocol, planner=Reviewer()) == good
    assert len(calls) == 1


def test_present_invalid_provenance_under_legacy_marker_does_not_downgrade(monkeypatch, tmp_path):
    protocol, receipt = id_receipt(monkeypatch)
    receipt["assessor"] = "independent_protocol_scope_v1"
    receipt["source_provenance"]["responses"].pop()
    project = Project(TOPIC, output_dir=tmp_path)
    protocol._scope_receipt = receipt
    with pytest.raises(ProtocolInputRequired):
        ensure_project_protocol_scope(project, protocol, allow_recheck=False)


def test_valid_legacy_memory_cannot_hide_invalid_source_provenance_on_disk(monkeypatch, tmp_path):
    protocol, good = id_receipt(monkeypatch)
    broken = deepcopy(good)
    broken["source_provenance"]["responses"].pop()
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_json("protocol_scope.json", broken, subdir="analysis")
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    with pytest.raises(ProtocolInputRequired, match="lacks a matching"):
        ensure_project_protocol_scope(project, protocol, allow_recheck=False)
    assert project.load_json("protocol_scope.json", subdir="analysis") == broken


def test_valid_source_provenance_on_disk_is_preserved_over_legacy_memory(monkeypatch, tmp_path):
    protocol, receipt = id_receipt(monkeypatch)
    project = Project(TOPIC, output_dir=tmp_path)
    project.save_json("protocol_scope.json", receipt, subdir="analysis")
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    assert ensure_project_protocol_scope(project, protocol, allow_recheck=False) == receipt
    assert project.load_json("protocol_scope.json", subdir="analysis") == receipt


@pytest.mark.parametrize("memory_kind", ["legacy", "source"])
@pytest.mark.parametrize("damage", ["truncated", "permission", "read_failure", "over_limit", "json_scalar", "invalid_utf8", "false_missing", "assessor_list", "assessor_object"])
def test_existing_unreadable_disk_proof_cannot_be_replaced_by_memory(monkeypatch, tmp_path, memory_kind, damage):
    import new_meta.core.protocol_scope as scope_module

    protocol, source_receipt = id_receipt(monkeypatch)
    project = Project(TOPIC, output_dir=tmp_path)
    target = project.get_path("protocol_scope.json", subdir="analysis")
    original = json.dumps(source_receipt).encode()
    if damage == "truncated": original = original[:100]
    if damage == "over_limit": original = b" " * (4 * 1024 * 1024 + 1)
    if damage == "json_scalar": original = b"null"
    if damage == "invalid_utf8": original = b"\xff\xfeinvalid"
    if damage == "assessor_list": original = json.dumps({**source_receipt, "assessor": []}).encode()
    if damage == "assessor_object": original = json.dumps({**source_receipt, "assessor": {}}).encode()
    target.write_bytes(original)
    protocol._scope_receipt = source_receipt if memory_kind == "source" else scope_receipt(TOPIC, protocol, assessment(protocol))
    read = scope_module._read_scoped

    def failing_read(project, relative, **kwargs):
        if relative == "analysis/protocol_scope.json":
            if damage == "permission": raise PermissionError("synthetic permission failure")
            if damage == "read_failure": raise OSError("synthetic read failure")
            if damage == "false_missing": raise FileNotFoundError("existing file was not actually absent")
        return read(project, relative, **kwargs)

    monkeypatch.setattr(scope_module, "_read_scoped", failing_read)
    with pytest.raises(ProtocolInputRequired, match="lacks a matching"):
        ensure_project_protocol_scope(project, protocol, allow_recheck=False)
    assert target.read_bytes() == original


def test_truncated_disk_proof_requires_actual_recheck_before_replacement(monkeypatch, tmp_path):
    protocol, good = id_receipt(monkeypatch)
    project = Project(TOPIC, output_dir=tmp_path)
    target = project.get_path("protocol_scope.json", subdir="analysis")
    target.write_bytes(json.dumps(good).encode()[:100])
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    calls = []

    class Reviewer:
        def check_scope(self, topic, candidate):
            calls.append(topic)
            return good

    assert ensure_project_protocol_scope(project, protocol, planner=Reviewer()) == good
    assert calls == [TOPIC]
    assert project.load_json("protocol_scope.json", subdir="analysis") == good


def test_genuinely_absent_disk_receipt_still_allows_valid_legacy_memory(tmp_path):
    protocol = proposal()
    project = Project(TOPIC, output_dir=tmp_path)
    protocol._scope_receipt = scope_receipt(TOPIC, protocol, assessment(protocol))
    assert ensure_project_protocol_scope(project, protocol, allow_recheck=False) == protocol._scope_receipt


@pytest.mark.parametrize("bad_assessor", [[], {}])
@pytest.mark.parametrize("location", ["memory", "disk"])
def test_unhashable_assessor_requires_recheck(monkeypatch, tmp_path, bad_assessor, location):
    protocol, good = id_receipt(monkeypatch)
    project = Project(TOPIC, output_dir=tmp_path)
    damaged = {**good, "assessor": bad_assessor}
    if location == "memory":
        protocol._scope_receipt = damaged
    else:
        project.get_path("protocol_scope.json", subdir="analysis").write_text(json.dumps(damaged))
    calls = []

    class Reviewer:
        def check_scope(self, topic, candidate):
            calls.append(topic)
            return good

    assert ensure_project_protocol_scope(project, protocol, planner=Reviewer()) == good
    assert calls == [TOPIC]


def test_valid_provenance_under_legacy_marker_is_preserved(monkeypatch, tmp_path):
    protocol, receipt = id_receipt(monkeypatch)
    receipt["assessor"] = "independent_protocol_scope_v1"
    project = Project(TOPIC, output_dir=tmp_path)
    protocol._scope_receipt = receipt
    assert ensure_project_protocol_scope(project, protocol, allow_recheck=False) == receipt


@pytest.mark.parametrize("changed", ["topic", "protocol"])
def test_provenance_is_bound_to_current_exact_inputs(monkeypatch, changed):
    protocol, receipt = id_receipt(monkeypatch)
    topic = TOPIC
    if changed == "topic": topic += "\n"
    else: protocol.pico.comparator = "Active treatments"
    with pytest.raises(ValueError, match="current inputs"):
        replay_scope_sources(topic, protocol, receipt["source_provenance"])


def test_approval_provenance_is_complete_even_when_payload_exceeds_diagnostic_cap(monkeypatch, tmp_path):
    from new_meta.agents.research_planner import SCOPE_ASSESSMENT_MAX_BYTES

    planner = ResearchPlanner()
    protocol = proposal()
    actual = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        result.fields[0].rationale = "Valid independent rationale. " * SCOPE_ASSESSMENT_MAX_BYTES
        actual.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    receipt = planner.check_scope(TOPIC, protocol)
    provenance = receipt["source_provenance"]
    assert [record["response"] for record in provenance["responses"]] == actual
    assert len(provenance["field_origins"]) == len(scope_fields(protocol))
    assert replay_scope_sources(TOPIC, protocol, provenance).model_dump(mode="json") == receipt["assessment"]
    assert "omitted" not in json.dumps(provenance)


def test_unobserved_malformed_response_fails_closed_without_invented_history(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    calls = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            try: json.loads("broken")
            except json.JSONDecodeError as cause: raise ValueError("invalid raw output") from cause
        return batch_assessment(messages, protocol)

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    assert len(calls) == 1 and caught.value.phase.data["scope_check_attempts"] == []


def test_replay_retains_original_nonmatch_even_when_retry_returns_all_match(monkeypatch):
    planner = ResearchPlanner()
    protocol = proposal()
    actual = []

    @scope_response_mock
    def check(messages, schema, **kwargs):
        result = batch_assessment(messages, protocol)
        if not actual:
            result.fields[0].source_id = "invalid-other-field"
            next(row for row in result.fields if row.field == "pico.comparator").status = "mismatch"
        actual.append(result.model_dump(mode="json"))
        return result

    monkeypatch.setattr(planner.llm, "structured_output", check)
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(TOPIC, protocol)
    attempts = caught.value.phase.data["scope_check_attempts"]
    records = [{**{key: row[key] for key in ("batch", "attempt", "provider_response_ordinal", "finish_reason", "raw_content", "raw_sha256")}, "response": response,
                "response_sha256": digest(response)} for row, response in zip(attempts, actual)]
    origins = {field: origin for row in attempts for field, origin in row.get("field_origins", {}).items()}
    provenance = scope_source_provenance(source_catalogue(TOPIC, protocol), records, origins)
    replayed = replay_scope_sources(TOPIC, protocol, provenance)
    assert next(row for row in replayed.fields if row.field == "pico.comparator").status == "mismatch"
    with pytest.raises(ProtocolInputRequired): scope_receipt(TOPIC, protocol, replayed)
    provenance["field_origins"]["pico.comparator"]["attempt"] = 2
    with pytest.raises(ValueError, match="field origins"):
        replay_scope_sources(TOPIC, protocol, provenance)


def test_real_seven_outcome_seven_subgroup_proposal_stays_blocked_after_id_transport(monkeypatch):
    fixture = json.loads((Path(__file__).parent / "fixtures/protocol_scope_bounded_replication.json").read_text())
    topic = fixture["topic"]
    protocol = ResearchProtocol.model_validate(fixture["proposal"])
    assert len(protocol.pico.outcomes_secondary) == len(protocol.subgroup_variables) == 7
    # Observed verdicts are unchanged; synthetic matches elsewhere isolate these real conflicts.
    observed = {row["field"]: row for result in fixture["verified_assessments"] for row in result["fields"]}
    assert all(row["original_quote"] == topic for row in observed.values() if row["status"] != "match")
    planner = ResearchPlanner()
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda messages, *args, **kwargs:
                        batch_assessment(messages, protocol, topic=topic, changes=observed)))
    with pytest.raises(ProtocolInputRequired) as caught:
        planner.check_scope(topic, protocol)
    assert caught.value.phase.error_code == "protocol_scope_input_required"
    findings = caught.value.phase.issues[0].context["scope_findings"]
    assert sum(row["status"] == "mismatch" for row in findings) == 5
    assert sum(row["status"] == "uncertain" for row in findings) == 3
    assert protocol.model_dump(mode="json") == fixture["proposal"]


def test_requested_secondary_outcomes_and_subgroups_are_not_forced_empty(monkeypatch):
    protocol = proposal()
    protocol.pico.outcomes_secondary = ["All-cause mortality"]
    protocol.subgroup_variables = ["Baseline disease severity"]
    topic = TOPIC + " Also analyze all-cause mortality and subgroups by baseline disease severity."
    planner = ResearchPlanner()
    monkeypatch.setattr(planner, "call_llm_structured", lambda *args, **kwargs: protocol)
    monkeypatch.setattr(planner.llm, "structured_output", scope_response_mock(lambda messages, *args, **kwargs:
                        batch_assessment(messages, protocol, topic=topic)))
    approved = planner.run(topic)
    assert approved.pico.outcomes_secondary == ["All-cause mortality"]
    assert approved.subgroup_variables == ["Baseline disease severity"]


def test_both_planner_and_checker_prompts_distinguish_bounded_and_open_ended_scope():
    from new_meta.prompts import planner_prompts

    for prompt in (planner_prompts.SYSTEM_PROMPT, planner_prompts.SCOPE_CHECK_SYSTEM):
        assert "keep unrequested outcomes_secondary and subgroup_variables empty" in prompt
        assert "genuinely open-ended protocol design" in prompt
        assert "Preserve\nexplicitly requested additional analyses" in prompt
        assert "descriptive or exploratory\nlabels do not authorize" in prompt
    assert "PRISMA-compliant research protocol" not in planner_prompts.SYSTEM_PROMPT
