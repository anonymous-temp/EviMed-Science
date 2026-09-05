import { HttpError } from "./security.mjs";

export const PRODUCT_KINDS = Object.freeze([
  "capsule", "fact", "method", "source", "source-unit", "knowledge", "profile",
  "agenda", "episode", "notification", "preferences", "plugin", "price-list",
]);
export const PRODUCT_JOB_KINDS = Object.freeze(["ingest", "distill", "consolidate", "episode", "verify", "digest", "notify"]);
const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_product;
CREATE TABLE IF NOT EXISTS evimed_product.documents (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (${PRODUCT_KINDS.map((x) => `'${x}'`).join(",")})),
  id text NOT NULL,
  project_id text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz(3),
  PRIMARY KEY (user_id, kind, id),
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_documents_list_idx ON evimed_product.documents
  (user_id,kind,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_documents_project_idx ON evimed_product.documents
  (user_id,project_id,kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_documents_project_fk_idx ON evimed_product.documents(user_id,project_id);
CREATE TABLE IF NOT EXISTS evimed_product.revisions (
  user_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  deleted_at timestamptz(3),
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,kind,id,revision),
  FOREIGN KEY (user_id,kind,id) REFERENCES evimed_product.documents(user_id,kind,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS evimed_product.jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  kind text NOT NULL CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")})),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  result jsonb,
  error jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz(3),
  UNIQUE(user_id,idempotency_key),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_jobs_claim_idx ON evimed_product.jobs(kind,run_after,id)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS product_jobs_owner_idx ON evimed_product.jobs(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS product_jobs_project_fk_idx ON evimed_product.jobs(user_id,project_id);
CREATE INDEX IF NOT EXISTS product_jobs_queued_time_idx ON evimed_product.jobs(kind,run_after,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS product_jobs_running_lease_idx ON evimed_product.jobs(kind,lease_expires_at,id) WHERE status='running';
`;

/** Idempotent across processes; only the control-plane connection performs DDL.
 * @param {any} database */
export async function migrateProductStore(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-product-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/** @param {unknown} value @param {string} field @returns {string} */
export function productId(value, field = "id") {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || [...value].some((char) => char.charCodeAt(0) < 32)) {
    throw new HttpError(400, "product_identifier_invalid", `Invalid ${field}.`);
  }
  return value;
}

/** @param {unknown} value @param {readonly string[]} allowed @returns {string} */
export function productKind(value, allowed = PRODUCT_KINDS) {
  if (!allowed.includes(String(value))) throw new HttpError(400, "product_kind_invalid", "Unknown product record kind.");
  return String(value);
}

/** @param {unknown} value @returns {string} */
export function productPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "product_document_invalid", "A product record must be an object.");
  }
  let text;
  try { text = JSON.stringify(value); }
  catch { throw new HttpError(400, "product_document_invalid", "A product record must contain serializable JSON."); }
  if (Buffer.byteLength(text) > 262_144) throw new HttpError(413, "product_document_too_large", "A product record exceeds 256 KiB.");
  return text;
}

/** @param {unknown} value @param {number} min @param {number} max @returns {number} */
export function productInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, "product_parameter_invalid", `Expected an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

/** @param {any} value @returns {string | null} */
export function productTime(value) { return value == null ? null : new Date(value).toISOString(); }
