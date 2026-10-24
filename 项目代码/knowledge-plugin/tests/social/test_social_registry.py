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
