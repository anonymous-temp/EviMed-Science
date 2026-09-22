-- evimed_knowledge: the knowledge-source plugin's own store (design draft, 2026-09-22).
-- Owned and released by the plugin team, in its own PostgreSQL database on the Beijing host (a second database in the
-- production instance, role evimed_knowledge; the platform never connects to it). Everything here is either rebuildable
-- by crawling again or small: the team backs up `sources` and `seen_keys` daily, the rest is not worth a dump.
-- Validated on PostgreSQL 16 by tools/check_schema.sh (applied twice; the second run must be a no-op).

CREATE SCHEMA IF NOT EXISTS evimed_knowledge;

-- Runtime state of the registry file and, through its partial index, the collection queue. The file says what a source
-- IS; this table says what happened to it. A row missing from the file is retired, never deleted.
CREATE TABLE IF NOT EXISTS evimed_knowledge.sources (
  id                   text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  name                 text NOT NULL,
  homepage             text,
  lane                 text NOT NULL,                                     -- platform vocabulary; 'mixed' = per-entry
  source_type          text NOT NULL,
  access               text NOT NULL,
  egress               text NOT NULL CHECK (egress IN ('direct', 'browser', 'relay', 'bridge', 'api')),
  authority            smallint NOT NULL DEFAULT 2 CHECK (authority BETWEEN 1 AND 5),
  safety_feed          boolean NOT NULL DEFAULT false,                    -- official safety-alert feeds only
  owner_entity         text NOT NULL,                                     -- independent-source counts are by entity
  launch_tier          text NOT NULL CHECK (launch_tier IN ('P0', 'P1', 'P2')),
  language             text,
  region               text,
  config               jsonb NOT NULL DEFAULT '{}'::jsonb,                -- url template, selectors, date field, allowed hosts
  registry_sha256      text NOT NULL CHECK (registry_sha256 ~ '^[a-f0-9]{64}$'),
  enabled              boolean NOT NULL DEFAULT true,                     -- operator override; survives a registry reload
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
  first_contact_at     timestamptz(3),                                    -- backfill protection is relative to this
  updated_at           timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_due_idx
  ON evimed_knowledge.sources (egress, next_poll_at) WHERE enabled AND retired_at IS NULL;

-- One row per poll; health, drift and the sources page read it. Kept 14 days.
CREATE TABLE IF NOT EXISTS evimed_knowledge.fetches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL REFERENCES evimed_knowledge.sources(id) ON DELETE CASCADE,
  fetched_at     timestamptz(3) NOT NULL,
  egress         text NOT NULL,
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
CREATE INDEX IF NOT EXISTS knowledge_fetches_source_idx ON evimed_knowledge.fetches (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_fetches_retention_idx ON evimed_knowledge.fetches (fetched_at);

-- Every sighting of every thing, normalised, one row per (source, external key). `seq` is the delivery cursor the
-- platform reads with GET /v1/entries?after=; a content change bumps revision and seq. Whitelisted fields only.
CREATE TABLE IF NOT EXISTS evimed_knowledge.entries (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id        text NOT NULL UNIQUE CHECK (char_length(entry_id) BETWEEN 3 AND 200),   -- <source_id>:<sha256(external_key)[0:32]>
  source_id       text NOT NULL REFERENCES evimed_knowledge.sources(id),
  external_key    text NOT NULL CHECK (char_length(external_key) BETWEEN 1 AND 512),
  identity_key    text NOT NULL,             -- doi: | pmid: | wx:<biz>:<mid>:<idx> | reg:<id>:<event>:<date> | fda:<app>:<suppl> | url:<sha256>
  url             text NOT NULL CHECK (char_length(url) <= 2048),
  canonical_url   text NOT NULL CHECK (char_length(canonical_url) <= 2048),
  doi             text,
  pmid            text,
  registry_ids    text[] NOT NULL DEFAULT '{}',
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1000),
  summary         text CHECK (char_length(summary) <= 20000),
  lang            text NOT NULL DEFAULT 'und',
  lane_hint       text,
  published_at    timestamptz(3),
  date_precision  text NOT NULL DEFAULT 'instant' CHECK (date_precision IN ('instant', 'day', 'inferred')),
  first_seen_at   timestamptz(3) NOT NULL,
  content_sha256  text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  revision        integer NOT NULL DEFAULT 1,
  backfill        boolean NOT NULL DEFAULT false,
  defects         text[] NOT NULL DEFAULT '{}',
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the contract's whitelisted adapter facts, nothing else
  text_status     text NOT NULL DEFAULT 'none' CHECK (text_status IN ('none', 'pending', 'available', 'unavailable')),
  text_requested_at timestamptz(3),                     -- set when the platform asked; extends retention to 90 days
  delivered_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, external_key)
);
CREATE INDEX IF NOT EXISTS knowledge_entries_identity_idx ON evimed_knowledge.entries (identity_key);
CREATE INDEX IF NOT EXISTS knowledge_entries_retention_idx ON evimed_knowledge.entries (delivered_at);
CREATE INDEX IF NOT EXISTS knowledge_entries_text_queue_idx
  ON evimed_knowledge.entries (text_requested_at) WHERE text_status = 'pending';

-- Abstract, excerpt and deterministic enrichment, fetched on demand for the entries the platform asked about.
CREATE TABLE IF NOT EXISTS evimed_knowledge.entry_texts (
  entry_id          text PRIMARY KEY REFERENCES evimed_knowledge.entries(entry_id) ON DELETE CASCADE,
  revision          integer NOT NULL,
  text_kind         text NOT NULL DEFAULT 'none' CHECK (text_kind IN ('abstract', 'excerpt', 'full', 'none')),
  abstract          text,
  body_excerpt      text CHECK (char_length(body_excerpt) <= 20000),
  fetched_from      text CHECK (fetched_from IN ('pubmed', 'europepmc', 'crossref', 'page', 'browser', 'relay', 'evimed-api', 'wechat')),
  fetched_at        timestamptz(3),
  attempts          smallint NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz(3),
  enrichment        jsonb NOT NULL DEFAULT '{}'::jsonb   -- publication_types, mesh, journal, open_access, impact_factor, core_journal_tags, trial_facts, …
);

-- What a source has shown us, kept 400 days: without it deep feeds (MMWR back to 2019) and undated items come back
-- as new a month after `entries` is purged.
CREATE TABLE IF NOT EXISTS evimed_knowledge.seen_keys (
  source_id      text NOT NULL,
  key_sha256     text NOT NULL CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text,
  first_seen_at  timestamptz(3) NOT NULL,
  last_seen_at   timestamptz(3) NOT NULL,
  PRIMARY KEY (source_id, key_sha256)
);
CREATE INDEX IF NOT EXISTS knowledge_seen_keys_retention_idx ON evimed_knowledge.seen_keys (last_seen_at);
