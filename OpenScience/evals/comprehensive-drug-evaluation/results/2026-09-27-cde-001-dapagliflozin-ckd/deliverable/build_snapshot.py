# -*- coding: utf-8 -*-
"""Build the frozen evidence snapshot for the dapagliflozin CKD drug evaluation."""
import json, hashlib, os, glob

D = "/workspace/deliverables/dapagliflozin-ckd-evaluation"
FROZEN = "2026-09-27T07:20:00Z"

cands = [p for p in glob.glob(os.path.join(".evimed" + "-sources", "*", "*", "fulltext.md")) if "nejmoa" in p]
NEJM_ART = cands[0] if cands else None
NEJM_SHA = hashlib.sha256(open(NEJM_ART, 'rb').read()).hexdigest() if NEJM_ART else None
print("NEJM artifact:", NEJM_ART, NEJM_SHA[:12] if NEJM_SHA else None)


def src(sid, title, source, url, access, rtype, retrieved, notes, artifact=None, sha=None, jur="国际"):
    d = {"id": sid, "title": title, "source": source, "sourceType": rtype,
         "evidenceAccess": access, "retrievedAt": retrieved, "observedFields": notes, "jurisdiction": jur}
    d["url"] = url if url else None
    if artifact:
        d["artifactPath"] = artifact
    if sha:
        d["artifactSha256"] = sha
    return d


sources = [
 src("S01", "Dapagliflozin in Patients with Chronic Kidney Disease (DAPA-CKD 主要结果, N Engl J Med 2020;383:1436-1446, DOI 10.1056/NEJMoa2024816)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/32970396/", "full_text", "randomised_controlled_trial", "2026-09-27T07:19:00Z",
     "随机化 4304 例；eGFR 25-75 mL/min/1.73m2 且 UACR 200-5000 mg/g；达格列净 10 mg 对比安慰剂；中位随访 2.4 年；主要复合终点 197/2152(9.2%) 对 312/2152(14.5%)，HR 0.61(0.51-0.72)，P<0.001；全因死亡 101(4.7%) 对 146(6.8%)，HR 0.69(0.53-0.88)，P=0.004；eGFR 斜率组间差 0.93(0.61-1.25)；表 2 安全性事件；亚组含亚洲地区 HR 0.70(0.48-1.00)",
     NEJM_ART, NEJM_SHA),
 src("S02", "The dapagliflozin and prevention of adverse outcomes in chronic kidney disease (DAPA-CKD) trial: baseline characteristics (Nephrol Dial Transplant 2020)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/32862232/", "abstract", "randomised_controlled_trial", "2026-09-27T07:09:49Z",
     "基线：平均 eGFR 43.1；中位 UACR 949 mg/g；68% 合并 2 型糖尿病；97%(4174/4304) 使用 ACEI 或 ARB；43.7% 使用利尿剂；5.3% 使用 MRA"),
 src("S03", "Effects of dapagliflozin on major adverse kidney and cardiovascular events in patients with diabetic and non-diabetic chronic kidney disease: a prespecified analysis from the DAPA-CKD trial (Lancet Diabetes Endocrinol 2021)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/33338413/", "abstract", "randomised_controlled_trial", "2026-09-27T07:09:49Z",
     "主要复合终点：糖尿病 0.64(0.52-0.79)、非糖尿病 0.50(0.35-0.72)，交互 P=0.24；病因亚组：糖尿病肾病 0.63(0.51-0.78)、肾小球肾炎 0.43(0.26-0.71)、缺血/高血压性 0.75(0.44-1.26)、其他/不明 0.58(0.29-1.19)，交互 P=0.53"),
 src("S04", "Effects of dapagliflozin on mortality in patients with chronic kidney disease: a pre-specified analysis from the DAPA-CKD randomized controlled trial (Eur Heart J 2021)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/33792669/", "abstract", "randomised_controlled_trial", "2026-09-27T07:09:23Z",
     "随访期死亡 247 例(5.7%)：心血管 91(36.8%)、非心血管 102(41.3%)、死因未定 54(21.9%)；全因死亡 HR 0.69(0.53-0.88)，P=0.003；非心血管死亡 HR 0.54(0.36-0.82)"),
 src("S05", "A pre-specified analysis of the DAPA-CKD randomized controlled trial on the incidence of abrupt declines in kidney function (Kidney Int 2022)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/34560136/", "abstract", "randomised_controlled_trial", "2026-09-27T07:09:46Z",
     "血清肌酐翻倍 63(2.9%) 对 91(4.2%)，HR 0.68(0.49-0.94)；研究者报告的急性肾损伤相关严重不良事件 52(2.5%) 对 69(3.2%)，HR 0.77(0.54-1.10)"),
 src("S06", "Effects of Dapagliflozin in Chronic Kidney Disease, With and Without Other Cardiovascular Medications: DAPA-CKD Trial (J Am Heart Assoc 2023)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/37119064/", "abstract", "randomised_controlled_trial", "2026-09-27T07:09:49Z",
     "基线使用 RAS 抑制剂 98.1%；无论基线是否使用 RAS 抑制剂、钙通道阻滞剂、β 受体阻滞剂、利尿剂、抗血栓或调脂药，疗效方向一致，且联合用药未增加严重不良事件数"),
 src("S07", "SGLT2 Inhibitors and Kidney Outcomes by Glomerular Filtration Rate and Albuminuria: A Meta-Analysis (JAMA, SMART-C 协作组)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/41203232/", "abstract", "meta_analysis", "2026-09-27T07:11:43Z",
     "10 项随机双盲安慰剂对照试验、70361 例；CKD 进展 HR 0.62(0.57-0.68)；按 eGFR 分层 HR 0.61/0.57/0.64/0.71（趋势 P=0.16）；按 UACR 分层 HR 0.58/0.74/0.57（趋势 P=0.49）；单肾衰竭终点 HR 0.66(0.58-0.75)"),
 src("S08", "Efficacy and safety of sodium-glucose cotransporter-2 inhibitors in patients with chronic kidney disease: a systematic review and meta-analysis (Int Urol Nephrol 2024)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/37752340/", "abstract", "systematic_review", "2026-09-27T07:11:43Z",
     "30 篇研究；肾脏复合结局 HR 0.64；eGFR 下降率 MD 0.02(P=0.05)；UACR 变化 -141.34 mg/g；生殖器真菌感染与酮症酸中毒风险显著高于安慰剂"),
 src("S09", "SGLT2 inhibitors in type 2 diabetes: a systematic review and meta-analysis of cardiovascular outcome trials balancing their risks and benefits (Diabetologia 2022)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/35925319/", "abstract", "meta_analysis", "2026-09-27T07:11:43Z",
     "5 项 CVOT、46969 例、加权平均随访 3.5 年；DKA IRR 2.59(1.57-4.27)；生殖器感染 IRR 3.50(3.09-3.95)；截肢 IRR 1.23(1.00-1.51)；每 1000 例 3.5 年预计减少死亡 9 例、MACE 9 例、心衰住院 11 例、ESRD 2 例，增加 DKA 2 例、生殖器感染 36 例"),
 src("S10", "Risk of genitourinary tract infections with SGLT-2 inhibitors in type 2 diabetes mellitus: A meta-analysis of RCTs and disproportionality analysis using FAERS (Endocrine 2025)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/40849605/", "abstract", "meta_analysis", "2026-09-27T07:11:43Z",
     "98 项 RCT、91756 例；生殖器真菌感染 RR 3.65(3.22-4.14) 对比安慰剂，4.29(3.42-5.38) 对比活性对照；尿路感染关联不一致"),
 src("S11", "Safety of four SGLT2 inhibitors in three chronic diseases: A meta-analysis of large randomized trials of SGLT2 inhibitors (Diab Vasc Dis Res 2021)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/33887983/", "abstract", "meta_analysis", "2026-09-27T07:09:49Z",
     "急性肾损伤 RR 0.75(0.66-0.85)；严重低血糖 RR 0.86(0.71-1.03)；糖尿病酮症酸中毒 RR 2.57；生殖器感染 RR 3.75；容量不足 RR 1.14；骨折 RR 1.07；截肢 RR 1.21；尿路感染 RR 1.07（部分 RR 未报告 95% CI）"),
 src("S12", "SGLT2 inhibitors for the composite of cardiorenal outcome in patients with chronic kidney disease: A systematic review and network meta-analysis (Eur J Pharmacol 2022)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/36306924/", "abstract", "systematic_review", "2026-09-27T07:09:53Z",
     "3 项 CKD 试验；心肾复合结局 OR 0.70(0.57-0.86)，I2=72%；糖尿病 0.72(0.60-0.86)、非糖尿病 0.51(0.35-0.75)；三种 SGLT2 抑制剂之间无显著差异"),
 src("S13", "Cost-Effectiveness of Adding Dapagliflozin and Empagliflozin to Standard Treatment for Diabetic Kidney Disease in China (Clin Drug Investig 2025)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/40658333/", "abstract", "economic_evaluation", "2026-09-27T07:11:37Z",
     "中国医疗体系视角 Markov 模型；达格列净加标准治疗对比标准治疗：总费用 +人民币 19203.56 元；生命年 +1.72；QALY +1.40；ICER 每 QALY 18,192.50 元；意愿支付阈值取 2023 年中国人均 GDP 89,358 元；增量净货币效益 75,120.54 元"),
 src("S14", "Cost-Effectiveness of Dapagliflozin as a Treatment for Chronic Kidney Disease: A Health-Economic Analysis of DAPA-CKD (Clin J Am Soc Nephrol 2022)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/36323444/", "abstract", "economic_evaluation", "2026-09-27T07:09:53Z",
     "英国/德国/西班牙支付方视角终生 Markov 模型；ICER 分别为 8280、17623、11687 美元每 QALY；贴现后 QALY 增益 0.82-1.00"),
 src("S15", "Dapagliflozin in chronic kidney disease: cost-effectiveness beyond the DAPA-CKD trial (Clin Kidney J 2024)", "PubMed", "https://pubmed.ncbi.nlm.nih.gov/38389710/", "abstract", "economic_evaluation", "2026-09-27T07:09:46Z",
     "英国/西班牙/意大利/日本医疗体系视角终生模型；ICER 分别为 10676、14479、7771、13723 美元每 QALY；贴现 QALY 增益 0.45-0.68"),
 src("S16", "国家药品监督管理局批准的达格列净片说明书候选记录（安达唐，AstraZeneca AB；含适应症、禁忌、注意事项、老年用药等字段）", "NMPA", "", "regulatory_record", "drug_label", "2026-09-27T07:11:27Z",
     "适应症第 3 条为慢性肾脏病成人患者：降低有进展风险的慢性肾脏病成人患者的 eGFR 持续下降、终末期肾病、心血管死亡和因心力衰竭而住院的风险；禁忌仅列严重超敏反应史；注意事项首条为糖尿病患者的酮症酸中毒；记录状态标注为索引候选记录、需核对官方现行版本；未见任何字段被标记为黑框警告", jur="中国"),
 src("S17", "中国药品说明书索引快照中的达格列净片记录（10 条，含 1 条安达唐进口记录与 9 条国产记录；快照导出日 2025-12-17）", "EviMed 药品说明书索引", "", "regulatory_record", "drug_label", "2026-09-27T07:11:14Z",
     "10 条记录的适应症字段均仅载 2 型糖尿病相关表述，未载慢性肾脏病适应症；其中安达唐记录的不良反应字段引用了 FARXIGA 与 FDA 联系方式，提示该快照字段来源混杂；一条国产记录将 eGFR<30 列为禁忌", jur="中国"),
 src("S18", "钠-葡萄糖转运体2抑制剂在慢性肾脏病患者临床应用的中国专家共识（2023 年版）", "指南索引全文", "", "full_text", "clinical_practice_guideline", "2026-09-27T07:09:30Z",
     "推荐 eGFR>=20 mL/min/1.73m2 的成人 CKD 患者（伴或不伴 2 型糖尿病）使用 SGLT2 抑制剂；建议在 RAASi 基础上联合使用；列出血容量不足、酮症酸中毒、泌尿生殖道感染、急性肾损伤的风险评估与监测要求；建议开始治疗后 2-4 周复查肾功能；列出暂不适用人群（1 型糖尿病、肾移植、大剂量激素或免疫抑制剂、UACR>5000 mg/g、多囊肾）；引用 CREDENCE 与 EMPA-KIDNEY 的 DKA 发生率与 DAPA-CKD 的 0/2149 对 2/2149", jur="中国"),
 src("S19", "2024 KDIGO 慢性肾脏病评估和管理指南要点解读（中文解读文章）", "指南索引全文", "", "full_text", "guideline_interpretation", "2026-09-27T07:09:30Z",
     "称 KDIGO 2024 指南将 SGLT2 抑制剂在 CKD 中的适用人群从 2 型糖尿病相关 CKD 扩展至广泛 CKD 人群并给予 1A 级推荐；称启动时 eGFR 的可逆性下降不是停药指标；引用 RASi 应滴定至已获批的最高耐受剂量"),
 src("S20", "国家医保局、人力资源社会保障部关于印发《国家基本医疗保险、生育保险和工伤保险药品目录》以及《商业健康保险创新药品目录》（2025年）的通知（医保发〔2025〕33号）", "国家医疗保障局", "https://www.nhsa.gov.cn/art/2025/12/7/art_104_18970.html", "regulatory_record", "policy_document", "2026-09-27T07:09:00Z",
     "新版药品目录自 2026 年 1 月 1 日起执行；2024 年版同时废止；支付以符合法定说明书适应症及医保限定支付范围为条件", jur="中国"),
 src("S21", "《国家基本医疗保险、生育保险和工伤保险药品目录（2025年）》正文", "国家医疗保障局", "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a32f9f2f3fc046afaf08471f87456ce3.pdf", "regulatory_record", "policy_document", "2026-09-27T07:09:00Z",
     "西药部分 XA10BK 钠葡萄糖协同转运蛋白2(SGLT-2)抑制剂项下：达格列净片列为乙类、编号 165，备注栏为空（凡例第（十一）条规定备注栏用于规定限定支付范围）；目录未载支付标准金额", jur="中国"),
 src("S22", "第十一批国家组织药品集中带量采购中选结果表", "国家医疗保障局", "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=46863b415c9e4d119e9cc60af63ea962.pdf", "regulatory_record", "policy_document", "2026-09-27T07:09:00Z",
     "品种序号 8「达格列净口服常释剂型」列出 7 家中选企业及选省结果；其中 Hetero Labs Limited 备注为因未能按协议供应、已取消中选资格；所读页面未载中选价格", jur="中国"),
 src("S23", "达格列净在华获批 慢性肾脏病患者治疗有了新希望（中国新闻网，2022-09-05）", "中国新闻网", "https://www.chinanews.com.cn/m/life/2022/09-05/9845330.shtml", "full_text", "news_report", "2026-09-27T07:09:00Z",
     "报道称原研达格列净获 NMPA 批准用于治疗慢性肾脏病，批准依据为 DAPA-CKD III 期试验；系新闻报道，非监管原始记录，仅作线索", jur="中国"),
]

snapshot = {
 "snapshotVersion": "1.0",
 "deliverableId": "dapagliflozin-ckd-evaluation",
 "contractKind": "drug-evaluation-report",
 "frozenAt": FROZEN,
 "scope": {"drug": "达格列净（dapagliflozin；达格列净片）",
           "indication": "慢性肾脏病（伴或不伴 2 型糖尿病）",
           "comparator": "标准治疗（最大耐受剂量的 ACEI 或 ARB）",
           "population": "eGFR 25–75 mL/min/1.73 m²、伴白蛋白尿的成人慢性肾脏病患者",
           "jurisdiction": "中国（NMPA；国家医保药品目录）",
           "careSetting": "三级医院肾内科门诊",
           "timeHorizon": "3 年", "decisionDate": "2026-06-30",
           "evaluationDomains": ["effectiveness", "safety", "applicability", "economics"]},
 "queries": [
  {"id": "Q1", "target": "文献数据库", "query": "dapagliflozin chronic kidney disease DAPA-CKD randomized", "retrievedAt": "2026-09-27T07:09:23Z", "recordsReturned": 20, "screenedInto": ["S02", "S03", "S04", "S06", "S14", "S15"]},
  {"id": "Q2", "target": "文献数据库", "query": "dapagliflozin chronic kidney disease safety adverse events ketoacidosis acute kidney injury DAPA-CKD", "retrievedAt": "2026-09-27T07:09:49Z", "recordsReturned": 10, "screenedInto": ["S02", "S03", "S04", "S06", "S08", "S14"]},
  {"id": "Q3", "target": "文献数据库", "query": "达格列净 慢性肾脏病 成本效果 中国 药物经济学", "retrievedAt": "2026-09-27T07:09:53Z", "recordsReturned": 10, "screenedInto": ["S13", "S14", "S15"]},
  {"id": "Q4", "target": "文献数据库（按 PMID 精确取回）", "query": "pmids: 32970396, 34560136, 38389710", "retrievedAt": "2026-09-27T07:09:46Z", "recordsReturned": 3, "screenedInto": ["S01", "S05", "S15"]},
  {"id": "Q5", "target": "文献数据库（按 PMID 精确取回）", "query": "pmids: 37752340, 40849605, 35925319", "retrievedAt": "2026-09-27T07:11:43Z", "recordsReturned": 3, "screenedInto": ["S08", "S09", "S10"]},
  {"id": "Q6", "target": "指南库", "query": "慢性肾脏病 SGLT2 抑制剂 钠-葡萄糖共转运蛋白2抑制剂 临床应用", "retrievedAt": "2026-09-27T07:09:30Z", "recordsReturned": 10, "screenedInto": ["S18", "S19"]},
  {"id": "Q7", "target": "说明书库（辖区中国）", "query": "达格列净", "retrievedAt": "2026-09-27T07:11:14Z", "recordsReturned": 10, "screenedInto": ["S17"]},
  {"id": "Q8", "target": "监管说明书索引", "query": "dapagliflozin", "retrievedAt": "2026-09-27T07:11:27Z", "recordsReturned": 3, "screenedInto": ["S16"]},
  {"id": "Q9", "target": "开放网页（仅作线索）", "query": "达格列净 安达唐 说明书 适应症 慢性肾脏病 国家药品监督管理局 批准", "retrievedAt": "2026-09-27T07:11:20Z", "recordsReturned": 10, "screenedInto": ["S23"]},
 ],
 "sources": sources,
 "excludedOrUnavailable": [
  {"item": "KDIGO 2024 慢性肾脏病评估和管理指南（原文）", "reason": "指南索引返回该记录的题录与摘要级信息，本次未取得可核对的指南原文；其推荐内容仅经其中文要点解读（S19）间接获知，故未作为来源引用，也未据此陈述推荐强度。原文标识（供后续核对）：DOI 10.1016/j.kint.2023.10.018", "status": "not_read"},
  {"item": "厂商中国新闻稿（达格列净 CKD 适应症获批，2022-09）", "reason": "该页面以 JavaScript 挑战响应普通客户端，本次未能读取，未写入任何来源内容", "status": "unreadable_page"},
  {"item": "某医院药品说明书页面（swin.zy91.com，说明书）", "reason": "页面正文仅为占位提示「药品说明书内容仅供参考」，无可引用内容", "status": "empty_content"},
  {"item": "管理型证据适配器的一次检索", "reason": "首次调用返回适配器超时；改用公开来源逐条检索后完成取证，未把空结果当作阴性证据", "status": "adapter_timeout"},
  {"item": "2023 年版中国专家共识的可解析公开链接", "reason": "对该文一处候选 DOI（10.3760/cma.j.cn441217-20230625-00633）校验返回 Crossref 中不存在；因此该共识不附 URL，仅以其题名、发布方与发布日标识", "status": "url_unresolved"},
 ],
 "note": "本快照冻结本次评价所用的来源、检索式与观察字段。报告中出现的每一条引用，其来源均在本文件的 sources 内。",
}

os.makedirs(D, exist_ok=True)
with open(os.path.join(D, "evidence-snapshot.json"), "w", encoding="utf-8") as f:
    json.dump(snapshot, f, ensure_ascii=False, indent=2)
print("sources:", len(sources))
