-- evimed_frontier: design draft of the frontier-feed schema (2026-09-21; split 2026-09-22).
-- Collection (registry runtime, fetch log, dedupe memory, raw texts) lives in the knowledge-source plugin's own
-- database (tools/knowledge-plugin-schema.sql). This schema holds what the platform receives from the plugin and
-- everything it makes of it: screening, editing, events, dailies, and the reader's own state.
-- Validated on PostgreSQL 16 + pgvector 0.8 + pg_trgm (see tools/check_schema.sh). In the product this text lives in
-- apps/server/src/frontierPersistence.mjs and runs the way kbPersistence.mjs does: inside one transaction, behind
-- pg_advisory_xact_lock(hashtext('evimed-frontier-v1')), every statement idempotent, the two extension-backed
-- indexes (trigram, hnsw) skipped where the extension is missing. Closed vocabularies that change with the product
-- (lane, source_type, evidence_type, specialty) are validated in code from frontierVocabulary.mjs, not by CHECK.

CREATE SCHEMA IF NOT EXISTS evimed_frontier;

-- ───────────────────────── collection side ─────────────────────────

-- Mirror of the plugin's registry (GET /v1/sources), refreshed hourly. Items point at it, the public sources page
-- reads it, and `enabled` is the platform's own display override. A source the plugin retires stays here, retired.
CREATE TABLE IF NOT EXISTS evimed_frontier.sources (
  id                 text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  name               text NOT NULL,
  homepage           text,
  lane               text NOT NULL,                       -- 'mixed' = the screening model decides per item
  source_type        text NOT NULL,
  access             text NOT NULL,
  egress             text NOT NULL,
  authority          smallint NOT NULL DEFAULT 2 CHECK (authority BETWEEN 1 AND 5),
  safety_feed        boolean NOT NULL DEFAULT false,      -- official safety-alert feeds only: entries bypass scoring
  owner_entity       text NOT NULL,                       -- heat counts independent entities, not feeds
  launch_tier        text NOT NULL,
  language           text,
  region             text,
  enabled            boolean NOT NULL DEFAULT true,       -- platform-side override (hide from readers); the plugin has its own
  retired_at         timestamptz(3),
  plugin_health      text NOT NULL DEFAULT 'new',         -- as reported; unknown values are kept verbatim and shown as degraded
  last_ok_at         timestamptz(3),
  last_new_entry_at  timestamptz(3),
  entries_7d         integer NOT NULL DEFAULT 0,
  selected_30d       integer NOT NULL DEFAULT 0,          -- the platform's own count
  registry_sha256    text,
  mirrored_at        timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_sources_lane_idx ON evimed_frontier.sources (lane) WHERE retired_at IS NULL;

-- What the plugin delivered, one row per (entry_id, revision) received, with the platform's processing state. The
-- processing queue is the partial index below. Rows that produced nothing are purged after 30 days; rows behind a
-- published item stay (they are the item's provenance).
CREATE TABLE IF NOT EXISTS evimed_frontier.entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_entry_id text NOT NULL CHECK (char_length(plugin_entry_id) BETWEEN 3 AND 200),
  plugin_seq      bigint NOT NULL,           -- the cursor position this row came from
  revision        integer NOT NULL DEFAULT 1,
  source_id       text NOT NULL REFERENCES evimed_frontier.sources(id),
  identity_key    text NOT NULL,             -- doi: | pmid: | wx:<biz>:<mid>:<idx> | reg:<id>:<event>:<date> | fda:<app>:<suppl> | url:<sha256>
  url             text NOT NULL CHECK (char_length(url) <= 2048),
  canonical_url   text NOT NULL CHECK (char_length(canonical_url) <= 2048),
  doi             text,
  pmid            text,
  registry_ids    text[] NOT NULL DEFAULT '{}',
  title_raw       text NOT NULL CHECK (char_length(title_raw) BETWEEN 1 AND 1000),
  summary_raw     text CHECK (char_length(summary_raw) <= 20000),
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the contract's whitelisted adapter facts, as received
  lang            text NOT NULL DEFAULT 'und',
  lane_hint       text,
  published_at    timestamptz(3),
  date_precision  text NOT NULL DEFAULT 'instant' CHECK (date_precision IN ('instant', 'day', 'inferred')),
  first_seen_at   timestamptz(3) NOT NULL,   -- the plugin's clock
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
-- The second time axis (by=published): "what did NEJM publish this week" reads this, the default lists read timeline_at.
CREATE INDEX IF NOT EXISTS frontier_items_published_idx
  ON evimed_frontier.items (published_at DESC, id DESC) WHERE state = 'published' AND published_at IS NOT NULL;

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

-- The platform's own snapshot of what it published from: the plugin purges its copy after 30-90 days, the reader
-- and the number check need this for ever.
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
  open_access        text,                     -- gold | green | bronze | closed | unknown
  enrichment         jsonb NOT NULL DEFAULT '{}'::jsonb   -- impact_factor, core_journal_tags, trial_facts, … as the plugin gave them
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
  source_count_72h integer NOT NULL DEFAULT 1,             -- independent owner entities reporting in the last 72 h
  report_count    integer NOT NULL DEFAULT 1,              -- every report over the event's life
  entity_count    integer NOT NULL DEFAULT 1,              -- distinct owner entities over the event's life
  has_primary     boolean NOT NULL DEFAULT false,
  heat            double precision NOT NULL DEFAULT 0,     -- decayed sum (half-life 36 h); no age cut-off, the decay is the window
  heat_updated_at timestamptz(3),
  first_at        timestamptz(3) NOT NULL,
  last_at         timestamptz(3) NOT NULL,
  digest_state    text NOT NULL DEFAULT 'none' CHECK (digest_state IN ('none', 'written', 'stale')),  -- written only once on the hot list or with a primary
  digest_revision integer NOT NULL DEFAULT 0,
  merged_into     bigint REFERENCES evimed_frontier.events(id) ON DELETE SET NULL,  -- the old id keeps resolving: 308 to the survivor
  merged_at       timestamptz(3),
  updated_at      timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_events_recent_idx ON evimed_frontier.events (last_at DESC) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS frontier_events_hot_idx ON evimed_frontier.events (heat DESC) WHERE merged_into IS NULL AND status = 'developing';

-- Every public id an event has ever had. A merge adds the absorbed event's id here; the event page and the tool answer
-- the old id with a permanent redirect, so inbox links, stars, Feishu cards and saved drafts never break.
CREATE TABLE IF NOT EXISTS evimed_frontier.event_aliases (
  public_id text PRIMARY KEY,
  event_id  bigint NOT NULL REFERENCES evimed_frontier.events(id) ON DELETE CASCADE
);

-- Edges between events: the chain a medical story actually follows (signal -> PRAC review -> label change -> withdrawal;
-- preprint -> publication -> retraction). Flat events cannot show this and it cannot be added cheaply later.
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
  window_start timestamptz(3) NOT NULL,             -- the cut the issue actually used (07:00 the day before …
  window_end   timestamptz(3) NOT NULL,             -- … to 07:00), stored so an issue can be audited against itself
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

-- Change log for downstream copies: knowledge-base saves, Feishu cards, and any future public feed learn about
-- withdrawals and corrections from here (a time window cannot express "remove"). Kept 90 days.
CREATE TABLE IF NOT EXISTS evimed_frontier.item_changes (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    bigint NOT NULL,
  op         text NOT NULL CHECK (op IN ('upsert', 'remove')),
  reason     text NOT NULL,                          -- published | rescored | selected | withdrawn | retracted | corrected
  changed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_item_changes_retention_idx ON evimed_frontier.item_changes (changed_at);

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
