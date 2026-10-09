import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
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
  auth_type text NOT NULL CHECK (auth_type IN ('local', 'oidc', 'development', 'evimed', 'subject')),
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

-- 2026-10-09 (design reference N-14). A conversation can be limited to some of the knowledge base's documents (the
-- ones the researcher brought into it from the knowledge base): their ids, or null for all of them. It belongs to the
-- conversation, so a reload, a second window and the runtime all see the same scope.
ALTER TABLE ${schema}.research_sessions ADD COLUMN IF NOT EXISTS source_scope jsonb;
ALTER TABLE ${schema}.research_sessions ADD COLUMN IF NOT EXISTS origin_reference jsonb;

-- 2026-09-18 (contract C4). A project can be archived rather than deleted:
-- out of the way, still whole, still exportable.
ALTER TABLE ${schema}.projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- The seeded default was named in English, the first thing under the wordmark
-- of a Chinese product (B §2). Renamed once: a researcher who has renamed it
-- since no longer matches, and one who later names it "Default Project" on
-- purpose is not renamed again, because version 2 is recorded.
DO $default_project_name$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ${schema}.schema_migrations WHERE version = 2) THEN
    UPDATE ${schema}.projects SET name = '我的研究', updated_at = now()
     WHERE id = 'default' AND name = 'Default Project';
    INSERT INTO ${schema}.schema_migrations(version) VALUES (2) ON CONFLICT (version) DO NOTHING;
  END IF;
END $default_project_name$;

-- 2026-09-26 (fusion plan section 9.2). A Science account provisioned from an
-- EviMed shell session authenticates by neither a password of ours nor an OIDC
-- provider, so it carries an auth_type of its own. The kind is recorded rather
-- than folded into 'oidc' because step two of the same plan moves these
-- accounts to real OIDC, and that migration has to be able to find them.
--
-- Written as a drop-and-add rather than under a version guard: the statement is
-- the constraint this build requires, and a database whose constraint is wrong
-- for any reason is repaired by starting. The table holds one row per account,
-- so revalidating it costs nothing.
--
-- 2026-09-27: 'subject' is the account an integration key makes for one person
-- behind an institution (agentApiKeys.mjs, subjectAccount) — no password, no
-- identity provider, reached only through that institution's key.
-- 2026-10-05: 'platform' is the one account that belongs to no person (below).
ALTER TABLE ${schema}.users DROP CONSTRAINT IF EXISTS users_auth_type_check;
ALTER TABLE ${schema}.users ADD CONSTRAINT users_auth_type_check
  CHECK (auth_type IN ('local', 'oidc', 'development', 'evimed', 'subject', 'platform'));

INSERT INTO ${schema}.schema_migrations(version) VALUES (3)
ON CONFLICT (version) DO NOTHING;

-- 2026-09-28 (fusion backend requirements section 14). EviMed's credits
-- service charges and reads the balance of EviMed's own user, and the account
-- id here is a one-way hash of that user, so a deduction naming it named nobody
-- EviMed knows. The account row therefore keeps EviMed's own id, written from
-- the introspection answer at every session exchange (so an account created
-- before this column fills itself in at its next sign-in), and read by the
-- credits client alone. It is a column of the account and nothing else: no run
-- ledger, workspace file or log line carries it. Only an 'evimed' account may
-- hold one, and the bound matches what the introspection reader keeps.
ALTER TABLE ${schema}.users ADD COLUMN IF NOT EXISTS evimed_user_id text;
ALTER TABLE ${schema}.users DROP CONSTRAINT IF EXISTS users_evimed_user_id_check;
ALTER TABLE ${schema}.users ADD CONSTRAINT users_evimed_user_id_check
  CHECK (evimed_user_id IS NULL OR (auth_type = 'evimed' AND char_length(evimed_user_id) BETWEEN 1 AND 128));

INSERT INTO ${schema}.schema_migrations(version) VALUES (4)
ON CONFLICT (version) DO NOTHING;

-- 2026-10-05 (evidence-flywheel plan §3.3, B2). The platform's own publishing
-- account, 「EviMed 证据中心」: the owner of every official evidence zone and of
-- the platform programme's internal project. Until now the official zones were
-- owned by whichever operator the importer named, and the zone and card tables
-- reference the account with ON DELETE CASCADE, so deleting that person deleted
-- the platform's published evidence with them.
--
-- It cannot sign in or be reached by any credential: no password, no identity
-- provider, an auth type of its own that every sign-in path refuses
-- (store.mjs), and two constraints that keep the rule where code cannot forget
-- it — only this id may have that type, and this id may have no other type, so
-- a registration, an OIDC subject or an integration key that arrived at the same
-- id is refused by the database. The id and the name are the domain's
-- (@evimed/domain platformAccount.mjs), written here once because this SQL runs
-- before any code can; the test that holds them together is
-- platformPublisherAccount.integration.test.mjs.
--
-- Idempotent, and safe on a database that already holds release data: a row
-- already there with this id and any other type is a person who registered it
-- first, and that is named rather than overwritten — the migration stops with
-- platform_account_id_taken and the deployment says why it is not ready.
DO $platform_account$
BEGIN
  IF EXISTS (SELECT 1 FROM ${schema}.users WHERE lower(id) = 'evimed-evidence-center' AND auth_type <> 'platform') THEN
    RAISE EXCEPTION 'platform_account_id_taken: an account already holds the platform publisher id'
      USING ERRCODE = '23514';
  END IF;
END $platform_account$;
ALTER TABLE ${schema}.users DROP CONSTRAINT IF EXISTS users_platform_account_check;
ALTER TABLE ${schema}.users ADD CONSTRAINT users_platform_account_check
  CHECK (CASE WHEN auth_type = 'platform'
    THEN id = 'evimed-evidence-center' AND password_hash IS NULL
    ELSE lower(id) <> 'evimed-evidence-center' END);
INSERT INTO ${schema}.users(id, name, password_hash, auth_type)
VALUES ('evimed-evidence-center', 'EviMed 证据中心', NULL, 'platform')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  WHERE ${schema}.users.auth_type = 'platform' AND ${schema}.users.name <> EXCLUDED.name;
DELETE FROM ${schema}.deleted_users WHERE id = 'evimed-evidence-center';

INSERT INTO ${schema}.schema_migrations(version) VALUES (5)
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
    this.transactionClients = new AsyncLocalStorage();
    this.atomicTransactions = new AsyncLocalStorage();
    this.checkedOutClients = new WeakSet();
    this.savepointSequence = 0;
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

  /** A client is only guarded against connection loss while it sits idle in the
   *  pool: pg moves its own error listener off on checkout and back on release.
   *  In between, a dropped connection emits "error" on a Client nobody listens
   *  to, and an EventEmitter with no error listener throws — which killed the
   *  API process in production with "Unhandled 'error' event ... Emitted 'error'
   *  event on Client instance", mid-migration, taking every in-flight request
   *  with it. The checked-out window needs its own listener; the query already
   *  in flight rejects on its own and carries the real failure.
   *  @param {(client: Record<string, any>) => Promise<any>} operation */
  async withClient(operation) {
    const scoped = this.transactionScope();
    if (scoped) return this.trackScoped(scoped, Promise.resolve().then(() => operation(scoped.client)));
    const client = await this.pool.connect();
    this.checkedOutClients.add(client);
    const absorb = (error) => {
      process.stderr.write(
        `control-plane database client error: ${error?.code ?? "unknown"} ${error?.message ?? error}\n`,
      );
    };
    client.on("error", absorb);
    try {
      return await operation(client);
    } finally {
      client.off("error", absorb);
      this.checkedOutClients.delete(client);
      client.release();
    }
  }

  async migrate() {
    if (this.ready) return this.ready;
    // Everything that can fail belongs inside the promise whose rejection clears
    // the cache. pool.connect() used to sit outside it, so a database that was
    // still starting — 57P03, "the database system is not yet accepting
    // connections" — stored a rejected promise in this.ready that no later call
    // could ever displace: `if (this.ready) return this.ready` handed the same
    // dead rejection to every request from then on. Production spent two days
    // refusing every login with a database that had been accepting connections
    // the whole time, and only a process restart could clear it.
    const attempt = (async () => {
      try {
        return await this.withClient(async (client) => {
          try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-science-control-plane-v1'))");
            await client.query(migrationSql);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
          return true;
        });
      } catch (error) {
        if (this.ready === attempt) this.ready = null;
        throw error;
      }
    })();
    this.ready = attempt;
    return this.ready;
  }

  async query(text, values = []) {
    const scoped = this.transactionScope();
    if (scoped) return this.enqueueScoped(scoped, this.atomicTransactions.getStore() ?? scoped, () => scoped.client.query(text, values));
    await this.migrate();
    return this.pool.query(text, values);
  }

  async transaction(operation) {
    const scoped = this.transactionScope();
    if (scoped) {
      const enclosing = this.atomicTransactions.getStore();
      const run = async () => {
        const name = `evimed_scoped_${++this.savepointSequence}`;
        const atomic = { scope: scoped, open: true, serial: Promise.resolve() };
        await scoped.client.query(`SAVEPOINT ${name}`);
        try {
          const result = await this.atomicTransactions.run(atomic, () => operation(scoped.client));
          atomic.open = false;
          await atomic.serial;
          await scoped.client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          atomic.open = false;
          await atomic.serial;
          await scoped.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
          await scoped.client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
          throw error;
        } finally { atomic.open = false; }
      };
      // Peers serialize at each nesting level. Reentrant transactions use
      // their parent's queue, not the queue currently waiting for that parent.
      return this.enqueueScoped(scoped, enclosing ?? scoped, run);
    }
    await this.migrate();
    return this.withClient(async (client) => {
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  /** @returns {any} Only an open owned scope, including admitted atomic work draining at close. */
  transactionScope() {
    const scoped = this.transactionClients.getStore();
    if (!scoped) return null;
    const atomic = this.atomicTransactions.getStore();
    if ((atomic && !atomic.open) || (!scoped.open && !(scoped.draining && atomic?.scope === scoped && atomic.open))) {
      throw new HttpError(409, "product_revision_conflict", "The database transaction scope has ended; admit the operation again.");
    }
    return scoped;
  }
  /** @param {any} scoped @param {Promise<any>} pending */
  trackScoped(scoped, pending) {
    scoped.borrowers.add(pending);
    pending.then(() => scoped.borrowers.delete(pending), () => scoped.borrowers.delete(pending));
    return pending;
  }
  /** @param {any} scoped @param {any} holder @param {()=>Promise<any>} operation */
  enqueueScoped(scoped, holder, operation) {
    const pending = holder.serial.catch(() => {}).then(operation);
    holder.serial = pending.then(() => undefined, () => undefined);
    return this.trackScoped(scoped, pending);
  }
  /** Trusted held-client scope; every borrower settles before the owner may release it.
   * Detached callbacks retain a closed context and fail, rather than bypassing a fence through a fresh checkout.
   * @param {any} client @param {()=>Promise<any>} work */
  async withTransactionClient(client, work) {
    if (!this.checkedOutClients.has(client)) throw new HttpError(409, "product_revision_conflict", "The database client is not owned by this transaction.");
    const existing = this.transactionClients.getStore();
    if (existing) {
      this.transactionScope();
      if (existing.client !== client) throw new HttpError(409, "product_revision_conflict", "The database transaction client changed.");
      return this.trackScoped(existing, Promise.resolve().then(work));
    }
    const scoped = { client, open: true, draining: false, borrowers: new Set(), serial: Promise.resolve() };
    try { return await this.transactionClients.run(scoped, work); }
    finally {
      scoped.open = false; scoped.draining = true;
      while (scoped.borrowers.size) await Promise.allSettled([...scoped.borrowers]);
      scoped.draining = false;
    }
  }
  /** Explicitly independent work must perform its own admission; never a customer-selectable bypass.
   * @param {()=>any} work */
  withoutTransactionClient(work) { return this.transactionClients.run(undefined, () => this.atomicTransactions.run(undefined, work)); }

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
/** The migration version this build writes last, and the one readiness
 *  requires: 5 since the platform publisher account exists (2026-10-05);
 *  4 since an `evimed` account keeps EviMed's own user id for the
 *  credits client (2026-09-28); 3 was the `evimed` account kind (2026-09-26);
 *  2 was the project archive column and the default-name migration
 *  (2026-09-18). */
export const CONTROL_PLANE_SCHEMA_VERSION = 5;
