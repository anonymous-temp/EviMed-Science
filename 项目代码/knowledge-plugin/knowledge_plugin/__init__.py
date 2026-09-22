"""EviMed knowledge-source plugin: the one service between the outside world and the platform.

It owns the source registry, scheduling, protected fetching, parsing (adapters), normalisation,
per-source de-duplication, on-demand enrichment and source health, and serves the result through
the HTTP contract ``contract/knowledge-plugin-openapi.yaml`` v1 (plan chapter 14). The platform
pulls; the plugin never calls the platform, never stores user data and makes no
content-generating model call.
"""

from __future__ import annotations

from importlib import metadata as _metadata
from pathlib import Path as _Path
import re as _re

DISTRIBUTION = "evimed-knowledge-plugin"


def _version() -> str:
    """The installed distribution's version; a source checkout falls back to ``pyproject.toml``."""
    try:
        return _metadata.version(DISTRIBUTION)
    except _metadata.PackageNotFoundError:
        pyproject = _Path(__file__).resolve().parent.parent / "pyproject.toml"
        try:
            match = _re.search(r'^version = "([^"]+)"', pyproject.read_text(encoding="utf-8"), _re.M)
        except OSError:
            match = None
        return match.group(1) if match else "0.0.0"


__version__ = _version()
