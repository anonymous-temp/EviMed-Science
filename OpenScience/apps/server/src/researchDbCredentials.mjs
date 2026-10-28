import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from './security.mjs';

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
/** Production remains disabled until clinical isolation and key management are implemented.
 * @param {{environment:string|undefined,testOnly:boolean|undefined,database:any,testKey:unknown}} input */
export function researchDbCredentialsForTest({ environment, testOnly, database, testKey }) {
  return environment === 'test' && testOnly === true && database && typeof testKey === 'string' && testKey.length >= 32
    ? new ResearchDbCredentials(database, { activeId: 'test-v1', keys: { 'test-v1': testKey } }) : null;
}
/** @param {any} value */
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...connectionFields].sort().join()) throw invalid();
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw invalid();
  for (const key of ['host', 'database', 'username', 'password']) {
    const item = value[key];
    if (typeof item !== 'string' || !item || Buffer.byteLength(item) > 1024 || [...item].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  }
  return Object.fromEntries(connectionFields.map(key => [key, value[key]]));
}
/** The ciphertext is bound to the account, project and generated connection identity. */
export class ResearchDbCredentials {
  /** @param {any} database @param {{activeId:string,keys:Record<string,string>}} keyring */
  constructor(database, keyring) {
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
    await this.database.query(`CREATE TABLE IF NOT EXISTS evimed_control.research_db_connections (
      user_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL, ciphertext bytea NOT NULL, nonce bytea NOT NULL, tag bytea NOT NULL, key_id text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (user_id, project_id, id),
      FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE);
      ALTER TABLE evimed_control.research_db_connections ADD COLUMN IF NOT EXISTS key_id text;
      CREATE TABLE IF NOT EXISTS evimed_control.research_db_requests (
        user_id text NOT NULL, project_id text NOT NULL, request_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('save','snapshot')),
        fingerprint text, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (user_id,project_id,kind,request_id),
        FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE)`);
  }
  /** A missing or legacy NULL key ID is never guessed. A deployment must
   * retain every referenced version until its rows have been rewrapped. */
  async assertKeyCoverage() {
    const result = await this.database.query('SELECT DISTINCT key_id FROM evimed_control.research_db_connections');
    if (result.rows.some(row => typeof row.key_id !== 'string' || !this.keys.has(row.key_id))) {
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
      if (Number(count.rows[0]?.n) >= 50) throw new HttpError(409, 'research_db_connection_limit', 'This project already has the maximum number of database connections.');
      await client.query('INSERT INTO evimed_control.research_db_connections(user_id,project_id,id,ciphertext,nonce,tag,key_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [user, project, id, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId]);
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
  /** Rewrap one row under the active version; retaining old keys makes interrupted rotation recoverable.
   * @param {string} user @param {string} project @param {string} id */
  async rotate(user, project, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    return this.database.transaction(async client => {
      const found = await client.query('SELECT ciphertext,nonce,tag,key_id FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [user, project, id]);
      if (found.rows.length !== 1) throw new HttpError(404, 'research_db_connection_missing', 'The database connection was not found.');
      if (found.rows[0].key_id === this.activeId) return { rotated: false };
      const sealed = this.seal(user, project, id, this.unseal(user, project, id, found.rows[0]));
      await client.query('UPDATE evimed_control.research_db_connections SET ciphertext=$4,nonce=$5,tag=$6,key_id=$7 WHERE user_id=$1 AND project_id=$2 AND id=$3', [user, project, id, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId]);
      return { rotated: true };
    });
  }
  /** @param {string} user @param {string} project */
  async list(user, project) {
    const result = await this.database.query('SELECT id,created_at FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50', [user, project]);
    return result.rows.map(row => ({ id: row.id, createdAt: row.created_at }));
  }
  /** @param {string} user @param {string} project @param {string} id */
  async remove(user, project, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    const result = await this.database.query('DELETE FROM evimed_control.research_db_connections WHERE user_id=$1 AND project_id=$2 AND id=$3', [user, project, id]);
    return Boolean(result.rowCount);
  }
}
