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

-- ============================================================================================
-- Additions of the plugin build (2026-09-22). Everything above is the normative design draft,
-- byte for byte; everything below extends it idempotently. Why each one exists:
-- ============================================================================================

-- sources: the registry file's own switch and the operator's switch are separate. `enabled` stays
-- the effective value (the due index reads it): coalesce(operator_enabled, registry_enabled), so a
-- registry reload never overwrites an operator's decision (the note on the column above).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS registry_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS operator_enabled boolean;
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS category text;
-- Contract 1.3.0 (flywheel F09, 2026-10-05): the source's content is produced by the platform that consumes the plugin.
-- Only a label for the platform; polling, parsing and de-duplication treat it like any other source.
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS platform_produced boolean NOT NULL DEFAULT false;
-- Claim order when several sources are due: 0 safety feeds and regulators, 1 journals and open
-- APIs, 2 media and companies, 3 societies and conferences (plan 10.2.2 "优先级").
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 2;
-- The adapter-private cursor (ParseOutput.cursor of the last successful poll).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS cursor jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The URL the stored ETag / Last-Modified belong to: validators are only sent back to that URL.
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS last_url text;
-- Incremental journal queries re-read their whole 7-day window once a day (plan 10.2.2).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS last_full_scan_at timestamptz(3);
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz(3);
-- A periodic deep walk (config.full_walk_every_s) records when it was last tried, so a failing walk
-- is retried at most once a day (batch 2, the STAR ratings).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS last_full_attempt_at timestamptz(3);
-- Start of the current failure streak: three days of it is `unreadable` (plan 10.2.8).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS failing_since timestamptz(3);
-- Adaptive cadence: consecutive successful polls without a new entry (x1.5 after three).
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS empty_polls integer NOT NULL DEFAULT 0;
-- Drift (plan 10.2.8): a list that used to have items parses to zero, or its dates all vanish.
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS last_nonempty_at timestamptz(3);
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS zero_streak integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS ever_dated boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS undated_streak integer NOT NULL DEFAULT 0;
-- The host of the source's first request (from config.url, set at registry sync): a claim takes at
-- most one due source per host and skips hosts with a poll in flight, so four workers do not all
-- queue on the one Crossref slot while every other host waits.
ALTER TABLE evimed_knowledge.sources ADD COLUMN IF NOT EXISTS host text;
CREATE INDEX IF NOT EXISTS knowledge_sources_claim_idx
  ON evimed_knowledge.sources (priority, next_poll_at) WHERE enabled AND retired_at IS NULL;

-- fetches: the host a poll talked to (per-host health and budget questions), and the adapter's notes.
ALTER TABLE evimed_knowledge.fetches ADD COLUMN IF NOT EXISTS host text;
ALTER TABLE evimed_knowledge.fetches ADD COLUMN IF NOT EXISTS requests integer NOT NULL DEFAULT 1;

-- fetches.outcome gains 'empty-body' (review 2026-10-10, D-07): a 204 or a body with nothing in it, the source's failure, where
-- 'empty' stays the name of a page that parsed to no entries. The list is a CHECK made with the table and a table that exists
-- keeps the one it was made with, so the constraint is replaced once, when it does not name the outcome yet; a second run
-- finds it there and changes nothing. (Without this, the first such poll after an upgrade is refused by the database.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'evimed_knowledge.fetches'::regclass AND conname = 'fetches_outcome_check'
                    AND pg_get_constraintdef(oid) LIKE '%''empty-body''%') THEN
    ALTER TABLE evimed_knowledge.fetches DROP CONSTRAINT IF EXISTS fetches_outcome_check;
    ALTER TABLE evimed_knowledge.fetches ADD CONSTRAINT fetches_outcome_check CHECK (outcome IN
      ('ok', 'not-modified', 'empty', 'empty-body', 'challenge', 'blocked', 'timeout', 'http-error', 'parse-error',
       'robots-denied', 'host-budget', 'too-large'));
  END IF;
END $$;

-- entries: the operator/test filter by source reads (source_id, seq).
CREATE INDEX IF NOT EXISTS knowledge_entries_source_seq_idx ON evimed_knowledge.entries (source_id, seq);

-- entry_texts: why the last attempt did not produce text (a short code, never a URL or a key).
ALTER TABLE evimed_knowledge.entry_texts ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS knowledge_entry_texts_due_idx
  ON evimed_knowledge.entry_texts (next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- seen_keys: the last delivered revision, so an entry that returns with new content after its row
-- was purged continues its revision sequence instead of repeating (entry_id, 1) — the platform
-- stores (entry_id, revision) with ON CONFLICT DO NOTHING and would drop a repeated pair silently.
ALTER TABLE evimed_knowledge.seen_keys ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

-- Per-host request counts per UTC day, persisted: the NCBI and openFDA allowances are per IP/key
-- and shared with the platform's research runs, so a restart must not reset what was spent
-- (review finding 13 #9: "计数只在内存里，重启就清零").
CREATE TABLE IF NOT EXISTS evimed_knowledge.host_counters (
  host      text NOT NULL,
  day       date NOT NULL,
  requests  integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (host, day)
);

-- A host that answered 429 / Retry-After is paused as a whole, across restarts (plan 10.2.2).
CREATE TABLE IF NOT EXISTS evimed_knowledge.host_state (
  host          text PRIMARY KEY,
  paused_until  timestamptz(3),
  pause_reason  text,
  updated_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

-- Small facts of the instance: schema version, the purge watermark behind oldest_seq_available.
CREATE TABLE IF NOT EXISTS evimed_knowledge.meta (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

-- fr-sources 2026-10-22 ---------------------------------------------------------------------------------------------
-- Automatic source discovery and the source lifecycle (discovery.py, lifecycle.py). Candidates found by the candidate
-- lines are validated (reachable, robots, an adapter reads them, fresh items, medical), put on a seven-day trial as
-- ordinary registry rows at a low rate, then admitted or not; any source — file, discovered or dynamic — is retired by
-- rule (robots refusal, 401/403 for seven days, silence past its own rhythm, off-topic by the platform's screen) and
-- keeps its row and history, so it can come back.

-- One row per thing a line found: a site, a feed, a journal (ISSN), a social account, a requested row, a retired
-- source due for a re-check. `key` is the canonical identity (a feed or homepage URL, `issn:<ISSN-L>`,
-- `x:<handle>`, `source:<id>`), unique across lines: the first line that found it owns it, the rest add evidence.
CREATE TABLE IF NOT EXISTS evimed_knowledge.source_candidates (
  id               text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 120),
  line             text NOT NULL,
  key              text NOT NULL UNIQUE CHECK (char_length(key) BETWEEN 1 AND 2048),
  name             text,
  first_seen_at    timestamptz(3) NOT NULL,
  last_seen_at     timestamptz(3) NOT NULL,
  sightings        integer NOT NULL DEFAULT 1 CHECK (sightings >= 1),
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,       -- where it was seen: referring sources, lines, volumes
  state            text NOT NULL DEFAULT 'candidate'
                   CHECK (state IN ('candidate', 'trial', 'admitted', 'retired', 'failed', 'rejected')),
  state_reason     text,
  state_at         timestamptz(3) NOT NULL,
  attempts         smallint NOT NULL DEFAULT 0,
  next_check_at    timestamptz(3),                           -- a candidate whose validation was deferred
  medical_basis    text,                                     -- data that makes it medical: nlm-catalog, pubmed-stream, directory, request
  source_id        text,                                     -- the registry row's id once validated
  row              jsonb,                                    -- the registry row validation built (trial, admitted)
  validation       jsonb,                                    -- what the probe found: exit, feed, fresh items, sample titles
  trial_started_at timestamptz(3),
  trial_until      timestamptz(3)
);
CREATE INDEX IF NOT EXISTS knowledge_source_candidates_state_idx
  ON evimed_knowledge.source_candidates (state, line, next_check_at);
CREATE INDEX IF NOT EXISTS knowledge_source_candidates_source_idx
  ON evimed_knowledge.source_candidates (source_id) WHERE source_id IS NOT NULL;

-- Daily counts by line (Asia/Shanghai day): what /v1/health `discovery` reports. A transition adds one to its column
-- on the day it happens; net growth is admitted minus retired.
CREATE TABLE IF NOT EXISTS evimed_knowledge.discovery_daily (
  day        date NOT NULL,
  line       text NOT NULL,
  candidates integer NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  validated  integer NOT NULL DEFAULT 0 CHECK (validated >= 0),
  trial      integer NOT NULL DEFAULT 0 CHECK (trial >= 0),
  admitted   integer NOT NULL DEFAULT 0 CHECK (admitted >= 0),
  retired    integer NOT NULL DEFAULT 0 CHECK (retired >= 0),
  failed     integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  PRIMARY KEY (day, line)
);

-- Sources the lifecycle retired, whatever their origin. The registry composition leaves them out, so the sync marks
-- them retired (`retired_at`) and nothing polls them; the row, its entries and its fetch history stay. A re-check that
-- finds the source readable, permitted and fresh again deletes the row here and the source comes back.
CREATE TABLE IF NOT EXISTS evimed_knowledge.source_lifecycle (
  source_id     text PRIMARY KEY,
  reason        text NOT NULL CHECK (reason IN ('robots', 'forbidden', 'silent', 'off-topic')),
  line          text NOT NULL,                              -- `registry` for a file row, else the candidate's line
  decided_at    timestamptz(3) NOT NULL,
  recheck_after timestamptz(3),                             -- null: never re-checked automatically (off-topic)
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The platform's own screening verdicts on each source's entries (POST /v1/sources/screening): how many it screened
-- and how many it judged not medical over its window. The plugin makes no content judgement; trials and the
-- off-topic rule read these.
CREATE TABLE IF NOT EXISTS evimed_knowledge.source_screening (
  source_id   text PRIMARY KEY,
  screened    integer NOT NULL CHECK (screened >= 0),
  off_topic   integer NOT NULL CHECK (off_topic >= 0 AND off_topic <= screened),
  window_days smallint NOT NULL CHECK (window_days BETWEEN 1 AND 30),
  reported_at timestamptz(3) NOT NULL
);
-- How many of the source's items the platform selected (its own window, 30 days): a source that put one item in the
-- selected feed is never retired as off-topic, however much else it sends (2026-10-22: 中国政府网 最新政策, 1 selected).
ALTER TABLE evimed_knowledge.source_screening ADD COLUMN IF NOT EXISTS selected integer CHECK (selected >= 0);

-- fr-social 2026-10-22
-- Contract 1.5.0: social posts. What a post carries beside the common fields, on the entry as delivered: the channel (every
-- entry delivered from 1.5.0 on; older rows keep NULL and are delivered without it), the platform, the author, the stored
-- media (ids of evimed_knowledge.media), the post it quotes and the platform's own counts when it was read.
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS author jsonb;
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS quoted jsonb;
ALTER TABLE evimed_knowledge.entries ADD COLUMN IF NOT EXISTS metrics jsonb;
-- The full text (`/text` body_text): a post or article as it arrived, or the readable text of a page; 40,000 characters.
ALTER TABLE evimed_knowledge.entry_texts ADD COLUMN IF NOT EXISTS body_text text CHECK (char_length(body_text) <= 40000);
-- entry_texts.fetched_from gains 'x' and 'social' (a CHECK made with the table, replaced once, the way fetches.outcome was).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'evimed_knowledge.entry_texts'::regclass AND conname = 'entry_texts_fetched_from_check'
                    AND pg_get_constraintdef(oid) LIKE '%''social''%') THEN
    ALTER TABLE evimed_knowledge.entry_texts DROP CONSTRAINT IF EXISTS entry_texts_fetched_from_check;
    ALTER TABLE evimed_knowledge.entry_texts ADD CONSTRAINT entry_texts_fetched_from_check CHECK (fetched_from IN
      ('pubmed', 'europepmc', 'crossref', 'page', 'browser', 'relay', 'evimed-api', 'wechat', 'x', 'social'));
  END IF;
END $$;

-- The media store's index (the bytes are files under KNOWLEDGE_PLUGIN_MEDIA_DIR, named by their sha256): one row per stored
-- image, never deleted. Eviction (least recently served first, past the store's cap) removes the file and sets evicted_at;
-- the row keeps the id and the original address, so an entry that names the image keeps naming it.
CREATE TABLE IF NOT EXISTS evimed_knowledge.media (
  id              text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes           integer NOT NULL CHECK (bytes > 0 AND bytes <= 1572864),
  width           integer,
  height          integer,
  original_url    text NOT NULL CHECK (char_length(original_url) <= 2048),
  stored_at       timestamptz(3) NOT NULL,
  last_served_at  timestamptz(3),
  evicted_at      timestamptz(3)
);
CREATE INDEX IF NOT EXISTS knowledge_media_original_idx ON evimed_knowledge.media (original_url);
CREATE INDEX IF NOT EXISTS knowledge_media_lru_idx
  ON evimed_knowledge.media ((coalesce(last_served_at, stored_at))) WHERE evicted_at IS NULL;
-- An original that could not be stored (not an image, too big to re-encode, refused), so it is not fetched again on every
-- sighting; retried after a day.
CREATE TABLE IF NOT EXISTS evimed_knowledge.media_failures (
  original_url  text PRIMARY KEY CHECK (char_length(original_url) <= 2048),
  failed_at     timestamptz(3) NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) <= 200)
);

-- Every call to a paid provider (SocialData, Dajiala) and to the GEO social crawler, with what it cost: the daily caps are
-- sums over this table (Asia/Shanghai calendar day), /v1/health's `providers` reads its last 24 h. Kept 30 days.
CREATE TABLE IF NOT EXISTS evimed_knowledge.provider_calls (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider    text NOT NULL CHECK (char_length(provider) <= 40),
  called_at   timestamptz(3) NOT NULL,
  purpose     text NOT NULL CHECK (char_length(purpose) <= 60),
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'missing', 'refused', 'rate-limited', 'balance', 'failed')),
  objects     integer NOT NULL DEFAULT 0 CHECK (objects >= 0),
  amount      numeric(12, 6) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency    text NOT NULL CHECK (char_length(currency) <= 12),
  remaining   numeric(14, 4),
  error       text CHECK (char_length(error) <= 200)
);
CREATE INDEX IF NOT EXISTS knowledge_provider_calls_idx ON evimed_knowledge.provider_calls (provider, called_at DESC);
