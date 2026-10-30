---
name: vcr-matching
description: Two-way eligibility matching for a 「虚拟临床研究」 study — structure a protocol's criteria, locate every patient fact in its source text with a character span and a visibility time, answer the language-only criteria with a quote, and hand back the computed four-state judgment set with its evidence gaps. Matching ends at scientific assessment.
metadata:
  evimed-agent: vcr-matching
---

# Evidence-backed patient and trial matching

Support both directions: identify trials for one person, or assess an authorized
patient collection against a protocol. Work in Chinese unless requested otherwise.
Matching ends with criterion evidence, unknowns, exclusions and recheck needs.

## Shared operating contract

Read [../vcr-protocol/references/operating-contract.md](../vcr-protocol/references/operating-contract.md) before this workflow; reuse it when already loaded in this conversation. It defines task scope, data requirements, evidence and continuation boundaries.

## Start from an original case

Use `mcp__evimed__vcr_read` what `patient_context` to inspect bounded authenticated human message candidates (`filter.beforeSeq`, `filter.limit`); select the actual case with `mcp__evimed__vcr_write` what `patient_context`, data `{messageSeq}`. Do not infer that the latest instruction is the case. An owned human-upload original can use data `{sourceId}`; compiled knowledge pages, saved assistant outputs and platform-produced sources are not human uploads. Reuse the
returned `subjectKey`/`documentId`. Do not invent patient facts, original text,
patient identifiers, source times or a source-processing permission. For a patient
looking for trials, search and read the dated registry record, then register
`candidate_trial` criteria. No internal trial protocol or study-definition card is
a prerequisite for that direction. A record without original eligibility text has
unknown coverage, not an eligible verdict.

Use original wording and exact document or authorized table-cell evidence.
`mcp__evimed__vcr_read` matching with a selected subject and `candidate_trials` for a selected
trial preserve granted per-criterion quotes/locators in both directions. Individual
clinical evidence and counts of criteria are not population disclosure cells;
aggregate people-count protections remain in force. Revoked sources and hidden
trial intervals cannot be restored by paraphrasing, model memory or fill-forward.

The evaluator computes the final verdict. The model interprets only language
criteria with cited evidence. A human override stays distinguished from the model's
or code's judgment. Describe supplementary evidence as scientific gaps; do not
create a contact/referral workflow or promise enrollment.

## Evidence decisions before writing an assessment

Read the scope-independent `mcp__evimed__vcr_read` what `contracts` and the existing matching contract before mutations. A rejected write is not a reason to probe by saving an empty patient collection or decision. For uploaded case batches, use the preserved original handles from `data_intake` and its `import_documents` action; use returned pseudonyms, never identifiers guessed from file rows. Automated evaluation requests are not authenticated human messages: do not guess message sequence numbers or change automation flags. Use the owned-upload path.

Keep three questions separate for every criterion: does the criterion apply, is the necessary fact recorded, and does that fact satisfy it? Missing a prerequisite means unknown applicability, not not-applicable. Proven inapplicability stays `applicable: false` in the saved assessment and reader output. Missing family history is not a negative family history. Age alone does not establish menopause, pregnancy, fertility, consent or eligibility. A diagnosis/symptom does not establish an undocumented procedure, treatment failure or imaging modality. A known negative finding must be an explicit negative finding in the original evidence.

A fact states only what its quotation says. What the text does not mention is unknown, never `negated`: use `negated` (or assertion `negated`) only when the quotation itself denies the finding, for example 「否认妊娠」 or "denies pregnancy". A sex, an age or a diagnosis is a fact about itself, not a quotation for pregnancy, lactation, menopause, fertility, a procedure or a negative result; leave such a fact unwritten and the criterion stays unknown. Two facts about different variables should not rest on the same words unless the words state both (「未绝经」 does). A fact write that answers with a `negated_on_words_of_another_fact` notice names both facts: if the text does not deny the finding, correct the negated fact with `clinical.correctionOf` and assertion `unknown`.

A registry publication date, dataset year, file modification time and upload time are source metadata, not patient encounter or event dates. Do not derive a birth year or washout interval from an undated reported age or from benchmark metadata. Only a clinical encounter/event anchor in the source supports calendar arithmetic. For a new exact `occurredAt` or `recordedAt`, include the stated calendar date in its source quotation; otherwise omit that timestamp and retain the corresponding uncertainty.

Do not mark a person eligible while your own explanation says a required fact remains unconfirmed. Read the evaluator's assessment back; preserve its `applicable` and `state` separately. If protected subject intake or evaluation could not complete, deliver any useful file-based interpretation as provisional and explicitly state that a persisted patient assessment was not produced. Never replace the evaluator's unknown with a confident statement in an exported file.

Every criterion belongs to the trial or protocol version it was written from, and its `sourceText` is copied from that record. Several trials for one patient are several `candidate_trial` items, each carrying only the lines of its own registry record; a criterion whose wording is in another held trial's record and not in this one is refused as `criterion_from_other_trial`, naming the trial it belongs to. Move it to that trial or write this trial's own wording; never merge two trials' criteria into one.

Every eligibility verdict you deliver, whether a sentence in the reply, a table or a file, is copied from the saved read-back and never retyped from memory or from your own reasoning: `mcp__evimed__vcr_read` matching with `filter.subjectKey` for a protocol (`summary`, each judgment's `state` and `applicable`), or `candidate_trials` with `filter.subjectKey` for registry trials (`ranking`: `registryId`, `eligibility`, `criteriaCounts`, `evidenceGaps`). Read it back after the last write and before the table. If your own reading differs from a saved judgment, deliver the saved one and add your difference as a separate sentence marked as yours; a language criterion still owed an answer is delivered as pending.

## 一、读方案，必要时结构化

`mcp__evimed__vcr_read` `{ "what": "criteria" }` 给出最新的方案版本和它的条件（每条带 `id`、`kind`、`requirement`、`applicability`、`sourceText`）。
**评估针对明确选择的方案版本**；读取时可用 `filter.protocolVersionId`，不指定才取最新版本。没有条件时先写：`mcp__evimed__vcr_write` `what: "criteria"`（首次写方案用 `what: "protocol"`），
`data` 是 `{ "title"?, "criteria": [ … ] }`，一次写入是一个完整的方案版本，旧版本仍在。

纳入标准写成「要满足的要求」；排除标准照原句写「会被排除的情况」：「既往接受过多西他赛者除外」写成 `present prior_docetaxel`，不要自己取反——平台把它存成「不被这一条排除」的要求，读回来的排除标准仍是你写的样子，改写时照读到的写。
条件只有这些字段：`kind`（`inclusion` / `exclusion`）、`criterionType`、`requirement`（排除标准照原句写会被排除的情况）、`applicability`、`sourceText`（原句照抄）、`sourceLocator`、`evidenceNeeded`。

要求的文法是封闭的，不在里面的写法当场被拒（`vcr_criterion_malformed`，指出 `criteria[n].requirement`）：

| `op` | 测什么 | 字段 |
|---|---|---|
| `all` / `any` | 组合 | `operands` |
| `not` | 取反 | `operand` |
| `present` / `absent` | 有 / 没有某个事件或状况 | `variable`，可选 `window` |
| `compare` | 一个数或一个编码值 | `variable`、`comparator`（`lt lte gt gte eq ne between in not_in`）、`value`，可选 `highValue`、`unit`、`window`、`aggregate`（`latest` `all` `any`） |
| `elapsed_since` | 洗脱期 | `variable`、`days`，可选 `comparator`（`gte` / `gt`）、`deniedSatisfies` |
| `language` | 只有语言能判 | `text`、`key` |

`variable` 是小写英文加下划线（`ecog`、`myocardial_infarction`），下面写事实用的是同一个名字。`window` 是 `{ "months": 6 }`、`{ "days": 28 }` 或 `{ "years": 5 }`，从评估日往回数，可加 `"anchorDate"`。
`applicability` 是另一份同样文法的要求，写在条件旁边，不写进 `requirement`：「仅女性」这类适用范围放这里，因为不适用的条件不是「未知」，没有人该去为它找病历。
有几条被拒，其余的照常写入，但那一版就缺了被拒的条件：**改好后把全部条件整套再写一次**。

## 二、找到每个事实

要处理的受试者从 `mcp__evimed__vcr_read` `{ "what": "matching" }` 来：`subjects[]` 是本研究自己的假名编号（`P-001` 这样的），
`criterionFunnel`、`gaps` 是按条件汇总的人数，人数很小的格子会被隐去，不是数据缺失。**你读不到任何真实姓名或病历号，也不需要。**
研究绑定了知识包时，这次读取还会带 `packMapping`：方案条件里的变量在包里对应的概念（名称、类型、单位、数据里写法的对照），包里没有的变量，以及数据接入时字段映射已经对上的列。写事实时 `variable` 用包给的概念名，数据里的写法按它给的对照理解；包里没有的变量照原样写，不用硬凑。

病历文档用 `mcp__evimed__vcr_read` `{ "what": "subject_document" }` 读：

- 不带 `filter`：有文档的受试者及文档数；
- `{ "subjectKey": "P-001" }`：这位患者的文档清单（`id`、名称、字数、平台可见时间）；
- `{ "subjectKey": "P-001", "documentId": "…", "offset": 0 }`：文档的一段文字（返回 UTF-16 位置；续读使用返回的 `nextOffset`，保留跨段重叠，记录尚未处理的范围）。

这是读病历的唯一入口；不要用知识库检索代替它，那里的内容不带受试者身份，也不进事实的核对。

每个事实用 `mcp__evimed__vcr_write` `what: "fact"` 写，一次最多 200 项：

```json
{ "what": "fact", "items": [ {
  "subjectKey": "P-001", "variable": "myocardial_infarction", "polarity": "affirmed",
  "occurredAt": "2026-06-28", "surface": "急性心梗",
  "documentId": "<文档 id>", "quote": "2026-06-28 因急性心梗入院" } ] }
```

- `variable`：小写英文加下划线，**与入排条件里的 `variable` 完全一致**（性别写 `sex`，值 `女` / `female` 平台都认得；不认得的编码，条件按「未知」处理）。
- `polarity`：`affirmed`（确有）、`negated`（明确否认，否认史是 `negated`，不是「没有这个事实」）、`hypothetical`（拟行、不除外、可能）、`family`（家族史）。**只有 `affirmed` 才是这位患者的事实。**
- `value` 和 `unit`：数值型的事实要写，`value` 必须是引文里印着的数，单位照文档写；数值和单位缺一个，条件判「未知」。
- 时间：`occurredAt` 是事情发生的日期（缺日期的事实，时间窗类条件判「未知」）；`recordedAt` 是写入病历的时间；`visibleAt` 平台默认取文档的可见时间，**你写的不能早于文档进入平台的时间**。
- `surface`：你实际读到的词；`quote`：包含 `surface` 的原句，**逐字照抄**。`documentId` 是上面读到的文档 id。
- `start` 和 `end`：引文在文档里的字符位置（要写就一起写）。**不会数字数就不写**：引文在文档里只出现一次时平台自己定位；出现不止一次会回告起点，你再写上 `start` 和 `end` 指明是哪一处。

平台在写入时**重读那一段**：引文不是文档里的原话、`surface` 不在引文里、数值没印在这一段里，这个事实当场被拒（`vcr_evidence_unverified`），
评估时同样再核对一遍，核对不过的事实作废，需要它的条件回到「未知」。所以：不要把化验值四舍五入，不要在引文里换算单位，不要把两句话拼成一段引文。文档写 2.4 mg/dL，事实就写 2.4 mg/dL。

## 三、只回答需要语言的条件

有 `language` 节点的条件，`mcp__evimed__vcr_read` `{ "what": "matching", "filter": { "subjectKey": "P-001" } }` 的 `requests[]` 会列出这位患者还欠的回答（`criterionKey`）。用 `what: "language_judgment"` 回答：

```json
{ "what": "language_judgment", "items": [ {
  "subjectKey": "P-001", "protocolVersionId": "<selected protocol id>", "criterionKey": "consent", "state": "satisfied",
  "evidence": [ { "documentId": "<文档 id>", "quote": "患者本人可理解研究内容并签署知情同意" } ] } ] }
```

`state` 只有三种：`satisfied`、`not_satisfied`、`unknown`。排除标准里的语言节点，回答的是原句说的情况在这位患者身上是否成立（成立就是 `satisfied`），取反由平台做。判为满足或不满足必须带原句证据，原句的核对方式和事实的一样；
`unknown` 在病历没有说清时是正确答案，不带证据。**「未知」永远不是「不满足」**：没有治疗史的记录不满足洗脱期，育龄女性没有妊娠检查不是阴性。
只要有一条适用的排除标准是「未知」，这个人就不能是「符合」——这是算术，不是判断，评估器替你做。

## 四、交给评估器，读回结果

事实和回答都写完后：`mcp__evimed__vcr_simulate` `{ "action": "start", "kind": "match_criteria" }`，**不带 `scenario`、不带 `inputs`**——
平台冻结本次选择的条件、受试者名单、事实与语言回答。可传 `selection: { protocolVersionIds: [...], subjectKeys: [...], direction: "patient_to_trial", asOf: "..." }`，一次最多十个方案；返回各方案的作业，分别查询。单方案可用 `protocolVersionId`。不指定时默认当前方案。后续分批用 `selection: { snapshotId: inputSnapshotId, offset: nextOffset }`，不要重新抽取未改变的文档。`start` 会在工具里短暂等一下，几秒能算完的直接带回结果；没算完就告诉用户在评估什么、算完有通知，然后结束这一轮或接着做不依赖它的事，不要循环查 `status`，也不要用命令行等待；下一轮用户问起时再读下面的结果。
After completion the platform preserves assessments and their evidence, and returns the result to the originating conversation. It creates no referral, contact, coordinator notification or recruitment action.
评估之后才写入的事实不在这一次里，再排一次即可。

再读 `{ "what": "matching", "filter": { "subjectKey": "P-001" } }`：`assessment` 里有总体结论 `summary`、`criteriaCounts`、逐条的 `judgments`（`state`、`decidedBy`、`recheckAt`、`evidence[]` 的 `quote` 与位置）、`evidenceGaps`。
`decidedBy` 为 `code` 的是评估器判的，`model` 的是你回答的语言条件；`overrideState` 不为空，说明临床复核者改判过——以人的为准，不要复述成你的判断。
`pending_recheck` 带 `recheckAt`：到期平台会自己重评，不用等你。

## 五、写交付物

- `matching.json` —— 结构化评估。每位患者一项：`subjectKey`、`asOf`、`summary`、`judgments[]`（`criterionId`、`state`、`applicable`、`decidedBy`、`recheckAt`、`evidence[]`）、`evidenceGaps[]`。
  **`summary` 抄 `mcp__evimed__vcr_read` 读回的，不要自己算。**
- `matching-assessment.md` —— 研究者读的：每位患者为什么可能合适、还缺什么、怎么补。每个「满足」和「不满足」都引它的原句。数字取自评估，不凭记忆。
- `criterion-funnel.md`（可选）—— 哪一条单独排除了最多的候选人。这是申办方最想知道的答案：一条让试验失去患者的条件，在方案还是草稿时可以改。
- `revision-notes.md`（可选）—— 后台。关于你自己的过程、改了什么、为什么，只写在这里。

正文里的数（人数、比例）要在 `matching.json` 里有同样的字段；小人数的格子平台读给你的时候已经隐去，隐去的就写「少于十人」，不要猜。

交付前先用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（不消耗提交），改完再 `evimed_submit_deliverable`。

## 七、排序，以及它不是什么

按评估器的结论排序——各状态的条数、补齐缺口要花的代价。你可以另加一个临床优先级，加的话要明说它**不是获益概率**。

一位受试者若只因为某条 `language` 条件被判不符合，进入「待复核排除」，不要从名单里拿走——假排除率的分母就靠它。

## 九、不要声称什么

Benchmark accuracy applies to its evaluated data, criteria and reference labels, not to every disease or clinical setting. Report local confusion states, eligible recall, false exclusion, precision and screening effort when actually measured.
Report inter-rater agreement and disagreements as properties of that reference set, not a universal ceiling or a substitute for clinical validation.

## 十、给患者找试验

用户要为某位受试者找可参加的试验时（页面上的「为该患者找试验」，或在对话里直接说），做的是同一件事的另一头：不是一份方案找患者，而是一位患者找试验。条件的文法、事实的写法、语言条件的回答、判定由评估器做，都和上面一样。

- 候选试验来自试验登记平台：`mcp__evimed__clinical_trial_search` 找正在招募或即将招募的，凭这位患者的诊断、分期、生物标志物、年龄、性别和所在地区挑；有希望的用 `mcp__evimed__trial_registry_record` 读登记记录。本研究已经有的候选试验在 `mcp__evimed__vcr_read` `{ "what": "candidate_trials" }` 里，不必重复写。
- 一个试验写成一项候选试验：`what: "candidate_trial"`，`registryId`、`subjectKeys`（这位患者）和 `criteria`——登记记录里入选和排除标准的原句，一条一条按第一节的写法结构化，`sourceText` 逐字照抄，判不了的写成 `language`。试验的名称、分期、状态和中心由平台从登记记录读，你不写。写入时平台就把这位患者对照这个试验判了，判定在返回值里。条件里的 `variable` 用这位患者已有事实的变量名（`mcp__evimed__vcr_read` 读到的那些，例如已有 `egfr` 就不要另写 `gfr`）：同一个概念一个名字，平台才能拿这条事实判这条条件；单位照登记原句写，年龄、病程这类时间单位平台会换算。没有对应事实的，再按第一节起名。

```json
{ "what": "candidate_trial", "items": [ {
  "registryId": "NCT05000001", "subjectKeys": ["P-001"],
  "criteria": [
    { "kind": "inclusion", "criterionType": "demographic", "sourceText": "Age >= 18 years",
      "requirement": { "op": "compare", "variable": "age", "comparator": "gte", "value": 18, "unit": "year" } },
    { "kind": "exclusion", "criterionType": "comorbidity", "sourceText": "Active brain metastases",
      "requirement": { "op": "present", "variable": "active_brain_metastasis" } } ] } ] }
```

- 补了这位患者的新事实，或要让另一位受试者也对照已有的试验：同一个 `registryId` 再写一次，只写 `subjectKeys`，不带 `criteria`。条件要改就把整套 `criteria` 重写，平台会把受影响的判定重做。
- 语言条件的回答用第三节的 `language_judgment`，写 `candidateTrialId`（读回的试验 id）代替 `protocolVersionId`；还欠哪些，读 `{ "what": "candidate_trials", "filter": { "subjectKey": "P-001" } }` 的 `requests[]`。
- 同一次读取的 `ranking` 就是平台排好的顺序：全部满足的在前，其余按还差几条，被排除的在后，同样的再看登记状态；本研究自己的方案也在里面。顺序不是你的判断，不改它，也不写「匹配度」。
- 交付 `matching-assessment.md`：每个试验一段——登记号、名称、状态、为什么可能合适、还缺哪些证据和怎么补，满足和不满足各引患者原句与试验原句；`matching.json` 写 `subjectKey`、`direction: "patient_to_trial"` 和 `trials[]`（抄自 `ranking`）。登记状态不等于某个中心现在有名额；联系患者、转诊、入组都不归你。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `matching.json` 的某个字段或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。


## Correction cases and vocabulary scope

Authorized judgment corrections are retained as study-local cases with frozen input references. The matching page can export those references and replay held-out subjects through the deterministic evaluator. This does not re-run clinical-document extraction, does not establish clinical accuracy and does not require a human reviewer to complete ordinary research. Never copy patient text, extracted facts or correction labels into global learning fixtures, prompts or another study.

The internal sex-code mapping is pinned as `evimed-internal-sex-1`. Optional `vocabularyVersion` on a fact must match that supported version; unknown declared versions are not reinterpreted through the current table. This is not ICD, GB/T, USDM or Circe support. Preserve unknown codes as unknown and retain their source evidence.

## Evidence-preserving cloud extraction

When `matching.factContract` is null, keep the existing fact/polarity contract and omit optional `clinical` enrichment. When supplied, use its exact schema before writing facts. For each criterion variable, preserve the exact source quotation and the patient's context. Start with the smallest supported fact; extra fields are optional. Keep the criterion variable unchanged.

Place context only inside `clinical`, for example `"clinical": {"schema": 1, "assertion": "affirmed", "experiencer": "patient"}`. Choose assertion and experiencer independently from the tool's enums. Missing or unrecorded history is unknown, never an explicit denial. A planned treatment uses hypothetical assertion and planned temporality; family events belong to family. Do not guess dates, section offsets, coding editions, or existing fact IDs. Numeric values remain numbers. Omit uncertain optional metadata instead of filling every schema field.

For medication facts, add the supported `clinical.medication.state`: a plan or prescription is not administration. A negative exposure needs `medication.absenceScope`: use `never` only for explicit lifetime absence, `interval` with supported bounds for interval-wide absence, and `current` or `unknown` for an incomplete history. Copied text retains its original event date. For observations explicitly from the same event, use the same `clinical.eventId` (1–80 ASCII letters, digits, underscore or hyphen, for example `sample-2026-09-01`); competing results stay visible. Do not concatenate long document IDs or use colons in this field. An administered medication is an exposure fact even when no numeric dose is given; preserve its name as the value. Corrections use the existing fact ID in `correctionOf` and a sourced `correctionReason`. Laboratory originals stay in the quote; supported unit conversion is the evaluator's. A descriptor or pending assay is not an inferred diagnosis or negative test.

Read the study's documents through the study read: it hands you the reviewed projection where one exists and otherwise the document itself, which the deployment's provider agreements cover. Continue chunks using the returned offset, preserve projection and source locators, and report unprocessed sections as unknown. Do not copy patient text into shared memory, disease packs, or evaluation corpora. Language judgments name the selected protocol version. Candidate retrieval and registry status do not establish eligibility or current site availability.

Reuse `matching.semanticFields` through `mcp__evimed__dataset_semantics` as metadata only, with `basis: model_inferred` and the exact source hash. Researcher-confirmed meanings take precedence. Keep useful report portions with claim-level limitations; optional enrichment is not a delivery veto.
## Longitudinal research integration

Read `mcp__evimed__vcr_read` with `what: "longitudinal"` for the study's event histories, imported/cloud predictions and validation results. The `vcr-analysis` skill documents history mapping and the `forecast_trajectories`, `evaluate_forecast`, `compare_forecasts` and `benchmark_trial_effect` jobs. DeepSeek + DSH interprets and plans; the cloud provider or imported file supplies predictions and deterministic executors supply metrics. Preserve input versions, actual model versions, prediction origins, horizons and uncertainty meanings in the existing model analysis plan/report. Keep synthetic engineering, NLP and real longitudinal evidence separate. Predictions may inform research stratification or feasibility; they must never fill observed eligibility criteria or override a source-grounded unknown. No new whole-package quality gate or mandatory human review is introduced.

Longitudinal records now expose stable `numberPath` references in `report_model.longitudinal.byId`. Read both records and related; a `prediction_set` groups independently usable endpoint ids from one external upload. Sensitivity/model/update comparisons use `compare_forecasts` with the named mode and common calendar targets. Keep these outputs separate from observed clinical facts; local data partitions and input masking do not establish the external model's training independence.

Preserve a criterion's stated calendar unit. A window written in months uses the supported month window; do not silently replace six calendar months with 180 or 182 days. If an exact boundary needs a missing encounter date, retain unknown rather than manufacture an anchor.
