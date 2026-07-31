# [IN] GWAS IDs, output path
# [OUT] MRAnalysisResult
# [POS] mr_agent/tools/mr_executor.py - Safe R script execution
"""R script execution engine for MR analysis."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import pandas as pd

from mr_agent.models import (
    ColumnMapping,
    DataSource,
    DataSourceType,
    HeterogeneityResult,
    MRAnalysisResult,
    MRResult,
    PleiotopyResult,
)
from mr_agent.utils import safe_float, safe_int

logger = logging.getLogger(__name__)

DEFAULT_PVAL_THRESHOLDS = [5e-8, 5e-6, 5e-5]

# Per-pair R script timeout (seconds). OpenGWAS API calls from China to UK can be
# slow; allow override via env var for tuning without code changes.
_R_TIMEOUT_SEC = int(os.getenv("MR_R_TIMEOUT_SEC", "900"))

_r_env_cache: tuple[bool, str] | None = None
_r_env_lock = threading.Lock()

# TwoSampleMR and friends are vendored into .r-lib beside this agent rather than
# installed system-wide, and nothing ever told R where they were: both Rscript
# calls inherited an environment with no R_LIBS_USER in it. Every run therefore
# failed reporting the packages as missing while they sat on disk.
# (--vanilla is not the culprit — it skips .Renviron files but still honours a
# process-environment R_LIBS_USER, which is why it is kept below.)
_BUNDLED_R_LIBRARY = Path(__file__).resolve().parents[2] / ".r-lib"


def _r_subprocess_env() -> dict[str, str]:
    """Environment for an Rscript call, with the bundled library on the path."""
    env = dict(os.environ)
    if _BUNDLED_R_LIBRARY.is_dir():
        existing = env.get("R_LIBS_USER", "")
        env["R_LIBS_USER"] = (
            f"{_BUNDLED_R_LIBRARY}{os.pathsep}{existing}" if existing else str(_BUNDLED_R_LIBRARY)
        )
    return env


# --vanilla keeps a run reproducible: no saved workspace, no user or site
# profile, no stray .Renviron. The library path is supplied through the
# subprocess environment instead, which --vanilla does not discard.
_R_ISOLATION_FLAGS = ["--vanilla"]

_R_NOT_FOUND_MSG = (
    "Rscript not found. Please install R:\n"
    "  Windows: https://cran.r-project.org/bin/windows/base/\n"
    "           (安装后将 R\\bin 目录加入系统 PATH)\n"
    "  macOS:   brew install r\n"
    "  Ubuntu:  sudo apt install r-base"
)


def check_r_environment() -> tuple[bool, str]:
    """Check if R and required packages are available.

    Returns (ok, message) tuple. Result is cached after the first call.
    Thread-safe via _r_env_lock.
    """
    global _r_env_cache
    if _r_env_cache is not None:
        return _r_env_cache
    with _r_env_lock:
        # Double-check after acquiring lock to avoid redundant work
        if _r_env_cache is not None:
            return _r_env_cache
        _r_env_cache = _check_r_environment_impl()
        return _r_env_cache


def _check_r_environment_impl() -> tuple[bool, str]:
    """Internal R environment check (called once, under lock)."""
    try:
        result = subprocess.run(
            ["Rscript", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return (False, _R_NOT_FOUND_MSG)
    except FileNotFoundError:
        return (False, _R_NOT_FOUND_MSG)
    except subprocess.TimeoutExpired:
        return (False, "Rscript check timed out.")
    # Check required packages
    check_script = (
        'pkgs <- c("TwoSampleMR", "ieugwasr", "jsonlite", "MRPRESSO"); '
        'missing <- pkgs[!sapply(pkgs, requireNamespace, quietly=TRUE)]; '
        'if(length(missing)>0) cat(paste(missing,collapse=",")) else cat("OK")'
    )
    try:
        result = subprocess.run(
            ["Rscript", *_R_ISOLATION_FLAGS, "-e", check_script],
            capture_output=True, text=True, timeout=30, env=_r_subprocess_env(),
        )
        output = result.stdout.strip()
        if output != "OK":
            missing = output.split(",")
            install_cmd = ", ".join(f'"{p}"' for p in missing)
            return (False, (
                f"Missing R packages: {', '.join(missing)}\n"
                f"Install with: Rscript -e 'install.packages(c({install_cmd}))'"
            ))
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return (False, "Failed to check R packages.")
    return (True, "R environment OK")


def _r_path(p: Path | str) -> str:
    """Convert path to R-compatible forward-slash string."""
    return str(p).replace("\\", "/")


def run_mr_analysis(
    exposure_id: str,
    outcome_id: str,
    output_dir: Path,
    gwas_token: str = "",
    pval_thresholds: list[float] | None = None,
) -> MRAnalysisResult:
    """Execute standard MR analysis via R."""
    output_dir.mkdir(parents=True, exist_ok=True)
    if pval_thresholds is None:
        pval_thresholds = DEFAULT_PVAL_THRESHOLDS
    r_script = _build_standard_script(
        exposure_id, outcome_id, output_dir, gwas_token, pval_thresholds
    )
    success = _execute_r_script(r_script, output_dir)
    if not success:
        logger.error(f"MR analysis failed: {exposure_id} -> {outcome_id}")
        return MRAnalysisResult(exposure_id=exposure_id, outcome_id=outcome_id)
    return _parse_results(exposure_id, outcome_id, output_dir)


def _build_standard_script(
    exposure_id: str, outcome_id: str, output_dir: Path,
    gwas_token: str, pval_thresholds: list[float],
) -> str:
    """Build R script from template for standard MR."""
    from r_scripts.templates import MR_STANDARD_TEMPLATE
    token_line = _token_line(gwas_token)
    thresholds = ", ".join(str(t) for t in pval_thresholds)
    out = _r_path(output_dir)
    return MR_STANDARD_TEMPLATE.format(
        token_line=token_line, output_dir=out,
        exposure_id=exposure_id, outcome_id=outcome_id,
        thresholds=thresholds,
    )


def _build_moe_script(
    exposure_id: str, outcome_id: str, output_dir: Path, gwas_token: str,
) -> str:
    """Build R script from template for MOE MR."""
    from r_scripts.templates import MR_MOE_TEMPLATE
    token_line = _token_line(gwas_token)
    out = _r_path(output_dir)
    return MR_MOE_TEMPLATE.format(
        token_line=token_line, output_dir=out,
        exposure_id=exposure_id, outcome_id=outcome_id,
    )


def _token_line(gwas_token: str) -> str:
    """Generate R JWT token configuration line (sanitized).

    JWT tokens contain alphanumerics, hyphens, underscores, and dots.
    set_opengwas_jwt may not be exported in all ieugwasr builds — use :::
    to reach the internal function, with Sys.setenv as a final fallback.
    """
    if not gwas_token:
        return ""
    import re as _re
    # JWT-safe: allow A-Za-z0-9 - _ .
    sanitized = _re.sub(r'[^A-Za-z0-9\-_.]', '', gwas_token)
    if not sanitized:
        logger.warning("Invalid GWAS token format after sanitization, skipping")
        return ""
    return (
        f'tryCatch(\n'
        f'  ieugwasr:::set_opengwas_jwt("{sanitized}"),\n'
        f'  error = function(e) Sys.setenv(OPENGWAS_JWT = "{sanitized}")\n'
        f')'
    )


def _execute_r_script(script: str, work_dir: Path) -> bool:
    """Execute R script safely using subprocess."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".R", dir=work_dir, delete=False
    ) as f:
        f.write(script)
        script_path = f.name
    try:
        result = subprocess.run(
            ["Rscript", *_R_ISOLATION_FLAGS, script_path],
            cwd=str(work_dir), capture_output=True,
            text=True, timeout=_R_TIMEOUT_SEC, env=_r_subprocess_env(),
        )
        if result.returncode != 0:
            # Strip TwoSampleMR startup banner (first ~500 chars) to surface real error
            stderr_full = result.stderr
            banner_end = stderr_full.find("Error", 300)  # skip banner, find first Error
            if banner_end == -1:
                banner_end = 0
            logger.error(f"R failed (exit {result.returncode}):\n{stderr_full[banner_end:banner_end+2000]}")
            if result.stdout.strip():
                logger.error(f"R stdout tail:\n{result.stdout[-500:]}")
            return False
        if result.stdout.strip():
            logger.info(f"R stdout:\n{result.stdout[-500:]}")
        return True
    except subprocess.TimeoutExpired:
        logger.error(f"R script timed out ({_R_TIMEOUT_SEC}s)")
        return False
    except FileNotFoundError:
        logger.error("Rscript not found. Install R and TwoSampleMR.")
        return False
    finally:
        Path(script_path).unlink(missing_ok=True)


def run_mr_moe(
    exposure_id: str, outcome_id: str,
    output_dir: Path, gwas_token: str = "",
) -> MRAnalysisResult:
    """Execute MR with Mixture-of-Experts method."""
    output_dir.mkdir(parents=True, exist_ok=True)
    r_script = _build_moe_script(exposure_id, outcome_id, output_dir, gwas_token)
    success = _execute_r_script(r_script, output_dir)
    if not success:
        return MRAnalysisResult(exposure_id=exposure_id, outcome_id=outcome_id)
    return _parse_results(exposure_id, outcome_id, output_dir)


def run_mr_local(
    exposure_source: DataSource,
    outcome_source: DataSource,
    output_dir: Path,
    gwas_token: str = "",
    pval_thresholds: list[float] | None = None,
) -> MRAnalysisResult:
    """Execute MR with local data source(s)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    if pval_thresholds is None:
        pval_thresholds = DEFAULT_PVAL_THRESHOLDS
    r_script = _select_local_template(
        exposure_source, outcome_source, output_dir,
        gwas_token, pval_thresholds,
    )
    exp_id = exposure_source.display_id()
    out_id = outcome_source.display_id()
    success = _execute_r_script(r_script, output_dir)
    if not success:
        logger.error(f"Local MR failed: {exp_id} -> {out_id}")
        return _empty_local_result(exposure_source, outcome_source)
    result = _parse_results(exp_id, out_id, output_dir)
    result.exposure_source_type = exposure_source.source_type
    result.outcome_source_type = outcome_source.source_type
    return result


def _select_local_template(
    exp_src: DataSource, out_src: DataSource,
    output_dir: Path, gwas_token: str,
    pval_thresholds: list[float],
) -> str:
    """Select and build R script based on which sources are local."""
    if exp_src.is_local() and out_src.is_local():
        return _build_local_both_script(
            exp_src, out_src, output_dir, gwas_token, pval_thresholds,
        )
    if exp_src.is_local():
        return _build_local_exposure_script(
            exp_src, out_src, output_dir, gwas_token, pval_thresholds,
        )
    return _build_local_outcome_script(
        exp_src, out_src, output_dir, gwas_token, pval_thresholds,
    )


def _empty_local_result(exp_src: DataSource, out_src: DataSource) -> MRAnalysisResult:
    """Create empty result for failed local MR analysis."""
    return MRAnalysisResult(
        exposure_id=exp_src.display_id(),
        outcome_id=out_src.display_id(),
        exposure_source_type=exp_src.source_type,
        outcome_source_type=out_src.source_type,
    )


def _parse_results(
    exposure_id: str, outcome_id: str, output_dir: Path,
) -> MRAnalysisResult:
    """Parse R output files into MRAnalysisResult."""
    result = MRAnalysisResult(
        exposure_id=exposure_id, outcome_id=outcome_id,
        raw_data_path=output_dir,
    )
    _parse_summary(result, output_dir)
    _parse_mr_csv(result, output_dir)
    _parse_het_csv(result, output_dir)
    _parse_plt_csv(result, output_dir)
    _parse_steiger_csv(result, output_dir)
    _parse_presso_csv(result, output_dir)
    _parse_radial_csv(result, output_dir)
    _parse_conmix_csv(result, output_dir)
    _collect_plots(result, output_dir)
    return result


def _parse_summary(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse summary JSON."""
    summary_file = output_dir / "mr_summary.json"
    if not summary_file.exists():
        _check_error_file(output_dir)
        return
    data = json.loads(summary_file.read_text())
    result.n_instruments = data.get("n_instruments", 0)
    result.f_statistic_mean = data.get("mean_f_statistic")
    result.pval_threshold = data.get("pval_threshold", 5e-8)
    # Parse sample sizes if available
    n_exp = safe_int(data.get("sample_size_exposure"))
    n_out = safe_int(data.get("sample_size_outcome"))
    if n_exp is not None:
        result.sample_size_exposure = n_exp
    if n_out is not None:
        result.sample_size_outcome = n_out


def _check_error_file(output_dir: Path) -> None:
    """Log error if mr_error.json exists."""
    error_file = output_dir / "mr_error.json"
    if error_file.exists():
        data = json.loads(error_file.read_text())
        logger.error(f"MR error: {data.get('error')}")


def _parse_mr_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse MR results CSV."""
    csv_path = output_dir / "mr_results.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    for _, row in df.iterrows():
        result.mr_results.append(_row_to_mr_result(row))


def _row_to_mr_result(row) -> MRResult:
    """Convert a DataFrame row to MRResult."""
    or_val = safe_float(row.get("or")) if "or" in row else None
    ci_lo = safe_float(row.get("ci_lower")) if "ci_lower" in row else None
    ci_hi = safe_float(row.get("ci_upper")) if "ci_upper" in row else None
    pval_raw = safe_float(row.get("pval"))
    pval = pval_raw if pval_raw is not None else 1.0
    return MRResult(
        method=str(row.get("method", "")),
        nsnp=safe_int(row.get("nsnp")) or 0,
        beta=safe_float(row.get("b")) or 0.0,
        se=safe_float(row.get("se")) or 0.0,
        pval=pval,
        or_value=or_val,
        ci_lower=ci_lo,
        ci_upper=ci_hi,
    )




def _parse_het_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse heterogeneity CSV."""
    csv_path = output_dir / "heterogeneity.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    for _, row in df.iterrows():
        q_val = safe_float(row.get("Q"))
        q_pval = safe_float(row.get("Q_pval"))
        if q_val is None or q_pval is None:
            continue
        result.heterogeneity.append(HeterogeneityResult(
            method=str(row.get("method", "")),
            q=q_val,
            q_df=safe_int(row.get("Q_df")) or 0,
            q_pval=q_pval,
        ))


def _parse_plt_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse pleiotropy CSV."""
    csv_path = output_dir / "pleiotropy.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    if len(df) > 0:
        row = df.iloc[0]
        intercept = safe_float(row.get("egger_intercept"))
        se = safe_float(row.get("se"))
        pval = safe_float(row.get("pval"))
        if intercept is not None and se is not None and pval is not None:
            result.pleiotropy = PleiotopyResult(
                egger_intercept=intercept, se=se, pval=pval,
            )


def _parse_steiger_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse Steiger directionality test CSV."""
    csv_path = output_dir / "steiger.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    if len(df) > 0:
        row = df.iloc[0]
        raw = row.get("correct_causal_direction")
        if raw is not None:
            result.steiger_correct = str(raw).upper() == "TRUE"
        pval = safe_float(row.get("steiger_pval"))
        if pval is not None:
            result.steiger_pval = pval


def _parse_presso_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse MR-PRESSO results CSV."""
    csv_path = output_dir / "mrpresso.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    if len(df) > 0:
        row = df.iloc[0]
        global_p = safe_float(row.get("global_p"))
        if global_p is not None:
            result.presso_global_pval = global_p
        n_out = safe_int(row.get("n_outliers"))
        if n_out is not None:
            result.presso_n_outliers = n_out


def _collect_plots(result: MRAnalysisResult, output_dir: Path) -> None:
    """Collect generated plot paths (PDF and PNG)."""
    for name in ["scatter_plot", "forest_plot", "funnel_plot", "loo_plot",
                  "summary_forest"]:
        for ext in [".pdf", ".png"]:
            plot_path = output_dir / f"{name}{ext}"
            if plot_path.exists():
                key = f"{name}{ext.replace('.', '_')}"
                result.plots[key] = plot_path


# --- Local data script builders ---


def _column_mapping_to_r_args(mapping: ColumnMapping, prefix: str = "") -> dict[str, str]:
    """Convert ColumnMapping to template format args."""
    p = prefix
    args = {
        f"{p}col_snp": mapping.snp,
        f"{p}col_beta": mapping.beta,
        f"{p}col_se": mapping.se,
        f"{p}col_effect_allele": mapping.effect_allele,
        f"{p}col_other_allele": mapping.other_allele,
        f"{p}col_eaf": mapping.eaf,
        f"{p}col_pval": mapping.pval,
    }
    extra_parts = []
    if mapping.samplesize:
        extra_parts.append(f',\n    samplesize_col = "{mapping.samplesize}"')
    if mapping.gene:
        extra_parts.append(f',\n    gene_col = "{mapping.gene}"')
    if mapping.chr:
        extra_parts.append(f',\n    chr_col = "{mapping.chr}"')
    if mapping.pos:
        extra_parts.append(f',\n    pos_col = "{mapping.pos}"')
    args[f"{p}extra_format_args"] = "".join(extra_parts)
    return args


def _build_zscore_block(mapping: ColumnMapping, data_var: str = "raw_exp") -> str:
    """Build Z-score derivation R code block."""
    if not mapping.z_score_column:
        return ""
    from r_scripts.templates import ZSCORE_DERIVE_BLOCK
    return ZSCORE_DERIVE_BLOCK.format(
        z_col=mapping.z_score_column,
        col_beta=mapping.beta,
        col_se=mapping.se,
        data_var=data_var,
    )


def _build_log10p_block(mapping: ColumnMapping, data_var: str = "raw_exp") -> str:
    """Build LOG10P derivation R code block."""
    if not mapping.log10p:
        return ""
    from r_scripts.templates import LOG10P_DERIVE_BLOCK
    return LOG10P_DERIVE_BLOCK.format(
        log10p_col=mapping.log10p,
        col_pval=mapping.pval,
        data_var=data_var,
    )


def _build_local_exposure_script(
    exp_src: DataSource, out_src: DataSource,
    output_dir: Path, gwas_token: str, pval_thresholds: list[float],
) -> str:
    """Build R script: local exposure + remote outcome."""
    from r_scripts.templates import MR_LOCAL_EXPOSURE_TEMPLATE
    mapping = exp_src.column_mapping or ColumnMapping()
    exp_args = _column_mapping_to_r_args(mapping)
    out = _r_path(output_dir)
    exp_file = _r_path(exp_src.file_path or "")
    outcome_id = out_src.gwas_id or ""
    if not outcome_id:
        raise ValueError(
            "Remote outcome GWAS ID is required for local-exposure mode, "
            f"but outcome source '{out_src.display_id()}' has no gwas_id"
        )
    return MR_LOCAL_EXPOSURE_TEMPLATE.format(
        token_line=_token_line(gwas_token),
        output_dir=out,
        exposure_file=exp_file,
        outcome_id=outcome_id,
        pval_threshold=pval_thresholds[0],
        exposure_label=exp_src.display_id(),
        outcome_label=out_src.display_id(),
        zscore_block=_build_zscore_block(mapping),
        log10p_block=_build_log10p_block(mapping),
        **exp_args,
    )


def _build_local_outcome_script(
    exp_src: DataSource, out_src: DataSource,
    output_dir: Path, gwas_token: str,
    pval_thresholds: list[float],
) -> str:
    """Build R script: remote exposure + local outcome."""
    from r_scripts.templates import MR_LOCAL_OUTCOME_TEMPLATE
    mapping = out_src.column_mapping or ColumnMapping()
    out_args = _column_mapping_to_r_args(mapping, prefix="out_")
    out = _r_path(output_dir)
    out_file = _r_path(out_src.file_path or "")
    thresholds = ", ".join(str(t) for t in pval_thresholds)
    exposure_id = exp_src.gwas_id or ""
    if not exposure_id:
        raise ValueError(
            "Remote exposure GWAS ID is required for local-outcome mode, "
            f"but exposure source '{exp_src.display_id()}' has no gwas_id"
        )
    return MR_LOCAL_OUTCOME_TEMPLATE.format(
        token_line=_token_line(gwas_token),
        output_dir=out,
        exposure_id=exposure_id,
        outcome_file=out_file,
        thresholds=thresholds,
        pval_threshold=pval_thresholds[0],
        exposure_label=exp_src.display_id(),
        outcome_label=out_src.display_id(),
        out_zscore_block=_build_zscore_block(mapping, "raw_out"),
        out_log10p_block=_build_log10p_block(mapping, "raw_out"),
        **out_args,
    )


def _build_local_both_script(
    exp_src: DataSource, out_src: DataSource,
    output_dir: Path, gwas_token: str, pval_thresholds: list[float],
) -> str:
    """Build R script: both local exposure and outcome."""
    from r_scripts.templates import MR_LOCAL_BOTH_TEMPLATE
    exp_mapping = exp_src.column_mapping or ColumnMapping()
    out_mapping = out_src.column_mapping or ColumnMapping()
    exp_args = _column_mapping_to_r_args(exp_mapping)
    out_args = _column_mapping_to_r_args(out_mapping, prefix="out_")
    out = _r_path(output_dir)
    exp_file = _r_path(exp_src.file_path or "")
    out_file = _r_path(out_src.file_path or "")
    return MR_LOCAL_BOTH_TEMPLATE.format(
        token_line=_token_line(gwas_token),
        output_dir=out,
        exposure_file=exp_file,
        outcome_file=out_file,
        pval_threshold=pval_thresholds[0],
        exposure_label=exp_src.display_id(),
        outcome_label=out_src.display_id(),
        zscore_block=_build_zscore_block(exp_mapping),
        log10p_block=_build_log10p_block(exp_mapping),
        out_zscore_block=_build_zscore_block(out_mapping, "raw_out"),
        out_log10p_block=_build_log10p_block(out_mapping, "raw_out"),
        **exp_args,
        **out_args,
    )


# --- New method executors ---


def run_mr_mrlap(
    exposure_id: str, outcome_id: str,
    output_dir: Path, gwas_token: str = "",
    pval_thresholds: list[float] | None = None,
) -> MRAnalysisResult:
    """Execute MR-LAP analysis (sample overlap correction)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    if pval_thresholds is None:
        pval_thresholds = DEFAULT_PVAL_THRESHOLDS
    r_script = _build_mrlap_script(
        exposure_id, outcome_id, output_dir, gwas_token, pval_thresholds,
    )
    success = _execute_r_script(r_script, output_dir)
    if not success:
        return MRAnalysisResult(exposure_id=exposure_id, outcome_id=outcome_id)
    return _parse_results(exposure_id, outcome_id, output_dir)


def _build_mrlap_script(
    exposure_id: str, outcome_id: str, output_dir: Path,
    gwas_token: str, pval_thresholds: list[float],
) -> str:
    """Build R script for MR-LAP."""
    from r_scripts.templates import MR_MRLAP_TEMPLATE
    out = _r_path(output_dir)
    thresholds = ", ".join(str(t) for t in pval_thresholds)
    return MR_MRLAP_TEMPLATE.format(
        token_line=_token_line(gwas_token), output_dir=out,
        exposure_id=exposure_id, outcome_id=outcome_id,
        thresholds=thresholds,
    )


def run_mr_mvmr(
    exposure_ids: list[str], outcome_id: str,
    output_dir: Path, gwas_token: str = "",
) -> MRAnalysisResult:
    """Execute multivariable MR (MVMR) analysis."""
    output_dir.mkdir(parents=True, exist_ok=True)
    r_script = _build_mvmr_script(
        exposure_ids, outcome_id, output_dir, gwas_token,
    )
    success = _execute_r_script(r_script, output_dir)
    exp_label = "+".join(exposure_ids)
    if not success:
        return MRAnalysisResult(exposure_id=exp_label, outcome_id=outcome_id)
    return _parse_results(exp_label, outcome_id, output_dir)


def _build_mvmr_script(
    exposure_ids: list[str], outcome_id: str,
    output_dir: Path, gwas_token: str,
) -> str:
    """Build R script for MVMR."""
    from r_scripts.templates import MR_MVMR_TEMPLATE
    out = _r_path(output_dir)
    ids_str = ", ".join(f'"{eid}"' for eid in exposure_ids)
    return MR_MVMR_TEMPLATE.format(
        token_line=_token_line(gwas_token), output_dir=out,
        exposure_ids=ids_str, outcome_id=outcome_id,
    )


def _parse_single_pval_csv(
    result: MRAnalysisResult, output_dir: Path,
    filename: str, column: str, attr: str,
) -> None:
    """Parse a single-row CSV and set a pval attribute on result."""
    csv_path = output_dir / filename
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path)
    if len(df) > 0:
        pval = safe_float(df.iloc[0].get(column))
        if pval is not None:
            setattr(result, attr, pval)


def _parse_radial_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse Radial MR results CSV."""
    _parse_single_pval_csv(result, output_dir, "radial.csv", "global_q_pval", "radial_pval")


def _parse_conmix_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse Contamination Mixture results CSV."""
    _parse_single_pval_csv(result, output_dir, "conmix.csv", "pval", "conmix_pval")


def run_summary_forest(
    results: list[MRAnalysisResult], output_dir: Path,
) -> bool:
    """Generate summary forest plot across all MR results."""
    csv_paths = []
    labels = []
    for r in results:
        if not r.raw_data_path:
            continue
        csv_file = Path(r.raw_data_path) / "mr_results.csv"
        if csv_file.exists():
            csv_paths.append(_r_path(csv_file))
            labels.append(f"{r.exposure_name} → {r.outcome_name}")
    if len(csv_paths) < 2:
        return False
    from r_scripts.templates import MR_FOREST_SUMMARY_TEMPLATE
    paths_str = ", ".join(f'"{p}"' for p in csv_paths)
    labels_str = ", ".join(f'"{l}"' for l in labels)
    out = _r_path(output_dir)
    script = MR_FOREST_SUMMARY_TEMPLATE.format(
        output_dir=out, result_csv_paths=paths_str, pair_labels=labels_str,
    )
    return _execute_r_script(script, output_dir)
