/**
 * The in-memory `ProductDocuments` the server tests drive `LearningService` over (`apps/server/test/helpers/productDocumentsDouble.mjs`), with
 * one addition: its rows, its revision history and its clock can be saved to a JSON value and loaded back, so an offline library survives a
 * restart. The semantics are the helper's, line for line: `expectedRevision: 0` creates, anything else must match, payload containment
 * filters, newest-first listing, a history of every write, `telemetry` writes that move the revision without a history row.
 *
 * A copy and not an import because the helper keeps its rows' history and clock in closures; restoring a library through it would restart
 * the clock (so a method written after a restart would list as the oldest) and lose the saved revisions a `depends_on` pin may name.
 */
import { productInteger } from "../../../apps/server/src/productPersistence.mjs";
import { HttpError } from "../../../apps/server/src/security.mjs";

/** PostgreSQL's `@>` on a jsonb payload, as the helper reads it. @param {any} payload @param {any} filter @returns {boolean} */
function contains(payload, filter) {
  if (Array.isArray(filter)) return Array.isArray(payload) && filter.every((item) => payload.some((candidate) => contains(candidate, item)));
  if (filter && typeof filter === "object") return Object.entries(filter).every(([key, value]) => contains(payload?.[key], value));
  return JSON.stringify(payload) === JSON.stringify(filter);
}

/**
 * @param {{rows?: any[], revisions?: [string, any[]][], clock?: number} | null} [saved] what `snapshot()` returned
 */
export function persistentDocuments(saved = null) {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, any[]>} */
  const revisions = new Map(saved?.revisions ?? []);
  let clock = Number.isFinite(saved?.clock) ? Number(saved?.clock) : Date.parse("2026-09-01T00:00:00.000Z");
  const keyOf = (/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id) => JSON.stringify([userId, kind, id]);
  for (const row of saved?.rows ?? []) rows.set(keyOf(row.userId, row.kind, row.id), row);
  const tick = () => new Date((clock += 1_000)).toISOString();
  const saveRevision = (/** @type {string} */ key, /** @type {any} */ row) => {
    const list = revisions.get(key) ?? [];
    list.push({ revision: row.revision, payload: structuredClone(row.payload), deletedAt: row.deletedAt, recordedAt: row.updatedAt });
    revisions.set(key, list);
  };
  const publicRow = (/** @type {any} */ row) => (row ? structuredClone(row) : null);
  return {
    rows,
    database: null,
    /** Everything needed to load the store back. */
    snapshot() {
      return { rows: [...rows.values()].map((row) => structuredClone(row)), revisions: [...revisions.entries()].map(([key, list]) => [key, structuredClone(list)]), clock };
    },
    async get(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, { includeDeleted = false } = {}) {
      const row = rows.get(keyOf(userId, kind, id));
      return row && (includeDeleted || !row.deletedAt) ? publicRow(row) : null;
    },
    async list(/** @type {string} */ userId, /** @type {string} */ kind, { limit = 50, projectId = undefined, filter = {}, deleted = false, fields = null } = /** @type {any} */ ({})) {
      productInteger(limit, 1, 100);
      const items = [...rows.values()]
        .filter((row) => row.userId === userId && row.kind === kind && Boolean(row.deletedAt) === deleted)
        .filter((row) => projectId === undefined || (row.projectId ?? null) === (projectId ?? null))
        .filter((row) => contains(row.payload, filter))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .slice(0, limit)
        .map(publicRow)
        .map((row) => (fields ? { ...row, payload: Object.fromEntries(Object.entries(/** @type {Record<string, any>} */ (fields)).map(([key, size]) => {
          const value = row.payload?.[key] ?? null;
          return [key, size === true || typeof value !== "string" ? value : value.slice(0, size)];
        })) } : row));
      return { items, nextCursor: null };
    },
    async search(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ query, { limit = 20, filter = {}, any = { field: "", values: [] } } = /** @type {any} */ ({})) {
      return [...rows.values()]
        .filter((row) => row.userId === userId && row.kind === kind && !row.deletedAt && contains(row.payload, filter))
        .filter((row) => String(row.payload?.content ?? "").toLowerCase().includes(String(query).toLowerCase()))
        .filter((row) => !any.values?.length || any.values.includes(row.payload?.[any.field]))
        .slice(0, limit)
        .map(publicRow);
    },
    async put(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ payload,
      /** @type {any} */ { expectedRevision, projectId = null, telemetry = false, restoreDeleted = false }) {
      const key = keyOf(userId, kind, id);
      const current = rows.get(key);
      if (expectedRevision === 0) {
        if (telemetry) throw new HttpError(400, "product_document_invalid", "A counter update cannot create a record.");
        if (current) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
        const at = tick();
        const row = { id, kind, userId, projectId, payload: structuredClone(payload), revision: 1, createdAt: at, updatedAt: at, deletedAt: null };
        rows.set(key, row);
        saveRevision(key, row);
        return publicRow(row);
      }
      if (!current || (current.deletedAt && !restoreDeleted) || current.revision !== expectedRevision) {
        throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      }
      if (restoreDeleted) current.deletedAt = null;
      current.payload = structuredClone(payload);
      current.revision += 1;
      if (!telemetry) {
        current.updatedAt = tick();
        saveRevision(key, current);
      }
      return publicRow(current);
    },
    async createBatch(/** @type {string} */ userId, /** @type {any[]} */ records) {
      const created = [];
      for (const item of records) created.push(await this.put(userId, item.kind, item.id, item.payload, { expectedRevision: 0, projectId: item.projectId ?? null }));
      return created;
    },
    async remove(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, /** @type {number} */ expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, true); },
    async restore(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, /** @type {number} */ expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, false); },
    async changeDeletion(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, /** @type {number} */ expectedRevision, /** @type {boolean} */ removed) {
      const key = keyOf(userId, kind, id);
      const current = rows.get(key);
      if (!current) throw new HttpError(404, "product_document_not_found", "The record is unavailable.");
      if (current.revision !== expectedRevision) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      current.deletedAt = removed ? tick() : null;
      current.revision += 1;
      current.updatedAt = tick();
      saveRevision(key, current);
      return publicRow(current);
    },
    async history(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id, { limit = 50, beforeRevision = null } = /** @type {any} */ ({})) {
      return [...(revisions.get(keyOf(userId, kind, id)) ?? [])].reverse()
        .filter((entry) => beforeRevision == null || entry.revision < beforeRevision)
        .slice(0, limit).map((entry) => structuredClone(entry));
    },
  };
}
