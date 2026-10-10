"""The AI-discovery rows (循证进化 breadth, 2026-10-10) against recorded answers and the traps of each reader.

The weekly self-research used to read one arXiv query. It now reads the source set decided on 2026-10-10: three arXiv
phrase rows over the core AI categories and one for papers whose comment says accepted, Hugging Face Daily Papers /
model releases / blog, the Anthropic research mirror, the GitHub releases of the agent frameworks (REST, because
github.com's robots.txt disallows ``*.atom``) and the kernel's upstream, PMLR volumes and the ACL Anthology's ingestion
commits. Every one of them is ``discovery_only``: the medical feed drops them, the platform recognises the id prefix.

The Hugging Face rows are relay rows, recorded here from the dev box over a direct connection; they stay disabled
(``relay_not_accepted``) until the Tokyo node has read them, and no acceptance is written for them here.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.adapters.json_api import family_of
from knowledge_plugin.model import FetchError, FetchResult, RequestSpec, SourceConfig, SourceState
from knowledge_plugin.registry import validate_row
from knowledge_plugin.source_requests import admitted_requests
from replay import load_case

ROOT = Path(__file__).resolve().parents[2]
ROWS = {row["id"]: row for row in json.loads((ROOT / "registry" / "sources.json").read_text(encoding="utf-8"))["sources"]}
DISCOVERY = {sid: row for sid, row in ROWS.items() if sid.startswith("ai-discovery-")}
RELAY_ACCEPTANCE = ROOT / "registry" / "research" / "probe-edge-honest-ua-2026-09-22.jsonl"
NOW = datetime(2026, 10, 10, 18, 0, tzinfo=timezone.utc)
FRESH = SourceState(None, None, None, None, None, {})


def source(row: dict, **config) -> SourceConfig:
    built = SourceConfig(**{name: row.get(name) for name in SourceConfig.__dataclass_fields__})
    return replace(built, config={**built.config, **config}) if config else built


def answer(url: str, payload, *, status: int = 200, not_modified: bool = False) -> FetchResult:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    return FetchResult(request=RequestSpec(url=url, api=True), final_url=url, status=status, headers={}, body=body,
                       fetched_at=NOW, not_modified=not_modified)


def parsed(name: str):
    case = load_case(name)
    adapter = REGISTRY[case.source.access]
    outputs = [adapter.parse(result, case.source, case.now) for result in case.results()]
    return case, outputs, [entry for output in outputs for entry in output.entries]


# --------------------------------------------------------------------------------------------- the registry

def test_the_registry_carries_the_discovery_set_and_not_the_single_query():
    assert "arxiv-agent-self-improvement" not in ROWS, "the single arXiv query is replaced, not kept beside the set"
    assert len(DISCOVERY) == 28
    for sid, row in DISCOVERY.items():
        assert validate_row(row) == [], sid
        assert row["lane"] == "ai" and row["category"] == "ai-discovery", sid
        assert row["config"]["discovery_only"] is True, sid
        host = urlsplit(row["config"]["url"]).hostname
        assert host in row["config"]["allowed_hosts"], sid
        assert validate_config(source(row)) == [], sid


def test_every_row_has_an_exit_the_evidence_supports_and_none_is_accepted_without_a_probe():
    relay = {sid for sid, row in DISCOVERY.items() if row["egress"] == "relay"}
    # huggingface.co is unreachable from the Beijing host (measured 2026-09-21); the Tokyo relay reads it.
    assert relay == {"ai-discovery-hf-daily-papers", "ai-discovery-hf-models-deepseek", "ai-discovery-hf-models-qwen",
                     "ai-discovery-hf-blog"}
    for sid in relay:
        assert DISCOVERY[sid]["enabled"] is False and DISCOVERY[sid]["disabled_reason"] == "relay_not_accepted"
    assert all(row["enabled"] for sid, row in DISCOVERY.items() if sid not in relay)
    accepted = {json.loads(line)["id"] for line in RELAY_ACCEPTANCE.read_text(encoding="utf-8").splitlines() if line.strip()}
    assert not accepted & set(DISCOVERY), "a relay acceptance is a record of a probe from the Tokyo node, never written by hand"


def test_the_arxiv_rows_cover_the_phrases_and_categories_of_the_brief():
    for sid in ("ai-discovery-arxiv-judges-evals", "ai-discovery-arxiv-agents-memory", "ai-discovery-arxiv-retrieval-evidence"):
        url = DISCOVERY[sid]["config"]["url"]
        for category in ("cs.AI", "cs.CL", "cs.LG", "cs.IR", "cs.MA", "cs.SE", "stat.ML", "q-bio.QM"):
            assert f"cat:{category}" in url, (sid, category)
        assert "sortBy=submittedDate&sortOrder=descending&max_results=100" in url
        assert DISCOVERY[sid]["config"]["arxiv_comment"] is True
    assert "abs:%22LLM-as-a-judge%22" in DISCOVERY["ai-discovery-arxiv-judges-evals"]["config"]["url"]
    agents = DISCOVERY["ai-discovery-arxiv-agents-memory"]["config"]["url"]
    for phrase in ("agent+memory", "recursive+self-improvement", "skill+library", "context+engineering", "AI+scientist"):
        assert f"abs:%22{phrase}%22" in agents
    assert "abs:%22generative+engine+optimization%22" in DISCOVERY["ai-discovery-arxiv-retrieval-evidence"]["config"]["url"]


def test_the_venue_row_names_no_year_so_it_never_goes_stale():
    config = DISCOVERY["ai-discovery-arxiv-venue-accepted"]["config"]
    for venue in ("NeurIPS", "EMNLP", "ICLR", "COLM", "ICML", "ACL", "TMLR"):
        assert f"co:{venue}" in config["url"]
    assert "co:accepted" in config["url"] and "sortBy=lastUpdatedDate" in config["url"]
    assert not any(token.isdigit() and len(token) == 4 for token in config["url"].replace("+", " ").split())


def test_the_github_rows_cover_the_listed_repositories_and_the_kernel_upstream():
    repos = {row["config"]["url"].split("/repos/")[1].split("/releases")[0] for sid, row in DISCOVERY.items()
             if row["config"].get("family") == "github-releases"}
    assert len(repos) == 17
    assert {"langchain-ai/langgraph", "openai/openai-agents-python", "microsoft/agent-framework", "pydantic/pydantic-ai",
            "google/adk-python", "crewAIInc/crewAI", "anthropics/claude-agent-sdk-python", "OpenHands/OpenHands",
            "modelcontextprotocol/modelcontextprotocol", "modelcontextprotocol/python-sdk", "modelcontextprotocol/typescript-sdk",
            "mem0ai/mem0", "getzep/graphiti", "letta-ai/letta", "vllm-project/vllm", "huggingface/smolagents",
            "deepseek-ai/deepseek-harness"} == repos
    assert all(urlsplit(DISCOVERY[sid]["config"]["url"]).hostname == "api.github.com" for sid in DISCOVERY
               if sid.startswith("ai-discovery-gh-"))


def test_a_discovery_row_is_a_request_the_plugin_would_admit_and_a_relay_row_is_not():
    arxiv = {**DISCOVERY["ai-discovery-arxiv-judges-evals"], "enabled": True, "disabled_reason": None}
    accepted, dispositions = admitted_requests({"sources": [arxiv]}, [])
    assert [d["status"] for d in dispositions] == ["admitted"] and len(accepted) == 1
    accepted, dispositions = admitted_requests({"sources": [DISCOVERY["ai-discovery-hf-daily-papers"]]}, [])
    assert not accepted and dispositions[0]["status"] == "deferred"  # the policy takes direct readers on scholarly hosts only


# --------------------------------------------------------------------------------------------- arXiv rows

def test_arxiv_entries_carry_the_authors_words_beside_the_abstract_and_keep_one_identity():
    case, _, found = parsed("atom/ai-discovery-arxiv-venue-accepted")
    assert len(found) == 100
    first = found[0]
    assert first.external_key == "arxiv:2610.12453" and first.doi == "10.48550/arxiv.2610.12453"
    assert first.url == "https://arxiv.org/abs/2610.12453"
    assert first.summary.endswith("\n\nComments: Accepted at NeurIPS 2026")
    assert all(e.external_key.startswith("arxiv:") and "v" not in e.external_key.split(":")[1] for e in found)
    assert sum("Comments: " in e.summary for e in found) == 100  # the row asks for papers whose comment says accepted
    _, _, topical = parsed("atom/ai-discovery-arxiv-agents-memory")
    assert 0 < sum("Comments: " in e.summary for e in topical) < len(topical)  # not every paper has a comment


def test_the_comment_is_added_only_where_the_row_asks_for_it():
    case = load_case("atom/ai-discovery-arxiv-venue-accepted")
    plain = replace(case.source, config={k: v for k, v in case.source.config.items() if k != "arxiv_comment"})
    adapter = REGISTRY["atom"]
    with_comment = adapter.parse(case.results()[0], case.source, case.now).entries
    without = adapter.parse(case.results()[0], plain, case.now).entries
    assert all("Comments:" in e.summary for e in with_comment) and not any("Comments:" in e.summary for e in without)
    assert [e.external_key for e in with_comment] == [e.external_key for e in without]
    assert all(a.summary.startswith(b.summary) for a, b in zip(with_comment, without))


# --------------------------------------------------------------------------------------------- Hugging Face

def test_daily_papers_keeps_papers_with_twenty_upvotes_and_walks_back_two_days():
    case, outputs, found = parsed("json-api/ai-discovery-hf-daily-papers")
    assert [e.spec.url for e in case.exchanges] == [
        "https://huggingface.co/api/daily_papers?date=2026-10-10&limit=100",
        "https://huggingface.co/api/daily_papers?limit=100&date=2026-10-09",
        "https://huggingface.co/api/daily_papers?limit=100&date=2026-10-08"]
    assert [o.next is not None for o in outputs] == [True, True, False], "the walk ends at lookback_days"
    assert outputs[1].notes == ["huggingface_below_20_upvotes=52"]
    for entry in found:
        assert entry.external_key.startswith("arxiv:") and entry.doi == f"10.48550/arxiv.{entry.external_key[6:]}"
        assert entry.date_precision == "day" and entry.url == f"https://arxiv.org/abs/{entry.external_key[6:]}"
    assert len({e.external_key for e in found}) == len(found)
    with_code = [e for e in found if "\n\nCode: https://github.com/" in e.summary]
    assert with_code and all(e.summary.rsplit("Code: ", 1)[1].startswith("https://github.com/") for e in with_code)


def test_daily_papers_traps_threshold_duplicates_shape_and_not_modified():
    row = DISCOVERY["ai-discovery-hf-daily-papers"]
    url = "https://huggingface.co/api/daily_papers?date=2026-10-09&limit=100"

    def paper(pid, upvotes, **extra):
        return {"paper": {"id": pid, "title": f"Paper {pid}", "summary": "An abstract.", "upvotes": upvotes,
                          "publishedAt": "2026-10-08T00:00:00.000Z", **extra}}

    items = [paper("2610.00001", 19), paper("2610.00002", 20), paper("2610.00002", 99),
             paper("not-an-arxiv-id", 50), {"title": "no paper"}, paper("2610.00003", 40, githubRepo="http://example.org/x")]
    adapter = REGISTRY["json-api"]
    out = adapter.parse(answer(url, items), source(row), NOW)
    assert [e.external_key for e in out.entries] == ["arxiv:2610.00002", "arxiv:2610.00003"]
    assert out.notes == ["huggingface_below_20_upvotes=1"]
    assert "Code:" not in out.entries[1].summary, "only a github.com repository is carried"
    assert [e.external_key for e in adapter.parse(answer(url, items), source(row, min_upvotes=0), NOW).entries] == [
        "arxiv:2610.00001", "arxiv:2610.00002", "arxiv:2610.00003"]
    assert adapter.parse(answer(url, items), source(row, lookback_days=0), NOW).next is None
    with pytest.raises(FetchError) as error:
        adapter.parse(answer(url, {"error": "rate limited"}), source(row), NOW)
    assert error.value.detail == "huggingface_daily_unexpected_shape"
    assert adapter.parse(answer(url, b"", not_modified=True), source(row), NOW).notes == ["huggingface_not_modified"]


def test_the_models_row_is_one_entry_per_public_model_newest_first():
    case, _, found = parsed("json-api/ai-discovery-hf-models")
    assert len(found) == 20 and found[0].external_key == "hf-model:deepseek-ai/DeepSeek-V4.1-Flash"
    assert found[0].url == "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash"
    assert "link-derived" in found[0].defects and found[0].summary.endswith("License: mit.")
    row = DISCOVERY["ai-discovery-hf-models-qwen"]
    out = REGISTRY["json-api"].parse(answer(row["config"]["url"], [
        {"id": "Qwen/Qwen-Public", "createdAt": "2026-10-09T01:00:00.000Z", "pipeline_tag": "text-generation"},
        {"id": "Qwen/Qwen-Private", "private": True, "createdAt": "2026-10-09T01:00:00.000Z"},
        {"id": "no-owner", "createdAt": "2026-10-09T01:00:00.000Z"}]), source(row), NOW)
    assert [e.external_key for e in out.entries] == ["hf-model:Qwen/Qwen-Public"]


def test_the_blog_the_mirror_and_the_volume_feeds_are_read_as_feeds():
    _, _, blog = parsed("rss/ai-discovery-hf-blog")
    assert blog and all(e.url.startswith("https://huggingface.co/blog/") for e in blog)
    _, _, research = parsed("rss/ai-discovery-anthropic-research")
    assert research and all(e.url.startswith("https://www.anthropic.com/") for e in research)
    assert sum(e.url.startswith("https://www.anthropic.com/research/") for e in research) > 100
    _, _, volumes = parsed("rss/ai-discovery-pmlr-volumes")
    assert {e.external_key for e in volumes} >= {"https://proceedings.mlr.press/v1", "https://proceedings.mlr.press/v2"}
    # PMLR dates nothing: the core reads an undated entry as old on first contact and as new afterwards.
    assert all(e.published_at is None for e in volumes)


# --------------------------------------------------------------------------------------------- GitHub

def test_a_repository_is_read_through_the_rest_api_with_validators_and_the_version_header():
    row = DISCOVERY["ai-discovery-gh-langchain-ai-langgraph"]
    (request,) = REGISTRY["json-api"].plan(source(row), FRESH, NOW)
    assert request.url == "https://api.github.com/repos/langchain-ai/langgraph/releases?per_page=10"
    assert request.headers == {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    assert request.conditional is True and request.api is True  # an API: robots.txt does not apply, a 304 costs no rate limit
    assert family_of(source(row)) == "github-releases"


def test_releases_leave_out_drafts_and_name_a_prerelease_in_the_title():
    case, _, found = parsed("json-api/ai-discovery-github-releases")
    assert len(found) == 10
    first = found[0]
    assert first.external_key == "github-release:langchain-ai/langgraph:cli==0.4.33"
    assert first.url.startswith("https://github.com/langchain-ai/langgraph/releases/tag/")
    assert first.published_at is not None and first.defects == []
    row = DISCOVERY["ai-discovery-gh-pydantic-pydantic-ai"]
    url = row["config"]["url"]
    out = REGISTRY["json-api"].parse(answer(url, [
        {"tag_name": "v1.0.0", "name": "v1.0.0", "html_url": "https://github.com/pydantic/pydantic-ai/releases/tag/v1.0.0",
         "published_at": "2026-10-09T10:00:00Z", "body": "## Breaking\n* the agent API"},
        {"tag_name": "v1.1.0rc1", "name": "", "prerelease": True, "html_url": "https://github.com/pydantic/pydantic-ai/releases/tag/v1.1.0rc1",
         "published_at": "2026-10-09T11:00:00Z", "body": ""},
        {"tag_name": "v9", "draft": True, "html_url": "https://github.com/pydantic/pydantic-ai/releases/tag/v9"},
        {"tag_name": "v8", "html_url": "https://evil.example/releases/tag/v8"},
        {"name": "no tag", "html_url": "https://github.com/pydantic/pydantic-ai/releases/tag/none"}]), source(row), NOW)
    assert [e.title for e in out.entries] == ["pydantic/pydantic-ai v1.0.0", "pydantic/pydantic-ai v1.1.0rc1 (pre-release)"]
    assert out.entries[0].summary == "## Breaking\n* the agent API" and out.entries[1].summary is None
    assert all("pre-release" not in d for e in out.entries for d in e.defects), "the defect vocabulary is closed"


def test_release_traps_not_modified_wrong_shape_and_wrong_address():
    row = DISCOVERY["ai-discovery-gh-vllm-project-vllm"]
    url = row["config"]["url"]
    adapter = REGISTRY["json-api"]
    assert adapter.parse(answer(url, b"", status=304, not_modified=True), source(row), NOW).notes == ["github_not_modified"]
    with pytest.raises(FetchError) as shape:
        adapter.parse(answer(url, {"message": "Not Found"}), source(row), NOW)
    assert shape.value.detail == "github_releases_unexpected_shape"
    with pytest.raises(FetchError) as limited:
        adapter.parse(answer(url, {"message": "API rate limit exceeded"}, status=403), source(row), NOW)
    assert limited.value.detail == "github_http_403"
    with pytest.raises(FetchError) as address:
        adapter.parse(answer("https://api.github.com/orgs/vllm-project", []), source(row), NOW)
    assert address.value.detail == "github_releases_unexpected_url"


def test_the_anthology_row_keeps_the_ingestion_commits_and_nothing_else():
    case, outputs, found = parsed("json-api/ai-discovery-github-commits")
    assert [e.title for e in found] == [
        "acl-org/acl-anthology: Ingest TACL 2026(Sep) (#10188)", "acl-org/acl-anthology: Ingest AIME-Con (#10112)",
        "acl-org/acl-anthology: Ingest STIL 2026 proceedings (#10131)", "acl-org/acl-anthology: Ingest more clicit volumes (#10149)"]
    assert outputs[0].notes == ["github_commits_not_matching=26"]
    assert found[0].external_key == "github-commit:acl-org/acl-anthology:aba352fa0375"
    assert found[0].url.startswith("https://github.com/acl-org/acl-anthology/commit/")
    body = case.results()[0].body.decode("utf-8")
    addresses = set(re.findall(r"[A-Za-z0-9._%+\[\]-]+@[A-Za-z0-9.-]+", body))
    assert addresses <= {"49699333+dependabot[bot]@users.noreply.github.com"}, "authors' and co-authors' addresses are redacted from the fixture"
    unfiltered = replace(case.source, config={k: v for k, v in case.source.config.items() if k != "message_contains"})
    assert len(REGISTRY["json-api"].parse(case.results()[0], unfiltered, case.now).entries) == 30
    with pytest.raises(FetchError) as shape:
        REGISTRY["json-api"].parse(answer(case.exchanges[0].spec.url, {"message": "Bad credentials"}), case.source, NOW)
    assert shape.value.detail == "github_commits_unexpected_shape"
