"""Ancestry-aware selection of immutable, observed local LD references.

A missing or unsuitable reference is an explicit reason to use a labeled
approximation, never a claim that LD was measured or a default to Europeans.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

POPULATIONS = frozenset({"EUR", "EAS", "SAS", "AFR", "AMR"})
_CATEGORIES = {
    "eur": "EUR", "european": "EUR", "european ancestry": "EUR",
    "eas": "EAS", "east asian": "EAS", "east asian ancestry": "EAS",
    "sas": "SAS", "south asian": "SAS", "south asian ancestry": "SAS",
    "afr": "AFR", "african": "AFR", "african ancestry": "AFR",
    "amr": "AMR", "admixed american": "AMR",
}


def _population(values: Any) -> tuple[str | None, str]:
    if not isinstance(values, list) or not values:
        return None, "unknown"
    labels = []
    for entry in values:
        group = entry if isinstance(entry, list) else [entry]
        if not group:
            return None, "unknown"
        for label in group:
            if not isinstance(label, str):
                return None, "unknown"
            code = _CATEGORIES.get(" ".join(label.casefold().split()))
            if code is None:
                return None, "unknown"
            labels.append(code)
    unique = set(labels)
    return (labels[0], "matched") if len(unique) == 1 else (None, "mixed")


def resolve_population(samples: dict[str, Any], discovery: list[Any]) -> dict[str, Any]:
    """Use structured sample categories; bare catalogue labels are a fallback.

    Counts in prose, country names and an arbitrary mixture are not population
    identities. Missing information in any reported sample remains missing.
    """
    groups = samples.get("ancestrySamples")
    has_sample_categories = isinstance(groups, list) and any(group is not None for group in groups)
    evidence = []
    if has_sample_categories:
        evidence.append({"source": samples.get("source"), "field": "samples.sample_ancestry_category", "value": copy.deepcopy(groups)})
        population, status = _population(groups)
    else:
        population, status = _population(discovery)
    if discovery:
        evidence.append({"source": "GWAS Catalog discovery ancestry", "field": "discovery_ancestry", "value": copy.deepcopy(discovery)})
    if has_sample_categories and status == "matched":
        other, other_status = _population(discovery)
        if other_status == "mixed" or (other_status == "matched" and other != population):
            population, status = None, "conflicting"
    return {"population": population, "status": status, "evidence": evidence,
            "reason": None if status == "matched" else "ancestry_" + status}


class ReferenceUnavailable(ValueError):
    """A reference problem described by a bounded, nonsecret reason code."""


@dataclass(frozen=True)
class LDReference:
    plink: str
    bfile: str
    population: str
    _receipt: dict[str, Any]
    _identities: tuple[tuple[str, tuple], ...]

    def assert_current(self) -> None:
        for path, expected in self._identities:
            if _identity(Path(path)) != expected:
                raise ReferenceUnavailable("ld_reference_changed")

    def record(self) -> dict[str, Any]:
        return copy.deepcopy(self._receipt)


def _identity(path: Path) -> tuple[int, int, int, int, int]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size <= 0:
        raise ReferenceUnavailable("ld_reference_file_invalid")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _digest(path: Path, expected: tuple[int, int, int, int, int]) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        digest = hashlib.sha256()
        while block := stream.read(1024 * 1024):
            digest.update(block)
        observed = os.fstat(stream.fileno())
    after = (observed.st_dev, observed.st_ino, observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns)
    if after != expected or _identity(path) != expected:
        raise ReferenceUnavailable("ld_reference_changed")
    return digest.hexdigest()


def _panel(manifest: dict[str, Any], population: str) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("populations"), dict):
        raise ReferenceUnavailable("ld_reference_manifest_invalid")
    panel = manifest["populations"].get(population)
    if not isinstance(panel, dict) or panel.get("valid") is not True:
        raise ReferenceUnavailable("ld_reference_population_unavailable")
    # Versioned extraction writes these names, never caller-selected paths.
    if panel.get("prefix") != population:
        raise ReferenceUnavailable("ld_reference_prefix_invalid")
    files = panel.get("files")
    if not isinstance(files, dict) or set(files) != {"bed", "bim", "fam"}:
        raise ReferenceUnavailable("ld_reference_triplet_missing")
    for suffix, entry in files.items():
        if not isinstance(entry, dict) or entry.get("path") != f"{population}.{suffix}":
            raise ReferenceUnavailable("ld_reference_path_invalid")
    return panel


@lru_cache(maxsize=10)
def _validated(root: str, population: str, manifest_bytes: bytes, manifest_identity: tuple, identities: tuple,
               binary: str, binary_identity: tuple) -> LDReference:
    manifest = json.loads(manifest_bytes)
    panel = _panel(manifest, population)
    folder = Path(root)
    for (suffix, identity) in zip(("bed", "bim", "fam"), identities):
        expected = panel["files"][suffix]
        if expected.get("bytes") != identity[2] or _digest(folder / expected["path"], identity) != expected.get("sha256"):
            raise ReferenceUnavailable("ld_reference_checksum_mismatch")
    samples, variants = panel.get("sampleCount"), panel.get("variantCount")
    if type(samples) is not int or type(variants) is not int or samples < 1 or variants < 1:
        raise ReferenceUnavailable("ld_reference_dimensions_invalid")
    with (folder / f"{population}.bed").open("rb") as bed:
        if bed.read(3) != bytes.fromhex("6c1b01") or identities[0][2] != 3 + ((samples + 3) // 4) * variants:
            raise ReferenceUnavailable("ld_reference_bed_invalid")
    binary_sha = _digest(Path(binary), binary_identity)
    # Capture in a temporary file, not an unbounded in-memory pipe. A wrong
    # executable gets neither job credentials nor an unlimited readback.
    with tempfile.TemporaryFile() as output:
        version = subprocess.run([binary, "--version"], stdout=output, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, env={}, timeout=10, check=False)
        output.seek(0)
        body = output.read(4097)
    if len(body) > 4096:
        raise ReferenceUnavailable("ld_reference_binary_output_invalid")
    lines = body.decode("utf-8", errors="replace").strip().splitlines()
    line = lines[0] if lines else ""
    if version.returncode != 0 or not line.startswith("PLINK v1.9") or _identity(Path(binary)) != binary_identity:
        raise ReferenceUnavailable("ld_reference_binary_unsupported")
    receipt = {"population": population, "archive": manifest.get("archive"), "source": manifest.get("source"),
               "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(), "files": panel["files"],
               "sampleCount": samples, "variantCount": variants,
               "genomeBuild": panel.get("genomeBuild", manifest.get("genomeBuild")),
               "genomeBuildVerification": panel.get("genomeBuildVerification", manifest.get("genomeBuildVerification")),
               "binary": {"version": line[:200], "sha256": binary_sha}}
    bound = ((str(folder / "manifest.json"), manifest_identity), (binary, binary_identity),
             *((str(folder / f"{population}.{suffix}"), identity) for suffix, identity in zip(("bed", "bim", "fam"), identities)))
    return LDReference(binary, str(folder / population), population, receipt, bound)


def load_reference(choice: dict[str, Any], directory: str | Path | None, binary: str | Path | None
                   ) -> tuple[LDReference | None, str | None]:
    """Validate a matched immutable triplet, returning a reason on unavailability."""
    if not isinstance(choice, dict) or choice.get("status") != "matched" or not isinstance(choice.get("population"), str) or choice["population"] not in POPULATIONS:
        return None, str(choice.get("reason") or "ancestry_unknown") if isinstance(choice, dict) else "ancestry_unknown"
    if not directory or not binary:
        return None, "ld_reference_not_configured"
    try:
        root = Path(directory).resolve(strict=True)
        executable = Path(binary).resolve(strict=True)
        if not os.access(executable, os.X_OK):
            return None, "ld_reference_binary_unavailable"
        manifest_path = root / "manifest.json"
        identity = _identity(manifest_path)
        if identity[2] > 1024 * 1024:
            raise ReferenceUnavailable("ld_reference_manifest_invalid")
        descriptor = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            body = stream.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024 or _identity(manifest_path) != identity:
            raise ReferenceUnavailable("ld_reference_changed")
        manifest = json.loads(body)
        population = choice["population"]
        _panel(manifest, population)
        identities = tuple(_identity(root / f"{population}.{suffix}") for suffix in ("bed", "bim", "fam"))
        reference = _validated(str(root), population, body, identity, identities, str(executable), _identity(executable))
        reference.assert_current()
        return reference, None
    except ReferenceUnavailable as error:
        return None, str(error)
    except (OSError, ValueError, TypeError, RuntimeError, subprocess.SubprocessError):
        return None, "ld_reference_unavailable"
