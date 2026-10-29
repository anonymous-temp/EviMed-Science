import {
  EVIDENCE_CHALLENGE_OUTCOMES,
  EVIDENCE_CHALLENGE_ROUTES,
  EVIDENCE_CHALLENGE_STATES,
  EVIDENCE_CHANGE_CATEGORIES,
  EVIDENCE_CHANGE_SUMMARY_MAX_CHARS,
  EVIDENCE_CHANGE_TRIGGERS,
  EVIDENCE_ORIGINALITY,
  EVIDENCE_PLATFORM_PRODUCER_NAME,
  EVIDENCE_ZONE_CHANGE_KINDS,
  EVIDENCE_ZONE_ITEM_STATES,
  EVIDENCE_ZONE_ITEM_VIAS,
  EVIDENCE_ZONE_KINDS,
  EVIDENCE_ZONE_LIFECYCLES,
  EVIDENCE_ZONE_RELEVANCE,
  EVIDENCE_ZONE_ROLES,
  EVIDENCE_ZONE_TYPES,
  EVIDENCE_ZONE_VISIBILITY,
  SOURCE_CURRENCY_LABELS,
} from "@evimed/domain";
import { refreshVocabularyChecks } from "./vocabularyChecks.mjs";

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
-- The AI editor's two tables (a zone's automation settings and its editorial job queue) are gone with the editor (2026-10-29: the platform
-- writes no cards). Dropped on every start, which is idempotent; nothing reads them. The jobs go first: their rows referred to the zones and cards.
DROP TABLE IF EXISTS evimed_frontier.evidence_editorial_jobs;
DROP TABLE IF EXISTS evimed_frontier.evidence_automation;
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
-- A programme card with no headline claim carried one neutral sentence as its list line — the same words on every such card, so a zone
-- listed nineteen identical rows (R19, audit D C3). The programme's builder (deleted 2026-10-29) wrote the card's first conclusion; this
-- takes the cards an earlier release wrote to the same line. The sentence is the builder's own code-built string, matched exactly, and
-- only a card whose first claim is a direct quotation is touched (a synthesis keeps its confidence label, which only the builder adds).
-- Idempotent: a row that no longer carries the sentence is not selected, and the zones' version moves only when a row changed.
WITH relined AS (UPDATE evimed_frontier.evidence_cards SET summary=left(claims->0->>'claim',600)
  WHERE summary LIKE '这张卡汇总了 % 条引文已逐字核对的结论；其中没有达到“发现”标准的结论，请逐条阅读下面的限定。'
    AND jsonb_typeof(claims)='array' AND COALESCE(claims->0->>'claimType','direct')='direct' AND COALESCE(claims->0->>'claim','')<>'' RETURNING 1)
UPDATE evimed_frontier.evidence_zone_meta SET version=version+1 WHERE EXISTS (SELECT 1 FROM relined);
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
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_topic_request_links (
 left_id text NOT NULL REFERENCES evimed_frontier.evidence_topic_requests(id) ON DELETE CASCADE,
 right_id text NOT NULL REFERENCES evimed_frontier.evidence_topic_requests(id) ON DELETE CASCADE,
 relation text NOT NULL DEFAULT 'related' CHECK(relation='related'),
 PRIMARY KEY(left_id,right_id), CHECK(left_id<right_id)
);
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
-- Topic zones (owner 2026-10-29, plan docs/superpowers/plans/2026-10-29-evidence-zone-topics.md v1.2). A zone is a topic of two or
-- three keywords: its definition (keywords with their alternatives, the scope sentence, criteria for the model, exclusions, seeds), its
-- type, its directory group, its life, how far the items were scanned, its 最新进展 and a count snapshot for the directory. The model
-- decides membership; the zone_items table (EVIDENCE_ZONE_TOPICS_SQL, which the frontier migration runs because it references the
-- frontier's items) keeps every judged pair (in, out, pending) and the overrides no automatic pass rewrites.
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS evidence_zones_slug_idx ON evimed_frontier.evidence_zones(slug) WHERE slug IS NOT NULL;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS zone_type text CHECK(zone_type IS NULL OR zone_type IN (${sqlList(EVIDENCE_ZONE_TYPES)}));
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS specialties text[] NOT NULL DEFAULT '{}';
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS group_label text NOT NULL DEFAULT '';
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS scope_zh text NOT NULL DEFAULT '';
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS definition jsonb;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS definition_version integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'none' CHECK(lifecycle IN (${sqlList(EVIDENCE_ZONE_LIFECYCLES)}));
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS matched_through timestamptz(3);
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS backfilled_version integer NOT NULL DEFAULT 0;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS overview jsonb;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS overview_at timestamptz(3);
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS stats jsonb;
ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS stats_at timestamptz(3);
CREATE INDEX IF NOT EXISTS evidence_zones_topic_idx ON evimed_frontier.evidence_zones(kind, lifecycle, state) WHERE lifecycle <> 'none';
CREATE INDEX IF NOT EXISTS evidence_zones_owner_topic_idx ON evimed_frontier.evidence_zones(user_id) WHERE kind = 'user' AND lifecycle <> 'none';
-- What happened to a zone, for the operators and for undoing a planner action: who did it (planner, owner:<id>, operator:<id>,
-- migration) and the detail. No foreign key, so a deleted zone keeps its history.
CREATE TABLE IF NOT EXISTS evimed_frontier.zone_changes (
 id bigserial PRIMARY KEY, zone_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN (${sqlList(EVIDENCE_ZONE_CHANGE_KINDS)})),
 actor text NOT NULL, detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object'),
 occurred_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS zone_changes_zone_idx ON evimed_frontier.zone_changes(zone_id, id DESC);
-- The owner (2026-10-29): the zones that existed before topic zones are deleted and the platform starts again (they were whole
-- diseases or kinds of card, and the platform no longer writes cards). Once per database: the platform's and readers' zones with no
-- topic definition go, with their cards (the foreign keys cascade); 循证 GEO's product zones stay. The marker makes it run once, so a
-- zone made later is never touched. The marker and the content version move in the one UPDATE of the singleton row: a second
-- UPDATE of the same row in the same statement (a CTE's, then the outer one) is skipped by PostgreSQL, which once left the version
-- unmoved after the reset and every version-keyed ETag answering 304 with deleted content. The version moves only when zones go.
ALTER TABLE evimed_frontier.evidence_zone_meta ADD COLUMN IF NOT EXISTS topics_reset_at timestamptz(3);
WITH reset AS (
  UPDATE evimed_frontier.evidence_zone_meta
     SET topics_reset_at=clock_timestamp(),
         version=version + CASE WHEN EXISTS (SELECT 1 FROM evimed_frontier.evidence_zones o WHERE o.kind IN ('official','user') AND o.lifecycle='none') THEN 1 ELSE 0 END
   WHERE singleton AND topics_reset_at IS NULL RETURNING 1
), gone AS (
  DELETE FROM evimed_frontier.evidence_zones z
   WHERE EXISTS (SELECT 1 FROM reset) AND z.kind IN ('official','user') AND z.lifecycle='none'
  RETURNING z.id
), noted AS (
  INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail)
  SELECT id, 'reset', 'migration', '{"reason":"topic zones replace the zones before 2026-10-29"}'::jsonb FROM gone RETURNING 1
)
SELECT count(*) FROM noted;
`;

/**
 * The topic zones' item table. It references the frontier's \`items\`, so it is created by the frontier migration right after
 * {@link EVIDENCE_ZONE_SQL} (\`migrateFrontier\`), never by {@link migrateEvidenceZones} alone, which runs on databases that have
 * no frontier tables.
 */
export const EVIDENCE_ZONE_TOPICS_SQL = `
CREATE TABLE IF NOT EXISTS evimed_frontier.zone_items (
 zone_id text NOT NULL REFERENCES evimed_frontier.evidence_zones(id) ON DELETE CASCADE,
 item_id bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN (${sqlList(EVIDENCE_ZONE_ITEM_STATES)})),
 relevance text CHECK(relevance IS NULL OR relevance IN (${sqlList(EVIDENCE_ZONE_RELEVANCE)})),
 via text NOT NULL CHECK(via IN (${sqlList(EVIDENCE_ZONE_ITEM_VIAS)})),
 role text NOT NULL CHECK(role IN (${sqlList(EVIDENCE_ZONE_ROLES)})),
 score real,
 decided_by text NOT NULL DEFAULT 'recall',
 definition_version integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,
 matched_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 judged_at timestamptz(3),
 PRIMARY KEY(zone_id, item_id)
);
CREATE INDEX IF NOT EXISTS zone_items_list_idx ON evimed_frontier.zone_items(zone_id, state, item_id DESC);
CREATE INDEX IF NOT EXISTS zone_items_item_idx ON evimed_frontier.zone_items(item_id) WHERE state IN ('in','pinned');
CREATE INDEX IF NOT EXISTS zone_items_pending_idx ON evimed_frontier.zone_items(matched_at, zone_id) WHERE state = 'pending';
-- What a reader's daily notice already named of the zones they own or follow (frontierZoneUpdates.mjs): an item, and the event it
-- reports, is named to a reader once whichever zone it sits in. A row is written when the notice is taken and deleted when the notice
-- could not be made; rows older than a fortnight are cleared by the next notice, as no item that old is a candidate any more.
CREATE TABLE IF NOT EXISTS evimed_frontier.zone_notice_claims (
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 item_id bigint NOT NULL REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
 zone_id text NOT NULL,
 event_key bigint NOT NULL,
 notified_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id, item_id)
);
CREATE INDEX IF NOT EXISTS zone_notice_claims_event_idx ON evimed_frontier.zone_notice_claims(user_id, event_key);
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
          // A word a list above gained after the table was created is otherwise refused by every existing database (vocabularyChecks.mjs).
          await refreshVocabularyChecks(client, EVIDENCE_ZONE_SQL, "evimed_frontier");
        })
        .catch((/** @type {unknown} */ error) => {
          migrations.delete(database);
          throw error;
        }),
    );
  await migrations.get(database);
}
