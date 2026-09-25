/**
 * STUB — package B's stand-in for package A's `geoPersistence.mjs`.
 *
 * Package A owns the `evimed_geo` DDL (build spec §2). This file carries only
 * the tables the measurement package reads or writes, in the shape of the
 * build spec (and of A's branch where it already exists), plus the columns
 * agreed since the spec:
 *   facts.red_flag_expected / red_flag_hits / safety_terms_hit (jsonb arrays),
 *   metrics.variant / rival / reason (text),
 * and three the measurement package needs and asks A to carry:
 *   snapshots.probe_job_id (which job, so which repeat, produced a snapshot),
 *   probe_jobs.external_ref (the inclusion channel's request id),
 *   errors.notified_at (an S3+ error is notified exactly once).
 * `GeoMeasureStore.ready()` also adds those columns with `ADD COLUMN IF NOT
 * EXISTS`, so the package works on A's DDL either way.
 *
 * The lead drops this commit at merge and A's module takes its place; the one
 * name package B imports from it is `migrateGeo(database)`.
 *
 * @module geoPersistence
 */

const migrations = new WeakMap();

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
  tier          text NOT NULL DEFAULT '2' CHECK (tier IN ('1','2','3')),
  budget        jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  steps         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS evimed_geo.claims (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL REFERENCES evimed_geo.projects(id) ON DELETE CASCADE,
  claim_key      text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  statement      text NOT NULL,
  quote          text NOT NULL,
  source_ref     text NOT NULL,
  source_kind    text CHECK (source_kind IN ('label','guideline','trial','review','literature','regulator','other')),
  evidence_level text,
  population     text,
  in_label       boolean,
  elements       jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at    timestamptz,
  valid_until    timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','retired')),
  run_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, claim_key, version)
);

CREATE TABLE IF NOT EXISTS evimed_geo.question_groups (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  set_version      integer NOT NULL,
  pool             text CHECK (pool IN ('P1','P2','P3','P4')),
  name             text,
  typical_question text,
  journey_stage    text,
  audience         text CHECK (audience IN ('patient','physician')),
  bridge           text,
  weight           numeric,
  is_control       boolean NOT NULL DEFAULT false,
  signal           text CHECK (signal IN ('collected','partial','no_signal','client')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.questions (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL,
  group_id       text NOT NULL REFERENCES evimed_geo.question_groups(id) ON DELETE CASCADE,
  set_version    integer NOT NULL,
  text           text NOT NULL,
  kind           text CHECK (kind IN ('typical','real','label_safety','client')),
  pool           text CHECK (pool IN ('P1','P2','P3','P4')),
  platform       text,
  source_url     text,
  collected_at   timestamptz,
  is_measured    boolean NOT NULL DEFAULT false,
  retired_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

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
  kind           text NOT NULL CHECK (kind IN ('baseline','weekly','sentinel','post_publication','confirm','noise','single_step')),
  set_version    integer,
  engines        text[],
  surface        jsonb NOT NULL DEFAULT '{"mode":"web","deep":false,"newChat":true,"city":null}'::jsonb,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','partial','cancelled')),
  planned        integer NOT NULL DEFAULT 0,
  done           integer NOT NULL DEFAULT 0,
  failed         integer NOT NULL DEFAULT 0,
  sample_date    date,
  ref            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE TABLE IF NOT EXISTS evimed_geo.probe_jobs (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  round_id       text NOT NULL REFERENCES evimed_geo.rounds(id) ON DELETE CASCADE,
  geo_project_id text NOT NULL,
  question_id    text NOT NULL,
  engine         text NOT NULL,
  repeat_index   integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','done','failed','skipped')),
  attempts       integer NOT NULL DEFAULT 0,
  run_after      timestamptz,
  lease_owner    text,
  lease_until    timestamptz,
  snapshot_id    text,
  error_code     text,
  external_ref   text,
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
  status            text CHECK (status IN ('valid','suspect','refusal','failed')),
  answer_text       text,
  answer_sha256     text,
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshot_sha256 text,
  surface           jsonb,
  latency_ms        integer,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  probe_job_id      text,
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
  failure_mode        text CHECK (failure_mode IN ('omitted','correct','wrong_ours','wrong_competitor','none')),
  parser_version      text,
  judged_at           timestamptz,
  red_flag_expected   jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flag_hits       jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_terms_hit    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

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
  error_type         text CHECK (error_type IN ('label_conflict','number','dropped_condition','unfounded','attribute_swap')),
  severity           text CHECK (severity IN ('S0','S1','S2','S3','S4')),
  severity_basis     text NOT NULL DEFAULT 'initial',
  claim_id           text,
  evidence_quote     text,
  confirm            jsonb,
  cited_source       jsonb,
  action             text CHECK (action IN ('own_edit','correction_letter','encyclopedia_fix','report_and_cover','no_contact','continuous_supply')),
  responsible        text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acting','awaiting_remeasure','closed')),
  closed_snapshot_id text,
  materials          jsonb NOT NULL DEFAULT '[]'::jsonb,
  notified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, fingerprint, engine)
);

CREATE TABLE IF NOT EXISTS evimed_geo.metrics (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  geo_project_id text NOT NULL,
  round_id       text,
  scope          text NOT NULL CHECK (scope IN ('project','pool','engine','pool_engine','group','arm')),
  pool           text,
  engine         text,
  group_id       text,
  arm            text CHECK (arm IN ('pilot','control')),
  metric_id      text NOT NULL,
  variant        text,
  rival          text,
  reason         text,
  numerator      numeric,
  denominator    numeric,
  value          numeric,
  ci_low         numeric,
  ci_high        numeric,
  status         text NOT NULL CHECK (status IN ('ok','insufficient','not_measurable','absent')),
  data_type      text NOT NULL DEFAULT 'measured' CHECK (data_type IN ('measured','client_provided','derived','forecast','commercial')),
  snapshot_count integer,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_metrics_lookup_idx ON evimed_geo.metrics (geo_project_id, metric_id, computed_at);
CREATE INDEX IF NOT EXISTS geo_metrics_round_idx ON evimed_geo.metrics (round_id);

CREATE TABLE IF NOT EXISTS evimed_geo.sources (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  domain           text NOT NULL,
  name             text,
  kind             text,
  layer            text CHECK (layer IN ('anchor','coverage','owned')),
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
  layer            text CHECK (layer IN ('deep','card','popular','qa','correction')),
  title            text,
  group_id         text,
  claim_ids        text[] NOT NULL DEFAULT '{}',
  gate             text CHECK (gate IN ('passed','unverified','failed')),
  safety           text NOT NULL DEFAULT 'open' CHECK (safety IN ('clear','open','released')),
  content_sha256   text,
  protected_sha256 text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publishable','placed','published','withdrawn')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.orders (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  geo_project_id   text NOT NULL,
  article_id       text,
  media_type       text CHECK (media_type IN ('website','wemedia')),
  resource_id      text,
  vendor_order_nid text UNIQUE,
  state            text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','reserved','submitted','accepted','published','verified','settled','unknown',
                                                             'rejected','cancelled','refunded','problem','lost')),
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
`;
}

/**
 * Create the tables above, idempotently, once per database object.
 * @param {{ transaction: (operation: (client: any) => Promise<any>) => Promise<any> }} database
 */
export async function migrateGeo(database) {
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-v1'))");
    await client.query(sql());
    return true;
  });
  migrations.set(database, attempt);
  try { return await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
