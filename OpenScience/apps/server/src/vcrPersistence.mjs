/**
 * 「虚拟临研」's own schema, `evimed_vcr` (build plan 2026-09-28 §11.3).
 *
 * Hidden knowledge:
 *
 * - **One DDL for every package.** The study side (studies, members,
 *   definitions, protocols, criteria), the evidence side (precedents,
 *   extracted values, assumptions), the data plane (sources, grants,
 *   snapshots, field maps, analysis tables), the research objects
 *   (populations, patient sets, comparator designs, trial scenarios, grids),
 *   execution (jobs, executions, results, forecasts), the business side
 *   (matching, referrals, sites, follow-up) and governance (lineage, stale
 *   marks, reviews, decisions, regulatory contacts, audit, schedule marks) are
 *   all created here — the shape 「循证 GEO」 settled on, for the same reason:
 *   so no package migrates a table another one reads. Additive and idempotent.
 * - **Tenancy is a column, checked in code**, and here it is not enough on its
 *   own: a study has members, so a row's reader is decided by
 *   `(user_id = caller) OR member_of(study)`, never by `user_id` alone
 *   (`vcrAccess.mjs`). The column stays because it makes the owner's deletion
 *   path a single predicate.
 * - **Patient-level rows are not in this schema.** `snapshots` holds a
 *   reference, a hash, a field map and a quality profile; the rows themselves
 *   live in the data plane's own volume, which is never mounted into a runtime
 *   (plan §8.1). A table here that held patient rows would put them one join
 *   away from everything the model can already read.
 * - **Nothing a result used is re-read later.** `executions` freezes its
 *   inputs and its environment; `results` are immutable and superseded rather
 *   than updated. That is what makes AC-04 (reproduce from the saved inputs)
 *   and AC-16 (a corrected source marks results stale) decidable at all.
 * - **Closed vocabularies are CHECKed from `@evimed/domain`'s vcr
 *   vocabulary**, spliced as literals after each word is checked against
 *   `^[A-Za-z0-9_]+$`. Adding a word is then a migration the CHECK names.
 * - **`audit` cannot be turned off** and `snapshots`/`executions` cannot be
 *   rewritten: this is the record a sponsor's computerized-system validation
 *   reads (ICH E6(R3), plan §11.3).
 *
 * @module vcrPersistence
 */

import {
  VCR_ANALYSIS_TABLES, VCR_ASSUMPTION_SOURCE_KINDS, VCR_COMPARATOR_ROUTES, VCR_CONCLUSIONS, VCR_CRITERION_STATES,
  VCR_CRITERION_TYPES, VCR_DATA_TIERS, VCR_ELIGIBILITY_SUMMARIES, VCR_ENDPOINT_TYPES, VCR_ENROLLMENT_KINDS,
  VCR_EXPORT_KINDS, VCR_FOLLOWUP_KINDS, VCR_INTENDED_USES, VCR_JOB_KINDS, VCR_JOB_STATES, VCR_MEMBER_ROLES,
  VCR_MISSING_REASONS, VCR_MODEL_RISKS, VCR_MODEL_TIERS, VCR_POOLING_METHODS, VCR_POPULATION_KINDS,
  VCR_REFERRAL_STATES, VCR_REVIEW_KINDS, VCR_REVIEW_STATES, VCR_STALE_REASONS, VCR_STEPS, VCR_STUDY_STATUSES,
  VCR_TRIAL_DESIGNS, VCR_VALUE_SOURCES,
} from "@evimed/domain";
import { refreshVocabularyChecks } from "./vocabularyChecks.mjs";

/** The schema name, written once. */
export const VCR_SCHEMA = "evimed_vcr";

/**
 * What a column of a source is *for* in the study — the one thing the analysis
 * tables are derived from (plan §8.1 step 2). `subject_key` is the person's key
 * in the source (it becomes a per-study pseudonym and never leaves the data
 * plane); `arm` and `covariate` are baseline attributes (the subject table);
 * `outcome_time` / `outcome_event` are one time-to-event outcome, paired by
 * their `parameter` (the events table); `measurement` is one longitudinal
 * parameter (the longitudinal table); `time_zero` is the index date; `visit_date`
 * dates a measurement row; `other` is kept in the snapshot and never derived.
 * A vocabulary of this file's own, spliced into a CHECK like the domain's: it
 * belongs in `@evimed/domain` the next time that package is open.
 */
export const VCR_FIELD_ROLES = Object.freeze([
  "subject_key", "arm", "covariate", "outcome_time", "outcome_event", "time_zero", "measurement", "visit_date", "other",
]);
/** What an uploaded file is: the rows, the dictionary that explains them, or a patient document. */
export const VCR_SOURCE_FILE_ROLES = Object.freeze(["data", "dictionary", "document"]);
/** Where a source's field map stands: nothing yet, proposed (by the run or a person), or confirmed by a person. */
export const VCR_FIELD_MAP_STATES = Object.freeze(["none", "proposed", "confirmed"]);

/**
 * Every table the migration creates, in creation order. The deletion paths and
 * the integration test read this list; a table added below and not here is a
 * table nobody cleans up.
 */
export const VCR_TABLES = Object.freeze([
  "studies", "members", "study_definitions", "protocol_versions", "criteria", "soa_items",
  "precedents", "study_precedents", "evidence_items", "curve_extractions", "assumptions",
  "sources", "source_files", "grants", "snapshots", "field_maps", "analysis_tables",
  "populations", "patient_sets", "comparator_designs", "trial_scenarios", "design_grids",
  "models", "methods",
  "jobs", "executions", "results", "forecasts",
  "matching_assessments", "criterion_judgments", "matching_facts", "language_judgments",
  "referrals", "referral_events", "sites", "followup_episodes",
  "dependencies", "stale_marks", "reviews", "decisions", "regulatory_contacts", "exports", "audit", "schedule_marks",
]);

const migrations = new WeakMap();

/** `IN (...)` over a closed vocabulary, refusing any member that is not a plain word. @param {readonly string[]} words */
function inList(words) {
  for (const word of words) {
    if (!/^[A-Za-z0-9_]+$/.test(word)) throw new TypeError(`A VCR vocabulary word cannot be spliced into SQL: ${JSON.stringify(word)}`);
  }
  return `(${words.map((word) => `'${word}'`).join(", ")})`;
}

/** The whole schema. */
function sql() {
  return `
CREATE SCHEMA IF NOT EXISTS evimed_vcr;

-- ---------------------------------------------------------------------------
-- Study and definition
-- ---------------------------------------------------------------------------

-- A study is one ordinary project plus this row (the GEO shape). Conversations,
-- files and memory stay with the project.
CREATE TABLE IF NOT EXISTS evimed_vcr.studies (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  project_id    text NOT NULL,
  name          text NOT NULL,
  question      text NOT NULL DEFAULT '',
  data_tier     text NOT NULL DEFAULT 'T0' CHECK (data_tier IN ${inList(VCR_DATA_TIERS)}),
  intended_use  text NOT NULL DEFAULT 'exploratory' CHECK (intended_use IN ${inList(VCR_INTENDED_USES)}),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ${inList(VCR_STUDY_STATUSES)}),
  steps         jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget        jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome_seal  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS vcr_studies_user_idx ON evimed_vcr.studies (user_id, updated_at DESC) WHERE deleted_at IS NULL;

-- Study members and their roles (plan §11.1 conclusion 4): project-level only,
-- deliberately not an organization model.
CREATE TABLE IF NOT EXISTS evimed_vcr.members (
  study_id   text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL CHECK (role IN ${inList(VCR_MEMBER_ROLES)}),
  invited_by text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, user_id, role)
);
CREATE INDEX IF NOT EXISTS vcr_members_user_idx ON evimed_vcr.members (user_id);

-- The research question as an object: PICO, the estimand's five attributes,
-- the primary endpoint and its type, the intended use. Versioned; everything
-- downstream references one version.
CREATE TABLE IF NOT EXISTS evimed_vcr.study_definitions (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  pico          jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimand      jsonb NOT NULL DEFAULT '{}'::jsonb,
  endpoint_type text CHECK (endpoint_type IS NULL OR endpoint_type IN ${inList(VCR_ENDPOINT_TYPES)}),
  intended_use  text NOT NULL DEFAULT 'exploratory' CHECK (intended_use IN ${inList(VCR_INTENDED_USES)}),
  field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state  text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

-- A protocol the study works from, and the versions it goes through. A
-- revision never rewrites an assessment made against an earlier one (AC-05).
CREATE TABLE IF NOT EXISTS evimed_vcr.protocol_versions (
  id           text PRIMARY KEY,
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  version      integer NOT NULL,
  title        text NOT NULL DEFAULT '',
  source_ref   text,
  usdm         jsonb NOT NULL DEFAULT '{}'::jsonb,
  frozen_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

-- One structured eligibility criterion, with the sentence it came from kept
-- beside it. Every criterion is stated as a requirement to satisfy, so an
-- exclusion reading 「满足」 means 「不被这一条排除」 (plan §7.1).
CREATE TABLE IF NOT EXISTS evimed_vcr.criteria (
  id                  text PRIMARY KEY,
  study_id            text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  protocol_version_id text NOT NULL REFERENCES evimed_vcr.protocol_versions(id) ON DELETE CASCADE,
  user_id             text NOT NULL,
  ordinal             integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('inclusion', 'exclusion')),
  criterion_type      text NOT NULL CHECK (criterion_type IN ${inList(VCR_CRITERION_TYPES)}),
  requirement         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_text         text NOT NULL DEFAULT '',
  source_locator      jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_needed     jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_state        text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol_version_id, ordinal)
);
-- When a criterion applies at all (「仅女性」), beside the requirement, never inside it:
-- the evaluator reads it from here and the domain's requirement grammar refuses
-- an extra key, so the two must not share a document.
ALTER TABLE evimed_vcr.criteria ADD COLUMN IF NOT EXISTS applicability jsonb;

-- The schedule of activities, when a protocol carries one: visits, procedures
-- and the burden a design costs a patient and a site (plan §2.2).
CREATE TABLE IF NOT EXISTS evimed_vcr.soa_items (
  id                  text PRIMARY KEY,
  protocol_version_id text NOT NULL REFERENCES evimed_vcr.protocol_versions(id) ON DELETE CASCADE,
  user_id             text NOT NULL,
  visit               text NOT NULL,
  day                 numeric,
  window_days         numeric,
  procedure           text NOT NULL,
  burden              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Evidence and assumptions (plan §6)
-- ---------------------------------------------------------------------------

-- A trial precedent: the registry record and what was published about it.
-- Planned and actual enrollment are kept apart on purpose — the gap between
-- them is the most useful accrual prior there is (plan §6.4).
-- The library is the account's: a precedent is one registry record however many
-- studies pull it in, so \`study_id\` is only the study that first did (SET NULL
-- when that study goes, never CASCADE — deleting a study must not take a record
-- another study is pooling from) and the studies that use it are \`study_precedents\`.
CREATE TABLE IF NOT EXISTS evimed_vcr.precedents (
  id               text PRIMARY KEY,
  user_id          text NOT NULL,
  study_id         text REFERENCES evimed_vcr.studies(id) ON DELETE SET NULL,
  registry         text NOT NULL DEFAULT '',
  registry_id      text NOT NULL DEFAULT '',
  title            text NOT NULL DEFAULT '',
  pico             jsonb NOT NULL DEFAULT '{}'::jsonb,
  design           jsonb NOT NULL DEFAULT '{}'::jsonb,
  enrollment       jsonb NOT NULL DEFAULT '{}'::jsonb,
  enrollment_kind  text CHECK (enrollment_kind IS NULL OR enrollment_kind IN ${inList(VCR_ENROLLMENT_KINDS)}),
  sites            jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligibility_text text NOT NULL DEFAULT '',
  endpoints        jsonb NOT NULL DEFAULT '[]'::jsonb,
  results          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources          jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, registry, registry_id)
);
CREATE INDEX IF NOT EXISTS vcr_precedents_study_idx ON evimed_vcr.precedents (study_id);

-- What a quotation is checked against later: the preserved text of the record
-- (reproducible from the registry id and the reduction, and kept because a
-- registry changes under a stored value) and its hash.
ALTER TABLE evimed_vcr.precedents ADD COLUMN IF NOT EXISTS record_text text NOT NULL DEFAULT '';
ALTER TABLE evimed_vcr.precedents ADD COLUMN IF NOT EXISTS record_hash text;

-- Which studies use which precedent. The library is the account's, the use is the study's.
CREATE TABLE IF NOT EXISTS evimed_vcr.study_precedents (
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  precedent_id text NOT NULL REFERENCES evimed_vcr.precedents(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, precedent_id)
);

-- A database that predates this: the first study no longer owns the record.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'precedents_study_id_fkey' AND conrelid = 'evimed_vcr.precedents'::regclass AND confdeltype <> 'n') THEN
    ALTER TABLE evimed_vcr.precedents DROP CONSTRAINT IF EXISTS precedents_study_id_fkey;
    ALTER TABLE evimed_vcr.precedents ADD CONSTRAINT precedents_study_id_fkey
      FOREIGN KEY (study_id) REFERENCES evimed_vcr.studies(id) ON DELETE SET NULL;
  END IF;
END $$;
INSERT INTO evimed_vcr.study_precedents (study_id, precedent_id, user_id)
  SELECT study_id, id, user_id FROM evimed_vcr.precedents WHERE study_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- One extracted number, with the place in the source it can be checked
-- against. A value with no locator never becomes an assumption (AC-25).
CREATE TABLE IF NOT EXISTS evimed_vcr.evidence_items (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  study_id       text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  precedent_id   text REFERENCES evimed_vcr.precedents(id) ON DELETE SET NULL,
  parameter      text NOT NULL,
  arm            text,
  value          numeric,
  value_text     text,
  unit           text,
  ci_low         numeric,
  ci_high        numeric,
  sample_size    integer,
  events         integer,
  value_source   text NOT NULL DEFAULT 'extracted' CHECK (value_source IN ${inList(VCR_VALUE_SOURCES)}),
  source_ref     text NOT NULL DEFAULT '',
  quote          text NOT NULL DEFAULT '',
  locator        jsonb NOT NULL DEFAULT '{}'::jsonb,
  applicability  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_evidence_items_study_idx ON evimed_vcr.evidence_items (study_id, parameter);

-- What pooling needs to know about a value and the extraction used to leave out:
-- which arm it describes, which endpoint definition it measures, whether the
-- registry stated it as having happened, and the rest of the record's own
-- words. A missing \`historical_baseline\` is not a baseline (a value of unknown
-- standing never enters a pool by omission).
ALTER TABLE evimed_vcr.evidence_items ADD COLUMN IF NOT EXISTS endpoint_key text NOT NULL DEFAULT '';
ALTER TABLE evimed_vcr.evidence_items ADD COLUMN IF NOT EXISTS arm_role text NOT NULL DEFAULT 'unknown';
ALTER TABLE evimed_vcr.evidence_items ADD COLUMN IF NOT EXISTS enrollment_kind text;
ALTER TABLE evimed_vcr.evidence_items ADD COLUMN IF NOT EXISTS historical_baseline boolean;
ALTER TABLE evimed_vcr.evidence_items ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS vcr_evidence_items_key_idx
  ON evimed_vcr.evidence_items (study_id, precedent_id, parameter, arm, endpoint_key, created_at DESC);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'evidence_items_precedent_id_fkey' AND conrelid = 'evimed_vcr.evidence_items'::regclass AND confdeltype <> 'n') THEN
    ALTER TABLE evimed_vcr.evidence_items DROP CONSTRAINT IF EXISTS evidence_items_precedent_id_fkey;
    ALTER TABLE evimed_vcr.evidence_items ADD CONSTRAINT evidence_items_precedent_id_fkey
      FOREIGN KEY (precedent_id) REFERENCES evimed_vcr.precedents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- An assumption card: one parameter, one version. The distribution is what a
-- simulation draws from; the prediction interval is what a pooled literature
-- parameter actually justifies (plan §6.1).
-- Authenticated curve selection/extraction receipts are study-local immutable numerical input.
CREATE TABLE IF NOT EXISTS evimed_vcr.curve_extractions (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  principal text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('human_click','digitizer')),
  image jsonb NOT NULL,
  points_hash text NOT NULL,
  scenario jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_curve_extractions_study_idx ON evimed_vcr.curve_extractions(study_id,created_at);
-- A digitizer record also keeps what the digitization was: the algorithm and its
-- version, the calibration the run stated, the parameters used and the quality of
-- each curve. Null for a human selection, which has none of that to keep.
ALTER TABLE evimed_vcr.curve_extractions ADD COLUMN IF NOT EXISTS digitization jsonb;

CREATE TABLE IF NOT EXISTS evimed_vcr.assumptions (
  id             text PRIMARY KEY,
  study_id       text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  key            text NOT NULL,
  version        integer NOT NULL,
  name           text NOT NULL,
  endpoint       text,
  unit           text,
  point_value    numeric,
  distribution   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sensitivity    jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_kind    text NOT NULL CHECK (source_kind IN ${inList(VCR_ASSUMPTION_SOURCE_KINDS)}),
  value_source   text NOT NULL DEFAULT 'assumed' CHECK (value_source IN ${inList(VCR_VALUE_SOURCES)}),
  pooling_method text CHECK (pooling_method IS NULL OR pooling_method IN ${inList(VCR_POOLING_METHODS)}),
  pooling        jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids   text[] NOT NULL DEFAULT '{}',
  applicability  jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state   text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, key, version)
);
CREATE INDEX IF NOT EXISTS vcr_assumptions_study_idx ON evimed_vcr.assumptions (study_id, key, version DESC);

-- ---------------------------------------------------------------------------
-- Data plane (plan §8.1). Patient-level rows live outside this schema.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evimed_vcr.sources (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  study_id       text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  name           text NOT NULL,
  owner_party    text NOT NULL DEFAULT '',
  allowed_uses   text[] NOT NULL DEFAULT '{}',
  visible_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention      jsonb NOT NULL DEFAULT '{}'::jsonb,
  format         text NOT NULL DEFAULT 'csv',
  status         text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'profiled', 'frozen', 'withdrawn')),
  -- What the rows of this source are (the nine value sources). Every table
  -- derived from it carries this label; a caller never supplies it.
  value_source   text NOT NULL DEFAULT 'observed' CHECK (value_source IN ${inList(VCR_VALUE_SOURCES)}),
  -- The field map before any snapshot: one document, validated as a whole,
  -- proposed by the run or a person and confirmed by a person (plan §8.1 step 2).
  field_map      jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_map_state text NOT NULL DEFAULT 'none' CHECK (field_map_state IN ${inList(VCR_FIELD_MAP_STATES)}),
  field_map_hash text,
  field_map_by   text NOT NULL DEFAULT '',
  field_map_at   timestamptz,
  field_map_confirmed_by text,
  field_map_confirmed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS value_source text NOT NULL DEFAULT 'observed' CHECK (value_source IN ${inList(VCR_VALUE_SOURCES)});
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_state text NOT NULL DEFAULT 'none' CHECK (field_map_state IN ${inList(VCR_FIELD_MAP_STATES)});
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_hash text;
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_by text NOT NULL DEFAULT '';
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_at timestamptz;
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_confirmed_by text;
ALTER TABLE evimed_vcr.sources ADD COLUMN IF NOT EXISTS field_map_confirmed_at timestamptz;
CREATE INDEX IF NOT EXISTS vcr_sources_user_idx ON evimed_vcr.sources (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS vcr_sources_study_idx ON evimed_vcr.sources (study_id, updated_at DESC);

-- A file uploaded into a source, before any snapshot: named by what it holds
-- (the bytes' sha256), never by what the uploader called it. The bytes live in
-- the data plane; this row is the reference, the hash and the draft profile the
-- run reads to propose a field map. \`detail\` carries a dictionary's entries or
-- a document's subject key and visible time.
CREATE TABLE IF NOT EXISTS evimed_vcr.source_files (
  id           text PRIMARY KEY,
  source_id    text NOT NULL REFERENCES evimed_vcr.sources(id) ON DELETE CASCADE,
  study_id     text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  role         text NOT NULL DEFAULT 'data' CHECK (role IN ${inList(VCR_SOURCE_FILE_ROLES)}),
  name         text NOT NULL,
  format       text NOT NULL,
  location     text NOT NULL,
  sha256       text NOT NULL,
  bytes        bigint NOT NULL,
  row_count    integer,
  column_count integer,
  profile      jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, sha256, role)
);
CREATE INDEX IF NOT EXISTS vcr_source_files_source_idx ON evimed_vcr.source_files (source_id, created_at);
CREATE INDEX IF NOT EXISTS vcr_source_files_study_idx ON evimed_vcr.source_files (study_id);

-- Who may read which fields of which source, in which window. Judged per
-- operation in \`vcrAccess.mjs\`; this table is what it judges against.
CREATE TABLE IF NOT EXISTS evimed_vcr.grants (
  id            text PRIMARY KEY,
  source_id     text NOT NULL REFERENCES evimed_vcr.sources(id) ON DELETE CASCADE,
  study_id      text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  grantee       text NOT NULL,
  role          text CHECK (role IS NULL OR role IN ${inList(VCR_MEMBER_ROLES)}),
  fields        text[] NOT NULL DEFAULT '{}',
  field_mode    text NOT NULL DEFAULT 'allow' CHECK (field_mode IN ('allow', 'deny')),
  window_start  timestamptz,
  window_end    timestamptz,
  purposes      text[] NOT NULL DEFAULT '{}',
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_grants_source_idx ON evimed_vcr.grants (source_id) WHERE revoked_at IS NULL;

-- A frozen, hashed view of a source. Immutable: a correction makes a new one.
CREATE TABLE IF NOT EXISTS evimed_vcr.snapshots (
  id            text PRIMARY KEY,
  source_id     text NOT NULL REFERENCES evimed_vcr.sources(id) ON DELETE CASCADE,
  study_id      text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  location      text NOT NULL,
  sha256        text NOT NULL,
  row_count     integer,
  column_count  integer,
  profile       jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sealed_fields text[] NOT NULL DEFAULT '{}',
  sealed_until  timestamptz,
  -- Every file of the snapshot with its own sha256, in the order they were
  -- profiled, and the hash of the confirmed field map they were frozen with.
  file_hashes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_map_hash text,
  value_source  text NOT NULL DEFAULT 'observed',
  created_by    text NOT NULL DEFAULT '',
  frozen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);
ALTER TABLE evimed_vcr.snapshots ADD COLUMN IF NOT EXISTS file_hashes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evimed_vcr.snapshots ADD COLUMN IF NOT EXISTS field_map_hash text;
ALTER TABLE evimed_vcr.snapshots ADD COLUMN IF NOT EXISTS value_source text NOT NULL DEFAULT 'observed';
ALTER TABLE evimed_vcr.snapshots ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS vcr_snapshots_study_idx ON evimed_vcr.snapshots (study_id, frozen_at DESC);

-- What a column means: the unit, the coding system, which clock it is on and
-- what a blank in it means (plan §8.1).
CREATE TABLE IF NOT EXISTS evimed_vcr.field_maps (
  id             text PRIMARY KEY,
  snapshot_id    text NOT NULL REFERENCES evimed_vcr.snapshots(id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  table_name     text NOT NULL DEFAULT '',
  column_name    text NOT NULL,
  concept        text NOT NULL DEFAULT '',
  unit           text,
  coding_system  text,
  time_kind      text CHECK (time_kind IS NULL OR time_kind IN ('occurred_at', 'recorded_at', 'visible_at')),
  missing_reason text CHECK (missing_reason IS NULL OR missing_reason IN ${inList(VCR_MISSING_REASONS)}),
  identifier     boolean NOT NULL DEFAULT false,
  review_state   text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  -- What the column is for (the derivation reads these), the name it carries in
  -- the analysis tables, and what the map declares about its values.
  role           text NOT NULL DEFAULT 'other' CHECK (role IN ${inList(VCR_FIELD_ROLES)}),
  parameter      text,
  alias          text,
  declared_type  text,
  value_range    jsonb,
  required       boolean NOT NULL DEFAULT false,
  outcome        boolean NOT NULL DEFAULT false,
  codes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS table_name text NOT NULL DEFAULT '';
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'other' CHECK (role IN ${inList(VCR_FIELD_ROLES)});
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS parameter text;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS alias text;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS declared_type text;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS value_range jsonb;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS outcome boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_vcr.field_maps ADD COLUMN IF NOT EXISTS codes jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Two files of one snapshot may each have a column of the same name.
ALTER TABLE evimed_vcr.field_maps DROP CONSTRAINT IF EXISTS field_maps_snapshot_id_column_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS vcr_field_maps_snapshot_table_column ON evimed_vcr.field_maps (snapshot_id, table_name, column_name);

-- The three ADaM-shaped tables a snapshot derives inside a study. The engine
-- only ever reads these three shapes, which is why a new disease does not
-- change the engine (plan §8.1).
CREATE TABLE IF NOT EXISTS evimed_vcr.analysis_tables (
  id          text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES evimed_vcr.snapshots(id) ON DELETE CASCADE,
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  shape       text NOT NULL CHECK (shape IN ${inList(VCR_ANALYSIS_TABLES)}),
  location    text NOT NULL,
  sha256      text NOT NULL,
  row_count   integer,
  columns     jsonb NOT NULL DEFAULT '[]'::jsonb,
  issues      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which source columns feed the table, whether any of them is an outcome
  -- (a table carrying one is withheld while the seal holds), and the value
  -- source its rows carry — set from the source, never by a caller.
  outcome_bearing boolean NOT NULL DEFAULT false,
  derived_from    jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_source    text NOT NULL DEFAULT 'observed',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, study_id, shape)
);
ALTER TABLE evimed_vcr.analysis_tables ADD COLUMN IF NOT EXISTS outcome_bearing boolean NOT NULL DEFAULT false;
ALTER TABLE evimed_vcr.analysis_tables ADD COLUMN IF NOT EXISTS derived_from jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evimed_vcr.analysis_tables ADD COLUMN IF NOT EXISTS value_source text NOT NULL DEFAULT 'observed';

-- ---------------------------------------------------------------------------
-- Research objects (plan §5)
-- ---------------------------------------------------------------------------

-- A population: the definition and one generation of it are two things, so the
-- same definition can be re-run on another snapshot and compared (plan §5.1).
CREATE TABLE IF NOT EXISTS evimed_vcr.populations (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  name          text NOT NULL DEFAULT '',
  kind          text NOT NULL CHECK (kind IN ${inList(VCR_POPULATION_KINDS)}),
  definition    jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_id   text REFERENCES evimed_vcr.snapshots(id) ON DELETE SET NULL,
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  waterfall     jsonb NOT NULL DEFAULT '[]'::jsonb,
  profile       jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality       jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_uses  text[] NOT NULL DEFAULT '{}',
  result_id     text,
  review_state  text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_vcr.patient_sets (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  population_id text REFERENCES evimed_vcr.populations(id) ON DELETE SET NULL,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  name          text NOT NULL DEFAULT '',
  model_id      text,
  model_version text,
  scenario      jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  twin_label    text CHECK (twin_label IS NULL OR twin_label IN ('digital_twin', 'baseline_conditioned_prediction')),
  result_id     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_vcr.comparator_designs (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  route         text NOT NULL CHECK (route IN ${inList(VCR_COMPARATOR_ROUTES)}),
  estimand      text NOT NULL DEFAULT 'ATT' CHECK (estimand IN ('ATT', 'ATE', 'ATO')),
  target_trial  jsonb NOT NULL DEFAULT '{}'::jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  conclusion    text CHECK (conclusion IS NULL OR conclusion IN ${inList(VCR_CONCLUSIONS)}),
  gap_list      jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_id     text,
  review_state  text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

CREATE TABLE IF NOT EXISTS evimed_vcr.trial_scenarios (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  version       integer NOT NULL,
  label         text NOT NULL DEFAULT '',
  design        text NOT NULL CHECK (design IN ${inList(VCR_TRIAL_DESIGNS)}),
  endpoint_type text NOT NULL CHECK (endpoint_type IN ${inList(VCR_ENDPOINT_TYPES)}),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  assumption_ids text[] NOT NULL DEFAULT '{}',
  comparator_id text REFERENCES evimed_vcr.comparator_designs(id) ON DELETE SET NULL,
  result_id     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version, label)
);

-- Design dimensions × truth scenarios. Each cell is one immutable run, and the
-- comparison target the team wrote down decides the ordering, not the platform
-- (plan §5.4).
CREATE TABLE IF NOT EXISTS evimed_vcr.design_grids (
  id               text PRIMARY KEY,
  study_id         text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id          text NOT NULL,
  version          integer NOT NULL,
  dimensions       jsonb NOT NULL DEFAULT '{}'::jsonb,
  truth_scenarios  jsonb NOT NULL DEFAULT '[]'::jsonb,
  comparison_goal  jsonb,
  cells            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, version)
);

-- ---------------------------------------------------------------------------
-- The shared model and method library (plan §8.2). Not owned by one study.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evimed_vcr.models (
  id             text PRIMARY KEY,
  user_id        text,
  study_id       text REFERENCES evimed_vcr.studies(id) ON DELETE SET NULL,
  name           text NOT NULL,
  version        text NOT NULL,
  tier           text NOT NULL CHECK (tier IN ${inList(VCR_MODEL_TIERS)}),
  risk           text NOT NULL DEFAULT 'none' CHECK (risk IN ${inList(VCR_MODEL_RISKS)}),
  endpoint_type  text CHECK (endpoint_type IS NULL OR endpoint_type IN ${inList(VCR_ENDPOINT_TYPES)}),
  card           jsonb NOT NULL DEFAULT '{}'::jsonb,
  applicability  jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation     jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence       text[] NOT NULL DEFAULT '{}',
  retired_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One model per owner, name and version; the platform's own rows (user_id NULL)
-- are their own scope. The table used to say UNIQUE (name, version), which made
-- every account's model collide with — and rewrite — every other's.
ALTER TABLE evimed_vcr.models DROP CONSTRAINT IF EXISTS models_name_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS vcr_models_owner_name_version
  ON evimed_vcr.models ((COALESCE(user_id, '')), name, version);

CREATE TABLE IF NOT EXISTS evimed_vcr.methods (
  id             text PRIMARY KEY,
  method         text NOT NULL,
  version        text NOT NULL,
  endpoints      text[] NOT NULL DEFAULT '{}',
  assumptions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  numeric_tests  jsonb NOT NULL DEFAULT '{}'::jsonb,
  cross_checks   text[] NOT NULL DEFAULT '{}',
  released_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method, version)
);

-- ---------------------------------------------------------------------------
-- Execution (plan §11.4). A job carries its scenario; nothing is re-read.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evimed_vcr.jobs (
  id              text PRIMARY KEY,
  study_id        text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ${inList(VCR_JOB_KINDS)}),
  method          text NOT NULL,
  method_version  text NOT NULL DEFAULT '',
  state           text NOT NULL DEFAULT 'queued' CHECK (state IN ${inList(VCR_JOB_STATES)}),
  scenario        jsonb NOT NULL DEFAULT '{}'::jsonb,
  scenario_hash   text NOT NULL DEFAULT '',
  inputs          jsonb NOT NULL DEFAULT '[]'::jsonb,
  seed            bigint NOT NULL DEFAULT 0,
  replicates      integer,
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint      jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  cpu_seconds_limit numeric NOT NULL DEFAULT 600,
  cpu_seconds_used  numeric NOT NULL DEFAULT 0,
  budget_cny      numeric,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  run_after       timestamptz NOT NULL DEFAULT now(),
  lease_owner     text,
  lease_until     timestamptz,
  run_id          text,
  error           jsonb,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS vcr_jobs_claim_idx ON evimed_vcr.jobs (state, run_after) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS vcr_jobs_study_idx ON evimed_vcr.jobs (study_id, created_at DESC);

-- What a finished job actually ran: inputs, environment, seed, hashes.
-- Immutable — this is what AC-04 reproduces from.
CREATE TABLE IF NOT EXISTS evimed_vcr.executions (
  id             text PRIMARY KEY,
  job_id         text NOT NULL REFERENCES evimed_vcr.jobs(id) ON DELETE CASCADE,
  study_id       text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  method         text NOT NULL,
  method_version text NOT NULL DEFAULT '',
  scenario_hash  text NOT NULL DEFAULT '',
  inputs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  environment    jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed           bigint NOT NULL DEFAULT 0,
  replicates     integer,
  output_hash    text,
  receipt        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cpu_seconds    numeric,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_executions_study_idx ON evimed_vcr.executions (study_id, created_at DESC);

-- A result is immutable and superseded, never updated (plan §3.4). The four
-- counts live in \`counts\`; the scientific conclusion is the method's own.
CREATE TABLE IF NOT EXISTS evimed_vcr.results (
  id              text PRIMARY KEY,
  study_id        text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  execution_id    text REFERENCES evimed_vcr.executions(id) ON DELETE SET NULL,
  user_id         text NOT NULL,
  kind            text NOT NULL,
  subject_id      text,
  version         integer NOT NULL DEFAULT 1,
  conclusion      text CHECK (conclusion IS NULL OR conclusion IN ${inList(VCR_CONCLUSIONS)}),
  not_estimable_rule text,
  counts          jsonb NOT NULL DEFAULT '{}'::jsonb,
  measures        jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics     jsonb NOT NULL DEFAULT '{}'::jsonb,
  tables          jsonb NOT NULL DEFAULT '[]'::jsonb,
  intended_use    text CHECK (intended_use IS NULL OR intended_use IN ${inList(VCR_INTENDED_USES)}),
  use_downgrade   jsonb,
  review_state    text NOT NULL DEFAULT 'ai_set' CHECK (review_state IN ${inList(VCR_REVIEW_STATES)}),
  superseded_by   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_results_study_idx ON evimed_vcr.results (study_id, kind, created_at DESC);

-- A prediction registered before the outcome it predicts, with the timestamp
-- and hash that prove the order (plan §5.4, AC-23).
CREATE TABLE IF NOT EXISTS evimed_vcr.forecasts (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  kind          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  prediction    jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash  text NOT NULL DEFAULT '',
  public        boolean NOT NULL DEFAULT false,
  actual        jsonb,
  compared_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, kind, version)
);

-- ---------------------------------------------------------------------------
-- Matching, referral, sites, follow-up (plan §7)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evimed_vcr.matching_assessments (
  id                  text PRIMARY KEY,
  study_id            text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  protocol_version_id text REFERENCES evimed_vcr.protocol_versions(id) ON DELETE SET NULL,
  user_id             text NOT NULL,
  subject_key         text NOT NULL,
  direction           text NOT NULL DEFAULT 'trial_to_patient' CHECK (direction IN ('trial_to_patient', 'patient_to_trial')),
  as_of               timestamptz NOT NULL DEFAULT now(),
  summary             text NOT NULL DEFAULT 'pending' CHECK (summary IN ${inList(VCR_ELIGIBILITY_SUMMARIES)}),
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority            jsonb,
  evidence_gaps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by         text,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, protocol_version_id, subject_key, as_of)
);
ALTER TABLE evimed_vcr.matching_assessments ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS vcr_matching_study_idx ON evimed_vcr.matching_assessments (study_id, summary, created_at DESC);

CREATE TABLE IF NOT EXISTS evimed_vcr.criterion_judgments (
  id             text PRIMARY KEY,
  assessment_id  text NOT NULL REFERENCES evimed_vcr.matching_assessments(id) ON DELETE CASCADE,
  criterion_id   text NOT NULL REFERENCES evimed_vcr.criteria(id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  state          text NOT NULL CHECK (state IN ${inList(VCR_CRITERION_STATES)}),
  applicable     boolean NOT NULL DEFAULT true,
  decided_by     text NOT NULL DEFAULT 'code' CHECK (decided_by IN ('code', 'model', 'human')),
  evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,
  recheck_at     timestamptz,
  overridden_by  text,
  override_state text CHECK (override_state IS NULL OR override_state IN ${inList(VCR_CRITERION_STATES)}),
  override_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, criterion_id)
);

-- A fact about one patient, with where it was read (plan §7.1). The subject is
-- the study's pseudonym, never a source id. A model-read fact keeps the
-- document, the span and the quotation so the evaluator can re-read the bytes;
-- \`fact_key\` makes writing the same located fact twice one row.
CREATE TABLE IF NOT EXISTS evimed_vcr.matching_facts (
  id           text PRIMARY KEY,
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  subject_key  text NOT NULL,
  fact_key     text NOT NULL,
  variable     text NOT NULL,
  value        jsonb,
  unit         text,
  polarity     text NOT NULL DEFAULT 'affirmed' CHECK (polarity IN ('affirmed', 'negated', 'hypothetical', 'family')),
  occurred_at  timestamptz,
  recorded_at  timestamptz,
  visible_at   timestamptz NOT NULL,
  surface      text NOT NULL DEFAULT '',
  date_surface text,
  source       jsonb,
  extracted_by text NOT NULL DEFAULT 'model' CHECK (extracted_by IN ('model', 'code')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, fact_key)
);
CREATE INDEX IF NOT EXISTS vcr_matching_facts_subject_idx ON evimed_vcr.matching_facts (study_id, subject_key);

-- The answer to a criterion only language can decide, with the sentences it
-- rests on. The newest per (study, subject, key) is the one evaluated.
CREATE TABLE IF NOT EXISTS evimed_vcr.language_judgments (
  id           text PRIMARY KEY,
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  subject_key  text NOT NULL,
  criterion_key text NOT NULL,
  state        text NOT NULL CHECK (state IN ('satisfied', 'not_satisfied', 'unknown')),
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,
  visible_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_language_judgments_idx ON evimed_vcr.language_judgments (study_id, subject_key, criterion_key, created_at DESC);

CREATE TABLE IF NOT EXISTS evimed_vcr.sites (
  id             text PRIMARY KEY,
  study_id       text REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  name           text NOT NULL,
  capability     jsonb NOT NULL DEFAULT '{}'::jsonb,
  capacity       jsonb NOT NULL DEFAULT '{}'::jsonb,
  competing      jsonb NOT NULL DEFAULT '[]'::jsonb,
  contacts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  activated_on   date,
  accrual_prior  jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_vcr.referrals (
  id             text PRIMARY KEY,
  study_id       text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  assessment_id  text REFERENCES evimed_vcr.matching_assessments(id) ON DELETE SET NULL,
  site_id        text REFERENCES evimed_vcr.sites(id) ON DELETE SET NULL,
  user_id        text NOT NULL,
  subject_key    text NOT NULL,
  state          text NOT NULL DEFAULT 'candidate' CHECK (state IN ${inList(VCR_REFERRAL_STATES)}),
  contact_approved_by text,
  contact_approved_at timestamptz,
  screen_fail_criterion_id text REFERENCES evimed_vcr.criteria(id) ON DELETE SET NULL,
  screen_fail_reason text,
  enrolled_on    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_referrals_state_idx ON evimed_vcr.referrals (study_id, state, updated_at DESC);

-- One live referral per subject and study. screen_failed is terminal and a
-- second attempt on the same protocol is a NEW referral (plan §7.2), so the
-- funnel's denominators stay countable: the old table-level UNIQUE turned that
-- second attempt into an overwrite of the failed one.
ALTER TABLE evimed_vcr.referrals DROP CONSTRAINT IF EXISTS referrals_study_id_subject_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS vcr_referrals_live_subject
  ON evimed_vcr.referrals (study_id, subject_key) WHERE state <> 'screen_failed';

-- The first human stop, held by the schema as well as by the policy (plan
-- §10.1, AC-18): a referral at or past 'contacted' has a named approver. NOT
-- VALID so a database that predates it migrates; every new write is checked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'vcr_referrals_contact_needs_approval' AND conrelid = 'evimed_vcr.referrals'::regclass) THEN
    ALTER TABLE evimed_vcr.referrals ADD CONSTRAINT vcr_referrals_contact_needs_approval
      CHECK (state NOT IN ${inList(VCR_REFERRAL_STATES.slice(VCR_REFERRAL_STATES.indexOf("contacted"), VCR_REFERRAL_STATES.indexOf("screen_failed") + 1))}
        OR contact_approved_by IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS evimed_vcr.referral_events (
  id          text PRIMARY KEY,
  referral_id text NOT NULL REFERENCES evimed_vcr.referrals(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  from_state  text CHECK (from_state IS NULL OR from_state IN ${inList(VCR_REFERRAL_STATES)}),
  to_state    text NOT NULL CHECK (to_state IN ${inList(VCR_REFERRAL_STATES)}),
  actor       text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_referral_events_idx ON evimed_vcr.referral_events (referral_id, occurred_at);

CREATE TABLE IF NOT EXISTS evimed_vcr.followup_episodes (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  subject_key   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ${inList(VCR_FOLLOWUP_KINDS)}),
  window_start  timestamptz,
  window_end    timestamptz,
  observations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  restricted    jsonb NOT NULL DEFAULT '{}'::jsonb,
  exit_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Governance (plan §6.3, §10.2, §11.3)
-- ---------------------------------------------------------------------------

-- One lineage edge: \`<kind>:<id>@<version>\` on both ends (vcrLineage.mjs).
CREATE TABLE IF NOT EXISTS evimed_vcr.dependencies (
  study_id   text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  from_node  text NOT NULL,
  to_node    text NOT NULL,
  cost       text NOT NULL DEFAULT 'light' CHECK (cost IN ('light', 'heavy')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, from_node, to_node)
);

CREATE TABLE IF NOT EXISTS evimed_vcr.stale_marks (
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  node        text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ${inList(VCR_STALE_REASONS)}),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  queued_job_id text,
  marked_at   timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  PRIMARY KEY (study_id, node)
);

CREATE TABLE IF NOT EXISTS evimed_vcr.reviews (
  id           text PRIMARY KEY,
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ${inList(VCR_REVIEW_KINDS)}),
  nodes        text[] NOT NULL DEFAULT '{}',
  state        text NOT NULL DEFAULT 'reviewed' CHECK (state IN ${inList(VCR_REVIEW_STATES)}),
  reviewer     text NOT NULL,
  note         text NOT NULL DEFAULT '',
  changes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_reviews_study_idx ON evimed_vcr.reviews (study_id, created_at DESC);

ALTER TABLE evimed_vcr.reviews ADD COLUMN IF NOT EXISTS reviewer_kind text NOT NULL DEFAULT 'human' CHECK (reviewer_kind IN ('ai','human'));
ALTER TABLE evimed_vcr.reviews ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'done' CHECK (status IN ('queued','running','done','failed'));
ALTER TABLE evimed_vcr.reviews ADD COLUMN IF NOT EXISTS platform_review_id text;
ALTER TABLE evimed_vcr.reviews ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS vcr_reviews_platform_idx ON evimed_vcr.reviews(platform_review_id) WHERE platform_review_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS evimed_vcr.decisions (
  id            text PRIMARY KEY,
  study_id      text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  question      text NOT NULL,
  chosen        jsonb NOT NULL DEFAULT '{}'::jsonb,
  alternatives  jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale     text NOT NULL DEFAULT '',
  decided_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_vcr.regulatory_contacts (
  id          text PRIMARY KEY,
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  agency      text NOT NULL,
  meeting     text NOT NULL DEFAULT '',
  occurred_on date,
  conclusion  text NOT NULL DEFAULT '',
  source_ref  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evimed_vcr.exports (
  id          text PRIMARY KEY,
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ${inList(VCR_EXPORT_KINDS)}),
  state       text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  run_id      text,
  location    text,
  sha256      text,
  cover       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Who did what, when, and why. Never off (plan §11.3).
CREATE TABLE IF NOT EXISTS evimed_vcr.audit (
  id          bigserial PRIMARY KEY,
  study_id    text,
  user_id     text,
  actor       text NOT NULL DEFAULT '',
  action      text NOT NULL,
  object      text NOT NULL DEFAULT '',
  outcome     text NOT NULL DEFAULT 'ok',
  reason      text NOT NULL DEFAULT '',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vcr_audit_study_idx ON evimed_vcr.audit (study_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS vcr_audit_action_idx ON evimed_vcr.audit (action, occurred_at DESC);

-- The orchestrator's marks: what it dispatched, enqueued, sent or skipped,
-- once per key (the GEO shape, so restarts and two processes cannot double).
CREATE TABLE IF NOT EXISTS evimed_vcr.schedule_marks (
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  key         text NOT NULL,
  user_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('run', 'job', 'notice', 'export', 'recompute')),
  state       text NOT NULL CHECK (state IN ('pending', 'claimed', 'running', 'done', 'failed', 'skipped')),
  step        text CHECK (step IS NULL OR step IN ${inList(VCR_STEPS)}),
  run_id      text,
  session_id  text,
  dispatch_id text,
  job_id      text,
  attempts    integer NOT NULL DEFAULT 0,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  PRIMARY KEY (study_id, key)
);
CREATE INDEX IF NOT EXISTS vcr_schedule_marks_open_idx ON evimed_vcr.schedule_marks (study_id, kind, state)
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
export async function migrateVcr(database) {
  if (!database || typeof database.transaction !== "function") throw new TypeError("The VCR migration needs the product database.");
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-v1'))");
    const ddl = sql();
    await client.query(ddl);
    // A vocabulary word the domain added after this table was created is
    // otherwise refused on every existing database (vocabularyChecks.mjs).
    await refreshVocabularyChecks(client, ddl, VCR_SCHEMA);
    return { schema: VCR_SCHEMA, tables: VCR_TABLES };
  });
  migrations.set(database, attempt);
  try { return await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/** The DDL as text, for tests that read it without a database. */
export function vcrSchemaSql() {
  return sql();
}
