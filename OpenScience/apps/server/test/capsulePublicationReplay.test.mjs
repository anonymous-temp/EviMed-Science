import test from 'node:test';
import assert from 'node:assert/strict';
import { CapsuleService } from '../src/capsuleService.mjs';
import { productDocumentsDouble } from './helpers/productDocumentsDouble.mjs';
import { makeCapsule } from "./helpers/capsuleFixtures.mjs";
test('internal source publication replay preserves a user retirement', async () => {
  const docs = productDocumentsDouble();
  const service = new CapsuleService(docs);
  const capsule = await makeCapsule(service, 'u', { title: 'Mine' });
  const input = { factKind: 'project_fact', layer: 'sources', content: 'Observed source fact', origin: 'inferred',
    derivedFrom: { sourceId: `src_${'a'.repeat(32)}`, projectId: 'p' } };
  const first = await service.addEntry('u', capsule.id, input, { publicationKey: 'fact-content-digest' });
  await service.updateEntry('u', capsule.id, first.id, { status: 'retired', expectedRevision: first.revision });
  const replay = await service.addEntry('u', capsule.id, input, { publicationKey: 'fact-content-digest' });
  assert.equal(replay.id, first.id);
  assert.equal(replay.payload.status, 'retired');
});

test('client input cannot select a publication identity', async () => {
  const docs = productDocumentsDouble();
  const service = new CapsuleService(docs);
  const capsule = await makeCapsule(service, 'u', { title: 'Mine' });
  const input = { factKind: 'project_fact', layer: 'sources', content: 'Observed source fact', origin: 'inferred',
    derivedFrom: { sourceId: `src_${'b'.repeat(32)}`, projectId: 'p', publicationKey: 'untrusted' } };
  const a = await service.addEntry('u', capsule.id, input);
  const b = await service.addEntry('u', capsule.id, input);
  assert.notEqual(a.id, b.id);
});
