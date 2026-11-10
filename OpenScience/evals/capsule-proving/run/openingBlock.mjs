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

/** Rebuild the same persona and guidance as evals/remembered-format/texts.mjs. */
export function buildSystemPrompt({ model = "deepseek-flash" } = {}) {
  const manifests = readdirSync(path.join(root, "capabilities")).flatMap((id) => {
    try { return [parse(readFileSync(path.join(root, "capabilities", id, "capability.yaml"), "utf8"), quiet)]; }
    catch { return []; }
  });
  const guidance = buildGuidanceText(manifests, {
    askUserEnabled: true, capsuleActive: false, reviewEnabled: false, runPolicyEnabled: true,
    capsuleToolEnabled: false, openVikingMemory: true,
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
