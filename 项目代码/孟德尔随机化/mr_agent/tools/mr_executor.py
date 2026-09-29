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
    HeterogeneityResult,
    MRAnalysisResult,
    MRPressoCorrection,
    MRResult,
    PleiotopyResult,
)
from mr_agent.utils import safe_float, safe_int
from mr_agent.tools.mr_replay import (
    DEFAULT_REPLAY_SEED,
    complete_local_replay,
    prepare_local_replay,
)

logger = logging.getLogger(__name__)

DEFAULT_PVAL_THRESHOLDS = [5e-8, 5e-6, 5e-5]


class MRSourceError(RuntimeError):
    """A data source refused or could not answer.

    Distinct from "the analysis ran and found too few instruments": an expired
    OpenGWAS JWT used to arrive as `Insufficient instrumental variables (< 3)`
    with exit 0, which reads as a scientific finding rather than a credential
    problem.
    """

    def __init__(self, message: str, *, code: str):
        super().__init__(message)
        self.code = code


# Codes the R templates write into mr_error.json. Source codes mean the data
# never arrived; analysis codes mean it arrived and did not support a run.
SOURCE_ERROR_CODES = frozenset({
    "opengwas_auth_failed",
    "opengwas_rate_limited",
    "opengwas_unavailable",
    "ld_clumping_failed",
    "analysis_failed",
})
ANALYSIS_ERROR_CODES = frozenset({
    "no_instruments",
    "no_outcome_data",
    "insufficient_harmonised_snps",
})

# Per-pair R script timeout (seconds). OpenGWAS API calls from China to UK can be
# slow; allow override via env var for tuning without code changes.
_R_TIMEOUT_SEC = int(os.getenv("MR_R_TIMEOUT_SEC", "900"))

_r_env_cache: tuple[bool, str] | None = None
_r_env_lock = threading.Lock()

# Every R package the analysis templates call. The readiness check used to name
# four of these, so an environment missing MVMR or MRlap reported healthy and the
# multivariable and sample-overlap templates failed only once a run reached R.
# test_r_environment.py holds this to what the templates actually reference and
# to what install_r_packages.R installs, so the three cannot drift apart again.
REQUIRED_R_PACKAGES = (
    "TwoSampleMR",
    "ieugwasr",
    "jsonlite",
    "MRPRESSO",
    "RadialMR",
    "MendelianRandomization",
    "MVMR",
    "MRlap",
    "ggplot2",
    "data.table",
)

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
    # A package that is installed but cannot load reports the same as one that
    # was never installed, and the advice to install it is then wrong: what is
    # actually missing is a dependency. TwoSampleMR sat on disk unusable for
    # want of data.table and the message said to install TwoSampleMR. Report the
    # load error, which names the real gap.
    package_list = ", ".join(f'"{name}"' for name in REQUIRED_R_PACKAGES)
    check_script = (
        f"pkgs <- c({package_list}); "
        'bad <- character(0); '
        'for (p in pkgs) { '
        '  err <- tryCatch({ loadNamespace(p); NULL }, error = function(e) conditionMessage(e)); '
        '  if (!is.null(err)) bad <- c(bad, paste0(p, ": ", gsub("[\r\n]+", " ", err))) '
        '}; '
        'if (length(bad) > 0) cat(paste(bad, collapse=" | ")) else cat("OK")'
    )
    try:
        result = subprocess.run(
            ["Rscript", *_R_ISOLATION_FLAGS, "-e", check_script],
            capture_output=True, text=True, timeout=30, env=_r_subprocess_env(),
        )
        output = result.stdout.strip()
        if output != "OK":
            failures = [item.strip() for item in output.split("|") if item.strip()]
            names = [item.split(":", 1)[0].strip() for item in failures]
            install_cmd = ", ".join(f'"{p}"' for p in names)
            detail = "\n".join(f"  - {item}" for item in failures)
            return (False, (
                f"R packages unusable: {', '.join(names)}\n{detail}\n"
                f"If a package is absent, install it: Rscript -e 'install.packages(c({install_cmd}))'\n"
                f"If it is present but fails to load, install the dependency its error names instead."
            ))
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return (False, "Failed to check R packages.")
    return (True, "R environment OK")


def _r_path(p: Path | str) -> str:
    """Escape the contents of a quoted R path, preserving legacy slash conversion."""
    return json.dumps(str(p).replace("\\", "/"), ensure_ascii=False)[1:-1]


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
    previous = _output_identities(output_dir)
    success = _execute_r_script(r_script, output_dir)
    # A classified failure exits non-zero on purpose, so the error file must be
    # read before the exit code is treated as "nothing to parse".
    result = _parse_results(exposure_id, outcome_id, output_dir, previous=previous)
    if not result.mr_results and not any(name in _output_identities(output_dir) and _output_identities(output_dir)[name] != previous.get(name) for name in ("selected-source-rows.csv", "harmonised-rows.csv")):
        raise_for_source_failure(output_dir)
    if not success:
        result.analysis_status = "partial" if result.mr_results else "failed"
        result.analysis_error_code = str(read_error_file(output_dir).get("code") or "analysis_failed")
    return result


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
        return _execute_r_file(Path(script_path), work_dir)
    finally:
        Path(script_path).unlink(missing_ok=True)


def _write_r_logs(work_dir: Path, stdout: str, stderr: str) -> None:
    """Keep the R transcript beside the results.

    The classified failure lives in mr_error.json, but the message OpenGWAS
    actually returned only ever reached stdout, which was logged at 500
    characters and then discarded with the temporary directory.
    """
    try:
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "r_stdout.log").write_text(stdout or "", encoding="utf-8")
        (work_dir / "r_stderr.log").write_text(stderr or "", encoding="utf-8")
    except OSError as error:
        logger.warning("Could not persist R transcript in %s: %s", work_dir, error)


def _execute_r_file(script_path: Path, work_dir: Path) -> bool:
    """Execute an existing entry without rewriting or deleting its code."""
    try:
        result = subprocess.run(
            ["Rscript", *_R_ISOLATION_FLAGS, str(script_path.resolve())],
            cwd=str(work_dir), capture_output=True,
            text=True, timeout=_R_TIMEOUT_SEC, env=_r_subprocess_env(),
        )
        _write_r_logs(work_dir, result.stdout, result.stderr)
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


def run_mr_local(
    exposure_source: DataSource,
    outcome_source: DataSource,
    output_dir: Path,
    gwas_token: str = "",
    pval_thresholds: list[float] | None = None,
    *,
    seed: int = DEFAULT_REPLAY_SEED,
) -> MRAnalysisResult:
    """Execute MR with local data source(s)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    if pval_thresholds is None:
        pval_thresholds = DEFAULT_PVAL_THRESHOLDS
    previous = _output_identities(output_dir)
    parsed_dir = output_dir
    exp_id = exposure_source.display_id()
    out_id = outcome_source.display_id()
    if (
        exposure_source.is_local() and outcome_source.is_local()
        and exposure_source.instruments_preclumped
    ):
        replay = prepare_local_replay(
            exposure_source, outcome_source, output_dir, pval_thresholds, seed,
            _build_local_both_script,
        )
        success = _execute_r_file(replay / "run.R", replay)
        if success:
            complete_local_replay(replay, output_dir)
        elif (replay / "results").is_dir():
            parsed_dir = replay / "results"
            previous = {}
    else:
        r_script = _select_local_template(
            exposure_source, outcome_source, output_dir,
            gwas_token, pval_thresholds,
        )
        success = _execute_r_script(r_script, output_dir)
    result = _parse_results(exp_id, out_id, parsed_dir, previous=previous)
    if not result.mr_results and not any(name in _output_identities(parsed_dir) and _output_identities(parsed_dir)[name] != previous.get(name) for name in ("selected-source-rows.csv", "harmonised-rows.csv")):
        raise_for_source_failure(parsed_dir)
    if not success:
        result.analysis_status = "partial" if result.mr_results else "failed"
        result.analysis_error_code = str(read_error_file(parsed_dir).get("code") or "analysis_failed")
    result.exposure_source_type = exposure_source.source_type
    result.outcome_source_type = outcome_source.source_type
    for label, source in (("exposure", exposure_source), ("outcome", outcome_source)):
        setattr(result, f"{label}_scale", source.effect_scale)
        if source.is_local():
            setattr(result, f"{label}_name", source.trait_name)
            setattr(result, f"{label}_metadata", {
                "gwas_id": source.gwas_id, "trait": source.trait_name,
                "sample_size": source.sample_size, "population": source.population,
                "metadata_source": "provided_local_data",
            })
            if source.sample_size is not None:
                setattr(result, f"sample_size_{label}", source.sample_size)
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


def _output_identities(root: Path) -> dict:
    return {path.name: (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            for path in root.iterdir() if path.is_file() and not path.is_symlink() for info in [path.stat()]}


def _parse_results(
    exposure_id: str, outcome_id: str, output_dir: Path, *, previous: dict | None = None,
) -> MRAnalysisResult:
    """Parse R output files into MRAnalysisResult."""
    result = MRAnalysisResult(
        exposure_id=exposure_id, outcome_id=outcome_id,
        raw_data_path=output_dir,
    )
    current = _output_identities(output_dir)
    files = {"summary": "summary.json", "instrumentStrength": "f_statistics.csv", "primaryEstimate": "mr_results.csv",
             "heterogeneity": "heterogeneity.csv", "pleiotropy": "pleiotropy.csv", "steiger": "steiger.csv",
             "presso": "mrpresso.csv", "radial": "radial.csv", "conmix": "conmix.csv"}
    for name, parser in (("summary", _parse_summary), ("instrumentStrength", _parse_f_statistics),
                         ("primaryEstimate", _parse_mr_csv), ("heterogeneity", _parse_het_csv),
                         ("pleiotropy", _parse_plt_csv), ("steiger", _parse_steiger_csv),
                         ("presso", _parse_presso_csv), ("radial", _parse_radial_csv), ("conmix", _parse_conmix_csv)):
        if previous is not None and (files[name] not in current or current[files[name]] == previous.get(files[name])):
            result.module_status[name] = {"status": "unavailable", "reason": "not_produced_by_this_attempt"}
            continue
        try:
            parser(result, output_dir)
        except (OSError, ValueError, TypeError, KeyError):
            result.module_status[name] = {"status": "unavailable", "reason": "incomplete_or_invalid_output"}
    if result.mr_results:
        result.module_status["primaryEstimate"] = {"status": "completed"}
        if not result.n_instruments:
            result.n_instruments = max(item.nsnp for item in result.mr_results)
    else:
        result.module_status.setdefault("primaryEstimate", {"status": "unavailable", "reason": "no_complete_numeric_rows"})
        result.analysis_status = "failed"
        result.analysis_error_code = "mr_analysis_incomplete"
    observed = {"instrumentStrength": bool(result.instrument_strength), "heterogeneity": bool(result.heterogeneity),
                "pleiotropy": result.pleiotropy is not None, "steiger": result.steiger_status == "computed",
                "presso": result.presso_global_pval is not None, "radial": result.radial_pval is not None, "conmix": result.conmix_pval is not None}
    for name, available in observed.items():
        result.module_status.setdefault(name, {"status": "completed" if available else "unavailable"})
    path = output_dir / "harmonised-rows.csv"
    if path.is_file() and not path.is_symlink() and path.stat().st_size <= 8 * 1024 * 1024:
        from mr_agent.source_context import variant_sample_summary
        try:
            rows = pd.read_csv(path)
            for role in ("exposure", "outcome"):
                if f"samplesize.{role}" in rows:
                    result.variant_sample_sizes[role] = variant_sample_summary(rows[f"samplesize.{role}"], scope="harmonised_rows")
        except (OSError, ValueError):
            pass
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
    # jsonlite writes a one-element vector as a bare string even under I(), so
    # accept both shapes rather than silently dropping a single skip.
    skipped = data.get("skipped_analyses") or []
    if isinstance(skipped, str):
        skipped = [skipped]
    result.skipped_analyses = [str(item) for item in skipped]
    harmonisation_file = output_dir / "harmonisation.json"
    if harmonisation_file.is_file():
        try:
            value = json.loads(harmonisation_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            value = None
        if isinstance(value, dict):
            result.harmonisation = value
    selection_file = output_dir / "instrument-selection.json"
    if selection_file.exists():
        result.instrument_selection = json.loads(selection_file.read_text(encoding="utf-8"))


def read_error_file(output_dir: Path) -> dict:
    """Return the classified failure the R template wrote, if any."""
    error_file = output_dir / "mr_error.json"
    if not error_file.exists():
        return {}
    try:
        data = json.loads(error_file.read_text())
    except (OSError, json.JSONDecodeError) as error:
        logger.error("Unreadable mr_error.json in %s: %s", output_dir, error)
        return {}
    return data if isinstance(data, dict) else {}


def raise_for_source_failure(output_dir: Path) -> dict:
    """Turn a source-level R failure into a coded exception.

    An analysis-level failure (too few instruments, no outcome rows) is
    returned instead: those are results, and other exposure-outcome pairs in
    the same job can still run.
    """
    data = read_error_file(output_dir)
    if not data:
        return {}
    code = str(data.get("code") or "")
    message = str(data.get("error") or "MR analysis failed")
    if code in SOURCE_ERROR_CODES:
        raise MRSourceError(message, code=code)
    if code:
        logger.error("MR analysis failure [%s]: %s", code, message)
    else:
        # Pre-classification artifact, or a template that has not been updated.
        logger.error("MR error without a code: %s", message)
    return data


def _check_error_file(output_dir: Path) -> None:
    """Raise for a source failure, log an analysis failure."""
    raise_for_source_failure(output_dir)


def _parse_mr_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse MR results CSV."""
    csv_path = output_dir / "mr_results.csv"
    if not csv_path.exists():
        return
    if csv_path.is_symlink() or csv_path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Unsafe primary output")
    df = pd.read_csv(csv_path)
    required = {"method", "nsnp", "b", "se", "pval"}
    if not required <= set(df.columns) or df.empty:
        raise ValueError("Incomplete primary output")
    parsed = []
    for _, row in df.iterrows():
        if any(safe_float(row.get(key)) is None for key in required - {"method"}) or not str(row["method"]).strip():
            raise ValueError("Incomplete primary row")
        if float(row["se"]) <= 0 or (int(row["nsnp"]) <= 0 or float(row["nsnp"]) != int(row["nsnp"])) or not 0 <= float(row["pval"]) <= 1:
            raise ValueError("Invalid primary row")
        parsed.append(_row_to_mr_result(row))
    result.mr_results = parsed


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
    """Parse the Steiger directionality test, or the reason it was not computed."""
    csv_path = output_dir / "steiger.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    if len(df) == 0:
        return
    row = df.iloc[0]
    status = str(row.get("status", "") or "").strip()
    if status in {"computed", "not_computable", "failed"}:
        result.steiger_status = status
        reason = str(row.get("reason", "") or "").strip()
        result.steiger_reason = "" if reason == "NA" else reason
    raw = row.get("correct_causal_direction")
    if isinstance(raw, (bool,)) or str(raw).upper() in {"TRUE", "FALSE"}:
        result.steiger_correct = str(raw).upper() == "TRUE"
        # A file from before the status column was written holds a verdict.
        if result.steiger_status == "not_run":
            result.steiger_status = "computed"
    result.steiger_pval = safe_float(row.get("steiger_pval"))
    result.steiger_r2_exposure = safe_float(row.get("snp_r2.exposure"))
    result.steiger_r2_outcome = safe_float(row.get("snp_r2.outcome"))


def _bounded_probability(raw) -> tuple[float | None, str]:
    """A permutation p value: exact, or a strict upper bound such as "<0.001"."""
    bounded = isinstance(raw, str) and raw.strip().startswith("<")
    value = safe_float(raw.strip()[1:].strip() if bounded else raw)
    if value is None or not 0 <= value <= 1 or (bounded and value == 0):
        return None, "="
    return value, "<" if bounded else "="


def _parse_presso_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse MR-PRESSO: global test, outliers, and the outlier-corrected estimate."""
    csv_path = output_dir / "mrpresso.csv"
    if not csv_path.exists():
        return
    df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    if len(df) == 0:
        return
    row = df.iloc[0]
    global_p, relation = _bounded_probability(row.get("global_p"))
    if global_p is not None:
        result.presso_global_pval = global_p
        result.presso_global_pval_relation = relation
    n_out = safe_int(row.get("n_outliers"))
    if n_out is not None:
        result.presso_n_outliers = n_out
    if "corrected_reason" not in row:
        return  # written before the corrected estimate was kept
    distortion_p, distortion_relation = _bounded_probability(row.get("distortion_p"))
    snps = [snp for snp in str(row.get("outlier_snps") or "").split(";") if snp.strip()]
    result.presso_correction = MRPressoCorrection(
        n_distributions=safe_int(row.get("n_distributions")),
        outlier_resolution=safe_float(row.get("outlier_resolution")),
        outlier_snps=[snp.strip() for snp in snps],
        beta=safe_float(row.get("corrected_beta")),
        se=safe_float(row.get("corrected_se")),
        pval=safe_float(row.get("corrected_p")),
        or_value=safe_float(row.get("corrected_or")),
        ci_lower=safe_float(row.get("corrected_ci_lower")),
        ci_upper=safe_float(row.get("corrected_ci_upper")),
        distortion_coefficient=safe_float(row.get("distortion_coefficient")),
        distortion_pval=distortion_p,
        distortion_pval_relation=distortion_relation,
        reason=str(row.get("corrected_reason") or "").strip(),
    )


def _parse_f_statistics(result: MRAnalysisResult, output_dir: Path) -> None:
    """Summarise per-instrument F statistics: count, spread, and the weakest and strongest variant."""
    csv_path = output_dir / "f_statistics.csv"
    if not csv_path.exists():
        return
    try:
        df = pd.read_csv(csv_path)
    except (OSError, ValueError):
        return
    if "f_statistic" not in df.columns:
        return
    values = pd.to_numeric(df["f_statistic"], errors="coerce")
    rows = df.assign(f_statistic=values).dropna(subset=["f_statistic"])
    if rows.empty:
        return
    weakest = rows.loc[rows["f_statistic"].idxmin()]
    strongest = rows.loc[rows["f_statistic"].idxmax()]
    result.instrument_strength = {
        "n": int(len(rows)),
        "mean": float(rows["f_statistic"].mean()),
        "median": float(rows["f_statistic"].median()),
        "min": float(weakest["f_statistic"]),
        "min_snp": str(weakest.get("snp", "")),
        "max": float(strongest["f_statistic"]),
        "max_snp": str(strongest.get("snp", "")),
        "below_10": int((rows["f_statistic"] < 10).sum()),
    }


def _collect_plots(result: MRAnalysisResult, output_dir: Path) -> None:
    """Collect generated plot paths (PDF and PNG)."""
    try:
        ledger = json.loads((output_dir / "diagnostic-plots.json").read_text())
    except (OSError, ValueError):
        ledger = {}
    for name in ["scatter_plot", "forest_plot", "funnel_plot", "loo_plot",
                  "summary_forest"]:
        paths = [output_dir / f"{name}.pdf", output_dir / f"{name}.png"]
        item = ledger.get(name, {}) if isinstance(ledger, dict) else {}
        if name != "summary_forest" and isinstance(item, dict) and item.get("status") in {"skipped", "failed"}:
            continue
        pages = item.get("pages") if isinstance(item, dict) else None
        if type(pages) is int and 1 < pages <= 64:
            paths.extend(output_dir / f"{name}-{index:03d}.png" for index in range(2, pages + 1))
        for plot_path in paths:
            if plot_path.is_file():
                key = f"{plot_path.stem}_{plot_path.suffix[1:]}"
                result.plots[key] = plot_path


# --- Local data script builders ---


def _build_local_clumping(source: DataSource) -> str:
    """Never substitute unselected SNPs when the requested LD step fails."""
    if source.instruments_preclumped and source.selection:
        # Selected by this engine from open summary statistics: say how, as
        # recorded, rather than calling it a supplier's declaration.
        selection = json.dumps(json.dumps(source.selection, ensure_ascii=True, sort_keys=True))
        block = (
            f'instrument_selection <- jsonlite::fromJSON({selection}, simplifyVector=TRUE)\n'
            'cat(sprintf("Instruments selected from open summary statistics by %s.\\n", '
            'instrument_selection$method))\n'
        )
    elif source.instruments_preclumped:
        provenance = json.dumps(source.clumping_provenance, ensure_ascii=True)
        block = (
            'instrument_selection <- list(mode="provided_preclumped", '
            f'provenance={provenance}, ld_rechecked=FALSE)\n'
            'cat("Using provided clumped instruments; LD was not independently rechecked.\\n")\n'
        )
    else:
        block = '''tryCatch({
    exposure_dat <- clump_data(exposure_dat, clump_r2=0.001, clump_kb=10000)
}, error=function(e) {
    # A refused token reaches this handler too; reporting it as a clumping
    # failure sends the researcher to the wrong problem.
    guard_auth_failure("LD clumping failed", e$message)
    mr_fail("ld_clumping_failed",
        sprintf("LD clumping failed; no unselected instruments were analyzed: %s", e$message))
})
instrument_selection <- list(mode="opengwas", r2=0.001, kb=10000, ld_rechecked=TRUE)
'''
    return block + (
        'write(toJSON(instrument_selection, auto_unbox=TRUE), '
        'file.path(output_dir,"instrument-selection.json"))\n'
    )


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
        clumping_block=_build_local_clumping(exp_src),
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
        clumping_block=_build_local_clumping(exp_src),
        out_zscore_block=_build_zscore_block(out_mapping, "raw_out"),
        out_log10p_block=_build_log10p_block(out_mapping, "raw_out"),
        **exp_args,
        **out_args,
    )


# --- New method executors ---


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
    raise_for_source_failure(output_dir)
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
    row = _first_row(output_dir / "radial.csv")
    if row is not None:
        result.radial_n_outliers = safe_int(row.get("n_outliers"))


def _parse_conmix_csv(result: MRAnalysisResult, output_dir: Path) -> None:
    """Parse Contamination Mixture results CSV."""
    _parse_single_pval_csv(result, output_dir, "conmix.csv", "pval", "conmix_pval")
    row = _first_row(output_dir / "conmix.csv")
    if row is not None:
        result.conmix_estimate = safe_float(row.get("estimate"))
        result.conmix_ci_lower = safe_float(row.get("ci_lower"))
        result.conmix_ci_upper = safe_float(row.get("ci_upper"))
        result.conmix_n_intervals = safe_int(row.get("n_intervals"))


def _first_row(csv_path: Path):
    if not csv_path.exists():
        return None
    df = pd.read_csv(csv_path)
    return df.iloc[0] if len(df) > 0 else None


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
    labels_str = ", ".join(f'"{label}"' for label in labels)
    out = _r_path(output_dir)
    script = MR_FOREST_SUMMARY_TEMPLATE.format(
        output_dir=out, result_csv_paths=paths_str, pair_labels=labels_str,
    )
    return _execute_r_script(script, output_dir)
