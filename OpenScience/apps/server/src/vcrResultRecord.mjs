/**
 * One result as a short record (remediation plan D7, 2026-11-01): what it assumed, the seed and the versions it ran under, the one
 * example trial of a simulation, and where to find it. Written by the platform from the result itself, never by a model: every number
 * is the stored one, so the record can be checked against the page it came from, and nobody types a figure into it.
 *
 * Hidden knowledge:
 *
 * - **On request only.** Nothing builds a record by itself and no review, gate or report waits for one; it is an export a person (or
 *   the assistant for them) asks for, kept beside the study's other exports and converted by the same document service.
 * - **Assumptions are the frozen scenario, leaf by leaf, with the platform's defaults marked.** The scenario is what the engine ran;
 *   a leaf the researcher never wrote (a dropout of 0, an alpha of 0.025) is listed with 「默认」 where the job recorded it as an
 *   applied default (`checkpoint.appliedDefaults`). A long scenario is cut at a fixed number of lines and says how many it left out.
 * - **The example trial is the engine's.** A simulation of 1.3.0 states its first replicate (`diagnostics.exampleTrial`: the run's
 *   seed always gives the same trial); a result that is not a simulation says it has none. Nothing is re-simulated here.
 * - **Links back are the application's own addresses** (`vcrResultEntry`): the tab that holds the result, absolute when the
 *   deployment knows its public address.
 *
 * @module vcrResultRecord
 */

import { createHash } from "node:crypto";
import { VCR_CONCLUSION_LABELS_ZH, VCR_TAB_LABELS_ZH } from "@evimed/domain";
import { vcrResultAddress, vcrResultTab } from "./vcrResultEntry.mjs";
import { METHOD_LABELS } from "./vcrViewsKit.mjs";

const object = (/** @type {unknown} */ value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);

/** The most scenario lines a record lists before it says how many it left out. */
export const VCR_RECORD_MAX_ASSUMPTIONS = 40;

/** What the engine's example trial calls its values, in the reader's words, in the order a reader looks. */
const EXAMPLE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  estimate: "估计值", se: "标准误", statistic: "检验统计量", p: "P 值", reject: "是否拒绝零假设（1 是，0 否）",
  events: "事件数", sampleSize: "样本量", duration: "试验持续时间", look: "停在第几次期中分析",
}));

/**
 * The leaves of a scenario as `path = value` lines, the order the scenario states them, with the engine's applied defaults marked.
 * @param {unknown} scenario @param {ReadonlyArray<{ path?: unknown }>} applied
 * @returns {string[]}
 */
export function scenarioLines(scenario, applied = []) {
  const defaults = new Set(applied.map((entry) => String(object(entry).path)));
  /** @type {string[]} */
  const lines = [];
  /** @param {unknown} value @param {string} path */
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      if (value.every((item) => item === null || typeof item !== "object")) lines.push(`${path} = [${value.map(leaf).join(", ")}]`);
      else value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
    } else if (path) lines.push(`${path} = ${leaf(value)}${defaults.has(path) ? "（默认）" : ""}`);
  };
  walk(scenario, "");
  // a default the scenario did not state is listed too: it is part of what ran
  for (const path of defaults) {
    if (!lines.some((line) => line.startsWith(`${path} = `))) {
      const found = applied.find((entry) => String(object(entry).path) === path);
      lines.push(`${path} = ${leaf(object(found).value)}（默认）`);
    }
  }
  return lines;
}

/** @param {unknown} value */
function leaf(value) {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  return String(value);
}

/**
 * @param {{
 *   study: { id: string, name?: string | null },
 *   result: Record<string, any>,
 *   execution: Record<string, any> | null,
 *   scenario?: unknown,
 *   checkpoint?: Record<string, any> | null,
 *   publicUrl?: unknown,
 * }} input
 * @returns {{ title: string, markdown: string, sections: Array<{ id: string, title: string, lines: string[] }>, digest: string, hasExampleTrial: boolean }}
 */
export function buildResultRecord({ study, result, execution, scenario = null, checkpoint = null, publicUrl = null }) {
  const diagnostics = object(result.diagnostics);
  const env = object(execution?.environment);
  const plan = object(object(checkpoint).replicatePlan);
  const applied = list(object(checkpoint).appliedDefaults);
  const method = String(execution?.method ?? "");
  const methodWord = (/** @type {Record<string, string>} */ (METHOD_LABELS))[method] ?? method;
  const conclusion = (/** @type {Record<string, string>} */ (VCR_CONCLUSION_LABELS_ZH))[String(result.conclusion)] ?? null;
  const tab = vcrResultTab(String(result.kind));
  const tabWord = (/** @type {Record<string, string>} */ (VCR_TAB_LABELS_ZH))[tab] ?? tab;
  const studyName = String(study.name ?? "").trim() || "研究";

  /** @type {Array<{ id: string, title: string, lines: string[] }>} */
  const sections = [];
  sections.push({ id: "what", title: "这是什么", lines: [
    `- 研究：${studyName}`,
    `- 结果：${result.kind}，第 ${Number(result.version ?? 1)} 版${conclusion ? `，${conclusion}` : ""}`,
    `- 方法：${methodWord}${method && methodWord !== method ? `（${method}）` : ""}${execution?.methodVersion ? ` ${execution.methodVersion}` : ""}`,
    ...(result.createdAt ? [`- 算完于：${String(result.createdAt).slice(0, 19).replace("T", " ")}（UTC）`] : []),
  ] });

  const assumptions = scenarioLines(scenario, applied);
  const shown = assumptions.slice(0, VCR_RECORD_MAX_ASSUMPTIONS);
  const cards = list(execution?.inputs).map(object).filter((entry) => ["assumption", "evidence"].includes(String(entry.kind)) && entry.id).map((entry) => String(entry.id));
  sections.push({ id: "assumptions", title: "假设", lines: [
    ...(shown.length ? shown.map((line) => `- ${line}`) : ["- 这条结果没有记下场景（它不是由场景算出来的）。"]),
    ...(assumptions.length > shown.length ? [`- 还有 ${assumptions.length - shown.length} 项没有列出；完整的场景在这条结果的运行记录里。`] : []),
    ...(cards.length ? [`- 用到的假设卡和证据：${cards.slice(0, 20).join("、")}${cards.length > 20 ? `等 ${cards.length} 项` : ""}`] : []),
  ] });

  const engine = [env.engineVersion ?? env.version, env.rVersion ? `R ${env.rVersion}` : null, env.packageLockHash ? `包锁定 ${String(env.packageLockHash).slice(0, 12)}` : null].filter(Boolean);
  sections.push({ id: "versions", title: "种子和版本", lines: [
    `- 随机种子：${execution?.seed ?? "没有记录"}`,
    ...(execution?.replicates != null ? [`- 重复次数：${Number(execution.replicates).toLocaleString("en-US")}${plan.reason ? `（${String(plan.reason)}）` : ""}`] : []),
    `- 方法版本：${method || "没有记录"}${execution?.methodVersion ? ` ${execution.methodVersion}` : ""}`,
    ...(engine.length ? [`- 计算引擎：${engine.join("，")}`] : []),
    ...(execution?.scenarioHash ? [`- 场景哈希：${String(execution.scenarioHash).slice(0, 16)}`] : []),
    ...(execution?.outputHash ? [`- 输出哈希：${String(execution.outputHash).slice(0, 16)}`] : []),
  ] });

  const example = object(diagnostics.exampleTrial);
  const exampleValues = Object.entries(object(example.values)).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  sections.push({ id: "example", title: "一个示例试验", lines: exampleValues.length
    ? [`第 ${Number(example.replicate ?? 1)} 次重复（种子 ${example.seed ?? execution?.seed ?? "?"}）：同一个种子永远给出同一个试验。`,
      ...Object.keys(EXAMPLE_LABELS).filter((key) => exampleValues.some(([name]) => name === key))
        .map((key) => `- ${EXAMPLE_LABELS[key]}：${exampleValues.find(([name]) => name === key)?.[1]}`)]
    : ["这条结果不是 1.3.0 以上的仿真，没有示例试验。"] });

  const base = vcrResultAddress(publicUrl, study.id, tab);
  const home = vcrResultAddress(publicUrl, study.id, "overview");
  sections.push({ id: "links", title: "回到哪里看", lines: [
    `- 在“${tabWord}”页：${base ?? `/app/virtual-research/${study.id}/${tab}`}`,
    `- 研究总览：${home ?? `/app/virtual-research/${study.id}/overview`}`,
  ] });

  const title = `${studyName} — 结果记录`;
  const markdown = [`# ${title}`, ...sections.map((section) => `## ${section.title}\n\n${section.lines.join("\n")}`)].join("\n\n");
  return { title, markdown, sections, digest: createHash("sha256").update(markdown).digest("hex"), hasExampleTrial: exampleValues.length > 0 };
}
