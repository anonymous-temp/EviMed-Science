// A dispatch states the capability it was routed to (2026-10-10 review D5).
//
// The runtime used to learn the route by parsing the routing sentence out of `context.md`, a file that also embeds the
// researcher's recalled memories and knowledge text. It is the dispatch index's `capability` now, and the index is written by
// `dispatchPrompt`: a site that sends the context (`system`) and does not say what the context was routed to leaves the run
// unrouted, and for a background run of an internal capability (method distillation, source understanding) that is a run
// refused its own method. So each dispatch site that sends a context is held here to stating the route, decided from its source
// — "one problem, audit the class" as a test, the way `platformDispatchTags.test.mjs` holds the text each one sends.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Read a JavaScript span from `start` up to the first `stop` character met at depth zero (or the bracket that closes the span).
 * Strings, templates (with nested interpolations) and comments are skipped as units, so a bracket or comma inside one never
 * ends a span.
 * @param {string} source @param {number} start @param {(char: string) => boolean} stop
 * @returns {number} the index of the character that ended the span
 */
function endOfSpan(source, start, stop) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") { index = source.indexOf("\n", index); if (index < 0) return source.length; continue; }
    if (char === "/" && next === "*") { index = source.indexOf("*/", index + 2) + 1; continue; }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1;
      index = end;
      continue;
    }
    if (char === "`") { index = endOfTemplate(source, index); continue; }
    if (depth === 0 && stop(char)) return index;
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return source.length;
}

/** @param {string} source @param {number} start the opening backtick @returns {number} the closing backtick */
function endOfTemplate(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "`") return index;
    if (char === "$" && source[index + 1] === "{") index = endOfSpan(source, index + 2, () => false);
  }
  return source.length;
}

/**
 * Every `.dispatchPrompt(` call in one file, with the property names of its request object.
 * @param {string} file @param {string} source
 * @returns {{ file: string, line: number, keys: string[] }[]}
 */
function dispatchSites(file, source) {
  const sites = [];
  for (const match of source.matchAll(/\.dispatchPrompt\(/g)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*(\/\/|\*)/.test(source.slice(lineStart, match.index))) continue;
    let cursor = /** @type {number} */ (match.index) + match[0].length;
    // The third argument is the request object.
    for (let argument = 0; argument < 2; argument += 1) cursor = endOfSpan(source, cursor, (char) => char === ",") + 1;
    const brace = source.indexOf("{", cursor);
    const keys = [];
    for (let at = brace + 1; at < source.length;) {
      const end = endOfSpan(source, at, (char) => char === ",");
      const property = source.slice(at, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
      const key = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(property);
      if (key) keys.push(property.startsWith("...") ? `...${key[1]}` : key[1]);
      if (source[end] !== ",") break;
      at = end + 1;
    }
    sites.push({ file, line: source.slice(0, match.index).split("\n").length, keys });
  }
  return sites;
}

/** @param {string} directory @returns {Promise<string[]>} */
async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".mjs")) found.push(full);
  }
  return found;
}

const sources = await Promise.all((await sourceFiles(sourceRoot)).map(async (full) => ({ file: path.relative(sourceRoot, full), source: await readFile(full, "utf8") })));
const sites = sources.flatMap(({ file, source }) => dispatchSites(file, source));

test("the walk reads every dispatcher, and tells a request object's properties from the text inside them", () => {
  assert.ok(sites.length >= 10, `found only ${sites.length} dispatch sites; the parse is wrong`);
  for (const file of ["server.mjs", "learningRuntime.mjs", "sourceUnderstandingRuntime.mjs", "evolutionRuns.mjs"]) {
    assert.ok(sites.some((site) => site.file === file && site.keys.includes("system")), `${file} sends a context and no site was found in it`);
  }
  const [site] = dispatchSites("fixture", "x.dispatchPrompt(p, s, {\n  // system: a comment\n  text: `a ${(b, { system: 1 })}, c`, runId });");
  assert.deepEqual(site.keys, ["text", "runId"]);
});

test("every dispatch that sends a context states the capability it was routed to, or that it was routed to none", () => {
  const withContext = sites.filter((site) => site.keys.includes("system"));
  const missing = withContext.filter((site) => !site.keys.includes("routedCapability")).map((site) => `${site.file}:${site.line}`);
  assert.deepEqual(missing, [], "a dispatch that writes a context writes the index beside it, and the index is where the runtime reads the route: "
    + "pass `routedCapability: prepared.routedCapability` (null when the turn was routed nowhere)");
});

test("a dispatch that sends no context leaves the index's route as the run's own context had it", () => {
  // A steer (`mode: "steer"`) adds to a running run and writes no context. Its index keeps what the context on disk was routed to
  // (`writeRunBriefIndex`), so it must not state a route of its own.
  const steers = sites.filter((site) => site.keys.includes("mode"));
  assert.ok(steers.length >= 2, "the chat route and the channel route steer a run");
  for (const site of steers) {
    assert.ok(!site.keys.includes("system") && !site.keys.includes("routedCapability"), `${site.file}:${site.line} steers and states a context`);
  }
});
