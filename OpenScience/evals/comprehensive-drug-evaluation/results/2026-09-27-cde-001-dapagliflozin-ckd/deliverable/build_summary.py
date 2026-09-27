# -*- coding: utf-8 -*-
"""Write evaluation-summary.json (verbatim compiler result) and evidence-table.csv."""
import json, csv, os

D = "/workspace/deliverables/dapagliflozin-ckd-evaluation"

compiler = {
    "compiler": "evimed-drug-assessment",
    "compilerVersion": "1.4.0",
    "inputSha256": "defc92411e394d2c23d35bc67683bbddca542ba9b8dfc92d30dd14fc8fa2486e",
    "automaticDecision": False,
    "humanReviewRequired": True,
}

assessments = [
    {
        "domain": "effectiveness", "status": "favorable", "certainty": "not_rated",
        "evidenceIds": ["S01", "S02", "S03", "S04", "S06", "S07", "S08", "S12"],
        "rationale": "在 eGFR 25–75 mL/min/1.73m² 且 UACR 200–5000 mg/g 的成人 CKD 人群中，一项随机双盲安慰剂对照试验（4304 例，中位随访 2.4 年，97% 背景使用 ACEI/ARB）显示加用达格列净 10 mg 使主要肾脏复合终点由 14.5% 降至 9.2%（HR 0.61，95% CI 0.51–0.72），肾脏特异复合终点 HR 0.56（0.45–0.68），全因死亡 HR 0.69（0.53–0.88）。糖尿病与非糖尿病、不同病因、不同基线心血管合并用药亚组方向一致且无显著交互；以 SGLT2 抑制剂类别为主体的荟萃分析（70361 例）在各 eGFR 与白蛋白尿层均显示肾脏获益。效应稳健，但由单一试验主导，且对照为安慰剂加指南推荐治疗，与题面“最大耐受剂量 ACEI 或 ARB”高度接近但不完全等同。",
        "certaintyBasis": "偏倚风险：主要试验为随机双盲、事件裁定独立，但由资助方发起并因疗效提前终止，可能影响次要终点的把握度。不一致性：试验结论与类效应荟萃分析方向一致；CKD 专项心肾复合终点的荟萃分析 I2=72%。间接性：试验白蛋白尿门槛为 UACR≥200 mg/g，高于临床一般“伴白蛋白尿”（≥30 mg/g）；亚洲地区亚组 HR 0.70（0.48–1.00）置信区间跨 1；未见中国人群专属随机证据。不精确性：主要终点与全因死亡置信区间较窄，多数亚组与单个病因亚组置信区间较宽。发表偏倚：未在检索层面评估，试验由资助方主导。未使用经验证的确定性评级框架，故不作 GRADE 等级声明，标为 not_rated。",
        "confidenceStatement": "综合结论置信度：较高。该方向上证据来自单项大样本随机对照试验及多项预设亚组分析，并被类别层面荟萃分析佐证；主要不确定性在于中国人群专属数据缺失与白蛋白尿门槛差异。",
        "wouldBeOverturnedBy": "一项设计良好、样本量相当、在同类人群与同类对照背景下结论方向相反的随机对照试验；或现有关键试验数据被实质性更正或撤回。"
    },
    {
        "domain": "safety", "status": "mixed", "certainty": "not_rated",
        "evidenceIds": ["S01", "S05", "S08", "S09", "S10", "S11", "S18"],
        "rationale": "试验内总体安全性可接受：严重不良事件比例低于安慰剂（29.5% 对 33.9%，P=0.002），因不良事件停药比例相近（5.5% 对 5.7%），酮症酸中毒 0/2149 对 2/2149，急性肾损伤相关严重不良事件 2.5% 对 3.2%（HR 0.77，0.54–1.10）。风险侧为容量不足（5.9% 对 4.2%）与类别层面的生殖器真菌感染与酮症酸中毒风险升高（生殖器感染 RR/IRR 3.50–3.75；GMI RR 3.65，3.22–4.14；DKA IRR 2.59，1.57–4.27）。风险与获益需并读：在高心血管风险 2 型糖尿病人群中，每 1000 例治疗 3.5 年预计减少死亡 9 例、MACE 9 例、心衰住院 11 例、终末期肾病 2 例，同时增加酮症酸中毒 2 例与生殖器感染 36 例。四类关注事件均被覆盖，但生殖器感染与酮症酸中毒的量化主要来自非 CKD 人群的类别证据。",
        "certaintyBasis": "偏倚风险：安全性数据来自随机试验，但部分为预设或事后分析，急性肾损伤严重事件由研究者报告而非中心裁定。不一致性：酮症酸中毒方向在 CREDENCE 与 EMPA-KIDNEY 为升高而在 DAPA-CKD 未观察到升高；生殖器感染在 CKD 专项荟萃分析中显著升高，而试验主表未单列该事件。间接性：生殖器感染与酮症酸中毒的风险比主要来自 2 型糖尿病或心衰人群。不精确性：多数安全性事件为零事件或低事件数，置信区间宽，部分荟萃分析摘要未报告 95% CI。发表偏倚：安全性结局的报告完整性受原始试验与摘要信息限制。故标为 not_rated。",
        "confidenceStatement": "综合结论置信度：中等。总体安全性方向（严重不良事件不增加、急性肾损伤不增加）证据直接且一致；四类关注事件中生殖器感染与酮症酸中毒的量化依赖类别证据。",
        "wouldBeOverturnedBy": "本药品在 CKD 人群中的大规模安全性数据库或头对头试验显示生殖器感染或酮症酸中毒的绝对风险显著高于现有估计；或现有试验安全性数据被实质性更正。"
    },
    {
        "domain": "applicability", "status": "mixed", "certainty": "not_rated",
        "evidenceIds": ["S01", "S02", "S07", "S16", "S17", "S18", "S19", "S20", "S21", "S22", "S23"],
        "rationale": "注册层面：一份达格列净片（安达唐，AstraZeneca AB）说明书候选记录的适应症含“用于慢性肾脏病成人患者：降低有进展风险的慢性肾脏病成人患者的 eGFR 持续下降、终末期肾病、心血管死亡和因心力衰竭而住院的风险”，禁忌仅列严重超敏反应史；但同一次检索得到的 10 条中国说明书记录（含原研记录与 9 条国产记录）适应症字段均仅载 2 型糖尿病，且其中一条记录的不良反应字段引自美国 FARXIGA 文本，说明索引快照字段来源混杂，不能替代现行 NMPA 说明书原文核对。医保层面：2025 年版国家医保药品目录将达格列净片列为乙类、编号 165，备注栏为空，按凡例不属于限定支付范围的药品；目录自 2026-01-01 执行，覆盖决策日 2026-06-30。采购层面：达格列净口服常释剂型已列入第十一批国家组织集中带量采购中选结果（品种序号 8，7 家中选企业，1 家因供应问题被取消资格），所获文件未载中选价格。人群层面：试验人群在 eGFR 区间与背景治疗（97% 使用 ACEI/ARB）上与题面高度重叠，但白蛋白尿门槛为 UACR≥200 mg/g，UACR 30–200 mg/g 与 eGFR 20–25 的患者属外推；类效应荟萃分析在 UACR≤30 与 30–300 mg/g 层仍显示肾脏获益。中国专家共识建议 eGFR≥20 使用，并列明 1 型糖尿病、肾移植、大剂量激素或免疫抑制剂、UACR>5000 mg/g、多囊肾等暂不适用人群。",
        "certaintyBasis": "偏倚风险：注册与医保事实来自监管与官方文件，但说明书事实取自索引记录且各记录互相矛盾，官方现行说明书全文未核对。不一致性：同一次检索得到的 10 条说明书记录在适应症表述与肾功能禁忌阈值上互不一致。间接性：疗效证据来自国际多中心试验，未见中国人群专属随机证据。不精确性：无中国人群效应估计可用。发表偏倚：不适用（非文献合并）。故标为 not_rated。",
        "confidenceStatement": "综合结论置信度：中等。医保目录与集采状态有官方文件直接支持；说明书适应症表述依赖索引记录，需以现行官方说明书核对后才能作为合规依据。",
        "wouldBeOverturnedBy": "现行 NMPA 说明书原文不含慢性肾脏病适应症，或对肾功能设定了与目标人群冲突的禁忌；或国家医保目录对本品设定了限定支付范围。"
    },
    {
        "domain": "economics", "status": "unclear", "certainty": "not_rated",
        "evidenceIds": ["S13", "S14", "S15", "S20", "S21", "S22"],
        "rationale": "中国辖区可获得一项药物经济学模型：在糖尿病肾病人群中，达格列净加标准治疗对比标准治疗，总费用增加人民币 19203.56 元、QALY 增加 1.40，ICER 每 QALY 18192.50 元，低于以 2023 年中国人均 GDP 89358 元设定的意愿支付阈值。但该研究人群为糖尿病肾病，不等于题面“伴或不伴 2 型糖尿病”的全谱 CKD，且为终生视野的模型推算，不是 3 年视野下的实付费用或预算影响。境外研究（英国、德国、西班牙、意大利、日本）一致显示每 QALY 成本在各自阈值内，但辖区不可移植。未检索到中国 CKD 人群 3 年视野的成本效果、预算影响或成本抵消分析；国家医保目录正文与集采中选结果表均未载价格或支付标准金额。本域不作成本结论。",
        "certaintyBasis": "偏倚风险：经济学证据为模型研究，输入参数来自已发表文献而非中国本土试验，模型结构与参数来源在摘要层面不可完整核查。不一致性：中国研究与境外研究的人群与时间视野不同，结果不可直接比较。间接性：中国证据人群为糖尿病肾病而非题面全谱 CKD，时间视野为终生而非 3 年。不精确性：摘要未报告概率敏感性分析的区间。发表偏倚：经济学研究多由资助方支持，本次未评估。故标为 not_rated，不做成本结论。",
        "confidenceStatement": "综合结论置信度：低。仅有间接人群与不同视野的模型证据，且未取得中国现行价格或支付标准，无法形成本辖区的成本判断。",
        "wouldBeOverruledBy": "一项中国 CKD 人群、3 年视野、含本地价格与资源消耗的成本效果或预算影响分析。"
    },
]

summary = {
    "deliverableId": "dapagliflozin-ckd-evaluation",
    "contractKind": "drug-evaluation-report",
    "question": {
        "drug": "达格列净（dapagliflozin）",
        "indication": "慢性肾脏病（伴或不伴 2 型糖尿病）",
        "comparator": "标准治疗（最大耐受剂量的 ACEI 或 ARB）",
        "population": "eGFR 25–75 mL/min/1.73 m²、伴白蛋白尿的成人慢性肾脏病患者",
        "jurisdiction": "中国（NMPA；国家医保药品目录）",
        "careSetting": "三级医院肾内科门诊",
        "outcomes": ["肾脏复合终点（eGFR 持续下降、终末期肾病、肾性或心血管死亡）", "全因死亡", "安全性：酮症酸中毒、容量不足、生殖器感染、急性肾损伤"],
        "timeHorizon": "3 年",
        "decisionDate": "2026-06-30",
        "evaluationDomains": ["effectiveness", "safety", "applicability", "economics"]
    },
    "compilerResult": {
        "status": "ok",
        "assessmentType": "comprehensive_drug_evaluation",
        "coreDomainCoverage": {"required": ["applicability", "effectiveness", "safety"], "missing": [], "unresolved": [], "complete": True},
        "evaluationDomains": None,
        "compositeScore": None,
        "scoreStatus": "not_requested",
        "scoreWithheldReasons": [],
        "recommendationStrength": "not_automatically_determined",
        "audit": compiler,
        "warnings": [
            "研究设计本身不决定确定性，确定性也不决定推荐强度。",
            "未产生任何自动的临床、HTA、报销或采购建议。"
        ],
        "nextActions": [
            "补齐缺失的核心评价域并解决相互矛盾的证据。",
            "在使用本辅助评估前，由有资质评审者复核确定性、获益—风险平衡、经济性、公平性与适用性。"
        ]
    },
    "domainAssessments": assessments,
    "scoreWithheld": {
        "withheld": True,
        "reason": "题面未要求定量评分，也未提供评分条目定义、量表、权重、方向与缺失值规则，因此不产生加权归一化分数；缺失证据一律不作零分处理。"
    },
    "sourceCoverage": {
        "sourcesInFrozenSnapshot": 23,
        "byEvidenceAccess": {"full_text": 4, "abstract": 14, "regulatory_record": 5},
        "bibliographicOnlySourcesCitedAsEvidence": 0
    },
    "humanReview": {
        "required": True,
        "flag": "本文件与报告为辅助证据与域评估包，未形成任何推荐或结论；临床、HTA、报销与采购结论留给有资质评审者。"
    },
    "note": "本文件的 compilerResult 与 domainAssessments 为编译器返回结果的逐字保存，仅更正了 applicability 的 rationale 中一处中文错字（“限制定支付范围”改为“限定支付范围”）；其余字段未作改动。"
}

os.makedirs(D, exist_ok=True)
with open(os.path.join(D, "evaluation-summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)

# ---- evidence-table.csv : header row must be the first line ----
header = ["evidenceId", "referenceIndex", "sourceTitle", "sourceType", "evidenceAccess",
          "jurisdiction", "versionOrDate", "url", "domain", "observedFinding", "limitations", "reportedInSection"]

rows = [
 ["S01", 1, "Dapagliflozin in Patients with Chronic Kidney Disease (DAPA-CKD, N Engl J Med 2020)", "随机对照试验", "full_text", "国际多中心（含亚洲）", "2020-10-08", "https://pubmed.ncbi.nlm.nih.gov/32970396/", "effectiveness",
  "4304 例，eGFR 25-75 mL/min/1.73m² 且 UACR 200-5000 mg/g；主要复合终点 197/2152（9.2%）对 312/2152（14.5%），HR 0.61（0.51-0.72），P<0.001，NNT 19（15-27）；肾脏特异复合终点 HR 0.56（0.45-0.68）；全因死亡 101（4.7%）对 146（6.8%），HR 0.69（0.53-0.88），P=0.004；eGFR 斜率组间差 0.93（0.61-1.25）mL/min/1.73m²/年；亚洲地区亚组 50/692 对 69/654，HR 0.70（0.48-1.00）",
  "对照为安慰剂加指南推荐治疗（97% 使用 ACEI/ARB），非字面意义的“单用最大耐受剂量 ACEI/ARB”；试验因疗效提前终止；中位随访 2.4 年短于题面 3 年视野；白蛋白尿门槛 UACR≥200 mg/g",
  "§3.1、§3.2、§3.4"],
 ["S01", 1, "同上", "随机对照试验", "full_text", "国际多中心（含亚洲）", "2020-10-08", "https://pubmed.ncbi.nlm.nih.gov/32970396/", "safety",
  "表 2 安全性人群 n=2149/组：酮症酸中毒 0 对 2（<0.1%），P=0.50；容量不足 127（5.9%）对 90（4.2%），P=0.01；肾脏相关不良事件 155（7.2%）对 188（8.7%），P=0.07；严重不良事件 633（29.5%）对 729（33.9%），P=0.002；因不良事件停药 118（5.5%）对 123（5.7%）；严重低血糖 14（0.7%）对 28（1.3%）；截肢 35（1.6%）对 39（1.8%）；骨折 85（4.0%）对 69（3.2%）；会阴坏死性筋膜炎安慰剂组 1 例、达格列净组 0 例",
  "安全性分析集为接受至少一剂药物的 2149 例/组，少于随机化 2152 例/组；生殖器感染未在表 2 单列；多数事件为零事件或低事件数，估计不精确",
  "§4.1-§4.5"],
 ["S02", 2, "DAPA-CKD trial: baseline characteristics (Nephrol Dial Transplant 2020)", "随机对照试验", "abstract", "国际多中心", "2020-09-01", "https://pubmed.ncbi.nlm.nih.gov/32862232/", "effectiveness",
  "基线特征：平均 eGFR 43.1 mL/min/1.73m²；中位 UACR 949 mg/g；68%（2906 例）合并 2 型糖尿病；97%（4174 例）接受 ACEI 或 ARB；43.7% 使用利尿剂；5.3% 使用盐皮质激素受体拮抗剂",
  "仅读摘要；用于描述研究人群与背景治疗，不用于疗效估计",
  "§3.1、§5.3"],
 ["S03", 3, "DAPA-CKD prespecified analysis by diabetes status and CKD aetiology (Lancet Diabetes Endocrinol 2021)", "随机对照试验（预设亚组分析）", "abstract", "国际多中心", "2021-01-01", "https://pubmed.ncbi.nlm.nih.gov/33338413/", "effectiveness",
  "主要复合终点：合并 2 型糖尿病 0.64（0.52-0.79）、不合并 0.50（0.35-0.72），交互 P=0.24；病因亚组：糖尿病肾病 0.63（0.51-0.78）、肾小球肾炎 0.43（0.26-0.71）、缺血性/高血压性 0.75（0.44-1.26）、其他或不明 0.58（0.29-1.19），交互 P=0.53",
  "亚组分析，非主要终点；部分亚组事件数少、置信区间宽；仅读摘要",
  "§3.2"],
 ["S04", 4, "Effects of dapagliflozin on mortality in CKD (Eur Heart J 2021)", "随机对照试验（预设分析）", "abstract", "国际多中心", "2021-04-01", "https://pubmed.ncbi.nlm.nih.gov/33792669/", "effectiveness",
  "随访期共 247 例死亡（5.7%）：心血管 91 例（36.8%）、非心血管 102 例（41.3%）、死因未定 54 例（21.9%）；全因死亡 HR 0.69（0.53-0.88），P=0.003；非心血管死亡 HR 0.54（0.36-0.82），获益主要由非心血管死亡驱动",
  "全因死亡为关键次要终点而非主要终点；仅读摘要；死因分类中 21.9% 未定，削弱机制解释",
  "§3.1、§7"],
 ["S05", 5, "Abrupt declines in kidney function in DAPA-CKD (Kidney Int 2022)", "随机对照试验（预设分析）", "abstract", "国际多中心", "2022-01-01", "https://pubmed.ncbi.nlm.nih.gov/34560136/", "safety",
  "血清肌酐加倍 63 例（2.9%）对 91 例（4.2%），HR 0.68（0.49-0.94）；研究者报告的急性肾损伤相关严重不良事件 52 例（2.5%）对 69 例（3.2%），HR 0.77（0.54-1.10）",
  "急性肾损伤严重事件为研究者报告、非中心裁定，且属事后分析；HR 置信区间跨 1；仅读摘要",
  "§4.5"],
 ["S06", 6, "Dapagliflozin in CKD with and without other cardiovascular medications (J Am Heart Assoc 2023)", "随机对照试验（亚组分析）", "abstract", "国际多中心", "2023-05-02", "https://pubmed.ncbi.nlm.nih.gov/37119064/", "effectiveness",
  "基线 RAS 抑制剂使用率 98.1%、钙通道阻滞剂 50.7%、β 受体阻滞剂 39.0%、利尿剂 43.7%、抗血栓药 47.4%、调脂药 15.0%；各亚组获益方向一致，联合用药未增加严重不良事件数",
  "亚组分析；仅读摘要",
  "§3.2"],
 ["S07", 7, "SGLT2 inhibitors and kidney outcomes by GFR and albuminuria (JAMA, SMART-C)", "荟萃分析（个体试验水平）", "abstract", "国际（10 项试验）", "2026", "https://pubmed.ncbi.nlm.nih.gov/41203232/", "effectiveness",
  "70361 例、10 项试验；CKD 进展 HR 0.62（0.57-0.68）；按基线 eGFR 分层：≥60 为 0.61（0.52-0.71）、45-<60 为 0.57（0.47-0.70）、30-<45 为 0.64（0.54-0.75）、<30 为 0.71（0.60-0.83），趋势 P=0.16；按 UACR 分层：≤30 为 0.58（0.44-0.76）、30-300 为 0.74（0.57-0.96）、>300 为 0.57（0.52-0.64），趋势 P=0.49；单肾衰竭终点 HR 0.66（0.58-0.75）",
  "为 SGLT2 抑制剂类别效应，非达格列净单药；人群含 2 型糖尿病、CKD 与心力衰竭；仅读摘要，未获取各试验权重与偏倚评估",
  "§3.3、§5.3"],
 ["S08", 8, "Efficacy and safety of SGLT2 inhibitors in patients with CKD: systematic review and meta-analysis (Int Urol Nephrol 2024)", "系统评价/Meta 分析", "abstract", "国际（CKD 人群）", "2024", "https://pubmed.ncbi.nlm.nih.gov/37752340/", "safety",
  "30 篇研究；肾脏复合结局 HR 0.64；eGFR 下降率 MD 0.02（P=0.05）；UACR 变化 -141.34 mg/g；生殖器真菌感染与酮症酸中毒风险显著高于安慰剂",
  "摘要未报告各安全性结局的效应量与 95% CI；人群为 CKD 但纳入药物为 SGLT2 抑制剂整类",
  "§4.2、§4.4、§3.3"],
 ["S09", 9, "SGLT2 inhibitors in type 2 diabetes: meta-analysis of CVOTs balancing risks and benefits (Diabetologia 2022)", "系统评价/Meta 分析", "abstract", "国际（5 项 CVOT）", "2022-08-03", "https://pubmed.ncbi.nlm.nih.gov/35925319/", "safety",
  "46969 例、加权平均随访 3.5 年；DKA IRR 2.59（1.57-4.27）；生殖器感染 IRR 3.50（3.09-3.95）；截肢 IRR 1.23（1.00-1.51）；每 1000 例治疗 3.5 年预计减少死亡 9 例、MACE 9 例、心衰住院 11 例、ESRD 2 例，同时增加 DKA 2 例、生殖器感染 36 例",
  "人群为高心血管风险的 2 型糖尿病患者，非 CKD 人群；纳入药物为 SGLT2 抑制剂整类；基于汇总数据",
  "§4.2、§4.4、§8"],
 ["S10", 10, "Risk of genitourinary tract infections with SGLT-2 inhibitors (Endocrine 2025)", "系统评价/Meta 分析", "abstract", "国际", "2025", "https://pubmed.ncbi.nlm.nih.gov/40849605/", "safety",
  "98 项随机对照试验、91756 例；生殖器真菌感染 RR 3.65（3.22-4.14）对安慰剂，RR 4.29（3.42-5.38）对活性对照；尿路感染关联不一致",
  "人群为 2 型糖尿病，非 CKD；纳入整类药物；仅读摘要",
  "§4.4"],
 ["S11", 11, "Safety of four SGLT2 inhibitors in three chronic diseases: meta-analysis (Diab Vasc Dis Res 2021)", "系统评价/Meta 分析", "abstract", "国际", "2021", "https://pubmed.ncbi.nlm.nih.gov/33887983/", "safety",
  "急性肾损伤 RR 0.75（0.66-0.85）；严重低血糖 RR 0.86（0.71-1.03）；糖尿病酮症酸中毒 RR 2.57；生殖器感染 RR 3.75；容量不足 RR 1.14；骨折 RR 1.07；截肢 RR 1.21；尿路感染 RR 1.07",
  "部分 RR 未报告 95% CI（摘要层面）；人群含 2 型糖尿病、心力衰竭与 CKD 三类，CKD 亚组效应量未在摘要中单列",
  "§4.2、§4.3、§4.4、§4.5"],
 ["S12", 12, "SGLT2 inhibitors for the composite of cardiorenal outcome in CKD: systematic review and network meta-analysis (Eur J Pharmacol 2022)", "系统评价/网状 Meta 分析", "abstract", "国际（3 项 CKD 试验）", "2022", "https://pubmed.ncbi.nlm.nih.gov/36306924/", "effectiveness",
  "心肾复合结局 OR 0.70（0.57-0.86），I²=72%；合并糖尿病 0.72（0.60-0.86）、不合并 0.51（0.35-0.75）；卡格列净、达格列净、索格列净之间无显著差异",
  "异质性高（I²=72%）；纳入试验含索格列净（未在中国上市用于 CKD）；仅读摘要",
  "§3.3"],
 ["S13", 13, "Cost-effectiveness of adding dapagliflozin and empagliflozin to standard treatment for diabetic kidney disease in China (Clin Drug Investig 2025)", "经济学评价（Markov 模型）", "abstract", "中国", "2025", "https://pubmed.ncbi.nlm.nih.gov/40658333/", "economics",
  "达格列净加标准治疗对比标准治疗：总费用 +19203.56 元；生命年 +1.72；QALY +1.40；ICER 每 QALY 18192.50 元（每生命年 11178.52 元）；意愿支付阈值取 2023 年中国人均 GDP 89358 元；增量净货币效益 75120.54 元；敏感性分析支持主要结果",
  "人群为糖尿病肾病，不等于题面全谱 CKD；终生时间视野，非 3 年；输入参数来自已发表文献而非中国本土试验；仅读摘要",
  "§6"],
 ["S14", 14, "Cost-effectiveness of dapagliflozin as a treatment for CKD: health-economic analysis of DAPA-CKD (Clin J Am Soc Nephrol 2022)", "经济学评价（Markov 模型）", "abstract", "英国、德国、西班牙", "2022", "https://pubmed.ncbi.nlm.nih.gov/36323444/", "economics",
  "符合 DAPA-CKD 入选条件的患者：ICER 分别为每 QALY 8280 美元（英国）、17623 美元（德国）、11687 美元（西班牙）；贴现后 QALY 增益 0.82-1.00；在英国 eGFR 15-89 区间多停留 1.7 年",
  "辖区为英国/德国/西班牙，成本与阈值不可移植至中国；模型推算；仅读摘要",
  "§6"],
 ["S15", 15, "Dapagliflozin in CKD: cost-effectiveness beyond the DAPA-CKD trial (Clin Kidney J 2024)", "经济学评价（Markov 模型）", "abstract", "英国、西班牙、意大利、日本", "2024", "https://pubmed.ncbi.nlm.nih.gov/38389710/", "economics",
  "ICER 分别为每 QALY 10676 美元（英国）、14479 美元（西班牙）、7771 美元（意大利）、13723 美元（日本）；贴现 QALY 增益 0.45-0.68；英国预期寿命延长 0.64 年",
  "辖区不含中国；人群较 DAPA-CKD 更宽（不设白蛋白尿门槛）；终生视野；仅读摘要",
  "§6"],
 ["S16", 16, "NMPA 达格列净片说明书候选记录（安达唐，AstraZeneca AB）", "监管说明书记录", "regulatory_record", "中国", "记录状态：索引候选记录，需核对官方现行版本", "", "applicability",
  "适应症含“用于慢性肾脏病成人患者：降低有进展风险的慢性肾脏病成人患者的 eGFR 持续下降、终末期肾病、心血管死亡和因心力衰竭而住院的风险”；禁忌仅列严重超敏反应史；注意事项首条为糖尿病患者的酮症酸中毒；未见任何字段被标记为黑框警告",
  "为索引候选记录而非官方原文，页面对应的公开链接不可直接引用；官方现行说明书全文未核对",
  "§5.1、§4.2"],
 ["S17", 17, "中国药品说明书索引快照中的达格列净片记录（10 条；快照导出日 2025-12-17）", "监管说明书记录快照", "regulatory_record", "中国", "快照导出日 2025-12-17", "", "applicability",
  "10 条记录的适应症字段均仅载 2 型糖尿病相关表述，未载慢性肾脏病适应症；安达唐记录的不良反应字段引用了美国 FARXIGA 名称与 FDA 报告联系方式；一条国产记录将 eGFR<30 mL/min/1.73m² 列为禁忌",
  "索引快照字段来源混杂、版本不一，不能代替现行 NMPA 说明书原文；仅用于说明注册层面证据的不确定性",
  "§5.1、§8"],
 ["S18", 18, "钠-葡萄糖转运体2抑制剂在慢性肾脏病患者临床应用的中国专家共识（2023 年版）", "临床实践共识", "full_text", "中国", "2023-11-16", "", "applicability",
  "建议 eGFR≥20 mL/min/1.73m² 的成人 CKD 患者（伴或不伴 2 型糖尿病）使用 SGLT2 抑制剂；优先用于中度及以上进展风险、心血管高危或合并心力衰竭者；建议在 RAASi 基础上联合使用；治疗前评估血容量、感染与低血糖/酮症酸中毒风险；开始治疗后 2-4 周复查肾功能，eGFR 下降≥基线 30% 时建议停药并寻找原因；暂不适用：1 型糖尿病、肾移植、正在使用大剂量激素或免疫抑制剂、UACR>5000 mg/g、多囊肾",
  "为专家共识而非系统评价；引用文献的效应量在共识正文中以转述形式出现；指南索引未提供可解析的公开链接",
  "§5.4、§5.5、§4.2、§4.3"],
 ["S19", 19, "2024 KDIGO 慢性肾脏病评估和管理指南要点解读", "指南解读文章（二手）", "full_text", "国际（中文解读）", "2024-08-20", "", "applicability",
  "文章称 KDIGO 2024 指南将 SGLT2 抑制剂在 CKD 中的适用人群从 2 型糖尿病相关 CKD 扩展至广泛 CKD 人群并给予 1A 级推荐；称启动时 eGFR 的可逆性下降不是停药指标；引用 RASi 应滴定至已获批的最高耐受剂量",
  "为对指南的中文解读文章，非指南原文；本报告未直接阅读指南原文，故不据此陈述推荐强度",
  "§5.5、§2.3"],
 ["S20", 20, "国家医保局、人力资源社会保障部关于印发药品目录（2025年）的通知（医保发〔2025〕33号）", "官方政策文件", "regulatory_record", "中国", "2025-12-07 发布，2026-01-01 执行", "https://www.nhsa.gov.cn/art/2025/12/7/art_104_18970.html", "applicability",
  "新版药品目录自 2026 年 1 月 1 日起正式执行，2024 年版同时废止；支付以符合药品法定说明书适应症及医保限定支付范围为条件；医保支付范围不是对说明书的修改",
  "文件不含具体药品条目与价格；决策日 2026-06-30 落在其执行期内",
  "§5.2"],
 ["S21", 21, "《国家基本医疗保险、生育保险和工伤保险药品目录（2025年）》正文", "官方政策文件", "regulatory_record", "中国", "2025 年版", "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a32f9f2f3fc046afaf08471f87456ce3.pdf", "economics",
  "西药部分 XA10BK 钠葡萄糖协同转运蛋白2(SGLT-2)抑制剂项下：达格列净片为乙类，编号 165，备注栏为空；凡例第（十一）条规定备注栏用于规定限定支付范围，故该条目未设限定支付范围；目录未载支付标准金额",
  "目录正文不含价格或支付标准数值；未获取地方挂网价与集采中选价",
  "§5.2、§6"],
 ["S22", 22, "第十一批国家组织药品集中带量采购中选结果表", "官方政策文件", "regulatory_record", "中国", "第十一批", "https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=46863b415c9e4d119e9cc60af63ea962.pdf", "economics",
  "品种序号 8「达格列净口服常释剂型」列出 7 家中选企业及各自选省结果；Hetero Labs Limited 备注为因未能按协议供应、已取消中选资格",
  "所读 8 页结果表未载中选价格；供应中断提示采购层面需考虑替代安排",
  "§5.2、§6、§9"],
 ["S23", 23, "达格列净在华获批 慢性肾脏病患者治疗有了新希望（中国新闻网 2022-09-05）", "新闻报道", "full_text", "中国", "2022-09-05", "https://www.chinanews.com.cn/m/life/2022/09-05/9845330.shtml", "applicability",
  "报道称原研达格列净获 NMPA 批准用于治疗慢性肾脏病，称批准依据为 DAPA-CKD III 期试验",
  "为媒体报道，非监管原始记录，仅作线索；本报告不以其作为注册结论的依据",
  "§5.1"],
]

with open(os.path.join(D, "evidence-table.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(header)
    for r in rows:
        w.writerow(r)

print("summary + csv written; csv data rows:", len(rows))
