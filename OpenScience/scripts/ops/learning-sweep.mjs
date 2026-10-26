#!/usr/bin/env node
/**
 * Put away what the platform learned about features it no longer has.
 *
 * A learned method is text a run is told to follow, learnt from a run at a time when the platform did things it has since stopped
 * doing: the clinical package's six bookkeeping files and the checks that read them (ruling 2026-09-17), the count of submissions a
 * run was held to, the paired evaluation of a method (2026-10-10). Nothing swept them when a ruling removed a feature, so on
 * production sixteen handbooks and eight methods went on telling runs to write files nobody reads any more, and were mounted into
 * runs until their own runs showed harm — which a method that merely wastes a run's time never does (audit 2026-10-23, B defect 4).
 * (The handbooks were the capability handbook arm's, deleted on 2026-10-25 with their records; what is left to sweep is the methods.)
 *
 * What counts as stale is the domain's closed list of retired features (`@evimed/domain` `retiredFeatures.mjs`): a lesson whose
 * text names one of them by its literal name. Nothing here reads what a lesson means.
 *
 *   node scripts/ops/learning-sweep.mjs --user <userId>              # report what would be put away, and why
 *   node scripts/ops/learning-sweep.mjs --all                        # the report for every account that holds any
 *   node scripts/ops/learning-sweep.mjs --user <userId> --apply      # put it away
 *   node scripts/ops/learning-sweep.mjs --user <userId> --restore    # give back everything this script put away
 *
 * A method is put away the way the page's own 「不再使用」 does: it is retired (`LearningService`). Every revision is kept, `--restore`
 * returns each method to the state it had before, and the report and the audit line carry ids, titles and the closed feature names,
 * never a body.
 * Uses the configuration the server runs with.
 *
 * @module scripts/ops/learning-sweep
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/** What is written on a record this script put away (the reader's sentence; `--restore` recognises its own work by it). */
export const STALE_REASON = "讲的是平台已经取消的功能，已自动停用；需要时可以恢复。";
/** The code a finding carries. */
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
 * @property {"method"} kind
 * @property {string} id
 * @property {string} title
 * @property {string} code  `stale_feature`
 * @property {string[]} features  the closed names of the retired features it names
 */

/**
 * What of an account's learned methods names a feature the platform no longer has. Reads; changes nothing.
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
  for (const document of await records("learned-method", "approved")) {
    if (retired(document)) continue;
    const features = [...new Set(retiredFeaturesOfMethod(document.payload).map((hit) => hit.feature))];
    if (!features.length) continue;
    held.set(document.id, document);
    findings.push({ kind: "method", id: document.id, title: titleOf(document), code: STALE_CODE, features });
  }
  return { findings, documents: held };
}

/**
 * The sweep of one account: the report, then (with `apply`) the retirement, then (with `restore`) the way back.
 * @param {{ documents: any, learning: any, retiredFeaturesOfMethod: (method: any) => { feature: string }[], audit?: ((event: string, detail: Record<string, unknown>) => unknown) | null }} dependencies
 * @param {{ user: string, apply?: boolean, restore?: boolean }} options
 */
export async function sweepAccount({ documents, learning, retiredFeaturesOfMethod, audit = null }, options) {
  const userId = options.user;
  /** @param {string} event @param {Record<string, unknown>} detail */
  const say = async (event, detail) => { try { await audit?.(event, { userId, ...detail }); } catch { /* an audit line never decides */ } };
  if (options.restore) {
    /** @type {{ kind: string, id: string, title: string }[]} */
    const restored = [];
    for (const document of await every((cursor) => documents.list(userId, "method", { limit: 100, cursor, filter: { recordType: "learned-method", status: "retired" } }))) {
      if (document.payload?.statusReason !== STALE_REASON) continue;
      // The revision before the stop, as the page's own restore names it (「已忘记的内容」 sends `revision - 1`).
      await learning.rollback(userId, document.id, { expectedRevision: document.revision, targetRevision: document.revision - 1 });
      restored.push({ kind: "method", id: document.id, title: titleOf(document) });
    }
    await say("learning.sweep.restore", { code: `restored:${restored.length}` });
    return { mode: "restore", restored: restored.length, items: restored };
  }
  const { findings, documents: held } = await findStale({ documents, retiredFeaturesOfMethod }, userId);
  if (options.apply) {
    for (const finding of findings) {
      const document = held.get(finding.id);
      await learning.retire(userId, finding.id, { expectedRevision: document.revision, reason: STALE_REASON });
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ProductDocuments }, { LearningService }, { retiredFeaturesOfMethod }, { securityAudit }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/productStore.mjs"),
    import("../../apps/server/src/learningService.mjs"),
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
    const audit = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) => securityAudit(config, event, "recorded", detail);
    const users = options.all
      ? (await database.query("SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind='method' AND deleted_at IS NULL ORDER BY user_id")).rows.map((/** @type {any} */ row) => String(row.user_id))
      : [options.user];
    /** @type {any[]} */
    const reports = [];
    for (const user of users) {
      const report = await sweepAccount({ documents, learning, retiredFeaturesOfMethod, audit }, { user, apply: options.apply, restore: options.restore });
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
