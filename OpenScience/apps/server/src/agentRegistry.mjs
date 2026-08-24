import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { MCP_TOOL_BASE_NAMES } from "@evimed/domain";

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
// The server publishes bare names; a kernel adds its own prefix when it
// shows them to the model. A manifest names the tool, not the presentation.
const toolPattern = /^[a-z][a-z0-9_]{1,95}$/;
const inputPattern = /^[a-z][A-Za-z0-9]{0,63}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const manifestFileName = "agent.yaml";
const skillFileName = "SKILL.md";
const maxManifestBytes = 128 * 1024;
const maxSkillBytes = 1024 * 1024;

const publicManifestFields = Object.freeze([
  "id",
  "version",
  "title",
  "category",
  "description",
  "skill",
  "companionSkills",
  "estimatedMinutes",
  "starterPrompts",
  "requiredInputs",
  "optionalInputs",
  "requiredTools",
  "optionalTools",
  "dataSources",
  "outputs",
  "completionChecks",
]);
const optionalManifestFields = new Set(["companionSkills"]);

/**
 * The research tools an agent package may declare.
 *
 * Derived from `@evimed/domain` rather than copied. The copy that used to live
 * here is how the two drifted: the MCP server published names with an `evimed_`
 * prefix, the vocabulary defined them without one, and this list agreed with
 * the server — so a manifest could name a tool that the model would never see
 * under the new kernel and nothing anywhere said so.
 *
 * `health` is excluded because it is an operator probe, not something an agent
 * asks for.
 */
export const EVIMED_AGENT_TOOL_IDS = new Set(MCP_TOOL_BASE_NAMES.filter((name) => name !== "health"));

export const EVIMED_AGENT_DATA_SOURCES = new Set([
  "faers",
  "jader",
  "meddra",
  "drug-labels",
  "literature",
  "guidelines",
  "clinical-trials",
  "internal-evidence",
  "uploaded-files",
  "metaagent",
  "opengwas",
  "local-gwas",
  "bibliometric-records",
  "reporting-guidelines",
]);

export const EVIMED_AGENT_COMPLETION_CHECKS = new Set([
  "requiredOutputsExist",
  "citationsResolvable",
  "citationIntegrity",
  "citedSourcesRecorded",
  "evidenceClaimsTraceable",
  "skillsLoaded",
]);

/** @returns {Error & Record<string, any>} An Error carrying the extra fields its
 *  callers read; a bare Error type rejects every one of them. */
function registryError(message, code = "agent_package_invalid") {
  /** @type {Error & Record<string, any>} */
  const error = new Error(message);
  error.code = code;
  return error;
}

function expectPlainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw registryError(`${label} must be a mapping.`);
  }
  return value;
}

function expectString(value, label, { min = 1, max = 512 } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length < min || value.length > max) {
    throw registryError(`${label} must be a trimmed string between ${min} and ${max} characters.`);
  }
  if (value.includes("\0")) throw registryError(`${label} contains an invalid null byte.`);
  return value;
}

function expectInteger(value, label, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw registryError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function expectUniqueStringArray(value, label, { min = 1, max = 64 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw registryError(`${label} must contain between ${min} and ${max} entries.`);
  }
  const items = value.map((item, index) => expectString(item, `${label}[${index}]`, { max: 512 }));
  if (new Set(items).size !== items.length) throw registryError(`${label} must not contain duplicates.`);
  return items;
}

function expectInputIdentifiers(value, label) {
  const inputs = expectUniqueStringArray(value, label, { min: 0, max: 64 });
  for (const input of inputs) {
    if (!inputPattern.test(input)) throw registryError(`${label} contains invalid input identifier "${input}".`);
  }
  return inputs;
}

function validateOutputPath(value, index) {
  const label = `output path at index ${index}`;
  const outputPath = expectString(value, label, { max: 512 });
  const normalized = path.posix.normalize(outputPath);
  if (
    outputPath.includes("\\") ||
    path.posix.isAbsolute(outputPath) ||
    normalized !== outputPath ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw registryError(`${label} must be a normalized relative POSIX path.`);
  }
  return outputPath;
}

function validateTools(value, label, agentId, allowedToolIds, { min }) {
  const tools = expectUniqueStringArray(value, label, { min, max: 64 });
  for (const tool of tools) {
    if (!toolPattern.test(tool) || !allowedToolIds.has(tool)) {
      throw registryError(`Unknown tool "${tool}" declared by agent "${agentId}".`);
    }
  }
  return tools;
}

function validateEstimate(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw registryError("estimatedMinutes must be a two-item [minimum, maximum] tuple.");
  }
  const minimum = expectInteger(value[0], "estimatedMinutes minimum", { min: 1, max: 480 });
  const maximum = expectInteger(value[1], "estimatedMinutes maximum", { min: 1, max: 480 });
  if (minimum > maximum) throw registryError("estimatedMinutes minimum must not exceed maximum.");
  return [minimum, maximum];
}

function validateOutputs(value, { requireDeliverable = true } = {}) {
  const minimum = requireDeliverable ? 1 : 0;
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) {
    throw registryError(`outputs must contain between ${minimum} and 64 entries.`);
  }
  const paths = new Set();
  return value.map((rawOutput, index) => {
    const output = expectPlainObject(rawOutput, `output at index ${index}`);
    const unknownFields = Object.keys(output).filter((field) => !["path", "required"].includes(field));
    if (unknownFields.length > 0) throw registryError(`output at index ${index} contains unknown field(s): ${unknownFields.join(", ")}.`);
    if (!Object.hasOwn(output, "path") || !Object.hasOwn(output, "required")) {
      throw registryError(`output at index ${index} requires path and required fields.`);
    }
    const outputPath = validateOutputPath(output.path, index);
    if (paths.has(outputPath)) throw registryError(`outputs must not contain duplicate output path "${outputPath}".`);
    paths.add(outputPath);
    if (typeof output.required !== "boolean") throw registryError(`output at index ${index} required must be boolean.`);
    return Object.freeze({ path: outputPath, required: output.required });
  });
}

function validateManifest(value, directoryName, allowedToolIds, allowedDataSources, allowedCompletionChecks) {
  const manifest = expectPlainObject(value, "agent.yaml");
  const unknownFields = Object.keys(manifest).filter((field) => !publicManifestFields.includes(field));
  if (unknownFields.length > 0) {
    throw registryError(`agent.yaml contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
  }
  const missingFields = publicManifestFields.filter(
    (field) => !optionalManifestFields.has(field) && !Object.hasOwn(manifest, field),
  );
  if (missingFields.length > 0) {
    throw registryError(`agent.yaml is missing field(s): ${missingFields.join(", ")}.`);
  }

  const id = expectString(manifest.id, "agent id", { max: 63 });
  if (!idPattern.test(id)) throw registryError(`Invalid agent id "${id}".`);
  const version = expectString(manifest.version, "version", { max: 128 });
  if (!semverPattern.test(version)) throw registryError(`version "${version}" must be semantic versioning.`);
  const skill = expectString(manifest.skill, "skill", { max: 63 });
  if (!idPattern.test(skill)) throw registryError(`Invalid skill id "${skill}".`);
  if (skill !== directoryName) {
    throw registryError(`Manifest skill "${skill}" must match package directory "${directoryName}".`);
  }
  const companionSkills = expectUniqueStringArray(
    manifest.companionSkills ?? [],
    "companionSkills",
    { min: 0, max: 16 },
  );
  for (const companionSkill of companionSkills) {
    if (!idPattern.test(companionSkill)) {
      throw registryError(`Invalid companion skill id "${companionSkill}".`);
    }
    if (companionSkill === skill) {
      throw registryError("companionSkills must not repeat the package skill.");
    }
  }
  const requiredInputs = expectInputIdentifiers(manifest.requiredInputs, "requiredInputs");
  const optionalInputs = expectInputIdentifiers(manifest.optionalInputs, "optionalInputs");
  const overlappingInputs = requiredInputs.filter((input) => optionalInputs.includes(input));
  if (overlappingInputs.length > 0) {
    throw registryError(`requiredInputs and optionalInputs overlap: ${overlappingInputs.join(", ")}.`);
  }
  const requiredTools = validateTools(manifest.requiredTools, "requiredTools", id, allowedToolIds, { min: 1 });
  const optionalTools = validateTools(manifest.optionalTools, "optionalTools", id, allowedToolIds, { min: 0 });
  const overlappingTools = requiredTools.filter((tool) => optionalTools.includes(tool));
  if (overlappingTools.length > 0) {
    throw registryError(`requiredTools and optionalTools overlap: ${overlappingTools.join(", ")}.`);
  }
  const dataSources = expectUniqueStringArray(manifest.dataSources, "dataSources");
  for (const dataSource of dataSources) {
    if (!allowedDataSources.has(dataSource)) throw registryError(`Unknown data source "${dataSource}" declared by agent "${id}".`);
  }
  const completionChecks = expectUniqueStringArray(manifest.completionChecks, "completionChecks");
  for (const check of completionChecks) {
    if (!allowedCompletionChecks.has(check)) throw registryError(`Unknown completion check "${check}" declared by agent "${id}".`);
  }
  // File-delivery contracts must declare at least one required deliverable;
  // answer-mode contracts (no requiredOutputsExist check) may legitimately
  // declare zero file outputs because their deliverable is the reply itself.
  const requiresDeliverable = completionChecks.includes("requiredOutputsExist");
  const outputs = Object.freeze(validateOutputs(manifest.outputs, { requireDeliverable: requiresDeliverable }));
  if (requiresDeliverable && !outputs.some((output) => output.required)) {
    throw registryError(`Agent "${id}" declares requiredOutputsExist but no required output.`);
  }

  return Object.freeze({
    id,
    version,
    title: expectString(manifest.title, "title", { max: 128 }),
    category: expectString(manifest.category, "category", { max: 96 }),
    description: expectString(manifest.description, "description", { max: 512 }),
    skill,
    companionSkills: Object.freeze(companionSkills),
    estimatedMinutes: Object.freeze(validateEstimate(manifest.estimatedMinutes)),
    starterPrompts: Object.freeze(expectUniqueStringArray(manifest.starterPrompts, "starterPrompts", { min: 1, max: 16 })),
    requiredInputs: Object.freeze(requiredInputs),
    optionalInputs: Object.freeze(optionalInputs),
    requiredTools: Object.freeze(requiredTools),
    optionalTools: Object.freeze(optionalTools),
    dataSources: Object.freeze(dataSources),
    outputs,
    completionChecks: Object.freeze(completionChecks),
    runtimeAgent: `evimed-${id}`,
  });
}

async function readRegularFileNoFollow(file, label, maxBytes) {
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw registryError(`${label} must be a regular file.`);
    if (stat.size > maxBytes) throw registryError(`${label} exceeds its size limit.`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw registryError(`${label} is missing.`, "agent_package_missing_file");
    if (error?.code === "ELOOP") throw registryError(`${label} must not be a symlink.`, "agent_package_symlink");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertDirectoryNoFollow(directory, label) {
  let stat;
  try {
    stat = await fsp.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw registryError(`${label} is missing.`, "agent_package_root_missing");
    throw error;
  }
  if (stat.isSymbolicLink()) throw registryError(`${label} must not be a symlink.`, "agent_package_symlink");
  if (!stat.isDirectory()) throw registryError(`${label} must be a directory.`);
}

function parseYaml(text, label) {
  try {
    return parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    throw registryError(`${label} is not valid YAML: ${error.message}`);
  }
}

function parseSkillName(text, label) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw registryError(`${label} must start with YAML frontmatter.`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw registryError(`${label} has unterminated YAML frontmatter.`);
  const frontmatter = expectPlainObject(parseYaml(normalized.slice(4, end), `${label} frontmatter`), `${label} frontmatter`);
  return expectString(frontmatter.name, `${label} frontmatter name`, { max: 63 });
}

class AgentRegistry {
  #publicAgents;
  #packagesById;

  constructor(packages) {
    const sorted = [...packages].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id, "en"));
    this.#publicAgents = Object.freeze(sorted.map((entry) => entry.manifest));
    this.#packagesById = new Map(sorted.map((entry) => [entry.manifest.id, Object.freeze(entry)]));
  }

  list() {
    return [...this.#publicAgents];
  }

  get(id) {
    return this.#packagesById.get(id)?.manifest ?? null;
  }

  getPackage(id) {
    return this.#packagesById.get(id) ?? null;
  }
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {Record<string, any>} options0
 */
export async function loadAgentRegistry({
  packageDirs,
  allowedToolIds = EVIMED_AGENT_TOOL_IDS,
  allowedDataSources = EVIMED_AGENT_DATA_SOURCES,
  allowedCompletionChecks = EVIMED_AGENT_COMPLETION_CHECKS,
} = {}) {
  if (!Array.isArray(packageDirs) || packageDirs.length === 0) {
    throw registryError("At least one agent package root is required.", "agent_package_config_invalid");
  }
  const toolIds = new Set(allowedToolIds);
  const dataSources = new Set(allowedDataSources);
  const completionChecks = new Set(allowedCompletionChecks);
  const packages = [];
  const ids = new Set();

  for (const packageRoot of packageDirs) {
    if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
      throw registryError("Agent package roots must be absolute paths.", "agent_package_config_invalid");
    }
    await assertDirectoryNoFollow(packageRoot, `Agent package root "${packageRoot}"`);
    const entries = await fsp.readdir(packageRoot, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) {
        throw registryError(`Agent package "${entry.name}" must not be a symlink.`, "agent_package_symlink");
      }
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(packageRoot, entry.name);
      await assertDirectoryNoFollow(packageDir, `Agent package "${entry.name}"`);
      const manifestPath = path.join(packageDir, manifestFileName);
      const skillPath = path.join(packageDir, skillFileName);
      const manifestText = await readRegularFileNoFollow(manifestPath, `${entry.name}/${manifestFileName}`, maxManifestBytes);
      const skillText = await readRegularFileNoFollow(skillPath, `${entry.name}/${skillFileName}`, maxSkillBytes);
      const manifest = validateManifest(
        parseYaml(manifestText, `${entry.name}/${manifestFileName}`),
        entry.name,
        toolIds,
        dataSources,
        completionChecks,
      );
      const skillName = parseSkillName(skillText, `${entry.name}/${skillFileName}`);
      if (skillName !== manifest.skill) {
        throw registryError(`${entry.name}/${skillFileName} frontmatter name must be "${manifest.skill}".`);
      }
      if (ids.has(manifest.id)) throw registryError(`Duplicate agent id "${manifest.id}".`);
      ids.add(manifest.id);
      packages.push({ manifest, packageDir, manifestPath, skillPath, skillText });
    }
  }

  return new AgentRegistry(packages);
}
