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
from knowledge_plugin.registry import FEED_URL_UNSET, RegistryError, load_registry, parse_registry, resolve_env_url, row_sha256, sync_registry, validate_row

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
    rows = load_registry(REGISTRY, {})
    assert len(rows) == len(document["sources"]) == 722
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
    # read on production on the evening of 2026-09-22 after their first polls failed: the two Google
    # blogs through the Tokyo node, MIT News's AI feed through the browser
    verified_on_production = {"google-deepmind-blog", "google-keyword-ai", "mit-news-ai"}
    # read from the Tokyo node on 2026-09-28 after Beijing's polls kept timing out (research/probe-2026-09-28.jsonl)
    verified_on_production |= {json.loads(line)["id"] for line in (ROOT / "registry/research/probe-2026-09-28.jsonl")
                               .read_text(encoding="utf-8").splitlines()
                               if line.strip() and json.loads(line)["verdict"] == "feed-ok"}
    verified_on_production |= {row["id"] for row in json.loads((ROOT / "registry/research/source-expansion-2026-09-29.json").read_text())["rows"] if row.get("enabledAfterProbe") or (row["group"] == "p1" and row["outcome"] == "ok")}
    verified_on_production |= {row["id"] for row in json.loads((ROOT / "registry/research/source-expansion-2026-09-30.json").read_text())["rows"] if row["decision"] == "enabled"}
    assert "google-health-blog" in verified_on_production
    for s in sources:
        if s["enabled"]:
            assert s["egress"] in model.IMPLEMENTED_EGRESSES and s["access"] in model.IMPLEMENTED_ACCESSES
            # batch 2: P0; lists and EviMed scans of P1; relay only what the Tokyo node read on 2026-09-22
            assert (s["launch_tier"] == "P0" or s["egress"] == "relay" or s["id"] in verified_on_production
                    or (s["launch_tier"] == "P1" and s["access"] in ("html-list", "browser-list", "evimed-api")))
            if s["egress"] == "relay":
                assert s["id"] in accepted or s["id"] in verified_on_production
        else:
            assert s["disabled_reason"]
    by_id = {s["id"]: s for s in sources}
    assert by_id["openfda-drug-enforcement-api"]["safety_feed"] is True
    assert by_id["j-0028-4793"]["authority"] == 5
    assert by_id["eyjlr"]["access"] == "wechat-bridge"
    assert "{since" in by_id["openfda-drugsfda-api"]["config"]["url"]
    # the controller's batch-2 decisions (2026-09-22)
    for sid in ("pubmed-rss-created-headlessly", "the-decoder", "aga-clinical-guidance", "health-affairs-journal"):
        assert by_id[sid]["enabled"] is False and by_id[sid]["disabled_reason"] == "robots_disallow"
    # production, first evening: sources that answer a browser and refuse the crawler's HTTP client —
    # ClinicalTrials.gov's API (a Google load balancer's bot rule), Endpoints (refused through Tokyo
    # too), Fastly's client challenge on CIDRAP and MIT News, PubMed's trending page
    browser_read = ("ctgov-phase3-new-registrations", "ctgov-results-first-posted", "ctgov-china-interventional",
                    "ctgov-tcm-interventions", "ctgov-stopped-phase3", "endpoints-news", "endpoints-news-ai",
                    "cidrap-news", "mit-news-ai", "pubmed-trending-page")
    for sid in browser_read:
        assert by_id[sid]["egress"] == "browser" and by_id[sid]["enabled"], sid
    for sid in ("google-deepmind-blog", "google-keyword-ai", "google-health-blog"):
        assert by_id[sid]["egress"] == "relay" and by_id[sid]["enabled"], sid
    # 2026-09-28: walls no exit of this build passes, each with its measurement in research/probe-2026-09-28.jsonl
    research = {json.loads(line)["id"]: json.loads(line) for line in (ROOT / "registry/research/probe-2026-09-28.jsonl")
                .read_text(encoding="utf-8").splitlines() if line.strip()}
    for sid, reason in (("fierce-biotech", "challenge_cloudflare"), ("fierce-pharma", "challenge_cloudflare"),
                        ("cde-breakthrough-therapy", "waf_refuses_crawler_identity")):
        assert by_id[sid]["enabled"] is False and by_id[sid]["disabled_reason"] == "owner_excluded", sid
        assert research[sid]["verdict"] == "blocked", sid
    assert not by_id["fierce-healthcare"]["enabled"] and by_id["fierce-healthcare"]["disabled_reason"] == "owner_excluded"
    star = by_id["star-guideline-rating-cn"]
    assert star["poll_floor_s"] == 86400 and star["config"]["max_pages"] == 3           # a daily poll reads 3 pages
    assert star["config"]["full_walk_every_s"] == 604800 and star["config"]["full_walk_max_pages"] == 160
    assert by_id["evimed-chictr"]["access"] == by_id["evimed-guides"]["access"] == "evimed-api"
    assert len(by_id["evimed-chictr"]["config"]["terms"]) == 20 and len(by_id["evimed-guides"]["config"]["publisher_groups"]) == 30
    assert by_id["nmpa-label-revision-announcements"]["poll_floor_s"] == 1800 and by_id["cde-guidance-principles"]["poll_floor_s"] == 7200
    # 30 on 2026-09-22; 2026-09-28: the two Fierce feeds off behind Cloudflare, google-health-blog on
    assert sum(1 for s in sources if s["enabled"] and s["egress"] == "relay") >= 28
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


FEED = "https://www.evimed.test/evidence/feed.json"


def test_the_platforms_own_feed_is_one_ordinary_source_that_waits_for_its_address(document):
    by_id = {s["id"]: s for s in document["sources"]}
    row = by_id["evimed-evidence"]
    # In the file it names the variable and is marked the platform's own; every other row says nothing of either.
    assert row["platform_produced"] is True and row["config"]["url_env"] == "EVIMED_EVIDENCE_FEED_URL" and "url" not in row["config"]
    assert row["access"] == "json-api" and row["config"]["family"] == "evimed-evidence"
    assert [s["id"] for s in document["sources"] if "platform_produced" in s] == ["evimed-evidence"], "no row carries the label but its own"
    assert row["authority"] == 3, "no boost: the middle of the scale, like a source nobody vouched for"
    assert validate_row(row) == []

    def loaded(environ):
        (found,) = [r for r in load_registry(REGISTRY, environ) if r.source.id == "evimed-evidence"]
        return found

    # No address: loaded, disabled by name, nothing to poll.
    for environ in ({}, {"EVIMED_EVIDENCE_FEED_URL": ""}, {"EVIMED_EVIDENCE_FEED_URL": "  "}, {"EVIMED_EVIDENCE_FEED_URL": "not a url"},
                    {"EVIMED_EVIDENCE_FEED_URL": "ftp://www.evimed.test/feed.json"}):
        waiting = loaded(environ)
        assert waiting.enabled is False and waiting.disabled_reason == FEED_URL_UNSET, environ
        assert waiting.source.platform_produced is True, "the label is the source's, address or none"
    # An address: enabled, polled at that URL, and only that host.
    reading = loaded({"EVIMED_EVIDENCE_FEED_URL": FEED})
    assert reading.enabled is True and reading.disabled_reason is None
    assert reading.source.config["url"] == FEED and reading.source.config["allowed_hosts"] == ["www.evimed.test"]
    assert reading.source.platform_produced is True
    # A moved address is a changed source: its hash moves, so its cursor starts again.
    moved = loaded({"EVIMED_EVIDENCE_FEED_URL": "https://other.evimed.test/evidence/feed.json"})
    assert moved.sha256 != reading.sha256
    assert loaded({"EVIMED_EVIDENCE_FEED_URL": FEED}).sha256 == reading.sha256
    # A row with no url_env is untouched, so no other source's hash moved.
    plain = good_row(document)
    assert resolve_env_url(plain, {}) is plain
    assert row_sha256(plain) == [r for r in load_registry(REGISTRY, {}) if r.source.id == plain["id"]][0].sha256


def test_the_platform_label_and_the_address_variable_are_validated(document):
    row = copy.deepcopy(next(s for s in document["sources"] if s["id"] == "evimed-evidence"))
    assert validate_row({**row, "platform_produced": "yes"}) and any("wrong type" in p for p in validate_row({**row, "platform_produced": "yes"}))
    bad_name = copy.deepcopy(row)
    bad_name["config"]["url_env"] = "lower case"
    assert any("environment variable" in p for p in validate_row(bad_name))
    unnamed = copy.deepcopy(row)
    del unnamed["config"]["url_env"]
    assert any("enabled without config.url" in p for p in validate_row(unnamed))


@pytest.mark.db
async def test_the_platform_label_and_the_wait_for_an_address_reach_the_table(pool):
    from datetime import datetime, timezone
    now = datetime(2026, 10, 5, tzinfo=timezone.utc)
    async with pool.connection() as conn:
        rows = [r for r in load_registry(REGISTRY, {}) if r.source.id in ("evimed-evidence", "fda-press-announcements")]
        await sync_registry(conn, rows, now)
        stored = {r["id"]: r for r in await (await conn.execute(
            "SELECT id, platform_produced, enabled, disabled_reason, health FROM evimed_knowledge.sources")).fetchall()}
        assert stored["evimed-evidence"] == {"id": "evimed-evidence", "platform_produced": True, "enabled": False,
                                              "disabled_reason": FEED_URL_UNSET, "health": "disabled"}
        assert stored["fda-press-announcements"]["platform_produced"] is False
        # The address arrives (a restart with the variable set): the source is on and its cursor is its own to start.
        rows = [r for r in load_registry(REGISTRY, {"EVIMED_EVIDENCE_FEED_URL": FEED}) if r.source.id == "evimed-evidence"]
        await sync_registry(conn, rows, now)
        reading = await (await conn.execute("SELECT enabled, disabled_reason, host, platform_produced FROM evimed_knowledge.sources WHERE id = 'evimed-evidence'")).fetchone()
        assert reading == {"enabled": True, "disabled_reason": None, "host": "www.evimed.test", "platform_produced": True}


@pytest.mark.db
async def test_sync_inserts_every_row_and_retires_missing_ones(pool):
    """Every row goes through the real table and its CHECK constraints (egress, tier, authority,
    cadence bounds, health); then the operator switch and retirement rules hold."""
    from datetime import datetime, timezone
    rows = load_registry(REGISTRY, {})
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


@pytest.mark.db
async def test_owner_exclusion_overrides_an_older_operator_enable(pool):
    rows = [row for row in load_registry(REGISTRY) if row.source.id == 'fierce-healthcare']
    from datetime import datetime, timezone
    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    async with pool.connection() as conn:
        await sync_registry(conn, rows, now)
        await conn.execute("UPDATE evimed_knowledge.sources SET operator_enabled = true, enabled = true WHERE id = 'fierce-healthcare'")
        await sync_registry(conn, rows, now)
        record = await (await conn.execute("SELECT enabled, disabled_reason, health, operator_enabled FROM evimed_knowledge.sources WHERE id = 'fierce-healthcare'")).fetchone()
        assert record == {'enabled': False, 'disabled_reason': 'owner_excluded', 'health': 'disabled', 'operator_enabled': True}
