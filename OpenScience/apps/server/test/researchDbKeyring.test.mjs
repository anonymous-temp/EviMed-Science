import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readResearchDbKeyring } from '../src/researchDbKeyring.mjs';

test('a production keyring requires protected files and material-bound key identities', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-keyring-'));
  try {
    const bytes = randomBytes(32), id = createHash('sha256').update(bytes).digest('hex');
    const value = { activeId: id, keys: { [id]: bytes.toString('base64') } }, file = path.join(dir, 'keys');
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    assert.deepEqual(readResearchDbKeyring(file), value);
    const link = path.join(dir, 'link'); symlinkSync(file, link);
    assert.throws(() => readResearchDbKeyring(link), { code: 'research_db_keyring_unavailable' });
    chmodSync(file, 0o644); assert.throws(() => readResearchDbKeyring(file), { code: 'research_db_keyring_unavailable' });
    chmodSync(file, 0o600); value.keys[id] = randomBytes(32).toString('base64'); writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readResearchDbKeyring(file), { code: 'research_db_keyring_unavailable' });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
