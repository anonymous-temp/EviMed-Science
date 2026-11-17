/** The profile template's scaffolding when the person has not supplied a name.
 * These exact headings are rendered into the extraction template, not inferred
 * from a dictionary of possible names. All other H1 text belongs to the person. */
export const MEMORY_PROFILE_NEUTRAL_TITLES = Object.freeze({ chinese: '用户', other: 'User' });

export const MEMORY_PROFILE_HEADING_RULE = `One H1 heading with the name the user gave for themselves. When no name is known,
use exactly "# ${MEMORY_PROFILE_NEUTRAL_TITLES.chinese}" for a Chinese conversation or "# ${MEMORY_PROFILE_NEUTRAL_TITLES.other}" otherwise.
These two fallback headings are document structure, not personal facts; only these headings are exempt from the language rule.
Follow the heading directly with bullet statements. No H2/H3 headings, tables, JSON or paragraphs.`;

/** @param {unknown} line */
export function isNeutralProfileHeading(line) {
  const title = /^#\s+(.+?)\s*$/.exec(String(line ?? '').trim())?.[1];
  return Object.values(MEMORY_PROFILE_NEUTRAL_TITLES).some(value => value === title);
}

/** Keep H1 identity for editing and origins; lower headings are structure.
 * @param {unknown} body @returns {string[]} */
export function profileMemoryStatements(body) {
  return String(body ?? '').split('\n').map(line => line.trim())
    .filter(line => line && !isNeutralProfileHeading(line) && (/^#\s+/.test(line) || !/^#{1,6}\s/.test(line)))
    .map(line => line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
}
