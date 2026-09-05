import { HttpError } from "./security.mjs";
import { migrateProductStore, productId, productInteger, productKind, productPayload, productTime } from "./productPersistence.mjs";
export { ProductJobs } from "./productJobs.mjs";

/** @param {any} row */
function record(row) {
  return row ? {
    id: row.id, kind: row.kind, projectId: row.project_id, payload: row.payload,
    revision: row.revision, createdAt: productTime(row.created_at), updatedAt: productTime(row.updated_at),
    deletedAt: productTime(row.deleted_at),
  } : null;
}

/** @param {any} client @param {any} row */
async function saveRevision(client, row) {
  await client.query(`INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6)`, [row.user_id, row.kind, row.id, row.revision, row.payload, row.deleted_at]);
}

/** Durable, account-scoped product records with optimistic updates and recoverable deletion. */
export class ProductDocuments {
  /** @param {any} database */
  constructor(database) { this.database = database; }

  /** @param {string} userId @param {string} kind @param {string} id @param {{ includeDeleted?: boolean }} options */
  async get(userId, kind, id, { includeDeleted = false } = {}) {
    const values = [productId(userId, "user"), productKind(kind), productId(id), includeDeleted];
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND id=$3 AND ($4::boolean OR deleted_at IS NULL)`, values);
    return record(result.rows[0]);
  }

  /** @param {string} userId @param {string} kind
   * @param {{ limit?: number, cursor?: string|null, projectId?: string|null }} options */
  async list(userId, kind, { limit = 50, cursor = null, projectId = undefined } = {}) {
    productInteger(limit, 1, 100);
    let after = null;
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== "string" || !Number.isFinite(Date.parse(after[0]))) throw new Error();
        productId(after[1]);
      } catch { throw new HttpError(400, "product_cursor_invalid", "Invalid page cursor."); }
    }
    if (projectId != null) productId(projectId, "project");
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND deleted_at IS NULL
      AND (NOT $3::boolean OR project_id IS NOT DISTINCT FROM $4::text)
      AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text))
      ORDER BY created_at DESC,id DESC LIMIT $7`,
    [productId(userId, "user"), productKind(kind), projectId !== undefined, projectId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const items = result.rows.slice(0, limit).map(record);
    const last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") : null };
  }

  /** expectedRevision=0 creates; every update names the version the caller read.
   * @param {string} userId @param {string} kind @param {string} id @param {Record<string,any>} payload
   * @param {{ expectedRevision: number, projectId?: string|null }} options */
  async put(userId, kind, id, payload, { expectedRevision, projectId = null }) {
    const values = [productId(userId, "user"), productKind(kind), productId(id), productPayload(payload)];
    productInteger(expectedRevision, 0, 2_147_483_646);
    if (projectId != null) productId(projectId, "project");
    await migrateProductStore(this.database);
    return this.database.transaction(async (client) => {
      const result = expectedRevision === 0
        ? await client.query(`INSERT INTO evimed_product.documents(user_id,kind,id,payload,project_id)
            VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING *`, [...values, projectId])
        : await client.query(`UPDATE evimed_product.documents SET payload=$4::jsonb,revision=revision+1,updated_at=clock_timestamp()
            WHERE user_id=$1 AND kind=$2 AND id=$3 AND revision=$5 AND deleted_at IS NULL RETURNING *`, [...values, expectedRevision]);
      if (!result.rows[0]) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      await saveRevision(client, result.rows[0]);
      return record(result.rows[0]);
    });
  }

  /** @param {string} userId @param {string} kind @param {string} id @param {number} expectedRevision */
  async remove(userId, kind, id, expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, true); }

  /** @param {string} userId @param {string} kind @param {string} id @param {number} expectedRevision */
  async restore(userId, kind, id, expectedRevision) { return this.changeDeletion(userId, kind, id, expectedRevision, false); }

  /** @param {string} userId @param {string} kind @param {string} id @param {number} expectedRevision @param {boolean} removed */
  async changeDeletion(userId, kind, id, expectedRevision, removed) {
    productInteger(expectedRevision, 1, 2_147_483_646);
    await migrateProductStore(this.database);
    return this.database.transaction(async (client) => {
      const values = [productId(userId, "user"), productKind(kind), productId(id)];
      const current = await client.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE", values);
      if (!current.rows[0]) throw new HttpError(404, "product_document_not_found", "The record is unavailable.");
      if (current.rows[0].revision !== expectedRevision) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      const result = await client.query(`UPDATE evimed_product.documents SET
        deleted_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END,
        revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND kind=$2 AND id=$3 RETURNING *`, [...values, removed]);
      await saveRevision(client, result.rows[0]);
      return record(result.rows[0]);
    });
  }

  /** @param {string} userId @param {string} kind @param {string} id
   * @param {{ beforeRevision?: number|null, limit?: number }} options */
  async history(userId, kind, id, { beforeRevision = null, limit = 50 } = {}) {
    productInteger(limit, 1, 100);
    if (beforeRevision != null) productInteger(beforeRevision, 1, 2_147_483_647);
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.revisions
      WHERE user_id=$1 AND kind=$2 AND id=$3 AND ($4::integer IS NULL OR revision<$4)
      ORDER BY revision DESC LIMIT $5`,
    [productId(userId, "user"), productKind(kind), productId(id), beforeRevision, limit]);
    return result.rows.map((row) => ({ revision: row.revision, payload: row.payload, deletedAt: productTime(row.deleted_at), recordedAt: productTime(row.recorded_at) }));
  }
}
