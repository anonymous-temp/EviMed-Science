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

  /** Create a bounded batch with its history in one transaction. No partial import is observable.
   * @param {string} userId @param {{kind:string,id:string,payload:Record<string,any>,projectId?:string|null}[]} records
   * @param {{guards?:{userId:string,kind:string,id:string,filter:Record<string,any>}[],accountCreatedAt?:string}} options */
  async createBatch(userId, records, { guards = [], accountCreatedAt } = {}) {
    productId(userId, "user");
    if (!Array.isArray(records) || records.length < 1 || records.length > 257) throw new HttpError(400, "product_batch_invalid", "Invalid record batch.");
    if (!Array.isArray(guards) || guards.length > 8 || (accountCreatedAt !== undefined && (typeof accountCreatedAt !== "string" || accountCreatedAt.length > 80))) {
      throw new HttpError(400, "product_batch_invalid", "Invalid batch conditions.");
    }
    const conditions = guards.map((guard) => {
      if (!guard || typeof guard !== "object" || Object.keys(guard).some((key) => !["userId", "kind", "id", "filter"].includes(key))) throw new HttpError(400, "product_batch_invalid", "Invalid source condition.");
      const filter = productPayload(guard.filter);
      if (Buffer.byteLength(filter) > 8192) throw new HttpError(400, "product_batch_invalid", "Source condition is too large.");
      const values = [productId(guard.userId, "source owner"), productKind(guard.kind), productId(guard.id), filter];
      return { values, key: JSON.stringify(values.slice(0, 3)) };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const seen = new Set();
    const rows = records.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["kind", "id", "payload", "projectId"].includes(key))) throw new HttpError(400, "product_batch_invalid", "Invalid batch record.");
      const kind = productKind(item.kind);
      const id = productId(item.id);
      const key = JSON.stringify([kind, id]);
      if (seen.has(key)) throw new HttpError(400, "product_batch_invalid", "Duplicate batch record.");
      seen.add(key);
      return { kind, id, payload: JSON.parse(productPayload(item.payload)), project_id: item.projectId == null ? null : productId(item.projectId, "project") };
    });
    const input = JSON.stringify(rows);
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new HttpError(413, "product_batch_too_large", "Record batch exceeds 16 MiB.");
    await migrateProductStore(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${userId}`]);
      if (accountCreatedAt !== undefined) {
        const account = await client.query("SELECT id FROM evimed_control.users WHERE id=$1 AND created_at::text=$2 FOR SHARE", [userId, accountCreatedAt]);
        if (account.rowCount !== 1) throw new HttpError(409, "product_account_changed", "The account changed before import completed.");
      }
      for (const condition of conditions) {
        const source = await client.query(`SELECT id FROM evimed_product.documents
          WHERE user_id=$1 AND kind=$2 AND id=$3 AND deleted_at IS NULL AND payload @> $4::jsonb FOR SHARE`, condition.values);
        if (source.rowCount !== 1) throw new HttpError(409, "product_guard_conflict", "The source changed before import completed.");
      }
      const result = await client.query(`WITH inserted AS (
        INSERT INTO evimed_product.documents(user_id,kind,id,payload,project_id)
        SELECT $1,kind,id,payload,project_id FROM jsonb_to_recordset($2::jsonb) AS x(kind text,id text,payload jsonb,project_id text)
        ON CONFLICT DO NOTHING RETURNING *
      ), history AS (
        INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at)
        SELECT user_id,kind,id,revision,payload,deleted_at FROM inserted RETURNING id
      ) SELECT * FROM inserted`, [userId, input]);
      if (result.rows.length !== rows.length) throw new HttpError(409, "product_revision_conflict", "An imported record already exists.");
      const byKey = new Map(result.rows.map((row) => [JSON.stringify([row.kind, row.id]), record(row)]));
      return rows.map((row) => byKey.get(JSON.stringify([row.kind, row.id])));
    });
  }

  /** @param {string} userId @param {string} kind @param {string} id @param {{ includeDeleted?: boolean }} options */
  async get(userId, kind, id, { includeDeleted = false } = {}) {
    const values = [productId(userId, "user"), productKind(kind), productId(id), includeDeleted];
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND id=$3 AND ($4::boolean OR deleted_at IS NULL)`, values);
    return record(result.rows[0]);
  }

  /** @param {string} userId @param {string} kind
   * @param {{ limit?: number, cursor?: string|null, projectId?: string|null, filter?: Record<string,any>, deleted?: boolean }} options */
  async list(userId, kind, { limit = 50, cursor = null, projectId = undefined, filter = {}, deleted = false } = {}) {
    productInteger(limit, 1, 100);
    if (typeof deleted !== "boolean") throw new HttpError(400, "product_filter_invalid", "Invalid deletion filter.");
    const filterJson = productPayload(filter);
    if (Buffer.byteLength(filterJson) > 8192) throw new HttpError(400, "product_filter_invalid", "The record filter is too large.");
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
      WHERE user_id=$1 AND kind=$2 AND (deleted_at IS NOT NULL)=$9::boolean
      AND (NOT $3::boolean OR project_id IS NOT DISTINCT FROM $4::text)
      AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text)) AND payload @> $8::jsonb
      ORDER BY created_at DESC,id DESC LIMIT $7`,
    [productId(userId, "user"), productKind(kind), projectId !== undefined, projectId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, filterJson, deleted]);
    const items = result.rows.slice(0, limit).map(record);
    const last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") : null };
  }

  /** Bounded lexical fallback; semantic retrieval can enrich it without weakening ownership.
   * @param {string} userId @param {string} kind @param {string} query
   * @param {{ limit?: number, filter?: Record<string,any>, since?: string|null, any?: { field: string, values: string[] } }} options */
  async search(userId, kind, query, { limit = 20, filter = {}, since = null, any = { field: "", values: [] } } = {}) {
    if (since != null && (typeof since !== "string" || since.length > 40 || !Number.isFinite(Date.parse(since)))) throw new HttpError(400, "product_filter_invalid", "Invalid record date.");
    if (typeof any?.field !== "string" || any.field.length > 80 || !Array.isArray(any.values) || any.values.length > 100
      || any.values.some((value) => typeof value !== "string" || value.length > 200)) throw new HttpError(400, "product_filter_invalid", "Invalid record filter.");
    productInteger(limit, 1, 100);
    if (typeof query !== "string" || query.length > 2000) throw new HttpError(400, "product_query_invalid", "Invalid record query.");
    const filterJson = productPayload(filter);
    if (Buffer.byteLength(filterJson) > 8192) throw new HttpError(400, "product_filter_invalid", "The record filter is too large.");
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND deleted_at IS NULL AND payload @> $3::jsonb
      AND strpos(lower(coalesce(payload->>'content','')),lower($4))>0
      AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
      AND (cardinality($8::text[])=0 OR payload->>$7::text=ANY($8::text[]))
      ORDER BY updated_at DESC,id DESC LIMIT $5`,
    [productId(userId, "user"), productKind(kind), filterJson, query, limit, since, any.field, any.values]);
    return result.rows.map(record);
  }

  /** expectedRevision=0 creates; every update names the version the caller read.
   * @param {string} userId @param {string} kind @param {string} id @param {Record<string,any>} payload
   * @param {{ expectedRevision: number, projectId?: string|null, transactionClient?: any }} options */
  async put(userId, kind, id, payload, { expectedRevision, projectId = null, transactionClient = null }) {
    const values = [productId(userId, "user"), productKind(kind), productId(id), productPayload(payload)];
    productInteger(expectedRevision, 0, 2_147_483_646);
    if (projectId != null) productId(projectId, "project");
    if (!transactionClient) await migrateProductStore(this.database);
    const operation = async (client) => {
      const result = expectedRevision === 0
        ? await client.query(`INSERT INTO evimed_product.documents(user_id,kind,id,payload,project_id)
            VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING *`, [...values, projectId])
        : await client.query(`UPDATE evimed_product.documents SET payload=$4::jsonb,revision=revision+1,updated_at=clock_timestamp()
            WHERE user_id=$1 AND kind=$2 AND id=$3 AND revision=$5 AND deleted_at IS NULL RETURNING *`, [...values, expectedRevision]);
      if (!result.rows[0]) throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
      await saveRevision(client, result.rows[0]);
      return record(result.rows[0]);
    };
    return transactionClient ? operation(transactionClient) : this.database.transaction(operation);
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
