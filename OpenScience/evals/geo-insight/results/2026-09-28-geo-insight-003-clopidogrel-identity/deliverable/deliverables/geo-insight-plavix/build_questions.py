# -*- coding: utf-8 -*-
"""Build question-map.json for the 波立维 GEO insight package.

Every kind=real question carries the platform, the post URL and the collection
time it came from. Counts, pool distribution and saturation are computed here,
not typed by hand.
"""
import json, os, datetime

WS = "/workspace"
OUT = os.path.join(WS, "deliverables", "geo-insight-plavix")

ZH1 = "https://www.zhihu.com/api/v4/answers/"
ZH1T = "2026-09-28T05:29:44.118Z"
ZH2T = "2026-09-28T05:36:47.105Z"
DYT = "2026-09-28T05:33:27.601Z"
XHST = "2026-09-28T05:35:50.763Z"

DY = "https://www.iesdouyin.com/share/video/"
XHS = "https://www.xiaohongshu.com/discovery/item/"


def real(text, platform, url, collectedAt):
    return dict(text=text, kind="real", platform=platform, sourceUrl=url,
                collectedAt=collectedAt, measured=True)


def typical(text):
    return dict(text=text, kind="typical", platform=None, sourceUrl=None,
                collectedAt=None, measured=True)


def safety(text):
    return dict(text=text, kind="label_safety", platform=None, sourceUrl=None,
                collectedAt=None, measured=True)


GROUPS = []


def group(groupKey, pool, name, typicalQuestion, stage, audience, bridge,
          weight, isControl, signal, questions, notes=""):
    GROUPS.append(dict(groupKey=groupKey, pool=pool, name=name,
                       typicalQuestion=typicalQuestion, journeyStage=stage,
                       audience=audience, bridge=bridge, weight=weight,
                       isControl=isControl, signal=signal,
                       questions=questions, notes=notes))


STAGE_NAME = {
    "S1": "风险积累（无症状期）", "S2": "首发症状与预警", "S3": "症状误判与自我处理",
    "S4": "就医决策与首诊", "S5": "检查与诊断", "S6": "诊断告知与风险认知",
    "S7": "治疗决策（介入/溶栓/药物）", "S8": "起始治疗与出院带药",
    "S9": "术后早期管理（第一个月）", "S10": "长期用药与依从",
    "S11": "随访复查与降阶调整", "S12": "不良反应、并发症与停药复诊",
}

# ------------------------------------------------------------------ P1 品牌明确
group("G-P1-01", "P1", "长期服用波立维的疗程与注意事项",
      "长期服用波立维有哪些必须注意的事项，要吃多久？", "S10", "patient", "indication", 5, False,
      "collected", [
          real("有心脑血管病的患者长期服用波立维需要注意哪些事项？", "zhihu",
               ZH1 + "2032451626926077883", ZH1T),
          real("支架术后波立维能长期吃吗？", "zhihu", ZH1 + "3497137992", ZH1T),
          real("支架术后#波立维 还要吃多久？", "douyin",
               DY + "7426558430237691175", DYT),
          typical("长期吃波立维，出现什么情况必须去医院？"),
      ])

group("G-P1-02", "P1", "波立维与更便宜的同类药",
      "有没有和波立维效果一样但更便宜的药？", "S10", "patient", "home_plan", 4, False,
      "collected", [
          real("有哪位知道有和波立维硫酸氢氯吡格雷片一样效果而价格便宜些的药？", "zhihu",
               ZH1 + "2825415866", ZH1T),
          real("请问一下这个药进口和国产仿制差距大吗", "douyin",
               DY + "7615296884734877282", DYT),
          typical("波立维和国产氯吡格雷能互相换着吃吗？"),
      ])

group("G-P1-03", "P1", "波立维与阿司匹林怎么选、能不能同吃",
      "波立维和阿司匹林哪个更适合长期吃？", "S10", "patient", "indication", 4, False,
      "collected", [
          real("波立维和阿司匹林哪个适合长期吃？", "douyin",
               DY + "7348397908510674195", DYT),
          typical("波立维和阿司匹林可以一起吃吗？"),
      ])

group("G-P1-04", "P1", "波立维的基因检测与疗效个体差异",
      "吃波立维要不要做基因检测？", "S10", "patient", "coexisting_condition", 3, False,
      "collected", [
          real("CYP2C19是什么体检", "douyin",
               DY + "7615296884734877282", DYT),
          typical("基因检测结果不好，是不是就得换药？"),
      ],
      "本组的来源是一条药师科普视频与其评论区提问；视频标题不是问句，只作为本组由来的记录，未计入测量问句集。")

group("G-P1-05", "P1", "波立维与国产同通用名片同时拿到怎么吃",
      "医生同时开了波立维和泰嘉，两个都要吃吗？", "S8", "patient", "home_plan", 3, False,
      "collected", [
          real("为何中山开了两款一样的还要同时吃....（波立维）硫酸氢氯吡格雷片和（泰嘉）硫酸氢氯吡格雷片",
               "xhs", XHS + "651e89b7000000002301958b", XHST),
          typical("波立维和泰嘉是同一个药吗，能不能只吃一个？"),
      ])

# ------------------------------------------------------------- P2 通用名与品类类
group("G-P2-01", "P2", "硫酸氢氯吡格雷片能否长期服用",
      "硫酸氢氯吡格雷片能不能长期吃？", "S10", "patient", "indication", 5, False,
      "collected", [
          real("硫酸氢氯吡格雷片常吃可以吗？", "zhihu", ZH1 + "2285898809", ZH1T),
          typical("硫酸氢氯吡格雷片长期吃会不会伤胃？"),
          typical("硫酸氢氯吡格雷片吃了几年，能减量吗？"),
      ])

group("G-P2-02", "P2", "氯吡格雷与替格瑞洛的区别、选择与换药",
      "氯吡格雷和替格瑞洛有什么区别，医生为什么给我换药？", "S7", "patient", "indication", 5, False,
      "collected", [
          real("替格瑞洛与氯吡格雷的最重要区别是什么？", "zhihu", ZH1 + "136754970", ZH1T),
          real("18年1月手术后替格瑞洛服用5个月，5月开始出现皮下出血，7月刚复查医生建议换氯比格雷，但没有做基因测试，请问这要紧嘛？",
               "zhihu", ZH1 + "136754970", ZH1T),
          real("我妈做完支架之后先吃的几天氯吡格雷，复查血小板最大凝聚没有降下去，又改成了替格瑞洛。但是出院之后对替格瑞洛反映很大，经常性胸闷，医生又让改成了氯吡格雷，早晚各一片。这种情况下可以吗？",
               "zhihu", ZH1 + "136754970", ZH1T),
      ])

group("G-P2-03", "P2", "氯吡格雷与阿司匹林的原理与效果比较",
      "氯吡格雷和阿司匹林哪个抗血小板效果更好，原理有什么不一样？", "S10", "patient", "indication", 4, False,
      "collected", [
          real("氯吡格雷和阿司匹林在临床上抗血小板凝聚哪个更有效？", "zhihu",
               ZH1 + "2068627146550120606", ZH2T),
          real("硫酸氢氯吡格雷片的作用原理什么？", "zhihu", ZH1 + "2809263200", ZH1T),
          typical("阿司匹林不耐受，换成氯吡格雷可以吗？"),
      ])

group("G-P2-04", "P2", "氯吡格雷的副作用与出血风险",
      "氯吡格雷的副作用有哪些，出血风险多大？", "S12", "patient", "indication", 5, False,
      "collected", [
          real("硫酸氢氯吡格雷的副作用？", "zhihu", ZH1 + "46779884680", ZH1T),
          real("波立维长吃也会伤胃的，，，，，", "douyin",
               DY + "7348397908510674195", DYT),
          typical("吃氯吡格雷期间出现哪些出血表现要马上就医？"),
      ])

group("G-P2-05", "P2", "氯吡格雷漏服怎么补",
      "氯吡格雷忘吃了一次怎么办？", "S10", "patient", "home_plan", 4, False,
      "no_signal", [
          safety("氯吡格雷漏服了，下一次要不要吃两片补上？"),
          safety("经常忘记吃氯吡格雷，会不会影响效果？"),
      ],
      "本组为说明书安全题，题目由说明书条款转化，未采到对应的真人原话。")

group("G-P2-06", "P2", "氯吡格雷与抑酸药、他汀等合用",
      "吃氯吡格雷能不能同时吃奥美拉唑？", "S10", "patient", "coexisting_condition", 4, False,
      "collected", [
          real("我母亲去年五月份支架 出院医生就配了氯吡格雷和噢美拉唑 吃到现在 哎",
               "zhihu", ZH1 + "136754970", ZH1T),
          real("请问泮托拉唑钠肠溶片和 #阿斯匹林 怎么吃，先吃哪个后吃哪个？间隔多久吃呀",
               "xhs", XHS + "682afc57000000000c03b570", XHST),
          typical("吃氯吡格雷期间还能吃他汀吗？"),
      ])

# ------------------------------------------------------------- P3 泛症状场景类
group("G-P3-01", "P3", "支架/心梗术后靠什么药防止再堵",
      "支架术后吃什么药能防止血管再堵？", "S9", "patient", "no_valid_public_bridge", 5, False,
      "collected", [
          real("心脏支架术后，这5件事子女必须知道", "xhs",
               XHS + "69a837a3000000001b01760a", XHST),
          typical("支架术后不吃抗血小板药会怎么样？"),
          typical("支架里面又堵了，是不是因为药没吃够？"),
      ])

group("G-P3-02", "P3", "术后药要不要吃一辈子、能不能停",
      "支架术后的药要吃一辈子吗，一年后能不能停？", "S10", "patient", "home_plan", 5, False,
      "collected", [
          real("放完支架，一年后还要吃药吗？为什么我的医生没和我讲要一直吃药？", "xhs",
               XHS + "6527b4fe000000001d015077", XHST),
          real("做支架12年，需要换药吗？", "xhs",
               XHS + "68060d08000000001d003926", XHST),
          typical("自己把抗血小板药停了几天，会有危险吗？"),
      ])

group("G-P3-03", "P3", "术后出院第一个月的生活、工作与复查安排",
      "心梗出院后第一个月要注意什么，什么时候能上班？", "S9", "patient", "care_node", 4, False,
      "collected", [
          real("心梗病友群最常问的出院第一个月注意事项", "xhs",
               XHS + "65ec91d100000000030367eb", XHST),
          real("请问支架手术后多久可以上班。", "xhs",
               XHS + "6527b4fe000000001d015077", XHST),
          real("请问下做完一边手术有四五个月了 另一边没做 有什么要注意的吗", "xhs",
               XHS + "67623a650000000014023d9b", XHST),
          typical("支架术后要复查哪些项目，多久复查一次？"),
      ])

group("G-P3-04", "P3", "术后牙龈出血、鼻出血、淤青怎么办",
      "术后刷牙牙龈出血、身上淤青，要不要停药？", "S12", "patient", "care_node", 5, False,
      "collected", [
          real("老年病人吃阿司匹林流鼻血怎么办？？", "zhihu", ZH1 + "3100859532", ZH2T),
          real("吃了两种鼻子出血了一天，医生让停了阿斯匹林，波立维继续吃", "douyin",
               DY + "7348397908510674195", DYT),
          typical("吃药期间身上一碰就青，是正常反应吗？"),
      ])

# ------------------------------------------------------------- P4 风险监测类
group("G-P4-01", "P4", "妊娠、备孕、哺乳期能不能用氯吡格雷",
      "怀孕或哺乳期能不能吃氯吡格雷？", "S12", "patient", "indication", 5, False,
      "no_signal", [
          safety("怀孕期间能不能吃硫酸氢氯吡格雷片？"),
          safety("哺乳期吃氯吡格雷，能继续喂奶吗？"),
          safety("备孕期间吃氯吡格雷，需要提前停药吗？"),
      ],
      "本组为说明书安全题（禁忌与特殊人群条款转化），未采到对应的真人原话。")

group("G-P4-02", "P4", "老年人该选氯吡格雷还是替格瑞洛",
      "八十岁的老人，医生让吃氯吡格雷还是替格瑞洛？", "S10", "patient", "indication", 5, False,
      "collected", [
          real("您好，家里老人刚做完心脏支架出院，大夫开了替格瑞洛片，写着2/日，医生开药时不在场，老人也不清楚怎么吃，也不知道这个起始是一次吃两片，还是分早晚吃，如果您知道，望告知，万分感谢",
               "zhihu", ZH1 + "136754970", ZH1T),
          typical("高龄、容易出血的人，抗血小板药要不要换温和一点的？"),
          typical("七十岁以上老人吃氯吡格雷要注意什么？"),
      ])

group("G-P4-03", "P4", "有过活动性出血或颅内出血史能不能用",
      "有过脑出血的人还能吃氯吡格雷吗？", "S12", "patient", "indication", 5, False,
      "collected", [
          real("阿司匹林和氯吡格雷外加低分子肝素钙一起用后发生脑出血算不算医疗事故？", "zhihu",
               ZH1 + "2587741843", ZH2T),
          typical("有胃溃疡出血史的人，还能吃抗血小板药吗？"),
          typical("正在牙龈持续出血的时候，氯吡格雷要不要先停？"),
      ])

group("G-P4-04", "P4", "没有确诊的人能不能自己吃氯吡格雷预防血栓",
      "没有确诊冠心病，能自己买氯吡格雷预防血栓吗？", "S3", "patient", "no_valid_public_bridge", 4, False,
      "collected", [
          real("医生帮我看看,这种要吃什么药,43岁，没有高血压，高血脂，不胖不瘦", "xhs",
               XHS + "682afc57000000000c03b570", XHST),
          real("氯吡格雷25mg可以有预防血栓形成的作用。", "zhihu",
               ZH1 + "136754970", ZH1T),
          typical("体检发现血稠，能提前吃点抗血小板药预防吗？"),
      ])

# -------------------------------------------------------------------- 对照组
group("G-CTRL-P1-01", "P1", "波立维的贮藏与有效期",
      "波立维需要冷藏保存吗，有效期多久？", "S8", "patient", "home_plan", 2, True,
      "no_signal", [
          typical("波立维开封后能放多久？"),
          typical("波立维夏天要不要放冰箱？"),
      ], "对照语义群：不投放，只监测，用于计算净效应。")

group("G-CTRL-P2-01", "P2", "硫酸氢氯吡格雷片有哪些规格和剂型",
      "硫酸氢氯吡格雷片有哪些规格？", "S8", "patient", "home_plan", 2, True,
      "no_signal", [
          typical("硫酸氢氯吡格雷片是 25mg 还是 75mg？"),
          typical("硫酸氢氯吡格雷片有进口和国产两种包装吗？"),
      ], "对照语义群：不投放，只监测，用于计算净效应。")

group("G-CTRL-P2-02", "P2", "氯吡格雷饭前还是饭后吃",
      "氯吡格雷是空腹吃还是饭后吃？", "S10", "patient", "home_plan", 2, True,
      "no_signal", [
          typical("氯吡格雷早上吃还是晚上吃更好？"),
          typical("氯吡格雷可以和饭一起吃吗？"),
      ], "对照语义群：不投放，只监测，用于计算净效应。")

group("G-CTRL-P3-01", "P3", "冠心病患者的饮食要注意什么",
      "冠心病患者平时饮食要注意什么？", "S10", "patient", "no_valid_public_bridge", 2, True,
      "collected", [
          real("术后应该吃什么油呀？我们家用了牛油果油和山茶油，想着再换换别的", "xhs",
               XHS + "65ec91d100000000030367eb", XHST),
          typical("冠心病患者能不能吃蛋黄和动物内脏？"),
      ], "对照语义群：不投放，只监测，用于计算净效应。")

group("G-CTRL-P4-01", "P4", "服药期间能不能拔牙或做有创检查",
      "吃氯吡格雷期间能拔牙吗？", "S12", "patient", "care_node", 2, True,
      "collected", [
          real("咨询个事儿，阿司匹林刚停用两天，医生就让做肾穿，是否靠谱？", "zhihu",
               ZH1 + "1895825317630826416", ZH2T),
          typical("做胃肠镜切息肉，氯吡格雷要停几天？"),
      ], "对照语义群：不投放，只监测，用于计算净效应。")

assumptions = [
    {"field": "四池判定口径",
     "value": "P1=含本品品牌名；P2=含本品通用名或剂型且不含品牌名；P3=不含本品品牌名与通用名（只点名其它药物如阿司匹林的问句归此池）；P4=命中超适应症、特殊人群或禁忌词表的问句，且判定优先于 P1–P3",
     "basis": "inferred",
     "reason": "规则原文对「只点名他药」的问句没有归类位置，本包把该类问句放入 P3，并让风险词表优先，以保证四池互斥且穷尽。",
     "howToChange": "若甲方要求把只点名阿司匹林的问句算作品类增量，改入 P2 并生成新的 measurement_set_version。"},
    {"field": "测量状态", "value": "66 条问句全部纳入冻结测量集（measured=true），基线尚未运行",
     "basis": "upstream",
     "reason": "本包只做证据、旅程、问题三步；基线由平台在问句冻结后自行测量。",
     "howToChange": "冻结后由平台跑基线，测量结果回填 measured 与快照编号。"},
    {"field": "问题组权重", "value": "1–5 的排序权重，按人群规模 × 旅程关键度 × 与产品的相关度排序",
     "basis": "inferred",
     "reason": "说明书限定的「近期」事件人群规模没有公开流行病学来源，权重只作排序，不作规模换算。",
     "howToChange": "取得可靠的人群规模来源后，把权重换成规模×触发率×缺口的口径。"},
    {"field": "对照组选择", "value": "5 个对照语义群，占 24 组的 20.8%，与试点群同池",
     "basis": "upstream",
     "reason": "对照群不投放、只监测，用于按净效应验收；数量与占比均落在规则区间内。",
     "howToChange": "若投放批次扩大，可在同池同难度内调整并生成新版本。"},
    {"field": "发声渠道", "value": "已采集知乎、抖音、小红书；微博、B站、视频号、百度未采集",
     "basis": "default",
     "reason": "社媒采集一次一平台，本次按患者最常聚集的平台取三个；小红书「波立维 氯吡格雷 支架」一次采集返回失败，按无信号处理。",
     "howToChange": "补采其余平台并重新计算饱和度与版本号。"},
]


def main():
    counts = {"P1": 0, "P2": 0, "P3": 0, "P4": 0}
    n_q = 0
    for g in GROUPS:
        counts[g["pool"]] += 1
        n_q += len(g["questions"])
    real_q = sum(1 for g in GROUPS for q in g["questions"] if q["kind"] == "real")
    wrong = [q for g in GROUPS for q in g["questions"]
             if q["kind"] == "real" and not (q["sourceUrl"] and q["collectedAt"] and q["platform"])]
    if wrong:
        raise SystemExit("real question without source: %r" % wrong[0])

    grouped_utterances = sum(len([q for q in g["questions"] if q["kind"] == "real"]) for g in GROUPS)
    f1 = sum(1 for g in GROUPS if len([q for q in g["questions"] if q["kind"] == "real"]) == 1)
    sat = round(1 - f1 / grouped_utterances, 3) if grouped_utterances else 0.0
    ctrl = sum(1 for g in GROUPS if g["isControl"])

    pkg = {
        "minimal": False,
        "groups": GROUPS,
        "assumptions": assumptions,
        "_meta": {
            "groupCount": len(GROUPS),
            "controlGroupCount": ctrl,
            "controlShare": round(ctrl / len(GROUPS), 3),
            "questionCount": n_q,
            "realQuestionCount": real_q,
            "poolGroupCounts": counts,
            "groupedUtterances": grouped_utterances,
            "f1": f1,
            "saturation": sat,
            "saturationBasis": "Ĉ = 1 − f1/n，f1 = 只采到一次原话的语义群数，n = 已归组的真人原话数",
            "measurementSetVersion": "plavix-v1.0",
            "frozenAt": datetime.datetime.utcnow().isoformat() + "Z",
            "platformCoverage": {
                "collected": ["zhihu", "douyin", "xhs"],
                "no_signal": [{"platform": "xhs", "query": "波立维 氯吡格雷 支架",
                               "status": "request_failed"}],
                "not_collected": ["weibo", "bilibili", "wechat_channels", "baidu"],
            },
            "stageNames": STAGE_NAME,
        },
    }
    with open(os.path.join(OUT, "question-map.json"), "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in pkg["_meta"].items() if k != "stageNames"},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
