"""The bundled R library must actually be reachable.

TwoSampleMR and its companions are vendored into .r-lib beside the agent rather
than installed system-wide, and nothing ever put that directory on R's search
path: both Rscript calls inherited an environment with no R_LIBS_USER in it, so
every run failed reporting the packages as missing while they sat on disk.
"""
import subprocess

from mr_agent.tools.mr_executor import (
    _BUNDLED_R_LIBRARY,
    _R_ISOLATION_FLAGS,
    _r_subprocess_env,
)


def test_the_bundled_library_reaches_the_subprocess_environment():
    env = _r_subprocess_env()
    if not _BUNDLED_R_LIBRARY.is_dir():
        return  # no vendored library on this host
    assert str(_BUNDLED_R_LIBRARY) in env.get("R_LIBS_USER", ""), (
        "the vendored library must be on R_LIBS_USER; inheriting os.environ alone "
        "leaves it unset and every package reads as missing"
    )


def test_r_resolves_every_package_the_analysis_needs():
    """The real check: run R exactly as the analysis does and see what loads."""
    if not _BUNDLED_R_LIBRARY.is_dir():
        return
    packages = '"TwoSampleMR","ieugwasr","jsonlite","MRPRESSO"'
    try:
        result = subprocess.run(
            ["Rscript", *_R_ISOLATION_FLAGS, "-e",
             f'cat(paste(c({packages})[!sapply(c({packages}), requireNamespace, quietly=TRUE)], collapse=","))'],
            capture_output=True, text=True, timeout=180, env=_r_subprocess_env(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return  # R is not installed on this host
    assert result.stdout.strip() == "", f"unreachable R packages: {result.stdout.strip()}"


def test_a_package_that_is_present_but_unloadable_names_its_real_gap():
    """TwoSampleMR sat on disk unusable for want of data.table, and the check
    said to install TwoSampleMR. The remedy has to name what is actually
    missing, so the R error travels back with the package name."""
    import subprocess
    from unittest import mock

    from mr_agent.tools import mr_executor

    completed = subprocess.CompletedProcess(
        args=["Rscript"], returncode=0,
        stdout="TwoSampleMR: there is no package called 'data.table'", stderr="",
    )
    with mock.patch.object(mr_executor.subprocess, "run", return_value=completed):
        ok, message = mr_executor.check_r_environment()

    assert ok is False
    assert "data.table" in message, "the message must name the dependency that is actually missing"
    assert "fails to load" in message, "it must distinguish absent from unloadable"
