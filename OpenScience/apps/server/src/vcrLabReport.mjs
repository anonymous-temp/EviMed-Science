/**
 * The virtual lab in the exported package (round 2, R14): the 「虚拟实验室」 section of the Word and PDF document.
 *
 * The report model carries `lab` (`VcrExperiments.reportBlock`: every comparison and every design search of the study with its premises
 * and each result beside the design it was computed for), and the export used to print none of it: its templates were the run's words,
 * the visit schedule and the regulatory contacts. This module is the platform's own section, written like those two: structure and
 * words from the frozen block, and **every number a reference into it** (`{{n:labDoc[i]…}}`, rendered by `renderVcrNumbers` against the
 * same frozen model, so a number the page shows and a number the document prints are the one value and a template can never carry a typed one).
 * The settings of a candidate design are numbers of the block too, so they are references like the rest.
 *
 * Hidden knowledge:
 *
 * - **Reference paths cannot address a key with a dot in it.** A candidate's design is `{ "design.nTreat": 100 }`; the render root
 *   (`labDocumentRoot`) re-keys it into a list of `{ label, value }` rows, with a Chinese label (`SETTING_LABELS_ZH`; an unlisted path
 *   reads 「设置项」, never the path), and the section references the list.
 * - **The root is derived, not stored.** `labDocumentRoot(lab)` is a pure function of the frozen block, so a document and its frozen
 *   model can never disagree and nothing is added to what an export freezes.
 * - **A premise's value is the block's own sentence** (code-written from the frozen data, as the page shows it) and is printed after the
 *   numbers are rendered: it is a rendered sentence, not template text, so the typed-number scan does not read it.
 *
 * @module vcrLabReport
 */

import { renderVcrNumbers } from "./vcrRender.mjs";
import { MEASURE_META } from "./vcrViewsKit.mjs";

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** A cell of a markdown table: no pipe, no line break. @param {unknown} value */
const cellText = (value) => String(value ?? "").replace(/\|/g, "／").replace(/\s*\n\s*/g, " ").trim();

/** What a searched setting is called. Closed; a path not here reads 「设置项」, never the path itself. */
const SETTING_LABELS_ZH = Object.freeze({
  "design.nTreat": "试验组人数", "design.nControl": "对照组人数", "design.n": "样本量", "design.allocation": "试验组比例",
  "analysis.alpha": "检验水准", "analysis.sided": "单双侧", "accrual.duration": "入组时长", "accrual.followup": "随访时长",
  "accrual.dropoutAnnual": "每年脱落率", "accrual.rate": "入组速度", "truth.effect": "真实效应", "truth.hazardRatio": "风险比",
});
const OPS_ZH = Object.freeze({ ">=": "不低于", "<=": "不高于", ">": "高于", "<": "低于" });

/** The number a measure value carries, as a reference's format asks for it. @param {Record<string, any>} measure */
const formatOf = (measure) => (measure.unit === "%" ? "pct1" : Number.isInteger(measure.value) ? "int" : "f2");

/** A measure's own number and its simulation error beside it. @param {string} path @param {unknown} value */
function numberText(path, value) {
  const measure = object(value);
  if (!Number.isFinite(measure.value)) return "未计算";
  const format = formatOf(measure);
  const error = Number.isFinite(measure.mcse) && measure.mcse > 0 ? `（模拟误差 ±{{n:${path}.mcse|${format}}}）` : "";
  return `{{n:${path}.value|${format}}}${error}`;
}

/**
 * The block as the section renders from: the same entries with their numbers where a reference path can reach them (a dotted design key is
 * a list of labelled rows; a constraint's bound carries the unit its measure is shown in). Pure over the frozen `lab`.
 * @param {readonly Record<string, any>[]} lab
 * @returns {Array<Record<string, any>>}
 */
export function labDocumentRoot(lab) {
  const settings = (/** @type {unknown} */ design) => Object.entries(object(design)).map(([path, value]) => ({ label: /** @type {Record<string, string>} */ (SETTING_LABELS_ZH)[path] ?? "设置项", value: { value } }));
  const bound = (/** @type {Record<string, any>} */ constraint) => {
    const percent = MEASURE_META[String(constraint.measure)]?.percent === true;
    return { value: percent && Number.isFinite(constraint.bound) ? constraint.bound * 100 : constraint.bound, unit: percent ? "%" : null };
  };
  return list(lab).map((entry) => {
    const row = object(entry);
    if (row.kind === "campaign") {
      return { ...row, finalists: list(row.finalists).map((finalist) => ({ ...object(finalist), settings: settings(object(finalist).design),
        constraints: list(object(finalist).constraints).map((constraint) => ({ ...object(constraint), opText: /** @type {Record<string, string>} */ (OPS_ZH)[String(object(constraint).op)] ?? "", boundValue: bound(object(constraint)) })) })),
        bestSettings: row.best ? settings(object(row.best).design) : [],
        constraints: list(row.constraints).map((constraint) => ({ ...object(constraint), opText: /** @type {Record<string, string>} */ (OPS_ZH)[String(object(constraint).op)] ?? "", boundValue: bound(object(constraint)) })) };
    }
    return row;
  });
}

/**
 * The section's template: Chinese structure and every number as a reference into `labDoc`. Nothing here is typed.
 * @param {ReadonlyArray<Record<string, any>>} root `labDocumentRoot(lab)`
 * @returns {{ template: string, premises: string[][], slots: string[] }} the template, each entry's premises (sentences, printed after the render) and the words the slots stand for
 */
export function labSectionTemplate(root) {
  /** @type {string[]} */
  const out = ["## 虚拟实验室", ""];
  /** @type {string[][]} */
  const premises = [];
  /** @type {string[]} */
  const slots = [];
  // The block's own words (a question, an arm's name, a sentence of the page) go through the renderer as slots and are put back after it:
  // the renderer replaces every number a template types with 「未计算」, and a number inside a researcher's words is not the section's to blank.
  const cell = (/** @type {unknown} */ value) => `{{TEXT_${slots.push(cellText(value)) - 1}}}`;
  root.forEach((entry, i) => {
    const at = `labDoc[${i}]`;
    if (entry.kind === "campaign") {
      out.push(`### 设计搜索：${cell(entry.question) || "未写明问题"}`, "");
      if (entry.stop?.text) out.push(cell(entry.stop.text), "");
      const goal = object(entry.objective);
      out.push(`目标：${goal.direction === "minimize" ? "尽量减少" : "尽量提高"}${cell(goal.label)}。约束：${list(entry.constraints).map((constraint, c) =>
        `${cell(constraint.label)}${constraint.opText}{{n:${at}.constraints[${c}].boundValue.value|${constraint.boundValue.unit === "%" ? "pct1" : "f2"}}}`).join("；") || "没有"}。`, "");
      if (entry.best) {
        out.push(`最优设计：${list(entry.bestSettings).map((setting, s) => `${cell(setting.label)} {{n:${at}.bestSettings[${s}].value.value|${Number.isInteger(setting.value.value) ? "int" : "f3"}}}`).join("，")}；${cell(goal.label)} ${numberText(`${at}.best.objective`, entry.best.objective)}。`, "");
      } else if (entry.undecided) out.push(`没有设计同时满足全部约束；${cell(entry.undecided.advice)}`, "");
      if (list(entry.finalists).length) {
        out.push(`| 候选 | 设置 | ${cell(goal.label)} | 约束 |`, "|---|---|---|---|");
        entry.finalists.forEach((finalist, f) => {
          const base = `${at}.finalists[${f}]`;
          const set = list(finalist.settings).map((setting, s) => `${cell(setting.label)} {{n:${base}.settings[${s}].value.value|${Number.isInteger(setting.value.value) ? "int" : "f3"}}}`).join("，");
          const checks = list(finalist.constraints).map((constraint) => `${cell(constraint.label)}：${cell(object(constraint.final).statusText) || "未评估"}`).join("；");
          out.push(`| {{n:${base}.index|int}} | ${set} | ${numberText(`${base}.objective`, finalist.objective)} | ${checks} |`);
        });
        out.push("");
      }
    } else {
      out.push(`### 方案比较：${cell(entry.question) || "未写明问题"}`, "");
      const arms = list(entry.arms);
      if (list(entry.comparison).length && arms.length) {
        out.push(`| 指标 | ${arms.map((arm) => cell(arm.name)).join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
        entry.comparison.forEach((row, r) => {
          out.push(`| ${cell(row.label)} | ${list(row.arms).map((armCell, a) => (armCell.value ? numberText(`${at}.comparison[${r}].arms[${a}].value`, armCell.value) : "未计算")).join(" | ")} |`);
        });
        out.push("");
        entry.comparison.forEach((row, r) => list(row.contrasts).forEach((contrast, c) => {
          out.push(`- ${cell(row.label)}：${cell(contrast.arm)}相对${cell(contrast.against)}，${contrast.difference ? `差值 ${numberText(`${at}.comparison[${r}].contrasts[${c}].difference`, contrast.difference)}` : "没有可比的差值"}${contrast.couplingText ? `；${cell(contrast.couplingText)}` : ""}`);
        }));
        out.push("");
      }
      const courses = arms.filter((arm) => list(arm.trajectory).length);
      if (courses.length) {
        out.push(`| 随访时间点 | ${courses.map((arm) => `${cell(arm.name)}（治疗组均值）`).join(" | ")} |`, `|---|${courses.map(() => "---").join("|")}|`);
        const visits = list(courses[0].trajectory).map((point) => point.visit);
        visits.forEach((_visit, v) => {
          const cells = courses.map((arm) => `{{n:${at}.arms[${arms.indexOf(arm)}].trajectory[${v}].treated|f1}}`);
          out.push(`| {{n:${at}.arms[${arms.indexOf(courses[0])}].trajectory[${v}].visit|int}} | ${cells.join(" | ")} |`);
        });
        out.push("");
      }
    }
    premises.push(list(entry.premises).map((premise) => `${cellText(object(premise).label)}：${cellText(object(premise).value)}`));
    out.push(`{{LAB_PREMISES_${i}}}`, "");
  });
  return { template: out.join("\n"), premises, slots };
}

/**
 * The section as markdown for a frozen report model, or null when the study has no lab work. Numbers are rendered from the model's own
 * `lab` block; `issues` are the renderer's (a reference that did not resolve reads 「未计算」 and is named, never a number made up).
 * @param {Record<string, any>} model the frozen report model (`cover.results`)
 * @returns {{ markdown: string, issues: Array<Record<string, any>> } | null}
 */
export function renderLabSection(model) {
  const lab = list(model?.lab);
  if (!lab.length) return null;
  const root = labDocumentRoot(lab);
  const { template, premises, slots } = labSectionTemplate(root);
  const rendered = renderVcrNumbers(template, { ...model, labDoc: root });
  const withPremises = premises.reduce((text, lines, i) => text.replace(`{{LAB_PREMISES_${i}}}`, lines.length ? `这些结论的前提：\n\n${lines.map((line) => `- ${line}`).join("\n")}` : ""), rendered.text);
  const markdown = withPremises.replace(/\{\{TEXT_(\d+)\}\}/g, (_match, index) => slots[Number(index)] ?? "");
  return { markdown, issues: rendered.issues };
}
