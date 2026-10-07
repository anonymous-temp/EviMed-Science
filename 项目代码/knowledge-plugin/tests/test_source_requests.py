"""A platform wish list cannot enable excluded rows or add arbitrary hosts."""
import json
from pathlib import Path
from knowledge_plugin.registry import parse_registry
from knowledge_plugin.source_requests import admitted_requests


def discovery_row():
    doc = json.loads((Path(__file__).parents[1] / "registry/extra-sources.json").read_text())
    return next(row for row in doc["sources"] if row["id"] == "arxiv-agent-self-improvement")


def test_supported_discovery_admitted_and_arbitrary_host_refused():
    row = discovery_row()
    accepted, dispositions = admitted_requests({"sources": [row]}, [])
    assert len(accepted) == 1
    assert dispositions[0]["status"] == "admitted"
    row["config"]["allowed_hosts"] = ["example.com"]
    row["config"]["url"] = "https://example.com/feed"
    assert not admitted_requests({"sources": [row]}, [])[0]


def test_existing_exclusion_is_never_overwritten():
    row = discovery_row()
    existing = parse_registry({"sources": [{**row, "enabled": False, "disabled_reason": "owner_excluded"}]})
    accepted, dispositions = admitted_requests({"sources": [row]}, existing)
    assert not accepted
    assert dispositions[0]["status"] == "already_registered"


def test_a_page_where_the_manifest_should_be_is_deferred_not_raised(plain_settings, monkeypatch):
    """With 循证进化 off the platform once answered the manifest address with its web page (200, text/html)."""
    import asyncio
    from types import SimpleNamespace
    from knowledge_plugin.scheduler import Crawler

    class PageFetcher:
        async def fetch(self, spec, **_):
            return SimpleNamespace(status=200, body=b"<!doctype html><html lang=\"zh-CN\"><head></head></html>")

    monkeypatch.setenv("EVIMED_SOURCE_REQUESTS_URL", "https://platform.example.org/evolution/source-requests.json")
    crawler = Crawler(plain_settings, None, PageFetcher(), adapters={})
    assert asyncio.run(crawler.pull_source_requests()) == {"status": "deferred", "reason": "manifest_invalid"}
