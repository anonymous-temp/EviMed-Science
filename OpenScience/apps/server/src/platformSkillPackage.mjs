import { parseSkillFrontmatter } from '@evimed/domain';
import { verificationRequest } from './evolutionVerificationController.mjs';
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
  const frontmatter = hasFrontmatter ? parseSkillFrontmatter(skillBody).frontmatter : null;
  if (hasFrontmatter && (!frontmatter || typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string' || !frontmatter.description.trim())) issue('package_skill_frontmatter_invalid', 'files.SKILL.md', 'Declared SKILL.md frontmatter requires a string name and a nonempty string description.');
  const id = String(candidate.id ?? card?.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) issue('package_id_invalid', 'id', 'The public package ID must contain 1–100 letters, digits, underscores or hyphens.');
  if (candidate.publicationKind === 'isolated-tool' && !/^scripts\/[A-Za-z0-9_-]+\.py:[A-Za-z_][A-Za-z0-9_]*$/.test(candidate.entrypoint ?? '')) issue('package_entrypoint_invalid', 'entrypoint', 'An isolated tool entrypoint must name scripts/<file>.py:<function>.');
  if (candidate.executionTools !== undefined && !Array.isArray(candidate.executionTools) || card?.executionTools !== undefined && !Array.isArray(card.executionTools)) issue('package_execution_tools_invalid', 'executionTools', 'Execution tool declarations must be an array.');
  return { ok: issues.length === 0, issues, files, skillBody, hasFrontmatter, id };
}
