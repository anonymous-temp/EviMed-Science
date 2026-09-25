/**
 * 「循证 GEO」's own schema, `evimed_geo` (build spec 2026-09-25 §2).
 *
 * Hidden knowledge:
 *
 * - **One DDL for every package.** The content side (projects, claims, the
 *   question map, strategy, targets, sources, articles), the measurement side
 *   (rounds, probe jobs, snapshots, facts, errors, metrics) and the market side
 *   (media, orders, the ledger, top-ups, reconciliations) are all created here,
 *   so each package codes against one schema and none of them migrates a table
 *   another reads. Additive and idempotent: every statement is `IF NOT EXISTS`,
 *   and a column added later is `ADD COLUMN IF NOT EXISTS` below the tables.
 * - **Tenancy is a column, checked in code.** Every tenant table carries
 *   `user_id`; there is no foreign key into `evimed_control` (the frontier
 *   schema's reader tables have one, but these rows are cleaned up by the two
 *   deletion paths explicitly — `deleteGeoProjectRows`/`deleteGeoUserRows` in
 *   `geoStore.mjs` — and the money tables must outlive both). The catalogue
 *   and the platform's own ledger tables (`media`, `media_outcomes`, `topups`,
 *   `reconciliations`) are the platform's and carry none.
 * - **A GEO project is 1:1 with a control-plane project, per account.** The
 *   spec writes `project_id unique`; control-plane project ids are unique per
 *   user (`evimed_control.projects` keys on `(user_id, id)`), and ids derived
 *   from a brand name collide across accounts (two accounts naming a project
 *   「Wegovy」 both get `wegovy`). So the uniqueness is `(user_id, project_id)`.
 * - **Foreign keys only where the spec marks one**, each cascading from its
 *   parent: claims → projects, questions → question_groups, probe_jobs →
 *   rounds, facts → snapshots. `order_events → orders` does not cascade: an
 *   order's history is the money's audit trail and orders are never deleted.
 * - **Closed vocabularies are CHECKed from `@evimed/domain`'s geo vocabulary**,
 *   spliced as literals the module owns (every member matches `^[A-Za-z0-9_]+$`,
 *   asserted before splicing). Adding a word is then a migration the CHECK
 *   names — except `sources.kind`, which moves with the product and is checked
 *   in code only, like the frontier's lanes.
 * - **Two tables the spec does not list**, both versioned products the runtime
 *   writes through `geo_write` and the spec gives no home: `journeys` (the
 *   旅程 summary) and `placement_plans` (the run's outlet preferences, which
 *   the control plane reads and still decides against). And columns it does
 *   not list: `position` on question groups and questions (the order the run
 *   wrote them in), and the metrics package's `facts.red_flag_expected`,
 *   `red_flag_hits`, `safety_terms_hit` and `metrics.variant`, `rival`,
 *   `reason`.
 * - **The orchestrator's own bookkeeping** (`schedule_marks`, package F): one
 *   row per thing it did or decided once — a dispatched run, an enqueued
 *   round, a notice sent, an export asked for — keyed per project by a key
 *   that names the period it belongs to (`weekly:2026-09-28`,
 *   `postpub:<article>:w4`, `run:insight`). The primary key is what makes
 *   every schedule idempotent across ticks, restarts and processes: a key is
 *   claimed by inserting it, and a second claimer finds it taken.
 *
 * @module geoPersistence
 */

import {
  GEO_ARMS, GEO_ARTICLE_GATES, GEO_ARTICLE_LAYERS, GEO_ARTICLE_SAFETY, GEO_ARTICLE_STATUSES, GEO_AUDIENCES, GEO_CELL_STATUSES,
  GEO_CLAIM_SOURCE_KINDS, GEO_CLAIM_STATUSES, GEO_DATA_TYPES, GEO_ERROR_ACTIONS, GEO_ERROR_STATUSES, GEO_ERROR_TYPES,
  GEO_FAILURE_MODES, GEO_GROUP_SIGNALS, GEO_LEDGER_KINDS, GEO_MEDIA_TYPES, GEO_METRIC_ROW_SCOPES, GEO_ORDER_STATES, GEO_POOLS,
  GEO_PROBE_JOB_STATUSES, GEO_PROJECT_STATUSES, GEO_QUESTION_KINDS, GEO_RECONCILIATION_STATUSES, GEO_ROUND_KINDS,
  GEO_ROUND_STATUSES, GEO_SEVERITIES, GEO_SNAPSHOT_STATUSES, GEO_SOURCE_LAYERS, GEO_TIERS, GEO_TOPUP_STATUSES,
} from "@evimed/domain";

/** The schema name, written once. */
export const GEO_SCHEMA = "evimed_geo";

/**
 * Every table the migration creates, in creation order. The two deletion paths
 * and the integration test read this list; a table added below and not here is
 * a table nobody cleans up.
 */
export const GEO_TABLES = Object.freeze([
  "projects", "claims", "question_sets", "question_groups", "questions", "journeys", "rounds", "probe_jobs", "snapshots", "facts",
  "errors", "metrics", "strategy", "targets", "placement_plans", "sources", "articles",
  "media", "media_outcomes", "orders", "order_events", "ledger", "topups", "reconciliations", "schedule_marks",
]);

const migrations = new WeakMap();

/** `IN (...)` over a closed vocabulary, refusing any member that is not a plain word. @param {readonly string[]} words */
function inList(words) {
  for (const word of words) {
    if (!/^[A-Za-z0-9_]+$/.test(word)) throw new TypeError(`A GEO vocabulary word cannot be spliced into SQL: ${JSON.stringify(word)}`);
  }
  return `(${words.map((word) => `'${word}'`).join(", ")})`;
}

/** The whole schema. */
function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_geo;

CREATE TABLE IF NOT EXISTS evimed_geo.projects (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  project_id    text NOT NULL,
  product       jsonb NOT NULL DEFAULT '{}'::jsonb,
  competitors   jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage_days integer NOT NULL DEFAULT 90,
  engines       text[] NOT NULL,
  tier          text NOT NULL DEFAULT '2' CHECK (tier IN ${inList(GEO_TIERS)}),
  budget        jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ${inList(GEO_PROJECT_STATUSES)}),
  steps         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS geo_projects_user_idx ON evimed_geo.projects (user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS evimed_geo.claims (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL REFERENCES evimed_geo.projects(id) ON DELETE CASCADE,
  claim_key      text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  statement      text NOT NULL,
  quote          text NOT NULL,
  source_ref     text NOT NULL,
  source_kind    text CHECK (source_kind IN ${inList(GEO_CLAIM_SOURCE_KINDS)}),
  evidence_level text,
  population     text,
  in_label       boolean,
  elements       jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at    timestamptz,
  valid_until    timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ${inList(GEO_CLAIM_STATUSES)}),
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, claim_key, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.question_sets (
  geo_project_id text NOT NULL,
  version        integer NOT NULL,
  user_id        text NOT NULL,
  locked_at      timestamptz,
  measured_count integer,
  note           text,
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.question_groups (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  set_version      integer NOT NULL,
  pool             text CHECK (pool IN ${inList(GEO_POOLS)}),
  name             text,
  typical_question text,
  journey_stage    text,
  audience         text CHECK (audience IN ${inList(GEO_AUDIENCES)}),
  bridge           text,
  weight           numeric,
  is_control       boolean NOT NULL DEFAULT false,
  signal           text CHECK (signal IN ${inList(GEO_GROUP_SIGNALS)}),
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_question_groups_set_idx ON evimed_geo.question_groups (geo_project_id, set_version);

CREATE TABLE IF NOT EXISTS evimed_geo.questions (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL,
  group_id       text NOT NULL REFERENCES evimed_geo.question_groups(id) ON DELETE CASCADE,
  set_version    integer NOT NULL,
  text           text NOT NULL,
  kind           text CHECK (kind IN ${inList(GEO_QUESTION_KINDS)}),
  pool           text CHECK (pool IN ${inList(GEO_POOLS)}),
  platform       text,
  source_url     text,
  collected_at   timestamptz,
  is_measured    boolean NOT NULL DEFAULT false,
  retired_at     timestamptz,
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_questions_set_idx ON evimed_geo.questions (geo_project_id, set_version);
CREATE INDEX IF NOT EXISTS geo_questions_group_idx ON evimed_geo.questions (group_id);

CREATE TABLE IF NOT EXISTS evimed_geo.journeys (
  geo_project_id text NOT NULL,
  version        integer NOT NULL,
  user_id        text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.rounds (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ${inList(GEO_ROUND_KINDS)}),
  set_version    integer,
  engines        text[],
  surface        jsonb NOT NULL DEFAULT '{"mode":"web","deep":false,"newChat":true,"city":null}'::jsonb,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ${inList(GEO_ROUND_STATUSES)}),
  planned        integer NOT NULL DEFAULT 0,
  done           integer NOT NULL DEFAULT 0,
  failed         integer NOT NULL DEFAULT 0,
  sample_date    date,
  ref            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS geo_rounds_project_idx ON evimed_geo.rounds (geo_project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS geo_rounds_open_idx ON evimed_geo.rounds (status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS evimed_geo.probe_jobs (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  round_id       text NOT NULL REFERENCES evimed_geo.rounds(id) ON DELETE CASCADE,
  geo_project_id text NOT NULL,
  question_id    text NOT NULL,
  engine         text NOT NULL,
  repeat_index   integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ${inList(GEO_PROBE_JOB_STATUSES)}),
  attempts       integer NOT NULL DEFAULT 0,
  run_after      timestamptz,
  lease_owner    text,
  lease_until    timestamptz,
  snapshot_id    text,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, question_id, engine, repeat_index)
);
CREATE INDEX IF NOT EXISTS geo_probe_jobs_queue_idx ON evimed_geo.probe_jobs (status, run_after) WHERE status IN ('queued', 'leased');

CREATE TABLE IF NOT EXISTS evimed_geo.snapshots (
  id                text PRIMARY KEY,
  user_id           text NOT NULL,
  round_id          text,
  geo_project_id    text NOT NULL,
  question_id       text,
  engine            text,
  asked_at          timestamptz,
  status            text CHECK (status IN ${inList(GEO_SNAPSHOT_STATUSES)}),
  answer_text       text,
  answer_sha256     text,
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshot_sha256 text,
  surface           jsonb,
  latency_ms        integer,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_snapshots_round_idx ON evimed_geo.snapshots (round_id);
CREATE INDEX IF NOT EXISTS geo_snapshots_question_idx ON evimed_geo.snapshots (geo_project_id, question_id, engine, asked_at DESC);

CREATE TABLE IF NOT EXISTS evimed_geo.facts (
  snapshot_id         text PRIMARY KEY REFERENCES evimed_geo.snapshots(id) ON DELETE CASCADE,
  user_id             text NOT NULL,
  geo_project_id      text NOT NULL,
  brands              jsonb NOT NULL DEFAULT '[]'::jsonb,
  mentions_ours       boolean,
  first_ours          boolean,
  recommended_ours    boolean,
  position_ours       integer,
  brands_mentioned    integer,
  retrieval_triggered boolean,
  cites_ours          boolean,
  cites_ours_in_body  boolean,
  care_hint           boolean,
  statements          jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flag_expected   jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flag_hits       jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_terms_hit    jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_mode        text CHECK (failure_mode IN ${inList(GEO_FAILURE_MODES)}),
  parser_version      text,
  judged_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_facts_project_idx ON evimed_geo.facts (geo_project_id);

CREATE TABLE IF NOT EXISTS evimed_geo.errors (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL,
  geo_project_id     text NOT NULL,
  fingerprint        text NOT NULL,
  engine             text NOT NULL,
  question_id        text,
  first_snapshot_id  text,
  last_snapshot_id   text,
  statement          text,
  error_type         text CHECK (error_type IN ${inList(GEO_ERROR_TYPES)}),
  severity           text CHECK (severity IN ${inList(GEO_SEVERITIES)}),
  severity_basis     text NOT NULL DEFAULT 'initial',
  claim_id           text,
  evidence_quote     text,
  confirm            jsonb,
  cited_source       jsonb,
  action             text CHECK (action IN ${inList(GEO_ERROR_ACTIONS)}),
  responsible        text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ${inList(GEO_ERROR_STATUSES)}),
  closed_snapshot_id text,
  materials          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, fingerprint, engine)
);
CREATE INDEX IF NOT EXISTS geo_errors_project_idx ON evimed_geo.errors (geo_project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS evimed_geo.metrics (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL,
  round_id       text,
  scope          text NOT NULL CHECK (scope IN ${inList(GEO_METRIC_ROW_SCOPES)}),
  pool           text,
  engine         text,
  group_id       text,
  arm            text CHECK (arm IN ${inList(GEO_ARMS)}),
  metric_id      text NOT NULL,
  variant        text,
  rival          text,
  reason         text,
  numerator      numeric,
  denominator    numeric,
  value          numeric,
  ci_low         numeric,
  ci_high        numeric,
  status         text NOT NULL CHECK (status IN ${inList(GEO_CELL_STATUSES)}),
  data_type      text NOT NULL DEFAULT 'measured' CHECK (data_type IN ${inList(GEO_DATA_TYPES)}),
  snapshot_count integer,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_metrics_lookup_idx ON evimed_geo.metrics (geo_project_id, metric_id, computed_at);
CREATE INDEX IF NOT EXISTS geo_metrics_round_idx ON evimed_geo.metrics (round_id);

CREATE TABLE IF NOT EXISTS evimed_geo.strategy (
  geo_project_id text NOT NULL,
  version        integer NOT NULL,
  user_id        text NOT NULL,
  battlefield    jsonb,
  expectations   jsonb,
  gaps           jsonb,
  layout         jsonb,
  summary        text,
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.targets (
  geo_project_id text NOT NULL,
  version        integer NOT NULL,
  user_id        text NOT NULL,
  tier           text NOT NULL CHECK (tier IN ${inList(GEO_TIERS)}),
  metric_id      text NOT NULL,
  pool           text NOT NULL,
  baseline       numeric,
  target         numeric,
  horizon_weeks  integer,
  placements     integer,
  budget_cny     numeric,
  data_type      text NOT NULL DEFAULT 'forecast' CHECK (data_type IN ${inList(GEO_DATA_TYPES)}),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version, tier, metric_id, pool)
);

CREATE TABLE IF NOT EXISTS evimed_geo.placement_plans (
  geo_project_id text NOT NULL,
  version        integer NOT NULL,
  user_id        text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.sources (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  domain           text NOT NULL,
  name             text,
  kind             text,
  layer            text CHECK (layer IN ${inList(GEO_SOURCE_LAYERS)}),
  icp_owner        text,
  icp_matches      boolean,
  news_indexed     boolean,
  medical_vertical boolean,
  impostor         boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  checked_at       timestamptz,
  cited            jsonb NOT NULL DEFAULT '{}'::jsonb,
  mentions_ours    integer NOT NULL DEFAULT 0,
  wrong_ours       integer NOT NULL DEFAULT 0,
  market           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, domain)
);

CREATE TABLE IF NOT EXISTS evimed_geo.articles (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  run_id           text,
  deliverable_id   text,
  path             text,
  layer            text CHECK (layer IN ${inList(GEO_ARTICLE_LAYERS)}),
  title            text,
  group_id         text,
  claim_ids        text[] NOT NULL DEFAULT '{}',
  gate             text CHECK (gate IN ${inList(GEO_ARTICLE_GATES)}),
  safety           text NOT NULL DEFAULT 'open' CHECK (safety IN ${inList(GEO_ARTICLE_SAFETY)}),
  content_sha256   text,
  protected_sha256 text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ${inList(GEO_ARTICLE_STATUSES)}),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_articles_project_idx ON evimed_geo.articles (geo_project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS geo_articles_path_key ON evimed_geo.articles (geo_project_id, path) WHERE path IS NOT NULL;

CREATE TABLE IF NOT EXISTS evimed_geo.media (
  resource_id      text NOT NULL,
  media_type       text NOT NULL CHECK (media_type IN ${inList(GEO_MEDIA_TYPES)}),
  name             text,
  domain           text,
  domain_verified  boolean,
  icp_owner        text,
  fields           jsonb,
  price_cny        numeric,
  publish_rate     numeric,
  publish_seconds  integer,
  remarks          text,
  case_link        text,
  flags            jsonb,
  available        boolean,
  blacklisted      boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  price_history    jsonb NOT NULL DEFAULT '[]'::jsonb,
  synced_at        timestamptz,
  PRIMARY KEY (media_type, resource_id)
);
CREATE INDEX IF NOT EXISTS geo_media_domain_idx ON evimed_geo.media (domain);
CREATE INDEX IF NOT EXISTS geo_media_available_idx ON evimed_geo.media (available, blacklisted, price_cny);

CREATE TABLE IF NOT EXISTS evimed_geo.media_outcomes (
  media_type  text NOT NULL,
  resource_id text NOT NULL,
  engine      text NOT NULL,
  placed      integer NOT NULL DEFAULT 0,
  cited       integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, resource_id, engine)
);

CREATE TABLE IF NOT EXISTS evimed_geo.orders (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  article_id       text,
  media_type       text CHECK (media_type IN ${inList(GEO_MEDIA_TYPES)}),
  resource_id      text,
  vendor_order_nid text UNIQUE,
  state            text NOT NULL DEFAULT 'planned' CHECK (state IN ${inList(GEO_ORDER_STATES)}),
  reserve_cny      numeric,
  price_cny        numeric,
  settled_cny      numeric,
  body_sha256      text,
  published_url    text,
  checks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  appeal           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_orders_project_idx ON evimed_geo.orders (geo_project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS geo_orders_state_idx ON evimed_geo.orders (state);
CREATE INDEX IF NOT EXISTS geo_orders_outlet_idx ON evimed_geo.orders (media_type, resource_id);

CREATE TABLE IF NOT EXISTS evimed_geo.order_events (
  id         text PRIMARY KEY,
  order_id   text NOT NULL REFERENCES evimed_geo.orders(id),
  at         timestamptz NOT NULL DEFAULT now(),
  from_state text,
  to_state   text,
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS geo_order_events_order_idx ON evimed_geo.order_events (order_id, at);

CREATE TABLE IF NOT EXISTS evimed_geo.ledger (
  id             text PRIMARY KEY,
  user_id        text,
  geo_project_id text,
  order_id       text,
  kind           text NOT NULL CHECK (kind IN ${inList(GEO_LEDGER_KINDS)}),
  amount_cny     numeric(12,2) NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_ledger_project_idx ON evimed_geo.ledger (geo_project_id, created_at);
CREATE INDEX IF NOT EXISTS geo_ledger_order_idx ON evimed_geo.ledger (order_id);
CREATE INDEX IF NOT EXISTS geo_ledger_kind_idx ON evimed_geo.ledger (geo_project_id, kind);
CREATE INDEX IF NOT EXISTS geo_ledger_created_idx ON evimed_geo.ledger (created_at);

CREATE TABLE IF NOT EXISTS evimed_geo.topups (
  id             text PRIMARY KEY,
  amount_cny     numeric,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ${inList(GEO_TOPUP_STATUSES)}),
  balance_before numeric,
  balance_after  numeric,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  note           text
);

CREATE TABLE IF NOT EXISTS evimed_geo.reconciliations (
  day        date PRIMARY KEY,
  ours       numeric,
  vendor     numeric,
  balance    numeric,
  diff       numeric,
  status     text CHECK (status IN ${inList(GEO_RECONCILIATION_STATUSES)}),
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Added after the first cut, for the metrics package's cells (M-11 and M-12
-- read the red-flag and safety-term extractions; a cell carries its variant,
-- its rival and why it is not a number). In the tables above for a new schema,
-- and here for one created before them.
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS red_flag_expected jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS red_flag_hits jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.facts ADD COLUMN IF NOT EXISTS safety_terms_hit jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS rival text;
ALTER TABLE evimed_geo.metrics ADD COLUMN IF NOT EXISTS reason text;
-- The order the run wrote a question map in: one write is one statement, and
-- rows of one statement share their created_at.
ALTER TABLE evimed_geo.question_groups ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_geo.questions ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

-- The orchestrator's marks (package F): what it dispatched, enqueued, sent or
-- skipped, once per key. \`state\`: pending (asked for, not started), claimed
-- (being started), running, done, failed, skipped.
CREATE TABLE IF NOT EXISTS evimed_geo.schedule_marks (
  geo_project_id text NOT NULL,
  key            text NOT NULL,
  user_id        text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('run', 'round', 'notice', 'request')),
  state          text NOT NULL CHECK (state IN ('pending', 'claimed', 'running', 'done', 'failed', 'skipped')),
  run_id         text,
  session_id     text,
  dispatch_id    text,
  round_id       text,
  attempts       integer NOT NULL DEFAULT 0,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz,
  PRIMARY KEY (geo_project_id, key)
);
CREATE INDEX IF NOT EXISTS geo_schedule_marks_open_idx ON evimed_geo.schedule_marks (geo_project_id, kind, state)
  WHERE state IN ('pending', 'claimed', 'running');
`;
}

/**
 * Create or complete the schema: one transaction behind an advisory lock, so
 * two processes starting together cannot interleave their DDL. Cached per
 * database object; a failed attempt is forgotten so the next call retries.
 * @param {{ transaction: (operation: (client: any) => Promise<any>) => Promise<any> }} database
 * @returns {Promise<{ schema: string, tables: readonly string[] }>}
 */
export async function migrateGeo(database) {
  if (!database || typeof database.transaction !== "function") throw new TypeError("The GEO migration needs the product database.");
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-v1'))");
    await client.query(sql());
    return { schema: GEO_SCHEMA, tables: GEO_TABLES };
  });
  migrations.set(database, attempt);
  try { return await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
