"""Execute generated R boundaries caught by the public BMI/CHD fixture."""

import csv
import json
import shutil
import subprocess

import pytest

from mr_agent.tools.mr_executor import _r_subprocess_env
from r_scripts.templates import (
    _LOCAL_EXPOSURE_READ,
    _LOCAL_OUTCOME_READ,
    _SENSITIVITY_BLOCK,
)


def run_r(script, tmp_path):
    if shutil.which("Rscript") is None:
        pytest.skip("Rscript is unavailable on this test host")
    script_file = tmp_path / "regression.R"
    script_file.write_text(script, encoding="utf-8")
    command = ["Rscript", "--vanilla", str(script_file)]
    if shutil.which("sandbox-exec"):
        command = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", *command]
    result = subprocess.run(
        command,
        capture_output=True, text=True, timeout=60, env=_r_subprocess_env(),
    )
    if result.returncode == 77:
        pytest.skip("TwoSampleMR is unavailable on this test host")
    assert result.returncode == 0, result.stderr
    return result


def test_local_formatting_uses_the_installed_twosamplemr_api(tmp_path):
    """Both generated readers must execute, before any LD or network work."""
    data = tmp_path / "gwas.csv"
    with data.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["SNP", "beta", "se", "effect_allele", "other_allele", "eaf", "pval"])
        for index in range(4):
            writer.writerow([f"rs{index + 1}", 0.1, 0.02, "A", "G", 0.2, 1e-9])
    mapping = {f"col_{name}": name for name in (
        "snp", "beta", "se", "effect_allele", "other_allele", "eaf", "pval",
    )}
    mapping["col_snp"] = "SNP"
    exposure = _LOCAL_EXPOSURE_READ.split("# Filter by p-value threshold", 1)[0].format(
        exposure_file=data.as_posix(), extra_format_args="", zscore_block="", log10p_block="", **mapping,
    )
    outcome = _LOCAL_OUTCOME_READ.split("# Filter outcome to exposure SNPs", 1)[0].format(
        outcome_file=data.as_posix(), out_extra_format_args="", out_zscore_block="", out_log10p_block="",
        **{f"out_{key}": value for key, value in mapping.items()},
    )
    run_r(
        'options(timeout=2)\nif (!requireNamespace("TwoSampleMR", quietly=TRUE)) quit(status=77)\n'
        'library(TwoSampleMR)\n' + exposure + outcome
        + '\nstopifnot(nrow(exposure_dat) == 4L, nrow(outcome_dat) == 4L, '
        'all(exposure_dat$pval.exposure == 1e-9), all(outcome_dat$pval.outcome == 1e-9))\n',
        tmp_path,
    )


@pytest.mark.parametrize("outlier_count", [0, 1, 10, "none", "unknown"])
def test_radial_summary_reports_heterogeneity_and_outlier_rows(tmp_path, outlier_count):
    """An effect-test p-value and data-frame column count are different quantities."""
    expression = "radial_df <-" + _SENSITIVITY_BLOCK.format().split("radial_df <-", 1)[1].split("write.csv", 1)[0]
    output = tmp_path / "radial.csv"
    outliers = (
        '"No significant outliers"' if outlier_count == "none" else 'NULL'
        if outlier_count == "unknown" else
        f'data.frame(SNP=seq_len({outlier_count}), Q=rep(0,{outlier_count}), P=rep(1,{outlier_count}))'
    )
    run_r(
        'radial_res <- list(qstatistic=140.81342013927426, df=78, '
        'coef=matrix(4.19309767994741e-14, nrow=1, dimnames=list(NULL,"Pr(>|t|)")), '
        f'outliers={outliers})\n'
        + expression + f'\nwrite.csv(radial_df, {json.dumps(output.as_posix())}, row.names=FALSE)\n',
        tmp_path,
    )
    with output.open(encoding="utf-8") as handle:
        row = next(csv.DictReader(handle))
    assert float(row["global_q_pval"]) == pytest.approx(1.7248098855983917e-5, rel=1e-10)
    if outlier_count == "unknown":
        assert row["n_outliers"] == "NA"
    else:
        assert int(row["n_outliers"]) == (0 if outlier_count == "none" else outlier_count)
