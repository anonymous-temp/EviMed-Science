/**
 * The independent reviewer's ledger: every review, every finding, every answer
 * a writer gave to one, and every reply check.
 *
 * Hidden knowledge: this ledger is what turns the reviewer from an opinion
 * into a measured instrument. Judgment findings stay advice until a kind's
 * false-positive rate can be read here (principle 4, plan §3.6): a kind the
 * writers decline more often than they fix is a kind to demote, and a
 * decidable kind whose findings are fixed is a kind that has earned the right
 * to be required. Nothing reads this to decide a delivery.
 *
 * Rows belong to their project and go with it (foreign keys to the control
 * plane's projects, created with the tables, so they are valid from the
 * start): a finding quotes the package it was raised on, and a quote of a
 * deleted project's report is not something to keep.
 *
 * @module reviewPersistence
 */

const migrations = new WeakMap();

function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_review;

CREATE TABLE IF NOT EXISTS evimed_review.reviews (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text,
  socket_run_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  deliverable_id text NOT NULL,
  contract_kind text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('L2','L3')),
  safety boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  pass integer NOT NULL DEFAULT 0 CHECK (pass >= 0),
  status text NOT NULL CHECK (status IN ('running','done','failed')),
  error_code text,
  model text,
  package_digest text,
  report_text text,
  deterministic jsonb NOT NULL DEFAULT '{}'::jsonb,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance jsonb NOT NULL DEFAULT '[]'::jsonb,
  dropped jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost numeric(18,8) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_reviews_run_idx
  ON evimed_review.reviews (user_id, project_id, socket_run_id, deliverable_id, created_at DESC);
CREATE INDEX IF NOT EXISTS review_reviews_created_idx ON evimed_review.reviews (created_at DESC);

CREATE TABLE IF NOT EXISTS evimed_review.findings (
  review_id text NOT NULL REFERENCES evimed_review.reviews(id) ON DELETE CASCADE,
  finding_id text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('required','advisory')),
  origin text NOT NULL CHECK (origin IN ('code','editor')),
  location text NOT NULL DEFAULT '',
  evidence text NOT NULL DEFAULT '',
  fix text NOT NULL DEFAULT '',
  message text NOT NULL,
  response text CHECK (response IS NULL OR response IN ('fixed','declined')),
  response_reason text,
  responded_at timestamptz,
  PRIMARY KEY (review_id, finding_id)
);
CREATE INDEX IF NOT EXISTS review_findings_kind_idx ON evimed_review.findings (kind, response);

CREATE TABLE IF NOT EXISTS evimed_review.reply_checks (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  session_id text NOT NULL DEFAULT '',
  turn_seq integer,
  status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  reply_text text NOT NULL,
  question text NOT NULL DEFAULT '',
  medicines text[] NOT NULL DEFAULT '{}',
  sentences jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  cautions jsonb NOT NULL DEFAULT '[]'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text,
  cost numeric(18,8) NOT NULL DEFAULT 0,
  error_code text,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (user_id, project_id, run_id),
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_reply_checks_queue_idx ON evimed_review.reply_checks (status, created_at);
CREATE INDEX IF NOT EXISTS review_reply_checks_session_idx ON evimed_review.reply_checks (user_id, project_id, session_id, created_at DESC);
`;
}

/**
 * Create or bring up to date the review schema. Idempotent and serialized by
 * an advisory lock, cached per database like every schema this control plane
 * owns.
 * @param {any} database a `ControlPlaneDatabase`
 * @returns {Promise<void>}
 */
export async function migrateReview(database) {
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-review-v1'))");
    await client.query(sql());
  });
  migrations.set(database, attempt);
  try {
    await attempt;
  } catch (error) {
    migrations.delete(database);
    throw error;
  }
}
