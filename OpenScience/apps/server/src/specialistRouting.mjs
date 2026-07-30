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

const clinicalSubject = /(?:胸痛|胸口|心绞痛|急性冠脉|冠心病|胃食管|患者|症状|诊断|治疗|用药|药物|临床|疾病)/i;
// The heavy clinical report pipeline only engages on an EXPLICIT report /
// deep-synthesis request. Plain clinical questions ("X 药疗效怎么样",
// "分析下 X 的机制") stay on the open-domain answer line, whose skill carries
// the same safety framing without the 12-section academic package.
const explicitReportIntent = /(?:证据报告|证据综合|循证.{0,6}报告|综合.{0,6}证据.{0,4}报告|出一份|写一份|撰写|生成.{0,12}(?:报告|综述)|整理.{0,12}(?:报告|综述)|深度(?:研究|调研|报告)|systematic review|evidence report|evidence synthesis|clinical evidence report)/i;
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

export function routeOpenDomainSpecialist(query, agents) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return null;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const [id, pattern] of routeRules) {
    if (pattern.test(query)) return selection(byId.get(id), `matched:${id}`);
  }
  if (positiveMetaIntent.test(query) && !negatedMetaIntent.test(query)) {
    return selection(byId.get("meta-analysis"), "matched:meta-analysis");
  }
  const clinicalSubjectMatch = clinicalSubject.test(query)
    || (clinicalRoutingMedicinePattern != null && clinicalRoutingMedicinePattern.test(query));
  if (clinicalSubjectMatch && explicitReportIntent.test(query)) {
    return selection(byId.get("clinical-evidence-synthesis"), "matched:clinical-evidence-synthesis");
  }
  return null;
}
