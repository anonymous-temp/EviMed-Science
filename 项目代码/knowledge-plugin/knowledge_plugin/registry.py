"""The runtime registry: load and validate ``registry/sources.json``, sync it into ``sources``.

The file says what a source IS; the ``sources`` table says what HAPPENED to it (plan 10.4.2). A sync
therefore rewrites only the registry-owned columns of a row and leaves the runtime ones alone
(next poll, lease, validators, cursor, health counters). Two further rules:

- **Retire, never delete.** A row missing from the file gets ``retired_at``; its entries still point
  at it, and ``/v1/sources?include_retired=true`` still shows it. Coming back clears the mark.
- **The operator's switch survives a reload.** ``enabled`` is ``coalesce(operator_enabled,
  registry_enabled)``: the file decides unless an operator decided (``UPDATE … SET
  operator_enabled = false``; back to the file with ``NULL``).

``validate_row`` is also the registry load test's oracle: a missing field, a value outside the
contract vocabulary, a literal date in a URL, or an enabled row this build cannot read fails it.
``registry_sha256`` is the hash of the row as written in the file (canonical JSON), so it changes
exactly when the team edits the source.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from .model import (
    ACCESSES, EGRESSES, IMPLEMENTED_ACCESSES, IMPLEMENTED_EGRESSES, LANES, LAUNCH_TIERS, SOURCE_ID_MAX, SOURCE_TYPES,
    SourceConfig,
)
from .policy import priority
from .urltemplate import TemplateError, literal_dates, validate_template

log = logging.getLogger("knowledge_plugin.registry")

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,%d}$" % (SOURCE_ID_MAX - 1))
REQUIRED: dict[str, type | tuple] = {
    "id": str, "name": str, "lane": str, "source_type": str, "access": str, "egress": str, "authority": int,
    "safety_feed": bool, "owner_entity": str, "launch_tier": str, "poll_floor_s": int, "poll_ceiling_s": int,
    "enabled": bool, "config": dict,
}
OPTIONAL: dict[str, type | tuple] = {
    "homepage": (str, type(None)), "language": (str, type(None)), "region": (str, type(None)),
    "disabled_reason": (str, type(None)), "category": (str, type(None)),
}


class RegistryError(ValueError):
    """The registry file is unreadable or has invalid rows; ``problems`` lists every one."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__(f"{len(problems)} registry problem(s): " + "; ".join(problems[:5]))
        self.problems = problems


@dataclass(frozen=True)
class RegistryRow:
    source: SourceConfig
    enabled: bool
    disabled_reason: str | None
    category: str | None
    sha256: str


def row_sha256(row: dict) -> str:
    return hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def list_configured(config: dict) -> bool:
    """A list page can be read: CSS selectors with an item selector, or the readers' ``script-json``
    mode (the list is a JSON value in a script variable: ``script_var`` plus a ``fields`` map)."""
    if (config.get("selectors") or {}).get("item"):
        return True
    return config.get("mode") == "script-json" and bool(config.get("script_var")) and bool(config.get("fields"))


def validate_row(row: dict) -> list[str]:
    """Every problem with one registry row (empty when it can be loaded)."""
    sid = row.get("id") if isinstance(row.get("id"), str) else "<no id>"
    problems: list[str] = []
    for key, expected in REQUIRED.items():
        if key not in row:
            problems.append(f"{sid}: missing field {key}")
        elif not isinstance(row[key], expected) or (expected is int and isinstance(row[key], bool)):
            problems.append(f"{sid}: field {key} has the wrong type")
    for key, expected in OPTIONAL.items():
        if key in row and not isinstance(row[key], expected):
            problems.append(f"{sid}: field {key} has the wrong type")
    unknown = set(row) - set(REQUIRED) - set(OPTIONAL)
    if unknown:
        problems.append(f"{sid}: unknown field(s) {sorted(unknown)}")
    if problems:
        return problems
    if not _ID.match(row["id"]):
        problems.append(f"{sid}: id must match {_ID.pattern}")
    for key, vocabulary in (("lane", LANES), ("source_type", SOURCE_TYPES), ("access", ACCESSES), ("egress", EGRESSES),
                            ("launch_tier", LAUNCH_TIERS)):
        if row[key] not in vocabulary:
            problems.append(f"{sid}: {key}={row[key]!r} is outside the contract vocabulary")
    if not 1 <= row["authority"] <= 5:
        problems.append(f"{sid}: authority must be 1-5")
    if not row["name"].strip() or not row["owner_entity"].strip():
        problems.append(f"{sid}: name and owner_entity must not be empty")
    if not 300 <= row["poll_floor_s"] <= row["poll_ceiling_s"] <= 604800:
        problems.append(f"{sid}: need 300 <= poll_floor_s <= poll_ceiling_s <= 604800")
    homepage = row.get("homepage")
    if homepage is not None and not homepage.startswith(("http://", "https://")):
        problems.append(f"{sid}: homepage must be an http(s) URL")
    config = row["config"]
    templates = ([config["url"]] if config.get("url") else []) + list(config.get("urls") or [])
    for template in templates:
        if not isinstance(template, str) or not template.startswith(("http://", "https://")):
            problems.append(f"{sid}: config url must be an http(s) URL template")
            continue
        try:
            validate_template(template)
        except TemplateError as error:
            problems.append(f"{sid}: {error}")
        dates = literal_dates(template)
        if dates:
            problems.append(f"{sid}: literal date(s) {dates} in a URL (use {{since}}/{{today}} placeholders)")
    hosts = config.get("allowed_hosts")
    if hosts is not None and not (isinstance(hosts, list) and all(isinstance(h, str) and h for h in hosts)):
        problems.append(f"{sid}: config.allowed_hosts must be a list of host names")
    if row["enabled"]:
        if not templates:
            problems.append(f"{sid}: enabled without config.url")
        if row["access"] not in IMPLEMENTED_ACCESSES:
            problems.append(f"{sid}: enabled with access {row['access']} that this build does not implement")
        if row["egress"] not in IMPLEMENTED_EGRESSES:
            problems.append(f"{sid}: enabled with egress {row['egress']} that this build does not implement")
        if row["access"] in ("html-list", "browser-list") and not list_configured(config):
            problems.append(f"{sid}: enabled {row['access']} without a list configuration (selectors.item or script-json)")
    return problems


def parse_registry(document: dict) -> list[RegistryRow]:
    rows = document.get("sources") if isinstance(document, dict) else None
    if not isinstance(rows, list):
        raise RegistryError(["the registry file has no 'sources' list"])
    problems: list[str] = []
    seen: set[str] = set()
    out: list[RegistryRow] = []
    for row in rows:
        if not isinstance(row, dict):
            problems.append("a registry row is not an object")
            continue
        row_problems = validate_row(row)
        if isinstance(row.get("id"), str) and row["id"] in seen:
            row_problems.append(f"{row['id']}: duplicate id")
        if row_problems:
            problems.extend(row_problems)
            continue
        seen.add(row["id"])
        out.append(RegistryRow(
            source=SourceConfig(
                id=row["id"], name=row["name"].strip(), homepage=row.get("homepage"), lane=row["lane"],
                source_type=row["source_type"], access=row["access"], egress=row["egress"], authority=row["authority"],
                safety_feed=row["safety_feed"], owner_entity=row["owner_entity"].strip(), launch_tier=row["launch_tier"],
                language=row.get("language"), region=row.get("region"), poll_floor_s=row["poll_floor_s"],
                poll_ceiling_s=row["poll_ceiling_s"], config=row["config"],
            ),
            enabled=row["enabled"],
            disabled_reason=row.get("disabled_reason"),
            category=row.get("category"),
            sha256=row_sha256(row),
        ))
    if problems:
        raise RegistryError(problems)
    return out


def load_registry(path: str | Path) -> list[RegistryRow]:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RegistryError([f"cannot read the registry file: {type(error).__name__}"]) from None
    return parse_registry(document)


_UPSERT = """
INSERT INTO evimed_knowledge.sources AS s
  (id, name, homepage, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, language,
   region, config, registry_sha256, registry_enabled, enabled, disabled_reason, category, priority, poll_interval_s,
   poll_floor_s, poll_ceiling_s, next_poll_at, health, retired_at, updated_at, host)
VALUES
  (%(id)s, %(name)s, %(homepage)s, %(lane)s, %(source_type)s, %(access)s, %(egress)s, %(authority)s, %(safety_feed)s,
   %(owner_entity)s, %(launch_tier)s, %(language)s, %(region)s, %(config)s, %(sha)s, %(enabled)s, %(enabled)s,
   %(disabled_reason)s, %(category)s, %(priority)s, %(floor)s, %(floor)s, %(ceiling)s, %(now)s,
   CASE WHEN %(enabled)s THEN 'new' ELSE 'disabled' END, NULL, %(now)s, %(host)s)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, homepage = EXCLUDED.homepage, lane = EXCLUDED.lane, source_type = EXCLUDED.source_type,
  access = EXCLUDED.access, egress = EXCLUDED.egress, authority = EXCLUDED.authority,
  safety_feed = EXCLUDED.safety_feed, owner_entity = EXCLUDED.owner_entity, launch_tier = EXCLUDED.launch_tier,
  language = EXCLUDED.language, region = EXCLUDED.region, config = EXCLUDED.config,
  cursor = CASE WHEN s.registry_sha256 IS DISTINCT FROM EXCLUDED.registry_sha256 THEN '{}'::jsonb ELSE s.cursor END,
  registry_sha256 = EXCLUDED.registry_sha256, registry_enabled = EXCLUDED.registry_enabled,
  enabled = coalesce(s.operator_enabled, EXCLUDED.registry_enabled),
  disabled_reason = CASE WHEN s.operator_enabled IS NULL THEN EXCLUDED.disabled_reason
                         WHEN s.operator_enabled THEN NULL ELSE 'operator' END,
  category = EXCLUDED.category, priority = EXCLUDED.priority,
  poll_floor_s = EXCLUDED.poll_floor_s, poll_ceiling_s = EXCLUDED.poll_ceiling_s,
  poll_interval_s = least(greatest(s.poll_interval_s, EXCLUDED.poll_floor_s), EXCLUDED.poll_ceiling_s),
  health = CASE WHEN NOT coalesce(s.operator_enabled, EXCLUDED.registry_enabled) THEN 'disabled'
                WHEN s.health = 'disabled' THEN (CASE WHEN s.last_ok_at IS NULL THEN 'new' ELSE 'healthy' END)
                ELSE s.health END,
  next_poll_at = CASE WHEN s.health = 'disabled' AND coalesce(s.operator_enabled, EXCLUDED.registry_enabled)
                      THEN EXCLUDED.next_poll_at ELSE s.next_poll_at END,
  retired_at = NULL, updated_at = EXCLUDED.updated_at, host = EXCLUDED.host
WHERE s.registry_sha256 IS DISTINCT FROM EXCLUDED.registry_sha256
   OR s.host IS DISTINCT FROM EXCLUDED.host
   OR s.retired_at IS NOT NULL
   OR s.enabled IS DISTINCT FROM coalesce(s.operator_enabled, EXCLUDED.registry_enabled)
   OR s.priority IS DISTINCT FROM EXCLUDED.priority
"""


async def sync_registry(conn: AsyncConnection, rows: list[RegistryRow], now: datetime) -> dict:
    """Upsert every row, retire rows missing from the file; one transaction."""
    params = [{
        "id": r.source.id, "name": r.source.name, "homepage": r.source.homepage, "lane": r.source.lane,
        "source_type": r.source.source_type, "access": r.source.access, "egress": r.source.egress,
        "authority": r.source.authority, "safety_feed": r.source.safety_feed, "owner_entity": r.source.owner_entity,
        "launch_tier": r.source.launch_tier, "language": r.source.language, "region": r.source.region,
        "config": Jsonb(r.source.config), "sha": r.sha256, "enabled": r.enabled, "disabled_reason": r.disabled_reason,
        "category": r.category,
        "priority": priority(safety_feed=r.source.safety_feed, source_type=r.source.source_type, access=r.source.access),
        "floor": r.source.poll_floor_s, "ceiling": r.source.poll_ceiling_s, "now": now,
        "host": _host_of(r.source.config.get("url")),
    } for r in rows]
    async with conn.transaction():
        async with conn.cursor() as cur:
            await cur.executemany(_UPSERT, params)
        retired = await (await conn.execute(
            """UPDATE evimed_knowledge.sources SET retired_at = %s, updated_at = %s
                WHERE retired_at IS NULL AND NOT (id = ANY(%s)) RETURNING id""",
            (now, now, [r.source.id for r in rows]),
        )).fetchall()
    counts = {"rows": len(rows), "enabled": sum(1 for r in rows if r.enabled), "retired": len(retired)}
    log.info("registry synced: %(rows)s rows, %(enabled)s enabled in the file, %(retired)s newly retired", counts)
    return counts


def _host_of(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return (urlsplit(url).hostname or "").lower() or None
    except ValueError:
        return None


def source_from_row(row: dict) -> SourceConfig:
    """A ``SourceConfig`` from a ``sources`` table row."""
    return SourceConfig(
        id=row["id"], name=row["name"], homepage=row["homepage"], lane=row["lane"], source_type=row["source_type"],
        access=row["access"], egress=row["egress"], authority=row["authority"], safety_feed=row["safety_feed"],
        owner_entity=row["owner_entity"], launch_tier=row["launch_tier"], language=row["language"],
        region=row["region"], poll_floor_s=row["poll_floor_s"], poll_ceiling_s=row["poll_ceiling_s"],
        config=row["config"] or {},
    )
