/**
 * The knowledge-base search index: its own schema, derived and rebuildable.
 *
 * Hidden knowledge: everything here is a derivation of rows that live in
 * `evimed_product` (a source's frozen capture) — delete the schema and
 * `pnpm rebuild:kb-index` puts it back. That is why it is its own schema and
 * not more kinds on the product ledger: nothing in it is anyone's record, it is
 * never exported with an account, and it may be emptied at will.
 *
 * A document is keyed by the account, the file's SHA-256, the parser revision
 * it was read under and the digest of the captured text. The first three are
 * the plan's key; the fourth is what makes a hit's offsets true. The same bytes
 * parsed twice by a model-backed service are not guaranteed to come back as the
 * same text, and a hit's `start`/`end` are only valid against the exact text
 * they were computed on — so two captures of one file are two documents.
 *
 * Two legs depend on extensions this database may not have. `pg_trgm` ships
 * with every PostgreSQL build we deploy on but is created here only where it is
 * available; `vector` needs the pgvector image. Each is created if available and
 * the leg that needs it is skipped otherwise — a search without the vector leg
 * says `mode: "keyword"`, it does not fail. Creating an extension needs a
 * privilege the application role may not hold; the host migration creates both
 * as the superuser, and this only notices whether they exist.
 */

const migrations = new WeakMap();

/** The tables every deployment has; the vector column is added below, only
 *  where the extension exists. */
function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_kb;
CREATE TABLE IF NOT EXISTS evimed_kb.documents (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  parser_revision text NOT NULL CHECK (char_length(parser_revision) BETWEEN 1 AND 160),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 1000),
  char_count integer NOT NULL CHECK (char_count >= 0),
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  embedding_model text,
  indexed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, sha256, parser_revision, text_sha256)
);
CREATE TABLE IF NOT EXISTS evimed_kb.chunks (
  user_id text NOT NULL,
  sha256 text NOT NULL,
  parser_revision text NOT NULL,
  text_sha256 text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  page integer,
  heading_path text NOT NULL DEFAULT '',
  context_prefix text NOT NULL DEFAULT '',
  content text NOT NULL,
  lexemes tsvector NOT NULL,
  PRIMARY KEY (user_id, sha256, parser_revision, text_sha256, ordinal),
  FOREIGN KEY (user_id, sha256, parser_revision, text_sha256)
    REFERENCES evimed_kb.documents(user_id, sha256, parser_revision, text_sha256) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS kb_chunks_lexemes_idx ON evimed_kb.chunks USING gin (lexemes);
CREATE INDEX IF NOT EXISTS kb_documents_user_idx ON evimed_kb.documents (user_id, indexed_at DESC);
`;
}

/** @param {any} client @param {string} name */
async function ensureExtension(client, name) {
  const found = await client.query("SELECT default_version, installed_version FROM pg_available_extensions WHERE name=$1", [name]);
  const row = found.rows[0];
  if (!row) return null;
  if (!row.installed_version) {
    // A role without CREATE on the database cannot install it; that is the
    // host migration's job, and until then the leg is skipped, not failed.
    await client.query("SAVEPOINT kb_extension");
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${name === "vector" ? "vector" : "pg_trgm"}`);
      await client.query("RELEASE SAVEPOINT kb_extension");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT kb_extension");
      return null;
    }
  }
  const installed = await client.query("SELECT extversion FROM pg_extension WHERE extname=$1", [name]);
  return installed.rows[0]?.extversion ?? null;
}

/** `0.8.6` → [0, 8, 6]; a version this cannot read compares lowest.
 * @param {string | null} version */
function versionParts(version) {
  return String(version ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * Create or bring up to date the index schema, and say which legs it supports.
 *
 * Idempotent and serialized by an advisory lock, like every other schema this
 * control plane owns. A vector column of another width than the pin's is
 * dropped and re-created — its vectors cannot be compared with the new model's
 * — and every document is marked as needing vectors again.
 *
 * @param {any} database
 * @param {{ dimension: number }} options
 * @returns {Promise<{ vector: boolean, vectorVersion: string | null, iterativeScan: boolean, trigram: boolean }>}
 */
export async function migrateKnowledgeBaseIndex(database, { dimension }) {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 2000) throw new TypeError("The embedding dimension is invalid.");
  const cached = migrations.get(database);
  if (cached?.dimension === dimension) return cached.attempt;
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-kb-v1'))");
    await client.query(sql());
    const trigramVersion = await ensureExtension(client, "pg_trgm");
    if (trigramVersion) {
      await client.query("CREATE INDEX IF NOT EXISTS kb_chunks_trigram_idx ON evimed_kb.chunks USING gin (content gin_trgm_ops)");
    }
    const vectorVersion = await ensureExtension(client, "vector");
    if (vectorVersion) {
      const column = await client.query(`SELECT atttypmod FROM pg_attribute
        WHERE attrelid='evimed_kb.chunks'::regclass AND attname='embedding' AND NOT attisdropped`);
      if (column.rowCount && column.rows[0].atttypmod !== dimension) {
        await client.query("DROP INDEX IF EXISTS evimed_kb.kb_chunks_embedding_idx");
        await client.query("ALTER TABLE evimed_kb.chunks DROP COLUMN embedding");
        await client.query("UPDATE evimed_kb.documents SET embedding_model=NULL");
      }
      await client.query(`ALTER TABLE evimed_kb.chunks ADD COLUMN IF NOT EXISTS embedding vector(${dimension})`);
      // HNSW since pgvector 0.5; cosine because the embedder's vectors are
      // compared by direction, which is what its own documentation scores by.
      if (versionParts(vectorVersion)[0] > 0 || versionParts(vectorVersion)[1] >= 5) {
        await client.query("CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON evimed_kb.chunks USING hnsw (embedding vector_cosine_ops)");
      }
    }
    const [major, minor] = versionParts(vectorVersion);
    return {
      vector: Boolean(vectorVersion),
      vectorVersion,
      // 0.8 added iterative index scans, which is what keeps a filtered
      // nearest-neighbour search from returning fewer rows than asked for.
      iterativeScan: Boolean(vectorVersion) && (major > 0 || minor >= 8),
      trigram: Boolean(trigramVersion),
    };
  });
  migrations.set(database, { dimension, attempt });
  try { return await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
