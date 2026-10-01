export const EVIDENCE_ZONE_SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_frontier;
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_zones (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 title text NOT NULL, description text NOT NULL DEFAULT '', background text NOT NULL DEFAULT '',
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_cards (
 id text PRIMARY KEY, zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 title text NOT NULL, subtype text NOT NULL CHECK(subtype IN ('knowledge','academic')),
 summary text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', sources jsonb NOT NULL DEFAULT '[]',
 limitations text NOT NULL DEFAULT '', provenance text NOT NULL DEFAULT '', source_item_id text,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evidence_cards_zone_idx ON evimed_frontier.evidence_cards(zone_id,updated_at DESC,id);
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS source_item_id text;
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_zone_follows (
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,zone_id)
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_comments (
 id text PRIMARY KEY, card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 text text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_reviews (
 card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 card_revision integer NOT NULL, score integer NOT NULL CHECK(score BETWEEN 1 AND 5), text text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(card_id,user_id)
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_zone_feedback (
 id text PRIMARY KEY, zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 text text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_zone_meta (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version bigint NOT NULL DEFAULT 0
);
INSERT INTO evimed_frontier.evidence_zone_meta(singleton) VALUES(true) ON CONFLICT DO NOTHING;
`;
const migrations = new WeakMap();
/** @param {any} database */
export async function migrateEvidenceZones(database) {
  if (!migrations.has(database))
    migrations.set(
      database,
      database
        .transaction(async (/** @type {any} */ client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('evimed-evidence-zones-v1'))",
          );
          await client.query(EVIDENCE_ZONE_SQL);
        })
        .catch((/** @type {unknown} */ error) => {
          migrations.delete(database);
          throw error;
        }),
    );
  await migrations.get(database);
}
