// The firewall between 「循证 GEO」 and the clinical answer (fusion plan §3.4):
// the open-domain answer and the clinical-evidence retrieval and ranking never
// read a GEO client's data or rules. GEO is paid visibility work for a brand;
// an answer to a clinician that ranked sources by what a client placed, or
// read a client's claim library, would be a paid insertion into a medical
// answer. This holds the boundary in code, the way the plan asks for it
// ("写进测试"): who may name a GEO tool, who may query the GEO schema, and who
// may import a GEO module.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { MCP_TOOL_BASE_NAMES } from "@evimed/domain";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverSource = path.join(root, "apps", "server", "src");

/** The tools that reach GEO data or the GEO measurement: named in the domain's tool list, never guessed. */
const GEO_TOOLS = MCP_TOOL_BASE_NAMES.filter((name) => /^geo_/.test(name) || name === "social_posts_search");

/** @param {string} directory @returns {Promise<string[]>} */
async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "__pycache__", "test", "tests"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    else out.push(full);
  }
  return out;
}

/** @param {string} text @returns {string[]} */
const geoToolsIn = (text) => GEO_TOOLS.filter((tool) => new RegExp(`(?:^|[^a-z_])(?:mcp__evimed__)?${tool}(?![a-z_])`, "m").test(text));

test("the GEO tools are the domain's: the list this firewall holds is not empty", () => {
  assert.deepEqual([...GEO_TOOLS].sort(), ["geo_read", "geo_visibility_probe", "geo_write", "social_posts_search"]);
});

test("the open-domain answer names no GEO tool, in its manifest or its method", async () => {
  const directory = path.join(root, "runtime", "skills", "evimed", "open-domain-answer");
  const manifest = parse(await readFile(path.join(directory, "agent.yaml"), "utf8"));
  const tools = [...(manifest.requiredTools ?? []), ...(manifest.optionalTools ?? [])].map(String);
  assert.ok(tools.includes("biomedical_source_search"), "the manifest was read");
  assert.deepEqual(tools.filter((tool) => GEO_TOOLS.includes(tool)), []);
  let read = 0;
  for (const file of await files(directory)) {
    read += 1;
    assert.deepEqual(geoToolsIn(await readFile(file, "utf8")), [], path.relative(root, file));
  }
  assert.ok(read >= 2, `read only ${read} files of the open-domain answer`);
});

test("only a 「循证 GEO」 capability may declare a GEO tool; clinical evidence declares none", async () => {
  const directory = path.join(root, "capabilities");
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length >= 20, `read only ${entries.length} capabilities`);
  const declaring = [];
  for (const entry of entries) {
    const manifest = parse(await readFile(path.join(directory, entry.name, "capability.yaml"), "utf8"));
    const tools = (manifest.tools ?? []).map((tool) => String(tool).replace(/^mcp__evimed__/, ""));
    if (tools.some((tool) => GEO_TOOLS.includes(tool))) declaring.push(String(manifest.id));
    // A capability's own method may not reach for them either.
    if (!String(manifest.id).startsWith("geo-")) {
      const skill = await readFile(path.join(directory, entry.name, "SKILL.md"), "utf8").catch(() => "");
      assert.deepEqual(geoToolsIn(skill), [], `${manifest.id}'s SKILL.md`);
    }
  }
  assert.deepEqual(declaring.sort(), ["geo-content", "geo-insight", "geo-proposal", "geo-strategy"]);
});

test("only the GEO modules query the GEO schema, and only the composition, the runtime wiring and the inbox link import one", async () => {
  const modules = (await readdir(serverSource)).filter((name) => name.endsWith(".mjs"));
  assert.ok(modules.length >= 150, `read only ${modules.length} server modules`);
  const querying = [];
  const importing = [];
  for (const name of modules) {
    const text = await readFile(path.join(serverSource, name), "utf8");
    if (/\bevimed_geo\./.test(text)) querying.push(name);
    if (!name.startsWith("geo") && /from "\.\/(?:geo[A-Za-z]*|socialCrawlClient|mediaMarketClient)\.mjs"/.test(text)) importing.push(name);
  }
  assert.ok(querying.length >= 5, "the walk found the GEO modules");
  assert.deepEqual(querying.filter((name) => !name.startsWith("geo")), [], "no module outside GEO reads its tables");
  // server.mjs composes the module; runtimeManager and runtimeGatewayEntry hand
  // a GEO project's runtime its gateway address; imService links a GEO notice.
  // None of them is on the path of an answer's retrieval or ranking.
  assert.deepEqual(importing.sort(), ["imService.mjs", "runtimeGatewayEntry.mjs", "runtimeManager.mjs", "server.mjs"]);
  for (const name of ["researchContext.mjs", "specialistRouting.mjs", "publicSourceGateway.mjs", "webSearchGateway.mjs", "kbSearchGateway.mjs",
    "clinicalEvidenceQuality.mjs", "agentRuns.mjs"]) {
    const text = await readFile(path.join(serverSource, name), "utf8");
    // RummaGEO (gene expression) is a literature source, not this module.
    assert.equal(/循证 GEO|EVIMED_GEO|evimed_geo|\/api\/geo|\bgeo(?:Service|Store|Gateway|Market|Orchestrator|Measure|Metrics|_read|_write)\b/.test(text), false,
      `${name} knows nothing of 循证 GEO`);
  }
});

test("in the research tool server, only the GEO modules reach the GEO gateway; retrieval and ranking do not", async () => {
  const directory = path.join(root, "runtime", "mcp", "evimed-research");
  const modules = (await readdir(directory)).filter((name) => name.endsWith(".py"));
  assert.ok(modules.includes("public_sources.py") && modules.length >= 15, `read only ${modules.length} tool modules`);
  for (const name of modules) {
    if (["geo_platform.py", "geo_probe.py", "server.py"].includes(name)) continue;
    const text = await readFile(path.join(directory, name), "utf8");
    assert.equal(/EVIMED_GEO|geo_platform|geo_probe|internal\/geo/.test(text), false, `${name} reaches no GEO gateway`);
  }
  // server.py registers the GEO tools beside the others and dispatches each by name; nothing else of it reads GEO.
  const server = await readFile(path.join(directory, "server.py"), "utf8");
  const uses = [...server.matchAll(/geo_(?:platform|probe)\.([A-Za-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(uses)].sort(), ["GeoPlatformError", "GeoProbeError", "probe", "read", "social_search", "tool_definitions", "write"]);
});
