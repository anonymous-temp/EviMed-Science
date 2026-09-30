/**
 * 「虚拟临研」's data-plane and membership queries: sources, grants, snapshots,
 * field maps, analysis tables and study members (build plan 2026-09-28 §8.1,
 * §11.1 conclusion 4, §11.3).
 *
 * Hidden knowledge:
 *
 * - **Nothing here holds a patient row.** A snapshot row holds a location, a
 *   hash, row and column counts and a profile; the bytes live under
 *   `config.vcrDataPlaneDir`, outside this schema and outside every runtime
 *   mount (`vcrDataPlane.mjs` refuses a location that is not). A column added
 *   here that carried values would put them one join away from everything the
 *   model can already read, which is the whole reason the data plane exists.
 * - **Ownership is never `user_id` alone.** A study has members, so "may this
 *   account see this row" is `(studies.user_id = caller) OR member_of(study)`.
 *   That is why `studyForAccess` exists in this file even though the study row
 *   belongs to another package: a judgment that cannot read the owner cannot
 *   be made, and a second copy of the study table would be the thing that
 *   drifts. This file only ever reads `studies`; it never writes one.
 * - **A member holds roles, not a role.** The primary key is
 *   `(study_id, user_id, role)`, because the one person at a small site is the
 *   coordinator and the clinical reviewer, and folding that into a single
 *   strongest role silently grants the abilities of the other one.
 * - **A snapshot is frozen once.** `version` is allocated under the row lock
 *   (`nextVersion`), and there is no update path for `location`, `sha256`,
 *   `row_count` or `profile`: a correction is a new snapshot, which is what
 *   makes 「源数据已更正」 a lineage event rather than a silent rewrite of a
 *   number somebody already read (AC-16).
 * - **Sealing writes two timestamps, not one flag.** `sealed_until` says when
 *   the seal lifts and the audit row says when it was set and by whom; AC-32
 *   is decided by comparing the seal's timestamp with the analysis plan's, and
 *   a boolean cannot answer that question afterwards.
 * - **A revoked grant is kept.** `revoked_at` rather than `DELETE`, because
 *   the question a sponsor's validation asks is 「当时谁能读」, and a deleted
 *   row answers 「现在没人能读」 instead.
 *
 * @module vcrDataStore
 */

import { randomUUID } from "node:crypto";

import {
  VCR_ANALYSIS_TABLES, VCR_MEMBER_ROLES, VCR_MISSING_REASONS, VCR_SOURCE_FORMATS, VCR_TIME_KINDS, VCR_VALUE_SOURCES,
} from "@evimed/domain";

import { VCR_FIELD_MAP_STATES, VCR_FIELD_ROLES, VCR_SOURCE_FILE_ROLES } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

export { VCR_FIELD_MAP_STATES, VCR_FIELD_ROLES, VCR_SOURCE_FILE_ROLES };

/** A file's id: `sfl_` and 22 characters of a uuid, the same shape `vcrId` gives every other object. */
const sourceFileId = () => `sfl_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

/** A source's lifecycle, as the DDL's CHECK spells it. */
export const VCR_SOURCE_STATUSES = Object.freeze(["registered", "profiled", "frozen", "withdrawn"]);
/** How a grant reads its field list. */
export const VCR_GRANT_FIELD_MODES = Object.freeze(["allow", "deny"]);

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : null);
/** @param {unknown} value @returns {string[]} */
const words = (value) => (Array.isArray(value) ? value.map((entry) => String(entry)) : []);
/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {any} */ (value) : {});

/** A word that must belong to a closed vocabulary before it reaches SQL. @param {readonly string[]} vocabulary @param {unknown} value @param {string} what */
function oneOf(vocabulary, value, what) {
  const word = typeof value === "string" ? value.trim() : "";
  if (!vocabulary.includes(word)) {
    throw new TypeError(`${what} must be one of ${vocabulary.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return word;
}

/** A non-empty identifier the caller supplied. @param {unknown} value @param {string} what */
function required(value, what) {
  const word = typeof value === "string" ? value.trim() : "";
  if (!word) throw new TypeError(`${what} is required.`);
  return word;
}

/** @param {any} row */
export function vcrSourceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    studyId: text(row.study_id),
    name: row.name,
    ownerParty: row.owner_party ?? "",
    allowedUses: words(row.allowed_uses),
    visibleWindow: object(row.visible_window),
    retention: object(row.retention),
    format: row.format,
    status: row.status,
    valueSource: row.value_source ?? "observed",
    fieldMap: { columns: Array.isArray(object(row.field_map).columns) ? object(row.field_map).columns : [] },
    fieldMapState: row.field_map_state ?? "none",
    fieldMapHash: text(row.field_map_hash),
    fieldMapBy: row.field_map_by ?? "",
    fieldMapAt: iso(row.field_map_at),
    fieldMapConfirmedBy: text(row.field_map_confirmed_by),
    fieldMapConfirmedAt: iso(row.field_map_confirmed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
export function vcrSourceFileFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    studyId: text(row.study_id),
    userId: row.user_id,
    role: row.role,
    name: row.name,
    format: row.format,
    location: row.location,
    sha256: row.sha256,
    bytes: Number(row.bytes),
    rowCount: num(row.row_count),
    columnCount: num(row.column_count),
    profile: object(row.profile),
    detail: object(row.detail),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
export function vcrGrantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    studyId: text(row.study_id),
    userId: row.user_id,
    grantee: row.grantee,
    role: text(row.role),
    fields: words(row.fields),
    fieldMode: row.field_mode,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    purposes: words(row.purposes),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
export function vcrSnapshotFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    studyId: text(row.study_id),
    userId: row.user_id,
    version: Number(row.version),
    location: row.location,
    sha256: row.sha256,
    rowCount: num(row.row_count),
    columnCount: num(row.column_count),
    profile: object(row.profile),
    quality: object(row.quality),
    sealedFields: words(row.sealed_fields),
    sealedUntil: iso(row.sealed_until),
    fileHashes: Array.isArray(row.file_hashes) ? row.file_hashes : [],
    fieldMapHash: text(row.field_map_hash),
    valueSource: row.value_source ?? "observed",
    createdBy: row.created_by ?? "",
    frozenAt: iso(row.frozen_at),
  };
}

/** @param {any} row */
export function vcrFieldMapFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    userId: row.user_id,
    columnName: row.column_name,
    concept: row.concept ?? "",
    unit: text(row.unit),
    codingSystem: text(row.coding_system),
    timeKind: text(row.time_kind),
    missingReason: text(row.missing_reason),
    identifier: row.identifier === true,
    reviewState: row.review_state,
    tableName: row.table_name ?? "",
    role: row.role ?? "other",
    parameter: text(row.parameter),
    alias: text(row.alias),
    declaredType: text(row.declared_type),
    range: Array.isArray(row.value_range) ? row.value_range : null,
    required: row.required === true,
    outcome: row.outcome === true,
    codes: object(row.codes),
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
export function vcrAnalysisTableFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    studyId: row.study_id,
    userId: row.user_id,
    shape: row.shape,
    location: row.location,
    sha256: row.sha256,
    rowCount: num(row.row_count),
    columns: Array.isArray(row.columns) ? row.columns : [],
    issues: Array.isArray(row.issues) ? row.issues : [],
    outcomeBearing: row.outcome_bearing === true,
    derivedFrom: object(row.derived_from),
    valueSource: row.value_source ?? "observed",
    createdAt: iso(row.created_at),
  };
}

/** @param {any} row */
export function vcrMemberFromRow(row) {
  if (!row) return null;
  return {
    studyId: row.study_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: text(row.invited_by),
    detail: object(row.detail),
    createdAt: iso(row.created_at),
  };
}

/**
 * The queries the data plane, the access judge and the member service share.
 * Each of them takes ids the caller has already resolved for the account —
 * except `studyForAccess` and `sourceFor`, which are the resolution.
 */
export class VcrDataStore extends VcrStoreBase {
  // -------------------------------------------------------------------------
  // Studies — read only. The study row belongs to the orchestration package;
  // this file needs the owner and the tombstone to judge who may read a source.
  // -------------------------------------------------------------------------

  /**
   * The study as the judge needs it: who owns it, what it is used for, and where
   * its seal stands. Never a study that is deleted.
   * @param {string} studyId @param {any} [client]
   */
  async studyForAccess(studyId, client = null) {
    const sql = `SELECT id, user_id, project_id, deleted_at, intended_use, data_tier, outcome_seal
      FROM ${this.schema}.studies WHERE id = $1`;
    const rows = client ? (await client.query(sql, [studyId])).rows : await this.rows(sql, [studyId]);
    const row = rows[0];
    if (!row || row.deleted_at) return null;
    return {
      id: row.id, userId: row.user_id, projectId: row.project_id,
      intendedUse: String(row.intended_use ?? "exploratory"), dataTier: String(row.data_tier ?? "T0"),
      outcomeSeal: object(row.outcome_seal),
    };
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  /** @param {string} studyId */
  async listMembers(studyId) {
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.members WHERE study_id = $1 ORDER BY created_at, user_id, role`, [studyId]);
    return rows.map(vcrMemberFromRow);
  }

  /** Every role this account holds in this study, sorted. @param {string} studyId @param {string} userId @param {any} [client] */
  async rolesOf(studyId, userId, client = null) {
    const sql = `SELECT role FROM ${this.schema}.members WHERE study_id = $1 AND user_id = $2 ORDER BY role`;
    const rows = client ? (await client.query(sql, [studyId, userId])).rows : await this.rows(sql, [studyId, userId]);
    return rows.map((/** @type {any} */ row) => String(row.role));
  }

  /**
   * @param {{ studyId: string, userId: string, role: string, invitedBy?: string | null,
   *   detail?: Record<string, unknown>, actor?: string }} entry
   */
  async addMember(entry) {
    const studyId = required(entry.studyId, "studyId");
    const userId = required(entry.userId, "userId");
    const role = oneOf(VCR_MEMBER_ROLES, entry.role, "A member role");
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.schema}.members (study_id, user_id, role, invited_by, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (study_id, user_id, role) DO UPDATE SET detail = EXCLUDED.detail
         RETURNING *`,
        [studyId, userId, role, entry.invitedBy ?? null, JSON.stringify(entry.detail ?? {})]);
      await this.audit({
        client, studyId, userId: entry.actor ?? entry.invitedBy ?? null, actor: entry.actor ?? entry.invitedBy ?? "",
        action: "member.add", object: `${userId}:${role}`, detail: { role, member: userId },
      });
      return vcrMemberFromRow(result.rows[0]);
    });
  }

  /** @param {{ studyId: string, userId: string, role: string, actor?: string }} entry */
  async removeMember(entry) {
    const studyId = required(entry.studyId, "studyId");
    const userId = required(entry.userId, "userId");
    const role = oneOf(VCR_MEMBER_ROLES, entry.role, "A member role");
    return this.transaction(async (client) => {
      const result = await client.query(
        `DELETE FROM ${this.schema}.members WHERE study_id = $1 AND user_id = $2 AND role = $3`, [studyId, userId, role]);
      const removed = (result.rowCount ?? 0) > 0;
      if (removed) {
        await this.audit({
          client, studyId, userId: entry.actor ?? null, actor: entry.actor ?? "",
          action: "member.remove", object: `${userId}:${role}`, detail: { role, member: userId },
        });
      }
      return { removed };
    });
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /**
   * @param {{ userId: string, studyId?: string | null, name: string, ownerParty?: string,
   *   allowedUses?: string[], visibleWindow?: Record<string, unknown>, retention?: Record<string, unknown>,
   *   format?: string, valueSource?: string, actor?: string }} entry
   */
  async createSource(entry) {
    const userId = required(entry.userId, "userId");
    const name = required(entry.name, "A data source needs a name");
    const format = oneOf(VCR_SOURCE_FORMATS, entry.format ?? "csv", "A source format");
    const valueSource = oneOf(VCR_VALUE_SOURCES, entry.valueSource ?? "observed", "A value source");
    const id = vcrId("source");
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.schema}.sources
           (id, user_id, study_id, name, owner_party, allowed_uses, visible_window, retention, format, value_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10) RETURNING *`,
        [id, userId, entry.studyId ?? null, name, entry.ownerParty ?? "", words(entry.allowedUses),
          JSON.stringify(entry.visibleWindow ?? {}), JSON.stringify(entry.retention ?? {}), format, valueSource]);
      await this.audit({
        client, studyId: entry.studyId ?? null, userId, actor: entry.actor ?? userId,
        action: "source.register", object: id,
        detail: { name, format, valueSource, ownerParty: entry.ownerParty ?? "", allowedUses: words(entry.allowedUses),
          visibleWindow: entry.visibleWindow ?? {}, retention: entry.retention ?? {} },
      });
      return vcrSourceFromRow(result.rows[0]);
    });
  }

  /** The source as its owning account sees it. @param {string} userId @param {string} sourceId */
  async getSource(userId, sourceId) {
    return vcrSourceFromRow(await this.one(
      `SELECT * FROM ${this.schema}.sources WHERE id = $1 AND user_id = $2`, [sourceId, userId]));
  }

  /** The source without a tenancy filter — for the judge, which decides who may see it. @param {string} sourceId @param {any} [client] */
  async sourceFor(sourceId, client = null) {
    const sql = `SELECT * FROM ${this.schema}.sources WHERE id = $1`;
    const rows = client ? (await client.query(sql, [sourceId])).rows : await this.rows(sql, [sourceId]);
    return vcrSourceFromRow(rows[0]);
  }

  /**
   * A source of *this* study, or nothing: a source of another study, another
   * account or no study at all answers exactly as one that does not exist.
   * @param {string} studyId @param {string} sourceId @param {any} [client]
   */
  async sourceInStudy(studyId, sourceId, client = null) {
    const sql = `SELECT * FROM ${this.schema}.sources WHERE id = $1 AND study_id = $2`;
    const rows = client ? (await client.query(sql, [sourceId, studyId])).rows : await this.rows(sql, [sourceId, studyId]);
    return vcrSourceFromRow(rows[0]);
  }

  /** @param {{ userId: string, studyId?: string | null }} query */
  async listSources(query) {
    const values = [required(query.userId, "userId")];
    let where = "user_id = $1";
    if (query.studyId) { values.push(query.studyId); where += ` AND study_id = $${values.length}`; }
    const rows = await this.rows(`SELECT * FROM ${this.schema}.sources WHERE ${where} ORDER BY updated_at DESC, id`, values);
    return rows.map(vcrSourceFromRow);
  }

  /** Every source of a study, whoever registered it. @param {string} studyId */
  async listSourcesForStudy(studyId) {
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.sources WHERE study_id = $1 ORDER BY created_at, id`, [studyId]);
    return rows.map(vcrSourceFromRow);
  }

  /** @param {{ sourceId: string, status: string, actor?: string, userId?: string }} entry */
  async setSourceStatus(entry) {
    const status = oneOf(VCR_SOURCE_STATUSES, entry.status, "A source status");
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.sources SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [entry.sourceId, status]);
      const source = vcrSourceFromRow(result.rows[0]);
      if (source) {
        await this.audit({
          client, studyId: source.studyId, userId: entry.userId ?? source.userId, actor: entry.actor ?? "",
          action: "source.status", object: source.id, detail: { status },
        });
      }
      return source;
    });
  }

  // -------------------------------------------------------------------------
  // The field map before a snapshot: one document per source
  // -------------------------------------------------------------------------

  /**
   * Store the source's field-map draft (the whole document, replaced), proposed
   * by the run or a person. A confirmation never survives an edit: the state
   * goes back to `proposed` and the hash moves, so a person confirms exactly the
   * map they read.
   * @param {{ sourceId: string, columns: unknown[], hash: string, by: string, actor?: string, reason?: string }} entry
   */
  async saveFieldMapDraft(entry) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.sources SET field_map = $2::jsonb, field_map_state = 'proposed', field_map_hash = $3,
           field_map_by = $4, field_map_at = now(), field_map_confirmed_by = NULL, field_map_confirmed_at = NULL,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [entry.sourceId, JSON.stringify({ columns: entry.columns }), entry.hash, entry.by]);
      const source = vcrSourceFromRow(result.rows[0]);
      if (source) {
        await this.audit({
          client, studyId: source.studyId, userId: source.userId, actor: entry.actor ?? entry.by,
          action: "fieldmap.propose", object: source.id, reason: entry.reason ?? "",
          detail: { hash: entry.hash, columns: entry.columns.length, by: entry.by },
        });
      }
      return source;
    });
  }

  /**
   * Confirm the draft — only the version the person read (`hash`), only if it
   * is still the current one.
   * @param {{ sourceId: string, hash: string, by: string, actor?: string }} entry
   */
  async confirmFieldMapDraft(entry) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.sources SET field_map_state = 'confirmed', field_map_confirmed_by = $3,
           field_map_confirmed_at = now(), updated_at = now()
         WHERE id = $1 AND field_map_hash = $2 AND field_map_state IN ('proposed', 'confirmed') RETURNING *`,
        [entry.sourceId, entry.hash, entry.by]);
      const source = vcrSourceFromRow(result.rows[0]);
      if (source) {
        await this.audit({
          client, studyId: source.studyId, userId: source.userId, actor: entry.actor ?? entry.by,
          action: "fieldmap.confirm", object: source.id, detail: { hash: entry.hash, by: entry.by },
        });
      }
      return source;
    });
  }

  // -------------------------------------------------------------------------
  // Uploaded files (before any snapshot)
  // -------------------------------------------------------------------------

  /**
   * Record a stored file. The same bytes uploaded again to the same source in
   * the same role are the same file: the existing row answers, nothing new is
   * written (`created: false`).
   * @param {{ sourceId: string, studyId: string, userId: string, role: string, name: string, format: string,
   *   location: string, sha256: string, bytes: number, rowCount?: number | null, columnCount?: number | null,
   *   profile?: Record<string, unknown>, detail?: Record<string, unknown>, actor?: string }} entry
   */
  async addSourceFile(entry) {
    const role = oneOf(VCR_SOURCE_FILE_ROLES, entry.role, "A file role");
    const id = sourceFileId();
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${this.schema}.source_files
           (id, source_id, study_id, user_id, role, name, format, location, sha256, bytes, row_count, column_count, profile, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
         ON CONFLICT (source_id, sha256, role) DO NOTHING RETURNING *`,
        [id, required(entry.sourceId, "sourceId"), entry.studyId, required(entry.userId, "userId"), role,
          required(entry.name, "A file name"), required(entry.format, "A file format"), required(entry.location, "A file location"),
          required(entry.sha256, "A file sha256"), Math.max(0, Math.trunc(Number(entry.bytes) || 0)),
          entry.rowCount ?? null, entry.columnCount ?? null, JSON.stringify(entry.profile ?? {}), JSON.stringify(entry.detail ?? {})]);
      if (inserted.rows[0]) {
        await this.audit({
          client, studyId: entry.studyId, userId: entry.userId, actor: entry.actor ?? entry.userId,
          action: "source.file", object: id,
          detail: { sourceId: entry.sourceId, role, name: entry.name, format: entry.format, bytes: entry.bytes, sha256: entry.sha256,
            rowCount: entry.rowCount ?? null, columnCount: entry.columnCount ?? null },
        });
        return { file: vcrSourceFileFromRow(inserted.rows[0]), created: true };
      }
      const existing = await client.query(
        `SELECT * FROM ${this.schema}.source_files WHERE source_id = $1 AND sha256 = $2 AND role = $3`,
        [entry.sourceId, entry.sha256, role]);
      return { file: vcrSourceFileFromRow(existing.rows[0]), created: false };
    });
  }

  /** @param {string} sourceId */
  async listSourceFiles(sourceId) {
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.source_files WHERE source_id = $1 ORDER BY created_at, id`, [sourceId]);
    return rows.map(vcrSourceFileFromRow);
  }

  /** Every file of a study's sources. @param {string} studyId */
  async listSourceFilesForStudy(studyId) {
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.source_files WHERE study_id = $1 ORDER BY created_at, id`, [studyId]);
    return rows.map(vcrSourceFileFromRow);
  }

  /** @param {string} studyId @param {string} fileId */
  async getSourceFile(studyId, fileId) {
    return vcrSourceFileFromRow(await this.one(
      `SELECT * FROM ${this.schema}.source_files WHERE id = $1 AND study_id = $2`, [fileId, studyId]));
  }

  /**
   * Forget a file — only one no snapshot names: a frozen snapshot's bytes are
   * its own record. Answers the row it removed, or `null`.
   * @param {{ studyId: string, fileId: string, actor?: string }} entry
   */
  async deleteSourceFile(entry) {
    return this.transaction(async (client) => {
      const row = (await client.query(
        `SELECT * FROM ${this.schema}.source_files WHERE id = $1 AND study_id = $2 FOR UPDATE`, [entry.fileId, entry.studyId])).rows[0];
      if (!row) return { removed: null, frozen: false };
      const used = await client.query(
        `SELECT 1 FROM ${this.schema}.snapshots WHERE source_id = $1 AND file_hashes @> $2::jsonb LIMIT 1`,
        [row.source_id, JSON.stringify([{ id: entry.fileId }])]);
      if (used.rowCount) return { removed: null, frozen: true };
      await client.query(`DELETE FROM ${this.schema}.source_files WHERE id = $1`, [entry.fileId]);
      await this.audit({
        client, studyId: entry.studyId, userId: row.user_id, actor: entry.actor ?? "",
        action: "source.file.remove", object: entry.fileId, detail: { sourceId: row.source_id, name: row.name, sha256: row.sha256 },
      });
      return { removed: vcrSourceFileFromRow(row), frozen: false };
    });
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * @param {{ sourceId: string, studyId?: string | null, userId: string, grantee: string, role?: string | null,
   *   fields?: string[], fieldMode?: string, windowStart?: string | Date | null, windowEnd?: string | Date | null,
   *   purposes?: string[], actor?: string }} entry
   */
  async createGrant(entry) {
    const sourceId = required(entry.sourceId, "sourceId");
    const grantee = required(entry.grantee, "A grant needs a grantee");
    const fieldMode = oneOf(VCR_GRANT_FIELD_MODES, entry.fieldMode ?? "allow", "A grant field mode");
    const role = entry.role == null || entry.role === "" ? null : oneOf(VCR_MEMBER_ROLES, entry.role, "A grant role");
    const id = vcrId("grant");
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.schema}.grants
           (id, source_id, study_id, user_id, grantee, role, fields, field_mode, window_start, window_end, purposes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, sourceId, entry.studyId ?? null, required(entry.userId, "userId"), grantee, role,
          words(entry.fields), fieldMode, entry.windowStart ?? null, entry.windowEnd ?? null, words(entry.purposes)]);
      await this.audit({
        client, studyId: entry.studyId ?? null, userId: entry.userId, actor: entry.actor ?? entry.userId,
        action: "grant.create", object: id,
        detail: { sourceId, grantee, role, fieldMode, fields: words(entry.fields), purposes: words(entry.purposes) },
      });
      return vcrGrantFromRow(result.rows[0]);
    });
  }

  /**
   * Revoke, keeping the row. With `studyId` the grant must be that study's: an
   * id from another study revokes nothing.
   * @param {{ grantId: string, studyId?: string | null, actor?: string }} entry
   */
  async revokeGrant(entry) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.grants SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR study_id = $2) RETURNING *`,
        [entry.grantId, entry.studyId ?? null]);
      const grant = vcrGrantFromRow(result.rows[0]);
      if (grant) {
        await this.audit({
          client, studyId: grant.studyId, userId: grant.userId, actor: entry.actor ?? "",
          action: "grant.revoke", object: grant.id, detail: { sourceId: grant.sourceId, grantee: grant.grantee },
        });
      }
      return grant;
    });
  }

  /**
   * Live grants only. A revoked one is kept for the record and never judged on.
   * @param {{ sourceId: string, grantee?: string | null, studyId?: string | null }} query @param {any} [client]
   */
  async liveGrants(query, client = null) {
    const values = [required(query.sourceId, "sourceId")];
    let where = "source_id = $1 AND revoked_at IS NULL";
    if (query.grantee) { values.push(query.grantee); where += ` AND grantee = $${values.length}`; }
    if (query.studyId) { values.push(query.studyId); where += ` AND (study_id IS NULL OR study_id = $${values.length})`; }
    const sql = `SELECT * FROM ${this.schema}.grants WHERE ${where} ORDER BY created_at, id`;
    const rows = client ? (await client.query(sql, values)).rows : await this.rows(sql, values);
    return rows.map(vcrGrantFromRow);
  }

  /** The live and the revoked grants of several sources, in one read. @param {string[]} sourceIds */
  async grantsForSources(sourceIds) {
    if (!sourceIds.length) return [];
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.grants WHERE source_id = ANY($1::text[]) ORDER BY created_at, id`, [sourceIds]);
    return rows.map(vcrGrantFromRow);
  }

  /** @param {string} grantId */
  async getGrant(grantId) {
    return vcrGrantFromRow(await this.one(`SELECT * FROM ${this.schema}.grants WHERE id = $1`, [grantId]));
  }

  /** Every grant ever written for a source, revoked ones included. @param {string} sourceId */
  async listGrants(sourceId) {
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.grants WHERE source_id = $1 ORDER BY created_at, id`, [sourceId]);
    return rows.map(vcrGrantFromRow);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /**
   * Freeze a source into an immutable, hashed version, and everything that
   * belongs to that moment with it — the snapshot row, its field map, the
   * source's status and the audit rows — in one transaction, under one advisory
   * lock per source. Before the lock two freezes of one source both read
   * `MAX(version)` and the slower one failed on the unique index after its
   * profile had already been computed (review CS-40); after it, the second waits
   * and takes the next version. A map that does not write leaves no snapshot
   * without a map behind.
   * @param {{ sourceId: string, studyId?: string | null, userId: string, location: string, sha256: string,
   *   rowCount?: number | null, columnCount?: number | null, profile?: Record<string, unknown>,
   *   quality?: Record<string, unknown>, sealedFields?: string[], sealedUntil?: string | Date | null,
   *   fileHashes?: unknown[], fieldMapHash?: string | null, valueSource?: string,
   *   fieldMaps?: Array<Record<string, any>>, actor?: string }} entry
   */
  async freezeSnapshot(entry) {
    const sourceId = required(entry.sourceId, "sourceId");
    const location = required(entry.location, "A snapshot needs a location");
    const sha256 = required(entry.sha256, "A snapshot needs its sha256");
    const id = vcrId("snapshot");
    const userId = required(entry.userId, "userId");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-snapshot:${sourceId}`]);
      const version = await this.nextVersion(client, "snapshots", "source_id = $1", [sourceId]);
      const result = await client.query(
        `INSERT INTO ${this.schema}.snapshots
           (id, source_id, study_id, user_id, version, location, sha256, row_count, column_count, profile, quality,
            sealed_fields, sealed_until, file_hashes, field_map_hash, value_source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16, $17) RETURNING *`,
        [id, sourceId, entry.studyId ?? null, userId, version, location, sha256,
          entry.rowCount ?? null, entry.columnCount ?? null,
          JSON.stringify(entry.profile ?? {}), JSON.stringify(entry.quality ?? {}),
          words(entry.sealedFields), entry.sealedUntil ?? null, JSON.stringify(entry.fileHashes ?? []),
          entry.fieldMapHash ?? null, oneOf(VCR_VALUE_SOURCES, entry.valueSource ?? "observed", "A value source"),
          entry.actor ?? userId]);
      for (const map of entry.fieldMaps ?? []) await this.putFieldMap(/** @type {any} */ ({ ...map, snapshotId: id, userId }), client);
      await client.query(`UPDATE ${this.schema}.sources SET status = 'frozen', updated_at = now() WHERE id = $1`, [sourceId]);
      await this.audit({
        client, studyId: entry.studyId ?? null, userId, actor: entry.actor ?? userId,
        action: "snapshot.freeze", object: id,
        detail: { sourceId, version, sha256, rowCount: entry.rowCount ?? null, columnCount: entry.columnCount ?? null,
          files: (entry.fileHashes ?? []).length, fieldMapHash: entry.fieldMapHash ?? null, sealedFields: words(entry.sealedFields),
          // A replay says which instant it replays: the ledger is where a person finds out why two snapshots of one file differ.
          asOf: text(object(object(entry.profile).frozen).asOf) },
      });
      // The seal is its own row in the ledger, stamped when it was set: AC-32
      // compares this instant with the analysis plan's.
      if (words(entry.sealedFields).length) {
        await this.audit({
          client, studyId: entry.studyId ?? null, userId, actor: entry.actor ?? userId,
          action: "snapshot.seal", object: id, reason: "结局字段在分析计划冻结前封存",
          detail: { sealedFields: words(entry.sealedFields), sealedUntil: entry.sealedUntil ?? null },
        });
      }
      return vcrSnapshotFromRow(result.rows[0]);
    });
  }

  /** @param {string} snapshotId @param {any} [client] */
  async getSnapshot(snapshotId, client = null) {
    const sql = `SELECT * FROM ${this.schema}.snapshots WHERE id = $1`;
    const rows = client ? (await client.query(sql, [snapshotId])).rows : await this.rows(sql, [snapshotId]);
    return vcrSnapshotFromRow(rows[0]);
  }

  /** @param {{ studyId?: string | null, sourceId?: string | null }} query */
  async listSnapshots(query) {
    /** @type {unknown[]} */
    const values = [];
    const conditions = [];
    if (query.studyId) { values.push(query.studyId); conditions.push(`study_id = $${values.length}`); }
    if (query.sourceId) { values.push(query.sourceId); conditions.push(`source_id = $${values.length}`); }
    if (!conditions.length) throw new TypeError("listSnapshots needs a study or a source.");
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.snapshots WHERE ${conditions.join(" AND ")} ORDER BY frozen_at DESC, id`, values);
    return rows.map(vcrSnapshotFromRow);
  }

  /**
   * Set or lift a seal. Both directions write an audit row carrying the wall
   * clock of the change, which is the timestamp AC-32 compares against the
   * analysis plan's.
   * @param {{ snapshotId: string, sealedFields: string[], sealedUntil?: string | Date | null,
   *   actor: string, reason?: string, action?: string }} entry
   */
  async setSeal(entry) {
    const snapshotId = required(entry.snapshotId, "snapshotId");
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.snapshots SET sealed_fields = $2, sealed_until = $3 WHERE id = $1 RETURNING *`,
        [snapshotId, words(entry.sealedFields), entry.sealedUntil ?? null]);
      const snapshot = vcrSnapshotFromRow(result.rows[0]);
      if (!snapshot) return null;
      await this.audit({
        client, studyId: snapshot.studyId, userId: snapshot.userId, actor: entry.actor,
        action: entry.action ?? (words(entry.sealedFields).length ? "snapshot.seal" : "snapshot.unseal"),
        object: snapshotId, reason: entry.reason ?? "",
        detail: { sealedFields: snapshot.sealedFields, sealedUntil: snapshot.sealedUntil },
      });
      return snapshot;
    });
  }

  /**
   * Seal columns on every snapshot of a study (or the named ones), in one
   * statement: the union with what is already sealed is taken inside the
   * `UPDATE`, so two sealers cannot lose each other's columns. Sealing again
   * clears a lift — this is for a study whose plan has not been frozen.
   * @param {{ studyId: string, fields: string[], snapshotIds?: string[] | null, actor: string, reason?: string }} entry
   */
  async sealStudySnapshots(entry) {
    const fields = words(entry.fields);
    if (!fields.length) return [];
    return this.transaction(async (client) => {
      const values = [required(entry.studyId, "studyId"), fields];
      let scope = "";
      if (entry.snapshotIds?.length) { values.push(entry.snapshotIds); scope = ` AND id = ANY($${values.length}::text[])`; }
      const result = await client.query(
        `UPDATE ${this.schema}.snapshots
           SET sealed_fields = ARRAY(SELECT DISTINCT f FROM unnest(sealed_fields || $2::text[]) AS f ORDER BY f),
               sealed_until = NULL
         WHERE study_id = $1 AND NOT (sealed_fields @> $2::text[] AND sealed_until IS NULL)${scope}
         RETURNING *`, values);
      const changed = result.rows.map(vcrSnapshotFromRow);
      for (const snapshot of changed) {
        await this.audit({
          client, studyId: entry.studyId, userId: snapshot?.userId ?? null, actor: entry.actor, action: "snapshot.seal",
          object: snapshot?.id ?? "", reason: entry.reason ?? "",
          detail: { sealedFields: snapshot?.sealedFields ?? [], sealedUntil: null },
        });
      }
      return changed;
    });
  }

  /**
   * Lift the seal on every snapshot of a study as of `at` — the instant the
   * analysis plan was frozen. The sealed columns stay listed (what was sealed is
   * a fact); `sealed_until` is what ends the seal, so a judgment at any time
   * after `at` finds it lifted and one before it finds it standing.
   * @param {{ studyId: string, at: string | Date, actor: string, reason?: string }} entry
   */
  async liftStudySeal(entry) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE ${this.schema}.snapshots SET sealed_until = $2
         WHERE study_id = $1 AND cardinality(sealed_fields) > 0 AND (sealed_until IS NULL OR sealed_until > $2)
         RETURNING *`, [required(entry.studyId, "studyId"), entry.at]);
      const lifted = result.rows.map(vcrSnapshotFromRow);
      for (const snapshot of lifted) {
        await this.audit({
          client, studyId: entry.studyId, userId: snapshot?.userId ?? null, actor: entry.actor, action: "snapshot.unseal",
          object: snapshot?.id ?? "", reason: entry.reason ?? "",
          detail: { sealedFields: snapshot?.sealedFields ?? [], sealedUntil: snapshot?.sealedUntil ?? null },
        });
      }
      return lifted;
    });
  }

  // -------------------------------------------------------------------------
  // Field maps
  // -------------------------------------------------------------------------

  /**
   * One column's meaning. Re-mapping a column replaces its row, so a study
   * never holds two answers to 「这一列是什么」. A column is addressed by its
   * table (the file's name) and its name: two files of one snapshot may each
   * have an `ID`.
   * @param {{ snapshotId: string, userId: string, columnName: string, tableName?: string, concept?: string,
   *   unit?: string | null, codingSystem?: string | null, timeKind?: string | null, missingReason?: string | null,
   *   identifier?: boolean, reviewState?: string, role?: string, parameter?: string | null, alias?: string | null,
   *   declaredType?: string | null, range?: number[] | null, required?: boolean, outcome?: boolean,
   *   codes?: Record<string, unknown>, actor?: string }} entry @param {any} [client]
   */
  async putFieldMap(entry, client = null) {
    const snapshotId = required(entry.snapshotId, "snapshotId");
    const columnName = required(entry.columnName, "A field map needs a column name");
    const timeKind = entry.timeKind == null || entry.timeKind === "" ? null : oneOf(VCR_TIME_KINDS, entry.timeKind, "A time kind");
    const missingReason = entry.missingReason == null || entry.missingReason === ""
      ? null : oneOf(VCR_MISSING_REASONS, entry.missingReason, "A missing reason");
    const role = oneOf(VCR_FIELD_ROLES, entry.role ?? "other", "A field role");
    const values = [vcrId("fieldMap"), snapshotId, required(entry.userId, "userId"), columnName,
      entry.concept ?? "", entry.unit ?? null, entry.codingSystem ?? null, timeKind, missingReason,
      entry.identifier === true, entry.reviewState ?? "ai_set", entry.tableName ?? "", role,
      entry.parameter ?? null, entry.alias ?? null, entry.declaredType ?? null,
      Array.isArray(entry.range) ? JSON.stringify(entry.range) : null, entry.required === true, entry.outcome === true,
      JSON.stringify(entry.codes ?? {})];
    const sql = `INSERT INTO ${this.schema}.field_maps
        (id, snapshot_id, user_id, column_name, concept, unit, coding_system, time_kind, missing_reason, identifier, review_state,
         table_name, role, parameter, alias, declared_type, value_range, required, outcome, codes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20::jsonb)
      ON CONFLICT (snapshot_id, table_name, column_name) DO UPDATE SET
        concept = EXCLUDED.concept, unit = EXCLUDED.unit, coding_system = EXCLUDED.coding_system,
        time_kind = EXCLUDED.time_kind, missing_reason = EXCLUDED.missing_reason,
        identifier = EXCLUDED.identifier, review_state = EXCLUDED.review_state, role = EXCLUDED.role,
        parameter = EXCLUDED.parameter, alias = EXCLUDED.alias, declared_type = EXCLUDED.declared_type,
        value_range = EXCLUDED.value_range, required = EXCLUDED.required, outcome = EXCLUDED.outcome, codes = EXCLUDED.codes
      RETURNING *`;
    if (client) return vcrFieldMapFromRow((await client.query(sql, values)).rows[0]);
    return this.transaction(async (own) => {
      const row = vcrFieldMapFromRow((await own.query(sql, values)).rows[0]);
      await this.audit({
        client: own, userId: entry.userId, actor: entry.actor ?? entry.userId,
        action: "fieldmap.put", object: `${snapshotId}:${entry.tableName ? `${entry.tableName}.` : ""}${columnName}`,
        detail: { concept: entry.concept ?? "", unit: entry.unit ?? null, timeKind, missingReason, role, identifier: entry.identifier === true },
      });
      return row;
    });
  }

  /** @param {string} snapshotId @param {any} [client] */
  async listFieldMaps(snapshotId, client = null) {
    const sql = `SELECT * FROM ${this.schema}.field_maps WHERE snapshot_id = $1 ORDER BY table_name, column_name`;
    const rows = client ? (await client.query(sql, [snapshotId])).rows : await this.rows(sql, [snapshotId]);
    return rows.map(vcrFieldMapFromRow);
  }

  // -------------------------------------------------------------------------
  // Analysis tables
  // -------------------------------------------------------------------------

  /**
   * @param {{ snapshotId: string, studyId: string, userId: string, shape: string, location: string, sha256: string,
   *   rowCount?: number | null, columns?: unknown[], issues?: unknown[], outcomeBearing?: boolean,
   *   derivedFrom?: Record<string, unknown>, valueSource?: string, actor?: string }} entry @param {any} [client]
   */
  async putAnalysisTable(entry, client = null) {
    const shape = oneOf(VCR_ANALYSIS_TABLES, entry.shape, "An analysis table shape");
    const values = [vcrId("analysisTable"), required(entry.snapshotId, "snapshotId"), required(entry.studyId, "studyId"),
      required(entry.userId, "userId"), shape, required(entry.location, "An analysis table needs a location"),
      required(entry.sha256, "An analysis table needs its sha256"), entry.rowCount ?? null,
      JSON.stringify(entry.columns ?? []), JSON.stringify(entry.issues ?? []), entry.outcomeBearing === true,
      JSON.stringify(entry.derivedFrom ?? {}), oneOf(VCR_VALUE_SOURCES, entry.valueSource ?? "observed", "A value source")];
    const sql = `INSERT INTO ${this.schema}.analysis_tables
        (id, snapshot_id, study_id, user_id, shape, location, sha256, row_count, columns, issues, outcome_bearing, derived_from, value_source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13)
      ON CONFLICT (snapshot_id, study_id, shape) DO UPDATE SET
        location = EXCLUDED.location, sha256 = EXCLUDED.sha256, row_count = EXCLUDED.row_count,
        columns = EXCLUDED.columns, issues = EXCLUDED.issues, outcome_bearing = EXCLUDED.outcome_bearing,
        derived_from = EXCLUDED.derived_from, value_source = EXCLUDED.value_source, created_at = now()
      RETURNING *`;
    if (client) return vcrAnalysisTableFromRow((await client.query(sql, values)).rows[0]);
    return this.transaction(async (own) => {
      const row = vcrAnalysisTableFromRow((await own.query(sql, values)).rows[0]);
      await this.audit({
        client: own, studyId: entry.studyId, userId: entry.userId, actor: entry.actor ?? entry.userId,
        action: "analysis_table.put", object: `${entry.snapshotId}:${shape}`,
        detail: { shape, sha256: entry.sha256, rowCount: entry.rowCount ?? null, issues: (entry.issues ?? []).length,
          outcomeBearing: entry.outcomeBearing === true, valueSource: entry.valueSource ?? "observed" },
      });
      return row;
    });
  }

  /** @param {{ snapshotId?: string | null, studyId?: string | null }} query */
  async listAnalysisTables(query) {
    /** @type {unknown[]} */
    const values = [];
    const conditions = [];
    if (query.snapshotId) { values.push(query.snapshotId); conditions.push(`snapshot_id = $${values.length}`); }
    if (query.studyId) { values.push(query.studyId); conditions.push(`study_id = $${values.length}`); }
    if (!conditions.length) throw new TypeError("listAnalysisTables needs a snapshot or a study.");
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.analysis_tables WHERE ${conditions.join(" AND ")} ORDER BY shape`, values);
    return rows.map(vcrAnalysisTableFromRow);
  }

  // -------------------------------------------------------------------------
  // Audit reads (the record a validation asks for)
  // -------------------------------------------------------------------------

  /** @param {{ studyId?: string | null, action?: string | null, object?: string | null, limit?: number }} query */
  async auditTrail(query = {}) {
    /** @type {unknown[]} */
    const values = [];
    const conditions = [];
    if (query.studyId) { values.push(query.studyId); conditions.push(`study_id = $${values.length}`); }
    if (query.action) { values.push(query.action); conditions.push(`action = $${values.length}`); }
    if (query.object) { values.push(query.object); conditions.push(`object = $${values.length}`); }
    const limit = Number.isSafeInteger(query.limit) && /** @type {number} */ (query.limit) > 0 ? Number(query.limit) : 200;
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.rows(
      `SELECT * FROM ${this.schema}.audit ${where} ORDER BY id DESC LIMIT ${limit}`, values);
    return rows.map((/** @type {any} */ row) => ({
      id: Number(row.id), studyId: text(row.study_id), userId: text(row.user_id), actor: row.actor ?? "",
      action: row.action, object: row.object ?? "", outcome: row.outcome ?? "ok", reason: row.reason ?? "",
      detail: object(row.detail), occurredAt: iso(row.occurred_at),
    }));
  }
}
