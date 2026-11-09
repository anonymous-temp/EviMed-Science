import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVcrConversationReference, validateVcrConversationReference } from '../src/vcrConversationReference.mjs';
const user = { id: 'alice' }, project = { id: 'prj_a' };
function fixture() {
  const study = { id: 'std_a', userId: 'alice', projectId: 'prj_a', conversationSessionId: 'session_a', steps: { population: { status: 'failed' } } };
  let allowed = true;
  /** the abilities each account holds in the study, when a test narrows them (an account not listed holds all of them) */
  /** @type {Map<string, string[]>} */ const abilities = new Map();
  let claimed = false;
  /** @type {Map<string, any>} */ const grants = new Map();
  const vcr = { service: { allows() { return true; }, async requireStudy(_user, id) { if (id !== study.id) throw new Error('not found'); return study; } }, access: { async require({ actor, ability }) { if (!allowed) throw new Error('grant revoked'); if (abilities.has(actor) && !abilities.get(actor).includes(ability)) throw Object.assign(new Error('role'), { code: 'vcr_role_forbids' }); } }, store: {
    async grantStudyConversation(g) { const row = { ...g, revokedAt: null }; grants.set(`${g.studyId}:${g.sessionId}:${g.grantedBy}`, row); return row; },
    async studyConversationGrant(studyId, sessionId, person) { const row = grants.get(`${studyId}:${sessionId}:${person}`); return row && !row.revokedAt ? row : null; },
    async sessionClaimedByOther() { return claimed; },
    revoke(studyId, sessionId, person = 'alice') { grants.get(`${studyId}:${sessionId}:${person}`).revokedAt = 'now'; },
    async populations() { return [{ id: 'pop_a', version: 2, snapshotId: 'snap_a' }, { id: 'pop_b', version: 1 }]; }, async result(_study, id) { return id === 'res_a' ? { id, subjectId: 'pop_a', version: 3 } : null; },
    async models() { return [{ id: 'model_a', version: '1.0.0', studyId: null }]; },
  } };
  return { vcr, study, revoke() { allowed = false; }, abilities, claim() { claimed = true; }, grants };
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
  assert.equal(await vcr.store.studyConversationGrant('std_a', 'session_b', 'alice'), null);
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_b', study, { grant: true }), study);
  assert.equal((await vcr.store.studyConversationGrant('std_a', 'session_b', 'alice')).grantedBy, 'alice');
  // another account's pick is no grant for this one, and a granted study is read for the granted conversation only
  await assert.rejects(validateVcrConversationReference(vcr, { id: 'bob' }, project, 'session_b', study), { code: 'vcr_object_reference_invalid' });
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_c', study), { code: 'vcr_object_reference_invalid' });
  // a grant lets that conversation select the study's objects too, and the send tells the model how to name the study
  assert.deepEqual(await validateVcrConversationReference(vcr, user, project, 'session_b', reference), reference);
  const request = { sessionId: 'session_b', content: [{ type: 'text', text: 'go on' }], evimedVcrReference: study };
  await bindVcrConversationReference(vcr, user, project, request);
  assert.match(request.content.at(-1).text, /handed to this conversation/);
  assert.doesNotMatch(request.content.at(-1).text, /studyId=/, 'no study argument is taught: the grant binds the conversation');
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

test('R11 the handoff is the owner\'s act or a member\'s whose role holds read, write and run: a viewer or a reviewer is refused', async () => {
  const { vcr, abilities, grants } = fixture();
  const study = { studyId: 'std_a', kind: 'study', objectId: 'study' };
  const member = { id: 'viewer1' };
  // same project id string as the owner's: the compare is the (person, project) pair, and a member reaches the study through a grant only
  const memberProject = { id: 'prj_a' };
  abilities.set('viewer1', ['read']);
  await assert.rejects(validateVcrConversationReference(vcr, member, memberProject, 'session_v', study, { grant: true }), { code: 'vcr_role_forbids' });
  abilities.set('viewer1', ['read', 'review_clinical', 'export']);
  await assert.rejects(validateVcrConversationReference(vcr, member, memberProject, 'session_v', study, { grant: true }), { code: 'vcr_role_forbids' });
  assert.equal(grants.size, 0, 'a refused handoff writes nothing');
  abilities.set('viewer1', ['read', 'write', 'run']);
  assert.deepEqual(await validateVcrConversationReference(vcr, member, memberProject, 'session_v', study, { grant: true }), study);
  assert.equal(grants.get('std_a:session_v:viewer1').grantedBy, 'viewer1');
  // the member never owned the study's conversation: without the grant the same pick is refused at send
  await assert.rejects(validateVcrConversationReference(vcr, member, memberProject, 'session_w', study), { code: 'vcr_object_reference_invalid' });
});

test('R11 a study with no conversation of its own still needs a grant to be worked in from another conversation', async () => {
  const { vcr, study: row, grants } = fixture();
  row.conversationSessionId = null;
  const study = { studyId: 'std_a', kind: 'study', objectId: 'study' };
  await validateVcrConversationReference(vcr, user, project, 'session_z', study, { grant: true });
  assert.ok(grants.get('std_a:session_z:alice'), 'the owner\'s pick writes the grant even when no conversation holds the study');
});

test('R11 a conversation that already belongs to somebody else cannot be handed a study, and nobody\'s grant is overwritten', async () => {
  const { vcr, claim, grants } = fixture();
  const study = { studyId: 'std_a', kind: 'study', objectId: 'study' };
  claim();
  await assert.rejects(validateVcrConversationReference(vcr, user, project, 'session_b', study, { grant: true }), { code: 'vcr_object_reference_invalid' });
  assert.equal(grants.size, 0);
});
