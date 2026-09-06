"""Construct and publish the explicitly supported local MR replay package.

The statistical implementation remains the existing generated R template. This
module only binds its inputs, execution environment and portable entry point.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Callable

from mr_agent.models import ColumnMapping, DataSource

DEFAULT_REPLAY_SEED = 73421
REPLAY_SCHEMA = "evimed.mr.local-replay.v1"
_PREPARED_FILES = (
    "run.R", "analysis.R", "options.json", "inputs/exposure.csv", "inputs/outcome.csv",
)
_COMPLETE_FILES = (*_PREPARED_FILES, "observed-environment.json")

# The original run invokes this exact file too. No provider key or source path
# is interpolated. MD5 is a base-R corruption check; publication also verifies
# the SHA-256 digests. The manifest is a receipt, not a signature/trust boundary.
_RUN_R = r'''# EviMed paired-local MR replay. Run: Rscript --vanilla run.R
entry <- grep("^--file=", commandArgs(), value=TRUE)
if (length(entry) != 1L) stop("Run with Rscript --vanilla run.R")
setwd(dirname(normalizePath(sub("^--file=", "", entry), mustWork=TRUE)))
library(jsonlite)
manifest <- fromJSON("manifest.json", simplifyVector=FALSE)
allowed <- c("run.R", "analysis.R", "options.json", "inputs/exposure.csv",
    "inputs/outcome.csv", "observed-environment.json")
if (!identical(manifest$schema, "evimed.mr.local-replay.v1") ||
    !all(names(manifest$files) %in% allowed)) stop("Invalid replay manifest")
for (name in names(manifest$files)) {
    if (!file.exists(name) ||
        !identical(unname(tools::md5sum(name)), manifest$files[[name]]$md5)) {
        stop(paste("Replay file changed:", name))
    }
}
options <- fromJSON("options.json", simplifyVector=FALSE)
Sys.unsetenv("OPENGWAS_JWT")
if (dir.exists("results")) stop("results already exists; use a clean replay directory")
dir.create("results")
RNGkind("Mersenne-Twister", "Inversion", "Rejection")
set.seed(options$seed)
source("analysis.R", local=TRUE)
summary <- fromJSON("results/mr_summary.json")
if (!identical(summary$status, "success")) stop("MR analysis did not complete")
packages <- sort(unique(c(loadedNamespaces(), "TwoSampleMR", "ieugwasr",
    "jsonlite", "MRPRESSO", "RadialMR", "MendelianRandomization", "ggplot2", "data.table")))
versions <- lapply(packages, function(name) {
    tryCatch(as.character(packageVersion(name)), error=function(e) NULL)
})
names(versions) <- packages
methods <- TwoSampleMR::mr_method_list()
observed <- list(r_version=as.character(getRversion()), platform=R.version$platform,
    seed=options$seed, rng_kind=as.list(RNGkind()), packages=versions,
    two_sample_mr_defaults=list(parameters=TwoSampleMR::default_parameters(),
        methods=as.list(methods$obj[methods$use_by_default])))
write(toJSON(observed, auto_unbox=TRUE, pretty=TRUE, null="null"),
    "results/environment.json")
if (file.exists("observed-environment.json")) {
    original <- fromJSON("observed-environment.json", simplifyVector=FALSE)
    if (!identical(original$r_version, observed$r_version) ||
        !identical(original$platform, observed$platform) ||
        !identical(original$packages, observed$packages)) {
        warning("R/platform/package versions differ from the original; inspect environment.json")
    }
}
'''


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def _digest(path: Path) -> dict:
    content = path.read_bytes()
    return {
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "md5": hashlib.md5(content, usedforsecurity=False).hexdigest(),
    }


def prepare_local_replay(
    exposure: DataSource,
    outcome: DataSource,
    output_dir: Path,
    pval_thresholds: list[float],
    seed: int,
    build_script: Callable,
) -> Path:
    """Freeze input bytes before the original run, then generate its actual code."""
    if not exposure.is_local() or not outcome.is_local() or not exposure.instruments_preclumped:
        raise ValueError("MR replay requires paired local, declared-preclumped exposure inputs")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**31:
        raise ValueError("MR replay seed must be an integer from 0 to 2147483647")
    root = output_dir / "replay"
    root.mkdir()
    (root / "inputs").mkdir()
    sources = {}
    portable = {}
    for role, source in (("exposure", exposure), ("outcome", outcome)):
        name = f"inputs/{role}.csv"
        shutil.copyfile(Path(source.file_path), root / name)
        mapping = source.column_mapping or ColumnMapping()
        portable[role] = DataSource(
            source_type=source.source_type, file_path=name, column_mapping=mapping,
            instruments_preclumped=source.instruments_preclumped,
            clumping_provenance=source.clumping_provenance,
        )
        sources[role] = {
            "file": name,
            "column_mapping": mapping.model_dump(mode="json"),
            "instruments_preclumped": source.instruments_preclumped,
            "clumping_provenance": source.clumping_provenance,
            "ld_rechecked": False,
        }
    _write_json(root / "options.json", {
        "seed": seed,
        "requested_pval_thresholds": pval_thresholds,
        "effective_pval_threshold": pval_thresholds[0],
        "sources": sources,
        "statistical_options": "Exact calls are preserved in analysis.R; observed package defaults are in observed-environment.json.",
    })
    script = build_script(
        portable["exposure"], portable["outcome"], Path("results"), "", pval_thresholds,
    )
    (root / "analysis.R").write_text(script, encoding="utf-8")
    (root / "run.R").write_text(_RUN_R, encoding="utf-8")
    _write_json(root / "manifest.json", {
        "schema": REPLAY_SCHEMA, "status": "prepared", "entry": "run.R",
        "command": ["Rscript", "--vanilla", "run.R"],
        "scope": "paired_local_declared_preclumped_exposure",
        "network_required": False,
        "files": {name: _digest(root / name) for name in _PREPARED_FILES},
    })
    return root


def complete_local_replay(root: Path, output_dir: Path) -> None:
    """Retain observed runtime evidence and move original outputs to the parser."""
    results = root / "results"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if (results / "mr_error.json").is_file():
        # The shared template exits R with code zero for insufficient SNPs.
        # Preserve that scientific outcome even though quit bypasses the
        # entry's environment receipt; it is never a complete replay package.
        manifest["status"] = "analysis_failed"
    else:
        shutil.copyfile(results / "environment.json", root / "observed-environment.json")
        manifest["status"] = "complete"
        manifest["files"]["observed-environment.json"] = _digest(root / "observed-environment.json")
    manifest["original_outputs"] = {
        path.name: _digest(path) for path in sorted(results.iterdir()) if path.is_file()
    }
    _write_json(root / "manifest.json", manifest)
    for path in results.iterdir():
        shutil.move(str(path), output_dir / path.name)
    results.rmdir()


def copy_replay_package(source: Path, target: Path) -> list[Path]:
    """Publish only the constructed, complete package, never transient R files."""
    if not source.exists():
        return []
    manifest_file = source / "manifest.json"
    if source.is_symlink() or manifest_file.is_symlink() or not manifest_file.is_file():
        raise ValueError("MR replay manifest is missing or linked")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if (
        manifest.get("schema") != REPLAY_SCHEMA
        or manifest.get("status") != "complete"
        or set(manifest.get("files", {})) != set(_COMPLETE_FILES)
    ):
        raise ValueError("MR replay package is incomplete or unsupported")
    for name in _COMPLETE_FILES:
        path = source / name
        if (
            path.is_symlink() or path.parent.is_symlink() or not path.is_file()
            or path.stat().st_size > 50_000_000 or _digest(path) != manifest["files"][name]
        ):
            raise ValueError(f"MR replay file changed or is unsupported: {name}")
    copied = []
    for name in (*_COMPLETE_FILES, "manifest.json"):
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != target.resolve():
            shutil.copyfile(source / name, destination)
        copied.append(destination)
    return copied
