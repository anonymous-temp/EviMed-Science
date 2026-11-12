/** Opening selection for the pinned plugin. The plugin alphabetizes names after REST listing,
 * so selection must happen here, before that sort and its per-directory token cuts. No file is changed.
 * Remove this budget adapter when upstream accepts ordered opening entries and a shared character cap.
 */

/** The plugin's CJK-aware estimator (profile-inject.mjs), rather than the resident renderer's estimator.
 * @param {string} text */
export function openingTokens(text) {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x3000) wide++;
  return Math.ceil(wide * 1.5 + (text.length - wide) / 4);
}

/** @param {any} file */
const count = file => Math.max(0, Number(file?.usedCount) || 0);
/** @param {any} file */
const lastUse = file => Date.parse(file?.lastUsedAt ?? '') || 0;

/** Stable use order, with a grace period for newly learned files. Unknown creation times get that chance too.
 * @param {any[]} entries @param {Map<string,any>} files @param {{ newFileDays?: number, now?: number }} [options] */
export function orderOpeningEntries(entries, files, { newFileDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(0, newFileDays) * 86_400_000;
  const old = entry => {
    const created = Date.parse(files.get(entry.uri)?.createdAt ?? '');
    return count(files.get(entry.uri)) === 0 && Number.isFinite(created) && created < cutoff ? 1 : 0;
  };
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) =>
    count(files.get(b.entry.uri)) - count(files.get(a.entry.uri))
    || lastUse(files.get(b.entry.uri)) - lastUse(files.get(a.entry.uri))
    || old(a.entry) - old(b.entry) || a.index - b.index).map(row => row.entry);
}

/** How much of profile.md the unmodified plugin puts before its listings: half of 10,000 tokens,
 * first eight lines plus the tail when over budget. This is only a measurement, never a write.
 * @param {string} value */
function openingProfile(value) {
  const text = value.trim();
  if (openingTokens(text) <= 5_000) return text;
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x3000) wide++;
  const maxChars = Math.max(400, Math.floor(5_000 / (wide / text.length * 1.5 + (1 - wide / text.length) / 4)));
  const lines = text.split('\n'), head = lines.slice(0, 8).join('\n'), marker = '\n... [profile middle elided] ...\n';
  const headOnly = () => text.slice(0, maxChars).trimEnd() + '\n... [profile truncated]';
  const room = maxChars - head.length - marker.length;
  if (lines.length <= 12 || room < 200) return headOnly();
  let start = lines.length, used = 0;
  for (let i = lines.length - 1; i > 8; i--) {
    if (used + lines[i].length + 1 > room) break;
    used += lines[i].length + 1;
    start = i;
  }
  return start >= lines.length - 1 ? headOnly() : head + marker + lines.slice(start).join('\n');
}

/** An optional opening view when the requested total cap cannot fit profile.md alone. Stored bytes stay untouched.
 * The unmarked REST profile route also serves direct REST callers; MCP read always returns the complete file.
 * @param {string} text @param {string} root @param {any} config */
export function openingProfileRead(text, root, config) {
  if (config?.memoryOpeningByUseEnabled !== true || !(Number(config.memoryOpeningMaxChars) > 0)) return text;
  const room = Math.max(0, Number(config.memoryOpeningMaxChars) - `<user-profile uri="${root}/profile.md">\n\n</user-profile>`.length);
  if (text.trim().length <= room) return text;
  if (!room) return '';
  const marker = '\n... [profile middle elided] ...\n';
  const head = text.split('\n').slice(0, 8).join('\n');
  if (room <= head.length + marker.length) return text.slice(0, room);
  return head + marker + text.slice(-(room - head.length - marker.length));
}

/** @param {any} entry */
const name = entry => String(entry.rel_path || entry.name || '');
/** @param {any[]} entries */
const leaves = entries => entries.filter(entry => !entry.isDir && name(entry).endsWith('.md'));
/** @param {any} entry */
const line = entry => `    - ${name(entry)}`;
/** @param {any[]} entries @param {string} uri */
function listing(entries, uri) {
  return entries.length ? [`  ${uri}/`, ...entries.map(line)] : [];
}
/** @param {string[]} lines */
const cost = lines => lines.reduce((sum, text) => sum + openingTokens(text), 0);

/** Today's alphabetical listing including the plugin's continuation marker, used to derive the default character cap.
 * @param {any[]} entries @param {string} uri @param {number} budget */
function currentListing(entries, uri, budget) {
  const sorted = leaves(entries).sort((a, b) => name(a).localeCompare(name(b)));
  if (!sorted.length) return { lines: [], used: 0 };
  const header = `  ${uri}/`, lines = [header];
  const stub = () => {
    const text = `  ${uri}/  (${sorted.length} entries, budget too tight; use \`memory_recall\`)`;
    return { lines: [text], used: openingTokens(text) };
  };
  let used = openingTokens(header);
  if (used > budget) return stub();
  for (let i = 0; i < sorted.length; i++) {
    const text = line(sorted[i]), tokens = openingTokens(text);
    if (used + tokens > budget) {
      let remaining = sorted.length - i;
      const tail = () => `    ... +${remaining} more, use \`memory_recall\``;
      while (used + openingTokens(tail()) > budget && lines.length > 1) {
        used -= openingTokens(lines.pop());
        remaining++;
      }
      if (lines.length === 1) return stub();
      if (used + openingTokens(tail()) <= budget) { lines.push(tail()); used += openingTokens(tail()); }
      return { lines, used };
    }
    lines.push(text); used += tokens;
  }
  return { lines, used };
}

/** Select globally by use, then enforce both the total character cap and the plugin's two token shares.
 * Zero/unset maxChars means today's effective size for this account; untouched accounts have identical opening bytes.
 * @param {{ preferences: any[], entities: any[], currentPreferences?: any[], currentEntities?: any[], profile?: string,
 *   root: string, files: Map<string,any>, config: any, now?: number }} input */
export function selectOpeningEntries({ preferences, entities, currentPreferences = preferences, currentEntities = entities,
  profile = '', root, files, config, now = Date.now() }) {
  if (config?.memoryOpeningByUseEnabled !== true) return { preferences, entities };
  const explicitCap = Number(config.memoryOpeningMaxChars) > 0;
  const all = [...leaves(preferences), ...leaves(entities)];
  if (!explicitCap && !all.some(entry => count(files.get(entry.uri)) > 0)) return { preferences, entities };
  const text = openingProfile(openingProfileRead(profile, root, config)), profileLines = text ? [`<user-profile uri="${root}/profile.md">`, text, '</user-profile>'] : [];
  const remainingTokens = Math.max(0, 10_000 - openingTokens(text));
  const prefUri = `${root}/preferences`, entUri = `${root}/entities`;
  const beforePref = currentListing(currentPreferences, prefUri, Math.floor(remainingTokens / 2));
  const beforeEnt = currentListing(currentEntities, entUri, Math.max(0, remainingTokens - beforePref.used));
  const render = (pref, ent) => [...profileLines, ...(pref.length || ent.length ? ['<available-memories>', ...pref, ...ent, '</available-memories>'] : [])].join('\n');
  const maxChars = explicitCap ? Number(config.memoryOpeningMaxChars) : render(beforePref.lines, beforeEnt.lines).length;
  const ranked = orderOpeningEntries(all, files, { newFileDays: config.memoryOpeningNewFileDays ?? 30, now });
  const selected = { preferences: [], entities: [] };
  const blocked = new Set();
  for (const entry of ranked) {
    const group = entry.uri.startsWith(`${prefUri}/`) ? 'preferences' : 'entities';
    if (blocked.has(group)) continue;
    selected[group].push(entry);
    const pref = listing(selected.preferences, prefUri), ent = listing(selected.entities, entUri);
    if (cost(pref) > Math.floor(remainingTokens / 2) || cost(ent) > remainingTokens - cost(pref)) {
      selected[group].pop(); blocked.add(group); continue;
    }
    if (render(pref, ent).length > maxChars) { selected[group].pop(); break; }
  }
  return selected;
}

/** Bounded native memos for the resident block. The caller supplies already scoped, redacted files and their receipts.
 * @param {any[]} files @param {any} config */
export function mostUsedMemos(files, config) {
  if (config?.memoryOpeningByUseEnabled !== true) return [];
  const limit = Math.max(0, Math.min(100, Math.trunc(Number(config.memoryOpeningTopK ?? 5)) || 0));
  return files.filter(file => count(file) > 0 && !file.sensitive && String(file.body ?? '').trim())
    .sort((a, b) => count(b) - count(a) || lastUse(b) - lastUse(a) || String(a.uri).localeCompare(String(b.uri)))
    .slice(0, limit).map(file => ({
      id: `native-used:${file.uri}`, memoryType: 'native_most_used', kind: 'note', scope: file.projectId ? 'project' : 'user',
      origin: 'unknown', updatedAt: file.updatedAt ?? null,
      content: `Most used · ${file.uri}\n${String(file.body).split('\n').filter(bodyLine => bodyLine.trim()).slice(0, 3).join('\n').slice(0, 400)}`,
      originalSources: file.originalSources ?? [], attribution: file.attribution, sourcePrivacy: file.sourcePrivacy,
    }));
}
