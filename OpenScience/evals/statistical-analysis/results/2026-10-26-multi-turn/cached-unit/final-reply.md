**结果：B 组相对 A 组的 marker_mm 平均差异为 0.296 cm（95% CI 0.232–0.360 cm）**，即原报告中的 2.96 mm（2.32–3.60 mm）。本次只把已经算好的毫米值按 1 mm = 0.1 cm 精确换算，没有重跑分析，也没有改动数据、分组、方法和随机种子。

**数值的换算情况**

| 量 | 毫米（原） | 厘米（新） |
|---|---|---|
| 均值差（B 减 A） | 2.959988 | 0.296 |
| 95% CI | 2.3153–3.6047 | 0.232–0.360 |
| Welch SE | 0.3238 | 0.0324 |
| 区间宽度 | 1.289 | 0.129 |
| A 组均值 ± SD | 10.233 ± 1.437 | 1.0233 ± 0.1437 |
| B 组均值 ± SD | 13.193 ± 1.459 | 1.3193 ± 0.1459 |
| 合并方差、bootstrap、Hodges-Lehmann、ANCOVA 的区间 | ≈2.31–3.61 / 2.33–3.58 / 2.36–3.57 / 2.31–3.61 | ≈0.231–0.361 / 0.233–0.358 / 0.236–0.357 / 0.231–0.361 |
| ANCOVA 年龄系数 | 0.0026 mm/岁 | 0.00026 cm/年 |

**没有变化的量**，因为它们与长度尺度无关或属于其他单位：

- Welch t = 9.14、df = 77.98、p = 5.8 × 10⁻¹⁴；bootstrap、合并方差、ANCOVA、Mann-Whitney 的 p 值也都不变；
- Cohen's d = 2.04（95% CI 1.65–2.56）、Hedges g = 2.02、合并 SD 之比：分子与分母同比例缩小 10 倍，因此比值不变；
- 相对差异 28.9%（95% CI 22.6%–35.2%）、P(B>A) ≈ 0.92、KS D = 0.65、U = 1468/1600、年龄–marker 相关 r = 0.046；
- 年龄相关量（均值 54.5 vs 55.5 岁、差 1.0 岁、校正前后比较）以年为单位，不参与换算；
- 样本量与队列流程（80 例，A、B 各 40）、所有假设检验的结论与局限。

**交付与保留**

- 新增文件：[厘米版报告](deliverables/statistical-analysis-report/statistical-report-cm.md)、[厘米差值表](deliverables/statistical-analysis-report/table-difference-estimates-cm.csv)、[厘米分组表](deliverables/statistical-analysis-report/table-group-summary-cm.csv)；换算脚本为 [convert_units.py](deliverables/statistical-analysis-report/convert_units.py)，换算记录为 [unit-conversion.json](deliverables/statistical-analysis-report/unit-conversion.json)，自检脚本为 [verify_units.py](deliverables/statistical-analysis-report/verify_units.py)（105 项检查全部通过）。
- 原始结果原样保留：`analysis-results.json`、两张毫米表、R 交叉核对、图、毫米版[原报告](deliverables/statistical-analysis-report/statistical-report.md)的 SHA-256 与完成时逐字节一致；报告中的每个厘米值都能回溯到对应毫米值乘以 0.1。

两点说明：我假设“换单位”指报告呈现层，`cohort.csv` 仍以 mm 存储；如果数据文件本身改成 cm，输入哈希会变，按原报告第 12 节第 3 条就必须重跑。图仍为毫米刻度，未重绘（估计值不受影响）；需要厘米刻度的图可以另出。