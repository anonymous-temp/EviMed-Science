import { createRequire } from 'node:module';
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
// Default Mandarin readings of U+4E00..U+9FFF, generated one character per line with ICU 74.2
// uconv -x Han-Latin, grouped by identical reading including tone. A reading is only a page hint.
const requireData = createRequire(import.meta.url);
let hanReadings;
export function personNameReading(label) {
  if (!/^\p{Script=Han}{2,16}$/u.test(label)) return null;
  if (!hanReadings) {
    const groups = /** @type {Record<string,string>} */ (requireData('./person-name-readings.json'));
    hanReadings = new Map();
    for (const [reading, characters] of Object.entries(groups)) {
      for (const char of characters) hanReadings.set(char, reading);
    }
  }
  const readings = [...label].map(char => hanReadings.get(char));
  return readings.every(Boolean) ? readings.join(' ') : null;
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

const DECLARED_PERSON_NAME = /^(?:(?:姓名|全名|别名|又称|name|full name|alias(?:es)?|also known as)\s*[:：]\s*|(?:全名|又称)\s*)(.+)$/iu;

/** Names on the card are leads for a hint only. Keep title and relationship wording intact.
 * @param {string} label @param {string} body */
export function personHintNames(label, body) {
  const names = new Set([label, ...confirmedAliases(body)]);
  for (const line of body.split('\n')) {
    const field = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/u, '').replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/iu, '');
    // The first clause of an explicit field can be followed by details about the person.
    const value = DECLARED_PERSON_NAME.exec(field.split(/[，,。；;]/u, 1)[0])?.[1];
    if (!value) continue;
    for (const entry of value.split('、')) {
      const name = entry.trim().replace(/^(?:“(.+)”|「(.+)」|"(.+)")$/u, (_whole, curly, corner, straight) => curly ?? corner ?? straight);
      if (name.length >= 2 && name.length <= 100) names.add(name);
      if (names.size >= 12) return [...names];
    }
  }
  return [...names];
}

/** @param {string[]} names @param {string[]} others @param {{left:(string|null)[],right:(string|null)[]}|null} [readings] */
export function personNamesSuggestPair(names, others, readings = null) {
  return names.some((name, i) => others.some((other, j) => name === other || closePersonNames(name, other)
    || Boolean(readings?.left[i] && readings.left[i] === readings.right[j])));
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
