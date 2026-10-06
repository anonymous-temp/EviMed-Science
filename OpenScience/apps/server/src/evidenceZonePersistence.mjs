import {
  EVIDENCE_CHALLENGE_OUTCOMES,
  EVIDENCE_CHALLENGE_ROUTES,
  EVIDENCE_CHALLENGE_STATES,
  EVIDENCE_CHANGE_CATEGORIES,
  EVIDENCE_CHANGE_SUMMARY_MAX_CHARS,
  EVIDENCE_CHANGE_TRIGGERS,
  EVIDENCE_ORIGINALITY,
  EVIDENCE_PLATFORM_PRODUCER_NAME,
  EVIDENCE_ZONE_KINDS,
  EVIDENCE_ZONE_VISIBILITY,
  SOURCE_CURRENCY_LABELS,
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
-- A published official zone is read on the open internet: it has no owner to choose it, so the rule is kept here for zones
-- marked official by a re-own or made before the rule (2026-10-06). Touches only rows that disagree.
WITH opened AS (UPDATE evimed_frontier.evidence_zones SET visibility='internet' WHERE kind='official' AND state='published' AND visibility<>'internet' RETURNING 1)
UPDATE evimed_frontier.evidence_zone_meta SET version=version+1 WHERE EXISTS (SELECT 1 FROM opened);
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
-- Keeping a card current (flywheel F13, F14, §4.4, §8, 2026-10-05). A card carries its own 时效 — one of the five labels of
-- \`currencyLabel\` — with the frontier items that bear on it, when the platform last looked, and, for a card taken back,
-- why. \`source_keys\` are the identifiers its sources name in the form the source-change record uses, so a change in that
-- record finds the cards that cite it without reading a source's text. Every card that existed is current, never looked at.
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'current' CHECK(currency IN (${sqlList(SOURCE_CURRENCY_LABELS)}));
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS pending_item_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS currency_detail jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS withdrawn jsonb;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS no_change_checks integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS no_change_since timestamptz;
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS source_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE evimed_frontier.evidence_cards ADD COLUMN IF NOT EXISTS source_keys_revision integer;
CREATE INDEX IF NOT EXISTS evidence_cards_source_keys_idx ON evimed_frontier.evidence_cards USING gin (source_keys);
CREATE INDEX IF NOT EXISTS evidence_cards_watch_idx ON evimed_frontier.evidence_cards (last_checked_at NULLS FIRST, id) WHERE state='published';
-- The public change log (plan §8): append-only. No foreign key on purpose — a log entry outlives the card and the account
-- that wrote it, and a cascade that deleted history would be a way to rewrite it. The database refuses an UPDATE, a DELETE
-- and a TRUNCATE itself, so the refusal does not depend on the module that writes it being the only writer.
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_change_log (
 id bigserial PRIMARY KEY, zone_id text NOT NULL, card_id text NOT NULL,
 revision_before integer, revision_after integer,
 category text NOT NULL CHECK(category IN (${sqlList(EVIDENCE_CHANGE_CATEGORIES)})),
 trigger text NOT NULL CHECK(trigger IN (${sqlList(EVIDENCE_CHANGE_TRIGGERS)})),
 summary_zh text NOT NULL CHECK(char_length(summary_zh) BETWEEN 1 AND ${EVIDENCE_CHANGE_SUMMARY_MAX_CHARS}),
 refs jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(refs)='object'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evidence_change_log_zone_idx ON evimed_frontier.evidence_change_log(zone_id,id DESC);
CREATE INDEX IF NOT EXISTS evidence_change_log_card_idx ON evimed_frontier.evidence_change_log(card_id,id DESC);
CREATE OR REPLACE FUNCTION evimed_frontier.evidence_change_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'evidence_change_log is append-only: % is refused', TG_OP USING ERRCODE='55000';
END
$fn$;
DROP TRIGGER IF EXISTS evidence_change_log_no_rewrite ON evimed_frontier.evidence_change_log;
CREATE TRIGGER evidence_change_log_no_rewrite BEFORE UPDATE OR DELETE ON evimed_frontier.evidence_change_log
  FOR EACH ROW EXECUTE FUNCTION evimed_frontier.evidence_change_log_append_only();
DROP TRIGGER IF EXISTS evidence_change_log_no_truncate ON evimed_frontier.evidence_change_log;
CREATE TRIGGER evidence_change_log_no_truncate BEFORE TRUNCATE ON evimed_frontier.evidence_change_log
  FOR EACH STATEMENT EXECUTE FUNCTION evimed_frontier.evidence_change_log_append_only();
-- A reader's challenge to one claim of a published card (F14). One open challenge per reader per claim; the judgement and
-- the verbatim check are kept as they were made.
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_challenges (
 id text PRIMARY KEY, card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 zone_id text NOT NULL, claim_id text NOT NULL,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 reason text NOT NULL, card_revision integer NOT NULL,
 route text NOT NULL CHECK(route IN (${sqlList(EVIDENCE_CHALLENGE_ROUTES)})),
 state text NOT NULL CHECK(state IN (${sqlList(EVIDENCE_CHALLENGE_STATES)})),
 outcome text CHECK(outcome IN (${sqlList(EVIDENCE_CHALLENGE_OUTCOMES)})),
 check_result jsonb, judgement jsonb, change_log_id bigint, last_error text,
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_owner text, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_challenges_one_open_idx ON evimed_frontier.evidence_challenges(card_id,claim_id,user_id) WHERE state IN ('open','notified');
CREATE INDEX IF NOT EXISTS evidence_challenges_due_idx ON evimed_frontier.evidence_challenges(state,available_at) WHERE state='open';
CREATE INDEX IF NOT EXISTS evidence_challenges_reader_idx ON evimed_frontier.evidence_challenges(user_id,created_at DESC);
-- What the upkeep loops have read so far (the source-change feed's position, the downstream reconcilers'), and the lease a
-- loop holds while it works, so two control planes never run the same pass.
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_upkeep_state (
 name text PRIMARY KEY, cursor bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}',
 lease_owner text, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The public pages' own tables (flywheel F08, 2026-10-06). Reads: one row per card (or per zone page, card_id '') and day, so "nobody
-- reads it" and the topic selector's attention signal have a real input; no address, no user agent, no cookie is kept. The day is the
-- platform's own (Asia/Shanghai). Topic requests: the public entry of plan §8 — a request is a title, optionally aimed at a zone, and
-- ranks by the number of distinct accounts that filed or seconded it; title_key is the title's whitespace-and-case-folded form, so the
-- same words filed twice are one request with two requesters rather than two requests.
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_page_reads (
 zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 card_id text NOT NULL DEFAULT '', day date NOT NULL, reads integer NOT NULL DEFAULT 0 CHECK(reads>=0),
 PRIMARY KEY(zone_id,card_id,day)
);
CREATE INDEX IF NOT EXISTS evidence_page_reads_day_idx ON evimed_frontier.evidence_page_reads(day);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_topic_requests (
 id text PRIMARY KEY, title text NOT NULL CHECK(char_length(title) BETWEEN 4 AND 200), title_key text NOT NULL UNIQUE,
 zone_id text REFERENCES evimed_frontier.evidence_zones(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_topic_request_votes (
 request_id text NOT NULL REFERENCES evimed_frontier.evidence_topic_requests(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(request_id,user_id)
);
CREATE INDEX IF NOT EXISTS evidence_topic_request_votes_user_idx ON evimed_frontier.evidence_topic_request_votes(user_id,created_at DESC);
-- A source with no public address keeps none of its text (2026-10-06 review): a researcher's own uploaded document could reach a card as a
-- source's retained text, and a card is readable by others. The writers no longer store it (EvidenceZoneService); this takes it off the
-- rows an earlier release wrote, cards and the revision snapshots that copy them, and says the source is no longer full text. Idempotent:
-- a row with nothing to remove is not touched, and the next start finds none.
UPDATE evimed_frontier.evidence_cards c SET sources=(
    SELECT jsonb_agg(CASE WHEN COALESCE(e.s->>'url','')='' AND e.s ? 'documentText'
      THEN (e.s - 'documentText') || CASE WHEN e.s->>'coverage'='full-text' THEN '{"coverage":"excerpt"}'::jsonb ELSE '{}'::jsonb END ELSE e.s END ORDER BY e.ord)
    FROM jsonb_array_elements(c.sources) WITH ORDINALITY AS e(s,ord))
  WHERE jsonb_typeof(c.sources)='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.sources) AS x(s) WHERE COALESCE(x.s->>'url','')='' AND x.s ? 'documentText');
UPDATE evimed_frontier.evidence_card_revisions r SET snapshot=jsonb_set(r.snapshot,'{sources}',(
    SELECT jsonb_agg(CASE WHEN COALESCE(e.s->>'url','')='' AND e.s ? 'documentText'
      THEN (e.s - 'documentText') || CASE WHEN e.s->>'coverage'='full-text' THEN '{"coverage":"excerpt"}'::jsonb ELSE '{}'::jsonb END ELSE e.s END ORDER BY e.ord)
    FROM jsonb_array_elements(r.snapshot->'sources') WITH ORDINALITY AS e(s,ord)))
  WHERE jsonb_typeof(r.snapshot->'sources')='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'sources') AS x(s) WHERE COALESCE(x.s->>'url','')='' AND x.s ? 'documentText');
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
