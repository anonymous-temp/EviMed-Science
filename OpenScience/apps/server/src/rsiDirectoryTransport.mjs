import { createHash } from 'node:crypto';
import { constants, lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { RSI_BUNDLE_MAX_BYTES } from './rsiOssTransport.mjs';

const NAME = /^[a-f0-9]{64}\.json$/;
const KEY = /^rsi\/v1\/bundles\/([a-f0-9]{64}\.json)$/;
/** One poll's page, as the OSS listing's max-keys. */
const PAGE = 100;
/** Entries one listing walks, whatever they are: a directory past this is refused, never read without end. */
const MAX_ENTRIES = 4096;

/** The transport section of a deployment with no cloud: where production reads what its pull timer brought. @param {any} section */
export function rsiDirectoryTransportIssues(section) {
  const issues = [];
  if (!section || typeof section !== 'object' || Array.isArray(section) || Object.keys(section).some(key => !['kind', 'role', 'path'].includes(key))) issues.push('rsi_online_configuration_invalid');
  if (section?.kind !== 'directory' || section?.role !== 'production' || typeof section?.path !== 'string' || !isAbsolute(section.path)
    || normalize(section.path) !== section.path || section.path === '/' || section.path.endsWith('/')) issues.push('rsi_online_transport_invalid');
  return issues;
}

/** The bundle channel without a cloud, the OSS transport's production read port and nothing else: the design's direction rule (the lab writes
 * bundles, production polls them) is that this object has no write, export or incident method and opens every file read-only, on a host
 * directory the deployment mounts read-only. A file is immutable by its name: `<sha256 of its bytes>.json`. It keeps the OSS port's keys
 * (`rsi/v1/bundles/<digest>.json`) and closed codes because the poller decides a bundle by them. @param {any} section */
export async function createRsiDirectoryTransport(section) {
  const issues = rsiDirectoryTransportIssues(section);
  if (issues.length) return { available: false, preflight: { configured: false, issues } };
  const root = section.path;
  const intact = async () => { if (!(await lstat(root)).isDirectory()) throw new Error('rsi_directory_unavailable'); };
  await intact();
  return { available: true, preflight: { configured: true, issues },
    /** @param {string} [cursor] the last key of the page before */
    async listBundles(cursor) {
      if (cursor !== undefined && (typeof cursor !== 'string' || !KEY.test(cursor))) throw new Error('rsi_oss_cursor_invalid');
      await intact();
      const after = cursor === undefined ? '' : /** @type {RegExpExecArray} */ (KEY.exec(cursor))[1];
      const names = [];
      let walked = 0;
      // A dirent's type is the entry's own: a symlink is no file here, and rsync's hidden temporary names never match.
      for await (const entry of await opendir(root)) {
        if (++walked > MAX_ENTRIES) throw new Error('rsi_oss_listing_invalid');
        if (entry.isFile() && NAME.test(entry.name) && entry.name > after) names.push(entry.name);
      }
      names.sort();
      const page = names.slice(0, PAGE).map(name => `rsi/v1/bundles/${name}`);
      return { keys: page, cursor: names.length > PAGE ? page[PAGE - 1] : null };
    },
    /** @param {string} digest the sha256 of the file's bytes, and so its name */
    async readBundle(digest) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('rsi_oss_digest_invalid');
      await intact();
      let handle;
      // O_NONBLOCK: a FIFO put under this name answers its stat here instead of holding the poll in open().
      try { handle = await open(join(root, `${digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') throw new Error('rsi_oss_object_changed');
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('rsi_oss_object_changed');
        if (stat.size < 1 || stat.size > RSI_BUNDLE_MAX_BYTES) throw new Error('rsi_oss_object_unbounded');
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
        if (bytesRead !== stat.size || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('rsi_oss_object_changed');
        return { bytes, digest };
      } finally { await handle.close(); }
    },
  };
}
