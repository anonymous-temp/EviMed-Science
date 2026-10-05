import {
  EVIDENCE_ORIGINALITY,
  EVIDENCE_PLATFORM_PRODUCER_NAME,
  EVIDENCE_ZONE_KINDS,
  EVIDENCE_ZONE_VISIBILITY,
} from "@evimed/domain";

/** The domain's closed lists as a SQL list, so the table's CHECK and the contract cannot disagree.
 * @param {readonly string[]} values */
const sqlList = (values) => values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");

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
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS content jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS editorial jsonb;
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_card_revisions (
 card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 revision integer NOT NULL, snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(card_id,revision)
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_automation (
 zone_id text PRIMARY KEY REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 discovery_turn boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT false, query text NOT NULL DEFAULT '', source_types text[] NOT NULL DEFAULT '{journal,regulator,evidence-body}',
 interval_hours integer NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 720),
 max_cards_per_run integer NOT NULL DEFAULT 2 CHECK(max_cards_per_run BETWEEN 1 AND 10),
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_run_at timestamptz, last_error text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_editorial_jobs (
 id text PRIMARY KEY, zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 identity_key text NOT NULL, card_id text REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 source_item_id text, source_url text, source_title text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed','conflict')),
 attempts integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error text, payload jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(zone_id,identity_key)
);
CREATE INDEX IF NOT EXISTS evidence_editorial_jobs_due_idx ON evimed_frontier.evidence_editorial_jobs(state,available_at);
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
-- The evidence card as the platform's one evidence unit (flywheel B1, 2026-10-05). A zone has a kind (who owns its
-- voice) and a visibility (who may read it once published); every zone that existed is a user zone, visible to the
-- platform's signed-in accounts, until its owner chooses otherwise.
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'user' CHECK(kind IN (${sqlList(EVIDENCE_ZONE_KINDS)}));
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'platform' CHECK(visibility IN (${sqlList(EVIDENCE_ZONE_VISIBILITY)}));
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS claims jsonb NOT NULL DEFAULT '[]';
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS producer jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS originality text CHECK(originality IN (${sqlList(EVIDENCE_ORIGINALITY)}));
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS lineage jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS entity_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS journey_stage jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS disclosure jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS public_view jsonb;
CREATE INDEX IF NOT EXISTS evidence_cards_entity_keys_idx ON evimed_frontier.evidence_cards USING gin (entity_keys);
-- Backfill (idempotent: only rows still without a value). A card the AI wrote in a zone the operator import created
-- is the platform's; every other card is its owner's, under the owner's display name. A card the AI editor wrote is a
-- brief, anything else a synthesis.
UPDATE evimed_frontier.evidence_cards c SET producer=CASE
    WHEN c.editorial->'author'->>'kind'='ai' AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_cards i
      WHERE i.zone_id=c.zone_id AND i.editorial->>'reviewOrigin'='import')
    THEN jsonb_build_object('kind','platform','name','${EVIDENCE_PLATFORM_PRODUCER_NAME.replaceAll("'", "''")}','relation','none')
    ELSE jsonb_build_object('kind','user','name',COALESCE(NULLIF(btrim(u.name),''),u.id),'relation','none') END
  FROM evimed_control.users u WHERE u.id=c.user_id AND c.producer IS NULL;
UPDATE evimed_frontier.evidence_cards SET originality=CASE WHEN editorial->'author'->>'kind'='ai' THEN 'brief' ELSE 'synthesis' END
  WHERE originality IS NULL;
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
