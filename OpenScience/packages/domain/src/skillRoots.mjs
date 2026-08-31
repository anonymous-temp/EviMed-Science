/**
 * Where a skill's files actually live in the runtime image, declared once.
 *
 * Hidden knowledge: why this exists at all, and why it is a list rather than a
 * single path.
 *
 * A SKILL.md references its own scripts relatively — `scripts/x.py`, or
 * `../_runtime/execute_skill.py` for the executor the curated family shares.
 * That is the Agent Skills convention and it is what makes a skill body
 * portable to any harness following the standard. What it is not is
 * self-resolving: the model's shell starts in the workspace, not in the skill
 * directory, so a relative path needs a root to be relative *to*.
 *
 * For a long time the bodies solved that by spelling out
 * `$XDG_CONFIG_HOME/opencode/skills/...`, a path that stopped existing when the
 * kernel changed. Forty-five shipped skills carried it, every DSH run loaded
 * them that way, and nothing failed until a model tried to run one — because a
 * wrong path inside Markdown is not a syntax error anywhere.
 *
 * So the roots are a deployment fact and are declared here, in the vocabulary
 * package that has no runtime dependencies and ships inside the bundle. The
 * image copies these trees to these paths; the profile patch reads this list
 * and tells the run where they are; a test asserts the Dockerfile's COPY
 * targets still match. One definition, one drift guard, and skill bodies that
 * say nothing about any of it.
 *
 * They are a list because the families genuinely land in different places, and
 * pretending otherwise is what a single sed would have done — misdirecting two
 * of the three groups while looking like a fix.
 */

/**
 * @typedef {object} SkillRoot
 * @property {string} family  the tree's name, matching its directory in the repo
 * @property {string} source  repo-relative path the image copies from
 * @property {string} path    absolute path inside the runtime image
 * @property {string} holds   what a reader needs to know about the tree
 */

/** @type {readonly SkillRoot[]} */
export const RUNTIME_SKILL_ROOTS = Object.freeze([
  Object.freeze({
    family: 'curated-scientific',
    source: 'runtime/skills/curated-scientific',
    path: '/usr/local/share/evimed/skills/curated-scientific',
    // `_runtime/execute_skill.py` is a sibling of every skill in this family,
    // which is the only reason `../_runtime/...` resolves. The family is copied
    // whole, so that relationship survives the copy.
    holds: 'the audited scientific skills and the shared executor they call as ../_runtime/execute_skill.py',
  }),
  Object.freeze({
    family: 'office',
    source: 'runtime/skills/office',
    path: '/usr/local/share/evimed/skills/office',
    holds: 'document producers (docx, pdf, pptx, xlsx)',
  }),
  Object.freeze({
    family: 'core',
    source: 'runtime/skills/core',
    path: '/opt/evimed/skills/core',
    holds: 'the general-purpose skills; each references its own scripts relatively',
  }),
  Object.freeze({
    family: 'community',
    source: 'runtime/skills/community',
    path: '/opt/evimed/skills/community',
    holds: 'vendored community skills',
  }),
  Object.freeze({
    family: 'capability-skills',
    source: 'capability-skills',
    path: '/opt/evimed/capability-skills',
    holds: 'the skill bodies delegation pre-injects, one per capability',
  }),
])

/** @returns {string[]} */
export function runtimeSkillRootPaths() {
  return RUNTIME_SKILL_ROOTS.map((root) => root.path)
}

/**
 * The sentence a run is told, so a relative reference in a skill body can be
 * resolved without the body naming a path.
 *
 * Deliberately one short block: it is read on every run, and a paragraph nobody
 * finishes is worth less than three lines everybody does.
 * @param {readonly SkillRoot[]} [roots]
 * @returns {string}
 */
export function skillRootGuidance(roots = RUNTIME_SKILL_ROOTS) {
  if (!roots.length) return ''
  const lines = roots.map((root) => `- \`${root.path}\` — ${root.holds}`)
  return [
    '## Where a skill\'s own files are',
    '',
    'A SKILL.md refers to its scripts relative to its own directory — `scripts/x.py`,',
    'or `../_runtime/execute_skill.py` for the executor the curated family shares.',
    'Your shell starts in the workspace, not in the skill directory, so resolve those',
    'against the skill\'s directory under one of these roots:',
    '',
    ...lines,
    '',
    'A skill you loaded as `<family>/<name>` lives at `<root-for-that-family>/<name>`.',
    'Never copy one of these paths into a deliverable: they are machinery.',
  ].join('\n')
}
