#!/usr/bin/env python3
"""Build ``registry/social-sources.json`` from the social research files (deterministic; ``--check`` verifies).

Inputs, all under ``registry/research/`` and all dated (each kind from the file of its date, ``*_DATE`` below):

- ``x-accounts-candidates-<date>.json`` + ``x-accounts-verified-<date>.json``: the X accounts. A row for each candidate the
  verification kept, with the handle as SocialData spells it and the account's id (posts are matched by either).
- ``wechat-accounts-<date>.json``: the WeChat accounts, re-resolved at run time — from a verified article link when the
  research file has one that can name the account (a ``__biz`` or short ``/s/`` link; a Sogou temporary link is never
  kept), else by the account's nickname (ct-src 2026-10-24, ``knowledge_plugin.social.wechat``), checked against its
  ``biz`` when the research file knows it.
- ``social-watch-list-<date>.json``: the six-platform monitor's terms.

The six platform rows are written here. Every row is a plain registry row (``registry.validate_row`` checks it) of a
social read method. ``config`` holds only what does not change from one verification to the next: a change of a row's
config is a changed source, whose cursor (the X watermark, the WeChat resolution) starts again.

    python tools/build_social_registry.py [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.registry import validate_row  # noqa: E402
from knowledge_plugin.social.wechat import temporary_link  # noqa: E402

RESEARCH = ROOT / "registry" / "research"
X_DATE = "2026-10-22"
WECHAT_DATE = "2026-10-24"
WATCH_DATE = "2026-10-22"
WECHAT_GROUPS = ("industry", "clinical", "society-journal", "hospital", "regulator", "research-media")
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


def wechat_url(account: dict) -> str:
    """What a WeChat row names as its address (never fetched — the account is read through Dajiala): its verified
    article, else its profile page by ``__biz``, else the public account search for its name."""
    if account.get("verified_url"):
        return account["verified_url"]
    if account.get("biz"):
        return "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=" + quote(account["biz"], safe="=")
    return "https://weixin.sogou.com/weixin?type=1&query=" + quote(account["expected_names"][0], safe="")


def wechat_rows(date: str) -> list[dict]:
    rows = []
    for account in json.loads((RESEARCH / f"wechat-accounts-{date}.json").read_text())["accounts"]:
        if account.get("verified_url") and temporary_link(account["verified_url"]):
            raise SystemExit(f"{account['id']}: a Sogou temporary link names no account; leave verified_url empty")
        if account.get("group") not in WECHAT_GROUPS:
            raise SystemExit(f"{account['id']}: group must be one of {WECHAT_GROUPS}")
        url = wechat_url(account)
        polls = 2 if account["priority"] == 1 else 1
        config = {"url": url, "expected_names": account["expected_names"], "priority": account["priority"],
                  "polls_per_day": polls, "role": "organisation", "allowed_hosts": ["mp.weixin.qq.com"]}
        if account.get("verified_url"):
            config["verified_url"] = account["verified_url"]
        if account.get("biz"):
            config["biz"] = account["biz"]
        rows.append({
            "id": account["id"], "name": account["name"], "homepage": url, "lane": "mixed",
            "source_type": account["source_type"], "access": "dajiala", "egress": "api", "authority": account["authority"],
            "safety_feed": False, "owner_entity": account["owner_entity"], "launch_tier": "P1", "language": "zh", "region": "CN",
            "poll_floor_s": 43200 if polls == 2 else 86400, "poll_ceiling_s": 86400, "enabled": True,
            "category": f"wechat-{account['category']}", "config": config,
        })
    return sorted(rows, key=lambda r: r["id"])


def platform_rows() -> list[dict]:
    return [{"id": f"social-{platform}", "name": f"{label}（社媒监测）", "homepage": home, "lane": "mixed", "source_type": "media",
             "access": "social-crawl", "egress": "api", "authority": 1, "safety_feed": False,
             "owner_entity": f"{label}用户", "launch_tier": "P2", "language": "zh", "region": "CN", "poll_floor_s": 3600,
             "poll_ceiling_s": 86400, "enabled": True, "category": "social-monitor",
             "config": {"url": home, "crawl_platform": crawl, "platform": platform}} for platform, crawl, label, home in PLATFORMS]


def build() -> str:
    rows = x_rows(X_DATE) + wechat_rows(WECHAT_DATE) + platform_rows()
    problems = [problem for row in rows for problem in validate_row(row)]
    if problems:
        raise SystemExit("invalid rows: " + "; ".join(problems[:10]))
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ids")
    names = [row["config"]["expected_names"][0] for row in rows if row["access"] == "dajiala"]
    if len(names) != len(set(names)):
        raise SystemExit("two WeChat rows ask for the same nickname")
    watch = json.loads((RESEARCH / f"social-watch-list-{WATCH_DATE}.json").read_text())["watch_list"]
    accounts = json.loads((RESEARCH / f"wechat-accounts-{WECHAT_DATE}.json").read_text())["accounts"]
    document = {
        "_doc": "Generated by tools/build_social_registry.py from the dated files in registry/research/; do not edit by hand. The social sources of contract 1.5.0 (X through SocialData, WeChat through Dajiala, six platforms through the GEO crawler), composed with registry/sources.json by dynamic_registry and read by knowledge_plugin.social.",
        "generated_from": {"x": X_DATE, "wechat": WECHAT_DATE, "watch_list": WATCH_DATE},
        "counts": {"x": sum(r["access"] == "socialdata" for r in rows), "wechat": sum(r["access"] == "dajiala" for r in rows),
                   "social": sum(r["access"] == "social-crawl" for r in rows), "watch_list": len(watch),
                   "wechat_by_group": {group: sum(a["group"] == group for a in accounts) for group in WECHAT_GROUPS},
                   "wechat_by_priority": {str(tier): sum(a["priority"] == tier for a in accounts) for tier in (1, 2, 3, 4)}},
        "sources": rows,
        "watch_list": watch,
    }
    return json.dumps(document, ensure_ascii=False, indent=1) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = build()
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
