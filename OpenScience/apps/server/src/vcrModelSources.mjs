/** Source-bound numeric parameters for existing reference simulators, never an inferred fitted model. */
import { createHash } from "node:crypto";
import { validateScenario } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { projectSourceManifestRecord } from "./sourceService.mjs";
const object = (/** @type {any} */ value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const digest = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex");
export const VCR_LITERATURE_PROFILES = Object.freeze([
  { method: "patients.continuous", label: "连续结局参考仿真", endpoint: "continuous", fields: [
    { key: "truth.effect", label: "结局差值", unit: "outcome units", required: true }, { key: "truth.sd", label: "标准差", unit: "outcome units", required: true },
  ] },
  { method: "patients.binary", label: "二分类结局参考仿真", endpoint: "binary", fields: [
    { key: "truth.controlRate", label: "对照组发生率", unit: "proportion", required: true }, { key: "truth.treatmentRate", label: "干预组发生率", unit: "proportion", required: true },
  ] },
  { method: "patients.time_to_event", label: "事件时间参考仿真", endpoint: "time_to_event", fields: [
    { key: "truth.hazardRatio", label: "风险比", unit: "ratio", required: true }, { key: "truth.controlMedian", label: "对照中位时间", unit: "time units", required: true },
  ] },
]);
/** Every candidate is a literal numeric occurrence with its exact quote offsets. Meaning is chosen explicitly, never guessed.
 * @param {string} text @param {string} sha
 */
export function literatureNumericCandidates(text, sha) {
  /** @type {any[]} */ const rows = [];
  const prefix = text.slice(0, 1_000_000);
  const pattern = /(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?!\w|\.\d)/g;
  for (const match of prefix.matchAll(pattern)) {
    const value = Number(match[0]);
    if (!Number.isFinite(value)) continue;
    const start = match.index;
    const end = start + match[0].length;
    const unit = /^\s*(%|mmol\/L|mg\/dL|mg|kg|mmHg|days?|weeks?|months?|years?|天|周|月|年)(?=\s|[.,;:，。；）)]|$)/iu.exec(prefix.slice(end, end + 32))?.[1] ?? "";
    const quoteStart = Math.max(prefix.lastIndexOf("\n", start - 1) + 1, start - 100);
    const nextLine = prefix.indexOf("\n", end);
    const quoteEnd = Math.min(nextLine < 0 ? prefix.length : nextLine, end + 100);
    rows.push({ id: digest(`${sha}:${start}:${end}:${match[0]}`).slice(0, 24), value, unit, literal: match[0],
      start, end, quoteStart, quoteEnd, quote: prefix.slice(quoteStart, quoteEnd) });
    if (rows.length >= 1000) break;
  }
  return rows;
}
/** @param {{sources:any}} dependencies */
export function createVcrModelSources({ sources }) {
  return {
    /** @param {{id:string}} user @param {any} study @param {string} sourceId */
    async preview(user, study, sourceId) {
      const source = await sources.get(String(user.id), sourceId);
      if (source.projectId !== study.projectId || String(source.userId ?? user.id) !== String(user.id)) {
        throw new HttpError(404, "source_not_found", "Source not found in this study project.");
      }
      const capture = await sources.loadCapture(String(user.id), source);
      const [understanding, materials] = await Promise.all([
        sources.getUnderstanding(String(user.id), sourceId).catch(() => null), sources.getMaterials(String(user.id), sourceId).catch(() => null),
      ]);
      const text = String(capture?.input?.text ?? "");
      const textSha256 = capture ? digest(text) : null;
      if (capture && source.payload?.analysis?.textSha256 !== textSha256) throw new HttpError(409, "source_capture_invalid", "The source capture digest does not agree.");
      return { sourceId: source.id, generation: source.payload.generation, textSha256, title: projectSourceManifestRecord(source).display.title,
        status: source.payload.status, parameters: capture ? literatureNumericCandidates(text, textSha256) : [],
        supportedProfiles: VCR_LITERATURE_PROFILES, understanding: understanding?.current ? { abstract: understanding.current.abstract, claims: understanding.current.claims, methods: understanding.current.methods, slots: understanding.current.slots } : null, materials: materials?.materials ?? null,
        missing: [...(!capture ? ["来源尚未完成解析；可先登记并稍后补充。"] : []), ...(text.length > 1_000_000 ? ["仅列出前一百万字符的数值；未列出的部分尚未建立参数映射。"] : []),
          "来源中的数值不是自动拟合的模型；选择参数含义和单位后才能形成参考仿真配置。", "研究人数需要在所用研究中配置；临床验证尚未建立。"],
      };
    },
    /** Resolve every binding again from trusted bytes. Browser supplied values, quotes and executable flags are ignored.
     * @param {{id:string}} user @param {any} study @param {any} card
     */
    async prepare(user, study, card) {
      const asked = object(card.literatureSource);
      const read = await this.preview(user, study, String(asked.sourceId ?? ""));
      if (asked.generation !== read.generation || asked.textSha256 !== read.textSha256) throw new HttpError(409, "source_changed", "The source changed; read it again before mapping parameters.");
      const profile = VCR_LITERATURE_PROFILES.find(row => row.method === card.executionProfile);
      const byId = new Map(read.parameters.map(row => [row.id, row]));
      /** @type {any[]} */ const bindings = [];
      /** @type {Record<string, any>} */ const truth = {};
      /** @type {string[]} */ const missing = [];
      let timeUnit = null;
      if (!read.textSha256) missing.push("文献尚未形成可读正文，参数说明仍待补充。");
      for (const raw of Array.isArray(card.parameterBindings) ? card.parameterBindings : []) {
        const binding = object(raw);
        const field = profile?.fields.find(row => row.key === binding.field);
        const candidate = byId.get(String(binding.candidateId));
        if (!field || !candidate || bindings.some(row => row.field === field.key)) throw new HttpError(400, "vcr_model_invalid", "A parameter mapping must name one current source occurrence and supported field.");
        const converted = field.unit === "proportion" && candidate.unit === "%" ? candidate.value / 100 : candidate.value;
        const conversion = field.unit === "proportion" && candidate.unit === "%" ? "percent_to_proportion" : "identity";
        truth[field.key.split(".")[1]] = converted;
        if (field.key === "truth.controlMedian") {
          timeUnit = ({ day: "days", days: "days", 天: "days", week: "weeks", weeks: "weeks", 周: "weeks", month: "months", months: "months", 月: "months", year: "years", years: "years", 年: "years" })[candidate.unit.toLowerCase()] ?? null;
          if (!timeUnit) missing.push("对照中位时间的单位尚未在来源中声明。");
        }
        bindings.push({ field: field.key, candidateId: candidate.id, sourceId: read.sourceId, generation: read.generation, textSha256: read.textSha256,
          ...candidate, mappedValue: converted, conversion });
      }
      for (const field of profile?.fields ?? []) if (!bindings.some(row => row.field === field.key)) missing.push(`尚未映射${field.label}。`);
      const scenario = profile ? { endpoint: { type: profile.endpoint }, truth, ...(timeUnit ? { timeUnit } : {}) } : null;
      if (profile && scenario) {
        // Validate the source parameters against the existing method contract;
        // no placeholder design is persisted or executed.
        for (const issue of validateScenario(profile.method, { ...scenario, design: { nTreat: 1, nControl: 1 } })) {
          const field = profile.fields.find(row => issue.field.endsWith(row.key));
          missing.push(`${field?.label ?? "来源参数"}的值或单位不符合参考仿真的要求。`);
        }
      }
      if (!profile) missing.push("尚未选择已支持的参考仿真形式；外部模型方程与可调用集成尚未提供。");
      return { literatureSource: { sourceId: read.sourceId, generation: read.generation, textSha256: read.textSha256, projectId: study.projectId, title: read.title },
        parameterBindings: bindings, ...(profile ? { interfaceShape: "baseline_to_outcome" } : {}), executionProfile: profile?.method ?? null,
        executionSpec: profile && !missing.length ? { method: profile.method, scenario, sourceParameters: bindings.map(row => ({ field: row.field, value: row.mappedValue })) } : null,
        specificationMissing: missing, registrationState: profile && !missing.length ? "parameterized_reference" : "incomplete_specification",
        type: "literature_parameterized_reference", knownLimits: ["来源参数仅用于已有统计参考仿真；没有由这些数值推断模型方程、个体预测能力或临床验证。"],
        inputs: ["研究设计人数", ...bindings.map(row => `${row.field}（${row.unit || "来源未声明单位"}）`)], outputs: "标明假设和来源的参考情景结局分布；不是个体临床预测。",
      };
    },
  };
}
