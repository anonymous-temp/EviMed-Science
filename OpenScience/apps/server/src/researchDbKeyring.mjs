import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';

const unavailable = () => new HttpError(503, 'research_db_keyring_unavailable', 'Database credential keys are unavailable.');

/** Read only an owner-protected, regular, non-symlink file. Key IDs are bound
 * to their random 32-byte material so an operator cannot reuse an ID for a
 * different key. This loader does not enable the connector by itself.
 * @param {string} file */
export function readResearchDbKeyring(file) {
  let descriptor;
  try {
    if (typeof file !== 'string' || !file) throw unavailable();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw unavailable();
    const data = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join() !== 'activeId,keys'
      || !data.keys || typeof data.keys !== 'object' || Array.isArray(data.keys)) throw unavailable();
    const entries = Object.entries(data.keys);
    if (!entries.length || entries.length > 16 || !Object.hasOwn(data.keys, data.activeId)) throw unavailable();
    for (const [id, value] of entries) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw unavailable();
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== value || id !== createHash('sha256').update(bytes).digest('hex')) throw unavailable();
    }
    return { activeId: data.activeId, keys: { ...data.keys } };
  } catch { throw unavailable(); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
