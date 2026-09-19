/**
 * An in-memory `ProductDocuments` for the capsule tests that do not need a
 * database: the same method surface, the same revision semantics
 * (`expectedRevision: 0` creates, anything else must match), containment
 * filters on the payload, newest-first listing and a history of every write.
 *
 * It is deliberately not clever about pagination (one page) or about the
 * lexical search (a substring of `payload.content`), because the integration
 * suite holds the real store to those; what the unit tests here need is the
 * shape of each record and the conflicts a revision mismatch raises.
 */
import { HttpError } from "../../src/security.mjs";

/** @param {any} payload @param {Record<string, any>} filter */
function contains(payload, filter) {
  return Object.entries(filter ?? {}).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return contains(payload?.[key], value);
    return JSON.stringify(payload?.[key]) === JSON.stringify(value);
  });
}

export function productDocumentsDouble() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, any[]>} */
  const revisions = new Map();
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const tick = () => new Date((clock += 1_000)).toISOString();
  const keyOf = (userId, kind, id) => JSON.stringify([userId, kind, id]);
  const saveRevision = (key, row) => {
    const list = revisions.get(key) ?? [];
    list.push({ revision: row.revision, payload: structuredClone(row.payload), deletedAt: row.deletedAt, recordedAt: row.updatedAt });
    revisions.set(key, list);
  };
  const publicRow = (row) => (row ? structuredClone(row) : null);
  return {
    rows,
    database: null,
    async get(userId, kind, id, { includeDeleted = false } = {}) {
      const row = rows.get(keyOf(userId, kind, id));
      return row && (includeDeleted || !row.deletedAt) ? publicRow(row) : null;
    },
    async list(userId, kind, { limit = 50, projectId = undefined, filter = {}, deleted = false } = {}) {
      const items = [...rows.values()]
        .filter((row) => row.userId === userId && row.kind === kind && Boolean(row.deletedAt) === deleted)
        .filter((row) => projectId === undefined || (row.projectId ?? null) === (projectId ?? null))
        .filter((row) => contains(row.payload, filter))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .slice(0, limit)
        .map(publicRow);
      return { items, nextCursor: null };
    },
    async search(userId, kind, query, { limit = 20, filter = {}, any = { field: "", values: [] } } = {}) {
      return [...rows.values()]
        .filter((row) => row.userId === userId && row.kind === kind && !row.deletedAt && contains(row.payload, filter))
        .filter((row) => String(row.payload?.content ?? "").toLowerCase().includes(String(query).toLowerCase()))
        .filter((row) => !any.values?.length || any.values.includes(row.payload?.[any.field]))
        .slice(0, limit)
        .map(publicRow);
    },
    async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
      const key = keyOf(userId, kind, id);
      const current = rows.get(key);
      if (expectedRevision === 0) {
        if (current) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
        const at = tick();
        const row = { id, kind, userId, projectId, payload: structuredClone(payload), revision: 1, createdAt: at, updatedAt: at, deletedAt: null };
        rows.set(key, row);
        saveRevision(key, row);
        return publicRow(row);
      }
      if (!current || current.deletedAt || current.revision !== expectedRevision) {
        throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      }
      current.payload = structuredClone(payload);
      current.revision += 1;
      current.updatedAt = tick();
      saveRevision(key, current);
      return publicRow(current);
    },
    async createBatch(userId, records) {
      const created = [];
      for (const item of records) {
        created.push(await this.put(userId, item.kind, item.id, item.payload, { expectedRevision: 0, projectId: item.projectId ?? null }));
      }
      return created;
    },
    async remove(userId, kind, id, expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, true); },
    async restore(userId, kind, id, expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, false); },
    async changeDeletion(userId, kind, id, expectedRevision, removed) {
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
    async history(userId, kind, id, { limit = 50 } = {}) {
      return [...(revisions.get(keyOf(userId, kind, id)) ?? [])].reverse().slice(0, limit).map((entry) => structuredClone(entry));
    },
  };
}
