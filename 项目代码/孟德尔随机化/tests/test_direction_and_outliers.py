"""Steiger and MR-PRESSO say what they found, or why there is nothing.

Production run mr-001 (BMI -> CAD, open GWAS Catalog data) reported no Steiger
direction ("replacement has length zero": the outcome file has no per-variant
sample size) and no MR-PRESSO outlier-corrected estimate (computed by
MR-PRESSO, never written). These tests run the shared R block and read its
files back through the engine's parser.
"""

import csv
import json
import math
import shutil
import subprocess

import pytest

from mr_agent.models import MRAnalysisResult
from mr_agent.tools.mr_executor import _parse_presso_csv, _parse_steiger_csv, _r_subprocess_env
from r_scripts.templates import _DIRECTION_AND_OUTLIER_BLOCK, _SKIP_TRACKING_BLOCK


def _run_block(tmp_path, *, outcome_samplesize: bool, outlier: bool) -> dict:
    if shutil.which("Rscript") is None:
        pytest.skip("Rscript is unavailable on this test host")
    exposure = tmp_path / "exposure.csv"
    outcome = tmp_path / "outcome.csv"
    alleles = [("A", "G"), ("C", "T"), ("A", "C"), ("G", "T")]
    with exposure.open("w", newline="") as e_handle, outcome.open("w", newline="") as o_handle:
        e_rows, o_rows = csv.writer(e_handle), csv.writer(o_handle)
        e_rows.writerow(["SNP", "beta", "se", "effect_allele", "other_allele", "eaf", "pval", "samplesize"])
        o_rows.writerow(["SNP", "beta", "se", "effect_allele", "other_allele", "eaf", "pval", "samplesize"])
        for index in range(20):
            effect, other = alleles[index % 4]
            bx = 0.04 + 0.003 * index
            # Noise of about one standard error, and one variant 7.5 SE off the line.
            noise = ((index * 7) % 5 - 2) * 0.002
            by = 0.3 * bx + noise + (0.03 if outlier and index == 5 else 0.0)
            e_rows.writerow([f"rs{index + 1}", bx, 0.004, effect, other, 0.3, 1e-20, 300000])
            o_rows.writerow([f"rs{index + 1}", by, 0.004, effect, other, 0.3, 1e-3,
                             180000 if outcome_samplesize else "NA"])
    script = (
        'if (!requireNamespace("TwoSampleMR", quietly=TRUE) || !requireNamespace("MRPRESSO", quietly=TRUE)) '
        "quit(status=77)\n"
        "suppressMessages(library(TwoSampleMR)); library(jsonlite)\n"
        f'output_dir <- "{tmp_path.as_posix()}"\n'
        "set.seed(1)\n"
        f'exposure_dat <- suppressWarnings(format_data(read.csv("{exposure.as_posix()}"), type="exposure", '
        'samplesize_col="samplesize"))\n'
        f'outcome_dat <- suppressWarnings(format_data(read.csv("{outcome.as_posix()}"), type="outcome", '
        'samplesize_col="samplesize"))\n'
        "dat <- suppressMessages(harmonise_data(exposure_dat, outcome_dat))\n"
        "dat <- dat[dat$mr_keep == TRUE, ]\n"
        + _SKIP_TRACKING_BLOCK.format()
        + _DIRECTION_AND_OUTLIER_BLOCK.format()
        + 'write(toJSON(list(skipped=I(sensitivity_skipped)), auto_unbox=TRUE), file.path(output_dir, "skips.json"))\n'
    )
    script_file = tmp_path / "block.R"
    script_file.write_text(script, encoding="utf-8")
    result = subprocess.run(
        ["Rscript", "--vanilla", str(script_file)],
        capture_output=True, text=True, timeout=300, env=_r_subprocess_env(),
    )
    if result.returncode == 77:
        pytest.skip("TwoSampleMR or MRPRESSO is unavailable on this test host")
    assert result.returncode == 0, result.stderr
    return json.loads((tmp_path / "skips.json").read_text())


def test_steiger_without_an_outcome_sample_size_names_the_missing_input(tmp_path):
    skips = _run_block(tmp_path, outcome_samplesize=False, outlier=False)
    result = MRAnalysisResult(exposure_id="e", outcome_id="o")
    _parse_steiger_csv(result, tmp_path)
    assert result.steiger_status == "not_computable"
    assert result.steiger_reason == "no instrument has samplesize.outcome"
    assert result.steiger_correct is None
    assert "steiger: not computable: no instrument has samplesize.outcome" in skips["skipped"]
    assert result.display["steiger"]["status"] == "not_computable"

    import evimed_runner
    modules = evimed_runner._module_ledger([result], bidirectional=False)
    assert modules["steigerDirection"] == {
        "status": "degraded", "reason": "not computable: no instrument has samplesize.outcome",
    }


def test_steiger_with_both_sample_sizes_gives_a_verdict_and_its_r2(tmp_path):
    _run_block(tmp_path, outcome_samplesize=True, outlier=False)
    result = MRAnalysisResult(exposure_id="e", outcome_id="o")
    _parse_steiger_csv(result, tmp_path)
    assert result.steiger_status == "computed"
    assert result.steiger_reason == ""
    assert result.steiger_correct is True
    assert result.steiger_pval is not None and result.steiger_r2_exposure > result.steiger_r2_outcome > 0
    shown = result.display["steiger"]
    assert shown["correct_causal_direction"] is True and shown["pval"] and shown["r2_exposure"]


def test_mr_presso_writes_the_outlier_corrected_estimate_and_the_variant_it_removed(tmp_path):
    _run_block(tmp_path, outcome_samplesize=True, outlier=True)
    result = MRAnalysisResult(exposure_id="e", outcome_id="o")
    _parse_presso_csv(result, tmp_path)
    correction = result.presso_correction
    assert correction is not None and correction.reason == ""
    assert correction.outlier_snps == ["rs6"]
    assert result.presso_n_outliers == 1
    assert correction.n_distributions == 1000
    assert correction.outlier_resolution == pytest.approx(20 / 1000)
    assert correction.beta == pytest.approx(0.3, abs=0.01)
    assert correction.se is not None and correction.pval is not None
    assert correction.or_value == pytest.approx(math.exp(correction.beta))
    assert correction.ci_lower == pytest.approx(math.exp(correction.beta - 1.96 * correction.se))
    shown = result.display["mr_presso"]
    assert shown["outlier_snps"] == ["rs6"]
    assert shown["corrected_beta"] == f"{correction.beta:.3f}"
    assert shown["corrected_or_ci"] and shown["reason"] == ""


def test_mr_presso_says_why_there_is_no_corrected_estimate(tmp_path):
    _run_block(tmp_path, outcome_samplesize=True, outlier=False)
    result = MRAnalysisResult(exposure_id="e", outcome_id="o")
    _parse_presso_csv(result, tmp_path)
    correction = result.presso_correction
    assert correction is not None
    assert correction.beta is None and correction.outlier_snps == []
    assert correction.reason.startswith("the global test (p = ")
    assert "MR-PRESSO tests single variants only after a significant global test" in correction.reason
    assert result.display["mr_presso"]["corrected_or"] is None


def test_the_outlier_test_is_given_enough_draws_to_reach_its_threshold():
    # 64 variants with 1000 draws gave a Bonferroni resolution of 0.064, above
    # the 0.05 threshold, and MR-PRESSO warned "Outlier test unstable".
    block = _DIRECTION_AND_OUTLIER_BLOCK

    def draws(n: int) -> int:
        # The R expression, restated: enough draws for n / draws <= 0.05, never
        # costing more than the old 1000 draws at 150 variants.
        return max(1000, min(-(-n * 20 // 1), (150 ** 2 * 1000) // n ** 2))

    assert "ceiling(nrow(presso_dat) / presso_threshold)" in block
    assert "floor(150^2 * 1000 / nrow(presso_dat)^2)" in block
    assert "outlier_resolution = nrow(presso_dat) / presso_draws" in block
    assert draws(20) == 1000 and draws(64) == 1280 and draws(100) == 2000
    assert draws(120) == 1562 and 120 / draws(120) > 0.05  # resolution written, not hidden
    assert draws(300) == 1000
    # The outlier count is the set MR-PRESSO removed, never a string comparison
    # of its formatted p-values against 0.05 in the locale's collation.
    assert "Pvalue < 0.05" not in _DIRECTION_AND_OUTLIER_BLOCK


def test_a_mrpresso_file_from_before_the_correction_was_kept_still_parses(tmp_path):
    (tmp_path / "mrpresso.csv").write_text('"global_p","n_outliers"\n"<0.001",2\n', encoding="utf-8")
    result = MRAnalysisResult(exposure_id="e", outcome_id="o")
    _parse_presso_csv(result, tmp_path)
    assert result.presso_global_pval == 0.001 and result.presso_global_pval_relation == "<"
    assert result.presso_n_outliers == 2 and result.presso_correction is None
    assert result.display["mr_presso"]["global_pval"] == "<0.001"
