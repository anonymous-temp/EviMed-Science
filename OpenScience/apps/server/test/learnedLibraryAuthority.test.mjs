import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { withLearnedLibrary } from '../src/learnedLibraryAuthority.mjs';

test('a finished nested library operation cannot admit later writes through its captured async context', async () => {
  const documents = {}; let later; let writes = 0;
  await withLearnedLibrary(documents, 'owner', async () => {
    await withLearnedLibrary(documents, 'owner', async () => {
      later = AsyncLocalStorage.bind(() => withLearnedLibrary(documents, 'owner', async () => { writes++; }));
    });
    await assert.rejects(later(), { code: 'product_revision_conflict' });
  });
  assert.equal(writes, 0);
});
