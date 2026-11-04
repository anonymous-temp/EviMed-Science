/**
 * A second, independent reading of the passage a number was read from (algorithm round E1, 2026-11-03).
 *
 * The first reading of a literature parameter is the run's: it reads the paper in its own turn and writes the value, the interval, the
 * sample size and the sentence it found them in. The platform checks that the sentence is in the preserved text and that every number is in
 * the sentence; it cannot check that the run read the right number out of a table row that holds six. Reading is language, so a model does
 * it, and comparing two readings is arithmetic, so code does that: one more model call (Flash, through the control plane's model client under
 * the purpose `vcr`) is given the same passage and told only what to look for, not what the first reading found, and the two answers are
 * compared number by number. The mechanism is EviSearch's (several agents read, a validator compares, the disagreeing cells are the ones a
 * person should look at first); its code is not used. An agreement says nothing; a disagreement is a warning with both numbers and the
 * quotation. No study measured the gain on this kind of extraction (the survey's own words), so the rate of agreement and of disagreement is
 * counted and an eval, not this file, is what says whether it earns its cost.
 *
 * Hidden knowledge:
 *
 * - **Blind means blind to the answer, not to the question.** The second reader is told the quantity, the arm and the endpoint the first
 *   reading named (what is being looked for), and is never shown the first reading's value, interval, counts or quotation. It reads a window
 *   of the preserved text around the quotation (`SECOND_READ_WINDOW_CHARS` either side), which is the same passage and a little more.
 * - **Code re-verifies what it can.** A number the second reader returns that is not in the passage was not read from it and is dropped
 *   before the comparison (principle 5: the model reads, code verifies the checkable part, a failed verdict is dropped and not softened).
 *   A field only one reading carries cannot disagree. Two numbers agree when they are the same number, or the same share written as a
 *   fraction and as a percentage; nothing is rounded to make them agree and nothing to make them differ.
 * - **It never decides.** The first value stands, whatever the second says (owner rulings 2026-09-17, 2026-10-10). A disagreement is a note
 *   in the answer of the card's write and a warning mark on the card. A read that fails, times out, is cut off or cannot find the quotation in
 *   the preserved text says nothing and changes nothing: it is counted, not stored.
 * - **Only text the platform preserved, and not necessarily public.** The text is what the platform preserved of a source the item cites: a
 *   publication or a registry record it read, or any other source of the project, a private upload included (`literature.text`,
 *   `vcrEvidenceSources.mjs`). A patient record never comes this way (those go through the matching reader and the study's cloud basis).
 *   Sending it adds no recipient: the run that wrote the item read the same text through the same model provider (owner ruling 2026-10-10),
 *   and this is the same reading again, blind to the first. (A comment here said "the text is public"; it is not always, and nothing narrows
 *   what is read because of that.)
 * - **Bounded.** One call per stored value, at most `CONCURRENCY` at a time, each stopped after the deployment's timeout; the write of the
 *   value does not wait for it, and the write of a card waits for the reads of the values it cites for at most `SECOND_READ_CARD_WAIT_MS`.
 *
 * @module vcrEvidenceSecondRead
 */

import { callModelForControlPlane } from "./modelGateway.mjs";
import { numberIsInQuote } from "./vcrEvidence.mjs";
import { PARAMETER_LABELS } from "./vcrViewsKit.mjs";

/** The numbers of an item that a second reading is compared on. */
export const SECOND_READ_FIELDS = Object.freeze(["value", "ciLow", "ciHigh", "sampleSize", "events"]);
/** How much of the preserved text is read either side of the quotation, and the most characters one call is given. */
export const SECOND_READ_WINDOW_CHARS = 1500;
export const SECOND_READ_PASSAGE_MAX = 6000;
/** How many second readings run at once in one process. */
const CONCURRENCY = 3;

const FIELD_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ ciLow: "区间下限", ciHigh: "区间上限", sampleSize: "样本量", events: "事件数" }));

const INSTRUCTIONS = [
  "你从一段论文或登记记录的原文里读一个数。只输出 JSON：{\"found\":true或false,\"value\":数或null,\"ciLow\":数或null,\"ciHigh\":数或null,\"sampleSize\":整数或null,\"events\":整数或null}。",
  "规则：",
  "1. 只读原文里印着的数，照印出来的写：不换算、不取整、不自己算。",
  "2. 问的是哪一组、哪一个结局的数，原文里找不到对应的就把 found 写 false，其余写 null。",
  "3. ciLow、ciHigh 只在原文把它们印成这个数的置信区间的两端时才填；sampleSize 是这个数是在多少人身上得到的，events 是其中发生事件的人数，原文没印就写 null。",
].join("\n");

/** @param {unknown} value @returns {number | null} */
function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {number} value */
const show = (value) => String(Number(value.toPrecision(8)));

/**
 * The window of the preserved text a quotation stands in: `null` when the quotation cannot be located (the platform's lenient comparison
 * found it, but not at a place this can point to), and the read is skipped.
 * @param {string} sourceText @param {string} quote
 * @returns {{ text: string, start: number, end: number } | null}
 */
export function secondReadPassage(sourceText, quote) {
  const source = String(sourceText ?? "");
  const segments = String(quote ?? "").split(/…|\.\.\./).map((part) => part.trim()).filter(Boolean);
  if (!source || !segments.length) return null;
  let at = source.indexOf(segments[0]);
  let length = segments[0].length;
  if (at < 0) {
    // The same words with the whitespace the platform's comparison ignores.
    const flexible = new RegExp(segments[0].split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
    const found = flexible.exec(source);
    if (!found) return null;
    at = found.index;
    length = found[0].length;
  }
  let start = Math.max(0, at - SECOND_READ_WINDOW_CHARS);
  let end = Math.min(source.length, at + length + SECOND_READ_WINDOW_CHARS);
  // A long quotation keeps its head: the window is cut on the sides before it is cut in the middle of what was quoted.
  if (end - start > SECOND_READ_PASSAGE_MAX) {
    start = Math.max(start, at - Math.floor((SECOND_READ_PASSAGE_MAX - Math.min(length, SECOND_READ_PASSAGE_MAX / 2)) / 2));
    end = Math.min(end, start + SECOND_READ_PASSAGE_MAX);
  }
  return { text: source.slice(start, end), start, end };
}

/**
 * Are these two readings of one printed number the same? The same number, or the same share as a fraction and as a percentage.
 * @param {number} a @param {number} b @param {boolean} share the quantity may be written either way
 */
function sameNumber(a, b, share) {
  const close = (/** @type {number} */ x, /** @type {number} */ y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return close(a, b) || (share && (close(a * 100, b) || close(a, b * 100)));
}

/**
 * The two readings, compared field by field.
 * @param {{ first: Record<string, unknown>, second: Record<string, unknown>, unit?: string, passage: string, label?: string, arm?: string | null, quote?: string }} input
 * @returns {{ outcome: "agree" | "differ" | "inconclusive", agreed: string[], differs: Array<{ field: string, first: number, second: number }>, dropped: string[], message: string | null }}
 */
export function compareReadings({ first, second, unit = "", passage, label = "", arm = null, quote = "" }) {
  const share = /%|percent|百分/i.test(String(unit));
  /** @type {string[]} */ const agreed = [];
  /** @type {Array<{ field: string, first: number, second: number }>} */ const differs = [];
  /** @type {string[]} */ const dropped = [];
  for (const field of SECOND_READ_FIELDS) {
    const a = finite(first[field]);
    const b = finite(second[field]);
    // A number only one reading carries cannot disagree with anything.
    if (a === null || b === null) continue;
    // A number that is not in the passage was not read from it.
    if (!numberIsInQuote(passage, b, field === "sampleSize" || field === "events" ? {} : { unit })) { dropped.push(field); continue; }
    if (sameNumber(a, b, share && field !== "sampleSize" && field !== "events")) agreed.push(field);
    else differs.push({ field, first: a, second: b });
  }
  const outcome = differs.length ? "differ" : agreed.length ? "agree" : "inconclusive";
  const parts = differs.map((entry) => `${FIELD_WORDS[entry.field] ?? (label || "数值")} 第一次读到 ${show(entry.first)}，第二次读到 ${show(entry.second)}`);
  const excerpt = String(quote).replace(/\s+/g, " ").trim();
  const message = differs.length
    ? `${label || "这条抽取值"}${arm ? `（${arm}）` : ""}：同一段原文读了两次，结果不一致——${parts.join("；")}。原文：“${excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt}”。已按第一次读到的保存，请回到原文核对是哪一个。`
    : null;
  return { outcome, agreed, differs, dropped, message };
}

/**
 * The second reader: one model call per stored value, compared in code. `check` answers `null` when there was nothing to read (no
 * locatable passage, the model found nothing for the question) and throws when the call failed; the caller counts and says nothing.
 *
 * @param {{ config: Record<string, any>, usageLedger?: any, callModel?: typeof callModelForControlPlane, fetchImpl?: typeof fetch }} deps
 */
export function createSecondReader({ config, usageLedger = null, callModel = callModelForControlPlane, fetchImpl = globalThis.fetch }) {
  const model = String(config.deepseekModel || "deepseek-flash");
  const timeoutMs = Math.max(3_000, Math.min(120_000, Number(config.vcrEvidenceSecondReadTimeoutMs ?? 20_000) || 20_000));
  // Without a key of its own the control plane's client cannot call anything; a test that injects its own client does not need one.
  const enabled = config.vcrEvidenceSecondReadEnabled !== false && (callModel !== callModelForControlPlane || Boolean(config.deepseekApiKey));
  let running = 0;
  /** @type {Array<(value?: unknown) => void>} */
  const waiting = [];
  // A finished call hands its place to the next in line, so the count never passes CONCURRENCY.
  const slot = () => (running < CONCURRENCY ? (running += 1, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };
  return {
    enabled, model, timeoutMs,
    /**
     * @param {{ userId: string, projectId?: string, evidenceId: string, item: Record<string, any>, sourceText: string, signal?: AbortSignal }} input
     */
    async check({ userId, projectId = "", evidenceId, item, sourceText, signal }) {
      if (!enabled) return null;
      const passage = secondReadPassage(sourceText, String(item.quote ?? ""));
      if (!passage) return null;
      const parameter = String(item.parameter ?? "");
      const label = PARAMETER_LABELS[parameter] ?? "";
      const asked = [`要读的数：${label ? `${label}（${parameter}）` : parameter}`,
        item.arm ? `组：${item.arm}${item.armRole && item.armRole !== "unknown" ? `（${item.armRole}）` : ""}` : "",
        item.endpointKey || item.detail?.outcome ? `结局：${[item.endpointKey, item.detail?.outcome].filter(Boolean).join(" / ")}` : ""].filter(Boolean).join("\n");
      await slot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const relay = () => controller.abort();
      signal?.addEventListener("abort", relay, { once: true });
      try {
        const body = await callModel({ config, usageLedger, fetchImpl }, {
          userId, projectId, runId: evidenceId, purpose: "vcr", signal: controller.signal,
          body: {
            model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 200, response_format: { type: "json_object" },
            messages: [{ role: "system", content: INSTRUCTIONS }, { role: "user", content: `${asked}\n\n原文：\n${passage.text}` }],
          },
        });
        const choice = body?.choices?.[0];
        if (choice && Object.hasOwn(choice, "finish_reason") && choice.finish_reason !== "stop") throw Object.assign(new Error("The second reading was cut off."), { code: "second_read_cut_off" });
        let answer;
        try { answer = JSON.parse(String(choice?.message?.content ?? "")); }
        catch { throw Object.assign(new Error("The second reading did not return JSON."), { code: "second_read_unreadable" }); }
        if (!answer || typeof answer !== "object" || answer.found === false) return null;
        const second = Object.fromEntries(SECOND_READ_FIELDS.map((field) => {
          const number = finite(answer[field]);
          return [field, number !== null && (field === "sampleSize" || field === "events") && !Number.isInteger(number) ? null : number];
        }));
        const compared = compareReadings({ first: item, second, unit: String(item.unit ?? ""), passage: passage.text, label, arm: item.arm ?? null, quote: String(item.quote ?? "") });
        return { ...compared, second, model };
      } catch (error) {
        if (/** @type {any} */ (error)?.name === "AbortError") throw Object.assign(new Error("The second reading timed out."), { code: "second_read_timeout" });
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relay);
        release();
      }
    },
  };
}
