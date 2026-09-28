# -*- coding: utf-8 -*-
"""Build claims.json for the 波立维 GEO insight package.

Every quote is checked as a literal substring of the preserved source file it
names; the script refuses to write a claim whose quote cannot be located.
"""
import json, os, re, sys, hashlib, datetime

WS = "/workspace"
OUT = os.path.join(WS, "deliverables", "geo-insight-plavix")

A = ".evimed-sources/drug-labels/455270100abc83b4/eeaa16ca08012a29d2350512bf587b69c985c0c11e3c81bbfb1ce661d22b638c"
B = ".evimed-sources/drug-labels/222d7584bbf282ac/9c10fb04239ddfb554fbb65266b88ae7f9af5a635d4154c2dda31c49596dd12e"
C = ".evimed-sources/drug-labels/ba50281757bdb588/fc490f3612721b0284dc6d010d454a404baa8fe1e6dd61b1cc19151dbc610a65"
D = ".evimed-sources/drug-labels/5a10253ee0470112/fe474f8c6953001567aeca268bd3821a976e46f0511b3c55e27b8199bae138d6"
E = ".evimed-sources/evimed-guidelines/be4a81bb078630eb/653c56eac5a5fdb66428f9f31387e15fcf9947b0902b3cd48ab17c95d993ac68"
F = ".evimed-sources/evimed-guidelines/00366ec0605bf45d/241308b3fddad9e2df33a60a1955841abd916207b13f51f7b3fc4ce4067383d4"
G = ".evimed-sources/web-pages/b63e9a5cc2e22237/bbcd7a65e01b228c42afdb01a61b712bb969f5413a9ecde06d63c3a53036516c"
H = {
    "38018129": ".evimed-sources/pubmed/PMID38018129/c1f34d618faa2c48437eb329f554074aaf2f09ed8c4e129d57618d81fda38fb6",
    "23900047": ".evimed-sources/pubmed/PMID23900047/b423d7d7af9574f56bfda788d1fb9ce159f94f52c9265cd6a3ef7b00f2955d08",
    "31553203": ".evimed-sources/pubmed/PMID31553203/c750376e64c0fbabc2d026ebeffbfa0a3b56915571d95390235e929d8d57d0a9",
    "29094604": ".evimed-sources/pubmed/PMID29094604/48e779a14ea89775bdd49ea0ea87c26a31e82315bfb8c713f3dfcacfd8284558",
    "40164463": ".evimed-sources/pubmed/PMID40164463/78d0211f394a05a270a8e7a3905a421cf9f2c7ded3025de0fd58b28b936d3390",
    "21685437": ".evimed-sources/pubmed/PMID21685437/0406dca312187793f3a1cfa738ade4def86cb61b544a6d8b09c08312163884cb",
}

VERIFIED = "2026-09-28"
VALID_UNTIL = "2027-09-28"   # 下一次说明书修订 / 指南更新 / 年度复核，以先到者为准

# key: claimKey -> dict
CLAIMS = []
def add(ck, statement, artifact, quote, sourceRef, sourceKind, level, population,
        in_label, elements, audience="patient+physician", allowed=None):
    CLAIMS.append(dict(
        claimKey=ck, statement=statement, quote=quote, sourceRef=sourceRef,
        sourceKind=sourceKind, artifactPath=artifact, evidenceLevel=level,
        population=population, inLabel=in_label, elements=elements,
        audience=audience,
        allowedLayers=allowed or (["deep_analysis", "evidence_card", "popular_article", "qa"]
                                 if in_label else ["deep_analysis", "evidence_card"]),
        verifiedAt=VERIFIED, validUntil=VALID_UNTIL,
    ))

def ELEM(n, v, u, c, ch, ind, pop="n/a"):
    return dict(sourceLevel=n, version=v, updatedAt=u, evidenceFileNo=c,
                chaser=ch, independentSourceCount=ind,
                reviewer="unconfirmed", populationMatch=pop)


SOURCE_LABELS = {
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）":
        "硫酸氢氯吡格雷片（波立维）说明书，赛诺菲，批准文号 国药准字HJ20171237（进口版）",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）":
        "硫酸氢氯吡格雷片（波立维）说明书，赛诺菲(杭州)制药有限公司，批准文号 国药准字H20056410（国产版）",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）":
        "硫酸氢氯吡格雷片（泰嘉）说明书，深圳信立泰药业股份有限公司，批准文号 国药准字H20000542",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）":
        "替格瑞洛片（倍林达）说明书，阿斯利康，批准文号 国药准字HJ20171037",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会":
        "《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》":
        "《2022 CPIC 指南：CYP2C19 基因型与氯吡格雷治疗（更新版）》，临床药物基因组学实施联盟",
    "DailyMed：CLOPIDOGREL 片剂说明书（美国，Aurobindo Pharma，2024-05-17 修订）":
        "美国 CLOPIDOGREL 片剂说明书（DailyMed 公开文本，2024-05-17 修订）",
    "PMID 23900047（Circulation 2013，PLATO 支架内血栓分析）":
        "Steg 等，《Circulation》2013，PLATO 试验支架内血栓分析（PMID 23900047）",
    "PMID 21685437（BMJ 2011，PLATO 非侵入治疗亚组）":
        "James 等，《BMJ》2011，PLATO 非侵入治疗亚组（PMID 21685437）",
    "PMID 31553203（Circulation 2019，韩国多中心 RCT，n=800）":
        "Park 等，《Circulation》2019，韩国多中心随机对照试验（PMID 31553203）",
    "PMID 29094604（J Comp Eff Res，东亚 ACS 随机试验荟萃分析）":
        "Wu 等，《Journal of Comparative Effectiveness Research》，东亚人群随机试验荟萃分析（PMID 29094604）",
    "PMID 40164463（CMAJ 2025，TC4 随机对照试验）":
        "Kutcher 等，《CMAJ》2025，TC4 随机对照试验（PMID 40164463）",
    "PMID 38018129（Chinese Medical Journal 2023，中国心血管健康与疾病报告 2022 概要）":
        "Summary of the 2022 Report on Cardiovascular Health and Diseases in China（《中国心血管健康与疾病报告 2022》概要，PMID 38018129）",
}

# ---------------------------------------------------------------- 波立维说明书
add("PLV-01-LABEL-IND",
    "波立维（硫酸氢氯吡格雷片）说明书载明的适应症为动脉粥样硬化血栓形成事件的二级预防，覆盖近期心肌梗死、近期缺血性卒中与确诊外周动脉性疾病三类人群。",
    A + "/indications.md",
    "氯吡格雷用于以下患者的动脉粥样硬化血栓形成事件的二级预防：近期心肌梗死患者（从几天到小于35天），近期缺血性卒中患者（从7天到小于6个月）或确诊外周动脉性疾病的患者。",
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）", "label", "基准事实层（法定说明书）",
    "近期心肌梗死（从几天到小于35天）、近期缺血性卒中（从7天到小于6个月）、确诊外周动脉性疾病",
    True, ELEM("法定说明书", "进口版", "2025-12-17 快照导出", "label:国药准字HJ20171237#indications", "not_required", 1, "n/a"))

add("PLV-02-LABEL-ACS-NSTE",
    "说明书的非ST段抬高型急性冠脉综合征条款要求与阿司匹林合用，并明确包括经皮冠状动脉介入术后置入支架的患者。",
    A + "/indications.md",
    "非ST段抬高型急性冠脉综合征（包括不稳定性心绞痛或非Q波心肌梗死），包括经皮冠状动脉介入术后置入支架的患者，与阿司匹林合用。",
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）", "label", "基准事实层（法定说明书）",
    "非ST段抬高型急性冠脉综合征（含 PCI 术后置入支架者），与阿司匹林合用",
    True, ELEM("法定说明书", "进口版", "2025-12-17 快照导出", "label:国药准字HJ20171237#indications", "not_required", 1, "n/a"))

add("PLV-03-LABEL-ACS-STEMI",
    "说明书的ST段抬高型急性冠脉综合征条款允许与阿司匹林联合，并可合并在溶栓治疗中使用。",
    A + "/indications.md",
    "用于ST段抬高型急性冠脉综合征患者，与阿司匹林联合，可合并在溶栓治疗中使用。",
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）", "label", "基准事实层（法定说明书）",
    "ST段抬高型急性冠脉综合征，与阿司匹林联合，可与溶栓合并使用",
    True, ELEM("法定说明书", "进口版", "2025-12-17 快照导出", "label:国药准字HJ20171237#indications", "not_required", 1, "n/a"))

add("PLV-04-LABEL-DOSE",
    "波立维说明书的推荐剂量为 75mg 每日一次，与或不与食物同服。",
    A + "/dosage.md",
    "氯吡格雷的推荐剂量为75mg每日一次。口服，与或不与食物同服。",
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）", "label", "基准事实层（法定说明书）",
    "成人与老年人，75mg 每日一次",
    True, ELEM("法定说明书", "进口版", "2025-12-17 快照导出", "label:国药准字HJ20171237#dosage", "not_required", 1, "n/a"))

add("PLV-05-LABEL-CONTRA",
    "国产文号说明书的【禁忌】为四条：对活性物质或本品任一成份过敏、严重肝脏损伤、活动性病理性出血（如消化性溃疡或颅内出血）、哺乳。进口文号说明书的同一栏只列前三条。",
    B + "/contraindications.md",
    "1.对活性物质或本品任一成份过敏。\n2.严重肝脏损伤。\n3.活动性病理性出血，如消化性溃疡或颅内出血。\n4.哺乳（参见妊娠和哺乳）。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "全部拟用人群",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#contraindications", "not_required", 1, "n/a"))

add("PLV-06-LABEL-SURGERY-7D",
    "说明书要求在择期手术前停用氯吡格雷 7 天以上（抗血小板治疗并非必须时）。",
    B + "/precautions.md",
    "在需要进行择期手术的患者，如抗血小板治疗并非必须，则应在术前停用氯吡格雷7天以上。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "需要择期手术的用药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-07-LABEL-BLEED-MONITOR",
    "说明书要求在治疗过程中一旦出现出血的临床症状，应立即考虑血细胞计数和/或其他适当检查。",
    B + "/precautions.md",
    "由于出血和血液学不良反应的危险性，在治疗过程中一旦出现出血的临床症状，就应立即考虑进行血细胞计数和/或其它适当的检查。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "全部用药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-08-LABEL-REPORT-BLEED",
    "说明书要求告知患者服药期间止血时间可能延长，并向医生报告异常出血的部位和时间。",
    B + "/precautions.md",
    "应告诉患者，当他们服用氯吡格雷（单用或与阿司匹林合用）时止血时间可能比往常长，同时病人应向医生报告异常出血情况（部位和出血时间）。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "全部用药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-09-LABEL-TTP",
    "说明书载明应用氯吡格雷后极少出现血栓性血小板减少性紫癜（TTP），有时在用药后短时间内出现。",
    B + "/precautions.md",
    "应用氯吡格雷后极少出现血栓性血小板减少性紫癜（TTP），有时在用药后短时间内出现。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "全部用药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-10-LABEL-TTP-EMERGENCY",
    "说明书写明 TTP 可能威胁病人生命，需要立即采取血浆置换等紧急治疗。",
    B + "/precautions.md",
    "TTP可能威胁病人的生命，需要立即采取血浆置换等紧急治疗。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "全部用药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-11-LABEL-WARFARIN",
    "说明书不推荐氯吡格雷与华法林合用，原因是可能使出血加重。",
    B + "/precautions.md",
    "因可能使出血加重，不推荐氯吡格雷与华法林合用。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "合并使用华法林的患者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-12-LABEL-STROKE-7D",
    "说明书载明因缺乏研究数据，急性缺血性卒中（7天之内）患者不推荐使用氯吡格雷。",
    B + "/precautions.md",
    "因缺乏有关研究数据，急性缺血性卒中（7天之内）患者不推荐使用氯吡格雷。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "急性缺血性卒中发作 7 天内的患者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-13-LABEL-STEMI-EARLY",
    "说明书载明因缺乏研究数据，ST段抬高型心肌梗死的最初几天不应开始氯吡格雷治疗。",
    B + "/precautions.md",
    "因缺乏有关研究数据，在伴有ST段抬高的急性心肌梗死患者，心肌梗死的最初几天不应开始氯吡格雷治疗。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "ST段抬高型心肌梗死最初几天的患者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-14-LABEL-RENAL",
    "说明书载明肾功能损害患者应用氯吡格雷的经验有限，应慎用。",
    B + "/precautions.md",
    "肾功能损害患者应用氯吡格雷的经验有限，所以这些患者应慎用氯吡格雷。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "肾功能损害患者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-15-LABEL-HEPATIC",
    "说明书载明对可能有出血倾向的中度肝脏疾病患者应慎用氯吡格雷。",
    B + "/precautions.md",
    "对于可能有出血倾向的中度肝脏疾病患者，由于对这类病人使用氯吡格雷的经验有限，因此应慎用氯吡格雷。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "中度肝脏疾病伴出血倾向者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#precautions", "not_required", 1, "n/a"))

add("PLV-16-LABEL-PREGNANCY",
    "说明书载明怀孕期应避免给怀孕期妇女使用氯吡格雷。",
    B + "/pregnancy-lactation.md",
    "怀孕期因尚无临床上提供的有关用于妊娠的资料，谨慎起见，应避免给怀孕期妇女使用。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "妊娠期妇女",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#pregnancy-lactation", "not_required", 1, "n/a"))

add("PLV-17-LABEL-PEDIATRIC",
    "说明书载明尚无在儿童中使用氯吡格雷的经验。",
    B + "/pediatric.md",
    "尚无在儿童中使用的经验。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "儿童",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#pediatric", "not_required", 1, "n/a"))

add("PLV-18-LABEL-MOA",
    "说明书载明氯吡格雷选择性抑制 ADP 与其血小板受体的结合及继发的 ADP 介导的糖蛋白 GPⅡb/Ⅲa 复合物活化，从而抑制血小板聚集。",
    B + "/pharmacology-toxicology.md",
    "氯吡格雷是一种血小板聚集抑制剂，选择性地抑制二磷酸腺苷(ADP)与它的血小板受体的结合及继发的ADP介导的糖蛋白GPⅡb/Ⅲa复合物的活化，因此可抑制血小板聚集。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "不限",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#pharmacology-toxicology", "not_required", 1, "n/a"))

add("PLV-19-LABEL-PD",
    "说明书载明 75mg 每日一次重复给药后 3–7 天达到稳态，稳态时平均血小板聚集抑制水平为 40%–60%，停药后 5 天内逐渐回到基线。",
    B + "/pharmacology-toxicology.md",
    "氯吡格雷75mg，每日一次重复给药，从第一天开始明显抑制ADP诱导的血小板聚集，抑制作用逐步增强并在3-7天达到稳态。在稳态时，每天服用氯吡格雷75mg的平均抑制水平为40%-60%,一般在中止治疗后5天内血小板聚集和出血时间逐渐回到基线水平。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "按 75mg 每日一次服药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#pharmacology-toxicology", "not_required", 1, "n/a"))

add("PLV-20-LABEL-PRODRUG",
    "说明书载明氯吡格雷是一种前体药，需经氧化与水解形成活性代谢物，氧化作用主要由细胞色素 P450 同功酶 2B6 和 3A4 调节，1A1、1A2 和 2C19 也有一定作用。",
    B + "/pharmacokinetics.md",
    "氯吡格雷是一种前体药。氯吡格雷经氧化生成2-氧基-氯吡格雷，继之水解形成活性代谢物（一种硫醇衍生物）。氧化作用主要由细胞色素P450同功酶2B6和3A4调节，1A1，1A2和2C19也有一定的调节作用。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "不限",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#pharmacokinetics", "not_required", 1, "n/a"))

add("PLV-21-LABEL-NSAID",
    "说明书提示氯吡格雷与非甾体抗炎药合用时胃肠潜血损失增加，应小心。",
    B + "/interactions.md",
    "3.非甾体抗炎药(NSAIDs)：健康志愿者同时服用本品和萘普生，胃肠潜血损失增加，故本品与NSAIDs合用时应小心。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "合并使用非甾体抗炎药者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#interactions", "not_required", 1, "n/a"))

add("PLV-22-LABEL-ASA-COMBO",
    "说明书载明氯吡格雷可增加阿司匹林对胶原引起的血小板聚集的抑制效果，长期合并用药的安全性无进一步研究资料。",
    B + "/interactions.md",
    "1.阿司匹林：本品增加阿司匹林对胶原引起的血小板聚集的抑制效果，长期合并用药的安全性无进一步的研究资料。",
    "label:国药准字H20056410（国产版说明书，赛诺菲(杭州)）", "label", "基准事实层（法定说明书）",
    "与阿司匹林联用者",
    True, ELEM("法定说明书", "国产版", "2021-05-17 快照文件日期", "label:国药准字H20056410#interactions", "not_required", 1, "n/a"))

add("PLV-23-LABEL-IMPORT-EXIST",
    "进口批准文号说明书快照记录的规格为「进口版 75mg*90片」。",
    A + "/specification.md",
    "进口版 75mg*90片",
    "label:国药准字HJ20171237（进口版说明书，赛诺菲）", "label", "基准事实层（法定说明书）",
    "不限",
    True, ELEM("法定说明书", "进口版", "2025-12-17 快照导出", "label:国药准字HJ20171237#specification", "not_required", 1, "n/a"))

# ------------------------------------------------------------ 国产同通用名（竞品）
add("GEN-01-LABEL-IND",
    "国产硫酸氢氯吡格雷片的适应症措辞与波立维同源，覆盖近期心肌梗死、近期缺血性卒中、确诊外周动脉性疾病与急性冠脉综合征。",
    C + "/indications.md",
    "氯吡格雷用于以下患者，预防动脉粥样硬化血栓形成事件：近期心肌梗死患者(从几天到小于35天)，近期缺血性卒中患者(从7天到小于6个月)或确诊外周动脉性疾病的患者。",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）", "label", "基准事实层（法定说明书）",
    "同波立维适应症人群",
    False, ELEM("法定说明书", "泰嘉", "2025-12-17 快照导出", "label:国药准字H20000542#indications", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("GEN-02-LABEL-STRENGTH-25MG",
    "国产硫酸氢氯吡格雷片存在 25mg 规格（泰嘉 25mg*20片*3板），与波立维在境内主要销售的 75mg 规格不同。",
    C + "/specification.md",
    "25mg*20片*3板",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）", "label", "基准事实层（法定说明书）",
    "不限",
    False, ELEM("法定说明书", "泰嘉", "2025-12-17 快照导出", "label:国药准字H20000542#specification", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("GEN-03-LABEL-MISSED-DOSE",
    "泰嘉说明书给出漏服处理：常规服药时间 12 小时内漏服应立即补服一次标准剂量；超过 12 小时则在下次常规时间服标准剂量，无需剂量加倍。本地留存的波立维说明书快照未见对应条款。",
    C + "/dosage.md",
    "如果漏服：在常规服药时间的12小时之内漏服：患者应立即补服一次标准剂量，并按照常规服药时间服用下一次剂量；超过常规服药时间12小时之后漏服：患者应在下次常规服药时间服用标准剂量，无需剂量加倍。",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）", "label", "基准事实层（法定说明书）",
    "全部用药者",
    False, ELEM("法定说明书", "泰嘉", "2025-12-17 快照导出", "label:国药准字H20000542#dosage", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("GEN-04-LABEL-ELDERLY-LOAD",
    "泰嘉说明书载明 ST 段抬高型急性心肌梗死患者年龄超过 75 岁时不使用氯吡格雷负荷剂量。",
    C + "/dosage.md",
    "对于年龄超过75岁的患者，不使用氯吡格雷负荷剂量。",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）", "label", "基准事实层（法定说明书）",
    "≥75 岁的 STEMI 患者",
    False, ELEM("法定说明书", "泰嘉", "2025-12-17 快照导出", "label:国药准字H20000542#dosage", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("GEN-05-LABEL-DAPT-12M",
    "泰嘉说明书载明急性冠脉综合征患者以 300mg 负荷量开始后 75mg 每日一次，临床试验资料支持用药 12 个月。",
    C + "/dosage.md",
    "应以单次负荷量氯吡格雷300mg开始(合用阿司匹林75mg-325mg/日)，然后以75mg每日1次连续服药。",
    "label:国药准字H20000542（泰嘉说明书，深圳信立泰）", "label", "基准事实层（法定说明书）",
    "非ST段抬高型急性冠脉综合征患者",
    False, ELEM("法定说明书", "泰嘉", "2025-12-17 快照导出", "label:国药准字H20000542#dosage", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

# ------------------------------------------------------------------ 倍林达（竞品）
add("TGR-01-LABEL-IND",
    "倍林达（替格瑞洛片）说明书适应症为急性冠脉综合征患者，包括接受药物治疗和经皮冠状动脉介入治疗的患者，用于降低血栓性心血管事件发生率。",
    D + "/indications.md",
    "用于急性冠脉综合征(不稳定性心绞痛、非ST段抬高心肌梗死或ST段抬高心肌梗死)患者，包括接受药物治疗和经皮冠状动脉介入(PCI)治疗的患者，降低血栓性心血管事件的发生率。",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）", "label", "基准事实层（法定说明书）",
    "急性冠脉综合征患者（含药物治疗与 PCI 治疗）",
    False, ELEM("法定说明书", "倍林达", "2025-12-17 快照导出", "label:国药准字HJ20171037#indications", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("TGR-02-LABEL-DOSE",
    "倍林达说明书载明起始剂量为单次负荷量 180mg，此后每次 1 片每日两次，应与阿司匹林联合用药。",
    D + "/dosage.md",
    "本品起始剂量为单次负荷量180mg，此后每次1片，每日两次。除非有明确禁忌，本品应与阿司匹林联合用药。",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）", "label", "基准事实层（法定说明书）",
    "急性冠脉综合征患者",
    False, ELEM("法定说明书", "倍林达", "2025-12-17 快照导出", "label:国药准字HJ20171037#dosage", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("TGR-03-LABEL-CONTRA",
    "倍林达说明书的禁忌包括有颅内出血病史者、中-重度肝脏损害患者，以及禁止与强效 CYP3A4 抑制剂联合用药。",
    D + "/contraindications.md",
    "3.有颅内出血病史者。4.中-重度肝脏损害患者。5.因联合用药可导致替格瑞洛的暴露量大幅度增加，禁止替格瑞洛片与强效CYP3A4抑制剂(如:酮康唑、克拉霉素、奈法唑酮、利托那韦和阿扎那韦)联合用药。",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）", "label", "基准事实层（法定说明书）",
    "拟用替格瑞洛的患者",
    False, ELEM("法定说明书", "倍林达", "2025-12-17 快照导出", "label:国药准字HJ20171037#contraindications", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("TGR-04-LABEL-ADR",
    "倍林达说明书列举的不良反应包含脑出血、颅内出血、出血性卒中，以及呼吸困难（劳力性、静息时、夜间）。",
    D + "/adverse-reactions.md",
    "2.脑出血，颅内出血, 出血性卒中。3.呼吸困难，劳力性呼吸困难, 静息时呼吸困难, 夜间呼吸困难。",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）", "label", "基准事实层（法定说明书）",
    "使用替格瑞洛的患者",
    False, ELEM("法定说明书", "倍林达", "2025-12-17 快照导出", "label:国药准字HJ20171037#adverse-reactions", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

add("TGR-05-LABEL-STOP-7D",
    "倍林达说明书要求择期手术患者在术前 7 天停用替格瑞洛，并载明停用会增加心肌梗死、支架血栓和死亡风险。",
    D + "/precautions.md",
    "对于实施择期手术的患者，如果抗血小板药物治疗不是必须的，应在术前7天停止使用替格瑞洛。",
    "label:国药准字HJ20171037（倍林达说明书，阿斯利康）", "label", "基准事实层（法定说明书）",
    "需择期手术的替格瑞洛使用者",
    False, ELEM("法定说明书", "倍林达", "2025-12-17 快照导出", "label:国药准字HJ20171037#precautions", "not_required", 1, "n/a"),
    allowed=["deep_analysis", "evidence_card"])

# ---------------------------------------------------------------------- 指南
add("GD-01-NSTEACS-2024-FIRST",
    "《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》建议首选抗血小板强度更强的替格瑞洛，氯吡格雷用于存在替格瑞洛禁忌证、无法获取或无法耐受时。",
    E + "/guideline.md",
    "建议首选抗血小板强度更强的替格瑞洛（负荷量180mg，维持量90mg，2次/d）（I，B），当存在替格瑞洛禁忌证、无法获取或无法耐受时建议使用氯吡格雷（负荷量300~600mg，维持量75mg，1次/d）(I,C)",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南推荐（含推荐级别与证据等级照录）",
    "非ST段抬高型急性冠脉综合征患者",
    False, ELEM("临床实践指南", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-02-NSTEACS-2024-REALWORLD",
    "同一指南指出国内真实世界注册研究显示 ACS 患者使用氯吡格雷比例不低，且越高危患者使用氯吡格雷的比例越高，与指南推荐存在差距。",
    E + "/guideline.md",
    "即越高危的患者使用氯吡格雷的比例越高，与目前指南推荐的治疗策略存在差距",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南正文引述的真实世界注册研究",
    "中国 ACS 患者",
    False, ELEM("临床实践指南（转述真实世界研究）", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-03-NSTEACS-2024-ELDERLY-BLEED",
    "同一指南引述 POPULARAGE 及 SWEDEHEART 真实世界研究结果：老年患者应用替格瑞洛的出血风险显著高于氯吡格雷。",
    E + "/guideline.md",
    "POPULARAGE及SWEDEHEART真实世界研究结果表明，老年患者应用替格瑞洛的出血风险显著高于氯吡格雷",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南正文引述的真实世界研究",
    "老年急性冠脉综合征患者",
    False, ELEM("临床实践指南（转述真实世界研究）", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-04-NSTEACS-2024-PPI",
    "同一指南建议服用氯吡格雷的患者尽可能选择泮托拉唑、雷贝拉唑等对 CYP2C19 影响较小的质子泵抑制剂。",
    E + "/guideline.md",
    "对于服用氯吡格雷的患者，建议尽可能选择泮托拉唑、雷贝拉唑等对CYP2C19影响较小的药物",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南推荐",
    "服用氯吡格雷并需抑酸治疗的患者",
    False, ELEM("临床实践指南", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-05-NSTEACS-2024-PGX",
    "同一指南指出血小板功能和 CYP2C19 基因分型检测有助于发现对氯吡格雷治疗不敏感的人群。",
    E + "/guideline.md",
    "血小板功能和CYP2C19基因分型检测有助于发现对氯吡格雷治疗不敏感的人群",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南正文",
    "氯吡格雷治疗人群",
    False, ELEM("临床实践指南", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-06-NSTEACS-2024-OAC",
    "同一指南推荐 PCI 后短期三联抗栓随后转换为单一抗血小板药物（首选氯吡格雷）与口服抗凝药的两联抗栓治疗 12 个月。",
    E + "/guideline.md",
    "然后转换为单一抗血小板药物（首选氯吡格雷）和NOAC的两联抗栓治疗（dualantithrombotictherapy，DAT）12个月（1，A）",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南推荐（I，A）",
    "需长期口服抗凝药的 PCI 术后患者（如合并非瓣膜性心房颤动）",
    False, ELEM("临床实践指南", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-07-NSTEACS-2024-HOSTEXAM",
    "同一指南引述 HOST-EXAM 研究：PCI 后完成 6~18 个月双联抗血小板治疗且无缺血事件与重大出血并发症的患者，随机接受阿司匹林或氯吡格雷治疗 24 个月的研究设计。",
    E + "/guideline.md",
    "HOSTEXAM研究多中心入选5530例PCI后完成6~18个月DAPT且无任何缺血事件及重大出血并发症的患者，随机接受阿司匹林或氯吡格雷治疗24个月",
    "EVIMED-GUIDE:12《非ST段抬高型急性冠脉综合征诊断和治疗指南（2024）》，中华医学会心血管病学分会", "guideline", "指南正文引述的随机对照研究",
    "PCI 后已完成 6~18 个月 DAPT 的患者",
    False, ELEM("临床实践指南（转述 RCT）", "2024版", "2024-06-17", "EVIMED-GUIDE:12", "not_required", 1, "n/a"))

add("GD-08-CPIC-AVOID",
    "2022 年 CPIC 指南对 ACS 和/或接受 PCI 的 CYP2C19 中间代谢者与弱代谢者，推荐避免使用氯吡格雷，改用普拉格雷或替格瑞洛（无禁忌证时）。",
    F + "/guideline.md",
    "avoid clopidogrel in CYP2C19 IMs and PMs and use an alternative antiplatelet agent, such as prasugrel or ticagrelor, if no contraindications",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》", "guideline", "国际药物基因组学实施联盟指南推荐",
    "ACS 和/或接受 PCI 的 CYP2C19 中间/弱代谢者",
    False, ELEM("国际专业学会指南", "2022更新版", "2022-01-16", "EVIMED-GUIDE:8", "not_required", 1, "n/a"))

add("GD-09-CPIC-EASTASIAN-OR",
    "CPIC 引述的东亚人群荟萃分析显示，氯吡格雷治疗的 CYP2C19 中间代谢者与弱代谢者主要不良心血管事件风险高于正常代谢者（OR 1.92 与 3.08）。",
    F + "/guideline.md",
    "(MACE: odds ratio (OR) 1.92, 95% confidence interval (C1) 1.34-2.76 for IMs and OR 3.08, 95% CI 1.85-5.13 for PMs",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》", "guideline", "荟萃分析（指南转述）",
    "东亚人群，氯吡格雷治疗者",
    False, ELEM("国际专业学会指南（转述荟萃分析）", "2022更新版", "2022-01-16", "EVIMED-GUIDE:8", "not_required", 1, "n/a"))

add("GD-10-CPIC-BOXED",
    "CPIC 指南记载美国 FDA 于 2016 年更新了氯吡格雷说明书上的黑框警告（boxed warning），提示 CYP2C19 弱代谢者疗效减弱，并将适用范围扩展到全部服药患者。",
    F + "/guideline.md",
    "prompted the US Food and Drug Administration (FDA) to update the boxed warning on the clopidogrel label in 2016, noting the diminished effectiveness in CYP2C19 PMs",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》", "guideline", "指南正文对美国监管文件的转述",
    "服用氯吡格雷的患者（美国说明书语境）",
    False, ELEM("国际专业学会指南", "2022更新版", "2022-01-16", "EVIMED-GUIDE:8", "not_required", 1, "n/a"))

add("GD-11-CPIC-MOST-PRESCRIBED",
    "CPIC 指南记载尽管已有更强效的普拉格雷与替格瑞洛，氯吡格雷仍是北美最常处方的抗血小板药物。",
    F + "/guideline.md",
    "clopidogrel remains the most commonly prescribed antiplatelet drug in North America",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》", "guideline", "指南背景叙述",
    "北美服药人群（非中国数据）",
    False, ELEM("国际专业学会指南", "2022更新版", "2022-01-16", "EVIMED-GUIDE:8", "not_required", 1, "n/a"))

add("GD-12-CPIC-NEURO",
    "CPIC 指南记载氯吡格雷用于缺血性卒中或短暂性脑缺血发作患者时，携带 CYP2C19 功能缺失等位基因者复合血管事件与卒中风险升高（RR 1.51 与 1.92）。",
    F + "/guideline.md",
    "had an increased risk for composite vascu lar events (stroke, MI, or vascular death) compared with patients without those alleles (risk ratio [RR] 1.51, 95% CI 1.10-2.06), and increased risk of stroke (RR 1.92, 95% CI 1.57-2.35).22",
    "EVIMED-GUIDE:8《2022 CPIC指南：CYP2C19基因型与氯吡格雷治疗（更新版）》", "guideline", "荟萃分析（指南转述）",
    "缺血性卒中或 TIA 患者",
    False, ELEM("国际专业学会指南（转述荟萃分析）", "2022更新版", "2022-01-16", "EVIMED-GUIDE:8", "not_required", 1, "n/a"))

# ------------------------------------------------------------- 美国说明书（监管）
add("US-01-BOXED-WARNING",
    "美国氯吡格雷说明书设有黑框警告（boxed warning），标题为「CYP2C19 基因两个功能缺失等位基因患者的抗血小板作用减弱」，并建议对确认为 CYP2C19 弱代谢者的患者考虑换用另一种 P2Y12 抑制剂。本条属美国监管文件，不是中国说明书条款。",
    G + "/page.md",
    "Consider use of another platelet P2Y12 inhibitor in patients identified as CYP2C19 poor metabolizers.",
    "DailyMed：CLOPIDOGREL 片剂说明书（美国，Aurobindo Pharma，2024-05-17 修订）", "regulator", "监管文件（FDA 黑框警告）",
    "服用氯吡格雷的患者（美国说明书语境）",
    False, ELEM("监管机构说明书", "2024-05-17 修订版", "2024-05-17", "web-page:b63e9a5cc2e22237", "not_required", 1, "n/a"))

add("US-02-STOP-5D",
    "美国说明书要求可能时在出血风险高的择期手术前中断氯吡格雷 5 天，并在止血后尽快恢复。",
    G + "/page.md",
    "When possible, interrupt therapy with clopidogrel for five days prior to such surgery.",
    "DailyMed：CLOPIDOGREL 片剂说明书（美国，Aurobindo Pharma，2024-05-17 修订）", "regulator", "监管文件（注意事项）",
    "需择期手术的用药者（美国说明书语境）",
    False, ELEM("监管机构说明书", "2024-05-17 修订版", "2024-05-17", "web-page:b63e9a5cc2e22237", "not_required", 1, "n/a"))

add("US-03-OMEPRAZOLE",
    "美国说明书要求避免氯吡格雷与奥美拉唑或埃索美拉唑同时使用，因为两者都会显著降低氯吡格雷的抗血小板活性。",
    G + "/page.md",
    "Avoid concomitant use of clopidogrel with omeprazole or esomeprazole because both significantly reduce the antiplatelet activity of clopidogrel",
    "DailyMed：CLOPIDOGREL 片剂说明书（美国，Aurobindo Pharma，2024-05-17 修订）", "regulator", "监管文件（注意事项）",
    "合并使用质子泵抑制剂的用药者（美国说明书语境）",
    False, ELEM("监管机构说明书", "2024-05-17 修订版", "2024-05-17", "web-page:b63e9a5cc2e22237", "not_required", 1, "n/a"))

add("US-04-BLEEDING-COMMON",
    "美国说明书载明出血（包括危及生命和致命性出血）是报告最多的不良反应。",
    G + "/page.md",
    "Bleeding, including life-threatening and fatal bleeding, is the most commonly reported adverse reaction.",
    "DailyMed：CLOPIDOGREL 片剂说明书（美国，Aurobindo Pharma，2024-05-17 修订）", "regulator", "监管文件（不良反应）",
    "服用氯吡格雷的患者（美国说明书语境）",
    False, ELEM("监管机构说明书", "2024-05-17 修订版", "2024-05-17", "web-page:b63e9a5cc2e22237", "not_required", 1, "n/a"))

# ------------------------------------------------------------------ 文献证据
add("LIT-01-PLATO-STENT",
    "PLATO 试验的支架内血栓分析显示，替格瑞洛较氯吡格雷降低确定支架内血栓发生率（1.37% 对 1.93%，HR 0.67）。该研究中氯吡格雷为对照组，结论对本通用名不利。",
    H["23900047"] + "/abstract.md",
    "Ticagrelor reduced stent thrombosis compared with clopidogrel across all definitions: definite, 1.37% (n=71) versus 1.93% (n=105; hazard ratio [HR], 0.67; 95% confidence interval [CI], 0.50-0.90; P=0.0091)",
    "PMID 23900047（Circulation 2013，PLATO 支架内血栓分析）", "literature", "随机对照试验的事后分析（abstract 层级）",
    "急性冠脉综合征住院患者 18624 例，其中 11289 例置入至少 1 枚支架",
    False, ELEM("RCT 分析（摘要）", "2013", "2026-09-28 检索", "PMID:23900047", "read", 1, "same_indication"))

add("LIT-02-PLATO-NONINVASIVE",
    "PLATO 非侵入治疗亚组中，替格瑞洛组主要终点低于氯吡格雷组（12.0% 对 14.3%，HR 0.85），全因死亡亦更低。该研究中氯吡格雷为对照组。",
    H["21685437"] + "/abstract.md",
    "The incidence of the primary end point was lower with ticagrelor than with clopidogrel (12.0% (n=295) v 14.3% (346); hazard ratio 0.85, 95% confidence interval 0.73 to 1.00; P=0.04).",
    "PMID 21685437（BMJ 2011，PLATO 非侵入治疗亚组）", "literature", "随机对照试验的预设亚组（abstract 层级）",
    "计划非侵入治疗的 ACS 患者 5216 例",
    False, ELEM("RCT 亚组（摘要）", "2011", "2026-09-28 检索", "PMID:21685437", "read", 1, "same_indication"))

add("LIT-03-KOREAN-BLEED",
    "在东亚（韩国）ACS 人群中，替格瑞洛组 12 个月临床显著出血发生率显著高于氯吡格雷组（11.7% 对 5.3%，HR 2.26）；两组心血管死亡、心肌梗死或卒中无统计学差异。该研究以氯吡格雷为对照组，结论中的安全性方向对替格瑞洛不利。",
    H["31553203"] + "/abstract.md",
    "the incidence of clinically significant bleeding was significantly higher in the ticagrelor group than in the clopidogrel group (11.7% [45/400] vs 5.3% [21/400]; hazard ratio [HR], 2.26; 95% confidence interval [CI], 1.34 to 3.79; P=0.002)",
    "PMID 31553203（Circulation 2019，韩国多中心 RCT，n=800）", "literature", "随机对照试验（abstract 层级）",
    "800 例拟行侵入治疗的韩国 ACS 患者",
    False, ELEM("RCT（摘要）", "2019", "2026-09-28 检索", "PMID:31553203", "read", 1, "same_indication"))

add("LIT-04-EASTASIAN-META",
    "东亚人群随机试验的荟萃分析结论为替格瑞洛与氯吡格雷在 ACS 患者中疗效相近，替格瑞洛伴随大出血风险增加。",
    H["29094604"] + "/abstract.md",
    "Ticagrelor and clopidogrel displayed similar efficacies in ACS presenting patients from East Asia. Administration of ticagrelor also displays some side effects including an increased risk of major bleeding.",
    "PMID 29094604（J Comp Eff Res，东亚 ACS 随机试验荟萃分析）", "literature", "系统综述/Meta 分析（abstract 层级）",
    "东亚 ACS 患者（纳入 2 项随机试验）",
    False, ELEM("荟萃分析（摘要）", "2018", "2026-09-28 检索", "PMID:29094604", "read", 1, "same_indication"))

add("LIT-05-TC4",
    "2025 年发表的 TC4 贝叶斯实用性随机试验在北美 ACS 患者中未发现替格瑞洛优于氯吡格雷的有力证据，作者建议指南在未来纳入这一证据。",
    H["40164463"] + "/abstract.md",
    "we found no strong evidence for the superiority of ticagrelor over clopidogrel in North American patients",
    "PMID 40164463（CMAJ 2025，TC4 随机对照试验）", "literature", "随机对照试验（abstract 层级）",
    "加拿大单中心 1005 例 ACS 患者",
    False, ELEM("RCT（摘要）", "2025", "2026-09-28 检索", "PMID:40164463", "read", 1, "same_indication"))

add("EPI-01-CHINA-CVD",
    "《中国心血管健康与疾病报告 2022》概要估计中国现患心血管病人数约 3.3 亿，其中脑卒中 1300 万、冠心病 1139 万、外周动脉疾病 4530 万。该数字是疾病总患病人数，不等于说明书限定的「近期」事件人群规模。",
    H["38018129"] + "/abstract.md",
    "It is estimated that there are around 330 million patients suffering from CVD currently, including 245 million of hypertension, 13 million of stroke, 45.3 million of peripheral artery disease, 11.39 million of coronary heart disease (CHD)",
    "PMID 38018129（Chinese Medical Journal 2023，中国心血管健康与疾病报告 2022 概要）", "literature", "国家级报告概要（abstract 层级）",
    "中国全人群",
    False, ELEM("国家级疾病报告（摘要）", "2022年报告", "2023", "PMID:38018129", "read", 1, "category_background"))

products = {
    "brandName": "波立维",
    "genericName": "硫酸氢氯吡格雷片",
    "aliases": ["波立维/PLAVIX", "PLAVIX", "波立维(赛诺菲)"],
    "genericAliases": ["氯吡格雷", "硫酸氯吡格雷", "clopidogrel", "clopidogrel bisulfate"],
    "misspellings": ["波利维", "氯比格雷", "氢氯吡格雷", "硫氢酸氯吡格雷"],
    "approvalNo": ["国药准字HJ20171237（进口，法国 Sanofi Winthrop Industrie）",
                   "国药准字H20056410（国产，赛诺菲(杭州)制药有限公司）"],
    "rx": "rx",
    "identityStatus": "confirmed",
    "singleSource": False,
    "singleSourceReason": "硫酸氢氯吡格雷片在中国有多个持证商（深圳信立泰、乐普药业、南京正大天晴、广东东阳光、浙江京新、扬子江广州海瑞、江苏联环、湖南迪诺、吉林博大伟业等），通用名不能唯一指向波立维；因此测量中只有品牌名（波立维/PLAVIX）计为提及本品，通用名只在 P2 品类池中用于比较。",
    "holder": "赛诺菲（Sanofi）",
    "focusSku": "硫酸氢氯吡格雷片（波立维）75mg 薄膜衣片，进口文号 HJ20171237 为主 SKU，国产文号 H20056410 同品牌同规格并行",
}

competitors = [
    {"brandName": "倍林达", "genericName": "替格瑞洛片",
     "aliases": ["倍林达/BRILINTA", "BRILINTA"],
     "genericAliases": ["替格瑞洛", "ticagrelor"],
     "singleSource": False,
     "holder": "阿斯利康（进口：瑞典 AstraZeneca AB；境内：阿斯利康制药有限公司）",
     "indication": "急性冠脉综合征（不稳定性心绞痛、非ST段抬高心肌梗死或ST段抬高心肌梗死），包括接受药物治疗和经皮冠状动脉介入治疗的患者，降低血栓性心血管事件发生率",
     "reason": "2024 年中国 NSTE-ACS 指南与 2022 年 CPIC 指南均将其列为 ACS 首选/替代 P2Y12 抑制剂；患者与 AI 最常做的比较就是它与氯吡格雷。国内已有国产替格瑞洛批文，故通用名不能唯一指向倍林达。"},
    {"brandName": "泰嘉", "genericName": "硫酸氢氯吡格雷片",
     "aliases": ["泰嘉/信立泰", "信立泰泰嘉"],
     "genericAliases": ["氯吡格雷", "clopidogrel"],
     "singleSource": False,
     "holder": "深圳信立泰药业股份有限公司",
     "indication": "同波立维（同一通用名）：近期心肌梗死、近期缺血性卒中、确诊外周动脉性疾病、急性冠脉综合征",
     "reason": "国产同通用名中最具认知度的品牌，也是「同成分国产更便宜」这类问法的实际承接者。"},
    {"brandName": "国产硫酸氢氯吡格雷片", "genericName": "硫酸氢氯吡格雷片",
     "aliases": ["国产氯吡格雷", "国产波立维", "仿制波立维"],
     "genericAliases": ["氯吡格雷", "clopidogrel"],
     "singleSource": False,
     "holder": "多个持证商（信立泰、乐普、南京正大天晴、广东东阳光、浙江京新、扬子江广州海瑞、江苏联环、湖南迪诺、吉林博大伟业等）",
     "indication": "同波立维（同一通用名）",
     "reason": "用户在题面中把「国产硫酸氢氯吡格雷片」整体作为一个竞争对手；它是一个品类而非单一产品，登记为集合型竞品，声量份额按品牌名集合统计。"},
]

assumptions = [
    {"field": "焦点规格", "value": "75mg 薄膜衣片（进口文号 HJ20171237 为主 SKU）",
     "basis": "inferred",
     "reason": "用户只给了品牌名，未给规格；境内波立维按 75mg 销售，进口文号规格记录为 75mg*90片，国产文号规格为 75mg。",
     "howToChange": "如实际主推 300mg 负荷剂量包装或其它规格，更新 products.focusSku 并重跑 KPI 池。"},
    {"field": "竞品集合口径", "value": "替格瑞洛（倍林达）与国产硫酸氢氯吡格雷片按两个竞品登记，国产项为集合型",
     "basis": "client_said",
     "reason": "题面给出的第二个竞品是品类而非单品，登记为集合型竞品并在声量份额中按品牌名集合统计。",
     "howToChange": "若甲方希望只对标泰嘉，删除集合型竞品、保留泰嘉条目。"},
    {"field": "同通用名单源判定", "value": "singleSource = false",
     "basis": "upstream",
     "reason": "硫酸氢氯吡格雷片有多个境内持证商，通用名不能唯一指向波立维。",
     "howToChange": "若甲方提供独家持有证据，改为 true，则 P2 池中通用名亦可计为提及本品。"},
    {"field": "P4 判定优先于 P1–P3", "value": "命中超适应症/特殊人群/禁忌词表的问句一律入 P4",
     "basis": "upstream",
     "reason": "同一问句可能既含通用名又命中特殊人群词表（如「老人能不能吃氯吡格雷」），四池必须互斥。",
     "howToChange": "若甲方要求把老年用药问题算作品类增量，改为 P2 并在假设中登记新版本。"},
    {"field": "发声渠道范围", "value": "本次采集知乎、抖音、小红书三个平台，其余平台未采",
     "basis": "default",
     "reason": "社媒采集一次一平台，本项目按最常见的患者聚集地取三个。",
     "howToChange": "补采微博、B站、视频号、百度后生成新的 measurement_set_version。"},
    {"field": "未经核对的价格与医保口径", "value": "不写任何具体价格、集采中选价或报销比例",
     "basis": "default",
     "reason": "本次未取得可引用的官方集采/医保支付标准页面，价格数字无法追溯到公开可打开的来源。",
     "howToChange": "甲方提供医保支付标准文件或官方页面后，在主张库中新增价格类主张并给出版本与核验时间。"},
    {"field": "覆盖周期与引擎", "value": "90 天，引擎为豆包、通义千问、DeepSeek、腾讯元宝、Kimi",
     "basis": "upstream",
     "reason": "取自项目已有配置。",
     "howToChange": "在项目设置中修改覆盖周期或引擎后重跑基线。"},
    {"field": "医疗审核责任人", "value": "reviewer 字段留 unconfirmed",
     "basis": "default",
     "reason": "本次由模型逐字核对说明书与指南原文，尚无人签名的医学审核。",
     "howToChange": "甲方医学部指定审核人后写入 reviewer，并把 validUntil 改为按说明书修订触发。"},
]

def main():
    # label claims are addressed by the exact preserved section id
    # label:<approval>#<section>; the reader-facing name stays in sourceRefLabel.
    APPROVAL = {
        "455270100abc83b4": "国药准字HJ20171237",
        "222d7584bbf282ac": "国药准字H20056410",
        "ba50281757bdb588": "国药准字H20000542",
        "5a10253ee0470112": "国药准字HJ20171037",
    }
    LABEL_NAME = {
        "国药准字HJ20171237": "硫酸氢氯吡格雷片（波立维）说明书，赛诺菲，批准文号 国药准字HJ20171237（进口版）",
        "国药准字H20056410": "硫酸氢氯吡格雷片（波立维）说明书，赛诺菲（杭州）制药有限公司，国药准字H20056410（国产版）",
        "国药准字H20000542": "硫酸氢氯吡格雷片（泰嘉）说明书，深圳信立泰药业股份有限公司，国药准字H20000542",
        "国药准字HJ20171037": "替格瑞洛片（倍林达）说明书，阿斯利康，国药准字HJ20171037",
    }
    missing = []
    for c in CLAIMS:
        parts = c["artifactPath"].split("/")
        if len(parts) > 3 and parts[1] == "drug-labels" and parts[2] in APPROVAL:
            ap = APPROVAL[parts[2]]
            stem = parts[-1][:-3]
            c["sourceRef"] = "label:%s" % ap
            c["sourceRefLabel"] = LABEL_NAME[ap]
        else:
            c["sourceRefLabel"] = SOURCE_LABELS.get(c["sourceRef"], c["sourceRef"])
        p = os.path.join(WS, c["artifactPath"])
        if not os.path.exists(p):
            missing.append((c["claimKey"], "artifact missing", c["artifactPath"]))
            continue
        text = open(p, encoding="utf-8").read()
        if c["quote"] not in text:
            missing.append((c["claimKey"], "quote not found", c["artifactPath"]))
    if missing:
        for m in missing:
            print("FAIL", m)
        sys.exit(1)

    pkg = {
        "product": products,
        "competitors": competitors,
        "minimal": False,
        "claims": CLAIMS,
        "assumptions": assumptions,
        "_meta": {
            "builtAt": datetime.datetime.utcnow().isoformat() + "Z",
            "claimCount": len(CLAIMS),
            "quoteCheck": "每条 quote 已按 UTF-8 逐字比对到 artifactPath 指向的留存文件",
        },
    }
    with open(os.path.join(OUT, "claims.json"), "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
    print("claims written:", len(CLAIMS))

if __name__ == "__main__":
    main()
