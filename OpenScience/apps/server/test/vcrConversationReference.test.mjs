import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVcrConversationReference, validateVcrConversationReference } from '../src/vcrConversationReference.mjs';
const user = { id: 'alice' }, project = { id: 'prj_a' };
function fixture() {
  const study = { id: 'std_a', projectId: 'prj_a', conversationSessionId: 'session_a', steps: { population: { status: 'failed' } } };
  let allowed = true;
  /** @type {Map<string, any>} */ const grants = new Map();
  const vcr = { service: { allows() { return true; }, async requireStudy(_user, id) { if (id !== study.id) throw new Error('not found'); return study; } }, access: { async require() { if (!allowed) throw new Error('grant revoked'); } }, store: {
    async grantStudyConversation(g) { const row = { ...g, revokedAt: null }; grants.set(`${g.studyId}:${g.sessionId}`, row); return row; },
    async studyConversationGrant(studyId, sessionId) { const row = grants.get(`${studyId}:${sessionId}`); return row && !row.revokedAt ? row : null; },
    revoke(studyId, sessionId) { grants.get(`${studyId}:${sessionId}`).revokedAt = 'now'; },
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

test('R11 a study bound to another conversation is usable only through the person\'s own explicit grant, recorded and revocable', async () => {
  const { vcr } = fixture();
  const study = { studyId: 'std_a', kind: 'study', objectId: 'study' };
  // nothing implicit: neither a study reference nor an object of it reaches a conversation the study was not handed to
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_b', study), { code: 'vcr_object_reference_invalid' });
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_b', reference), { code: 'vcr_object_reference_invalid' });
  // the native send never writes a grant, only the person's staging does
  await assert.rejects(bindVcrConversationReference(vcr, user, project, { sessionId: 'session_b', content: [{ type: 'text', text: 'go on' }], evimedVcrReference: study }));
  assert.equal(await vcr.store.studyConversationGrant('std_a', 'session_b'), null);
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_b', study, { grant: true }), study);
  assert.equal((await vcr.store.studyConversationGrant('std_a', 'session_b')).grantedBy, 'alice');
  // another account's pick is no grant for this one, and a granted study is read for the granted conversation only
  await assert.rejects(validateVcrConversationReference(vcr, { id: 'bob' }, project, 'session_b', study), { code: 'vcr_object_reference_invalid' });
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_c', study), { code: 'vcr_object_reference_invalid' });
  // a grant lets that conversation select the study's objects too, and the send tells the model how to name the study
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_b', reference), reference);
  const request = { sessionId: 'session_b', content: [{ type: 'text', text: 'go on' }], evimedVcrReference: study };
  await bindVcrConversationReference(vcr, user, project, request);
  assert.match(request.content.at(-1).text, /pass studyId=std_a to vcr_read, vcr_write and vcr_simulate/);
  // the study's own conversation needs no grant and is told nothing of one
  const own = { sessionId: 'session_a', content: [{ type: 'text', text: 'go on' }], evimedVcrReference: study };
  await bindVcrConversationReference(vcr, user, project, own);
  assert.doesNotMatch(own.content.at(-1).text, /studyId=/);
  // another project is still refused, and a revoked grant is denied at the next staging or send
  await assert.rejects(validateVcrConversationReference(vcr, user, { id: 'other' }, 'session_b', study, { grant: true }), { code: 'vcr_object_reference_invalid' });
  vcr.store.revoke('std_a', 'session_b');
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_b', study), { code: 'vcr_object_reference_invalid' });
  await assert.rejects(bindVcrConversationReference(vcr, user, project, { sessionId: 'session_b', content: [{ type: 'text', text: 'go on' }], evimedVcrReference: reference }));
});
