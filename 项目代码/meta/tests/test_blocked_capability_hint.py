"""A blocked plan should say which narrower eligibility would run."""
from new_meta.core.method_registry import default_method_registry
from new_meta.schemas.method_policy import ReviewDesignSpec, ReviewFamily


def _spec(designs: list[str]) -> ReviewDesignSpec:
    return ReviewDesignSpec(
        review_id="r1",
        protocol_version="1",
        family=ReviewFamily.INTERVENTION_NRSI,
        study_designs=designs,
        outcome_type="dichotomous",
        requested_effect_measure="HR",
        requested_model="random",
    )


def test_cohort_only_nrsi_runs_on_the_production_capability() -> None:
    plan = default_method_registry().compile(_spec(["cohort"]))
    assert plan.execution_allowed is True
    assert plan.capability_id == "intervention_nrsi.adjusted_cohort_reml"


def test_one_unvalidated_design_blocks_and_names_the_alternative() -> None:
    plan = default_method_registry().compile(_spec(["case_control", "cohort"]))
    assert plan.execution_allowed is False
    assert any("production validated" in reason for reason in plan.blocking_reasons)
    assert any("intervention_nrsi.adjusted_cohort_reml" in reason for reason in plan.blocking_reasons)


def test_a_family_with_no_narrower_capability_gets_no_hint() -> None:
    plan = default_method_registry().compile(_spec(["interrupted_time_series"]))
    assert plan.execution_allowed is False
    assert not any("production validated" in reason for reason in plan.blocking_reasons)
