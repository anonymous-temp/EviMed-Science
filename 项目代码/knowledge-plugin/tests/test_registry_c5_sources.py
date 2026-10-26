"""The c5-sources batch (2026-10-26): 73 verified rows switched on, one dead channel retired, two walled newsrooms kept off with
their reason. The rows are in ``registry/extra-sources.json``, each switched on by an ``overrides.json`` ``enabled`` that says why,
and each recorded in ``registry/research/source-expansion-2026-10-26.json`` (what was read, once under a browser identity and
once under the honest one, from a development box outside mainland China)."""

from __future__ import annotations

import json
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import pytest

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry"
WHY = "_why_enabled_20261026"
AT = date(2026, 10, 26)


def read(name):
    return json.loads((REGISTRY / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rows():
    return {row["id"]: row for row in read("sources.json")["sources"]}


@pytest.fixture(scope="module")
def record():
    return read("research/source-expansion-2026-10-26.json")


@pytest.fixture(scope="module")
def batch(record):
    return [row["id"] for row in record["rows"]]


def test_the_record_names_the_batch_by_group(record, batch):
    scope = record["scope"]
    assert len(batch) == len(set(batch)) == scope["rows"] == 73
    assert Counter(row["group"] for row in record["rows"]) == {
        "cn-provincial-regulator": scope["provincialRegulators"], "eu-regulator": scope["euRegulators"],
        "university": scope["universities"], "deals-media": scope["dealsMedia"]}
    assert (scope["provincialRegulators"], scope["euRegulators"], scope["universities"], scope["dealsMedia"]) == (21, 18, 23, 11)


def test_every_row_of_the_batch_is_on_with_its_reason_and_was_read_by_the_rule_it_was_admitted_under(rows, record, batch):
    overrides = read("overrides.json")
    for entry in record["rows"]:
        sid = entry["id"]
        row = rows[sid]
        assert row["enabled"] is True and row["disabled_reason"] is None, sid
        assert overrides[sid]["enabled"] is True and "robots.txt allows it" in overrides[sid][WHY], sid
        assert row["launch_tier"] == "P2" and row["egress"] == "direct" and row["access"] in ("html-list", "rss"), sid
        assert urlsplit(row["config"]["url"]).hostname in row["config"]["allowed_hosts"], sid
        # the rule of the research: >= 5 items, >= 90 % dated, the newest within 30 days, robots.txt allows it, honest identity reads it
        assert entry["entries"] >= 5 and entry["dated"] >= 0.9 * entry["entries"], sid
        assert AT - date.fromisoformat(entry["newest"]) <= timedelta(days=30), sid
        assert entry["robotsAllowed"] is True and entry["honestIdentityRead"] is True, sid


def test_a_row_the_research_held_back_is_not_in_the_registry(rows, record):
    held = {row["id"] for row in record["heldBack"]}
    assert len(held) == 32 and not held & set(rows)


def test_only_a_safety_list_of_an_official_agency_is_a_safety_feed_and_the_trim_is_the_one_cadence(rows, batch):
    safety = sorted(sid for sid in batch if rows[sid]["safety_feed"])
    assert safety == ["cz-sukl-stahovani-pozastaveni", "de-pei-sicherheitsinformationen", "fr-ansm-informations-securite",
                      "pl-urpl-komunikaty-produkty-lecznicze"]
    assert all(rows[sid]["lane"] == "safety" and rows[sid]["source_type"] == "regulator" for sid in safety)
    # a slow section with an ~880 KB feed is read four times a day, not twelve; no other row of the batch was given a cadence of its own
    slow = rows["uni-harvard-gazette-health"]
    assert (slow["poll_floor_s"], slow["poll_ceiling_s"]) == (21600, 86400)
    assert read("overrides.json")["uni-harvard-gazette-health"]["_why_cadence_20261026"]
    assert {rows[sid]["poll_floor_s"] for sid in batch if sid != "uni-harvard-gazette-health"} == {3600, 7200}


def test_the_dead_channel_is_retired_and_the_walled_newsrooms_stay_off_with_the_reason(rows):
    # 36氪's medical channel answers 404: the probe row is not loaded (egress none), the plugin retires a row missing from the file
    assert "36kr-medical" not in rows
    probe = {row["id"]: row for row in read("probe-sources.json")}
    assert probe["36kr-medical"]["egress"] == "none" and "404" in probe["36kr-medical"]["note"]
    for sid in ("hopkins-medicine-newsroom", "mayo-clinic-news"):
        assert rows[sid]["enabled"] is False and rows[sid]["disabled_reason"] == "probe_cloudflare", sid
        assert "403" in read("overrides.json")[sid]["_why"]


def test_清华大学医学院_is_in_the_batch_because_its_date_can_now_be_read(rows):
    row = rows["uni-tsinghua-med-research"]
    assert row["enabled"] and row["config"]["selectors"]["date"] == "div.con span" and "date_format" not in row["config"]
