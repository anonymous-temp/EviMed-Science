import { appendFile, open, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/** appendFile may split large UTF-8 records across writes. Serialize complete records across replay workers. */
export function serialJsonlWriter(file) {
  let writing = Promise.resolve();
  return value => {
    const encoded = JSON.stringify(value) + '\n';
    writing = writing.then(() => {
      if (existsSync(file+'.gz')) throw Error('evidence_compressed_read_only');
      return appendFile(file, encoded);
    });
    return writing;
  };
}

/** Completed evidence may be compressed after its byte hash has been verified. Never load it whole. */
export function recordingInput(file) {
  return existsSync(file) ? createReadStream(file) : createReadStream(file+'.gz').pipe(createGunzip());
}


/** Resume with bounded memory and refuse a torn record rather than silently merging later evidence into it. */
export async function recordedIds(file) {
  if (existsSync(file+'.gz')) throw Error('evidence_compressed_read_only');
  let info;
  try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  if (info.size) {
    const handle = await open(file, 'r'), last = Buffer.alloc(1);
    try { await handle.read(last, 0, 1, info.size - 1); } finally { await handle.close(); }
    if (last[0] !== 10) throw Error('evidence_last_record_incomplete');
  }
  const ids = new Set();
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.id !== 'string') throw Error('evidence_record_id_invalid');
    ids.add(row.id);
  }
  return ids;
}
