"""Load recorded upstream exchanges (``tests/fixtures/<group>/<case>/``) for the reader tests.

Every case directory holds the raw bodies (``NN.<ext>``, gzip-compressed as ``NN.<ext>.gz`` when
large) and a ``provenance.json`` written by ``record.py``: the URL (without secrets), method and
body of each request, the HTTP status, the response headers that matter, when it was fetched, the
sha256 of the stored body, and — for adapter cases — the registry row and ``SourceState`` the
adapter planned with and the ``now`` of the recording. Nothing in these directories is written by
hand: a case that cannot be recorded is not a case.

``ReplayFetcher`` answers the enrichment code's requests from a case, matching on method, URL and
body exactly, so a test fails loudly when the code asks for something it did not ask for when the
case was recorded.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from knowledge_plugin.model import FetchError, FetchResult, RequestSpec, SourceConfig, SourceState

FIXTURES = Path(__file__).resolve().parent


@dataclass
class Exchange:
    spec: RequestSpec
    result: FetchResult | None
    error: FetchError | None
    meta: dict


@dataclass
class Case:
    name: str
    provenance: dict
    exchanges: list[Exchange]
    source: SourceConfig | None = None
    state: SourceState | None = None
    now: datetime | None = None
    rows: list[dict] = field(default_factory=list)

    def results(self) -> list[FetchResult]:
        """The answers the code received (error answers excluded)."""
        return [e.result for e in self.exchanges if e.result is not None and e.error is None]


def _datetime(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def read_body(case_dir: Path, meta: dict) -> bytes:
    data = (case_dir / meta["file"]).read_bytes()
    if meta.get("gzip"):
        data = gzip.decompress(data)
    digest = hashlib.sha256(data).hexdigest()
    if digest != meta["sha256"]:
        raise AssertionError(f"{case_dir.name}/{meta['file']}: body does not match its recorded sha256")
    return data


def source_config(row: dict) -> SourceConfig:
    return SourceConfig(**{name: row.get(name) for name in SourceConfig.__dataclass_fields__})


def load_case(name: str) -> Case:
    case_dir = FIXTURES / name
    provenance = json.loads((case_dir / "provenance.json").read_text(encoding="utf-8"))
    exchanges = []
    for meta in provenance["exchanges"]:
        body = meta.get("request_body")
        spec = RequestSpec(url=meta["url"], method=meta.get("method", "GET"),
                           body=body.encode("utf-8") if body is not None else None,
                           headers=dict(meta.get("request_headers") or {}),
                           conditional=bool(meta.get("conditional", False)), api=bool(meta.get("api", True)))
        error = None
        if meta.get("error"):
            error = FetchError(meta["error"]["outcome"], meta["error"]["detail"], status=meta.get("status"))
        result = None
        if meta.get("file"):  # an error answer keeps its body too (a test may hand it to parse directly)
            result = FetchResult(request=spec, final_url=meta.get("final_url") or meta["url"], status=meta["status"],
                                 headers=dict(meta.get("headers") or {}), body=read_body(case_dir, meta),
                                 fetched_at=_datetime(meta["fetched_at"]), not_modified=meta["status"] == 304)
        exchanges.append(Exchange(spec=spec, result=result, error=error, meta=meta))
    state = provenance.get("state")
    return Case(
        name=name,
        provenance=provenance,
        exchanges=exchanges,
        source=source_config(provenance["source"]) if provenance.get("source") else None,
        state=SourceState(etag=None, last_modified=None, last_content_sha256=None,
                          last_ok_at=_datetime(state.get("last_ok_at")), first_contact_at=None,
                          cursor=dict(state.get("cursor") or {})) if state is not None else None,
        now=_datetime(provenance.get("now")),
        rows=[_row(r) for r in provenance.get("rows") or []],
    )


def _row(row: dict) -> dict:
    out = dict(row)
    for key in ("published_at", "first_seen_at"):
        if out.get(key):
            out[key] = datetime.fromisoformat(out[key])
    return out


class ReplayFetcher:
    """Serves a case's recorded exchanges by (method, url, body); counts what it served."""

    def __init__(self, *cases: Case) -> None:
        self.table: dict[tuple, Exchange] = {}
        for case in cases:
            for exchange in case.exchanges:
                self.table[self._key(exchange.spec)] = exchange
        self.calls: list[tuple[str, str, Any]] = []

    @staticmethod
    def _key(spec: RequestSpec) -> tuple:
        return (spec.method.upper(), spec.url, spec.body or b"", bool(spec.api))

    async def fetch(self, spec: RequestSpec, *, source_id: str | None = None, egress: str = "direct",
                    allowed_hosts: Any = None) -> FetchResult:
        self.calls.append((spec.method, spec.url, source_id))
        exchange = self.table.get(self._key(spec))
        if exchange is None:
            raise AssertionError(f"no recorded exchange for {spec.method} {spec.url} (api={spec.api})")
        if exchange.error is not None:
            raise exchange.error
        return exchange.result
