#!/usr/bin/env node
/**
 * The model's skill catalogue as a measured budget: per skill root, how many skills the kernel would list to the model and
 * how many characters that listing costs, for the runtime of a 循证 GEO project and for every other runtime.
 *
 * Hidden knowledge: a session's skill catalogue is not a page anyone reads. The kernel's `skill` tool (`dsh-tool-skill`)
 * puts one line per model-invocable skill into the first message of every session — `- \`name\`: description`, whitespace
 * collapsed, the description cut at `catalogDescriptionMaxLength` (500) characters — and the model pays for that text on
 * every request of the conversation, whether the task has anything to do with those skills or not. On 2026-10-14 it was
 * 108 skills and about 43 000 characters in every session, 60% of them the 51 skills of the GEO method pack, and nobody
 * had counted (audit A §1.4 #6, §4 V6, §6 S7). Principle 11 says a plugin earns its place by a measured difference; this
 * is the measurement: run it, read the number, and a skill that is added, or a description that grows, is a decision with
 * a figure beside it. `test/skillCatalogueSize.test.mjs` pins the repository-measurable total for a runtime that is not a
 * GEO project, so growth fails a test instead of passing unnoticed.
 *
 * What it reads. The roots come from the agent preset (`readPreset`, the same reader the runtime inventory uses), in the
 * preset's order: the first root wins a name collision, as the kernel's registry does. Each root's skills are the folders
 * that hold a `SKILL.md` whose frontmatter has a valid `name` and a `description`, and that do not say
 * `disable-model-invocation: true`. A root gated on something that is not in the repository is read from where it is given:
 *   - the GEO method pack is private and absent from a clone: `--geo-pack <runtime/skills/geo-private>`; without it the GEO
 *     figure is "not measured" and nothing is guessed;
 *   - LoopX's skill folders are written into the image from a pinned wheel: `--loopx-root <skills dir>`, restricted to the
 *     folders `packages/contracts/loopx/workflow-skills.json` keeps;
 *   - an account's own skills and the ones the platform learned are per account and are reported, never counted.
 * The kernel's limit and the fixed frame around the lines are the installed kernel's: `--closure <node_modules>` reads
 * `dsh-tool-skill`'s default limit from it and checks that its frame text is the one measured here (a changed frame is
 * named, not silently mis-measured).
 *
 * Usage:
 *   node scripts/ops/skill-catalogue-size.mjs [--geo-pack DIR] [--loopx-root DIR] [--closure DIR]
 *                                             [--json] [--candidate-json FILE]
 *   `--candidate-json FILE` merges the totals into an existing `candidate-check.json` (`kernel-candidate-check.mjs`) as
 *   `skillCatalogue`, leaving every other key as it is; it creates nothing when the file is not there.
 *
 * @module skill-catalogue-size
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { readPreset } from "../build/generate-runtime-inventory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** The kernel's default (`DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH` in `dsh-tool-skill`); the preset's `tool-skill` row sets none. */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500;

/**
 * The text around the lines, as the pinned kernel's `dsh-tool-skill` renders its first catalogue message. Held by
 * `frameDrift` against the installed closure.
 */
export const CATALOGUE_FRAME = Object.freeze({
  head: [
    "<system-reminder>",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
  ],
  tail: [
    "</available_skills>",
    "",
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
    "</system-reminder>",
  ],
});

/**
 * What the image carries of `runtime/skills/evimed`: exactly the packages the runtime Dockerfile copies one by one
 * (`COPY runtime/skills/evimed/<name>`), because the rest of that tree predates `capabilities/` and is not mounted.
 * `skillCatalogueSize.test.mjs` holds this list equal to the Dockerfile.
 */
export const IMAGE_EVIMED_PACKAGES = Object.freeze(["open-domain-answer"]);

/** The rows of the catalogue are the kernel's own: whitespace collapsed, cut with an ellipsis. @param {string} value @param {number} maxLength */
export function catalogDescription(value, maxLength = CATALOG_DESCRIPTION_MAX_LENGTH) {
  const normalized = String(value).replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

/** @param {string} value */
export function escapeText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * One catalogue line, exactly as the kernel renders it.
 * @param {{ name: string, description: string }} skill @param {number} [maxLength]
 */
export function catalogueLine(skill, maxLength = CATALOG_DESCRIPTION_MAX_LENGTH) {
  return `- \`${skill.name}\`: ${escapeText(catalogDescription(skill.description, maxLength))}`;
}

/** The frame's characters: every fixed line and the newline after it, the lines' own newlines counted with the lines. */
export function frameChars() {
  const lines = [...CATALOGUE_FRAME.head, ...CATALOGUE_FRAME.tail];
  return lines.reduce((sum, line) => sum + line.length + 1, 0) - 1;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The skill a `SKILL.md` declares, or null where the kernel would ignore the file (no frontmatter, no name or description, a
 * name that is not a skill name) and `modelInvocable: false` where it keeps the skill out of the model's catalogue.
 * @param {string} text
 * @returns {{ name: string, description: string, modelInvocable: boolean } | null}
 */
export function readSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  let data;
  try { data = parseYaml(match[1]); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const { name, description } = /** @type {Record<string, unknown>} */ (data);
  if (typeof name !== "string" || typeof description !== "string" || !SKILL_NAME.test(name)) return null;
  return { name, description, modelInvocable: /** @type {Record<string, unknown>} */ (data)["disable-model-invocation"] !== true };
}

/**
 * The skills a directory holds, in the kernel's order (names sorted with `localeCompare`): a folder with a `SKILL.md`, or a
 * `.md` file at the top.
 * @param {string} dir @param {{ only?: readonly string[] }} [options] `only` keeps the folders of that name and no other
 */
export function readSkillRoot(dir, options = {}) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  /** @type {{ name: string, description: string, modelInvocable: boolean, folder: string }[]} */
  const found = [];
  for (const entry of names) {
    if (options.only && !options.only.includes(entry)) continue;
    const full = path.join(dir, entry);
    const info = statSync(full);
    const file = info.isDirectory() ? path.join(full, "SKILL.md") : info.isFile() && entry.endsWith(".md") ? full : null;
    if (!file || !existsSync(file)) continue;
    const skill = readSkillFrontmatter(readFileSync(file, "utf8"));
    if (skill) found.push({ ...skill, folder: entry });
  }
  return found;
}

/**
 * The totals of an ordered list of roots: the first root to name a skill keeps it, and a skill the model may not invoke is
 * not in the catalogue.
 * @param {{ id: string, skills: { name: string, description: string, modelInvocable: boolean }[] }[]} roots
 * @param {number} [maxLength]
 */
export function catalogueOf(roots, maxLength = CATALOG_DESCRIPTION_MAX_LENGTH) {
  const seen = new Set();
  /** @type {{ id: string, skills: number, chars: number, shadowed: number }[]} */
  const perRoot = [];
  for (const root of roots) {
    let skills = 0, chars = 0, shadowed = 0;
    for (const skill of root.skills) {
      if (seen.has(skill.name)) { shadowed += 1; continue; }
      seen.add(skill.name);
      if (!skill.modelInvocable) continue;
      skills += 1;
      chars += catalogueLine(skill, maxLength).length + 1;
    }
    perRoot.push({ id: root.id, skills, chars, shadowed });
  }
  const skills = perRoot.reduce((sum, root) => sum + root.skills, 0);
  const chars = perRoot.reduce((sum, root) => sum + root.chars, 0);
  return { roots: perRoot, skills, chars, frame: frameChars(), total: chars + frameChars() };
}

/**
 * The roots of the preset and where each is read from. `where` is a directory, or why there is none to read.
 * @param {{ root?: string, geoPack?: string | null, loopxRoot?: string | null }} [options]
 */
export function presetRoots(options = {}) {
  const root = options.root ?? repoRoot;
  const preset = readPreset(readFileSync(path.join(root, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8"));
  const loopx = JSON.parse(readFileSync(path.join(root, "packages/contracts/loopx/workflow-skills.json"), "utf8"));
  return preset.roots.map((entry) => {
    /** @type {{ id: string, gate: string | null, dir: string | null, only?: readonly string[], why?: string }} */
    const row = { id: entry.id, gate: entry.gate, dir: null };
    if (entry.id === "evimed") return { ...row, dir: path.join(root, "runtime/skills/evimed"), only: IMAGE_EVIMED_PACKAGES };
    if (entry.id === "geo-private") {
      const given = options.geoPack ?? path.join(root, "runtime/skills/geo-private");
      const skills = path.join(given, "skills");
      return existsSync(skills) ? { ...row, dir: skills } : { ...row, why: "the private pack is not in this tree; pass --geo-pack" };
    }
    if (entry.id === "loopx") {
      return options.loopxRoot ? { ...row, dir: options.loopxRoot, only: loopx.kept } : { ...row, why: `installed at image build from the pinned wheel (${loopx.kept.length} kept); pass --loopx-root` };
    }
    if (entry.id === "personal") return { ...row, why: "the account's own skills; per account" };
    if (entry.id === "platform-learned") return { ...row, why: "what the platform learned for the account; per account" };
    return { ...row, dir: path.join(root, "runtime/skills", entry.id) };
  });
}

/**
 * The two catalogues: a GEO project's runtime mounts the roots gated on `geoProject`, every other runtime does not. A root
 * that cannot be read here is listed with the reason and left out of the totals.
 * @param {ReturnType<typeof presetRoots>} roots @param {number} [maxLength]
 */
export function measure(roots, maxLength = CATALOG_DESCRIPTION_MAX_LENGTH) {
  const read = roots.map((entry) => ({
    id: entry.id, gate: entry.gate, why: entry.why ?? null,
    skills: entry.dir ? readSkillRoot(entry.dir, entry.only ? { only: entry.only } : {}) : null,
  }));
  /** @param {boolean} geo */
  const build = (geo) => {
    const mounted = read.filter((entry) => entry.skills && (entry.gate !== "geoProject" || geo));
    const catalogue = catalogueOf(mounted.map((entry) => ({ id: entry.id, skills: /** @type {any[]} */ (entry.skills) })), maxLength);
    return {
      ...catalogue,
      notMeasured: read.filter((entry) => !entry.skills && (entry.gate !== "geoProject" || geo)).map((entry) => ({ id: entry.id, why: entry.why })),
    };
  };
  const geoRoot = read.find((entry) => entry.gate === "geoProject");
  return { descriptionMax: maxLength, nonGeo: build(false), geo: geoRoot?.skills ? build(true) : null, geoNotMeasured: geoRoot && !geoRoot.skills ? geoRoot.why : null };
}

/**
 * The installed kernel's limit and whether its frame is the one measured here.
 * @param {string} modules a `node_modules` directory that holds `@deepseek-ai/dsh-tool-skill`
 * @returns {{ descriptionMax: number | null, frameDrift: string[] }}
 */
export function readKernel(modules) {
  const file = path.join(modules, "@deepseek-ai/dsh-tool-skill/lib/index.js");
  const text = readFileSync(file, "utf8");
  const limit = /DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = (\d+)/.exec(text)?.[1];
  const drift = [...CATALOGUE_FRAME.head, ...CATALOGUE_FRAME.tail].filter((fixed) => fixed && !text.includes(fixed)).map((fixed) => fixed.slice(0, 60));
  if (!text.includes("`- \\`${entry.name}\\`: ${escapeText(entry.description)}`")) drift.push("the catalogue line is no longer `- \\`name\\`: description`");
  return { descriptionMax: limit ? Number(limit) : null, frameDrift: drift };
}

/** @param {number} value */
const pad = (value) => String(value).padStart(7);

/** @param {ReturnType<typeof measure>} result */
export function renderTable(result) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} title @param {ReturnType<typeof measure>["nonGeo"] | null} catalogue @param {string | null} [why] */
  const block = (title, catalogue, why = null) => {
    out.push(title);
    if (!catalogue) { out.push(`  not measured: ${why}`); return; }
    for (const root of catalogue.roots) out.push(`  ${root.id.padEnd(20)} ${pad(root.skills)} skills ${pad(root.chars)} chars${root.shadowed ? `  (${root.shadowed} shadowed by an earlier root)` : ""}`);
    out.push(`  ${"lines".padEnd(20)} ${pad(catalogue.skills)} skills ${pad(catalogue.chars)} chars`);
    out.push(`  ${"frame".padEnd(20)} ${pad(0)} skills ${pad(catalogue.frame)} chars`);
    out.push(`  ${"TOTAL".padEnd(20)} ${pad(catalogue.skills)} skills ${pad(catalogue.total)} chars`);
    for (const entry of catalogue.notMeasured) out.push(`  not counted: ${entry.id} (${entry.why})`);
  };
  block("A runtime that is not a GEO project:", result.nonGeo);
  block("A GEO project's runtime:", result.geo, result.geoNotMeasured);
  return `${out.join("\n")}\n`;
}

const VALUE_FLAGS = Object.freeze(["geo-pack", "loopx-root", "closure", "candidate-json"]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (key === "json") args[key] = true;
    else if (VALUE_FLAGS.includes(key) && typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--")) { args[key] = argv[i + 1]; i += 1; }
    else throw new Error(`${arg} is not a flag of this command (--json, ${VALUE_FLAGS.map((flag) => `--${flag} <value>`).join(", ")})`);
  }
  return args;
}

/**
 * Merge the totals into an existing candidate-check document; the file is left alone when it does not exist.
 * @param {string} file @param {ReturnType<typeof measure>} result
 */
export function mergeIntoCandidateJson(file, result) {
  if (!existsSync(file)) return false;
  const document = JSON.parse(readFileSync(file, "utf8"));
  const summary = (/** @type {ReturnType<typeof measure>["nonGeo"] | null} */ catalogue) => catalogue && { skills: catalogue.skills, chars: catalogue.chars, total: catalogue.total, roots: catalogue.roots, notMeasured: catalogue.notMeasured };
  document.skillCatalogue = { measuredAt: new Date().toISOString(), descriptionMax: result.descriptionMax, nonGeo: summary(result.nonGeo), geo: summary(result.geo), geoNotMeasured: result.geoNotMeasured };
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let maxLength = CATALOG_DESCRIPTION_MAX_LENGTH;
  /** @type {string[]} */
  let drift = [];
  if (typeof args.closure === "string") {
    const kernel = readKernel(args.closure);
    if (kernel.descriptionMax) maxLength = kernel.descriptionMax;
    drift = kernel.frameDrift;
  }
  const result = measure(presetRoots({
    geoPack: typeof args["geo-pack"] === "string" ? args["geo-pack"] : null,
    loopxRoot: typeof args["loopx-root"] === "string" ? args["loopx-root"] : null,
  }), maxLength);
  if (args.json) process.stdout.write(`${JSON.stringify({ ...result, frameDrift: drift })}\n`);
  else process.stdout.write(renderTable(result));
  if (drift.length) process.stderr.write(`the installed kernel's catalogue frame differs from the one measured here: ${drift.join(" | ")}\n`);
  if (typeof args["candidate-json"] === "string") {
    const merged = mergeIntoCandidateJson(args["candidate-json"], result);
    process.stderr.write(merged ? `skillCatalogue written into ${args["candidate-json"]}\n` : `${args["candidate-json"]} does not exist; nothing written\n`);
  }
  if (drift.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main().catch((error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 2; });
}
