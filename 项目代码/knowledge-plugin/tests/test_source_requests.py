"""A platform wish list cannot enable excluded rows or add arbitrary hosts."""
import json
from pathlib import Path
from knowledge_plugin.registry import parse_registry
from knowledge_plugin.source_requests import admitted_requests


def discovery_row():
    """An arXiv phrase row of the registry, as the platform would word a request for one."""
    doc = json.loads((Path(__file__).parents[1] / "registry/extra-sources.json").read_text())
    return next(row for row in doc["sources"] if row["id"] == "ai-discovery-arxiv-judges-evals")


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


# The row the platform files for an arXiv feed its scout found (OpenScience/apps/server/src/evolutionSourceRequests.mjs `requestRow`; the
# platform's test pins the same literal): every field the admission checks is set from a closed value, and the plugin admits it.
PLATFORM_ARXIV_ROW = {
    "id": "ai-discovery-req-eb3e36c3b57c", "name": "arXiv · test-time training", "homepage": "https://export.arxiv.org/", "lane": "ai",
    "source_type": "preprint", "access": "atom", "egress": "direct", "authority": 2, "safety_feed": False, "owner_entity": "export.arxiv.org",
    "launch_tier": "P0", "language": "en", "poll_floor_s": 21600, "poll_ceiling_s": 129600, "category": "ai-discovery",
    "config": {"url": "https://export.arxiv.org/api/query?max_results=100&search_query=abs%3A%22test-time+training%22+AND+cat%3Acs.LG&sortBy=submittedDate&sortOrder=descending",
               "max_pages": 1, "allowed_hosts": ["export.arxiv.org"], "discovery_only": True, "arxiv_comment": True},
}


def test_a_row_the_platform_files_is_admitted_and_one_that_breaks_the_policy_is_not():
    accepted, dispositions = admitted_requests({"sources": [PLATFORM_ARXIV_ROW]}, [])
    assert [d["status"] for d in dispositions] == ["admitted"] and accepted[0].enabled
    assert accepted[0].source.config["arxiv_comment"] is True and accepted[0].source.id.startswith("ai-discovery-req-")
    # The same request a second time is already registered, and a request off the policy's hosts or off the direct exit is deferred.
    assert admitted_requests({"sources": [PLATFORM_ARXIV_ROW]}, accepted)[1][0]["status"] == "already_registered"
    off_host = {**PLATFORM_ARXIV_ROW, "id": "ai-discovery-req-000000000002", "config": {**PLATFORM_ARXIV_ROW["config"], "url": "https://example.org/feed.xml", "allowed_hosts": ["example.org"]}}
    relayed = {**PLATFORM_ARXIV_ROW, "id": "ai-discovery-req-000000000003", "egress": "relay"}
    for refused in (off_host, relayed):
        assert admitted_requests({"sources": [refused]}, [])[1][0]["status"] == "deferred"
