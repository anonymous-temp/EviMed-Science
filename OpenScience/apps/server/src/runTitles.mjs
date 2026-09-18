/**
 * Automatic run titles (C3, 2026-09-18).
 *
 * A run was listed by its question, and a question is a paragraph: the runs
 * page and the sidebar showed twelve rows starting with the same capability
 * card's naming line, and a researcher could not tell yesterday's aspirin run
 * from today's without opening both (B §4b). One small model call names the
 * run instead — deepseek-flash, the deployment's one model, through the same
 * metered control-plane path as memory extraction (`callModelForControlPlane`),
 * attributed to the run it names.
 *
 * Off the critical path and fail-safe by construction: nothing waits for it,
 * any failure leaves the question-derived title in place (`titleSource:
 * 'question'`), and a researcher's own title is locked against it by the
 * ledger. Language judgement, so a model makes it (principle 1); what the
 * code checks is only the shape of the answer: one line, bounded, non-empty.
 *
 * Deletable when the kernel names its own sessions in a form the control plane
 * can read — the scaffolding here is one prompt and one length check.
 *
 * @module runTitles
 */

import { callModelForControlPlane } from "./modelGateway.mjs";

/** CJK titles are counted in characters; a Latin title may run longer. */
const maxCjkTitle = 24;
const maxLatinTitle = 60;
const cjk = /[㐀-鿿豈-﫿]/;

const titleInstructions = [
  "你为一次医学科研对话起一个简短的标题，供研究者在任务列表里一眼认出它。",
  "标题概括研究对象与问题，例如「阿司匹林一级预防在≥70岁人群的获益」。",
  "使用提问所用的语言：中文标题不超过 20 个字，英文标题不超过 8 个词。",
  "不要书名号、引号、句末标点，不要「关于」「请帮我」之类的套话，不要提到平台、工具或能力名称。",
  "只输出 JSON：{\"title\": \"...\"}。",
].join("");

/**
 * The model's answer, if it is one: `{"title": "…"}` in the content, or in
 * the reasoning text when a reasoning model wrote its answer there.
 * @param {unknown} content @returns {string | null}
 */
function titleFrom(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [raw, ...[...raw.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.title === "string") return parsed.title;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * A model's title, cleaned to the one shape a list can show, or null. Only
 * format is checked here: surrounding quotes and brackets, a trailing full
 * stop, whitespace, length.
 * @param {unknown} value @returns {string | null}
 */
export function cleanRunTitle(value) {
  if (typeof value !== "string") return null;
  let title = [...value].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("")
    .replace(/\s+/g, " ").trim();
  title = title.replace(/^[「『《“"'‘\s]+/, "").replace(/[」』》”"'’。．.!！?？;；,，:：\s]+$/, "");
  if (!title) return null;
  const length = [...title].length;
  if (length > (cjk.test(title) ? maxCjkTitle : maxLatinTitle)) return null;
  return title;
}

export class RunTitler {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof callModelForControlPlane }} [options]
   */
  constructor(config, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane } = {}) {
    this.config = config;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.config?.runTitlesEnabled !== false && this.config?.deepseekProviderEnabled === true
      && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * A title for one question, or null — never a throw. Why it failed goes to
   * stderr once, because a title that silently never arrives looks exactly
   * like a feature that is off.
   * @param {string} question
   * @param {{ userId: string, projectId: string, runId: string }} owner
   * @returns {Promise<string | null>}
   */
  async titleFor(question, { userId, projectId, runId }) {
    if (!this.available || typeof question !== "string" || !question.trim()) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await this.callModel(
        { config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl },
        {
          userId,
          projectId,
          runId,
          signal: controller.signal,
          body: {
            model: this.config.deepseekModel,
            temperature: 0,
            // A title needs no reasoning. Measured on the live API with the
            // aspirin question (2026-09-19): thinking off returned the same
            // title in 17 output tokens and 0.6 s; on, 503 tokens (486 of them
            // reasoning) and 2.3 s. The budget still leaves room for a model
            // that thinks anyway (see specialistClassifier.mjs for what a
            // budget tuned too tight did).
            thinking: { type: "disabled" },
            max_tokens: 2_000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: titleInstructions },
              { role: "user", content: question.slice(0, 2_000) },
            ],
          },
        },
      );
      const message = body?.choices?.[0]?.message;
      const title = cleanRunTitle(titleFrom(message?.content) ?? titleFrom(message?.reasoning_content));
      if (!title) process.stderr.write(`run title produced no usable title for ${runId}\n`);
      return title;
    } catch (error) {
      process.stderr.write(`run title failed for ${runId}: ${error?.name === "AbortError" ? "timeout" : error?.code ?? "error"}\n`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Decides which runs get a title and when, and records it.
 *
 * Called on every ledger state change: a run is titled once, the first time
 * it is seen carrying a question and no title of its own — at dispatch, at
 * adoption, or when a backfill finally reads what it asked. Runs older than
 * `maxAgeMs` keep their question-derived title rather than turning an opened
 * runs page into a burst of model calls.
 */
export class RunTitleScheduler {
  /**
   * @param {{ titler: RunTitler, recordTitle: (project: any, runId: string, title: string) => Promise<unknown>,
   *           maxAgeMs?: number, now?: () => number }} options
   */
  constructor({ titler, recordTitle, maxAgeMs = 7 * 86_400_000, now = () => Date.now() }) {
    this.titler = titler;
    this.recordTitle = recordTitle;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    /** Runs already tried, oldest first. @type {Set<string>} */
    this.attempted = new Set();
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
  }

  /** @param {any} project @param {Record<string, any>} run */
  consider(project, run) {
    if (!this.titler.available || !run?.id || run.titleSource !== "question" || !run.question) return;
    if (this.attempted.has(run.id)) return;
    const created = Date.parse(run.createdAt ?? run.startedAt ?? "");
    if (!Number.isFinite(created) || this.now() - created > this.maxAgeMs) return;
    this.attempted.add(run.id);
    if (this.attempted.size > 5_000) this.attempted.delete(this.attempted.values().next().value);
    const work = (async () => {
      const title = await this.titler.titleFor(run.question, { userId: project.userId, projectId: project.id, runId: run.id });
      if (title) await this.recordTitle(project, run.id, title);
    })().catch(() => {
      // isolated: evimed_run_title_record_failures_total — the question-derived
      // title stays, which is the fail-safe this whole feature promises.
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Every title still being made, for shutdown and tests. */
  async settle() {
    await Promise.allSettled([...this.pending]);
  }
}
