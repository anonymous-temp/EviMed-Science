import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './security.mjs';

const denied = () => new HttpError(403, 'research_db_network_denied', 'This database address is not admitted by the deployment.');

/** Only globally routable IPv4 addresses are admitted. IPv6 is deliberately unsupported. @param {string} address */
function publicV4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

/** @param {string} host @param {number} port @param {string} policy */
export function admittedResearchDbAddresses(host, port, policy) {
  if (typeof host !== 'string' || host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    || isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof policy !== 'string') throw denied();
  const allowed = new Set(policy.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([^:=]+):(\d+)=([^:=]+)$/.exec(item);
    return match && match[1] === host && Number(match[2]) === port && publicV4(match[3]) ? match[3] : '';
  }).filter(Boolean));
  if (!allowed.size) throw denied();
  return allowed;
}

/** Resolve once, require every answer to be explicitly allowed, then connect to the returned address.
 * Policy is operator-owned and consists of comma-separated host:port=IPv4 entries.
 * @param {string} host @param {number} port @param {string} policy @param {any} resolve */
export async function resolveResearchDbAddress(host, port, policy, resolve = lookup) {
  const allowed = admittedResearchDbAddresses(host, port, policy);
  let records;
  try { records = await resolve(host, { all: true }); } catch { throw denied(); }
  if (!Array.isArray(records) || !records.length || records.length > 32
    || records.some(row => row.family !== 4 || !publicV4(row.address) || !allowed.has(row.address))) throw denied();
  return records[0].address;
}
