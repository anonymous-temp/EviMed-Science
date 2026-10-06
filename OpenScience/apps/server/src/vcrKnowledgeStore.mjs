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

/** Ids of this package's own objects. @param {"pack" | "definition" | "definitionVersion" | "promotion"} kind */
export function vcrKnowledgeId(kind) {
  const prefix = { pack: "pkg", definition: "dfn", definitionVersion: "dfv", promotion: "ppr" }[kind];
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

/**
 * What the platform records beside a platform pack, as a page and a zone read it: the author by the name they allow, the date, the
 * version the copy came from, the official zone and the 「来源有变更」 label. The author's account id never leaves.
 * @param {any} row a `platform_packs` row, or its JSON
 */
export function platformOf(row) {
  if (!row) return null;
  return {
    packId: String(row.pack_id), diseaseKey: String(row.disease_key), version: Number(row.version),
    author: { name: String(row.author_name ?? ""), at: iso(row.authored_at), sourceVersion: Number(row.source_version) },
    zoneId: text(row.zone_id), entityKeys: Array.isArray(row.entity_keys) ? row.entity_keys.map(String) : [],
    state: String(row.state), retiredAt: iso(row.retired_at),
    sourceChanged: row.source_changed_at ? { at: iso(row.source_changed_at), sources: Array.isArray(row.source_changes) ? row.source_changes : [] } : null,
    promotedAt: iso(row.promoted_at),
    // Held back from every reader: who the author is, as an account.
    authorUserId: String(row.author_user_id ?? ""),
  };
}

/** @param {any} row */
function promotionFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), userId: String(row.user_id), packId: String(row.pack_id), packVersion: Number(row.pack_version), requestedBy: String(row.requested_by),
    state: String(row.state), failing: Array.isArray(row.failing) ? row.failing : [], checked: row.checked ?? {},
    platformPackId: text(row.platform_pack_id), createdAt: iso(row.created_at),
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

  /** The account's own pack, or null — never a platform one: promotion and drafting act on the account's rows only. @param {string} userId @param {string} id */
  async getPack(userId, id) {
    return packFromRow(await this.one(`SELECT * FROM ${VCR_SCHEMA}.knowledge_packs WHERE id = $1 AND user_id = $2`, [id, userId]));
  }

  /**
   * A pack the account may read: its own, or a platform version that is live or that one of its studies pinned (a retired version
   * is gone for new studies and stays what it was for the studies that chose it). Carries what the platform records beside it.
   * @param {string} userId @param {string} id @param {{ platformPacks?: boolean, forBinding?: boolean }} [options] `platformPacks` off, no
   *   platform row is read at all; `forBinding` asks for a pack a study is about to be bound to, which a retired version never is
   */
  async getReadablePack(userId, id, { platformPacks = false, forBinding = false } = {}) {
    const own = await this.getPack(userId, id);
    if (own || !platformPacks) return own;
    const row = await this.one(
      `SELECT p.*, to_jsonb(pp.*) AS platform FROM ${VCR_SCHEMA}.knowledge_packs p JOIN ${VCR_SCHEMA}.platform_packs pp ON pp.pack_id = p.id
        WHERE p.id = $1 AND (pp.state = 'live' OR (NOT $3::boolean AND EXISTS (
          SELECT 1 FROM ${VCR_SCHEMA}.study_packs b WHERE b.origin = 'stored' AND b.pack_id = p.id AND b.user_id = $2)))`, [id, userId, forBinding]);
    return row ? { ...packFromRow(row), platform: platformOf(row.platform) } : null;
  }

  /**
   * The account's packs, newest first: every curated one, and the drafts that
   * are still bound to a study of the account — and, with platform packs on,
   * the live platform versions (the newest of each disease), except for a disease
   * the account has a pack of its own for: its own wins for it.
   * @param {string} userId @param {{ platformPacks?: boolean }} [options]
   */
  async listPacks(userId, { platformPacks = false } = {}) {
    const rows = await this.rows(
      `SELECT p.* FROM ${VCR_SCHEMA}.knowledge_packs p
        WHERE p.user_id = $1 AND (p.status = 'curated' OR EXISTS (
          SELECT 1 FROM ${VCR_SCHEMA}.study_packs b WHERE b.origin = 'stored' AND b.pack_id = p.id AND b.user_id = $1))
        ORDER BY p.created_at DESC LIMIT 200`, [userId]);
    const own = rows.map(packFromRow);
    if (!platformPacks) return own;
    const ownDiseases = new Set(own.map((pack) => pack?.diseaseKey));
    const platform = await this.rows(
      `SELECT DISTINCT ON (pp.disease_key) p.*, to_jsonb(pp.*) AS platform FROM ${VCR_SCHEMA}.platform_packs pp
         JOIN ${VCR_SCHEMA}.knowledge_packs p ON p.id = pp.pack_id
        WHERE pp.state = 'live' ORDER BY pp.disease_key, pp.version DESC`);
    return [...own, ...platform.filter((row) => !ownDiseases.has(String(row.disease_key)))
      .map((row) => ({ ...packFromRow(row), platform: platformOf(row.platform) }))];
  }

  /**
   * Every live platform pack whose disease shares an entity key with `keys`, newest version of each disease: what a zone page links.
   * @param {readonly string[]} keys
   */
  async platformPacksForKeys(keys) {
    const wanted = [...new Set(keys.map(String).filter(Boolean))].slice(0, 64);
    if (!wanted.length) return [];
    const rows = await this.rows(
      `SELECT DISTINCT ON (pp.disease_key) p.*, to_jsonb(pp.*) AS platform FROM ${VCR_SCHEMA}.platform_packs pp
         JOIN ${VCR_SCHEMA}.knowledge_packs p ON p.id = pp.pack_id
        WHERE pp.state = 'live' AND pp.entity_keys && $1::text[] ORDER BY pp.disease_key, pp.version DESC`, [wanted]);
    return rows.map((row) => ({ ...packFromRow(row), platform: platformOf(row.platform) }));
  }

  /**
   * Copy a curated pack of an account as the platform's next version of its disease, in one transaction: a row of the publisher
   * account (immutable from here on) and the record of whose it was. The version is the platform's own, per disease.
   * @param {{ publisherId: string, source: NonNullable<ReturnType<typeof packFromRow>>, authorName: string, entityKeys: readonly string[],
   *   zoneId: string | null, recheck: Record<string, any>, actor: string }} input
   */
  async promoteToPlatform({ publisherId, source, authorName, entityKeys, zoneId, recheck, actor }) {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-vcr-platform-pack:${source.diseaseKey}`]);
      const version = await this.nextVersion(client, "knowledge_packs", "user_id = $1 AND disease_key = $2", [publisherId, source.diseaseKey]);
      const id = vcrKnowledgeId("pack");
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.knowledge_packs (id, user_id, study_id, disease_key, version, status, body, reviewed_by, reviewed_at)
         VALUES ($1, $2, NULL, $3, $4, 'curated', $5::jsonb, 'platform', now()) RETURNING *`,
        [id, publisherId, source.diseaseKey, version, jsonb({ ...source.body, version, status: "curated" })])).rows[0];
      const platform = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.platform_packs (pack_id, disease_key, version, source_pack_id, source_version, author_user_id, author_name, authored_at,
           entity_keys, zone_id, recheck)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::jsonb) RETURNING *`,
        [id, source.diseaseKey, version, source.id, source.version, source.userId, authorName, source.reviewedAt ?? source.createdAt,
          [...entityKeys], zoneId, jsonb(recheck)])).rows[0];
      await this.audit({ client, userId: source.userId, actor, action: "vcr.pack.platform", object: id,
        detail: { diseaseKey: source.diseaseKey, version, sourcePackId: source.id, sourceVersion: source.version } });
      return { ...packFromRow(row), platform: platformOf(platform) };
    });
  }

  /**
   * The record of one request to promote: what the re-check said.
   * @param {{ id: string, userId: string, packId: string, packVersion: number, requestedBy: string, state: "passed" | "failed",
   *   failing: readonly any[], checked: Record<string, any>, platformPackId?: string | null }} input
   */
  async recordPromotion({ id, userId, packId, packVersion, requestedBy, state, failing, checked, platformPackId = null }) {
    const row = await this.one(
      `INSERT INTO ${VCR_SCHEMA}.pack_promotions (id, user_id, pack_id, pack_version, requested_by, state, failing, checked, platform_pack_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) RETURNING *`,
      [id, userId, packId, packVersion, requestedBy, state, jsonb(failing), jsonb(checked), platformPackId]);
    return promotionFromRow(row);
  }

  /** The latest re-check of one of the account's packs, or null. @param {string} userId @param {string} packId */
  async latestPromotion(userId, packId) {
    return promotionFromRow(await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.pack_promotions WHERE user_id = $1 AND pack_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [userId, packId]));
  }

  /** The platform version made from an account pack version that is still offered, or null. @param {string} userId @param {string} packId @param {number} version */
  async livePlatformCopyOf(userId, packId, version) {
    return this.one(`SELECT pack_id FROM ${VCR_SCHEMA}.platform_packs WHERE author_user_id = $1 AND source_pack_id = $2 AND source_version = $3 AND state = 'live'`,
      [userId, packId, version]);
  }

  /**
   * The author takes their name off a platform pack: it is retired for new studies and its attribution is blanked. The studies that
   * pinned the version keep reading it.
   * @param {{ userId: string, platformPackId: string, reason: string }} input
   */
  async retirePlatformPack({ userId, platformPackId, reason }) {
    return this.transaction(async (client) => {
      const row = (await client.query(
        `UPDATE ${VCR_SCHEMA}.platform_packs SET state = 'retired', retired_at = now(), retired_reason = $3, author_name = ''
          WHERE pack_id = $1 AND author_user_id = $2 AND state = 'live' RETURNING *`, [platformPackId, userId, reason])).rows[0];
      if (row) await this.audit({ client, userId, actor: userId, action: "vcr.pack.platform_retire", object: platformPackId, detail: { reason } });
      return row ? platformOf(row) : null;
    });
  }

  /** Live platform packs, oldest check first, for the source watch. @param {number} limit */
  async platformPacksToCheck(limit) {
    return (await this.rows(
      `SELECT p.*, to_jsonb(pp.*) AS platform FROM ${VCR_SCHEMA}.platform_packs pp JOIN ${VCR_SCHEMA}.knowledge_packs p ON p.id = pp.pack_id
        WHERE pp.state = 'live' ORDER BY coalesce((pp.recheck->>'watchedAt')::timestamptz, 'epoch') LIMIT $1`, [limit]))
      .map((row) => ({ ...packFromRow(row), platform: platformOf(row.platform) }));
  }

  /**
   * Label a platform pack 「来源有变更」, or clear the label when what is known no longer says so. Never rewrites the pack.
   * @param {{ platformPackId: string, changes: readonly any[], watchedAt: string }} input
   */
  async markSourceChanges({ platformPackId, changes, watchedAt }) {
    const row = await this.one(
      `UPDATE ${VCR_SCHEMA}.platform_packs SET source_changes = $2::jsonb,
          source_changed_at = CASE WHEN $3::boolean THEN coalesce(source_changed_at, now()) ELSE NULL END,
          recheck = recheck || jsonb_build_object('watchedAt', $4::text)
        WHERE pack_id = $1 AND state = 'live' RETURNING *`, [platformPackId, jsonb(changes), changes.length > 0, watchedAt]);
    return row ? platformOf(row) : null;
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
