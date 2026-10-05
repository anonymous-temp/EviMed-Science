import { parse as parseYaml } from 'yaml';
import { verificationRequest } from './evolutionVerificationController.mjs';
/** The longest description a published skill may advertise. The kernel lists it in every session that can see
 * the skill, so it is read by every tenant's agent on every start: a short pointer, never the instructions. */
export const PLATFORM_SKILL_DESCRIPTION_MAX_CHARS = 500;
/** @param {string} text @returns {{ head: string, body: string } | null} the front matter block and what follows it, or null when it is not closed */
function splitFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const close = lines.indexOf('---', 1);
  return lines[0] === '---' && close > 0 ? { head: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n').replace(/^\n+/, '') } : null;
}
/** One line: control characters and runs of whitespace become one space. @param {unknown} value */
function collapse(value) {
  return String(value ?? '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
/**
 * The SKILL.md every tenant's runtime reads: front matter the platform writes — its own native name and one
 * bounded description, the only two fields it keeps — followed by the builder's body. The builder's own front
 * matter never reaches a tenant. It used to: the name line was renamed with one regex, so a second `name:` line
 * survived (the kernel's YAML parser refuses duplicate keys and ignores the whole file, leaving a tool the
 * ledger calls published and no session can see) and the description was bounded by nothing but the 4 MiB file
 * cap. The platform's tenants read the front matter of every skill on every start; a model-written file does
 * not get to shape it.
 * @param {{ nativeName: string, description: unknown, body: string }} parts
 */
export function runtimeSkillText({ nativeName, description, body }) {
  return `---\nname: ${nativeName}\ndescription: ${JSON.stringify(collapse(description).slice(0, PLATFORM_SKILL_DESCRIPTION_MAX_CHARS))}\n---\n\n${body}`;
}
/** Publication's public package invariants, shared with pre-evaluation alternative selection.
 * This checks only delivered bytes and public metadata; no reference answer or evaluator verdict.
 * @param {any} candidate @param {{card?:any}} [options] */
export function validatePlatformSkillPackage(candidate, { card } = {}) {
  const issues = [];
  const issue = (code, field, message) => issues.push({ code, field, message });
  let files;
  try { files = verificationRequest({ files: candidate?.files, code: '' }).files; }
  catch { issue('package_files_invalid', 'files', 'Files must be a bounded map of safe relative UTF-8 file names and string contents.'); return { ok: false, issues }; }
  if (candidate.publicationKind === 'skill' && Object.keys(files).some(name => !/\.(?:md|txt|json|yaml|yml|csv|tsv)$/i.test(name))) issue('package_skill_executable_invalid', 'files', 'A prose skill package cannot contain executable file types.');
  if (!files['SKILL.md']?.trim()) issue('package_skill_missing', 'files.SKILL.md', 'Every published package requires a nonempty SKILL.md.');
  const skillBody = (files['SKILL.md'] ?? '').replace(/^\uFEFF/, '');
  const hasFrontmatter = /^---(?:\r?\n|$)/.test(skillBody);
  /** What the platform reads out of the builder's own front matter: the description, and the body it introduces. */
  let description = null;
  let body = skillBody;
  if (hasFrontmatter) {
    const split = splitFrontmatter(skillBody);
    /** @type {any} */
    let frontmatter = null;
    // The kernel's own parser decides whether a session can see the skill (duplicate keys are an error there).
    try { frontmatter = split ? parseYaml(split.head, { uniqueKeys: true }) : null; } catch { frontmatter = null; }
    if (!split || !frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter) || typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
      issue('package_skill_frontmatter_invalid', 'files.SKILL.md', 'Declared SKILL.md frontmatter must be valid YAML without duplicate keys, with a string name and a nonempty string description.');
    } else if (collapse(frontmatter.description).length > PLATFORM_SKILL_DESCRIPTION_MAX_CHARS) {
      issue('package_skill_description_too_long', 'files.SKILL.md', `The frontmatter description is the line every session lists for this skill: at most ${PLATFORM_SKILL_DESCRIPTION_MAX_CHARS} characters on one line. Put the instructions in the body.`);
    } else { description = frontmatter.description; body = split.body; }
  }
  const id = String(candidate.id ?? card?.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) issue('package_id_invalid', 'id', 'The public package ID must contain 1–100 letters, digits, underscores or hyphens.');
  if (candidate.publicationKind === 'isolated-tool' && !/^scripts\/[A-Za-z0-9_-]+\.py:[A-Za-z_][A-Za-z0-9_]*$/.test(candidate.entrypoint ?? '')) issue('package_entrypoint_invalid', 'entrypoint', 'An isolated tool entrypoint must name scripts/<file>.py:<function>.');
  if (candidate.executionTools !== undefined && !Array.isArray(candidate.executionTools) || card?.executionTools !== undefined && !Array.isArray(card.executionTools)) issue('package_execution_tools_invalid', 'executionTools', 'Execution tool declarations must be an array.');
  return { ok: issues.length === 0, issues, files, skillBody, hasFrontmatter, description, body, id };
}
