---
name: vcr-protocol
description: 把一句话或一份方案草稿变成「虚拟临研」的研究定义卡与逐条结构化的入排条件，保留原文与出处。
---

# 研究定义与入排结构化

## 模型不产生数字

**这一步不算任何统计量。** 样本量、事件数、功效、把握度、入组速度、脱落率——全部来自 `vcr_read` 读到的已保存结果，或 `vcr_simulate` 排出去的引擎作业。你自己心算、估算、"大约"出来的数不得写进任何交付物。需要一个数而它还不存在时，写清楚它缺，并说明由哪一步产生。

## 一、先读，再写

1. `vcr_read` `what: "study"`：研究的名称、问题、数据档位、预期用途、七步进度、结局封存状态。
2. `vcr_read` `what: "definition"`：是否已经有定义卡。**有就改，不从头写**——写出去的是下一个版本，旧版本仍然可查（AC-05）。
3. 有登记号就 `trial_registry_record`；有方案全文就用 `locate_quote` 把每条入排条件的原句定位下来。

## 二、研究定义卡

`vcr_write` `what: "definition"`，一次写完：

- `pico`：`population` / `intervention` / `comparator` / `outcome`，每项写成一句可判定的话，不要形容词。
- `estimand`：ICH E9(R1) 的五要素——`population`、`variable`（终点变量）、`treatment`（处理条件）、`intercurrentEvents`（伴随事件及其处理策略）、`summary`（群体层面的汇总量）。**伴随事件的处理策略必须写**：治疗策略、假想策略、复合策略、在治策略、主层策略，写哪一条就说明理由。
- `endpointType`：`continuous` / `binary` / `time_to_event`。这决定后面所有方法的分支，认不准就按主要终点的实际测量方式定，并在 `fieldSources` 里说明依据。
- `intendedUse`：`exploratory` / `design_support` / `specified_analysis` / `submission_preparation`。**默认 `exploratory`**；只有用户明确说要做指定分析或申报准备时才往上提——提上去会触发结局封存（§6.5），这是一件好事，但要让用户知道。
- `fieldSources`：每个字段一句来源，`"方案第 12 页"` 或 `"AI 设定：用户未指定，按同类研究惯例"`。这就是界面上那个「AI 设定」标签的内容。

写出去的定义立刻生效并带 `ai_set` 标签；不要问用户确认。**只有一种情况该问**：连要研究哪个人群、哪个干预都认不出来。

## 三、入排条件

`vcr_write` `what: "criteria"`，`criteria` 是一个数组，每条：

- `kind`：`inclusion` 或 `exclusion`。
- `criterionType`：从封闭词表里选（`demographic` `diagnosis` `biomarker` `lab` `prior_treatment` `time_window` `performance_status` `comorbidity` `concomitant_medication` `pregnancy` `consent_capacity` `other`）。
- `requirement`：**结构化的可判定形式**，例如 `{"field":"ecog","op":"<=","value":1}`、`{"field":"egfr_mutation","op":"in","value":["19del","L858R"]}`、`{"field":"prior_lines","op":">=","value":1,"window":{"months":6}}`。一条判不了的自由文本条件，写成 `{"free_text": "..."}` 并在 `evidenceNeeded` 里写清要什么证据才能判。
- `sourceText`：**原句照抄**，一个字不改。
- `sourceLocator`：`{"page": 12, "section": "4.2"}` 或 `{"registryId":"NCT…","field":"eligibility"}`。
- `evidenceNeeded`：判这一条需要哪些资料（病理报告、基因检测、某项检验及其时间窗）。

三条铁律：

1. **每条都写成「要满足的要求」。** 排除标准写成「不被这一条排除」的要求，于是「满足」在两种条件下意思一致，Kleene 三值逻辑才能直接用（§7.1）。
2. **改写不得比原文更宽或更严。** 原文写「ECOG 0–1」就不要写成「ECOG ≤ 2」；原文写「三个月内」就不要丢掉时间窗。
3. **判不了不等于不符合。** 结构化时把「需要什么证据」写清楚，后面匹配那一步才会给出「未知」而不是「不符合」（AC-14）。

## 四、可估计性判断

定义写完，回答一个问题：**这个估计目标，在这个数据档位下，能不能估计？**

- `estimable`：能，方法明确。
- `limited`：能，但有明确限制（例如只能给单臂的率，不能给效应量）。
- `not_estimable`：不能，并列出缺什么。**这是一份完成的结果，不是失败**（§3.6）。

## 五、交付

三个文件，名字就是这三个：

| 文件 | 内容 |
|---|---|
| `study-definition.md` | 研究定义卡的可读版本：PICO、估计目标五要素、主要终点及其类型、预期用途、每个字段的来源；可估计性判断及理由 |
| `criteria.json` | 结构化入排条件数组，字段同上，**每条都带 `sourceText` 与 `sourceLocator`** |
| `results.json` | `{"conclusion": "...", "counts": {"realPatients": null, "events": null, "effectiveSampleSize": null, "generatedRecords": null}, "assumptions": [], "definitionVersion": <n>, "criteriaCount": <n>}` |

`results.json` 里的四个数这一步都是 `null`——**还没有数过任何人，写 `null`，不要写 `0`**（§3.5）。`conclusion` 就是上一节的判断。

`study-definition.md` 里出现的每一个数（版本号、条件条数）写成 `{{n:definitionVersion}}`、`{{n:criteriaCount}}` 这样的引用；平台按 `results.json` 渲染（§8.3）。年份、页码、方案里原样引用的阈值不算手写数字。

## 六、运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定——它不消耗一次提交，检查的是交付前的步骤，不是交付规则本身：文件在不在、每条条件有没有原文与出处、结构化要求能不能读、四个数有没有分开写。它的发现全部是提示级——照它说的修，修不了的写进报告，不要为了让它闭嘴改数据。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
