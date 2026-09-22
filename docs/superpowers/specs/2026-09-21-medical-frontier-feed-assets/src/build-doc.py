#!/usr/bin/env python3
"""Assembles the plan from doc-part*.md + ../appendix-sources.md, fills the {{TOKENS}} from ../stats.json, and writes
../../2026-09-21-frontier-feed-medical-aihot-plan.md.  Usage: build-doc.py"""
import json, os, re
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, ".."); SPECS = os.path.join(ROOT, "..")
stats = json.load(open(os.path.join(ROOT, "stats.json"), encoding="utf-8"))
rows = json.load(open(os.path.join(ROOT, "sources.json"), encoding="utf-8"))
tier, egress = stats["tier"], stats["egress"]
GROUPS = [("evidence", "临床证据：期刊、文献流、预印本"), ("guideline", "指南共识：循证机构与学会"), ("regulatory", "审批监管：监管机构、医保与 HTA"), ("safety", "药物安全：安全通告、药物警戒、药学期刊"),
          ("pipeline", "研发产业：产业媒体、药企、试验注册"), ("public-health", "公共卫生"), ("research", "科研与基金：方法学、诚信、基金、科学媒体"), ("ai", "AI 与医学"),
          ("news", "综合医学新闻（中英文）"), ("conference", "学术会议")]
def table_groups():
    out = ["| 分组 | 合计 | 第一梯队 | 第二梯队 | 第三梯队 |", "|---|---|---|---|---|"]
    for gid, name in GROUPS:
        t = stats["tier_by_group"].get(gid, {})
        out.append(f"| {name} | {sum(t.values())} | {t.get('P0', 0)} | {t.get('P1', 0)} | {t.get('P2', 0)} |")
    out.append(f"| **合计** | **{stats['total']}** | **{tier.get('P0', 0)}** | **{tier.get('P1', 0)}** | **{tier.get('P2', 0)}** |")
    return "\n".join(out)
def table_access():
    a, p0 = stats["access"], stats["p0_access"]
    order = ["Crossref + PubMed", "开放接口", "订阅源", "列表页", "公众号", "需登录", "付费接口", "仅邮件"]
    out = ["| 读法 | 登记表 | 其中第一梯队 | 说明 |", "|---|---|---|---|"]
    note = {"Crossref + PubMed": "155 种期刊，一个适配器", "开放接口": "PubMed 查询流、Europe PMC、ClinicalTrials.gov、openFDA、Federal Register、WHO、medRxiv、arXiv、MedHELM 等",
            "订阅源": "RSS 与 Atom，通用解析", "列表页": "每个信源配一组选择器；含要用无头浏览器读的", "公众号": "第三阶段经桥接服务", "需登录": "暂不读", "付费接口": "暂不读", "仅邮件": "暂不读"}
    for k in order:
        if a.get(k): out.append(f"| {k} | {a.get(k, 0)} | {p0.get(k, 0)} | {note.get(k, '')} |")
    return "\n".join(out)
def table_egress():
    by = stats["egress_by_tier"]
    names = [("direct", "直连（含用开放接口替代网站）"), ("browser", "无头浏览器"), ("relay", "海外中继"), ("bridge", "公众号桥接"), ("none", "暂无可行读法")]
    out = ["| 出口 | 信源数 | 第一梯队 | 第二梯队 | 第三梯队 |", "|---|---|---|---|---|"]
    for k, n in names:
        out.append(f"| {n} | {egress.get(k, 0)} | {by.get('P0', {}).get(k, 0)} | {by.get('P1', {}).get(k, 0)} | {by.get('P2', {}).get(k, 0)} |")
    return "\n".join(out)
tokens = {"N_TOTAL": stats["total"], "N_P0": tier.get("P0", 0), "N_P1": tier.get("P1", 0), "N_P2": tier.get("P2", 0), "N_P0P1": tier.get("P0", 0) + tier.get("P1", 0),
          "N_LAUNCH": tier.get("P0", 0), "N_PROD_ONLY": len(stats["ok_from_prod_not_dev"]), "N_DEV_ONLY": len(stats["blocked_from_prod_ok_from_dev"]),
          "TABLE_GROUPS": table_groups(), "TABLE_ACCESS": table_access(), "TABLE_EGRESS": table_egress()}
wx_path = os.path.join(ROOT, "research", "wechat-trial-2026-09-21.json")
if os.path.exists(wx_path):  # chapter 11's trial numbers come from the trial report, never typed by hand
    wx = json.load(open(wx_path, encoding="utf-8"))
    share = lambda d: f"{round(100 * d['share'])}%" if d.get("share") is not None else "—"
    tokens.update({"WX_BIZ": wx["accounts_with_biz"], "WX_ACCOUNTS": wx["accounts_with_structured_article"], "WX_FETCHED": wx["fetches"],
                   "WX_OK": wx["articles_structured"], "WX_AUTHOR": share(wx["fields_present"]["author"]), "WX_IP": share(wx["fields_present"]["ip_region"]),
                   "WX_ORIGINAL": share(wx["original_true"]), "WX_TEXT": f"{int(wx['text_chars']['median']):,}", "WX_REFS": share(wx["with_identifier_refs"]),
                   "WX_JOURNAL": share(wx["with_journal_mention"]), "WX_7D": f"{wx['published_within_7d']['n']} / {wx['published_within_7d']['of']}",
                   "WX_SOGOU_Q": wx["sogou"]["accounts_queried"], "WX_SOGOU_BY": wx["sogou"]["with_results_by_the_account"],
                   "WX_SOGOU7D": wx["sogou"]["with_a_post_within_7d"],
                   "WX_LANES": "、".join(f"{name} {wx['lanes'][k]['with_article']}/{wx['lanes'][k]['accounts']}" for k, name in
                                         [("news", "资讯"), ("pipeline", "研发"), ("research", "科研"), ("ai", "AI"), ("evidence", "证据"),
                                          ("guideline", "指南"), ("regulatory", "监管"), ("public-health", "公卫"), ("safety", "安全")] if k in wx["lanes"])})
hl = os.path.join(HERE, "doc-highlights.md")
tokens["SECTION_HIGHLIGHTS"] = open(hl, encoding="utf-8").read() if os.path.exists(hl) else "（待补）"
parts = [open(os.path.join(HERE, f"doc-part{i}.md"), encoding="utf-8").read() for i in (1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13)]  # 8-9 chapter 10, 10 chapter 11 (WeChat), 11 chapter 12 (EviMed API), 12 chapter 13 (review), 13 chapter 14 (final: the source plugin); 7 is the tail after appendix A
appendix = open(os.path.join(ROOT, "appendix-sources.md"), encoding="utf-8").read()
tail = open(os.path.join(HERE, "doc-part7.md"), encoding="utf-8").read() if os.path.exists(os.path.join(HERE, "doc-part7.md")) else ""
text = "\n".join(parts) + "\n\n---\n\n# 附录 A　信源清单（" + str(stats["total"]) + " 个，2026-09-21 两地实测）\n\n" + \
    "读法、梯队、出口的含义见第 5 章。「本机 / 生产机」两栏是核查工具的结论：`feed-ok` 订阅源可解析且有条目，`api-ok` 接口返回有效 JSON，`page-ok` 页面可读且确有列表，`blocked` 被防护拦截，`failed` 读不到。期刊表的数字是该刊近 7 天、近 30 天在 Crossref 登记与 PubMed 入库的篇数。个别接口地址里的日期是核查当天的窗口，上线时换成滚动窗口。\n\n" + appendix + "\n" + tail
for k, v in tokens.items():
    text = text.replace("{{" + k + "}}", str(v))
left = re.findall(r"\{\{[A-Z_0-9]+\}\}", text)
out = os.path.join(SPECS, "2026-09-21-frontier-feed-medical-aihot-plan.md")
open(out, "w", encoding="utf-8").write(text)
print("written", out, len(text), "chars; unfilled tokens:", left)
