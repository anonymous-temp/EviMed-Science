import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ALL_ERROR_CODES, knownErrorCodeMessage, errorCodeOutcome } from '../../../packages/domain/src/errorCodes.mjs';

const sources = ['nativeMemoryRejections', 'memoryHistory', 'memoryHistoryPersistence', 'memoryHistorySecrets', 'nativeMemoryForgetRequests'];

test('history and removal product errors carry registered stable codes', async () => {
  const found = new Set();
  for (const name of sources) {
    const text = await readFile(new URL(`../src/${name}.mjs`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/new Error\((['"])((?:memory_history_|forget_request_)[a-z_]+)\1\)/g)) {
      const code = match[2];
      found.add(code);
      const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
      assert.match(suffix, new RegExp(`^,\\s*\\{\\s*code:\\s*['"]${code}['"]\\s*\\}\\)`), `${name}: ${code} must carry its code`);
      assert.ok(ALL_ERROR_CODES.includes(code), `${code} must be registered`);
      assert.ok(knownErrorCodeMessage(code), `${code} needs a reader message`);
      assert.notEqual(errorCodeOutcome(code), 'unknown', `${code} needs an outcome`);
    }
  }
  assert.ok(found.has('memory_history_privacy_unavailable'));
  assert.ok(found.has('forget_request_judge_unavailable'));
  assert.ok(found.size >= 13, 'audit the whole error family, not only the reported throw');
});
