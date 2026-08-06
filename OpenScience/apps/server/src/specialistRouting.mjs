import { readFileSync } from "node:fs";

// The default open-domain handler. It is not a routable specialist: unrouted
// open-domain dispatches fall back to it in server.mjs, and it must be
// excluded from router/classifier candidate lists and specialist catalogs.
export const OPEN_DOMAIN_ANSWER_AGENT_ID = "open-domain-answer";

// High-risk medicines that must route an open-domain evidence question to the
// clinical gate are data-driven from the same pharmacist-owned rules file that
// holds the medicine-specific safety checks, so a plain "速效救心丸疗效分析"
// still reaches clinical-evidence-synthesis without hardcoding the drug here.
function loadClinicalRoutingPattern() {
  const parsed = JSON.parse(readFileSync(new URL("./clinical-safety-rules.json", import.meta.url), "utf8"));
  const entities = Array.isArray(parsed?.routingEntities)
    ? parsed.routingEntities.filter((entity) => typeof entity === "string" && entity.trim())
    : [];
  if (!entities.length) return null;
  const escaped = entities.map((entity) => entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

const clinicalRoutingMedicinePattern = loadClinicalRoutingPattern();

const routeRules = Object.freeze([
  ["adr-analysis", /(?:药物警戒|(?:药物|药品)安全性(?:信号)?分析|不良(?:反应|事件).{0,4}(?:信号|监测)|\bfaers\b|\bopenfda\b|(?:\bROR\b|\bPRR\b|\bEBGM\b).{0,20}(?:信号|不良|disproportional)|pharmacovigilance|disproportionality analysis)/i],
  ["bibliometric-analysis", /(?:文献计量|科学计量|citespace|vosviewer|bibliometric)/i],
  ["comprehensive-drug-evaluation", /(?:药品综合评价|药物综合评价|综合评价.{0,20}(?:药|临床价值)|comprehensive drug evaluation)/i],
  ["drug-selection", /(?:药品遴选|药物遴选|院内目录.{0,12}(?:选择|评分)|formulary.{0,12}(?:selection|decision))/i],
  ["mendelian-randomization", /(?:孟德尔随机化|mendelian randomi[sz]ation|\btwo[- ]sample mr\b)/i],
  ["off-label-analysis", /(?:超说明书|说明书外用药|off[- ]label)/i],
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
const datasetSubject = /(?:(?:上传|我的|我们的|手上|手里|现有|已有|这份|那份|本院|院内|自己的)[^。；;!?\n]{0,12}?(?:数据集?|数据库|数据表|资料|表格)|数据集|dataset|data\s?set)/i;
// The last clause is the model case, and it was missing. "这份数据能不能支撑一个
// 个体化用药的预测模型" is the same question — what will this data carry — but
// its object is a model rather than a 研究 or 课题, so the enumeration above did
// not reach it and only the LLM fallback did. A router that depends on the
// fallback for a question this central is one outage away from answering it in
// chat with no deliverable.
const datasetScopingIntent = /(?:(?:能|可以|可能|适合|能否|能不能|可不可以)\s*(?:做|开展|支撑|支持|回答|产出|发)\s*(?:哪些|什么|多少)?\s*(?:科学性?)?(?:研究|课题|分析|选题|文章|论文)|(?:研究|课题|选题|分析)\s*(?:的)?\s*可行性|(?:哪些|什么)\s*(?:科学性?)?(?:研究|课题|选题)|(?:能|可以|能否|能不能|可不可以|是否)\s*(?:支撑|支持|做|搭|建|构建|训练|拟合|开发)\s*(?:出|一个|一套|一版)?[^。；;!?\n]{0,16}?模型|模型[^。；;!?\n]{0,10}可行|what\s+(?:research|studies|questions).{0,24}(?:support|possible|feasible)|research\s+feasibilit|feasibility\s+of\s+(?:the\s+)?(?:data|dataset|[^.;\n]{0,24}model))/i;

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
const explicitReportIntent = /(?:证据报告|证据综合|循证.{0,6}报告|综合.{0,6}证据.{0,4}报告|出一份|写一份|撰写|(?:生成|整理|写出|给我|出具|提供|输出|形成|产出|完成).{0,16}(?:报告|综述)|(?:分析|研究|评估|可行性|调研|论证|总结)报告|深度(?:研究|调研|报告)|systematic review|evidence report|evidence synthesis|clinical evidence report)/i;
const positiveMetaIntent = /(?:(?:开展|进行|执行|完成|做|conduct|run).{0,24}(?:meta\s*分析|荟萃分析|系统评价|systematic review|meta-analysis)|(?:meta\s*分析|荟萃分析|systematic review|meta-analysis).{0,24}(?:开展|进行|执行|完成|研究|分析))/i;
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
export function routeOpenDomainSpecialist(query, agents) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return null;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const [id, pattern] of routeRules) {
    if (/** @type {RegExp} */ (pattern).test(query)) return selection(byId.get(id), `matched:${id}`);
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
  const clinicalSubjectMatch = clinicalSubject.test(query)
    || researchSubject.test(query)
    || (clinicalRoutingMedicinePattern != null && clinicalRoutingMedicinePattern.test(query));
  if (clinicalSubjectMatch && explicitReportIntent.test(query)) {
    return selection(byId.get("clinical-evidence-synthesis"), "matched:clinical-evidence-synthesis");
  }
  return null;
}
