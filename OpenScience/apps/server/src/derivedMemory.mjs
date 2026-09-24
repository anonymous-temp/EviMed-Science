/**
 * Memory derived from a knowledge-base document, or from a project, goes when
 * they go (plan 2026-09-23 §5.6, 修漏洞).
 *
 * Hidden knowledge:
 *
 * - The 「来自资料」 memories are capsule entries (`fact` product documents)
 *   that `LibraryService.publishSourceUnderstanding` writes into the account's
 *   own capsule. The capsule is account-level (`project_id` NULL), so neither
 *   deleting the document nor deleting its project reached them: on 2026-09-23
 *   production held 62 of them whose documents had long been deleted.
 * - Their derivation is recorded twice, and this module keys on both, never on
 *   the entry's text:
 *     1. the publication ledger — one `preferences` record per document,
 *        `recordType: "source-publication"`, whose `entries` map names every
 *        capsule entry that document's understanding put in the capsule. An
 *        entry whose understanding carried no anchor has no provenance at all
 *        (`libraryCapsuleEntries`), so the ledger is the only record of it;
 *     2. each anchored entry's provenance, `{ type: "source", id:
 *        "src_<32 hex>#<start>-<end>" }`. The id names a span, not the
 *        document — which is why the source deletion's own statement, matching
 *        `{ type: "source", id: "src_<32 hex>" }` exactly, never matched one.
 * - A note a run wrote with no provenance of its own names its project instead
 *   (`{ type: "source", id: "runtime-project:<project>" }`, `CapsuleService.note`),
 *   and every document a project holds carries the project in its row.
 * - Withdrawn means: soft-deleted (`deleted_at`), marked `status: "retired"`,
 *   and stamped `withdrawn: { reason, sourceId | projectId, at }`, as one
 *   revision recorded in `evimed_product.revisions`. Deleted rather than only
 *   retired because nothing about it is the researcher's to undo — the document
 *   it came from is gone — and a retired entry would sit in 「已忘记的内容」
 *   beside the things they chose to forget. The row keeps the text for the
 *   audit trail; no list, recall or share reads a deleted row.
 * - The recall index follows the way it follows every other forget: the update
 *   fires `product_documents_memory_index_outbox`, which queues a rebuild of
 *   the entry's capsule, and the rebuild publishes only approved, undeleted
 *   entries. Until it runs, a stale hit is dropped by the hydration re-check
 *   (`MemoryIndexing.recall` reads `deleted_at IS NULL` and `status`).
 * - The ledger is emptied, not deleted: `entries` becomes `{}` and the ledger
 *   says what was withdrawn. A ledger that still listed withdrawn entries would
 *   make a later publication of the same document keep nothing, since
 *   publishing never re-adds what the ledger says is already there.
 *
 * @module derivedMemory
 */

/** The personal library's record of what one document put in the capsule. */
export const SOURCE_PUBLICATION_RECORD_TYPE = "source-publication";

/** The provenance id of a note whose writer named no provenance of its own. */
export const RUNTIME_PROJECT_PROVENANCE_PREFIX = "runtime-project:";

/**
 * Why a memory was withdrawn: its document or project was deleted just now,
 * the orphan sweep found it pointing at one that no longer exists, or its
 * document was published again under a newer rule
 * (`scripts/ops/republish-source-memory.mjs`).
 */
export const DERIVED_MEMORY_WITHDRAWAL_REASONS = Object.freeze([
  "source_deleted", "project_deleted", "source_missing", "project_missing", "source_republished",
]);

/**
 * The capsule layer only a document's publication writes
 * (`LibraryService.publishSourceUnderstanding`). The capsule's own routes
 * refuse it, a share never carries it (`NEVER_SHARED_LAYERS`) and no method
 * mount reads it, so an entry in it is one a document yielded.
 */
export const DOCUMENT_MEMORY_LAYER = "sources";

/**
 * The project each of these document-derived capsule entries belongs to,
 * for the entries that do not say so themselves.
 *
 * An entry published since 2026-09-24 carries its document and project
 * (`payload.sourceId`, `payload.projectId`). One published before names its
 * document only through the publication ledger that lists it, or through the
 * anchors in its provenance; its project is that document's. Read here at
 * recall time rather than written back, so there is no migration to run and
 * nothing to get out of step: the ledger is already the record the withdrawal
 * keys on. An entry no ledger and no anchor names is absent from the answer,
 * and its caller treats it as belonging to no project.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any> } | null | undefined} database
 * @param {string} userId @param {readonly string[]} entryIds
 * @returns {Promise<Map<string, string>>} entry id → project id
 */
export async function documentEntryProjects(database, userId, entryIds) {
  /** @type {Map<string, string>} */
  const projects = new Map();
  const ids = [...new Set((entryIds ?? []).map(String))];
  if (!database || ids.length === 0) return projects;
  const result = await database.query(`WITH named AS (
      SELECT e.value AS entry_id, l.payload->>'sourceId' AS source_id, 0 AS rank
        FROM evimed_product.documents l
        CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(l.payload->'entries')='object' THEN l.payload->'entries' ELSE '{}'::jsonb END) e
       WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL AND l.payload->>'recordType'=$3::text
         AND e.value=ANY($2::text[])
      UNION ALL
      SELECT d.id, split_part(p->>'id','#',1), 1
        FROM evimed_product.documents d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'provenance')='array' THEN d.payload->'provenance' ELSE '[]'::jsonb END) p
       WHERE d.user_id=$1 AND d.kind='fact' AND d.id=ANY($2::text[]) AND p->>'type'='source' AND p->>'id' ~ '^src_[a-f0-9]{32}#'
    )
    SELECT DISTINCT ON (n.entry_id) n.entry_id, s.project_id
      FROM named n JOIN evimed_product.documents s ON s.user_id=$1 AND s.kind='source' AND s.id=n.source_id
     WHERE s.project_id IS NOT NULL
     ORDER BY n.entry_id, n.rank, s.deleted_at NULLS FIRST`, [userId, ids, SOURCE_PUBLICATION_RECORD_TYPE]);
  for (const row of result.rows ?? []) projects.set(String(row.entry_id), String(row.project_id));
  return projects;
}

const SOURCE_ID = /^src_[a-f0-9]{32}$/;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** One page of orphans per sweep; the next cycle takes the rest. */
const SWEEP_LIMIT_MAX = 500;

/**
 * The capsule entries a scope reaches, locked for the update that withdraws
 * them. Shared by the withdrawal and by the sweep's report, so what is counted
 * is what is withdrawn.
 *
 * $1 user, $2 source ids, $3 project id or NULL, $4 ledger record type,
 * $5 runtime-note provenance prefix.
 */
const TARGET_ENTRIES = `
  SELECT d.id FROM evimed_product.documents d
   WHERE d.user_id=$1 AND d.kind='fact' AND d.deleted_at IS NULL
     AND (
       d.id IN (
         SELECT e.value FROM evimed_product.documents l,
           jsonb_each_text(CASE WHEN jsonb_typeof(l.payload->'entries')='object' THEN l.payload->'entries' ELSE '{}'::jsonb END) e
          WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL
            AND l.payload->>'recordType'=$4::text AND l.payload->>'sourceId'=ANY($2::text[]))
       OR d.payload->>'sourceId'=ANY($2::text[])
       OR ($3::text IS NOT NULL AND d.project_id=$3)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'provenance')='array' THEN d.payload->'provenance' ELSE '[]'::jsonb END) p
          WHERE p->>'type'='source'
            AND (split_part(p->>'id','#',1)=ANY($2::text[]) OR ($3::text IS NOT NULL AND p->>'id'=($5::text || $3::text))))
     )`;

/** @param {unknown} reason */
function assertReason(reason) {
  if (!DERIVED_MEMORY_WITHDRAWAL_REASONS.includes(String(reason))) {
    throw new TypeError(`Unknown derived-memory withdrawal reason: ${String(reason)}`);
  }
  return String(reason);
}

/**
 * Withdraw, inside the caller's transaction, every capsule entry derived from
 * one of `sourceIds` or from `projectId`, and empty those documents'
 * publication ledgers.
 *
 * Idempotent: a withdrawn entry is deleted and a withdrawn ledger is empty, so
 * running it again finds nothing. Scoped to one account by construction — every
 * statement names the owner.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any> }} client a transaction client
 * @param {string} userId
 * @param {{ sourceIds?: readonly string[], projectId?: string | null, reason: string }} scope
 * @returns {Promise<{ entries: number, ledgers: number }>}
 */
export async function withdrawDerivedMemory(client, userId, { sourceIds = [], projectId = null, reason }) {
  const why = assertReason(reason);
  const sources = [...new Set((sourceIds ?? []).map(String).filter((id) => SOURCE_ID.test(id)))];
  const project = projectId == null ? null : String(projectId);
  if (project != null && !PROJECT_ID.test(project)) throw new TypeError("Invalid project id for a derived-memory withdrawal.");
  if (sources.length === 0 && project == null) return { entries: 0, ledgers: 0 };
  // The account row before any document, the order account deletion takes
  // them in: the update below fires the index outbox trigger, whose job row
  // references the account, so without this a concurrent account deletion
  // and this withdrawal would acquire the pair in opposite orders.
  await client.query("SELECT 1 FROM evimed_control.users WHERE id=$1 FOR KEY SHARE", [userId]);
  const marker = JSON.stringify({
    reason: why,
    ...(project != null ? { projectId: project } : sources.length === 1 ? { sourceId: sources[0] } : {}),
  });
  const entries = await client.query(`WITH targets AS (${TARGET_ENTRIES} ORDER BY d.id FOR UPDATE),
    changed AS (
      UPDATE evimed_product.documents d SET
        payload=d.payload || jsonb_build_object('status','retired','withdrawn',$6::jsonb || jsonb_build_object('at',clock_timestamp())),
        deleted_at=clock_timestamp(),revision=d.revision+1,updated_at=clock_timestamp()
        FROM targets WHERE d.user_id=$1 AND d.kind='fact' AND d.id=targets.id
        RETURNING d.user_id,d.kind,d.id,d.revision,d.payload,d.deleted_at
    ) INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at)
      SELECT user_id,kind,id,revision,payload,deleted_at FROM changed RETURNING id`,
  [userId, sources, project, SOURCE_PUBLICATION_RECORD_TYPE, RUNTIME_PROJECT_PROVENANCE_PREFIX, marker]);
  const ledgers = sources.length === 0 ? { rowCount: 0 } : await client.query(`WITH changed AS (
      UPDATE evimed_product.documents l SET
        payload=l.payload || jsonb_build_object('entries','{}'::jsonb,'withdrawn',$4::jsonb || jsonb_build_object(
          'at',clock_timestamp(),'entries',(SELECT count(*) FROM jsonb_object_keys(l.payload->'entries')))),
        revision=l.revision+1,updated_at=clock_timestamp()
       WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL
         AND l.payload->>'recordType'=$3::text AND l.payload->>'sourceId'=ANY($2::text[])
         AND jsonb_typeof(l.payload->'entries')='object' AND l.payload->'entries'<>'{}'::jsonb
       RETURNING l.user_id,l.kind,l.id,l.revision,l.payload,l.deleted_at
    ) INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at)
      SELECT user_id,kind,id,revision,payload,deleted_at FROM changed RETURNING id`,
  [userId, sources, SOURCE_PUBLICATION_RECORD_TYPE, marker]);
  return { entries: Number(entries.rowCount ?? 0), ledgers: Number(ledgers.rowCount ?? 0) };
}

/**
 * Everything derived from a project that is about to be deleted: the entries
 * published from any document it ever held (a deleted one included — its
 * entries may predate this module), its runs' notes, and the entries in its own
 * capsules. Run inside the transaction that deletes the project, before the
 * delete, so the two commit together; the cascade then removes what lived in
 * the project, and the update here is what tells the recall index.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any> }} client
 * @param {string} userId @param {string} projectId
 * @param {{ reason?: string }} [options]
 */
export async function withdrawProjectDerivedMemory(client, userId, projectId, { reason = "project_deleted" } = {}) {
  const sources = await client.query(`SELECT id FROM evimed_product.documents
    WHERE user_id=$1 AND kind='source' AND project_id=$2 ORDER BY id`, [userId, String(projectId)]);
  return withdrawDerivedMemory(client, userId, {
    sourceIds: sources.rows.map((/** @type {any} */ row) => row.id), projectId, reason,
  });
}

/**
 * What still points at a document or a project that no longer exists: the
 * sweep's work list, without changing anything.
 *
 * A document counts as gone when its source row is absent (its project was
 * deleted and the row went with it) or soft-deleted; a project, when its row
 * is absent. Only live entries and non-empty ledgers are looked at, so a
 * withdrawn one never reappears here.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any> }} database
 * @param {{ limit?: number, userId?: string | null }} [options]
 * @returns {Promise<{ sources: { userId: string, sourceId: string }[], projects: { userId: string, projectId: string }[] }>}
 */
export async function findOrphanedDerivedMemory(database, { limit = 100, userId = null } = {}) {
  const bound = Math.max(1, Math.min(SWEEP_LIMIT_MAX, Math.trunc(Number(limit)) || 100));
  const sources = await database.query(`WITH named AS (
      SELECT d.user_id, split_part(p->>'id','#',1) AS source_id
        FROM evimed_product.documents d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'provenance')='array' THEN d.payload->'provenance' ELSE '[]'::jsonb END) p
       WHERE d.kind='fact' AND d.deleted_at IS NULL AND d.payload @> '{"provenance":[{"type":"source"}]}'::jsonb
         AND p->>'type'='source' AND ($3::text IS NULL OR d.user_id=$3)
      UNION
      SELECT l.user_id, l.payload->>'sourceId' FROM evimed_product.documents l
       WHERE l.kind='preferences' AND l.deleted_at IS NULL AND l.payload->>'recordType'=$2::text
         AND jsonb_typeof(l.payload->'entries')='object' AND l.payload->'entries'<>'{}'::jsonb
         AND ($3::text IS NULL OR l.user_id=$3)
    )
    SELECT DISTINCT n.user_id, n.source_id FROM named n
     WHERE n.source_id ~ '^src_[a-f0-9]{32}$'
       AND NOT EXISTS (SELECT 1 FROM evimed_product.documents s
         WHERE s.user_id=n.user_id AND s.kind='source' AND s.id=n.source_id AND s.deleted_at IS NULL)
     ORDER BY n.user_id, n.source_id LIMIT $1`, [bound, SOURCE_PUBLICATION_RECORD_TYPE, userId]);
  const projects = await database.query(`WITH named AS (
      SELECT DISTINCT d.user_id, substr(p->>'id', length($2::text) + 1) AS project_id
        FROM evimed_product.documents d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'provenance')='array' THEN d.payload->'provenance' ELSE '[]'::jsonb END) p
       WHERE d.kind='fact' AND d.deleted_at IS NULL AND d.payload @> '{"provenance":[{"type":"source"}]}'::jsonb
         AND p->>'type'='source' AND starts_with(p->>'id', $2::text) AND ($3::text IS NULL OR d.user_id=$3)
    )
    SELECT n.user_id, n.project_id FROM named n
     WHERE n.project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'
       AND NOT EXISTS (SELECT 1 FROM evimed_control.projects x WHERE x.user_id=n.user_id AND x.id=n.project_id)
     ORDER BY n.user_id, n.project_id LIMIT $1`, [bound, RUNTIME_PROJECT_PROVENANCE_PREFIX, userId]);
  return {
    sources: sources.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), sourceId: String(row.source_id) })),
    projects: projects.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), projectId: String(row.project_id) })),
  };
}

/**
 * How many live entries and non-empty ledgers a scope reaches — exactly what
 * `withdrawDerivedMemory` would change — without changing anything.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any> }} database
 * @param {string} userId
 * @param {{ sourceIds?: readonly string[], projectId?: string | null }} scope
 * @returns {Promise<{ entries: number, ledgers: number }>}
 */
export async function countDerivedMemory(database, userId, { sourceIds = [], projectId = null }) {
  const sources = [...new Set((sourceIds ?? []).map(String).filter((id) => SOURCE_ID.test(id)))];
  const project = projectId == null ? null : String(projectId);
  if (sources.length === 0 && project == null) return { entries: 0, ledgers: 0 };
  const entries = await database.query(`SELECT count(*)::integer AS count FROM (${TARGET_ENTRIES}) targets`,
    [userId, sources, project, SOURCE_PUBLICATION_RECORD_TYPE, RUNTIME_PROJECT_PROVENANCE_PREFIX]);
  const ledgers = sources.length === 0 ? null : await database.query(`SELECT count(*)::integer AS count FROM evimed_product.documents l
    WHERE l.user_id=$1 AND l.kind='preferences' AND l.deleted_at IS NULL
      AND l.payload->>'recordType'=$3::text AND l.payload->>'sourceId'=ANY($2::text[])
      AND jsonb_typeof(l.payload->'entries')='object' AND l.payload->'entries'<>'{}'::jsonb`,
  [userId, sources, SOURCE_PUBLICATION_RECORD_TYPE]);
  return { entries: Number(entries.rows[0]?.count ?? 0), ledgers: Number(ledgers?.rows[0]?.count ?? 0) };
}

/**
 * The orphan sweep: withdraw what `findOrphanedDerivedMemory` lists, one
 * document or project per transaction, each re-checked inside it — a document
 * or project that exists again by then is left alone. Idempotent, bounded by
 * `limit` per kind, and safe to run beside the server: a withdrawal locks what
 * it changes, and a row somebody else withdrew first is simply not found.
 *
 * `apply: false` reports the work list, with what each item would withdraw,
 * and changes nothing.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<any>, transaction: (operation: (client: any) => Promise<any>) => Promise<any> }} database
 * @param {{ limit?: number, userId?: string | null, apply?: boolean }} [options]
 * @returns {Promise<{ applied: boolean, sources: number, projects: number, entries: number, ledgers: number,
 *   orphans: Array<{ userId: string, sourceId?: string, projectId?: string, entries: number, ledgers: number }> }>}
 */
export async function withdrawOrphanedDerivedMemory(database, { limit = 100, userId = null, apply = true } = {}) {
  const found = await findOrphanedDerivedMemory(database, { limit, userId });
  const totals = { sources: 0, projects: 0, entries: 0, ledgers: 0 };
  /** @type {Array<{ userId: string, sourceId?: string, projectId?: string, entries: number, ledgers: number }>} */
  const orphans = [];
  const work = [
    ...found.sources.map((orphan) => ({ orphan, scope: { sourceIds: [orphan.sourceId] }, reason: "source_missing",
      live: ["SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 AND deleted_at IS NULL FOR SHARE", orphan.sourceId] })),
    // Only what names the project: no source of a missing project is still in
    // the database, and none of its rows either — the cascade took them.
    ...found.projects.map((orphan) => ({ orphan, scope: { projectId: orphan.projectId }, reason: "project_missing",
      live: ["SELECT 1 FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR SHARE", orphan.projectId] })),
  ];
  for (const { orphan, scope, reason, live } of work) {
    const result = apply
      ? await database.transaction(async (/** @type {any} */ client) => {
        const exists = await client.query(live[0], [orphan.userId, live[1]]);
        if (exists.rowCount) return null;
        return withdrawDerivedMemory(client, orphan.userId, { ...scope, reason });
      })
      : await countDerivedMemory(database, orphan.userId, scope);
    if (!result) continue;
    orphans.push({ ...orphan, ...result });
    if ("sourceId" in orphan) totals.sources += 1;
    else totals.projects += 1;
    totals.entries += result.entries;
    totals.ledgers += result.ledgers;
  }
  return { applied: apply, ...totals, orphans };
}
