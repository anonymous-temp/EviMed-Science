"""Provider-boundary regressions for source-faithful independent verification."""
import hashlib
import json
from types import SimpleNamespace

import pytest

from new_meta.agents.data_extraction_agent import DataExtractionAgent
from new_meta.core.primary_analysis_alignment import alignment_status, recover_issue_history, row_fingerprint, protocol_fingerprint
from new_meta.core.project import Project
from new_meta.schemas.study import ExtractedStudy
from test_extraction_issue_persistence import issue
from test_extraction_verification import SOURCE, checked_row, protocol, study


def payload(count=2, *, issues=()):
    return {"score": 9, "data_issues": list(issues),
            "primary_analysis_alignment": [checked_row(index) for index in range(count)]}


def run_provider(tmp_path, monkeypatch, responses, *, candidate=None, project=None):
    project = project or Project("raw observation regression", output_dir=tmp_path)
    source = project.base_dir / "papers/source.txt"
    source.write_text(SOURCE)
    candidate = candidate or study()
    if len(candidate.outcomes) == 1:
        candidate.outcomes.append(candidate.outcomes[0].model_copy(deep=True))
    agent = DataExtractionAgent()
    agent.llm.stream = False
    monkeypatch.setattr(agent.llm, "_sleep_before_retry", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(agent, "_refine_extraction", lambda _text, current, *_args: current)
    calls = []
    remaining = list(responses)

    def create(**kwargs):
        calls.append(kwargs)
        response = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, SimpleNamespace):
            return response
        raw, finish_reason = response if isinstance(response, tuple) else (response, "stop")
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=raw), finish_reason=finish_reason)], usage=None)

    monkeypatch.setattr(agent.llm.client.chat.completions, "create", create)
    # Preserve the real transport orchestration while satisfying the suite's
    # offline guard; the SDK method above is the mocked provider boundary.
    original_call = agent.llm._call
    monkeypatch.setattr(agent.llm, "_call", lambda **kwargs: original_call(**kwargs))
    result = agent._verify_alignment(candidate, {"fulltext_path": str(source)},
        {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()},
        protocol(), project)
    observations = [json.loads(path.read_text()) for path in
                    (project.base_dir / "extraction/verification").glob("*.json")]
    return project, result, calls, observations


def test_malformed_sibling_cannot_erase_observed_source_conflict(tmp_path, monkeypatch):
    first = payload(issues=[issue(conflict=True)])
    first["primary_analysis_alignment"][1] = {"outcome_index": 1}
    raw = json.dumps(first)
    project, result, calls, observations = run_provider(
        tmp_path, monkeypatch, [raw, json.dumps(payload())])
    history, complete = recover_issue_history(project, result, 0)
    assert complete and [item.issue.kind for item in history] == ["source_conflict"]
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert any(item.get("raw_response", {}).get("content") == raw for item in observations)
    assert len(calls) <= 2


def test_healthy_provider_check_still_certifies_complete_rows(tmp_path, monkeypatch):
    raw = json.dumps(payload())
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [raw])
    assert len(calls) == 1
    assert all(alignment_status(project, protocol(), result, index)["status"] == "match"
               for index in range(2))
    assert any(item.get("raw_response", {}).get("content") == raw for item in observations)


@pytest.mark.parametrize("damage", ["malformed_row", "extra_row_key", "extra_envelope_key", "missing_required",
                                    "invalid_issue_sibling", "duplicate_row", "coerced_boolean"])
def test_valid_data_issue_survives_invalid_siblings(tmp_path, monkeypatch, damage):
    first = payload(issues=[issue(conflict=True)])
    if damage == "malformed_row":
        first["primary_analysis_alignment"][1] = {"outcome_index": 1}
    elif damage == "extra_row_key":
        first["primary_analysis_alignment"][1]["extra"] = True
    elif damage == "extra_envelope_key":
        first["extra"] = True
    elif damage == "missing_required":
        del first["score"]
    elif damage == "invalid_issue_sibling":
        first["data_issues"].append({"outcome_index": 1})
    elif damage == "duplicate_row":
        first["primary_analysis_alignment"].append(checked_row(1))
    else:
        first["primary_analysis_alignment"][1]["verification"]["randomized_comparison"] = "true"
    project, result, _, observations = run_provider(tmp_path, monkeypatch,
        [json.dumps(first), json.dumps(payload())])
    history, complete = recover_issue_history(project, result, 0)
    assert complete and len(history) == 1
    assert history[0].issue.model_dump(mode="json") == issue(conflict=True)
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    first_observation = next(item for item in observations if item.get("raw_response", {}).get("content") == json.dumps(first))
    assert first_observation["reasons"]
    assert first_observation["retained_data_issues"][0]["kind"] == "source_conflict"


@pytest.mark.parametrize("negative", ["contrast", "population", "outcome", "endpoint", "estimand"])
@pytest.mark.parametrize("damage", ["sibling", "length"])
def test_partial_clinical_negative_is_terminal_and_survives_reload(tmp_path, monkeypatch, negative, damage):
    first = payload()
    row = first["primary_analysis_alignment"][0]
    if negative in {"contrast", "population", "outcome"}:
        row[negative]["status"] = "mismatch"
    elif negative == "endpoint":
        row["verification"]["endpoint_relation"] = "different"
    else:
        row["verification"]["estimand_relation"] = "mismatch"
    if damage == "sibling":
        first["primary_analysis_alignment"][1] = {"outcome_index": 1}
    raw = json.dumps(first)
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [(raw, "length" if damage == "length" else "stop"), json.dumps(payload())])
    assert len(calls) == 1
    assert all(alignment_status(project, protocol(), result, index)["status"] == "unknown" for index in range(2))
    assert recover_issue_history(project, result, 0) == ([], False)
    record = next(item for item in observations if item.get("raw_response", {}).get("content") == raw)
    assert record["retained_clinical_judgments"]
    assert any(item["code"] == "verification_partial_clinical_judgment_retained" for item in record["reasons"])
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    _, retried, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], candidate=restored, project=project)
    assert alignment_status(project, protocol(), retried, 0)["reason"] == "verification_issue_history_required"


def test_negative_dimension_is_retained_when_other_dimension_is_malformed(tmp_path, monkeypatch):
    first = payload()
    first["primary_analysis_alignment"][0]["contrast"]["status"] = "mismatch"
    del first["primary_analysis_alignment"][0]["population"]["rationale"]
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [json.dumps(first), json.dumps(payload())])
    assert len(calls) == 1
    assert recover_issue_history(project, result, 0) == ([], False)
    assert any(item.get("retained_clinical_judgments") for item in observations)


def test_length_retry_cannot_clear_data_issue_and_records_provider_ordinals(tmp_path, monkeypatch):
    first, second = json.dumps(payload(issues=[issue(conflict=True)])), json.dumps(payload())
    original = study(); original.outcomes.append(original.outcomes[0].model_copy(deep=True))
    expected_rows = {str(index): row_fingerprint(original, index) for index in range(2)}
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [(first, "length"), second], candidate=original)
    raw_records = [item for item in observations if "raw_response" in item]
    initial = sorted([item for item in raw_records if item["attempt"] == 1],
                     key=lambda item: item["raw_response"]["provider_response_ordinal"])
    assert [item["raw_response"]["provider_response_ordinal"] for item in initial] == [1, 2]
    assert [item["raw_response"]["content"] for item in initial] == [first, second]
    for record in initial:
        assert record["source_sha256"] == record["checked_source_sha256"] == hashlib.sha256(SOURCE.encode()).hexdigest()
        assert record["row_sha256"] == expected_rows
        assert record["protocol_sha256"] == protocol_fingerprint(protocol())
        assert record["raw_response_sha256"] == hashlib.sha256(record["raw_response"]["content"].encode()).hexdigest()
    assert len(calls) == 2
    assert len(recover_issue_history(project, result, 0)[0]) == 1


@pytest.mark.parametrize("invalid", ["malformed_json", "duplicate_keys", "duplicate_row", "unanchored", "invalid_field"])
def test_ambiguous_or_unanchored_observations_do_not_fabricate_conflicts(tmp_path, monkeypatch, invalid):
    first = payload()
    if invalid == "malformed_json":
        raw = '{"primary_analysis_alignment":['
    elif invalid == "duplicate_keys":
        raw = json.dumps(first)[:-1] + ', "data_issues": []}'
    elif invalid == "duplicate_row":
        first["primary_analysis_alignment"][0]["contrast"]["status"] = "mismatch"
        first["primary_analysis_alignment"].append(checked_row(0))
        raw = json.dumps(first)
    else:
        defect = issue(conflict=True)
        if invalid == "unanchored":
            defect["quote"] = "A nonexistent source assertion."
        else:
            defect["field"] = "invented_field"
        first["data_issues"] = [defect]
        raw = json.dumps(first)
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [raw])
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert recover_issue_history(project, result, 0) == ([], True)
    assert len(calls) == 3
    raw_records = [item for item in observations if "raw_response" in item]
    assert raw_records and all(item["retained_data_issues"] == [] for item in raw_records)
    assert all(item["retained_clinical_judgments"] == [] for item in raw_records)


def test_provider_fault_is_incomplete_with_no_fabricated_observation(tmp_path, monkeypatch):
    project, result, _, observations = run_provider(tmp_path, monkeypatch, [RuntimeError("synthetic provider fault")])
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert all("raw_response" not in item for item in observations)
    assert any(item["code"] == "verification_response_unavailable" for record in observations for item in record["reasons"])


def test_complete_clinical_mismatch_retains_normal_mismatch_verdict(tmp_path, monkeypatch):
    first = payload()
    first["primary_analysis_alignment"][0]["contrast"]["status"] = "mismatch"
    project, result, calls, _ = run_provider(tmp_path, monkeypatch, [json.dumps(first)])
    assert len(calls) == 1
    assert alignment_status(project, protocol(), result, 0)["status"] == "mismatch"
    assert recover_issue_history(project, result, 0) == ([], True)


def test_provider_interruption_after_length_observation_preserves_issue_checkpoint(tmp_path, monkeypatch):
    project = Project("interrupted raw observation", output_dir=tmp_path)
    with pytest.raises(KeyboardInterrupt):
        run_provider(tmp_path, monkeypatch,
            [(json.dumps(payload(issues=[issue(conflict=True)])), "length"), KeyboardInterrupt()], project=project)
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    assert len(recover_issue_history(project, restored, 0)[0]) == 1
    _, result, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], candidate=restored, project=project)
    assert alignment_status(project, protocol(), result, 0)["reason"] == "verification_issue_history_required"


def test_observation_persistence_failure_never_regenerates_or_approves(tmp_path, monkeypatch):
    import new_meta.core.primary_analysis_alignment as alignment
    project = Project("failed raw persistence", output_dir=tmp_path)
    write_once = alignment._write_scoped_once
    attempts = []

    def fail_observation(project, relative, data):
        if relative.startswith("extraction/verification/"):
            attempts.append(relative)
            raise OSError("synthetic observation write failure")
        return write_once(project, relative, data)

    monkeypatch.setattr(alignment, "_write_scoped_once", fail_observation)
    with pytest.raises(OSError):
        run_provider(tmp_path, monkeypatch,
            [(json.dumps(payload(issues=[issue(conflict=True)])), "length"), json.dumps(payload())], project=project)
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    history, complete = recover_issue_history(project, restored, 0)
    assert len(history) == 1 and not complete
    assert len(attempts) == 2  # The observation and its terminal attempt diagnostic.
    assert alignment_status(project, protocol(), restored, 0)["status"] == "unknown"


def test_valid_metadata_issue_does_not_disappear_on_positive_retry(tmp_path, monkeypatch):
    candidate = study()
    candidate.outcomes[0].reported_effect_scale = "log"
    first = payload(issues=[issue()])
    first["primary_analysis_alignment"][1] = {"outcome_index": 1}
    project, result, _, _ = run_provider(tmp_path, monkeypatch,
        [json.dumps(first), json.dumps(payload())], candidate=candidate)
    history, complete = recover_issue_history(project, result, 0)
    assert complete and len(history) == 1
    assert result.outcomes[0].reported_effect_scale == "log"
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


@pytest.mark.parametrize("negative", ["endpoint", "estimand", "randomized_comparison",
    "postrandomization_conditioning", "selection_timing", "conditioning_variable", "endpoint_component"])
@pytest.mark.parametrize("sibling", ["numeric_schema", "contrast_schema", "contrast_anchor"])
def test_source_subjudgment_does_not_depend_on_unrelated_sibling(tmp_path, monkeypatch, negative, sibling):
    first = payload()
    row = first["primary_analysis_alignment"][0]
    details = row["verification"]
    if negative == "endpoint":
        details["endpoint_relation"] = "different"
    elif negative == "estimand":
        details["estimand_relation"] = "mismatch"
    elif negative == "randomized_comparison":
        details[negative] = False
    elif negative == "postrandomization_conditioning":
        details[negative] = True
    elif negative == "selection_timing":
        details[negative] = "postrandomization"
    elif negative == "conditioning_variable":
        details["conditioning_variables"][0]["timing"] = "postrandomization"
    else:
        details["components"][0]["relation"] = "extra"
    if sibling == "numeric_schema":
        del details["numeric_findings"][0]["rationale"]
    elif sibling == "contrast_schema":
        del row["contrast"]["rationale"]
    else:
        row["contrast"]["quote"] = "This is not in the source."
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [json.dumps(first), json.dumps(payload())])
    assert len(calls) == 1
    assert recover_issue_history(project, result, 0) == ([], False)
    assert any(item.get("retained_clinical_judgments") for item in observations)
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    _, retried, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], candidate=restored, project=project)
    assert alignment_status(project, protocol(), retried, 0)["status"] == "unknown"


@pytest.mark.parametrize("empty", [None, "", "null", SimpleNamespace(choices=[], usage=None)])
def test_absent_and_null_content_remain_distinct_and_allow_bounded_retry(tmp_path, monkeypatch, empty):
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [empty, json.dumps(payload())])
    assert len(calls) == 2
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert recover_issue_history(project, result, 0) == ([], True)
    raw = [item for item in observations if "raw_response" in item]
    expected_content = None if isinstance(empty, SimpleNamespace) else empty
    first = next(item for item in raw if item["raw_response"]["content"] == expected_content)
    assert first["retained_clinical_judgments"] == first["retained_data_issues"] == []
    assert first["raw_response_sha256"] == (None if expected_content is None else
        hashlib.sha256(expected_content.encode()).hexdigest())


@pytest.mark.parametrize("boundary", ["before_retained_proof", "after_retained_proof", "after_retained_checkpoint",
                                     "before_raw", "after_raw"])
def test_observation_write_interruption_cannot_restore_an_earlier_clean_checkpoint(tmp_path, monkeypatch, boundary):
    import new_meta.core.primary_analysis_alignment as alignment
    project = Project("crash-safe observed judgment", output_dir=tmp_path)
    _, candidate, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], project=project)
    immutable_before = {path: path.read_bytes() for path in (project.base_dir / "extraction/primary_alignment").glob("*.json")}
    original_once, original_atomic = alignment._write_scoped_once, alignment._write_scoped_atomic
    once_interrupted = False
    raw = payload(issues=[issue(conflict=True)])
    raw["primary_analysis_alignment"][0]["contrast"]["status"] = "mismatch"
    del raw["primary_analysis_alignment"][1]["contrast"]["rationale"]

    def retained_proof(relative, data):
        return (relative.startswith("extraction/primary_alignment/") and relative.endswith(".json")
                and bool(json.loads(data).get("unresolved_data_issues")))

    def intercept_once(project, relative, data):
        nonlocal once_interrupted
        is_raw = relative.startswith("extraction/verification/")
        selected = ((boundary in {"before_retained_proof", "after_retained_proof"} and retained_proof(relative, data))
                    or (boundary in {"before_raw", "after_raw"} and is_raw))
        if selected and not once_interrupted and boundary.startswith("before"):
            once_interrupted = True
            raise KeyboardInterrupt
        result = original_once(project, relative, data)
        if selected and not once_interrupted:
            once_interrupted = True
            raise KeyboardInterrupt
        return result

    def intercept_atomic(project, relative, data):
        nonlocal once_interrupted
        result = original_atomic(project, relative, data)
        if boundary == "after_retained_checkpoint" and not once_interrupted and relative == "extraction/trial-paper.json":
            rows = json.loads(data)["outcomes"]
            if rows[0]["primary_analysis_alignment"]["unresolved_data_issues"]:
                once_interrupted = True
                raise KeyboardInterrupt
        return result

    monkeypatch.setattr(alignment, "_write_scoped_once", intercept_once)
    monkeypatch.setattr(alignment, "_write_scoped_atomic", intercept_atomic)
    with pytest.raises(KeyboardInterrupt):
        run_provider(tmp_path, monkeypatch, [json.dumps(raw)], candidate=candidate, project=project)
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    assert recover_issue_history(project, restored, 0)[1] is False
    _, retried, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], candidate=restored, project=project)
    assert alignment_status(project, protocol(), retried, 0)["status"] == "unknown"
    assert all(path.read_bytes() == content for path, content in immutable_before.items())


@pytest.mark.parametrize("negative", ["endpoint", "estimand", "randomized_comparison", "postrandomization_conditioning",
                                     "selection_timing", "conditioning_variable", "endpoint_component"])
@pytest.mark.parametrize("support_damage", ["missing", "malformed", "unanchored"])
def test_negative_requires_its_own_valid_source_support(tmp_path, monkeypatch, negative, support_damage):
    first = payload()
    row = first["primary_analysis_alignment"][0]
    details = row["verification"]
    if negative in {"endpoint", "endpoint_component"}:
        support = details["source_endpoint_definition"]
        if negative == "endpoint":
            details["endpoint_relation"] = "different"
        else:
            details["components"][0]["relation"] = "extra"
    elif negative == "conditioning_variable":
        support = details["conditioning_variables"][0]
        support["timing"] = "postrandomization"
    else:
        support = details["estimand_support"]
        field = "estimand_relation" if negative == "estimand" else negative
        details[field] = {"estimand": "mismatch", "randomized_comparison": False,
            "postrandomization_conditioning": True, "selection_timing": "postrandomization"}[negative]
    if support_damage == "missing":
        del support["quote"]
    elif support_damage == "malformed":
        support["quote"] = {"text": SOURCE}
    else:
        support["quote"] = "An unsupported invented quotation."
    del row["contrast"]["rationale"]
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [json.dumps(first), json.dumps(payload())])
    assert len(calls) == 2
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert all(item.get("retained_clinical_judgments", []) == [] for item in observations)


def test_completed_empty_observation_does_not_clear_prior_incomplete_history(tmp_path, monkeypatch):
    first = payload()
    first["primary_analysis_alignment"][0]["contrast"]["status"] = "mismatch"
    del first["primary_analysis_alignment"][1]["contrast"]["rationale"]
    project, result, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(first)])
    _, retried, _, observations = run_provider(tmp_path, monkeypatch,
        [None, json.dumps(payload())], candidate=result, project=project)
    assert recover_issue_history(project, retried, 0) == ([], False)
    assert alignment_status(project, protocol(), retried, 0)["status"] == "unknown"
    assert any(item.get("raw_response") and item["raw_response"]["content"] is None for item in observations)


@pytest.mark.parametrize("negative", ["contrast", "endpoint", "estimand"])
def test_complete_negative_survives_post_observation_usage_failure(tmp_path, monkeypatch, negative):
    first = payload()
    row = first["primary_analysis_alignment"][0]
    if negative == "contrast":
        row["contrast"]["status"] = "mismatch"
    elif negative == "endpoint":
        row["verification"]["endpoint_relation"] = "different"
    else:
        row["verification"]["estimand_relation"] = "mismatch"
    raw = json.dumps(first)
    bad_usage = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=raw), finish_reason="stop")],
                               usage={"prompt_tokens": 1, "completion_tokens": "unknown", "total_tokens": 2})
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [bad_usage, json.dumps(payload())])
    assert len(calls) == 1
    assert recover_issue_history(project, result, 0) == ([], False)
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    records = [item for item in observations if "raw_response" in item]
    assert len(records) == 1
    assert records[0]["raw_response"]["content"] == raw
    assert records[0]["raw_response"]["provider_response_ordinal"] == 1
    assert records[0]["response"] is not None and records[0]["retained_clinical_judgments"]
    restored = ExtractedStudy.model_validate(project.load_json("trial-paper.json", subdir="extraction"))
    _, retried, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())], candidate=restored, project=project)
    assert recover_issue_history(project, retried, 0) == ([], False)
    assert alignment_status(project, protocol(), retried, 0)["reason"] == "verification_issue_history_required"


def test_provider_fault_before_any_negative_keeps_normal_bounded_retry(tmp_path, monkeypatch):
    project, result, calls, observations = run_provider(tmp_path, monkeypatch,
        [RuntimeError("synthetic fault before any observation"), json.dumps(payload())])
    assert len(calls) == 2
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert recover_issue_history(project, result, 0) == ([], True)
    assert len([item for item in observations if "raw_response" in item]) == 1
