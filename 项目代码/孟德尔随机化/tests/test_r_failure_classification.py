"""A refused source must not be reported as an empty result set (R021, R022, R025).

Before this, every per-threshold tryCatch in the R templates only cat()'d its
message, so an OpenGWAS 401 fell through to
`{"error": "Insufficient instrumental variables (< 3)"}` with `quit(status = 0)`.
The job then told the researcher their exposure had no instruments when in fact
their JWT had expired.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mr_agent.tools import mr_executor
from mr_agent.tools.mr_executor import (
    ANALYSIS_ERROR_CODES,
    SOURCE_ERROR_CODES,
    MRSourceError,
    raise_for_source_failure,
)
from r_scripts import templates

ROOT = Path(__file__).resolve().parents[1]
R_LIBRARY = ROOT / ".r-lib"

_TEMPLATE_ARGS = dict(
    token_line='Sys.setenv(OPENGWAS_JWT="expired.jwt.value")',
    exposure_id="ieu-a-2",
    outcome_id="ieu-a-7",
    thresholds="5e-08, 5e-06, 5e-05",
)

# Both OpenGWAS calls raise the message the API returns for an expired JWT;
# everything else is the shipped template.
_AUTH_STUB = """
library(TwoSampleMR)
extract_instruments <- function(...) stop("OpenGWAS request failed: 401 Unauthorized. Your token may have expired.")
extract_outcome_data <- function(...) stop("OpenGWAS request failed: 401 Unauthorized")
"""

# extract_instruments answers, but with nothing usable: a real empty result.
_EMPTY_STUB = """
library(TwoSampleMR)
extract_instruments <- function(...) NULL
extract_outcome_data <- function(...) NULL
"""


def _run_standard_template(tmp_path: Path, stub: str) -> subprocess.CompletedProcess:
    script = templates.MR_STANDARD_TEMPLATE.format(
        output_dir=str(tmp_path), **_TEMPLATE_ARGS
    )
    script = script.replace("library(TwoSampleMR)\n", "library(TwoSampleMR)\n" + stub, 1)
    script_path = tmp_path / "run.R"
    script_path.write_text(script, encoding="utf-8")
    env = {"R_LIBS_USER": str(R_LIBRARY), "HOME": str(tmp_path), "PATH": "/usr/bin:/bin"}
    return subprocess.run(
        ["Rscript", "--vanilla", str(script_path)],
        capture_output=True, text=True, timeout=600, env=env,
    )


requires_r = pytest.mark.skipif(
    shutil.which("Rscript") is None or not R_LIBRARY.is_dir(),
    reason="Rscript or the bundled R library is not available",
)


@requires_r
def test_expired_jwt_is_classified_and_exits_non_zero(tmp_path):
    completed = _run_standard_template(tmp_path, _AUTH_STUB)
    assert completed.returncode != 0, completed.stdout
    payload = json.loads((tmp_path / "mr_error.json").read_text())
    assert payload["code"] == "opengwas_auth_failed"
    assert "401" in payload["error"]
    # Retrying an expired token cannot help: it must stop at the first threshold.
    assert completed.stdout.count("failed: OpenGWAS request failed") == 1


@requires_r
def test_a_genuinely_empty_result_is_still_no_instruments(tmp_path):
    completed = _run_standard_template(tmp_path, _EMPTY_STUB)
    assert completed.returncode != 0
    payload = json.loads((tmp_path / "mr_error.json").read_text())
    assert payload["code"] == "no_instruments"


@pytest.mark.parametrize("template_name", [
    "MR_STANDARD_TEMPLATE",
    "MR_LOCAL_EXPOSURE_TEMPLATE",
    "MR_LOCAL_OUTCOME_TEMPLATE",
    "MR_LOCAL_BOTH_TEMPLATE",
    "MR_MVMR_TEMPLATE",
])
def test_no_template_writes_an_uncoded_failure(template_name):
    template = getattr(templates, template_name)
    assert "quit(status = 0)" not in template
    assert "mr_fail" in template
    # The helper definitions must travel with the calls.
    assert "classify_source_failure" in template


def test_source_and_analysis_codes_do_not_overlap():
    assert not (SOURCE_ERROR_CODES & ANALYSIS_ERROR_CODES)


@pytest.mark.parametrize("code", sorted(SOURCE_ERROR_CODES))
def test_a_coded_source_failure_raises(tmp_path, code):
    (tmp_path / "mr_error.json").write_text(
        json.dumps({"error": "source refused", "code": code}), encoding="utf-8"
    )
    with pytest.raises(MRSourceError) as raised:
        raise_for_source_failure(tmp_path)
    assert raised.value.code == code


@pytest.mark.parametrize("code", sorted(ANALYSIS_ERROR_CODES))
def test_an_analysis_failure_is_returned_not_raised(tmp_path, code):
    (tmp_path / "mr_error.json").write_text(
        json.dumps({"error": "too few", "code": code}), encoding="utf-8"
    )
    assert raise_for_source_failure(tmp_path)["code"] == code


def test_missing_error_file_is_not_a_failure(tmp_path):
    assert raise_for_source_failure(tmp_path) == {}


def test_run_mr_analysis_raises_before_treating_a_refusal_as_no_result(tmp_path, monkeypatch):
    def fake_execute(_script, work_dir):
        (Path(work_dir) / "mr_error.json").write_text(
            json.dumps({"error": "401 Unauthorized", "code": "opengwas_auth_failed"}),
            encoding="utf-8",
        )
        return False  # R exited non-zero, as a classified failure now does

    monkeypatch.setattr(mr_executor, "_execute_r_script", fake_execute)
    with pytest.raises(MRSourceError) as raised:
        mr_executor.run_mr_analysis("ieu-a-2", "ieu-a-7", tmp_path)
    assert raised.value.code == "opengwas_auth_failed"


def test_r_transcript_is_kept_next_to_the_results(tmp_path):
    mr_executor._write_r_logs(tmp_path, "stdout body", "stderr body")
    assert (tmp_path / "r_stdout.log").read_text() == "stdout body"
    assert (tmp_path / "r_stderr.log").read_text() == "stderr body"


# --------------------------------------------------------------------- R022

def test_the_unrunnable_methods_are_gone():
    """MOE needed an rf.rdata that TwoSampleMR does not publish; MR-LAP was
    called with arguments MRlap::MRlap does not accept."""
    assert not hasattr(templates, "MR_MOE_TEMPLATE")
    assert not hasattr(templates, "MR_MRLAP_TEMPLATE")
    assert not hasattr(mr_executor, "run_mr_moe")
    assert not hasattr(mr_executor, "run_mr_mrlap")


def test_the_method_vocabulary_only_offers_reachable_methods():
    from mr_agent.models import MRMethod

    assert {m.value for m in MRMethod} == {"standard", "mvmr"}


# --------------------------------------------------------------------- R025

def test_steiger_failure_is_recorded_as_a_skip_not_only_printed():
    for name in ("MR_STANDARD_TEMPLATE", "MR_LOCAL_BOTH_TEMPLATE"):
        template = getattr(templates, name)
        assert 'note_skip("steiger"' in template, name
        assert 'cat(sprintf("Steiger test failed' not in template, name


def test_standard_template_runs_the_shared_sensitivity_analyses():
    template = templates.MR_STANDARD_TEMPLATE
    assert "RadialMR::ivw_radial" in template
    assert "MendelianRandomization::mr_conmix" in template


# ------------------------------------------------- module ledger (class D)

def test_a_refused_source_is_a_fatal_ledger_entry(tmp_path):
    import evimed_runner

    for code in sorted(SOURCE_ERROR_CODES - {"analysis_failed"}):
        modules = evimed_runner._failure_ledger(code)
        entry = next(iter(modules.values()))
        assert entry["status"] == "failed"
        assert entry["fatal"] is True
        assert code.replace("_", " ") or code in entry["reason"] or code in str(modules)


def test_skipped_sensitivity_analyses_degrade_without_failing_the_run():
    import evimed_runner
    from mr_agent.models import MRAnalysisResult

    result = MRAnalysisResult(
        exposure_id="ieu-a-2", outcome_id="ieu-a-7", n_instruments=79,
        steiger_correct=True,
        skipped_analyses=["radial_mr: RadialMR package not installed"],
    )
    modules = evimed_runner._module_ledger([result], bidirectional=False)
    assert modules["sensitivityAnalyses"]["status"] == "degraded"
    assert "RadialMR" in modules["sensitivityAnalyses"]["reason"]
    assert modules["primaryEstimate"]["status"] == "ok"
    assert modules["reverseMR"]["status"] == "skipped"
    assert evimed_runner._degraded(modules) is True
    assert not any(entry.get("fatal") for entry in modules.values())


def test_an_executed_reverse_pair_is_ok_and_a_missing_one_degrades():
    import evimed_runner
    from mr_agent.models import MRAnalysisResult

    forward = MRAnalysisResult(exposure_id="A", outcome_id="B", n_instruments=10,
                               steiger_correct=True)
    reverse = MRAnalysisResult(exposure_id="B", outcome_id="A", n_instruments=5,
                               steiger_correct=True)
    both = evimed_runner._module_ledger([forward, reverse], bidirectional=True)
    assert both["reverseMR"]["status"] == "ok"

    one_way = evimed_runner._module_ledger([forward], bidirectional=True)
    assert one_way["reverseMR"]["status"] == "degraded"


def test_an_absent_steiger_verdict_is_named():
    import evimed_runner
    from mr_agent.models import MRAnalysisResult

    modules = evimed_runner._module_ledger(
        [MRAnalysisResult(exposure_id="A", outcome_id="B", n_instruments=10)],
        bidirectional=False,
    )
    assert modules["steigerDirection"]["status"] == "degraded"
