---
name: clinical-evidence-synthesis
description: Produce a publication-grade, deeply researched clinical evidence analysis with reproducible searches, verified citations, claim-level traceability, and a separate safety-first practical answer.
---

# Clinical Evidence Synthesis

Use this skill for open-domain clinical questions that require an academic evidence analysis. It does not replace emergency care or individualized diagnosis.

## Required skill stack

Load these skills before retrieving evidence:

1. `deep-research`
2. `biomedical-database-search`
3. `citation-integrity`
4. `clinical-evidence-synthesis`

Do not claim completion if any required skill fails to load.

## Academic scope

1. Start from the current question. Do not reuse a prior report as a factual draft.
2. Convert the question into a concise, direct academic title and honor any title-length preference in the request.
3. Do not put `综述`, `系统评价`, `meta分析`, `review`, or another article-type label in the title unless the user explicitly requests that design.
4. Write a publication-grade evidence analysis, not an expanded chat answer. Let the question and usable evidence determine length; do not pad the report or repeat conclusions to meet a quota.
5. Keep the safety-first practical answer separate and concise. Clinical urgency takes precedence over product discussion.
6. **The request is an input, not a template.** Take the clinical question out of it and leave the rest behind — its headings, its checklists, its metrics, its expected answer, its vocabulary. A request written as an acceptance specification is still answered with a manuscript; see "Register: what a manuscript never says".

### Never carry a record number out of the data

When the analysis is over a dataset the user supplied, subjects are referred to
by pseudonyms **you assign** — P1, P2, P3 in a stable order — and never by a
value copied from the file. Prefixing a hospital number with a letter does not
de-identify it: `P90000001` reads like a pseudonym and is one of the source
`PATIENT_ID`s. The same holds for case numbers, medical record numbers,
admission numbers, dates of birth, and names.

A production run wrote five real `PATIENT_ID`s through its report and evidence
matrix this way. Nobody reading the report could tell, and the people exposed
were not the reader.

Identifiers of *sources* — PMID, PMC, DOI, NCT, Cochrane CD numbers — are
citations and belong in the report as they are.

### Argue a thesis; do not answer a questionnaire

A report that poses sub-questions, searches each, and returns a verdict on each is not analysis — it is a lookup table with citations. These questions are chosen because they sit at an edge of what is known, and an edge is where the work is.

State the bottom line first, then make the case for it: establish what the answer depends on, and push on each of those dependencies with everything available. The reader should be able to see the argument being built, and see which load-bearing piece is weakest.

Those dependencies are your working, not your outline. They decide which searches you run and which findings matter; they are never printed as a section heading, a lettered list of propositions, or a pass/fail verdict. In the manuscript they appear twice, dissolved: as the evidence appraisal criteria in `资料与方法`, and as the reasoning in `结果` and `讨论`. See "Required report structure" and "Register: what a manuscript never says".

**Absence of direct evidence is where the analysis begins, not where it ends.** "No study was found" is a finding about the literature, not an answer to the question. Having established it, you owe the reader the best defensible answer the evidence still permits, reached by whichever of these apply:

- **Mechanism** — physical, chemical, or pharmacological reasoning from measured constants toward the direction, and where possible the magnitude, of the effect;
- **Quantitative bounding** — take the constants you retrieved and compute. A vapour pressure and a sealed-system loss curve constrain an opened-container loss; a half-life and a dosing interval constrain accumulation; a sensitivity and a prevalence constrain post-test probability. An order-of-magnitude estimate with stated assumptions beats a refusal to estimate;
- **Analogy** — a comparable agent, formulation, or system where the evidence does exist, with the differences that limit the transfer stated explicitly;
- **Adjacent-population extrapolation** — with the indirectness named and its direction of bias argued;
- **Converse and negative evidence** — what would already have been observed if the proposition were false, and whether it has been;
- **Triangulation** — where two or more independent angles agree, say so and say why that agreement is or is not informative; where they conflict, adjudicate rather than list.

Close by saying what evidence would settle the question — the study, measurement, or dataset that would convert the estimate into a finding. A question worth asking deserves a stated path to answering it.

None of this licenses assertion beyond the evidence. It requires the opposite: every step above must be recorded as a derived claim (see "Derived results"), which makes the reasoning auditable and marks it in the report as reasoning rather than measurement.

## Deep-research protocol

### Question decomposition

Decompose the question into the evidence domains it actually needs. Derive them from the question in front of you — a stability question needs formulation and physical chemistry, a diagnostic question needs test performance and prevalence, a policy question needs jurisdiction and health-system context. Domains that recur across clinical questions:

- the phenotype or exposure in question, and what it is distinguished from;
- the decision the answer feeds, and what makes that decision time-sensitive or reversible;
- how the relevant quantity is measured, and the performance limits of that measurement;
- competing explanations, and the limits of discriminating between them;
- when a medicine, device, or intervention is named: efficacy, safety, indication, regulatory scope, and the population actually studied.

Do not carry a previous question's domains into this one. If the question is about drug stability, ECG and troponin are not its domains; if it is about triage, formulation chemistry is not.

### The question ledger: one entry per asked question, and a declared gap stays a gap

Decomposition is also a deliverable. The delivery gate checks your account of the
task's 「需要回答的问题」 section against two things: the artifacts in this
workspace — the report's own lines, the claim anchors in them, and
`clinical-evidence-search.json` — and the task itself. Write it last, out of the
finished package.

The task you were given is on disk at `.evimed-brief/research-brief.md`, written
by the server before this run began. Read it whenever you need the exact wording
of a question rather than your recollection of it; after an hour of retrieval the
fifth question is a recollection. **Do not edit it.** The gate checks its own
copy, not this one, and reports any difference between them — editing it changes
nothing except that the difference is on the record. If the file is not there,
the gate is checking without the task too, and says so on the delivery.

Every numbered question of the task needs at least one entry whose `id` begins
with that question's number, and every entry's `question` must be transcribed
from the question its `id` names — not paraphrased, and not the text of a
different question. Where a question spells out a list of things to report, each
of those things must end up somewhere in the report: answered and anchored, or
named in its own `gap` entry and written up in the body as a gap. An item that is
simply absent from the report is the defect this ledger exists to surface.

Write `question-coverage.json` next to the files listed under "Required outputs",
with exactly this shape:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "2.3",
      "question": "睡眠剥夺对心率变异性所反映的交感与迷走张力有何实测效应",
      "status": "answered",
      "reportLines": [58],
      "claimIds": ["CLM-005"]
    },
    {
      "id": "4.1",
      "question": "以睡眠剥夺、失眠或轮班人群为纳入对象、以本品为干预的临床研究是否存在",
      "status": "gap",
      "searches": [
        { "query": "suxiao jiuxin palpitation insomnia sleep", "database": "PubMed", "searchedAt": "2026-08-13" }
      ]
    }
  ]
}
```

Create one entry per **atomic sub-question**, under the task's own numbering and
in the task's own order — never merge two items into one, never renumber, never
drop one because it reads like a restatement of its neighbour. Inside each
numbered item, split on 顿号, 破折号, 「或」, and parallel clauses; an item needs at
least as many entries as it has 「？」, and an enumeration introduced by 「：」 or set
off by 破折号 gives one entry per member — that list *is* the question, not
decoration. One entry asks one thing. `id` is the task's number plus a sub-item
index (`2.3`); `question` transcribes the sub-question's own wording, not a
paraphrase that is easier to answer.

Two things are not splits. A **population stratification** (「急性完全性、慢性部分
性与轮班作业三种形式」) is reported inside each entry rather than multiplied across
entries; see "Stratify the population before you conclude". A **reporting
requirement attached to the whole item** (研究类型、效应量、可逆性、随访时长) is what
every entry of that item owes, not an entry of its own.

示例——某题面第 2 问原文：

> 睡眠剥夺——急性完全性、慢性部分性与轮班作业三种形式——对心血管系统的实测效应有哪些：心率与血压、心率变异性所反映的交感与迷走张力、儿茶酚胺水平、房性与室性期前收缩负荷、心房颤动发作、QT 间期、炎症与内皮功能指标？各项结论分别来自何种研究类型（健康志愿者睡眠剥夺实验、轮班人群队列、可穿戴设备观察），其效应量、可逆性与随访时长为何？睡眠剥夺与心肌缺血及急性冠脉事件之间的关联强度如何，这些人群层面的关联能否对应到「心悸」这一主诉？

- 正例（一问拆成九条：`：` 后的七项各一条，后两个「？」各一条）：`2.1 睡眠剥夺对心率
  与血压的实测效应`、`2.2 睡眠剥夺对心率变异性所反映的交感与迷走张力的实测效应`、
  `2.3 睡眠剥夺对儿茶酚胺水平的实测效应`、`2.4 睡眠剥夺对房性与室性期前收缩负荷的
  实测效应`、`2.5 睡眠剥夺与心房颤动发作的关系`、`2.6 睡眠剥夺对 QT 间期的实测效应`、
  `2.7 睡眠剥夺对炎症与内皮功能指标的实测效应`、`2.8 睡眠剥夺与心肌缺血及急性冠脉
  事件之间的关联强度`、`2.9 上述人群层面的关联能否对应到「心悸」这一主诉`。三种睡眠
  剥夺形式在每条内部分层陈述；研究类型、效应量、可逆性与随访时长是这九条各自都要
  报告的内容，不另立条目。
- 反例（真实交付的 `摘要`，把五个编号问题重排成「三件事」）：
  `**目的** 评价三件事所依赖的证据：其一，工作压力与情绪激动后出现的心悸、胸闷，与心绞痛之间据以鉴别的证据；其二，现行指南要求在把症状归因于情绪之前排除哪些病因；其三，速效救心丸的说明书边界是否覆盖"无心血管诊断者在应激场景自行含服"这一用法。`
  该题面第 2 问的第一句是「其病理生理路径——交感激活、过度换气与低碳酸血症、心率
  变异性改变——各由何种研究类型支持？」，破折号里的三条支路本该是三条条目；全文
  「交感」「低碳酸」「心率变异」各 0 次，既没有答案，也没有缺口声明。缺口被申明与问题
  被删除，在交付物上看不出差别，对读者的后果完全不同。

**A conditional question's fallback branch is its own sub-question.** 「若 X 检索
不足则回到 Y 并标注来源与推荐强度」 is two entries: X, and Y. A report that wrote
「未检索到 X」 and stopped has answered neither — it has answered X as a gap and
left Y unwritten, and Y is what the reader was promised. The gate cannot see this
one, because it cannot see the task text; it is on you.

题面原文（真实题面的证据要求节）：`若检索不足以支持给出独立的血压下限或时间阈值，应
回到指南既有阈值并标注其来源与推荐强度。` X 是本品自己的血压下限与时间阈值，Y 是指南
既有阈值及其来源与推荐强度；两条都要登记，Y 落在正文里，不是落在 `局限性` 里。

- 正例（真实交付，X 落空后照 Y 交付）：先写 `该说明书未载明含服后应观察多久、再次给
  药的间隔，也未给出任何"不缓解即升级"的时间界限`，再回到指南把阈值连同推荐强度逐条
  给出：`2012 ACCF/AHA 稳定型缺血性心脏病（SIHD）指南以"每间隔 5 分钟给药、15 分钟内≤1.2 mg"为用药边界，并写明此时间窗内不缓解即应"立即寻求医疗关注"，即刻缓解推荐证据等级为 B`。
- 反例（另一份交付，X 落空后 Y 也没有写，缺口只留在 `局限性`）：
  `指南（2021 AHA/ACC、ESC、国内共识）以正式题录与官方摘要页为依据，未逐条核对推荐类别与证据等级原文`。
  该题面第 5 问要的是「必须立即启动急救医疗服务的条件，其推荐类别与证据等级如何」，
  并写明检索不足时回到指南既有阈值。全文既没有任何时间阈值，也没有任何推荐类别与
  证据等级，正文读起来却像这一问已被回答。

Give every entry exactly one status:

- `answered` — list `reportLines`, the 1-indexed lines of
  `clinical-evidence-report.md` where you actually answer it, and optionally the
  `claimIds` those lines carry. Every line must exist and carry prose, and at
  least one of them must sit in a paragraph that carries a claim anchor
  (`<!-- claim:CLM-… -->`). A line inside `参考文献` or `局限性` does not count:
  neither section answers a question. A line that only says 「未检索到…」 is not an
  answer either; that sub-question is a gap.
- `gap` — list the searches you really ran, each with `query`, `database` and
  `searchedAt` (`YYYY-MM-DD`). Every query must match an entry in
  `clinical-evidence-search.json`'s `queries[]` (whitespace, quoting and case may
  differ; the terms may not), under the same database, on the log's own
  `searchedAt` date. You write that log yourself, one entry per search as you
  run it, so 「我查了但没查到」 is falsifiable against it — and a search you never
  ran will be caught at once. Its `queries[]` holds objects, never bare strings:
  a log of strings loses the database each search was run against, which is half
  of what makes a declared gap checkable.

**A `gap` is a result, not a failure.** A sub-question you searched for and did
not find is registered as `gap`, written into the body in those same words, and
carried together with the searches that came back empty. Writing the gap out is
the point: 「未检索到该终点的直接证据，这是一处证据空白」 is exactly right, and
「未检索到以睡眠不足人群为对象、以本品为干预的临床研究，此为证据空缺，非已证实无效」
is the sentence to copy. What is forbidden is the *next* sentence, the one that
turns the absence into a finding — a direction of effect, a ranking, a share, or
a claim about what the literature contains. 「我这次没有检索到」 is a statement about
your run; 「英文索引中只有 1 条」 is a statement about the world, and this run did
not measure the world. Say the one you can support, and see "Absent evidence is a
gap, not a counter-finding".

- 正例（真实交付，检索空手就写成检索空手，并点名注册库的检索结果）：
  `未检索到以运动诱发胸痛人群、久坐无心血管诊断者或运动人群为纳入对象、以速效救心丸为干预的临床研究；临床试验注册库以"速效救心丸"检索命中 0 条。`
- 反例（同一段的下一句）：
  `英文索引中与本品相关的临床相关记录仅 1 条，为 2011 年发表的动物实验（速效救心丸对大鼠实验性动脉粥样硬化氧化应激与炎症的作用，SinoMed 题录）[8]。`
  这一篇对该药只跑过两条 PubMed 检索式，自己声明过的 Europe PMC 一次也没有用上；
  同批次另外四篇用几乎相同的词检出了一项含 41 项随机对照试验的 meta 分析与一项多中心
  双盲安慰剂对照试验。一次薄检索的空手被写成了文献格局，缺口还被顺势归因给不可及的
  中文数据库——既误述了证据格局，也掩盖了检索本身的不足。
- 反例（另一份交付的 `结论`，把空手升级成阴性结论）：
  `第四，无心血管诊断青年人为预防猝死而常备自服本品缺乏临床结局证据；减少咖啡因对心悸发作的直接干预证据为弱或阴性。`
  该题面问的是「减少咖啡因摄入能否降低心悸发作频次」；用来支撑「阴性」的试验，人群是
  房颤电复律后的持续性房颤患者、结局是房颤复发，没有测过心悸发作频次。换人群、换结局
  的阴性结果回答不了这条子问，它只能说明这条仍是 gap。

**The ledger then binds the prose.** Where `摘要` or `引言` restates the scope of
the work, it names at least as many items as the ledger holds, and it keeps the
task's numbering: no merging two items into one, no renumbering what survives. A
restatement is a promise about the body, and a body that never answers item 4 is
found out only by the reader who still had the task in hand.

- 正例（真实交付，题面五问，重述仍是五问）：
  `本文旨在逐条核查上述五个问题所依赖的证据，明确哪些结论有直接证据支持、哪些仅能作为间接证据陈述、哪些属于证据空白，并以证据强度相称的方式给出结论。`
- 反例（题面同样是五问，`摘要` 重述成三问）：
  `本文评价三个问题：（1）睡眠剥夺对心血管系统的实测效应及其能否对应到"心悸"这一具体主诉；（2）速效救心丸的适应症边界，及其与三类临床情境的关系；（3）在无心血管诊断的睡眠剥夺相关心悸人群中使用本品的获益与风险证据。`
  被折进「（1）」半句里的，是题面逐项点名的七类实测效应；全文「儿茶酚胺」「血压」
  「炎症」「内皮」各 0 次，读者无从发现四条子问从未被回答。同一批交付里还有一种更隐蔽
  的形态：五问重述为三问，而这三问恰好是第 1、2、4 问的合并，第 3、5 问随重新编号一起
  消失——条目数与编号都不得改。

And once a sub-question is registered as a gap, its topic may not reappear in
`摘要`, `结论`, or `临床实践要点` as a ranking, a composition share, a 「最常见」, a
threshold, a recommendation, or a 「证据为阴性／无此类证据／文献中没有」.

- 正例（`结论`，缺口在结论里仍然是缺口）：
  `（一）速效救心丸按处方药还是非处方药（甲类/乙类）管理、其出处、不同规格与批准文号之间分类是否一致、以及分类沿革，均无法从本研究可及的任何权威来源核实；原因是官方登记与公告不可及、标签索引副本不含分类字段、中文全文数据库不可访问。凡以某一具体分类属性为前提的渠道论断，只能以条件句表述。`
- 反例（同一段先声明缺口，再把缺口当已知构成使用）：
  `其三，高原暴露人群的急性冠脉事件、心绞痛与心血管死亡发生率相对平原的差异，缺乏前瞻性对照数据；以胸闷、心慌、气短为主诉者的病因构成比例亦无分母明确的研究。现有证据仅支持"急性高原病是最常见病因、高原肺水肿与高原脑水肿罕见但致命、肺栓塞可与高原肺水肿混淆、心源性猝死以既往心肌梗死与不习惯运动为要"这一较弱表述。`
  为什么是反例：「病因构成比例无分母明确的研究」是一条缺口，紧接着的「最常见病因」
  却是一个构成排序。要么把该子问登记为 `answered` 并指向承载分母的正文行，要么删掉
  排序断言。

**An unverifiable premise downgrades the sub-questions that depend on it; it does
not delete the ones that do not.** When a fact you could not verify is the
premise of some entries, mark those entries and conditionalize their claims —
and then answer the rest of the item anyway. Ask of every neighbouring entry
whether it truly needs the missing premise; most do not.

- 正例（真实交付，前提不可核实，依赖它的论断改写为条件句）：上面那条 `（一）…凡以某
  一具体分类属性为前提的渠道论断，只能以条件句表述。`
- 反例（同一篇，不依赖该前提的两问被顺带吞掉）：`摘要` 把 `界定分类属性对各购买渠道
  设定的前置条件` 列为三大目的之一，正文却没有任何一节回答它，也没有写「未检索到相关
  规章」；`讨论` 只写 `只能以条件句表述"若属甲类/若属乙类/若为处方药，则……"`，而条件句
  的内容始终没有写出来。题面第 3 问的后半段（规章对销售主体资质、处方审核、平台责任、
  信息展示的要求）与第 4 问（说明书与警示语规范、遴选原则、执业药师指导义务、包装标签
  标识）并不依赖分类属性是否可核实——同批次另一篇在同样的检索环境里引到了《药品网络
  销售监督管理办法》与《处方管理办法》的具体条款。不是取不到，是被一句「前提不可核实」
  顺带删掉了。

### Reproducible search

Search iteratively across at least two relevant source classes. Use English and Chinese synonyms when relevant. Continue until every material section has usable evidence and further query variation is no longer changing the conclusion; do not stop because a numeric query target was reached.

Record each completed search in `clinical-evidence-search.json` immediately after
the search succeeds. The JSON must exactly match successful search-tool calls
from the current run. Planned, duplicate, or failed searches do not count.

One log entry per call, and copy the query string verbatim from the call you
made. A single search that reached several underlying databases is still one
search: name the source class in `database` if that is clearer, but do not split
it into an entry per database, and do not paraphrase or shorten the query. An
entry whose query you never sent claims a search that did not happen.

For an acute pressure-like chest symptom question, adapt the queries to examine
urgent cardiovascular triage, diagnostic pathways, limits of symptom-based
discrimination, relevant non-cardiac causes, population differences, current
guidance, and any named medicine's indication, efficacy, safety, and regulatory
scope. Combine or split concepts according to the results rather than following
a fixed query list.

**A query that returns nothing has failed; it has not answered anything.** Long
conjunctive queries are the usual cause — seven concepts joined together match no
record even when the literature on the question is substantial. Before writing
that evidence on a point is absent:

1. Re-run the concept with at least two shorter queries, phrased the way a paper
   on that question would be titled, and drop the qualifiers rather than the
   subject.
2. Search a second source class, not only the one that came back empty.
3. Only after those come back empty may you write that you did not retrieve
   evidence — and write exactly that. **Never write that a study, trial, or body
   of evidence does not exist.** Your searches bound what you found; they do not
   bound what exists.

This is not a style preference. A report once stated that no prospective study
had examined the diagnostic value of symptom relief after sublingual
nitroglycerin. One exists, it is the central study on the question, and a
seven-concept query had returned zero records; two shorter queries return it as
the first hit.

Use `literature_search`, `guideline_search`, and selected audited sources from `data_source_catalog` or `biomedical_source_search`. Deduplicate candidate records with `evidence_deduplicate`.

When calling `evidence_deduplicate`, omit absent identifier keys instead of sending empty `doi`, `pmid`, `pmcid`, or URL strings. If input validation fails, correct the full batch and obtain a successful deduplication result before continuing.

Screen the returned records, deduplicate them, and inspect enough relevant sources to support every material conclusion and important counterpoint. Prefer:

1. current guidelines and consensus statements;
2. systematic evidence and high-quality diagnostic studies;
3. primary randomized or prospective studies;
4. official regulatory documents;
5. authoritative public triage guidance for the patient-facing action boundary.

Do not inflate counts with duplicates, irrelevant records, editorials, or title-only results.

### Reading what you retrieved

A literature search of twenty records runs to roughly seventy kilobytes, most of
it abstracts, so the runtime writes it to a tool-output file instead of putting
it in the conversation. Open that file with `read` and work from the records.

**Never delegate this to a subagent.** A subagent replies in prose, so what
returns is an account of the records — abstracts paraphrased, identifiers
dropped — and every quotation you then take is your delegate's wording, not the
source's. Two consecutive runs of this skill differed by nothing else: the one
that read its own search results produced a report three times longer with ten
traceable claims, and the one that delegated six reads had its support quotes
rejected because they were not present in the documents they cited.

The rule generalises: delegate a question, never a document. Anything you will
quote, you read.

### Full-text and source preservation

Use `official_page_fetch` for approved professional-society, guideline, evidence-review, public-health, or regulatory pages. Use `open_access_full_text` for key PMID, PMCID, or DOI records with accessible full text.

Prefer a PMCID or a search record explicitly marked open access before calling
the full-text tool. For official pages, use stable URLs returned by the search
or audited source catalog rather than guessed publisher paths. A closed-access
result or unreachable official page belongs in `failedSources`; replace it with
another relevant accessible source rather than repeatedly retrying it.

Preserve and inspect the distinct documents actually used to support the report. Count one canonical readable artifact per document:

- use the returned `fulltext.md` for a PMC document, not both its Markdown and companion XML;
- use the returned `page.md` for an official page;
- never count two formats, aliases, redirects, or duplicate records for the same document as separate sources.

Before drafting, group the preserved paths by document identity and confirm that every material claim has an inspected canonical artifact. If an evidence domain remains unsupported, continue searching for relevant PMCID/open-access records or approved official pages. A successful source artifact must contain source identity, retrieval time, content hash, and usable text.

Never create, edit, replace, or copy a file under `.evimed-sources/`. Only artifacts returned by successful retrieval tools are evidence artifacts.

A title, bibliographic record, search snippet, or failed retrieval is not evidence for a clinical outcome, recommendation, effect estimate, study design, certainty rating, or causal statement.

## Evidence appraisal

For every included source, record:

- source type and study design;
- population, setting, intervention/comparator, and outcomes where applicable;
- access level: `full_text`, `official_page`, `abstract`, or `structured_record`;
- risk of bias or evidence-form limitations;
- directness to the question;
- precision and sample-size limitations;
- recency and jurisdictional applicability;
- whether the source directly supports, qualifies, or conflicts with another source.

Separate findings for emergency triage from findings for chronic stable disease. Evidence that a medicine may help diagnosed stable angina does not establish a role in self-diagnosing undifferentiated acute chest pressure. The transfer fails in the other direction too, and a care setting is not a population — see "Stratify the population before you conclude".

### An instrument you name in `资料与方法` should be executed once in `结果` or `讨论`

Naming RoB 2, ROBINS-I, ROBINS-E, QUADAS-2, AMSTAR 2, AGREE II,
Newcastle-Ottawa, Naranjo, WHO-UMC, Jadad, or GRADE in the methods section is a
promise that a rating follows, not a statement of your qualifications. For each
instrument you name, `结果` or `讨论` should carry at least one sentence that
applies it — to a specific study, in a paragraph that carries that study's `[n]`;
or as a certainty verdict on a body of evidence, which legitimately stands a
paragraph below the `[n]`s of the studies it summarises; or as an explicit
statement that no study exists to apply it to. Hedging an instrument with
思路 / 精神 / 理念 / 参照…要点 is not using it — write what you actually did
instead.

**This one is advice, not a gate.** The reason is that pre-specifying an
instrument per design stratum is exactly what the methods section is for, and a
stratum your search returned nothing for owes no sentence retiring its
instrument: 「诊断准确性研究以 QUADAS-2 评价偏倚风险」 stays correct in a run that
included no diagnostic-accuracy study. So **do not delete an instrument name from
`资料与方法` in order to clear a notice** — the pre-specification is the
methodological transparency the notice exists to protect. Delete it only if it
was never part of your plan. The gate reports the gap and delivers the package.

A GRADE level must agree with the downgrade reasons written next to it, and this
one *is* a gate. Any downgrade at all excludes 高, so a **paragraph** that
**asserts a deficiency** in the evidence — 方法学质量偏低/欠佳/不足, 证据强度不足,
偏倚风险高/严重/不明确, 存在不一致/间接性/不精确, or a downgrade actually taken
(降一级 / 下调一级 / 扣一档) — may not give a level that reaches 高, including
ranges such as 中至高.

The paragraph, not the sentence, is the unit, and the verdict counts however it
is worded: 「纳入研究方法学质量普遍偏低。按 GRADE 评为高确定性。」 is the same
judgement as the one-sentence form, and so is the same pair in the other order.
So are 「按 GRADE 属高级别证据」, 「GRADE 确定性高」 and 「证据确定性评为高」 — putting
the level after its noun, changing the noun, or leaving the word GRADE out does
not make it a different verdict. Naming the five domains in order to
say you did *not* downgrade for them is the standard way to justify 高 and is not
this error: 「偏倚风险低、结果一致、估计精确、无发表偏倚证据，按 GRADE 评为高确定性」
and 「未对任何领域降级，按 GRADE 评为高确定性」 both pass. Naming GRADE's starting
point (从"高"起步…降一级…评为低确定性) is correct and is not this error either.
Beyond what a check can measure, the level must match the *number* of downgrades
you state, not merely avoid 高; and every population stratum you declare in
`资料与方法` needs an identifiable subsection or label in `结果` and one appearance
in `结论` and in `临床实践要点`, or an explicit 该层未检索到证据.

- 正例（工具落在一篇具体文献上，与该文献编号同段）：
  `按 QUADAS-2，该研究排除了初始心电图明确心肌梗死与已行急诊导管检查者，存在选择偏倚风险，且"非心源性"以检查阴性定义、随访期短，但结论方向与既往同类研究一致 [6]。`
  正例（无文献可评时的正确写法）：
  `未检索到针对本品的 Naranjo 或 WHO-UMC 因果关系评定，也未检索到去激发与再激发观察的个案或系列。`
  正例（证据体级评级，独占一段，编号在它汇总的各研究上）：
  `综合而言，机制层面可支持"本品含川芎嗪，具有钙拮抗与血管舒张作用"的方向性结论，按 GRADE 属低确定性，降级理由为间接性（离体组织与动物而非目标人群、静脉而非含服给药）。`
  正例（GRADE 等级与降级理由自洽）：
  `按 GRADE 评估，该证据体从"高"起步，因偏倚风险（单个试验、结果仅为摘要层级，RoB 2 无法完整评估）降一级，因不精确（单个试验，长期时点无合并效应量及置信区间）再降一级，评为**低确定性** 〔推导〕。`
  正例（判为"高"时，逐个点名五个领域并说明未降级——不触发本条）：
  `两项大型随机对照试验偏倚风险低、结果一致、估计精确、无发表偏倚证据，按 GRADE 评为高确定性 [1]。`
- 提示例（`资料与方法`宣告一整套工具，全文再无一次落地；只提示，不阻断交付）：
  `鉴别要点的诊断效能以诊断准确性研究及其系统评价为准，用 QUADAS-2 评价；干预性研究用 Cochrane RoB 2，非随机干预研究用 ROBINS-I，系统评价用 AMSTAR 2，指南方法学质量用 AGREE II 说明。……药物与不良事件的因果关系以 Naranjo 量表或 WHO-UMC 标准评定。`
  提示例（弱化词等同于未使用）：
  `干预性研究以 Cochrane RoB 2 / ROBINS-I 思路评估偏倚风险；指南与共识以 AGREE II 思路说明方法学质量。`
  反例（同句断言"方法学质量偏低"，等级却给到含"高"的区间——这一条阻断交付）：
  `但纳入研究整体方法学质量偏低、多数为中文单中心小样本试验，按 GRADE 在中至高之间`
  ——同一证据体在 `结果` 中已写为「低或极低确定性」。

## Comparative appraisal and evidence bridging

When the question compares two or more interventions, the first thing a reviewer
checks is whether they were appraised the same way. The asymmetry is almost never
deliberate: the familiar arm attracts the language of clinical tradition (`长期临床使用`,
`指南推荐`, `已广泛应用`), the less studied arm attracts the language of grading
(`按 GRADE 为低确定性`), and a paragraph ends up reporting one as supported and the
other as uncertain when the two stand in the same evidentiary position for the
question actually asked. That is a methodological defect, not a matter of tone.

None of what follows levels the arms upward. Symmetry belongs to the appraisal,
not to the conclusion: where one arm's evidence really is stronger *for the
question asked*, the conclusion says so, in the same vocabulary it used for the
other.

A comparison also fails before the appraisal begins and after it ends: the object
of study drifts toward a neighbouring question that is easier to answer, several
populations are merged into one PICO, the arms are described along axes that never
meet, a mechanism acting on one arm alone is walked all the way to a conclusion
about the other, and a secondary caution grows until it is what the paper appears
to be about. The subsections below run in the order a report is built — what is
being asked, of whom, along which axes, how far each line of reasoning reaches,
and at what length — and none of them may be used to weaken the last one.

### The question asked is the question answered

The object of study is fixed by the question and named in the title, and it stays
fixed through `结果`, `讨论`, and `结论`. What displaces it is never a worse
question — it is an easier one. `两种药物在院外自救中的证据比较` becomes
`未分化胸痛患者能否自行判断病因`, because the second has a clean answer and the
first does not, and the exchange happens a clause at a time: the population
narrows to the hardest stratum, the comparison thins, and by `讨论` the paper is
arguing something the title never claimed. No sentence in it need be false; the
paper simply answers a question nobody asked and leaves the asked one unanswered.

A question sometimes does have to be restated — its premise does not hold, the
population as posed does not exist, a term in it turns out ambiguous. Restating
it is a legitimate result, and it is **declared**: say which question was asked,
what in it does not survive contact with the evidence, what it is being replaced
with, and what the replacement can and cannot settle. A declared restatement is
science; the same move undeclared is substitution.

`摘要` `目的` lists the research questions; `结论` answers them in the same order,
one answer per question. A question with no answer in `结论` was either not
answerable — say so, as a gap — or was dropped, which requires the declaration
above. A statement in `结论` answering nothing listed in `目的` is the drift above,
caught late.

**A secondary finding does not become the paper's thesis, and a safety caution is
the one that most often tries.** A caution can be important without being the
subject: it earns a full-strength statement in `临床实践要点` and, where it bears
on interpretation, a sentence in `讨论`. It does not earn a research question of
its own in `引言`, a diagnostic-performance passage sized like a primary finding,
a repeat in every one of `摘要结果`, `摘要结论` and `结论`, or a compound thesis
welded to an unrelated result. Nothing here removes content: everything "Safety
boundaries" requires is still written, at full strength, in the section that
carries it. What changes is rank.

- 反例（把次级安全提示升格为研究问题与主结论）：`引言：本文提出三个研究问题……（三）服药后症状是否缓解能否用于鉴别胸痛病因。`，`摘要结果` 与 `摘要结论` 各重复一次，`讨论` 用一节讨论"含服后缓解"的敏感度与特异度，并与 ALDH2 合并为"双重失效"。
  为什么是反例：题目问的是两药证据比较与人群差异，读者读完却认为本文的目的是反驳"服药诊断法"；一条风险提示占据了主问题的位置。
  正例（内容不减，位置与次序归位）：`临床实践要点：服药后症状是否缓解不能用于鉴别胸痛病因，缓解与未缓解都不排除急性冠脉综合征；新发胸痛应立即拨打 120 并接受心电图与高敏肌钙蛋白评估 [1,4]。`，`讨论` 中一句说明其边界：`该提示限定的是对缓解现象的解读，不构成两药疗效比较的结论。`

Each answer in `结论` leads with the finding rather than with the appraisal of a
neighbouring arm. Where a question asks about the limits of one intervention's
effect in a defined population, the answer states the magnitude and the share of
the population it applies to — an effect limited to a genotype carried by half the
target population is a different result from one carried by one in a thousand, and
the conclusion must say which. **A correct qualifier may not stand in place of the
finding it qualifies.**

- 反例（把核心发现压平为一句限定语）：`ALDH2 rs671 变异降低但不消除对硝酸甘油的反应。`
  正例（发现与人群占比在前，限定语在后，推导另起一行并标注）：
  `ALDH2 rs671 变异型在东亚人群的携带率约 40%，中国汉族为 45% 至 49% [8]。携带者舌下含服硝酸甘油后的心绞痛缓解率为 50.6%，野生型为 79.4% [9]。`
  `〔推导〕以汉族携带率 45% 至 49% 与上述两组缓解率计算，人群平均缓解率约为 65% 至 66%，即每两名患者中约有一名属于低反应基因型；含服后未缓解在该亚群中更可能反映酶活性不足而非病因不同，"含服后缓解"这一现象据此不能用于区分病因。变异降低但不消除反应，携带者仍可能获益，故该发现限定的是对缓解现象的解读，不构成停用理由。`

### Stratify the population before you conclude

A setting named in the question — `院外自救`, `术后随访`, `基层首诊`, `居家用药` —
is not a population. Inside it sit groups whose evidentiary position differs so
much that no single sentence is true of all of them. Identifying those strata is
the first analytic step, not a refinement applied at the end: they decide which
searches get run, and every conclusion attaches to one of them rather than to the
setting.

For an out-of-hospital self-management question the recurring partition is by what
is already established about the patient:

1. 已确诊冠心病或心绞痛、按既往医嘱处置；
2. 既往有类似症状，但本次发作的性质或程度发生变化；
3. 首次发生、病因不明。

Derive the strata of the question in front of you the same way — by prior
diagnosis, prior treatment, severity, genotype, care level, jurisdiction, whatever
changes which evidence applies — and state the evidence for each stratum
separately.

**Merging the strata into one PICO produces a judgment true of none of them.** The
stratum with the least evidence sets the verdict for all of them, and the uses
that do have an established basis disappear from the report — not refuted, just
never asked about on their own. Any judgment of the form 「在 X 场景下证据不足」
must name the stratum it holds for, wherever it appears: `结果`, `讨论`, `结论`,
and the abstract.

- 反例：`两药在院外自救场景中均缺乏证据。`
  为什么是反例：把三类人群合并成一个 PICO 后按最弱的一类给出统一判断，遮蔽了两药在已确诊冠心病心绞痛患者中的既有应用场景。
  正例：`两药在已确诊冠心病心绞痛患者中均有相应应用依据，但在首次发生或病因未明的院外急性胸痛中，现有证据不能支持患者自行选择药物替代专业评估。`

Stratification blocks transfer in both directions. The rule in "Evidence
appraisal" — evidence that a medicine helps diagnosed stable angina does not
establish a role in self-diagnosed undifferentiated chest pressure — runs the
other way just as strictly: a finding about the undifferentiated stratum does not
describe the diagnosed one. A stratum you put out of scope is excluded in
`资料与方法` with its reason, and its evidence stays out of the conclusions.

### One ruler for every arm

Report every arm's evidence with the same appraisal instrument, for the same
indication, the same population, the same care setting, and the same outcome. If
one arm's certainty is stated by GRADE, every arm's is. If one arm is appraised in
the scenario the question asks about, no arm may be appraised in an adjacent
scenario where its evidence happens to be stronger. Long clinical use, guideline
mention, and regulatory approval are each evidence of something specific; none of
them is a certainty rating and none substitutes for one.

- 反例（结论段，同一场景两把尺子）：`（1）舌下含服硝酸甘油缓解心绞痛发作的疗效有长期临床使用与指南推荐支持，但其用于未分化急性胸痛院外自救的适应症内随机对照证据缺乏……（2）速效救心丸的随机对照证据确定性按 GRADE 为低至极低，未检索到其在急性胸痛院外自救场景中与硝酸甘油的头对头比较……`
  为什么是反例："有长期临床使用与指南推荐支持"评的是另一个适应症（已确诊心绞痛发作），"按 GRADE 为低至极低"评的是本场景（院外自救、未分化胸痛）；在本场景中两者同样没有适应症内随机对照证据，却被写成一方有支持、一方确定性低。
  正例：`在未分化急性胸痛的院外自救场景中，两者均未检索到适应症内随机对照证据。硝酸甘油的缓解疗效证据来自已确诊心绞痛发作人群 [2]，外推至未分化自救人群受人群间接性与结局间接性双重限制，按 GRADE 为极低确定性；速效救心丸的随机对照证据集中于气滞血瘀型冠心病心绞痛，样本量小、盲法与分配隐藏报告不全，同一外推按 GRADE 为低至极低确定性 [11,12]。未检索到两者在该场景的头对头比较。`

Where an arm genuinely holds evidence the other lacks, keep the indication and
population attached to it, so the reader can see that a different question is
being answered: `硝酸甘油在已确诊心绞痛发作中的缓解疗效证据充分 [2]，该证据不覆盖未分化胸痛的自救决策`.

### Fix the comparison axes before filling them

Decide the axes of comparison before writing about any arm, then fill every arm on
every axis. Reviewing arm A's literature, then arm B's, then closing with a shared
verdict is not a comparison: the two accounts never touch, and the verdict is
supplied by whichever arm had the thinner file. **`分别介绍完再统一判定证据不足` is
the shape this subsection forbids.**

The axes are needed because evidence bases are not commensurable by default. One
arm's evidence may be chronic coronary syndrome, continuous dosing, ECG and
questionnaire endpoints; the other's acute as-needed sublingual use, symptom
relief, haemodynamics and onset time. Both belong in one review. They are not two
values of one variable, and a sentence ranking them is comparing a long-term
treatment result against an acute relief result.

Fix at least these axes, adapting the wording to the domain and dropping none:

1. **核准适用场景** — the approved indication as written, and what it does not cover;
2. **急性/按需使用证据** — population studied, outcome measured, onset time;
3. **长期治疗证据** — population, outcome, duration;
4. **人群反应差异** — genotype, age, comorbidity, ancestry, and whether a difference was measured or merely not measured;
5. **安全性与禁忌** — contraindications, interactions, and known harms, in full for every arm;
6. **是否存在直接比较研究** — head-to-head evidence, and its absence written as a cell;
7. **该维度可支持的结论边界** — how far a conclusion may go on this axis alone.

The last axis is the one that does the work. Write it per axis and before the
cross-arm sentence, so each comparison inherits a stated ceiling instead of
borrowing the highest ceiling in the table. An empty cell is a result, written
`未检索到` with what was searched (see "Absent evidence is a gap, not a
counter-finding"); it stays inside its axis and never becomes the verdict of the
table. Cross-arm statements use one appraisal vocabulary ("One ruler for every
arm") and one stratum ("Stratify the population before you conclude").

A table is the natural form — axes as rows, arms as columns, the boundary as the
last column — and each factual cell carries its numbered citation and hidden claim
marker like any other line.

- 反例（把不同维度的结果并列为优劣）：`速效救心丸可改善心绞痛发作频次与心电图缺血表现 [11]，硝酸甘油含服后 1 至 3 分钟起效 [2]，就院外自救而言后者更为可靠。`
  为什么是反例：前者是慢性冠脉综合征人群连续用药、以发作频次与心电图为结局的结果，后者是急性按需含服的起效时间结果；两者不是同一维度上的两个取值，"更可靠"没有可比的量。
- 正例（先固定维度，再逐一填充，并写明该维度允许写到哪一步）：

  | 维度 | 硝酸甘油 | 速效救心丸 | 该维度可支持的结论边界 |
  | --- | --- | --- | --- |
  | 核准适用场景 | 心绞痛发作的急性缓解与预防 [2] | 气滞血瘀型冠心病心绞痛 [7] | 只能判断某一用法是否落在核准范围内，不能据此比较疗效 |
  | 急性按需使用证据 | 已确诊心绞痛发作人群，结局为症状缓解与血流动力学，含服后 1 至 3 分钟起效 [2] | 未检索到以急性发作缓解时间为结局的随机对照研究 | 可分别陈述"在何人群、以何结局、多久起效"，不足以排序 |
  | 长期治疗证据 | 未检索到以长期结局为终点的按需含服研究 | 气滞血瘀型冠心病心绞痛连续用药，心电图与发作频次改善，样本量小、盲法报告不全 [11,12] | 长期治疗结局不外推至单次自救用药 |
  | 人群反应差异 | ALDH2 rs671 变异型缓解率 50.6%，野生型 79.4% [9] | 未检索到按基因型分层的反应数据 | 一方为已测得的异质性，另一方为未测量而非无差异 |
  | 安全性与禁忌 | 与 PDE5 抑制剂合用为禁忌，低血压与晕厥风险 [2] | 说明书列有不良反应，无分母，发生率未知 [7] | 两侧均按全强度报告，不因证据量少而少报 |
  | 是否存在直接比较研究 | 未检索到头对头随机对照研究 | 同上 | 该空缺本身是结果，不能替代上述各维度的比较 |

### Absent evidence is a gap, not a counter-finding

Three states stay distinct in every sentence, table cell, abstract line, and
conclusion:

1. **evidence of no effect** — direct studies were done and were negative or
   bounded by an equivalence margin; give the estimate and its interval;
2. **insufficient evidence to judge** — no directly applicable study was
   retrieved; give what was searched and what is missing;
3. **evidence of effect** — direct studies support it; give the estimate and its
   certainty.

`未检索到直接证据` is the second state and may never be summarised into the first.
It is written as a gap, and a gap is complete only when it names the study that
would close it: design, population, comparator, outcome, and the order of
magnitude of sample that outcome requires.

- 反例：`该药在急性胸痛院外自救中无效，不推荐使用。`、`现有证据不支持该药用于院外自救。`
  正例：`未检索到在未分化急性胸痛院外自救场景中以临床结局为终点的随机对照研究，现有证据不足以判断其在该场景的效能。可回答该问题的研究为：以院外发作的未分化胸痛人群为对象、以舌下含服硝酸甘油为对照、以症状缓解时间与 30 天主要心血管事件为结局的随机对照试验；按该人群的事件率，事件驱动的样本量在千例量级。`
  （`不支持` 是对证据方向的陈述，检索落空时的正确写法是 `不足以支持` 或 `未检索到……的证据`；见"Register: what a manuscript never says"中的证据动词。）

A summary compresses, and that is where this error does the most damage: an
abstract or `结论` line that turns a gap into `无效`／`不推荐`／`不支持使用` states a
negative finding the report never made. The prohibition runs in the other
direction too — a gap is not permission to conclude that an arm works. The gap is
the finding, and the sentence stops there.

### The bridging ladder

When direct evidence for an arm is thin or absent, **attempt the bridge before
reporting the gap.** Stopping at `证据不足` is the failure this subsection exists to
prevent: it is the answer the reader could have reached without the search. The
rungs below are the moves of "Argue a thesis; do not answer a questionnaire",
ordered for a comparison. Work down them, and for each rung state the certainty
it carries and what it cannot reach:

1. **机制与药理学** — receptor, pathway, pharmacokinetics, measured constants.
   Supports a direction of effect and sometimes an order of magnitude; never a
   clinical effect size, never a safety margin.
2. **替代终点与中间结局** — ECG change, exercise tolerance, ischemic burden,
   biomarkers. Supports that the mechanism operates in humans; supports a clinical
   outcome only where the surrogate is validated for that outcome, and the
   validation is cited.
3. **间接人群** — adjacent indication, adjacent severity, adjacent care setting.
   Supports transfer with the indirectness named and its direction of bias
   argued; the certainty is downgraded for it, not assumed to survive.
4. **同类药物或同类制剂的类效应** — supports a class-level expectation only where
   the shared property is the one doing the work; a shared class name with a
   different route, formulation, or pharmacokinetic profile is not a bridge.
5. **真实世界数据与登记研究** — utilisation data, registries, pharmacovigilance
   databases, cohorts. Supports exposure patterns, frequencies, and safety
   signals; confounding by indication puts effectiveness out of reach unless the
   design addresses it.
6. **反向与不利证据** — negative trials, failed replications, regulatory warnings
   and non-approvals, and what would already have been observed if the
   proposition were false. This rung is not optional, and it is reported at the
   same length as the favourable ones.

Bridge every arm you compare, or bridge none. One arm carried across four rungs
while the other is dismissed at the gap is the first subsection's asymmetry in
another form. Every rung you reach is a derived claim in the matrix with its
`derivedFrom`, `method`, `assumptions`, and `sensitivity`, and is marked `〔推导〕`
in the report (see "Derived results"); a bridge never reaches `临床实践要点`.

**A bridge attempted and not built is a result.** Say which rung failed and why —
the surrogate is not validated for this outcome, the class shares a name but not
the mechanism, the registry has no denominator — so the reader learns what the
literature currently cannot support. Silence at a rung reads as a rung never
tried.

### Enumerate the links a bridge needs

The ladder above rates how far a *kind* of evidence reaches. This rule is about a
*chain*. When the comparison is driven by a mechanism acting on one arm only — a
genotype, a metabolic pathway, a route, a formulation property — the step from
`该机制影响 A` to `低反应者应改用 B` is not one inference but several, and each of
them is a separate empirical proposition that either has been established or has
not.

So list them. One link per line in `讨论`, each marked `已建立` or `未建立` with the
evidence or the missing study behind the mark, and the conclusion then stops at
the last established link and says that it stopped there.

- 例（基因型驱动的比较，逐环列出与逐环状态）：
  1. `该变异在目标人群中常见` — 已建立：东亚人群携带率约 40%，中国汉族 45% 至 49% [8]；
  2. `携带者对 A 的反应降低` — 已建立：携带者缓解率 50.6%，野生型 79.4% [9]；
  3. `B 的作用不经该通路，故不受同一变异影响` — 未建立：未检索到 B 的基因型分层研究，"未测量"不等于"不受影响"；
  4. `低反应者改用 B 后的临床结局优于继续用 A` — 未建立：未检索到头对头或按基因型分层的比较研究；
  5. `B 可在该场景替代 A` — 未建立，且不能由第 1 至 4 环推出；
  6. `基因型差异足以构成两药之间的选择规则` — 未建立：需以基因型分层、以症状缓解与 30 天主要心血管事件为结局的前瞻性比较研究。

An arm never tested for the mechanism is untested, not immune. One arm's
susceptibility is not the other arm's advantage, and that is the link a chain
skips most often — link 3 above, which is where the report must say `未测量`
instead of letting silence read as `不受影响`.

**A chain that does not close is a result, not a failure.** Links 1 and 2 built
with 3 to 6 open is exactly a research hypothesis plus an evidence gap — both are
publishable findings and both are worth more than an assertion — and the gap is
complete only when it names the study that would build the next link: design,
population, comparator, outcome, and the order of magnitude of sample that outcome
requires (see "Absent evidence is a gap, not a counter-finding"). What is not
permitted is walking the open links in silence and landing on a substitution
claim. Any quantity you compute along the chain is a derived claim with its
`derivedFrom`, `method`, `assumptions` and `sensitivity` (see "Derived results"),
and no link of the chain reaches `临床实践要点`.

- 反例：`ALDH2 rs671 变异者对硝酸甘油反应降低，此类人群可改用速效救心丸。`、`对 ALDH2 低反应人群，速效救心丸可能是更合适的选择。`
  为什么是反例：`可能` 补不上第 3 至 6 环；把未建立的环写成推测性建议，读者读到的仍是替代性疗效结论。
  正例：`ALDH2 相关反应差异提示，院外心绞痛用药效果可能存在显著个体差异，不宜将硝酸甘油视为对所有中国患者反应完全一致的单一标准。另一药具有不同的药物组成和证据路径，但其在 ALDH2 低反应人群中的相对价值仍需直接临床研究验证。`

### Length in proportion to the question

Length is a claim about importance. A reader infers what the paper is about from
where its words are, so each section's share of the body must track the rank of
the question it answers: the main question carries the body, while a secondary
finding and the safety boundary are stated in full at their own rank.

For a comparison question with a population-heterogeneity component and a safety
boundary, the shares that fit are, as an order of magnitude and not a formula:

- 干预间的证据比较 ≈50%;
- 人群反应异质性 25% 至 30%;
- 使用安全边界 10% 至 15%.

Adapt them to the structure of the question actually asked — one with no
heterogeneity component gives that share back to the comparison, not to the safety
section. They are magnitudes to check against, never a quota to write toward: if
the evidence on the main question is thin the report is shorter, and inflating a
secondary section to fill the space is the defect this rule exists to catch (see
"Academic scope", item 4).

Before delivery, take each level-three subsection, name the research question it
serves, and compare its share of the body against that question's position in
`引言`. A section that outweighs its rank is either the wrong subject or an
inflated one; the usual inflation is a caution or a methodological aside that was
easy to write about. Compress the discussion, never the duty — `临床实践要点`
states every action, contraindication, and emergency instruction at full strength
however short the section is.

- 反例：一条风险提示（`服药后是否缓解不能鉴别病因`）出现在 `摘要结果`、`摘要结论`、`引言` 的第三个研究问题、`讨论` 的诊断效能一节与 `结论`，合计约占正文三成，而两药的维度对照只有一节。
  正例：该提示在 `临床实践要点` 中以完整强度陈述一次，`讨论` 中以一句说明其解读边界；正文主体是维度对照与人群反应异质性，两者的篇幅次序与 `引言` 中研究问题的次序一致。

### Symmetry never softens a safety statement

This subsection ranks below "Safety boundaries" and may never be cited against
it. Appraising two arms evenly does not even out their risks.

- The instruction not to let self-administered medicine delay emergency contact is
  written at full strength for every arm, whatever its evidence grade.
- An out-of-indication scenario is stated as out-of-indication for every arm that
  is out of indication, the familiar one included.
- Contraindications, interactions (nitrates with PDE5 inhibitors, among others),
  and known harms are reported in full regardless of how symmetric the efficacy
  evidence turned out; an arm with less efficacy evidence does not receive less
  harm reporting.
- Symmetry is a floor under the weaker-looking arm's appraisal, never a ceiling on
  the stronger one's. Unfavourable evidence about either arm is reported in full,
  and no rule above — bridge, gap, ruler, axis, chain of links, question fidelity,
  stratification, or proportion — may be used to omit it. Demoting a caution from
  thesis to boundary changes where it sits and how much room it takes, never what
  it says: a shorter section states the same duties at the same strength.

## Citation and traceability integrity

### Screening numbers and the source set are rendered from the log, never written by hand

`clinical-evidence-search.json` is the ledger of what this run actually did.
Four quantities live there and nowhere else — `queries.length`,
`screening.recordsIdentified`, `screening.recordsAfterDeduplication`,
`screening.sourcesIncluded` — together with the identity of every record you
included. When the report states one of those quantities, copy it out of the
file; do not restate it from memory and do not round, re-count or re-estimate
it. If the sentence and the file disagree, the file is not the thing that is
wrong.

The numbered reference list is the same fact seen from the reader's side. **It
must be exactly the set of `sourceRecords` whose `included` is `true`** — same
count, same reference numbers. A record you never read to an inspectable level
(`full_text`, `abstract`, `official_page`, `structured_record`) may not be
numbered in 参考文献 and may not carry an in-text `[n]`, not even as background
colour, and not even if you label it 「题录层级」. Read it, or drop it. Keeping
the record at `included: false` while still citing it does not make the citation
honest; it makes the count a lie.

When an identifier resolves and a bibliographic field does not come back, leave
the field empty and mark it 未解析. Never fill it from what the title suggests,
and never reuse another paper's author list.

- 正例（流程句逐字取自检索日志，编号表与之一致）：
  `共执行 21 条检索，命中 194 条记录，去重后 148 条，纳入 15 份来源。`
  该次运行的日志正是 `queries.length = 21`、`screening = {recordsIdentified: 194,
  recordsAfterDeduplication: 148, sourcesIncluded: 15}`，`参考文献` 恰为 15 条，
  编号 1–15，且正是那 15 条 `included: true` 的记录。
- 反例（四个数字都是手写的，没有一个能对上日志）：
  `以 PMID、DOI、稳定 URL 及规范化题名去重后，共获得 191 条记录，去重并剔除无关记录后余 116 条，最终纳入 25 个来源。`
  同一次运行的日志写着 `203 / 125 / 24`，`参考文献` 有 24 条，连它自己的
  `citation-audit.md` 开篇都写着「核查范围：全部 24 条编号参考文献」——正确的数字
  就在同一交付里，只是没有被渲染出来。
- 反例（另一条腿：编号表里坐着从未读到可核查层级的记录）：
  `2018 ACC/AHA/HRS 心动过缓和心脏传导延迟评估与管理指南[6]、窦房结功能障碍综述[7]、2022 年 JCS/JHRS 心律失常诊断与风险评估指南[8]，均以窦房结功能障碍的评估与管理为主题，其全文在本次检索中不可获取，仅能列为题录。`
  这三条在日志里是 `"accessLevel": "bibliographic", "included": false`，而同一份报告
  写着「最终纳入 7 个来源」，`参考文献` 却编了 12 条。在正文里标注「仅能列为题录」
  并不能修复它：读者看到的仍然是十二个编号来源，方法学写的是七个。

A per-query hit count is not the flow and is fine to state on its own —
「临床试验注册库以"速效救心丸"检索命中 0 条」 is a result, not a screening total,
and it is not compared against `recordsIdentified`.

### Reference-table closure (nothing floats, no number is an orphan)

The numbered list and the body must close on each other in both directions.

- **Every numbered entry in `参考文献` must be cited at least once by a `[n]` in
  the body**, and every `[n]` in the body must resolve to an entry. Table cells
  and the abstract count as body.
- **A source you retrieved but did not use is not a reference.** Record it in
  `clinical-evidence-search.json` as a `sourceRecords` entry with
  `"included": false` and a non-empty `exclusionReason`, then drop it from the
  numbered list and renumber. Naming it once in `局限性` as "full text
  unavailable" is not a use.
- **Never put a bibliographic identifier in the citation slot.**
  `[PMID 22897413]` resolves to nothing a reader can follow and to no claim. If
  the source is worth naming it earns a number and a claim; if it is not, it
  goes to the excluded list.
- **Every line carrying a `<!-- claim:CLM-NNN -->` marker must also carry that
  claim's own `referenceNumber`** (or, for a synthesized claim, one of its
  `referenceNumbers`). Having paired the marker correctly earlier in the report
  does not exempt a later line. Derived results are exempt: they carry 〔推导〕
  and no number of their own.

- 正例（两个 claim 的 `referenceNumber` 都是 6，句内编号含 6；表格单元格里的
  `[6]` 同样算作「已被引用」）：
  `连续高敏肌钙蛋白 0/1 小时算法灵敏度 99.3%、假阴性约 2/1,000，是现行指南以客观检查完成排除的节点 [6,10]<!-- claim:CLM-015 --><!-- claim:CLM-016 -->。`
- 反例（参考表里的孤儿条目）：
  `11. Walker NJ, Sites FD, Shofer FS, Hollander JE. Characteristics and outcomes of young adults who present to the emergency department with chest pain. Acad Emerg Med. 2001;8(7):703-708. PMID:11435184.`
  全文没有任何 `[11]`：这条青年胸痛队列只在 `局限性` 里被顺带提了一句「全文未获」，
  而它恰恰是该报告要回答的问题所需的队列。一个零引用的编号条目几乎总是指向一个没答
  完的问题；要么真正引用它，要么以 `included: false` 加 `exclusionReason` 记入检索
  日志并退出编号表。
- 反例（行内标识符绕过参考表）：
  `……针对膝骨关节炎患者的中医诊断变量信度研究……[题录，PMID 22897413，全文未获]；冠心病痰瘀互结证中医诊断量表研究方案……[题录，PMID 29721788，全文未获]。`
  这句话承载的是一条否定性断言（「未检索到……的实证研究」），却把两条来源塞进方括号
  里当引用用，既不在参考表中，也没有对应 claim。
- 反例（锚点编号与句内编号不符）：
  `- 发作频率增加、含服后缓解不如既往或症状加重时，及时就医评估而非自行调整剂量 [6]；心绞痛持续发作者，说明书提示宜加用硝酸酯类药 [6]。<!-- claim:CLM-021 -->`
  `CLM-021` 的 `referenceNumber` 是 22，内容是一条中成药系统评价的结局概述；这条临床
  实践要点挂在一条支持不了它的 claim 上。同一个 marker 在报告前半部分配对正确，不豁免
  这一行。

### A quotation carries the predicate, not just the number

A citation check can verify that a figure appears in the quotation. That is not
enough: the **predicate** attached to the figure — its direction, its metric
type, its frequency grade — must be visible in the same quoted breath.

1. **Direction.** An OR/RR/HR and the direction word in its clause must agree; a
   ratio above 1 means the event became *more* likely. If the source really does
   report the odd caliber, say so in the same clause — which arm is the
   numerator, which group is the reference. An effect size with no interval
   estimate may not appear in `摘要` or `结论`: write it in `结果` only, as a point
   estimate with the interval marked unreported.
2. **Likelihood-ratio type.** Print the type word your `supportQuote` prints.
   `pLR`/`LR+` is a *positive* likelihood ratio even when its value is below 1.
   Any post-test-probability derivation states in `method` which class of LR it
   consumes, and whether it applies to the feature being present or absent.
3. **Non-knowledge.** If the quoted sentence's whole content is that something is
   unknown, no claim anchored to it may assert that the effect is established.
   Find the sentence that reports the result.
4. **Ellipsis.** A `…` inside a quote is a high-risk mark. A threshold
   (temperature, dose, time point) and the direction word bound to it must sit
   inside **one** unelided run of the quote. Each fragment being verbatim is not
   enough, and that is exactly how a reversed finding gets through.
5. **Frequency grade.** 罕见/偶见/常见/十分常见 may only be printed alongside the
   rate that grounds it, in the same sentence. Bare case counts are not a rate.
6. **The title is not a quotation.** `supportQuote` is a statement from the
   source's body, never its title, running head, or reference entry.

- 正例（类型词、数值、区间三者与引文逐一对上；引文原文为 `negative DLR, 0.04
  (0.02−0.09)`）：
  `EDACS-ADP 的系统评价（12 项研究、14 290 例）报告合并灵敏度 0.97（0.95–0.99）、特异度 0.58（0.53–0.63）、阴性似然比 0.04（0.02–0.09）`
- 反例（数值全部对得上，谓语反了）：
  `其判别效能集中于"按压可复现"：其阴性似然比在 0.13 至 0.41 之间 [4]`
  该行锚定的 `CLM-006`，其 `supportQuote` 是
  `pain reproducible by palpation might be helpful for ruling out myocardial ischemia, with pLR ranging from 0.13 to 0.41`
  ——这是**阳性**似然比。改写之后，随之而来的整段排除能力论证与
  〔推导〕（post-test odds = pretest odds × LR(−)）全部建在这个改写上。同型反例：
  `1 年 MACE 下降（p<0.05，OR 1.916）`（比值大于 1 却写成下降，且没有区间就进了
  `摘要` 与 `结论`）；`制备加热至 70 ℃ 以上即出现龙脑的挥发损失`（引文里 70 ℃
  那一段写的是 `markedly increased release`，`decline` 在省略号的另一侧）。

### Attribution rests on the quote, never on the number

An entity or a stance is carried by the wording of the quote, not by the figure
standing next to it.

1. **Do not narrow the entity a number belongs to.** If the source reports an
   umbrella category — 全因猝死, 全部胸痛, 「娱乐活动或运动」 — you may not restate
   its figure under a narrower one (心源性猝死, 急性冠脉综合征, 「运动中」) unless
   you also give the subset fraction and recompute. Name a compound category by
   both of its parts.
2. **Do not add attributes the quote does not state.** A cohort name, database,
   exposure measure, country, or design label may only be used as the quote
   itself words it, and an attribute you supplied may never be the thing that
   dissolves a conflict between two results. A 「建议摄入上限」 is a dietary or
   regulatory recommendation; it is not a threshold below which some outcome does
   not rise.
3. **An attributed position must be quoted, not inferred from data.** 作者指出 /
   作者认为 / 作者将…视为 / 该研究强调 / 原文提醒 — every such sentence cites a
   claim whose `supportQuote` states that position in the source's own words. A
   quote that only reports measurements cannot carry one: numbers are what a
   study found, not what its authors concluded. If no preserved passage says it,
   either quote the passage or drop the attribution and own the reading
   (本研究认为…). Writing the position into the claim's `claim` /
   `applicability` / `uncertainty` field and then citing that claim does not
   work — those are your words. So is `sourceTitle`: it is metadata you typed
   in, not text the source was quoted as saying, and **only `supportQuote` is
   read**.

   The attribution is recognised by what it is, not by which string you used.
   The subject is any demonstrative plus a research-entity noun, with or without
   a measure word (该研究 / 这项研究 / 该项研究 / 上述研究 / 该 meta 分析), or any
   author noun (作者 / 研究团队 / 课题组 / 原作者). The predicate is any stance verb
   (认为/指出/强调/视为/归因/归结/主张/推测/提出/断言/提示/写道…) or one of the two
   frames that carry a position without a verb: 「在原作者看来，…」 and
   「作者的核心观点是…」. 报告/报道/说明/描述 are reporting verbs and are not this
   rule. 本研究/本文 is your own voice and is never an attribution.

   The quote counts as carrying a position when it **states** one, not when it
   contains a word associated with one. `could` inside
   "You could be having a heart attack", `our` inside "included in our analysis",
   `we` inside "we included 417 patients" and `however` in front of a
   measurement are not positions. What is: an authorial subject predicating a
   judgement verb ("Our results do not support…"), a judgement verb taking a
   complement ("concluded that…", "considered to be…"), a hedge governing an
   interpretive predicate ("was likely due to…", "may lead to…"), a deontic
   statement ("is not recommended for…", "the need to…"), a causal attribution
   of a stated result ("received low Jadad scores due to…", "accounts for the
   observed decline"), and an epistemic one ("remains unclear").

- 正例（归属句与引文逐字对得上，数值和结论各有各的出处）：
  `在以聚乙二醇 6000 为载体熔融制备固体分散体的过程中，加热温度升至 70 ℃ 以上、延长加热时间均使龙脑的释放量下降，作者将其归因于升温下的挥发损失 [3]。<!-- claim:CLM-004 -->`
  `CLM-004` 的 `supportQuote` 里就写着这句归因：
  `This decline was likely due to volatilization losses of L-borneol at elevated temperatures.`
- 反例（数字全对，立场是造的，而这条被伪造的立场是一条给医师的操作建议）：
  `……女性以焦虑（校正 OR 2.9，95% CI 1.1–8.1）、心悸、恶心为表现者更多，作者指出这些症状"常被误释为焦虑或惊恐障碍，导致诊断延迟"，并主张对以心悸、焦虑、恶心就诊者行心电图以排除心律失常 [7]。<!-- claim:CLM-008 -->`
  `CLM-008` 的 `supportQuote` 全文只有
  `278 were included … anxiety (OR 2.9 (95% CI 1.1 –8.1, p=0.031)) were more frequent in women when presenting in the ED.`
  ——引号里那句「常被误释…」和「主张行心电图」这条建议，来源一个字都没说。
- 反例（上位实体换成下位实体，数值原样搬过去）：
  `第三，青年心源性猝死少见（约 2,4/10 万人·年）[5]<!-- claim:CLM-012 -->`
  `CLM-012` 的引文是
  `159 SD were identified, corresponding to an annual incidence of 2,4 … per 100.000 people-years. … There were 70,4% cardiac`
  ——2,4 是**全部**突发死亡的发生率，心源性只占其中 70,4%。同一份报告在正文三处都
  正确写作「突发死亡」，只有结论这一行换成了「心源性猝死」，量级因此错了三成。要么
  写「突发死亡」，要么写「心源性猝死约 1,7/10 万人·年（2,4 × 70,4%）」并标为推算。

### Article-level regulatory citations need the regulator's own text

An article locator — a statute and an article number in one sentence — asserts
what a normative text says at clause granularity. Only the issuing authority's
own published text can carry that. The order and the spelling do not matter:
`《医师法》…第 29 条`, `医师法第 29 条` without the book-title marks,
`第 29 条第 2 款是《医师法》为…设定的` with the number first, and
`《中华人民共和国医师法》确立了…；该法第 29 条…` referring back from a later clause
are one assertion in four disguises, and all four are this rule. On any body line (before
`## 参考文献`) containing such a locator, at least one source cited on that line
must be a matrix claim whose `sourceUrl` host sits in a government namespace
(`.gov`, `.gov.<cc>`, `.go.<cc>`, `.gouv.fr`, `.europa.eu`, `.int`), whose
`artifactPath` is in this run's `successfulSourceArtifacts`, and whose
`supportQuote` or `claim` names the same article number (第二十九条 and
Article 29 both count).

A journal article, a review, a law-school commentary, a portal reprint, or a
bare reference-list entry with no preserved artifact cannot carry an article
number, however accurately it paraphrases the law. If you cannot preserve the
statute, you have not lost the point — you have lost the locator. Drop the
article number and state what your source actually is. Naming a statute without
a clause locator (`《药品管理法》将"超过有效期的药品"列为劣药情形之一`) is always
allowed, and so is citing the fact that a document was issued, together with its
document number, while saying its clauses were not obtained.

- 正例（条款不可及时的正确降级写法）：
  `检索所及的监管门户显示，国家药监局综合司于 2026 年印发《处方药网络零售合规指南》（药监综药管函〔2026〕282 号）[18]<!-- claim:CLM-019 -->，但其正文与处方药销售记录、药师指导、网络销售及追溯的具体条款未能获取核对`
- 反例（`[13]` 是一篇发表于 Front Pharmacol 的法学综述，不是法条原文）：
  `《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点：无有效或更优治疗手段、有循证医学证据支持、患者知情同意、医疗机构内部审查批准 [13]`
  改法之一，不需要任何新检索：
  `一篇分析《医师法》（2021）实施后超说明书用药的法学综述将其合法前提归纳为四点：无有效或更优治疗手段、有循证医学证据支持、患者知情同意、医疗机构内部审查批准 [13]`

### Reader-visible citations

Use standard numbered citations in order of first appearance:

`急性胸痛需要结构化风险评估。[1](https://example.org/source) <!-- claim:CLM-001 -->`

- Readers must see `[1]`, `[2]`, and so on, not internal claim IDs.
- Put each internal marker in an HTML comment: `<!-- claim:CLM-NNN -->`.
- Put the numbered citation and hidden claim marker on the same physical line as the supported proposition.
- In the abstract, put every quantitative proposition on its own physical line
  with the matching numbered citation and hidden claim marker.
- Every factual numeral and every practical action needs a directly applicable citation and claim marker.
- Never use a broad citation to cover a sample size, effect estimate, timing threshold, indication, contraindication, or recommendation absent from its source passage.

### Quotation placement

A verbatim support quote is a traceability device, and its home is the
`supportQuote` field of `clinical-evidence-matrix.json` and the `supportQuote`
column of `citation-ledger.csv`, where it is checked against the preserved
artifact. **It does not go into the report body.** The body states the finding in
Chinese, in the paper's own voice, with its numbered citation; a reader who wants
the original wording follows the citation, and an auditor reads the matrix.

Quotation inside the body is reserved for the case where the exact wording is
itself the object of analysis — a regulatory indication clause being parsed, a
recommendation class, a definition the dispute turns on. It is then a short
phrase or a single sentence, inside quotation marks, grammatically inside a
Chinese sentence, with its source cited in place. **Never a run of untranslated
source sentences, and never introduced by the label `原文：`.** Two `原文：` in one
paragraph is the signature of a matrix pasted into a manuscript.

- 反例：`……其推荐含服剂量为 0.3 至 0.6 mg [2]。原文：the recommended doses of NTG include sublingual or spray (0.3 to 0.6 mg) every 5 minutes up to a maximum of 3 doses 原文：the 2020 European Society of Cardiology recommends (Class I, Level C) the use of sublingual or IV nitrates in patients with ongoing ischemic symptoms`
  正例：`指南推荐舌下含服 0.3 至 0.6 mg，每 5 分钟可重复，最多 3 次 [2]；对仍有缺血症状者，2020 年欧洲心脏病学会给出 I 类 C 级推荐 [3]。`
- 正例（确有必要直引时）：`该说明书将适应症限定为"气滞血瘀型冠心病心绞痛"[7]，未涵盖未分化急性胸痛。`

Pasting the device into the body adds no verifiability: verifiability is carried
by the matrix and the ledger, which are machine-checked against the artifacts,
while a quotation in the body is checked by nobody. What it does add is a
paragraph that reads as assembled by copying rather than written.

### Evidence matrix

Write `clinical-evidence-matrix.json` with a top-level `claims` array containing the report's atomic material claims. Do not split prose into artificial micro-claims merely to increase the count. Every claim must contain:

- `claimId`
- `claim`
- `referenceNumber`
- `sourceUrl`
- `sourceTitle`
- `artifactPath`
- `identifier`
- `accessLevel`
- `supportQuote`
- `applicability`
- `uncertainty`

`referenceNumber` must resolve to the numbered reference list. `supportQuote` must be a verbatim passage present in the preserved source artifact. Every numeral in a claim must also appear in the quote, source title, or identifier.

Every claim also carries `pico`, `picoMatch`, `denominatorKind`, and `requiredCaveats`, and the matrix root carries `questionPico` — see "A claim's caveats travel with it".

Quote contiguously by default. You may elide a passage you do not need by marking the gap with `…`, as any scholarly quotation does; each side of the gap is then checked on its own and must appear in the source in the order you wrote it. Never join two passages without marking the gap, and never elide across a qualification — a quote reading "the effect was significant … in the subgroup analysis" that hides "not" is a misquotation whether or not the words are all in the document. Copy sentences as they read: an inline citation marker the extractor left mid-sentence ("…in coronary spasm patients.23 Li Jin et al…") is not part of the sentence and may be left out.

**`artifactPath` is copied from a tool result — never typed by hand.** Three tools preserve an artifact you may cite: `open_access_full_text` (papers, by DOI or PMCID), `official_page_fetch` (labels, regulatory and institutional pages), and `guideline_search`, which preserves a guideline's own text when the record carries it. Each returns the workspace path it wrote under `.evimed-sources/`; that exact string is the `artifactPath`. A search hit is not an artifact — search tells you what exists, preservation is a second call.

So when you want to cite something you have only seen in search results, **preserve it first**: fetch the full text by its DOI or PMCID, or fetch its official page by URL. A guideline retrieved through `guideline_search` may already carry its own preserved text — check the result for an `artifactPath` before assuming you must fetch it elsewhere. If neither preserves it — no open-access copy, no reachable official page — then you have not read that source and it cannot carry a claim. Cite the sources you did preserve instead, and if that leaves the point unsupported, say in the report that the evidence was not obtainable. Do not describe the gap in the path field: a string like `abstract-only PMID:15940087` or `regulatory-record NMPA速效救心丸` is not a path, and writing one asserts a verification that never happened.

`accessLevel` is exactly one of `full_text`, `official_page`, `abstract`, `structured_record` — no other value is accepted. It records how much of the source the preserved artifact actually contains, so `abstract` and `structured_record` still require a preserved artifact to quote from; they mark a partial document, not a missing one.

For an emergency-call claim, the contiguous quote must itself contain both the
action to call emergency services and the relevant symptom condition. A quote
that only describes the symptom is not sufficient.

### Synthesized (cross-source) claims

A weighed cross-source conclusion — "across these four trials the evidence leans toward X" — has no single verbatim home, so it cannot be a direct claim. Mark it `"claimType": "synthesized"` and give it the stricter multi-source package:

- `claimId`, `claim`, `applicability`, `uncertainty` — as for direct claims.
- `confidence`: exactly one of `high`, `moderate`, `low`.
- `referenceNumber`: the primary numbered citation (must be one of `referenceNumbers`).
- `referenceNumbers`: every numbered citation the synthesis rests on (at least two).
- `supportingSources`: at least two distinct sources — distinct meaning different documents, so the same `artifactPath` listed twice is one source, not two. Each entry carries `sourceUrl`, `sourceTitle`, `artifactPath`, `accessLevel`, and its own contiguous verbatim `supportQuote` from its own preserved artifact — every entry is checked exactly like a direct claim's source.

Numerals in a synthesized claim must either appear in one of the supporting quotes/titles/identifiers, or be a count of the supporting sources themselves ("4 项研究中 3 项…" — the gate counts). **A claim that says "three independent studies" needs three different documents behind it.** One paper cited three times is one study, and writing it as three overstates the evidence in the direction that matters most — a reader takes independent replication as far stronger than a single finding. Count the distinct artifactPaths before you write the number. Do not use the synthesized type to smuggle in numbers no source states, and do not use it for claims a single source does support — those stay direct claims.

### A claim's caveats travel with it

Every `direct` and `synthesized` claim registers, alongside `applicability` and
`uncertainty`:

- `pico` — the `{population, intervention, outcome}` the claim actually measured;
- `picoMatch` — each of those three judged `"same"` or `"different"` against the
  matrix root's `questionPico`;
- `denominatorKind` — one of `exposed_population_prevalence`,
  `presenting_population_share`, `trial_enrollment_share`, `not_applicable`;
- `requiredCaveats` — **at least one** entry, each
  `{ "id": <slug>, "forms": [...] }`. A caveat is the shortest form of a limit
  you already stated for this claim in `结果`; `forms` lists the interchangeable
  spellings you use for that one limit, so a caveat written as 「撒哈拉以南非洲」
  in `结果` and 「坦桑尼亚」 in `摘要` is one caveat with two forms, not two
  caveats. Every form must appear somewhere in the report body — you register
  what you wrote, you do not invent a label.

Wherever that claim is restated in `摘要`, `结论`, or `临床实践要点`, one form of
each registered caveat appears in the same sentence, or in the sentence
immediately before or after it. The same holds anywhere one sentence cites claims
with two different `denominatorKind` values. A conclusion written in negative
voice (无效 / 不推荐 / 无获益) rests on at least one claim whose `picoMatch` is
`"same"` on all three fields; with no such claim, the sentence is downgraded to
「未检索到该人群（或该终点）的直接证据」.

Registering caveats you then have to reproduce is the point. If reproducing one
makes a practice point unwriteable, the practice point was never supported.

- 正例（动物与 16 倍剂量两条限定都随主张走到了行动指令一层）：
  `- 孕妇禁用 [1]；川芎在 16 倍临床剂量下于动物中显示弱胚胎毒性，与该妊娠禁忌方向一致 [10]。<!-- claim:CLM-010 -->`
  `CLM-010` 的 `requiredCaveats` 登记为 `{"id":"population","forms":["动物","小鼠"]}`
  与 `{"id":"dose","forms":["16 倍","16倍"]}`，读者不会把动物高剂量信号读成人体剂量
  风险。
- 反例（限定在实践要点这一层一个不剩）：
  `- 家庭备置本品应置于儿童不可及处；家庭贮存药品的风险包括儿童误服，儿童中毒登记中药物为仅次于农药的常见毒物 [13][15]。<!-- claim:CLM-015 -->`
  `结果` 一节写得很清楚：「上述均为跨药品类别的家庭药箱与中毒研究……儿童中毒登记未
  单独列出本品」。到了实践要点，「药物为仅次于农药的常见毒物」于是读起来像是在说本
  品。同一份报告的 `摘要` 还把 62.4% 那条的「埃塞俄比亚 Dessie」抹掉只留数字——数值
  与矩阵完全一致，丢掉的是它的分母属于谁。

### Derived results (your own estimate, bound, or inference)

`claimType: "derived"` is how you publish a conclusion no source states because you reasoned or computed it — the bounding estimate, the mechanistic inference, the extrapolation the "Argue a thesis" section asks for. It is the only claim type whose numerals need not appear in any source, because by construction they cannot.

It is not a lighter standard, it is a different one. Where a direct claim is bonded to a verbatim quote, a derived claim is bonded to its working:

- `claimId`, `claim`, `applicability`, `uncertainty` — as for direct claims.
- `derivedFrom`: the claim ids this result reasons from. They must exist in the matrix, and following them must reach measured evidence — a derivation resting only on other derivations is not grounded.
- `method`: the actual step from those inputs to this result — the relation applied, the arithmetic, the bound taken. Show the working, do not name it. "按一级动力学估算" is naming it; the equation, the inputs substituted, and the result is showing it.
- `assumptions`: what must hold for the method to apply — held constant, assumed unchanged, taken as approximately linear.
- `sensitivity`: what moves the result and by how much. An estimate whose fragility is unstated is worth less than no estimate.

Every numeral you state in the report for a derived result must appear in its `method`, `assumptions`, `sensitivity`, or `uncertainty`. That is the audit trail replacing the missing quote: a reader can check your arithmetic even though they cannot check your quote.

In the report, mark every line asserting a derived result with `〔推导〕` so it is never read as a measurement, and give it a hidden claim marker as usual. A derived result takes no numbered citation of its own — it is not a source; its inputs carry the citations. It is presented in `结果`, at the point of the finding it reasons from, and discussed in `讨论` like any other result.

**A derived result may never appear in `临床实践要点`.** Reason as far as the evidence allows in the analysis; what a reader is told to actually do must rest on measured evidence. If a derivation implies a more cautious action, state the caution in the analysis and give the practical step a directly supported claim.

### Bibliography and audit

Write:

- `references.bib` with one deduplicated entry for every numbered report reference;
- `citation-ledger.csv` with a header row and one row per matrix claim. The header must name `claimId`, `referenceNumber`, and `supportQuote` columns; order does not matter and extra columns are welcome. Each row's `referenceNumber` must equal that claim's `referenceNumber` in the matrix;
- `citation-audit.md` documenting unresolved identifiers, duplicates, corrections or retractions, metadata-only records, and claim-source mismatches.

Record the checks actually performed and their findings, including unresolved
identifiers, duplicates, corrections or retractions, metadata-only records, and
claim-source mismatches. `Abstract-only` is not a synonym for `metadata-only`.

Prefer DOI, then PMID/PMCID, then a stable official-document identifier. Verify author, title, venue, year, volume, issue, pages, DOI, PMID, and version against an authoritative record. Do not manufacture missing metadata.

The report reference list must use a consistent Vancouver-style format:

`1. Authors. Title. Journal. Year;volume(issue):pages. doi:... PMID:... URL:...`

For organizations or official documents, use the issuing organization as the author and include publication/update date and stable URL when available.

## Required report structure

A reader judges what kind of document this is from the section names, before a
single sentence of the body. Names that describe the analyst's workflow —
`判定条件`, `逐角度论证`, `三角互证与冲突处理` — announce a work record, and an
acceptance checklist printed inside a manuscript is the reviewer's form, not the
paper. So the deliverable is a manuscript: the sections a journal reader expects,
in the order they expect them. Nothing analytical is surrendered by this. Every
demand the old workflow sections made is still made below; each one has moved to
the place a manuscript carries it.

Required level-two sections, in this order:

1. `摘要` — structured: `目的` / `方法` / `结果` / `结论`, followed by `关键词`. The bottom line goes in `结论`, at the strength the evidence supports. Each quantitative proposition still takes its own physical line with its numbered citation and hidden claim marker.
2. `引言` — the clinical question, the decision that hangs on it, what is already established, and where the uncertainty sits; the objective of this analysis in the closing paragraph.
3. `资料与方法` — sources and search, eligibility, screening, deduplication, and the evidence appraisal criteria.
4. `结果` — what the evidence establishes, organised by finding.
5. `讨论` — what the body of evidence supports as a whole, where the lines of evidence agree or conflict, how this stands against existing knowledge, and what would settle the question.
6. `局限性` — the closing movement of the discussion, kept as its own heading.
7. `结论` — the answer, at the strength the evidence supports.
8. `临床实践要点` — the safety-first practical answer. This section carries every safety duty the report has; it was named `安全优先的实际处置` and only the name changed. Head it with one of `安全优先的实际处置` / `实际处置` / `实用回答` / `临床实践要点` / `临床要点` / `怎么办` / `Practical`, and write the reader's actions under it: every safety check on practical advice locates the section by that heading, so a heading outside the set — `结论与处置建议`, `患者须知`, `面向临床的处置建议` — and an empty section are both audited as no section at all, and both are refused. `结论` and `临床实践要点` remain two sections; neither satisfies the other's requirement.
9. `参考文献` — always the final level-two section.

Do not merge these sections and do not add sections between them; whatever
further organisation the material needs is carried by level-three subsections
under `结果` and `讨论`. Never append the practical answer, an operational note,
or any other section after the numbered reference list.

### `资料与方法`

Report databases and source classes, complete query concepts, search date,
eligibility criteria, deduplication, screening counts, access levels, and the
appraisal dimensions. Write it as a scholarly method — impersonal, reproducible,
in the past tense — not as a log of what the tools did.

**This is where the evidence bar lives.** State once, in the vocabulary of the
field, what evidence a conclusion of each kind had to rest on before it could
stand:

- design hierarchy, and what design a class of conclusion requires — an incidence estimate requires a denominator-defined study with prospective active ascertainment; an interchangeability conclusion requires a pre-specified equivalence or non-inferiority margin; a diagnostic conclusion requires a study with a reference standard and reported operating characteristics;
- risk of bias, appraised with a named instrument where one applies (Cochrane RoB 2, ROBINS-I, QUADAS-2, AMSTAR 2, Newcastle-Ottawa, Jadad where the source used it);
- directness on population, intervention, comparator, and outcome; precision; recency; applicability to the jurisdiction and care setting in question;
- causal attribution of an adverse event by a named instrument — Naranjo, WHO-UMC — with the observations each level demands (dechallenge, rechallenge, alternative explanations, timing);
- certainty of a body of evidence by a named framework — GRADE — with any downgrade attributed to its reason (risk of bias, indirectness, imprecision, inconsistency, publication bias).

Write these as criteria, in continuous methods prose. **Never as a lettered list
of propositions with pass/fail conditions**, and never carried forward as a
per-proposition verdict elsewhere in the report. A published grading instrument
you apply is reported as that instrument's output and named as such (`按 WHO-UMC
评定为"可能有关"`, `按 GRADE 为低确定性`); a private scale you invented is not
an instrument, and grading your own conclusions against it is the acceptance
form again. See "Register: what a manuscript never says".

### `结果`

Organised by finding, not by source and not by retrieval attempt. For each line
of evidence: what it establishes, in which population, at what certainty, and
what it cannot reach. Tables are encouraged for study characteristics, effect
estimates, and decision boundaries.

Direct evidence, mechanism, quantitative bounding, analogy,
adjacent-population extrapolation and converse evidence remain required analytic
moves — **they are content, not headings.** Subsection titles name the subject
matter (`说明书与监管文本`, `随机对照试验证据`, `药理机制与人体验证`,
`不良反应归因评定`), never the procedure that produced them.

A line of evidence you sought and did not find is a result: say what was sought,
what was retrieved, and what the absence constrains — as `未检索到`, never as a
statement that the evidence does not exist. Derived results appear here, each
marked `〔推导〕`, with its working, assumptions, and sensitivity at the point of
the finding it reasons from.

**A `结果` section that restates sources one by one and declares a gap has not
done the work.** Restating what each paper said is a reading list; a result is
what the evidence establishes about the question. If the section reads as a
sequence of source summaries, the analysis is still owed — go back and attempt
the lines of reasoning listed in "Argue a thesis; do not answer a questionnaire",
then report what each one established.

### `讨论`

What the evidence supports taken as a whole. Where independent lines converge,
say so and say whether the convergence is informative — convergence between two
reports of the same underlying data is not replication. Where they conflict,
adjudicate: say which is preferred and on what grounds (design, directness,
precision, recency, risk of bias), rather than listing both. Distinguish acute
undifferentiated symptoms from diagnosed chronic disease, keep measured evidence
separate from derived reasoning, compare the findings with existing knowledge,
and name the study, measurement, or dataset that would settle the question. Any
factual numeral introduced here still carries its citation and claim marker.

### `局限性`

Only limitations that materially change interpretation — risk of bias,
indirectness, imprecision, evidence form, publication bias, recency, population
transferability, jurisdiction, health-system applicability. Synthesize them into
an argument about how far the conclusions can be trusted, not a checklist. Do not
report tool, gateway, file, or page-retrieval failures in the academic report.

### `临床实践要点`

**Emergency-call triggers may never be conditioned on how a self-administered
medicine performed.** An item that tells the reader to call emergency services
must state its trigger in terms of **symptoms and signs only**. A trigger
phrased as "the drug did not work" is forbidden, **even when a guideline you
cited says exactly that**.

"The drug did not work" is a meaning, not a phrase, and every way of writing it
is the same trigger: 含药不缓解 / 服药后无效 / 含服 N 分钟后不缓解 / 未完全缓解即呼叫,
and equally 未见效 / 无好转 / 未获缓解 / 未能奏效 / 疼痛不减轻 / 症状持续存在. So is
the same condition written across a comma that closes a temporal clause
(「若含服硝酸甘油后，症状仍不缓解，应立即拨打 120」), across a full stop with an
anaphor picking the medication act back up (「含服一片后观察。仍不缓解者拨打 120」),
and with the medicine named instead of the act of taking it (「若硝酸甘油未能奏效，
应立即拨打 120」). It is forbidden because this section always also carries the
unconditional rule (「服药不是等待的理由，应在服药的同时呼叫急救」), and a reader
cannot execute both. The only permitted register is unconditional: 无论服药与否、
无论是否缓解. If a source does state a drug-response threshold, restate it
faithfully in **结果** with its citation; 结果 describes what the literature says,
and 临床实践要点 is the one section a reader executes.

Writing the forbidden order in order to reject it is fine. The negation
(而非/不得/不应/无论/不宜/不因/不构成/不等同…) may stand in the clause that carries
the phrase, or in a later clause of the same sentence **that is itself about the
medicine or about relief** — 「若含服后…不缓解，应立即呼叫急救，不得因已服药而推迟」
rejects the delay in its last clause and is compliant, and so is 「…，症状自觉缓解
不等同于心肌缺血解除」. A negation about something else does not license it:
「…应立即拨打 120，不要自行驾车前往医院」 is safer advice about driving and leaves
the trigger exactly as it was. It must also be in that sentence: a rejection in a
neighbouring sentence licenses nothing.

The medication word and the non-relief word must also stand in **one clause** to
count as one trigger, where a comma ends a clause unless it closes a temporal or
conditional one (…后，/…时，). 「症状经首次含服明显改善后，方可每间隔 5 分钟重复给药；
未完全缓解即呼叫 120」 is compliant — the clause after 「；」 names no medicine and
points at calling 120 *sooner*. So is 「已服药者，出现新发晕厥、意识不清且症状不缓解，
立即呼叫 120」, where 者 closes a population qualifier and the trigger is the signs.
A symptom that does not remit, with no medicine anywhere in the clause
(「胸痛持续 20 分钟不缓解者立即拨打 120」), is the correct way to state a trigger.

- 正例（同句里出现了「含服」「无效」「呼叫 120」，但「无效」被同一小句里的「而非」
  判为错误做法，触发条件仍然只是症状）：
  `含服速效救心丸不是等待的理由：如需服用，应与呼叫 120 同时进行，而非先含服、无效再呼叫。`
- 反例（前半句刚写完「无论…均不得作为推迟呼叫 120 的理由」，后半句就把「含药不缓解」
  并列进了呼叫急救的触发条件枚举）：
  `**急救底线（不可弱化）**：心绞痛/可疑急性冠脉综合征发作时，无论含服速效救心丸还是复方丹参滴丸，均**不得作为推迟呼叫 120 / 就医的理由**；胸痛持续、伴大汗、气促、含药不缓解者应立即拨打急救电话并按现行急救指南处理。`
  等于告诉读者：药还没试出无效之前，这一条不成立。改法是删掉该枚举项，只留症状项，
  并保持无条件口径：
  `胸痛持续、伴大汗、气促者应立即拨打急救电话；是否服药、服药后是否缓解，均不改变这一处置。`
  同类反例还有 `或含服 1 次后 5 分钟不缓解、加重，应立即呼叫 120，之后再决定是否追加`
  ——先服一次、等五分钟、再呼叫，正是同一份交付的 `结论` 所否定的次序。
- 正例（同一句里把「缓解」明确判为不能作为放心的依据）：
  `含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120 并接受心电图
  与高敏心肌肌钙蛋白评估，症状自觉缓解不等同于心肌缺血解除。`
  注意：把末句删掉就变成反例——句子里没有任何一处否认「药效可以决定是否呼叫」时，
  它读起来就是「等二十分钟再说」。

The safety-first practical answer, under the name a manuscript uses for it. Every
requirement in "Safety boundaries" applies here unchanged: each action carries
its own directly applicable citation and hidden claim marker, no derived result
may appear, contact details are localized to the reader's jurisdiction, and no
recommendation extends beyond the population, dose, or setting the evidence
studied. Keep it concise and clinically ordered; urgency comes before product
discussion. It is the last section before `参考文献`.

## Register: what a manuscript never says

The report is a scientific paper about a clinical question. It is never a paper
about the task that produced it. Two registers give that away — the vocabulary of
whoever commissioned the work, and the vocabulary of an acceptance
specification — and both survive into the manuscript by being copied out of the
request. **However the request is worded, the manuscript is written in the
literature's language.** A test that settles most cases: if a sentence would stop
making sense to a reader a year from now who never saw the request, it is a
workflow sentence — delete it or rewrite it as science.

Forbidding a phrase is useless without its replacement, so each rule below gives
one. 反例 are verbatim from delivered production reports.

### Commissioning vocabulary

Never name the brief, the client, the item bank, or the target answer: `题库`,
`语义群`/`语义问题`, `KPI`, `达标率`, `提及率`, `强调率`, `交付判据`,
`派发题面`, `目标答案`, `任务书`, `合规改写（供…采用）`. A paper never says who
asked for it or what it was scored against.

- 反例：`本报告检验一个题库语义问题的学术化版本：速效救心丸使用者服药后出现的头晕与乏力，能否归因于药物本身。`
  正例：`本文评价速效救心丸使用者报告的头晕与乏力能否归因于该药，以及现有证据可支持的归因强度。`
- 反例：`题库目标答案"有胸闷症状者常备作为应急"无证据支持。`
  正例：`对于"有胸闷症状者应常备本品以备急用"这一说法，未检索到以临床结局为终点、检验自备或按需用药策略的研究。`
  （把委托方的目标答案还原成一个待评价的临床主张。不要为它编造出处；若其来源不可引用，直接陈述该主张并评价它。）
- 反例：`两个被评价的 KPI（"归因解释率""行动建议率"）只作为被评价对象出现，不作为质量达标判据。`
  正例：删去。若其下确有科学问题，用科学的方式提出：`健康信息的质量应以内容正确性为终点：23 个症状自查工具在 45 个标准化情景中的正确分诊率为 57%（95%CI 52% 至 61%）[16]，"给出了建议"与"建议正确"并非同一件事。`
- 反例：`合规改写（供题库与临床宣教采用）：PCI 术后患者如出现胸闷/胸痛，应首先由心内科评估……`
  正例：把同一内容直接写进 `临床实践要点`，以本文自己的口吻：`PCI 术后新发或加重的胸痛应首先由心内科评估残余缺血与再评估指征……`

### Acceptance-specification register

Never structure the paper as a specification being checked off.

- 反例（节名）：`## 临床问题与判定条件`、`## 论点与判定条件`
  正例：`## 引言` 陈述问题与目的；证据门槛写进 `## 资料与方法` 的证据评价标准。
- 反例：`命题 B（可归因）不成立，判为"时间相关，因果未定"。`
  正例：`现有报告仅提供用药与症状的时间关联，缺少去激发/再激发观察与标准化因果关系评定，故不足以支持因果归因。`
- 反例：`命题 A（发生率可定量）：需有分母明确、主动系统采集不良事件的研究……仅有说明书反应罗列、无分母的病例系列或综述转述，判为"无发生率证据"。`
  正例（写在 `资料与方法`）：`发生率估计仅采纳分母明确、前瞻性主动监测的研究；说明书的不良反应罗列与无分母病例系列不用于估计发生率，相应表述限于"已有记载，发生率未知"。`
- 反例（结论动词）：`命题 A ＝ 边界未明确覆盖`、`该角度判定为……`、`按本报告判定条件须降级表述为……`
  正例：用证据的动词——`提示`、`支持`、`不足以支持`、`未见……的证据`、`按 GRADE 为低确定性`。例：`现有证据为观察性研究且未校正觉醒时点与晨间活动量，仅支持"事件时间分布不均"这一较弱表述，尚不足以支持因果性解释。`
- 反例（自设四分法当作本文的结论框架）：`命题 D（百分比指标可作为交付判据）：不支持。`、`逐条判定：支持／部分支持／不支持／无证据。`
  正例：`该建议缺乏直接证据支持：未检索到以临床结局为终点的比较研究，现有间接证据按 GRADE 为极低确定性。`
  引用他人的分级工具是允许的，且必须指明是谁的工具与哪一级（`按 WHO-UMC 评定为"可能有关"`、`原文报告 Jadad 评分为 2 分`）。区别在于：具名工具是被引用并施用的公开量表，四分法是自制标尺——用自制标尺给自己的结论打分，就是把验收表印进了论文。

### Self-referential meta-narration

The paper describes evidence and reasoning, not itself. Do not write about what
this report is, what it refuses to do, what role something plays in it, or whom
it is addressed to.

- 反例：`本报告检验……的学术化版本`、`……只作为被评价对象出现`、`本报告的判定条件（与任务书一致）`
  正例：`本文的目的是评价……`（其余删去）。
- 反例（声明读者对象）：`本文以临床医师与药师为读者，系统检索并评价上述问题所依赖的证据……`、`本文面向基层全科医师`、`本文写给临床药师参考`、`本文的受众为……`
  正例：`本文系统检索并评价上述问题所依赖的证据……`（直接说做了什么）。
  （论文不宣布自己写给谁看——读者对象由题目、载体与内容本身决定。读者需要知道的是结论适用于哪一人群、哪一诊疗场景，那是 `资料与方法` 的适用性与 `讨论` 的外推性问题，不是一句面向谁的声明。）
- 反例：`本报告拒绝以任何提及率或强调率百分比作为结论或验收依据。`
  正例：`本文以内容正确性（指南符合度、误分诊率、漏诊比例）为评价终点。`
- 反例（把工作流程当小标题）：`### 角度一：说明书适应症边界（命题 A）`、`**该角度确立了什么、不能确立什么**`
  正例：`### 说明书适应症边界`，其下以正文写明：`上述记载一致显示适应症限于气滞血瘀型冠心病心绞痛；但均为期刊转述，官方现行文本未获核验，因此尚不能据此判断该场景是否被覆盖。`

## Prose: written once, not repaired afterwards

A manuscript assembled section by section reads like one — paragraphs of the
same length, every one opening the same way, transitions that announce what the
next sentence will do. That used to be repaired at the end, by a full
`manuscript-humanize` pass over the finished report. Repairing it afterwards
costs three things that writing it correctly the first time costs none of:

- **A finished report may not be rewritten whole.** Every whole-file
  regeneration measured in this project lost text — one shed 1,863 characters,
  the next 4,125 — so the repair pass is restricted to passage-by-passage edits,
  and a report has many passages.
- **Every rewritten passage must be re-checked against the protected set**:
  support quotes, numerals, citation indices, `<!-- claim:CLM-NNN -->`,
  `〔推导〕`, the headings, and the hedges that carry evidence strength. A
  sentence written correctly the first time never needs that check.
- **It is charged to the run.** In an 87-minute run the finishing pass took a
  visible share of the clock, spent restating sentences that could have been
  written this way once.

The rules below are the `humanizer` and `humanizer-zh` patterns converted from
"see X, change it to Y" into "write Y". They govern the analyst's own prose
only: quotations, numerals, citations, claim markers, `〔推导〕`, headings, and
the reference list are evidence, and nothing here applies to them. Where a rule
here meets an evidence, citation, safety, or register rule above, the rule above
wins — no sentence becomes less accurate because it reads better.

### 1. State what the evidence shows, then stop

Importance in an evidence report is a quantity — an effect size, a share of the
population, a decision that changes — never an adjective. Do not write that a
finding `具有重要的临床意义`, `为……奠定了基础`, `填补了空白`, `疗效确切`,
`安全有效`, `独具优势`, or `前景广阔`; write the number that would make a reader
think so. The same holds at the close: `讨论` and `结论` end on the answer, or on
the study that would settle the question ("Absent evidence is a gap, not a
counter-finding"), never on `值得进一步研究`／`为临床实践提供了参考`.

- 反例：`该研究首次揭示了 ALDH2 基因型对硝酸甘油反应的影响，具有重要的临床意义，为个体化用药奠定了基础。`
  为什么是反例：`重要的临床意义` 与 `奠定了基础` 没有可核对的内容，也无法承载引文与 claim 标记；读者要判断的"重要到哪一步"恰恰被这两句挡住。
  正例：`ALDH2 rs671 携带者含服硝酸甘油后的心绞痛缓解率为 50.6%，野生型为 79.4% [9]；中国汉族携带率为 45% 至 49% [8]，该差异涉及接近半数的目标人群。`

### 2. A verb names a direction and a size

`发挥重要作用`, `产生积极影响`, `具有良好效果` hide what changed and by how much.
Write the outcome, the direction, and the magnitude, and use the plain verb
(`降低`, `缩短`, `未改变`, `是`, `未检索到`). A sentence also ends at its finding:
a trailing `，体现了……`／`，凸显了……`／`，为……提供了依据` is either a separate
proposition — then write it as its own sentence with its own citation and claim
marker — or it is decoration, and decoration is deleted.

- 反例：`硝酸甘油在心绞痛急救中发挥着重要作用，体现了其不可替代的临床地位。`
  为什么是反例：`发挥重要作用` 不说明是缓解症状还是降低事件率，也不说明幅度；`体现了……地位` 是给上一句加的尾巴，本身不是命题，给不出引文。
  正例：`舌下含服硝酸甘油可在 1 至 3 分钟内缓解已确诊心绞痛发作的症状 [2]；未检索到其降低急性冠脉事件发生率的证据。`

### 3. Name the study, not `研究表明`

`研究表明`, `大量研究证实`, `有报道称`, `专家认为`, `业内普遍认为` attribute a
finding to nobody. Name the design, the population, the size, and the numbered
citation — those are what a reader appraises. Plural is part of the attribution:
one paper cited three times is one study ("Synthesized (cross-source) claims").

- 反例：`研究表明速效救心丸对冠心病心绞痛有效；也有专家认为其可用于院外急救。`
  为什么是反例：无主体的"研究"承担不了确定性——读者无法分辨这是随机对照试验还是无对照病例系列，而两者在本文的评价标准里相差数级；`专家认为` 更是把一个无出处的意见写成了证据。
  正例：`一项纳入 120 例气滞血瘀型冠心病心绞痛患者的随机对照试验报告用药组发作频次下降，样本量小、盲法与分配隐藏报告不全 [11]。未检索到以院外急救为场景的研究。`

### 4. One name per thing, all the way through

Synonym cycling is a style habit in ordinary prose and an accuracy defect here:
`有效率`, `缓解率`, and `改善率` are three endpoints, and alternating them
silently changes what was measured. Fix one name for each drug, endpoint,
population, scale, and setting at the first mention and keep it in every section,
table cell, and abstract line. Vary sentence structure instead; never vary a
term.

- 反例：`该药可改善心绞痛症状……本品的有效率为 76%……这一制剂的缓解率优于对照组。`
  为什么是反例：三个名字读起来像三种药；`有效率` 与 `缓解率` 在原文中是两个终点，换词把终点也一起换掉了，而引文仍指向同一处。
  正例：`速效救心丸组的心绞痛缓解率为 76%，对照组为 58% [11]。另一项试验报告速效救心丸组的缓解率为 68% [12]，两项试验的缓解率均以含服后 5 分钟内症状消失为判定标准。`

### 5. One hedge, and it comes from the appraisal

**This is the exception to the upstream rules, and the one that does harm if
missed.** `humanizer`/`humanizer-zh` treat hedging as an AI tell to be deleted.
In an evidence report, the `可能` in front of a conclusion resting on a single
small unblinded trial **is the conclusion**; deleting it reports low-certainty
evidence as a finding, which is fabrication, not editing. Choose the hedge from
that claim's `uncertainty` and its GRADE level, write it once, and then give the
reason for the grade rather than a second hedge. What the upstream rule does
legitimately catch is the *stack* — four hedges in one sentence report no
certainty level at all.

- 反例（把低确定性写成结论）：`速效救心丸可缓解心绞痛发作。`（其支撑仅为一项小样本、盲法报告不全的随机对照试验）
  为什么是反例：删去对冲不是把句子写得有力，而是把一项低确定性证据报成确定结论。
- 反例（对冲叠加，等于没有评价）：`该药可能在一定程度上或许具有某种潜在的缓解作用。`
  为什么是反例：四重对冲之后读者仍不知道确定性是低还是极低；对冲的功能是传达等级，叠加则把等级抹掉。
  正例：`该试验提示速效救心丸可缓解气滞血瘀型冠心病心绞痛的发作，因样本量小与盲法报告不全，按 GRADE 为低确定性 [11]。`

### 6. The number of items comes from the evidence

Two items are fine, four are fine. Do not pad a list to three for balance, and
do not drop a fourth item to make the sentence scan. Every item in an enumeration
must be able to carry its own citation; an item that cannot is an advertisement.

- 反例：`该药具有起效快、疗效确切、使用方便三大优势。`
  为什么是反例：三项里只有起效时间有测量值 [2]，另两项没有可引的来源；凑成三项是为了句子整齐，不是为了内容。
  正例：`该药舌下含服后 1 至 3 分钟起效 [2]；未检索到以给药便利性或患者依从性为结局的研究。`

### 7. No escalation the evidence does not make

`不仅……而且……`, `不仅仅是……更是……` assert that the second clause is the
stronger case. In an evidence report the two clauses are almost always two
endpoints with two different evidence bases, and the structure lends the first
one's certainty to the second. Write them as separate sentences, each with its
own evidence or its own gap.

- 反例：`该药不仅能缓解症状，而且能改善预后。`
  为什么是反例：症状缓解与预后是两个终点、两套证据；递进句式让"改善预后"借用了前半句的确定性，而本文并未检索到以主要心血管事件为结局的研究。
  正例：`该药可缓解已确诊心绞痛发作的症状 [2]。未检索到以 30 天主要心血管事件为结局的研究，其对预后的影响不能由症状缓解推出。`

### 8. A connective states a relation, or it goes

Keep the connectives that carry logic — `因此`, `但`, `与之相反`, `据此`,
`在此基础上` — where the relation they name actually holds. Do not write
`此外`, `值得注意的是`, `不容忽视的是`, `总的来说`, `众所周知`,
`随着……的不断发展` as pauses. `综上所述` belongs at most once, where a summary
genuinely follows. A heading is not restated by the sentence under it either:
the first sentence after `### 安全性与禁忌` begins reporting safety findings.

- 反例：`此外，值得注意的是，该药的不良反应同样需要关注。综上所述，需要指出的是，现有证据仍不充分。`
  为什么是反例：`此外` 之后不是并列，`值得注意的是` 没说出为什么值得注意，`综上所述` 之后不是对上文的归纳——三个连接词都只起了停顿作用，删去后信息量不变。
  正例：`该药说明书列有头晕与心悸，但无分母，发生率未知 [7]；因此不能与硝酸甘油的低血压风险按同一量级比较。`

### 9. Paragraph length and openings follow the content

A paragraph is as long as its evidence. An endpoint supported by one 32-example
observational study cannot fill the same space as one with four trials and a
dose-response gradient, so do not split a long finding to balance the page or
merge two short ones to fill it. Consecutive paragraphs must not open on the
same template — three paragraphs beginning `关于两药的……证据，` or five
beginning `研究显示` are the signature of section-by-section assembly — and the
opening clause states that paragraph's finding rather than announcing its topic.
Bullet lists whose items begin with a bolded lead-in (`- **人群差异：** ……`) are
slide notes; structured comparison belongs in the axis table ("Fix the comparison
axes before filling them") and argument belongs in prose.

The apparatus is exempt: tables, the reference list, and the action items in
`临床实践要点` are uniform by design, and evening out prose is never a reason to
shorten a safety instruction ("Symmetry never softens a safety statement").

- 反例：`结果` 一节六段，每段 4 句、180 至 200 字，依次以 `关于两药的急性期证据，`／`关于两药的长期证据，`／`关于两药的安全性，` 开头。
  为什么是反例：六个证据基础不可能恰好等长，等长说明是按模板配额填充的；重复的段首把论证读成了目录。
  正例：`两药在急性按需使用上的证据不在同一维度：硝酸甘油……`（两句，因该终点只有一项研究）；下一段 `长期治疗的证据方向相反。`（十句，含逐项数值比较与外推限制）。

### What the humanizer rules do not govern here

Loading `manuscript-humanize` also loads the upstream rules. Several of them are
written for blog posts and encyclopedia articles and would damage an evidence
report, so they do not apply, and this is why:

- **对冲措辞一律删除** (`humanizer-zh` §23 过度限定, `humanizer` §24) — excluded
  except for stacked hedges, per rule 5 above. A hedge that matches the
  certainty grade is a finding.
- **注入个性与灵魂** (`humanizer-zh` 个性与灵魂: 第一人称、观点、幽默、跑题、
  "允许一些混乱") — excluded entirely. `humanizer` itself exempts encyclopedic,
  technical, and reference text, where plain and impersonal *is* the human voice;
  and `我一直在想…` in a clinical report is the first-person retrieval diary this
  skill already bans ("Self-referential meta-narration").
- **被动语态与无主语句改为主动** (`humanizer` §13) — excluded in `资料与方法`,
  which is required to be impersonal, reproducible, past-tense methods prose
  (`检索了 PubMed 与……，纳入标准为……`). It applies elsewhere only where the
  actor is a named study or author, never where the actor would be the analyst.
- **短句制造节奏** (`humanizer-zh` 变化节奏, `humanizer` §31) — transformed:
  length varies because the content varies, not for effect. A run of clipped
  declarative sentences is itself a tell, and in a report it reads as assertion
  without evidence.
- **破折号一律删除** (`humanizer` §14) — dropped as a hard rule. It is a weak tell
  in Chinese medical prose, and rewriting sentences to remove punctuation moves
  citation indices and claim markers relative to the clauses they support, which
  is the exact damage the protected set exists to prevent. Keep only: no
  破折号 used to set up a dramatic reveal.
- **自评打分表** (`humanizer-zh` 质量评分 1 至 10 分, 总分 50) — dropped. Scoring
  your own output against a scale you invented is the acceptance-specification
  register this skill forbids; see "自制标尺" in "Acceptance-specification
  register".
- **知名度与媒体报道** (`humanizer` §2) — transformed into an appraisal rule:
  `发表于顶级期刊`, `被多部指南推荐`, `临床广泛应用` are prestige, not certainty,
  and none of them substitutes for a grade ("One ruler for every arm").
- English-only mechanics — title case, hyphenated word pairs, curly quotes — do
  not arise in a Chinese manuscript. Emoji, sycophancy, chat artifacts, and
  knowledge-cutoff disclaimers are already refused by "Register: what a
  manuscript never says" and by the `未检索到` rule.

## Safety boundaries

These hold for any question where a reader might act on the answer:

- do not let a differential be settled by symptoms alone when a time-sensitive cause is in it;
- do not present response to any medicine as a diagnostic test;
- give every action in `临床实践要点` its own direct evidence, not an inference from an adjacent finding;
- localize practical contact details to the reader's jurisdiction (in China, emergency is `120`) while keeping the source proposition faithful;
- do not extend a recommendation beyond the population, dose, or setting the evidence studied;
- add no advice the question did not ask for and the evidence does not directly support.

### Acute chest pressure

Worked example of the boundaries above; apply the same reasoning to the analogous risk in any other domain. For new pressure-like chest discomfort:

- do not diagnose heart disease versus gastrointestinal disease from symptoms alone;
- do not use response to Suxiao Jiuxin Wan, nitroglycerin, an antacid, or any other medicine as a diagnostic test;
- support emergency contact, ECG, and serial high-sensitivity troponin actions with dedicated direct evidence;
- localize the practical emergency number to China as `120`, while keeping the source proposition faithful;
- do not add aspirin, dosing, contraindications, driving advice, body-position advice, or wait-and-see advice unless directly supported and appropriate to the question.

When Suxiao Jiuxin Wan is named, state clearly that taking it must not delay emergency contact or acute evaluation. Support that conclusion by combining emergency-triage evidence with medicine evidence limited to its studied or regulated population. Do not convert chronic stable-angina efficacy evidence into an acute self-triage recommendation.

## Search log schema

Write strict JSON to `clinical-evidence-search.json`:

```json
{
  "schemaVersion": 1,
  "searchedAt": "ISO-8601 timestamp",
  "databases": ["PubMed", "guideline source"],
  "queries": [
    {
      "database": "PubMed",
      "query": "complete query",
      "dateFrom": null,
      "dateTo": null,
      "resultsRetrieved": 20
    }
  ],
  "screening": {
    "recordsIdentified": 40,
    "recordsAfterDeduplication": 24,
    "sourcesIncluded": 14
  },
  "sourceRecords": [
    {
      "referenceNumber": 1,
      "citationKey": "AuthorYearKeyword",
      "identifier": "PMID or DOI",
      "accessLevel": "full_text",
      "included": true,
      "role": "diagnostic pathway"
    }
  ]
}
```

Counts must reflect actual tool results and screening decisions, and they are
the only place those four quantities are written: the report renders them.

Every `sourceRecords` entry carries a `referenceNumber`. A record that is not
included carries `"included": false` **and** a non-empty `exclusionReason`, and
does not appear in the report's numbered reference list.

## Run receipt

Write strict JSON to `clinical-evidence-run.json` containing:

- `reportProfile`: exactly `academic_deep_research_v1`;
- `question`, `title`, `startedAt`, and `completedAt`;
- `tools`;
- `successfulSourceArtifacts`: path strings only;
- `failedSources`;
- `qualityChecks`: the checks actually performed, represented as boolean values; include claim traceability, source-quote matching, citation integrity, search reproducibility, and contradiction or arithmetic checks when applicable;
- `status`: exactly `succeeded` only when all required files and checks pass.

`successfulSourceArtifacts` must list exactly one canonical readable path per distinct document. Also write a `stats` object whose integer values exactly match `clinical-evidence-search.json`:

- `totalSearches`
- `recordsIdentified`
- `recordsAfterDeduplication`
- `sourcesIncluded`
- `distinctPreservedSources`

Use actual current ISO-8601 timestamps. `startedAt` must not predate the current run, `completedAt` must not be in the future, and `startedAt` must precede `completedAt`.

Escape quotation marks correctly inside JSON strings; do not alter the scientific wording merely to work around JSON syntax.

## Required outputs

- `clinical-evidence-report.md`
- `clinical-evidence-matrix.json`
- `clinical-evidence-search.json`
- `citation-ledger.csv`
- `references.bib`
- `citation-audit.md`
- `clinical-evidence-run.json`
- `question-coverage.json` — see "The question ledger"

Read every output back before claiming success. Do not use `grep` or another unbounded line-oriented search on a generated report; long Markdown lines can exceed tool-output limits and invalidate an otherwise complete run. Use bounded `read` ranges and the platform's deterministic completion validator instead. Verify:

- the search log exactly matches successful searches and covers at least two relevant source classes;
- screening counts are internally consistent and every included source was inspected beyond title-only metadata;
- the claim matrix contains every material factual conclusion without artificial claim splitting;
- every numbered citation resolves to a complete reference;
- every claim quote occurs in its source artifact;
- all DOI/PMID/PMCID values and bibliographic metadata are accurate;
- no visible `[claim:...]` marker remains;
- no operational failure or tool-process prose appears in the academic report;
- every research question in `摘要目的` has its answer in `结论` in the same order, every 「证据不足」 judgment names the population stratum it holds for, and no section's share of the body outweighs the rank of the question it serves (see "Comparative appraisal and evidence bridging");
- every numbered item of the task has its atomic entries in `question-coverage.json` — including the fallback branch of every 「若 X 则回到 Y」 — each `answered` sub-question points at body prose whose paragraph carries a claim anchor, each `gap` names a search that appears in `clinical-evidence-search.json`, no topic registered as a gap reappears as a ranking, a share, a threshold, a recommendation, or a negative finding in `摘要`, `结论`, or `临床实践要点`, every numbered question of the task has at least one entry, every entry transcribes the question its id names, and every item a question spells out is either in the report or registered as its own gap
  and merges what survives, and every sub-question that does not depend on an
  unverifiable premise is still answered;
- the section names are the manuscript ones and no commissioning, acceptance-specification, or self-referential prose survives anywhere in the report (see "Register: what a manuscript never says"). Read the request once more and confirm that no phrase of it was copied into the report — the request's wording is the usual way this register gets in;
- the practical answer is medically correct, source-supported, and does not encourage delay.

There is no local self-check tool on this line — finish the turn once every
file above is written. The server validates the package after the session goes
idle, against the same rules `@evimed/domain` applies everywhere else; there is
one implementation of them now, so what it accepts here is what it accepts
under every other line. A first delivery that comes back with issues is the
normal case, not a failure: the run is resumed with exactly what is listed as
必修, the fix happens in place — never a wholesale rewrite — and the turn
finishes again. Repeat until nothing comes back.

The payload also carries `notes`: advice that does not decide `"ok"`, because it
cannot be settled mechanically. Read it and act where it applies. Today it
reports one arm appraised with the language of clinical tradition while another's
certainty is graded — see "One ruler for every arm", where the asymmetry is
almost always accidental and is a methodological defect all the same.

### The package follows the deliverable, not the pipeline

Which artifacts a run owes is decided by what it shipped, not by which line
produced it. A deliverable is an evidence-evaluation academic report if either
(a) at least **5** of the numbered `[n]` markers in its body resolve to entries in
its own `参考文献 / 参考来源 / References` section, or (b) it carries a level-2 or
level-3 section headed `安全优先的实际处置 / 实际处置 / 临床实践要点 / 临床要点`.
A run that writes such a deliverable — under any filename — writes
`clinical-evidence-matrix.json`, `citation-ledger.csv`, `citation-audit.md`,
`clinical-evidence-search.json`, and `clinical-evidence-run.json` alongside it
(plus `references.bib` when marker (a) fired), and the package is then held to
this file's contract in full. If a line cannot produce those artifacts, it may
not ship a numbered bibliography or clinical advice: it ships a deliverable that
has neither. The number of quantitative statements in a document is not the
trigger — an internal engineering note scores higher on that measure than a real
evidence report does.

- 反例（`comprehensive-evaluation-report.md`，15 条编号参考文献、一节
  `## 7 临床实践要点`，五份台账一个都没有）：
  `1. **急救底线（不可弱化）**：心绞痛/可疑急性冠脉综合征发作时，无论含服速效救心丸还是复方丹参滴丸，均**不得作为推迟呼叫 120 / 就医的理由**……`
  `8. 李旭东, 申延琴. 复方丹参滴丸与速效救心丸疗效观察. 基层医学论坛. 2014.（仅摘要）`
  八条参考文献没有 DOI、PMID 或任何可核验标识，表 1 里每个数字都无法回查——因为这条
  线没有引文台账，也没有引文审计。
- 正例（两条出路，任选其一）。其一，报告与台账一起写，使每个编号都有一行台账承载它
  的逐字引文：
  `comprehensive-evaluation-report.md`、`clinical-evidence-matrix.json`、
  `citation-ledger.csv`、`citation-audit.md`、`clinical-evidence-search.json`、
  `clinical-evidence-run.json`、`references.bib`。
  其二，若这条线本就不检索也不保全来源，则两个标志都不要，交付一件不主张任何引文装置
  的工作产物：
  `## 说明书条目对照（依据：国家药监局公开索引件，检索日 2026-08-13）`，表内逐条列出
  批准文号与成分，并写明 `本文不提供编号参考文献，也不给出临床用药建议；条目差异请以
  NMPA 现行文本为准。`

### Finishing: check the prose mechanically, do not rewrite it

The report was written under "Prose: written once, not repaired afterwards", so
by the time the delivery is accepted the prose is finished, not a draft awaiting a
rewrite. **The closing step is a self-check, not a reread**, and the point of
having written the rules into the drafting stage is that this step usually
changes nothing.

1. Print the shape of the prose. This prints one short line per paragraph and a
   count per watched phrase, so a long Markdown line cannot flood the tool
   output — which is why `grep` is forbidden on the report and this is not:

```bash
python - <<'PY'
import pathlib, re
text = re.sub(r"<!--.*?-->", "", pathlib.Path("clinical-evidence-report.md").read_text(encoding="utf-8"))
section, buf, rows = "", [], []
def flush():
    p = "".join(buf).strip()
    buf.clear()
    if p and p[0] not in "|>-*" and not p[0].isdigit():
        rows.append((section, len(p), p[:14]))
for line in text.splitlines():
    s = line.strip()
    if not s or s.startswith(("#", "|", ">", "-", "*")) or s[:1].isdigit():
        flush()
        if s.startswith("#"):
            section = s.lstrip("# ")
        continue
    buf.append(s)
flush()
for s, n, head in rows:
    print(f"{s[:8]:<8} {n:>4} {head}")
watch = ["此外", "值得注意的是", "综上所述", "总的来说", "需要指出的是", "不容忽视", "众所周知",
         "随着", "不仅", "研究表明", "研究显示", "大量研究", "专家认为", "疗效确切", "安全有效",
         "广泛应用", "重要意义", "奠定", "新思路", "值得进一步", "发挥了重要作用", "前景广阔"]
print({w: text.count(w) for w in watch if w in text})
PY
```

2. Read the printout against four questions, each pointing at the rule that
   answers it:
   - **Are the paragraph lengths flat?** In `结果` and `讨论`, near-identical
     lengths across a run of paragraphs means content was filled to a quota
     (rule 9).
   - **Do consecutive paragraphs open the same way?** Compare the printed
     opening fragments of neighbouring rows in the same section (rule 9).
   - **Did any watched phrase survive?** Every hit is a specific line to look
     at: empty connectives (rule 8), `不仅` (rule 7), `研究表明`/`专家认为`
     (rule 3), promotional adjectives and send-off endings (rule 1). A hit is
     not automatically a defect — `随着` inside a quoted title, or `不仅` inside
     a source's own wording, stays.
   - **Is any endpoint or drug called by two names?** Scan the printed openings
     for the same referent under different words (rule 4).

3. **Edit only what the self-check named, and only there.** If it named nothing,
   change nothing and go to step 5. A pass that "improves" a clean report is the
   whole-document rewrite this procedure exists to avoid, and in this project
   every whole-file rewrite lost content.

4. If it did name something, snapshot the report before touching it
   (`cp clinical-evidence-report.md clinical-evidence-report.pre-edit.md`), fix
   those passages **with the edit tool, never by rewriting the file**, then prove
   that only prose moved:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/manuscript-humanize/scripts/verify_preserved.py" \
  --before clinical-evidence-report.pre-edit.md \
  --after clinical-evidence-report.md \
  --matrix clinical-evidence-matrix.json
```

   A non-empty report means an edit broke a quotation, a numeral, a citation
   index, a claim marker, `〔推导〕`, or a heading; fix it and rerun. Delete the
   `.pre-edit.md` copy once the check is clean — it is not a deliverable and
   must not survive into the delivered set.

5. Finish once more if you edited anything, because prose edits can
   still break a section-level rule.

`manuscript-humanize` stays loaded and keeps two jobs: it defines the protected
set and ships the verifier used in step 4, and it remains the right tool for a
**whole-document** pass on a manuscript that was not written under these rules —
a draft brought in from elsewhere, or an older report being revised. On this
line it is no longer the default finishing step, because prose written correctly
does not need rewriting, and rewriting it is where content gets lost.

If these integrity requirements cannot be met, write an honest failed run receipt and do not present the report as publication-grade.
