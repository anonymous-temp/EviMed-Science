"""Local instruments need either completed LD selection or explicit provenance."""

import json
from types import SimpleNamespace

import pytest

from mr_agent.models import DataSource, DataSourceType, MRAnalysisResult, SessionState
from mr_agent.paper.generator import PaperGenerator
from mr_agent.tools.mr_executor import _build_local_both_script
from r_scripts.templates import _ERROR_HANDLING_BLOCK
from test_local_r_statistics import run_r

# The clumping block classifies its failure through the shared helpers, so a
# script exercising it in isolation has to carry them the way every composed
# template does. The block has no placeholders, only escaped braces.
ERROR_HELPERS = _ERROR_HANDLING_BLOCK.format()


def source(tmp_path, **values):
    return DataSource(source_type=DataSourceType.LOCAL_FILE, file_path=str(tmp_path / "data.csv"), **values)


def test_preclumped_inputs_require_source_provenance(tmp_path):
    with pytest.raises(ValueError, match="provenance"):
        source(tmp_path, instruments_preclumped=True)


def clumping_block(tmp_path, exposure):
    script = _build_local_both_script(exposure, source(tmp_path), tmp_path, "", [5e-8])
    return script.split("# Clump via LD reference", 1)[1].split("if (nrow(exposure_dat) < 3)", 1)[0]


def test_clump_api_failure_cannot_continue_with_unclumped_instruments(tmp_path):
    script = (
        'library(jsonlite)\noutput_dir <- ' + json.dumps(tmp_path.as_posix())
        + ERROR_HELPERS
        + '\nexposure_dat <- data.frame(SNP=c("rs1","rs2","rs3"))\n'
        'clump_data <- function(...) stop("offline acceptance: network refused")\n'
        + '# Clump via LD reference' + clumping_block(tmp_path, source(tmp_path))
        + '\nwrite("incorrect-success", file.path(output_dir,"continued.txt"))\n'
    )
    # The injected dependency fails; the generated script must end before
    # downstream statistics. This is a failure test, never a fake API success.
    with pytest.raises(AssertionError):
        run_r(script, tmp_path)
    error = json.loads((tmp_path / "mr_error.json").read_text())
    assert error["code"] == "ld_clumping_failed"
    assert not (tmp_path / "continued.txt").exists()


def test_provided_clumped_data_never_calls_the_api_and_keeps_its_provenance(tmp_path):
    note = 'Official instrument extraction snapshot; "LD" selection is supplied, not rechecked.'
    exposure = source(tmp_path, instruments_preclumped=True, clumping_provenance=note)
    script = (
        'library(jsonlite)\noutput_dir <- ' + json.dumps(tmp_path.as_posix())
        + ERROR_HELPERS
        + '\nexposure_dat <- data.frame(SNP=c("rs1","rs2","rs3"))\n'
        'clump_data <- function(...) stop("the API must not be called")\n'
        + '# Clump via LD reference' + clumping_block(tmp_path, exposure)
        + '\nwrite(toJSON(instrument_selection,auto_unbox=TRUE),file.path(output_dir,"selection.json"))\n'
    )
    run_r(script, tmp_path)
    selection = json.loads((tmp_path / "selection.json").read_text())
    assert selection == {"mode": "provided_preclumped", "provenance": note, "ld_rechecked": False}


@pytest.mark.parametrize("language", ["en", "zh"])
def test_report_does_not_claim_to_have_reclumped_provided_instruments(language):
    result = MRAnalysisResult(exposure_id="exposure", outcome_id="outcome", instrument_selection={
        "mode": "provided_preclumped", "provenance": "Official extraction snapshot", "ld_rechecked": False,
    })
    generator = PaperGenerator(SimpleNamespace(), SessionState(analysis_results=[result]), language=language)
    methods = generator._grounded_methods([result])
    assert "Official extraction snapshot" in methods
    assert "not independently rechecked" in methods if language == "en" else "未独立重新核验" in methods
    assert "followed by LD clumping" not in methods
    assert "执行LD clumping" not in methods


@pytest.mark.parametrize("language", ["en", "zh"])
def test_local_metadata_does_not_become_verified_public_source_metadata(language):
    result = MRAnalysisResult(
        exposure_id="hospital-exposure.csv", outcome_id="hospital-outcome.csv",
        exposure_source_type=DataSourceType.LOCAL_FILE, outcome_source_type=DataSourceType.LOCAL_FILE,
        exposure_metadata={"metadata_source": "provided_local_data", "sample_size": 500},
        outcome_metadata={"metadata_source": "provided_local_data", "population": "provided cohort"},
    )
    generator = PaperGenerator(SimpleNamespace(), SessionState(analysis_results=[result]), language=language)
    methods = generator._grounded_methods([result])
    table = generator._grounded_table1([result])
    assert "Provided; not independently verified" in table
    assert "not independently verified" in methods if language == "en" else "未独立核验" in methods
    assert "gwas.mrcieu.ac.uk" not in generator._grounded_data_availability([result])
    ethics = generator._grounded_ethics_statement()
    assert "only public" not in ethics and "仅处理公开" not in ethics


def test_a_refused_credential_during_clumping_is_not_reported_as_a_clumping_bug(tmp_path):
    """The stage code is right, but "LD clumping failed" sends the researcher to
    the wrong problem when the real cause is an expired token."""
    script = (
        'library(jsonlite)\noutput_dir <- ' + json.dumps(tmp_path.as_posix())
        + ERROR_HELPERS
        + '\nexposure_dat <- data.frame(SNP=c("rs1","rs2","rs3"))\n'
        'clump_data <- function(...) stop("401 Unauthorized: your OPENGWAS_JWT has expired")\n'
        + '# Clump via LD reference' + clumping_block(tmp_path, source(tmp_path))
        + '\nwrite("incorrect-success", file.path(output_dir,"continued.txt"))\n'
    )
    with pytest.raises(AssertionError):
        run_r(script, tmp_path)
    error = json.loads((tmp_path / "mr_error.json").read_text())
    assert error["code"] == "opengwas_auth_failed"
    assert not (tmp_path / "continued.txt").exists()
