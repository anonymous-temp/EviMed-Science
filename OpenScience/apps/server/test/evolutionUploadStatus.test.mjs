import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadProfileComplete } from '../../../scripts/ops/evolution-upload-acceptance.mjs';
test('upload semantics stay unread until profiling succeeds and failures cannot match', () => {
  for (const status of ['queued', 'dispatching', 'running']) assert.equal(uploadProfileComplete({ status }), false);
  assert.equal(uploadProfileComplete(null), false);
  assert.equal(uploadProfileComplete({ status: 'succeeded' }), true);
  for (const status of ['failed', 'canceled']) assert.throws(() => uploadProfileComplete({ status }));
});
