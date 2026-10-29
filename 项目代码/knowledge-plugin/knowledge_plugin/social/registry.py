"""The social sources' registry file: ``registry/social-sources.json`` (X accounts, WeChat accounts, the six platforms).

It is a registry file like ``sources.json`` — the same row shape, validated by the same ``registry.validate_row`` — kept
apart because it is curated differently (the X list is verified against SocialData, the WeChat list re-resolved through
Dajiala; ``tools/verify_x_accounts.py`` and the research files under ``registry/research/`` say how) and because only
the social read methods may appear in it. ``dynamic_registry`` composes its rows with the rest under the registry lock,
so a row missing from both files is retired like any other. Its ``watch_list`` is the six-platform monitor's
(``crawl.load_watch_list``).

The path: ``KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY``, else ``social-sources.json`` beside ``KNOWLEDGE_PLUGIN_REGISTRY``, else
beside the repository's ``registry/sources.json``. A missing file is no social sources; an invalid one fails the load
like an invalid main registry.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from ..model import SOCIAL_ACCESSES
from ..registry import RegistryError, RegistryRow, parse_registry
from ..settings import PROJECT_ROOT


def social_registry_path(environ=None) -> Path:
    env = os.environ if environ is None else environ
    named = (env.get("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY") or "").strip()
    if named:
        return Path(named)
    main = (env.get("KNOWLEDGE_PLUGIN_REGISTRY") or "").strip()
    return (Path(main) if main else PROJECT_ROOT / "registry" / "sources.json").with_name("social-sources.json")


def load_social_registry(path: str | Path | None = None, environ=None) -> list[RegistryRow]:
    """The social rows; ``[]`` when the file does not exist. A row of another read method is a registry error."""
    path = Path(path) if path else social_registry_path(environ)
    if not path.exists():
        return []
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RegistryError([f"cannot read the social registry file: {type(error).__name__}"]) from None
    rows = parse_registry(document, environ)
    foreign = [row.source.id for row in rows if row.source.access not in SOCIAL_ACCESSES]
    if foreign:
        raise RegistryError([f"{source_id}: the social registry holds social read methods only" for source_id in foreign])
    return rows
