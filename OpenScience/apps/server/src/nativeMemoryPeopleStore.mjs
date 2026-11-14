import { NATIVE_TEXT_LIMIT } from './nativeMemoryPersistence.mjs';
import { HttpError } from './security.mjs';
import { contentHash, lineFingerprint, memoryLines, originalSources } from './nativeMemoryOverlay.mjs';
import { mergePeopleText, personProjectScope } from './nativeMemoryPeople.mjs';
import { personLabel } from './nativeMemoryInduction.mjs';
import { withMemorySummaryInvalidation } from './nativeMemorySummaries.mjs';

/** @typedef {import('./nativeMemoryPeople.mjs').PersonBefore} PersonBefore */
/** @typedef {{sessions:import('./openVikingSessions.mjs').OpenVikingSessions,kind?:string,namespaceId?:string|null,projectId?:string|null}} PeopleContext */
/** @typedef {{userId:string,overlay:import('./nativeMemoryOverlay.mjs').NativeMemoryOverlay,context:PeopleContext}} PeopleDependencies */
const conflict = () => new HttpError(409, 'memory_conflict', 'The people files changed. Read them again before merging or undoing.');

/** Restore exact line ancestry, including all origins of a duplicated line.
 * @param {PeopleDependencies} deps @param {PersonBefore} file @param {string} body @param {PersonBefore[]} sources */
async function writePeopleFile({ userId, overlay, context }, file, body, sources) {
  const present = new Set(memoryLines(body).map(lineFingerprint));
  /** @type {Map<string, import('./nativeMemoryPeople.mjs').PersonOrigin[]>} */
  const origins = new Map();
  for (const source of sources) for (const [print, origin] of source.origins) {
    if (present.has(print)) origins.set(print, [...(origins.get(print) ?? []), ...originalSources(origin)]);
  }
  await withMemorySummaryInvalidation(context.sessions, overlay, userId, file.uri, () => context.sessions.replace(userId, file.uri, body), async () => {
    // Preserve ancestry before summary maintenance can fail after the engine accepted the new bytes.
    await overlay.upsertFile({ userId, uri: file.uri, memoryType: 'people', body, projectId: file.projectId, sensitive: file.sensitive });
    await overlay.syncOrigins(userId, file.uri, { after: '' });
    await overlay.inheritOrigins(userId, file.uri, origins);
    if (file.projectId) await context.sessions.setTags(userId, file.uri, [`project=${file.projectId}`]);
  });
}

/** Persist a redo/undo receipt before touching engine bytes. A retry resumes only the exact recorded pair and before-images.
 * @param {PeopleDependencies & {keep:PersonBefore,merge:PersonBefore,engineSession:string}} deps */
export async function mergePeopleFiles(deps) {
  const { userId, overlay, context, keep, merge, engineSession } = deps;
  const active = await overlay.personMerges(userId);
  let operation = active.find(row => row.keepUri === keep.uri && row.mergeUri === merge.uri && row.state === 'pending');
  if (active.some(row => row.mergeUri === keep.uri || row.mergeUri === merge.uri && row !== operation)) throw conflict();
  if (!operation) {
    const after = mergePeopleText(keep.body, merge.body, personLabel(merge.uri, merge.body));
    // The native overlay and its revisions have a bounded text limit. Refuse before any truncating write.
    if (after.length > NATIVE_TEXT_LIMIT) throw new HttpError(400, 'memory_payload_invalid', 'The combined people file is too large.');
    const prepared = { keep, merge, after, confirmationSession: engineSession };
    const revision = await overlay.addRevision({ userId, uri: keep.uri, memoryType: 'people', change: 'updated', actor: 'conversation',
      // The confirming turn authorizes the move; it is not a new source of the transferred facts.
      reason: 'confirmed people merge', before: keep.body, after, projectId: keep.projectId });
    if (!revision) throw conflict();
    await overlay.recordPersonMerge(userId, revision.id, prepared);
    operation = { revisionId: revision.id, keepUri: keep.uri, mergeUri: merge.uri, state: 'pending', snapshot: prepared };
  }
  const snapshot = operation.snapshot;
  if (!snapshot) throw conflict();
  const [currentKeep, currentMerge] = await Promise.all([context.sessions.read(userId, keep.uri), context.sessions.read(userId, merge.uri)]);
  if (![snapshot.keep.body, snapshot.after].includes(currentKeep ?? '') || currentMerge !== null && currentMerge !== snapshot.merge.body) throw conflict();
  await writePeopleFile(deps, { ...snapshot.keep, sensitive: snapshot.keep.sensitive || snapshot.merge.sensitive }, snapshot.after, [snapshot.keep, snapshot.merge]);
  // Retirement uses the ordinary engine removal and overlay removal path, without a forget rejection: these facts still exist.
  await withMemorySummaryInvalidation(context.sessions, overlay, userId, merge.uri, () => context.sessions.remove(userId, merge.uri));
  await overlay.removeFile(userId, merge.uri);
  await overlay.settlePersonMerge(userId, operation.revisionId, 'applied');
  return { revisionId: operation.revisionId, keep: keep.uri, retired: merge.uri };
}

/** A two-file undo never overwrites a subsequent edit or resurrects a privacy-deleted snapshot.
 * @param {PeopleDependencies & {operation:import('./nativeMemoryPeople.mjs').PersonMerge}} deps */
export async function undoPeopleMerge(deps) {
  const { userId, overlay, context, operation } = deps;
  const snapshot = operation.snapshot;
  if (!snapshot) throw new HttpError(409, 'memory_source_deleted', 'The merge before-images were removed by a privacy deletion.');
  const [currentKeep, currentMerge] = await Promise.all([context.sessions.read(userId, operation.keepUri), context.sessions.read(userId, operation.mergeUri)]);
  if (currentKeep !== snapshot.after && currentKeep !== snapshot.keep.body || currentMerge !== null && currentMerge !== snapshot.merge.body) throw conflict();
  await writePeopleFile(deps, snapshot.keep, snapshot.keep.body, [snapshot.keep]);
  await writePeopleFile(deps, snapshot.merge, snapshot.merge.body, [snapshot.merge]);
  await overlay.settlePersonMerge(userId, operation.revisionId, 'undone');
  await overlay.markUndone(userId, operation.revisionId);
}

/** Resolve only an exact, previously confirmed retired path. No similarity or extractor-created alias confers write authority.
 * @param {PeopleDependencies & {uris:string[]}} deps */
export async function redirectPeopleWrites(deps) {
  const { userId, overlay, context, uris } = deps;
  const active = await overlay.personMerges(userId);
  for (const uri of new Set(uris)) {
    const redirect = active.find(row => row.mergeUri === uri && row.state === 'applied');
    if (!redirect) continue;
    let target = redirect.keepUri;
    const visited = new Set([uri]);
    while (active.some(row => row.mergeUri === target && row.state === 'applied')) {
      if (visited.has(target)) throw conflict();
      visited.add(target);
      target = /** @type {import('./nativeMemoryPeople.mjs').PersonMerge} */ (active.find(row => row.mergeUri === target && row.state === 'applied')).keepUri;
    }
    const [before, incoming] = await Promise.all([context.sessions.read(userId, target), context.sessions.read(userId, uri)]);
    if (incoming === null) continue;
    // A forgotten or deleted destination is not recreated from an old name.
    if (before === null) throw conflict();
    const origins = await overlay.originsOf(userId, [target, uri]);
    const files = await overlay.files(userId);
    const keepMeta = files.get(target), mergeMeta = files.get(uri);
    if (!keepMeta || !mergeMeta) throw conflict();
    const writable = [null, 'default', context.projectId ?? null];
    if (!writable.includes(keepMeta.projectId) || !writable.includes(mergeMeta.projectId)
      || personProjectScope(keepMeta.projectId) !== personProjectScope(mergeMeta.projectId)) throw conflict();
    const after = mergePeopleText(before, incoming, personLabel(uri, incoming));
    if (after.length > NATIVE_TEXT_LIMIT) throw conflict();
    const keep = { uri: target, body: before, projectId: keepMeta.projectId, sensitive: keepMeta.sensitive || mergeMeta.sensitive, origins: [...(origins.get(target) ?? [])] };
    const merge = { uri, body: incoming, projectId: mergeMeta.projectId, sensitive: mergeMeta.sensitive, origins: [...(origins.get(uri) ?? [])] };
    if (contentHash(after) !== contentHash(before)) {
      await overlay.addRevision({ userId, uri: target, memoryType: 'people', change: 'updated', actor: 'platform', reason: 'confirmed people redirect', before, after, projectId: keep.projectId });
    }
    // An unchanged body can still acquire a new first-party source; do not discard that origin with the retired path.
    await writePeopleFile(deps, keep, after, [keep, merge]);
    await withMemorySummaryInvalidation(context.sessions, overlay, userId, uri, () => context.sessions.remove(userId, uri));
    await overlay.removeFile(userId, uri);
  }
}
