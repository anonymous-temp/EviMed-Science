const routeRules = Object.freeze([
  ["adr-analysis", /(?:药物警戒|药品安全性分析|药物安全性分析|不良反应信号|\bfaers\b|pharmacovigilance)/i],
  ["bibliometric-analysis", /(?:文献计量|科学计量|citespace|vosviewer|bibliometric)/i],
  ["comprehensive-drug-evaluation", /(?:药品综合评价|药物综合评价|综合评价.{0,20}(?:药|临床价值)|comprehensive drug evaluation)/i],
  ["drug-selection", /(?:药品遴选|药物遴选|院内目录.{0,12}(?:选择|评分)|formulary.{0,12}(?:selection|decision))/i],
  ["mendelian-randomization", /(?:孟德尔随机化|mendelian randomi[sz]ation|\btwo[- ]sample mr\b)/i],
  ["off-label-analysis", /(?:超说明书|说明书外用药|off[- ]label)/i],
  ["peer-review", /(?:论文审稿|同行评审|审查.{0,12}(?:论文|稿件)|peer review.{0,20}(?:paper|manuscript))/i],
  ["research-topic-selection", /(?:科研选题|研究选题|选题设计|research topic selection)/i],
]);

const clinicalSubject = /(?:胸痛|胸口|心绞痛|急性冠脉|冠心病|胃食管|速效救心丸|患者|症状|诊断|治疗|用药|药物|临床|疾病)/i;
const evidenceIntent = /(?:学术|科研|证据|分析|报告|研究|指南|文献|题目|clinical evidence|evidence synthesis)/i;
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
  if (clinicalSubject.test(query) && evidenceIntent.test(query)) {
    return selection(byId.get("clinical-evidence-synthesis"), "matched:clinical-evidence-synthesis");
  }
  return null;
}
