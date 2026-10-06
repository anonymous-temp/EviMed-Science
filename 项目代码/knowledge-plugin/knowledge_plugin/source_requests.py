"""Pull-only source requests, admitted by plugin policy rather than platform instructions."""
from __future__ import annotations

from urllib.parse import urlsplit
from .registry import parse_registry, RegistryError
from .adapters import validate_config

DISCOVERY_HOSTS = frozenset({"arxiv.org", "export.arxiv.org", "openreview.net", "api.openreview.net",
                            "proceedings.iclr.cc", "proceedings.mlr.press", "papers.nips.cc", "papers.neurips.cc",
                            "neurips.cc", "aclanthology.org", "colmweb.org"})


def admitted_requests(document: dict, existing: list) -> tuple[list, list[dict]]:
    """Only bounded supported discovery readers on trusted scholarly hosts; exclusions survive."""
    accepted, dispositions = [], []
    known = {row.source.id: row for row in existing}
    for request in document.get("sources", [])[:25]:
        sid = request.get("id") if isinstance(request, dict) else None
        if sid in known:
            dispositions.append({"id": sid, "status": "already_registered"})
            continue
        try:
            row = {**request, "enabled": True, "disabled_reason": None}
            config = row.get("config", {})
            hosts = set(config.get("allowed_hosts", []))
            urls = [config.get("url", ""), *config.get("urls", [])]
            if row.get("access") not in {"rss", "atom", "html-list", "json-api"} or row.get("egress") != "direct":
                raise ValueError("unsupported_reader")
            if not hosts or not hosts <= DISCOVERY_HOSTS or any(urlsplit(url).hostname not in hosts for url in urls):
                raise ValueError("unapproved_host")
            if row.get("lane") != "ai" or not config.get("discovery_only"):
                raise ValueError("discovery_only_required")
            parsed = parse_registry({"sources": [row]})[0]
            if validate_config(parsed.source):
                raise ValueError("adapter_config_invalid")
            accepted.append(parsed)
            known[sid] = parsed
            dispositions.append({"id": sid, "status": "admitted"})
        except (RegistryError, ValueError, TypeError, KeyError) as error:
            dispositions.append({"id": sid, "status": "deferred", "reason": type(error).__name__})
    return accepted, dispositions
