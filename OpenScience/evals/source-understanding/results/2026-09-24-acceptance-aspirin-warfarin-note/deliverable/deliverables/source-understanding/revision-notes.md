# 修订记录：source-understanding（阿司匹林与华法林联用）

源标识：src_1c3a3a0f7129a3b6a80207a7adda1968，generation 1。交付目录内保留的 `source-understanding-input.json` 与工作区输入副本逐字节一致（`cmp` 无差异）。源文本按不可信证据处理：其中不含针对本次任务的指令、工具调用或额外任务，理解过程中未执行、未采纳其任何祈使性内容。

## 一、锚点复核（traceability-review）

对 4 个已知槽位值、3 条 claim 共 10 条锚点逐条回查冻结输入：条条命中真实单元 `…:g1:u1`，`start`（含端）/`end`（排他端）均落在该单元 [0,114) 内，且 `text[start:end]` 与 `quote` 逐字符相等（脚本核对，0 处不符）；`sourceId`、`generation` 与输入一致。本包未生成图件，故无图件可核；本契约的锚点只对保留的源文档解析，未向任何外部来源核验引用，也未作外部引文审计。

复核中确认解释保留了原文的条件与数量：

- CLM-01 保留“12 项研究”“低剂量阿司匹林”“约 1.5 倍”“RR 1.5”“95% CI 1.3–1.8”，未把“约”改为确定值，未补写对照组、随访时长或研究设计。
- CLM-02 保留人群“房颤合并稳定冠心病”，未删去“稳定”这一限定，未把“指南建议”改写成疗效结论，也未指认具体指南名称（原文未给出）。
- 主题槽位取值即标题原文；decisions 槽位取值即原文第二段整句。映射说明：该笔记属“notes”体裁，四个槽位是体裁的通用框架；原文未记录作者本人的决策或行动，故 actions、openQuestions 记为 unknown，decisions 位置只填入原文自己陈述的、与“是否联用”直接相关的结论性内容（指南建议），取值本身仍按原文措辞，不冠以“我们决定”之类原文没有的表述。
- 未把“一项荟萃分析显示”这一未标注出处的转述升格为可追溯证据；summary 中如实写明原文未标注该荟萃分析的文献出处。

按上述回查结果，未发现需要撤回或改为 unknown 的解释。

## 二、措辞清理（manuscript-humanize）

清理前先另存 `pre-edit` 副本，并登记受保护集合：证据数组（含 sourceId、generation、unitId、start、end、quote）、全部数字（12、1.5、1.5、95%、1.3、1.8）、槽位取值与 unknown 理由、claims 陈述、遗漏审计的 status / omissionRate / samples / represented。本包语言为中文，故按中文写作规则处理。

仅改动两处散文字段，均以就地编辑完成，未整篇重写：

- `summary`：去掉“本文档是……其一……其二……”的对照式框架与“并列记录于同一主题之下”这类空转表述，改为直述两条内容，句子长短交错。数字与限定词一字未动（12 项研究、约 1.5 倍、RR 1.5、95% CI 1.3–1.8 原样保留）。
- `omissionAudit.reason`：把契约内部字段名换成读者能读懂的“按抽样列出的 1 个单元”，审计的 status、omissionRate、samples、represented 均未改动。

机械核对：`scripts/verify_preserved.py --before .tmp/pre-edit.json --after deliverables/source-understanding/source-understanding.json` 返回 `ok: true`、`issues: []`（字符数 4060 → 4053，缩减 0.2%，远低于证据被删的告警线）。该助手不识别本契约的证据数组，故另以 JSON 值比较核对：除 `summary` 与上述 `reason` 外，slots、claims、methods、generation、sourceId、unitId、start、end、quote 与清理前逐值相等；审计数据未移动。

## 三、遗漏审计

输入 `auditSample` 列出 1 个单元：`…:g1:u1`，即全文唯一的文本单元；未另行挑选单元，也未跳过列出的单元。以本记录已定稿的锚点判定：该单元被 10 条锚点中的多条命中（主题、荟萃分析结论、指南建议），判为 represented = true。未代表单元 0 个，已审计单元 1 个，omissionRate = 0.0，status = audited。本条为按锚点核对得出的实测值，非估算；若控制面据锚点重新推导得出不同结论，以控制面推导为准。

本轮未发现真实遗漏，故不存在“为掩盖缺口而改样本”的情形；也没有为让被抽中单元显得被代表而新增锚点——该单元的锚点在做审计之前就已存在。
