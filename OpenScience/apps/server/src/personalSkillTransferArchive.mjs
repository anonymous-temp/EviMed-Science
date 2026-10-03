import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { HttpError } from './security.mjs';

const MAX_INPUT = 32 * 1024 * 1024, MAX_EXPANDED = 512 * 1024 * 1024;
let active = 0;
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The account data archive is invalid or exceeds the supported limits.');

/** Extract only the platform's fixed customer-state entry in a bounded worker.
 * No archive path is opened, executed or restored to the filesystem.
 * @param {Buffer} bytes */
export async function accountSkillStateBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_INPUT) throw invalid();
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (active >= 2) throw new HttpError(503, 'product_state_unavailable', 'Account archive processing is busy.');
  active++;
  let worker, joined = true;
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'personal-account-data-v1', bytes },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }, stdout: true, stderr: true });
    joined = false;
    return await new Promise((resolve, reject) => {
      let settled = false, diagnostics = 0;
      const finish = async (error, result = null) => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { await worker.terminate(); joined = true; } catch { error = invalid(); }
        if (error) reject(error); else resolve(Buffer.from(result));
      };
      const timer = setTimeout(() => { void finish(invalid()); }, 10000);
      for (const output of [worker.stdout, worker.stderr]) output.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 4096) void finish(invalid()); });
      worker.once('message', message => {
        if (!message?.bytes || message.bytes.length < 1 || message.bytes.length > MAX_INPUT) void finish(invalid());
        else void finish(null, message.bytes);
      });
      worker.once('error', () => { void finish(invalid()); });
      worker.once('exit', () => { void finish(invalid()); });
    });
  } finally { if (joined) active--; }
}

/** @param {Buffer} bytes */
async function extractAccountState(bytes) {
  const extract = tar.extract();
  let expanded = 0, entries = 0, found = null;
  const ceiling = new Transform({ transform(chunk, _encoding, next) { expanded += chunk.length; next(expanded > MAX_EXPANDED ? new Error('limit') : null, chunk); } });
  extract.on('entry', (header, stream, next) => {
    stream.once('error', error => extract.destroy(error));
    if (++entries > 20000) { stream.destroy(new Error('limit')); return; }
    if (header.name !== 'account/customer-state.json') { stream.resume(); stream.once('end', next); return; }
    if (found || header.type !== 'file' || !Number.isSafeInteger(header.size) || header.size < 1 || header.size > MAX_INPUT) { stream.destroy(new Error('invalid')); return; }
    const chunks = []; let size = 0;
    stream.on('data', chunk => { size += chunk.length; if (size > MAX_INPUT) stream.destroy(new Error('limit')); else chunks.push(chunk); });
    stream.once('end', () => { if (size !== header.size) { extract.destroy(new Error('invalid')); return; } found = Buffer.concat(chunks); next(); });
  });
  await pipeline(Readable.from([bytes]), createGunzip(), ceiling, extract);
  if (!found) throw new Error('missing');
  return found;
}

if (!isMainThread && workerData?.kind === 'personal-account-data-v1') {
  try { parentPort.postMessage({ bytes: await extractAccountState(Buffer.from(workerData.bytes)) }); }
  catch { parentPort.postMessage({ invalid: true }); }
}
