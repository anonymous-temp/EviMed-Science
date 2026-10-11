/**
 * The schema of withdrawal and of the marks on what was derived from a basis that has since changed (2026-10-10), kept in a file
 * of its own so that the tables, the vocabulary and the statements that read them agree in one place.
 *
 * Hidden knowledge:
 *
 * - **Erasing text keeps the row.** A document, a projection, a fact or a judgment that is erased keeps its id, its hashes and its
 *   place in the ledger: `erased_at`, `retired_at`/`purged_at` and `withdrawn` say that its words are gone, and the hash it had
 *   before is kept beside them (`withdrawn.digest`) so a frozen evaluation that referred to it still verifies and reads as
 *   withdrawn instead of changed.
 * - **A mark is not a verdict.** `derived_marks` says that a fact, a judgment or an assessment was derived from a document, a
 *   projection or a permission that has since changed (or that its source was withdrawn). Nothing reads a mark to block
 *   anything and nothing re-runs because of one; the page shows it as a plain state beside the thing it marks and offers the
 *   evaluation that already exists.
 * - The statements are additive and idempotent, like the rest of the module's schema (`vcrPersistence.test.mjs`).
 */

/** Why something derived from a basis is marked: the document it read, the projection it read, the permission it was read under, or a withdrawal. */
export const VCR_BASIS_CAUSES = Object.freeze(["document", "projection", "permission", "withdrawn"]);
/** What a mark is on. */
export const VCR_MARK_KINDS = Object.freeze(["fact", "language_judgment", "assessment"]);

const words = (/** @type {readonly string[]} */ list) => `(${list.map((word) => `'${word}'`).join(", ")})`;

export const VCR_ERASURE_SQL = `
-- Withdrawal and retirement (2026-10-10): the text goes, the row, its hashes and the audit trail stay.
ALTER TABLE evimed_vcr.source_files ADD COLUMN IF NOT EXISTS erased_at timestamptz;
ALTER TABLE evimed_vcr.document_projections ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE evimed_vcr.document_projections ADD COLUMN IF NOT EXISTS purged_at timestamptz;
ALTER TABLE evimed_vcr.matching_facts ADD COLUMN IF NOT EXISTS withdrawn jsonb;
ALTER TABLE evimed_vcr.language_judgments ADD COLUMN IF NOT EXISTS withdrawn jsonb;

-- A subject whose consent was withdrawn: no longer a candidate, no longer a referral, whatever else the study holds of them.
CREATE TABLE IF NOT EXISTS evimed_vcr.subject_withdrawals (
  study_id     text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  subject_key  text NOT NULL,
  withdrawn_by text NOT NULL DEFAULT '',
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, subject_key)
);

-- Derived from a basis that has since changed. The strongest cause stays (a withdrawal over a change).
CREATE TABLE IF NOT EXISTS evimed_vcr.derived_marks (
  study_id    text NOT NULL REFERENCES evimed_vcr.studies(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ${words(VCR_MARK_KINDS)}),
  target_id   text NOT NULL,
  subject_key text NOT NULL,
  cause       text NOT NULL CHECK (cause IN ${words(VCR_BASIS_CAUSES)}),
  cause_id    text NOT NULL DEFAULT '',
  marked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (study_id, kind, target_id)
);
CREATE INDEX IF NOT EXISTS vcr_derived_marks_subject_idx ON evimed_vcr.derived_marks (study_id, subject_key);
`;
