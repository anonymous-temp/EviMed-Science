#!/usr/bin/env node
/**
 * Writes `packages/domain/src/skill-packages.json`: the record of every package
 * the platform ships a skill or a capability in, and the runtime image's recipe
 * those records are read against.
 *
 * Hidden knowledge: where each fact about a package really lives, and that
 * none of them was written next to the package.
 *
 *   - the skill packs' own `inventory.json` files know each package's
 *     dependencies, artifacts, review state and (for the curated pack) the
 *     upstream it was derived from and its licence file's digest;
 *   - `runtime/skills/community/sources.json` knows the exact repository and
 *     commit a vendored skill came from;
 *   - `capabilities/<id>/capability.yaml` knows a capability's version and the
 *     platform tools it declares;
 *   - the package's own files know what its scripts import, and which flags they
 *     read (`argparse` is a closed, decidable syntax — the flags a script's
 *     operation takes are read from the script, not retyped);
 *   - `deploy/runtime-dsh/install-runtime.sh` knows what the image installs.
 *
 * This script reads each of them once and writes the one record the product
 * reads. It never decides a state: whether a package can run here is the domain's
 * `skillDependencyReasons` over this table (a label, never a gate), and a fact
 * no source supplies is written as unknown, not guessed. The runtime web image
 * carries neither `deploy/runtime-dsh` nor `capability-skills` nor the community
 * pack, which is why the reading is done at build time and committed, as
 * `capability-display.json` is.
 *
 * Usage:
 *   node scripts/build/generate-skill-packages.mjs            # write
 *   node scripts/build/generate-skill-packages.mjs --check    # what CI runs
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  PYTHON_DISTRIBUTION_MODULES,
  R_IMAGE_PACKAGES,
  buildSkillPackageRecord,
  mcpToolBaseName,
  normalizeSkillOperation,
} from "@evimed/domain";
import { digestDirectory } from "../../apps/server/src/releaseManifest.mjs";
import { COWORK_OPERATIONS } from "../../packages/socket/extensions/cowork/operations.mjs";
import { definedInstallPhases } from "../ops/runtime-install-phases.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The table's path, relative to the repository root. */
export const SKILL_PACKAGES_TABLE = "packages/domain/src/skill-packages.json";

/** Source files whose text is kept so imports can be read; bigger ones are listed by digest only. */
const MAX_TEXT_BYTES = 512 * 1024;

/**
 * The commands the apt packages the image installs put on the path. A closed
 * table: a package without a row contributes its name and no command, and the
 * image's own `verify-tools` phase names the commands the build checks.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const APT_COMMANDS = Object.freeze({
  bash: ["bash"], curl: ["curl"], git: ["git"], gzip: ["gzip"], socat: ["socat"], tar: ["tar"],
  python3: ["python", "python3"], "r-base-core": ["R", "Rscript"], ripgrep: ["rg"],
});

// ---------------------------------------------------------------------------
// The image recipe
// ---------------------------------------------------------------------------

/**
 * What the runtime image installs, read from the install script's own phases.
 * @param {string} script the text of deploy/runtime-dsh/install-runtime.sh
 * @returns {{ source: string, python: Record<string, string>, modules: Record<string, string[]>, apt: string[], tools: string[], rPackages: string[] }}
 */
export function readImageRecipe(script) {
  const phases = definedInstallPhases(script);
  const python = /** @type {Record<string, string>} */ ({});
  for (const match of String(phases.get("python") ?? "").matchAll(/^\s+([A-Za-z0-9_.-]+)==([0-9][^\s\\]*)/gmu)) python[match[1].toLowerCase()] = match[2];
  if (!Object.keys(python).length) throw new Error("install-runtime.sh pins no python package in its python phase");
  const modules = /** @type {Record<string, string[]>} */ ({});
  for (const distribution of Object.keys(python)) {
    const provided = PYTHON_DISTRIBUTION_MODULES[distribution];
    if (!provided) throw new Error(`the image pins ${distribution}, which PYTHON_DISTRIBUTION_MODULES (packages/domain/src/skillSupply.mjs) does not list: add the modules it provides`);
    modules[distribution] = [...provided];
  }
  const system = String(phases.get("system") ?? "").split("\n");
  const start = system.findIndex((line) => line.includes("apt-get install -y --no-install-recommends"));
  /** @type {string[]} */ const apt = [];
  for (let index = start + 1; start >= 0 && index < system.length; index += 1) {
    const line = system[index].trim();
    const name = line.replace(/\s*\\$/u, "");
    if (/^[a-z0-9][a-z0-9+.-]*$/u.test(name)) apt.push(name);
    if (!line.endsWith("\\")) break;
  }
  if (!apt.length) throw new Error("install-runtime.sh installs no apt package in its system phase");
  const tools = new Set(apt.flatMap((name) => APT_COMMANDS[name] ?? []));
  for (const line of String(phases.get("verify-tools") ?? "").split("\n")) {
    const words = line.trim().split(/\s+/u);
    if (words[0] === "test" && words[1] === "-x") tools.add(path.basename(words[2] ?? ""));
    else if (words[0] && !["set", "test", "echo"].includes(words[0]) && /^[A-Za-z][A-Za-z0-9._-]*$/u.test(words[0])) tools.add(words[0]);
  }
  if (phases.has("toolchain")) { tools.add("node"); tools.add("uv"); }
  if (phases.has("pnpm")) tools.add("pnpm");
  tools.delete("");
  if (!(apt.includes("r-base-core") && apt.includes("r-recommended"))) throw new Error("the image's R packages changed: update R_IMAGE_PACKAGES (packages/domain/src/skillSupply.mjs)");
  return {
    source: "deploy/runtime-dsh/install-runtime.sh",
    python: Object.fromEntries(Object.entries(python).sort(([left], [right]) => left.localeCompare(right, "en"))),
    modules: Object.fromEntries(Object.entries(modules).sort(([left], [right]) => left.localeCompare(right, "en"))),
    apt: [...new Set(apt)].sort(),
    tools: [...tools].sort(),
    rPackages: [...R_IMAGE_PACKAGES],
  };
}

// ---------------------------------------------------------------------------
// Operations read from a script's own argument parser
// ---------------------------------------------------------------------------

/** @param {string} text @param {number} open the index of an opening parenthesis @returns {number} the index of its closing one, or -1 */
function closingParenthesis(text, open) {
  let depth = 0;
  /** @type {string | null} */ let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/**
 * The flags a Python script's `argparse` parser reads: name, type, whether it is
 * required, its default and closed values, its help, and the mutually exclusive
 * groups. Read from the call syntax, which is closed; an argument built from
 * anything but a literal is read as far as its literal parts go and no further.
 *
 * @param {string} source
 * @returns {{ params: Record<string, any>[], groups: { required: boolean, flags: string[] }[] }}
 */
export function readArgparse(source) {
  /** @type {Map<string, { required: boolean, flags: string[] }>} */ const groups = new Map();
  for (const match of source.matchAll(/^\s*(\w+)\s*=\s*\w+\.add_mutually_exclusive_group\(([^)]*)\)/gmu)) groups.set(match[1], { required: /required\s*=\s*True/u.test(match[2]), flags: [] });
  /** @type {Record<string, any>[]} */ const params = [];
  for (const match of source.matchAll(/(\w+)\.add_argument\(/gu)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingParenthesis(source, open);
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    const flag = /^\s*["'](--[A-Za-z][A-Za-z0-9-]*)["']/u.exec(body)?.[1];
    if (!flag) continue;
    const rest = body.slice(body.indexOf(flag) + flag.length);
    const group = groups.get(match[1]);
    const type = /action\s*=\s*["']store_true["']/u.test(rest) ? "boolean"
      : /type\s*=\s*Path\b/u.test(rest) ? "path" : /type\s*=\s*int\b/u.test(rest) ? "integer" : /type\s*=\s*float\b/u.test(rest) ? "number" : "string";
    const fallback = /default\s*=\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))/u.exec(rest);
    const choices = /choices\s*=\s*\[([^\]]*)\]/u.exec(rest)?.[1];
    const help = /help\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(rest);
    const param = {
      name: flag, type,
      ...(/required\s*=\s*True/u.test(rest) && !group ? { required: true } : {}),
      ...(fallback ? { default: fallback[3] !== undefined ? Number(fallback[3]) : (fallback[1] ?? fallback[2]) } : {}),
      ...(choices ? { values: [...choices.matchAll(/["']([^"']+)["']/gu)].map((value) => value[1]) } : {}),
      ...(help ? { description: help[1] ?? help[2] } : {}),
    };
    params.push(param);
    group?.flags.push(flag);
  }
  return { params, groups: [...groups.values()].filter((group) => group.flags.length > 1) };
}

/** The limits sentences a mutually exclusive group yields. @param {{ required: boolean, flags: string[] }[]} groups @returns {string[]} */
function groupLimits(groups) {
  return groups.map((group) => `${group.required ? "必须且只能给出其中一个" : "至多给出其中一个"}：${group.flags.join("、")}`);
}

// ---------------------------------------------------------------------------
// Reading a package
// ---------------------------------------------------------------------------

/** @param {string} text @returns {Record<string, any>} the YAML frontmatter of a SKILL.md, or {} */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) return {};
  try {
    const value = parseYaml(match[1]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** @param {string} dir @returns {Promise<{ path: string, sha256: string, text?: string }[]>} */
async function packageFiles(dir) {
  /** @type {{ path: string, sha256: string, text?: string }[]} */ const files = [];
  /** @param {string} current */
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (["node_modules", "__pycache__", ".DS_Store"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const bytes = await fs.readFile(full);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      const readable = /\.(?:py|r)$/iu.test(relative) || /(?:^|\/)SKILL\.md$/u.test(relative);
      files.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), ...(readable && bytes.length <= MAX_TEXT_BYTES ? { text: bytes.toString("utf8") } : {}) });
    }
  }
  await walk(dir);
  return files;
}

/** @param {string} file @returns {Promise<any>} */
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
/** @param {string} dir @returns {Promise<string[]>} the directories under `dir` that hold a SKILL.md */
async function skillDirectories(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  /** @type {string[]} */ const found = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (await fs.stat(path.join(dir, entry.name, "SKILL.md")).then(() => true, () => false)) found.push(entry.name);
  }
  return found;
}

/**
 * Every package the repository ships, as the records the domain reads.
 * @param {string} [root]
 * @returns {Promise<{ image: ReturnType<typeof readImageRecipe>, packages: Record<string, any>[] }>}
 */
export async function collectSkillPackages(root = repoRoot) {
  const image = readImageRecipe(await fs.readFile(path.join(root, "deploy/runtime-dsh/install-runtime.sh"), "utf8"));
  const skills = path.join(root, "runtime/skills");
  const curatedRoot = path.join(skills, "curated-scientific");
  const officeRoot = path.join(skills, "office");
  const communityRoot = path.join(skills, "community");
  const inventory = await readJson(path.join(curatedRoot, "inventory.json"));
  const office = await readJson(path.join(officeRoot, "inventory.json"));
  const sources = await readJson(path.join(communityRoot, "sources.json"));
  const capabilityNames = await skillDirectories(path.join(root, "capabilities"));

  // Every module a package's own scripts ship, so one script importing its sibling is not a dependency.
  /** @type {Set<string>} */ const localModules = new Set();
  for (const tree of [skills, path.join(root, "capabilities"), path.join(root, "capability-skills")]) {
    for (const entry of await fs.readdir(tree, { recursive: true }).catch(() => [])) if (String(entry).endsWith(".py")) localModules.add(path.basename(String(entry), ".py"));
  }
  const imageModules = new Set(Object.values(image.modules).flat());
  for (const name of imageModules) localModules.delete(name);

  /** @type {Record<string, any>[]} */ const packages = [];
  /** @param {Record<string, any>} input @returns {Promise<void>} */
  async function add({ origin, name, dir, version = null, source = null, licence = null, dependencies = [], operations = [], skillFile = "SKILL.md" }) {
    const files = await packageFiles(dir);
    const frontmatter = parseFrontmatter(files.find((file) => file.path === skillFile)?.text ?? "");
    const metadata = {
      ...(frontmatter.metadata && typeof frontmatter.metadata === "object" ? frontmatter.metadata : {}),
      ...(typeof frontmatter.license === "string" ? { license: frontmatter.license } : {}),
      ...(typeof frontmatter.version === "string" || typeof frontmatter.version === "number" ? { version: frontmatter.version } : {}),
    };
    const record = buildSkillPackageRecord({
      id: `${origin}/${name}`, name, origin, version, source, licence, files, metadata, localModules: [...localModules],
      digest: (await digestDirectory(dir)).digest, digestAlgorithm: "release-directory-v1", dependencies, operations,
    });
    if (!record) throw new Error(`the package ${origin}/${name} does not read as a record`);
    packages.push(record);
  }

  // core: the platform's own skills.
  for (const name of await skillDirectories(path.join(skills, "core"))) {
    await add({ origin: "core", name, dir: path.join(skills, "core", name), source: { kind: "release" } });
  }

  // curated: derived from a reviewed upstream pack; the executor's flags are read from the executor.
  const executorSource = await fs.readFile(path.join(curatedRoot, "_runtime/execute_skill.py"), "utf8");
  const executor = readArgparse(executorSource);
  const template = (await readJson(path.join(curatedRoot, "_runtime/operations.json")));
  const described = new Set(template.operation.params.map((/** @type {any} */ param) => param.name));
  for (const param of template.operation.params) {
    if (!executor.params.some((flag) => flag.name === param.name)) throw new Error(`_runtime/operations.json describes ${param.name}, which execute_skill.py does not read`);
  }
  const licenceFile = (await fs.readdir(curatedRoot)).find((name) => /^LICENSE\./u.test(name));
  if (licenceFile) {
    const sha = createHash("sha256").update(await fs.readFile(path.join(curatedRoot, licenceFile))).digest("hex");
    if (sha !== inventory.source.licenseSha256) throw new Error(`${licenceFile} does not match the licence digest the curated inventory records`);
  }
  const curatedLicence = { id: inventory.source.license, file: licenceFile ? { path: licenceFile, sha256: inventory.source.licenseSha256 } : null, basis: "inventory" };
  for (const skill of inventory.skills) {
    const contract = inventory.policy.delivery.executable[skill.name];
    const [, upstreamPath] = /^[^/]+\/(.+)$/u.exec(skill.derivedFrom ?? "") ?? [];
    const params = executor.params.map((flag) => (flag.name === "--skill"
      ? { ...flag, required: true, values: [skill.name], description: "固定为这个技能的名称" }
      : { ...flag, ...(described.has(flag.name) ? { description: template.operation.params.find((/** @type {any} */ param) => param.name === flag.name).description } : {}),
        ...(template.operation.params.find((/** @type {any} */ param) => param.name === flag.name)?.required ? { required: true } : {}) }));
    const operation = contract ? {
      name: `${skill.name} baseline`, kind: "script", entrypoint: template.entrypoint, params,
      summary: template.operation.summary, summaryZh: template.operation.summaryZh,
      accepts: template.operation.accepts, produces: contract.artifacts, limits: [...template.operation.limits, ...groupLimits(executor.groups)],
    } : null;
    const declared = (inventory.policy.delivery.methodDependencies?.[skill.name] ?? []).map((/** @type {any} */ dependency) => ({
      kind: dependency.kind, name: dependency.name, optional: dependency.optional === true, basis: "declared", evidence: `inventory.json: ${dependency.evidence}`,
    }));
    const contractDependencies = (contract?.dependencies ?? []).map((/** @type {string} */ entry) => {
      const [, name, constraint] = /^([A-Za-z0-9._+-]+)((?:==|>=|<=|~=|!=).+)?$/u.exec(entry) ?? [];
      const python = name && Object.hasOwn(image.python, name.toLowerCase());
      return { kind: python ? "python-package" : "system-tool", name, constraint: constraint ?? null, basis: "declared", evidence: "inventory.json: delivery contract" };
    });
    await add({
      origin: "curated", name: skill.name, dir: path.join(curatedRoot, skill.name),
      source: { kind: "derived", package: inventory.source.package, path: upstreamPath ?? null },
      licence: curatedLicence, dependencies: [...contractDependencies, ...declared], operations: operation ? [operation] : [],
    });
  }

  // community: vendored at an exact commit.
  for (const entry of sources.skills) {
    const dir = path.join(communityRoot, entry.name);
    const file = (await fs.readdir(dir)).find((name) => /^LICEN[CS]E/u.test(name));
    await add({
      origin: "community", name: entry.name, dir,
      source: { kind: "repository", repository: entry.repo, commit: entry.commit, path: entry.subpath ?? null },
      licence: { id: entry.license, file: file ? { path: file, sha256: createHash("sha256").update(await fs.readFile(path.join(dir, file))).digest("hex") } : null, basis: "inventory" },
    });
  }

  // office: first-party exporters; operations read from each exporter's own flags.
  for (const [name, contract] of Object.entries(office.policy.delivery.executable)) {
    const entrypoint = /** @type {any} */ (contract).entrypoints[0];
    const parsed = readArgparse(await fs.readFile(path.join(officeRoot, name, entrypoint), "utf8"));
    const description = parseFrontmatter(await fs.readFile(path.join(officeRoot, name, "SKILL.md"), "utf8")).description;
    await add({
      origin: "office", name, dir: path.join(officeRoot, name), source: { kind: "release" }, licence: { id: office.license, file: null, basis: "inventory" },
      dependencies: /** @type {any} */ (contract).dependencies.map((/** @type {string} */ entry) => {
        const [, dependency, constraint] = /^([A-Za-z0-9._+-]+)((?:==|>=|<=|~=|!=).+)?$/u.exec(entry) ?? [];
        return { kind: Object.hasOwn(image.python, String(dependency).toLowerCase()) ? "python-package" : "system-tool", name: dependency, constraint: constraint ?? null, basis: "declared", evidence: "inventory.json: delivery contract" };
      }),
      operations: [{ name: `create ${name}`, kind: "script", entrypoint, params: parsed.params, summary: typeof description === "string" ? description : null, produces: /** @type {any} */ (contract).artifacts, limits: groupLimits(parsed.groups) }],
    });
  }

  // evimed: the one agent package the image takes whole.
  {
    const dir = path.join(skills, "evimed/open-domain-answer");
    const agent = parseYaml(await fs.readFile(path.join(dir, "agent.yaml"), "utf8"));
    await add({ origin: "evimed", name: "open-domain-answer", dir, version: typeof agent?.version === "string" ? agent.version : null, source: { kind: "release" } });
  }

  // capabilities: each is a package (its manifest, its skill body, its scripts); the shared bodies are packages of their own.
  for (const name of capabilityNames) {
    const dir = path.join(root, "capabilities", name);
    const manifest = parseYaml(await fs.readFile(path.join(dir, "capability.yaml"), "utf8"));
    const tools = [...new Set((manifest.tools ?? []).map((/** @type {string} */ tool) => mcpToolBaseName(tool)).filter(Boolean))];
    const display = manifest.display ?? {};
    const operations = (manifest.produces ?? []).map((/** @type {any} */ entry) => ({
      name: entry.contractKind, kind: "deliverable", summary: typeof manifest.description === "string" && manifest.description.length <= 300 ? manifest.description : null,
      summaryZh: typeof display.description === "string" ? display.description : null,
      accepts: [...(manifest.inputs?.required ?? []), ...(manifest.inputs?.optional ?? [])],
      produces: (entry.outputs ?? []).map((/** @type {any} */ output) => output.path),
      limits: Array.isArray(display.knownLimits) ? display.knownLimits : [],
    }));
    await add({
      origin: "capability", name, dir, version: String(manifest.version ?? "") || null, source: { kind: "release" },
      dependencies: tools.map((tool) => ({ kind: "platform-tool", name: tool, basis: "declared", evidence: "capability.yaml: tools" })), operations,
    });
  }
  for (const name of await skillDirectories(path.join(root, "capability-skills"))) {
    if (capabilityNames.includes(name)) continue;
    await add({ origin: "capability-skill", name, dir: path.join(root, "capability-skills", name), source: { kind: "release" } });
  }

  // the isolated document tools the extension centre admits.
  {
    const dir = path.join(root, "scripts/runtime/extensions/cowork");
    const descriptor = await readJson(path.join(dir, "descriptor.json"));
    const manifest = await readJson(path.join(dir, "source-manifest.json"));
    const licenceEntry = (manifest.files ?? []).find((/** @type {any} */ file) => file.path === "LICENSE");
    const record = buildSkillPackageRecord({
      id: `extension/${descriptor.id}`, name: descriptor.id, origin: "extension", version: String(descriptor.commit).slice(0, 12),
      source: { kind: "repository", repository: descriptor.repository.replace(/^https:\/\/github\.com\//u, ""), commit: descriptor.commit },
      licence: { id: descriptor.license, file: licenceEntry ? { path: "LICENSE", sha256: licenceEntry.sha256 } : null, basis: "declared" },
      digest: `sha256:${descriptor.sourceArchiveSha256}`, digestAlgorithm: "source-archive-sha256", files: [],
      operations: COWORK_OPERATIONS.map((raw) => normalizeSkillOperation(raw)).filter((operation) => operation !== null),
    });
    if (!record) throw new Error("the document tools' record does not read");
    packages.push(record);
  }

  packages.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { image, packages };
}

/**
 * The table stores a record without its absences: a null, an empty list and a
 * `false` are what the domain's reader fills in again, so writing them 91 times
 * over would only make the file larger and every diff noisier.
 * @param {any} value @returns {any}
 */
export function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, any>} */ const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === false || (Array.isArray(item) && item.length === 0)) continue;
    out[key] = prune(item);
  }
  return out;
}

/**
 * JSON with a short object or array on one line and a long one broken at its
 * members: one line per file, per parameter, per dependency, so a change to one
 * package's file touches one line and two branches that each change a different
 * package merge without a conflict.
 * @param {any} value @param {number} [depth] @returns {string}
 */
export function stringify(value, depth = 0) {
  const flat = JSON.stringify(value);
  if (flat === undefined || !value || typeof value !== "object" || flat.length <= 150) return flat ?? "null";
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (Array.isArray(value)) return `[\n${value.map((item) => `${pad}${stringify(item, depth + 1)}`).join(",\n")}\n${close}]`;
  return `{\n${Object.entries(value).map(([key, item]) => `${pad}${JSON.stringify(key)}: ${stringify(item, depth + 1)}`).join(",\n")}\n${close}}`;
}

/** @param {string} [root] @returns {Promise<string>} */
export async function renderSkillPackagesTable(root = repoRoot) {
  const { image, packages } = await collectSkillPackages(root);
  return `${stringify({
    schemaVersion: 1,
    description: "Generated by scripts/build/generate-skill-packages.mjs from the skill packs' inventories, capabilities/*/capability.yaml, each package's own files and deploy/runtime-dsh/install-runtime.sh. Do not edit by hand: change the package (or the inventory) and re-run the generator.",
    image,
    packages: packages.map(prune),
  })}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const target = path.join(repoRoot, SKILL_PACKAGES_TABLE);
  const rendered = await renderSkillPackagesTable();
  if (check) {
    const current = await fs.readFile(target, "utf8").catch(() => null);
    if (current !== rendered) {
      process.stderr.write(`out of date: ${SKILL_PACKAGES_TABLE}\nrun \`node scripts/build/generate-skill-packages.mjs\` and commit the result\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.parse(rendered).packages.length} skill packages up to date\n`);
    return;
  }
  await fs.writeFile(target, rendered, "utf8");
  process.stdout.write(`${JSON.parse(rendered).packages.length} skill packages written to ${SKILL_PACKAGES_TABLE}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
