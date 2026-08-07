# 数据质量报告（data quality）

数据集：`20260803TDM.xlsx`（5 张表：病案首页 5 行、医嘱记录 915 行、检验 22 行、诊断记录 56 行、体征 537 行；共 93 个字段，9 个全空）。
分类口径：Kahn（2016）协调术语，即 FDA 2024 真实世界数据指南采纳的 **Conformance / Completeness / Plausibility** 三轴。
所有数字由 `scripts/quality_checks.py`、`scripts/domain_quantities.py` 与 `data-profile.py` 生成，可复算。

**凡报告"填充率"，均为 Weiskopf 四义中的 density completeness（该字段在多少比例的行上有值），不涉及取值正确性，也不是 documentation/breadth/predictive 三种完整性。**

---

## 1. Conformance（一致性）

### 1.1 Value conformance（取值一致性）

| 发现 | 证据 | 影响 |
|---|---|---|
| **本地疗程编码词表（核心陷阱）**：`FREQUENCY` 共 30 个取值，含 `QD12`、`BID4`、`W4D8`、`W5D8`、`QN`、`ALWAYS`、`PRN` 等。数字后缀是**疗程长度而非每日次数**（QD12＝每日 1 次×12 天；W4D8＝每周 4 天×8 周）。`BID4` 不能读作 4 次/日 | 医嘱记录.FREQUENCY 词表（30 值，见 data-profile.md） | 若把 `QD12` 当 12 次/日、`BID4` 当 4 次/日，**日剂量偏差 2–12 倍**，全部 C/D 比值与暴露窗口计算作废 |
| **品牌名与化学名混用**：帕利哌酮（芮达）5 条医嘱全部只写品牌名"芮达"，检验项目名写"帕利哌酮（帕潘立酮）" | `drugOrderCoverage.帕利哌酮: genericNameOrders=0, brandNameOrders=5` | 不做品牌-通用名映射，检验-医嘱连接在帕利哌酮上断裂（本次已出现 1 例剂量缺失） |
| **医嘱≠给药执行**：`ORDER_STATE` 仅区分已停止/已作废；无执行/发药时间戳；`MEDICATION_WAY=领药/退药` 各 4/2 条 | 医嘱记录 | 处方暴露只能作为"医嘱暴露"，不能当作实际服药 |
| **复合值**：血压 `129/74` 式（53 行，52 行可解析、1 行解析失败）；`OTHER_DIAGNOSIS_CODE/NAME` 竖线分隔（各 1 行，如 6 个并存诊断）；`DRUG_SPEC` 含 `*1g`、`5mg*1片`（13 处） | data-profile.md 备注列 | 不拆分则血压不可算、合并症计数错误 |
| **哨兵值**：`END_DATETIME=0/0/0 00:00:00` 105 行（11.5%），语义为"在院未停"；`UNIT/DRUG_SPEC/MEDICATION_WAY=无`（418 行＝非药品医嘱的占位） | 医嘱记录（105 行哨兵）；data-profile.md | 日期解析直接失败（实测抛错）；`无` 若当作真实剂量单位则剂量解析出错 |
| **年龄类型跨表不一致**：病案首页 `AGE`＝text（`21岁`…），检验 `AGE`＝integer（21…56） | data-profile.py 的 typeConflicts | 跨表聚合/连接会静默失败 |
| 局部编码：`SEX`∈{1,2}、`BLOOD_TYPE`∈{2,3,6}、`BLOOD_RH`∈{2,4}、`ORDER_TYPE`∈{1..5}、`ADM_WAY/DIS_WAY/DIS_RESULT` 各 1 个取值 | quality_checks.localVocabularies | 取值语义需机构编码表核对（如 SEX 推测为 1=男、2=女，未验证）；`DIS_RESULT=0` 全列单一取值 |
| 体征含 3 个**无表头列**：2 个全空，1 个 5 个值（0.9%），形似操作员编号；`RECORD_UNIT` 全空 | data-profile.md | 无表头列取值已做标识符屏蔽；单位缺失使体征数值单位需按 SIGN_TYPE 推断 |

### 1.2 Relational conformance（关系一致性）

| 发现 | 证据 |
|---|---|
| `PATIENT_ID` 与 `CASE_NO` 在病案首页/医嘱/检验/体征四表均为 100% 填充、5 个不同值，互相可达（包含度 100%） | data-profile.md 跨表连接表 |
| **诊断记录.PATIENT_ID 填充率为 0%**（空连接键陷阱），但 `CASE_NO` 100% 填充、5 个不同值，与病案首页 5 个 CASE_NO 完全一致 | 同上；quality_checks.diagnosisJoin |
| 药品与非药品医嘱标记自洽：`ORDER_TYPE=1` 497 行 ⇔ `DRUG_FLAG=1` 497 行（计算一致性通过）；`DRUG_CODE/DRUG_NAME` 仅药品医嘱有值（54.3%，有设计原因） | 医嘱记录 crosstab |

### 1.3 Computational conformance（计算一致性）

- 医嘱时间序：810 条非哨兵"起止双全"记录全部满足 `END ≥ START`；105 条哨兵为未停医嘱（quality_checks.orderTimeOrder）。
- 年龄与出生日期：5 例均在院龄与出生日期推算年龄一致（差值 ≤1.5 岁，mismatch=0）。
- 住院日：`DAY_TOTAL` 与入出院日期差全部一致（mismatch=0）。
- 检验申请日期 ≤ 检验日期（22/22）；22 条检验全部落在住院窗口内（quality_checks.tdmTiming）。

## 2. Completeness（完整性，density 口径）

| 字段 | density | 说明 |
|---|---|---|
| 病案首页：ID/PATIENT_ID/CASE_NO/MED_REC_NO/SEX/AGE/BIRTHDATE/IN_DATE/DIS_DATE/MAIN_DIAGNOSIS_CODE 等 | 100% | 核心人口学与管理字段齐全 |
| `AGE_UNIT`、`PATHOLOGY_DIAGNOSIS_CODE/NAME`、`DRUG_ALLERGENS_NAME` | 0% | 病理诊断、过敏原、年龄单位三组字段全空 |
| 诊断记录：`PATIENT_ID` | 0% | 空连接键（但 CASE_NO 100%） |
| 诊断记录：`DIAGNOSIS_CODE` | 80.4% | 45/56 有编码，11 行只有名称 |
| 诊断记录：`DIAGNOSTIC_CONTENT` | 0% | 全空 |
| 检验：`REFFR_SCOPE` | 72.7% | **脱氢阿立哌唑 6 条全部无参考范围**（该分析物在实验室主数据中缺范围） |
| 医嘱：`DRUG_CODE/DRUG_NAME` | 54.3% | 非药品医嘱（护理/化验/中医外治）按设计无值 |
| 体征：`RECORD_UNIT`、2 个无表头列 | 0% | 单位字段全空 |
| 体征无表头第 3 列 | 0.9% | 5 个疑似操作员编号 |

补充（领域完整性）：TDM 信号层面——检验表仅 **6 个采样事件 × 5 位患者**（P4 两次），其中阿立哌唑三件套 6 事件、其余 4 药各 1 次单测；无 CYP 基因型、无给药执行时间、无采血时刻（`TEST_DATE` 仅到日）。这不是字段密度问题，而是**该领域结论可承载度的硬约束**（见 research-portfolio.md）。

## 3. Plausibility（合理性）

### 3.1 唯一性
- 医嘱 `DOCTOR_ORDER_ID`/`ORDER_NO` 915/915 唯一；体征 `RECORD_ID` 537/537 唯一；检验 `SAMPLENO` 6 个批次（每个批次＝一次采样，行数＝同时测定的分析物数）。

### 3.2 时点合理性（atemporal/temporal）
- 全部 5 例 `IN_DATE < DIS_DATE`；住院时长 15–49 天（P4 最长，49 天）。
- 体征 537 条中 503 条在住院窗口内；记录时刻以 14:00 定点为主（392/537），另有 10:00×62、18:00×48 等（非全部定点；34 条在窗口外，多为入出院当日边界）。
- 阿立哌唑 12 条医嘱剂量 {5,10,15} mg，频次 {QD,QN,BID4,ONCE}；氯氮平剂量 100–300 mg、频次 {QD11,QD12,QN,ONCE} —— 与检验申请（TEST_PURPOSE）一致，未发现逻辑矛盾。

### 3.3 有效性（validation）
本批未进行任何外部基准校验（无机构外部金标准可用）；以上均为 verification（对照元数据与内部一致性）。`REFFR_SCOPE` 与 AGNP 2017 共识参考范围的对照属于外部基准对照，但该对照在 external-linkage.md 中完成（本报告不重复断言）。

---

## 4. 强制性预处理清单（mandatory preprocessing list）

1. **统一日期解析**：所有日期按"日/月/年"解析（`25/12/2020`＝2020-12-25），并把 `0/0/0 00:00:00` 先识别为"未停/未设"再处理。否则住院时长、医嘱暴露窗口、稳态天数全部错算或直接抛错。
2. **校验 FREQUENCY 疗程解码**：向 HIS 厂商确认 `QD<n>/BID<n>/TID<n>/W<d>D<w>` 语义后再定日剂量系数；本报告暂按"QD=1、QN=1、BID=2、TID=3、QOD=0.5、W<d>D<w>=d/7、PRN=不可算"处理并**在方法学中如实声明**。否则日剂量偏差可达数倍，C/D 比值与所有剂量-浓度分析失效。
3. **剔除出院带药/领药/退药**：`MEDICATION_WAY=出院带药`（25 条）等不属于住院期间在用方案，不能进入"采样日有效医嘱"。否则把出院带药计入在院方案，暴露窗口与 C/D 计算系统性失真。
4. **统一 AGE 类型**：剥离"岁"后缀转数值，跨表按数值类型连接。否则病案首页×检验的聚合静默失败。
5. **拆分复合值**：血压拆 SYS/DIA（52/53 可拆，1 条解析失败需人工核对）；`OTHER_DIAGNOSIS` 竖线拆分计合并症；`DRUG_SPEC` 解析规格。否则血压不可算、合并症计数错误。
6. **诊断记录一律经 CASE_NO 连接**：`PATIENT_ID` 全空，仅 `CASE_NO` 可达（包含度 100%）。否则诊断信息整表丢失。
7. **药品名品牌-通用名映射**（芮达→帕利哌酮等，优先用 RxNorm 解析）：否则检验分析物↔医嘱连接在品牌名药品上断裂（本数据已出现 1 例）。
8. **暴露捕获完整性如实报告**：P2 的采样日无阿立哌唑在院医嘱（检验却报阿立哌唑 63 ng/mL）——把这类"有浓度无医嘱"样本标记为暴露来源不明（疑似入院前用药/换药窗），不得静默丢弃或默认为 0 剂量。否则 C/D 的分子分母错配，审计结果偏差。
9. **补全脱氢阿立哌唑参考范围**：从 AGNP 2017 共识补 20–60 ng/mL 并标注外部来源；不补则代谢物范围状态全部"未分类"。
10. **输出前脱敏**：所有标识符（患者、病例、病历号、医嘱号、样本号、行号）一律以化名 P1–P5、样本 S1–S6 指代，禁止外带任何源值；否则构成再识别风险（本次运行已加固 data-profile.py 的屏蔽规则并复算通过）。
11. **稳态/谷浓度不可假设**：数据无采血时刻与给药时刻，凡涉及"谷浓度""稳态"的结论一律标为**不可判定/缺失字段**，不得按惯例假设。否则会把他峰浓度当谷浓度，临床解释错误。

> 以上 11 项任一项被跳过，research-portfolio.md 中 Q1–Q3 的可复算数字与任何下游暴露/浓度分析即告失效。
