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
    return CrawlClient(ledger, settings, lambda: datetime.now(timezone.utc), transport=httpx.MockTransport(handler), poll_interval_s=0.001,
                       poll_retry_delays_s=(0.001, 0.001)), ledger, key


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


def accepted(request):
    return httpx.Response(202, json={"job_id": JOB, "job_status": "queued"})


async def test_the_job_names_its_platforms_as_a_list_like_the_platforms_own_client(plain_settings, tmp_path):
    bodies = []
    def answer(request):
        if request.method == "POST":
            bodies.append(json.loads(request.content))
            return accepted(request)
        return httpx.Response(200, json=done())
    crawler, _, _ = client(plain_settings, tmp_path, answer)
    await crawler.crawl("test", "xhs")
    assert bodies[0]["platforms"] == ["xhs"] and "platform" not in bodies[0]


@pytest.mark.parametrize("busy", [httpx.Response(503), httpx.Response(429, headers={"retry-after": "0"}), httpx.Response(503, headers={"retry-after": "junk"})])
async def test_a_busy_poll_is_asked_again_within_the_deadline_and_never_submits_again(plain_settings, tmp_path, busy):
    methods = []
    def answer(request):
        methods.append(request.method)
        if request.method == "POST":
            return accepted(request)
        return busy if methods.count("GET") < 3 else httpx.Response(200, json=done())
    crawler, ledger, _ = client(plain_settings, tmp_path, answer)
    result = await crawler.crawl("test", "xhs")
    assert result["posts"] and methods == ["POST", "GET", "GET", "GET"]
    assert len(ledger.rows) == 1 and ledger.rows[0]["outcome"] == "ok"


async def test_busy_polls_are_asked_a_bounded_number_of_times_then_the_accepted_job_is_unavailable(plain_settings, tmp_path):
    methods = []
    def answer(request):
        methods.append(request.method)
        return accepted(request) if request.method == "POST" else httpx.Response(503)
    crawler, ledger, _ = client(plain_settings, tmp_path, answer)
    with pytest.raises(ProviderError) as caught:
        await crawler.crawl("test", "xhs")
    assert caught.value.detail == "accepted_result_unavailable" and caught.value.kind == "failed"
    assert methods == ["POST", "GET", "GET", "GET"], "the first ask and two retries, one submit"
    assert len(ledger.rows) == 1


async def test_a_busy_submit_is_not_retried_here_and_a_dropped_poll_connection_is(plain_settings, tmp_path):
    methods = []
    crawler, _, _ = client(plain_settings, tmp_path, lambda request: methods.append(request.method) or httpx.Response(503))
    with pytest.raises(ProviderError) as caught:
        await crawler.crawl("test", "xhs")
    assert caught.value.kind == "rate-limited" and methods == ["POST"]
    methods.clear()
    def dropping(request):
        methods.append(request.method)
        if request.method == "POST":
            return accepted(request)
        if methods.count("GET") == 1:
            raise httpx.ConnectError("reset")
        return httpx.Response(200, json=done())
    crawler, _, _ = client(plain_settings, tmp_path, dropping)
    assert (await crawler.crawl("test", "xhs"))["posts"] and methods == ["POST", "GET", "GET"]


async def test_the_collectors_200_replay_of_a_submit_is_an_accepted_job(plain_settings, tmp_path):
    methods = []
    def answer(request):
        methods.append(request.method)
        return httpx.Response(200, json={"job_id": JOB, "job_status": "running"}) if request.method == "POST" else httpx.Response(200, json=done())
    crawler, _, _ = client(plain_settings, tmp_path, answer)
    assert (await crawler.crawl("test", "xhs"))["posts"] and methods == ["POST", "GET"]


@pytest.mark.parametrize("meta, posts", [({"requirements_met": False}, 0), ({"requirements_met": False}, 2)])
async def test_unmet_requirements_without_errors_are_empty_or_partial_never_an_error(plain_settings, tmp_path, meta, posts):
    value = done()
    value["result"]["meta"].update(meta)
    value["result"]["posts"] = [{"post_id": f"p{index}", "url": f"https://example.org/p{index}", "content": "public excerpt"} for index in range(posts)]
    crawler, ledger, _ = client(plain_settings, tmp_path, lambda request: httpx.Response(202, json=value))
    result = await crawler.crawl("test", "xhs")
    assert len(result["posts"]) == posts
    # No posts and nothing wrong: the read is empty (as the collector said, "collected" with none); with posts it is not full coverage.
    assert result["meta"]["collection_status"] == ("collected" if posts == 0 else "partial_collected")
    assert ledger.rows[0]["outcome"] == ("ok" if posts == 0 else "failed")


@pytest.mark.parametrize("patch", [{"collection_status": "partial_collected"}, {"has_errors": True}, {"error_details_total": 2}, {"collection_status": "failed"}])
async def test_unmet_requirements_with_an_error_and_no_posts_are_still_a_failed_read(plain_settings, tmp_path, patch):
    value = done()
    value["result"]["meta"].update({"requirements_met": False, **patch})
    value["result"]["posts"] = []
    crawler, ledger, _ = client(plain_settings, tmp_path, lambda request: httpx.Response(202, json=value))
    with pytest.raises(ProviderError) as caught:
        await crawler.crawl("test", "xhs")
    assert caught.value.detail == "collection_incomplete" and ledger.rows[0]["outcome"] == "failed"


async def test_the_multi_platform_envelope_of_a_one_platform_job_is_read_too(plain_settings, tmp_path):
    envelope = {"job_id": JOB, "query": "test", "platforms": ["xhs"], "progress": {"xhs": {"status": "done", "requirements_met": True}}, "errors": {},
                "results": {"xhs": done()["result"]}}
    crawler, _, _ = client(plain_settings, tmp_path, lambda request: httpx.Response(202, json=done(result=envelope)))
    assert (await crawler.crawl("test", "xhs"))["posts"][0]["post_id"] == "p"
    for patch, expected in [({"errors": {"xhs": "boom"}}, "collection_incomplete"), ({"progress": {"xhs": {"status": "partial"}}}, "collection_incomplete"),
                            ({"results": {"zhihu": done()["result"]}}, "invalid_result"), ({"results": {}}, "missing_platform"),
                            ({"query": "other"}, "invalid_result")]:
        bad = {**envelope, **patch}
        if patch.get("errors") or patch.get("progress"):
            bad["results"] = {"xhs": {**done()["result"], "posts": []}}      # nothing usable besides what went wrong
        crawler, _, _ = client(plain_settings, tmp_path, lambda request, bad=bad: httpx.Response(202, json=done(result=bad)))
        with pytest.raises(ProviderError) as caught:
            await crawler.crawl("test", "xhs")
        assert caught.value.detail == expected, patch
