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
    _PLOT_BLOCK,
)


def test_mvmr_template_labels_actual_mv_multiple_schema_for_shared_parser(tmp_path):
    from mr_agent.tools import mr_executor
    from evimed_mr_job import _scientific_rows

    script = mr_executor._build_mvmr_script(["x1", "x2"], "y", tmp_path, "")
    export = script.split("# MVMR-IVW\n", 1)[1].split("# MVMR sensitivity", 1)[0]
    # TwoSampleMR mv_multiple() returns these fields, without a method column.
    run_r(f'output_dir <- "{tmp_path}"\nmvdat <- list()\n' + '''
mv_multiple <- function(dat) list(result=data.frame(
    id.exposure=c("x1", "x2"), id.outcome=c("y", "y"), outcome=c("Outcome", "Outcome"),
    nsnp=c(8,8), b=c(0.3,0.2), se=c(0.04,0.03), pval=c(0.001,0.002),
    expname=c("Exposure one", "Exposure two")))
''' + export, tmp_path)
    parsed = mr_executor._parse_results("x1+x2", "y", tmp_path)
    assert [row.beta for row in parsed.mr_results] == [0.3, 0.2]
    assert {row.method for row in parsed.mr_results} == {"Multivariable IVW"}
    body, count = _scientific_rows((tmp_path / "mr_results.csv").read_bytes(), "mr_results.csv")
    assert count == 2 and b"Multivariable IVW" in body


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


@pytest.mark.parametrize("mode", ["normal", "multi_page", "render_failure", "inapplicable"])
def test_actual_twosamplemr_diagnostics_render_all_pdf_and_png_pages(tmp_path, mode):
    from PIL import Image, ImageStat
    from PyPDF2 import PdfReader
    from mr_agent.models import MRAnalysisResult
    from mr_agent.tools.mr_executor import _collect_plots
    from mr_agent.analysis.delivery import diagnostic_plot_checks

    script = '''
if (!requireNamespace("TwoSampleMR", quietly=TRUE)) quit(status=77)
library(TwoSampleMR)
library(jsonlite)
set.seed(1729)
dat <- data.frame(SNP=paste0("rs", 1:8), beta.exposure=seq(0.08,0.22,length.out=8),
    beta.outcome=0.35*seq(0.08,0.22,length.out=8)+c(-0.01,0.02,-0.015,0.005,0.01,-0.005,0.025,-0.02),
    se.exposure=rep(0.01,8), se.outcome=rep(0.02,8),
    id.exposure="exposure", id.outcome="outcome", exposure="Synthetic exposure",
    outcome="Synthetic outcome", mr_keep=TRUE)
mr_res <- mr(dat, method_list=c("mr_ivw","mr_egger_regression"))
'''
    analysis = tmp_path / "analysis.R"
    if mode == "multi_page":
        script += '\noriginal_scatter <- mr_scatter_plot\nmr_scatter_plot <- function(...) {p <- original_scatter(...); c(p,p)}\n'
    elif mode == "render_failure":
        script += '\nmr_scatter_plot <- function(...) stop("simulated rendering failure")\n'
    elif mode == "inapplicable":
        script += '\ndat <- dat[1:2,]\n'
    # A reused output location may contain a figure from an earlier attempt.
    # Only the exact owned diagnostic names may be removed by the new attempt.
    stale_name = "loo_plot" if mode == "inapplicable" else "scatter_plot"
    for suffix in (".pdf", ".png", "-003.png"):
        (tmp_path / (stale_name + suffix)).write_bytes(b"old diagnostic")
    unrelated = tmp_path / "unrelated.pdf"
    unrelated.write_bytes(b"preserve unrelated output")
    analysis.write_text(script + f'output_dir <- {json.dumps(tmp_path.as_posix())}\n' + _PLOT_BLOCK.format())
    # Portable replay executes through source(), where returned plot lists are
    # not auto-printed, unlike a top-level Rscript expression.
    run_r(f'source({json.dumps(analysis.as_posix())}, local=TRUE)', tmp_path)
    status = json.loads((tmp_path / "diagnostic-plots.json").read_text())
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome",
        n_instruments=2 if mode == "inapplicable" else 8, raw_data_path=tmp_path)
    _collect_plots(result, tmp_path)
    checks = diagnostic_plot_checks(result)
    for name in ("scatter_plot", "forest_plot", "funnel_plot", "loo_plot"):
        if mode == "render_failure" and name == "scatter_plot":
            assert status[name]["status"] == "failed"
            assert checks[name]["status"] == "failed"
            assert not (tmp_path / f"{name}.pdf").exists()
            continue
        if mode == "inapplicable" and name == "loo_plot":
            assert status[name]["status"] == "skipped"
            assert checks[name]["status"] == "skipped"
            assert not (tmp_path / f"{name}.pdf").exists()
            continue
        reader = PdfReader(tmp_path / f"{name}.pdf")
        pages = 2 if mode == "multi_page" and name == "scatter_plot" else 1
        assert len(reader.pages) == pages
        text = reader.pages[0].extract_text()
        assert ("MR Method" if name == "funnel_plot" else "Synthetic") in text
        assert len(reader.pages[0].get_contents().get_data()) > 1000
        with Image.open(tmp_path / f"{name}.png") as picture:
            assert picture.size == (2400, 1800)
            assert max(ImageStat.Stat(picture.convert("RGB")).stddev) > 5
        assert status[name]["status"] == "ready"
        assert checks[name] == {"status": "ok", "pages": pages, "images": pages}
    assert not (tmp_path / f"{stale_name}-003.png").exists()
    assert unrelated.read_bytes() == b"preserve unrelated output"


def test_harmonisation_counts_are_recorded_before_rows_are_dropped(tmp_path):
    """mr-001 asks how many instruments reached the analysis, how many were
    dropped as palindromic with intermediate frequency and how many the
    outcome lacked; the engine recorded none of the three."""
    from r_scripts.templates import _MR_DOWNSTREAM_BLOCK

    start = _MR_DOWNSTREAM_BLOCK.index("dat <- harmonise_data")
    stop = _MR_DOWNSTREAM_BLOCK.index("mr_res <- mr(dat)")
    block = _MR_DOWNSTREAM_BLOCK[start:stop].replace("{{", "{").replace("}}", "}")
    exposure = tmp_path / "exposure.csv"
    outcome = tmp_path / "outcome.csv"
    rows = [
        # rs3 is palindromic at an intermediate frequency (dropped), rs4 is
        # palindromic at a low frequency (kept), rs5 is absent from the outcome.
        ("rs1", "A", "G", 0.20), ("rs2", "C", "T", 0.30), ("rs3", "A", "T", 0.48),
        ("rs4", "G", "C", 0.10), ("rs5", "A", "C", 0.25),
    ]
    header = "SNP,beta,se,effect_allele,other_allele,eaf,pval\n"
    exposure.write_text(header + "".join(f"{s},0.1,0.01,{a},{b},{f},1e-10\n" for s, a, b, f in rows))
    outcome.write_text(header + "".join(f"{s},0.02,0.01,{a},{b},{f},0.01\n" for s, a, b, f in rows[:4]))
    script = (
        'if (!requireNamespace("TwoSampleMR", quietly=TRUE)) quit(status=77)\n'
        "suppressMessages(library(TwoSampleMR)); library(jsonlite)\n"
        f'output_dir <- "{tmp_path.as_posix()}"\n'
        "mr_fail <- function(code, message) stop(message)\n"
        f'exposure_dat <- format_data(read.csv("{exposure.as_posix()}"), type="exposure")\n'
        f'outcome_dat <- format_data(read.csv("{outcome.as_posix()}"), type="outcome")\n'
        + block
    )
    run_r(script, tmp_path)
    counts = json.loads((tmp_path / "harmonisation.json").read_text())
    assert counts == {
        "exposure_instruments": 5, "unavailable_in_outcome": 1, "harmonised_pairs": 4,
        "palindromic": 2, "dropped_palindromic_ambiguous": 1, "dropped_other": 0, "retained": 3,
    }
