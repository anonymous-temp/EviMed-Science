#!/usr/bin/env node
/**
 * Writes `packages/domain/src/runtime-inventory.json`: what a runtime session of this image is made of, read out of the
 * files that define it — every bundle and row of the composition the kernel boots with, every row of the agent preset,
 * every skill root, the tool sets, the skills the LoopX CLI installs and where the GEO method pack's index sits.
 *
 * Hidden knowledge: 「插件与技能」 used to list what a person had written a row for. LoopX (`长任务`), OpenViking's memory
 * plugin, the kernel's own step list, sub-agents, hand-over and questions, and the 51 skills of the GEO method pack were in
 * every session and on no page, because the page's members were typed by hand and the image's were built, with nothing between
 * the two that could fail (audit A §1, owner 2026-10-14: 「loopx 这插件……技能与插件那里看不到」). The composition snapshot
 * (`deploy/runtime-dsh/dump-config.baseline.json`) is committed and the image build diffs it against what the kernel really
 * composes, so it IS the image's own list; this reads it, and `runtime-inventory-zh.json` — the words — must account for
 * everything in it, or `packages/domain/test/runtimeInventory.test.mjs` is red. A new bundle, a new row, a new skill root
 * with no words is a decision somebody makes, in a file, with a reason, and not a thing nobody noticed.
 *
 * Nothing of the GEO pack is read here: the pack is proprietary and this file is committed. Its index sits beside the
 * pack, in the git-ignored private root (`geo-pack-index.mjs`), and the server reads it at run time.
 *
 * Usage:
 *   node scripts/build/generate-runtime-inventory.mjs            # write
 *   node scripts/build/generate-runtime-inventory.mjs --check    # what CI runs
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_MOUNTED_TOOL_NAMES,
  MCP_TOOL_BASE_NAMES,
  OPENVIKING_MEMORY_TOOL_BASE_NAMES,
  RUNTIME_SKILL_ROOTS,
  SOCKET_TOOL_NAME_LIST,
} from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The table's path, relative to the repository root. */
export const RUNTIME_INVENTORY_FILE = "packages/domain/src/runtime-inventory.json";
/** What it is read from. */
export const COMPOSITION_FILE = "deploy/runtime-dsh/dump-config.baseline.json";
export const PRESET_FILE = "packages/socket/presets/evimed-universal/agent.cordis.yml";
export const LOOPX_SKILLS_FILE = "packages/contracts/loopx/workflow-skills.json";
/** Where the GEO method pack's index is written beside the pack (git-ignored; the generator never reads it). */
export const GEO_PACK_INDEX_PATH = "runtime/skills/geo-private/geo-pack-index.json";

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A scalar's text with its quotes taken off. @param {string} value */
function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/**
 * Whether a row is mounted: no `disabled:` at all and `disabled: false` are mounted, `disabled: true` is not, and a `!!js`
 * expression is decided by the environment (the row is conditional, and the page says nothing it cannot know).
 * @param {string | undefined} value @returns {"enabled" | "disabled" | "conditional"}
 */
function stateOf(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text === "false") return "enabled";
  if (text === "true") return "disabled";
  return "conditional";
}

/**
 * The composition snapshot: its rows, and the bundle each row came from (the `# == <bundle>` comment above it).
 * A comment may also say what patched the row (`@deepseek-ai/dsh-base, patched by @evimed/dsh-socket`): the first name is the
 * bundle that declared it, the rest are bundles whose patch touched it.
 * @param {string} text
 * @returns {{ bundles: string[], rows: { id: string, name: string, bundle: string, patchedBy: string[], state: "enabled" | "disabled" | "conditional" }[] }}
 */
export function readComposition(text) {
  /** @type {string[]} */ const bundles = [];
  /** @type {{ id: string, name: string, bundle: string, patchedBy: string[], state: "enabled" | "disabled" | "conditional" }[]} */ const rows = [];
  let bundle = "";
  let patchedBy = /** @type {string[]} */ ([]);
  /** @type {{ id: string, name: string, bundle: string, patchedBy: string[], disabled?: string } | null} */
  let current = null;
  const close = () => {
    if (!current) return;
    rows.push({ id: current.id, name: current.name, bundle: current.bundle, patchedBy: current.patchedBy, state: stateOf(current.disabled) });
    current = null;
  };
  for (const line of text.split("\n")) {
    const comment = /^# == (.+)$/.exec(line);
    if (comment) {
      close();
      const [declared, ...patchers] = comment[1].split(/,\s*patched by\s*/);
      bundle = declared.trim();
      patchedBy = patchers.flatMap((part) => part.split(/,\s*/)).map((part) => part.trim()).filter(Boolean);
      if (!bundles.includes(bundle)) bundles.push(bundle);
      continue;
    }
    const id = /^- id: (\S+)\s*$/.exec(line);
    if (id) {
      close();
      if (!bundle) throw new Error(`${COMPOSITION_FILE}: a row (${id[1]}) stands before any "# == <bundle>" comment`);
      current = { id: id[1], name: "", bundle, patchedBy };
      continue;
    }
    if (!current) continue;
    const name = /^ {2}name: (.+)$/.exec(line);
    if (name && !current.name) current.name = unquote(name[1]);
    const disabled = /^ {2}disabled: (.*)$/.exec(line);
    if (disabled && current.disabled === undefined) current.disabled = disabled[1];
  }
  close();
  if (rows.length < 100 || bundles.length < 5) throw new Error(`${COMPOSITION_FILE}: read ${rows.length} rows and ${bundles.length} bundles; the file's shape is not the one this reads`);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${COMPOSITION_FILE}: row ${row.id} is declared twice`);
    seen.add(row.id);
    if (!row.name) throw new Error(`${COMPOSITION_FILE}: row ${row.id} has no name`);
  }
  return { bundles, rows };
}

/**
 * The rows of the agent preset, and the skill roots it mounts. A `cordis:group` row is a way to nest rows, not a row.
 * @param {string} text
 */
export function readPreset(text) {
  /** @type {{ id: string, name: string, state: "enabled" | "disabled" | "conditional" }[]} */ const rows = [];
  const chunks = text.split(/\n(?=\s*- id: )/);
  for (const chunk of chunks) {
    const id = /^\s*- id: (\S+)/.exec(chunk)?.[1];
    if (!id) continue;
    const name = /^\s*name: (.+)$/m.exec(chunk)?.[1];
    if (!name) throw new Error(`${PRESET_FILE}: row ${id} has no name`);
    if (unquote(name) === "cordis:group") continue;
    const disabled = /^\s*disabled: (.*)$/m.exec(chunk)?.[1];
    // The first `name:` is the row's own: a nested row starts its own chunk.
    rows.push({ id, name: unquote(name), state: stateOf(disabled) });
  }
  // The skill roots, from the one row that mounts them.
  const skills = chunks.find((chunk) => /^\s*- id: skill-filesystem\b/.test(chunk));
  if (!skills) throw new Error(`${PRESET_FILE}: no skill-filesystem row`);
  /** @type {{ id: string, mount: string, gate: string | null }[]} */ const roots = [];
  for (const line of skills.split("\n")) {
    const entry = /^\s*- !!js (.+)$/.exec(line);
    if (!entry) continue;
    const expression = entry[1];
    const preset = /EVIMED_PRESET_SKILLS_DIR \+ '\/([a-z0-9-]+)(\/skills)?'/.exec(expression);
    // The GEO method pack is a root only in the runtime of a 「循证 GEO」 project (the preset reads EVIMED_GEO_SKILLS).
    if (preset) { roots.push({ id: preset[1], mount: preset[1] + (preset[2] ?? ""), gate: /EVIMED_GEO_SKILLS/.test(expression) ? "geoProject" : null }); continue; }
    if (/EVIMED_LOOPX_ROOT/.test(expression)) { roots.push({ id: "loopx", mount: "loopx/skills", gate: "loopxEnabled" }); continue; }
    if (/EVIMED_PERSONAL_SKILLS_DIR/.test(expression)) { roots.push({ id: "personal", mount: "personal-skills", gate: null }); continue; }
    if (/EVIMED_PLATFORM_SKILLS_DIR/.test(expression)) { roots.push({ id: "platform-learned", mount: "platform-skills", gate: null }); continue; }
    throw new Error(`${PRESET_FILE}: a skill root this generator does not know — ${entry[1].slice(0, 80)} — say where it comes from in readPreset`);
  }
  if (roots.length < 6) throw new Error(`${PRESET_FILE}: read ${roots.length} skill roots; the file's shape is not the one this reads`);
  return { rows, roots };
}

/**
 * Where each root's skills come from, for a reader of the inventory: a directory of the repository, a contract the build
 * records, the index beside the private pack, or what an account or the learning loop writes.
 * @param {{ id: string, mount: string, gate: string | null }} root
 */
function describeRoot(root) {
  if (root.id === "loopx") return { ...root, kind: "contract", source: LOOPX_SKILLS_FILE };
  if (root.id === "geo-private") return { ...root, kind: "private-index", source: GEO_PACK_INDEX_PATH };
  if (root.id === "personal") return { ...root, kind: "account", source: null };
  if (root.id === "platform-learned") return { ...root, kind: "learned", source: null };
  const known = RUNTIME_SKILL_ROOTS.find((family) => family.family === root.id);
  return { ...root, kind: "repo", source: known ? known.source : `runtime/skills/${root.id}` };
}

/**
 * Builds the inventory object from the files, relative to `root`.
 * @param {string} [root]
 */
export async function buildRuntimeInventory(root = repoRoot) {
  const read = (/** @type {string} */ file) => fs.readFile(path.join(root, file), "utf8");
  const [compositionText, presetText, loopxText] = await Promise.all([read(COMPOSITION_FILE), read(PRESET_FILE), read(LOOPX_SKILLS_FILE)]);
  const composition = readComposition(compositionText);
  const preset = readPreset(presetText);
  const loopx = JSON.parse(loopxText);
  if (!Array.isArray(loopx.kept) || !loopx.kept.includes(loopx.entry)) throw new Error(`${LOOPX_SKILLS_FILE}: the kept skills must hold the entry skill`);
  return {
    $comment: "Generated by scripts/build/generate-runtime-inventory.mjs from the composition snapshot, the agent preset, the tool names, the skill roots and the LoopX skill record. Do not edit by hand: change the source (or packages/domain/src/runtime-inventory-zh.json, the words) and re-run the generator.",
    schemaVersion: 1,
    composition: {
      source: COMPOSITION_FILE,
      sha256: sha256(compositionText),
      bundles: composition.bundles,
      rows: composition.rows,
    },
    preset: {
      source: PRESET_FILE,
      sha256: sha256(presetText),
      rows: preset.rows,
    },
    toolSets: {
      research: [...MCP_TOOL_BASE_NAMES],
      memory: [...OPENVIKING_MEMORY_TOOL_BASE_NAMES],
      socket: [...SOCKET_TOOL_NAME_LIST],
      kernel: [...KERNEL_MOUNTED_TOOL_NAMES],
    },
    skillRoots: preset.roots.map(describeRoot),
    loopxSkills: { source: LOOPX_SKILLS_FILE, entry: String(loopx.entry), kept: [...loopx.kept].map(String).sort() },
  };
}

/** @param {object} inventory */
export function renderRuntimeInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

/** @param {string} [root] */
export async function renderRuntimeInventoryFile(root = repoRoot) {
  return renderRuntimeInventory(await buildRuntimeInventory(root));
}

async function main() {
  const check = process.argv.includes("--check");
  const target = path.join(repoRoot, RUNTIME_INVENTORY_FILE);
  const expected = await renderRuntimeInventoryFile();
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (check) {
    if (current !== expected) {
      process.stderr.write(`out of date: ${RUNTIME_INVENTORY_FILE}\nrun \`node scripts/build/generate-runtime-inventory.mjs\` and commit the result\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (current !== expected) await fs.writeFile(target, expected);
  const inventory = JSON.parse(expected);
  process.stdout.write(`${current === expected ? "unchanged" : "wrote"}: ${RUNTIME_INVENTORY_FILE} (${inventory.composition.bundles.length} bundles, ${inventory.composition.rows.length} host rows, ${inventory.preset.rows.length} agent rows, ${inventory.skillRoots.length} skill roots)\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
