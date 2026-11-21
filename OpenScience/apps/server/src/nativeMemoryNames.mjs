import { memoryLines, originalSources } from './nativeMemoryOverlay.mjs';
import { nativeMemoryFile } from './openVikingSessions.mjs';
import { fenceWithdrawnMemoryBody, withMemorySummaryInvalidation } from './nativeMemorySummaries.mjs';
import { removalRefusals } from './nativeMemoryRejections.mjs';
import { memoryNameVariants } from './nativeMemoryHardTokens.mjs';
import { NATIVE_TEXT_LIMIT } from './nativeMemoryPersistence.mjs';

/** Formatting equality only, never transliteration, spelling repair or inferred identity.
 * Each path segment remains distinct: a person's disambiguating suffix is not discarded.
 * @param {string} value */
export function normalizedMemoryName(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
}

/** @param {string} uri @param {string} root */
export function memoryNameKey(uri, root) {
  const file = nativeMemoryFile(uri, root);
  if (!file || file.type === 'profile') return null;
  const segments = file.relPath.replace(/\.md$/i, '').split('/').map(normalizedMemoryName);
  if (segments.some(segment => !segment)) return null;
  return JSON.stringify([file.type, ...segments]);
}

/** Keep the latest dated card first; retain every distinct older statement verbatim.
 * No semantic deduplication: dates and conflicting values remain inspectable.
 * @param {string} current @param {string} earlier */
export function mergeNormalizedMemoryText(current, earlier) {
  // A privacy fingerprint deliberately strips "as of" dates. For copying historical
  // statements, two differently dated observations must both survive.
  const present = new Set(memoryLines(current));
  const missing = [...new Set(memoryLines(earlier))].filter(line => !present.has(line));
  if (!missing.length) return current;
  const dated = line => [...line.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]).sort().at(-1) ?? '';
  missing.sort((left, right) => dated(right).localeCompare(dated(left)));
  return `${current.trimEnd()}\n\n## Earlier retained statements\n${missing.map(line => `- ${line}`).join('\n')}`;
}

/** The engine owns creation. Reconcile its committed paths under the existing owner write
 * fence, before another worker operation; never merge across project/privacy boundaries.
 * All ancestors are copied before retiring a formatting-only sibling. A partial failure
 * leaves duplicate readable bytes and retries safely; it never rolls back user statements.
 * @param {{userId:string,context:any,overlay:any}} input */
export async function reconcileMemoryNames({ userId, context, overlay }) {
  const sessions = context.sessions, root = sessions.memoryRoot(userId);
  if (overlay.sourceDeletion && (await overlay.sourceDeletion.ledger.recordsForOwner(userId, { pendingOnly: true })).length) return 0;
  const hidden = overlay.sourceDeletion ? await overlay.sourceDeletion.hiddenMemoryUris(userId) : [];
  const files = await overlay.files(userId);
  const groups = new Map();
  for (const [uri, meta] of files) {
    const key = memoryNameKey(uri, root);
    if (!key || meta.sensitive || hidden.some(prefix => uri === prefix || uri.startsWith(`${prefix}/`))) continue;
    const scoped = JSON.stringify([key, meta.projectId ?? null]);
    if (!groups.has(scoped)) groups.set(scoped, []);
    groups.get(scoped).push({ ...meta, uri });
  }
  let merged = 0;
  for (const group of groups.values()) {
    // Prefer the pre-existing path, then a stable lexical tie-breaker.
    group.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.uri.localeCompare(b.uri));
    const keep = group[0];
    for (const sibling of group.slice(1)) {
      const before = await sessions.read(userId, keep.uri), incoming = await sessions.read(userId, sibling.uri);
      if (before === null || incoming === null) continue;
      const namespaceId = context.kind === 'geo-project' ? context.namespaceId : null;
      // A merge is not fresh user confirmation. Do not copy a withdrawn statement or title.
      if (await fenceWithdrawnMemoryBody(overlay, userId, keep.uri, before, namespaceId) !== before
        || await fenceWithdrawnMemoryBody(overlay, userId, sibling.uri, incoming, namespaceId) !== incoming) continue;
      if ((await removalRefusals({ userId, overlay, projectId: keep.projectId ?? null, namespaceId,
        candidates: [...memoryLines(before + '\n' + incoming), ...memoryNameVariants(keep.uri),
          ...memoryNameVariants(sibling.uri)].map(text => ({ text })) })).size) continue;
      const latestDate = body => [...body.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]).sort().at(-1) ?? '';
      const incomingNewer = latestDate(incoming) > latestDate(before)
        || latestDate(incoming) === latestDate(before) && String(sibling.updatedAt ?? '') > String(keep.updatedAt ?? '');
      const after = incomingNewer ? mergeNormalizedMemoryText(incoming, before) : mergeNormalizedMemoryText(before, incoming);
      if (after.length > NATIVE_TEXT_LIMIT) continue;
      const sources = await overlay.originsOf(userId, [keep.uri, sibling.uri]);
      const origins = new Map();
      for (const uri of [keep.uri, sibling.uri]) for (const [print, origin] of sources.get(uri) ?? []) {
        origins.set(print, [...(origins.get(print) ?? []), ...originalSources(origin)]);
      }
      if (await sessions.read(userId, keep.uri) !== before || await sessions.read(userId, sibling.uri) !== incoming) continue;
      const type = nativeMemoryFile(keep.uri, root).type;
      await overlay.addRevision({ userId, uri: keep.uri, memoryType: type, projectId: keep.projectId ?? null,
        change: 'updated', actor: 'platform', reason: 'normalized memory name', before, after });
      await withMemorySummaryInvalidation(sessions, overlay, userId, keep.uri, () => sessions.replace(userId, keep.uri, after), async () => {
        await overlay.upsertFile({ userId, uri: keep.uri, memoryType: type, projectId: keep.projectId ?? null, body: after });
        await overlay.inheritOrigins(userId, keep.uri, origins);
        if (keep.projectId) await sessions.setTags(userId, keep.uri, [`project=${keep.projectId}`]);
      });
      if (await sessions.read(userId, keep.uri) !== after || await sessions.read(userId, sibling.uri) !== incoming) continue;
      await overlay.addRevision({ userId, uri: sibling.uri, memoryType: type, projectId: sibling.projectId ?? null,
        change: 'deleted', actor: 'platform', reason: 'normalized memory name', before: incoming, after: null });
      await withMemorySummaryInvalidation(sessions, overlay, userId, sibling.uri, () => sessions.remove(userId, sibling.uri));
      await overlay.removeFile(userId, sibling.uri);
      merged++;
      keep.updatedAt = [keep.updatedAt, sibling.updatedAt].sort().at(-1);
      if (merged >= 32) return merged;
    }
  }
  return merged;
}
