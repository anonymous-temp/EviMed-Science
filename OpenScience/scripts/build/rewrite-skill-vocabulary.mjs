#!/usr/bin/env node
/**
 * Rewrites the vocabulary in every SKILL.md.
 *
 * Hidden knowledge: which strings are interface names, and where each interface
 * moved. Earlier versions of this script got that wrong twice, in opposite
 * directions, and both mistakes are recorded below because both are the kind a
 * reader would otherwise re-introduce.
 *
 * There is one kernel, so there is one model-visible tool vocabulary. The
 * script used to carry two, one per kernel, and pick between them by skill
 * root; that split is gone with the second kernel. What remains is a different
 * distinction with the same shape, and confusing the two is the mistake to
 * avoid: a tree is split by whether a *model* reads it (so tool names must be
 * spelled the way the model is shown them) or only the *server* does (so they
 * are the bare names the MCP server publishes). See `SKILL_TREES`.
 *
 * Skill-resource paths are rewritten to a *relative* path — never to the
 * earlier `<skill_resources>/…` marker. That marker was invented by an earlier
 * version of this script and never existed in DSH: `@deepseek-ai/dsh-skill`
 * wraps a skill's *entire* rendered body in a literal
 * `<skill_resources>…</skill_resources>` tag pair and separately tells the
 * model, in prose, the base directory to resolve relative paths against
 * ("Resolve relative paths mentioned by this skill against the base directory
 * before using them"). It is not a find-and-replace token, so splicing it into
 * the middle of a shell command produced a string no shell can parse — `python
 * <skill_resources>/foo.py"` is bash input redirection from a file literally
 * named `skill_resources`, immediately followed by a dangling quote, because
 * the regex that produced it consumed the opening quote from many characters
 * to the left of the closing one it could never see in the same match. Every
 * skill under every root that used this marker failed identically, on the
 * first line, under the kernel it was supposedly written for. The relative
 * form fixes both: it is what `dsh-skill`'s own hint format expects, and it
 * cannot leave a stray quote because it introduces exactly one pair of its own.
 *
 * The tool names come from `@evimed/domain`, not from a list here — a rewrite
 * script with its own copy of the tool names is a fourth place they could
 * drift.
 *
 * Usage: node scripts/build/rewrite-skill-vocabulary.mjs [--check]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_TOOL_BASE_NAMES, mcpToolName } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The skill trees, and the one fact about each that decides which rules apply:
 * whether a model reads it.
 *
 * `modelFacing` trees are the ones the runtime image ships, so their tool names
 * must be spelled the way the model is shown them. The rest are read only by
 * the server, where a tool is the bare name the MCP server publishes — the
 * split is stated and pinned in `apps/server/test/agentRegistry.test.mjs`, and
 * sweeping the two together writes a spelling into a tree that never refers to
 * it. The skill-resource-path rule applies to every tree either way: a body
 * that names a deployment path is wrong where it ships and false where it is
 * only read.
 *
 * `runtime/skills/evimed` appears twice on purpose. `deploy/runtime-dsh/
 * Dockerfile` copies exactly one package out of it — `open-domain-answer`, the
 * default line for an unrouted question — while the eleven specialists reach a
 * run as capability bodies under `capability-skills/` instead. Naming the
 * package rather than the directory is what keeps the two halves apart. The
 * more specific entry is listed first and a file is rewritten under the first
 * entry that contains it.
 *
 * `runtime/skills/community` and `runtime/skills/external` are deliberately
 * absent. They are vendored verbatim at a pinned upstream commit, and the point
 * of a pin is that the vendored bytes are the upstream bytes; rewriting them
 * would leave a tree that matches no commit anywhere. They are also the trees
 * that name none of our tools — `scripts/dev/vendor-community-skills.mjs`
 * refuses a community skill that calls a tool this composition does not mount,
 * which is the check that keeps it that way.
 *
 * @type {readonly { root: string, modelFacing: boolean }[]}
 */
const SKILL_TREES = Object.freeze([
  { root: "capabilities", modelFacing: true },
  { root: "capability-skills", modelFacing: true },
  { root: "runtime/skills/core", modelFacing: true },
  { root: "runtime/skills/curated-scientific", modelFacing: true },
  { root: "runtime/skills/office", modelFacing: true },
  { root: "runtime/skills/evimed/open-domain-answer", modelFacing: true },
  { root: "runtime/skills/evimed", modelFacing: false },
]);

/**
 * The tool-name rewrites. One kernel, one spelling: DSH shows every MCP tool of
 * the `evimed` server to the model as `mcp__evimed__<tool>`, so that is what a
 * model-facing skill body must name.
 *
 * Two older spellings still turn up, and both denote the same tool:
 *
 *   `evimed_<tool>`  the MCP server's own former prefix, from before the raw
 *                    names dropped it (`@evimed/domain` explains why they did).
 *   `<tool>`         the bare name, which is what the MCP server publishes and
 *                    therefore still correct in a tree only the server reads.
 *                    In a *shipped* tree it was correct for exactly as long as
 *                    a second kernel existed that added no prefix of its own
 *                    and received `runtime/skills/{core,curated-scientific,
 *                    office}`; `runtime/skills/curated-scientific/
 *                    digest-repins.jsonl` records the deliberate revert to the
 *                    bare spelling on that ground. That kernel is gone, and
 *                    with it the ground: the *same* body shipped as
 *                    `core/deep-research` and as `capability-skills/
 *                    deep-research` was naming the same seven tools two
 *                    different ways under one kernel, and the bare half named
 *                    tools the model is never shown. A run following it calls a
 *                    tool that does not exist, which reads as the model being
 *                    bad at its job rather than as a delivery fault.
 *
 * The bare rewrite is anchored to backticks. That is what keeps it a
 * closed-vocabulary edit over a code-shaped token rather than a guess about
 * prose: every research-tool mention in the shipped trees is written
 * `` `tool_name` ``, while `health` — the one base name that is also an
 * ordinary English word — occurs only unbackticked, inside "public-health" and
 * "health-system". Backtick anchoring also makes the rules idempotent and
 * non-overlapping: `` `mcp__evimed__x` `` has no backtick before `x`, and
 * neither does `` `drug_term_normalize` `` before `term_normalize`.
 *
 * @returns {{ find: RegExp, replace: string, why: string }[]}
 */
function toolNameRewrites() {
  return MCP_TOOL_BASE_NAMES.flatMap((base) => [
    { find: new RegExp(`\\bevimed_${base}\\b`, "g"), replace: mcpToolName(base), why: "tool name" },
    { find: new RegExp("`" + base + "`", "g"), replace: `\`${mcpToolName(base)}\``, why: "tool name" },
  ]);
}

/**
 * The skill-resource-path rewrite, scoped to one file's own skill directory
 * name (a path relative to *this* skill's own directory does not restate that
 * directory's name — the redundant form is what "under the old kernel, every
 * skill shared one parent directory" left behind).
 *
 * The literal it looks for is the retired kernel's config root. It is kept
 * rather than retired with the kernel because it is what the leftovers in the
 * tree are still spelled as, and because deleting the rule would not delete the
 * paths — it would only stop anyone noticing them. `apps/server/test/
 * skillPathsAreRelative.test.mjs` holds the shipped trees to the same rule from
 * the other side; this script's own leftover report below covers the trees that
 * test does not walk.
 *
 * @param {string} skillDirName
 * @returns {{ find: RegExp, replace: (match: string, group: string) => string, why: string }[]}
 */
function skillResourceRewrites(skillDirName) {
  return [
    {
      // `"$XDG_CONFIG_HOME/opencode/skills/<skill>/<rest>"` — the common case,
      // both quotes present. Consumed and reproduced together so nothing is
      // left dangling.
      find: new RegExp(`"\\$XDG_CONFIG_HOME/opencode/skills/${skillDirName}/([^"\\s]+)"`, "g"),
      replace: (_match, rest) => `"${relativeSkillPath(rest)}"`,
      why: "skill resource path",
    },
    {
      // The same path with no surrounding quotes at all (a `python3 … --flag`
      // line that was never quoted to begin with).
      find: new RegExp(`\\$XDG_CONFIG_HOME/opencode/skills/${skillDirName}/([^"'\\s]+)`, "g"),
      replace: (_match, rest) => relativeSkillPath(rest),
      why: "skill resource path",
    },
  ];
}

/**
 * The curated-scientific shared entrypoint lives one directory above every
 * individual skill (`inventory.json`'s own `entrypoints` name it as
 * `../_runtime/execute_skill.py`); every other reference is a path inside the
 * skill's own directory and needs nothing prepended.
 * @param {string} rest @returns {string}
 */
function relativeSkillPath(rest) {
  return rest.startsWith("_runtime/") ? `../${rest}` : rest;
}

/**
 * The retired kernel's config root, in the one spelling the leftovers use.
 *
 * `skillResourceRewrites` can only rewrite a reference to the file's *own*
 * skill directory, because that is the only case where the relative target is
 * decidable — a body pointing into some *other* skill's directory does not say
 * which family root that skill lives under, and guessing is how a body ends up
 * naming a path that resolves to nothing. Those are reported instead of
 * rewritten, so the one case this script cannot fix fails loudly here rather
 * than surviving as a path a model discovers is wrong mid-run.
 */
const RETIRED_KERNEL_CONFIG_ROOT = "$XDG_CONFIG_HOME/opencode";

/** @param {string} dir @returns {Promise<string[]>} */
async function skillFiles(dir) {
  /** @type {string[]} */
  const found = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await skillFiles(full));
    else if (entry.name === "SKILL.md") found.push(full);
  }
  return found;
}

async function main() {
  const check = process.argv.includes("--check");
  /** @type {{ file: string, changes: Record<string, number> }[]} */
  const touched = [];
  /** A file under a more specific tree must not be rewritten again under the
   *  directory that contains it, with the other tree's rules. */
  const seen = new Set();
  /** @type {string[]} */
  const unrewritable = [];
  for (const tree of SKILL_TREES) {
    for (const file of await skillFiles(path.join(repoRoot, tree.root))) {
      if (seen.has(file)) continue;
      seen.add(file);
      const rules = [
        ...(tree.modelFacing ? toolNameRewrites() : []),
        ...skillResourceRewrites(path.basename(path.dirname(file))),
      ];
      const before = await fs.readFile(file, "utf8");
      let after = before;
      /** @type {Record<string, number>} */
      const changes = {};
      for (const rule of rules) {
        const stepBefore = after;
        after = after.replace(rule.find, /** @type {any} */ (rule.replace));
        // Counted by what the file actually gains from this rule, not by how
        // many times the pattern matched: a base name already in its target
        // spelling matches and "replaces" itself with identical text, and
        // counting that as a change made an already-correct file's diagnostic
        // report claim tool names moved when none had.
        if (after !== stepBefore) {
          changes[rule.why] = (changes[rule.why] ?? 0) + (stepBefore.match(rule.find)?.length ?? 0);
        }
      }
      if (after.includes(RETIRED_KERNEL_CONFIG_ROOT)) {
        unrewritable.push(path.relative(repoRoot, file));
      }
      if (after === before) continue;
      touched.push({ file: path.relative(repoRoot, file), changes });
      if (!check) await fs.writeFile(file, after, "utf8");
    }
  }
  // A walk that read nothing rewrites nothing and reports success, which is the
  // same output as a tree that was already correct. Rename a root, move the
  // trees, or resolve `repoRoot` one directory wrong and without this the
  // script says "up to date" forever.
  const scanned = seen.size;
  if (!scanned) {
    process.stderr.write(`no SKILL.md found under ${SKILL_TREES.map((tree) => tree.root).join(", ")} (searched from ${repoRoot})\n`);
    process.exitCode = 1;
    return;
  }
  if (unrewritable.length) {
    process.stderr.write(
      `${unrewritable.length} skill body/bodies still name ${RETIRED_KERNEL_CONFIG_ROOT}, `
      + "which no deployment has: the reference is to another skill's directory, so this script cannot "
      + "decide the relative target for you. Rewrite it by hand against that skill's own layout:\n",
    );
    for (const file of unrewritable) process.stderr.write(`  ${file}\n`);
    process.exitCode = 1;
  }
  if (check) {
    if (!touched.length) {
      process.stdout.write(`skill vocabulary is up to date across ${scanned} skill file(s)\n`);
      return;
    }
    process.stderr.write(`skill vocabulary is stale in ${touched.length} of ${scanned} file(s):\n`);
    for (const entry of touched) process.stderr.write(`  ${entry.file} — ${JSON.stringify(entry.changes)}\n`);
    process.stderr.write("run `node scripts/build/rewrite-skill-vocabulary.mjs`\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`rewrote ${touched.length} of ${scanned} skill file(s)\n`);
  for (const entry of touched) process.stdout.write(`  ${entry.file} — ${JSON.stringify(entry.changes)}\n`);
}

await main();
