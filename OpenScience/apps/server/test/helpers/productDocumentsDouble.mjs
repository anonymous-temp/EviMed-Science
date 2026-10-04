// A product ledger in memory, with the bounds the real one has: optimistic revisions that refuse a stale
// writer, a revision history, a list that honours its limit and its project, and the 256 KiB document cap.
// A double that ignored any of these hid a limit-blind caller once (store doubles need real bounds).
import { HttpError } from "../../src/security.mjs";

export class ProductDocumentsDouble {
  constructor() {
    /** @type {Map<string, any>} */
    this.rows = new Map();
    /** @type {Map<string, any[]>} */
    this.revisions = new Map();
    /** Fail the next N writes as a lost race, to exercise the caller's retry. */
    this.conflicts = 0;
    this.puts = 0;
  }

  #key(userId, kind, id) { return `${userId}\u0000${kind}\u0000${id}`; }

  async get(userId, kind, id) {
    const row = this.rows.get(this.#key(userId, kind, id));
    return row ? structuredClone(row) : null;
  }

  async list(userId, kind, { limit = 50, projectId = undefined } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "product_parameter_invalid", "Expected an integer between 1 and 100.");
    const all = [...this.rows.values()].filter((row) => row.userId === userId && row.kind === kind && (projectId === undefined || row.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: all.slice(0, limit).map((row) => structuredClone(row)), nextCursor: all.length > limit ? "more" : null };
  }

  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    this.puts += 1;
    if (Buffer.byteLength(JSON.stringify(payload)) > 262_144) throw new HttpError(413, "product_document_too_large", "A product record exceeds 256 KiB.");
    const key = this.#key(userId, kind, id);
    const current = this.rows.get(key);
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
    }
    if (expectedRevision === 0 ? Boolean(current) : !current || current.revision !== expectedRevision) {
      throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
    }
    const stamp = `2026-10-04T08:00:${String(this.rows.size).padStart(2, "0")}.000Z`;
    const row = { userId, kind, id, projectId, payload: structuredClone(payload), revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? stamp, updatedAt: stamp, deletedAt: null };
    this.rows.set(key, row);
    this.revisions.set(key, [...(this.revisions.get(key) ?? []), { revision: row.revision, payload: structuredClone(payload) }]);
    return structuredClone(row);
  }

  history(userId, kind, id) { return this.revisions.get(this.#key(userId, kind, id)) ?? []; }
}
