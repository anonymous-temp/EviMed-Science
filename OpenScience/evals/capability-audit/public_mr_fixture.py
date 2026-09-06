"""Stage a commit-pinned official public MR subset without storing GWAS data in git."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from hosted_receipts import ReceiptError, canonical, digest, read_owned, write_new

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "fixtures/public_mr.json"
MAPPING = {"snp": "SNP", "beta": "beta", "se": "se", "effect_allele": "effect_allele",
    "other_allele": "other_allele", "eaf": "eaf", "pval": "pval"}


def _download(item):
    with urllib.request.urlopen(item["url"], timeout=30) as response:
        if response.geturl() != item["url"]:
            raise ReceiptError("public_fixture_redirect_refused")
        return response.read(item["bytes"] + 1)


def _check(blob, item):
    if len(blob) != item["bytes"] or digest(blob) != item["sha256"]:
        raise ReceiptError("public_fixture_hash_mismatch")


def _write_or_verify(workspace, relative, blob):
    if (workspace / relative).exists() or (workspace / relative).is_symlink():
        if read_owned(workspace, relative) != blob:
            raise ReceiptError("public_fixture_existing_bytes_differ")
    else:
        write_new(workspace, relative, blob)


def load_manifest(path=MANIFEST):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fixture_prefix(manifest):
    return "data/public-mr-" + manifest["commit"]


def arguments_for_manifest(manifest):
    prefix = fixture_prefix(manifest)
    sources = {}
    for role, name in (("exposure", "bmi_exposure.csv"), ("outcome", "chd_outcome.csv")):
        data = manifest[role]
        sources[role + "Source"] = {"type": "local_file", "path": prefix + "/" + name,
            "columnMapping": dict(MAPPING), "sampleSize": data["sampleSize"],
            "instrumentsPreclumped": data["instrumentsPreclumped"],
            "clumpingProvenance": data.get("clumpingProvenance", data.get("selectionProvenance"))}
    return {"exposure": manifest["exposure"]["trait"], "outcome": manifest["outcome"]["trait"],
        "analysisDirection": "forward", "outputLanguage": "en", **sources}


def fixture_binding(manifest):
    prefix = fixture_prefix(manifest)
    return {"manifestSha256": digest(canonical(manifest)), "sources": [
        {"path": prefix + "/" + item["name"], "url": item["url"], "bytes": item["bytes"], "sha256": item["sha256"]}
        for item in manifest["files"]]}


def fixture_file_receipts(manifest):
    binding = fixture_binding(manifest)
    receipts = [{key: row[key] for key in ("path", "bytes", "sha256")} for row in binding["sources"]]
    body = canonical(manifest) + b"\n"
    receipts.append({"path": fixture_prefix(manifest) + "/fixture-manifest.json", "bytes": len(body), "sha256": digest(body)})
    return receipts


def prepare(workspace, *, cache=None, download=False, rscript="Rscript", manifest_path=MANIFEST,
            fetch=_download, runner=subprocess.run):
    manifest = load_manifest(manifest_path)
    prefix = fixture_prefix(manifest)
    for item in manifest["files"]:
        relative = prefix + "/" + item["name"]
        if (workspace / relative).exists() or (workspace / relative).is_symlink():
            blob = read_owned(workspace, relative)
        elif cache is not None:
            candidates = [item["name"], "datasets/" + item["name"], "manifests/" + item["name"]]
            found = next((name for name in candidates if (cache / name).exists() or (cache / name).is_symlink()), None)
            if found is None:
                raise ReceiptError("public_fixture_cache_incomplete")
            blob = read_owned(cache, found)
        elif download:
            blob = fetch(item)
        else:
            raise ReceiptError("public_fixture_requires_verified_cache_or_download")
        _check(blob, item)
        _write_or_verify(workspace, relative, blob)
    missing = []
    for name, expected in manifest["outputs"].items():
        relative = prefix + "/" + name
        if (workspace / relative).exists() or (workspace / relative).is_symlink():
            _check(read_owned(workspace, relative), expected)
        else:
            missing.append(name)
    if missing:
        binary = shutil.which(rscript)
        if binary is None:
            raise ReceiptError("public_fixture_rscript_unavailable")
        with tempfile.TemporaryDirectory(prefix="evimed-public-mr-") as temporary:
            result = runner([binary, "--vanilla", str(HERE / "prepare_public_mr.R"),
                str(workspace / prefix / "vig_perform_mr.RData"), temporary],
                env={"PATH": os.environ.get("PATH", os.defpath), "LANG": "C", "LC_ALL": "C", "TZ": "UTC"},
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if result.returncode:
                raise ReceiptError("public_fixture_generation_failed")
            for name, expected in manifest["outputs"].items():
                blob = read_owned(Path(temporary), name)
                _check(blob, expected)
                _write_or_verify(workspace, prefix + "/" + name, blob)
    _write_or_verify(workspace, prefix + "/fixture-manifest.json", canonical(manifest) + b"\n")
    return arguments_for_manifest(manifest)
