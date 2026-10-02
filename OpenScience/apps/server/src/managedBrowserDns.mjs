/** Resolve public browser destinations over the same TLS egress as their traffic. */
import {isIP} from 'node:net';
import {edgeFetch} from './edgeProxy.mjs';
import {privateAddress, privateHostname, webReadError} from './webReadNetwork.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HOSTS = 128;
const MAX_PENDING = 8;
const RESOLVER = 'https://cloudflare-dns.com/dns-query';

/** The resolver endpoint is fixed server code; callers supply only a public hostname.
 * The Tokyo proxy resolves this trusted service name. Destination answers are still
 * checked by pinnedPublicLookup and connected by their exact checked address.
 * @param {ReturnType<import('./edgeProxy.mjs').edgeProxyFromConfig>} edge
 * @param {{fetchImpl?: typeof edgeFetch, now?: () => number}} [deps]
 */
export function createManagedBrowserResolver(edge, {fetchImpl = edgeFetch, now = Date.now} = {}) {
  const cached = new Map();
  const pending = new Map();
  const unavailable = () => webReadError(502, 'web_read_host_unresolved', 'The browser destination could not be resolved.', {retryable: true});

  async function query(hostname, type) {
    const url = new URL(RESOLVER);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', String(type));
    const signal = AbortSignal.timeout(8000);
    const response = await fetchImpl(edge, url, {headers: {accept: 'application/dns-json'}, signal});
    if (response.status !== 200 || !/^application\/(?:dns-)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw unavailable();
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw unavailable(); }
    if (data.Status !== 0 || data.TC === true || (data.Answer !== undefined && !Array.isArray(data.Answer))) throw unavailable();
    const answers = data.Answer ?? [];
    if (answers.length > 64) throw unavailable();
    const records = answers.filter(answer => answer.type === type).map(answer => {
      const address = String(answer.data ?? ''), family = isIP(address);
      if (family !== (type === 1 ? 4 : 6) || privateAddress(address)) throw unavailable();
      return {address, family, ttl: Number.isFinite(answer.TTL) && answer.TTL >= 0 ? Math.min(answer.TTL, 60) : 0};
    });
    return records;
  }

  return async hostname => {
    if (typeof hostname !== 'string' || hostname.length > 253 || privateHostname(hostname)) throw unavailable();
    const name = hostname.toLowerCase().replace(/\.$/, '');
    const literal = isIP(name);
    if (literal) {
      if (privateAddress(name)) throw unavailable();
      return [{address: name, family: literal}];
    }
    if (!/^[a-z0-9.-]+$/.test(name) || !edge || edge.url.protocol !== 'https:') throw unavailable();
    const old = cached.get(name);
    if (old && old.expiresAt > now()) return structuredClone(old.records);
    cached.delete(name);
    if (pending.has(name)) return structuredClone(await pending.get(name));
    if (pending.size >= MAX_PENDING) throw unavailable();
    const work = (async () => {
      // Both families must complete: a failing or private answer cannot be hidden
      // by whichever other family happened to return first.
      const responses = await Promise.allSettled([query(name, 1), query(name, 28)]);
      if (responses.some(response => response.status !== 'fulfilled')) throw unavailable();
      const all = responses.flatMap(response => response.status === 'fulfilled' ? response.value : []);
      if (!all.length) throw unavailable();
      const records = all.map(({address, family}) => ({address, family}));
      const ttl = Math.min(...all.map(record => record.ttl));
      if (cached.size >= MAX_HOSTS) cached.delete(cached.keys().next().value);
      if (ttl > 0) cached.set(name, {records, expiresAt: now() + ttl * 1000});
      return records;
    })().finally(() => pending.delete(name));
    pending.set(name, work);
    try { return structuredClone(await work); } catch { throw unavailable(); }
  };
}
