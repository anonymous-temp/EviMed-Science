"""The adapter protocol, and the few helpers every read method shares.

An adapter is one read method (``access``): ``plan`` turns a source and its state into the
requests of one poll, ``parse`` turns one response into normalised entries. ``parse`` is PURE —
no network, no database, no clock other than the ``now`` it is given — so it is tested with
recorded real responses (plan 10.2.4). Everything around it (budgets, robots, pinning,
conditional requests, identity, defects, storage) is the core's job.

Ownership: package P1 wrote the protocol and the helpers below; package P2 owns this file from
then on and may extend the helpers. The dataclasses live in ``knowledge_plugin.model`` and the URL
template grammar in ``knowledge_plugin.urltemplate`` (both P1); they are re-exported here so an
adapter needs one import.

Conventions the core relies on:

- Put no credential and no contact address into a URL: the fetcher adds NCBI ``tool``/``email``/
  ``api_key``, the openFDA ``api_key`` and the Unpaywall ``email`` per host.
- Mark open-API requests ``api=True`` (robots.txt is for pages, not APIs).
- Pagination within one poll goes through ``ParseOutput.next``; the scheduler follows it up to
  ``config.max_pages`` (default 5) and stops early when a page adds nothing new.
- Emit ``date_precision='day'`` for a date without a time; never emit ``inferred`` (the core
  infers from the first sighting and clamps future timestamps).
"""

from __future__ import annotations

import codecs
import re
from datetime import datetime
from typing import Protocol, runtime_checkable

from ..model import (  # noqa: F401  (re-exported for adapters)
    EntryTextResult,
    FetchError,
    FetchResult,
    NormalizedEntry,
    ParseOutput,
    RequestSpec,
    SourceConfig,
    SourceState,
)
from ..urltemplate import (  # noqa: F401  (re-exported for adapters)
    TEMPLATE_FIELDS,
    TemplateError,
    render_template,
    template_values,
    window_since,
)


@runtime_checkable
class Adapter(Protocol):
    """One read method. Registered in ``adapters.REGISTRY`` under its ``access`` value."""

    access: str

    def plan(self, source: SourceConfig, state: SourceState, now: datetime) -> list[RequestSpec]: ...

    def parse(self, result: FetchResult, source: SourceConfig, now: datetime) -> ParseOutput: ...


def plan_from_template(source: SourceConfig, state: SourceState, now: datetime, *,
                       api: bool, conditional: bool = True, headers: dict | None = None) -> list[RequestSpec]:
    """The common plan: render ``config.url`` (and any ``config.urls``) once each."""
    config = source.config or {}
    templates = [config["url"]] if config.get("url") else []
    templates += [t for t in (config.get("urls") or []) if t]
    values = template_values(source, state, now)
    return [RequestSpec(url=render_template(t, values), headers=dict(headers or {}), conditional=conditional, api=api)
            for t in templates]


_XML_DECLARED = re.compile(rb"^\s*<\?xml[^>]*encoding=[\"']([A-Za-z0-9._-]+)[\"']", re.I)
_META_CHARSET = re.compile(rb"<meta[^>]+charset=[\"']?\s*([A-Za-z0-9._-]+)", re.I)


def declared_charset(result: FetchResult) -> str | None:
    """The charset the response declares: header, then BOM, then XML declaration, then HTML meta."""
    content_type = result.headers.get("content-type", "")
    match = re.search(r"charset=[\"']?([A-Za-z0-9._-]+)", content_type, re.I)
    if match:
        return match.group(1)
    body = result.body
    if body.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    head = body[:4096]
    for pattern in (_XML_DECLARED, _META_CHARSET):
        found = pattern.search(head)
        if found:
            return found.group(1).decode("ascii", "replace")
    return None


def decode_body(result: FetchResult) -> str:
    """Decode a body by its declared charset; undeclared bodies try UTF-8, then GB18030.

    Chinese government and older media sites still serve GBK/GB18030, sometimes undeclared
    (plan 10.3.2 "乱码与编码错误"). A GB2312/GBK declaration is read as GB18030, its superset, so
    characters outside GB2312 that such sites use anyway do not turn into replacement characters.
    What still fails to decode becomes U+FFFD, which normalisation flags as the ``encoding`` defect.
    """
    charset = (declared_charset(result) or "").lower()
    if charset in ("gb2312", "gbk", "x-gbk", "gb_2312-80"):
        charset = "gb18030"
    if charset:
        try:
            return result.body.decode(charset, errors="replace")
        except LookupError:
            pass  # an unknown label falls through to the undeclared path
    try:
        return result.body.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return result.body.decode("gb18030")
        except UnicodeDecodeError:
            return result.body.decode("utf-8", errors="replace")
