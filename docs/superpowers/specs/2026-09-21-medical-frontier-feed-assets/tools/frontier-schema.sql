-- evimed_frontier: design draft of the frontier-feed schema (2026-09-21).
-- Validated on PostgreSQL 16 + pgvector 0.8 + pg_trgm (see tools/check_schema.sh). In the product this text lives in
-- apps/server/src/frontierPersistence.mjs and runs the way kbPersistence.mjs does: inside one transaction, behind
-- pg_advisory_xact_lock(hashtext('evimed-frontier-v1')), every statement idempotent, the two extension-backed
-- indexes (trigram, hnsw) skipped where the extension is missing. Closed vocabularies that change with the product
-- (lane, source_type, evidence_type, specialty) are validated in code from frontierVocabulary.mjs, not by CHECK.

CREATE SCHEMA IF NOT EXISTS evimed_frontier;

-- ───────────────────────── collection side ─────────────────────────

-- Runtime mirror of the registry file. The file is the truth for what a source IS; this table is the truth for
-- what happened to it. A row missing from the file is retired, never deleted (entries keep pointing at it).
CREATE TABLE IF NOT EXISTS evimed_frontier.sources (
  id                   text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  name                 text NOT NULL,
  lane                 text NOT NULL,
  source_type          text NOT NULL,
  access               text NOT NULL,
  egress               text NOT NULL CHECK (egress IN ('direct', 'browser', 'relay', 'bridge')),  -- the registry's values; 'none' rows are not loaded
  authority            smallint NOT NULL DEFAULT 2 CHECK (authority BETWEEN 1 AND 5),
  bypass_scoring       boolean NOT NULL DEFAULT false,          -- official safety-alert feeds only
  launch_tier          text NOT NULL CHECK (launch_tier IN ('P0', 'P1', 'P2')),
  registry_sha256      text NOT NULL CHECK (registry_sha256 ~ '^[a-f0-9]{64}$'),
  enabled              boolean NOT NULL DEFAULT true,            -- operator override; survives a registry reload
  retired_at           timestamptz(3),
  poll_interval_s      integer NOT NULL CHECK (poll_interval_s BETWEEN 300 AND 604800),
  poll_floor_s         integer NOT NULL CHECK (poll_floor_s >= 300),
  poll_ceiling_s       integer NOT NULL CHECK (poll_ceiling_s <= 604800),
  next_poll_at         timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  lease_owner          text,
  lease_until          timestamptz(3),
  etag                 text,
  last_modified        text,
  last_content_sha256  text,
  last_ok_at           timestamptz(3),
  last_new_entry_at    timestamptz(3),
  last_error_code      text,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  health               text NOT NULL DEFAULT 'new'
                       CHECK (health IN ('new', 'healthy', 'degraded', 'unreadable', 'drifted', 'disabled')),
  entries_7d           integer NOT NULL DEFAULT 0,
  selected_30d         integer NOT NULL DEFAULT 0,
  updated_at           timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
-- The collection queue IS this index: due, enabled, not leased. No job row per poll.
CREATE INDEX IF NOT EXISTS frontier_sources_due_idx
  ON evimed_frontier.sources (egress, next_poll_at) WHERE enabled AND retired_at IS NULL;

-- One row per poll. Source health, selector drift and the public sources page read this; kept 14 days.
CREATE TABLE IF NOT EXISTS evimed_frontier.fetches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL REFERENCES evimed_frontier.sources(id) ON DELETE CASCADE,
  fetched_at     timestamptz(3) NOT NULL,
  egress         text NOT NULL,
  node           text,
  http_status    integer,
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'not-modified', 'empty', 'challenge', 'blocked', 'timeout',
                   'http-error', 'parse-error', 'robots-denied', 'host-budget', 'too-large')),
  bytes          integer CHECK (bytes >= 0),
  duration_ms    integer CHECK (duration_ms >= 0),
  content_sha256 text,
  entries_seen   integer NOT NULL DEFAULT 0,
  entries_new    integer NOT NULL DEFAULT 0,
  error_detail   text CHECK (char_length(error_detail) <= 500)
);
CREATE INDEX IF NOT EXISTS frontier_fetches_source_idx ON evimed_frontier.fetches (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS frontier_fetches_retention_idx ON evimed_frontier.fetches (fetched_at);

-- Every sighting of every thing, as the source gave it. The processing queue is the partial index below.
CREATE TABLE IF NOT EXISTS evimed_frontier.entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       text NOT NULL REFERENCES evimed_frontier.sources(id),
  external_key    text NOT NULL CHECK (char_length(external_key) BETWEEN 1 AND 512),
  dedupe_key      text NOT NULL,            -- doi:… | pmid:… | reg:… | wx:<biz>:<mid>:<idx> | url:<sha256 of the canonical url>
  url             text NOT NULL CHECK (char_length(url) <= 2048),
  canonical_url   text NOT NULL CHECK (char_length(canonical_url) <= 2048),
  doi             text,
  pmid            text,
  registry_ids    text[] NOT NULL DEFAULT '{}',
  title_raw       text NOT NULL CHECK (char_length(title_raw) BETWEEN 1 AND 1000),
  summary_raw     text CHECK (char_length(summary_raw) <= 20000),
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- adapter facts: crossref type, update-to, trial phase, …
  lang            text NOT NULL DEFAULT 'und',
  published_at    timestamptz(3),
  date_precision  text NOT NULL DEFAULT 'instant' CHECK (date_precision IN ('instant', 'day', 'inferred')),
  first_seen_at   timestamptz(3) NOT NULL,   -- the collector's clock
  received_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  content_sha256  text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  revision        integer NOT NULL DEFAULT 1,
  defects         text[] NOT NULL DEFAULT '{}',
  state           text NOT NULL DEFAULT 'collected' CHECK (state IN
                    ('collected', 'held', 'merged', 'screened-out', 'promoted', 'dropped', 'backfill', 'failed')),
  state_reason    text,
  hold_until      timestamptz(3),
  attempts        smallint NOT NULL DEFAULT 0,
  lease_owner     text,
  lease_until     timestamptz(3),
  item_id         bigint,
  UNIQUE (source_id, external_key)
);
CREATE INDEX IF NOT EXISTS frontier_entries_queue_idx
  ON evimed_frontier.entries (state, hold_until, id) WHERE state IN ('collected', 'held');
CREATE INDEX IF NOT EXISTS frontier_entries_dedupe_idx ON evimed_frontier.entries (dedupe_key);
CREATE INDEX IF NOT EXISTS frontier_entries_retention_idx
  ON evimed_frontier.entries (received_at) WHERE state IN ('screened-out', 'dropped', 'backfill', 'failed');

-- What a source has shown us, kept far longer than entries (400 days): without it a 30-day purge makes deep feeds
-- (MMWR back to 2019) and undated items come back as new.
CREATE TABLE IF NOT EXISTS evimed_frontier.seen_keys (
  source_id      text NOT NULL,
  key_sha256     text NOT NULL CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text,
  first_seen_at  timestamptz(3) NOT NULL,
  last_seen_at   timestamptz(3) NOT NULL,
  PRIMARY KEY (source_id, key_sha256)
);
CREATE INDEX IF NOT EXISTS frontier_seen_keys_retention_idx ON evimed_frontier.seen_keys (last_seen_at);

-- No edge tables: since 2026-09-22 the overseas sources are read by this same
-- worker through the Tokyo node's TLS proxy (apps/server/src/edgeProxy.mjs), so
-- there is no node identity, no batch and no spool to record.

-- ───────────────────────── content side ─────────────────────────

-- What a reader sees. Narrow on purpose: list queries never touch the long texts or the vectors.
CREATE TABLE IF NOT EXISTS evimed_frontier.items (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text NOT NULL UNIQUE CHECK (public_id ~ '^[a-z0-9]{12,32}$'),
  primary_source_id text NOT NULL REFERENCES evimed_frontier.sources(id),
  canonical_url     text NOT NULL,
  identity_key      text NOT NULL,          -- the item's primary key among item_keys; registry and database sources key
                                            -- the event, not the object: reg:NCT…:results:2026-09-20, fda:NDA…:SUPPL-12
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
  entities          jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {drugs, trials, orgs, diseases}, as displayed
  entity_keys       text[] NOT NULL DEFAULT '{}',              -- the same, normalised, for overlap queries
  flags             text[] NOT NULL DEFAULT '{}',              -- preprint, press-release, no-abstract, retracted, corrected, china, …
  score_authority   smallint CHECK (score_authority BETWEEN 0 AND 30),
  score_impact      smallint CHECK (score_impact BETWEEN 0 AND 30),
  score_novelty     smallint CHECK (score_novelty BETWEEN 0 AND 20),
  score_relevance   smallint CHECK (score_relevance BETWEEN 0 AND 20),
  score_total       smallint CHECK (score_total BETWEEN 0 AND 100),
  selected          boolean NOT NULL DEFAULT false,
  selected_at       timestamptz(3),
  selected_rule     text,                                       -- threshold | lane-floor | safety-bypass | operator-pin
  safety_alert      boolean NOT NULL DEFAULT false,
  verification      text NOT NULL DEFAULT 'pending'
                    CHECK (verification IN ('pending', 'passed', 'repaired', 'title-only')),
  published_at      timestamptz(3),
  date_precision    text NOT NULL DEFAULT 'instant',
  first_seen_at     timestamptz(3) NOT NULL,
  timeline_at       timestamptz(3) NOT NULL,                    -- set when the item is published: visible_at if that is within
                                                                -- 72 h of published_at, else published_at; never changed after
  state             text NOT NULL DEFAULT 'screened'
                    CHECK (state IN ('screened', 'scored', 'published', 'withdrawn', 'failed')),
  visible_at        timestamptz(3),
  rescored_at       timestamptz(3),                               -- an abstract that arrives after publication triggers one re-score
  withdrawn_at      timestamptz(3),
  withdrawn_reason  text,
  editor_version    text,                                       -- prompt + vocabulary version that wrote the Chinese fields
  editor_model      text,
  lexemes           tsvector NOT NULL DEFAULT ''::tsvector,     -- written by the platform tokenizer, as evimed_kb does
  event_id          bigint,
  attempts          smallint NOT NULL DEFAULT 0,
  lease_owner       text,
  lease_until       timestamptz(3),
  updated_at        timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS frontier_items_doi_key ON evimed_frontier.items (lower(doi)) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS frontier_items_identity_key ON evimed_frontier.items (identity_key);
-- Not unique: two feeds of one site can carry the same link for one work (EMA), and that is a merge, not an error.
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

-- Every key an item is known by (doi:, pmid:, wx:, url:, reg:<id> for clustering). Dedupe looks an entry's keys up here,
-- so a PMID-only arrival finds the item first seen by DOI.
CREATE TABLE IF NOT EXISTS evimed_frontier.item_keys (
  key     text PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS frontier_item_keys_item_idx ON evimed_frontier.item_keys (item_id);
CREATE INDEX IF NOT EXISTS frontier_items_queue_idx
  ON evimed_frontier.items (state, lease_until, id) WHERE state IN ('screened', 'scored');
-- pg_trgm leg; skipped where the extension is missing.
CREATE INDEX IF NOT EXISTS frontier_items_title_trgm_idx
  ON evimed_frontier.items USING gin ((title_raw || ' ' || coalesce(title_zh, '')) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS evimed_frontier.item_texts (
  item_id            bigint PRIMARY KEY REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  abstract_raw       text,
  body_excerpt       text CHECK (char_length(body_excerpt) <= 12000),
  model_input        text NOT NULL,            -- exactly what the editor model was shown; the number check reads this
  model_input_sha256 text NOT NULL CHECK (model_input_sha256 ~ '^[a-f0-9]{64}$'),
  abstract_zh        text,                     -- written on first open, then shared by every reader
  abstract_zh_at     timestamptz(3),
  publication_types  text[] NOT NULL DEFAULT '{}',
  mesh               text[] NOT NULL DEFAULT '{}',
  journal            text,
  authors_short      text,
  open_access        text                      -- gold | green | bronze | closed | unknown
);

-- Derived, rebuildable, excluded from the backup. A model change touches this table and nothing else.
CREATE TABLE IF NOT EXISTS evimed_frontier.item_vectors (
  item_id     bigint PRIMARY KEY REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  model_key   text NOT NULL,                   -- model@dimension, the same key KbEmbedder uses
  embedding   halfvec(1024) NOT NULL,
  embedded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_item_vectors_hnsw_idx
  ON evimed_frontier.item_vectors USING hnsw (embedding halfvec_cosine_ops);

-- The same work arriving by another road (journal query, PubMed stream, Europe PMC, a second feed).
CREATE TABLE IF NOT EXISTS evimed_frontier.item_mentions (
  item_id      bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  entry_id     bigint NOT NULL REFERENCES evimed_frontier.entries(id) ON DELETE CASCADE,
  source_id    text NOT NULL,
  url          text NOT NULL,
  published_at timestamptz(3),
  PRIMARY KEY (item_id, entry_id)
);

-- Retractions, corrections, expressions of concern, preprint → published. Keyed by DOI so a notice can arrive
-- before or after the work it points at.
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

-- Translation consistency. Seeded from the pharmacy base data (generic names) and a short hand-kept list.
CREATE TABLE IF NOT EXISTS evimed_frontier.glossary (
  kind          text NOT NULL CHECK (kind IN ('drug', 'disease', 'org', 'trial', 'method', 'other')),
  term_en       text NOT NULL CHECK (char_length(term_en) BETWEEN 2 AND 200),
  term_zh       text NOT NULL,
  keep_original boolean NOT NULL DEFAULT false,   -- trial acronyms, gene symbols: shown as written
  origin        text NOT NULL,
  updated_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, term_en)
);
CREATE INDEX IF NOT EXISTS frontier_glossary_lower_idx ON evimed_frontier.glossary (lower(term_en));

-- ───────────────────────── editorial side ─────────────────────────

CREATE TABLE IF NOT EXISTS evimed_frontier.events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text NOT NULL UNIQUE,
  title_zh        text NOT NULL,
  digest_zh       text,
  latest_zh       text,
  lane            text NOT NULL,
  status          text NOT NULL DEFAULT 'developing' CHECK (status IN ('developing', 'settled')),
  entity_keys     text[] NOT NULL DEFAULT '{}',
  source_count    integer NOT NULL DEFAULT 1,
  has_primary     boolean NOT NULL DEFAULT false,
  heat            double precision NOT NULL DEFAULT 0,
  first_at        timestamptz(3) NOT NULL,
  last_at         timestamptz(3) NOT NULL,
  digest_revision integer NOT NULL DEFAULT 0,
  updated_at      timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_events_recent_idx ON evimed_frontier.events (last_at DESC);
CREATE INDEX IF NOT EXISTS frontier_events_entity_idx ON evimed_frontier.events USING gin (entity_keys);

CREATE TABLE IF NOT EXISTS evimed_frontier.event_items (
  event_id  bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  item_id   bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('primary', 'report', 'background')),
  joined_by text NOT NULL CHECK (joined_by IN ('identifier', 'vector', 'model', 'operator')),
  joined_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, item_id),
  UNIQUE (item_id)                                  -- an item belongs to at most one event
);

CREATE TABLE IF NOT EXISTS evimed_frontier.event_revisions (
  event_id   bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE,
  revision   integer NOT NULL,
  digest_zh  text NOT NULL,
  cause      text NOT NULL,                         -- new-primary | new-report | operator
  written_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, revision)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.hot_snapshots (
  taken_at timestamptz(3) PRIMARY KEY,
  ranking  jsonb NOT NULL                           -- [{rank, eventId, sourceCount, delta}]
);

CREATE TABLE IF NOT EXISTS evimed_frontier.dailies (
  day          date PRIMARY KEY,                    -- the Asia/Shanghai day it covers
  lead         jsonb NOT NULL,
  sections     jsonb NOT NULL,
  safety       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_minute    text,
  markdown     text NOT NULL,
  item_ids     bigint[] NOT NULL,
  model        text NOT NULL,
  cost_cny     numeric(10, 4),
  finalized_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

-- View versions (the ETag source), budget state, last daily: a handful of rows.
CREATE TABLE IF NOT EXISTS evimed_frontier.meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

-- ───────────────────────── reader side: the only tables that carry a user id ─────────────────────────

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
  muted      boolean NOT NULL DEFAULT false,       -- true = "show me less of this"
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, kind, key)
);

CREATE TABLE IF NOT EXISTS evimed_frontier.user_profiles (
  user_id     text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  specialties text[] NOT NULL DEFAULT '{}',
  phrases     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{text, memoryId}] - every phrase names the memory it came from
  for_you     jsonb,                               -- the cached ranking and its reasons
  computed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  for_you_at  timestamptz(3)
);

-- Push time and on/off live in the platform's notification preferences (digestTime, switches.frontier); this table
-- keeps only what the module itself needs.
CREATE TABLE IF NOT EXISTS evimed_frontier.user_prefs (
  user_id       text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  state_version bigint NOT NULL DEFAULT 0,          -- bumped by every star / hide / read / follow: part of every personal ETag
  last_seen_at  timestamptz(3),                     -- the digest goes to people who came within 14 days
  last_push_day date
);
