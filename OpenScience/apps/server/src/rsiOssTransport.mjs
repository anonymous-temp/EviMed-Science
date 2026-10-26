import { createHash } from 'node:crypto';
import { createRsiOssClient } from './rsiOssClient.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BUNDLE = 5 * 1024 * 1024;
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error('rsi_oss_identity_invalid'); return value; };
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('rsi_oss_digest_invalid'); return value; };
const incidentKey = (stream, generation) => `rsi/v1/incidents/${id(stream)}/${generation}.json`;
const bundleKey = digest => `rsi/v1/bundles/${hash(digest)}.json`;
const missing = error => error?.status === 404 && ['NoSuchKey', 'NotFound'].includes(error?.code);
/** Append-only objects: generation 2 permanently dominates generation 1. There is no cross-key CAS.
 * Readers fence before reading and again before consumption/signing; late generation 1 bytes may
 * remain stored, but are never visible through this port after a durable tombstone.
 * @param {any} config @param {any} options */
export async function createRsiOssTransport(config, options = {}) {
  const connection = await createRsiOssClient(config, options);
  const requireRole = role => { if (!connection.available) throw new Error('rsi_oss_unavailable'); if (config.role !== role) throw new Error('rsi_oss_role_forbidden'); };
  const client = channel => connection.clients[channel];
  async function head(channel, key) {
    try {
      const value = await client(channel).head(key);
      return { digest: hash(value.res?.headers?.['x-oss-meta-sha256']), size: Number(value.res?.headers?.['content-length']) };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async function immutable(channel, key, bytes, digest) {
    const existing = await head(channel, key);
    if (existing) { if (existing.digest !== digest || existing.size !== bytes.length) throw new Error('rsi_oss_object_conflict'); await read(channel, key, bytes.length); return { digest }; }
    try { await client(channel).put(key, bytes, { headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': digest, 'Content-Type': 'application/json' } }); }
    catch (error) { const reconciled = await head(channel, key); if (!reconciled) throw error; if (reconciled.digest !== digest || reconciled.size !== bytes.length) throw new Error('rsi_oss_object_conflict'); await read(channel, key, bytes.length); }
    const confirmed = await head(channel, key);
    if (!confirmed || confirmed.digest !== digest || confirmed.size !== bytes.length) throw new Error('rsi_oss_upload_unconfirmed');
    return { digest };
  }
  async function read(channel, key, limit) {
    const metadata = await head(channel, key);
    if (!metadata) return null;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > limit) throw new Error('rsi_oss_object_unbounded');
    const result = await client(channel).get(key, { headers: { Range: `bytes=0-${limit}` } });
    const bytes = Buffer.from(result.content);
    if (bytes.length > limit || bytes.length !== metadata.size || sha(bytes) !== metadata.digest) throw new Error('rsi_oss_object_changed');
    return { bytes, digest: metadata.digest };
  }
  async function assertIncidentCurrent(authority) {
    requireRole('lab');
    const streamId = typeof authority === 'string' ? authority : authority?.incidentId;
    if (await head('incidentBucket', incidentKey(streamId, 2))) throw new Error('rsi_oss_incident_withdrawn');
    const value = await read('incidentBucket', incidentKey(streamId, 1), 65536);
    if (!value) throw new Error('rsi_oss_incident_missing');
    const body = JSON.parse(value.bytes.toString('utf8'));
    if (body.incidentId !== streamId || body.generation !== 1 || typeof authority !== 'string' && (
      value.digest !== authority.incidentDigest || body.authorizationId !== authority.id ||
      body.sourceRunId !== authority.sourceRunId || body.sourceRevision !== authority.sourceRevision)) throw new Error('rsi_oss_incident_binding_changed');
    if (await head('incidentBucket', incidentKey(streamId, 2))) throw new Error('rsi_oss_incident_withdrawn');
    return value;
  }
  async function list(channel, prefix, cursor) {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048 || [...cursor].some(character => character.charCodeAt(0) < 32))) throw new Error('rsi_oss_cursor_invalid');
    const result = await client(channel).listV2({ prefix, 'max-keys': 100, ...(cursor ? { 'continuation-token': cursor } : {}) });
    const keys = (result.objects ?? []).map(object => object.name);
    if (keys.length > 100 || keys.some(key => typeof key !== 'string' || !key.startsWith(prefix))) throw new Error('rsi_oss_listing_invalid');
    return { keys, cursor: result.isTruncated ? result.nextContinuationToken : null };
  }
  return {
    available: connection.available, preflight: connection.preflight,
    async putObject(pending) {
      requireRole('production');
      const generation = pending.kind === 'withdrawal' ? 2 : pending.kind === 'incident' ? 1 : 0;
      if (!generation || pending.generation !== generation || pending.body?.generation !== generation || pending.body?.incidentId !== pending.streamId || JSON.stringify(pending.body) !== pending.serializedBody || pending.idempotencyKey !== `${pending.streamId}:${pending.kind}`) throw new Error('rsi_oss_incident_invalid');
      const bytes = Buffer.from(pending.serializedBody);
      if (bytes.length > 65536 || sha(bytes) !== hash(pending.digest)) throw new Error('rsi_oss_incident_invalid');
      if (generation === 1 && await head('incidentBucket', incidentKey(pending.streamId, 2))) throw new Error('rsi_oss_incident_withdrawn');
      return immutable('incidentBucket', incidentKey(pending.streamId, generation), bytes, pending.digest);
    },
    async headObject(input) { requireRole('production'); if (![1, 2].includes(input.generation)) throw new Error('rsi_oss_generation_invalid'); return head('incidentBucket', incidentKey(input.streamId, input.generation)); },
    assertIncidentCurrent,
    async readIncident(streamId) { return assertIncidentCurrent(streamId); },
    async listIncidents(cursor) { requireRole('lab'); return list('incidentBucket', 'rsi/v1/incidents/', cursor); },
    async exportBundle(envelope) { requireRole('lab'); const bytes = Buffer.from(JSON.stringify(envelope)); if (bytes.length > MAX_BUNDLE) throw new Error('rsi_oss_bundle_unbounded'); const digest = sha(bytes); await immutable('bundleBucket', bundleKey(digest), bytes, digest); return { digest }; },
    async readBundle(digest) { requireRole('production'); const value = await read('bundleBucket', bundleKey(digest), MAX_BUNDLE); if (value && value.digest !== digest) throw new Error('rsi_oss_object_changed'); return value; },
    async listBundles(cursor) { requireRole('production'); return list('bundleBucket', 'rsi/v1/bundles/', cursor); },
  };
}
