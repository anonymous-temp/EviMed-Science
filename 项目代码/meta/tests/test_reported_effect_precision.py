"""Reported time-to-event precision must not be replaced by event-table precision."""
import json
import logging
import math

import pytest

from new_meta.core.extraction_ledger import _result_data
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.project import Project
from new_meta.core.effect_selection import compute_study_effect
from new_meta.core.method_planning import validate_protocol_method
from new_meta.core.synthesis_routing import compile_synthesis_route, SynthesisRoute
from new_meta.core.rct_design_reconciliation import (
    comparative_effect_from_outcome,
    reconcile_extracted_rct_designs,
)
from new_meta.engines.complex_rct import ComplexRCTRecord, run_complex_rct
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.evidence_ledger import ResultEntity
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _protocol(measure="HR"):
    return ResearchProtocol(
        research_question="Does Drug reduce time to disease progression?",
        pico=PICO(population="Adults", intervention="Drug", comparator="Placebo",
                  outcome_primary="Disease progression"),
        review_family="intervention_rct", study_designs=["parallel RCT"],
        primary_outcome_type="time_to_event" if measure == "HR" else "dichotomous",
        effect_measure=measure,
    )


def _outcome(*, counts=True, scale="original", precision="ci", measure="HR", **updates):
    value = math.log(0.72) if scale == "log" else 0.72
    lower, upper = (math.log(0.54), math.log(0.96)) if scale == "log" else (0.54, 0.96)
    payload = dict(
        outcome_name="Disease progression", outcome_type="time_to_event",
        effect_size=value, reported_effect_measure=measure, reported_effect_scale=scale,
        ci_lower=lower if precision == "ci" else None,
        ci_upper=upper if precision == "ci" else None,
        reported_effect_standard_error=0.17 if precision == "se" else None,
        source_quote="The source reports an adjusted hazard ratio of 0.72 (0.54 to 0.96).",
        source_quote_verified=True, treatment_arm="Drug", reference_arm="Placebo",
    )
    if counts:
        payload.update(events_intervention=12, total_intervention=100,
                       events_control=30, total_control=100)
    payload.update(updates)
    return OutcomeData(**payload)


def _study(*outcomes, study_id="S1"):
    return ExtractedStudy(
        characteristics=StudyCharacteristics(study_id=study_id, study_design="parallel RCT",
                                             intervention_description="Drug", control_description="Placebo"),
        outcomes=list(outcomes),
    )


@pytest.mark.parametrize("counts", [True, False])
@pytest.mark.parametrize("scale", ["original", "log"])
@pytest.mark.parametrize("precision", ["ci", "se"])
def test_reported_hr_survives_reconciliation_and_ledger(counts, scale, precision):
    protocol = _protocol()
    outcome = _outcome(counts=counts, scale=scale, precision=precision)
    report = reconcile_extracted_rct_designs(protocol, [_study(outcome)])
    assert report["comparative_rows"] == 1
    assert outcome.precision_basis == "source_reported_effect"
    data, effect = _result_data(outcome, protocol)
    assert data.data_type == "comparative_effect"
    assert effect.measure == "HR"
    assert effect.estimate == outcome.effect_size
    assert effect.scale == scale
    assert effect.ci_lower == outcome.ci_lower
    assert effect.ci_upper == outcome.ci_upper
    assert effect.standard_error == outcome.reported_effect_standard_error
    assert effect.variance is None


@pytest.mark.parametrize("scale", ["original", "log"])
@pytest.mark.parametrize("precision", ["ci", "se"])
def test_ordinary_hr_keeps_reported_precision_before_ancillary_counts(scale, precision):
    outcome = _outcome(scale=scale, precision=precision)
    data, effect = _result_data(outcome, _protocol())
    assert data is None
    assert effect.measure == "HR"
    assert effect.estimate == outcome.effect_size
    assert effect.scale == scale
    assert effect.standard_error == outcome.reported_effect_standard_error


@pytest.mark.parametrize("precision", ["ci", "se"])
@pytest.mark.parametrize("reconcile", [False, True])
def test_typed_hr_alias_keeps_source_reported_precision(precision, reconcile):
    outcome = _outcome(effect_size=None, ci_lower=None, ci_upper=None,
                       reported_effect_measure="", hazard_ratio=0.72,
                       hr_ci_lower=0.54 if precision == "ci" else None,
                       hr_ci_upper=0.96 if precision == "ci" else None,
                       hr_se=0.17 if precision == "se" else None)
    protocol = _protocol()
    if reconcile:
        reconcile_extracted_rct_designs(protocol, [_study(outcome)])
    _, effect = _result_data(outcome, protocol)
    assert effect.measure == "HR"
    assert effect.estimate == 0.72
    assert effect.standard_error == outcome.hr_se


@pytest.mark.parametrize("updates", [
    {"effect_size": None, "ci_lower": None, "ci_upper": None},
    {"ci_lower": None, "ci_upper": None},
    {"source_quote_verified": False},
    {"ci_lower": 0.96, "ci_upper": 0.54},
    {"reported_effect_scale": "unknown"},
])
def test_hr_without_verified_valid_precision_never_synthesizes_counts(updates):
    # Historical objects can reach migration after mutation without schema revalidation.
    outcome = _outcome().model_copy(update=updates)
    protocol = _protocol()
    with pytest.raises(ValueError):
        comparative_effect_from_outcome(outcome, protocol)
    data, effect = _result_data(outcome, protocol)
    assert effect is None
    assert data.data_type == "unstructured"
    reconcile_extracted_rct_designs(protocol, [_study(outcome)])
    assert outcome.precision_basis != "computed_from_source_verified_2x2"


@pytest.mark.parametrize("scale", ["original", "log"])
@pytest.mark.parametrize("updates", [
    {"hazard_ratio": 0.61}, {"hr_ci_lower": 0.4}, {"hr_ci_upper": 1.1},
    {"reported_effect_standard_error": 0.17, "hr_se": 0.3},
])
def test_conflicting_dual_hr_representations_stay_unpooled(scale, updates):
    outcome = _outcome(scale=scale, **updates)
    with pytest.raises(ValueError):
        comparative_effect_from_outcome(outcome, _protocol())
    data, effect = _result_data(outcome, _protocol())
    assert effect is None
    assert data.data_type == "unstructured"


@pytest.mark.parametrize("scale", ["original", "log"])
def test_matching_dual_hr_representations_preserve_canonical_scale(scale):
    outcome = _outcome(scale=scale, hazard_ratio=0.72, hr_ci_lower=0.54, hr_ci_upper=0.96)
    effect = comparative_effect_from_outcome(outcome, _protocol())
    assert effect["estimate"] == outcome.effect_size
    assert effect["scale"] == scale


def test_typed_hr_with_declared_measure_is_not_lost_when_generic_value_is_absent():
    outcome = _outcome(effect_size=None, ci_lower=None, ci_upper=None,
                       hazard_ratio=0.72, hr_ci_lower=0.54, hr_ci_upper=0.96)
    _, effect = _result_data(outcome, _protocol())
    assert effect.estimate == 0.72


def test_legacy_hr_is_not_relabelled_as_protocol_rr():
    outcome = _outcome(effect_size=None, reported_effect_measure="", hazard_ratio=0.72,
                       hr_ci_lower=0.54, hr_ci_upper=0.96)
    with pytest.raises(ValueError, match="reported HR does not match"):
        comparative_effect_from_outcome(outcome, _protocol("RR"))
    data, effect = _result_data(outcome, _protocol("RR"))
    assert effect is None
    assert data.data_type == "unstructured"


@pytest.mark.parametrize("representation", ["canonical", "legacy"])
def test_reconciliation_and_ledger_cannot_replace_hr_with_protocol_rr(tmp_path, representation):
    outcome = _outcome()
    if representation == "legacy":
        outcome = _outcome(effect_size=None, reported_effect_measure="", hazard_ratio=0.72,
                           hr_ci_lower=0.54, hr_ci_upper=0.96)
    protocol = _protocol("RR")
    study = _study(outcome)
    with pytest.raises(ValueError, match="reported HR does not match"):
        comparative_effect_from_outcome(outcome, protocol)
    reconcile_extracted_rct_designs(
        protocol, [study], parsed_papers={"S1": {"full_text": "Risk ratio 0.40; 95% CI 0.20–0.80."}},
    )
    assert outcome.precision_basis != "computed_from_source_verified_2x2"
    assert outcome.effect_size == (0.72 if representation == "canonical" else None)
    assert outcome.hazard_ratio == (0.72 if representation == "legacy" else None)
    project = Project("HR cannot become RR", output_dir=tmp_path / "project")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    ledger = EvidenceLedger(migration.ledger_path, review_id=migration.review_id)
    result = ledger.current(migration.result_ids[0], model=ResultEntity)
    assert result.estimate is None
    assert result.raw_data.data_type == "unstructured"


@pytest.mark.parametrize("measure", ["RR", "OR", "RD"])
def test_unadjusted_count_effect_retains_compatible_count_crosscheck(measure):
    protocol = _protocol(measure)
    outcome = _outcome(measure=measure, outcome_type="dichotomous")
    effect = comparative_effect_from_outcome(outcome, protocol)
    expected = {"RR": 0.4, "OR": (12 / 88) / (30 / 70), "RD": -0.18}[measure]
    assert effect["estimate"] == pytest.approx(expected)
    assert effect["variance"] > 0


def test_log_scale_crude_rr_is_compared_on_its_original_scale():
    outcome = _outcome(measure="RR", scale="log", effect_size=math.log(0.4),
                       ci_lower=math.log(0.2), ci_upper=math.log(0.8))
    effect = comparative_effect_from_outcome(outcome, _protocol("RR"))
    assert effect["estimate"] == math.log(0.4)
    assert effect["scale"] == "log"
    assert effect["variance"] is None


@pytest.mark.parametrize("reconcile", [False, True])
def test_adjusted_rr_is_not_replaced_by_crude_event_count_rr(reconcile):
    outcome = _outcome(measure="RR", reported_effect_adjusted=True,
                       adjustment_covariates=["age", "baseline severity"])
    protocol = _protocol("RR")
    if reconcile:
        reconcile_extracted_rct_designs(protocol, [_study(outcome)])
    _, effect = _result_data(outcome, protocol)
    assert effect.estimate == 0.72
    assert effect.adjusted is True
    assert effect.adjusted_covariates == ["age", "baseline severity"]


def test_adjusted_rr_without_precision_does_not_fall_back_to_crude_counts():
    outcome = _outcome(measure="RR", reported_effect_adjusted=True,
                       ci_lower=None, ci_upper=None)
    data, effect = _result_data(outcome, _protocol("RR"))
    assert effect is None
    assert data.data_type == "unstructured"


@pytest.mark.parametrize("measure, adjusted", [("HR", False), ("RR", True)])
def test_multi_arm_reported_effect_does_not_invent_count_covariance(measure, adjusted):
    protocol = _protocol(measure)
    left = _outcome(measure=measure, reported_effect_adjusted=adjusted, treatment_arm="Drug low")
    right = _outcome(measure=measure, reported_effect_adjusted=adjusted, treatment_arm="Drug high")
    other = _outcome(measure=measure, reported_effect_adjusted=adjusted)
    studies = [_study(left, right), _study(other, study_id="S2")]
    reconcile_extracted_rct_designs(protocol, studies)
    assert left.comparative_design == right.comparative_design == "multi_arm_rct"
    assert left.covariance_with == right.covariance_with == {}
    records = []
    for study in studies:
        for outcome in study.outcomes:
            data, effect = _result_data(outcome, protocol)
            records.append(ComplexRCTRecord(
                result_id=outcome.contrast_id, study_id=study.characteristics.study_id,
                **data.model_dump(exclude={"data_type"}),
                **effect.model_dump(exclude={"adjusted", "adjusted_covariates"}),
            ))
    with pytest.raises(ValueError, match="requires explicit covariance"):
        run_complex_rct(records)


@pytest.mark.parametrize("scale", ["original", "log"])
def test_actual_engine_derives_hr_precision_from_ci_independently_of_event_counts(scale):
    protocol = _protocol()
    pooled = []
    for events in (1, 90):
        studies = [
            _study(_outcome(scale=scale, events_intervention=events), study_id="S1"),
            _study(_outcome(scale=scale, events_intervention=events), study_id="S2"),
        ]
        reconcile_extracted_rct_designs(protocol, studies)
        records = []
        for study in studies:
            data, effect = _result_data(study.outcomes[0], protocol)
            assert effect.standard_error is None
            records.append(ComplexRCTRecord(
                result_id=study.outcomes[0].contrast_id, study_id=study.characteristics.study_id,
                **data.model_dump(exclude={"data_type"}),
                **effect.model_dump(exclude={"adjusted", "adjusted_covariates"}),
            ))
        result = run_complex_rct(records)
        expected_se = (math.log(0.96) - math.log(0.54)) / (2 * 1.959963984540054)
        assert result.measure == "HR"
        assert result.pooled_effect == pytest.approx(0.72)
        for row in result.study_effects:
            assert row["analysis_effect"] == pytest.approx(math.log(0.72))
            assert row["variance"] == pytest.approx(expected_se ** 2)
        pooled.append(result.model_dump())
    assert pooled[0] == pooled[1]


@pytest.mark.parametrize("prior_precision", [
    "computed_from_source_verified_2x2", "source_reported_effect",
])
def test_historical_adjusted_count_covariance_is_retired_after_checkpoint_reload(tmp_path, prior_precision):
    protocol = _protocol("RR")
    reported_values = (
        {"effect_size": 0.4, "ci_lower": 0.2, "ci_upper": 0.8}
        if prior_precision == "source_reported_effect"
        else {"effect_size": 0.72, "ci_lower": 0.50, "ci_upper": 1.03}
    )
    studies = [
        _study(*[_outcome(measure="RR", reported_effect_adjusted=True, treatment_arm=arm, **reported_values)
                 for arm in ("Drug low", "Drug high")]),
        _study(_outcome(measure="RR", reported_effect_adjusted=True), study_id="S2"),
    ]
    reconcile_extracted_rct_designs(protocol, studies)
    left, right = studies[0].outcomes
    # Both labels were produced by the former reconciler, which unconditionally
    # derived shared-control covariance even for source-reported adjusted effects.
    old_covariance = 1 / 30 - 1 / 100
    for outcome in (left, right):
        outcome.precision_basis = prior_precision
    left.covariance_with[right.contrast_id] = old_covariance
    right.covariance_with[left.contrast_id] = old_covariance
    checkpoint = tmp_path / "extractions.json"
    checkpoint.write_text(json.dumps([study.model_dump(mode="json") for study in studies]))
    preserved = checkpoint.read_bytes()
    reloaded = [ExtractedStudy.model_validate(item) for item in json.loads(preserved)]
    report = reconcile_extracted_rct_designs(protocol, reloaded)
    assert checkpoint.read_bytes() == preserved
    left, right = reloaded[0].outcomes
    assert left.covariance_with == right.covariance_with == {}
    assert report["retired_count_covariances"][0]["covariance"] == old_covariance
    assert left.precision_basis == right.precision_basis == "source_reported_effect"
    first_retirement = report["retired_count_covariances"]
    report_path = tmp_path / "rct_design_reconciliation.json"
    report_path.write_text(json.dumps(report))
    resumed_checkpoint = tmp_path / "resumed-extractions.json"
    resumed_checkpoint.write_text(json.dumps([study.model_dump(mode="json") for study in reloaded]))
    reloaded = [ExtractedStudy.model_validate(item) for item in json.loads(resumed_checkpoint.read_text())]
    # The production orchestrator rewrites the report after reconciling the saved
    # extraction again. Originals must survive that overwrite, not just one return.
    report_path.write_text(json.dumps(reconcile_extracted_rct_designs(protocol, reloaded)))
    assert json.loads(report_path.read_text())["retired_count_covariances"] == first_retirement
    for outcome in reloaded[0].outcomes:
        notes = [note for note in outcome.conflicts if "legacy_covariance_retirement" in note.observed_values]
        assert len(notes) == 1
        assert notes[0].observed_values["legacy_covariance_retirement"]["covariance"] == old_covariance
        assert notes[0].severity == "warning"
    records = []
    for study in reloaded:
        for outcome in study.outcomes:
            data, effect = _result_data(outcome, protocol)
            records.append(ComplexRCTRecord(
                result_id=outcome.contrast_id, study_id=study.characteristics.study_id,
                **data.model_dump(exclude={"data_type"}),
                **effect.model_dump(exclude={"adjusted", "adjusted_covariates"}),
            ))
    with pytest.raises(ValueError, match="requires explicit covariance"):
        run_complex_rct(records)


def test_distinct_reported_adjusted_covariance_is_preserved():
    protocol = _protocol("RR")
    left, right = [_outcome(measure="RR", reported_effect_adjusted=True, treatment_arm=arm)
                   for arm in ("Drug low", "Drug high")]
    study = _study(left, right)
    reconcile_extracted_rct_designs(protocol, [study])
    left.covariance_with[right.contrast_id] = 0.002
    right.covariance_with[left.contrast_id] = 0.002
    report = reconcile_extracted_rct_designs(protocol, [study])
    assert left.covariance_with[right.contrast_id] == 0.002
    assert right.covariance_with[left.contrast_id] == 0.002
    assert report["retired_count_covariances"] == []


@pytest.mark.parametrize("measure, adjusted", [("HR", False), ("RR", True)])
@pytest.mark.parametrize("scale", ["original", "log"])
@pytest.mark.parametrize("precision", ["ci", "se"])
def test_actual_pairwise_route_preserves_reported_precision(measure, adjusted, scale, precision):
    protocol = _protocol(measure)
    route = compile_synthesis_route(validate_protocol_method(protocol))
    assert route.route is SynthesisRoute.PAIRWISE_AGGREGATE
    observed = []
    for events in (1, 90):
        outcome = _outcome(
            measure=measure, reported_effect_adjusted=adjusted, scale=scale, precision=precision,
            events_intervention=events,
            outcome_type="time_to_event" if measure == "HR" else "dichotomous",
        )
        study = _study(outcome)
        reconcile_extracted_rct_designs(protocol, [study])
        effect = compute_study_effect(study, outcome, protocol, logging.getLogger(__name__))
        assert effect is not None
        expected_se = (math.log(0.96) - math.log(0.54)) / 3.92 if precision == "ci" else 0.17
        assert effect.yi == pytest.approx(math.log(0.72))
        assert effect.vi == pytest.approx(expected_se ** 2)
        observed.append(effect.model_dump())
    assert observed[0] == observed[1]


@pytest.mark.parametrize("updates", [
    {"ci_lower": None, "ci_upper": None},
    {"hazard_ratio": 0.4},
    {"source_quote_verified": False},
])
def test_pairwise_reported_hr_still_requires_unambiguous_source_precision(updates):
    outcome = _outcome(**updates)
    audit = {}
    effect = compute_study_effect(_study(outcome), outcome, _protocol(), logging.getLogger(__name__), audit_row=audit)
    assert effect is None
    assert audit["reason"] == "reported_effect_precision_requires_adjudication"
    assert audit["requires_adjudication"] is True
