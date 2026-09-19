/**
 * A researcher's own credentials for the external data sources.
 *
 * The public-source gateway injects one credential per profile, server-side,
 * from the deployment's configuration — the runtime never carries a key. That
 * leaves a source the deployment has not configured (OpenGWAS is the standing
 * example: its token belongs to a person and expires every fourteen days)
 * refusing every run with `..._credential_missing`, and nothing the researcher
 * could do about it. This store is what they can do about it: a credential
 * they hold, saved once from the account page, encrypted at rest, resolved by
 * the gateway only for their own runs, and only where the deployment has none.
 *
 * Precedence is deployment first, then the researcher. A deployment that has
 * configured a source has decided how that source is reached; a personal key
 * is the fallback, never an override.
 *
 * At rest: AES-256-GCM under a key derived from the model-gateway signing
 * secret with HKDF and a purpose string of its own, so no new secret has to
 * exist for this, and the derived key is useless for anything else. The AAD
 * binds each ciphertext to its owner and connector, so a row moved between
 * users or connectors fails to open. Values never enter logs, audit lines or
 * API responses: status is reported as a source, never as a value.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { CONNECTOR_CREDENTIALS, connectorDeploymentSource, validateConnectorCredentialValue } from "@evimed/domain";

import { HttpError, sendError, sendJson } from "./security.mjs";

const SCHEMA = "evimed_control";
const HKDF_INFO = "evimed-user-connector-credentials-v1";
const KEY_BYTES = 32;

const migrationSql = `
CREATE TABLE IF NOT EXISTS ${SCHEMA}.user_connector_credentials (
  user_id text NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
  connector text NOT NULL CHECK (length(connector) BETWEEN 1 AND 64),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  tag bytea NOT NULL,
  expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, connector)
);
`;

/** @param {string} value */
function assertSafeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new HttpError(400, "invalid_payload", `${label} is invalid.`);
  }
  return value;
}

export class ConnectorCredentialStore {
  /**
   * @param {{ database: { query(text: string, values?: unknown[]): Promise<{ rows: any[], rowCount: number | null }> },
   *   secret: string, config: Record<string, any>, now?: () => Date }} input
   */
  constructor({ database, secret, config, now = () => new Date() }) {
    if (typeof secret !== "string" || secret.length < 32) throw new TypeError("Connector credential store secret is invalid.");
    this.database = database;
    this.config = config;
    this.now = now;
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES));
  }

  async migrate() {
    await this.database.query(migrationSql);
  }

  /**
   * Whether the deployment itself holds a credential for the connector: the
   * decision a personal credential defers to.
   * @param {string} connector
   */
  deploymentConfigured(connector) {
    const source = connectorDeploymentSource(connector);
    if (!source) return false;
    const value = "configValue" in source
      ? this.config[source.configValue]
      : this.config.publicSourceCredentials?.[source.configKey];
    return typeof value === "string" && value.trim().length > 0;
  }

  /**
   * Every connector, with where its credential comes from for this user and
   * never with the credential itself.
   * @param {string} userId
   */
  async status(userId) {
    assertSafeId(userId, "user id");
    const { rows } = await this.database.query(
      `SELECT connector, expires_at, updated_at FROM ${SCHEMA}.user_connector_credentials WHERE user_id = $1`,
      [userId],
    );
    const own = new Map(rows.map((row) => [String(row.connector), row]));
    return CONNECTOR_CREDENTIALS.map((spec) => {
      const row = own.get(spec.id);
      const expiresAt = row?.expires_at ? new Date(row.expires_at).toISOString() : null;
      const expired = expiresAt != null && Date.parse(expiresAt) < this.now().getTime();
      const source = this.deploymentConfigured(spec.id) ? "deployment" : row && !expired ? "user" : "none";
      return {
        id: spec.id,
        title: spec.title,
        kind: spec.kind,
        unlocks: spec.unlocks,
        obtainUrl: spec.obtainUrl,
        capabilities: [...spec.capabilities],
        keyless: spec.keyless,
        validityDays: spec.validityDays ?? null,
        source,
        // The deployment's credential is the deployment's business; a
        // researcher's own row is reported whichever source wins, so they can
        // see and remove it.
        own: row ? { updatedAt: new Date(row.updated_at).toISOString(), expiresAt, expired } : null,
        // What the login prompt asks about: nothing serves this source for the
        // researcher, and it is not one that works without a key.
        needsAttention: source === "none" && !spec.keyless,
      };
    });
  }

  /**
   * @param {string} userId @param {string} connector @param {unknown} value
   * @returns {Promise<{ connector: string, expiresAt: string | null }>}
   */
  async set(userId, connector, value) {
    assertSafeId(userId, "user id");
    const checked = validateConnectorCredentialValue(connector, value);
    if (checked.ok !== true) throw new HttpError(400, "connector_credential_invalid", `The credential was not accepted: ${checked.reason}.`);
    await this.#store(userId, connector, String(value).trim(), checked.expiresAt);
    return { connector, expiresAt: checked.expiresAt };
  }

  /** @param {string} userId @param {string} connector @returns {Promise<boolean>} */
  async remove(userId, connector) {
    assertSafeId(userId, "user id");
    assertSafeId(connector, "connector");
    const result = await this.database.query(
      `DELETE FROM ${SCHEMA}.user_connector_credentials WHERE user_id = $1 AND connector = $2`,
      [userId, connector],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The researcher's own credential for a connector, or null. Expired rows
   * resolve to null rather than to a token the upstream will refuse.
   * @param {string} userId @param {string} connector @returns {Promise<string | null>}
   */
  async resolveOwn(userId, connector) {
    assertSafeId(userId, "user id");
    assertSafeId(connector, "connector");
    return this.#open(userId, connector);
  }

  /**
   * A secret the control plane holds for a messaging channel: a Feishu bot's
   * App Secret, a device's push token.
   *
   * Same table, same cipher, same AAD rule as a data-source credential: the
   * plan puts channel credentials in the existing per-user encrypted store
   * (§3.6), and a second store would be a second key to rotate. What keeps it
   * apart is the connector id: every
   * one starts `channel.`, which no `CONNECTOR_CREDENTIALS` entry does, so
   * `status()` never lists it, the connectors route refuses it by name, and the
   * workload gateway — the one path a runtime has into this store — answers
   * `connector_unknown`, because `connectorDeploymentSource` knows no such id.
   * A runtime can never read a bot's secret.
   * @param {string} userId @param {string} connector `channel.<id>` or `channel.<id>.<suffix>`
   * @param {unknown} value
   */
  async setChannelSecret(userId, connector, value) {
    assertSafeId(userId, "user id");
    assertChannelConnector(connector);
    const secret = typeof value === "string" ? value.trim() : "";
    if (!secret || secret.length > 4096 || [...secret].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new HttpError(400, "channel_secret_invalid", "The channel credential is not a usable value.");
    }
    await this.#store(userId, connector, secret, null);
  }

  /** @param {string} userId @param {string} connector @returns {Promise<string | null>} */
  async resolveChannelSecret(userId, connector) {
    assertSafeId(userId, "user id");
    assertChannelConnector(connector);
    return this.#open(userId, connector);
  }

  /** @param {string} userId @param {string} connector @returns {Promise<boolean>} */
  async removeChannelSecret(userId, connector) {
    assertSafeId(userId, "user id");
    assertChannelConnector(connector);
    const result = await this.database.query(
      `DELETE FROM ${SCHEMA}.user_connector_credentials WHERE user_id = $1 AND connector = $2`,
      [userId, connector],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** @param {string} userId @param {string} connector @param {string} value @param {string | null} expiresAt */
  async #store(userId, connector, value, expiresAt) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad(userId, connector));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    await this.database.query(
      `INSERT INTO ${SCHEMA}.user_connector_credentials (user_id, connector, ciphertext, nonce, tag, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, connector) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, tag = EXCLUDED.tag,
               expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()`,
      [userId, connector, ciphertext, nonce, tag, expiresAt],
    );
  }

  /** @param {string} userId @param {string} connector @returns {Promise<string | null>} */
  async #open(userId, connector) {
    const { rows } = await this.database.query(
      `SELECT ciphertext, nonce, tag, expires_at FROM ${SCHEMA}.user_connector_credentials WHERE user_id = $1 AND connector = $2`,
      [userId, connector],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < this.now().getTime()) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.nonce));
    decipher.setAAD(aad(userId, connector));
    decipher.setAuthTag(Buffer.from(row.tag));
    try {
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
    } catch {
      // A row that does not open under its own owner and connector is not a
      // credential; it is a row that was moved or a key that was rotated.
      return null;
    }
  }

  /**
   * The credential a run for this user should use: the deployment's when it
   * has one, else the researcher's own, else nothing.
   * @param {string} userId @param {string} connector
   * @returns {Promise<{ value: string, source: "deployment" | "user" } | null>}
   */
  async resolve(userId, connector) {
    const source = connectorDeploymentSource(connector);
    if (!source) return null;
    const deployment = "configValue" in source
      ? this.config[source.configValue]
      : this.config.publicSourceCredentials?.[source.configKey];
    if (typeof deployment === "string" && deployment.trim()) return { value: deployment.trim(), source: "deployment" };
    const own = await this.resolveOwn(userId, connector);
    return own ? { value: own, source: "user" } : null;
  }
}

/** @param {string} userId @param {string} connector */
function aad(userId, connector) {
  return Buffer.from(`${HKDF_INFO}\0${userId}\0${connector}`, "utf8");
}

/** The id a channel secret is held under: `channel.<channel id>` plus an
 *  optional per-binding suffix (one push token per device). Bounded so the
 *  whole id fits the table's 64-character connector column.
 *  @param {string} channel @param {string} [suffix] */
export function channelCredentialConnector(channel, suffix = "") {
  return suffix ? `channel.${channel}.${suffix}` : `channel.${channel}`;
}

/** @param {unknown} connector */
function assertChannelConnector(connector) {
  if (typeof connector !== "string" || !/^channel\.[a-z][a-z-]{0,15}(?:\.[A-Za-z0-9_-]{1,32})?$/.test(connector)) {
    throw new HttpError(400, "channel_connector_invalid", "The channel credential reference is invalid.");
  }
}

/** Where an adapter asks for the credential a job should run with. */
export const CONNECTOR_CREDENTIAL_GATEWAY_PATH = "/internal/connectors/v1/credential";

/**
 * The connectors a specialist job may be handed a credential for: what the
 * adapters actually ask for (`_JOB_CONNECTOR_ENV` in the specialist adapter's
 * service.py — OpenGWAS for the MR engine, nothing else). Any other connector's
 * credential is injected by the public-source gateway server-side and never
 * leaves the control plane. Found 2026-09-20 in the release's security review:
 * answering every connector let any active runtime token read the deployment's
 * licensed keys (UMLS, OMIM, NCBI, …) — a runtime's token is a file the run
 * can print.
 */
export const JOB_SCOPED_CONNECTORS = Object.freeze(new Set(["opengwas"]));

/**
 * The credential a specialist adapter should use for one job, resolved for
 * the workload that asked.
 *
 * The MR adapter reads OpenGWAS itself, outside the public-source gateway, so
 * the gateway's fallback never reaches it. It asks here instead, with the
 * same workload token the runtime handed it — the token names the user, the
 * control plane holds their credential, and the adapter passes the value to
 * that one job's process environment and nowhere else. The answer carries the
 * deployment's credential when there is one, for the same precedence the
 * gateway applies; the adapter does not have to know which it got.
 *
 * @param {{ runtimeManager: any, store: ConnectorCredentialStore | null }} input
 */
export function createConnectorCredentialGatewayHandler({ runtimeManager, store }) {
  /** @param {any} req @param {any} res @param {(failure: any) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      if (req.method !== "GET" || url.pathname !== CONNECTOR_CREDENTIAL_GATEWAY_PATH) {
        throw new HttpError(404, "not_found", "Connector credential operation not found.");
      }
      const connector = url.searchParams.get("connector") ?? "";
      if (!connectorDeploymentSource(connector)) {
        throw new HttpError(400, "connector_unknown", "The connector is not one a credential can be held for.");
      }
      if (!JOB_SCOPED_CONNECTORS.has(connector)) {
        throw new HttpError(403, "connector_not_job_scoped", "This connector's credential is used by the gateway, not handed to a job.");
      }
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      let identity;
      try { identity = await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable."); }
      if (!store) throw new HttpError(503, "connector_credentials_unavailable", "Connector credentials are not available on this deployment.");
      const resolved = await store.resolve(identity.userId, connector);
      if (!resolved) throw new HttpError(404, "connector_credential_missing", "No credential is configured for this connector.");
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, { data: { connector, source: resolved.source, value: resolved.value } });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "connector_credentials_unavailable", "Connector credentials are unavailable.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
