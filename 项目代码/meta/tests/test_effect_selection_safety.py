import logging

import pytest

from new_meta.engines import meta_engine
from new_meta.engines.effect_size import correlation_fisher_z, proportion_freeman_tukey
from new_meta.main import _dedupe_primary_effect_candidates
from new_meta.schemas.meta_result import StudyEffect
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _study(study_id: str) -> ExtractedStudy:
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id=study_id,
            title=f"Trial {study_id}",
            authors=[f"{study_id} Author"],
            year=2020,
        ),
        outcomes=[],
    )


def test_primary_effect_dedupe_keeps_distinct_studies_with_same_arm_totals() -> None:
    outcome_a = OutcomeData(
        outcome_name="mortality",
        outcome_type="dichotomous",
        events_intervention=1,
        total_intervention=50,
        events_control=2,
        total_control=50,
        source_quote_verified=True,
    )
    outcome_b = outcome_a.model_copy(deep=True)
    candidates = [
        (_study("S1"), outcome_a, StudyEffect(study_id="S1", study_label="Trial S1", yi=-0.2, vi=0.04, se=0.2)),
        (_study("S2"), outcome_b, StudyEffect(study_id="S2", study_label="Trial S2", yi=-0.1, vi=0.05, se=0.22)),
    ]

    effects = _dedupe_primary_effect_candidates(candidates, logging.getLogger("test"))

    assert {effect.study_id for effect in effects} == {"S1", "S2"}


def test_correlation_and_proportion_are_back_transformed_for_reporting() -> None:
    z, _ = correlation_fisher_z(0.42, 30)
    assert meta_engine._to_original(z, "COR") == pytest.approx(0.42)

    yi, vi = proportion_freeman_tukey(30, 100)
    assert meta_engine._to_original(yi, "PROP", vi) == pytest.approx(0.30, abs=0.01)
