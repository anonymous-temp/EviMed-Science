import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from './security.mjs';
import { readResearchDbKeyring } from './researchDbKeyring.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';
import { researchDbHostName } from './researchDbNetwork.mjs';

const invalid = () => new HttpError(400, 'research_db_connection_invalid', 'The database connection is invalid.');
const unavailable = () => new HttpError(503, 'research_db_connection_unavailable', 'The database connection is unavailable.');
const conflict = () => new HttpError(409, 'research_db_request_conflict', 'This request ID was already used for a different request.');
const connectionFields = ['host', 'port', 'database', 'username', 'password'];
/** @param {unknown} value */
export function researchDbRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) throw new HttpError(400, 'research_db_request_invalid', 'A stable request ID is required.');
  return value;
}
/** @param {any} value */
export function researchDbSnapshotFingerprint(value) {
  return createHash('sha256').update(JSON.stringify([value.connectionId, value.agendaId, value.schema, value.table, value.columns])).digest('hex');
}
/** The isolated test injection: only under NODE_ENV=test, with an explicit flag and a fixture key.
 * @param {{environment:string|undefined,testOnly:boolean|undefined,database:any,testKey:unknown,maxConnections?:number}} input */
export function researchDbCredentialsForTest({ environment, testOnly, database, testKey, maxConnections = RESEARCH_DB_LIMIT_DEFAULTS.connections }) {
  return environment === 'test' && testOnly === true && database && typeof testKey === 'string' && testKey.length >= 32
    ? new ResearchDbCredentials(database, { activeId: 'test-v1', keys: { 'test-v1': testKey } }, { maxConnections }) : null;
}
/** The connector's credentials for this process. The test injection is the isolated path above; otherwise the
 * connector exists only when the operator configured both an egress allowlist and an independent keyring file and
 * a product database exists. The keyring is never derived from another secret (the model gateway's, for one): a key
 * that protects database passwords has its own custody, rotation and backup. A keyring that cannot be read leaves the
 * connector unavailable and reports its code (never a path or key material) once.
 * @param {{environment:string|undefined,testOnly:boolean|undefined,database:any,testKey:unknown,keyringFile:string,allow:string,maxConnections?:number,report?:(code:string)=>void}} input */
export function researchDbCredentialsFromConfig({ keyringFile, allow, maxConnections = RESEARCH_DB_LIMIT_DEFAULTS.connections, report = () => {}, ...test }) {
  const injected = researchDbCredentialsForTest({ ...test, maxConnections });
  if (injected) return injected;
  if (!test.database || !keyringFile) return null;
  if (!String(allow ?? '').trim()) { report('research_db_allowlist_missing'); return null; }
  try { return new ResearchDbCredentials(test.database, readResearchDbKeyring(keyringFile), { maxConnections }); }
  catch (error) { report(typeof error?.code === 'string' ? error.code : 'research_db_keyring_unavailable'); return null; }
}
/** @param {any} value */
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...connectionFields].sort().join()) throw invalid();
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw invalid();
  for (const key of ['host', 'database', 'username', 'password']) {
    const item = value[key];
    if (typeof item !== 'string' || !item || Buffer.byteLength(item) > 1024 || [...item].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  }
  // The host is matched, resolved and verified in lower case everywhere (`researchDbHostName`); it is kept that way.
  return /** @type {Record<string, any>} */ ({ ...Object.fromEntries(connectionFields.map(key => [key, value[key]])), host: researchDbHostName(value.host) });
}
/** The ciphertext is bound to the account, project and generated connection identity. */
export class ResearchDbCredentials {
  /** @param {any} database @param {{activeId:string,keys:Record<string,string>}} keyring
   * @param {{maxConnections?:number}} [options] `maxConnections`: saved credentials one project keeps (`OPEN_SCIENCE_RESEARCH_DB_MAX_CONNECTIONS`) */
  constructor(database, keyring, { maxConnections = RESEARCH_DB_LIMIT_DEFAULTS.connections } = {}) {
    this.maxConnections = maxConnections;
    if (!keyring || !/^[a-zA-Z0-9_-]{1,64}$/.test(keyring.activeId) || !keyring.keys || !Object.hasOwn(keyring.keys, keyring.activeId)) throw unavailable();
    this.database = database;
    this.activeId = keyring.activeId;
    this.keys = new Map();
    for (const [id, secret] of Object.entries(keyring.keys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw unavailable();
      this.keys.set(id, Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('evimed-research-db-v1'), 32)));
    }
  }
  async migrate() {
    // `label` is the connection's host and database name, kept beside the sealed credential so the list can name a
    // connection without opening it; it holds no user name or password.
    await this.database.query(`CREATE TABLE IF NOT EXISTS evimed_control.research_db_connections (
      user_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL, label text NOT NULL, ciphertext bytea NOT NULL, nonce bytea NOT NULL, tag bytea NOT NULL, key_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (user_id, project_id, id),
      FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS evimed_control.research_db_requests (
        user_id text NOT NULL, project_id text NOT NULL, request_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('save','snapshot')),
        fingerprint text, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (user_id,project_id,kind,request_id),
        FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE)`);
  }
  /** A key ID the keyring does not hold is never guessed. A deployment must retain every referenced version for as long
   * as a credential sealed under it exists. */
  async assertKeyCoverage() {
    const result = await this.database.query('SELECT DISTINCT key_id FROM evimed_control.research_db_connections');
    if (result.rows.some(row => !this.keys.has(row.key_id))) {
      throw new HttpError(503, 'research_db_keyring_incomplete', 'Database credential keys need operator attention.');
    }
  }
  /** @param {string} user @param {string} project @param {string} id @param {any} value */
  seal(user, project, id, value) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeId), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([user, project, id, this.activeId])));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId: this.activeId };
  }
  /** @param {string} user @param {string} project @param {string} id @param {any} row */
  unseal(user, project, id, row) {
    try {
      const key = this.keys.get(row.key_id); if (!key) throw unavailable();
      const cipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([user, project, id, row.key_id]))); cipher.setAuthTag(row.tag);
      return validate(JSON.parse(Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString('utf8')));
    } catch { throw unavailable(); }
  }
  /** @param {string} user @param {string} project @param {any} input @param {string} requestId */
  async save(user, project, input, requestId) {
    researchDbRequestId(requestId);
    const value = validate(input), id = randomUUID(), sealed = this.seal(user, project, id, value);
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`research-db-limit:${JSON.stringify([user, project])}`]);
      const previous = await client.query("SELECT result FROM evimed_control.research_db_requests WHERE user_id=$1 AND project_id=$2 AND kind='save' AND request_id=$3", [user, project, requestId]);
      if (previous.rows.length) {
        const previousId = previous.rows[0].result.id;
        let original;
        try { original = await this.open(user, project, previousId, client, true); }
        catch (error) { if (error?.code === 'research_db_connection_missing') throw new HttpError(410, 'research_db_connection_revoked', 'The connection saved by this request was removed.'); throw error; }
        const a = Buffer.from(JSON.stringify(original)), b = Buffer.from(JSON.stringify(value));
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw conflict();
        return previousId;
      }
      const count = await client.query('SELECT count(*)::integer AS n FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2', [user, project]);
      if (Number(count.rows[0]?.n) >= this.maxConnections) throw new HttpError(409, 'research_db_connection_limit', 'This project already has the maximum number of database connections.');
      await client.query('INSERT INTO evimed_control.research_db_connections(user_id,project_id,id,label,ciphertext,nonce,tag,key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [user, project, id, `${value.host}/${value.database}`, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId]);
      await client.query("INSERT INTO evimed_control.research_db_requests(user_id,project_id,kind,request_id,result) VALUES($1,$2,'save',$3,$4::jsonb)", [user, project, requestId, JSON.stringify({ id })]);
      return id;
    });
  }
  /** @param {string} user @param {string} project @param {string} requestId @param {string} fingerprint @param {any} [client] */
  async snapshotResult(user, project, requestId, fingerprint, client = this.database) {
    researchDbRequestId(requestId);
    const found = await client.query("SELECT fingerprint,result FROM evimed_control.research_db_requests WHERE user_id=$1 AND project_id=$2 AND kind='snapshot' AND request_id=$3", [user, project, requestId]);
    if (!found.rows.length) return null;
    if (found.rows[0].fingerprint !== fingerprint) throw conflict();
    return found.rows[0].result;
  }
  /** Must be called within the same transaction as source publication. @param {string} user @param {string} project @param {string} requestId @param {string} fingerprint @param {any} result */
  async recordSnapshot(user, project, requestId, fingerprint, result) {
    await this.database.query("INSERT INTO evimed_control.research_db_requests(user_id,project_id,kind,request_id,fingerprint,result) VALUES($1,$2,'snapshot',$3,$4,$5::jsonb)", [user, project, researchDbRequestId(requestId), fingerprint, JSON.stringify(result)]);
  }
  /** @param {string} user @param {string} project @param {string} id @param {any} [client] @param {boolean} [lock] */
  async open(user, project, id, client = this.database, lock = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    const found = await client.query(`SELECT ciphertext,nonce,tag,key_id FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 AND id=$3${lock ? ' FOR SHARE' : ''}`, [user, project, id]);
    if (found.rows.length !== 1) throw new HttpError(404, 'research_db_connection_missing', 'The database connection was not found.');
    return this.unseal(user, project, id, found.rows[0]);
  }
  /** The project's saved connections, newest first: the id, when it was saved and its `label` (host and database name).
   * @param {string} user @param {string} project */
  async list(user, project) {
    const result = await this.database.query('SELECT id,label,created_at FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT $3', [user, project, this.maxConnections]);
    return result.rows.map(row => ({ id: row.id, label: row.label, createdAt: row.created_at }));
  }
  /** @param {string} user @param {string} project @param {string} id */
  async remove(user, project, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    const result = await this.database.query('DELETE FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 AND id=$3', [user, project, id]);
    return Boolean(result.rowCount);
  }
}
