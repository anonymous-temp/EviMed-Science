import { createHash } from "node:crypto";

import { callModelForControlPlane } from "./modelGateway.mjs";

/**
 * 「重读旧记忆」: a memory the platform wrote under older rules, read again under
 * today's.
 *
 * The extraction rules have been tightened many times (report content on
 * 2026-09-20, platform notes on 2026-09-19, a conversation's pending state and
 * the platform's own inventory on 2026-10-07), and each tightening governs only
 * what is written after it. What an earlier rule let through stays in force:
 * production on 2026-10-12 still held 「平台现有三份病种知识包…」 — the very
 * sentence the 10-07 rule quotes as its example — beside study identifiers, a
 * tool's gap and to-dos the assistant had proposed, each recalled into later
 * questions as if it were known about the researcher.
 *
 * So a memory the platform wrote is read again, once per version of these
 * rules, and one that the rules would not have written now is forgotten the way
 * a researcher forgets one: archived, listed under 「已忘记的内容」, and put back
 * with one click. Whether a sentence is report content or a standing fact is a
 * language judgement, so it is the model's (principle 1); what code holds is the
 * closed half — the id is one of the memories it was shown, the reason is one of
 * the codes below, and anything else keeps the memory. A memory the researcher
 * stated, wrote, edited or restored is theirs and is never read here
 * (`ResearchMemory.unreviewedRecords`); nothing asks anyone to confirm anything
 * (owner rulings of 2026-09-19 and 2026-10-10).
 *
 * Two classes are not a language judgement and are not put to the model. A memory extraction wrote from what the assistant or a
 * tool said (origin `system`), and one that rests only on an instruction the platform dispatched (a scheduled task reuses one
 * conversation, and its template was quoted as the person's habit), are decided from who wrote the quoted message — the role it
 * carries and the request it came in (`memoryEvidenceProvenance.mjs`) — and forgotten the same way. Since 2026-10-14 extraction
 * writes neither.
 *
 * Deletable when the extractor no longer writes what the rules exclude and no
 * account holds a memory written before that.
 */

/** Why a memory is not kept: one code per class the rules name. */
export const MEMORY_REVIEW_REASONS = Object.freeze([
  "report_content", "source_detail", "run_state", "platform", "task_condition", "personal_detail", "duplicate",
]);

/** Why a memory is forgotten in code, from whose words it rests on and not from what it says. */
export const MEMORY_REVIEW_STRUCTURAL_REASONS = Object.freeze(["assistant_text", "dispatched_instruction"]);

/**
 * The structural rules in words, part of the version of the rules a reading is made under: editing them reads every memory again.
 *  - assistant_text: the memory rests on what the assistant or a tool said (origin `system`), or only on messages that were not the person's.
 *  - dispatched_instruction: every message it rests on was dispatched by the platform (a scheduled execution's instruction, a platform brief).
 *  Decided only when every observation of the memory is decided; one that rests on the person's words, or on a message nothing
 *  can place, is never decided here.
 */
const STRUCTURAL_RULES = "assistant_text: origin system, or every observation an assistant or tool message; dispatched_instruction: every observation a dispatched or platform message, at least one dispatched; undecided observation keeps the memory";

/** How many memories one reading takes: one model call, about 6,000 input tokens at the most. */
export const MEMORY_REVIEW_BATCH = 24;

/** Whose records are read: what the platform inferred or took from the assistant (the model's and code's), and what it read as the person's own (code's alone). */
export const REVIEWED_ORIGINS = Object.freeze(["system", "inferred", "explicit"]);

const INSTRUCTIONS = [
  "You read again memories a research platform wrote about one researcher and their projects. The platform wrote each of them, some under older rules; none was typed by the researcher.",
  "Each memory shows the researcher's own words it rests on as quote. Keep a memory only when it says what those words say.",
  "Keep what will still be true and useful to the researcher's next conversations: who they are and what they work on; how they want work done and how they write; a correction they made; a project's standing shape — its question, population, data source, inclusion rule, comparator, the decisions taken and what the researcher still has open.",
  "List the memories not to keep, each with exactly one reason code:",
  "report_content — a number, a finding or a conclusion that belongs to a report or an answer: an effect estimate, a p-value, a count, a ranking, what a guideline or a trial concluded, what the evidence shows;",
  "source_detail — a fact about one source rather than about the research: what one paper, page, guideline or document is, says or is numbered, which the report and the knowledge base already hold;",
  "run_state — something true of one conversation only: what it searched and when, what a tool could or could not reach, what the assistant was waiting for from the researcher (an upload, a choice, a sentence), what it would do next, and a direction or a study the assistant proposed. A decision the project still has to make, or a gap the project itself has to close, is part of its standing shape: keep it;",
  "platform — anything about how the platform works or what it offers: its tools, engines, steps, files, packages, knowledge packs and limits, and the rules the platform's own instructions set for how its deliverables are written;",
  "task_condition — a condition the researcher put on one request (「这次只看亚洲人群」), stored as if it were how they always work;",
  "personal_detail — a patient's or any other person's identifying or clinical details, or an inference about the researcher's health, beliefs or private life;",
  "duplicate — the same fact as another memory in this list, said less completely; keep the fuller one.",
  "When a memory is partly worth keeping, keep it. When unsure, keep it.",
  "Return JSON only: {\"forget\":[{\"id\":\"…\",\"reason\":\"…\"}]}, listing only the memories not to keep — an empty list when every one stays.",
].join(" ");

/** The version of the rules a reading is made under: a memory is read again when they change, and only then. */
export const MEMORY_REVIEW_RULES = createHash("sha256").update(INSTRUCTIONS).update("\n").update(STRUCTURAL_RULES).digest("hex").slice(0, 16);

/**
 * The reason a memory is forgotten in code, or null when code does not decide it.
 * @param {{ origin?: string, evidence?: readonly unknown[] }} record
 * @param {readonly string[] | null} voices whose words each observation is, as `memoryEvidenceProvenance` answers (one per evidence entry)
 * @returns {"assistant_text" | "dispatched_instruction" | null}
 */
export function structuralVerdict(record, voices) {
  // Extraction wrote origin `system` only from an assistant or tool source: by construction nothing the person said.
  if (record.origin === "system") return "assistant_text";
  if (!voices?.length || voices.length !== (record.evidence ?? []).length) return null;
  if (voices.some((voice) => voice !== "assistant" && voice !== "dispatched")) return null;
  return voices.includes("dispatched") ? "dispatched_instruction" : "assistant_text";
}

/**
 * The memories the model said not to keep, by id, each with its reason — only ids it was shown and only reasons the rules name.
 * Anything else, a reply that is not JSON included, keeps every memory.
 * @param {unknown} content @param {readonly { id: string }[]} batch @returns {Map<string, string>}
 */
export function reviewVerdicts(content, batch) {
  const shown = new Set(batch.map((record) => record.id));
  /** @type {Map<string, string>} */
  const forget = new Map();
  let parsed;
  try { parsed = JSON.parse(String(content ?? "")); } catch { return forget; }
  for (const item of Array.isArray(parsed?.forget) ? parsed.forget : []) {
    const id = String(item?.id ?? "");
    const reason = String(item?.reason ?? "");
    if (shown.has(id) && MEMORY_REVIEW_REASONS.includes(reason) && !forget.has(id)) forget.set(id, reason);
  }
  return forget;
}

/** What the model is shown of a memory: its kind, whether it is the account's or a project's, and its sentence. @param {any} record */
function shownMemory(record) {
  const text = String(record.summary || record.value || "").replace(/\s+/g, " ").trim();
  const quote = String(record.evidence?.[0]?.quote ?? "").replace(/\s+/g, " ").trim();
  return { id: record.id, kind: record.kind, scope: record.scope === "user" ? "account" : "project", text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
    ...(quote ? { quote: quote.length > 200 ? `${quote.slice(0, 200)}…` : quote } : {}) };
}

export class MemoryReview {
  /**
   * @param {any} config
   * @param {any} memoryStore `ResearchMemory`: `unreviewedRecords`, `noteReviewed`, `upsertRecord`
   * @param {{ fetchImpl?: typeof fetch, usageLedger?: any, audit?: (event: string, error: unknown) => unknown,
   *   evidenceProvenance?: (() => (userId: string, record: any) => Promise<string[]>) | null }} [options]
   *   `evidenceProvenance`: makes one `createEvidenceProvenance` reader per reading; absent, only origin `system` is decided in code.
   */
  constructor(config, memoryStore, { fetchImpl = globalThis.fetch, usageLedger = null, audit = () => {}, evidenceProvenance = null } = {}) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.fetchImpl = fetchImpl;
    this.usageLedger = usageLedger;
    this.audit = audit;
    this.evidenceProvenance = typeof evidenceProvenance === "function" ? evidenceProvenance : null;
    this.model = String(config.memoryExtractionModel || config.deepseekModel || "");
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
  }

  /** Whether this deployment can read memories again at all: a store that keeps the readings, and a model. */
  get available() {
    return typeof this.memoryStore?.unreviewedRecords === "function" && typeof this.memoryStore?.noteReviewed === "function"
      && Boolean(this.config.deepseekProviderEnabled && this.config.deepseekApiKey && this.model);
  }

  /**
   * The model's reading of one batch: which of these memories the rules would not write now, and why (`reviewVerdicts`).
   * @param {string} userId @param {readonly any[]} batch at most `MEMORY_REVIEW_BATCH` memories
   * @param {{ projectId: string, runId?: string | null }} options the project the call is charged to
   * @returns {Promise<Map<string, string>>}
   */
  async judge(userId, batch, { projectId, runId = null }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await callModelForControlPlane({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId, projectId, runId, purpose: "memory-extraction", signal: controller.signal,
        body: {
          model: this.model,
          // Structured judgement, as for extraction: thinking off, temperature 0, one JSON object.
          thinking: { type: "disabled" },
          temperature: 0,
          max_tokens: 2_000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INSTRUCTIONS },
            { role: "user", content: JSON.stringify({ memories: batch.slice(0, MEMORY_REVIEW_BATCH).map(shownMemory) }) },
          ],
        },
      });
      return reviewVerdicts(body?.choices?.[0]?.message?.content, batch);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Why each of these memories is not kept, if it is not: first from whose words it rests on (code), then, for what the platform
   * inferred, from what it says (the model). A memory the researcher stated outright (origin explicit) is only ever put to the
   * first; a reader that fails keeps the memory.
   * @param {string} userId @param {readonly any[]} batch at most `MEMORY_REVIEW_BATCH` memories
   * @param {{ projectId: string, runId?: string | null }} options the project the model call is charged to
   * @returns {Promise<Map<string, string>>}
   */
  async verdicts(userId, batch, { projectId, runId = null }) {
    /** @type {Map<string, string>} */
    const forget = new Map();
    const provenance = this.evidenceProvenance ? this.evidenceProvenance() : null;
    /** @type {any[]} */
    const forModel = [];
    for (const record of batch.slice(0, MEMORY_REVIEW_BATCH)) {
      let voices = null;
      if (provenance && record.origin !== "system") {
        voices = await provenance(userId, record).catch(async (/** @type {unknown} */ error) => { await this.audit("memory.review.provenance", error); return null; });
      }
      const structural = structuralVerdict(record, voices);
      if (structural) forget.set(record.id, structural);
      else if (record.origin !== "explicit") forModel.push(record);
    }
    if (forModel.length) for (const [id, reason] of await this.judge(userId, forModel, { projectId, runId })) forget.set(id, reason);
    return forget;
  }

  /**
   * Read one batch of the account's memories again; forget those the rules would not have written now.
   * `apply: false` reads and reports without changing a memory or noting a reading.
   * @param {string} userId
   * @param {{ projectId: string, runId?: string | null, limit?: number, apply?: boolean }} options the project the call is charged to
   * @returns {Promise<{ read: number, forgotten: { id: string, kind: string, scope: string, reason: string }[] }>}
   */
  async review(userId, { projectId, runId = null, limit = MEMORY_REVIEW_BATCH, apply = true }) {
    if (!this.available) return { read: 0, forgotten: [] };
    const batch = await this.memoryStore.unreviewedRecords(userId, MEMORY_REVIEW_RULES, { limit: Math.max(1, Math.min(MEMORY_REVIEW_BATCH, limit)), origins: REVIEWED_ORIGINS });
    if (batch.length === 0) return { read: 0, forgotten: [] };
    const verdicts = await this.verdicts(userId, batch, { projectId, runId });
    const forgotten = [];
    /** Memories that changed while they were read: neither forgotten nor noted, so they are read again next time. */
    const changed = new Set();
    if (!apply) {
      return { read: batch.length, forgotten: batch.filter((record) => verdicts.has(record.id))
        .map((record) => ({ id: record.id, kind: record.kind, scope: record.scope, reason: String(verdicts.get(record.id)) })) };
    }
    for (const record of batch) {
      const reason = verdicts.get(record.id);
      if (!reason) continue;
      try {
        await this.memoryStore.upsertRecord(userId, { ...record, status: "archived" }, null, {
          expectedVersion: record.version,
          reason: `read again under the memory rules ${MEMORY_REVIEW_RULES}: ${reason}`,
          by: "system", runId,
        });
        forgotten.push({ id: record.id, kind: record.kind, scope: record.scope, reason });
      } catch (error) {
        // A memory that changed while it was read is left as it now is, and read again next time.
        if (/** @type {any} */ (error)?.code !== "memory_conflict") throw error;
        changed.add(record.id);
        await this.audit("memory.review.changed", error);
      }
    }
    await this.memoryStore.noteReviewed(userId, MEMORY_REVIEW_RULES, batch.filter((record) => !changed.has(record.id))
      .map((record) => ({ id: record.id, kept: !verdicts.has(record.id), reason: verdicts.get(record.id) ?? "" })));
    return { read: batch.length, forgotten };
  }
}
