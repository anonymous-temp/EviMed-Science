#!/usr/bin/env python3
"""Writes 09-sources-mix.html and 10-egress.html from ../stats.json, ../sources.json and ../research/aihot-measured-7d.json.
Colours: the six categorical slots validated with the dataviz skill's validate_palette.js (light surface); the tier
ramp is one hue, light to dark. Values are direct-labelled because three slots sit under 3:1 contrast."""
import collections, html, json, os

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, "..")
stats = json.load(open(os.path.join(ROOT, "stats.json"), encoding="utf-8"))
rows = json.load(open(os.path.join(ROOT, "sources.json"), encoding="utf-8"))
aihot = json.load(open(os.path.join(ROOT, "research", "aihot-measured-7d.json"), encoding="utf-8"))

SLOTS = [("开放接口", "#2a78d6"), ("订阅源", "#eb6834"), ("网页 / 列表页", "#1baf7a"), ("微信公众号", "#eda100"), ("X 账号", "#e87ba4"), ("代码与模型仓库", "#008300")]
A_MAP = {"API": "开放接口", "RSS": "订阅源", "网页": "网页 / 列表页", "微信公众号": "微信公众号", "X 账号": "X 账号", "GitHub / HF": "代码与模型仓库"}
E_MAP = {"crossref-issn": "开放接口", "json-api": "开放接口", "rss": "订阅源", "atom": "订阅源", "html-list": "网页 / 列表页", "login": "网页 / 列表页",
         "wechat": "微信公众号", "x": "X 账号", "email-only": "网页 / 列表页", "paid-api": "开放接口"}
a_counts = collections.Counter(); e_counts = collections.Counter()
for k, v in aihot["by_type"].items():
    a_counts[A_MAP[k]] += v["sources"]
for r in rows:
    e_counts[E_MAP.get(r.get("access"), "网页 / 列表页")] += 1


def stacked(counts, total):
    out = []
    for name, colour in SLOTS:
        n = counts.get(name, 0)
        if not n:
            continue
        pct = 100 * n / total
        label = f"{n}" if pct >= 4 else ""
        ink = "#17201e" if colour in ("#1baf7a", "#eda100", "#e87ba4") else "#ffffff"  # three slots sit under 3:1 against white
        out.append(f'<div class="seg" title="{html.escape(name)}：{n} 个（{pct:.0f}%）" style="flex:{n};background:{colour}"><span style="color:{ink}">{label}</span></div>')
    return "".join(out)


legend = "".join(f'<span class="lg"><i style="background:{c}"></i>{html.escape(n)}</span>' for n, c in SLOTS)
GROUP_NAMES = [("evidence", "临床证据"), ("guideline", "指南共识"), ("regulatory", "审批监管"), ("safety", "药物安全"), ("pipeline", "研发产业"),
               ("public-health", "公共卫生"), ("research", "科研与基金"), ("ai", "AI 与医学"), ("news", "综合医学新闻"), ("conference", "学术会议")]
TIER = [("P0", "第一梯队", "#00645c"), ("P1", "第二梯队", "#4aa79c"), ("P2", "第三梯队", "#b5ddd7")]
biggest = max(sum(stats["tier_by_group"].get(g, {}).values()) for g, _ in GROUP_NAMES) or 1
bars = []
for gid, gname in GROUP_NAMES:
    t = stats["tier_by_group"].get(gid, {}); total = sum(t.values())
    segs = "".join(f'<div class="seg" title="{gname} · {tn}：{t.get(tk, 0)} 个" style="flex:{t.get(tk, 0)};background:{tc}"><span style="color:{"#fff" if tk != "P2" else "#17201e"}">{t.get(tk, 0) if t.get(tk, 0) >= 4 else ""}</span></div>' for tk, tn, tc in TIER if t.get(tk, 0))
    bars.append(f'<div class="brow"><div class="bl">{gname}</div><div class="bt"><div class="stack" style="width:{100 * total / biggest:.1f}%">{segs}</div></div><div class="bv">{total}</div></div>')
tier_legend = "".join(f'<span class="lg"><i style="background:{c}"></i>{n}（{stats["tier"].get(k, 0)}）</span>' for k, n, c in TIER)
a_total, e_total = sum(a_counts.values()), len(rows)

CSS = """<style>.viz{--surface-1:#fcfcfb;--text-primary:#17201e;--text-secondary:#44514e;--text-muted:#7b8784;background:var(--surface-1);border:1px solid #e2e8e6;border-radius:12px;padding:18px 20px}
.viz h2{font-size:15px;margin:0 0 2px;color:var(--text-primary)}.viz .sub{font-size:12.5px;color:var(--text-muted);margin-bottom:14px}
.stack{display:flex;gap:2px;height:26px}.seg{display:flex;align-items:center;justify-content:center;min-width:3px;border-radius:0}.seg:first-child{border-radius:4px 0 0 4px}.seg:last-child{border-radius:0 4px 4px 0}
.seg span{font-size:12px;color:#fff;font-weight:600}.rowlabel{font-size:13px;color:var(--text-primary);margin:12px 0 5px;display:flex;justify-content:space-between}.rowlabel small{color:var(--text-muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}.lg{font-size:12.5px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px}.lg i{width:10px;height:10px;border-radius:2px;display:inline-block}
.brow{display:grid;grid-template-columns:96px 1fr 38px;gap:10px;align-items:center;margin-bottom:7px}.bl{font-size:13px;color:var(--text-primary);text-align:right}.bt{border-left:1px solid #dfe5e3;padding-left:0}
.brow .stack{height:20px}.bv{font-size:12.5px;color:var(--text-secondary)}.takeaway{font-size:13px;color:var(--text-secondary);margin-top:12px;line-height:1.7}</style>"""

page = f"""<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="base.css">{CSS}
<div id="shot" class="dg" style="width:1040px"><div class="grid2" style="grid-template-columns:1fr 1.05fr;gap:18px;align-items:start">
<div class="viz"><h2>信源怎么读：AIHOT 与 EviMed 前沿动态</h2><div class="sub">按读取方式统计信源个数 · AIHOT 为 2026-09-14 至 09-21 公开池实测</div>
<div class="rowlabel"><span>AIHOT</span><small>{a_total} 个信源</small></div><div class="stack">{stacked(a_counts, a_total)}</div>
<div class="rowlabel"><span>EviMed 前沿动态（登记表）</span><small>{e_total} 个信源</small></div><div class="stack">{stacked(e_counts, e_total)}</div>
<div class="legend">{legend}</div>
<div class="takeaway">AIHOT 过半信源是 X 账号，却只出了两成精选。医学的权威信源本身就是结构化的：期刊走 Crossref 与 PubMed 的开放接口，监管与循证机构多有订阅源；中文信息的难点在列表页与公众号。</div></div>
<div class="viz"><h2>我们的 {e_total} 个信源：十个分组 × 三个梯队</h2><div class="sub">梯队由 9 月 21 日本机与生产机两地实测结果决定</div>
{''.join(bars)}<div class="legend">{tier_legend}</div>
<div class="takeaway">第一梯队今天就能从生产机直接读到；第二梯队要配列表解析规则或用无头浏览器读；第三梯队要公众号桥接、海外中继或付费。</div></div>
</div></div><div class="cap">图 9 · 信源结构对照与梯队分布（数据图，数值见正文表格）</div>"""
open(os.path.join(HERE, "09-sources-mix.html"), "w", encoding="utf-8").write(page)

eg = stats["egress"]; by = stats["egress_by_tier"]
def n(tier, key): return by.get(tier, {}).get(key, 0)
page2 = f"""<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="base.css">
<div id="shot" class="dg" style="width:1000px">
<div class="lane"><h3>生产机在北京腾讯云：同一张登记表，从两个地方各读一遍（2026-09-21 实测）</h3>
<div class="grid2" style="gap:16px">
<div class="node"><b>从生产机读得到的</b><span>Crossref、PubMed、Europe PMC、openFDA、ClinicalTrials.gov、Federal Register、medRxiv 接口；JAMA、BMJ、Nature 的订阅源；EMA、英国政府站、WHO 接口；医保局、疾控局、中国政府网、科学网；国内媒体；OpenAI、DeepMind、MIT 科技评论、量子位等 AI 信源。</span></div>
<div class="node am"><b>从生产机读不到的</b><span>被 Cloudflare 按机房 IP 拒绝：NEJM、柳叶刀、Cell、Science、Wiley、牛津、AHA、ASCO、LWW 等出版商站，Cochrane Library、NICE、NIH、Medscape、Fierce。被判为滥用来源：FDA 官网。网络不可达：X、Substack、纽约时报、HuggingFace。带瑞数脚本质询（在哪都一样）：国家药监局、药审中心、器审中心、卫健委。</span></div>
</div></div>
<div class="muted" style="text-align:center;font-size:14px;margin:4px 0 10px">↓ 四个出口，各管一类</div>
<div class="flow">
<div class="node hl"><b>① 直连 · {eg.get('direct', 0)} 个</b><span>生产机直接读。第一梯队 {n('P0', 'direct')} 个全部在这里。</span></div><div class="arr"> </div>
<div class="node hl"><b>② 用开放接口替代网站</b><span>155 种期刊不碰出版商网站：Crossref 发现，PubMed 与 Europe PMC 补摘要和文献类型。FDA 用 openFDA 与 Federal Register 替代官网。已计入直连。</span></div><div class="arr"> </div>
<div class="node vi"><b>③ 无头浏览器 · {eg.get('browser', 0)} 个</b><span>北京主机上自己的 Chromium 容器，9 月 22 日实测能过瑞数，每页 1–5 秒；AgentBay 只作后备。最要紧的 {n('P1', 'browser')} 个（国家药监局、药审中心、器审中心、卫健委的各栏目）第二阶段上线，其余带质询或脚本绘制列表的站按需。</span></div><div class="arr"> </div>
<div class="node am"><b>④ 海外中继 · {eg.get('relay', 0)} 个</b><span>生产机连不上或被按 IP 拒绝、境外可读的信源，经一个只认登记表地址、带签名的中继读取。第三阶段上线。</span></div>
</div>
<div class="note">另有公众号桥接 {eg.get('bridge', 0)} 个（第三阶段）、暂无可行读法 {eg.get('none', 0)} 个（需登录、付费或两地都读不到）。中继是一个可替换的接口：Cloudflare Worker 或一台境外轻量云主机都行，换哪种不影响管线其余部分。</div>
</div><div class="cap">图 10 · 出口策略：先用接口替代，再用浏览器，最后才用中继（设计稿，数字为实测）</div>"""
open(os.path.join(HERE, "10-egress.html"), "w", encoding="utf-8").write(page2)
print("charts written", dict(a_counts), dict(e_counts))
