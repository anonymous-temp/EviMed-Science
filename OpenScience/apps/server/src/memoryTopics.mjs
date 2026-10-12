import { createHash } from "node:crypto";

import { callModelForControlPlane } from "./modelGateway.mjs";
import { migrateResearchMemory } from "./researchMemoryPersistence.mjs";

/**
 * 「主题」: what an account's memories are about, in the account's own words — the map's third view.
 *
 * A memory has no topic field and none is asked of the extractor. The grouping is made afterwards, from the memories as they
 * are, by one Flash call: which memories are about the same thing, and what to call it. That is a language judgement, so it is the
 * model's (principle 1); what code holds is the half that is decidable — every member is the id of a memory the model was shown,
 * a topic has at least two of them, there are at most thirty, a label is short — and anything the model returns that does not
 * stand is dropped, not softened.
 *
 * Hidden knowledge:
 *
 * - **Open vocabulary, on purpose.** Nothing here names a specialty, a drug or any closed list of themes: an engineer's topics are
 *   an engineer's and a clinician's a clinician's, and the prompt says so. A topic is never a kind of memory (「偏好」) or the
 *   platform's own vocabulary.
 * - **The researcher's word is the stronger basis.** A rename, a merge of two topics into one, a topic dismissed and a memory
 *   taken out of a topic are kept as `overrides` and applied over every regrouping, and a regrouping is told which names are the
 *   researcher's so it keeps them and which themes they refused so it does not bring them back. Ids are kept across regroupings
 *   (the model is given the old ones to reuse; a topic it gives a new id to under its old label is matched by that label), which
 *   is what lets an edit survive.
 * - **The grouping is derived and rebuildable** (`evimed_memory.topic_sets`, one row per account) and is made only when the set of
 *   memories changed (`topicMark`), at most `memoryTopicsDailyRuns` times an account a day — failures count, so a model that
 *   keeps failing cannot be asked without end. Reading it never calls the model; a grouping that is out of date is served as it
 *   is, marked `stale`, and the page asks for a new one (`refresh`). An edit costs no model call.
 * - Only the memories the map draws are read (never a sensitive one, a run summary or a forgotten one), cut to a short excerpt.
 *   The call is charged to the account as memory extraction (`purpose: "memory-extraction"`), caps included.
 *
 * Deletable when a model's own reading of a whole account's memory is cheap enough to do on every open of the page.
 *
 * @module memoryTopics
 */

/** The bounds of a grouping. */
export const TOPIC_LIMITS = Object.freeze({
  /** The most topics one grouping keeps. */
  max: 30,
  /** The fewest memories a topic holds, unless the researcher made it. */
  members: 2,
  /** The longest a label is, in characters. */
  label: 20,
  /** The memories one call is shown, the most important and most recent. */
  shown: 300,
  /** How much of a memory the model is shown. */
  excerpt: 140,
  /** The days of a period of a topic's trend. */
  trendDays: 30,
});

const INSTRUCTIONS = [
  "You group one person's memories — short notes a research platform keeps about them and their projects — into the topics they are about.",
  "A topic is a theme of this person's own work or life that several memories belong to, named in the language of the memories in two to six words, as the person would name it (「心衰患者的随访」, 「本季度的预算」, 「SQL 性能调优」).",
  "Make 8 to 30 topics when the memories allow it, and fewer when there are fewer distinct themes. A memory may belong to up to three topics, and may belong to none when it fits no theme.",
  "The vocabulary is open: take the names from the memories. Never name a topic after a kind of note (a preference, a decision, a habit, a project fact) or after the platform, its tools or its steps, and never use a fixed list of subjects.",
  "Two topics that are one theme are one topic; one topic that is really two themes is two.",
  "`existing` lists the topics of the last grouping with their ids. When a theme is still there, give its topic the same id and keep its name, unless the memories now say it better; leave the id empty for a new theme. A topic with `fixed: true` was named by the person: keep its name exactly.",
  "`dismissed` lists names of themes the person said are wrong. Do not make a topic of that name or of that meaning.",
  "Return JSON only: {\"topics\":[{\"id\":\"<existing id or empty>\",\"label\":\"…\",\"members\":[\"<memory id>\", …]}]}. Use only the memory ids you were given.",
].join(" ");

/** The version of these instructions: a changed prompt is a reason for a new grouping the next time the memories change, no sooner. */
export const MEMORY_TOPICS_RULES = createHash("sha256").update(INSTRUCTIONS).digest("hex").slice(0, 16);

/** @param {unknown} value @param {number} max */
function excerpt(value, max) {
  const chars = [...String(value ?? "").replace(/\s+/gu, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

/** A label as it is compared: case, spacing and punctuation do not make two topics. @param {unknown} label */
export function labelKey(label) {
  return String(label ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** The id of a topic the model named afresh: derived from its label, so the same label is the same topic. @param {string} label */
export function topicIdFor(label) {
  return `topic:${createHash("sha256").update(labelKey(label)).digest("hex").slice(0, 10)}`;
}

/**
 * The memories a grouping is made from: those in force, the most important and most recent `TOPIC_LIMITS.shown` of them.
 * @param {readonly any[]} records the map's memories
 */
export function groupable(records) {
  return records
    .filter((record) => record && record.kind !== "run_summary" && record.sensitive !== true && ["active", "pending"].includes(record.status)
      && String(record.summary || record.value || "").trim())
    .sort((left, right) => (Number(right.importance) || 0) - (Number(left.importance) || 0)
      || String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || left.id.localeCompare(right.id))
    .slice(0, TOPIC_LIMITS.shown);
}

/** The digest of the memories a grouping was made from: their ids and versions, in order. @param {readonly any[]} records */
export function topicMark(records) {
  const keys = records.map((record) => `${record.id}@${record.version ?? 1}`).sort();
  return createHash("sha256").update(`${MEMORY_TOPICS_RULES}\n${keys.join("\n")}`).digest("hex").slice(0, 32);
}

/**
 * What the model returns, reduced to what stands.
 *
 * Only ids the model was shown are members; a label is trimmed and cut, a topic without one is dropped; two topics of one label
 * are one; a topic that keeps an old id keeps it only if the old topic exists and no other topic took it, and one that gives a
 * new id under the label of an old topic is that topic; a topic with fewer than `members` memories is dropped; at most
 * `max` topics remain, the largest. A reply that is not JSON has no topics.
 *
 * @param {unknown} content the model's message @param {readonly string[]} shown the memory ids it was shown
 * @param {readonly { id: string, label: string, modelLabel?: string }[]} existing the last grouping's topics
 * @returns {{ id: string, label: string, members: string[] }[]}
 */
export function parseTopics(content, shown, existing = []) {
  let parsed;
  try { parsed = JSON.parse(String(content ?? "")); } catch { return []; }
  const known = new Set(shown);
  const byId = new Map(existing.map((topic) => [topic.id, topic]));
  const byLabel = new Map(existing.map((topic) => [labelKey(topic.modelLabel ?? topic.label), topic.id]));
  /** @type {Map<string, { id: string, label: string, members: Set<string> }>} */
  const made = new Map();
  /** @type {Set<string>} */
  const taken = new Set();
  for (const item of Array.isArray(parsed?.topics) ? parsed.topics : []) {
    const label = excerpt(item?.label, TOPIC_LIMITS.label);
    if (!label) continue;
    const members = [...new Set((Array.isArray(item?.members) ? item.members : []).map(String).filter((id) => known.has(id)))];
    if (members.length === 0) continue;
    const key = labelKey(label);
    const merge = [...made.values()].find((topic) => labelKey(topic.label) === key);
    if (merge) { for (const id of members) merge.members.add(id); continue; }
    const given = String(item?.id ?? "");
    let id = byId.has(given) && !taken.has(given) ? given : "";
    if (!id) { const old = byLabel.get(key); if (old && !taken.has(old)) id = old; }
    if (!id) id = topicIdFor(label);
    if (taken.has(id)) continue;
    taken.add(id);
    made.set(id, { id, label, members: new Set(members) });
  }
  return [...made.values()]
    .map((topic) => ({ id: topic.id, label: topic.label, members: [...topic.members] }))
    .filter((topic) => topic.members.length >= TOPIC_LIMITS.members)
    .sort((left, right) => right.members.length - left.members.length || left.id.localeCompare(right.id))
    .slice(0, TOPIC_LIMITS.max);
}

/**
 * @typedef {object} TopicOverrides
 * @property {Record<string, string>} [renamed] topic id → the name the researcher gave it
 * @property {Record<string, string>} [merged] topic id → the topic it was merged into
 * @property {{ id: string, label: string }[]} [dismissed] topics the researcher said are wrong, by id and name
 * @property {Record<string, string[]>} [removed] topic id → memories the researcher took out of it
 */

/**
 * The topics a researcher sees: the last grouping with their word applied over it, and only memories that are still there.
 *
 * A merged topic's members join the topic it was merged into (a chain of merges is followed to its end, a cycle is cut), a
 * renamed topic wears the researcher's name, a dismissed topic — by id or by name — is gone, a memory taken out stays out, and a
 * memory that is no longer in force is no member. A topic the model made keeps `members` ≥ 2 to be shown; one the researcher
 * touched keeps its place at one. Weight is the number of memories now; trend is the memories begun in the last 30 days less
 * those begun in the 30 before.
 *
 * @param {readonly { id: string, label: string, members: readonly string[] }[]} topics
 * @param {TopicOverrides} overrides @param {readonly any[]} records the memories in force @param {Date} now
 * @returns {{ id: string, label: string, weight: number, trend: number, members: string[], edited: boolean }[]}
 */
export function shownTopics(topics, overrides, records, now) {
  const present = new Map(records.map((record) => [record.id, record]));
  const merged = overrides.merged ?? {};
  const renamed = overrides.renamed ?? {};
  const removed = overrides.removed ?? {};
  const dismissed = overrides.dismissed ?? [];
  const dismissedIds = new Set(dismissed.map((item) => item.id));
  const dismissedLabels = new Set(dismissed.map((item) => labelKey(item.label)));
  const finalOf = (/** @type {string} */ id) => {
    const seen = new Set([id]);
    let at = id;
    while (merged[at] && !seen.has(merged[at])) { at = merged[at]; seen.add(at); }
    return at;
  };
  /** @type {Map<string, { id: string, label: string, members: Set<string>, edited: boolean }>} */
  const grouped = new Map();
  for (const topic of topics) {
    const id = finalOf(topic.id);
    const target = topics.find((item) => item.id === id);
    if (dismissedIds.has(topic.id) || dismissedIds.has(id)) continue;
    const held = grouped.get(id) ?? { id, label: renamed[id] ?? target?.label ?? topic.label, members: new Set(), edited: Boolean(renamed[id]) };
    if (id !== topic.id) held.edited = true;
    if (!renamed[id] && dismissedLabels.has(labelKey(held.label))) continue;
    for (const member of topic.members) if (present.has(member) && !(removed[topic.id] ?? []).includes(member) && !(removed[id] ?? []).includes(member)) held.members.add(member);
    grouped.set(id, held);
  }
  const day = 86_400_000;
  const nowMs = now.getTime();
  return [...grouped.values()]
    .filter((topic) => topic.members.size >= (topic.edited ? 1 : TOPIC_LIMITS.members))
    .map((topic) => {
      const ages = [...topic.members].map((id) => nowMs - Date.parse(present.get(id)?.createdAt ?? ""));
      const recent = ages.filter((age) => Number.isFinite(age) && age >= 0 && age < TOPIC_LIMITS.trendDays * day).length;
      const before = ages.filter((age) => Number.isFinite(age) && age >= TOPIC_LIMITS.trendDays * day && age < 2 * TOPIC_LIMITS.trendDays * day).length;
      return { id: topic.id, label: topic.label, weight: topic.members.size, trend: recent - before, members: [...topic.members].sort(), edited: topic.edited };
    })
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

/** What the memories are shown as to the model. @param {any} record */
function shownMemory(record) {
  return { id: record.id, scope: record.scope === "user" ? "account" : "project", text: excerpt(record.summary || record.value, TOPIC_LIMITS.excerpt) };
}

/**
 * The body of the one request a grouping makes. Exported so `evals/memory-topics` runs the very prompt the platform runs.
 * @param {string} model
 * @param {{ existing?: { id: string, label: string, fixed?: boolean }[], dismissed?: string[], memories: readonly any[] }} input
 */
export function topicsRequestBody(model, { existing = [], dismissed = [], memories }) {
  return {
    model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 4_000, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: JSON.stringify({
        existing: existing.map(({ id, label, fixed }) => ({ id, label, ...(fixed ? { fixed: true } : {}) })),
        dismissed,
        memories: memories.map(shownMemory),
      }) },
    ],
  };
}

/** @param {any} value @returns {TopicOverrides} */
function overridesOf(value) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    renamed: object.renamed && typeof object.renamed === "object" ? object.renamed : {},
    merged: object.merged && typeof object.merged === "object" ? object.merged : {},
    dismissed: Array.isArray(object.dismissed) ? object.dismissed.filter((/** @type {any} */ item) => item && typeof item.id === "string") : [],
    removed: object.removed && typeof object.removed === "object" ? object.removed : {},
  };
}

const TOPIC_ID = /^topic:[a-f0-9]{10}$/u;

export class MemoryTopics {
  /**
   * @param {any} config
   * @param {any} memoryStore `ResearchMemoryStore`: `database` and `mapRecords`
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof callModelForControlPlane, now?: () => Date,
   *   audit?: (event: string, error: unknown) => unknown }} [options]
   */
  constructor(config, memoryStore, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane, now = () => new Date(), audit = () => {} } = {}) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    this.now = now;
    this.audit = audit;
    this.model = String(config.memoryExtractionModel || config.deepseekModel || "");
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 60_000)));
    /** @type {Map<string, Promise<any>>} */
    this.running = new Map();
  }

  /** Whether there is a database to keep a grouping in. */
  get configured() {
    return Boolean(this.memoryStore?.database) && this.config.memoryTopicsEnabled !== false;
  }

  /** Whether a grouping can be made at all: a store and a model. */
  get available() {
    return this.configured && Boolean(this.config.deepseekProviderEnabled && this.config.deepseekApiKey && this.model);
  }

  /** @param {string} text @param {any[]} values */
  async #query(text, values) {
    await migrateResearchMemory(this.memoryStore.database);
    return this.memoryStore.database.query(text, values);
  }

  /** @param {string} userId */
  async #row(userId) {
    const result = await this.#query("SELECT topics, overrides, memory_mark, computed_at, attempts_day, attempts FROM evimed_memory.topic_sets WHERE user_id=$1", [userId]);
    const row = result.rows[0];
    return {
      topics: Array.isArray(row?.topics) ? row.topics : [],
      overrides: overridesOf(row?.overrides),
      mark: String(row?.memory_mark ?? ""),
      computedAt: row?.computed_at ? new Date(row.computed_at).toISOString() : null,
      attemptsDay: String(row?.attempts_day ?? ""),
      attempts: Number(row?.attempts) || 0,
    };
  }

  /**
   * @param {string} userId @param {{ topics?: any, overrides?: any, mark?: string, computedAt?: string | null, attemptsDay?: string, attempts?: number }} patch
   */
  async #save(userId, patch) {
    await this.#query(`INSERT INTO evimed_memory.topic_sets (user_id, topics, overrides, memory_mark, computed_at, attempts_day, attempts)
      VALUES ($1, coalesce($2::jsonb, '[]'::jsonb), coalesce($3::jsonb, '{}'::jsonb), coalesce($4, ''), $5, coalesce($6, ''), coalesce($7, 0))
      ON CONFLICT (user_id) DO UPDATE SET
        topics = CASE WHEN $2::jsonb IS NULL THEN evimed_memory.topic_sets.topics ELSE $2::jsonb END,
        overrides = CASE WHEN $3::jsonb IS NULL THEN evimed_memory.topic_sets.overrides ELSE $3::jsonb END,
        memory_mark = CASE WHEN $4::text IS NULL THEN evimed_memory.topic_sets.memory_mark ELSE $4 END,
        computed_at = CASE WHEN $5::timestamptz IS NULL THEN evimed_memory.topic_sets.computed_at ELSE $5::timestamptz END,
        attempts_day = CASE WHEN $6::text IS NULL THEN evimed_memory.topic_sets.attempts_day ELSE $6 END,
        attempts = CASE WHEN $7::integer IS NULL THEN evimed_memory.topic_sets.attempts ELSE $7 END`,
    [userId, patch.topics == null ? null : JSON.stringify(patch.topics), patch.overrides == null ? null : JSON.stringify(patch.overrides),
      patch.mark ?? null, patch.computedAt ?? null, patch.attemptsDay ?? null, patch.attempts ?? null]);
  }

  /**
   * The topics to show for an account's memories, and whether they are up to date. Never calls the model.
   * `status`: `off` (no store, or the module is switched off), `empty` (too few memories to group and nothing grouped before),
   * `stale` (a grouping is due — there is none yet, or the memories changed since — and what is shown is the last one, or nothing),
   * `ready`.
   * @param {string} userId @param {readonly any[]} records the map's memories (the account's, not one project's)
   * @returns {Promise<{ status: "off" | "empty" | "stale" | "ready", topics: ReturnType<typeof shownTopics> }>}
   */
  async read(userId, records) {
    if (!this.configured) return { status: "off", topics: [] };
    const row = await this.#row(userId);
    const eligible = groupable(records);
    const topics = shownTopics(row.topics, row.overrides, eligible, this.now());
    if (eligible.length < this.config.memoryTopicsMinMemories) return { status: topics.length > 0 ? "ready" : "empty", topics };
    return { status: row.mark === topicMark(eligible) ? "ready" : "stale", topics };
  }

  /**
   * Group the account's memories again if they changed and the day's bound allows. Concurrent calls for one account are one.
   * A failed call leaves the last grouping as it was (principle 19) and is counted against the day.
   * @param {string} userId @param {{ projectId: string, runId?: string | null }} options the project the call is charged to
   * @returns {Promise<{ status: string, made: boolean, bounded?: boolean }>} `status` as `read` says it
   */
  async refresh(userId, { projectId, runId = null }) {
    if (!this.available) return { status: this.configured ? "stale" : "off", made: false };
    const pending = this.running.get(userId);
    if (pending) return pending;
    const work = this.#refresh(userId, { projectId, runId }).finally(() => this.running.delete(userId));
    this.running.set(userId, work);
    return work;
  }

  /** @param {string} userId @param {{ projectId: string, runId: string | null }} options */
  async #refresh(userId, { projectId, runId }) {
    const records = await this.memoryStore.mapRecords(userId, { projectId: null, limit: 2000 });
    const eligible = groupable(records);
    const row = await this.#row(userId);
    if (eligible.length < this.config.memoryTopicsMinMemories) return { status: row.topics.length > 0 ? "ready" : "empty", made: false };
    const mark = topicMark(eligible);
    if (row.mark === mark) return { status: "ready", made: false };
    const today = this.now().toISOString().slice(0, 10);
    const attempts = row.attemptsDay === today ? row.attempts : 0;
    if (attempts >= this.config.memoryTopicsDailyRuns) return { status: "stale", made: false, bounded: true };
    // Counted before the call: a model that keeps failing is asked a bounded number of times a day, not without end.
    await this.#save(userId, { attemptsDay: today, attempts: attempts + 1 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const old = row.topics.map((/** @type {any} */ topic) => ({
        id: topic.id, label: row.overrides.renamed?.[topic.id] ?? topic.label, modelLabel: topic.label, fixed: Boolean(row.overrides.renamed?.[topic.id]),
      }));
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId, projectId, runId, purpose: "memory-extraction", signal: controller.signal,
        body: topicsRequestBody(this.model, {
          existing: old, dismissed: (row.overrides.dismissed ?? []).map((/** @type {any} */ item) => item.label), memories: eligible,
        }),
      });
      const made = parseTopics(body?.choices?.[0]?.message?.content, eligible.map((record) => record.id), old);
      if (made.length === 0) {
        // Nothing stood: the last grouping stays, and this set of memories is not marked as grouped, so a later call may try again.
        return { status: "stale", made: false };
      }
      // A merge or a removal the researcher made names topics of the grouping they saw; the ones the new grouping no longer has
      // are forgotten with it, and a name they gave is kept only by id.
      const ids = new Set(made.map((topic) => topic.id));
      const overrides = row.overrides;
      overrides.renamed = Object.fromEntries(Object.entries(overrides.renamed ?? {}).filter(([id]) => ids.has(id)));
      overrides.merged = Object.fromEntries(Object.entries(overrides.merged ?? {}).filter(([from, into]) => ids.has(from) && ids.has(into)));
      overrides.removed = Object.fromEntries(Object.entries(overrides.removed ?? {}).filter(([id]) => ids.has(id)));
      await this.#save(userId, { topics: made, overrides, mark, computedAt: this.now().toISOString() });
      return { status: "ready", made: true };
    } catch (error) {
      await this.audit("memory.topics.failed", error);
      return { status: "stale", made: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------- the researcher's word

  /** @param {string} id */
  static #valid(id) {
    return TOPIC_ID.test(String(id ?? ""));
  }

  /**
   * Rename a topic. The name is the researcher's from then on: a regrouping keeps it.
   * @param {string} userId @param {string} id @param {string} label @returns {Promise<boolean>} whether the topic exists
   */
  async rename(userId, id, label) {
    const name = excerpt(label, TOPIC_LIMITS.label);
    if (!name || !MemoryTopics.#valid(id)) return false;
    const row = await this.#row(userId);
    if (!row.topics.some((/** @type {any} */ topic) => topic.id === id)) return false;
    await this.#save(userId, { overrides: { ...row.overrides, renamed: { ...row.overrides.renamed, [id]: name } } });
    return true;
  }

  /**
   * Say two topics are one: `id`'s memories join `into`, and `id` is gone from the page.
   * @param {string} userId @param {string} id @param {string} into @returns {Promise<boolean>}
   */
  async merge(userId, id, into) {
    if (!MemoryTopics.#valid(id) || !MemoryTopics.#valid(into) || id === into) return false;
    const row = await this.#row(userId);
    const has = (/** @type {string} */ topic) => row.topics.some((/** @type {any} */ item) => item.id === topic);
    if (!has(id) || !has(into)) return false;
    // A merge that would close a loop is the same two topics as before; refuse it rather than drop both.
    let at = into;
    for (let step = 0; step < 64 && row.overrides.merged?.[at]; step += 1) at = /** @type {string} */ (row.overrides.merged?.[at]);
    if (at === id) return false;
    await this.#save(userId, { overrides: { ...row.overrides, merged: { ...row.overrides.merged, [id]: into } } });
    return true;
  }

  /**
   * Say a topic is wrong: it is gone from the page, and a regrouping is told not to bring it back.
   * @param {string} userId @param {string} id @returns {Promise<boolean>}
   */
  async dismiss(userId, id) {
    if (!MemoryTopics.#valid(id)) return false;
    const row = await this.#row(userId);
    const topic = row.topics.find((/** @type {any} */ item) => item.id === id);
    if (!topic) return false;
    const dismissed = [...(row.overrides.dismissed ?? []).filter((item) => item.id !== id), { id, label: row.overrides.renamed?.[id] ?? topic.label }].slice(-40);
    await this.#save(userId, { overrides: { ...row.overrides, dismissed } });
    return true;
  }

  /**
   * Say a memory is not about a topic: it stays out of it, through every regrouping.
   * @param {string} userId @param {string} id @param {string} recordId @returns {Promise<boolean>}
   */
  async removeMember(userId, id, recordId) {
    if (!MemoryTopics.#valid(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(String(recordId ?? ""))) return false;
    const row = await this.#row(userId);
    if (!row.topics.some((/** @type {any} */ topic) => topic.id === id)) return false;
    const removed = { ...row.overrides.removed, [id]: [...new Set([...(row.overrides.removed?.[id] ?? []), recordId])].slice(-200) };
    await this.#save(userId, { overrides: { ...row.overrides, removed } });
    return true;
  }
}
