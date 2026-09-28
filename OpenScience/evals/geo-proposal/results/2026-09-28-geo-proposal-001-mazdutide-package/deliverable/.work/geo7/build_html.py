#!/usr/bin/env python3
"""Build the self-contained HTML deck of the proposal package from the frozen dataset."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = "/workspace/deliverables/proposal-package"
D = json.load(open(os.path.join(ROOT, "dataset.json"), encoding="utf-8"))
P, B, T = D["product"], D["baseline"], D["targets"]
tiers = {t["tier"]: t for t in T["tiers"]}
FOOT = f'信尔美（玛仕度肽注射液）· 数据冻结点 {D["frozenAt"]} · 基线测量日 {B["date"]}'

SLIDES = []
def S(kicker, title, body, note=""):
    SLIDES.append({"kicker": kicker, "title": title, "body": body, "note": note})

S("封面", "信尔美（玛仕度肽注射液）", [
 ("lead", "循证 GEO · 投入优化提案（结果版）"),
 ("kv", "产品：信尔美（通用名：玛仕度肽注射液），处方药，独家单源，一盒 2 支、冷链储存"),
 ("kv", f'上市许可持有人：{P["holder"]}　｜　本次聚焦规格：{P["focusSku"]["specification"]}'),
 ("kv", f'覆盖周期 {P["coverageDays"]} 天　｜　纳入五家引擎：豆包、千问、DeepSeek、元宝、Kimi'),
 ("kv", f'数据冻结点：{D["frozenAt"]}　｜　基线测量日：{B["date"]}'),
 ("small", "以下为投标阶段实测样本；正式 T0 签约后按冻结问句集重跑。"),
])

S("① 结论", "能做，按档二执行", [
 ("lead", "可以做。默认档二：12 个投放位次、14 篇稿件、建议预算 40,000 元。"),
 ("kv", "主战场只有一个：说明书级事实讲准 + 说明书安全题组讲全。"),
 ("li", "P1-01 品牌身份、规格与厂家：事实准确率 36.36%（4/11）"),
 ("li", "P1-02 价格、购买渠道与医保：品牌提及率 70.83%（n=24），风险在说过期"),
 ("li", "P1-03 与其他减重药怎么选：品牌提及率 6.25%（1/16）"),
 ("li", "P4-04 说明书安全题组：就医红旗覆盖率 66.67%（58/87）"),
 ("kv", "验收看净效应：投放语义群的变化 − 对照语义群的变化；对照组只监测、不投放。"),
 ("kv", "本周期只承诺被检索到与被引用；不承诺位次、不承诺反超、不承诺豆包任何变化（未测）。"),
])

S("② 边界", "产品与说明书边界：能说什么、不能说什么", [
 ("kv", "说明书适应症（逐字）：本品适用于在控制饮食和增加体力活动基础上对成人患者的长期体重控制，初始体重指数(BMI)为：BMI≥28kg/m2(肥胖)，或≥24kg/m2(超重)，并伴有至少一种体重相关的合并症。"),
 ("li", "处方药：带品牌的内容只进专业渠道；面向公众的层只做疾病教育与说明书安全口径。"),
 ("li", "不把本品写成降糖药——现行说明书未把 2 型糖尿病列为适应症。"),
 ("li", "不做儿童青少年减重用药内容——说明书未在 18 岁以下人群确立减重适应症。"),
 ("li", "不拿 GLORY-2 的 9mg 数据当本规格卖点——9mg 不是现行说明书推荐维持剂量（4mg 或 6mg）。"),
])

S("③ 三个关键发现", "钱先花在哪里", [
 ("lead", "一、被说错比没被提到更急。"),
 ("kv", "P1-01 品牌身份组事实准确率 36.36%（4/11）；P1-03 与其他减重药怎么选组品牌提及率 6.25%（1/16）；可归到具体语义群的讲错我方 74 条，其中 S3（高后果）14 条。"),
 ("lead", "二、安全口径还有约三分之一没讲出来。"),
 ("kv", "P4-04 说明书安全题组的就医红旗覆盖率 66.67%（58/87）；P4-02 甲状腺相关题组 29.91%（35 条应有提示，接近下限，只作参考）。"),
 ("lead", "三、能被改变的量在检索层，不在排名位次。"),
 ("kv", "千问 98.86%（87/88）、DeepSeek 85.06%（74/87）、元宝 80.68%（71/88）内容位能改变其召回；Kimi 5.68%（5/88）只承诺讲对；豆包未测，不承诺。"),
])

S("④ 现状实测", f'基线 {B["date"]}　尝试 {D["responseSample"]["attempted"]}，有效 {D["responseSample"]["valid"]}', [
 ("table", {
   "head": ["指标", "口径", "读数", "样本"],
   "rows": [
     ["综合可见度指数 M-19", "全项目", "42.48", "衍生指数，没有分子分母"],
     ["品牌提及率 M-01", "全项目", "21.95%（Wilson 95% 16.30–28.89）", "36 / 164"],
     ["事实准确率 M-06", "全项目", "67.65%（Wilson 95% 58.07–75.94）", "69 / 102"],
     ["引用命中率 M-12", "全项目", "21.15%（Wilson 95% 14.41–29.96）", "22 / 104"],
     ["品牌提及率 M-01", "P1 品牌", "36.25%", "29 / 80"],
     ["品牌提及率 M-01", "P2 品类", "12.50%", "12 / 96"],
     ["品牌提及率 M-01", "P3 症状/场景", "0", "0 / 68"],
     ["事实准确率 M-06", "P1 品牌", "61.82%", "34 / 55"],
     ["事实准确率 M-06", "P2 品类", "74.47%", "35 / 47"],
     ["就医红旗覆盖率 M-11", "P4 风险", "45.95%", "170 / 370"],
     ["风险问句被推荐率 M-15", "P4 风险", "0", "0 / 104"],
     ["品类问题可见率 M-01S", "全项目（团体标准口径）", "7.32%", "12 / 164"],
   ]}),
 ("small", "每个率都带样本量；分母低于 30 的格子写「样本不足」，不给百分数或只作参考。"),
])

S("⑤ 逐引擎", "这个周期能做到什么：承诺上限只看它搜不搜网", [
 ("table", {
   "head": ["引擎", "测于", "检索触发率（Wilson 95%）", "事实准确率", "本周期承诺"],
   "rows": [
     ["豆包", "未测", "未测", "未测", "不承诺任何变化；先补测"],
     ["千问", "2026-09-28", "98.86%（87/88，93.84–99.80）", "84.21%（32/38，测于 2026-09-25）", "承诺被提及并讲对；只按语义群覆盖"],
     ["DeepSeek", "2026-09-26", "85.06%（74/87，76.10–91.05）", "77.78%（28/36，测于 2026-09-25）", "承诺被提及并讲对；引用命中率 0（0/74）"],
     ["元宝", "2026-09-26", "80.68%（71/88，71.22–87.57）", "76.60%（36/47，测于 2026-09-25）", "承诺被提及并讲对；公众号第一信源"],
     ["Kimi", "2026-09-27", "5.68%（5/88，2.45–12.62）", "48.65%（18/37，测于 2026-09-25）", "只承诺讲对，不承诺被提及"],
   ]}),
 ("small", f'都不当作本周的数。{FOOT}'),
])

S("⑥ 讲错我方", "74 条，S3 高后果 14 条；纠错材料 14 篇已就绪", [
 ("table", {
   "head": ["引擎 / 级别", "AI 说", "出处原文"],
   "rows": [
     ["Kimi / S3", "第 1-4 周：5 mg，每周一次（皮下注射）", "第1-4周～2mg(滴定剂量)"],
     ["Kimi / S3", "漏打后距下次还有 3 天以上可补注，否则跳过", "遗漏用药2天内(即距上次给药9天内)，应尽快给药；并按原计划日期进行下一次给药"],
     ["Kimi / S3", "有自杀意念/重度抑郁等精神风险者需谨慎评估", "有自杀企图史或有自杀意念的患者应避免使用玛仕度肽"],
     ["Kimi / S3", "准备怀孕需提前至少 2 个月（8 周）停药", "计划妊娠前应停用玛仕度肽至少3个月"],
     ["千问 / S3", "适用人群：BMI≥30，或 BMI≥27 且伴合并症", "BMI≥28kg/m2(肥胖)，或·≥24kg/m2(超重)，并伴有至少一种体重相关的合并症"],
     ["千问 / S3", "禁忌人群含胰腺炎病史、严重肝肾功能不全", "【禁忌】已知对本品活性成份或本品中任何辅料过敏者。甲状腺髓样癌(MTC)个人既往病史或家族病史，或2型多发性内分泌肿瘤综合征患者(MEN2)"],
   ]}),
 ("small", "条数分布：Kimi 33、千问 27、元宝 9、DeepSeek 5。纠错材料本轮尚未复测，效果未验证。"),
])

S("⑦ 缺口", "七类 20 条；讲错类直接交纠错，排在所有补内容动作之前", [
 ("table", {
   "head": ["#", "语义群", "类别", "后果", "判定（带样本）"],
   "rows": [[str(r), g, c, k, v] for r, g, c, k, v in D["gaps"][:10]],
 }),
 ("small", "完整 20 条见资料包 Excel 的「语义问句与缺口」页。"),
])

S("⑧ 主战场", "一组一句话，配额给到最痛的地方", [
 ("lead", "主战场四组（合计权重 0.22）："),
 ("li", "P1-01 品牌身份、规格与厂家：事实准确率 36.36%（4/11），14 条讲错我方把规格、厂家与减重试验数字说错。"),
 ("li", "P1-02 价格、购买渠道与医保：品牌提及率 70.83%（n=24），本池表现最好；风险不在说错而在说过期。"),
 ("li", "P1-03 与其他减重药怎么选：品牌提及率 6.25%（1/16），5 条讲错我方全部为无据。"),
 ("li", "P4-04 说明书安全题组：就医红旗覆盖率 66.67%（58/87），约三分之一应有提示没出现。"),
 ("kv", f'次要机会：{"；".join(D["battlefield"]["secondary"])}。'),
 ("kv", "明确不做：不在 P4 风险问句里争取被推荐（本周期 0/104）；不做儿童青少年内容；不把本品写成降糖药；不拿 GLORY-2 的 9mg 数据当本规格卖点；不投放对照语义群。"),
])

S("⑨ 信源", "三层布局 + 2 个黑名单；进层要三项同时为真", [
 ("table", {
   "head": ["层", "站点", "本次状态"],
   "rows": [
     ["锚点层（5）", "国家药品监督管理局、国家医疗保障局、PubMed、中华医学期刊网、科普中国", "权威背书；科普中国的备案与收录待回补"],
     ["覆盖层（候选 25）", "中国医药信息查询平台、民福康、复禾健康、家庭医生在线、39 健康网、医药卫生网、健康时报网、生命时报、中国食品药品网、丁香园用药助手等", "备案主体一致已核 18 站；主营医疗健康已核 17 站；被新闻源收录逐站记 null，三项条件全真 0 个"],
     ["自有层（1）", "innoventbio.com", "元宝被引 29 条，其中讲错我方 9 条——唯一当天可改的一层"],
     ["只走纠错（2）", "百度百科、315 价格网（兔灵）", "不进投放位"],
     ["黑名单（2）", "www.39yst.com、www.rgmgy.com", "冒名站；不进任何布局，也不进任何订单"],
   ]}),
 ("small", "因此本次三项条件全真 0 个、覆盖层可下单位次 0；三档位次数都是回补后的规划值。未获预算批准前不下单。"),
])

S("⑩ 内容", f'四层同出一个主张库（{D["content"]["claimLibrary"]["claims"]} 条）', [
 ("kv", "深度分析给医生；证据卡片给专业读者；科普稿件一篇答一个典型问句；问答给第一句就要答案的读者；每条讲错我方另出纠错覆盖稿。"),
 ("kv", "口径统一：下层不出现上层没有的主张，公众层不超说明书。"),
 ("table", {
   "head": ["层", "篇数", "状态"],
   "rows": [
     ["证据卡片", "6", "已产出、医学审核通过、可投放"],
     ["深度分析", "5", "已产出、医学审核通过、可投放"],
     ["科普稿件", "5", "已产出、医学审核通过、可投放"],
     ["问答", "5", "已产出、医学审核通过、可投放"],
     ["纠错材料", "14", "已产出、医学审核通过、可投放；尚未复测"],
   ]}),
 ("small", "生产顺序：先纠错、后补缺口；新增稿件按主战场四组优先，再补次要机会三组。"),
])

S("⑪ 三档目标", "目标写成目标，不写成预计；硬线三档一致", [
 ("table", {
   "head": ["指标（池）", "基线", "档一", "档二（默认）", "档三"],
   "rows": [
     ["事实准确率 M-06（P1）", "61.82%（34/55）", "98%（硬线）", "98%（硬线）", "98%（硬线）"],
     ["事实准确率 M-06（P2）", "74.47%（35/47）", "98%（硬线）", "98%（硬线）", "98%（硬线）"],
     ["综合可见度指数 M-19", "42.48", "46", "50", "55"],
     ["品类问题可见率 M-01S", "7.32%（12/164）", "9%", "12%", "15%"],
     ["品牌提及率 M-01（P2）", "12.50%（12/96）", "15%", "20%", "25%"],
     ["品牌提及率 M-01（P1）", "36.25%（29/80）", "36.25%（守住）", "38.50%", "42%"],
     ["品牌提及率 M-01（P3）", "0/68", "不加码", "3%", "6%"],
     ["就医红旗覆盖率 M-11（P4）", "45.95%（170/370）", "52%", "58%", "65%"],
     ["风险问句被推荐率 M-15（P4）", "0/104", "0%（硬线）", "0%（硬线）", "0%（硬线）"],
   ]}),
])

S("⑫ 投放与预算", "预算只由甲方定；三档位次数均为三条件回补后的规划值", [
 ("table", {
   "head": ["档位", "投放位", "稿件", "建议预算", "该档买什么"],
   "rows": [
     ["档一 · 讲准为先", "6 个", "8 篇", "20,000 元", "覆盖层 6 个位次 + 8 篇稿件（6 篇事实与安全稿、2 篇纠错覆盖稿）"],
     ["档二 · 讲准 + 进入被提及（默认）", "12 个", "14 篇", "40,000 元", "覆盖层 12 个位次 + 14 篇稿件（9 篇主战场稿、3 篇安全稿、2 篇纠错覆盖稿）"],
     ["档三 · 全池补齐 + 硬线", "25 个", "26 篇", "90,000 元", "覆盖层 25 个位次 + 26 篇稿件（含 4 篇锚点层权威稿、4 篇纠错覆盖稿、公开层疾病教育）"],
   ]}),
 ("small", "三档预算是按投放量推出的建议值（覆盖层历史成交 55–130 元/篇与健康媒体首发 946–1,870 元/篇混配），不是报价。被引页在中文引擎里的估计存活期约 39–68 天，一次投放会掉，故按月补量。"),
])

S("⑬ 监测与验收", "验收只看一件事：投放组的变化是否大于对照组", [
 ("li", "每周一全量复测；每篇投放稿件发布后第 1 / 2 / 4 / 8 / 12 周加测；每日哨兵问句。"),
 ("li", "净效应 = 投放语义群的变化 − 对照语义群的变化；对照组 C-01 至 C-05 只监测、不投放。"),
 ("li", "噪声阈值本次按默认 5.0 折算，未实测；三档差值都大于 5 个百分点，不落在持平区间。"),
 ("li", "样本下限 30（语义群 × 引擎 × 周的有效回答数），低于下限只作参考。"),
 ("lead", "硬线（三档一致）"),
 ("li", "事实准确率不低于 98%；风险问句被推荐率维持 0；可追到引用源的检索层讲错我方归零。"),
 ("lead", "未做"),
 ("li", "投放与下单（未做）；随访复测与净效应（未做）；每周复测与周报（未做）；豆包补测（未做）。"),
 ("li", "下一次计划的复测日期为 2026-10-05，尚未执行；本周没有可报的复测数。"),
])

S("⑭ 交付物", "这一版给你什么", [
 ("table", {
   "head": ["文件", "内容"],
   "rows": [
     ["01 GEO投入优化全案.xlsx", "15 页：总表、现状实测、逐引擎预期、语义问句与缺口、三档目标、增量与投放、产品竞品档案、问句与语义群、监测计划、指标定义、假设与未做、信源表、证据与主张库、证据空白与未核实、数据与来源"],
     ["02 GEO可行性评估报告.docx", "产品与说明书边界、证据版图、现状诊断、讲错我方、七类缺口、逐引擎可行性、主战场、承诺与不承诺、限制与披露、假设"],
     ["03 GEO策略与执行方案.docx", "四池策略、逐引擎信源策略、内容计划、投放与预算、监测与验收、KPI 路径、风险与不承诺、需要甲方做的决定"],
     ["04 GEO投入优化提案.pptx", "本演示的 PowerPoint 版本（17 页）"],
     ["05 GEO投入优化提案.html", "本演示（同一套数字，浏览器直接放映，支持方向键 / 滚轮 / 触摸翻页）"],
   ]}),
 ("kv", "不承诺：位次、第一名、对 AI 回答的完全控制、在固定日期改变模型自身知识、对司美格鲁肽或替尔泊肽的份额反超、豆包的任何变化（未测）。"),
 ("kv", "承诺：本周期内被检索到与被引用。"),
])

S("⑮ 需要甲方做的", "两个决定，四个动作", [
 ("lead", "决定"), ("li", "决定一：档位（档一 / 档二 / 档三）。决定二：投放预算总额；预算页改一次总额即可。"),
 ("lead", "动作"), ("li", "开通并认证自有微信公众号（元宝的第一信源）。"),
 ("li", "登记自有抖音号与今日头条号（供豆包补测后使用）。"),
 ("li", "确认可投放的专业医学媒体清单与资质。"),
 ("li", "同意在媒介集市通道接通后回补覆盖层「被新闻源收录」的核验。"),
 ("kv", "两条人工关卡：投放预算由甲方批准；稿件如带未关闭的临床安全问题则不下单。"),
])

S("⑯ 假设与口径", "每一条都可以一句话改", [
 ("table", {
   "head": ["事项", "取值", "怎么改"],
   "rows": [[f, v, h] for f, v, _b, h in D["assumptions"]] + [[i, s, d] for i, s, d in D["notDone"]],
 }),
 ("small", D["responseSample"]["disclosure"]),
])

html_slides = []
for i, s in enumerate(SLIDES, start=1):
    parts = [f'<section class="slide" id="s{i}" data-n="{i}">',
             f'<p class="kicker">{s["kicker"]}</p>',
             f'<h2>{s["title"]}</h2>']
    if s["note"]:
        parts.append(f'<p class="note">{s["note"]}</p>')
    for kind, payload in s["body"]:
        if kind == "lead":
            parts.append(f'<p class="lead">{payload}</p>')
        elif kind == "kv":
            parts.append(f'<p class="kv">{payload}</p>')
        elif kind == "li":
            parts.append(f'<p class="li">{payload}</p>')
        elif kind == "small":
            parts.append(f'<p class="small">{payload}</p>')
        elif kind == "table":
            head = "".join(f"<th>{h}</th>" for h in payload["head"])
            rows = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in payload["rows"])
            parts.append(f'<table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>')
    parts.append(f'<p class="foot">{FOOT}</p>')
    parts.append("</section>")
    html_slides.append("\n".join(parts))

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>信尔美（玛仕度肽注射液）· 循证 GEO 投入优化提案（结果版）</title>
<style>
:root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--accent:#1f4e79;--bg:#ffffff;--soft:#f8fafc}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
 font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,-apple-system,"Segoe UI",sans-serif}
#deck{scroll-snap-type:y mandatory;overflow-y:auto;height:100vh}
.slide{scroll-snap-align:start;min-height:100vh;padding:44px 60px 64px;display:flex;flex-direction:column;
 border-bottom:1px solid var(--line);position:relative}
.kicker{margin:0 0 6px;font-size:13px;letter-spacing:.12em;color:var(--accent);font-weight:700}
h2{margin:0 0 18px;font-size:30px;line-height:1.28;color:var(--accent);font-weight:800}
.lead{margin:10px 0 6px;font-size:19px;font-weight:700;line-height:1.5}
.kv{margin:5px 0;font-size:16px;line-height:1.62;color:var(--ink)}
.li{margin:4px 0 4px 20px;font-size:16px;line-height:1.62}
.li::before{content:"";display:inline-block;width:6px;height:6px;margin-right:10px;margin-bottom:2px;
 background:var(--accent);border-radius:50%}
.small,.note{margin:10px 0 0;font-size:13px;line-height:1.55;color:var(--muted)}
table{margin:10px 0 6px;border-collapse:collapse;width:100%;font-size:13.5px;line-height:1.45}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:var(--accent);color:#fff;font-weight:700}
tbody tr:nth-child(even){background:var(--soft)}
.foot{margin-top:auto;padding-top:18px;font-size:12px;color:var(--muted)}
#hud{position:fixed;right:18px;bottom:14px;font-size:12px;color:var(--muted);background:rgba(255,255,255,.9);
 border:1px solid var(--line);border-radius:999px;padding:4px 12px;z-index:5}
#bar{position:fixed;left:0;top:0;height:3px;background:var(--accent);width:0;z-index:6;transition:width .18s ease}
@media (prefers-reduced-motion:reduce){#deck{scroll-behavior:auto}}
@media (max-width:900px){.slide{padding:26px 20px 48px}h2{font-size:22px}table{font-size:12px}}
</style>
</head>
<body>
<div id="bar"></div>
<div id="deck">
__SLIDES__
</div>
<div id="hud"><span id="cur">1</span> / __TOTAL__</div>
<script>
(function(){
  var deck=document.getElementById('deck'),slides=[].slice.call(document.querySelectorAll('.slide')),
      bar=document.getElementById('bar'),cur=document.getElementById('cur'),i=0;
  function paint(){bar.style.width=((i+1)/slides.length*100)+'%';cur.textContent=String(i+1);}
  function go(n){i=Math.max(0,Math.min(slides.length-1,n));slides[i].scrollIntoView({behavior:'smooth',block:'start'});paint();}
  deck.addEventListener('scroll',function(){
    var top=deck.scrollTop,h=window.innerHeight;
    i=Math.max(0,Math.min(slides.length-1,Math.round(top/h)));paint();
  },{passive:true});
  document.addEventListener('keydown',function(e){
    if(['ArrowRight','ArrowDown','PageDown',' '].indexOf(e.key)>-1){e.preventDefault();go(i+1);}
    if(['ArrowLeft','ArrowUp','PageUp'].indexOf(e.key)>-1){e.preventDefault();go(i-1);}
    if(e.key==='Home'){e.preventDefault();go(0);}
    if(e.key==='End'){e.preventDefault();go(slides.length-1);}
  });
  var x0=null;
  deck.addEventListener('touchstart',function(e){x0=e.touches[0].clientX;},{passive:true});
  deck.addEventListener('touchend',function(e){
    if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;
    if(Math.abs(dx)>50){go(dx<0?i+1:i-1);}x0=null;
  },{passive:true});
  paint();
})();
</script>
</body>
</html>
"""
HTML = HTML.replace("__SLIDES__", "\n".join(html_slides)).replace("__TOTAL__", str(len(SLIDES)))

out = os.path.join(ROOT, "files", "05_GEO投入优化提案.html")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(HTML)
print("wrote", out, os.path.getsize(out), "bytes;", len(SLIDES), "slides")
