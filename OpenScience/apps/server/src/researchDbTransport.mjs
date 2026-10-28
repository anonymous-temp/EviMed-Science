import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { researchDbHostName, resolveResearchDbAddress } from './researchDbNetwork.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';
import { HttpError } from './security.mjs';

const unavailable = () => new HttpError(503, 'research_db_unavailable', 'The database is unavailable.');
const tlsFailed = () => new HttpError(502, 'research_db_tls_failed', 'The database certificate could not be verified.');
const loginFailed = () => new HttpError(502, 'research_db_login_failed', 'The database refused the login.');
const unreachable = () => new HttpError(502, 'research_db_unreachable', 'The database did not answer.');

/** The largest CA file the operator may place: a chain of a few certificates. */
const CA_FILE_BYTES = 64 * 1024;

/**
 * The operator-owned trust anchor for one host: `<caDir>/<host>.pem`, the host in lower case as the allowlist writes it.
 * No file means the built-in public authorities (what Node ships) and nothing else; a file REPLACES them for that host, so
 * a certificate issued by any other authority is refused. The name is built from a host that has already passed the
 * allowlist's host-name shape, so it cannot leave the directory; the file must be a regular file of PEM certificates.
 * An unreadable or malformed file is a failed TLS setup (the operator's to mend), never a silent fall-back to the
 * public authorities.
 * @param {string} caDir @param {string} host @returns {string | null}
 */
export function researchDbCaFor(caDir, host) {
  if (!caDir) return null;
  const file = path.join(caDir, `${researchDbHostName(host)}.pem`);
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (/** @type {any} */ (error)?.code === 'ENOENT') return null; throw tlsFailed(); }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > CA_FILE_BYTES) throw tlsFailed();
    const pem = fs.readFileSync(descriptor, 'utf8');
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(pem)) throw tlsFailed();
    return pem;
  } catch (error) { throw error instanceof HttpError ? error : tlsFailed(); }
  finally { fs.closeSync(descriptor); }
}

/** SQLSTATEs that mean the server answered and said no to the login: class 28 (invalid authorization) and 3D000
 * (no such database -- the same fix, a wrong name in the connection). */
const isLoginRefusal = (/** @type {any} */ error) => typeof error?.code === 'string' && (error.code.startsWith('28') || error.code === '3D000');
/** The errors OpenSSL and Node raise for a certificate that does not verify, and pg's own for a server without TLS. */
const isTlsFailure = (/** @type {any} */ error) => /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_[A-Z_]+|HOSTNAME_MISMATCH|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z0-9_]+|ERR_OSSL_[A-Z0-9_]+)$/.test(String(error?.code ?? ''))
  || /ssl|tls|certificate/i.test(String(error?.message ?? ''));
/** Nothing listening, nothing answering, a path that does not route. */
const isNetworkFailure = (/** @type {any} */ error) => /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|ENOTFOUND)$/.test(String(error?.code ?? ''))
  || /timeout|terminated|ended unexpectedly/i.test(String(error?.message ?? ''));

/** What a failed connection is called. The server's own refusal is a login problem; a certificate that does not verify is
 * a TLS problem; no answer is a network problem; anything else stays the general unavailable.
 * @param {unknown} error */
export function researchDbConnectionError(error) {
  if (error instanceof HttpError) return error;
  if (isLoginRefusal(error)) return loginFailed();
  if (isTlsFailure(error)) return tlsFailed();
  if (isNetworkFailure(error)) return unreachable();
  return unavailable();
}

/** Connect only to the resolved operator-admitted IPv4 address while authenticating the original TLS hostname.
 * @param {any} connection @param {string} policy
 * @param {{Client?:any,resolve?:any,caDir?:string,limits?:{connectionMs:number,wireBytes:number}}} options */
export async function openResearchDb(connection, policy, { Client = pg.Client, resolve = undefined, caDir = '', limits = RESEARCH_DB_LIMIT_DEFAULTS } = {}) {
  let dnsTimer;
  const address = await Promise.race([
    resolveResearchDbAddress(connection.host, connection.port, policy, resolve),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(unavailable()), 5000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  const ca = researchDbCaFor(caDir, connection.host);
  /** @type {net.Socket | null} */ let socket = null;
  const client = new Client({ host: researchDbHostName(connection.host), port: connection.port, database: connection.database,
    user: connection.username, password: connection.password, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 5000,
    stream: () => {
      const stream = new net.Socket(); socket = stream;
      const connect = stream.connect.bind(stream);
      // The hostname stays in pg's configuration for TLS SNI and certificate checks;
      // only the already-validated address reaches the underlying socket.
      stream.connect = ((port) => connect(port, /** @type {string} */ (address)));
      return stream;
    },
  });
  client.on('error', () => {});
  // Cap the total decrypted PostgreSQL protocol bytes before pg accumulates an
  // unbounded response, including authentication and metadata messages
  // (`OPEN_SCIENCE_RESEARCH_DB_WIRE_BYTES`: the cell text a full snapshot keeps, the wire's four bytes a cell and one
  // marker string a row).
  client.connection?.once('sslconnect', () => {
    const stream = client.connection.stream; let received = 0;
    stream.prependListener('data', chunk => {
      received += chunk.length;
      if (received > limits.wireBytes) stream.destroy();
    });
  });
  // The hard end of one connection (`OPEN_SCIENCE_RESEARCH_DB_CONNECTION_MS`, 30 s). A snapshot stops reading on its
  // own before it (`OPEN_SCIENCE_RESEARCH_DB_READ_MS`).
  const timer = setTimeout(() => socket?.destroy(), limits.connectionMs); timer.unref();
  try { await client.connect(); }
  catch (error) { clearTimeout(timer); socket?.destroy(); await client.end().catch(() => {}); throw researchDbConnectionError(error); }
  return { client, close: async () => { clearTimeout(timer); socket?.destroy(); await client.end().catch(() => {}); } };
}
