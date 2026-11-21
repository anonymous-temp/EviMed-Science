/** The profile template's scaffolding when the person has not supplied a name.
 * These exact headings are rendered into the extraction template, not inferred
 * from a dictionary of possible names. All other H1 text belongs to the person. */
export const MEMORY_PROFILE_NEUTRAL_TITLES = Object.freeze({ chinese: '用户', other: 'User' });

export const MEMORY_PROFILE_HEADING_RULE = `One H1 heading with the name the user gave for themselves. When no name is known,
use exactly "# ${MEMORY_PROFILE_NEUTRAL_TITLES.chinese}" for a Chinese conversation or "# ${MEMORY_PROFILE_NEUTRAL_TITLES.other}" otherwise.
These two fallback headings are document structure, not personal facts; only these headings are exempt from the language rule.
Follow the heading directly with bullet statements. No H2/H3 headings, tables, JSON or paragraphs.`;

/** Other headings a profile can carry without naming anyone. The serving template asks for "the word for user" in the
 * conversation's language when no name was given, and older or hand-made stores used a document title; the memory
 * page showed such a title as the person's name. These are structure words, matched whole after case, width and
 * space folding: a list of what the scaffolding is called, never of names, so "Dr User" or "用户的昵称" stays a name. */
export const MEMORY_PROFILE_STRUCTURAL_TITLES = Object.freeze([
  ...Object.values(MEMORY_PROFILE_NEUTRAL_TITLES),
  'Profile', 'User Profile', 'The User', 'About the user', 'About me', 'Me',
  '用户画像', '用户档案', '用户信息', '用户资料', '个人画像', '个人档案', '个人信息', '个人资料', '画像', '档案', '关于用户', '关于我', '我',
  '用戶', '使用者', 'ユーザー', '사용자', 'Usuario', 'Usuaria', 'Utilisateur', 'Utilisatrice', 'Benutzer', 'Nutzer', 'Utente', 'Usuário', 'Пользователь',
]);

/** @param {string} title */
const foldTitle = title => title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const structuralTitles = new Set(MEMORY_PROFILE_STRUCTURAL_TITLES.map(foldTitle));

/** @param {unknown} line */
export function isNeutralProfileHeading(line) {
  const title = /^#\s+(.+?)\s*$/.exec(String(line ?? '').trim())?.[1];
  return title !== undefined && structuralTitles.has(foldTitle(title));
}

const PROFILE_NAME_LABEL = /^(?:(?:姓名|名字|昵称|称呼)\s*(?:[:：]|是|为)?\s*|(?:name|nickname)\s*[:：]\s*)(.+?)\s*$/iu;
const PROFILE_AS_OF = /\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/iu;
const PROFILE_ADDRESS_LABEL = /^(?:希望被称呼为\s*[:：]?\s*|(?:称呼|Preferred form of address)\s*[:：]\s*)(.+)$/iu;
const PROFILE_IDENTITY_LABEL = /^(?:姓名|名字|真实姓名|真名|全名|name|real name|full name)\s*[:：]\s*(.+)$/iu;

/** @param {unknown} line */
const profileField = line => String(line ?? '').trim().replace(/^(?:[-*+]|\d+[.)])\s+/u, '').replace(PROFILE_AS_OF, '');

/** @param {string} value */
const unquoteName = value => value.trim().replace(/^(?:“(.+)”|「(.+)」|"(.+)")$/u, (_whole, curly, corner, straight) => curly ?? corner ?? straight);

/** The explicit address preference, separate from the user's name. @param {unknown} line */
export function profileAddressFieldValue(line) {
  const value = PROFILE_ADDRESS_LABEL.exec(profileField(line))?.[1];
  return value ? unquoteName(value) : null;
}

/** The value of an explicit name field, without its bullet or as-of annotation. @param {unknown} line */
export function profileNameFieldValue(line) {
  return PROFILE_NAME_LABEL.exec(profileField(line))?.[1] ?? null;
}

/** @param {string[]} lines */
function namedHeading(lines) {
  const headings = lines.flatMap((line, index) => {
    const title = /^#\s+(.+?)\s*$/u.exec(line.trim())?.[1];
    return title ? [{ index, title, line: line.trim() }] : [];
  });
  return headings.length === 1 && !isNeutralProfileHeading(headings[0].line) ? headings[0] : null;
}

/** @param {string[]} lines */
const declaredNames = lines => lines.flatMap(line => {
  const value = PROFILE_IDENTITY_LABEL.exec(profileField(line))?.[1];
  return value ? [foldTitle(unquoteName(value))] : [];
});

/** @param {string[]} lines @param {string} title */
const addressMatches = (lines, title) => lines.some(line => {
  const address = profileAddressFieldValue(line);
  return address !== null && foldTitle(address) === foldTitle(title);
});

/** The engine promoted its explicit address preference to H1. Preserve the known name only when
 * the new body contains no declaration of a different actual name. @param {string} before @param {string} after */
export function preserveProfileName(before, after) {
  const previous = before.split(/\r?\n/u), lines = after.split(/\r?\n/u);
  const prior = namedHeading(previous), next = namedHeading(lines);
  if (!prior || !next || foldTitle(prior.title) === foldTitle(next.title) || !addressMatches(lines, next.title)) return after;
  const name = foldTitle(prior.title);
  if (declaredNames(lines).some(value => value !== name)
    || (addressMatches(previous, prior.title) && declaredNames(previous).some(value => value !== name))) return after;
  lines[next.index] = prior.line;
  return lines.join(after.includes('\r\n') ? '\r\n' : '\n');
}

/** Exact duplicate name bullets of a genuinely named H1, never a neutral scaffold or a different value.
 * @param {unknown} body @returns {string[]} raw trimmed lines */
export function profileNameDuplicateLines(body) {
  const lines = String(body ?? '').replace(/\r\n/gu, '\n').split('\n');
  const titles = lines.map(line => /^#\s+(.+?)\s*$/u.exec(line.trim())?.[1]).filter(value => value !== undefined);
  const [title] = titles;
  if (titles.length !== 1 || title === undefined || isNeutralProfileHeading(`# ${title}`)) return [];
  return lines.map(line => line.trim()).filter(line => {
    if (profileAddressFieldValue(line) !== null) return false;
    const name = profileNameFieldValue(line);
    return name !== null && foldTitle(name) === foldTitle(title);
  });
}

/** Remove only the exact duplicate name rows, leaving the named H1 as the one editable fact.
 * @param {unknown} body */
export function withoutProfileNameDuplicates(body) {
  const text = String(body ?? '');
  const duplicates = new Set(profileNameDuplicateLines(text));
  return duplicates.size ? text.replace(/\r\n/gu, '\n').split('\n').filter(line => !duplicates.has(line.trim())).join('\n') : text;
}

/** Keep H1 identity for editing and origins; lower headings are structure.
 * @param {unknown} body @returns {string[]} */
export function profileMemoryStatements(body) {
  return String(body ?? '').split('\n').map(line => line.trim())
    .filter(line => line && !isNeutralProfileHeading(line) && (/^#\s+/.test(line) || !/^#{1,6}\s/.test(line)))
    .map(line => line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
}
