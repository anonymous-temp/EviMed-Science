// The firewall between 「循证 GEO」 and the clinical answer (fusion plan §3.4):
// the open-domain answer and the clinical-evidence retrieval and ranking never
// read a GEO client's data or rules. GEO is paid visibility work for a brand;
// an answer to a clinician that ranked sources by what a client placed, or
// read a client's claim library, would be a paid insertion into a medical
// answer. This holds the boundary in code, the way the plan asks for it
// ("写进测试"): who may name a GEO tool, who may query the GEO schema, and who
// may import a GEO module.
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { MCP_TOOL_BASE_NAMES } from "@evimed/domain";
import ts from "typescript";
import { mergeInputAttribution } from "../src/geoNativeInputs.mjs";
import { contextPolicyIdentity, sameContextPolicy } from "../src/geoContextItems.mjs";
import { scopedMethodName } from "../src/geoContextProvenance.mjs";

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

// Exact metadata/identity seams. Listing a consumer permits only these modules
// and named bindings, never the business readers beside them. (The handbook arm's
// consumers left with it on 2026-10-25; the learning ledger now takes its scope only
// from the injected provenance and imports no GEO seam.)
const CONTEXT_IMPORTS = {
  "agentRuns.mjs": { geoNativeInputs: ["mergeInputAttribution"] },
  "capsuleMethods.mjs": { geoContextItems: ["CONTEXT_ITEM_FIELDS", "contextPolicyIdentity"] },
  "capsuleService.mjs": { geoContextItems: ["CONTEXT_ITEM_FIELDS"] },
  "learnedMethodMount.mjs": { geoContextItems: ["CONTEXT_ITEM_FIELDS", "contextPolicyIdentity"] },
  "learningTriggers.mjs": { geoContextItems: ["contextPolicyIdentity"] },
  "methodDistillationRuns.mjs": { geoContextItems: ["contextPolicyIdentity"], geoContextProvenance: ["scopedMethodName"] },
  "residentProfile.mjs": { geoContextItems: ["contextPolicyIdentity", "sameContextPolicy"] },
  "runtimeContextGeneration.mjs": { geoContextItems: ["contextPolicyIdentity"] },
};
const WIRING_IMPORTS = {
  "deploymentComposition.mjs": { geoGateway: ["geoGatewayProviderUrl"], geoService: ["geoAudienceAllows"] },
  "imService.mjs": { geoNotify: ["geoNoticeHref"] },
  "moduleEvolutionEvaluators.mjs": { geoJudge: ["quantityTokens"] },
  "runtimeGatewayEntry.mjs": { geoGateway: ["geoGatewayProviderUrl"] },
  "runtimeManager.mjs": { geoGateway: ["geoGatewayProviderUrl"], geoService: ["geoAudienceAllows"], geoContextItems: ["contextPolicyIdentity", "sameContextPolicy"] },
};
const GEO_MODULE = /^(geo[^/]*|socialCrawlClient|mediaMarketClient)\.mjs$/;
/** Match the resolved file identity, including ESM query/fragment instances. */
function geoModuleOf(specifier, importer) {
  try {
    const resolved = new URL(specifier, pathToFileURL(path.join(serverSource, importer)));
    if (resolved.protocol !== "file:") return null;
    let filename = fileURLToPath(resolved);
    try { filename = realpathSync(filename); } catch { /* Missing modules still use their normalized file identity. */ }
    return path.dirname(filename) === realpathSync(serverSource) ? GEO_MODULE.exec(path.basename(filename))?.[1] ?? null : null;
  } catch { return null; }
}

/** Parse all import forms so an alias, namespace or dynamic import cannot evade the named seam.
 * @param {string} text */
function geoImportsOf(text, importer = "newClinicalReader.mjs") {
  const source = ts.createSourceFile("module.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), found = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? geoModuleOf(node.moduleSpecifier.text, importer) : null;
      if (module) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : null;
        const names = clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map(binding => binding.propertyName && binding.propertyName.text !== binding.name.text ? `alias:${binding.propertyName.text}:${binding.name.text}` : binding.name.text).sort()
          : ["unsupported-import"];
        found.push([module, names]);
      }
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const module = geoModuleOf(node.arguments[0].text, importer);
      if (module) found.push([module, ["unsupported-import"]]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found.sort((left, right) => left[0].localeCompare(right[0]));
}
function assertGeoImports(name, text) {
  const actual = geoImportsOf(text, name);
  if (name === "server.mjs") return actual; // Explicit application composition, never a retrieval consumer.
  const allowed = CONTEXT_IMPORTS[name] ?? WIRING_IMPORTS[name] ?? {};
  const expected = Object.entries(allowed).map(([module, symbols]) => [module, [...symbols].sort()]).sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(actual, expected, `${name}: only its exact named GEO seam is admitted`);
  return actual;
}

test("context seams reject business readers, producer classes, aliases, namespaces and dynamic imports", async () => {
  for (const name of Object.keys(CONTEXT_IMPORTS)) {
    const source = await readFile(path.join(serverSource, name), "utf8");
    for (const extra of ["import { GeoService } from './geoService.mjs';", "import { GeoStore } from './geoStore.mjs';"]) {
      assert.throws(() => assertGeoImports(name, source + extra), assert.AssertionError);
    }
  }
  const source = await readFile(path.join(serverSource, "agentRuns.mjs"), "utf8");
  for (const extra of ["import { GeoNativeInputs } from './geoNativeInputs.mjs';", "import * as native from './geoNativeInputs.mjs';",
    "import native from './geoNativeInputs.mjs';", "import { mergeInputAttribution as other } from './geoNativeInputs.mjs';",
    "await import('./geoNativeInputs.mjs');", "await import(`./geoNativeInputs.mjs`);", "require('./geoNativeInputs.mjs');", "export { mergeInputAttribution } from './geoNativeInputs.mjs';"]) {
    assert.throws(() => assertGeoImports("agentRuns.mjs", source + extra), assert.AssertionError);
  }
  assert.throws(() => assertGeoImports("newClinicalReader.mjs", "import { GeoStore } from './geoStore.mjs';"), assert.AssertionError);
});

test("equivalent GEO module paths never evade the importer and exact-symbol policy", async () => {
  const admitted = await readFile(path.join(serverSource, "agentRuns.mjs"), "utf8");
  const variants = name => [`././${name}.mjs`, `../src/${name}.mjs`, `./${name}.mjs?reader`, `./${name}.mjs#reader`, `./%67${name.slice(1)}.mjs`, `./${name}.mjs?reader#fragment`, pathToFileURL(path.join(serverSource, `${name}.mjs`)).href];
  for (const specifier of variants("geoStore")) {
    for (const text of [`import { GeoStore } from '${specifier}';`, `export { GeoStore } from '${specifier}';`, `export * from '${specifier}';`, `await import('${specifier}');`, `require('${specifier}');`]) {
      assert.throws(() => assertGeoImports("newClinicalReader.mjs", text), assert.AssertionError, specifier);
      assert.throws(() => assertGeoImports("agentRuns.mjs", admitted + text), assert.AssertionError, specifier);
    }
  }
  for (const specifier of variants("geoNativeInputs")) {
    assertGeoImports("agentRuns.mjs", `import { mergeInputAttribution } from '${specifier}';`);
    for (const text of [`import { mergeInputAttribution, GeoNativeInputs } from '${specifier}';`, `import { mergeInputAttribution as alias } from '${specifier}';`, `import * as native from '${specifier}';`, `import native from '${specifier}';`, `export { mergeInputAttribution } from '${specifier}';`, `await import('${specifier}');`, `require('${specifier}');`]) {
      assert.throws(() => assertGeoImports("agentRuns.mjs", text), assert.AssertionError, specifier);
    }
  }
});

test("a file alias of a GEO business module retains the guarded module identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "geo-firewall-module-"));
  try {
    const alias = path.join(directory, "reader.mjs");
    await symlink(path.join(serverSource, "geoStore.mjs"), alias);
    const specifier = pathToFileURL(alias).href;
    for (const text of [`import { GeoStore } from '${specifier}';`, `export * from '${specifier}';`, `await import('${specifier}');`, `require('${specifier}');`]) {
      assert.throws(() => assertGeoImports("newClinicalReader.mjs", text), assert.AssertionError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared context helpers remain supplied-data identity and attribution operations", async () => {
  const policy = { kind: "owned", ownerId: "owner", controlProjectId: "project" };
  assert.deepEqual(contextPolicyIdentity(policy), policy);
  assert.equal(sameContextPolicy(policy, { ...policy }), true);
  assert.equal(sameContextPolicy(policy, { ...policy, ownerId: "other" }), false);
  assert.equal(scopedMethodName("method", policy), scopedMethodName("method", { ...policy }));
  assert.notEqual(scopedMethodName("method", policy), scopedMethodName("method", { ...policy, ownerId: "other" }));
  assert.equal(mergeInputAttribution(null, null), null);
  const supplied = { version: 1, namespaceId: "namespace", policyRef: "policy", count: 0, throughSeq: 0, digest: "0".repeat(64), complete: true, inputs: [], privateBody: "discarded" };
  const merged = mergeInputAttribution(null, supplied);
  assert.deepEqual(merged, mergeInputAttribution(null, structuredClone(supplied)));
  assert.equal(merged.namespaceId, supplied.namespaceId);
  assert.equal(Object.hasOwn(merged, "privateBody"), false);
  assert.equal(mergeInputAttribution(merged, { ...supplied, namespaceId: "other" }).complete, false);
  assert.equal(supplied.privateBody, "discarded", "identity projection leaves its supplied data untouched");
  for (const module of ["geoContextItems.mjs", "geoContextProvenance.mjs"]) {
    const source = await readFile(path.join(serverSource, module), "utf8");
    assert.equal(/\bevimed_geo\./.test(source), false, `${module} has no GEO business SQL`);
    assert.equal(geoImportsOf(source).some(([name, symbols]) => name === "geoStore" ? JSON.stringify(symbols) !== JSON.stringify(["canonicalJson"]) : /geo(?:Service|Gateway|Market|Orchestrator|Measure)/.test(name)), false);
  }
  // Only the admitted pure helper, not the producer class in the same file.
  const source = ts.createSourceFile("native.mjs", await readFile(path.join(serverSource, "geoNativeInputs.mjs"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "mergeInputAttribution");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  assert.equal(/\b(?:this|await|query|store|documents|GeoNativeInputs)\b/.test(helper.body.getText(source)), false);
});

test("only the GEO modules query the GEO schema, and only the composition, the runtime wiring and the inbox link import one", async () => {
  const modules = (await readdir(serverSource)).filter((name) => name.endsWith(".mjs"));
  assert.ok(modules.length >= 150, `read only ${modules.length} server modules`);
  const querying = [];
  const importing = [];
  for (const name of modules) {
    const text = await readFile(path.join(serverSource, name), "utf8");
    if (/\bevimed_geo\./.test(text)) querying.push(name);
    if (!name.startsWith("geo") && assertGeoImports(name, text).length) importing.push(name);
  }
  assert.ok(querying.length >= 5, "the walk found the GEO modules");
  assert.deepEqual(querying.filter((name) => !name.startsWith("geo")), [], "no module outside GEO reads its tables");
  // server.mjs composes the module; runtimeManager and runtimeGatewayEntry hand
  // a GEO project's runtime its gateway address; imService links a GEO notice;
  // deploymentComposition restates which GEO tools a launch withholds (the
  // availability label) from the same gateway address and audience. None of
  // them is on the path of an answer's retrieval or ranking.
  assert.deepEqual(importing.sort(), [...Object.keys(CONTEXT_IMPORTS), ...Object.keys(WIRING_IMPORTS), "server.mjs"].sort());
  // The evolution scorer imports a pure numeric-token checker only. Its injected
  // judge sees evaluator-owned public tasks, never a GEO client/schema gateway.
  const evaluator=await readFile(path.join(serverSource,"moduleEvolutionEvaluators.mjs"),"utf8");
  const geoImports=[...evaluator.matchAll(/import\s+([^;]+?)\s+from\s+['"]\.\/(geo[A-Za-z]*)\.mjs['"]/g)];
  assert.deepEqual(geoImports.map(match=>[match[1].replace(/\s+/g,""),match[2]]),[["{quantityTokens}","geoJudge"]]);
  assert.equal(/evimed_geo|geo(?:Service|Store|Gateway|Market|Orchestrator|Measure)|social_posts_search|\/internal\/geo/.test(evaluator),false);
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
