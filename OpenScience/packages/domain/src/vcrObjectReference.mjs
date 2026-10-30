/** Closed saved-object selection. Identifiers remain context, never authority. */
export const VCR_OBJECT_REFERENCE_KINDS = Object.freeze(['population', 'patient_set', 'comparator', 'trial_scenario', 'model', 'step']);
/** @param {any} value */
export function vcrObjectReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !VCR_OBJECT_REFERENCE_KINDS.includes(value.kind)
    || (value.studyId === undefined ? value.kind !== 'model' : typeof value.studyId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.studyId))) return null;
  /** @param {any} item */
  const selection = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.objectId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(item.objectId)) return null;
    if (value.kind === 'step' ? !['definition','evidence','population','patients','comparator','trial','matching'].includes(item.objectId) || (item.version !== undefined && (!Number.isSafeInteger(item.version) || item.version < 1))
      : value.kind === 'model' ? typeof item.version !== 'string' || !item.version || item.version.length > 80
        : !Number.isSafeInteger(item.version) || item.version < 1) return null;
    if (item.resultId !== undefined && (typeof item.resultId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.resultId))) return null;
    if (item.resultVersion !== undefined && (!item.resultId || !Number.isSafeInteger(item.resultVersion) || item.resultVersion < 1)) return null;
    return { objectId: item.objectId, ...(item.version === undefined ? {} : { version: item.version }), ...(item.resultId ? { resultId: item.resultId } : {}), ...(item.resultVersion ? { resultVersion: item.resultVersion } : {}) };
  };
  const selected = selection(value);
  const compareTo = value.compareTo === undefined ? undefined : selection(value.compareTo);
  if (!selected || (value.kind === 'step' && compareTo !== undefined) || compareTo === null || (compareTo && compareTo.objectId === selected.objectId && compareTo.version === selected.version && compareTo.resultId === selected.resultId)) return null;
  return { ...(value.studyId === undefined ? {} : { studyId: value.studyId }), kind: value.kind, ...selected, ...(compareTo ? { compareTo } : {}) };
}
