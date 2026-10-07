#!/usr/bin/env node
/**
 * Bring the display type of every knowledge-base document up to the one list
 * of types (2026-10-07, `@evimed/domain`'s `sourceVocabulary.mjs`).
 *
 * Until then the first pass read a file's format and name and called every PDF
 * or Word file a 「已发表论文」, every table 「队列数据」, and a file with
 * `review` or `方案` in its name a peer review or a protocol. The knowledge
 * base is for whatever a researcher hands EviMed, so a policy, a drug label and
 * a contract were all papers on the page.
 *
 *   node scripts/ops/reclassify-sources.mjs                         # report only
 *   node scripts/ops/reclassify-sources.mjs --apply                 # write the types
 *   node scripts/ops/reclassify-sources.mjs --user <id> [--limit 1000] [--no-judge] [--apply]
 *
 * For each live document whose type nobody decided — the researcher did not
 * set it (`override`), the judge did not name it from the text
 * (`typeClassification`) — it
 *
 * - asks the J7 judge, on the stored text (its name and opening 1,500
 *   characters; a fraction of a cent) and records the type it settles on;
 * - or, when the judge does not settle, cannot be asked (a table, an image, a
 *   note, no stored text, `--no-judge`) or the stored type is one the list no
 *   longer has, sets the type its format says (`sourceFirstPassType`): a PDF
 *   is a 「文档」, a spreadsheet a 「数据表」, never a paper by default.
 *
 * What it never does: re-run an understanding (paid), re-read a file, change
 * its depth or status, or touch its content. The understanding a document
 * already has keeps the type it was read under; only the type the page shows
 * changes, and a 「重新读取」 reads it under the new one. A document the
 * researcher set the type of, or one the judge already named, is left as it is.
 *
 * Idempotent: a document the run decided carries `typeClassification` and is
 * not asked again, so a second run reports nothing to do — except documents
 * the judge could not be asked about the first time, which are the only ones a
 * second run adds. The output is one JSON object of counts, and per document
 * the type before and after, never a word of what a document says.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SOURCE_TYPES, sourceFirstPassType, sourceOriginOf } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The formats whose text the judge reads: the ones the control plane asks it about when it parses them. */
const JUDGED_FORMAT = /\.(?:pdf|docx?|odt|rtf|md|txt|html?|epub)$/i;

/** @param {string[]} argv */
export function parseArguments(argv) {
  let apply = false;
  let judge = true;
  let userId = null;
  let limit = 1000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--no-judge") judge = false;
    else if (argument === "--user" || argument === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--user") userId = value;
      else {
        limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error("--limit must be an integer between 1 and 100000");
      }
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return { apply, judge, userId, limit };
}

/**
 * The documents whose type nobody decided, oldest first: no override, no
 * judged or reviewed type — or a type the list no longer has.
 * @param {any} database @param {{ userId: string | null, limit: number }} options
 */
async function candidates(database, { userId, limit }) {
  const result = await database.query(`SELECT user_id, id, project_id FROM evimed_product.documents
    WHERE kind='source' AND deleted_at IS NULL AND ($1::text IS NULL OR user_id=$1)
      AND (coalesce(payload->>'docType','') <> ALL($3::text[])
        OR (coalesce(payload->'override','null'::jsonb)='null'::jsonb AND coalesce(payload->'typeClassification'->>'origin','')=''))
    ORDER BY user_id, created_at, id LIMIT $2`, [userId, limit, [...SOURCE_TYPES]]);
  return result.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), sourceId: String(row.id), projectId: String(row.project_id) }));
}

/**
 * @param {any} database
 * @param {{ apply: boolean, userId: string | null, limit: number, judge?: ((request: { userId: string, projectId: string, sourceId: string, filename: string, text: string, docType: string }) => Promise<string | null>) | null,
 *   now?: () => Date, sources?: any }} options
 *   `judge` names the type from the stored text, or null when it does not settle; absent, nothing is asked.
 */
export async function reclassifySources(database, { apply, userId, limit, judge = null, now = () => new Date(), sources = null }) {
  const { migrateProductStore } = await import("../../apps/server/src/productPersistence.mjs");
  const { ProductDocuments } = await import("../../apps/server/src/productStore.mjs");
  const { SourceService } = await import("../../apps/server/src/sourceService.mjs");
  await migrateProductStore(database);
  const documents = new ProductDocuments(database);
  // Nothing is queued: stored text and records are only read.
  const service = sources ?? new SourceService(documents, { enqueue: async () => null });
  const found = await candidates(database, { userId, limit });
  const totals = { applied: apply, documents: found.length, judged: 0, format: 0, unchanged: 0, skipped: 0, failed: 0,
    items: /** @type {any[]} */ ([]) };
  for (const candidate of found) {
    const item = { ...candidate, before: /** @type {string | null} */ (null), after: /** @type {string | null} */ (null),
      by: /** @type {string | null} */ (null), error: /** @type {string | null} */ (null) };
    try {
      const source = await service.get(candidate.userId, candidate.sourceId);
      const payload = source.payload;
      item.before = typeof payload.docType === "string" ? payload.docType : null;
      const file = String(payload.paths?.[0] ?? "");
      const note = sourceOriginOf({ connectorType: payload.connector?.type, path: file }) === "note";
      let docType = null;
      if (judge && JUDGED_FORMAT.test(file) && !note) {
        const capture = await service.loadCapture(candidate.userId, source).catch(() => null);
        const text = String(capture?.input?.text ?? "");
        if (text) {
          const named = await judge({ ...candidate, filename: file, text: text.slice(0, 1500), docType: item.before ?? "other" });
          // The judge's 「其他」 only says it could not tell, which the format's own type says better.
          if (named && SOURCE_TYPES.includes(named) && !(named === "other" && sourceFirstPassType(file).docType !== "other")) docType = named;
        }
      }
      const by = docType ? "judge" : "format";
      if (!docType) docType = sourceFirstPassType(file).docType;
      item.after = docType;
      item.by = by;
      if (docType === item.before && payload.typeClassification?.origin) { totals.unchanged += 1; totals.items.push(item); continue; }
      if (apply) {
        await documents.put(candidate.userId, "source", source.id, { ...payload, docType,
          typeClassification: { origin: by, generation: payload.generation ?? null, reclassifiedAt: now().toISOString() },
          updatedAt: now().toISOString() }, { expectedRevision: source.revision, projectId: source.projectId });
      }
      if (by === "judge") totals.judged += 1; else totals.format += 1;
    } catch (error) {
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "reclassify_failed";
      // A document that moved meanwhile is the next run's: nothing here is urgent.
      if (code === "product_revision_conflict") totals.skipped += 1; else totals.failed += 1;
      item.error = code;
    }
    totals.items.push(item);
  }
  return totals;
}

/** The control-plane database, from the same sources the server reads it from. */
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
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    /** @type {any} */
    let judge = null;
    if (options.judge) {
      const [{ loadConfig }, { createJudgeService }, { UsageLedger }] = await Promise.all([
        import("../../apps/server/src/config.mjs"),
        import("../../apps/server/src/judgeService.mjs"),
        import("../../apps/server/src/usageLedger.mjs"),
      ]);
      const service = createJudgeService({ config: loadConfig(), usageLedger: new UsageLedger(database), database });
      judge = async (/** @type {any} */ request) => {
        try {
          const result = await service.judge("J7", { filename: request.filename, text: request.text, types: [...SOURCE_TYPES] },
            { userId: request.userId, projectId: request.projectId, taskId: `reclassify-${request.sourceId}`, module: "source", regexBaseline: { docType: request.docType } });
          return ["settled", "escalated"].includes(result?.outcome) ? String(result.value?.docType ?? "") || null : null;
        } catch { return null; }
      };
    }
    const report = await reclassifySources(database, { ...options, judge });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`reclassify_sources_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
