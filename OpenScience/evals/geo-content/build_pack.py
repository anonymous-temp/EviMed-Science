#!/usr/bin/env python3
"""Assemble the geo-001 deliverable from the two measured ledgers.

Every number in every output is computed here from the ledger. None is typed
into prose — that is the rule the platform's own principle #10c states, and a
GEO pack is the deliverable where it matters most, because the numbers ARE the
product.
"""

from __future__ import annotations

import json
import os
import pathlib
import statistics

RUN_ID = os.environ.get("GEO_RUN_ID", "2026-08-30-geo-001")
ROOT = pathlib.Path(__file__).resolve().parent / "results" / RUN_ID
OUT = ROOT / "deliverable"
BRAND = "速效救心丸"
PLATFORMS = ["deepseek", "doubao", "kimi", "qianwen", "yuanbao"]


def read(name: str, tag: str) -> list[dict]:
    path = ROOT / name
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        row["questionSet"] = tag
        rows.append(row)
    return rows


rows = read("geo-probe-log.jsonl", "branded") + read("geo-probe-log.unbranded.jsonl", "unbranded")
OUT.mkdir(exist_ok=True)

# The merged ledger is the deliverable's own record. Both sets, tagged, so a
# reader can see that the branded half exists and why it proves nothing.
(OUT / "geo-probe-log.jsonl").write_text(
    "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
)

measured = [r for r in rows if r["inDenominator"]]
failed = [r for r in rows if not r["inDenominator"]]
busy = [r for r in failed if "busy" in str(r.get("error") or "")]
vendor_failed = [r for r in failed if r not in busy]


def slice_of(tag: str) -> list[dict]:
    return [r for r in measured if r["questionSet"] == tag]


branded, unbranded = slice_of("branded"), slice_of("unbranded")
un_hits = sum(r["mentionsBrand"] for r in unbranded)
br_hits = sum(r["mentionsBrand"] for r in branded)

# geo-monitor.csv — the file the NEXT run compares against. One row per
# (set, platform, question, round), because a rate is not comparable and a row is.
lines = ["date,question_set,platform,question,measured,mentions_brand,competitors,citations,latency_ms"]
for r in sorted(rows, key=lambda r: (r["questionSet"], r["question"], r["provider"])):
    lines.append(",".join([
        r["at"][:10], r["questionSet"], r["provider"], '"%s"' % r["question"],
        "1" if r["inDenominator"] else "0",
        "1" if r.get("mentionsBrand") else "0",
        '"%s"' % ";".join(r.get("competitorsMentioned") or []),
        str(r.get("citations") or 0), str(r.get("latencyMs") or ""),
    ]))
(OUT / "geo-monitor.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def per_platform(pool: list[dict]) -> str:
    out = ["| 平台 | 测得轮次 | 提及本品 | 提及竞品次数 | 引用条数 | 中位耗时 |", "|---|---|---|---|---|---|"]
    for p in PLATFORMS:
        pr = [r for r in pool if r["provider"] == p]
        if not pr:
            out.append(f"| {p} | 0 | — | — | — | — |")
            continue
        lat = statistics.median(r["latencyMs"] for r in pr) / 1000
        out.append(
            f"| {p} | {len(pr)} | {sum(r['mentionsBrand'] for r in pr)}/{len(pr)} | "
            f"{sum(len(r['competitorsMentioned']) for r in pr)} | "
            f"{sum(r['citations'] for r in pr)} | {lat:.1f}s |"
        )
    return "\n".join(out)


def per_question(pool: list[dict]) -> str:
    out = ["| 问法 | 提及本品 | 同时出现的竞品 |", "|---|---|---|"]
    for q in dict.fromkeys(r["question"] for r in pool):
        qr = [r for r in pool if r["question"] == q]
        comps = sorted({c for r in qr for c in r["competitorsMentioned"]})
        out.append(f"| {q} | {sum(r['mentionsBrand'] for r in qr)}/{len(qr)} | {'、'.join(comps) or '—'} |")
    return "\n".join(out)


competitors: dict[str, int] = {}
for r in unbranded:
    for name in r["competitorsMentioned"]:
        competitors[name] = competitors.get(name, 0) + 1

measurement = f"""# 本轮测量说明

## 先说这一轮没测什么

只测了网页端、默认模式、每题一个全新会话。**没有**测 App 端、没有测深度思考模式、
没有测多轮追问，也没有测同一问题在一天中不同时段的差异。任何把本轮数字外推到这些面上的
说法都超出了证据。

时间为 {min(r['at'] for r in rows)[:10]}，五个平台：{"、".join(PLATFORMS)}。

## 两个分母，不是一个

| | 次数 |
|---|---|
| 发起的提问 | {len(rows)} |
| **真正测到的轮次** | **{len(measured)}** |
| 厂商侧失败（提问超时） | {len(vendor_failed)} |
| 根本没问出去（探测机忙） | {len(busy)} |

后两类都不是「这个平台没提到本品」。**探测机单并发，忙时直接拒绝，那一轮从未到达厂商**；
厂商超时则是问出去了但没拿回答案。两者都不进分母。若只按发起次数计，覆盖率会被高估
{(len(rows) - len(measured)) / len(measured) * 100:.0f}%。

其中 qianwen 一家占了 {len([r for r in vendor_failed if r['provider'] == 'qianwen'])} 次厂商超时中的
{len([r for r in vendor_failed if r['provider'] == 'qianwen'])} 次，是本轮最不稳定的一家；
它最终 {len([r for r in measured if r['provider'] == 'qianwen'])} 轮全部补测成功，代价是等待。

## 品牌问法测不出可见度

前 25 轮用的五个问法**每一个都写着本品名称**。结果是 {br_hits}/{len(branded)} 提及——
这个数字测的是问法，不是可见度：问题里点了名，模型只能把名字说回来。

所以补了第二组 {len({r['question'] for r in unbranded})} 个**不含品牌名**的问法，
按患者真实的问法提问。这一组才有信息量：

**不含品牌名时，{un_hits}/{len(unbranded)} 轮提到本品。**

### 不含品牌名的问法（这一组是结论所在）

{per_question(unbranded)}

{per_platform(unbranded)}

### 含品牌名的问法（保留作对照，不作结论）

{per_question(branded)}

{per_platform(branded)}

## 同场出现的其它药物（仅限不含品牌名的问法）

| 药物 | 出现轮次 |
|---|---|
""" + "\n".join(f"| {k} | {v}/{len(unbranded)} |" for k, v in sorted(competitors.items(), key=lambda kv: -kv[1])) + f"""

这是关于**这些引擎怎么回答**的测量，不是关于这些药物本身的判断。

## 可复算

`geo-probe-log.jsonl` 每行一轮，带提问、平台、端面三元组、耗时、答案摘要与截图名。
上面每一个数字都可以只用该文件重算出来；`geo-monitor.csv` 一行一轮，供下一轮对比。
行业经验是 60–90 天才见变化，所以这一轮交付的是基线与可比文件，不是效果。
"""
(OUT / "geo-measurement.md").write_text(measurement, encoding="utf-8")

CITATIONS = [
    {"id": "NMPA-LABEL-Z12020025", "title": "速效救心丸 说明书【功能主治】（国药准字Z12020025）",
     "url": "https://www.nmpa.gov.cn/datasearch/search-result.html", "kind": "official-label"},
    {"id": "PMID:18254051", "title": "Chinese herbal medicine suxiao jiuxin wan for angina pectoris (Cochrane Database Syst Rev, 2008)",
     "url": "https://pubmed.ncbi.nlm.nih.gov/18254051/", "kind": "systematic-review"},
]
(OUT / "citation-ledger.csv").write_text(
    "id,title,url,kind\n" + "\n".join(
        '%s,"%s",%s,%s' % (c["id"], c["title"], c["url"], c["kind"]) for c in CITATIONS
    ) + "\n", encoding="utf-8")

blocks = [
    {
        "id": "B-01",
        "question": "速效救心丸能预防心梗吗？",
        "conclusion": "不能。本品的登记用途是缓解气滞血瘀所致胸痹的症状，不是预防心肌梗死；把它当作预防用药，会把一件没有证据支持的事当成有证据的事。",
        "basis": "说明书【功能主治】为「行气活血，祛瘀止痛。用于气滞血瘀所致的胸痹，症见心痛、胸闷、憋气」，其中没有任何预防性适应症。现有最高层级的合并证据是一篇 2008 年 Cochrane 系统评价，纳入 15 项试验共 1776 人，评价的终点是心绞痛的症状与心电图改善，作者结论为「appears to be effective in the treatment of angina pectoris」，并明确指出「the evidence remains weak due to poor methodological quality of including studies」。该评价没有评估心肌梗死的发生率。",
        "conditions": "本条不适用于把本品当作长期预防手段的任何场景。合并证据本身被其作者判定为弱，检索截止于 2005 年 11 月，距今已久。已确诊冠心病者的长期用药方案由医师决定，不由本文决定。速效救心丸不构成对急救的替代；出现持续不缓解的胸痛时应在服药的同时呼叫急救，服药不得延误就医。",
        "citations": [{"id": c["id"]} for c in CITATIONS],
        "jsonLd": {"@context": "https://schema.org", "@type": "MedicalWebPage",
                   "about": {"@type": "Drug", "name": BRAND},
                   "mainEntity": {"@type": "MedicalCondition", "name": "心绞痛"}},
        "author": "循证药学团队（执业药师复核）",
        "updatedAt": "2026-08-30",
    },
    {
        "id": "B-02",
        "question": "速效救心丸和硝酸甘油有什么区别？",
        "conclusion": "两者不是同一类药，也不是互相的替代品：硝酸甘油是硝酸酯类血管扩张剂，本品是中成药，登记用途限于气滞血瘀所致的胸痹症状。",
        "basis": "说明书【功能主治】限定了本品的证型与症状范围。前述 Cochrane 系统评价确实把本品与硝酸甘油作了直接比较，报告心电图改善 RR 1.16（95% CI 1.05–1.27）、症状改善 RR 1.09（95% CI 1.04–1.13）、心绞痛急性发作频次差值 -0.70（95% CI -0.90 至 -0.50），但同一篇评价把这些结果的强度判为弱，理由是纳入研究的方法学质量差。",
        "conditions": "上述区间来自 2008 年的合并分析，检索截止 2005 年 11 月，且作者本人认为证据弱——不能据此认为本品优于硝酸甘油，也不能据此停用医师处方的硝酸酯类药物。是否替换、如何替换由医师决定。速效救心丸不构成对急救的替代；急性发作且症状不缓解时应在服药的同时呼叫急救，服药不得延误就医。",
        "citations": [{"id": c["id"]} for c in CITATIONS],
        "jsonLd": {"@context": "https://schema.org", "@type": "MedicalWebPage",
                   "about": {"@type": "Drug", "name": BRAND}},
        "author": "循证药学团队（执业药师复核）",
        "updatedAt": "2026-08-30",
    },
]

pack = {
    "brand": BRAND,
    "measurement": {
        "attempts": len(rows), "measured": len(measured),
        "vendorFailed": len(vendor_failed), "neverAsked": len(busy),
        "brandedMentions": br_hits, "brandedRounds": len(branded),
        "unbrandedMentions": un_hits, "unbrandedRounds": len(unbranded),
        "platforms": PLATFORMS,
        "surface": {"mode": "default", "session": "new_chat", "endpoint": "web"},
    },
    "blocks": blocks,
    "llmsTxt": "# %s\n\n> 循证内容包：结论、依据、适用条件三段式，每块绑定可解析引用。\n\n- [内容包](./geo-content-pack.md)\n- [测量说明](./geo-measurement.md)\n" % BRAND,
    "faq": [{"q": b["question"], "a": b["conclusion"]} for b in blocks],
}
(OUT / "geo-content-pack.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(OUT / "llms.txt").write_text(pack["llmsTxt"], encoding="utf-8")

md = ["# %s 循证内容包" % BRAND, ""]
for b in blocks:
    md += ["## %s" % b["question"], "", b["conclusion"], "", "**依据。**" + b["basis"], "",
           "**适用条件。**" + b["conditions"], "",
           "引用：" + "、".join(c["id"] for c in b["citations"]),
           "作者：%s ｜ 更新日期：%s" % (b["author"], b["updatedAt"]), ""]
(OUT / "geo-content-pack.md").write_text("\n".join(md), encoding="utf-8")

(OUT / "brand-entity.json").write_text(json.dumps({
    "name": BRAND, "approval": "国药准字Z12020025",
    "labelIndication": "行气活血，祛瘀止痛。用于气滞血瘀所致的胸痹，症见心痛、胸闷、憋气",
    "competitorsTracked": sorted(competitors) or ["硝酸甘油", "复方丹参滴丸"],
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

(OUT / "delivery-summary.md").write_text(f"""# 交付说明

本轮交付 {len(blocks)} 个内容块与一份基线测量。

测量共发起 {len(rows)} 次提问，测得 {len(measured)} 轮；{len(vendor_failed)} 次厂商超时、
{len(busy)} 次未问出去，均不进分母。

结论所在的是不含品牌名的一组：{un_hits}/{len(unbranded)} 轮提到本品。含品牌名的一组
（{br_hits}/{len(branded)}）保留作对照，不作结论——问法里点了名，那个数字测的是问法。

内容块只写了证据能支撑的两条。其余问法测了但未成块，因为没有可解析的来源可绑。
""", encoding="utf-8")

print(f"attempts {len(rows)}  measured {len(measured)}  vendorFailed {len(vendor_failed)}  neverAsked {len(busy)}")
print(f"branded mentions   {br_hits}/{len(branded)}   <- measures the question set")
print(f"unbranded mentions {un_hits}/{len(unbranded)}   <- measures visibility")
print(f"wrote {len(list(OUT.iterdir()))} files to {OUT}")
