"""The result a report is written from carries its display strings beside the raw values.

mr-001's report printed "OR 1.53311316166586 (95% CI 1.35097638690072–
1.73980536541073)": the skill wrote from raw floats. The engine now renders
what a report states, once, in mendelian-randomization-run.json.
"""

import json

from evimed_local_inputs import bind_open_metadata
from mr_agent.models import (
    HeterogeneityResult,
    MRAnalysisResult,
    MRPressoCorrection,
    MRResult,
    PleiotopyResult,
)


def _mr001() -> MRAnalysisResult:
    return MRAnalysisResult(
        exposure_id="GCST002783", outcome_id="GCST003116", n_instruments=64,
        f_statistic_mean=70.6173,
        mr_results=[MRResult(
            method="Inverse variance weighted", nsnp=64, beta=0.427300414298957, se=0.0645269559752301,
            pval=3.54262863158619e-11, or_value=1.53311316166586, ci_lower=1.35097638690072,
            ci_upper=1.73980536541073,
        )],
        heterogeneity=[HeterogeneityResult(method="Inverse variance weighted", q=122.738513258264, q_df=63,
                                           q_pval=9.97081339452979e-06)],
        pleiotropy=PleiotopyResult(egger_intercept=-0.00309020421407606, se=0.0044254692048616,
                                   pval=0.487614712674696),
        presso_global_pval=0.00078125, presso_global_pval_relation="<", presso_n_outliers=2,
        presso_correction=MRPressoCorrection(
            n_distributions=1280, outlier_snps=["rs6713510", "rs7903146"], beta=0.465379046529019,
            se=0.0542849452375192, pval=4.57342738512258e-12, or_value=1.5926177507213306, ci_lower=1.4318689569817105,
            ci_upper=1.7714130106286454, distortion_coefficient=-8.18228334817981,
            distortion_pval=0.515625,
        ),
        steiger_correct=True, steiger_pval=1.87713333321068e-192,
        steiger_r2_exposure=0.0140121200698697, steiger_r2_outcome=0.00110962570138499,
    )


def test_the_run_record_carries_display_strings_next_to_raw_values():
    dumped = json.loads(json.dumps([_mr001().model_dump(mode="json")]))[0]
    ivw = dumped["mr_results"][0]
    assert ivw["or_value"] == 1.53311316166586  # the raw value stays for machines
    assert ivw["display"] == {
        "nsnp": "64", "beta": "0.427", "se": "0.0645", "pval": "3.5×10⁻¹¹",
        "or_value": "1.53", "ci_lower": "1.35", "ci_upper": "1.74", "or_ci": "1.35–1.74",
    }
    assert dumped["heterogeneity"][0]["display"] == {"q": "123", "q_df": "63", "q_pval": "1.0×10⁻⁵"}
    assert dumped["pleiotropy"]["display"] == {"egger_intercept": "-0.00309", "se": "0.00443", "pval": "0.49"}
    shown = dumped["display"]
    assert shown["convention"] == "evimed-display-v1"
    assert shown["f_statistic_mean"] == "70.6"
    assert shown["steiger"] == {
        "status": "computed", "reason": "", "correct_causal_direction": True, "pval": "1.9×10⁻¹⁹²",
        "r2_exposure": "0.0140", "r2_outcome": "0.00111",
    }
    presso = shown["mr_presso"]
    assert presso["global_pval"] == "<0.001"
    assert presso["outlier_snps"] == ["rs6713510", "rs7903146"]
    assert (presso["corrected_or"], presso["corrected_or_ci"], presso["corrected_pval"]) == (
        "1.59", "1.43–1.77", "4.6×10⁻¹²")
    assert presso["distortion_pval"] == "0.52"


def test_a_dumped_record_reads_back_for_refinalization():
    dumped = _mr001().model_dump(mode="json")
    again = MRAnalysisResult.model_validate(dumped)
    assert again.model_dump(mode="json")["display"] == dumped["display"]


def test_open_catalogue_metadata_gives_the_sample_sizes_as_numbers():
    result = MRAnalysisResult(exposure_id="GCST002783", outcome_id="GCST003116",
                              exposure_source_type="gwas_catalog", outcome_source_type="gwas_catalog")
    record = {
        "exposure": {"accession": "GCST002783", "initialSampleSize": "up to 104,666 ...",
                     "sampleMetadata": {"sampleSize": 238944, "caseControlStudy": None}},
        "outcome": {"accession": "GCST003116", "initialSampleSize": "42,096 European ancestry cases, ...",
                    "sampleMetadata": {"sampleSize": 187599, "caseControlStudy": True}},
    }
    bind_open_metadata([result], record, {"exposure": "BMI", "outcome": "CAD"})
    assert (result.sample_size_exposure, result.sample_size_outcome) == (238944, 187599)
    assert result.outcome_metadata["case_control_study"] is True
    assert result.outcome_metadata["sample_size"] == "42,096 European ancestry cases, ..."
    assert result.display["sample_size_outcome"] == "187,599"
