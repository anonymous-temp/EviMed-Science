"""Source-reported adjustment metadata follows the existing verified repair path."""

import hashlib

import pytest
from pydantic import ValidationError

from new_meta.agents.data_extraction_agent import DataExtractionAgent, ExtractionCheckResult, ExtractionRefinement
from new_meta.core.extraction_verification import numeric_fields
from new_meta.core.primary_analysis_alignment import alignment_status, row_fingerprint
from new_meta.schemas.study import OutcomeData
from test_extraction_verification import SOURCE, checked_row, protocol, run_verifier, study


ADJUSTMENT_QUOTE = "The treatment model adjusted only for baseline eGFR and included the randomized cohort."


def _issue(field):
    return {
        "outcome_index": 0, "field": field,
        "kind": "missing_value" if field == "adjustment_covariates" else "incorrect_metadata",
        "rationale": "The reported analysis adjustment must be retained for this result.",
        "quote": ADJUSTMENT_QUOTE, "source_location": "Methods",
    }


def _checked(*fields):
    return ExtractionCheckResult(score=10, data_issues=[_issue(field) for field in fields],
                                 primary_analysis_alignment=[checked_row()])


def _correction(**fields):
    return {"outcomes": [{"outcome_index": 0, "outcome": {
        "outcome_type": "time_to_event", "comparative_design": "", **fields,
    }}]}


def test_actual_refinement_repairs_adjustment_metadata_before_a_fresh_source_check(tmp_path, monkeypatch):
    repairs = []

    def refine_response(self, prompt, schema, **kwargs):
        assert schema is ExtractionRefinement
        assert ADJUSTMENT_QUOTE in prompt
        repairs.append(prompt)
        return schema.model_validate(_correction(
            reported_effect_adjusted=True, adjustment_covariates=["baseline eGFR"],
        ))

    monkeypatch.setattr(DataExtractionAgent, "call_llm_structured", refine_response)
    candidate = study()
    original_values = numeric_fields(candidate.outcomes[0])
    project, result, checks = run_verifier(tmp_path, monkeypatch,
        [_checked("reported_effect_adjusted", "adjustment_covariates"), _checked()], candidate=candidate)

    assert len(repairs) == 1 and len(checks) == 2
    assert result.outcomes[0].reported_effect_adjusted is True
    assert result.outcomes[0].adjustment_covariates == ["baseline eGFR"]
    assert numeric_fields(result.outcomes[0]) == original_values
    assert result.outcomes[0].outcome_name == candidate.outcomes[0].outcome_name
    assert result.characteristics == candidate.characteristics
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    assert result.outcomes[0].primary_analysis_alignment.unresolved_data_issues == []
    import json
    observations = [json.loads(path.read_text()) for path in (project.base_dir / "extraction/verification").glob("*.json")]
    initial = next(row for row in observations if row.get("status") == "observed" and row["attempt"] == 1)
    assert {row["field"] for row in initial["retained_data_issues"]} == {
        "reported_effect_adjusted", "adjustment_covariates",
    }
    assert all(row["repairable"] for row in initial["retained_data_issues"])


@pytest.mark.parametrize("fields", [
    {"reported_effect_adjusted": "false"}, {"reported_effect_adjusted": 0},
    {"reported_effect_adjusted": 1}, {"reported_effect_adjusted": None},
    {"adjustment_covariates": None}, {"adjustment_covariates": "baseline age"},
    {"adjustment_covariates": {"age": "baseline"}}, {"adjustment_covariates": [None]},
    {"adjustment_covariates": [2]}, {"adjustment_covariates": [""]},
    {"adjustment_covariates": ["  "]},
])
def test_unsafe_adjustment_corrections_fail_before_legacy_coercion(fields):
    with pytest.raises(ValidationError):
        ExtractionRefinement.model_validate(_correction(**fields))


@pytest.mark.parametrize("value", [False, True])
def test_explicit_boolean_correction_is_not_confused_with_a_missing_value(monkeypatch, value):
    candidate = study()
    candidate.outcomes[0].reported_effect_adjusted = not value
    candidate.outcomes[0].adjustment_covariates = ["baseline age"]
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kwargs:
                        schema.model_validate(_correction(reported_effect_adjusted=value)))
    result = agent._refine_extraction(SOURCE, candidate, _checked("reported_effect_adjusted"), protocol())
    assert result.outcomes[0].reported_effect_adjusted is value
    assert result.outcomes[0].adjustment_covariates == ["baseline age"]
    assert numeric_fields(result.outcomes[0]) == numeric_fields(candidate.outcomes[0])


def test_omitted_metadata_fields_never_clear_existing_values(monkeypatch):
    candidate = study()
    candidate.outcomes[0].reported_effect_adjusted = True
    candidate.outcomes[0].adjustment_covariates = ["baseline age", "baseline disease severity"]
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kwargs:
                        schema.model_validate(_correction()))
    result = agent._refine_extraction(SOURCE, candidate, _checked(), protocol())
    assert result.model_dump(mode="json") == candidate.model_dump(mode="json")


def test_legacy_null_covariates_remain_loadable_but_absence_is_not_explicit():
    legacy = OutcomeData.model_validate({"adjustment_covariates": None})
    missing = OutcomeData.model_validate({})
    assert legacy.adjustment_covariates == []
    assert "adjustment_covariates" not in missing.model_fields_set
    assert legacy.model_dump(mode="json") == missing.model_dump(mode="json")


def test_metadata_repair_invalidates_old_positive_proof_until_fresh_verification(tmp_path, monkeypatch):
    project, approved, _ = run_verifier(tmp_path, monkeypatch, [_checked()])
    assert alignment_status(project, protocol(), approved, 0)["status"] == "match"
    old_proof = approved.outcomes[0].primary_analysis_alignment
    old_fingerprint = row_fingerprint(approved, 0)
    proof_path = project.base_dir / "extraction/primary_alignment" / f"{old_proof.proof_id}.json"
    proof_bytes = proof_path.read_bytes()
    raw_before = {path: path.read_bytes() for path in (project.base_dir / "extraction/verification/raw").glob("*.json")}
    agent = DataExtractionAgent()
    monkeypatch.setattr(agent, "call_llm_structured", lambda prompt, schema, **kwargs:
                        schema.model_validate(_correction(
                            reported_effect_adjusted=True, adjustment_covariates=["baseline eGFR"])))
    revised = agent._refine_extraction(SOURCE, approved, _checked("adjustment_covariates"), protocol())

    assert row_fingerprint(revised, 0) != old_fingerprint
    assert revised.outcomes[0].primary_analysis_alignment == old_proof
    assert alignment_status(project, protocol(), revised, 0)["status"] == "unknown"
    # Even copying that unchanged old proof to the revised checkpoint cannot
    # authorize the new payload. Only the actual fresh source-check path can.
    project.save_json("trial-paper.json", revised, subdir="extraction")
    assert alignment_status(project, protocol(), revised, 0)["status"] == "unknown"
    from extraction_source_fixture import observed_check
    monkeypatch.setattr(agent, "_check_extraction", lambda text, current, current_protocol, indices, feedback, observe, catalogue:
                        observed_check(_checked(), text, observe, catalogue))
    source_path = project.base_dir / "papers/source.txt"
    verified = agent._verify_alignment(revised, {"fulltext_path": str(source_path)},
        {"full_text": SOURCE, "_source_sha256": hashlib.sha256(SOURCE.encode()).hexdigest()}, protocol(), project)
    assert alignment_status(project, protocol(), verified, 0)["status"] == "match"
    assert verified.outcomes[0].primary_analysis_alignment.proof_id != old_proof.proof_id
    assert proof_path.read_bytes() == proof_bytes
    assert all(path.read_bytes() == data for path, data in raw_before.items())
    assert numeric_fields(verified.outcomes[0]) == numeric_fields(approved.outcomes[0])


@pytest.mark.parametrize("field", ["reported_effect_adjusted", "adjustment_covariates"])
def test_adjustment_source_conflict_is_not_resolved_by_automatic_refinement(tmp_path, monkeypatch, field):
    checked = _checked(field)
    checked.data_issues[0].kind = "source_conflict"

    def forbidden(*args, **kwargs):
        pytest.fail("A source conflict must not trigger automatic metadata repair")

    monkeypatch.setattr(DataExtractionAgent, "call_llm_structured", forbidden)
    project, result, checks = run_verifier(tmp_path, monkeypatch, [checked])
    assert len(checks) == 1
    assert result.outcomes[0].reported_effect_adjusted is False
    assert result.outcomes[0].adjustment_covariates == []
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"
    assert result.outcomes[0].primary_analysis_alignment.unresolved_data_issues[0].issue.kind == "source_conflict"
