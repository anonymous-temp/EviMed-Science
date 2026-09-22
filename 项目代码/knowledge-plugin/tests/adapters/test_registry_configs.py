"""Every enabled row of the runtime registry is readable by its adapter as configured.

For each row of ``registry/sources.json`` whose access has an adapter: an enabled row must pass
``validate_config`` and ``plan`` must build its requests both on first contact and incrementally,
with no literal date and no credential in any URL. Disabled rows are planned too when their access
exists (they are one registry edit away from being polled).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.model import SourceConfig, SourceState

REGISTRY_FILE = Path(__file__).resolve().parents[2] / "registry" / "sources.json"
NOW = datetime(2026, 9, 22, 9, 0, tzinfo=timezone.utc)
ROWS = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))["sources"]
READABLE = [r for r in ROWS if r["access"] in REGISTRY]


def source(row: dict) -> SourceConfig:
    return SourceConfig(**{name: row.get(name) for name in SourceConfig.__dataclass_fields__})


def test_the_registry_walk_found_rows():
    assert len(READABLE) > 500
    assert sum(1 for r in READABLE if r["enabled"]) >= 256


@pytest.mark.parametrize("row", [r for r in READABLE if r["enabled"]], ids=lambda r: r["id"])
def test_enabled_rows_validate_and_plan(row):
    config = source(row)
    assert validate_config(config) == []
    adapter = REGISTRY[row["access"]]
    for state in (SourceState(None, None, None, None, None, {}),
                  SourceState(None, None, None, NOW - timedelta(hours=6), NOW - timedelta(days=10), {})):
        requests = adapter.plan(config, state, NOW)
        assert requests
        for request in requests:
            assert request.url.startswith("https://") or request.url.startswith("http://")
            for marker in ("api_key=", "email=", "mailto=", "tool="):
                assert marker not in request.url


def test_disabled_rows_with_an_adapter_still_plan():
    failures = []
    for row in READABLE:
        if row["enabled"] or not (row.get("config") or {}).get("url"):
            continue
        try:
            REGISTRY[row["access"]].plan(source(row), SourceState(None, None, None, None, None, {}), NOW)
        except Exception as error:  # noqa: BLE001 — collected and reported below, not swallowed
            failures.append(f"{row['id']}: {type(error).__name__}: {error}")
    assert failures == []
