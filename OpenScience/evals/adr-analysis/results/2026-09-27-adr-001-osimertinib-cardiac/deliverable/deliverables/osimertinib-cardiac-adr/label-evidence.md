# 说明书对照的逐条出处（附件）

本附件把 `safety-report.md` 第 5 节引用的说明书内容与其出处原文排在一起，供逐条核对。引文按行逐字照录，未改写、未截断。

说明：以下数字与表述是说明书文本中的内容，不是统计运行的输出，因此不出现在 `signals.csv` 中；统计运行的数值只出现在 `signals.csv` 与正文第 2、4 节。

---

## A. 美国现行说明书（TAGRISSO，osimertinib，薄膜衣片，口服）

**来源**：DailyMed（美国国家医学图书馆每日药物标签库）所载 TAGRISSO 标签全文，包装商 AstraZeneca Pharmaceuticals LP，标签更新日期 2026-09-14。
**可打开地址**：https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5e81b4a7-b971-45e1-9c31-29cea8c87ce7
**页面正文快照 SHA-256**：467c8cc1b997ff112a2d9a8926538c5e1274ba163f79ba84deaad14d45f667ad
**读取日期**：2026-09-27

本版本标签未设「黑框警告」（boxed warning）章节：标签正文自「RECENT MAJOR CHANGES」「INDICATIONS AND USAGE」直入「DOSAGE AND ADMINISTRATION」，未见黑框警告栏；第 5 节「WARNINGS AND PRECAUTIONS」共 9 小节（5.1 间质性肺病/肺炎、5.2 QTc 间期延长、5.3 心肌病、5.4 角膜炎、5.5 多形性红斑/Stevens-Johnson 综合征/中毒性表皮坏死松解症、5.6 皮肤血管炎、5.7 再生障碍性贫血、5.8 肌痛或肌炎伴肌酸磷酸激酶升高、5.9 胚胎-胎儿毒性）。

### A1. 第 5.2 节「QTc 间期延长」（原文）

> TAGRISSO can cause heart rate-corrected QT (QTc) interval prolongation. Of the 1813 patients treated with TAGRISSO monotherapy in clinical trials, 1.1% were found to have a QTc >500 msec, and 4.3% of patients had an increase from baseline QTc >60 msec [see Clinical Pharmacology (12.2)].
>
> Of the 276 patients treated with TAGRISSO in combination with pemetrexed and platinum-based chemotherapy in the FLAURA2 study, 1.8% were found to have a QTc >500 msec, and 10.5% of patients had an increase from baseline QTc >60 msec.
>
> No QTc-related arrhythmias were reported.
>
> Clinical trials of TAGRISSO did not enroll patients with baseline QTc of >470 msec. Conduct periodic monitoring with ECGs and electrolytes in patients with congenital long QTc syndrome, congestive heart failure, electrolyte abnormalities, or those who are taking medications known to prolong the QTc interval. Permanently discontinue TAGRISSO in patients who develop QTc interval prolongation with signs/symptoms of life-threatening arrhythmia [see Dosage and Administration (2.5)].

### A2. 第 5.3 节「心肌病」（原文）

> TAGRISSO can cause cardiomyopathy, including cardiac failure, chronic cardiac failure, congestive heart failure, pulmonary edema or decreased ejection fraction.
>
> Across clinical trials, cardiomyopathy occurred in 3.8% of the 1813 TAGRISSO-treated patients; 0.1% of cardiomyopathy cases were fatal.
>
> In the FLAURA2 study, cardiomyopathy occurred in 9% of the 276 patients who received TAGRISSO in combination with pemetrexed and platinum-based chemotherapy; 1.1% of cardiomyopathy cases were fatal.
>
> A decline in left ventricular ejection fraction (LVEF) ≥10 percentage points from baseline and to less than 50% LVEF occurred in 4.2% of 1557 patients who had baseline and at least one follow-up LVEF assessment. In the ADAURA study, 1.5% (5/325) of patients treated with TAGRISSO experienced LVEF decreases greater than or equal to 10 percentage points and a drop to less than 50%. In the LAURA study, following platinum-based chemoradiation therapy, 3% (4/135) of patients treated with TAGRISSO and no patients treated with placebo experienced LVEF decreases greater than or equal to 10 percentage points and a drop to less than 50%. In the FLAURA2 study, 8% (21/262) of patients treated with TAGRISSO in combination with pemetrexed and platinum-based chemotherapy, who had baseline and at least one follow-up LVEF assessment, experienced LVEF decreases greater than or equal to 10 percentage points and a drop to less than 50%.
>
> For patients who will be receiving TAGRISSO monotherapy, conduct cardiac monitoring, including assessment of LVEF at baseline and during treatment, in patients with cardiac risk factors.
>
> For patients who will be receiving TAGRISSO in combination with pemetrexed and platinum-based chemotherapy, conduct cardiac monitoring, including assessment of LVEF at baseline and during treatment, in all patients.
>
> Assess LVEF in patients who develop relevant cardiac signs or symptoms during treatment. For symptomatic congestive heart failure, permanently discontinue TAGRISSO [see Dosage and Administration (2.5)].

### A3. 第 2.5 节剂量调整表（与本研究问题相关的行，原文）

原表（Table 3）为「目标器官 | 不良反应 | 剂量调整」三列，以下照录相关行，行内竖线保留原形式：

```
| Cardiac [see Warnings and Precautions (5.2, 5.3)] | QTc † interval greater than 500 msec on at least 2 separate ECGs ‡ | Withhold TAGRISSO until QTc interval is less than 481 msec or recovery to baseline if baseline QTc is greater than or equal to 481 msec, then resume at 40 mg dose. |
|  | QTc interval prolongation with signs/symptoms of life-threatening arrhythmia | Permanently discontinue TAGRISSO. |
|  | Symptomatic congestive heart failure | Permanently discontinue TAGRISSO. |
```

第 2.5 节另有一行适用于「其他」不良反应的通用行，按严重程度分级写就，并不专指心脏事件（同一行内以三个并列条件给出处置）：

```
| Other [[see Warnings and Precautions (5.8 ), see Adverse Reactions (6.1) ] | Adverse reaction of Grade 3 or greater severity | Withhold TAGRISSO for up to 3 weeks. |
|  | If improvement to baseline or to Grade 0-2 within 3 weeks | Resume at 80 mg or 40 mg daily. |
|  | If no improvement within 3 weeks | Permanently discontinue TAGRISSO. |
```

### A4. 第 6.1 节各研究 QTc 延长发生率（原文）

> Clinically relevant adverse reactions in ADAURA in <10% of patients receiving TAGRISSO were alopecia (6%), epistaxis (6%), interstitial lung disease (3%), palmar-plantar erythrodysesthesia syndrome (1.8%), skin hyperpigmentation (1.8%), urticaria (1.5%), keratitis (0.6%), QTc interval prolongation (0.6%), and erythema multiforme (0.3%). QTc interval prolongation represents the incidence of patients who had a QTcF prolongation >500 msec.
>
> Clinically relevant adverse reactions in LAURA in <10% of patients receiving TAGRISSO were dyspnea (8%), urinary tract infection (8%), alopecia (1.4%), urticaria (1.4%), epistaxis (0.7%), keratitis (0.7%), and QTc interval prolongation (0.7%). QTc interval prolongation represents the incidence of patients who had a QTc prolongation >500 msec.
>
> Clinically relevant adverse reactions in FLAURA in <10% of patients receiving TAGRISSO were alopecia (7%), epistaxis (6%), interstitial lung disease (3.9%), urticaria (2.2%), palmar-plantar erythrodysesthesia syndrome (1.4%), QTc interval prolongation (1.1%), keratitis (0.4%), and skin hyperpigmentation (0.4%). QTc interval prolongation represents the incidence of patients who had a QTcF prolongation >500 msec.
>
> Clinically relevant adverse reactions in FLAURA2 in <10% of patients receiving TAGRISSO in combination with pemetrexed and platinum-based chemotherapy were alopecia (9%), epistaxis (7%), palmar-plantar erythrodysesthesia syndrome (5%), interstitial lung disease (3.3%), skin hyperpigmentation (2.5%), QTc interval prolongation (1.8%), erythema multiforme (1.4%), urticaria (1.4%), and keratitis (0.7%). QTc interval prolongation represents the incidence of patients who had a QTcF prolongation >500 msec.
>
> Clinically relevant adverse reactions in AURA3 in <10% of patients receiving TAGRISSO were epistaxis (5%), interstitial lung disease (3.9%), alopecia (3.6%), urticaria (2.9%), palmar-plantar erythrodysesthesia syndrome (1.8%), QTc interval prolongation (1.4%), keratitis (1.1%), erythema multiforme (0.7%), and skin hyperpigmentation (0.4%). QTc interval prolongation represents the incidence of patients who had a QTcF prolongation >500 msec.

---

## B. 中文说明书（泰瑞沙／甲磺酸奥希替尼片，NMPA 批准）

**来源**：EviMed 药品标签索引收录的「甲磺酸奥希替尼片（泰瑞沙/AZD9291/TAGRISSO，瑞典 AstraZeneca AB）」条目，批准文号 H20170166，索引快照导出于 2025-12-17，索引版本 drug-labels-cb075ba6a4db。
**索引条目按节引用标识**：label:H20170166#adverse-reactions、label:H20170166#precautions
**索引条目的原文地址**：https://www.315jiage.cn/mn224691.aspx
**读取日期**：2026-09-27

**来源限制（必须随引文一并阅读）**：该条目是公开标签数据库的快照，非国家药品监督管理局发布的现行说明书原文；索引警告该快照可能已被修订，且抓取字段可能被截断或错位。因此下列引文只能作为「该中文标签的快照如此记载」的证据，不能作为现行中文说明书已如此收载的结论；依赖任何具体条目时应核对现行 NMPA 批准的说明书。所引两条在快照中的完整长文见索引保存的 `adverse-reactions` 与 `precautions` 两份分节文件（下引为其中与本研究问题直接相关的段落，逐字照录）。

### B1. 「不良反应」节（原文，与心脏事件相关段落）

> 泰瑞沙治疗组患者中常见(>20％)不良事件为腹泻(42％)、皮疹(41％)、皮肤干燥(31％)和指(趾)甲毒性(25％)。导致剂量减少或中断治疗的常见不良事件为心电图QTc间期延长(2.2％)和中性粒细胞减少(1.9％)。

说明：以上引文中的个别汉字在索引快照中呈繁体写法（如「減少」「中斷」），本附件统一转写为简体，其余字符与标点逐字保留。

### B2. 「注意事项」节（原文，QTc 间期延长部分）

> 在服用本品的患者中出现过QTc间期延长。QTc间期延长可导致室性快速性心律失常(如尖端扭转型室性心动过速)或猝死的风险增加。AURAex或AURA2研究期间无心律失常事件报告(见[不良反应])。通过静息心电图(ECG)检测，这两项研究排除了心脏节律或传导方面出现临床显著性异常的患者(如QTc间期>470ms) (见[不良反应])。如果可能，患有先天性长QT间期综合征的患者应避免使用本品。患有充血性心力衰竭、电解质异常或使用已知能够延长QTc间期的药物的患者应定期接受心电图(ECG)和电解质的监测。至少两次独立心电图检测提示QTc间期>500ms的患者应暂时停用本品，直至QTc间期<481ms或恢复至基线水平(如基线QTc间期>=481ms)，此时可恢复用药，但应按表1进行减量。合并出现QTc间期延长和下列任何一种情况的患者需永久停用本品：尖端扭转性室性心动过速、多形性室性心动过速、严重性心律失常的症状或体征。

### B3. 「注意事项」节（原文，心肌收缩力改变部分）

> AURAex和AURA2临床试验中，具有基线和至少1次随访的LVEF评估的接受奥希替尼治疗的患者中2.4％(9/375)发生左心室射血分数(LVEF)下降>10％，且下降至<50％。根据已有临床试验数据，尚不能确定心肌收缩力的改变与本品有因果关系。对于有已知心血管风险及存在可能影响LVEF情况的患者，需要考虑监测心脏功能，包括在基线和服药期间测定LVEF功能。对于本品治疗期间出现心脏事件相关症状和体征的患者，需要考虑心脏监测包括LVEF功能测定。

### B4. 中文说明书的警告层级（本次读取范围内的记录）

本次读取的是索引条目中「不良反应」与「注意事项」两节；该条目的分节清单为：成份、性状、适应症、规格、用法用量、不良反应、禁忌、注意事项、药物相互作用，其中不含「黑框警告」节。因此本次读到的范围内没有黑框警告；该条目是否含其他未列出的警示层级，本次未核对，记为缺口。
