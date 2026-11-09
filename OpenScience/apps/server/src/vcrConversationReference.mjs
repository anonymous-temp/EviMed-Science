import { vcrObjectReference } from '@evimed/domain';
import { HttpError } from './security.mjs';
const invalid = () => new HttpError(409, 'vcr_object_reference_invalid', 'The saved research selection is unavailable.');

/** What a handoff needs of the person who makes it: the abilities of every operation the gateway will run in the conversation. */
export const VCR_HANDOFF_ABILITIES = Object.freeze(['read', 'write', 'run']);

/**
 * Validate through current viewer authority both before staging and at native send. A study bound to another conversation is
 * usable only through a grant (R11), and a grant is the study OWNER's act, or a member's whose role holds every ability the gateway
 * will run in it (read, write, run): `options.grant` is the person's own act of picking it (the composer's study reference and the
 * 「在新对话中继续」 action stage it), recorded here and revocable; the native send never writes one, it only finds it. The grant binds
 * the conversation to the study, so the gateway needs no study argument. Study and conversation are compared as (person, project)
 * pairs, never by a bare project id, and a conversation that already belongs to somebody else cannot be handed a study.
 * @param {any} vcr @param {any} user @param {any} project @param {string} sessionId @param {any} input @param {{ grant?: boolean }} [options]
 */
export async function validateVcrConversationReference(vcr, user, project, sessionId, input, options = {}) {
  const reference = vcrObjectReference(input);
  if (!vcr?.service?.allows?.(user)) throw new HttpError(404, 'vcr_not_enabled', 'Research is not enabled.');
  if (!reference || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw invalid();
  if (reference.kind === 'model') {
    const models = await vcr.store.models(user.id);
    const checkModel = async selected => {
      const model = models.find(row => row.id === selected.objectId && row.version === selected.version);
      if (!model || selected.resultId) throw invalid();
      if (model.studyId) {
        if (reference.studyId !== model.studyId) throw invalid();
        await vcr.service.requireStudy(user, model.studyId);
        await vcr.access.require({ actor: user.id, studyId: model.studyId, ability: 'read', note: 'conversation-model-reference' });
      }
    };
    await checkModel(reference);
    if (reference.compareTo) await checkModel(reference.compareTo);
    return reference;
  }
  const study = await vcr.service.requireStudy(user, reference.studyId);
  const owner = String(study.userId) === String(user.id);
  // The owner's study lives in the owner's project: the pair must match. A member's conversation lives in the member's own project and
  // the study in the owner's, so a member has no project to compare and reaches the study only through a grant.
  if (owner && study.projectId !== project.id) throw invalid();
  await vcr.access.require({ actor: user.id, studyId: study.id, ability: 'read', note: 'conversation-object-reference' });
  // The conversation the study was made in needs no grant. A study with no conversation is reachable as context from the owner's own
  // conversations, but only a grant makes a conversation work in it.
  const ownConversation = study.conversationSessionId === sessionId && owner;
  const own = ownConversation || owner && !study.conversationSessionId;
  /** The grant of this person, or null. */
  const held = () => vcr.store.studyConversationGrant(study.id, sessionId, String(user.id));
  if (reference.kind === 'study') {
    if (!ownConversation) {
      if (options.grant === true) {
        if (!(await held())) {
          // a member holds every ability the gateway will run in the conversation, judged now (a viewer or a reviewer is refused with the role's own code)
          if (!owner) for (const ability of VCR_HANDOFF_ABILITIES) await vcr.access.require({ actor: user.id, studyId: study.id, ability, note: 'conversation-handoff' });
          if (await vcr.store.sessionClaimedByOther(sessionId, String(user.id))) throw invalid();
          await vcr.store.grantStudyConversation({ studyId: study.id, sessionId, grantedBy: String(user.id) });
        }
      } else if (!(await held())) throw invalid();
    }
    return { studyId: study.id, kind: 'study', objectId: 'study' };
  }
  if (!own && !(await held())) throw invalid();
  const methods = { population: 'populations', patient_set: 'patientSets', comparator: 'comparatorDesigns', trial_scenario: 'trialScenarios' };
  const rows = reference.kind === 'step' ? [] : await vcr.store[methods[reference.kind]](study.id, 500);
  const check = async selected => {
    if (reference.kind === 'step') {
      if (selected.resultId || reference.compareTo) throw invalid();
      return { ...selected, state: study.steps?.[selected.objectId] ?? null };
    }
    const object = rows.find(row => row.id === selected.objectId && row.version === selected.version);
    if (!object || (object.studyId && object.studyId !== study.id)) throw invalid();
    if (object.snapshotId) await vcr.access.require({ actor: user.id, studyId: study.id, ability: 'read', snapshotId: object.snapshotId, note: 'conversation-object-reference' });
    if (object.populationId) {
      const population = (await vcr.store.populations(study.id, 500)).find(row => row.id === object.populationId);
      if (!population) throw invalid();
      if (population.snapshotId) await vcr.access.require({ actor: user.id, studyId: study.id, ability: 'read', snapshotId: population.snapshotId, note: 'conversation-object-reference' });
    }
    if (selected.resultId) {
      const result = await vcr.store.result(study.id, selected.resultId);
      if (!result || result.subjectId !== selected.objectId || (selected.resultVersion !== undefined && result.version !== selected.resultVersion)) throw invalid();
    }
    return selected;
  };
  await check(reference);
  if (reference.compareTo) await check(reference.compareTo);
  return { ...reference, ...(reference.kind === 'step' ? { state: study.steps?.[reference.objectId] ?? null } : {}) };
}

/** The browser envelope is stripped and only a revalidated model-only block is added. */
export async function bindVcrConversationReference(vcr, user, project, request) {
  if (request?.evimedVcrReference === undefined) return;
  const input = request.evimedVcrReference;
  delete request.evimedVcrReference;
  const reference = await validateVcrConversationReference(vcr, user, project, request.sessionId, input);
  if (!Array.isArray(request.content)) throw invalid();
  // A study handed to this conversation binds it: the research tools work in that study without being told which. The staged selection
  // says so, so the model knows the work lands there.
  const handed = reference.studyId && await vcr.store.studyConversationGrant(reference.studyId, request.sessionId, String(user.id));
  const handoff = handed ? '\nThis study was handed to this conversation: vcr_read, vcr_write and vcr_simulate work in it here, and the work is saved to it.' : '';
  request.content = [...request.content, { type: 'text', text: `\n<evimed-vcr-selection>\n${JSON.stringify(reference).replaceAll("<", "\\u003c")}\nThese are the exact saved versions explicitly selected as context. Follow the researcher's latest instruction about what to do with them; this selection does not instruct you to adjust, compare or run anything by itself. When using these selected objects, preserve their original results and do not silently substitute newer versions. Explain missing or inapplicable inputs. This reference grants no source or patient access.${handoff}\n</evimed-vcr-selection>` }];
}
