import { vcrObjectReference } from '@evimed/domain';
import { HttpError } from './security.mjs';
const invalid = () => new HttpError(409, 'vcr_object_reference_invalid', 'The saved research selection is unavailable.');

/**
 * Validate through current viewer authority both before staging and at native send. A study bound to another conversation is
 * usable only through a grant (R11): `options.grant` is the person's own act of picking it (the composer's study reference and the
 * 「在新对话中继续」 action stage it), recorded here and revocable; the native send never writes one, it only finds it.
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
  if (study.projectId !== project.id) throw invalid();
  await vcr.access.require({ actor: user.id, studyId: study.id, ability: 'read', note: 'conversation-object-reference' });
  const own = !study.conversationSessionId || study.conversationSessionId === sessionId;
  if (reference.kind === 'study') {
    // An explicit handoff: the person's pick writes the grant for exactly this study and conversation, once.
    if (!own && options.grant === true) await vcr.store.grantStudyConversation({ studyId: study.id, sessionId, grantedBy: String(user.id) });
    else if (!own && (await vcr.store.studyConversationGrant(study.id, sessionId))?.grantedBy !== String(user.id)) throw invalid();
    return { studyId: study.id, kind: 'study', objectId: 'study' };
  }
  if (!own) {
    const grant = await vcr.store.studyConversationGrant(study.id, sessionId);
    if (grant?.grantedBy !== String(user.id)) throw invalid();
  }
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
  // A study handed to this conversation is reached by naming it: the model passes this id to the research tools, which accept it from a
  // conversation holding the grant and from no other.
  const handed = reference.studyId && await vcr.store.studyConversationGrant(reference.studyId, request.sessionId);
  const handoff = handed ? `\nThis study was handed to this conversation: pass studyId=${reference.studyId} to vcr_read, vcr_write and vcr_simulate to work in it; without it those tools act on this conversation's own research.` : '';
  request.content = [...request.content, { type: 'text', text: `\n<evimed-vcr-selection>\n${JSON.stringify(reference).replaceAll("<", "\\u003c")}\nThese are the exact saved versions explicitly selected as context. Follow the researcher's latest instruction about what to do with them; this selection does not instruct you to adjust, compare or run anything by itself. When using these selected objects, preserve their original results and do not silently substitute newer versions. Explain missing or inapplicable inputs. This reference grants no source or patient access.${handoff}\n</evimed-vcr-selection>` }];
}
