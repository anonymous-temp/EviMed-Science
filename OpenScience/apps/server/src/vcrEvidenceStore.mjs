/**
 * The evidence side of `evimed_vcr`: the precedent library, the extracted
 * values behind every number, and the versioned assumption cards
 * (build plan 2026-09-28 §6).
 *
 * Hidden knowledge:
 *
 * - **A precedent is per account, not per study** (`UNIQUE (user_id, registry,
 *   registry_id)`), because the library is also usable on its own — 「近五年国内
 *   NSCLC 二线 II 期单臂试验的入组速度」 is a question with no study attached
 *   (plan §6.4). Which studies use a precedent is `study_precedents`; the
 *   precedent's own `study_id` is only the study that first pulled it in. A
 *   second study fetching the same record never re-points it, and deleting a
 *   study never deletes a record another study pools from (review CS-4).
 * - **An extracted value is append-only.** `evidence_items` is never updated:
 *   a re-extraction writes new rows and the assumption card names the ids it
 *   used, so a card built last week still points at the bytes it was built
 *   from. That is what makes AC-25 answerable after the fact. Pooling reads the
 *   *latest* row per `(precedent, parameter, arm, endpoint key)`, so a
 *   re-extraction replaces a value for the pool without erasing it for the card
 *   that cited it (CS-26).
 * - **A value that failed its quote check is stored, not dropped.** It lands
 *   with `value = NULL`, `value_text = 'unknown'` and
 *   `locator.verification = 'quote_not_found'`. Dropping it would leave no
 *   record that the number was attempted and refused, and the next run would
 *   attempt it again with nothing to learn from. `verifiedEvidenceIds` is the
 *   only reader a card is allowed to use.
 * - **Versions are allocated under a lock.** Two runs saving 「脱落率 v4」 at the
 *   same moment would both read 3 and both write 4; the unique index would then
 *   fail the slower one after its work, as a 500. The save takes a transaction
 *   advisory lock on `(study, key)` first (review E-11).
 * - **Reads are scoped by `user_id` in the predicate, always.** Membership is
 *   `vcrAccess.mjs`'s decision and it happens before a call reaches here; this
 *   store never widens a query to 「all studies」 for convenience, so a caller
 *   that forgot the check gets nothing rather than someone else's library.
 * - **The preserved record text is not a column of a list.** It is what a
 *   quotation is checked against later (`record_text`), up to hundreds of
 *   kilobytes, so lists name their columns and only `getPrecedent` /
 *   `findPrecedent` with `withText` read it.
 *
 * @module vcrEvidenceStore
 */

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** How a stored extraction reports its quote check. Written into `locator.verification`. */
export const EVIDENCE_VERIFICATION_STATES = Object.freeze(["verified", "quote_not_found", "source_unavailable", "no_quote"]);

/** Which arm of a trial a value describes; pooling names the one it pools (review CS-26). */
export const EVIDENCE_ARM_ROLES = Object.freeze(["control", "treatment", "contrast", "single_arm", "overall", "unknown"]);

/** The precedent columns a list carries: everything but the preserved text. */
const PRECEDENT_COLUMNS = `id, user_id, study_id, registry, registry_id, title, pico, design, enrollment, enrollment_kind,
  sites, eligibility_text, endpoints, results, sources, fetched_at, created_at, record_hash`;

/** @param {unknown} value */
const jsonb = (value) => JSON.stringify(value ?? {});
/** @param {unknown} value @returns {number | null} */
const numeric = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
/** @param {unknown} value @returns {number | null} a whole number, or null — never a rounded stand-in for a fraction */
const whole = (value) => {
  const parsed = numeric(value);
  return parsed !== null && Number.isInteger(parsed) && Math.abs(parsed) <= 2_147_483_647 ? parsed : null;
};

export class VcrEvidenceStore extends VcrStoreBase {
  // -------------------------------------------------------------------------
  // Precedents
  // -------------------------------------------------------------------------

  /**
   * Write one precedent, keyed by the registry record it is, and record that
   * the study uses it. Returns the row (without its preserved text).
   * @param {{ userId: string, studyId?: string | null, precedent: any, recordText?: string, recordHash?: string | null, client?: any }} input
   */
  async savePrecedent({ userId, studyId = null, precedent, recordText = "", recordHash = null, client = null }) {
    const run = async (/** @type {any} */ handle) => {
      const result = await handle.query(
        `INSERT INTO ${VCR_SCHEMA}.precedents
           (id, user_id, study_id, registry, registry_id, title, pico, design, enrollment, enrollment_kind,
            sites, eligibility_text, endpoints, results, sources, fetched_at, record_text, record_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18)
         ON CONFLICT (user_id, registry, registry_id) DO UPDATE SET
           title = EXCLUDED.title, pico = EXCLUDED.pico, design = EXCLUDED.design,
           enrollment = EXCLUDED.enrollment, enrollment_kind = EXCLUDED.enrollment_kind,
           sites = EXCLUDED.sites, eligibility_text = EXCLUDED.eligibility_text,
           endpoints = EXCLUDED.endpoints, results = EXCLUDED.results, sources = EXCLUDED.sources,
           fetched_at = EXCLUDED.fetched_at,
           record_text = CASE WHEN EXCLUDED.record_text <> '' THEN EXCLUDED.record_text ELSE ${VCR_SCHEMA}.precedents.record_text END,
           record_hash = COALESCE(EXCLUDED.record_hash, ${VCR_SCHEMA}.precedents.record_hash)
         RETURNING ${PRECEDENT_COLUMNS}`,
        [
          vcrId("precedent"), userId, studyId,
          String(precedent?.registry ?? ""), String(precedent?.registryId ?? ""), String(precedent?.title ?? ""),
          jsonb(precedent?.pico), jsonb(precedent?.design), jsonb(precedent?.enrollment),
          precedent?.enrollmentKind ?? null, jsonb(precedent?.sites), String(precedent?.eligibilityText ?? ""),
          jsonb(precedent?.endpoints ?? []), jsonb(precedent?.results), jsonb(precedent?.sources ?? []),
          precedent?.fetchedAt ?? null, String(recordText ?? ""), recordHash,
        ],
      );
      const row = result.rows[0] ?? null;
      if (row && studyId) {
        await handle.query(
          `INSERT INTO ${VCR_SCHEMA}.study_precedents (study_id, precedent_id, user_id) VALUES ($1, $2, $3)
           ON CONFLICT (study_id, precedent_id) DO NOTHING`, [studyId, row.id, userId]);
      }
      await this.audit({
        client: handle, studyId, userId, actor: "system", action: "vcr.precedent.save",
        object: `${precedent?.registry ?? ""}:${precedent?.registryId ?? ""}`,
        detail: { hasResults: Boolean(precedent?.results?.hasResults), enrollmentKind: precedent?.enrollmentKind ?? null },
      });
      return row;
    };
    return client ? run(client) : this.transaction(run);
  }

  /**
   * The precedent library, newest first. With a `studyId` it is the precedents
   * that study uses. `parameters` is not a filter here: choosing which
   * precedents may be pooled is a per-item judgment made after the candidates
   * are read (plan §6.4).
   * @param {{ userId: string, studyId?: string | null, registry?: string | null,
   *   hasResults?: boolean | null, search?: string, limit?: number, offset?: number }} query
   */
  async listPrecedents({ userId, studyId = null, registry = null, hasResults = null, search = "", limit = 50, offset = 0 }) {
    /** @type {unknown[]} */
    const values = [userId];
    const where = ["p.user_id = $1"];
    let join = "";
    if (studyId) {
      values.push(studyId);
      join = `JOIN ${VCR_SCHEMA}.study_precedents sp ON sp.precedent_id = p.id AND sp.study_id = $${values.length}`;
    }
    if (registry) { values.push(registry); where.push(`p.registry = $${values.length}`); }
    if (hasResults !== null) { values.push(hasResults); where.push(`(p.results->>'hasResults')::boolean IS NOT DISTINCT FROM $${values.length}`); }
    if (String(search ?? "").trim()) {
      // A pattern's own wildcards are the reader's text, not the reader's query.
      values.push(`%${String(search).trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
      where.push(`(p.title ILIKE $${values.length} OR p.registry_id ILIKE $${values.length})`);
    }
    values.push(Math.max(1, Math.min(500, Math.floor(limit))), Math.max(0, Math.floor(offset)));
    return this.rows(
      `SELECT ${PRECEDENT_COLUMNS.split(",").map((column) => `p.${column.trim()}`).join(", ")}
         FROM ${VCR_SCHEMA}.precedents p ${join} WHERE ${where.join(" AND ")}
        ORDER BY p.created_at DESC, p.id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
  }

  /** @param {string} userId @param {string} id @param {{ withText?: boolean }} [options] */
  async getPrecedent(userId, id, { withText = false } = {}) {
    return this.one(
      `SELECT ${withText ? "*" : PRECEDENT_COLUMNS} FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1 AND id = $2`, [userId, id]);
  }

  /** @param {string} userId @param {string} registry @param {string} registryId @param {{ withText?: boolean }} [options] */
  async findPrecedent(userId, registry, registryId, { withText = false } = {}) {
    return this.one(
      `SELECT ${withText ? "*" : PRECEDENT_COLUMNS} FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1 AND registry = $2 AND registry_id = $3`,
      [userId, registry, registryId],
    );
  }

  /**
   * A precedent this study uses, with its preserved text: what a quotation
   * written by a run is checked against. A precedent the study does not use is
   * not found, whoever owns it.
   * @param {{ userId: string, studyId: string, registry: string, registryId: string }} query
   */
  async precedentOfStudy({ userId, studyId, registry, registryId }) {
    return this.one(
      `SELECT p.* FROM ${VCR_SCHEMA}.precedents p
         JOIN ${VCR_SCHEMA}.study_precedents sp ON sp.precedent_id = p.id AND sp.study_id = $2
        WHERE p.user_id = $1 AND p.registry = $3 AND p.registry_id = $4`,
      [userId, studyId, registry, registryId]);
  }

  // -------------------------------------------------------------------------
  // Extracted values
  // -------------------------------------------------------------------------

  /**
   * Append extracted values, all in one transaction. Each item is written as
   * it was decided — verified items with their number, refused items as
   * `unknown` — so the ledger records the attempt either way.
   * @param {{ userId: string, studyId?: string | null, precedentId?: string | null,
   *   items: readonly any[], client?: any }} input
   * @returns {Promise<{ written: number, verified: number, refused: number, ids: string[], verifiedIds: string[] }>}
   */
  async appendEvidenceItems({ userId, studyId = null, precedentId = null, items, client = null }) {
    const rows = [...(items ?? [])];
    const run = async (/** @type {any} */ handle) => {
      /** @type {string[]} */
      const ids = [];
      /** @type {string[]} */
      const verifiedIds = [];
      let refused = 0;
      for (const item of rows) {
        const id = vcrId("evidence");
        const verification = String(item?.locator?.verification ?? "no_quote");
        const accepted = verification === "verified";
        if (!accepted) refused += 1;
        await handle.query(
          `INSERT INTO ${VCR_SCHEMA}.evidence_items
             (id, user_id, study_id, precedent_id, parameter, arm, value, value_text, unit, ci_low, ci_high,
              sample_size, events, value_source, source_ref, quote, locator, applicability,
              endpoint_key, arm_role, enrollment_kind, historical_baseline, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb,
                   $19, $20, $21, $22, $23::jsonb)`,
          [
            id, userId, studyId, precedentId,
            String(item?.parameter ?? ""), item?.arm ?? null,
            // A refused value never reaches the numeric column: a number that
            // could not be found in its source must not be readable as one.
            accepted ? numeric(item?.value) : null,
            accepted ? String(item?.valueText ?? "") : "unknown",
            String(item?.unit ?? ""),
            accepted ? numeric(item?.ciLow) : null, accepted ? numeric(item?.ciHigh) : null,
            accepted ? whole(item?.sampleSize) : null, accepted ? whole(item?.events) : null,
            String(item?.valueSource ?? "extracted"), String(item?.sourceRef ?? ""), String(item?.quote ?? ""),
            jsonb(item?.locator), jsonb(item?.applicability),
            String(item?.endpointKey ?? item?.applicability?.endpointKey ?? "").trim(),
            EVIDENCE_ARM_ROLES.includes(String(item?.armRole)) ? String(item.armRole) : "unknown",
            item?.enrollmentKind ?? null,
            // Absent is not a baseline: only an explicit true is one.
            typeof item?.historicalBaseline === "boolean" ? item.historicalBaseline : null,
            jsonb(item?.detail),
          ],
        );
        ids.push(id);
        if (accepted) verifiedIds.push(id);
      }
      await this.audit({
        client: handle, studyId, userId, actor: "system", action: "vcr.evidence.extract",
        object: precedentId ?? "", outcome: refused ? "partial" : "ok",
        detail: { written: rows.length, verified: rows.length - refused, refused },
      });
      return { written: rows.length, verified: rows.length - refused, refused, ids, verifiedIds };
    };
    return client ? run(client) : this.transaction(run);
  }

  /**
   * @param {{ userId: string, studyId?: string | null, precedentId?: string | null,
   *   parameter?: string | null, verifiedOnly?: boolean, latestOnly?: boolean, limit?: number }} query
   *   `latestOnly` keeps one row per `(precedent, parameter, arm, endpoint key)`: the newest.
   */
  async listEvidenceItems({ userId, studyId = null, precedentId = null, parameter = null, verifiedOnly = false, latestOnly = false, limit = 500 }) {
    /** @type {unknown[]} */
    const values = [userId];
    const where = ["user_id = $1"];
    if (studyId) { values.push(studyId); where.push(`study_id = $${values.length}`); }
    if (precedentId) { values.push(precedentId); where.push(`precedent_id = $${values.length}`); }
    if (parameter) { values.push(parameter); where.push(`parameter = $${values.length}`); }
    const verified = "value IS NOT NULL AND locator->>'verification' = 'verified'";
    values.push(Math.max(1, Math.min(2_000, Math.floor(limit))));
    if (latestOnly) {
      // The newest attempt at each thing, verified or not: a newer refusal
      // of the platform's own re-reading supersedes an older success, because
      // the newer text is what was read. A hand-entered value that failed its
      // check is not a re-reading of anything — it is a run's attempt to type a
      // number — so it never supersedes what was verified for the same
      // precedent, arm and endpoint; it is the newest only when nothing else
      // exists. Only then is the verified filter applied.
      const failedHandEntry = `COALESCE(locator->>'authoredBy' = 'run' AND (value IS NULL OR locator->>'verification' IS DISTINCT FROM 'verified'), false)`;
      return this.rows(
        `SELECT * FROM (
           SELECT DISTINCT ON (precedent_id, parameter, arm, endpoint_key) *
             FROM ${VCR_SCHEMA}.evidence_items WHERE ${where.join(" AND ")}
            ORDER BY precedent_id, parameter, arm, endpoint_key, ${failedHandEntry} ASC, created_at DESC, id DESC
         ) latest ${verifiedOnly ? `WHERE ${verified}` : ""} ORDER BY created_at ASC, id LIMIT $${values.length}`,
        values,
      );
    }
    if (verifiedOnly) where.push(verified);
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.evidence_items WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC, id LIMIT $${values.length}`,
      values,
    );
  }

  /**
   * The ids a card may cite: verified, with a number. The only reader an
   * assumption card is allowed to build from (AC-25).
   * @param {{ userId: string, studyId: string, parameter: string }} query
   */
  async verifiedEvidenceIds({ userId, studyId, parameter }) {
    const rows = await this.rows(
      `SELECT id FROM ${VCR_SCHEMA}.evidence_items
       WHERE user_id = $1 AND study_id = $2 AND parameter = $3
         AND value IS NOT NULL AND locator->>'verification' = 'verified'
       ORDER BY created_at ASC, id`,
      [userId, studyId, parameter],
    );
    return rows.map((row) => String(row.id));
  }

  /**
   * The verified rows of some ids, for the study — an id of another study, or
   * one that failed its check, is simply absent.
   * @param {{ userId: string, studyId: string, ids: readonly string[] }} query
   */
  async verifiedItemsById({ userId, studyId, ids }) {
    const wanted = [...new Set((ids ?? []).map(String))];
    if (!wanted.length) return [];
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.evidence_items
        WHERE user_id = $1 AND study_id = $2 AND id = ANY($3::text[])
          AND value IS NOT NULL AND locator->>'verification' = 'verified'`,
      [userId, studyId, wanted]);
  }

  /** Per-parameter counts for the 「数据与证据」 page: how much is verified, how much refused. @param {{ userId: string, studyId: string }} query */
  async evidenceCoverage({ userId, studyId }) {
    return this.rows(
      `SELECT parameter,
              COUNT(*)::int AS extracted,
              COUNT(*) FILTER (WHERE value IS NOT NULL AND locator->>'verification' = 'verified')::int AS verified,
              COUNT(*) FILTER (WHERE locator->>'verification' <> 'verified')::int AS refused,
              COUNT(DISTINCT precedent_id)::int AS precedents
       FROM ${VCR_SCHEMA}.evidence_items
       WHERE user_id = $1 AND study_id = $2
       GROUP BY parameter ORDER BY parameter`,
      [userId, studyId],
    );
  }

  // -------------------------------------------------------------------------
  // Assumption cards
  // -------------------------------------------------------------------------

  /**
   * A new version of one assumption card. The version is allocated inside the
   * writing transaction under an advisory lock on the card, so two saves of the
   * same card serialize instead of colliding on the unique index (E-11);
   * `review_state` starts at `ai_set` and only a review moves it (plan §10.2).
   * @param {{ userId: string, studyId: string, card: any, client?: any }} input
   */
  async saveAssumption({ userId, studyId, card, client = null }) {
    const run = async (/** @type {any} */ handle) => {
      const key = String(card?.key ?? "");
      await handle.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-assumption:${studyId}:${key}`]);
      const version = await this.nextVersion(handle, "assumptions", "study_id = $1 AND key = $2", [studyId, key]);
      const result = await handle.query(
        `INSERT INTO ${VCR_SCHEMA}.assumptions
           (id, study_id, user_id, key, version, name, endpoint, unit, point_value, distribution, sensitivity,
            source_kind, value_source, pooling_method, pooling, evidence_ids, applicability, review_state, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18, $19)
         RETURNING *`,
        [
          vcrId("assumption"), studyId, userId, key, version,
          String(card?.name ?? ""), card?.endpoint ?? null, String(card?.unit ?? ""),
          numeric(card?.pointValue), jsonb(card?.distribution), jsonb(card?.sensitivity),
          String(card?.sourceKind ?? "expert_set"), String(card?.valueSource ?? "assumed"),
          card?.poolingMethod ?? null, jsonb(card?.pooling),
          [...(card?.evidenceIds ?? [])].map(String), jsonb(card?.applicability),
          String(card?.reviewState ?? "ai_set"), String(card?.note ?? ""),
        ],
      );
      await this.audit({
        client: handle, studyId, userId, actor: "system", action: "vcr.assumption.save",
        object: `${card?.key ?? ""}@${version}`,
        detail: {
          sourceKind: card?.sourceKind ?? null, poolingMethod: card?.poolingMethod ?? null,
          evidenceCount: (card?.evidenceIds ?? []).length,
        },
      });
      return result.rows[0] ?? null;
    };
    return client ? run(client) : this.transaction(run);
  }

  /** Every version of one card, newest first. @param {{ studyId: string, key: string }} query */
  async assumptionHistory({ studyId, key }) {
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.assumptions WHERE study_id = $1 AND key = $2 ORDER BY version DESC`,
      [studyId, key],
    );
  }

  /** The current card for every key of a study. @param {{ studyId: string }} query */
  async latestAssumptions({ studyId }) {
    return this.rows(
      `SELECT DISTINCT ON (key) * FROM ${VCR_SCHEMA}.assumptions
       WHERE study_id = $1 ORDER BY key, version DESC`,
      [studyId],
    );
  }

  /** @param {{ studyId: string, key: string }} query */
  async latestAssumption({ studyId, key }) {
    return this.one(
      `SELECT * FROM ${VCR_SCHEMA}.assumptions WHERE study_id = $1 AND key = $2 ORDER BY version DESC LIMIT 1`,
      [studyId, key],
    );
  }

  /**
   * The extracted values one card version was built from, in the order it
   * named them. A card whose evidence rows were removed reads as fewer rows,
   * never as a different card.
   * @param {{ userId: string, assumption: any }} query
   */
  async assumptionEvidence({ userId, assumption }) {
    const ids = [...(assumption?.evidence_ids ?? assumption?.evidenceIds ?? [])].map(String);
    if (!ids.length) return [];
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.evidence_items WHERE user_id = $1 AND id = ANY($2::text[])
       ORDER BY array_position($2::text[], id)`,
      [userId, ids],
    );
  }
}

/** @param {{ database: any, statementTimeoutMs?: number }} options */
export function createVcrEvidenceStore(options) {
  return new VcrEvidenceStore(options);
}
