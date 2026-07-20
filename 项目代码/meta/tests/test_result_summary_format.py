from new_meta.main import _format_pet_peese_summary
from new_meta.schemas.meta_result import PublicationBiasResult


def test_pet_peese_summary_reports_ratio_measure_on_original_scale() -> None:
    summary = _format_pet_peese_summary(
        PublicationBiasResult(pet_intercept=-0.7197, pet_p_value=0.0072),
        effect_measure="OR",
    )

    assert summary == "  PET-PEESE adjusted OR: 0.487 (log OR=-0.7197; PET p=0.0072)"


def test_pet_peese_summary_reports_continuous_measure_without_log_transform() -> None:
    summary = _format_pet_peese_summary(
        PublicationBiasResult(pet_intercept=-1.25, pet_p_value=0.1101),
        effect_measure="MD",
    )

    assert summary == "  PET-PEESE adjusted MD: -1.2500 (PET p=0.1101)"
