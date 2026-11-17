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

/** Keep H1 identity for editing and origins; lower headings are structure.
 * @param {unknown} body @returns {string[]} */
export function profileMemoryStatements(body) {
  return String(body ?? '').split('\n').map(line => line.trim())
    .filter(line => line && !isNeutralProfileHeading(line) && (/^#\s+/.test(line) || !/^#{1,6}\s/.test(line)))
    .map(line => line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
}
