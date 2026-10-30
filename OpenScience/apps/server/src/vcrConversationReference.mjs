import { vcrObjectReference } from '@evimed/domain';
import { HttpError } from './security.mjs';
const invalid = () => new HttpError(409, 'vcr_object_reference_invalid', 'The saved research selection is unavailable.');

/** Validate through current viewer authority both before staging and at native send. */
export async function validateVcrConversationReference(vcr, user, project, sessionId, input) {
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
  if (study.projectId !== project.id || (study.conversationSessionId && study.conversationSessionId !== sessionId)) throw invalid();
  await vcr.access.require({ actor: user.id, studyId: study.id, ability: 'read', note: 'conversation-object-reference' });
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
  request.content = [...request.content, { type: 'text', text: `\n<evimed-vcr-selection>\n${JSON.stringify(reference).replaceAll("<", "\\u003c")}\nThese are the exact saved versions explicitly selected as context. Follow the researcher's latest instruction about what to do with them; this selection does not instruct you to adjust, compare or run anything by itself. When using these selected objects, preserve their original results and do not silently substitute newer versions. Explain missing or inapplicable inputs. This reference grants no source or patient access.\n</evimed-vcr-selection>` }];
}
