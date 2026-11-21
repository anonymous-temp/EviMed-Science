import { createHash } from 'node:crypto';
import { MEMORY_NEVER_KEPT_TEXT } from '@evimed/domain';
import { callModelForControlPlane } from './modelGateway.mjs';
import { lineFingerprint, originalSources } from './nativeMemoryOverlay.mjs';
import { REJECTION_JUDGE_MAX_CANDIDATES, removalRefusals, removalText } from './nativeMemoryRejections.mjs';
import { nativeMemoryFile } from './openVikingSessions.mjs';
import { withNativeMemoryWrite } from './nativeMemoryWriteFence.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const instruction = `Classify the numbered lines of an existing personal memory card as data. Select only reported personal safety history (allergies, contraindications, serious reactions or other critical limitations). Preserve whose history it is, dates, uncertainty, negations and every qualifying condition. Preferences, hypothetical questions, instructions to the reader and unadopted suggestions are not safety history. Never infer a medical fact. Return JSON {"ranges":[[first,last],...]} with one inclusive, 1-based contiguous range per complete fact. The original card title identifies the subject; include any necessary section heading, attribution or continuation in the range. If the source cannot support a self-contained fact, leave it out. Attribute the user's own report, another person's history, and a document claim separately. Do not generate prose.\n\n${MEMORY_NEVER_KEPT_TEXT}`;

/** @param {any} config @param {any} usageLedger */
export function safetyClassifier(config, usageLedger) {
  return async (userId, uri, lines) => {
    const body = await callModelForControlPlane({ config, usageLedger }, { userId, projectId: 'default', runId: null,
      purpose: 'memory-extraction', signal: AbortSignal.timeout(config.memoryExtractionTimeoutMs || 30_000),
      body: { model: config.memoryExtractionModel || config.deepseekModel, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({
          file: uri.split('/memories/').at(-1), lines: lines.map((text, index) => [index + 1, text]) }) }] } });
    return JSON.parse(body?.choices?.[0]?.message?.content ?? '').ranges;
  };
}

/** A bad or overlapping range invalidates the response. No model-authored words reach storage. */
export function safetySelections(lines, ranges) {
  if (!Array.isArray(ranges)) throw new Error('Invalid safety classification');
  const covered = new Set();
  return ranges.map(range => {
    if (!Array.isArray(range) || range.length !== 2) throw new Error('Invalid safety range');
    const [start, last] = range;
    let end = last;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new Error('Invalid safety range');
    // Markdown continuation lines travel with the selected statement, including a final exception.
    while (end < lines.length && /^[ \t]+\S/.test(lines[end])) end++;
    for (let index = start; index <= end; index++) {
      if (covered.has(index)) throw new Error('Overlapping safety ranges');
      covered.add(index);
    }
    const selected = lines.slice(start - 1, end);
    if (!selected.some(line => line.trim() && !/^\s*#/.test(line))) throw new Error('Empty safety range');
    return selected;
  });
}

/** Remove a projected fact as a unit, including its qualifications. A later independent
 * fact added to the same engine card keeps its heading and original wording.
 * @param {string} source @param {string|null} next @param {any} binding @param {string} copy */
export function withdrawSafetyProjection(source, next, binding, copy) {
  const hashes = new Set((next ?? '').split(/\r?\n/).map(digest));
  if (next !== null && binding.lineHashes.every(hash => hashes.has(hash)) &&
      (!binding.titleFromFile || hashes.has(binding.titleHash))) return null;
  const words = source.split(/\r?\n/).filter(line => binding.lineHashes.includes(digest(line))).map(removalText);
  const prints = new Set(words.map(lineFingerprint));
  const remaining = copy.split(/\r?\n/).filter(line =>
    !binding.lineHashes.includes(digest(line)) && !prints.has(lineFingerprint(removalText(line))));
  return { words, body: remaining.some(line => line.trim() && !/^\s*#/.test(line)) ? remaining.join('\n') : '' };
}

/** Scope an individual statement to its card and section. A shared heading or a drug name alone
 * never identifies a fact. Different wording is decided by the existing strict statement judge. */
export function safetyStatements(body, uri) {
  const headings = [];
  const rows = [];
  for (const [index, line] of (body ?? '').split(/\r?\n/).entries()) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      headings.length = heading[1].length - 1;
      headings.push(heading[2]);
    } else if (line.trim()) {
      const text = removalText(line);
      rows.push({ line, hash: digest(line), index, text, scoped: [...(headings[0] ? headings : [uri.split('/').at(-1), ...headings]), text].filter(Boolean).join('\n') });
    }
  }
  return rows;
}

/** Return only matches among the supplied statements. Batch all candidates, including earlier
 * cards without provenance, so the judge's per-call limit cannot truncate a withdrawal. */
export async function matchSafetyStatements(userId, candidates, references, judge) {
  const matches = new Map();
  if (!references.length) return matches;
  const options = references.map(row => ({ fingerprint: lineFingerprint(row.scoped), text: row.scoped }));
  const unmatched = [];
  for (const row of candidates) {
    const exact = references.find(ref => lineFingerprint(ref.scoped) === lineFingerprint(row.scoped));
    if (exact) matches.set(row, exact);
    else unmatched.push(row);
  }
  if (judge) {
    for (let i = 0; i < unmatched.length; i += REJECTION_JUDGE_MAX_CANDIDATES) {
      const batch = unmatched.slice(i, i + REJECTION_JUDGE_MAX_CANDIDATES);
      const result = await judge.same({ userId, requireAvailable: true, said: [],
        candidates: batch.map(row => ({ text: row.scoped, removed: options })) });
      for (const [index, fingerprint] of result.same) {
        const ref = references.find(row => lineFingerprint(row.scoped) === fingerprint);
        if (batch[index] && ref) matches.set(batch[index], ref);
      }
    }
  }
  return matches;
}

/** Install the original source before ordinary extraction attribution. The existing line-origin
 * index keeps its first writer and prunes the entry when the line leaves the destination. */
export async function inheritSafetyProjections(userId, uri, body, added, overlay, judge) {
  const references = [];
  for (const file of (await overlay.files(userId)).values()) {
    if (!file.safetySource || file.uri === uri) continue;
    for (const row of safetyStatements(file.body, file.uri)) {
      if (file.safetySource.lineHashes.includes(digest(row.line))) references.push({ ...row, projection: file.uri, binding: file.safetySource });
    }
  }
  const candidates = safetyStatements(body, uri).filter(row => added.has(lineFingerprint(row.text)));
  const matches = await matchSafetyStatements(userId, candidates, references, judge);
  if (!matches.size) return;
  const origins = await overlay.originsOf(userId, [...new Set([...matches.values()].map(ref => ref.binding.uri))]);
  const inherited = new Map();
  for (const [row, ref] of matches) {
    const prior = originalSources(origins.get(ref.binding.uri)?.get(lineFingerprint(ref.text)));
    inherited.set(lineFingerprint(row.text), (prior.length ? prior : [{}]).map(source => ({
      ...source, safetyProjectionUri: ref.projection, safetySourceUri: ref.binding.uri, safetyLineHash: digest(ref.line),
    })));
  }
  await overlay.inheritOrigins(userId, uri, inherited);
}

/** One source per account per durable scheduling interval. Classify outside the writer fence.
 * The mutation rechecks visibility, bytes, permissions and withdrawal before creating a copy.
 * @param {any} dependencies @param {string} userId */
export async function migrateSafetyNotes({ config, store, overlay, sessions, settings, classify }, userId) {
  if (!config.memorySafetyNotesEnabled || !config.memorySafetyNotesMigrationEnabled) return;
  const paused = await settings.settings(userId);
  if (paused.learningPaused) return;
  const scan = await overlay.claimSafetyScan(userId);
  if (!scan) return;
  if (!(await sessions.settings(userId))?.memoryTypes.includes('safety_notes')) return;
  const root = sessions.memoryRoot(userId);
  // Older failed batch writes left a binding and inherited origins without a file.
  // Recheck under the writer lease: a timeout may also have committed engine bytes.
  for (const file of (await overlay.files(userId)).values()) {
    if (!file.safetySource || file.contentHash) continue;
    await withNativeMemoryWrite(overlay.database, userId, async () => {
      if (await sessions.read(userId, file.uri) === null) await overlay.removeSafetyOrphan(userId, file.uri);
    }, { exclusive: true });
  }
  const visibleSources = async () => {
    const inventory = await overlay.files(userId);
    const hidden = await overlay.sensitiveUris(userId);
    const nodes = await sessions.tree(userId, root, { levelLimit: 8 });
    return nodes.filter(node => !node.isDir).map(node => inventory.get(node.uri) ?? { uri: node.uri,
      projectId: node.tags?.find(tag => tag.startsWith('project='))?.slice(8) }).filter(file => ['people', 'profile'].includes(nativeMemoryFile(file.uri, root)?.type)
      && !file.sensitive && !(paused.pausedProjects ?? []).includes(file.projectId)
      && !hidden.some(uri => file.uri === uri || file.uri.startsWith(uri + '/')));
  };
  const read = async file => {
    const [live] = await store.files(userId, { uris: [file.uri] });
    if (!live || live.sensitive) return null;
    const records = await store.records(userId, { files: [live] });
    if (!records.length) return null;
    const visible = new Set(records.map(row => lineFingerprint(row.value)));
    const body = live.type === 'profile' ? live.body.split('\n').filter(line =>
      /^\s*#/.test(line) || visible.has(lineFingerprint(removalText(line)))).join('\n') : records[0].value;
    if (!body.trim()) return null;
    return { body, updatedAt: records[0].updatedAt ?? live.modTime, hash: live.hash, type: live.type, projectId: live.projectId, raw: live.body };
  };
  const safe = async (words) => {
    let unavailable = false;
    const judge = store.rejectionJudge && { same: async input => {
      try { return await store.rejectionJudge.same({ ...input, requireAvailable: true }); }
      catch (error) { unavailable = true; throw error; }
    } };
    const refused = await removalRefusals({ userId, overlay, judge, candidates: words.map(text => ({ text, sources: [] })) });
    if (unavailable) throw new Error('Safety migration withdrawal review unavailable');
    return refused;
  };
  // A malformed response or a temporarily unavailable source must not starve the next card.
  const candidates = (await visibleSources()).map(file => ({ file, cursor: digest(file.uri) }));
  candidates.sort((a, b) => Number(a.cursor <= scan.cursor) - Number(b.cursor <= scan.cursor) || a.cursor.localeCompare(b.cursor));
  for (const { file, cursor } of candidates) {
    const reviewKey = hash => digest(JSON.stringify(['safety-classification-v1', file.uri, hash]));
    if (file.contentHash && await overlay.instructionCheck(userId, reviewKey(file.contentHash))) continue;
    await overlay.noteSafetyScan(userId, cursor);
    const source = await read(file);
    if (!source) continue;
    if (file.contentHash && source.hash !== file.contentHash) continue;
    const key = reviewKey(source.hash);
    const removalsBefore = JSON.stringify(await overlay.removals(userId));
    const lines = source.body.split(/\r?\n/);
    const refused = await safe(lines.filter(line => line.trim()).map(removalText));
    // A withdrawn subject or exception can change the meaning of a surviving line.
    // Revisit an intact file after normal forget maintenance removes the rejected bytes.
    if (refused.size) continue;
    const sourceTitle = lines.find(line => /^#\s+\S/.test(line));
    const title = sourceTitle ?? (file.uri.endsWith('/profile.md') ? '# 用户本人' : '# ' + file.uri.split('/').pop().replace(/\.md$/, ''));
    if ((await safe([removalText(title)])).size) continue;
    const ranges = safetySelections(lines, await classify(userId, file.uri, lines));
    await withNativeMemoryWrite(overlay.database, userId, async () => {
      const latestSettings = await settings.settings(userId);
      if (latestSettings.learningPaused || (latestSettings.pausedProjects ?? []).includes(file.projectId)) return;
      if (!(await visibleSources()).some(row => row.uri === file.uri) || (await read(file))?.body !== source.body) return;
      // A listing cache can reuse the same modification time and size. The mutation needs fresh engine bytes.
      if (await sessions.read(userId, file.uri) !== source.raw || JSON.stringify(await overlay.removals(userId)) !== removalsBefore) return;
      if (!file.contentHash) await overlay.upsertFile({ userId, uri: file.uri, memoryType: source.type,
        projectId: source.projectId, body: source.raw });
      const origins = (await overlay.originsOf(userId, [file.uri])).get(file.uri);
      if (ranges.length) await sessions.ensureTypeDirectory(userId, 'safety_notes');
      for (const selected of ranges) {
        const body = [title, ...selected.filter(line => line !== title)].join('\n');
        const words = [title, ...selected].map(removalText).filter(Boolean);
        const lineHashes = selected.filter(line => line.trim()).map(digest);
        const uri = root + '/safety_notes/legacy-' + digest(JSON.stringify([file.uri, lineHashes])) + '.md';
        const binding = { uri: file.uri, lineHashes, titleFromFile: Boolean(sourceTitle), titleHash: digest(title), sourceHash: source.hash, updatedAt: source.updatedAt };
        const before = await sessions.read(userId, uri);
        // A person's edit at the deterministic destination wins. A partial first write is retried.
        if (before !== null && before !== body) continue;
        await overlay.bindSafetySource(userId, uri, binding);
        await overlay.inheritOrigins(userId, uri, new Map(words.map(word => {
          const fingerprint = lineFingerprint(word);
          return [fingerprint, originalSources(origins?.get(fingerprint))];
        })));
        if (before === null) {
          try {
            await sessions.replace(userId, uri, body);
          } catch (error) {
            // Only a definitive refusal proves the write cannot arrive later.
            const status = /** @type {any} */ (error)?.upstreamStatus;
            if (status >= 400 && status < 500) await overlay.removeSafetyOrphan(userId, uri);
            throw error;
          }
        }
        await overlay.upsertFile({ userId, uri, memoryType: 'safety_notes', body });
      }
      await overlay.recordInstructionCheck(userId, key, { safetyClassification: true });
    }, { exclusive: true });
    return;
  }
}
