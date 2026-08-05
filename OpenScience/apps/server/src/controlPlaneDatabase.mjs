import pg from "pg";
import { HttpError } from "./security.mjs";

const { Pool } = pg;
const schema = "evimed_control";

const migrationSql = `
CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${schema}.users (
  id text PRIMARY KEY,
  name text NOT NULL,
  password_hash text,
  auth_type text NOT NULL CHECK (auth_type IN ('local', 'oidc', 'development')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_type = 'local' AND password_hash IS NOT NULL) OR auth_type <> 'local')
);

CREATE TABLE IF NOT EXISTS ${schema}.deleted_users (
  id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${schema}.auth_sessions (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON ${schema}.auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON ${schema}.auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS ${schema}.projects (
  user_id text NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  active_workspace text NOT NULL DEFAULT '',
  quota_bytes bigint NOT NULL CHECK (quota_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS ${schema}.research_sessions (
  user_id text NOT NULL,
  project_id text NOT NULL,
  session_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('open-domain', 'specialist')),
  agent_id text,
  agent_version text,
  runtime_agent text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, project_id, session_id),
  FOREIGN KEY (user_id, project_id) REFERENCES ${schema}.projects(user_id, id) ON DELETE CASCADE,
  CHECK (
    (mode = 'open-domain' AND agent_id IS NULL AND agent_version IS NULL AND runtime_agent IS NULL)
    OR
    (mode = 'specialist' AND agent_id IS NOT NULL AND agent_version IS NOT NULL AND runtime_agent IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS research_sessions_updated_at_idx
  ON ${schema}.research_sessions(user_id, project_id, updated_at DESC);

INSERT INTO ${schema}.schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
`;

/** @returns {Error & Record<string, any>} An Error carrying the extra fields its
 *  callers read; a bare Error type rejects every one of them. */
function configurationError(code, message) {
  return new HttpError(503, code, message);
}

export class ControlPlaneDatabase {
  /** @param {Record<string, any>} config @param {Record<string, any>} options */
  constructor(config, { pool } = {}) {
    if (config.databaseUrlError) {
      throw configurationError(config.databaseUrlError, "The control-plane database secret is unavailable.");
    }
    if (!pool && !config.databaseUrl) {
      throw configurationError("database_url_missing", "The PostgreSQL control-plane database is not configured.");
    }
    const max = Number(config.databasePoolMax);
    const connectionTimeoutMillis = Number(config.databaseConnectionTimeoutMs);
    if (!Number.isSafeInteger(max) || max < 1 || max > 100) {
      throw configurationError("database_pool_invalid", "The PostgreSQL pool size is invalid.");
    }
    if (!Number.isSafeInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 120_000) {
      throw configurationError("database_timeout_invalid", "The PostgreSQL connection timeout is invalid.");
    }
    this.pool = pool ?? new Pool({
      connectionString: config.databaseUrl,
      max,
      connectionTimeoutMillis,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      application_name: "evimed-science-control-plane",
    });
    this.ownsPool = !pool;
    this.ready = null;
    // An idle client losing its connection is routine — a TCP timeout, a
    // database restart, a network blip — and pg reports it by emitting "error"
    // on the pool. An EventEmitter with no error listener throws, so this took
    // the whole API process down in production: "Unhandled 'error' event ...
    // Connection terminated unexpectedly", container restart count 1, and then
    // a readiness check stuck on 57P03 while a fresh client connected fine.
    //
    // The pool discards the broken client on its own. What it needed was
    // somewhere for the error to go, and for the migration promise to be
    // dropped so the next query re-establishes rather than trusting a
    // connection that has already died.
    this.pool.on("error", (error) => {
      this.ready = null;
      process.stderr.write(
        `control-plane database pool error: ${error?.code ?? "unknown"} ${error?.message ?? error}\n`,
      );
    });
  }

  async migrate() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-science-control-plane-v1'))");
        await client.query(migrationSql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        this.ready = null;
        throw error;
      } finally {
        client.release();
      }
      return true;
    })();
    return this.ready;
  }

  async query(text, values = []) {
    await this.migrate();
    return this.pool.query(text, values);
  }

  async transaction(operation) {
    await this.migrate();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    const result = await this.query(
      `SELECT current_database() AS database, (SELECT max(version) FROM ${schema}.schema_migrations) AS version`,
    );
    return { database: result.rows[0]?.database ?? null, schemaVersion: Number(result.rows[0]?.version ?? 0) };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export const CONTROL_PLANE_SCHEMA = schema;
