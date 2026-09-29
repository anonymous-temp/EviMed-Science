"""Staged outputs cannot follow or race replaced workspace directories."""
from pathlib import Path

import pytest

from evimed_specialist_adapter import isolated_job


def _trees(tmp_path):
    workspace = (tmp_path / "workspace").resolve()
    source = tmp_path / "stage"
    output = workspace / "runs" / "output"
    other = tmp_path / "different-tenant"
    output.mkdir(parents=True)
    (source / "figures").mkdir(parents=True)
    other.mkdir()
    (source / "figures" / "result.txt").write_text("verified result")
    return source, output, workspace, other


def test_publish_refuses_destination_parent_symlink(tmp_path):
    source, output, workspace, other = _trees(tmp_path)
    (output / "figures").symlink_to(other, target_is_directory=True)
    with pytest.raises((OSError, isolated_job.IsolatedJobError)):
        isolated_job.publish(source, output, workspace)
    assert list(other.iterdir()) == []


def test_publish_refuses_output_root_symlink(tmp_path):
    source, output, workspace, other = _trees(tmp_path)
    output.rmdir()
    output.symlink_to(other, target_is_directory=True)
    with pytest.raises((OSError, isolated_job.IsolatedJobError)):
        isolated_job.publish(source, output, workspace)
    assert list(other.iterdir()) == []


def test_publish_detects_replaced_output_root_after_read(tmp_path, monkeypatch):
    source, output, workspace, other = _trees(tmp_path)
    read = isolated_job.audit_receipt._read_file

    def replace_output(*args, **kwargs):
        blob = read(*args, **kwargs)
        output.rename(output.with_name("moved"))
        output.symlink_to(other, target_is_directory=True)
        return blob

    monkeypatch.setattr(isolated_job.audit_receipt, "_read_file", replace_output)
    with pytest.raises((OSError, isolated_job.IsolatedJobError)):
        isolated_job.publish(source, output, workspace)
    assert list(other.iterdir()) == []


def test_publish_regular_nested_outputs_keeps_existing_files(tmp_path):
    source, output, workspace, _ = _trees(tmp_path)
    (output / "existing.txt").write_text("prior result")
    rows = isolated_job.publish(source, output, workspace)
    assert rows[0]["path"] == "runs/output/figures/result.txt"
    assert rows[0]["bytes"] == len("verified result")
    assert (output / "figures" / "result.txt").read_text() == "verified result"
    assert (output / "existing.txt").read_text() == "prior result"
    with pytest.raises(FileExistsError):
        isolated_job.publish(source, output, workspace)
