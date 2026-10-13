import { clinicalContentTriggerPattern } from "@evimed/domain";

// The default open-domain handler. It is not a routable specialist: unrouted
// open-domain dispatches fall back to it in server.mjs, and it must be
// excluded from router/classifier candidate lists and specialist catalogs.
export const OPEN_DOMAIN_ANSWER_AGENT_ID = "open-domain-answer";

// Where an open-domain request goes, in this order:
//
//   1. a structured choice — the capability picked in the shell (`line` on the
//      dispatch), a session bound to one, or a leading `/<capability-id>` —
//      routes by name and nothing else is asked (the first two are decided by
//      the callers, the last by `routeSlashCommand` below);
//   2. otherwise the model reads the request (`SpecialistClassifier`) and its
//      answer is final: a specialist, or none;
//   3. when the model did not answer, or answered none, the request goes to the
//      ordinary conversation line — except the one data rule below.
//
// No word list decides what a request commissions. The rules that used to sit
// here (a verb of commissioning plus a field's vocabulary, a spreadsheet plus
// "分析一下", a capability id as a substring, a clinical word plus "报告") each
// took ordinary work into a heavy pipeline: a sales spreadsheet into research
// scoping, "什么是同行评审" into peer review, a message-queue comparison into a
// clinical evidence review, a pull request into peer review. Intent is language,
// so the model reads it; what this module keeps is only what is exact.

// High-risk medicines that must route an open-domain evidence report to the
// clinical gate are data-driven from the same pharmacist-owned rules file that
// holds the medicine-specific safety checks (clinical-safety-rules.json), so a
// plain "速效救心丸疗效证据报告" still reaches clinical-evidence-synthesis
// without hardcoding the drug here. A closed vocabulary, not prose matching.
const clinicalRoutingMedicinePattern = clinicalContentTriggerPattern();

// Asking for a report is the intent, whichever verb carries it — 「给我写出所有的
// 分析结果和报告」 used 写出 and matched no verb list — and 一篇…论文 is a
// commission too, as long as a quantifier says one is wanted (「这篇论文说……」 cites one).
// It only ever combines with a named high-risk medicine, never alone.
const explicitReportIntent = /(?:证据报告|证据综合|循证.{0,6}报告|综合.{0,6}证据.{0,4}报告|出一份|写一份|撰写|(?:生成|整理|写出|给我|出具|提供|输出|形成|产出|完成).{0,16}(?:报告|综述|论文|文稿)|(?:一篇|一份|一本)[^。；;\n]{0,30}(?:论文|报告|综述|文稿)|(?:分析|研究|评估|可行性|调研|论证|总结)报告|深度(?:研究|调研|报告)|systematic review|evidence report|evidence synthesis|clinical evidence report)/i;

/** The medicine rule's one target. */
const SAFETY_MEDICINE_AGENT_ID = "clinical-evidence-synthesis";

function selection(agent, reason) {
  if (!agent) return null;
  return Object.freeze({
    agentId: agent.id,
    agentVersion: agent.version,
    runtimeAgent: agent.runtimeAgent,
    reason,
  });
}

/** Keep classifier-failure provenance inside the AgentRun reason vocabulary.
 * @param {unknown} base @param {unknown} failure @returns {string} */
export function classifierFailureReason(base, failure) {
  let prefix = String(base ?? "route").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-");
  if (!/^[a-z]/.test(prefix)) prefix = `route:${prefix}`;
  const code = String(failure ?? "unknown").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 32) || "unknown";
  const suffix = `:classifier:${code}`;
  return `${prefix.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

/**
 * A capability id inside 《》 is the title of a document, not a word of the
 * request: 《A meta-analysis of remote work productivity》 names a paper.
 * `《…》` marks the name of a work and only that, so the span is removed before
 * ids are looked for. A structural check on a delimiter, not a prose pattern.
 * @param {string} query @returns {string}
 */
function withoutTitledWorks(query) {
  return query.replace(/《[^》]*》/g, " ");
}

/**
 * A slash command is a structured choice: `/meta-analysis 把这些试验合并` names
 * the capability the way the shell's picker does, by a syntax that cannot be
 * mistaken for a sentence. It is the only place the text of a request routes by
 * name. An id elsewhere in the text is a word — `peer-review` in a pull-request
 * question, `meta-analysis` in "这篇 meta-analysis 的结论是什么" — and
 * `namedSpecialistIds` hands it to the model as a fact about the request.
 * @param {any} query @param {any} agents
 */
export function routeSlashCommand(query, agents) {
  if (typeof query !== "string" || !Array.isArray(agents)) return null;
  const id = /^\s*\/([a-z][a-z0-9-]{0,63})(?=\s|$)/.exec(query)?.[1];
  const agent = id ? agents.find((candidate) => candidate.id === id) : null;
  return agent ? selection(agent, `command:${agent.id}`) : null;
}

/**
 * Which capability ids appear in the request as words — an input feature for the
 * classifier, not a route. The ids are a closed list, so this is a lookup, not
 * language understanding; what the appearance means (asking for the capability,
 * translating the word, discussing it) is the model's to read.
 * @param {any} query @param {any} agents @returns {string[]}
 */
export function namedSpecialistIds(query, agents) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return [];
  const lowered = withoutTitledWorks(query).toLowerCase();
  return agents.filter((agent) => typeof agent?.id === "string" && lowered.includes(agent.id)).map((agent) => agent.id);
}

/**
 * The one rule that outlives the model's answer: a high-risk medicine named in
 * the pharmacist-maintained list, together with an explicit request for a
 * report, reaches the clinical evidence line whatever the model said or
 * whether it answered at all. A closed vocabulary owned by pharmacists
 * (`clinical-safety-rules.json`), not a reading of the sentence.
 * @param {any} query @param {any} agents
 */
export function routeSafetyMedicine(query, agents) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(agents)) return null;
  if (clinicalRoutingMedicinePattern == null || !clinicalRoutingMedicinePattern.test(query)) return null;
  if (!explicitReportIntent.test(query)) return null;
  const agent = agents.find((candidate) => candidate.id === SAFETY_MEDICINE_AGENT_ID);
  // Short on purpose: the ledger reason is capped at 64 characters and may carry a `:classifier:<code>` suffix.
  return selection(agent, "matched:safety-medicine");
}

/**
 * The whole open-domain decision, in the order above. One function so the
 * dispatch, an adopted conversation and the composer's preview cannot disagree.
 *
 * It resolves, never throws: a classifier that breaks is recorded in `trace`
 * and the request goes to the ordinary line (principle 19).
 *
 * @param {{
 *   query: string,
 *   agents: any[],
 *   classifier?: { classify: Function } | null,
 *   consultModel?: boolean,
 *   trace?: { failure?: string, verdict?: string },
 *   owner?: { userId: string, projectId: string } | null,
 * }} input
 * @returns {Promise<{ specialist: any, decidedBy: 'named' | 'model' | 'rules' | 'default', modelConsulted: boolean }>}
 */
export async function routeOpenDomain({ query, agents, classifier = null, consultModel = true, trace = {}, owner = null }) {
  const structured = routeSlashCommand(query, agents);
  if (structured) return { specialist: structured, decidedBy: "named", modelConsulted: false };
  const modelConsulted = consultModel && classifier != null;
  if (modelConsulted) {
    let verdict = null;
    try {
      verdict = await classifier.classify(query, agents, trace, owner);
    } catch (error) {
      // The classifier's own contract is to resolve to null and say why in
      // `trace`; this is the case that contract does not cover, and it is named
      // rather than swallowed.
      trace.failure = `error_${error?.code ?? "unknown"}`;
      process.stderr.write(`routing: the classifier threw (${trace.failure})\n`);
    }
    if (verdict) return { specialist: verdict, decidedBy: "model", modelConsulted };
  }
  const medicine = routeSafetyMedicine(query, agents);
  if (!medicine) return { specialist: null, decidedBy: "default", modelConsulted };
  // The medicine rule catching a request is the design working after the model
  // said none; after it never answered, the ledger says so (a timed-out routing
  // and a deliberate none otherwise leave the same record).
  const specialist = trace.failure ? { ...medicine, reason: classifierFailureReason(medicine.reason, trace.failure) } : medicine;
  return { specialist, decidedBy: "rules", modelConsulted };
}
