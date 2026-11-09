/**
 * What a reader makes of the research question (round-2 plan R22): the card the page draws, the answer of a read, and the rows it
 * adds to the one 「这个结论的前提」 block of a result.
 *
 * Hidden knowledge:
 *
 * - **A field nobody wrote is listed as a gap, and a gap is not a defect.** The agent reads the list to ask for one field at a time;
 *   the page shows it as a line to fill in. Nothing computes differently, refuses or waits because of it.
 * - **The premises say only what is known.** A result is marked as answering an earlier version only when the job recorded a
 *   `questionRef`; an event the simulation cannot represent is stated in the event's own words with 「这个模拟表示不了」, and the
 *   result is not marked as having handled it; a question with no events says what the default handling is. A study with no question
 *   adds no row at all: there is nothing to say about a question nobody asked.
 * - **Pure.** Nothing is read here; the caller hands over the question as it stands and the job's reference.
 *
 * @module vcrResearchQuestionView
 */

import {
  VCR_QUESTION_MODEL_CAPABILITIES, VCR_QUESTION_FIELDS, VCR_QUESTION_FIELD_LABELS_ZH, VCR_QUESTION_STRATEGY_LABELS_ZH, questionAnswersEarlier,
  questionCalibration, questionRepresentability,
} from "@evimed/domain";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * The model the study's question is judged against: the one its treatment names when that model has a capability row, else the Alzheimer parameter set
 * when the study holds a simulation on it, else none (and then no event is judged). The page and a read ask the same way (round-2 review P1-5).
 * @param {{ fields?: Record<string, any> } | null | undefined} question @param {unknown} progressionResults the study's current progression simulations
 * @returns {string | null}
 */
export function questionModelId(question, progressionResults) {
  const named = object(object(question?.fields?.treatment).interventionModel).id;
  if (typeof named === "string" && named !== "default" && Object.hasOwn(VCR_QUESTION_MODEL_CAPABILITIES, named)) return named;
  const onAlzheimer = (Array.isArray(progressionResults) ? progressionResults : []).map(object).some((result) => result.kind === "progression_simulation" && !result.supersededBy
    && object(object(object(result.diagnostics).progression)).family === "beta_logit");
  return onAlzheimer ? "camd-adas-cog-11" : null;
}

/** The state of an event as the card says it. */
const STATE_ZH = Object.freeze({
  representable: "这个模拟可以表示", not_representable: "这个模拟表示不了", strategy_not_stated: "还没有写处理方式", not_judged: null,
});

/**
 * The attributes of the question that fix which effect is estimated (ICH E9(R1): treatment, population, variable, intercurrent events, summary). A result
 * that answered an earlier version is marked as needing a recompute only when one of them was written since; the question's words, the decision it serves
 * and the sources of its assumptions change no estimand.
 */
const ESTIMAND_FIELDS = Object.freeze(["population", "treatment", "variable", "intercurrentEvents", "summary"]);

/**
 * One question as the page and a read present it.
 * @param {ReturnType<typeof import("./vcrResearchQuestions.mjs").questionFromRow>} question
 * @param {{ modelId?: string | null }} [options] the model the events are judged against. With none, whether an event can be represented is not judged at
 *   all (no model, nothing to judge it against): the card shows the event and its strategy and no tag, never a warning from a table of another model.
 */
export function presentResearchQuestion(question, { modelId = null } = {}) {
  if (!question) return null;
  const events = questionRepresentability(question, modelId).map((entry) => (modelId || entry.state === "strategy_not_stated" ? entry : { ...entry, state: /** @type {const} */ ("not_judged") }));
  const calibration = questionCalibration(question, modelId);
  const gaps = VCR_QUESTION_FIELDS.filter((field) => question.fields[field] == null).map((field) => ({ field, label: VCR_QUESTION_FIELD_LABELS_ZH[field] }));
  return {
    id: question.id, version: question.version, fields: question.fields,
    // who wrote a field decides which write wins and is the model's to read; the person is never shown it (owner ruling 2026-10-10)
    bases: question.bases,
    gaps,
    events: events.map((entry, at) => ({
      ...entry, mechanism: String(object(question.fields.intercurrentEvents?.[at]).mechanism ?? ""),
      strategyLabel: entry.strategy ? /** @type {Record<string, string>} */ (VCR_QUESTION_STRATEGY_LABELS_ZH)[entry.strategy] ?? null : null,
      stateLabel: STATE_ZH[entry.state],
    })),
    calibration: calibration ? { sentence: calibration.sentence, differs: calibration.differs } : null,
    createdAt: question.createdAt,
  };
}

/**
 * The rows a result's premises block takes from the question. `ref` is the question the job recorded it answered.
 * @param {{ question?: ReturnType<typeof import("./vcrResearchQuestions.mjs").questionFromRow> | null, ref?: { id?: string, version?: number } | null,
 *   modelId?: string | null } | null | undefined} input
 * @returns {Array<{ key: string, label: string, value: string, source: "default" | "assumed", decisive: boolean }>}
 */
export function researchQuestionPremises(input) {
  const question = input?.question ?? null;
  if (!question) return [];
  /** @type {Array<{ key: string, label: string, value: string, source: "default" | "assumed", decisive: boolean }>} */
  const rows = [];
  const earlier = questionAnswersEarlier(input?.ref, { id: question.id, version: question.version });
  if (earlier) {
    // decisive only when what changed since the answered version bears on the estimand; the history says what each version wrote (unknown: decisive)
    const history = Array.isArray(/** @type {any} */ (question).history) ? /** @type {Array<{ version: number, written: string[] }>} */ (/** @type {any} */ (question).history) : null;
    const changed = history === null || history.filter((entry) => entry.version > earlier.answeredVersion && entry.version <= earlier.currentVersion).some((entry) => entry.written.some((field) => ESTIMAND_FIELDS.includes(field)));
    rows.push({ key: "question:earlier", label: "回答的研究问题", decisive: changed, source: "default",
      value: `这个结果回答的是研究问题的第 ${earlier.answeredVersion} 版；问题已经改到第 ${earlier.currentVersion} 版${changed ? "，改动涉及要估计的效应，需要时重新计算" : "，改动不影响这个结果要回答的效应"}。` });
  }
  // Without a model the events are not judged: a table for another model would call a strategy unrepresentable on a calculation that has no events to
  // represent, and say a default handling holds for a result that has none (round-2 review P1-4, P2-18).
  const modelId = input?.modelId ?? null;
  const events = modelId ? questionRepresentability(question, modelId) : [];
  const cannot = events.filter((entry) => entry.state === "not_representable");
  if (cannot.length) {
    rows.push({ key: "question:not_representable", label: "模拟表示不了的情况", decisive: true, source: "default",
      value: `${cannot.map((entry) => `“${entry.event}”按“${/** @type {Record<string, string>} */ (VCR_QUESTION_STRATEGY_LABELS_ZH)[String(entry.strategy)]}”处理`).join("；")}，这个模拟表示不了；这个结果没有按这种处理方式算。` });
  }
  const calibration = modelId ? questionCalibration(question, modelId) : null;
  if (calibration?.differs) {
    rows.push({ key: "question:calibration", label: "模型数据对应的问题", decisive: false, source: "assumed",
      value: `${calibration.sentence}；你要回答的问题对中途事件采用的处理方式与此不同。` });
  }
  if (modelId && !events.length) {
    rows.push({ key: "question:events_unstated", label: "中途事件的处理", decisive: false, source: "default",
      value: "研究问题里没有写停药、换药等中途事件怎么处理，模拟按模型自己的默认处理（缺失的数据按随机缺失算，不区分原因）。" });
  }
  return rows;
}

/**
 * What a result's premises need of the question: the study's question as it stands and the one this result's job recorded it answered.
 * The job is found through the result's execution; a result with neither (or a study with no question) adds nothing.
 * @param {{ researchQuestion?: unknown, executions?: { get?: (id: string) => any } | null, jobs?: unknown } | null | undefined} bundle
 * @param {{ executionId?: string | null } | null | undefined} result @param {string | null} [modelId]
 */
export function resultQuestionInput(bundle, result, modelId = null) {
  const execution = result?.executionId ? bundle?.executions?.get?.(String(result.executionId)) : null;
  const jobs = Array.isArray(bundle?.jobs) ? bundle.jobs : [];
  const job = execution?.jobId ? jobs.map(object).find((entry) => entry.id === execution.jobId) : null;
  return { question: /** @type {any} */ (bundle?.researchQuestion ?? null), ref: /** @type {any} */ (object(object(job).checkpoint).questionRef ?? null), modelId };
}
