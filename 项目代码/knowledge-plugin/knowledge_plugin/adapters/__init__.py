"""The read methods this build implements, keyed by ``access``.

The scheduler looks an enabled source's ``access`` up here; a source whose access has no adapter
is polled never and reported with the fetch outcome ``blocked`` / ``adapter_unavailable``.
Batch 1 (plan 14.6) implemented the seven direct methods; batch 2 adds ``browser-list`` (the
``html-list`` reading of a page the core's browser rendered) and ``evimed-api`` (the owner's EviMed
evidence API scans). ``relay`` is an egress of the same read methods, not an adapter of its own;
``wechat-bridge`` comes later.

``validate_config(source)`` lists what is wrong with a registry row's adapter configuration
(unknown json-api family, a refused Crossref ``select`` field, a PubMed ``datetype`` that would
silently return nothing, list selectors that do not parse, …) so the registry load test can
fail on it at review time instead of the source failing at 3 a.m.
"""

from __future__ import annotations

from ..model import SourceConfig
from .base import Adapter
from .crossref import CrossrefIssnAdapter
from .europepmc import EuropePmcAdapter
from .eutils import EutilsQueryAdapter
from .evimed_api import EvimedApiAdapter
from .feed import FeedAdapter
from .html_list import HtmlListAdapter
from .json_api import JsonApiAdapter

REGISTRY: dict[str, Adapter] = {
    "crossref-issn": CrossrefIssnAdapter(),
    "eutils-query": EutilsQueryAdapter(),
    "europepmc": EuropePmcAdapter(),
    "json-api": JsonApiAdapter(),
    "rss": FeedAdapter("rss"),
    "atom": FeedAdapter("atom"),
    "html-list": HtmlListAdapter(),
    "browser-list": HtmlListAdapter("browser-list"),
    "evimed-api": EvimedApiAdapter(),
}


def validate_config(source: SourceConfig) -> list[str]:
    """Problems with ``source.config`` for its adapter; ``[]`` when fine or when no adapter exists yet."""
    adapter = REGISTRY.get(source.access)
    if adapter is None:
        return []
    return list(adapter.validate_config(source))  # type: ignore[attr-defined]
