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
 *   (plan §6.4). `study_id` is the link that says which study pulled it in,
 *   and re-fetching the same registry record from a second study updates the
 *   one row instead of forking the library.
 * - **An extracted value is append-only.** `evidence_items` is never updated:
 *   a re-extraction writes new rows and the assumption card names the ids it
 *   used, so a card built last week still points at the bytes it was built
 *   from. That is what makes AC-25 answerable after the fact.
 * - **A value that failed its quote check is stored, not dropped.** It lands
 *   with `value = NULL`, `value_text = 'unknown'` and
 *   `locator.verification = 'quote_not_found'`. Dropping it would leave no
 *   record that the number was attempted and refused, and the next run would
 *   attempt it again with nothing to learn from. `verifiedEvidenceIds` is the
 *   only reader a card is allowed to use.
 * - **Versions are allocated under the row lock**, by `VcrStoreBase`'s
 *   `nextVersion` inside the writing transaction: two dispatches saving
 *   「脱落率 v4」 at once would otherwise both compute 4 and the unique index
 *   would fail the slower one after its work.
 * - **Reads are scoped by `user_id` in the predicate, always.** Membership is
 *   `vcrAccess.mjs`'s decision and it happens before a call reaches here; this
 *   store never widens a query to 「all studies」 for convenience, so a caller
 *   that forgot the check gets nothing rather than someone else's library.
 *
 * @module vcrEvidenceStore
 */

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** How a stored extraction reports its quote check. Written into `locator.verification`. */
export const EVIDENCE_VERIFICATION_STATES = Object.freeze(["verified", "quote_not_found", "source_unavailable", "no_quote"]);

/** @param {unknown} value */
const jsonb = (value) => JSON.stringify(value ?? {});
/** @param {unknown} value @returns {number | null} */
const numeric = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
/** @param {unknown} value @returns {number | null} */
const whole = (value) => {
  const parsed = numeric(value);
  return parsed === null ? null : Math.round(parsed);
};

export class VcrEvidenceStore extends VcrStoreBase {
  // -------------------------------------------------------------------------
  // Precedents
  // -------------------------------------------------------------------------

  /**
   * Write one precedent, keyed by the registry record it is. Returns the row.
   * @param {{ userId: string, studyId?: string | null, precedent: any, client?: any }} input
   */
  async savePrecedent({ userId, studyId = null, precedent, client = null }) {
    const run = async (/** @type {any} */ handle) => {
      const result = await handle.query(
        `INSERT INTO ${VCR_SCHEMA}.precedents
           (id, user_id, study_id, registry, registry_id, title, pico, design, enrollment, enrollment_kind,
            sites, eligibility_text, endpoints, results, sources, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16)
         ON CONFLICT (user_id, registry, registry_id) DO UPDATE SET
           study_id = COALESCE(EXCLUDED.study_id, ${VCR_SCHEMA}.precedents.study_id),
           title = EXCLUDED.title, pico = EXCLUDED.pico, design = EXCLUDED.design,
           enrollment = EXCLUDED.enrollment, enrollment_kind = EXCLUDED.enrollment_kind,
           sites = EXCLUDED.sites, eligibility_text = EXCLUDED.eligibility_text,
           endpoints = EXCLUDED.endpoints, results = EXCLUDED.results, sources = EXCLUDED.sources,
           fetched_at = EXCLUDED.fetched_at
         RETURNING *`,
        [
          vcrId("precedent"), userId, studyId,
          String(precedent?.registry ?? ""), String(precedent?.registryId ?? ""), String(precedent?.title ?? ""),
          jsonb(precedent?.pico), jsonb(precedent?.design), jsonb(precedent?.enrollment),
          precedent?.enrollmentKind ?? null, jsonb(precedent?.sites), String(precedent?.eligibilityText ?? ""),
          jsonb(precedent?.endpoints ?? []), jsonb(precedent?.results), jsonb(precedent?.sources ?? []),
          precedent?.fetchedAt ?? null,
        ],
      );
      await this.audit({
        client: handle, studyId, userId, actor: "system", action: "vcr.precedent.save",
        object: `${precedent?.registry ?? ""}:${precedent?.registryId ?? ""}`,
        detail: { hasResults: Boolean(precedent?.results?.hasResults), enrollmentKind: precedent?.enrollmentKind ?? null },
      });
      return result.rows[0] ?? null;
    };
    return client ? run(client) : this.transaction(run);
  }

  /**
   * The precedent library, newest first. `parameters` is not a filter here:
   * choosing which precedents may be pooled is a per-item judgment made after
   * the candidates are read (plan §6.4).
   * @param {{ userId: string, studyId?: string | null, registry?: string | null,
   *   hasResults?: boolean | null, search?: string, limit?: number, offset?: number }} query
   */
  async listPrecedents({ userId, studyId = null, registry = null, hasResults = null, search = "", limit = 50, offset = 0 }) {
    /** @type {unknown[]} */
    const values = [userId];
    const where = ["user_id = $1"];
    if (studyId) { values.push(studyId); where.push(`study_id = $${values.length}`); }
    if (registry) { values.push(registry); where.push(`registry = $${values.length}`); }
    if (hasResults !== null) { values.push(hasResults); where.push(`(results->>'hasResults')::boolean IS NOT DISTINCT FROM $${values.length}`); }
    if (String(search ?? "").trim()) {
      values.push(`%${String(search).trim()}%`);
      where.push(`(title ILIKE $${values.length} OR registry_id ILIKE $${values.length})`);
    }
    values.push(Math.max(1, Math.min(500, Math.floor(limit))), Math.max(0, Math.floor(offset)));
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.precedents WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
  }

  /** @param {string} userId @param {string} id */
  async getPrecedent(userId, id) {
    return this.one(`SELECT * FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1 AND id = $2`, [userId, id]);
  }

  /** @param {string} userId @param {string} registry @param {string} registryId */
  async findPrecedent(userId, registry, registryId) {
    return this.one(
      `SELECT * FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1 AND registry = $2 AND registry_id = $3`,
      [userId, registry, registryId],
    );
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
              sample_size, events, value_source, source_ref, quote, locator, applicability)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb)`,
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
   *   parameter?: string | null, verifiedOnly?: boolean, limit?: number }} query
   */
  async listEvidenceItems({ userId, studyId = null, precedentId = null, parameter = null, verifiedOnly = false, limit = 500 }) {
    /** @type {unknown[]} */
    const values = [userId];
    const where = ["user_id = $1"];
    if (studyId) { values.push(studyId); where.push(`study_id = $${values.length}`); }
    if (precedentId) { values.push(precedentId); where.push(`precedent_id = $${values.length}`); }
    if (parameter) { values.push(parameter); where.push(`parameter = $${values.length}`); }
    if (verifiedOnly) where.push("value IS NOT NULL AND locator->>'verification' = 'verified'");
    values.push(Math.max(1, Math.min(2_000, Math.floor(limit))));
    return this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.evidence_items WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC LIMIT $${values.length}`,
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
       ORDER BY created_at ASC`,
      [userId, studyId, parameter],
    );
    return rows.map((row) => String(row.id));
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
   * writing transaction; `review_state` starts at `ai_set` and only a review
   * moves it (plan §10.2).
   * @param {{ userId: string, studyId: string, card: any, client?: any }} input
   */
  async saveAssumption({ userId, studyId, card, client = null }) {
    const run = async (/** @type {any} */ handle) => {
      const version = await this.nextVersion(handle, "assumptions", "study_id = $1 AND key = $2", [studyId, String(card?.key ?? "")]);
      const result = await handle.query(
        `INSERT INTO ${VCR_SCHEMA}.assumptions
           (id, study_id, user_id, key, version, name, endpoint, unit, point_value, distribution, sensitivity,
            source_kind, value_source, pooling_method, pooling, evidence_ids, applicability, review_state, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18, $19)
         RETURNING *`,
        [
          vcrId("assumption"), studyId, userId, String(card?.key ?? ""), version,
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
