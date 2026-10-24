#!/usr/bin/env node
/**
 * Put away what the platform learned about features it no longer has.
 *
 * A learned method, a capability handbook and a handbook candidate are text a run is told to follow, learnt from a run at a time
 * when the platform did things it has since stopped doing: the clinical package's six bookkeeping files and the checks that read
 * them (ruling 2026-09-17), the count of submissions a run was held to, the paired evaluation of a method (2026-10-10). Nothing
 * swept them when a ruling removed a feature, so on production sixteen handbooks and eight methods went on telling runs to write
 * files nobody reads any more, and were mounted into runs until their own runs showed harm — which a method that merely wastes a
 * run's time never does (audit 2026-10-23, B defect 4).
 *
 * What counts as stale is the domain's closed list of retired features (`@evimed/domain` `retiredFeatures.mjs`): a lesson whose
 * text names one of them by its literal name. Nothing here reads what a lesson means.
 *
 *   node scripts/ops/learning-sweep.mjs --user <userId>              # report what would be put away, and why
 *   node scripts/ops/learning-sweep.mjs --all                        # the report for every account that holds any
 *   node scripts/ops/learning-sweep.mjs --user <userId> --apply      # put it away
 *   node scripts/ops/learning-sweep.mjs --user <userId> --restore    # give back everything this script put away
 *
 * Three kinds of record, each put away the way the page's own 「不再使用」 does: a learned method is retired (`LearningService`), a
 * capability handbook is stopped (`HandbookLibrary`), and a handbook candidate — which is never in force, only waiting to become a
 * handbook — is marked retired and closed (`rejected`, `stale_feature`) so the handbook loop does not take it up again. The
 * candidates the handbook loop has already applied are put away too: the active handbook is their one copy (same title, same text),
 * and they are what made the page read as duplicates. Every revision is kept, `--restore` returns each record to the state it had
 * before, and the report and the audit line carry ids, titles and the closed feature names, never a body.
 * Uses the configuration the server runs with.
 *
 * @module scripts/ops/learning-sweep
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/** What is written on a record this script put away (the reader's sentence; `--restore` recognises its own work by it). */
export const STALE_REASON = "讲的是平台已经取消的功能，已自动停用；需要时可以恢复。";
/** And on a handbook candidate that was already applied as a handbook: its one copy is the handbook. */
export const APPLIED_REASON = "已经成为能力手册，这份候选已收起。";
/** The code the disposition of a closed candidate carries. */
export const STALE_CODE = "stale_feature";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { user: "", all: false, apply: false, restore: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    if (argument === "--restore") { options.restore = true; continue; }
    if (argument === "--all") { options.all = true; continue; }
    if (argument !== "--user") throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--user needs a value");
    options.user = value;
    index += 1;
  }
  if (!options.user && !options.all) throw new Error("give --user <id>, or --all for the report");
  if (options.user && options.all) throw new Error("--user and --all are two runs");
  if (options.all && (options.apply || options.restore)) throw new Error("--apply and --restore name one account: give --user <id>");
  if (options.apply && options.restore) throw new Error("--apply and --restore are two runs");
  return options;
}

/**
 * Every page of a listing.
 * @param {(cursor: string | null) => Promise<{ items?: any[], nextCursor?: string | null }>} page
 * @returns {Promise<any[]>}
 */
async function every(page) {
  /** @type {any[]} */
  const items = [];
  let cursor = null;
  for (let turn = 0; turn < 50; turn += 1) {
    const result = await page(cursor);
    items.push(...(result.items ?? []));
    cursor = result.nextCursor ?? null;
    if (!cursor) break;
  }
  return items;
}

/** @param {any} document @returns {string} what the page calls it */
const titleOf = (document) => String(document.payload?.display?.title ?? document.payload?.frontmatter?.name ?? document.id);

/**
 * @typedef {object} Finding
 * @property {"method" | "handbook" | "handbook-candidate"} kind
 * @property {string} id
 * @property {string} title
 * @property {string} code  `stale_feature`, or `applied` for a candidate the handbook loop already applied
 * @property {string[]} features  the closed names of the retired features it names
 */

/**
 * What of an account's learned text names a feature the platform no longer has, and which handbook candidates the handbook loop
 * has applied. Reads; changes nothing.
 * @param {{ documents: any, retiredFeaturesOfMethod: (method: any) => { feature: string }[] }} dependencies
 * @param {string} userId
 * @returns {Promise<{ findings: Finding[], documents: Map<string, any> }>}
 */
export async function findStale({ documents, retiredFeaturesOfMethod }, userId) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Map<string, any>} */
  const held = new Map();
  /** @param {any} document @returns {boolean} */
  const retired = (document) => document.payload?.status === "retired";
  /** @param {string} recordType @param {string} [status] */
  const records = (recordType, status) => every((cursor) => documents.list(userId, "method", { limit: 100, cursor, filter: { recordType, ...(status ? { status } : {}) } }));
  for (const [kind, recordType, status] of /** @type {const} */ ([
    ["method", "learned-method", "approved"], ["handbook", "capability-handbook", "active"], ["handbook-candidate", "handbook-candidate", undefined],
  ])) {
    for (const document of await records(recordType, status)) {
      if (retired(document)) continue;
      const features = [...new Set(retiredFeaturesOfMethod(document.payload).map((hit) => hit.feature))];
      const applied = kind === "handbook-candidate" && document.payload?.dispositions?.[document.payload?.contentDigest]?.disposition === "applied";
      if (!features.length && !applied) continue;
      held.set(document.id, document);
      findings.push({ kind, id: document.id, title: titleOf(document), code: features.length ? STALE_CODE : "applied", features });
    }
  }
  return { findings, documents: held };
}

/**
 * The sweep of one account: the report, then (with `apply`) the retirement, then (with `restore`) the way back.
 * @param {{ documents: any, learning: any, handbooks: any, retiredFeaturesOfMethod: (method: any) => { feature: string }[], now?: () => Date, audit?: ((event: string, detail: Record<string, unknown>) => unknown) | null }} dependencies
 * @param {{ user: string, apply?: boolean, restore?: boolean }} options
 */
export async function sweepAccount({ documents, learning, handbooks, retiredFeaturesOfMethod, now = () => new Date(), audit = null }, options) {
  const userId = options.user;
  /** @param {string} event @param {Record<string, unknown>} detail */
  const say = async (event, detail) => { try { await audit?.(event, { userId, ...detail }); } catch { /* an audit line never decides */ } };
  if (options.restore) {
    /** @type {{ kind: string, id: string, title: string }[]} */
    const restored = [];
    for (const [kind, recordType] of /** @type {const} */ ([["method", "learned-method"], ["handbook", "capability-handbook"], ["handbook-candidate", "handbook-candidate"]])) {
      for (const document of await every((cursor) => documents.list(userId, "method", { limit: 100, cursor, filter: { recordType, status: "retired" } }))) {
        const reason = document.payload?.statusReason;
        if (reason !== STALE_REASON && reason !== APPLIED_REASON) continue;
        // The revision before the stop, as the page's own restore names it (「已忘记的内容」 sends `revision - 1`).
        if (kind === "method") await learning.rollback(userId, document.id, { expectedRevision: document.revision, targetRevision: document.revision - 1 });
        else if (kind === "handbook") await handbooks.rollback(userId, document.id, { expectedRevision: document.revision, targetRevision: document.revision - 1 });
        else await restoreCandidate(documents, userId, document);
        restored.push({ kind, id: document.id, title: titleOf(document) });
      }
    }
    await say("learning.sweep.restore", { code: `restored:${restored.length}` });
    return { mode: "restore", restored: restored.length, items: restored };
  }
  const { findings, documents: held } = await findStale({ documents, retiredFeaturesOfMethod }, userId);
  if (options.apply) {
    for (const finding of findings) {
      const document = held.get(finding.id);
      const reason = finding.code === STALE_CODE ? STALE_REASON : APPLIED_REASON;
      if (finding.kind === "method") await learning.retire(userId, finding.id, { expectedRevision: document.revision, reason });
      else if (finding.kind === "handbook") await handbooks.retire(userId, finding.id, { expectedRevision: document.revision, reason });
      else await closeCandidate(documents, userId, document, { reason, stale: finding.code === STALE_CODE, at: now().toISOString() });
    }
    await say("learning.sweep.apply", { code: `retired:${findings.length}` });
  }
  return {
    mode: options.apply ? "apply" : "report",
    [options.apply ? "retired" : "wouldRetire"]: findings.length,
    byKind: findings.reduce((totals, finding) => ({ ...totals, [finding.kind]: (totals[finding.kind] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    items: findings,
  };
}

/**
 * A handbook candidate put away: marked retired with the reason written on it, and — when it is stale — closed so the handbook loop
 * does not take it up again (`HandbookConsolidation.reconcile` skips a terminal disposition).
 * @param {any} documents @param {string} userId @param {any} document @param {{ reason: string, stale: boolean, at: string }} change
 */
async function closeCandidate(documents, userId, document, { reason, stale, at }) {
  const payload = document.payload;
  const dispositions = stale
    ? { ...(payload.dispositions ?? {}), [payload.contentDigest]: { disposition: "rejected", reason: STALE_CODE, at } }
    : payload.dispositions;
  await documents.put(userId, "method", document.id, {
    ...payload, status: "retired", statusReason: reason, statusChangedAt: at, ...(dispositions ? { dispositions } : {}),
  }, { expectedRevision: document.revision });
}

/**
 * A handbook candidate given back: the newest state it had that was not retired, saved forward.
 * @param {any} documents @param {string} userId @param {any} current
 */
async function restoreCandidate(documents, userId, current) {
  const history = await documents.history(userId, "method", current.id, { limit: 100 });
  const saved = (Array.isArray(history) ? history : history?.items ?? []).find((entry) => !entry.deletedAt && entry.payload?.status !== "retired");
  if (!saved) throw new Error(`no earlier state of ${current.id} to give back`);
  await documents.put(userId, "method", current.id, { ...saved.payload }, { expectedRevision: current.revision });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { LearningService }, { HandbookLibrary }, { retiredFeaturesOfMethod }, { securityAudit }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/learningService.mjs"),
    import("../../apps/server/src/handbookLibrary.mjs"),
    import("@evimed/domain"),
    import("../../apps/server/src/security.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const documents = new ProductDocuments(database);
    const learning = new LearningService({ documents });
    const handbooks = new HandbookLibrary({ learning });
    const audit = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) => securityAudit(config, event, "recorded", detail);
    const users = options.all
      ? (await database.query("SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind='method' AND deleted_at IS NULL ORDER BY user_id")).rows.map((/** @type {any} */ row) => String(row.user_id))
      : [options.user];
    /** @type {any[]} */
    const reports = [];
    for (const user of users) {
      const report = await sweepAccount({ documents, learning, handbooks, retiredFeaturesOfMethod, audit }, { user, apply: options.apply, restore: options.restore });
      if (options.all && !report.items?.length) continue;
      reports.push({ user, ...report });
    }
    process.stdout.write(`${JSON.stringify(options.all ? { accounts: reports } : reports[0], null, 2)}\n`);
  } finally {
    await database?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`learning-sweep: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
