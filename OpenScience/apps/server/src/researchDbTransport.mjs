import net from 'node:net';
import pg from 'pg';
import { resolveResearchDbAddress } from './researchDbNetwork.mjs';
import { HttpError } from './security.mjs';

/** Connect only to the resolved operator-admitted IPv4 address while authenticating the original TLS hostname.
 * @param {any} connection @param {string} policy @param {{Client?:any,resolve?:any}} options */
export async function openResearchDb(connection, policy, { Client = pg.Client, resolve = undefined } = {}) {
  let dnsTimer;
  const address = await Promise.race([
    resolveResearchDbAddress(connection.host, connection.port, policy, resolve),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new HttpError(503, 'research_db_unavailable', 'The database is unavailable.')), 5000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  /** @type {net.Socket | null} */ let socket = null;
  const client = new Client({ host: connection.host, port: connection.port, database: connection.database,
    user: connection.username, password: connection.password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 5000,
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
  // unbounded response, including authentication and metadata messages.
  client.connection?.once('sslconnect', () => {
    const stream = client.connection.stream; let received = 0;
    stream.prependListener('data', chunk => {
      received += chunk.length;
      if (received > 16 * 1024 * 1024) stream.destroy();
    });
  });
  const timer = setTimeout(() => socket?.destroy(), 15000); timer.unref();
  try { await client.connect(); }
  catch { clearTimeout(timer); socket?.destroy(); await client.end().catch(() => {}); throw new HttpError(503, 'research_db_unavailable', 'The database is unavailable.'); }
  return { client, close: async () => { clearTimeout(timer); socket?.destroy(); await client.end().catch(() => {}); } };
}
