#!/usr/bin/env node
/**
 * Whether each account's learning loop is being fed: the evidence it has left, the lessons that came of it, the methods in force.
 *
 *   node scripts/ops/learning-evidence-report.mjs               # every account, a table
 *   node scripts/ops/learning-evidence-report.mjs --user <id>   # one account
 *   node scripts/ops/learning-evidence-report.mjs --json        # the same, as JSON
 *
 * Per account: when it last left learning evidence (a steer, a follow-up judged on the next turn, a result corrected in the page, or the
 * silence of a settled run), how much of each kind in the last 7 and 30 days, the lessons queued and how they ended (30 days), and the learned
 * methods in force. The loop stopped teaching for eleven days (2026-10-12 to 10-23) and nothing said so: an account that works every day and has
 * no evidence for a week is the sign, and this is where an operator reads it. The same numbers are the metrics
 * `open_science_learning_evidence_total`, `open_science_learning_evidence_last_at` and `open_science_learning_lessons_total`.
 *
 * Read-only. Prints counts and times, never a quotation, a rule or a message. Idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY_MS = 86_400_000;
/** The evidence kinds and lesson triggers the report names; anything else is `other`, as the metrics do. */
const KINDS = ["steer", "follow-up", "result-corrected", "silent"];
const TRIGGERS = ["correction", "routine", "repair_accepted", "edit_diff", "delivered"];

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { options.json = true; continue; }
    if (argument === "--user") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user needs a value");
      options.user = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

/** @param {unknown} value @param {readonly string[]} allowed */
const closed = (value, allowed) => (allowed.includes(String(value ?? "")) ? String(value) : "other");

/**
 * One row per account that has left evidence, queued a lesson or holds a learned method.
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} database
 * @param {{ user?: string | null, now?: Date }} [options]
 */
export async function learningEvidenceReport(database, { user = null, now = new Date() } = {}) {
  const owner = user || null;
  const since = (/** @type {number} */ days) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const evidence = (await database.query(`SELECT user_id, coalesce(detail->>'evidence','') AS evidence, coalesce(detail->>'verdict','') AS verdict,
      count(*) FILTER (WHERE occurred_at >= $2::timestamptz)::integer AS d7, count(*) FILTER (WHERE occurred_at >= $3::timestamptz)::integer AS d30,
      max(occurred_at) AS last_at
    FROM evimed_product.feedback_events WHERE trigger_kind='learning-evidence' AND ($1::text IS NULL OR user_id=$1) GROUP BY 1,2,3`,
  [owner, since(7), since(30)])).rows;
  const lessons = (await database.query(`SELECT user_id, coalesce(payload->>'trigger','') AS trigger, status, count(*)::integer AS n,
      coalesce(result->>'operation','') AS operation
    FROM evimed_product.jobs WHERE kind='distill' AND created_at >= $2::timestamptz AND ($1::text IS NULL OR user_id=$1) GROUP BY 1,2,3,5`,
  [owner, since(30)])).rows;
  const methods = (await database.query(`SELECT user_id, count(*)::integer AS n FROM evimed_product.documents
    WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType'='learned-method' AND payload->>'status'='approved' AND ($1::text IS NULL OR user_id=$1) GROUP BY 1`,
  [owner])).rows;

  /** @type {Map<string, any>} */
  const accounts = new Map();
  const account = (/** @type {string} */ id) => {
    if (!accounts.has(id)) {
      accounts.set(id, { user: id, lastEvidenceAt: null, daysSinceEvidence: null,
        evidence7d: Object.fromEntries([...KINDS, "other"].map((kind) => [kind, 0])), evidence30d: Object.fromEntries([...KINDS, "other"].map((kind) => [kind, 0])),
        corrections30d: 0, lessons30d: Object.fromEntries([...TRIGGERS, "other"].map((trigger) => [trigger, 0])), lessonsQueued30d: 0, lessonsDistilled30d: 0,
        lessonsFailed30d: 0, methodsInForce: 0 });
    }
    return accounts.get(id);
  };
  for (const row of evidence) {
    const entry = account(String(row.user_id));
    const kind = closed(row.evidence, KINDS);
    entry.evidence7d[kind] += Number(row.d7);
    entry.evidence30d[kind] += Number(row.d30);
    if (["steer", "result-corrected"].includes(row.evidence) || (row.evidence === "follow-up" && ["correction", "preference", "rejection"].includes(row.verdict))) entry.corrections30d += Number(row.d30);
    const last = row.last_at ? new Date(row.last_at).getTime() : NaN;
    if (Number.isFinite(last) && (!entry.lastEvidenceAt || last > Date.parse(entry.lastEvidenceAt))) {
      entry.lastEvidenceAt = new Date(last).toISOString();
      entry.daysSinceEvidence = Math.floor((now.getTime() - last) / DAY_MS);
    }
  }
  for (const row of lessons) {
    const entry = account(String(row.user_id));
    entry.lessons30d[closed(row.trigger, TRIGGERS)] += Number(row.n);
    entry.lessonsQueued30d += Number(row.n);
    if (row.status === "failed" || row.status === "canceled") entry.lessonsFailed30d += Number(row.n);
    if (row.status === "succeeded" && ["create", "amend", "merge", "handbook"].includes(row.operation)) entry.lessonsDistilled30d += Number(row.n);
  }
  for (const row of methods) account(String(row.user_id)).methodsInForce = Number(row.n);
  return [...accounts.values()].sort((left, right) => (right.lastEvidenceAt ?? "").localeCompare(left.lastEvidenceAt ?? "") || left.user.localeCompare(right.user));
}

/** @param {ReturnType<typeof learningEvidenceReport> extends Promise<infer R> ? R : never} rows @returns {string} */
export function renderReport(rows) {
  if (!rows.length) return "no account has left learning evidence, queued a lesson or holds a learned method\n";
  const sum = (/** @type {Record<string, number>} */ counts) => Object.values(counts).reduce((total, value) => total + value, 0);
  const lines = [["account", "last evidence", "days", "7d (st/fu/rc/si)", "30d (st/fu/rc/si)", "corrected 30d", "lessons 30d", "distilled", "failed", "methods"]];
  for (const row of rows) {
    const split = (/** @type {Record<string, number>} */ counts) => KINDS.map((kind) => counts[kind]).join("/");
    lines.push([row.user, row.lastEvidenceAt ?? "never", row.daysSinceEvidence ?? "-", `${sum(row.evidence7d)} (${split(row.evidence7d)})`, `${sum(row.evidence30d)} (${split(row.evidence30d)})`,
      row.corrections30d, row.lessonsQueued30d, row.lessonsDistilled30d, row.lessonsFailed30d, row.methodsInForce].map(String));
  }
  const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  return `${lines.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n")}\n`;
}

function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { ControlPlaneDatabase } = await import("../../apps/server/src/controlPlaneDatabase.mjs");
  const { migrateProductStore } = await import("../../apps/server/src/productPersistence.mjs");
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(database);
    const rows = await learningEvidenceReport(database, { user: options.user || null });
    process.stdout.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : renderReport(rows));
  } finally { await database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`learning_evidence_report_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
