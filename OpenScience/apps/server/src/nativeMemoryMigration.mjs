import { createHash } from "node:crypto";
import { maskIdentifiers } from "@evimed/domain";
import { contentHash } from "./nativeMemoryOverlay.mjs";

/**
 * An account's PostgreSQL memory records, carried over to OpenViking's native engine (`scripts/ops/memory-engine.mjs --migrate`).
 *
 * Measured on v0.5.0 (`lab/memory/RESULTS.md` §3, §7.5): a memory written straight into the engine with `content/write create`
 * has no type and no tags, and the engine's later extraction never updates it — so a record is never written as a file. The
 * engine is told what the person had said, the way a conversation tells it: one migration session per (kind, project), whose
 * messages state the records in the person's own words with their dates, then a commit. The engine's extraction writes the
 * files (typed, tagged, in the places it keeps updating); the diff it leaves is read back, and each record is looked for in
 * what was written. That check is a report, not a gate: a record the engine worded differently is listed as "not found
 * verbatim" beside the files its group produced, for the operator to read, and nothing is rewritten or retried to make it
 * match.
 *
 * What is carried: active records of the person's own words and what was inferred from them. What is not, and is counted by
 * reason: records the person marked sensitive (they stay in PostgreSQL, out of recall), superseded, archived or pending ones,
 * expired or invalidated ones, run summaries, and what the platform wrote about itself (`origin: system`). PostgreSQL's rows
 * are kept for the fallback window; the capsule's facts are not touched (the capsule stays the platform's, and its subtree is
 * excluded from native recall by the gateway).
 *
 * @module nativeMemoryMigration
 */

/** The legacy kinds that are a person's memory. A run summary is the platform's record of work, not a thing to remember. */
export const MIGRATED_KINDS = Object.freeze(["profile", "preference", "behavior", "correction", "decision", "follow_up", "project_fact", "analysis"]);
/** The kinds a person's own project owns: their sessions carry the project, and the files written are tagged with it. */
const PROJECT_KINDS = new Set(["project_fact", "decision", "follow_up", "analysis"]);

const LABELS = Object.freeze({
  zh: { profile: "个人情况", preference: "偏好", behavior: "习惯", correction: "纠正", decision: "决定", follow_up: "待跟进的事", project_fact: "项目里的事实", analysis: "分析要点" },
  en: { profile: "about me", preference: "preferences", behavior: "habits", correction: "corrections", decision: "decisions", follow_up: "things to follow up", project_fact: "facts about my work", analysis: "points of the analysis" },
});

/** Most characters of one message of a migration session, and of one record in it. */
const MESSAGE_LIMIT = 4_000;
const RECORD_LIMIT = 600;

/** @param {unknown} value */
const day = (value) => {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

/** Whether the records are mostly written in Chinese: the frame sentence follows the language the person used. @param {readonly string[]} texts */
function writtenInChinese(texts) {
  const joined = texts.join("");
  if (!joined) return true;
  const han = (joined.match(/\p{Script=Han}/gu) ?? []).length;
  return han / joined.length > 0.2;
}

/**
 * Why a record is not carried, or null when it is.
 * @param {any} record @param {number} nowMs
 * @returns {"sensitive" | "inactive" | "expired" | "kind" | "system" | "empty" | null}
 */
export function notMigratedBecause(record, nowMs) {
  if (record.sensitive === true) return "sensitive";
  if (!MIGRATED_KINDS.includes(record.kind)) return "kind";
  if (record.origin === "system") return "system";
  if (record.status !== "active") return "inactive";
  if (record.invalidSince && Date.parse(record.invalidSince) <= nowMs) return "expired";
  if (record.expiresAt && Date.parse(record.expiresAt) <= nowMs) return "expired";
  if (!String(record.value ?? "").trim()) return "empty";
  return null;
}

/**
 * The plan: the sessions to run, with the messages each states, and what is left out by reason. Pure, so a dry run asks the
 * engine nothing.
 * @param {readonly any[]} records the account's records (`listAllRecords`)
 * @param {{ now?: Date }} [options]
 */
export function planMigration(records, { now = new Date() } = {}) {
  /** @type {Record<string, number>} */
  const skipped = {};
  /** @type {Map<string, { kind: string, projectId: string | null, records: any[] }>} */
  const groups = new Map();
  for (const record of records) {
    const why = notMigratedBecause(record, now.getTime());
    if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
    const projectId = record.scope === "project" && PROJECT_KINDS.has(record.kind) && record.scopeId ? String(record.scopeId) : null;
    const key = `${record.kind}\u0000${projectId ?? ""}`;
    const group = groups.get(key) ?? { kind: record.kind, projectId, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const sessions = [];
  for (const group of [...groups.values()].sort((left, right) => `${left.kind}${left.projectId}`.localeCompare(`${right.kind}${right.projectId}`))) {
    const ordered = group.records.slice().sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
    const chinese = writtenInChinese(ordered.map((record) => String(record.value)));
    const label = LABELS[chinese ? "zh" : "en"][/** @type {keyof typeof LABELS.zh} */ (group.kind)] ?? group.kind;
    const frame = chinese ? `以下是我之前说过、请长期记住的${label}（括号里是当时的日期）：` : `These are my ${label}, told to you earlier and worth remembering long term (dates in brackets):`;
    /** @type {{ text: string, recordIds: string[] }[]} */
    const messages = [];
    let current = { text: frame, recordIds: /** @type {string[]} */ ([]) };
    for (const record of ordered) {
      const when = day(record.lastConfirmedAt ?? record.updatedAt ?? record.createdAt);
      // The same masking every captured message gets at the gateway: an identifier-shaped span never reaches the engine.
      const line = `\n- ${maskIdentifiers(String(record.value).replace(/\s+/g, " ").trim().slice(0, RECORD_LIMIT))}${when ? `（${when}）` : ""}`;
      if (current.text.length + line.length > MESSAGE_LIMIT && current.recordIds.length) {
        messages.push(current);
        current = { text: frame, recordIds: [] };
      }
      current.text += line;
      current.recordIds.push(String(record.id));
    }
    if (current.recordIds.length) messages.push(current);
    sessions.push({
      session: `evimed-migrate-${createHash("sha256").update(`${group.kind}\u0000${group.projectId ?? ""}`).digest("hex").slice(0, 12)}`,
      kind: group.kind, projectId: group.projectId, records: ordered.length, messages,
      statements: ordered.map((record) => ({ id: String(record.id), value: String(record.value) })),
    });
  }
  const carried = sessions.reduce((total, session) => total + session.records, 0);
  return { sessions, carried, skipped, total: records.length };
}

/** Whitespace-collapsed, lower-cased, without bullets and as-of dates: what two renderings of one statement share. @param {unknown} text */
const flat = (text) => String(text ?? "").replace(/[（(]as of \d{4}-\d{2}-\d{2}[)）]/gi, " ").replace(/[（(]\d{4}-\d{2}-\d{2}[)）]/g, " ")
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Which records the engine wrote verbatim into the files its extraction produced. Containment of the whole statement, nothing
 * looser: whether a paraphrase says the same thing is for the operator reading the report.
 * @param {readonly { id: string, value: string }[]} records @param {readonly string[]} writtenTexts the text of every file the group's diff added or updated
 */
export function verifyAgainstWritten(records, writtenTexts) {
  const haystack = writtenTexts.map(flat).join("\n");
  const found = [];
  const notFound = [];
  for (const record of records) {
    const needle = flat(maskIdentifiers(String(record.value).replace(/\s+/g, " ").trim().slice(0, RECORD_LIMIT)));
    (needle && haystack.includes(needle) ? found : notFound).push(String(record.id));
  }
  return { found, notFound };
}

/**
 * Run the plan against the engine, one session at a time, and read each commit's diff back.
 *
 * Idempotent in the way that matters: a session whose commit the ledger already holds as `migration` for this account is not
 * run again, so a second `--apply` (after a stop, or a failed group) does the groups that are missing and no others. A group
 * that failed is reported and left to be asked again; the engine's own failure marker is read, and nothing is replayed here
 * (the replay belongs to the worker, and a migration that cannot finish is the operator's to look at).
 *
 * @param {{ sessions: import("./openVikingSessions.mjs").OpenVikingSessions, overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay,
 *   worker: import("./nativeMemoryWorker.mjs").NativeMemoryWorker, sleep?: (ms: number) => Promise<void>, now?: () => number }} dependencies
 * @param {string} userId @param {ReturnType<typeof planMigration>} plan
 * @param {{ waitMs?: number, pollMs?: number }} [options]
 */
export async function runMigration({ sessions, overlay, worker, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }, userId, plan, { waitMs = 240_000, pollMs = 2_000 } = {}) {
  if (await sessions.register(userId)) await overlay.noteRegistered(userId);
  const root = sessions.memoryRoot(userId);
  /** @type {any[]} */
  const groups = [];
  for (const planned of plan.sessions) {
    const report = { session: planned.session, kind: planned.kind, projectId: planned.projectId, records: planned.records, state: "pending", files: /** @type {string[]} */ ([]), found: 0, notFoundVerbatim: /** @type {string[]} */ ([]), error: "" };
    groups.push(report);
    try {
      // What an earlier run left: a group whose extraction completed (itself, or through the worker's replay) is done; one
      // still extracting is waited for rather than asked twice; one that failed is set aside and run again, so the worker's
      // replay does not make the same statements twice.
      const earlier = await overlay.commitsOfSession(userId, planned.session);
      let done = false;
      for (const row of earlier) {
        if (row.state === "completed") done = true;
        else if (row.state === "replayed" && row.replayedAs && (await overlay.commit(userId, row.replayedAs))?.state === "completed") done = true;
        else if (row.state === "failed" || row.state === "replayed") await overlay.abandonCommit(userId, row.archiveUri, "set aside by a later migration run");
      }
      if (done) { report.state = "already_done"; continue; }
      await sessions.createSession(userId, planned.session, { timeoutMs: sessions.timeoutMs });
      const held = await sessions.readSession(userId, planned.session).catch(() => null);
      if (!(Number(held?.result?.message_count) > 0)) {
        for (const message of planned.messages) await sessions.addMessage(userId, planned.session, { role: "user", parts: [{ type: "text", text: message.text }] });
      }
      const answer = await sessions.commit(userId, planned.session);
      const result = answer?.result ?? {};
      if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw new Error(`the commit was not accepted (${String(result.status ?? "no status")})`);
      await overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: planned.session, projectId: planned.projectId, origin: "migration",
        taskId: typeof result.task_id === "string" ? result.task_id : null });
      const deadline = now() + waitMs;
      /** @type {any} */
      let diff = null;
      for (;;) {
        await worker.processCommits({ userId });
        const row = await overlay.commit(userId, result.archive_uri);
        if (row?.state === "completed") {
          const text = await sessions.read(userId, `${result.archive_uri}/memory_diff.json`);
          try { diff = text ? JSON.parse(text) : null; } catch { diff = null; }
          break;
        }
        if (row?.state === "failed" || row?.state === "abandoned") throw new Error(`the engine's extraction failed: ${row.error || "no reason given"}`);
        if (now() > deadline) throw new Error("the extraction did not finish in time; run the migration again to pick it up");
        await sleep(pollMs);
      }
      const operations = [...(diff?.operations?.adds ?? []), ...(diff?.operations?.updates ?? [])];
      const written = operations.map((operation) => ({ uri: String(operation?.uri ?? ""), after: String(operation?.after ?? "") })).filter((entry) => entry.uri.startsWith(`${root}/`));
      const checked = verifyAgainstWritten(planned.statements, written.map((entry) => entry.after));
      report.files = written.map((entry) => entry.uri.slice(root.length + 1));
      report.found = checked.found.length;
      report.notFoundVerbatim = checked.notFound;
      report.state = "migrated";
    } catch (error) {
      report.state = "failed";
      report.error = String(/** @type {any} */ (error)?.message ?? error).slice(0, 300);
    }
  }
  const failed = groups.filter((group) => group.state === "failed").length;
  if (!failed) await overlay.noteMigrated(userId);
  return { groups, failed, migrated: groups.filter((group) => group.state === "migrated").length, alreadyDone: groups.filter((group) => group.state === "already_done").length };
}

/** A fingerprint of what a plan would say, for the report: the same records give the same value. @param {ReturnType<typeof planMigration>} plan */
export function planFingerprint(plan) {
  return contentHash(JSON.stringify(plan.sessions.map((session) => [session.session, session.statements.map((statement) => statement.id)])));
}
