"""Locate, verify and import the pinned, patched Harness2 checkout.

`load()` is the only way this package reaches upstream. It refuses a work directory that is not at the pin or whose patch set
differs from `patches/`, because results from an unknown upstream state are not comparable with anything.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from . import config

_loaded: dict | None = None


def patch_digests() -> list[dict]:
    rows = []
    for path in sorted((config.PACKAGE_ROOT / "patches").glob("*.patch")):
        rows.append({"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return rows


def verify(workdir: Path | None = None) -> dict:
    work = Path(workdir or config.WORKDIR)
    marker = work / ".h2-setup.json"
    if not marker.is_file():
        raise RuntimeError(f"no patched Harness2 at {work}: run evals/harness-adaptation/setup.sh first")
    info = json.loads(marker.read_text(encoding="utf-8"))
    if info.get("pin") != config.PIN:
        raise RuntimeError(f"{work} was set up at {info.get('pin')}, this package is pinned to {config.PIN}")
    if info.get("patches") != patch_digests():
        raise RuntimeError(f"{work} carries a different patch set than patches/: run setup.sh again")
    return info


def load(workdir: Path | None = None):
    """Verify the work directory, put it on sys.path and import the upstream modules this package needs.

    Environment is fixed before the first import, because upstream reads it at import time: its runs root is moved into our scratch
    (never into a repository checkout), and its improver concurrency is the round's, not its default of 2.
    """
    global _loaded
    work = Path(workdir or config.WORKDIR)
    if _loaded is not None and _loaded["work"] == work:
        return _loaded["ns"]
    verify(work)
    os.environ.setdefault("HARNESS2_RUNS_DIR", str(config.RUNS_ROOT / "_upstream"))
    sys.path.insert(0, str(work))
    from harness2 import config as h2_config

    h2_config.PROPOSER_CONCURRENCY = int(os.environ.get("RSI1_IMPROVER_CONCURRENCY", "2"))
    from harness2.core import context, library, prompts, proposer, recursion, runmark, selection, spec, tree
    from harness2.core import ledger as h2_ledger

    class _NS:
        pass

    ns = _NS()
    for name, module in (
        ("config", h2_config), ("context", context), ("library", library), ("prompts", prompts), ("proposer", proposer),
        ("recursion", recursion), ("runmark", runmark), ("selection", selection), ("spec", spec), ("tree", tree),
        ("ledger", h2_ledger),
    ):
        setattr(ns, name, module)
    _loaded = {"work": work, "ns": ns}
    return ns
