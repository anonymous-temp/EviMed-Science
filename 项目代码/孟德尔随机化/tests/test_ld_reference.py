"""Only a supported, ancestry-matched and intact panel can certify LD selection."""
import hashlib
import json

import pytest

from mr_agent.tools import ld_reference as ld


@pytest.mark.parametrize('categories,population,status', [
    ([["European"]], "EUR", "matched"), ([["East Asian"], ["EAS"]], "EAS", "matched"),
    ([["South Asian"]], "SAS", "matched"), ([["African"]], "AFR", "matched"),
    ([["Admixed American"]], "AMR", "matched"), ([["European"], ["South Asian"]], None, "mixed"),
    ([["European"], None], None, "unknown"), ([["European", "Unknown"]], None, "unknown"),
])
def test_structured_samples_require_one_supported_population(categories, population, status):
    answer = ld.resolve_population({"ancestrySamples": categories, "source": "https://example.org/ssf.yaml"}, [])
    assert answer["population"] == population and answer["status"] == status
    assert answer["evidence"][0]["value"] == categories


def test_fallback_never_infers_from_prose_or_calls_arbitrary_mixture_amr():
    assert ld.resolve_population({}, ["European"])["population"] == "EUR"
    assert ld.resolve_population({}, ["300000 European"])["population"] is None
    assert ld.resolve_population({}, ["EUR", "AFR"])["status"] == "mixed"
    assert ld.resolve_population({}, [])["status"] == "unknown"
    assert ld.resolve_population({"ancestrySamples": [["European"]]}, ["East Asian"])["status"] == "conflicting"


def panel(tmp_path, population="EUR"):
    root = tmp_path / "reference"
    root.mkdir()
    blobs = {"bed": bytes.fromhex("6c1b01") + b"\x00" * 3,
             "bim": b"1 rs1 0 100 A G\n1 rs2 0 200 A G\n2 rs3 0 300 A G\n",
             "fam": b"f s1 0 0 0 -9\nf s2 0 0 0 -9\nf s3 0 0 0 -9\nf s4 0 0 0 -9\n"}
    files = {}
    for suffix, blob in blobs.items():
        path = root / (population + "." + suffix)
        path.write_bytes(blob)
        files[suffix] = {"path": path.name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}
    manifest = {"schemaVersion": 1, "archive": {"sha256": "a" * 64}, "source": {"doi": "test-only-synthetic", "license": "CC0"},
                "populations": {population: {"prefix": population, "sampleCount": 4, "variantCount": 3, "valid": True, "files": files}}}
    (root / "manifest.json").write_text(json.dumps(manifest))
    binary = tmp_path / "plink1.9"
    binary.write_text("#!/bin/sh\nprintf 'PLINK v1.90b6.26 64-bit\\n'\n")
    binary.chmod(0o700)
    return root, binary, manifest


def test_reference_binds_population_binary_and_three_hashes(tmp_path):
    root, binary, manifest = panel(tmp_path)
    reference, reason = ld.load_reference(ld.resolve_population({}, ["EUR"]), root, binary)
    assert reason is None and reference is not None
    record = reference.record()
    assert reference.bfile == str(root / "EUR")
    assert record["population"] == "EUR"
    assert record["files"] == manifest["populations"]["EUR"]["files"]
    assert record["binary"]["sha256"] == hashlib.sha256(binary.read_bytes()).hexdigest()
    assert record["binary"]["version"].startswith("PLINK v1.90")
    assert ld.load_reference(ld.resolve_population({}, ["EAS"]), root, binary)[0] is None


@pytest.mark.parametrize("fault", ["missing-bed", "missing-bim", "missing-fam", "corrupt", "symlink", "wrong-binary", "invalid-panel", "unsafe-prefix"])
def test_faults_are_explicit_unavailability_never_false_ld_success(tmp_path, fault):
    root, binary, manifest = panel(tmp_path)
    if fault.startswith("missing-"):
        (root / ("EUR." + fault.split("-")[1])).unlink()
    elif fault == "corrupt":
        (root / "EUR.bim").write_text("changed")
    elif fault == "symlink":
        target = root / "EUR.bed"
        target.rename(tmp_path / "elsewhere.bed")
        target.symlink_to(tmp_path / "elsewhere.bed")
    elif fault == "wrong-binary":
        binary.write_text("#!/bin/sh\nprintf 'PuTTY plink\\n'\n")
    elif fault == "invalid-panel":
        manifest["populations"]["EUR"]["valid"] = False
        (root / "manifest.json").write_text(json.dumps(manifest))
    else:
        manifest["populations"]["EUR"]["prefix"] = "../EUR"
        (root / "manifest.json").write_text(json.dumps(manifest))
    reference, reason = ld.load_reference(ld.resolve_population({}, ["EUR"]), root, binary)
    assert reference is None and reason


def test_changed_panel_is_not_hidden_by_validation_cache(tmp_path):
    root, binary, _ = panel(tmp_path)
    choice = ld.resolve_population({}, ["EUR"])
    assert ld.load_reference(choice, root, binary)[0] is not None
    (root / "EUR.bed").write_bytes(b"changed")
    assert ld.load_reference(choice, root, binary)[0] is None
