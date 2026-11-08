import assert from 'node:assert/strict';
import test from 'node:test';
import { identifierShapesIn, maskIdentifiers } from '../src/memoryVocabulary.mjs';
const load = () => import('../src/methodSourcePrivacy.mjs');

test('contact details remain eligible factual memory but do not become reusable method source text', async () => {
  const { methodSourceIdentifierShapesIn } = await load();
  const text = 'Contact 13800138000 or editor@example.org.';
  assert.deepEqual(identifierShapesIn(text), []); assert.equal(maskIdentifiers(text), text);
  assert.deepEqual(methodSourceIdentifierShapesIn(text), ['mobile', 'email']);
});
test('the method privacy floor checks formats rather than the words of a useful correction', async () => {
  const { methodSourceIdentifierShapesIn } = await load();
  assert.deepEqual(methodSourceIdentifierShapesIn('Remove phone, email and password columns; preserve every denominator.'), []);
  assert.ok(methodSourceIdentifierShapesIn('password: "synthetic-private-value"').includes('credential'));
});
