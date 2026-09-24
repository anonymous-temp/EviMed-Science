#!/usr/bin/env node
/**
 * Publish every understood knowledge-base document into its researcher's
 * capsule again, under the current publication rule (2026-09-24,
 * `PUBLICATION_RULE` in `libraryService.mjs`): the document's summary and its
 * quote-anchored key claims, at most twelve entries, each stamped with the
 * document and its project — instead of one entry per template field and
 * claim plus the method drafts, unstamped and recalled in every project.
 *
 *   node scripts/ops/republish-source-memory.mjs                  # report only
 *   node scripts/ops/republish-source-memory.mjs --apply          # withdraw and publish again
 *   node scripts/ops/republish-source-memory.mjs --user <id> [--limit 1000] [--apply]
 *
 * For each live source with a current understanding whose publication ledger
 * is not yet at the current rule: withdraw what it published before
 * (`withdrawDerivedMemory`, reason `source_republished` — soft-deleted,
 * retired, recorded as a revision, and out of the recall index through the
 * ordinary outbox), then publish it again through the same path the source
 * worker takes (`LibraryService.publishSourceUnderstanding`).
 *
 * Idempotent: a document published under the current rule carries it on its
 * ledger and is skipped, so a second run reports nothing to do. A document
 * whose publication failed after its withdrawal keeps an old-rule ledger and
 * is taken again by the next run. The withdrawal takes entries the researcher
 * corrected by hand as well; the report counts them (`corrected`) so an
 * operator can see that before applying.
 *
 * It reads and writes only the control-plane database. The output is one JSON
 * object with counts per document — never the memories' text.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleService } from "../../apps/server/src/capsuleService.mjs";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { SOURCE_PUBLICATION_RECORD_TYPE, withdrawDerivedMemory } from "../../apps/server/src/derivedMemory.mjs";
import { LibraryService, PUBLICATION_RULE, describeLibrarySource, libraryCapsuleEntries } from "../../apps/server/src/libraryService.mjs";
import { migrateProductStore } from "../../apps/server/src/productPersistence.mjs";
import { ProductDocuments } from "../../apps/server/src/productStore.mjs";
import { SourceService } from "../../apps/server/src/sourceService.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string[]} argv */
export function parseArguments(argv) {
  let apply = false;
  let userId = null;
  let limit = 1000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--user" || argument === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--user") userId = value;
      else {
        limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("--limit must be an integer between 1 and 10000");
      }
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return { apply, userId, limit };
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

/**
 * The documents to publish again: live sources with a current understanding
 * whose ledger is absent or older than the current rule, oldest first.
 * @param {any} database @param {{ userId: string | null, limit: number }} options
 */
async function candidates(database, { userId, limit }) {
  const result = await database.query(`SELECT s.user_id, s.id, s.project_id FROM evimed_product.documents s
    LEFT JOIN evimed_product.documents l ON l.user_id=s.user_id AND l.kind='preferences' AND l.id='source-publication:' || s.id
      AND l.deleted_at IS NULL AND l.payload->>'recordType'=$3::text
    WHERE s.kind='source' AND s.deleted_at IS NULL AND coalesce(s.payload->>'currentUnderstandingId','')<>''
      AND ($1::text IS NULL OR s.user_id=$1)
      AND (l.id IS NULL OR coalesce((l.payload->>'rule')::integer, 1) < $4::integer)
    ORDER BY s.user_id, s.created_at, s.id LIMIT $2`, [userId, limit, SOURCE_PUBLICATION_RECORD_TYPE, PUBLICATION_RULE]);
  return result.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), sourceId: String(row.id), projectId: String(row.project_id) }));
}

/**
 * What a withdrawal of this document's memory would take, and how much of it
 * the researcher had corrected by hand.
 * @param {any} database @param {string} userId @param {string} sourceId
 */
async function published(database, userId, sourceId) {
  const result = await database.query(`WITH listed AS (
      SELECT e.value AS id FROM evimed_product.documents l
        CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(l.payload->'entries')='object' THEN l.payload->'entries' ELSE '{}'::jsonb END) e
       WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL AND l.id='source-publication:' || $2::text
    )
    SELECT count(*)::integer AS entries, count(*) FILTER (WHERE d.payload ? 'correctedAt')::integer AS corrected
      FROM evimed_product.documents d
     WHERE d.user_id=$1 AND d.kind='fact' AND d.deleted_at IS NULL
       AND (d.id IN (SELECT id FROM listed) OR d.payload->>'sourceId'=$2::text
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'provenance')='array' THEN d.payload->'provenance' ELSE '[]'::jsonb END) p
           WHERE p->>'type'='source' AND split_part(p->>'id','#',1)=$2::text))`, [userId, sourceId]);
  return { entries: Number(result.rows[0]?.entries ?? 0), corrected: Number(result.rows[0]?.corrected ?? 0) };
}

/**
 * @param {any} database
 * @param {{ apply: boolean, userId: string | null, limit: number }} options
 */
export async function republishSourceMemory(database, { apply, userId, limit }) {
  await migrateProductStore(database);
  const documents = new ProductDocuments(database);
  // Nothing is queued: understandings are only read here.
  const sources = new SourceService(documents, { enqueue: async () => null });
  const capsules = new CapsuleService(documents);
  const library = new LibraryService({ documents, sources, capsules,
    libraryDir: () => { throw new Error("A republication writes no library copy."); } });
  const found = await candidates(database, { userId, limit });
  const totals = { applied: apply, rule: PUBLICATION_RULE, documents: found.length, withdrawn: 0, corrected: 0, published: 0, failed: 0,
    items: /** @type {any[]} */ ([]) };
  for (const candidate of found) {
    const before = await published(database, candidate.userId, candidate.sourceId);
    const item = { ...candidate, withdraw: before.entries, corrected: before.corrected, publish: 0, error: /** @type {string | null} */ (null) };
    try {
      const source = await sources.get(candidate.userId, candidate.sourceId);
      const understanding = (await sources.getUnderstanding(candidate.userId, candidate.sourceId)).current;
      if (!understanding) throw Object.assign(new Error("no current understanding"), { code: "library_understanding_missing" });
      item.publish = libraryCapsuleEntries({ title: describeLibrarySource(source).title, sourceId: candidate.sourceId, understanding }).length;
      if (apply) {
        const withdrawn = await database.transaction((/** @type {any} */ client) => withdrawDerivedMemory(client, candidate.userId,
          { sourceIds: [candidate.sourceId], reason: "source_republished" }));
        item.withdraw = withdrawn.entries;
        const result = await library.publishSourceUnderstanding(candidate.userId, candidate.sourceId);
        item.publish = result.added + result.kept;
      }
    } catch (error) {
      item.error = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "republish_failed";
    }
    totals.withdrawn += item.withdraw;
    totals.corrected += item.corrected;
    if (item.error) totals.failed += 1;
    else totals.published += item.publish;
    totals.items.push(item);
  }
  return totals;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const result = await republishSourceMemory(database, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`republish_source_memory_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
