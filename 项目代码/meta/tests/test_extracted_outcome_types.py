"""A closed generation vocabulary must not reinterpret historical outcome rows."""
from copy import deepcopy
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from new_meta.engines.effect_size import EffectInputMismatch, compute_effect_size
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


FIXTURE = Path(__file__).parent / "fixtures/extracted_outcome_type_unknown.json"
CANONICAL = {
    "dichotomous", "continuous", "time_to_event", "proportion", "correlation", "count",
    "incidence_rate", "diagnostic_accuracy", "discrimination", "calibration", "overall_performance",
}
LEGACY_COMPATIBILITY = {
    "dichotomous": {"OR", "RR", "RD", "IRR"}, "binary": {"OR", "RR", "RD", "IRR"},
    "continuous": {"MD", "SMD"}, "time_to_event": {"HR"}, "proportion": {"PROP"},
    "correlation": {"COR"}, "count": {"IRR"}, "incidence_rate": {"IRR"},
}


def test_new_outcome_schema_requires_one_closed_statistical_type():
    from new_meta.schemas.extracted_outcome import ExtractedOutcomeData
    from new_meta.schemas.outcome_types import CANONICAL_EXTRACTION_OUTCOME_TYPES

    schema = ExtractedOutcomeData.model_json_schema()
    assert "outcome_type" in schema["required"]
    assert set(schema["properties"]["outcome_type"]["enum"]) == CANONICAL
    assert set(CANONICAL_EXTRACTION_OUTCOME_TYPES) == CANONICAL
    with pytest.raises(ValidationError):
        ExtractedOutcomeData(outcome_name="A supplied endpoint", comparative_design="")


@pytest.mark.parametrize("kind", sorted(CANONICAL))
def test_all_canonical_generation_types_keep_the_existing_row_shape(kind):
    from new_meta.schemas.extracted_outcome import ExtractedOutcomeData

    payload = {"outcome_name": "A disease-specific composite at 36 months", "outcome_type": kind,
               "comparative_design": "",
               "effect_size": 0.38, "ci_lower": 0.12, "ci_upper": 1.22,
               "source_quote": "The reported outcome, including its full qualifiers."}
    generated = ExtractedOutcomeData.model_validate(deepcopy(payload))
    legacy = OutcomeData.model_validate(deepcopy(payload))
    assert generated.model_dump() == legacy.model_dump()
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1"), outcomes=[generated])
    assert study.outcomes[0].outcome_type == kind


@pytest.mark.parametrize("kind", ["", None, "binary", "time-to-event", "survival", "categorical",
                                  "time_event", "time_to_event_composite", "incidence", "any",
                                  " TIME_TO_EVENT ", "calibration_slope", "mystery"])
def test_new_generation_never_guesses_aliases_or_composite_type_suffixes(kind):
    from new_meta.schemas.extracted_outcome import ExtractedOutcomeData

    with pytest.raises(ValidationError):
        ExtractedOutcomeData(outcome_name="A supplied endpoint", outcome_type=kind, comparative_design="")


def test_actual_japanese_unknown_type_is_rejected_only_at_new_generation_boundary():
    from new_meta.schemas.extracted_outcome import ExtractedOutcomeData

    original = FIXTURE.read_bytes()
    payload = json.loads(original)["outcome"]
    legacy = OutcomeData.model_validate(deepcopy(payload))
    assert legacy.outcome_type == "time_to_event_composite"
    assert legacy.effect_size == 0.38 and (legacy.ci_lower, legacy.ci_upper) == (0.12, 1.22)
    assert OutcomeData.model_validate_json(legacy.model_dump_json()).outcome_type == payload["outcome_type"]
    with pytest.raises(ValidationError):
        ExtractedOutcomeData.model_validate({**deepcopy(payload), "comparative_design": ""})
    with pytest.raises(EffectInputMismatch) as caught:
        compute_effect_size(legacy.outcome_type, "HR", effect=legacy.effect_size,
                            ci_lower=legacy.ci_lower, ci_upper=legacy.ci_upper, reported_effect_measure="HR")
    assert caught.value.code == "outcome_type_requires_adjudication"
    assert FIXTURE.read_bytes() == original


def test_canonical_types_cover_declared_compiled_method_families():
    from new_meta.core.method_registry import default_method_registry
    from new_meta.schemas.outcome_types import CANONICAL_EXTRACTION_OUTCOME_TYPES

    registry = default_method_registry()
    supported = {kind for family in registry.families() for kind in registry.plugin(family).supported_outcome_types}
    # "any" is a narrative/compiler wildcard; "binary" remains a legacy alias.
    assert supported - {"any", "binary"} <= set(CANONICAL_EXTRACTION_OUTCOME_TYPES)
    assert {"diagnostic_accuracy", "discrimination", "calibration", "overall_performance", "correlation"} <= CANONICAL


def test_shared_pairwise_table_preserves_the_exact_existing_compatibility_contract():
    from new_meta.schemas.outcome_types import PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE

    assert dict(PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE) == LEGACY_COMPATIBILITY
    with pytest.raises(TypeError):
        PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE["time_to_event_composite"] = frozenset({"HR"})


@pytest.mark.parametrize("kind", sorted(LEGACY_COMPATIBILITY))
@pytest.mark.parametrize("measure", ["OR", "RR", "RD", "IRR", "MD", "SMD", "HR", "PROP", "COR"])
def test_existing_type_measure_admission_is_unchanged(kind, measure):
    arguments = dict(effect=0.7, ci_lower=0.5, ci_upper=0.9, reported_effect_measure=measure)
    if measure in LEGACY_COMPATIBILITY[kind]:
        result = compute_effect_size(kind, measure, **arguments)
        assert len(result) == 2 and all(math.isfinite(value) for value in result)
    else:
        with pytest.raises(EffectInputMismatch) as caught:
            compute_effect_size(kind, measure, **arguments)
        assert caught.value.code == "outcome_type_measure_mismatch"


@pytest.mark.parametrize("kind", ["binary", " BINARY ", "time-to-event", " TIME_TO_EVENT ", "incidence-rate"])
def test_preexisting_engine_normalization_remains_legacy_only(kind):
    normalized = kind.strip().lower().replace("-", "_")
    canonical = "dichotomous" if normalized == "binary" else normalized
    measure = next(iter(LEGACY_COMPATIBILITY[normalized]))
    values = dict(effect=0.7, ci_lower=0.5, ci_upper=0.9, reported_effect_measure=measure)
    assert compute_effect_size(kind, measure, **values) == compute_effect_size(canonical, measure, **values)
    assert OutcomeData(outcome_type=kind).outcome_type == kind
