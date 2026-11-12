import { readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { buildGuidanceText } from "../../../packages/socket/src/guidanceText.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const quiet = { logLevel: "silent" };
const extractions = new Map();
const modules = new WeakMap();
let moduleId = 0;

// Pure text mirrors of the pinned kernel's @deepseek-ai/dsh-tool-skill/lib/index.js (deps-version.json):
// renderCatalogMessage, renderCatalogEntries, catalogDescription, and apply's skill definition.
// No kernel imports: the lab host intentionally has no kernel installation.
export const SKILL_TOOL = {
  name: "skill",
  description: "Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.",
  inputSchema: { type: "object", properties: { name: { type: "string", description: "The exact skill name from the available skills list." } }, required: ["name"] },
};

export function catalogDescription(value, maxLength = 500) {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

// @deepseek-ai/dsh-skill/lib/index.js: escapeText, isModelInvocable, renderSkillContent.
export function escapeText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export function isModelInvocable(skill) { return skill.invocation.modelInvocable; }

export function renderCatalogEntries(entries) {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`);
}

/** The complete initial user-slot message text; discovery here is synchronous and complete. */
export function renderCatalogMessage(entries) {
  return [
    "<system-reminder>",
    entries.length === 0 ? "No skills could be confirmed in this discovery attempt." : "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "", "<available_skills>", ...renderCatalogEntries(entries), "</available_skills>", "",
    entries.length === 0 ? "Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog." : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
    "</system-reminder>",
  ].join("\n");
}

/** Filesystem skills always carry a directory resource base, including the plugin's provider. */
export function renderSkillContent(name, skill) {
  const escapedName = name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return [
    `<skill_content name="${escapedName}">`, "<skill_resources>",
    `Base directory for this skill: ${escapeText(path.dirname(skill.path))}`,
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    "</skill_resources>", "", "<skill_instructions>", skill.body, "</skill_instructions>", "</skill_content>",
  ].join("\n");
}

/** Mirror apply's validation and error text, leaving errors for the normal tool-result path. */
export function loadSkill(skills, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid skill name "${name}"`);
  const skill = skills.get(name);
  if (!skill) throw new Error(`skill "${name}" is unknown or no longer available`);
  return { blocks: [renderSkillContent(name, skill)], isError: false };
}

// dsh-skill-filesystem/lib/index.js: parseFrontmatter, parseInvocationPolicy, frontmatterBoolean.
function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    if (["true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function readSkill(file) {
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
  const match = /^---\r?\n([\s\S]*?)^---\r?$(?:\n|$)/m.exec(raw);
  if (!match || match.index !== 0) return null;
  try {
    const data = parse(match[1], quiet);
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        typeof data.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) ||
        typeof data.description !== "string" || !data.description.length) return null;
    if (["disableModelInvocation", "modelInvocable", "userInvocable"].some((key) => Object.hasOwn(data, key))) return null;
    return { name: data.name, description: data.description,
      invocation: { modelInvocable: frontmatterBoolean(data, "disable-model-invocation") !== true,
        userInvocable: frontmatterBoolean(data, "user-invocable") !== false },
      body: raw.slice(match[0].length).trim(), path: file };
  } catch { return null; } // Native discovery also skips invalid frontmatter.
}

function skillFiles(directory) {
  let files;
  try { files = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
  // Native discoverRoot reads immediate *.md files and child-directory SKILL.md files only.
  return files.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => entry.isDirectory()
    ? [path.join(directory, entry.name, "SKILL.md")]
    : entry.isFile() && entry.name.endsWith(".md") ? [path.join(directory, entry.name)] : []);
}

/**
 * Build the ordinary-conversation catalogue from image-owned roots, never workspace uploads.
 * @param {{pluginTgz?: string, includeMemory?: boolean}} options
 * @returns {Promise<{text: string, entries: Array<{name: string, description: string}>, skills: Map<string, {body: string, path: string}>}>}
 */
export async function buildSkillCatalog({ pluginTgz = process.env.CAPSULE_PROVING_PLUGIN_TGZ, includeMemory = true } = {}) {
  const inventory = JSON.parse(readFileSync(path.join(root, "packages/domain/src/runtime-inventory.json"), "utf8"));
  const winners = new Map();
  const add = (file) => {
    const skill = readSkill(file);
    if (skill && !winners.has(skill.name)) winners.set(skill.name, skill);
  };
  // Preset customSkillDirs precedence; Dockerfile ships only open-domain-answer from evimed.
  // capabilities/* and capability-skills/* are delegation injections, not catalogue roots.
  // GEO is project-gated; personal/account skills have no fixture in this engine-layer runner.
  for (const entry of inventory.skillRoots) {
    if (entry.kind === "repo" && entry.gate === null) {
      const directory = path.join(root, entry.source);
      const files = entry.id === "evimed" ? [path.join(directory, "open-domain-answer/SKILL.md")] : skillFiles(directory);
      for (const file of files) add(file);
    } else if (entry.id === "loopx") {
      // LoopX bodies are installed from its wheel, not vendored in the checkout. Use the
      // production root when available; an absent root contributes nothing, like native discovery.
      const directory = path.join(process.env.EVIMED_LOOPX_ROOT || "/opt/evimed/loopx", "skills");
      for (const name of inventory.loopxSkills.kept) add(path.join(directory, name, "SKILL.md"));
    }
  }
  if (includeMemory) {
    if (!pluginTgz) throw Object.assign(new Error("Set CAPSULE_PROVING_PLUGIN_TGZ or pass pluginTgz"), { code: "plugin_archive" });
    const modulePath = await extractPlugin(pluginTgz);
    // memoryBridge.mjs withholds openviking-skills and ov-experience-memory; only this one is visible.
    add(path.join(path.dirname(modulePath), "../skills/openviking-memory/SKILL.md"));
  }
  // DSH SkillService.snapshot -> compareSkillSummary sorts winners by name using code points,
  // irrespective of provider. Retain non-invocable winners until after collision resolution.
  const visible = [...winners.values()].filter(isModelInvocable).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const entries = visible.map(({ name, description }) => ({ name, description: catalogDescription(description) }));
  const skills = new Map(visible.map(({ name, body, path: file }) => [name, { body, path: file }]));
  return { text: renderCatalogMessage(entries), entries, skills };
}

/** Rebuild the same persona and guidance as evals/remembered-format/texts.mjs.
 * @param {{ model?: string, config?: Record<string, any> }} [options]
 */
export function buildSystemPrompt({ model = "deepseek-flash", config = {} } = {}) {
  const manifests = readdirSync(path.join(root, "capabilities")).flatMap((id) => {
    try { return [parse(readFileSync(path.join(root, "capabilities", id, "capability.yaml"), "utf8"), quiet)]; }
    catch { return []; }
  });
  const guidance = buildGuidanceText(manifests, {
    askUserEnabled: true, capsuleActive: false, reviewEnabled: false, runPolicyEnabled: true,
    capsuleToolEnabled: false, openVikingMemory: true, memorySearchHint: config.memorySearchHintEnabled === true,
    memoryForgetToolHint: config.memoryForgetToolHintEnabled === true,
    memoryForgetTargets: config.memoryForgetTargetsEnabled === true,
  });
  const rows = parse(readFileSync(path.join(root, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8"), quiet);
  const prefix = String(rows.find((row) => row?.id === "persona")?.config?.prefix ?? "").replace(/\s+/g, " ").trim();
  if (!prefix) throw new Error("The persona row of the preset has no prefix");
  return `You are an AI agent powered by DeepSeek Harness.\n\n${prefix.replace("{{model}}", model)}\n\n${guidance}`;
}

async function extractPlugin(pluginTgz) {
  const pin = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8")).openviking.plugin;
  const bytes = await readFile(pluginTgz);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
    throw Object.assign(new Error("Memory plugin archive does not match deps-version.json"), { code: "plugin_digest" });
  }
  if (!extractions.has(pin.sha256)) {
    const extraction = (async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `capsule-proving-plugin-${pin.sha256.slice(0, 12)}-`));
      // Extract from the verified bytes, so replacing the input path cannot change what is imported.
      const archive = path.join(directory, "plugin.tgz");
      await writeFile(archive, bytes, { mode: 0o600 });
      await promisify(execFile)("tar", ["-xzf", archive, "-C", directory]);
      return path.join(directory, "package/shared/profile-inject.mjs");
    })();
    extractions.set(pin.sha256, extraction);
    extraction.catch(() => extractions.delete(pin.sha256));
  }
  return extractions.get(pin.sha256);
}

/**
 * Import upstream code, never a local copy. Isolate its module-global user-space cache by memory object.
 * @param {{fetchJSON: Function}} memory
 * @param {{budgetTokens?: number, pluginTgz?: string}} options
 * @returns {Promise<string|null>}
 */
export async function buildProfileBlock(memory, { budgetTokens = 10000, pluginTgz = process.env.CAPSULE_PROVING_PLUGIN_TGZ } = {}) {
  if (!pluginTgz) throw Object.assign(new Error("Set CAPSULE_PROVING_PLUGIN_TGZ or pass pluginTgz"), { code: "plugin_archive" });
  const modulePath = await extractPlugin(pluginTgz);
  let imports = modules.get(memory);
  if (!imports) { imports = new Map(); modules.set(memory, imports); }
  if (!imports.has(modulePath)) imports.set(modulePath, import(`${pathToFileURL(modulePath).href}?memory=${++moduleId}`));
  const upstream = await imports.get(modulePath);
  const profile = await upstream.buildProfileBlock((...args) => memory.fetchJSON(...args), budgetTokens, "", { skillCatalog: false });
  // runtime.mjs profileMessage -> capture.mjs pluginMessage: user role, form="instructions".
  return profile?.block ? ['<openviking-context source="profile">', profile.block, "</openviking-context>"].join("\n") : null;
}

/** A user-slot date context; use Han characters as the deterministic Chinese-language signal. */
export function buildTimeContext(asOf, question = "") {
  const date = new Date(typeof asOf === "string" && asOf.trim() ? asOf : NaN);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error("Invalid asOf date"), { code: "invalid_date" });
  const today = date.toISOString().slice(0, 10);
  return /\p{Script=Han}/u.test(question) ? `\u4eca\u5929\u7684\u65e5\u671f\u662f ${today}\u3002` : `Today's date is ${today}.`;
}
