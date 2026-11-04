// An unwired commit-time verifier. The caller must hold the study and all
// declared source fences and execute this in the same database transaction.
/** @param {{dataPlane:any, matchStore:any}} deps */
export function createVcrLanguageSourceLoader({ dataPlane, matchStore }) {
  if (!dataPlane || !matchStore) throw new TypeError('The data plane and matching store are required.');
  return async ({ studyId, userId, subjectKey, documents, evidence }) => {
    try {
      const withdrawn = await matchStore.withdrawnSubjects(studyId);
      if (withdrawn.has(subjectKey)) return null;
      const roster = await dataPlane.listDocuments({ studyId, principal:userId, subjectKey });
      const expected = new Map(documents.map(doc => [doc.id, doc]));
      if (roster.length !== expected.size || roster.some(row => !expected.has(row.id) || expected.get(row.id).sourceId !== row.sourceId)) return null;
      const verified = new Map();
      const loaded = [];
      for (const doc of documents) {
        const file = await dataPlane.store.getSourceFile(studyId, doc.id);
        if (!file || file.erasedAt || file.sourceId !== doc.sourceId || file.detail?.subjectKey !== subjectKey) return null;
        const actual = await dataPlane.projectionText({ studyId, documentId:doc.id, principal:userId, purpose:'vcr' }, true);
        if (!actual || actual.subjectKey !== subjectKey || actual.sourceHash !== doc.sourceHash
          || (actual.projectionHash ?? null) !== doc.projectionHash || actual.id !== (doc.projectionId ?? doc.id) || typeof actual.text !== 'string') return null;
        loaded.push({ documentId:actual.id, sourceDocumentId:doc.id, text:actual.text, visibleAt:actual.visibleAt ?? null });
        verified.set(doc.id, actual);
        verified.set(actual.id, actual);
      }
      for (const entry of evidence) {
        if (!entry || Object.keys(entry).some(key => !['documentId','start','end','quote','visibleAt'].includes(key))) return null;
        const doc = verified.get(entry.documentId);
        if (!doc || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < 0 || entry.end <= entry.start
          || typeof entry.quote !== 'string' || doc.text.slice(entry.start,entry.end) !== entry.quote
          || (entry.visibleAt ?? null) !== (doc.visibleAt ?? null)) return null;
      }
      return loaded;
    } catch { return null; }
  };
}

/** Boolean wrapper for the internal commit primitive. @param {{dataPlane:any, matchStore:any}} deps */
export function createVcrLanguageSourceVerifier(deps) {
  const load = createVcrLanguageSourceLoader(deps);
  return async (input) => (await load(input)) !== null;
}
