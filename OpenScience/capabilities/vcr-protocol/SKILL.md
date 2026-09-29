---
name: vcr-protocol
description: 把一句话或一份方案草稿变成「虚拟临研」的研究定义卡与逐条结构化的入排条件，保留原文与出处。
---

# 研究定义与入排结构化

## 模型不产生数字

**这一步不算任何统计量。** 样本量、事件数、功效、把握度、入组速度、脱落率——全部来自 `mcp__evimed__vcr_read` 读到的已保存结果，或 `mcp__evimed__vcr_simulate` 排出去的引擎作业。你自己心算、估算、"大约"出来的数不得写进任何交付物。需要一个数而它还不存在时，写清楚它缺，并说明由哪一步产生。

## 一、先读，再写

1. `mcp__evimed__vcr_read` `{ "what": "study" }`：研究的名称、问题、数据档位、预期用途、七步进度、结局封存状态。
2. `mcp__evimed__vcr_read` `{ "what": "definition" }`：是否已经有定义卡。**有就改，不从头写**——写出去的是下一个版本，旧版本仍然可查。
3. `mcp__evimed__vcr_read` `{ "what": "criteria" }`：已有的方案版本和它的入排条件。重写条件得到的是新的方案版本，旧版本原样保留。
4. 有登记号就 `mcp__evimed__trial_registry_record`；有方案全文就用 `mcp__evimed__locate_quote` 把每条入排条件的原句定位下来。

## 二、研究定义卡

`mcp__evimed__vcr_write`，`what` 写 `definition`，一次写完，内容放在 `data` 里：

```json
{ "what": "definition", "data": {
  "pico": { "population": "…", "intervention": "…", "comparator": "…", "outcome": "…" },
  "estimand": { "population": "…", "variable": "…", "treatment": "…",
                "intercurrentEvents": [ { "event": "后续抗肿瘤治疗", "strategy": "treatment_policy" } ],
                "summary": "…" },
  "endpointType": "time_to_event",
  "intendedUse": "exploratory",
  "fieldSources": { "endpointType": "AI 设定：按主要终点的测量方式" } } }
```

- `pico`：每项写成一句可判定的话，不要形容词。
- `estimand`：ICH E9(R1) 的五要素——`population`、`variable`（终点变量）、`treatment`（处理条件）、`intercurrentEvents`（伴随事件及其处理策略）、`summary`（群体层面的汇总量）。**伴随事件的处理策略必须写**：治疗策略、假想策略、复合策略、在治策略、主层策略，写哪一条就说明理由。
- `endpointType`：`continuous`、`binary` 或 `time_to_event`。这决定后面所有方法的分支，认不准就按主要终点的实际测量方式定，并在 `fieldSources` 里说明依据。
- `intendedUse`：`exploratory`、`design_support`、`specified_analysis`、`submission_preparation`。**默认 `exploratory`**；只有用户明确说要做指定分析或申报准备时才往上提——提上去会触发结局封存，这是一件好事，但要让用户知道。
- `fieldSources`：每个字段一句来源，`"方案第 12 页"` 或 `"AI 设定：用户未指定，按同类研究惯例"`。这就是界面上那个「AI 设定」标签的内容。

写出去的定义立刻生效并带 `ai_set` 标签；不要问用户确认。**只有一种情况该问**：连要研究哪个人群、哪个干预都认不出来。字段写错（词表外的取值、多写的字段）会被逐项拒绝，`issues` 里有字段名，改了再写。

## 三、入排条件

第一次写方案用 `what: "protocol"`，修订用 `what: "criteria"`，`data` 的形状一样：

```json
{ "what": "protocol", "data": { "title": "EV-201 v1.0", "criteria": [
  { "kind": "exclusion", "criterionType": "time_window",
    "sourceText": "近 6 个月内发生过心肌梗死者除外",
    "sourceLocator": { "page": 12, "section": "4.2" },
    "requirement": { "op": "absent", "variable": "myocardial_infarction", "window": { "months": 6 } },
    "evidenceNeeded": ["出院记录", "心肌酶谱"] } ] } }
```

一次写入是**一个完整的方案版本**。每条条件只有这些字段：`kind`（`inclusion` 或 `exclusion`）、`criterionType`、`requirement`、`applicability`、`sourceText`、`sourceLocator`、`evidenceNeeded`；多写别的字段会被拒。

- `criterionType`：`demographic` `diagnosis` `biomarker` `lab` `prior_treatment` `time_window` `performance_status` `comorbidity` `concomitant_medication` `pregnancy` `consent_capacity` `other`。
- `sourceText`：**原句照抄**，一个字不改。
- `sourceLocator`：`{ "page": 12, "section": "4.2" }` 或 `{ "registryId": "NCT…", "field": "eligibility" }`。
- `evidenceNeeded`：判这一条需要哪些资料（病理报告、基因检测、某项检验及其时间窗）。

### `requirement` 的写法

要求的结构是封闭的，**只用下面这些节点**；别的写法（`{"field": "ecog", "op": "<=", "value": 1}`、`{"free_text": "…"}`）会被当场拒绝，因为匹配那一步读不懂它们。

| `op` | 含义 | 字段 |
|---|---|---|
| `all` / `any` | 全部满足 / 满足任一 | `operands`：节点数组（1 到 32 个） |
| `not` | 取反 | `operand`：一个节点 |
| `present` / `absent` | 有 / 没有某个事件或状况 | `variable`，可选 `window` |
| `compare` | 比较一个数或一个编码值 | `variable`、`comparator`、`value`，可选 `highValue`、`unit`、`window`、`aggregate` |
| `elapsed_since` | 距上一次某事已满 N 天（洗脱期） | `variable`、`days`，可选 `comparator`、`deniedSatisfies` |
| `language` | 只有读懂原话才能判 | `text`，可选 `key` |

- `variable`：小写英文加下划线，例如 `ecog`、`egfr_mutation`、`myocardial_infarction`。**后面匹配一步写患者事实用的是同一个变量名**，所以一个概念在整份方案里只用一个名字。
- `comparator`：`lt` `lte` `gt` `gte` `eq` `ne` `between` `in` `not_in`。`between` 要同时写 `value`（下限）和 `highValue`（上限）；`in` / `not_in` 的 `value` 是数组；其余的 `value` 是一个数（`eq` / `ne` 也可以是一个词）。实验室数值写 `unit`，否则单位不明的读数判不了。`aggregate` 是 `latest`（默认，取最近一次）、`all`、`any`。
- `window`：`{ "days": 28 }`、`{ "months": 6 }`、`{ "years": 5 }` 三选一，从评估日往回数；要从另一个日期往回数，加 `"anchorDate": "2026-01-01"`。
- `elapsed_since`：`{ "op": "elapsed_since", "variable": "chemotherapy", "days": 28 }` 表示距上次化疗至少 28 天；`"comparator": "gt"` 表示严格多于 N 天；`"deniedSatisfies": false` 表示病历里写着「从未接受过」也不算满足（要求必须有一次带日期的治疗记录时才用）。
- `language`：`{ "op": "language", "key": "consent", "text": "受试者能够理解研究内容并签署知情同意书" }`。只有词汇和数字都判不了的条件才用它；`key` 是一个短标识，同一份方案里不重复，匹配那一步按它回答。
- **不写表达式。** 任何以代码或公式写成的条件都会被拒绝。

`applicability` 是另一份同样文法的要求，写在条件旁边，不写进 `requirement`：条件不适用的人不是「未知」，没人该去为他找病历。例如「妊娠试验阴性」只适用于女性：

```json
{ "kind": "inclusion", "criterionType": "pregnancy", "sourceText": "育龄女性妊娠试验阴性",
  "requirement": { "op": "absent", "variable": "pregnancy" },
  "applicability": { "op": "compare", "variable": "sex", "comparator": "in", "value": ["female"] } }
```

### 三条铁律

1. **每条都写成「要满足的要求」。** 排除标准写成「不被这一条排除」的要求：「近 6 个月内发生过心肌梗死者除外」写成 `absent myocardial_infarction`（窗口 6 个月），于是「满足」在纳入与排除两种条件下意思一致。
2. **改写不得比原文更宽或更严。** 原文写「ECOG 0–1」就不要写成「ECOG ≤ 2」；原文写「三个月内」就不要丢掉时间窗。
3. **判不了不等于不符合。** 结构化时把「需要什么证据」写清楚，后面匹配那一步才会给出「未知」而不是「不符合」。

### 被拒的条件

结构不合规定的条件会被**逐条**拒绝（`vcr_criterion_malformed`，`issues[].field` 是 `criteria[n].requirement` 这样的路径），其余条件照常写入，但这一版就缺了被拒的那几条。**改好之后把全部条件整套再写一次**（得到新版本）；只补写被拒的几条，得到的是一个只有那几条的版本。

## 四、可估计性判断

定义写完，回答一个问题：**这个估计目标，在这个数据档位下，能不能估计？**

- `estimable`：能，方法明确。
- `limited`：能，但有明确限制（例如只能给单臂的率，不能给效应量）。
- `not_estimable`：不能，并列出缺什么。**这是一份完成的结果，不是失败。**

## 五、交付

三个文件，名字就是这三个：

| 文件 | 内容 |
|---|---|
| `study-definition.md` | 研究定义卡的可读版本：PICO、估计目标五要素、主要终点及其类型、预期用途、每个字段的来源；可估计性判断及理由 |
| `criteria.json` | 结构化入排条件数组，字段同上，**每条都带 `sourceText` 与 `sourceLocator`** |
| `results.json` | `{"conclusion": "...", "counts": {"realPatients": null, "events": null, "effectiveSampleSize": null, "generatedRecords": null}, "assumptions": [], "definitionVersion": <n>, "criteriaCount": <n>}` |

`results.json` 里的四个数这一步都是 `null`——**还没有数过任何人，写 `null`，不要写 `0`**。`conclusion` 就是上一节的判断。`definitionVersion` 和 `criteriaCount` 抄自写完之后 `mcp__evimed__vcr_read` 读回的定义版本（`definition.version`）和条件条数（`criteria` 数组的长度）。

`study-definition.md` 里出现的每一个数（版本号、条件条数）都要在 `results.json` 里有同样的字段；年份、页码、方案里原样引用的阈值不算手写数字。

## 六、运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定——它不消耗一次提交，检查的是交付前的步骤，不是交付规则本身：文件在不在、每条条件有没有原文与出处、结构化要求能不能读、四个数有没有分开写。它的发现全部是提示级——照它说的修，修不了的写进报告，不要为了让它闭嘴改数据。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
