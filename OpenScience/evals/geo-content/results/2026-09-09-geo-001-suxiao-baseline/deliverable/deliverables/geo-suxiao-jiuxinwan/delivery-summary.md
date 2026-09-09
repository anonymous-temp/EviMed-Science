# 交付摘要（delivery-summary）

- 交付物：geo-suxiao-jiuxinwan —— 速效救心丸（国药准字Z12020025）GEO 内容包
- 内容语言：简体中文；产品名、批准文号、说明书原文与文献题录保留原样
- 编写与核对：EviMed 医学内容组；内容更新日期：2026-09-09
- 交付状态：**部分交付（partial）**。原因：本交付物提交达到部署上限（3 次）时门禁仍未给出通过回执，最后一次裁定仍列出 required 项（blocks 的作者资质/更新日期字段、安全规则表述）；这些项随后已在本地文件中修复（JSON 每 block 增加 author/authorCredential/updateDate；md 每 block 增加作者资质行；安全重申改为独立句），但因提交上限无法重新提交。同时 geo probe 后端本轮全程不可用，测量半场无有效轮次。请下一轮运行直接对当前文件重新提交以获得回执。

## 本包包含什么

1. **内容半场（完成）**：10 个患者问答内容块——5 个品牌问题（B1–B5）+ 5 个非品牌问题（U1–U5），每块按「结论 → 依据 → 条件」三段式，逐条主张绑定 citation-ledger.csv 中可解析来源。块内剂量、禁忌、不良反应等表述以 2026-09-09 检索到的 NMPA 说明书索引记录、2019《速效救心丸治疗冠心病中国专家共识》（全文快照留底）、相关 RCT/系统评价（摘要级）与 NHS 官方胸痛指引（全文哈希留底）为限。
2. **测量半场（未能完成）**：geo_visibility_probe 后端本轮全程不可用——20 次尝试（含 3 次单题探测）全部返回 MCP -32001 请求超时，而同一会话内 health、pubmed、drug_label_search、guideline_search、web_search 均正常。因此**没有任何有效测量轮次：无分母、无出现率、无引擎答案**。未把"超时"写成"引擎未提及品牌"，未计算任何比例。全部尝试按事件次序记入 geo-probe-log.jsonl（seq1–20，均 inDenominator=false），geo-monitor.csv 仅保留表头，geo-measurement.md 如实说明本轮未覆盖范围。
3. **机器可读件**：geo-content-pack.json、brand-entity.json、llms.txt（站点级片段，含 JSON-LD 与 FAQ 占位）。
4. **证据与台账**：citation-ledger.csv、references.bib、citation-audit.md、.internal/ 快照与修订基线。

## 安全优先表述（已写入包内"先读：急救边界"及各应急块）

- 含服后的症状缓解与否，不能用于区分胸痛是心脏性还是非心脏性，也不能排除心肌梗死；持续、反复或伴危险信号的胸痛应呼叫急救（120）急诊评估，与含服反应无关 [8]。
- 速效救心丸不能延误急救：当胸痛提示可能为急性心肌梗死时，应在含服的同时呼叫 120，而不是先含服观察、等药起效再决定 [8]。

## 本轮未覆盖 / 下一轮

- 任何平台 × 任何问题的引擎可见性测量均未发生（probe 服务不可用，非"未提及"）。
- 恢复测量后需补齐 10 题 × 5 平台 × new_chat 一轮（先 op=providers 检查登录态），将 geo-monitor.csv 首行回填并据此给出出现率。
- 发布前须用 NMPA 官方现行说明书复核标签引文与【用法用量】段；[3][6] 等中文期刊建议核 CNKI/官方全文后再对外引用；JSON-LD url/@id 需替换为站点正式域名；内容块正式发布应由具名执业医师/药师复核署名。

## 相关文件清单

geo-content-pack.md / geo-content-pack.json / brand-entity.json / geo-probe-log.jsonl / geo-monitor.csv / geo-measurement.md / llms.txt / revision-notes.md / citation-ledger.csv / references.bib / citation-audit.md
