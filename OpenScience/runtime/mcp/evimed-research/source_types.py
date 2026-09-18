"""Evidence source types, read from the domain's table rather than restated.

Hidden knowledge: the badge a reader sees beside a citation — guideline, RCT,
label, regulator's notice — is decided once, by `evidenceSourceTypeOf` in
`packages/domain/src/sourceTypes.mjs`, from `source-types.json`. This server
decides it too, at the moment it returns or preserves a source, because that is
when it holds the facts (publication types, the tool, the connector, the URL)
and a reader downstream may hold only a path. So it reads the same JSON file
and applies the same precedence; `packages/domain/test/fixtures/
source-type-cases.json` is answered by a test on each side.

Where the file lives depends on the build. In the repository it is beside this
tree; in the runtime image the domain package is copied to
`/opt/evimed/socket/node_modules/@evimed/domain` (both the full `Dockerfile`
and the delta), and `test_source_types.py` reads both Dockerfiles to prove the
path below is the one they write. `EVIMED_SOURCE_TYPES_FILE` overrides both.

A missing table is not an error: the type is left unset (never guessed as
`other`), the control plane derives it again from the same table, and the
`health` tool says the table was not found.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from functools import lru_cache
from pathlib import Path

TABLE_ENV = "EVIMED_SOURCE_TYPES_FILE"
IMAGE_TABLE = Path("/opt/evimed/socket/node_modules/@evimed/domain/src/source-types.json")
SIDECAR_NAME = "source.json"
SIDECAR_SCHEMA = 1
_MCP_PREFIX = re.compile(r"^mcp__[a-z0-9-]+__")


def _candidates():
    configured = os.environ.get(TABLE_ENV, "").strip()
    if configured:
        yield Path(configured)
    here = Path(__file__).resolve()
    # runtime/mcp/evimed-research/source_types.py -> OpenScience/
    if len(here.parents) > 3:
        yield here.parents[3] / "packages" / "domain" / "src" / "source-types.json"
    yield IMAGE_TABLE


@lru_cache(maxsize=1)
def table():
    """The parsed table, or None when no copy is reachable."""
    for candidate in _candidates():
        try:
            if candidate.is_file() and not candidate.is_symlink():
                value = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(value, dict) and isinstance(value.get("types"), list):
                    return _compile(value, str(candidate))
        except (OSError, ValueError):
            continue
    return None


def _compile(value, origin):
    types = tuple(str(item) for item in value["types"])
    known = set(types)

    def typed(item):
        if item not in known:
            raise ValueError("source-types.json names an unknown source type %r" % item)
        return item

    return {
        "origin": origin,
        "version": value.get("version"),
        "types": types,
        "publicationTypes": tuple((str(name).lower(), typed(kind)) for name, kind in value.get("publicationTypes", [])),
        "articleTypes": {str(name).lower(): typed(kind) for name, kind in value.get("articleTypes", {}).items()},
        "tools": {str(name): typed(kind) for name, kind in value.get("tools", {}).items()},
        "connectors": {str(name).lower(): typed(kind) for name, kind in value.get("connectors", {}).items()},
        "urls": tuple((str(host).lower(), str(prefix), typed(kind)) for host, prefix, kind in value.get("urls", [])),
    }


def is_source_type(value) -> bool:
    compiled = table()
    return compiled is not None and isinstance(value, str) and value in compiled["types"]


def _list_of(value):
    """The domain's `listOf`: arrays, or a `;`/`|`-separated string, trimmed and lowercased."""
    if isinstance(value, list):
        return [str(entry if entry is not None else "").strip().lower() for entry in value if str(entry if entry is not None else "").strip()]
    if isinstance(value, str) and value.strip():
        parts = value.replace("|", ";").split(";")
        return [part.strip().lower() for part in parts if part.strip()]
    return []


def _location(url):
    if not isinstance(url, str) or not url:
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    # `new URL()` accepts any scheme with an authority, and so does this.
    if not parsed.scheme or not parsed.hostname:
        return None
    return parsed.hostname.lower(), parsed.path or "/"


def _first_present(record, keys):
    """JavaScript's `a ?? b ?? c`: the first value that is not missing, even
    an empty string — which then parses as no URL at all."""
    for key in keys:
        if record.get(key) is not None:
            return record.get(key)
    return None


def source_type_of(record):
    """`evidenceSourceTypeOf`, step for step; None only when the table is missing."""
    compiled = table()
    if compiled is None:
        return None
    if not isinstance(record, dict):
        return "other"
    if record.get("sourceType") in compiled["types"]:
        return record["sourceType"]
    publication_types = (
        _list_of(record.get("publicationTypes"))
        + _list_of(record.get("publication_types"))
        + _list_of(record.get("pubTypes"))
    )
    for name, kind in compiled["publicationTypes"]:
        if name in publication_types:
            return kind
    for key in ("articleType", "articleTypes", "studyType"):
        for name in _list_of(record.get(key)):
            if name in compiled["articleTypes"]:
                return compiled["articleTypes"][name]
    for key in ("tool", "origin", "sourceTool"):
        tool = _MCP_PREFIX.sub("", str(record.get(key) if record.get(key) is not None else ""))
        if tool in compiled["tools"]:
            return compiled["tools"][tool]
    connector = str(record.get("source") or "").strip().lower()
    if connector in compiled["connectors"]:
        return compiled["connectors"][connector]
    location = _location(_first_present(record, ("url", "sourceUrl", "link")))
    if location:
        host, path = location
        for suffix, prefix, kind in compiled["urls"]:
            if (host == suffix or host.endswith("." + suffix)) and path.startswith(prefix):
                return kind
    return "other"


def sidecar(record):
    """`source.json` for a capture: what the preserved text is, written beside it.

    A reader holding only an artifact path — the evidence matrix names one per
    claim — can then draw the right badge without re-running a search. The
    bytes are deterministic (no timestamp), so preserving the same source again
    reuses the same capture. Returns `(name, bytes)`, or None without a table.
    """
    kind = source_type_of(record)
    if kind is None:
        return None
    value = {
        "schemaVersion": SIDECAR_SCHEMA,
        "sourceType": kind,
        "sourceId": str(record.get("id") or ""),
        "title": str(record.get("title") or "")[:512],
        "url": str(record.get("url") or ""),
    }
    publication_types = [str(item) for item in (record.get("publicationTypes") or []) if str(item).strip()][:12]
    if publication_types:
        value["publicationTypes"] = publication_types
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    return SIDECAR_NAME, payload.encode("utf-8")
