import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// A flow sequence splits at its commas: `tmpfs: [/tmp:rw,noexec,size=16m]` is three entries, and Docker refused the third as a mount
// path in the middle of the first patient-matching release switch (2026-11-10). Every entry must be one whole mount, starting at `/`.
const deployWeb = fileURLToPath(new URL('../../../deploy/web/', import.meta.url));

test('every tmpfs entry of every compose file is one absolute mount', () => {
  const files = fs.readdirSync(deployWeb).filter(name => /^docker-compose.*\.ya?ml$/.test(name));
  assert.ok(files.includes('docker-compose.patient-matching.yml'));
  let entries = 0;
  for (const name of files) {
    const document = YAML.parse(fs.readFileSync(path.join(deployWeb, name), 'utf8')) ?? {};
    for (const [service, definition] of Object.entries(document.services ?? {})) {
      const tmpfs = definition?.tmpfs;
      if (tmpfs === undefined) continue;
      for (const entry of Array.isArray(tmpfs) ? tmpfs : [tmpfs]) {
        entries++;
        assert.match(String(entry), /^\//, `${name} ${service}: tmpfs entry ${JSON.stringify(entry)} is not a mount path`);
      }
    }
  }
  assert.ok(entries > 0);
});
