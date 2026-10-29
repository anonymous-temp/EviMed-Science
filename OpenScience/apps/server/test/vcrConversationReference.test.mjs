import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVcrConversationReference, validateVcrConversationReference } from '../src/vcrConversationReference.mjs';
const user = { id: 'alice' }, project = { id: 'prj_a' };
function fixture() {
  const study = { id: 'std_a', projectId: 'prj_a', conversationSessionId: 'session_a', steps: { population: { status: 'failed' } } };
  let allowed = true;
  const vcr = { service: { allows() { return true; }, async requireStudy(_user, id) { if (id !== study.id) throw new Error('not found'); return study; } }, access: { async require() { if (!allowed) throw new Error('grant revoked'); } }, store: {
    async populations() { return [{ id: 'pop_a', version: 2, snapshotId: 'snap_a' }, { id: 'pop_b', version: 1 }]; }, async result(_study, id) { return id === 'res_a' ? { id, subjectId: 'pop_a', version: 3 } : null; },
    async models() { return [{ id: 'model_a', version: '1.0.0', studyId: null }]; },
  } };
  return { vcr, study, revoke() { allowed = false; } };
}
const reference = { studyId: 'std_a', kind: 'population', objectId: 'pop_a', version: 2, resultId: 'res_a', resultVersion: 3 };
test('staging and send both recheck scope, immutable version and current grants', async () => {
  const { vcr, revoke } = fixture();
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_a', reference), reference);
  const request = { sessionId: 'session_a', content: [{ type: 'text', text: 'Please compare these saved versions.' }], evimedVcrReference: reference };
  await bindVcrConversationReference(vcr, user, project, request);
  assert.equal(request.evimedVcrReference, undefined);
  assert.match(request.content.at(-1).text, /<evimed-vcr-selection>/);
  for (const input of [{ ...reference, version: 3 }, { ...reference, resultVersion: 4 }, { ...reference, objectId: 'foreign' }]) await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_a', input));
  await assert.rejects(validateVcrConversationReference(vcr, user, { id: 'other' }, 'session_a', reference));
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'other_session', reference));
  revoke();
  await assert.rejects(bindVcrConversationReference(vcr, user, project, { ...request, evimedVcrReference: reference }));
});
test('account model selections reject invisible owners and stale model versions', async () => {
  const { vcr } = fixture();
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_a', { kind: 'model', objectId: 'model_a', version: '1.0.0' }), { kind: 'model', objectId: 'model_a', version: '1.0.0' });
  for (const input of [{ kind: 'model', objectId: 'foreign', version: '1.0.0' }, { kind: 'model', objectId: 'model_a', version: '2.0.0' }]) await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_a', input));
});

test('the disabled research module remains unavailable through conversation staging', async () => {
  const { vcr } = fixture(); vcr.service.allows = () => false;
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_a', reference), error => error.code === 'vcr_not_enabled' && error.status === 404);
});

test('selected versions remain context while the latest human instruction stays unchanged', async () => {
  const { vcr } = fixture();
  const text = 'Do not compare or run anything. Explain the selected population only.';
  const request = { sessionId: 'session_a', content: [{ type: 'text', text }], evimedVcrReference: reference };
  await bindVcrConversationReference(vcr, user, project, request);
  assert.equal(request.content[0].text, text);
  assert.match(request.content[1].text, /Follow the researcher's latest instruction/);
  assert.match(request.content[1].text, /does not instruct you to adjust, compare or run anything by itself/);
});
