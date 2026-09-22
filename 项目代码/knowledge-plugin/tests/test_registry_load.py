"""The registry load test (plan 10.2.9, last bullet): every row loads into the ``sources``
definition; a missing field, a value outside the vocabulary or a literal date in a URL fails."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from knowledge_plugin import model
from knowledge_plugin.registry import RegistryError, load_registry, parse_registry, sync_registry, validate_row

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry" / "sources.json"
CONTRACT = ROOT / "contract" / "knowledge-plugin-openapi.yaml"
DOCS_CONTRACT = ROOT.parent.parent / "docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/contract/knowledge-plugin-openapi.yaml"


@pytest.fixture(scope="module")
def document():
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def test_the_committed_registry_is_a_fresh_deterministic_build():
    done = subprocess.run([sys.executable, str(ROOT / "tools" / "build_registry.py"), "--check"], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_every_row_validates(document):
    rows = load_registry(REGISTRY)
    assert len(rows) == len(document["sources"]) == 720
    assert sum(r.enabled for r in rows) >= 256


def test_the_plan_decisions_hold(document):
    sources = document["sources"]
    ids = {s["id"] for s in sources}
    # the three enrichment endpoints are settings, not sources; egress none / paid / login are not loaded
    assert not ids & {"pubmed-eutils-esummary", "europepmc-doi-abstract-enrich", "unpaywall-oa-status"}
    assert all(s["egress"] != "none" for s in sources)
    assert {s["lane"] for s in sources} <= set(model.LANES) and "news" not in {s["lane"] for s in sources}
    accepted = {json.loads(line)["id"] for line in (ROOT / "registry/research/probe-edge-honest-ua-2026-09-22.jsonl")
                .read_text(encoding="utf-8").splitlines() if line.strip() and json.loads(line)["verdict"] in ("feed-ok", "api-ok", "page-ok")}
    for s in sources:
        if s["enabled"]:
            assert s["egress"] in model.IMPLEMENTED_EGRESSES and s["access"] in model.IMPLEMENTED_ACCESSES
            # batch 2: P0; lists and EviMed scans of P1; relay only what the Tokyo node read on 2026-09-22
            assert (s["launch_tier"] == "P0" or s["egress"] == "relay"
                    or (s["launch_tier"] == "P1" and s["access"] in ("html-list", "browser-list", "evimed-api")))
            if s["egress"] == "relay" and s["id"] not in ("endpoints-news", "endpoints-news-ai"):
                assert s["id"] in accepted
        else:
            assert s["disabled_reason"]
    by_id = {s["id"]: s for s in sources}
    assert by_id["openfda-drug-enforcement-api"]["safety_feed"] is True
    assert by_id["j-0028-4793"]["authority"] == 5
    assert by_id["eyjlr"]["access"] == "wechat-bridge"
    assert "{since" in by_id["openfda-drugsfda-api"]["config"]["url"]
    # the controller's batch-2 decisions (2026-09-22)
    assert by_id["endpoints-news"]["egress"] == by_id["endpoints-news-ai"]["egress"] == "relay"
    for sid in ("pubmed-rss-created-headlessly", "the-decoder"):
        assert by_id[sid]["enabled"] is False and by_id[sid]["disabled_reason"] == "robots_disallow"
    star = by_id["star-guideline-rating-cn"]
    assert star["poll_floor_s"] == 86400 and star["config"]["max_pages"] == 3           # a daily poll reads 3 pages
    assert star["config"]["full_walk_every_s"] == 604800 and star["config"]["full_walk_max_pages"] == 160
    assert by_id["evimed-chictr"]["access"] == by_id["evimed-guides"]["access"] == "evimed-api"
    assert len(by_id["evimed-chictr"]["config"]["terms"]) == 20 and len(by_id["evimed-guides"]["config"]["publisher_groups"]) == 30
    assert by_id["nmpa-label-revision-announcements"]["poll_floor_s"] == 1800 and by_id["cde-guidance-principles"]["poll_floor_s"] == 7200
    assert sum(1 for s in sources if s["enabled"] and s["egress"] == "relay") >= 30
    # round 3: the general NMPA 药品公告通告 column is mixed, so it is not a safety feed (the edit's
    # safety-notice type makes an item an alert); label revisions stay one; 21 pure safety feeds
    other = by_id["nmpa-other-drug-announcements"]
    assert other["safety_feed"] is False and other["enabled"] and other["poll_floor_s"] == 1800
    assert other["lane"] == "mixed"               # a safety lane would pin its 参比制剂目录 notices to 药物安全
    assert by_id["nmpa-label-revision-announcements"]["safety_feed"] is True
    # production, first hour: FDA's recall feed mixes foods and cosmetics with drugs and devices,
    # so it is mixed too; 20 pure safety feeds remain
    recalls = by_id["fda-recalls-safety-alerts"]
    assert recalls["safety_feed"] is False and recalls["lane"] == "mixed"
    assert sum(1 for s in sources if s["safety_feed"]) == 20
    assert by_id["evimed-chictr"]["config"]["url"].endswith("/ai-api/review/api/clinical-trial")   # v1: sponsor present
    for sid in ("natcm-notices", "most-tztg", "nmpa-gd-mirror", "csco-news", "gd-pharm-society-notifications", "cntcm-news",
                "nhsa-policy-regulations", "cdr-adr-notices", "zhongguokexuebao", "chinacdc-notifiable-disease", "china-cdc-news"):
        assert by_id[sid]["enabled"] and by_id[sid]["launch_tier"] == "P1" and by_id[sid]["access"] == "html-list"


@pytest.mark.db
async def test_sync_inserts_every_row_and_retires_missing_ones(pool):
    """Every row goes through the real table and its CHECK constraints (egress, tier, authority,
    cadence bounds, health); then the operator switch and retirement rules hold."""
    from datetime import datetime, timezone
    rows = load_registry(REGISTRY)
    async with pool.connection() as conn:
        counts = await sync_registry(conn, rows, datetime.now(timezone.utc))
        assert counts == {"rows": len(rows), "enabled": sum(r.enabled for r in rows), "retired": 0}
        stored = await (await conn.execute(
            "SELECT count(*) AS n, count(*) FILTER (WHERE enabled) AS enabled, count(*) FILTER (WHERE health = 'disabled') AS off FROM evimed_knowledge.sources"
        )).fetchone()
        assert stored["n"] == len(rows) and stored["enabled"] == counts["enabled"] and stored["off"] == len(rows) - counts["enabled"]
        # an operator's switch survives a reload
        await conn.execute("UPDATE evimed_knowledge.sources SET operator_enabled = false WHERE id = 'j-0028-4793'")
        await sync_registry(conn, rows[:-1], datetime.now(timezone.utc))
        row = await (await conn.execute("SELECT enabled, disabled_reason FROM evimed_knowledge.sources WHERE id = 'j-0028-4793'")).fetchone()
        assert row == {"enabled": False, "disabled_reason": "operator"}
        retired = await (await conn.execute("SELECT id FROM evimed_knowledge.sources WHERE retired_at IS NOT NULL")).fetchall()
        assert [r["id"] for r in retired] == [rows[-1].source.id]


def good_row(document):
    return copy.deepcopy(next(s for s in document["sources"] if s["id"] == "fda-press-announcements"))


@pytest.mark.parametrize("mutate, expected", [
    (lambda r: r.pop("owner_entity"), "missing field owner_entity"),
    (lambda r: r.update(lane="news"), "lane='news' is outside the contract vocabulary"),
    (lambda r: r.update(access="wechat"), "access='wechat' is outside the contract vocabulary"),
    (lambda r: r.update(egress="none"), "egress='none' is outside the contract vocabulary"),
    (lambda r: r.update(authority=7), "authority must be 1-5"),
    (lambda r: r["config"].update(url="https://api.fda.gov/drug/enforcement.json?search=report_date:[20260801+TO+20260930]"), "literal date"),
    (lambda r: r["config"].update(url="https://x.example/{yesterday}"), "unknown template field"),
    (lambda r: r.update(enabled=True, egress="bridge"), "egress bridge that this build does not implement"),
    (lambda r: r.update(enabled=True, egress="direct", access="html-list"), "without a list configuration"),
    (lambda r: r.update(enabled=True, egress="browser", access="browser-list"), "without a list configuration"),
    (lambda r: r.update(poll_floor_s=60), "poll_floor_s"),
    (lambda r: r.update(surprise=1), "unknown field"),
])
def test_the_validator_catches(document, mutate, expected):
    row = good_row(document)
    mutate(row)
    problems = validate_row(row)
    assert any(expected in p for p in problems), problems


def test_duplicate_ids_are_refused(document):
    row = good_row(document)
    with pytest.raises(RegistryError) as refused:
        parse_registry({"sources": [row, copy.deepcopy(row)]})
    assert any("duplicate id" in p for p in refused.value.problems)


def test_enabled_rows_pass_the_adapters_own_checks():
    adapters = pytest.importorskip("knowledge_plugin.adapters")
    validate_config = getattr(adapters, "validate_config", None)
    if validate_config is None:
        pytest.skip("this build's adapters expose no validate_config")
    problems = [f"{r.source.id}: {p}" for r in load_registry(REGISTRY) if r.enabled for p in validate_config(r.source)]
    assert problems == []


def test_vocabularies_equal_the_contract():
    spec = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))
    schemas = spec["components"]["schemas"]
    assert tuple(schemas["Lane"]["enum"]) == model.LANES
    assert tuple(schemas["SourceType"]["enum"]) == model.SOURCE_TYPES
    assert tuple(schemas["Egress"]["enum"]) == model.EGRESSES
    assert tuple(schemas["Access"]["enum"]) == model.ACCESSES
    assert tuple(schemas["LaunchTier"]["enum"]) == model.LAUNCH_TIERS
    assert tuple(schemas["Health_State"]["enum"]) == model.HEALTH_STATES
    assert tuple(schemas["DatePrecision"]["enum"]) == model.DATE_PRECISIONS
    assert tuple(schemas["Entry"]["properties"]["defects"]["items"]["enum"]) == model.DEFECTS
    assert tuple(schemas["Error"]["properties"]["code"]["enum"]) == model.ERROR_CODES
    assert set(schemas["Entry"]["properties"]["facts"]["properties"]) == set(model.FACT_TYPES)
    assert set(schemas["EntryText"]["properties"]["enrichment"]["properties"]) == set(model.ENRICHMENT_TYPES)
    assert tuple(schemas["EntryText"]["properties"]["fetched_from"]["enum"]) == model.FETCHED_FROM
    assert spec["info"]["version"] == model.CONTRACT_VERSION


def test_the_vendored_contract_matches_the_plan_copy():
    if not DOCS_CONTRACT.exists():
        pytest.skip("outside the monorepo: the vendored contract is the only copy")
    assert CONTRACT.read_bytes() == DOCS_CONTRACT.read_bytes()


def test_the_schema_starts_with_the_normative_draft():
    draft = ROOT.parent.parent / "docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/tools/knowledge-plugin-schema.sql"
    if not draft.exists():
        pytest.skip("outside the monorepo")
    from knowledge_plugin.db import schema_sql
    assert schema_sql().startswith(draft.read_text(encoding="utf-8"))
