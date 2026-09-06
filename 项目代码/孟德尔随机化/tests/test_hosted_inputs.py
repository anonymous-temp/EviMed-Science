"""Local input integrity and mapping, with no R, model or remote GWAS calls."""

import copy
import csv
import hashlib
import io
import json
import os

import pytest

import evimed_local_inputs as inputs


def source(path="data/exposure.csv", clumped=True):
    return {
        "type": "local_file",
        "path": path,
        "columnMapping": dict(inputs.STANDARD_MAPPING),
        "instrumentsPreclumped": clumped,
        **(
            {
                "clumpingProvenance": "Study supplement: r2 < 0.001, 10 Mb selection; declared by "
                "provider."
            }
            if clumped
            else {}
        ),
    }


@pytest.fixture
def files(tmp_path):
    workspace = tmp_path / "users/alice/projects/paper/workspace/analysis"
    (workspace / "data").mkdir(parents=True)
    contents = "SNP,beta,se,effect_allele,other_allele,eaf,pval\nrs1,0.2,0.01,A,G,0.2,1e-10\n"
    for role in ("exposure", "outcome"):
        (workspace / f"data/{role}.csv").write_text(contents)
    output = workspace / "mendelian-randomization-runs/mr-fixture-001/output"
    output.mkdir(parents=True)
    request = {
        "exposure": "BMI",
        "outcome": "CHD",
        "exposureSource": source(),
        "outcomeSource": source("data/outcome.csv", False),
    }
    return tmp_path, workspace, output, request


def prepare(files):
    root, workspace, output, request = files
    binding = inputs.capture_bindings(workspace, request, root)
    return inputs.prepare_sources(workspace, output, request, binding, root, token_available=False)[
        "request"
    ]


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd.csv",
        "../out.csv",
        "data/../out.csv",
        "data//out.csv",
        "./out.csv",
        "C:\\out.csv",
        "data/out.pdf",
        "data/\x00out.csv",
    ],
)
def test_paths_cannot_name_other_scopes(files, path):
    request = files[3]
    request["exposureSource"]["path"] = path
    with pytest.raises(inputs.MRInputError, match="path|CSV|TSV|GWAS"):
        prepare(files)


@pytest.mark.parametrize("replacement", ["symlink", "directory", "regular", "ancestor", "hardlink"])
def test_queued_inputs_cannot_be_replaced(files, replacement):
    root, workspace, output, request = files
    binding = inputs.capture_bindings(workspace, request, root)
    original = workspace / "data/exposure.csv"
    victim = root / "users/bob/projects/paper/workspace/data/exposure.csv"
    victim.parent.mkdir(parents=True)
    victim.write_text("OTHER_ACCOUNT_PRIVATE_CONTENT")
    if replacement == "ancestor":
        (workspace / "data").rename(workspace / "original-data")
        (workspace / "data").symlink_to(victim.parent, target_is_directory=True)
    else:
        original.unlink()
        if replacement == "symlink":
            original.symlink_to(victim)
        elif replacement == "directory":
            original.mkdir()
        elif replacement == "hardlink":
            os.link(victim, original)
        else:
            original.write_text(victim.read_text())
    with pytest.raises(inputs.MRInputError):
        inputs.prepare_sources(workspace, output, request, binding, root, token_available=False)
    assert victim.read_text() == "OTHER_ACCOUNT_PRIVATE_CONTENT"
    assert not (output / inputs.MANIFEST_NAME).exists()


def test_workspace_replaced_during_read_never_receives_old_account_copies(files, monkeypatch):
    root, workspace, output, request = files
    binding = inputs.capture_bindings(workspace, request, root)
    original_read = inputs._read_source
    swapped = False

    def read_and_replace(parent, descriptor, expected):
        nonlocal swapped
        data = original_read(parent, descriptor, expected)
        if not swapped:
            swapped = True
            workspace.rename(workspace.with_name("old-workspace"))
            output.mkdir(parents=True)
            (workspace / "data").mkdir()
            for role in ("exposure", "outcome"):
                (workspace / f"data/{role}.csv").write_text("NEW_ACCOUNT_INPUT")
        return data

    monkeypatch.setattr(inputs, "_read_source", read_and_replace)
    with pytest.raises(inputs.MRInputError):
        inputs.prepare_sources(workspace, output, request, binding, root, token_available=False)
    assert not (output / "inputs/exposure.csv").exists()


@pytest.mark.parametrize(
    "delta",
    [
        {"instrumentsPreclumped": "false"},
        {"sampleSize": True},
        {"sampleSize": -1},
        {"columnMapping": {"snp": "SNP"}},
        {"clumpingProvenance": ""},
        {"command": "Rscript"},
    ],
)
def test_invalid_nested_source_fields_are_rejected(files, delta):
    files[3]["exposureSource"].update(delta)
    with pytest.raises(inputs.MRInputError):
        prepare(files)


def test_local_roles_and_clumping_conditions_are_independent(files):
    request = files[3]
    assert inputs.validate_request({"exposure": "BMI", "outcome": "CHD"}) is False
    incomplete = copy.deepcopy(request)
    incomplete.pop("outcomeSource")
    with pytest.raises(inputs.MRInputError):
        inputs.validate_request(incomplete)
    inputs.require_remote_access(request, False)
    request["analysisDirection"] = "bidirectional"
    with pytest.raises(inputs.MRInputError) as error:
        inputs.require_remote_access(request, False)
    assert error.value.code == "mr_input_clumping_required"
    request["outcomeSource"] = source("data/outcome.csv")
    inputs.require_remote_access(request, False)
    request["outcomeSource"] = {"type": "opengwas", "gwasId": "ieu-a-7"}
    assert inputs.validate_request(request)
    with pytest.raises(inputs.MRInputError) as error:
        inputs.require_remote_access(request, False)
    assert error.value.code == "mr_input_remote_auth_required"
    inputs.require_remote_access(request, True)


@pytest.mark.parametrize(
    "data",
    [
        "rs1,nan,0.1,A,G,0.2,0.01",
        "rs1,0.1,0,A,G,0.2,0.01",
        "rs1,0.1,0.1,A,G,1.2,0.01",
        "rs1,0.1,0.1,A,G,0.2,-0.1",
        "rs1,0.1,0.1,A,G,0.2",
        "rs1,0.1,0.1,A,G,0.2,0.01\nrs1,0.1,0.1,A,G,0.2,0.01",
    ],
)
def test_bad_rows_fail_instead_of_being_silently_dropped(files, data):
    (files[1] / "data/exposure.csv").write_text(
        ",".join(inputs.STANDARD_MAPPING.values()) + "\n" + data + "\n"
    )
    with pytest.raises(inputs.MRInputError):
        prepare(files)


def test_quoted_headers_are_data_and_never_reach_r_template_columns(files):
    _, workspace, output, request = files
    header = 'beta"; system("false"); #'
    request["exposureSource"]["columnMapping"]["beta"] = header
    original = io.StringIO(newline="")
    writer = csv.writer(original)
    writer.writerow(["SNP", header, "se", "effect_allele", "other_allele", "eaf", "pval"])
    writer.writerow(["rs1", "0.2", "0.01", "A", "G", "0.2", "1e-10"])
    raw = original.getvalue().encode()
    (workspace / "data/exposure.csv").write_bytes(raw)
    prepared = prepare(files)
    assert prepared["exposureSource"]["columnMapping"] == inputs.STANDARD_MAPPING
    assert header not in (output / "inputs/exposure.csv").read_text()
    manifest = json.loads((output / inputs.MANIFEST_NAME).read_text())
    assert manifest["sources"]["exposure"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert manifest["sources"]["exposure"]["columnMapping"]["beta"] == header
