#!/usr/bin/env python3
"""Build ``registry/social-sources.json`` from the social research files (deterministic; ``--check`` verifies).

Inputs, all under ``registry/research/`` and all dated:

- ``x-accounts-candidates-<date>.json`` + ``x-accounts-verified-<date>.json``: the X accounts. A row for each candidate the
  verification kept, with the handle as SocialData spells it and the account's id (posts are matched by either).
- ``wechat-accounts-<date>.json``: the WeChat accounts with a verified article link, re-resolved at run time.
- ``social-watch-list-<date>.json``: the six-platform monitor's terms.

The six platform rows are written here. Every row is a plain registry row (``registry.validate_row`` checks it) of a
social read method. ``config`` holds only what does not change from one verification to the next: a change of a row's
config is a changed source, whose cursor (the X watermark, the WeChat resolution) starts again.

    python tools/build_social_registry.py [--date 2026-10-22] [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.registry import validate_row  # noqa: E402

RESEARCH = ROOT / "registry" / "research"
OUT = ROOT / "registry" / "social-sources.json"
PLATFORMS = [
    ("xiaohongshu", "xhs", "小红书", "https://www.xiaohongshu.com/"),
    ("douyin", "douyin", "抖音", "https://www.douyin.com/"),
    ("zhihu", "zhihu", "知乎", "https://www.zhihu.com/"),
    ("weibo", "weibo", "微博", "https://weibo.com/"),
    ("bilibili", "bilibili", "哔哩哔哩", "https://www.bilibili.com/"),
    ("channels", "wechat_channels", "微信视频号", "https://channels.weixin.qq.com/"),
]


def x_rows(date: str) -> list[dict]:
    candidates = {c["handle"].lower(): c for c in json.loads((RESEARCH / f"x-accounts-candidates-{date}.json").read_text())["candidates"]}
    verified = json.loads((RESEARCH / f"x-accounts-verified-{date}.json").read_text())["results"]
    rows = []
    for result in verified:
        if result["decision"] != "kept":
            continue
        candidate = candidates[result["handle"].lower()]
        handle = result.get("screen_name") or candidate["handle"]
        editorial = candidate["mode"] == "editorial"
        config = {"url": f"https://x.com/{handle}", "handle": handle, "user_id": result["user_id"], "mode": candidate["mode"],
                  "role": candidate["role"]}
        if candidate.get("why"):
            config["why"] = candidate["why"]
        row = {"id": f"x-{handle.lower()}", "name": f"{candidate['name']}（X @{handle}）", "homepage": f"https://x.com/{handle}",
               "lane": "mixed", "source_type": candidate["source_type"], "access": "socialdata", "egress": "api",
               "authority": candidate["authority"], "safety_feed": False, "owner_entity": candidate["owner_entity"],
               "launch_tier": "P1", "language": candidate.get("language", "en"), "region": candidate.get("region"),
               "poll_floor_s": 1800 if editorial else 3600, "poll_ceiling_s": 3600 if editorial else 7200, "enabled": True,
               "category": f"x-{candidate['category']}", "config": config}
        rows.append({k: v for k, v in row.items() if v is not None})
    return sorted(rows, key=lambda r: r["id"])


def wechat_rows(date: str) -> list[dict]:
    rows = []
    for account in json.loads((RESEARCH / f"wechat-accounts-{date}.json").read_text())["accounts"]:
        rows.append({
            "id": account["id"], "name": account["name"], "homepage": account["verified_url"], "lane": "mixed",
            "source_type": account["source_type"], "access": "dajiala", "egress": "api", "authority": account["authority"],
            "safety_feed": False, "owner_entity": account["owner_entity"], "launch_tier": "P1", "language": "zh", "region": "CN",
            "poll_floor_s": 43200 if account["polls_per_day"] == 2 else 86400, "poll_ceiling_s": 86400, "enabled": True,
            "category": f"wechat-{account['category']}",
            "config": {"url": account["verified_url"], "verified_url": account["verified_url"],
                       "expected_names": account["expected_names"], "priority": account["priority"],
                       "polls_per_day": account["polls_per_day"], "role": "organisation",
                       "allowed_hosts": ["mp.weixin.qq.com"]},
        })
    return sorted(rows, key=lambda r: r["id"])


def platform_rows() -> list[dict]:
    return [{"id": f"social-{platform}", "name": f"{label}（社媒监测）", "homepage": home, "lane": "mixed", "source_type": "media",
             "access": "social-crawl", "egress": "api", "authority": 1, "safety_feed": False,
             "owner_entity": f"{label}用户", "launch_tier": "P2", "language": "zh", "region": "CN", "poll_floor_s": 3600,
             "poll_ceiling_s": 86400, "enabled": True, "category": "social-monitor",
             "config": {"url": home, "crawl_platform": crawl, "platform": platform}} for platform, crawl, label, home in PLATFORMS]


def build(date: str) -> str:
    rows = x_rows(date) + wechat_rows(date) + platform_rows()
    problems = [problem for row in rows for problem in validate_row(row)]
    if problems:
        raise SystemExit("invalid rows: " + "; ".join(problems[:10]))
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ids")
    watch = json.loads((RESEARCH / f"social-watch-list-{date}.json").read_text())["watch_list"]
    document = {
        "_doc": f"Generated by tools/build_social_registry.py from registry/research/*-{date}.json; do not edit by hand. The social sources of contract 1.5.0 (X through SocialData, WeChat through Dajiala, six platforms through the GEO crawler), composed with registry/sources.json by dynamic_registry and read by knowledge_plugin.social.",
        "generated_from": date,
        "counts": {"x": sum(r["access"] == "socialdata" for r in rows), "wechat": sum(r["access"] == "dajiala" for r in rows),
                   "social": sum(r["access"] == "social-crawl" for r in rows), "watch_list": len(watch)},
        "sources": rows,
        "watch_list": watch,
    }
    return json.dumps(document, ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default="2026-10-22")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = build(args.date)
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("registry/social-sources.json is not what the research files build; run tools/build_social_registry.py")
            return 1
        print("registry/social-sources.json is up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    counts = json.loads(text)["counts"]
    print(f"wrote registry/social-sources.json: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
