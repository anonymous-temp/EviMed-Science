/**
 * The frontier feed's own schema, `evimed_frontier` (「前沿动态」, plan §10.4).
 *
 * Hidden knowledge:
 *
 * - Two databases, zero coupling. Everything between the outside world and a
 *   normalised entry — the registry's runtime state, the fetch log, the dedupe
 *   memory, the raw texts — lives in the knowledge-source plugin's own database
 *   (`evimed_knowledge`). This schema holds what the platform received from the
 *   plugin and everything it made of it. There is no foreign key and no shared
 *   connection between the two; the HTTP contract is the only link.
 * - The DDL is the design draft `tools/frontier-schema.sql` (22 tables),
 *   validated twice on PostgreSQL 16 before it was moved here, plus one
 *   index the draft did not have (`frontier_items_visible_idx`, below) and
 *   columns it did not have (`hot_snapshots.heats`, and 与我相关's freshness
 *   columns on `user_profiles` and `user_prefs`), each added in place by
 *   `ADD COLUMN IF NOT EXISTS`, so a deployed schema takes it on the next
 *   start. It runs the way
 *   `kbPersistence.mjs` does: one transaction behind an advisory lock, every
 *   statement idempotent, the extension-backed pieces created only where the
 *   extension exists. Closed vocabularies that move with the product (lane,
 *   source type, evidence type, specialty) are checked in code from
 *   `@evimed/domain`'s frontier vocabulary, not by CHECK, so adding a lane is
 *   not a migration.
 * - Two pieces depend on extensions this database may not have. The trigram
 *   index on titles needs `pg_trgm` (production has it; the local development
 *   server does not), and the vectors need pgvector. `halfvec` — half the
 *   bytes, a recall difference nobody can measure — exists from pgvector 0.7;
 *   production runs 0.8.6, this box's development server 0.6.2, and the
 *   migration falls back to `vector` there. Without pgvector there is no
 *   `item_vectors` table at all and search says it ran without its vector leg.
 * - `item_vectors` is derived and rebuildable. A column of another width than
 *   the embedding pin's is emptied and re-created: vectors of two widths — or
 *   two models — are not comparable, and a search that mixed them would rank
 *   noise.
 * - The reader-side tables are the only ones that carry a user id, and each
 *   cascades from `evimed_control.users`, so the control-plane schema must exist
 *   first. `database.transaction` migrates it before it opens, which is why this
 *   runs inside one.
 * - `meta` holds a handful of rows whose values are JSON numbers: the content
 *   version every list ETag and cursor is built from, the hot and daily view
 *   versions, and the plugin cursor. They are seeded here, because an UPDATE of
 *   a key that was never inserted changes nothing and says nothing — and a
 *   content version that never moves serves a stale 304 for ever.
 *
 * @module frontierPersistence
 */

const migrations = new WeakMap();

/** The schema name, written once. */
export const FRONTIER_SCHEMA = "evimed_frontier";

/**
 * The `meta` keys this module seeds, and what each counts. Values are JSON
 * numbers; `bumpFrontierVersion` is the one way a version moves.
 */
export const FRONTIER_META_KEYS = Object.freeze({
  /** Bumped by every change a reader can see: publish, select, withdraw, flag, re-edit. */
  contentVersion: "content_version",
  /** Bumped when the hot ranking is recomputed (wave 2). */
  hotVersion: "hot_version",
  /** Bumped when a daily issue is finalized (wave 2). */
  dailyVersion: "daily_version",
  /** The last plugin `seq` stored; the next pull asks for entries after it. */
  pluginCursor: "plugin_cursor",
  /** The last manifest the plugin served, with its compatibility verdict. */
  pluginManifest: "plugin_manifest",
});

/** The keys `bumpFrontierVersion` moves; the cursor and the manifest are not versions.
 *  @type {ReadonlySet<string>} */
const VERSION_KEYS = new Set([FRONTIER_META_KEYS.contentVersion, FRONTIER_META_KEYS.hotVersion, FRONTIER_META_KEYS.dailyVersion]);

/** The tables every deployment has. The trigram index and the vector table
 *  follow below, only where their extension exists. */
function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_frontier;

CREATE TABLE IF NOT EXISTS evimed_frontier.sources (
  id                 text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  name               text NOT NULL,
  homepage           text,
  lane               text NOT NULL,
  source_type        text NOT NULL,
  access             text NOT NULL,
  egress             text NOT NULL,
  authority          smallint NOT NULL DEFAULT 2 CHECK (authority BETWEEN 1 AND 5),
  safety_feed        boolean NOT NULL DEFAULT false,
  owner_entity       text NOT NULL,
  launch_tier        text NOT NULL,
  language           text,
  region             text,
  enabled            boolean NOT NULL DEFAULT true,
  retired_at         timestamptz(3),
  plugin_health      text NOT NULL DEFAULT 'new',
  last_ok_at         timestamptz(3),
  last_new_entry_at  timestamptz(3),
  entries_7d         integer NOT NULL DEFAULT 0,
  selected_30d       integer NOT NULL DEFAULT 0,
  registry_sha256    text,
  mirrored_at        timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_sources_lane_idx ON evimed_frontier.sources (lane) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS evimed_frontier.entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_entry_id text NOT NULL CHECK (char_length(plugin_entry_id) BETWEEN 3 AND 200),
  plugin_seq      bigint NOT NULL,
  revision        integer NOT NULL DEFAULT 1,
  source_id       text NOT NULL REFERENCES evimed_frontier.sources(id),
  identity_key    text NOT NULL,
  url             text NOT NULL CHECK (char_length(url) <= 2048),
  canonical_url   text NOT NULL CHECK (char_length(canonical_url) <= 2048),
  doi             text,
  pmid            text,
  registry_ids    text[] NOT NULL DEFAULT '{}',
  title_raw       text NOT NULL CHECK (char_length(title_raw) BETWEEN 1 AND 1000),
  summary_raw     text CHECK (char_length(summary_raw) <= 20000),
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  lang            text NOT NULL DEFAULT 'und',
  lane_hint       text,
  published_at    timestamptz(3),
  date_precision  text NOT NULL DEFAULT 'instant' CHECK (date_precision IN ('instant', 'day', 'inferred')),
  first_seen_at   timestamptz(3) NOT NULL,
  received_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  content_sha256  text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  backfill        boolean NOT NULL DEFAULT false,
  defects         text[] NOT NULL DEFAULT '{}',
  state           text NOT NULL DEFAULT 'received' CHECK (state IN
                    ('received', 'held', 'merged', 'screened-out', 'promoted', 'dropped', 'backfill', 'failed')),
  state_reason    text,
  hold_until      timestamptz(3),
  attempts        smallint NOT NULL DEFAULT 0,
  lease_owner     text,
  lease_until     timestamptz(3),
  item_id         bigint,
  UNIQUE (plugin_entry_id, revision)
);
CREATE INDEX IF NOT EXISTS frontier_entries_queue_idx
  ON evimed_frontier.entries (state, hold_until, id) WHERE state IN ('received', 'held');
CREATE INDEX IF NOT EXISTS frontier_entries_identity_idx ON evimed_frontier.entries (identity_key);
CREATE INDEX IF NOT EXISTS frontier_entries_retention_idx
  ON evimed_frontier.entries (received_at) WHERE state IN ('screened-out', 'dropped', 'backfill', 'failed');

CREATE TABLE IF NOT EXISTS evimed_frontier.items (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text NOT NULL UNIQUE CHECK (public_id ~ '^[a-z0-9]{12,32}$'),
  primary_source_id text NOT NULL REFERENCES evimed_frontier.sources(id),
  canonical_url     text NOT NULL,
  identity_key      text NOT NULL,
  doi               text,
  pmid              text,
  registry_ids      text[] NOT NULL DEFAULT '{}',
  title_raw         text NOT NULL,
  title_zh          text CHECK (char_length(title_zh) <= 200),
  summary_zh        text CHECK (char_length(summary_zh) <= 600),
  reason_zh         text CHECK (char_length(reason_zh) <= 200),
  lang              text NOT NULL,
  lane              text NOT NULL,
  source_type       text NOT NULL,
  evidence_type     text,
  evidence_basis    text CHECK (evidence_basis IN ('pubmed-types', 'registry', 'model')),
  specialties       text[] NOT NULL DEFAULT '{}',
  entities          jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_keys       text[] NOT NULL DEFAULT '{}',
  flags             text[] NOT NULL DEFAULT '{}',
  score_authority   smallint CHECK (score_authority BETWEEN 0 AND 30),
  score_impact      smallint CHECK (score_impact BETWEEN 0 AND 30),
  score_novelty     smallint CHECK (score_novelty BETWEEN 0 AND 20),
  score_relevance   smallint CHECK (score_relevance BETWEEN 0 AND 20),
  score_total       smallint CHECK (score_total BETWEEN 0 AND 100),
  selected          boolean NOT NULL DEFAULT false,
  selected_at       timestamptz(3),
  selected_rule     text,
  safety_alert      boolean NOT NULL DEFAULT false,
  verification      text NOT NULL DEFAULT 'pending'
                    CHECK (verification IN ('pending', 'passed', 'repaired', 'title-only')),
  published_at      timestamptz(3),
  date_precision    text NOT NULL DEFAULT 'instant',
  first_seen_at     timestamptz(3) NOT NULL,
  timeline_at       timestamptz(3) NOT NULL,
  state             text NOT NULL DEFAULT 'screened'
                    CHECK (state IN ('screened', 'scored', 'published', 'withdrawn', 'failed')),
  visible_at        timestamptz(3),
  rescored_at       timestamptz(3),
  withdrawn_at      timestamptz(3),
  withdrawn_reason  text,
  editor_version    text,
  editor_model      text,
  lexemes           tsvector NOT NULL DEFAULT ''::tsvector,
  event_id          bigint,
  attempts          smallint NOT NULL DEFAULT 0,
  lease_owner       text,
  lease_until       timestamptz(3),
  updated_at        timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS frontier_items_doi_key ON evimed_frontier.items (lower(doi)) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS frontier_items_identity_key ON evimed_frontier.items (identity_key);
CREATE INDEX IF NOT EXISTS frontier_items_url_idx ON evimed_frontier.items (md5(canonical_url));
CREATE INDEX IF NOT EXISTS frontier_items_timeline_idx
  ON evimed_frontier.items (timeline_at DESC, id DESC) WHERE state = 'published';
CREATE INDEX IF NOT EXISTS frontier_items_selected_idx
  ON evimed_frontier.items (timeline_at DESC, id DESC) WHERE state = 'published' AND selected;
CREATE INDEX IF NOT EXISTS frontier_items_lane_idx
  ON evimed_frontier.items (lane, timeline_at DESC, id DESC) WHERE state = 'published';
CREATE INDEX IF NOT EXISTS frontier_items_safety_idx
  ON evimed_frontier.items (timeline_at DESC) WHERE state = 'published' AND safety_alert;
CREATE INDEX IF NOT EXISTS frontier_items_specialties_idx ON evimed_frontier.items USING gin (specialties);
CREATE INDEX IF NOT EXISTS frontier_items_entity_keys_idx ON evimed_frontier.items USING gin (entity_keys);
CREATE INDEX IF NOT EXISTS frontier_items_lexemes_idx ON evimed_frontier.items USING gin (lexemes);
CREATE INDEX IF NOT EXISTS frontier_items_event_idx ON evimed_frontier.items (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_items_published_idx
  ON evimed_frontier.items (published_at DESC, id DESC) WHERE state = 'published' AND published_at IS NOT NULL;
-- Not in the draft: the status route and the metrics count what was published
-- today and when the last item went up, by visible_at, and without this index
-- each of those is a scan of every item ever published.
CREATE INDEX IF NOT EXISTS frontier_items_visible_idx
  ON evimed_frontier.items (visible_at DESC) WHERE state = 'published';

CREATE TABLE IF NOT EXISTS evimed_frontier.item_keys (
  key     text PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS frontier_item_keys_item_idx ON evimed_frontier.item_keys (item_id);
CREATE INDEX IF NOT EXISTS frontier_items_queue_idx
  ON evimed_frontier.items (state, lease_until, id) WHERE state IN ('screened', 'scored');

CREATE TABLE IF NOT EXISTS evimed_frontier.item_texts (
  item_id            bigint PRIMARY KEY REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  abstract_raw       text,
  body_excerpt       text CHECK (char_length(body_excerpt) <= 12000),
  model_input        text NOT NULL,
  model_input_sha256 text NOT NULL CHECK (model_input_sha256 ~ '^[a-f0-9]{64}$'),
  abstract_zh        text,
  abstract_zh_at     timestamptz(3),
  publication_types  text[] NOT NULL DEFAULT '{}',
  mesh               text[] NOT NULL DEFAULT '{}',
  journal            text,
  authors_short      text,
  open_access        text,
  enrichment         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS evimed_frontier.item_mentions (
  item_id      bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  entry_id     bigint NOT NULL REFERENCES evimed_frontier.entries(id) ON DELETE CASCADE,
  source_id    text NOT NULL,
  url          text NOT NULL,
  published_at timestamptz(3),
  PRIMARY KEY (item_id, entry_id)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.item_links (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('retraction', 'correction', 'expression-of-concern', 'withdrawal',
                 'preprint-of', 'new-version')),
  from_doi     text NOT NULL,
  to_doi       text NOT NULL,
  from_item_id bigint REFERENCES evimed_frontier.items(id) ON DELETE SET NULL,
  to_item_id   bigint REFERENCES evimed_frontier.items(id) ON DELETE SET NULL,
  asserted_by  text NOT NULL CHECK (asserted_by IN ('crossref', 'pubmed', 'europepmc', 'retraction-watch')),
  noticed_at   timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, from_doi, to_doi)
);
CREATE INDEX IF NOT EXISTS frontier_item_links_to_idx ON evimed_frontier.item_links (lower(to_doi));

CREATE TABLE IF NOT EXISTS evimed_frontier.glossary (
  kind          text NOT NULL CHECK (kind IN ('drug', 'disease', 'org', 'trial', 'method', 'other')),
  term_en       text NOT NULL CHECK (char_length(term_en) BETWEEN 2 AND 200),
  term_zh       text NOT NULL,
  keep_original boolean NOT NULL DEFAULT false,
  origin        text NOT NULL,
  updated_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, term_en)
);
CREATE INDEX IF NOT EXISTS frontier_glossary_lower_idx ON evimed_frontier.glossary (lower(term_en));

CREATE TABLE IF NOT EXISTS evimed_frontier.events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text NOT NULL UNIQUE,
  title_zh        text NOT NULL,
  digest_zh       text,
  latest_zh       text,
  lane            text NOT NULL,
  status          text NOT NULL DEFAULT 'developing' CHECK (status IN ('developing', 'settled')),
  entity_keys     text[] NOT NULL DEFAULT '{}',
  source_count_72h integer NOT NULL DEFAULT 1,
  report_count    integer NOT NULL DEFAULT 1,
  entity_count    integer NOT NULL DEFAULT 1,
  has_primary     boolean NOT NULL DEFAULT false,
  heat            double precision NOT NULL DEFAULT 0,
  heat_updated_at timestamptz(3),
  first_at        timestamptz(3) NOT NULL,
  last_at         timestamptz(3) NOT NULL,
  digest_state    text NOT NULL DEFAULT 'none' CHECK (digest_state IN ('none', 'written', 'stale')),
  digest_revision integer NOT NULL DEFAULT 0,
  merged_into     bigint REFERENCES evimed_frontier.events(id) ON DELETE SET NULL,
  merged_at       timestamptz(3),
  updated_at      timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_events_recent_idx ON evimed_frontier.events (last_at DESC) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS frontier_events_hot_idx ON evimed_frontier.events (heat DESC) WHERE merged_into IS NULL AND status = 'developing';

CREATE TABLE IF NOT EXISTS evimed_frontier.event_aliases (
  public_id text PRIMARY KEY,
  event_id  bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evimed_frontier.event_links (
  from_event_id bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  to_event_id   bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  relation      text NOT NULL CHECK (relation IN ('follows', 'supersedes', 'preprint-of', 'retracted-by', 'corrected-by', 'related')),
  asserted_by   text NOT NULL CHECK (asserted_by IN ('identifier', 'model', 'operator')),
  linked_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (from_event_id, to_event_id, relation),
  CHECK (from_event_id <> to_event_id)
);
CREATE INDEX IF NOT EXISTS frontier_event_links_to_idx ON evimed_frontier.event_links (to_event_id);
CREATE INDEX IF NOT EXISTS frontier_events_entity_idx ON evimed_frontier.events USING gin (entity_keys);

CREATE TABLE IF NOT EXISTS evimed_frontier.event_items (
  event_id  bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  item_id   bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('primary', 'report', 'background')),
  joined_by text NOT NULL CHECK (joined_by IN ('identifier', 'vector', 'model', 'operator')),
  joined_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, item_id),
  UNIQUE (item_id)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.event_revisions (
  event_id   bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  revision   integer NOT NULL,
  digest_zh  text NOT NULL,
  cause      text NOT NULL,
  written_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, revision)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.hot_snapshots (
  taken_at timestamptz(3) PRIMARY KEY,
  ranking  jsonb NOT NULL
);
-- Not in the draft (2026-09-24, plan 2026-09-23 §6.5 #2): each snapshot also
-- records the heat of every event that could be on the list — public id →
-- heat — so the hot list can draw a 24-hour trend from what was measured then.
-- Snapshots taken before it hold '{}', which reads as no history.
ALTER TABLE evimed_frontier.hot_snapshots ADD COLUMN IF NOT EXISTS heats jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS evimed_frontier.dailies (
  day          date PRIMARY KEY,
  window_start timestamptz(3) NOT NULL,
  window_end   timestamptz(3) NOT NULL,
  lead         jsonb NOT NULL,
  sections     jsonb NOT NULL,
  safety       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_minute    text,
  markdown     text NOT NULL,
  item_ids     bigint[] NOT NULL,
  model        text NOT NULL,
  cost_cny     numeric(10, 4),
  generated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS evimed_frontier.item_changes (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    bigint NOT NULL,
  op         text NOT NULL CHECK (op IN ('upsert', 'remove')),
  reason     text NOT NULL,
  changed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_item_changes_retention_idx ON evimed_frontier.item_changes (changed_at);

CREATE TABLE IF NOT EXISTS evimed_frontier.meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO evimed_frontier.meta(key, value) VALUES
  ('content_version', '0'::jsonb), ('hot_version', '0'::jsonb), ('daily_version', '0'::jsonb), ('plugin_cursor', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS evimed_frontier.user_state (
  user_id    text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  item_id    bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  starred_at timestamptz(3),
  hidden_at  timestamptz(3),
  read_at    timestamptz(3),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS frontier_user_state_starred_idx
  ON evimed_frontier.user_state (user_id, starred_at DESC) WHERE starred_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS evimed_frontier.user_follows (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('topic', 'specialty', 'drug', 'source', 'event')),
  key        text NOT NULL,
  label      text NOT NULL,
  muted      boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, kind, key)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.user_profiles (
  user_id     text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  specialties text[] NOT NULL DEFAULT '{}',
  phrases     jsonb NOT NULL DEFAULT '[]'::jsonb,
  for_you     jsonb,
  computed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  for_you_at  timestamptz(3)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.user_prefs (
  user_id       text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  state_version bigint NOT NULL DEFAULT 0,
  last_seen_at  timestamptz(3),
  last_push_day date
);
-- Not in the draft (2026-09-24): what keeps 与我相关 fresh. A reader's action
-- or a new question moves inputs_version; a profile records the version it
-- was computed from and a mark of the memory it read (count, versions, latest
-- change), so a change of either makes it due at the next round instead of
-- the next day. for_you_seen_at is when the reader last opened the block:
-- those waiting on it are computed first.
ALTER TABLE evimed_frontier.user_profiles ADD COLUMN IF NOT EXISTS inputs_version bigint NOT NULL DEFAULT 0;
ALTER TABLE evimed_frontier.user_profiles ADD COLUMN IF NOT EXISTS computed_inputs_version bigint NOT NULL DEFAULT 0;
ALTER TABLE evimed_frontier.user_profiles ADD COLUMN IF NOT EXISTS memory_mark text;
ALTER TABLE evimed_frontier.user_prefs ADD COLUMN IF NOT EXISTS for_you_seen_at timestamptz(3);
`;
}

/**
 * The installed version of an extension, installing it first when this role
 * may. A role without CREATE on the database cannot, and that is the host
 * migration's job: until then the leg that needs it is skipped, not failed.
 * @param {any} client @param {"vector" | "pg_trgm"} name
 * @returns {Promise<string | null>}
 */
async function ensureExtension(client, name) {
  const found = await client.query("SELECT default_version, installed_version FROM pg_available_extensions WHERE name=$1", [name]);
  const row = found.rows[0];
  if (!row) return null;
  if (!row.installed_version) {
    await client.query("SAVEPOINT frontier_extension");
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${name === "vector" ? "vector" : "pg_trgm"}`);
      await client.query("RELEASE SAVEPOINT frontier_extension");
    } catch {
      // Refused for want of privilege: the leg waits for the host migration.
      await client.query("ROLLBACK TO SAVEPOINT frontier_extension");
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

/** @param {string | null} version @param {number} major @param {number} minor */
function atLeast(version, major, minor) {
  const [have, haveMinor] = versionParts(version);
  return have > major || (have === major && haveMinor >= minor);
}

/**
 * The vector table, in the element type this pgvector supports best.
 *
 * An existing column of the pin's width keeps its type whatever it is — a
 * pgvector upgraded under a populated `vector` column must not strand the rows
 * in it, and the index is always built with the operator class of the column
 * actually there. A column of another width is emptied and replaced.
 * @param {any} client @param {number} dimension @param {boolean} halfvecSupported
 * @returns {Promise<"halfvec" | "vector">}
 */
async function ensureVectorTable(client, dimension, halfvecSupported) {
  const preferred = /** @type {"halfvec" | "vector"} */ (halfvecSupported ? "halfvec" : "vector");
  await client.query(`CREATE TABLE IF NOT EXISTS evimed_frontier.item_vectors (
    item_id     bigint PRIMARY KEY REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
    model_key   text NOT NULL,
    embedding   ${preferred}(${dimension}) NOT NULL,
    embedded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
  )`);
  const column = await client.query(`SELECT t.typname, a.atttypmod FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid='evimed_frontier.item_vectors'::regclass AND a.attname='embedding' AND NOT a.attisdropped`);
  /** @type {"halfvec" | "vector"} */
  let type = column.rows[0]?.typname === "halfvec" ? "halfvec" : "vector";
  if (!column.rowCount || column.rows[0].atttypmod !== dimension) {
    // Vectors of another width cannot be compared with a new query's; they are
    // derived, so they are dropped and the worker embeds again.
    await client.query("DROP INDEX IF EXISTS evimed_frontier.frontier_item_vectors_hnsw_idx");
    await client.query("DELETE FROM evimed_frontier.item_vectors");
    await client.query("ALTER TABLE evimed_frontier.item_vectors DROP COLUMN IF EXISTS embedding");
    await client.query(`ALTER TABLE evimed_frontier.item_vectors ADD COLUMN embedding ${preferred}(${dimension}) NOT NULL`);
    type = preferred;
  }
  await client.query(`CREATE INDEX IF NOT EXISTS frontier_item_vectors_hnsw_idx
    ON evimed_frontier.item_vectors USING hnsw (embedding ${type}_cosine_ops)`);
  return type;
}

/**
 * Create or bring up to date the frontier schema, and say which search legs it
 * supports.
 *
 * Idempotent and serialized by an advisory lock, like every other schema this
 * control plane owns; cached per database and dimension, so every caller may
 * call it before its first query.
 *
 * @param {any} database a `ControlPlaneDatabase`
 * @param {{ dimension: number }} options the embedding width (the pin's)
 * @returns {Promise<{ vector: boolean, halfvec: boolean, vectorVersion: string | null, iterativeScan: boolean, trigram: boolean }>}
 */
export async function migrateFrontier(database, { dimension }) {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4000) throw new TypeError("The embedding dimension is invalid.");
  const cached = migrations.get(database);
  if (cached?.dimension === dimension) return cached.attempt;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-frontier-v1'))");
    await client.query(sql());
    const trigramVersion = await ensureExtension(client, "pg_trgm");
    if (trigramVersion) {
      await client.query(`CREATE INDEX IF NOT EXISTS frontier_items_title_trgm_idx
        ON evimed_frontier.items USING gin ((title_raw || ' ' || coalesce(title_zh, '')) gin_trgm_ops)`);
    }
    const vectorVersion = await ensureExtension(client, "vector");
    // HNSW itself arrived in 0.5; below that there is no index to search by,
    // and a sequential cosine scan over a year of items is not a search leg.
    const vectorUsable = Boolean(vectorVersion) && atLeast(vectorVersion, 0, 5);
    const type = vectorUsable ? await ensureVectorTable(client, dimension, atLeast(vectorVersion, 0, 7)) : null;
    return {
      vector: vectorUsable,
      halfvec: type === "halfvec",
      vectorVersion,
      // 0.8 added iterative index scans, which is what keeps a filtered
      // nearest-neighbour search from returning fewer rows than asked for.
      iterativeScan: vectorUsable && atLeast(vectorVersion, 0, 8),
      trigram: Boolean(trigramVersion),
    };
  });
  migrations.set(database, { dimension, attempt });
  try { return await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/**
 * A `meta` counter as a number, whatever shape an older writer left it in: a
 * JSON number, a numeric string, or nothing. Anything else reads as 0 rather
 * than failing the read that asked.
 * @param {unknown} value
 */
export function metaNumber(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,19}$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/**
 * Move one of the view versions by one and return the new value, inside the
 * caller's transaction — so the version moves exactly when the change it
 * describes commits, and a reader's ETag can never name a state the table is
 * not in.
 * @param {any} client a client inside an open transaction
 * @param {string} [key] one of `FRONTIER_META_KEYS`' version keys
 * @returns {Promise<number>}
 */
export async function bumpFrontierVersion(client, key = FRONTIER_META_KEYS.contentVersion) {
  if (!VERSION_KEYS.has(key)) {
    throw new TypeError("Unknown frontier version key.");
  }
  const result = await client.query(`INSERT INTO evimed_frontier.meta(key, value, updated_at) VALUES ($1, '1'::jsonb, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET
      value = to_jsonb(CASE WHEN jsonb_typeof(evimed_frontier.meta.value) = 'number'
        THEN (evimed_frontier.meta.value #>> '{}')::bigint ELSE 0 END + 1),
      updated_at = clock_timestamp()
    RETURNING (value #>> '{}')::bigint AS version`, [key]);
  return Number(result.rows[0].version);
}
