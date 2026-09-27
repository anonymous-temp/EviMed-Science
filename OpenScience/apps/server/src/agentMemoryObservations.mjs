/**
 * Habits learned from prescription edits, without a runtime.
 *
 * The TCM CDSS plan's learning signal is the one place its pipeline holds both
 * the candidate formula and the one the doctor sends: 「在处方审核环节提取"候选方—
 * 医生调整后处方"的差异，用于归纳用药习惯」. Every learning trigger we had was
 * anchored on one of our runs, and distillation is a capability run inside our
 * runtime; a prescription edit has no run, and the CDSS deployment has no
 * runtime (CDSS gap 3). So this path is kernel-free:
 *
 *  1. **Observe.** An integrator posts one edit: the syndrome, optionally the
 *     lineage chosen, and what changed — herbs replaced, added, removed, by
 *     name. Nothing else is accepted: no patient field, and no dose — a herb
 *     name cannot carry a digit, and an unknown field is refused, so a dose has
 *     nowhere to go (「涉及剂量的模式一律不沉淀为习惯」). A change naming a toxic
 *     herb (clinical-safety-rules.json `tcmToxicHerbs`) is kept aside, counted
 *     for the dashboard's 「不学习」 line, and never learned from.
 *  2. **Count, in code.** For the syndrome just observed, each change is
 *     counted across that doctor's most recent related edits. A change seen at
 *     least three times and in at least half of them is a habit. The counts are
 *     never the model's and never typed into prose: they are recomputed when
 *     the dashboard reads them (「在 12 次改方中出现 9 次」).
 *  3. **Word it, once.** One model call through the gateway writes the line a
 *     doctor reads — no numbers, and it must name the herbs and the syndrome it
 *     is about, or a fixed sentence is used instead: the habit stands whether or
 *     not the wording pass does (principle 19).
 *  4. **Write it to the method ledger** the learning loop uses
 *     (`LearningService.createCandidate`), so it is recalled, shown, stopped
 *     and rolled back exactly like a method learned from research — effective
 *     at once and 「新」, by the ledger's own verdict. A habit whose share falls
 *     below half its threshold over enough later edits is retired, with the
 *     reason said. A retired habit is not revived by counting: that is the
 *     doctor's act (restore), not ours.
 *
 * A doctor who paused learning is observed not at all.
 *
 * @module agentMemoryObservations
 */

import { createHash } from "node:crypto";

import { METHOD_SKILL_SCHEMA, TCM_TOXIC_HERBS, cleanMethodDisplay, hasSensitiveText, matchedTcmToxicHerbs } from "@evimed/domain";

import { learnedMethodId } from "./learningService.mjs";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { HttpError } from "./security.mjs";

/** A change must be seen this many times, in at least this share of the
 *  recent related edits, to be a habit. */
export const HABIT_MIN_OCCURRENCES = 3;
export const HABIT_MIN_SHARE = 0.5;
/** How many of a doctor's most recent edits under one syndrome are counted. */
export const HABIT_WINDOW = 30;
/** How many observations one account keeps; older ones are deleted. */
export const OBSERVATION_RETENTION = 500;

/**
 * Herbs a habit is never learned about: the toxic Chinese herbs of
 * `packages/domain/src/clinical-safety-rules.json` (`tcmToxicHerbs`), the same
 * pharmacist-maintained rows the extraction checkpoint and the capsule import
 * scan read (`matchedTcmToxicHerbs`). One list, so a herb a pharmacist adds is
 * never learned about, held for its owner and flagged on import alike. Each
 * row carries every name the herb is written under (制附子 is 附子; 白附子 is its
 * own row).
 */
export const NEVER_LEARNED_HERBS = Object.freeze(TCM_TOXIC_HERBS.map((row) => row.nameZh));

/** A herb's name: letters of any script, and no digit — a dose cannot ride in one. */
const HERB_PATTERN = /^[\p{Script=Han}A-Za-z·（）()]{1,24}$/u;
const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The change kinds an edit is described by. */
export const OBSERVATION_CHANGE_TYPES = Object.freeze(["replace", "add", "remove"]);
const CHANGE_TYPES = OBSERVATION_CHANGE_TYPES;
/** The fields an observation may carry, and nothing else. */
export const OBSERVATION_FIELDS = Object.freeze(["observationId", "syndrome", "lineage", "stage", "changes"]);

const migrations = new WeakMap();
const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_agent;
CREATE TABLE IF NOT EXISTS evimed_agent.observations (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 128),
  syndrome text NOT NULL CHECK (char_length(syndrome) BETWEEN 1 AND 64),
  lineage text CHECK (lineage IS NULL OR char_length(lineage) BETWEEN 1 AND 64),
  stage text NOT NULL,
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  never_learned jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(never_learned) = 'array'),
  observed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS agent_observations_syndrome_idx ON evimed_agent.observations(user_id, syndrome, observed_at DESC);
`;

/** @param {any} database */
export async function migrateAgentObservations(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-agent-observations-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; } catch (error) { migrations.delete(database); throw error; }
  return attempt;
}

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/** @param {unknown} value @param {string} field @param {number} max */
function label(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || [...text].length > max || [...text].some((character) => character.charCodeAt(0) < 32)) {
    throw new HttpError(400, "agent_observation_invalid", `${field} must be 1–${max} characters.`);
  }
  if (/\d/.test(text)) throw new HttpError(400, "agent_observation_invalid", `${field} carries a number; an observation carries names only.`);
  if (hasSensitiveText(text)) throw new HttpError(400, "agent_observation_invalid", `${field} carries an identifier; an observation carries no patient information.`);
  return text;
}

/** @param {unknown} value @param {string} field */
function herb(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!HERB_PATTERN.test(text)) {
    throw new HttpError(400, "agent_observation_invalid", `${field} must be a herb's name: 1–24 letters, no digits (a dose is never observed).`);
  }
  return text;
}

/** Whether a herb name is one of the toxic herbs. @param {string} name */
export function neverLearned(name) {
  return matchedTcmToxicHerbs(name).length > 0;
}

/**
 * One change as a stable key: what is counted.
 * @param {{ type: string, from?: string, to?: string, herb?: string }} change
 */
export function changeKey(change) {
  return change.type === "replace" ? `replace:${change.from}>${change.to}` : `${change.type}:${change.herb}`;
}

/** The herbs a change names. @param {any} change @returns {string[]} */
function herbsOf(change) {
  return change.type === "replace" ? [change.from, change.to] : [change.herb];
}

/**
 * An observation, checked field by field, split into what may be learned from
 * and what never is.
 * @param {any} body
 */
export function readObservation(body) {
  const allowed = OBSERVATION_FIELDS;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "agent_observation_invalid", "The request body must be an object.");
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new HttpError(400, "agent_observation_invalid",
      `Unsupported field(s): ${unknown.sort().join(", ")}. An observation carries a syndrome, a lineage and herb names — no dose and no patient field.`);
  }
  const observationId = body.observationId == null ? null : String(body.observationId);
  if (observationId !== null && !OBSERVATION_ID_PATTERN.test(observationId)) {
    throw new HttpError(400, "agent_observation_invalid", "observationId must be 1–128 letters, digits and . _ : -.");
  }
  const stage = body.stage == null ? "M04" : String(body.stage);
  if (stage !== "M04") throw new HttpError(400, "agent_observation_invalid", "Only prescription edits (stage M04) are observed.");
  if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > 30) {
    throw new HttpError(400, "agent_observation_invalid", "changes must list 1–30 changes.");
  }
  /** @type {any[]} */
  const changes = [];
  /** @type {any[]} */
  const kept = [];
  for (const [index, raw] of body.changes.entries()) {
    const field = `changes[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !CHANGE_TYPES.includes(raw.type)) {
      throw new HttpError(400, "agent_observation_invalid", `${field}.type must be one of ${CHANGE_TYPES.join(", ")}.`);
    }
    const keys = raw.type === "replace" ? ["type", "from", "to"] : ["type", "herb"];
    const extra = Object.keys(raw).filter((key) => !keys.includes(key));
    if (extra.length) throw new HttpError(400, "agent_observation_invalid", `${field} carries ${extra.sort().join(", ")}; a change is herb names only — a dose is never observed.`);
    const change = raw.type === "replace"
      ? { type: "replace", from: herb(raw.from, `${field}.from`), to: herb(raw.to, `${field}.to`) }
      : { type: raw.type, herb: herb(raw.herb, `${field}.herb`) };
    if (change.type === "replace" && change.from === change.to) throw new HttpError(400, "agent_observation_invalid", `${field} replaces a herb with itself.`);
    if (kept.includes(changeKey(change))) continue;
    kept.push(changeKey(change));
    changes.push(change);
  }
  const learnable = changes.filter((change) => !herbsOf(change).some(neverLearned));
  const never = changes.filter((change) => herbsOf(change).some(neverLearned))
    .map((change) => ({ ...change, reason: "toxic" }));
  return {
    observationId,
    syndrome: label(body.syndrome, "syndrome", 64),
    lineage: body.lineage == null ? null : label(body.lineage, "lineage", 64),
    stage,
    changes: learnable,
    neverLearned: never,
  };
}

/** The method name of the habit one change under one syndrome is.
 * @param {string} syndrome @param {any} change */
export function habitName(syndrome, change) {
  return `habit-${sha256(`${syndrome}\u0000${changeKey(change)}`).slice(0, 16)}`;
}

/**
 * The habits a doctor's recent edits under one syndrome show, counted.
 * @param {{ syndrome: string, lineage: string | null, changes: any[] }[]} related newest first
 * @returns {{ change: any, key: string, observed: number, related: number, share: number, lineage: string | null }[]}
 */
export function countHabits(related) {
  const window = related.slice(0, HABIT_WINDOW);
  /** @type {Map<string, { change: any, observed: number, lineages: Map<string, number> }>} */
  const seen = new Map();
  for (const observation of window) {
    for (const change of observation.changes) {
      const key = changeKey(change);
      const entry = seen.get(key) ?? { change, observed: 0, lineages: new Map() };
      entry.observed += 1;
      if (observation.lineage) entry.lineages.set(observation.lineage, (entry.lineages.get(observation.lineage) ?? 0) + 1);
      seen.set(key, entry);
    }
  }
  return [...seen.entries()].map(([key, entry]) => {
    const lineage = [...entry.lineages.entries()].sort((left, right) => right[1] - left[1])[0];
    return {
      change: entry.change, key, observed: entry.observed, related: window.length,
      share: window.length ? entry.observed / window.length : 0,
      // The lineage a habit belongs to, when most of its edits were made under one.
      lineage: lineage && lineage[1] * 2 > entry.observed ? lineage[0] : null,
    };
  }).sort((left, right) => right.observed - left.observed || left.key.localeCompare(right.key));
}

/** @param {{ observed: number, share: number }} count */
function isHabit(count) {
  return count.observed >= HABIT_MIN_OCCURRENCES && count.share >= HABIT_MIN_SHARE;
}

/** @param {{ observed: number, related: number, share: number }} count */
function faded(count) {
  return count.related >= HABIT_MIN_OCCURRENCES * 2 && count.share < HABIT_MIN_SHARE / 2;
}

/** The line a doctor reads when the wording pass cannot write one. @param {string} syndrome @param {any} change */
export function templateDisplay(syndrome, change) {
  if (change.type === "replace") return { title: `${syndrome}：${change.to}易${change.from}`, summary: `${syndrome}的候选方中，你常以${change.to}替代${change.from}。` };
  if (change.type === "add") return { title: `${syndrome}：常加${change.herb}`, summary: `${syndrome}的候选方中，你常加用${change.herb}。` };
  return { title: `${syndrome}：常去${change.herb}`, summary: `${syndrome}的候选方中，你常去掉${change.herb}。` };
}

/**
 * The method a habit is: a SKILL.md written from the counted facts, never from
 * the model's words, so its digest does not move when a count does.
 * @param {string} syndrome @param {any} change @param {string | null} lineage @param {{ title: string, summary: string }} display
 */
export function habitMethod(syndrome, change, lineage, display) {
  const act = change.type === "replace" ? `以${change.to}替代${change.from}` : change.type === "add" ? `考虑加用${change.herb}` : `考虑去掉${change.herb}`;
  const when = `候选方的主证为“${syndrome}”${lineage ? `，所选诊疗思路为“${lineage}”` : ""}时`;
  return {
    frontmatter: {
      name: habitName(syndrome, change),
      description: `医生本人的用药习惯：${syndrome}的候选方中${act}。只影响加减建议的排序，不改变任何安全判断。`,
      whenToUse: `${when}。`,
      metadata: {
        role: "atomic",
        applies_when: `${when}。`,
        not_when: "主证不符；或安全审核提示禁忌、特殊人群、剂量问题时。",
        derived_from: "prescription-edits",
        evimed_schema: METHOD_SKILL_SCHEMA,
      },
    },
    body: [
      "## Purpose", display.summary, "",
      "## When to Use", `${when}。`, "",
      "## Inputs", "候选方的药味与主证。", "",
      "## Workflow", `1. 核对主证为“${syndrome}”。`, `2. ${act}，作为加减建议中靠前的一项，并说明依据是该医生本人的改方习惯。`, "",
      "## Verification", "- 调整后的候选方仍须经过安全审核与药事审方。", "",
      "## Constraints", "- 只影响候选的排序与加减建议，不改变任何安全判断。", "- 不涉及剂量，不涉及毒性药。", "",
      "## Output", "带加减建议的候选方。",
    ].join("\n"),
  };
}

const WRITER_INSTRUCTIONS = [
  "你为一位中医医生的一条用药习惯写一个标题和一句说明，显示在他的「我的用药习惯」看板上。",
  "习惯是系统从他本人对候选方的调整中数出来的；你只负责把它说成医生看得懂的一句话。",
  "标题不超过 20 个字，说明不超过 60 个字；必须写出证候和涉及的药名，原样照写；不要出现任何数字、次数或百分比，不要写剂量，不要写「该习惯」「系统」之类的套话。",
  "只输出 JSON：{\"title\": \"...\", \"summary\": \"...\"}。",
].join("");

/** The one wording pass, through the model gateway and metered as learning. */
export class HabitWriter {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof callModelForControlPlane }} [options]
   */
  constructor(config, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane } = {}) {
    this.config = config;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * The line, re-verified: within the limits, no digit, and naming the
   * syndrome and every herb of the change. A line that fails any of these is
   * dropped, never softened; the caller then uses `templateDisplay`.
   * @param {{ userId: string, projectId: string }} owner @param {string} syndrome @param {any} change
   * @returns {Promise<{ title: string, summary: string } | null>}
   */
  async write(owner, syndrome, change) {
    if (!this.available) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId: owner.userId, projectId: owner.projectId, purpose: "learning", signal: controller.signal,
        body: {
          model: this.config.deepseekModel, temperature: 0, thinking: { type: "disabled" }, max_tokens: 1_000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: WRITER_INSTRUCTIONS },
            { role: "user", content: JSON.stringify({ syndrome, change }) },
          ],
        },
      });
      let parsed = null;
      try { parsed = JSON.parse(String(body?.choices?.[0]?.message?.content ?? "")); } catch { parsed = null; }
      const display = cleanMethodDisplay(parsed);
      if (!display) return null;
      const text = `${display.title}${display.summary}`;
      if (/\d/.test(text) || !text.includes(syndrome) || herbsOf(change).some((name) => !text.includes(name))) return null;
      return display;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Observations, counted habits and the method ledger, per account. */
export class AgentObservations {
  /**
   * @param {{ database: any, learning: any, researchMemory?: any, writer?: HabitWriter | null, now?: () => Date }} dependencies
   */
  constructor({ database, learning, researchMemory = null, writer = null, now = () => new Date() }) {
    this.database = database;
    this.learning = learning;
    this.researchMemory = researchMemory;
    this.writer = writer;
    this.now = now;
  }

  /**
   * Record one observation and bring the syndrome's habits up to date.
   * @param {{ id: string }} user @param {ReturnType<typeof readObservation>} observation
   */
  async observe(user, observation) {
    if (this.researchMemory?.configured) {
      const settings = await this.researchMemory.settings(user.id);
      if (settings.learningPaused) return { recorded: false, reason: "paused", habits: [] };
    }
    await migrateAgentObservations(this.database);
    const id = observation.observationId ?? `obs-${sha256(`${user.id}\u0000${this.now().toISOString()}\u0000${JSON.stringify(observation)}`).slice(0, 32)}`;
    const inserted = await this.database.query(`INSERT INTO evimed_agent.observations (user_id,id,syndrome,lineage,stage,changes,never_learned)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT (user_id,id) DO NOTHING`,
    [user.id, id, observation.syndrome, observation.lineage, observation.stage, JSON.stringify(observation.changes), JSON.stringify(observation.neverLearned)]);
    // The same edit posted twice is one edit.
    if (inserted.rowCount !== 1) return { recorded: false, reason: "duplicate", observationId: id, habits: [] };
    await this.database.query(`DELETE FROM evimed_agent.observations WHERE user_id=$1 AND id IN (
      SELECT id FROM evimed_agent.observations WHERE user_id=$1 ORDER BY observed_at DESC, id DESC OFFSET $2)`, [user.id, OBSERVATION_RETENTION]);
    const habits = await this.#settle(user, observation.syndrome);
    return {
      recorded: true, observationId: id,
      learnable: observation.changes.length,
      neverLearned: observation.neverLearned.map(({ reason, ...change }) => ({ ...change, reason })),
      habits,
    };
  }

  /** @param {string} userId @param {string} syndrome */
  async #related(userId, syndrome) {
    const { rows } = await this.database.query(`SELECT syndrome, lineage, changes FROM evimed_agent.observations
      WHERE user_id=$1 AND syndrome=$2 ORDER BY observed_at DESC, id DESC LIMIT $3`, [userId, syndrome, HABIT_WINDOW]);
    return rows.map((/** @type {any} */ row) => ({ syndrome: row.syndrome, lineage: row.lineage ?? null, changes: Array.isArray(row.changes) ? row.changes : [] }));
  }

  /**
   * Learn what now holds and retire what has faded, for one syndrome. A
   * failure on one habit is that habit's, reported, and never the
   * observation's.
   * @param {{ id: string }} user @param {string} syndrome
   */
  async #settle(user, syndrome) {
    const related = await this.#related(user.id, syndrome);
    const counts = countHabits(related);
    // A habit whose change no recent edit shows at all is counted too, as
    // zero: that is the clearest case of one that has faded.
    const counted = new Set(counts.map((count) => learnedMethodId(habitName(syndrome, count.change))));
    const effective = ((await this.learning.listMethods(user.id, { status: "approved", limit: 100 })).items ?? [])
      .filter((/** @type {any} */ document) => document.payload?.provenance?.source === "observations"
        && document.payload?.provenance?.syndrome === syndrome && !counted.has(String(document.id)));
    for (const document of effective) {
      counts.push({ change: document.payload.provenance.change, key: changeKey(document.payload.provenance.change),
        observed: 0, related: Math.min(related.length, HABIT_WINDOW), share: 0, lineage: null });
    }
    /** @type {any[]} */
    const outcome = [];
    for (const count of counts) {
      const id = learnedMethodId(habitName(syndrome, count.change));
      const existing = await this.learning.getMethod(user.id, id).catch((/** @type {any} */ error) => {
        if (error?.code === "method_not_found") return null;
        throw error;
      });
      try {
        if (!existing && isHabit(count)) {
          const display = (this.writer ? await this.writer.write({ userId: user.id, projectId: "default" }, syndrome, count.change) : null)
            ?? templateDisplay(syndrome, count.change);
          const method = habitMethod(syndrome, count.change, count.lineage, display);
          const created = await this.learning.createCandidate(user.id, {
            ...method, projectId: null, display,
            provenance: { origin: "inferred", source: "observations", syndrome, change: count.change },
          }).catch((/** @type {any} */ error) => {
            // A concurrent observation learned it first.
            if (error?.code === "product_revision_conflict") return null;
            throw error;
          });
          if (created) outcome.push({ id: created.id, title: display.title, change: "learned" });
        } else if (existing?.payload?.status === "approved" && existing.payload?.provenance?.source === "observations" && faded(count)) {
          await this.learning.retire(user.id, id, { expectedRevision: existing.revision, reason: "最近的改方里不再这样做" });
          outcome.push({ id, title: cleanMethodDisplay(existing.payload.display)?.title ?? id, change: "retired" });
        }
      } catch (error) {
        outcome.push({ id, change: "failed", code: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "habit_write_failed" });
      }
    }
    return outcome;
  }

  /**
   * What each habit learned from edits was counted from, now: for the
   * dashboard's 「在 12 次改方中出现 9 次」.
   * @param {string} userId @returns {Promise<Map<string, { syndrome: string, observed: number, related: number }>>}
   */
  async basis(userId) {
    await migrateAgentObservations(this.database);
    const { rows } = await this.database.query(`SELECT syndrome, lineage, changes FROM evimed_agent.observations
      WHERE user_id=$1 ORDER BY observed_at DESC, id DESC`, [userId]);
    /** @type {Map<string, any[]>} */
    const bySyndrome = new Map();
    for (const row of rows) {
      bySyndrome.set(row.syndrome, [...(bySyndrome.get(row.syndrome) ?? []), { syndrome: row.syndrome, lineage: row.lineage, changes: row.changes ?? [] }]);
    }
    /** @type {Map<string, { syndrome: string, observed: number, related: number }>} */
    const basis = new Map();
    for (const [syndrome, related] of bySyndrome) {
      for (const count of countHabits(related)) {
        basis.set(learnedMethodId(habitName(syndrome, count.change)), { syndrome, observed: count.observed, related: count.related });
      }
    }
    return basis;
  }

  /**
   * What was never learned from, by herb: the dashboard's 「不学习」 line.
   * @param {string} userId @returns {Promise<{ herb: string, count: number }[]>}
   */
  async neverLearned(userId) {
    await migrateAgentObservations(this.database);
    const { rows } = await this.database.query(`SELECT never_learned FROM evimed_agent.observations WHERE user_id=$1 AND never_learned <> '[]'::jsonb`, [userId]);
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const row of rows) {
      for (const change of row.never_learned ?? []) {
        // By the herb's own name, so 制附子 and 附子 are one line.
        for (const name of new Set(herbsOf(change).flatMap((named) => matchedTcmToxicHerbs(named)))) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([name, count]) => ({ herb: name, count })).sort((left, right) => right.count - left.count || left.herb.localeCompare(right.herb));
  }
}
