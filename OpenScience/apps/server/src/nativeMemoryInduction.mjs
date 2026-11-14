// Syntax and identity only. The existing extraction call judges meaning; no extra model or embedding call.
/** @typedef {{kind:string,scope:string,choice:string,subject:'work'}} Choice */
/** @param {string} text */
export const normaliseChoice = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
/** @param {Choice} row */
export const choiceKey = row => JSON.stringify([row.kind, normaliseChoice(row.scope), normaliseChoice(row.choice)]);
/** @param {string} body @returns {Choice[]} */
export function choiceRows(body) {
  /** @type {Choice[]} */
  const rows = [];
  for (const line of body.split('\n')) {
    const match = /^\s*- Choice: (\{.*\})\s*$/.exec(line);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (value.subject !== 'work' || !['form', 'structure', 'tool', 'format', 'length', 'method'].includes(value.kind)
        || typeof value.scope !== 'string' || !value.scope.trim() || value.scope.length > 160
        || typeof value.choice !== 'string' || !value.choice.trim() || value.choice.length > 400) continue;
      rows.push({ kind: value.kind, scope: value.scope, choice: value.choice, subject: 'work' });
    } catch { /* An untyped note remains a note; no inference from prose or filenames. */ }
  }
  return rows;
}
/** @param {Choice} row @param {string[]} dates @param {number} count */
export function inferredChoiceMessage(row, dates, count) {
  return `Record a tentative preference, not a statement the user made: ${row.scope}: ${row.choice}.\n`
    + `Keep this exact provenance on the preference line: [Inferred from behaviour; ${count} conversations; dates: ${dates.join(', ') || 'unknown'}].\n`
    + `A stated preference takes precedence. Withdraw this inference when a later choice for the same scope differs, or an explicit statement supersedes it; retain dated history only as history.\n`
    + `Do not convert this into an explicit instruction or profile fact. Keep a separate identity bullet exactly: - Choice: ${JSON.stringify(row)}.`;
}
/** Edit distance is a name hint, never identity authority. @param {string} left @param {string} right */
export function closePersonNames(left, right) {
  const a = [...normaliseChoice(left)], b = [...normaliseChoice(right)];
  if (a.length < 2 || b.length < 2 || a.length > 100 || b.length > 100) return false;
  // Shared literal name suffix or family-name/title shape is a hint only, not a language judgement.
  if (Math.min(a.length, b.length) >= 3 && (a.join('').endsWith(b.join('')) || b.join('').endsWith(a.join(''))
    || a[0] === b[0] && a.slice(-2).join('') === b.slice(-2).join(''))) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = current;
  }
  return previous[b.length] <= (Math.min(a.length, b.length) >= 5 ? 2 : 1);
}
/** Only the template's explicit confirmation marker, never fuzzy similarity. @param {string} body @returns {string[]} */
export function confirmedAliases(body) {
  const match = /^\s*- Confirmed aliases: (\[.*\])\s*$/m.exec(body);
  if (!match) return [];
  try {
    const names = JSON.parse(match[1]);
    return Array.isArray(names) && names.length >= 2 && names.length <= 10
      && names.every(name => typeof name === 'string' && name.trim().length >= 2 && name.length <= 100)
      ? [...new Set(/** @type {string[]} */ (names))] : [];
  } catch { return []; }
}
/** Replace longest literal name first so a short alias cannot alter a longer one twice.
 * @param {string} line @param {string[]} names @returns {string[]} */
export function aliasVariants(line, names) {
  const matched = [...names].sort((a, b) => b.length - a.length).find(name => line.includes(name));
  return matched ? [...new Set([line, ...names.map(name => line.split(matched).join(name))])] : [line];
}
/** @param {string} uri @param {string} body */
export function personLabel(uri, body) {
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (title) return title;
  const filename = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.md$/, '');
  try { return decodeURIComponent(filename); } catch { return filename; }
}

/** Confirmed links are local to the caller's already scoped file inventory.
 * @param {{uri:string,body:string}[]} files @param {{uri:string,body:string}} origin @returns {string[]} */
export function aliasesFor(files, origin) {
  const label = personLabel(origin.uri, origin.body);
  const names = new Set([label, ...confirmedAliases(origin.body)]);
  // No transitive guesses. Each added name is in an explicit marker naming this exact person.
  for (const file of files) {
    const aliases = confirmedAliases(file.body);
    if (aliases.includes(label)) for (const alias of aliases) names.add(alias);
  }
  return names.size > 1 ? [...names] : [];
}

/** The extractor classifies explicit identity; code requires its exact quoted user evidence.
 * @param {string} body @param {{role:string,text:string}[]} sources @returns {string[]} */
export function confirmedAliasRequest(body, sources) {
  const names = confirmedAliases(body);
  const match = /^\s*- Alias confirmation: (".*")\s*$/m.exec(body);
  if (!names.length || !match) return [];
  try {
    const quote = JSON.parse(match[1]);
    return typeof quote === 'string' && quote.length >= 4 && quote.length <= 1000
      && names.every(name => quote.includes(name))
      && sources.some(source => source.role === 'user' && source.text.includes(quote)) ? names : [];
  } catch { return []; }
}
