/**
 * STUB — package C's stand-in for package A's `geoPersistence.mjs`.
 *
 * Package A owns the `evimed_geo` DDL (build spec §2). This file carries only
 * the tables package C's market code reads or writes, copied from that section,
 * so the market's integration tests run before the packages are merged. The
 * lead drops this commit at merge and A's module takes its place; the one name
 * package C imports from it is `migrateGeo(database)`.
 *
 * The indexes at the end are the ones the market's queries want; they are
 * listed in C.report.md so A's DDL can carry them.
 *
 * @module geoPersistence
 */

const migrations = new WeakMap();

function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_geo;

CREATE TABLE IF NOT EXISTS evimed_geo.projects (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  project_id text UNIQUE NOT NULL,
  product jsonb NOT NULL DEFAULT '{}',
  competitors jsonb NOT NULL DEFAULT '[]',
  coverage_days int NOT NULL DEFAULT 90,
  engines text[] NOT NULL,
  tier text NOT NULL DEFAULT '2' CHECK (tier IN ('1','2','3')),
  budget jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  steps jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS evimed_geo.question_groups (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  geo_project_id text NOT NULL,
  set_version int,
  pool text CHECK (pool IN ('P1','P2','P3','P4')),
  name text,
  typical_question text,
  journey_stage text,
  audience text CHECK (audience IN ('patient','physician')),
  bridge text,
  weight numeric,
  is_control boolean DEFAULT false,
  signal text CHECK (signal IN ('collected','partial','no_signal','client')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.targets (
  geo_project_id text NOT NULL,
  version int NOT NULL,
  tier text NOT NULL,
  metric_id text NOT NULL,
  pool text NOT NULL,
  baseline numeric,
  target numeric,
  horizon_weeks int,
  placements int,
  budget_cny numeric,
  data_type text DEFAULT 'forecast',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geo_project_id, version, tier, metric_id, pool)
);

CREATE TABLE IF NOT EXISTS evimed_geo.sources (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  geo_project_id text NOT NULL,
  domain text,
  name text,
  kind text,
  layer text CHECK (layer IN ('anchor','coverage','owned')),
  icp_owner text,
  icp_matches boolean,
  news_indexed boolean,
  medical_vertical boolean,
  impostor boolean DEFAULT false,
  blacklist_reason text,
  checked_at timestamptz,
  cited jsonb DEFAULT '{}',
  mentions_ours int DEFAULT 0,
  wrong_ours int DEFAULT 0,
  market jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (geo_project_id, domain)
);

CREATE TABLE IF NOT EXISTS evimed_geo.articles (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  geo_project_id text NOT NULL,
  run_id text,
  deliverable_id text,
  path text,
  layer text CHECK (layer IN ('deep','card','popular','qa','correction')),
  title text,
  group_id text,
  claim_ids text[],
  gate text CHECK (gate IN ('passed','unverified','failed')),
  safety text CHECK (safety IN ('clear','open','released')),
  content_sha256 text,
  protected_sha256 text,
  status text CHECK (status IN ('draft','publishable','placed','published','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.media (
  resource_id text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('website','wemedia')),
  name text,
  domain text,
  domain_verified boolean,
  icp_owner text,
  fields jsonb,
  price_cny numeric,
  publish_rate numeric,
  publish_seconds int,
  remarks text,
  case_link text,
  flags jsonb,
  available boolean,
  blacklisted boolean DEFAULT false,
  blacklist_reason text,
  price_history jsonb DEFAULT '[]',
  synced_at timestamptz,
  PRIMARY KEY (media_type, resource_id)
);

CREATE TABLE IF NOT EXISTS evimed_geo.media_outcomes (
  media_type text NOT NULL,
  resource_id text NOT NULL,
  engine text NOT NULL,
  placed int,
  cited int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, resource_id, engine)
);

CREATE TABLE IF NOT EXISTS evimed_geo.orders (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  geo_project_id text,
  article_id text,
  media_type text,
  resource_id text,
  vendor_order_nid text UNIQUE,
  state text CHECK (state IN ('planned','reserved','submitted','accepted','published','verified','settled','unknown',
                              'rejected','cancelled','refunded','problem','lost')),
  reserve_cny numeric,
  price_cny numeric,
  settled_cny numeric,
  body_sha256 text,
  published_url text,
  checks jsonb DEFAULT '[]',
  appeal jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.order_events (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES evimed_geo.orders(id),
  at timestamptz NOT NULL DEFAULT now(),
  from_state text,
  to_state text,
  detail jsonb
);

CREATE TABLE IF NOT EXISTS evimed_geo.ledger (
  id text PRIMARY KEY,
  user_id text,
  geo_project_id text,
  order_id text,
  kind text NOT NULL CHECK (kind IN ('budget_set','reserve','release','settle','refund','topup_request','topup_confirmed','adjustment')),
  amount_cny numeric(12,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_geo.topups (
  id text PRIMARY KEY,
  amount_cny numeric,
  status text CHECK (status IN ('requested','confirmed','cancelled')),
  balance_before numeric,
  balance_after numeric,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  note text
);

CREATE TABLE IF NOT EXISTS evimed_geo.reconciliations (
  day date PRIMARY KEY,
  ours numeric,
  vendor numeric,
  balance numeric,
  diff numeric,
  status text CHECK (status IN ('ok','mismatch')),
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_orders_project_idx ON evimed_geo.orders (geo_project_id, created_at);
CREATE INDEX IF NOT EXISTS geo_orders_state_idx ON evimed_geo.orders (state);
CREATE INDEX IF NOT EXISTS geo_orders_media_idx ON evimed_geo.orders (media_type, resource_id);
CREATE INDEX IF NOT EXISTS geo_order_events_order_idx ON evimed_geo.order_events (order_id, at);
CREATE INDEX IF NOT EXISTS geo_ledger_project_idx ON evimed_geo.ledger (geo_project_id, kind);
CREATE INDEX IF NOT EXISTS geo_ledger_order_idx ON evimed_geo.ledger (order_id);
CREATE INDEX IF NOT EXISTS geo_ledger_created_idx ON evimed_geo.ledger (created_at);
CREATE INDEX IF NOT EXISTS geo_media_candidates_idx ON evimed_geo.media (available, blacklisted, price_cny);
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
