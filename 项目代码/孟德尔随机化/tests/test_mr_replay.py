"""A portable replay must preserve the actual executed inputs, code and seed."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import evimed_runner
from mr_agent.models import ColumnMapping, DataSource, DataSourceType
from mr_agent.tools import mr_executor
from mr_agent.tools.mr_replay import complete_local_replay, copy_replay_package, prepare_local_replay


def local_source(path, *, preclumped=True):
    path.write_bytes(
        b'SNP,beta,se,effect_allele,other_allele,eaf,pval\r\n'
        b'rs1,0.2,0.01,A,G,0.2,1e-10\r\n'
    )
    return DataSource(
        source_type=DataSourceType.LOCAL_FILE,
        file_path=str(path),
        column_mapping=ColumnMapping(),
        instruments_preclumped=preclumped,
        clumping_provenance="Supplied study instrument set; LD not rechecked." if preclumped else None,
    )


def fake_success(script_path, work_dir):
    assert script_path == work_dir / "run.R"
    options = json.loads((work_dir / "options.json").read_text())
    assert options["seed"] == 73421
    assert "set.seed(options$seed)" in script_path.read_text()
    results = work_dir / "results"
    results.mkdir()
    (results / "mr_summary.json").write_text(json.dumps({"status": "success", "n_instruments": 3}))
    (results / "mr_results.csv").write_text(
        "method,nsnp,b,se,pval\nInverse variance weighted,3,0.2,0.01,1e-10\n"
    )
    (results / "environment.json").write_text(json.dumps({
        "r_version": "4.5.1", "seed": options["seed"], "packages": {"TwoSampleMR": "0.7.6"},
    }))
    return True


def test_original_uses_the_delivered_entry_and_exact_private_input_bytes(tmp_path, monkeypatch):
    exposure = local_source(tmp_path / "customer-exposure.csv")
    outcome = local_source(tmp_path / "customer-outcome.csv")
    expected = Path(exposure.file_path).read_bytes()
    raw = tmp_path / "scratch" / "pair"
    monkeypatch.setattr(mr_executor, "_execute_r_file", fake_success)
    result = mr_executor.run_mr_local(
        exposure, outcome, raw, "must-not-enter-package", [5e-8, 5e-6], seed=73421,
    )
    replay = raw / "replay"
    assert result.n_instruments == 3
    assert (replay / "inputs/exposure.csv").read_bytes() == expected
    script = (replay / "analysis.R").read_text()
    assert "mr_res <- mr(dat)" in script
    assert "clump_data(" not in script
    assert "must-not-enter-package" not in script
    assert str(tmp_path) not in script
    assert "customer-exposure" not in script
    options = json.loads((replay / "options.json").read_text())
    assert options["effective_pval_threshold"] == 5e-8
    assert options["requested_pval_thresholds"] == [5e-8, 5e-6]
    assert options["sources"]["exposure"]["ld_rechecked"] is False
    manifest = json.loads((replay / "manifest.json").read_text())
    assert manifest["status"] == "complete"
    assert manifest["files"]["inputs/exposure.csv"]["sha256"] == hashlib.sha256(expected).hexdigest()
    assert manifest["original_outputs"]["mr_results.csv"]["sha256"] == hashlib.sha256(
        (raw / "mr_results.csv").read_bytes()
    ).hexdigest()
    assert str(tmp_path) not in json.dumps(manifest)

    (raw / "secret-remote.R").write_text("never publish this transient script")
    (replay / "unrelated.R").write_text("never publish this extra script")
    output = tmp_path / "published"
    output.mkdir()
    copied = evimed_runner._copy_release_artifacts(output, SimpleNamespace(output_dir=None), [result])
    destination = output / result.raw_data_path / "replay"
    assert any(name.endswith("replay/run.R") for name in copied)
    assert not any("secret-remote" in name or "unrelated" in name for name in copied)
    shutil.rmtree(raw.parent)
    Path(exposure.file_path).unlink()
    Path(outcome.file_path).unlink()
    assert (destination / "inputs/exposure.csv").read_bytes() == expected
    assert (destination / "run.R").is_file()


@pytest.mark.parametrize("reason", [
    "Insufficient IVs after p-value filtering (< 3)",
    "Insufficient SNPs after harmonization (< 3)",
])
def test_zero_exit_insufficiency_preserves_the_original_empty_result(tmp_path, monkeypatch, reason):
    exposure = local_source(tmp_path / "exposure.csv")
    outcome = local_source(tmp_path / "outcome.csv")
    raw = tmp_path / "analysis"

    def insufficient(_entry, root):
        results = root / "results"
        results.mkdir()
        (results / "mr_error.json").write_text(json.dumps({"error": reason}))
        return True  # The shared template exits R with status zero here.

    monkeypatch.setattr(mr_executor, "_execute_r_file", insufficient)
    result = mr_executor.run_mr_local(exposure, outcome, raw)
    assert result.n_instruments == 0
    assert result.mr_results == []
    assert json.loads((raw / "mr_error.json").read_text()) == {"error": reason}
    manifest = json.loads((raw / "replay/manifest.json").read_text())
    assert manifest["status"] == "analysis_failed"
    assert "observed-environment.json" not in manifest["files"]
    with pytest.raises(ValueError, match="incomplete"):
        copy_replay_package(raw / "replay", tmp_path / "published")


@pytest.mark.parametrize("mode", ["mixed", "remote", "requires_clumping"])
def test_unsupported_paths_never_publish_replay(tmp_path, monkeypatch, mode):
    exposure = local_source(tmp_path / "exposure.csv", preclumped=mode != "requires_clumping")
    outcome = local_source(tmp_path / "outcome.csv")
    if mode in {"mixed", "remote"}:
        outcome = DataSource(gwas_id="ieu-a-7")
    if mode == "remote":
        exposure = DataSource(gwas_id="ieu-a-2")
    monkeypatch.setattr(mr_executor, "_execute_r_script", lambda *_args: False)
    raw = tmp_path / "pair"
    mr_executor.run_mr_local(exposure, outcome, raw)
    assert not (raw / "replay").exists()


@pytest.mark.parametrize("seed", [True, -1, 2**31, 1.5])
def test_invalid_seed_is_rejected_before_execution(tmp_path, seed):
    exposure = local_source(tmp_path / "exposure.csv")
    outcome = local_source(tmp_path / "outcome.csv")
    with pytest.raises(ValueError, match="seed"):
        mr_executor.run_mr_local(exposure, outcome, tmp_path / "pair", seed=seed)


@pytest.mark.parametrize("damage", ["input", "entry_symlink", "manifest_path", "incomplete"])
def test_runner_rejects_changed_or_incomplete_replay_package(tmp_path, monkeypatch, damage):
    exposure = local_source(tmp_path / "exposure.csv")
    outcome = local_source(tmp_path / "outcome.csv")
    raw = tmp_path / "pair"
    monkeypatch.setattr(mr_executor, "_execute_r_file", fake_success)
    result = mr_executor.run_mr_local(exposure, outcome, raw, seed=73421)
    replay = raw / "replay"
    manifest_file = replay / "manifest.json"
    manifest = json.loads(manifest_file.read_text())
    if damage == "input":
        (replay / "inputs/exposure.csv").write_text("modified")
    elif damage == "entry_symlink":
        (replay / "run.R").unlink()
        (replay / "run.R").symlink_to(replay / "analysis.R")
    elif damage == "manifest_path":
        manifest["files"]["../unexpected.R"] = {}
    else:
        manifest["status"] = "prepared"
    manifest_file.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="replay"):
        evimed_runner._copy_release_artifacts(
            tmp_path / "output", SimpleNamespace(output_dir=None), [result]
        )


def test_portable_r_entry_reuses_seed_and_rejects_modified_input(tmp_path):
    """Exercise entry/receipt plumbing in R; clinical numeric acceptance is separate."""
    if shutil.which("Rscript") is None:
        pytest.skip("Rscript is unavailable")
    env = mr_executor._r_subprocess_env()
    check = subprocess.run(
        ["Rscript", "--vanilla", "-e", 'quit(status=if(requireNamespace("TwoSampleMR", quietly=TRUE)) 0 else 77)'],
        capture_output=True, text=True, timeout=30, env=env,
    )
    if check.returncode == 77:
        pytest.skip("TwoSampleMR is unavailable")
    assert check.returncode == 0, check.stderr
    exposure = local_source(tmp_path / "exposure.csv")
    outcome = local_source(tmp_path / "outcome.csv")
    original = tmp_path / "original"
    original.mkdir()
    replay = prepare_local_replay(
        exposure, outcome, original, [5e-8], 73421,
        lambda *_args: 'library(TwoSampleMR)\nwrite.csv(data.frame(draw=runif(4)), "results/draw.csv", row.names=FALSE)\n'
        'write(\'{"status":"success"}\', "results/mr_summary.json")\n',
    )

    def execute(root):
        command = ["Rscript", "--vanilla", str(root / "run.R")]
        if shutil.which("sandbox-exec"):
            command = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", *command]
        return subprocess.run(command, cwd=tmp_path, capture_output=True, text=True, timeout=30, env=env)

    first = execute(replay)
    assert first.returncode == 0, first.stderr
    complete_local_replay(replay, original)
    relocated = tmp_path / "fresh" / "package"
    copy_replay_package(replay, relocated)
    second = execute(relocated)
    assert second.returncode == 0, second.stderr
    assert (original / "draw.csv").read_bytes() == (relocated / "results/draw.csv").read_bytes()
    observed = json.loads((replay / "observed-environment.json").read_text())
    assert observed["seed"] == 73421
    assert observed["packages"]["TwoSampleMR"]
    assert "mr_ivw" in observed["two_sample_mr_defaults"]["methods"]
    assert str(tmp_path) not in json.dumps(observed)
    (relocated / "inputs/exposure.csv").write_text("changed")
    third = execute(relocated)
    assert third.returncode != 0
    assert "Replay file changed: inputs/exposure.csv" in third.stderr
