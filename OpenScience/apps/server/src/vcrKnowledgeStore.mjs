/**
 * The knowledge side of `evimed_vcr`: the packs that are rows (an AI draft, a
 * reviewed and promoted one), which pack a study works from, and the account's
 * library of population definitions with its versions and its uses (plan
 * 2026-09-28 §3.3, §5.1).
 *
 * Hidden knowledge:
 *
 * - **Everything here is the account's, and the predicate says so.** Every read
 *   and write names `user_id`; a definition or a pack of another account answers
 *   `null`, never a row the caller then has to hide. Study membership is
 *   `vcrAccess.mjs`'s decision and happens before a call reaches this store; the
 *   library is read by the *account*, not by the study — the same rule the
 *   precedent library keeps — so a member who is not the owner uses the owner's
 *   library through the study only, as the owner's study and the owner's account
 *   (the service resolves `study.userId`).
 * - **A version is a new row, never an edit.** A definition's version holds the
 *   rules as the cohort job reads them, the plain-language text and the pack
 *   entries it rests on; saving a change writes the next one, allocated under
 *   the definition's row lock, and the earlier ones stay what they were — a
 *   study that used version 2 used version 2.
 * - **A use is a study.** `definition_uses` is one row per (definition, version,
 *   study), and the count a library shows is the number of distinct studies that
 *   used any version: the study a definition was saved from is the first, a
 *   second study that reuses it is the second, and reusing it again in the same
 *   study changes nothing. Uses go with the study; the definition does not.
 * - **A shipped pack is not a row.** `study_packs` names it by its id, and the
 *   version bound is the version that was current when the study bound it.
 *
 * @module vcrKnowledgeStore
 */

import { randomUUID } from "node:crypto";

import { VCR_COMPARISON_RESULT_KIND, VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase } from "./vcrStoreBase.mjs";

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);
/** @param {unknown} value */
const jsonb = (value) => JSON.stringify(value ?? null);

/** Ids of this package's own objects. @param {"pack" | "definition" | "definitionVersion"} kind */
export function vcrKnowledgeId(kind) {
  const prefix = { pack: "pkg", definition: "dfn", definitionVersion: "dfv" }[kind];
  if (!prefix) throw new TypeError(`vcrKnowledgeId: unknown kind ${JSON.stringify(kind)}`);
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

/** @param {any} row */
export function packFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), userId: String(row.user_id), studyId: text(row.study_id), diseaseKey: String(row.disease_key),
    version: Number(row.version), status: String(row.status), body: row.body ?? {},
    reviewedBy: text(row.reviewed_by), reviewedAt: iso(row.reviewed_at), createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
function bindingFromRow(row) {
  if (!row) return null;
  return {
    studyId: String(row.study_id), userId: String(row.user_id), origin: String(row.origin), packId: String(row.pack_id),
    packVersion: Number(row.pack_version), boundBy: String(row.bound_by ?? ""), boundAt: iso(row.bound_at),
  };
}

/** @param {any} row */
function versionFromRow(row) {
  return {
    id: String(row.id), definitionId: String(row.definition_id), version: Number(row.version), text: String(row.text ?? ""),
    body: row.body ?? {}, packRefs: Array.isArray(row.pack_refs) ? row.pack_refs : [], sourceStudyId: text(row.source_study_id),
    createdBy: String(row.created_by ?? ""), createdAt: iso(row.created_at),
  };
}

export class VcrKnowledgeStore extends VcrStoreBase {
  // --- packs that are rows -------------------------------------------------------

  /**
   * Write a pack as the next version of its disease for the account.
   * @param {{ userId: string, studyId?: string | null, diseaseKey: string, status: string, body: Record<string, any>, actor?: string }} input
   */
  async savePack({ userId, studyId = null, diseaseKey, status, body, actor = "" }) {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-vcr-pack:${userId}:${diseaseKey}`]);
      const version = await this.nextVersion(client, "knowledge_packs", "user_id = $1 AND disease_key = $2", [userId, diseaseKey]);
      const id = vcrKnowledgeId("pack");
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.knowledge_packs (id, user_id, study_id, disease_key, version, status, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
        [id, userId, studyId, diseaseKey, version, status, jsonb({ ...body, version, status }) ?? "{}"])).rows[0];
      await this.audit({ client, studyId, userId, actor: actor || userId, action: "vcr.pack.save", object: id, detail: { diseaseKey, version, status } });
      return packFromRow(row);
    });
  }

  /** The account's pack, or null. @param {string} userId @param {string} id */
  async getPack(userId, id) {
    return packFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.knowledge_packs WHERE id = $1 AND user_id = $2`, [id, userId]));
  }

  /**
   * The account's packs, newest first: every curated one, and the drafts that
   * are still bound to a study of the account.
   * @param {string} userId
   */
  async listPacks(userId) {
    const rows = await this.rows(
      `SELECT p.* FROM ${VCR_SCHEMA}.knowledge_packs p
        WHERE p.user_id = $1 AND (p.status = 'curated' OR EXISTS (
          SELECT 1 FROM ${VCR_SCHEMA}.study_packs b WHERE b.origin = 'stored' AND b.pack_id = p.id AND b.user_id = $1))
        ORDER BY p.created_at DESC LIMIT 200`, [userId]);
    return rows.map(packFromRow);
  }

  /**
   * Promote a draft: the same row, `curated`, with who reviewed it and when.
   * @param {{ userId: string, id: string, reviewer: string }} input
   */
  async promotePack({ userId, id, reviewer }) {
    return this.transaction(async (client) => {
      const row = (await client.query(
        `UPDATE ${VCR_SCHEMA}.knowledge_packs
            SET status = 'curated', reviewed_by = $3, reviewed_at = now(),
                body = jsonb_set(body, '{status}', '"curated"'::jsonb)
          WHERE id = $1 AND user_id = $2 AND status = 'ai-draft' RETURNING *`, [id, userId, reviewer])).rows[0];
      if (row) await this.audit({ client, studyId: row.study_id ?? null, userId, actor: reviewer, action: "vcr.pack.promote", object: id,
        detail: { diseaseKey: row.disease_key, version: Number(row.version) } });
      return packFromRow(row);
    });
  }

  // --- which pack a study works from -----------------------------------------------

  /** @param {string} studyId */
  async studyBinding(studyId) {
    return bindingFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.study_packs WHERE study_id = $1`, [studyId]));
  }

  /**
   * Point a study at a pack (replacing what it pointed at).
   * @param {{ studyId: string, userId: string, origin: "shipped" | "stored", packId: string, packVersion: number, actor?: string }} input
   */
  async bindStudy({ studyId, userId, origin, packId, packVersion, actor = "" }) {
    return this.transaction(async (client) => {
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.study_packs (study_id, user_id, origin, pack_id, pack_version, bound_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (study_id) DO UPDATE SET origin = EXCLUDED.origin, pack_id = EXCLUDED.pack_id,
           pack_version = EXCLUDED.pack_version, bound_by = EXCLUDED.bound_by, bound_at = now()
         RETURNING *`, [studyId, userId, origin, packId, packVersion, actor || userId])).rows[0];
      await this.audit({ client, studyId, userId, actor: actor || userId, action: "vcr.pack.bind", object: packId, detail: { origin, packVersion } });
      return bindingFromRow(row);
    });
  }

  // --- the definition library -------------------------------------------------------

  /**
   * Save a definition as a new library entry (no `definitionId`) or as the next
   * version of one of the account's own. The study it was saved from is its
   * first use.
   * @param {{ userId: string, definitionId?: string | null, name?: string, text: string, body: Record<string, any>,
   *   packRefs?: unknown[], studyId?: string | null, populationId?: string | null, actor?: string }} input
   * @returns {Promise<{ definition: { id: string, name: string }, version: ReturnType<typeof versionFromRow> } | null>} null when the definition is not the account's
   */
  async saveDefinitionVersion({ userId, definitionId = null, name = "", text: description, body, packRefs = [], studyId = null, populationId = null, actor = "" }) {
    return this.transaction(async (client) => {
      /** @type {any} */
      let definition;
      if (definitionId) {
        definition = (await client.query(
          `SELECT * FROM ${VCR_SCHEMA}.definitions WHERE id = $1 AND user_id = $2 FOR UPDATE`, [definitionId, userId])).rows[0];
        if (!definition) return null;
        if (name && name !== definition.name) {
          await client.query(`UPDATE ${VCR_SCHEMA}.definitions SET name = $2, updated_at = now() WHERE id = $1`, [definitionId, name]);
          definition.name = name;
        } else await client.query(`UPDATE ${VCR_SCHEMA}.definitions SET updated_at = now() WHERE id = $1`, [definitionId]);
      } else {
        definition = (await client.query(
          `INSERT INTO ${VCR_SCHEMA}.definitions (id, user_id, name) VALUES ($1, $2, $3) RETURNING *`,
          [vcrKnowledgeId("definition"), userId, name])).rows[0];
      }
      const version = await this.nextVersion(client, "definition_versions", "definition_id = $1", [definition.id]);
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.definition_versions (id, definition_id, user_id, version, text, body, pack_refs, source_study_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
        [vcrKnowledgeId("definitionVersion"), definition.id, userId, version, description, jsonb(body), jsonb(packRefs), studyId, actor || userId])).rows[0];
      if (studyId) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.definition_uses (definition_id, version, study_id, user_id, population_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (definition_id, version, study_id) DO NOTHING`,
          [definition.id, version, studyId, userId, populationId]);
      }
      await this.audit({ client, studyId, userId, actor: actor || userId, action: "vcr.definition.save", object: String(definition.id), detail: { version } });
      return { definition: { id: String(definition.id), name: String(definition.name) }, version: versionFromRow(row) };
    });
  }

  /**
   * Record that a study used a version of the account's definition. Answers the
   * version, or null when the account has no such version.
   * @param {{ userId: string, definitionId: string, version: number, studyId: string, populationId?: string | null, actor?: string }} input
   */
  async recordDefinitionUse({ userId, definitionId, version, studyId, populationId = null, actor = "" }) {
    return this.transaction(async (client) => {
      const found = (await client.query(
        `SELECT v.* FROM ${VCR_SCHEMA}.definition_versions v
          WHERE v.definition_id = $1 AND v.version = $2 AND v.user_id = $3`, [definitionId, version, userId])).rows[0];
      if (!found) return null;
      await client.query(
        `INSERT INTO ${VCR_SCHEMA}.definition_uses (definition_id, version, study_id, user_id, population_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (definition_id, version, study_id) DO UPDATE SET population_id = COALESCE(EXCLUDED.population_id, ${VCR_SCHEMA}.definition_uses.population_id)`,
        [definitionId, version, studyId, userId, populationId]);
      await client.query(`UPDATE ${VCR_SCHEMA}.definitions SET updated_at = now() WHERE id = $1`, [definitionId]);
      await this.audit({ client, studyId, userId, actor: actor || userId, action: "vcr.definition.use", object: definitionId, detail: { version } });
      return versionFromRow(found);
    });
  }

  /**
   * The account's library: each definition with its latest version, how many
   * versions it has and how many studies have used it.
   * @param {string} userId
   */
  async listDefinitions(userId) {
    const rows = await this.rows(
      `SELECT d.id, d.name, d.created_at, d.updated_at,
              (SELECT count(*) FROM ${VCR_SCHEMA}.definition_versions v WHERE v.definition_id = d.id)::integer AS versions,
              (SELECT count(DISTINCT u.study_id) FROM ${VCR_SCHEMA}.definition_uses u WHERE u.definition_id = d.id)::integer AS uses
         FROM ${VCR_SCHEMA}.definitions d WHERE d.user_id = $1 ORDER BY d.updated_at DESC LIMIT 200`, [userId]);
    if (!rows.length) return [];
    const latest = await this.rows(
      `SELECT DISTINCT ON (definition_id) * FROM ${VCR_SCHEMA}.definition_versions
        WHERE definition_id = ANY($1::text[]) ORDER BY definition_id, version DESC`, [rows.map((row) => String(row.id))]);
    const byId = new Map(latest.map((row) => [String(row.definition_id), versionFromRow(row)]));
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), versions: Number(row.versions), uses: Number(row.uses),
      latest: byId.get(String(row.id)) ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    }));
  }

  /**
   * One of the account's definitions with every version and, for each version,
   * the studies that used it (their names, as the account owns them).
   * @param {string} userId @param {string} id
   */
  async getDefinition(userId, id) {
    const definition = await this.one(`SELECT * FROM ${VCR_SCHEMA}.definitions WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!definition) return null;
    const versions = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.definition_versions WHERE definition_id = $1 ORDER BY version DESC`, [id]);
    const uses = await this.rows(
      `SELECT u.version, u.study_id, s.name AS study_name, u.created_at
         FROM ${VCR_SCHEMA}.definition_uses u LEFT JOIN ${VCR_SCHEMA}.studies s ON s.id = u.study_id
        WHERE u.definition_id = $1 ORDER BY u.created_at`, [id]);
    return {
      id: String(definition.id), name: String(definition.name), createdAt: iso(definition.created_at), updatedAt: iso(definition.updated_at),
      versions: versions.map(versionFromRow),
      uses: uses.map((row) => ({ version: Number(row.version), studyId: String(row.study_id), studyName: String(row.study_name ?? ""), at: iso(row.created_at) })),
      studyCount: new Set(uses.map((row) => String(row.study_id))).size,
    };
  }

  /**
   * One version of one of the account's definitions, or null.
   * @param {string} userId @param {string} definitionId @param {number} version
   */
  async getDefinitionVersion(userId, definitionId, version) {
    const row = await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.definition_versions WHERE definition_id = $1 AND version = $2 AND user_id = $3`, [definitionId, version, userId]);
    return row ? versionFromRow(row) : null;
  }

  /**
   * The definitions a study used, with the version, the library name and the
   * pack entries they rest on — what the study page shows.
   * @param {string} studyId @param {string} userId
   */
  async definitionsUsedBy(studyId, userId) {
    const rows = await this.rows(
      `SELECT u.definition_id, u.version, u.population_id, u.created_at, d.name, v.text, v.pack_refs,
              (SELECT count(*) FROM ${VCR_SCHEMA}.definition_versions x WHERE x.definition_id = u.definition_id)::integer AS versions,
              (SELECT count(DISTINCT y.study_id) FROM ${VCR_SCHEMA}.definition_uses y WHERE y.definition_id = u.definition_id)::integer AS uses
         FROM ${VCR_SCHEMA}.definition_uses u
         JOIN ${VCR_SCHEMA}.definitions d ON d.id = u.definition_id AND d.user_id = $2
         JOIN ${VCR_SCHEMA}.definition_versions v ON v.definition_id = u.definition_id AND v.version = u.version
        WHERE u.study_id = $1 ORDER BY u.created_at`, [studyId, userId]);
    return rows.map((row) => ({
      definitionId: String(row.definition_id), version: Number(row.version), populationId: text(row.population_id), name: String(row.name),
      text: String(row.text ?? ""), packRefs: Array.isArray(row.pack_refs) ? row.pack_refs : [], versions: Number(row.versions),
      uses: Number(row.uses), usedAt: iso(row.created_at),
    }));
  }

  /**
   * The finished comparisons of a study (`definition_comparison` results), newest first.
   * @param {string} studyId
   */
  async comparisonResults(studyId) {
    return (await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.results WHERE study_id = $1 AND kind = $2 AND superseded_by IS NULL
        ORDER BY created_at DESC LIMIT 50`, [studyId, VCR_COMPARISON_RESULT_KIND])).map((row) => ({
      id: String(row.id), subjectId: text(row.subject_id), version: Number(row.version), conclusion: text(row.conclusion),
      counts: row.counts ?? {}, measures: row.measures ?? [], diagnostics: row.diagnostics ?? {}, createdAt: iso(row.created_at),
    }));
  }
}
