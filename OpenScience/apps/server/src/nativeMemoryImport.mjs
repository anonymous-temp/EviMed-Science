import { randomBytes } from "node:crypto";
import { MEMORY_NEVER_KEPT_TEXT, carriesPlatformContext, identifierShapesIn } from "@evimed/domain";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { recordImport } from "./nativeMemoryMetrics.mjs";
import { compact } from "./nativeMemoryRejections.mjs";
import { lineFingerprint } from "./nativeMemoryOverlay.mjs";
import { HttpError } from "./security.mjs";

/**
 * 「从其他 AI 导入」: what another assistant remembered about the person, brought into this one (owner decision 3 of 2026-10-25).
 *
 * The person pastes what the other assistant listed, the control plane splits it into short first-person statements with ONE Flash call,
 * the person reviews the list, and what they keep goes to the engine as their own statement, so the engine's templates and never-kept
 * rules apply a second time. Four steps and who does what in each:
 *
 *  1. **The model reads** (`offer`): few-shot, thinking off, JSON only, charged as `memory-extraction`. It splits and it names each
 *     statement's sensitivity tier by the platform's own rules — `MEMORY_NEVER_KEPT_TEXT` is handed to it as it stands, not restated: what
 *     is never written even when asked (`never`), what is written only when the person asks in so many words (`on_request`), and the rest
 *     (`ordinary`).
 *  2. **Code checks what code can.** The answer is one JSON shape or it is nothing; each statement names the line of the pasted text it
 *     comes from and shares a span of at least four characters with it (a rewrite out of nowhere is not a statement of this text); a
 *     statement, or the line it comes from, that carries the shape of a credential or an identifier is dropped (`identifierShapesIn`);
 *     machine text (`carriesPlatformContext`) is dropped; duplicates once; fifty at most.
 *  3. **The person decides.** `never` and dropped statements are not offered (only how many were left out, so that one plain line can say
 *     so, and their words are not even kept); `on_request` ones are offered unticked, the rest ticked. The offer waits an hour.
 *  4. **The engine writes** (`save`): one message per ten statements in the form the templates read as an import
 *     (`NativeMemoryStore.rememberImport`: «这是我在另一个 AI 助手里的记忆导出，请把它们导入到这里：…», the ticked sensitive ones apart
 *     as «我明确要求记住下面这几条»), in a session of its own so the drawer reads 「从其他 AI 导入」 beside what it wrote.
 *
 * Limits protect the resource: 8,000 characters of pasted text, at most `config.memoryImportOffersPerHour` offers an hour per account
 * (`OPEN_SCIENCE_MEMORY_IMPORT_OFFERS_PER_HOUR`), a model that does not answer is a refusal by name and not a hang, and a paused account
 * is told so before anything is read (the engine would skip what it was handed).
 *
 * @module nativeMemoryImport
 */

export const IMPORT_MAX_CHARS = 8_000;
export const IMPORT_MAX_STATEMENTS = 50;
const STATEMENT_MAX_CHARS = 300;
const LINE_MAX_CHARS = 1_000;
const SAVE_CHUNK = 10;
export const IMPORT_TIERS = Object.freeze(["never", "on_request", "ordinary"]);

const INSTRUCTIONS = [
  "A person pastes what another AI assistant remembered about them and asks to import it into this assistant. Split the pasted text into short first-person statements the person can confirm one by one: one fact, preference, habit, tool or working convention each, in the language of the pasted text, at most 300 characters.",
  "Say only what the text says: do not add, infer or generalise, do not merge two facts into one statement, and do not write a statement the text does not support. Leave out headings, greetings and anything that is not about the person. A line about another person (a relative, a colleague, a patient) is not a statement about the user.",
  "For every statement give the sensitivity tier by the platform's own rules below: `never` when the rules say it is never written even when the person asks (a secret, an identity number, a criminal or immigration detail, personal data of anyone else, the content of a document); `on_request` when the rules keep it only when the person explicitly asks to remember it (their own health, medication, allergy, religion, politics, ethnicity, sexual orientation, finances, a child's details, a precise home address, biometrics); `ordinary` for everything else.",
  "Return JSON only, in this shape: {\"statements\":[{\"line\":<1-based number of the pasted line it comes from>,\"text\":\"<the statement>\",\"tier\":\"never|on_request|ordinary\"}]}. A statement of a tier `never` is still listed, so that the person can be told some were left out.",
  "Example. Pasted: `1: - 我是心内科医生，主要做房颤的临床研究` `2: - 我对青霉素过敏` `3: - 我的邮箱密码是 hunter2hunter2` `4: - 回答尽量简短` → {\"statements\":[{\"line\":1,\"text\":\"我是心内科医生，主要做房颤的临床研究\",\"tier\":\"ordinary\"},{\"line\":2,\"text\":\"我对青霉素过敏\",\"tier\":\"on_request\"},{\"line\":3,\"text\":\"我有一个邮箱密码\",\"tier\":\"never\"},{\"line\":4,\"text\":\"回答尽量简短\",\"tier\":\"ordinary\"}]}",
  "Example. Pasted: `1: Prefers APA 7 for citations.` `2: Works in Berlin; commutes by bike.` `3: Her sister Anna is a nurse.` → {\"statements\":[{\"line\":1,\"text\":\"I prefer APA 7 for citations\",\"tier\":\"ordinary\"},{\"line\":2,\"text\":\"I work in Berlin and commute by bike\",\"tier\":\"ordinary\"},{\"line\":3,\"text\":\"I have a sister who is a nurse\",\"tier\":\"never\"}]}",
  "The platform's rules for what a memory never holds, which decide the tiers:",
  MEMORY_NEVER_KEPT_TEXT,
].join("\n\n");

/** The pasted text as numbered, non-empty lines (each cut at `LINE_MAX_CHARS`). @param {string} text @returns {string[]} */
export function importLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim().replace(/^(?:[-*•·]|\d+[.)、])\s+/, "").slice(0, LINE_MAX_CHARS)).filter(Boolean);
}

/** The request of the one model call. @param {string} model @param {string[]} lines */
export function importRequestBody(model, lines) {
  return {
    model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 4_000, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: lines.map((line, index) => `${index + 1}: ${line}`).join("\n") },
    ],
  };
}

/**
 * Whether two texts share a span of at least four characters (compared as `compact` forms: no spacing, punctuation or case).
 * @param {string} statement @param {string} line
 */
export function sharesASpan(statement, line) {
  const a = [...compact(statement)];
  const b = compact(line);
  if (a.length < 4) return false;
  for (let index = 0; index + 4 <= a.length; index += 1) if (b.includes(a.slice(index, index + 4).join(""))) return true;
  return false;
}

/**
 * What the model said, as far as it stands: the one JSON shape, each statement traceable to a line of the pasted text, none carrying a
 * credential, an identifier or machine text, no duplicate, at most fifty. The statements of tier `never` and the ones code refused are
 * only counted: nothing of their words is kept.
 * @param {unknown} content the model's message @param {string[]} lines the pasted lines
 * @returns {{ offered: { text: string, tier: "on_request" | "ordinary" }[], leftOut: number } | null} null when it was not the one shape
 */
export function parseImport(content, lines) {
  let value;
  try { value = JSON.parse(String(content ?? "")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.statements)) return null;
  /** @type {{ text: string, tier: "on_request" | "ordinary" }[]} */
  const offered = [];
  const seen = new Set();
  let leftOut = 0;
  for (const item of value.statements) {
    const text = typeof item?.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (!text || [...text].length > STATEMENT_MAX_CHARS || !IMPORT_TIERS.includes(item?.tier)) continue;
    if (item.tier === "never") { leftOut += 1; continue; }
    const named = Number.isInteger(item.line) && item.line >= 1 && item.line <= lines.length ? [lines[item.line - 1]] : [];
    const source = named.find((line) => sharesASpan(text, line)) ?? lines.find((line) => sharesASpan(text, line));
    if (!source) continue;
    // A statement, or the line it was made from, that carries a secret or an identifier is not offered, however the model worded it.
    if (identifierShapesIn(text).length || identifierShapesIn(source).length || carriesPlatformContext(text) || carriesPlatformContext(source)) { leftOut += 1; continue; }
    const print = lineFingerprint(text);
    if (seen.has(print)) continue;
    seen.add(print);
    if (offered.length < IMPORT_MAX_STATEMENTS) offered.push({ text, tier: /** @type {"on_request" | "ordinary"} */ (item.tier) });
  }
  return { offered, leftOut };
}

export class NativeMemoryImport {
  /**
   * @param {{ config: any, overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
   *   nativeMemory: { rememberImport: (userId: string, lines: { ordinary: readonly string[], onRequest?: readonly string[] }) => Promise<unknown> },
   *   memorySettings?: { settings: (userId: string) => Promise<{ learningPaused?: boolean }> } | null, usageLedger?: any,
   *   fetchImpl?: typeof fetch, now?: () => Date, callModel?: typeof callModelForControlPlane, newId?: () => string }} dependencies
   */
  constructor({ config, overlay, nativeMemory, memorySettings = null, usageLedger = null, fetchImpl = globalThis.fetch, now = () => new Date(), callModel = callModelForControlPlane,
    newId = () => `imp_${randomBytes(12).toString("hex")}` }) {
    this.config = config;
    this.overlay = overlay;
    this.nativeMemory = nativeMemory;
    this.memorySettings = memorySettings;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.callModel = callModel;
    this.newId = newId;
    this.model = String(config.memoryExtractionModel || config.deepseekModel || "");
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
    this.perHour = Math.max(0, Math.trunc(Number(config.memoryImportOffersPerHour ?? 5)));
    /** The attempts of the last hour by account, failed ones too, in this process: a model that keeps failing is asked a bounded number of times. @type {Map<string, number[]>} */
    this.attempts = new Map();
  }

  /** Whether a model can be asked here: a model and a provider. */
  get available() { return Boolean(this.model) && Boolean(this.config.deepseekProviderEnabled !== false && this.config.deepseekApiKey); }

  /**
   * Read a pasted text into an offer for the person to review.
   * @param {string} userId @param {{ text: string }} input
   * @returns {Promise<{ id: string, statements: { id: string, text: string, sensitivity: "ordinary" | "on_request", ticked: boolean }[], leftOut: number, expiresInMs: number }>}
   */
  async offer(userId, { text }) {
    const pasted = String(text ?? "");
    if (!pasted.trim() || [...pasted].length > IMPORT_MAX_CHARS) throw new HttpError(400, "memory_payload_invalid", `The text to import must be 1 to ${IMPORT_MAX_CHARS} characters.`);
    const settings = this.memorySettings ? await this.memorySettings.settings(userId) : null;
    if (settings?.learningPaused) throw new HttpError(409, "memory_import_paused", "Memory is paused: nothing would be kept.");
    const at = this.now();
    const since = new Date(at.getTime() - 3_600_000);
    const recent = (this.attempts.get(userId) ?? []).filter((time) => time > since.getTime());
    if (this.perHour < 1 || recent.length >= this.perHour * 3 || (await this.overlay.importsSince(userId, since)) >= this.perHour) {
      recordImport("rate_limited");
      throw new HttpError(429, "memory_import_rate_limited", "Too many imports in an hour.");
    }
    this.attempts.set(userId, [...recent, at.getTime()]);
    if (!this.available) { recordImport("model_failed"); throw new HttpError(503, "memory_import_unavailable", "The import cannot read the text now."); }
    const lines = importLines(pasted);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let parsed;
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId, projectId: "default", runId: null, purpose: "memory-extraction", signal: controller.signal, body: importRequestBody(this.model, lines),
      });
      parsed = parseImport(body?.choices?.[0]?.message?.content, lines);
    } catch {
      parsed = null;
    } finally {
      clearTimeout(timeout);
    }
    if (!parsed) { recordImport("model_failed"); throw new HttpError(503, "memory_import_unavailable", "The import cannot read the text now."); }
    const statements = parsed.offered.map((entry, index) => ({ id: `s${index + 1}`, text: entry.text, sensitivity: entry.tier, ticked: entry.tier === "ordinary" }));
    const id = this.newId();
    await this.overlay.createImport(userId, { id, statements, leftOut: parsed.leftOut });
    recordImport("offered");
    return { id, statements, leftOut: parsed.leftOut, expiresInMs: 3_600_000 };
  }

  /**
   * Save what the person kept. `ids` are the statements they ticked; absent, the ones the offer ticked. Only statements the offer made can be
   * saved, once each; the offer is spent when the engine has been handed them.
   * @param {string} userId @param {string} id @param {{ ids?: readonly string[] | null }} [choice]
   * @returns {Promise<{ saved: number }>}
   */
  async save(userId, id, { ids = null } = {}) {
    if (!/^imp_[a-f0-9]{24}$/.test(String(id))) throw new HttpError(404, "memory_import_expired", "This import is gone.");
    const offer = await this.overlay.importOffer(userId, id);
    if (!offer || offer.expired) throw new HttpError(404, "memory_import_expired", "This import is gone.");
    if (offer.state === "saved") return { saved: offer.saved };
    const wanted = ids === null ? null : new Set(ids.map(String));
    const chosen = offer.statements.filter((statement) => (wanted ? wanted.has(statement.id) : statement.ticked === true));
    if (!chosen.length) { await this.overlay.markImportSaved(userId, id, 0); return { saved: 0 }; }
    const ordinary = chosen.filter((statement) => statement.sensitivity !== "on_request").map((statement) => statement.text);
    const onRequest = chosen.filter((statement) => statement.sensitivity === "on_request").map((statement) => statement.text);
    // One message per few statements: an extraction given fifty lines at once keeps fewer of them.
    for (let start = 0; start < Math.max(ordinary.length, onRequest.length); start += SAVE_CHUNK) {
      await this.nativeMemory.rememberImport(userId, { ordinary: ordinary.slice(start, start + SAVE_CHUNK), onRequest: onRequest.slice(start, start + SAVE_CHUNK) });
    }
    await this.overlay.markImportSaved(userId, id, chosen.length);
    recordImport("saved");
    return { saved: chosen.length };
  }
}
