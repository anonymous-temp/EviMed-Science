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

Use `evimed_literature_search`, `evimed_guideline_search`, and selected audited sources from `evimed_data_source_catalog` or `evimed_biomedical_source_search`. Deduplicate candidate records with `evimed_evidence_deduplicate`.

When calling `evimed_evidence_deduplicate`, omit absent identifier keys instead of sending empty `doi`, `pmid`, `pmcid`, or URL strings. If input validation fails, correct the full batch and obtain a successful deduplication result before continuing.

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

Use `evimed_official_page_fetch` for approved professional-society, guideline, evidence-review, public-health, or regulatory pages. Use `evimed_open_access_full_text` for key PMID, PMCID, or DOI records with accessible full text.

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

Quote contiguously by default. You may elide a passage you do not need by marking the gap with `…`, as any scholarly quotation does; each side of the gap is then checked on its own and must appear in the source in the order you wrote it. Never join two passages without marking the gap, and never elide across a qualification — a quote reading "the effect was significant … in the subgroup analysis" that hides "not" is a misquotation whether or not the words are all in the document. Copy sentences as they read: an inline citation marker the extractor left mid-sentence ("…in coronary spasm patients.23 Li Jin et al…") is not part of the sentence and may be left out.

**`artifactPath` is copied from a tool result — never typed by hand.** Only two tools preserve an artifact you may cite: `evimed_open_access_full_text` (papers, by DOI or PMCID) and `evimed_official_page_fetch` (labels, guidelines, regulatory and institutional pages). Each returns the workspace path it wrote under `.evimed-sources/`; that exact string is the `artifactPath`. A search hit is not an artifact — search tells you what exists, preservation is a second call.

So when you want to cite something you have only seen in search results, **preserve it first**: fetch the full text by its DOI or PMCID, or fetch its official page by URL. If neither preserves it — no open-access copy, no reachable official page — then you have not read that source and it cannot carry a claim. Cite the sources you did preserve instead, and if that leaves the point unsupported, say in the report that the evidence was not obtainable. Do not describe the gap in the path field: a string like `abstract-only PMID:15940087` or `regulatory-record NMPA速效救心丸` is not a path, and writing one asserts a verification that never happened.

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
8. `临床实践要点` — the safety-first practical answer. This section carries every safety duty the report has; it was named `安全优先的实际处置` and only the name changed.
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

Counts must reflect actual tool results and screening decisions.

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
- the section names are the manuscript ones and no commissioning, acceptance-specification, or self-referential prose survives anywhere in the report (see "Register: what a manuscript never says"). Read the request once more and confirm that no phrase of it was copied into the report — the request's wording is the usual way this register gets in;
- the practical answer is medically correct, source-supported, and does not encourage delay.

Then run the deterministic structural preflight from the loaded skill directory:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/clinical-evidence-synthesis/scripts/preflight.py" --workspace .
```

If it exits non-zero, fix every listed issue and run it again. Do not finish
until it returns `"ok": true`. The server performs a stricter independent
evidence and source-integrity gate after this preflight.

The payload also carries `notes`: advice that does not decide `"ok"`, because it
cannot be settled mechanically. Read it and act where it applies. Today it
reports one arm appraised with the language of clinical tradition while another's
certainty is graded — see "One ruler for every arm", where the asymmetry is
almost always accidental and is a methodological defect all the same.

Once the preflight is clean, make one editing pass over the report with the
`manuscript-humanize` companion skill. A report assembled section by section
reads like one: paragraphs of the same length, every one opening the same way,
transitions that announce what the next sentence will do. The pass rewrites that
prose and nothing else — quotations, numbers, citation indices, claim markers,
`〔推导〕`, the section headings and the hedges that carry evidence strength are
fixed points, and its `verify_preserved.py` proves afterwards that they did not
move. Hedging is the case worth understanding: a `可能` in front of a claim
resting on one small trial is the finding, not weak writing, and sharpening it
is fabrication.

Then run the preflight once more, because prose edits can still break a
section-level rule.

If these integrity requirements cannot be met, write an honest failed run receipt and do not present the report as publication-grade.
