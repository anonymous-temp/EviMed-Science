import { clinicalContentTriggerPattern } from "@evimed/domain";

// The default open-domain handler. It is not a routable specialist: unrouted
// open-domain dispatches fall back to it in server.mjs, and it must be
// excluded from router/classifier candidate lists and specialist catalogs.
export const OPEN_DOMAIN_ANSWER_AGENT_ID = "open-domain-answer";

// High-risk medicines that must route an open-domain evidence question to the
// clinical gate are data-driven from the same pharmacist-owned rules file that
// holds the medicine-specific safety checks, so a plain "速效救心丸疗效分析"
// still reaches clinical-evidence-synthesis without hardcoding the drug here.
function loadClinicalRoutingPattern() {
  return clinicalContentTriggerPattern();
}

const clinicalRoutingMedicinePattern = loadClinicalRoutingPattern();

// A specialty term appearing in a request is not a request for that specialty.
// Every one of these rules fires on the vocabulary a *review of that field*
// necessarily uses: an evidence appraisal of a drug's long-term safety says
// 不良反应 and 药物警戒, one about an unapproved indication says 超说明书, one
// weighing published syntheses says 荟萃分析. Six of thirty-three briefs
// commissioning a clinical evidence review were routed away from it on exactly
// these words, and produced deliverables nobody asked for.
//
// So a rule only fires when the request asks for that specialty's own
// deliverable — the term together with a verb of commissioning — and the
// classifier, which can read intent, decides everything else. This is the net
// under the model, not a competing router.
// Widening this list pulled a brief back into the wrong pipeline; narrowing it
// dropped a real commission. That trade has no settling point, because the
// distinction is between commissioning a deliverable and discussing the field
// it belongs to, and no list of verbs encodes it. That is precisely the
// judgement the classifier makes, so the net below no longer tries to make it
// for the topical specialties — it fires on the terms a request uses when it
// asks for that specialty's own artefact by name.
const commissioningVerb = "(?:做|作|开展|进行|执行|完成|跑|出|写|撰写|生成|产出|给我|帮我|请|需要|评估|评价|conduct|run|perform|generate|produce|assess|evaluate)";
const routeRules = Object.freeze([
  ["adr-analysis", new RegExp(`${commissioningVerb}[^。；;!?、，,\n]{0,16}(?:药物警戒|(?:药物|药品)安全性(?:信号)?分析|不良(?:反应|事件)[^。；;!?\n]{0,4}(?:信号|监测)|\\bfaers\\b|\\bopenfda\\b|pharmacovigilance|disproportionality analysis)|(?:药物警戒|\\bfaers\\b|\\bopenfda\\b|disproportionality)[^。；;!?\n]{0,12}(?:信号|分析报告|信号分析|评价报告)|(?:\\bROR\\b|\\bPRR\\b|\\bEBGM\\b)[^。；;!?\n]{0,20}(?:信号|disproportional)`, "i")],
  ["bibliometric-analysis", /(?:文献计量|科学计量|citespace|vosviewer|bibliometric)/i],
  ["comprehensive-drug-evaluation", /(?:药品综合评价|药物综合评价|综合评价.{0,20}(?:药|临床价值)|comprehensive drug evaluation)/i],
  ["drug-selection", /(?:药品遴选|药物遴选|院内目录.{0,12}(?:选择|评分)|formulary.{0,12}(?:selection|decision))/i],
  ["mendelian-randomization", /(?:孟德尔随机化|mendelian randomi[sz]ation|\btwo[- ]sample mr\b)/i],
  ["off-label-analysis", new RegExp(`${commissioningVerb}[^。；;!?、，,\n]{0,16}(?:超说明书|说明书外用药|off[- ]label)|(?:超说明书|说明书外用药|off[- ]label)[^。；;!?\n]{0,12}(?:证据(?:评价|报告)|分析报告|评估报告)`, "i")],
  ["peer-review", /(?:论文审稿|同行评审|审查.{0,12}(?:论文|稿件)|peer review.{0,20}(?:paper|manuscript))/i],
  ["research-topic-selection", /(?:科研选题|研究选题|选题设计|research topic selection)/i],
]);

// A request that starts from data the researcher already holds and asks what it
// can support. Both halves are required: the data they have, and the question of
// what it can carry.
//
// These used to reach clinical-evidence-synthesis, which is a literature
// synthesis and has no profiling step — so the dataset's own fields never
// entered the judgment it was asked to make. A production run asked exactly
// this of a five-table hospital extract and got an evidence report back.
// dataset-research-scoping profiles the data first and answers per candidate
// question, naming the missing field whenever the answer is no.
// The possessive and the data word are rarely adjacent — "我手上有一份住院数据"
// puts five characters between them — so a bounded gap is allowed, stopping at
// a sentence boundary so two unrelated clauses cannot combine into a match.
// Every alternative here must mean "data the researcher is holding". Bare
// 数据集 / 数据库 / 资料 do not: a brief that says 中文全文数据库（CNKI、万方等）
// 无法访问, or names its own 资料与方法 section, was routed to dataset scoping
// and failed for want of deliverables it was never asked to produce. A word
// that appears in the methods section of every clinical paper cannot be the
// evidence that someone uploaded a file, so possession has to be stated —
// 上传/我的/手上/本院 — or the object has to be a file.
// 资料 is out of the possessable set for the same reason: 现有资料只能"提示"某种
// 关联 is how an evidence appraisal states its own limits, and it matched
// 现有 + 资料 exactly. What survives here has to be a thing with rows.
// 数据 alone is back, but only behind a possessive that means someone handed it
// over — 上传/我的/手上/本院 — never behind 现有/已有, which is how a paper
// describes the literature it found rather than a file it holds.
const datasetSubject = /(?:(?:上传|我的|我们的|手上|手里|这份|那份|本院|院内|自己的)[^。；;!?\n]{0,12}?(?:数据集?|数据库|数据表|表格)|(?:现有|已有)[^。；;!?\n]{0,12}?(?:数据集|数据表|表格)|数据抽取|抽取数据|数据导出|\.(?:xlsx?|csv|tsv|parquet)\b|uploaded\s+(?:hospital\s+)?(?:data|dataset)|data\s+extract)/i;
// The last clause is the model case, and it was missing. "这份数据能不能支撑一个
// 个体化用药的预测模型" is the same question — what will this data carry — but
// its object is a model rather than a 研究 or 课题, so the enumeration above did
// not reach it and only the LLM fallback did. A router that depends on the
// fallback for a question this central is one outage away from answering it in
// chat with no deliverable.
const datasetScopingIntent = /(?:(?:能|可以|可能|适合|能否|能不能|可不可以)\s*(?:做|开展|支撑|支持|回答|产出|发)\s*(?:哪些|什么|多少)?\s*(?:科学性?)?(?:研究|课题|分析|选题|文章|论文)|(?:研究|课题|选题|分析)\s*(?:的)?\s*可行性|(?:哪些|什么)\s*(?:科学性?)?(?:研究|课题|选题)|(?:能|可以|能否|能不能|可不可以|是否)\s*(?:支撑|支持|做|搭|建|构建|训练|拟合|开发)\s*(?:出|一个|一套|一版)?[^。；;!?\n]{0,16}?模型|模型[^。；;!?\n]{0,10}可行|what\s+(?:research|studies|questions).{0,24}(?:support|possible|feasible)|research\s+feasibilit|feasibility\s+of\s+(?:the\s+)?(?:data|dataset|[^.;\n]{0,24}model)|(?:请|帮我|麻烦)?\s*(?:出|做|写|给出|产出|生成|完成)\s*(?:一份|一版|一个)?[^。；;!?\n]{0,20}?(?:分析报告|科研选题|选题分析|研究方案|课题|数据画像|可行性分析)|(?:分析|画像|勘查|梳理)\s*(?:一下|下)?\s*(?:这份|这批|上传的|我的)?\s*(?:数据|数据集|抽取)|(?:analy[sz]e|profile|scope)\s+(?:the\s+)?(?:uploaded\s+)?(?:hospital\s+)?(?:data|dataset|extract))/i;

// Subjects that are research work rather than a clinical presentation. These
// only route anywhere in combination with an explicit report request, so a
// question that merely mentions 研究 or 数据 is unaffected.
const researchSubject = /(?:数据集|数据库|字段|数据结构|队列|回顾性|前瞻性|真实世界|科研|研究方向|研究设计|选题|可行性|统计分析|挖掘|dataset|cohort|retrospective|real[- ]world)/i;
// Presentations, and the pharmacology vocabulary a medication question is
// actually written in. Without the latter, "阿立哌唑血药浓度的分析报告" named
// no clinical subject the router recognised: the drug is not on the safety
// rules' medicine list and 血药浓度 was in neither pattern.
const clinicalSubject = /(?:胸痛|胸口|心绞痛|急性冠脉|冠心病|胃食管|患者|症状|诊断|治疗|用药|药物|临床|疾病|血药浓度|药物浓度|血药|药代动力学|药动学|治疗药物监测|TDM|不良反应|适应症|禁忌|剂量)/i;
// The heavy clinical report pipeline only engages on an EXPLICIT report /
// deep-synthesis request. Plain clinical questions ("X 药疗效怎么样",
// "分析下 X 的机制") stay on the open-domain answer line, whose skill carries
// the same safety framing without the 12-section academic package.
// The verbs here were the ones someone thought of. A real request — "给我写出
// 所有的分析结果和报告" — used 写出, matched none of them, and went to the
// answer line, which produces no file: the user asked for a report and received
// a chat message. Asking for a 报告 or 综述 is the intent, whichever verb
// carries it, and a named report ("分析报告", "研究报告") is one outright.
// Questions that merely contain 分析 or 研究 without asking for a document are
// unaffected, which the routing tests hold.
// 一篇…论文 is a commission too, and the most academic way to write one.
//
// This pattern knew 报告 and 综述 and not 论文, so a brief whose 交付 section
// read 「一篇面向临床医师与药师的中文学术论文」 — under a title asking for
// 有效性与安全性证据评价 of a named medicine — matched nothing. The clinical
// subject matched; the report intent did not; the net returned null. When the
// classifier then timed out, that request became an open-domain chat answer
// with no report and no gate, which is exactly what this net exists to prevent
// ("a high-risk medicine asked about in a report request always reaches the
// clinical gate"). A quantifier is required — 「一篇/一份…论文」 commissions one,
// while 「这篇论文说……」 cites one — so a discussion of published papers is
// still not a request to write one.
const explicitReportIntent = /(?:证据报告|证据综合|循证.{0,6}报告|综合.{0,6}证据.{0,4}报告|出一份|写一份|撰写|(?:生成|整理|写出|给我|出具|提供|输出|形成|产出|完成).{0,16}(?:报告|综述|论文|文稿)|(?:一篇|一份|一本)[^。；;\n]{0,30}(?:论文|报告|综述|文稿)|(?:分析|研究|评估|可行性|调研|论证|总结)报告|深度(?:研究|调研|报告)|systematic review|evidence report|evidence synthesis|clinical evidence report)/i;
// Commissioning one, not citing one. The trailing half used to match any
// mention followed by 分析 or 研究 within 24 characters, which is how
// "优先采用大样本前瞻队列、注册登记及其 meta 分析" and "现有网络 meta 分析……
// 表现如何" — both appraising published syntheses, in briefs asking for a
// clinical evidence review — were routed to the meta-analysis pipeline. The
// distinction is exactly the one the classifier is told to make; a pattern that
// cannot make it should not try.
// The verb and the object are rarely adjacent — 开展降压药对卒中结局的 meta 分析
// puts a whole PICO between them — so a bounded gap is allowed. What is not
// allowed is the reverse order without a commissioning word, which is how a
// citation reads: 现有网络 meta 分析在传递性上表现如何.
const positiveMetaIntent = /(?:(?:开展|进行|执行|完成|做|跑|conduct|run|perform)[^。；;!?\n]{0,24}?(?:meta\s*分析|荟萃分析|系统评价|systematic review|meta-analysis)|(?:meta\s*分析|荟萃分析|systematic review|meta-analysis)\s*(?:的)?\s*(?:任务|作业|流水线|pipeline|job))/i;
const negatedMetaIntent = /(?:不要|不得|无需|不需要|避免|别|禁止|not|without).{0,48}(?:meta\s*分析|荟萃分析|系统评价|systematic review|meta-analysis)/i;

function selection(agent, reason) {
  if (!agent) return null;
  return Object.freeze({
    agentId: agent.id,
    agentVersion: agent.version,
    runtimeAgent: agent.runtimeAgent,
    reason,
  });
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} query
 *  @param {any} agents
 */
/** Naming the package is an instruction, not a guess at intent, so it is the one
 *  signal that outranks the classifier — a request saying
 *  "请按 dataset-research-scoping 出一份报告" was once routed elsewhere because
 *  the name matched no topic pattern and nothing looked at it.
 *  @param {any} query @param {any} agents */
/**
 * A capability id inside 《》 is the title of a document, not an instruction.
 *
 * `《…》` marks the name of a work, and only that — unlike 「」 or quotation
 * marks, which a user may reasonably put around a package name for emphasis.
 * So the span is removed before the name match, and nothing else is.
 *
 * Measured 2026-08-31: two of thirty-three batch cases were routed to
 * meta-analysis by their own paper titles — 《… large-scale meta-analysis of 192
 * epidemiological studies.》 and 《… an individual patient data meta-analysis.》 —
 * and were then failed for not producing meta-analysis-report.md, which nobody
 * had asked for. Naming outranks the classifier, so in both runs the model was
 * never consulted at all.
 *
 * This is a structural check on a delimiter, not a widening of any prose
 * pattern: the capability ids are a closed list, and 《》 either encloses a span
 * or does not.
 * @param {string} query @returns {string}
 */
function withoutTitledWorks(query) {
  return query.replace(/《[^》]*》/g, " ");
}

export function routeNamedSpecialist(query, agents) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return null;
  const lowered = withoutTitledWorks(query).toLowerCase();
  const named = agents.find((agent) => lowered.includes(agent.id));
  return named ? selection(named, `matched:named:${named.id}`) : null;
}

export function routeOpenDomainSpecialist(query, agents, { afterCleanNone = false } = {}) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return null;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const named = routeNamedSpecialist(query, agents);
  if (named) return named;
  const dataInHand = datasetSubject.test(query) && datasetScopingIntent.test(query);
  // Both of these start from a question and never open the file. Naming a
  // mini-review or a literature landscape inside a scoping request is normal —
  // the scoping skill owes one per topic — so the review vocabulary must not
  // outrank the dataset. A request asking for both went to
  // clinical-evidence-synthesis, which read no data at all.
  const literatureOnly = new Set(["research-topic-selection", "clinical-evidence-synthesis"]);
  for (const [id, pattern] of routeRules) {
    if (!(/** @type {RegExp} */ (pattern).test(query))) continue;
    if (literatureOnly.has(/** @type {string} */ (id)) && dataInHand) break;
    return selection(byId.get(id), `matched:${id}`);
  }
  if (positiveMetaIntent.test(query) && !negatedMetaIntent.test(query)) {
    return selection(byId.get("meta-analysis"), "matched:meta-analysis");
  }
  // After meta, so "对我的数据集做 meta 分析" still reaches the meta pipeline,
  // and before the clinical fallback, which would otherwise take this.
  if (datasetSubject.test(query) && datasetScopingIntent.test(query)) {
    return selection(byId.get("dataset-research-scoping"), "matched:dataset-research-scoping");
  }
  // The clinical-subject requirement exists to keep generic conversation off
  // the heavy pipeline. It also kept a dataset off it: "基于上传的数据集，分析
  // 能做哪些科学性研究……写出所有的分析结果和报告" names no symptom, drug or
  // diagnosis, because its clinical content is in the attached file rather than
  // in the sentence. The router reads the prompt, not the workspace, so that
  // request could not reach the report line however it was phrased. A request
  // to report on data or on research design is not generic conversation.
  //
  // What a clean `none` from the model changes, and what it does not.
  //
  // The specific rules above stay in force whatever the model said. They carry
  // a strong signal — FAERS vocabulary, an explicit meta-analysis intent, a
  // dataset in hand — and the net exists precisely because the model gets one
  // of those wrong occasionally: asked about 奥希替尼's pharmacovigilance
  // signals it can still answer "none", and that answer is simply wrong.
  //
  // This last rule is different. It is the broad catch-all: any clinical or
  // research subject plus any request for a write-up. Measured 2026-08-31 on
  // the real title-to-paper corpus, it claimed fifty paper-rewrite briefs the
  // model had correctly declined — each run then produced the rewrite the brief
  // asked for and was failed for not loading a clinical skill nobody asked it
  // to use, four times out of four. A broad rule overturning a considered "no
  // specialist fits" is the shape that keeps being wrong.
  //
  // So after a clean `none`, the only thing that still reaches the clinical
  // line here is the medicine list — data, owned by pharmacists in
  // clinical-safety-rules.json, a closed vocabulary rather than prose matching.
  // Narrowing the prose patterns instead would be extending the keyword wall
  // (principles 2 and 5); the rules are fine, the question is when to consult
  // them.
  const namedMedicine = clinicalRoutingMedicinePattern != null && clinicalRoutingMedicinePattern.test(query);
  const clinicalSubjectMatch = afterCleanNone
    ? namedMedicine
    : (clinicalSubject.test(query) || researchSubject.test(query) || namedMedicine);
  if (clinicalSubjectMatch && explicitReportIntent.test(query)) {
    if (dataInHand) return selection(byId.get("dataset-research-scoping"), "matched:dataset-research-scoping");
    return selection(
      byId.get("clinical-evidence-synthesis"),
      afterCleanNone ? "matched:clinical-evidence-synthesis(safety-medicine)" : "matched:clinical-evidence-synthesis",
    );
  }
  return null;
}
