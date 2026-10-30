已按校正后的标签重跑分析并更新报告。

## 校正后的结果

最核心的改动不在数字本身，而在这句话的方向：**B 组在 `marker_mm` 上比 A 组低 2.96 mm，95% 置信区间 -3.60 至 -2.32 mm**（Welch，t = -9.14，自由度 77.98，p = 5.76e-14）。

| 估计 | 校正后 |
| --- | --- |
| Welch（主分析） | -2.96（-3.60 至 -2.32） |
| 合并方差 t | -2.96（-3.60 至 -2.32），自由度 78 |
| Mann-Whitney | U = 132，p = 1.34e-10（无 mm 区间） |
| 自助法交叉核对 | -2.96（-3.60 至 -2.33），SE 0.33 |
| 年龄调整 | -2.96（-3.61 至 -2.31），年龄项 p = 0.855 |

描述统计随之互换：A 组均值 13.19、B 组均值 10.23。

## 为什么方向会变

估计目标定义为 B 减 A。校正文件把两组的标签整体对调，等于把两组占据的数值集合互换，于是差值必然取相反数；这是算术恒等，不是重新算出“大概是负的”。

因此统计量分成两类：

- **带方向的取负**：均值差、区间两端（交换并取负）、t 值、Hedges g、带符号的年龄标准化差 → 2.96→-2.96、2.32~3.60→-3.60~-2.32、9.14→-9.14。
- **只衡量差异大小的不动**：Welch 自由度 77.98、p 值 5.76e-14、|g| 2.02、R² 0.5174 逐位相同。
- **取补**：Mann-Whitney U 从 1468 变成 132，正好是 40×40 − 1468，是“两组互换”的又一个直接证据。

所以变的是“哪个组更高”这个指向，而不是“差别很大”这个证据——上一版在旧标签下没写错，只是在正确标签下必须是“A 组更高”。

## 校正本身也验过，不是照单全收

`data/coding-correction.csv` 与 `data/cohort.csv` 按患者逐条比对：患者集合相同（80 例、无重复）、年龄 0 处不符、测量值 0 处不符、80/80 全部为 A↔B、交换后组内数值集合恰为对方；若其中任何一项不成立，校验脚本直接失败、后续分析不启动。原始 `data/cohort.csv` 未作任何修改（哈希未变）。

必须写明的假设：数据内部无法证明哪套标签是真的。报告以校正文件为准，若该裁定本身相反，方向需再翻一次——这一点写进了限制一节。

## 保留了原分析依据

方法学一字未改（Welch 主分析 + Student / Mann-Whitney / 年龄调整 / 自助法交叉核对及其适用条件）、原有的诊断（方差比 1.03、年龄整体差 1 岁的结构性偏移、Cook 距离超标 1 例且未做剔除重估、VIF 1.002、无缺失）和四条参考文献都保留；校正前的报告、结果、图、校验与会话定义归档在 `history/`，新报告用“旧口径”对照表逐条列出旧数值，可直接与归档文件核对，不用重跑旧标签。

## 可更新性

入口 `analysis.py` 现在是五步（校正校验 → 画像 → 估计 → 作图 → 数字校验），默认读 `data/coding-correction.csv`；报告里 71 处数字全部绑定到结果文件（含归档文件），校验通过；整链重跑一次确认输出逐字节一致。

- 报告：[statistical-report.md](deliverables/marker-group-comparison-report/statistical-report.md)
- 图：[figure-group-comparison.svg](deliverables/marker-group-comparison-report/figure-group-comparison.svg)
- 校正校验：[coding-correction-check.json](deliverables/marker-group-comparison-report/coding-correction-check.json)
- 归档旧版：[history/statistical-report-original-coding.md](deliverables/marker-group-comparison-report/history/statistical-report-original-coding.md)