/**
 * The kinds of work a conversation can be judged to have been (runTaskType.mjs), which are the axes of the memory map's
 * 「在做什么」 radar. A closed list on purpose: a polygon whose axes moved from one month to the next would mean nothing, and a
 * model's free reading of a task has to be collapsed to something a polygon can stand on. It lives apart from the judge so the
 * run ledger can know the list without importing the code that calls a model.
 *
 * @module taskTypes
 */

/** The kinds of work, in the order the radar draws them. `medical-evidence` is an axis only for an account that has any. */
export const TASK_TYPES = Object.freeze([
  Object.freeze({ id: "writing", label: "写作", meaning: "writing or editing prose: an article, a letter, a summary, a translation, a polish of wording" }),
  Object.freeze({ id: "documents", label: "文档与演示", meaning: "making or reworking a document, a report layout, slides or a presentation, a PDF or a form" }),
  Object.freeze({ id: "data", label: "表格与数据分析", meaning: "spreadsheets, tables, statistics, charts or analysis of a dataset" }),
  Object.freeze({ id: "code", label: "代码", meaning: "writing, reading, debugging or explaining code, scripts, commands or configuration" }),
  Object.freeze({ id: "web-research", label: "查资料与调研", meaning: "finding out about something: looking things up, researching a topic, comparing options, answering a general question" }),
  Object.freeze({ id: "medical-evidence", label: "医学证据", meaning: "medicine, drugs, clinical trials, guidelines, systematic reviews, meta-analysis, pharmacovigilance, clinical research" }),
  Object.freeze({ id: "other", label: "其他", meaning: "anything that is none of the above, or too little to tell" }),
]);

export const TASK_TYPE_IDS = new Set(TASK_TYPES.map((type) => type.id));

/** The radar's word for a kind of work. @param {string} id */
export function taskTypeLabel(id) {
  return TASK_TYPES.find((type) => type.id === id)?.label ?? "其他";
}

/** The kind of work a named capability's category stands for: the product's own catalogue, not a judgement. */
export const TASK_TYPE_OF_CATEGORY = Object.freeze(/** @type {Record<string, string>} */ ({
  药学评价: "medical-evidence", 临床证据: "medical-evidence", 虚拟临床研究: "medical-evidence", 写作与传播: "writing", 研究设计与数据: "data",
}));
