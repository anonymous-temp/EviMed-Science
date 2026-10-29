"""The social registry file (contract 1.5.0): built from the research files, valid, composed with the rest."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from knowledge_plugin.dynamic_registry import sync_dynamic_registry
from knowledge_plugin.model import SOCIAL_ACCESSES
from knowledge_plugin.registry import RegistryError, parse_registry
from knowledge_plugin.social.crawl import load_watch_list
from knowledge_plugin.social.registry import load_social_registry, social_registry_path
from knowledge_plugin.social.wechat import ask_name, temporary_link

ROOT = Path(__file__).resolve().parents[2]
SOCIAL = ROOT / "registry" / "social-sources.json"
NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)


def row_dict(row) -> dict:
    return {"name": row.source.name, "config": row.source.config}


def test_the_committed_file_is_what_the_research_files_build():
    result = subprocess.run([sys.executable, str(ROOT / "tools" / "build_social_registry.py"), "--check"],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_row_is_a_valid_social_row_and_the_lists_are_within_their_bounds():
    rows = load_social_registry(SOCIAL)
    by_access = {access: [row for row in rows if row.source.access == access] for access in SOCIAL_ACCESSES}
    assert 150 <= len(by_access["socialdata"]) <= 200, "the X seed list is 150-200 verified accounts"
    assert len(by_access["social-crawl"]) == 6
    people = [row for row in by_access["socialdata"] if row.source.config["role"] == "person"]
    assert len(people) <= 40 and all(row.source.config.get("why") for row in people), "each person carries the reason"
    for row in by_access["socialdata"]:
        assert row.source.lane == "mixed" and row.source.config["user_id"].isdigit()
        assert row.source.config["mode"] in ("editorial", "signal") and row.source.id == "x-" + row.source.config["handle"].lower()
    for row in by_access["dajiala"]:
        config = row.source.config
        if "verified_url" in config:
            assert config["verified_url"].startswith("https://mp.weixin.qq.com/s")
            assert not temporary_link(config["verified_url"]), "a Sogou temporary link names no account (ct-src)"
        else:
            assert ask_name(row_dict(row)) == config["expected_names"][0], "without a link the account is asked by name"
        assert config["expected_names"] and config["priority"] in (1, 2, 3, 4)
        assert config["polls_per_day"] == (2 if config["priority"] == 1 else 1)
        assert re.fullmatch(r"M[A-Za-z0-9+/]{6,30}={0,2}", config.get("biz", "MzA5MjE3MzUxNA==")), "a biz is base64"
        assert "gh_" not in json.dumps(config), "a saved original id is never trusted"
    assert len({row.source.config["expected_names"][0] for row in by_access["dajiala"]}) == len(by_access["dajiala"])
    assert len(load_watch_list(str(SOCIAL))) >= 35


def test_a_social_file_holds_social_read_methods_only(tmp_path):
    path = tmp_path / "social-sources.json"
    path.write_text(json.dumps({"sources": [{"id": "feed", "name": "A feed", "lane": "evidence", "source_type": "journal",
                                             "access": "rss", "egress": "direct", "authority": 3, "safety_feed": False,
                                             "owner_entity": "X", "launch_tier": "P0", "poll_floor_s": 3600,
                                             "poll_ceiling_s": 7200, "enabled": True,
                                             "config": {"url": "https://example.org/feed"}}]}))
    with pytest.raises(RegistryError):
        load_social_registry(path)
    assert load_social_registry(tmp_path / "missing.json") == []


def test_the_default_path_sits_beside_the_main_registry():
    assert social_registry_path({"KNOWLEDGE_PLUGIN_REGISTRY": "/opt/kp/registry/sources.json"}) == Path("/opt/kp/registry/social-sources.json")
    assert social_registry_path({"KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY": "/x/s.json"}) == Path("/x/s.json")


@pytest.mark.db
async def test_the_composition_adds_the_social_rows_and_retires_none_of_the_rest(pool, monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY", str(SOCIAL))
    base = parse_registry({"sources": [{"id": "feed", "name": "A feed", "lane": "evidence", "source_type": "journal",
                                        "access": "rss", "egress": "direct", "authority": 3, "safety_feed": False,
                                        "owner_entity": "X", "launch_tier": "P0", "poll_floor_s": 3600, "poll_ceiling_s": 7200,
                                        "enabled": True, "config": {"url": "https://example.org/feed"}}]})
    async with pool.connection() as conn:
        counts = await sync_dynamic_registry(conn, base, NOW)
        social = len(load_social_registry(SOCIAL))
        assert counts["rows"] == 1 + social and counts["retired"] == 0
        accesses = await (await conn.execute(
            "SELECT access, count(*) AS n FROM evimed_knowledge.sources WHERE retired_at IS NULL GROUP BY access")).fetchall()
    assert {row["access"]: row["n"] for row in accesses}["rss"] == 1


def builder():
    import importlib.util

    spec = importlib.util.spec_from_file_location("build_social_registry", ROOT / "tools" / "build_social_registry.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_builder_names_a_wechat_row_by_its_article_its_biz_or_its_name_and_refuses_a_temporary_link(tmp_path, monkeypatch):
    build = builder()
    assert build.wechat_url({"verified_url": "https://mp.weixin.qq.com/s/abc", "biz": "MzA5", "expected_names": ["甲"]}) \
        == "https://mp.weixin.qq.com/s/abc"
    assert build.wechat_url({"biz": "MzA5MjE3MzUxNA==", "expected_names": ["甲"]}) \
        == "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzA5MjE3MzUxNA=="
    assert build.wechat_url({"expected_names": ["医学界"]}) == "https://weixin.sogou.com/weixin?type=1&query=%E5%8C%BB%E5%AD%A6%E7%95%8C"
    account = {"id": "wx-a", "name": "甲", "expected_names": ["甲"], "group": "clinical", "category": "clinical",
               "source_type": "media", "authority": 3, "owner_entity": "甲", "priority": 1}
    research = tmp_path / "research"
    research.mkdir()
    monkeypatch.setattr(build, "RESEARCH", research)
    (research / "wechat-accounts-2099-01-01.json").write_text(json.dumps({"accounts": [account]}))
    (row,) = build.wechat_rows("2099-01-01")
    assert row["config"]["polls_per_day"] == 2 and row["poll_floor_s"] == 43200, "tier 1 is read twice a day"
    assert "verified_url" not in row["config"] and "biz" not in row["config"]
    temporary = {**account, "verified_url": "https://mp.weixin.qq.com/s?src=11&timestamp=1&ver=1&signature=x"}
    (research / "wechat-accounts-2099-01-01.json").write_text(json.dumps({"accounts": [temporary]}))
    with pytest.raises(SystemExit, match="temporary link"):
        build.wechat_rows("2099-01-01")
    (research / "wechat-accounts-2099-01-01.json").write_text(json.dumps({"accounts": [{**account, "group": "misc"}]}))
    with pytest.raises(SystemExit, match="group"):
        build.wechat_rows("2099-01-01")


def test_the_wechat_list_has_its_categories_and_tiers():
    """S3 (ct-src 2026-10-24): 150–200 accounts, by group, regulators and societies first."""
    document = json.loads(SOCIAL.read_text())
    counts = document["counts"]
    assert 150 <= counts["wechat"] <= 200
    groups = counts["wechat_by_group"]
    assert groups["industry"] >= 30 and groups["clinical"] >= 40 and groups["society-journal"] >= 25
    assert groups["hospital"] >= 10 and groups["regulator"] >= 10
    assert sum(counts["wechat_by_priority"].values()) == counts["wechat"]


def test_the_names_the_2026_10_25_review_could_not_read_are_the_nicknames_dajiala_answers_to():
    """c2-fixes F5 (¥1.98 of live checks, ``live_checks`` of the research file): six accounts were renamed, one answers by its own
    name and carries its biz, four are out of the list. The names Dajiala answered code 107 to are asked for no more."""
    rows = {row.source.id: row.source for row in load_social_registry(SOCIAL)}
    renamed = {"wx-cellpress": ("CellPress全科学", "MzU5MDcwNzg0MA=="), "wx-dxy-nephro": ("丁香园肾脏时间", "MzA3MjY5NzAxNA=="),
               "wx-yxj-psych": ("医学界精神心理频道", "MzIyNjk1MjAwNQ=="), "wx-yaorongyun": ("摩熵医药", "MzkxMTM1MDMyMA=="),
               "wx-liangyihui-hema": ("良医汇血液肿瘤资讯", "MzU4NjkzMDg4Mw=="), "wx-biopharma-xb": ("佰傲谷BioValley", "MzYzNjUxMjYzMw==")}
    for source_id, (name, biz) in renamed.items():
        source = rows[source_id]
        assert (source.name, ask_name({"name": source.name, "config": source.config}), source.config["biz"]) == (name, name, biz), source_id
    assert rows["wx-cjem"].config["biz"] == "MzA4ODYzMzg0Mg==" and rows["wx-cjem"].name == "中华内分泌代谢杂志"
    for gone in ("wx-nature-portfolio", "wx-yxj-lab", "wx-healthai", "wx-yigu"):
        assert gone not in rows, gone
    asked = {ask_name({"name": source.name, "config": source.config}) for source in rows.values() if source.access == "dajiala"}
    for code_107 in ("CellPress细胞科学", "丁香园肾内时间", "医学界精神病学频道", "药融云", "血液肿瘤资讯", "生物制药小编", "Nature Portfolio",
                     "医学界检验频道", "医健AI掘金志", "肿瘤资讯"):
        assert code_107 not in asked, code_107
    research = json.loads((ROOT / "registry" / "research" / "wechat-accounts-2026-10-24.json").read_text(encoding="utf-8"))
    assert {entry["id"] for entry in research["not_listed_2026_10_25"]} == {"wx-nature-portfolio", "wx-yxj-lab", "wx-healthai", "wx-yigu"}
    assert all(entry["reason"] for entry in research["not_listed_2026_10_25"])
