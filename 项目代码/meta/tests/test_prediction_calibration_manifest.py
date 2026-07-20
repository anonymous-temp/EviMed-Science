from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.schemas.method_policy import CapabilityStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _prediction_protocol(*, outcome_type: str, measure: str) -> ResearchProtocol:
    return ResearchProtocol(
        research_question="How well does Model X perform in external validation?",
        pico=PICO(
            population="Adults",
            intervention="Model X",
            comparator="Observed outcomes",
            outcome_primary="30-day mortality",
        ),
        review_family="prediction_model",
        study_designs=["external validation"],
        primary_outcome_type=outcome_type,
        effect_measure=measure,
        model_preference="random",
    )


def test_prediction_metric_capabilities_route_by_exact_metric(tmp_path) -> None:
    cstat = compile_project_method_plan(
        Project("cstat", output_dir=tmp_path / "cstat"),
        _prediction_protocol(outcome_type="discrimination", measure="C_STATISTIC"),
        enforce=True,
    )
    oe = compile_project_method_plan(
        Project("oe", output_dir=tmp_path / "oe"),
        _prediction_protocol(outcome_type="calibration", measure="OE_RATIO"),
        enforce=True,
    )
    slope = compile_project_method_plan(
        Project("slope", output_dir=tmp_path / "slope"),
        _prediction_protocol(outcome_type="calibration", measure="CALIBRATION_SLOPE"),
        enforce=True,
    )
    brier = compile_project_method_plan(
        Project("brier", output_dir=tmp_path / "brier"),
        _prediction_protocol(outcome_type="overall_performance", measure="BRIER"),
    )

    assert cstat.capability_id == "prediction_model.external_cstat_reml"
    assert cstat.capability_status is CapabilityStatus.PRODUCTION
    assert oe.capability_id == "prediction_model.external_oe_reml"
    assert oe.capability_status is CapabilityStatus.PRODUCTION
    assert slope.capability_id == "prediction_model.external_calibration_slope_reml"
    assert slope.capability_status is CapabilityStatus.PRODUCTION
    assert brier.capability_id == "prediction_model.other_performance"
    assert brier.capability_status is CapabilityStatus.BLOCKED
