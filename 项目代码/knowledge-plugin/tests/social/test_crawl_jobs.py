"""Collector 0.5.0 jobs: identity, one charge, no duplicate submission, and partial coverage."""
from dataclasses import replace
from datetime import datetime, timezone
import json

import httpx
import pytest

from knowledge_plugin.social.providers import CrawlClient, ProviderError

JOB = "a" * 32

class Ledger:
    def __init__(self):
        self.rows = []

    async def check(self, *args):
        pass

    async def record(self, provider, **row):
        self.rows.append(row)


def client(plain_settings, tmp_path, handler):
    key = tmp_path / "crawler-key"
    key.write_text("mock-social-key")
    key.chmod(0o600)
    settings = replace(plain_settings, social_crawl_url="https://crawler.test", social_crawl_key_file=str(key))
    ledger = Ledger()
    return CrawlClient(ledger, settings, lambda: datetime.now(timezone.utc), transport=httpx.MockTransport(handler), poll_interval_s=0.001), ledger, key


def done(**patch):
    return {"job_id": JOB, "job_status": "done", "query": "test", "platforms": ["xhs"], "result": {
        "platform": "xhs", "question": "test", "meta": {"collection_status": "collected"},
        "posts": [{"post_id": "p", "url": "https://example.org/p", "content": "public excerpt"}]}, **patch}


async def test_async_job_rotates_auth_and_records_once(plain_settings, tmp_path):
    calls = []
    def answer(request):
        calls.append(request)
        if request.method == "POST":
            assert request.headers["authorization"] == "Bearer mock-social-key"
            assert request.headers["idempotency-key"]
            assert json.loads(request.content)["collect_comments"] is False
            key.write_text("rotated-mock-key")
            return httpx.Response(202, json={"job_id": JOB, "job_status": "queued"})
        assert request.url.path == f"/api/jobs/{JOB}"
        assert request.headers["authorization"] == "Bearer rotated-mock-key"
        return httpx.Response(200, json=done())
    crawler, ledger, key = client(plain_settings, tmp_path, answer)
    result = await crawler.crawl("test", "xhs")
    assert result["posts"][0]["post_id"] == "p"
    assert len(calls) == 2 and len(ledger.rows) == 1 and ledger.rows[0]["amount"] == 1


@pytest.mark.parametrize("response", [httpx.Response(404), httpx.Response(302, headers={"location": "https://other.test"}), httpx.Response(200, json=done(job_id="b" * 32))])
async def test_accepted_poll_failure_never_submits_again(plain_settings, tmp_path, response):
    methods = []
    def answer(request):
        methods.append(request.method)
        return httpx.Response(202, json={"job_id": JOB, "job_status": "queued"}) if request.method == "POST" else response
    crawler, ledger, _ = client(plain_settings, tmp_path, answer)
    with pytest.raises(ProviderError):
        await crawler.crawl("test", "xhs")
    assert methods == ["POST", "GET"] and len(ledger.rows) == 1
    assert ledger.rows[0]["outcome"] == "failed"


async def test_partial_results_keep_usable_posts_but_never_claim_full_coverage(plain_settings, tmp_path):
    crawler, ledger, _ = client(plain_settings, tmp_path, lambda request: httpx.Response(202, json=done(requirements_met=False)))
    result = await crawler.crawl("test", "xhs")
    assert result["meta"]["collection_status"] == "partial_collected" and result["posts"]
    assert ledger.rows[0]["outcome"] == "failed"


async def test_missing_credential_makes_no_requests_or_charges(plain_settings, tmp_path):
    calls = []
    crawler, ledger, key = client(plain_settings, tmp_path, lambda request: calls.append(request))
    key.unlink()
    assert crawler.configured is False
    with pytest.raises(ProviderError):
        await crawler.crawl("test", "xhs")
    assert not calls and not ledger.rows

@pytest.mark.parametrize("stage", [{"detail": {"failed": 1}}, {"detail": {"complete": False}}, {"stage_completeness": {"detail": {"enabled": True, "status": "failed"}}}, {"error_details_total": 1}, {"collection_status": "failed"}])
async def test_incomplete_stages_cannot_be_reported_as_collected(plain_settings, tmp_path, stage):
    value = done()
    value["result"]["meta"].update(stage)
    crawler, ledger, _ = client(plain_settings, tmp_path, lambda request: httpx.Response(202, json=value))
    result = await crawler.crawl("test", "xhs")
    assert result["meta"]["collection_status"] == "partial_collected"
    assert ledger.rows[0]["outcome"] == "failed"

def test_compose_mounts_an_independent_credential_into_the_plugin_user_service():
    from pathlib import Path
    import yaml
    root = Path(__file__).resolve().parents[4]
    compose = yaml.safe_load((root / "OpenScience/deploy/web/docker-compose.knowledge.yml").read_text())
    plugin = compose["services"]["evimed-knowledge-plugin"]
    assert plugin["environment"]["KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_KEY_FILE"] == "/run/secrets/geo-social-api-key"
    mounts = [mount for mount in plugin["volumes"] if isinstance(mount, dict) and mount.get("target") == "/run/secrets/geo-social-api-key"]
    assert len(mounts) == 1 and mounts[0]["read_only"] is True
    assert "KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_KEY_HOST_FILE" in mounts[0]["source"]
