#!/usr/bin/env python3
"""Join the registry with the two probe runs, decide how each source is read from production (egress) and which
launch tier it lands in, then write the enriched registry, a CSV, the Markdown appendix and the counts the
document quotes.  Usage: classify_registry.py"""
import collections, csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, "..")
OK = {"feed-ok", "api-ok", "page-ok"}
STRUCTURED = {"feed-ok", "api-ok"}
JS_WALLS = {"ruishu", "aliyun-waf", "volc-waf"}

GROUPS = [  # (group id, Chinese name, research categories in display order)
    ("evidence", "一、临床证据：期刊、文献流与预印本", ["journal-general", "journal-specialty", "journal-tcm", "journal-cn", "literature-stream", "preprint"]),
    ("guideline", "二、指南共识：循证机构与学会", ["evidence", "guideline"]),
    ("regulatory", "三、审批监管：监管机构、医保与卫生技术评估", ["regulator", "hta-access"]),
    ("safety", "四、药物安全：安全通告、药物警戒与药学期刊", ["drug-safety", "journal-pharmacy"]),
    ("pipeline", "五、研发产业：产业媒体、药企与试验注册", ["industry-media", "cn-media-pharma", "company", "trial-registry"]),
    ("public-health", "六、公共卫生", ["public-health"]),
    ("research", "七、科研与基金：方法学、科研诚信、基金与科学媒体", ["methods", "journal-methods", "funding-policy", "scholarly-signal", "cn-media-science"]),
    ("ai", "八、AI 与医学", ["journal-ai-med", "ai-medicine", "ai-vendor", "ai-media", "ai-research-tools", "ai-benchmark"]),
    ("news", "九、综合医学新闻（条目按内容分到上面八栏）", ["med-news-en", "cn-media-clinical", "cn-wechat"]),
    ("conference", "十、学术会议（日历与会期新闻）", ["conference"]),
]
CATEGORY_NAME = {
    "journal-general": "综合与基础顶刊", "journal-specialty": "专科顶刊", "journal-tcm": "中医药期刊（英文）", "journal-cn": "中文期刊",
    "literature-stream": "文献查询流", "preprint": "预印本", "evidence": "循证机构与证据摘要", "guideline": "指南与学会",
    "regulator": "监管与官方机构", "hta-access": "卫生技术评估、医保与准入", "drug-safety": "安全通告与药物警戒", "journal-pharmacy": "药学与药物安全期刊",
    "industry-media": "医药产业媒体（英文）", "cn-media-pharma": "医药产业媒体（中文）", "company": "药企新闻室", "trial-registry": "临床试验注册",
    "public-health": "公共卫生与疫情", "methods": "方法学与科研诚信", "journal-methods": "方法学与循证期刊", "funding-policy": "科研基金与科研政策",
    "scholarly-signal": "学术关注度信号", "cn-media-science": "中文科学与科研媒体", "journal-ai-med": "医学 AI 期刊", "ai-medicine": "医学 AI：机构、产业、监管",
    "ai-vendor": "AI 厂商官方动态", "ai-media": "AI 媒体与解读（非技术向）", "ai-research-tools": "科研可用的 AI 工具", "ai-benchmark": "医学大模型评测榜",
    "med-news-en": "英文专业医学新闻", "cn-media-clinical": "中文医学媒体与社区", "cn-wechat": "只在公众号发布的账号", "conference": "学术会议",
}
ACCESS_NAME = {"crossref-issn": "Crossref + PubMed", "json-api": "开放接口", "rss": "订阅源", "atom": "订阅源", "html-list": "列表页",
               "wechat": "公众号", "login": "需登录", "email-only": "仅邮件", "paid-api": "付费接口", "x": "X"}
EGRESS_NAME = {"direct": "直连", "browser": "无头浏览器", "relay": "海外中继", "bridge": "公众号桥接", "none": "暂无"}


def load(path):
    out = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            try:
                v = json.loads(line); out[v["id"]] = v
            except Exception:
                pass
    return out


def decide(row, dev, prod):
    """(egress, tier, reason) for one source."""
    told = row.get("tier", "P1"); access = row.get("access")
    if access == "wechat" or not str(row.get("endpoint", "")).startswith("http"):
        return "bridge", "P2", "只在公众号发布"
    if access in ("login", "paid-api", "email-only"):
        return "none", "P2", "需登录或付费"
    pv, dv = (prod or {}).get("verdict"), (dev or {}).get("verdict")
    # 429 is a rate limit met by the concurrent probe, not a wall: judge by the other vantage point or the measured volume
    if (prod or {}).get("http") == 429:
        pv = "api-ok" if (dv in OK or (row.get("measured") or {}).get("crossref_30d") or (row.get("measured") or {}).get("pubmed_30d")) else pv
    if (dev or {}).get("http") == 429 and pv in OK:
        dv = pv
    wall = (prod or {}).get("anti_bot") or (dev or {}).get("anti_bot") or ""
    if pv in OK:
        # The researcher's tier is a value judgement made from the other network. Keep it, except where it can only have
        # been about reachability: a source that network could not read, and production can, moves up one step.
        unseen = dv not in OK
        if pv in STRUCTURED:
            tier = told if told in ("P0", "P1") else ("P1" if unseen else "P2")
            return "direct", tier, "生产机直连，结构化" + ("" if tier == "P0" else "；价值或稳定性排后")
        tier = "P0" if told == "P0" else ("P1" if told == "P1" or unseen else "P2")
        return "direct", tier, "生产机直连" + ("，列表干净" if tier == "P0" else "，需配列表解析规则")
    if pv == "blocked" and (wall in JS_WALLS or (row.get("region") == "CN")):
        return "browser", ("P2" if told == "P2" else "P1"), f"脚本质询（{wall or '防护'}），用无头浏览器读"
    if dv in OK:
        why = "生产机被按 IP 拒绝" if pv == "blocked" else "生产机网络不可达"
        return "relay", "P2", why + "，境外可读"
    if pv == "blocked" or dv == "blocked":
        return "browser", "P2", f"两地都被质询（{wall or '防护'}）"
    drawn = [x for x in (prod, dev) if x and x.get("http") == 200 and x.get("kind") == "html"]
    if drawn:
        return "browser", "P2", "页面可达，但列表由脚本绘制，需渲染后解析"
    return "none", "P2", "两地都读不到，待复查"


def findings():
    path = os.path.join(ROOT, "research", "dryrun-findings.json")
    return {k: v for k, v in json.load(open(path, encoding="utf-8")).items() if not k.startswith("_")} if os.path.exists(path) else {}


FINDINGS = findings()


def main():
    rows = json.load(open(os.path.join(ROOT, "sources.json"), encoding="utf-8"))
    dev, prod = load(os.path.join(ROOT, "research", "probe-dev.jsonl")), load(os.path.join(ROOT, "research", "probe-prod.jsonl"))
    for r in rows:
        d, p = dev.get(r["id"]), prod.get(r["id"])
        # A researcher read this page's HTML by hand and found the list (some lists sit in a script blob or in links the
        # anchor heuristic does not count). Where the uniform probe got a clean 200 and only the heuristic said no, keep
        # the researcher's finding and say so.
        if (r.get("verified") or {}).get("verdict") == "page-ok":
            for probe in (d, p):
                if probe and probe.get("verdict") == "failed" and probe.get("http") == 200 and probe.get("kind") == "html" and not probe.get("anti_bot"):
                    probe["verdict"] = "page-ok"; probe["by"] = "researcher"
        r["probe_dev"] = {k: d.get(k) for k in ("verdict", "http", "anti_bot", "items", "latest", "checked_at") if d and d.get(k) is not None} if d else {}
        r["probe_prod"] = {k: p.get(k) for k in ("verdict", "http", "anti_bot", "items", "latest", "checked_at") if p and p.get(k) is not None} if p else {}
        r["egress"], r["launch_tier"], r["launch_reason"] = decide(r, d, p)
        # A feed that answers is not yet a feed that publishes: findings of the ingestion dry run cap the tier.
        found = FINDINGS.get(r["id"])
        if found and "P0P1P2".index(r["launch_tier"]) < "P0P1P2".index(found["max_tier"]):
            r["launch_tier"], r["launch_reason"] = found["max_tier"], found["reason"]
            if found["note"] not in (r.get("note") or ""):
                r["note"] = ((r.get("note") or "") + " " + found["note"]).strip()
    json.dump(rows, open(os.path.join(ROOT, "sources.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    with open(os.path.join(ROOT, "sources.csv"), "w", encoding="utf-8-sig", newline="") as handle:
        w = csv.writer(handle)
        w.writerow(["分组", "类别", "名称", "机构", "语言", "地区", "读法", "梯队", "出口", "每周条数", "提供什么", "本机核查", "生产机核查", "防护", "入口地址", "备用入口", "备注", "id"])
        cat_group = {c: g[1] for g in GROUPS for c in g[2]}
        for r in rows:
            w.writerow([cat_group.get(r["category"], ""), CATEGORY_NAME.get(r["category"], r["category"]), r["name"], r.get("org", ""), r.get("lang", ""), r.get("region", ""),
                        ACCESS_NAME.get(r.get("access"), r.get("access")), r["launch_tier"], EGRESS_NAME[r["egress"]], r.get("volume_per_week", ""), r.get("signal", ""),
                        r["probe_dev"].get("verdict", ""), r["probe_prod"].get("verdict", ""), r["probe_prod"].get("anti_bot") or r["probe_dev"].get("anti_bot") or "",
                        r.get("endpoint", ""), " | ".join(r.get("endpoint_alt") or []), (r.get("note") or "").replace("\n", " ")[:400], r["id"]])

    stats = {"total": len(rows), "tier": collections.Counter(r["launch_tier"] for r in rows), "egress": collections.Counter(r["egress"] for r in rows),
             "access": collections.Counter(ACCESS_NAME.get(r.get("access"), r.get("access")) for r in rows),
             "tier_by_group": {}, "egress_by_tier": {}, "prod_verdict": collections.Counter(r["probe_prod"].get("verdict", "未探测") for r in rows),
             "dev_verdict": collections.Counter(r["probe_dev"].get("verdict", "未探测") for r in rows)}
    for gid, gname, cats in GROUPS:
        stats["tier_by_group"][gid] = dict(collections.Counter(r["launch_tier"] for r in rows if r["category"] in cats))
    for t in ("P0", "P1", "P2"):
        stats["egress_by_tier"][t] = dict(collections.Counter(r["egress"] for r in rows if r["launch_tier"] == t))
    stats["p0_weekly_volume"] = sum(int(r.get("volume_per_week") or 0) for r in rows if r["launch_tier"] == "P0")
    stats["p0_access"] = dict(collections.Counter(ACCESS_NAME.get(r.get("access"), r.get("access")) for r in rows if r["launch_tier"] == "P0"))
    stats["blocked_from_prod_ok_from_dev"] = sorted(r["name"] for r in rows if r["probe_prod"].get("verdict") not in OK and r["probe_dev"].get("verdict") in OK)
    stats["ok_from_prod_not_dev"] = sorted(r["name"] for r in rows if r["probe_prod"].get("verdict") in OK and r["probe_dev"].get("verdict") not in OK and r["probe_dev"])
    json.dump(stats, open(os.path.join(ROOT, "stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=dict)

    lines = []
    for gid, gname, cats in GROUPS:
        members = [r for r in rows if r["category"] in cats]
        if not members:
            continue
        tally = collections.Counter(r["launch_tier"] for r in members)
        lines += [f"## {gname}", "", f"共 {len(members)} 个：第一梯队 {tally.get('P0', 0)}，第二梯队 {tally.get('P1', 0)}，第三梯队 {tally.get('P2', 0)}。", ""]
        for cat in cats:
            sub = sorted([r for r in members if r["category"] == cat], key=lambda r: ({"P0": 0, "P1": 1, "P2": 2}[r["launch_tier"]], r["name"]))
            if not sub:
                continue
            lines += [f"### {CATEGORY_NAME.get(cat, cat)}（{len(sub)}）", ""]
            if cat.startswith("journal-") and cat != "journal-cn":
                lines += ["| 期刊 | ISSN | 梯队 | 近 7 天 Crossref / PubMed | 近 30 天 | 出口 |", "|---|---|---|---|---|---|"]
                for r in sub:
                    m = r.get("measured") or {}
                    issn = r["id"][2:].upper()
                    lines.append(f"| {r['name']} | {issn} | {r['launch_tier']} | {m.get('crossref_7d', '–')} / {m.get('pubmed_7d', '–')} | {m.get('crossref_30d', '–')} / {m.get('pubmed_30d', '–')} | {EGRESS_NAME[r['egress']]} |")
            else:
                lines += ["| 信源 | 读法 | 梯队 | 出口 | 本机 / 生产机 | 入口 |", "|---|---|---|---|---|---|"]
                for r in sub:
                    ep = r.get("endpoint", "")
                    shown = ep if not ep.startswith("http") else (ep if len(ep) <= 78 else ep[:75] + "…")
                    lines.append(f"| {r['name']} | {ACCESS_NAME.get(r.get('access'), r.get('access'))} | {r['launch_tier']} | {EGRESS_NAME[r['egress']]} | {r['probe_dev'].get('verdict', '–')} / {r['probe_prod'].get('verdict', '–')} | `{shown}` |")
            lines.append("")
    open(os.path.join(ROOT, "appendix-sources.md"), "w", encoding="utf-8").write("\n".join(lines))
    print(json.dumps({k: stats[k] for k in ("total", "tier", "egress", "prod_verdict", "dev_verdict", "p0_weekly_volume")}, ensure_ascii=False, default=dict))


if __name__ == "__main__":
    main()
