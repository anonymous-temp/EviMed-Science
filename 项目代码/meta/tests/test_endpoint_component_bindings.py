"""Current endpoint membership contracts preserve observations and old proofs."""
from copy import deepcopy
import hashlib
import pytest
from new_meta.schemas.study import PrimaryAlignmentAssessment
from new_meta.core.extraction_verification import validate_check_batch
from test_extraction_verification import SOURCE, checked_row, protocol, study


def legacy_row():
    row = deepcopy(checked_row())
    for name in ("schema_version", "selected_endpoint_result", "definition_scope", "component_bindings"):
        row["verification"].pop(name, None)
    return row


def bound_row():
    from endpoint_binding_fixture import bind_components
    return bind_components(legacy_row(), SOURCE)


def test_current_checker_requires_versioned_membership_contract():
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    with pytest.raises(ValueError):
        ExtractionCheckResult.model_validate({"score": 9, "data_issues": [],
            "primary_analysis_alignment": [legacy_row()]}, strict=True)


def test_legacy_assessment_serialization_is_byte_stable():
    row = legacy_row()
    original = PrimaryAlignmentAssessment.model_validate(row).model_dump(mode="json")
    assert original["verification"] == row["verification"]
    assert not any(name in original["verification"] for name in (
        "schema_version", "selected_endpoint_result", "definition_scope", "component_bindings"))


def test_three_bound_components_validate():
    row = PrimaryAlignmentAssessment.model_validate(bound_row(), strict=True)
    assert validate_check_batch(study(), [0], [row], SOURCE, protocol()) == []


@pytest.mark.parametrize("relation,membership,source_component", [
    ("extra", "included_in_selected_endpoint", "renal death"),
    ("missing", "absent_from_selected_endpoint", ""),
])
def test_valid_component_negative_is_retained_despite_broken_sibling(relation, membership, source_component):
    from new_meta.core.extraction_observations import inspect_extraction_payload
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    row = bound_row()
    row["verification"]["components"][2].update(
        relation=relation, source_component=source_component, protocol_component="Required component")
    row["verification"]["component_bindings"][2]["source_membership"] = membership
    del row["verification"]["numeric_findings"][0]["rationale"]
    result = inspect_extraction_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]},
        ExtractionCheckResult, study(), [0], SOURCE, protocol())
    assert result["errors"]
    retained = [item for item in result["clinical_negatives"] if item.get("field") == "components"]
    assert len(retained) == 1 and retained[0]["component_index"] == 2
    assert retained[0]["judgment"]["component_bindings"][0] == row["verification"]["component_bindings"][2]


def test_other_endpoint_extra_is_invalid_contract_not_clinical_negative():
    from new_meta.core.extraction_observations import inspect_extraction_payload
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    row = bound_row()
    row["verification"]["components"][2]["relation"] = "extra"
    row["verification"]["component_bindings"][2]["source_membership"] = "belongs_to_other_endpoint"
    result = inspect_extraction_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]},
        ExtractionCheckResult, study(), [0], SOURCE, protocol())
    assert any(error["code"] == "verification_component_membership_inconsistent" for error in result["errors"])
    assert result["clinical_negatives"] == []


@pytest.mark.parametrize("damage", ["missing", "duplicate", "out_of_range", "boolean", "different_target", "unanchored_label", "forged_bytes"])
def test_component_contract_errors_fail_closed(damage):
    row = bound_row()
    details = row["verification"]
    bindings = details["component_bindings"]
    if damage == "missing": bindings.pop()
    elif damage == "duplicate": bindings.append(deepcopy(bindings[0]))
    elif damage == "out_of_range": bindings[0]["component_index"] = 99
    elif damage == "boolean": bindings[0]["component_index"] = True
    elif damage == "different_target":
        from endpoint_binding_fixture import result_support
        bindings[0]["target_result"] = result_support(SOURCE, "The renal endpoint was kidney failure, creatinine doubling, or renal death.")
    elif damage == "unanchored_label": details["components"][0]["source_component"] = "Invented endpoint label"
    else: bindings[0]["target_result"]["source_range"]["start_byte"] += 1
    try:
        parsed = PrimaryAlignmentAssessment.model_validate(row, strict=True)
    except ValueError:
        return
    assert validate_check_batch(study(), [0], [parsed], SOURCE, protocol())


def test_source_reference_resolution_owns_range_identity():
    from new_meta.core.extraction_sources import source_catalogue, resolve_reference_payload, reference_schema
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from extraction_source_fixture import wire_payload
    payload = {"score": 9, "data_issues": [], "primary_analysis_alignment": [bound_row()]}
    catalogue = source_catalogue(SOURCE, hashlib.sha256(SOURCE.encode()).hexdigest())
    wire = wire_payload(payload, SOURCE, catalogue)
    assert "source_range" not in wire["primary_analysis_alignment"][0]["verification"]["selected_endpoint_result"]
    schema = reference_schema(ExtractionCheckResult.model_json_schema())
    assert "source_range" not in schema["$defs"]["EndpointResultSource"]["properties"]
    resolved, errors, metadata = resolve_reference_payload(SOURCE, catalogue, wire)
    assert errors == []
    assert resolved["primary_analysis_alignment"][0]["verification"]["selected_endpoint_result"] == payload["primary_analysis_alignment"][0]["verification"]["selected_endpoint_result"]
    selected = resolved["primary_analysis_alignment"][0]["verification"]["selected_endpoint_result"]
    forged = deepcopy(wire)
    forged["primary_analysis_alignment"][0]["verification"]["selected_endpoint_result"]["source_range"] = selected["source_range"]
    assert resolve_reference_payload(SOURCE, catalogue, forged)[1]


@pytest.mark.parametrize("negative", [False, True])
def test_legacy_proofs_keep_bytes_and_identity_but_positive_needs_recheck(tmp_path, negative):
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import _record_proof, _authenticated_proof, alignment_status, digest
    project = Project("legacy membership policy", output_dir=tmp_path)
    candidate = study()
    raw = legacy_row()
    if negative:
        raw["verification"]["components"][0]["relation"] = "extra"
    assessment = PrimaryAlignmentAssessment.model_validate(raw)
    proof = _record_proof(project, protocol(), candidate, 0, assessment,
        source_text=SOURCE, source_path=None, assessor="extraction-check-v2", issue_history=([], True))
    path = project.base_dir / "extraction/primary_alignment" / f"{proof.proof_id}.json"
    before = path.read_bytes()
    assert _authenticated_proof(project, proof) == proof
    result = alignment_status(project, protocol(), candidate, 0)
    assert result["status"] == ("mismatch" if negative else "unknown")
    assert result["reason"] == ("endpoint_components_incompatible" if negative else "endpoint_membership_recheck_required")
    assert path.read_bytes() == before
    assert digest(proof.model_dump(mode="json", exclude={"proof_id"})) == proof.proof_id
    assert candidate.outcomes[0].primary_analysis_alignment.proof_id == proof.proof_id


@pytest.mark.parametrize("version", [True, 3.0, "3"])
def test_current_contract_rejects_coerced_version(version):
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    row = bound_row(); row["verification"]["schema_version"] = version
    with pytest.raises(ValueError):
        ExtractionCheckResult.model_validate({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, strict=True)


def test_repeated_text_at_different_positions_is_a_different_target():
    from endpoint_binding_fixture import bind_components
    from new_meta.core.extraction_sources import source_catalogue, resolve_reference_payload
    from extraction_source_fixture import wire_payload
    text = SOURCE + " " + SOURCE
    row = bind_components(legacy_row(), text)
    catalogue = source_catalogue(text, hashlib.sha256(text.encode()).hexdigest())
    wire = wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, text, catalogue)
    target = wire["primary_analysis_alignment"][0]["verification"]["component_bindings"][0]["target_result"]
    old = row["verification"]["selected_endpoint_result"]
    repeated_start = text.index(old["quote"], len(SOURCE))
    first = next(item for item in catalogue["sources"] if item["start"] == repeated_start)
    last = next(item for item in catalogue["sources"] if item["end"] == repeated_start + len(old["quote"]))
    target.update(source_id=first["source_id"], end_source_id=last["source_id"])
    resolved, errors, _ = resolve_reference_payload(text, catalogue, wire)
    assert any(item["code"] == "verification_component_target_mismatch" for item in errors)
    parsed = PrimaryAlignmentAssessment.model_validate(resolved["primary_analysis_alignment"][0], strict=True)
    assert any(item["code"] == "verification_component_target_mismatch"
               for item in validate_check_batch(study(), [0], [parsed], text, protocol()))


def test_invalid_membership_can_be_corrected_without_erasing_raw_response(tmp_path, monkeypatch):
    import json
    from extraction_source_fixture import wire_payload
    from test_extraction_raw_observations import run_provider
    from new_meta.core.primary_analysis_alignment import alignment_status
    bad = bound_row()
    bad["verification"]["components"][0]["relation"] = "extra"
    bad["verification"]["component_bindings"][0]["source_membership"] = "belongs_to_other_endpoint"
    raw_bad = json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [bad]}, SOURCE))
    good = json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [bound_row()]}, SOURCE))
    candidate = study(); candidate.outcomes.append(candidate.outcomes[0].model_copy(deep=True))
    # The default checker isolates rows, so provide a separate complete second row.
    row1 = bound_row(); row1["outcome_index"] = 1
    other = json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row1]}, SOURCE))
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [raw_bad, good, other], candidate=candidate, batch_size=None)
    assert len(calls) == 3
    first = next(item for item in observations if item.get("raw_response", {}).get("content") == raw_bad)
    assert first["retained_clinical_judgments"] == []
    assert any(item["code"] == "verification_component_membership_inconsistent" for item in first["reasons"])
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    stored = list((project.base_dir / "extraction/verification/raw").glob("*.json"))
    assert any(json.loads(path.read_text())["raw_response"]["content"] == raw_bad for path in stored)


def test_true_fourth_component_overrules_an_incorrect_overall_match():
    import json
    from endpoint_binding_fixture import bind_components
    from new_meta.core.extraction_verification import verification_verdict
    from new_meta.core.extraction_observations import inspect_extraction_payload
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    text = SOURCE.replace("or renal death", "renal death, or hospitalization")
    row = json.loads(json.dumps(legacy_row()).replace("or renal death", "renal death, or hospitalization"))
    row["verification"]["components"].append({"source_component": "hospitalization", "protocol_component": "", "relation": "extra"})
    row = bind_components(row, text)
    parsed = PrimaryAlignmentAssessment.model_validate(row, strict=True)
    assert validate_check_batch(study(), [0], [parsed], text, protocol()) == []
    assert verification_verdict(parsed, protocol())["status"] == "mismatch"
    # Damage another component's own source binding, not the valid extra's evidence.
    row["verification"]["component_bindings"][0]["support"]["quote"] = "Unreported wording."
    observed = inspect_extraction_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]},
        ExtractionCheckResult, study(), [0], text, protocol())
    assert observed["errors"]
    assert [item["component_index"] for item in observed["clinical_negatives"] if item.get("field") == "components"] == [3]


@pytest.mark.parametrize("damage", ["catalogue", "ids", "checked_source", "range"])
def test_component_target_identity_cannot_be_replaced(damage):
    row = bound_row()
    target = row["verification"]["component_bindings"][0]["target_result"]["source_range"]
    if damage == "catalogue": target["catalogue_sha256"] = "a" * 64
    elif damage == "ids": target["source_id"] = "different-catalogue-id"
    elif damage == "checked_source": target["checked_source_sha256"] = "a" * 64
    else: target["start"] += 1
    parsed = PrimaryAlignmentAssessment.model_validate(row, strict=True)
    assert any(item["code"] == "verification_component_target_mismatch"
               for item in validate_check_batch(study(), [0], [parsed], SOURCE, protocol()))


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("negative", [False, True])
def test_legacy_source_receipt_replays_without_rewriting_history(tmp_path, negative, version):
    import json
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import (_record_proof, _write_scoped_once,
        row_fingerprint, protocol_fingerprint, alignment_status)
    from new_meta.core.extraction_sources import source_catalogue, resolve_reference_payload
    from extraction_source_fixture import wire_payload
    project = Project("legacy source receipt", output_dir=tmp_path)
    candidate = study(); row = legacy_row() if version == 1 else bound_row()
    if negative: row["verification"]["components"][0]["relation"] = "extra"
    source_sha = hashlib.sha256(SOURCE.encode()).hexdigest()
    catalogue = source_catalogue(SOURCE, source_sha)
    wire = wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, SOURCE, catalogue, wire_version=version)
    resolved, errors, metadata = resolve_reference_payload(SOURCE, catalogue, wire, wire_version=version)
    assert not errors
    def store(kind, value):
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        sha = hashlib.sha256(encoded).hexdigest()
        path = f"extraction/verification/{kind}/{sha}.json"
        _write_scoped_once(project, path, encoded)
        return {"path": path, "sha256": sha}
    raw_record = store("raw", {"version": version, "verification_id": "legacy-synthetic",
        "outcome_indices": [0], "attempt": 1, "source_sha256": source_sha, "checked_source_sha256": source_sha,
        "protocol_sha256": protocol_fingerprint(protocol()), "row_sha256": {"0": row_fingerprint(candidate, 0)},
        "catalogue": store("sources", catalogue), "raw_response": {"content": json.dumps(wire),
            "finish_reason": "stop", "provider_response_ordinal": 1}})
    reference = store("resolved", {"version": version, "raw_record": raw_record, "resolved_response": resolved,
        "resolution": metadata, "errors": [], "retained_data_issues": [], "retained_clinical_judgments": []})
    assessment = PrimaryAlignmentAssessment.model_validate(resolved["primary_analysis_alignment"][0], strict=True)
    proof = _record_proof(project, protocol(), candidate, 0, assessment,
        source_text=SOURCE, source_path=None, assessor=f"extraction-check-sources-v{version}", issue_history=([], True),
        source_reference=reference)
    before = {str(path): path.read_bytes() for path in project.base_dir.rglob("*.json")}
    result = alignment_status(project, protocol(), candidate, 0)
    assert result["status"] == ("mismatch" if negative else "unknown" if version == 1 else "match")
    if not negative and version == 1: assert result["reason"] == "endpoint_membership_recheck_required"
    assert before == {str(path): path.read_bytes() for path in project.base_dir.rglob("*.json")}
    assert candidate.outcomes[0].primary_analysis_alignment.proof_id == proof.proof_id


@pytest.mark.parametrize("marker", ["extraction-check-sources-v1", "extraction-check-v2", "human-review-v1"])
def test_current_membership_proof_cannot_downgrade_to_legacy_marker(tmp_path, marker):
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import _record_proof, alignment_status
    project = Project("no membership downgrade", output_dir=tmp_path)
    candidate = study()
    _record_proof(project, protocol(), candidate, 0, PrimaryAlignmentAssessment.model_validate(bound_row()),
        source_text=SOURCE, source_path=None, assessor=marker, assessor_id="explicit-synthetic", issue_history=([], True))
    assert alignment_status(project, protocol(), candidate, 0)["status"] == "unknown"


@pytest.mark.parametrize("damage", ["legacy", "forged_catalogue", "forged_ids"])
def test_human_review_requires_current_authentic_component_targets(tmp_path, damage):
    from test_primary_analysis_alignment import stamp_fixture, assessment_payload
    from new_meta.core.primary_analysis_alignment import alignment_status
    from new_meta.core.extraction_review import ExtractionReviewDecision, save_extraction_review_decision
    project, current_protocol, candidate, _ = stamp_fixture(tmp_path, population="uncertain")
    project.save_json("protocol.json", current_protocol)
    project.save_json("all_extractions.json", [candidate], subdir="extraction")
    version = alignment_status(project, current_protocol, candidate, 0)
    assessment = assessment_payload(); details = assessment["verification"]
    if damage == "legacy":
        for key in ("schema_version", "selected_endpoint_result", "definition_scope", "component_bindings"):
            details.pop(key)
    else:
        for support in [details["selected_endpoint_result"], *(item["target_result"] for item in details["component_bindings"])]:
            if damage == "forged_catalogue": support["source_range"]["catalogue_sha256"] = "a" * 64
            else: support["source_range"]["source_id"] = "forged-identical-target"
    decision = ExtractionReviewDecision(row_id="S1:0", alignment_assessment=assessment,
        alignment_protocol_sha256=version["protocol_sha256"], alignment_row_sha256=version["row_sha256"],
        alignment_source_sha256=version["source_sha256"])
    with pytest.raises(ValueError):
        save_extraction_review_decision(project, decision, alignment_assessor_id="reviewer-a")


@pytest.mark.parametrize("broken", [None, [], "invalid binding", 7, True])
def test_malformed_earlier_binding_cannot_hide_valid_later_negative(broken):
    from new_meta.core.extraction_observations import inspect_extraction_payload
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    row = bound_row()
    row["verification"]["components"][2]["relation"] = "extra"
    row["verification"]["component_bindings"][0] = broken
    result = inspect_extraction_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]},
        ExtractionCheckResult, study(), [0], SOURCE, protocol())
    assert result["errors"]
    retained = [item for item in result["clinical_negatives"] if item.get("field") == "components"]
    assert len(retained) == 1 and retained[0]["component_index"] == 2


def test_valid_later_component_negative_survives_provider_retry_and_reload(tmp_path, monkeypatch):
    import json
    from extraction_source_fixture import wire_payload
    from test_extraction_raw_observations import run_provider
    from new_meta.core.primary_analysis_alignment import alignment_status, recover_issue_history
    from new_meta.schemas.study import ExtractedStudy
    first, second = bound_row(), bound_row(); second["outcome_index"] = 1
    first["verification"]["components"][2]["relation"] = "extra"
    first["verification"]["component_bindings"][0] = None
    bad = json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [first, second]}, SOURCE))
    good = json.dumps(wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [bound_row(), second]}, SOURCE))
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [bad, good])
    assert len(calls) == 1
    assert recover_issue_history(project, result, 0) == ([], False)
    observed = next(item for item in observations if item.get("raw_response", {}).get("content") == bad)
    assert any(item.get("component_index") == 2 for item in observed["retained_clinical_judgments"])
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    _, retried, _, _ = run_provider(tmp_path, monkeypatch, [good], candidate=restored, project=project)
    assert alignment_status(project, protocol(), retried, 0)["reason"] == "verification_issue_history_required"


@pytest.mark.parametrize("damage", ["catalogue", "ids"])
def test_direct_current_proof_authenticates_catalogue_identity(tmp_path, damage):
    from new_meta.core.project import Project
    from new_meta.core.primary_analysis_alignment import record_checked_alignments, alignment_status
    project = Project("direct source membership boundary", output_dir=tmp_path)
    candidate = study(); row = bound_row(); details = row["verification"]
    for support in [details["selected_endpoint_result"], *(item["target_result"] for item in details["component_bindings"])]:
        if damage == "catalogue": support["source_range"]["catalogue_sha256"] = "a" * 64
        else: support["source_range"]["source_id"] = "consistent-forged-id"
    record_checked_alignments(project, protocol(), candidate, [row], source_text=SOURCE,
        issue_histories={0: ([], True)})
    assert alignment_status(project, protocol(), candidate, 0)["status"] == "unknown"
