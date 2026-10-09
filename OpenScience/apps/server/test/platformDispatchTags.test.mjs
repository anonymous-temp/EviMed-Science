// Every prompt the control plane sends into a conversation says whose words
// it carries (2026-09-26 audit, M-2).
//
// The extractor refuses a user-slot message that carries a registered platform
// tag (`memorySourceRejection`), and reads everything else as the researcher's
// own words. On 2026-09-25 a GEO step's brief went into a runtime the
// researcher happened to have open, carried no budget marker because the run
// was not bounded, and was stored as 「你说的」: the only thing that had ever
// marked it as the platform's was a marker that exists for the budget.
//
// So each dispatch site is held here to one of three things, decided from its
// source: the text carries a registered platform tag on every path; it
// carries a user-wrapper tag (the researcher's words, wrapped by us); or it is
// named below with the exact expression and the reason it is the
// researcher's own words. A new dispatch site that is none of these fails
// this file — which is the point: "one problem, audit the class" as a test.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORM_CONTEXT_TAGS, carriesPlatformContext } from "@evimed/domain";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(serverRoot, "src");

/**
 * Sites whose text is the researcher's own words. Matched on the exact
 * expression (whitespace collapsed), so an edit to one is re-read here.
 */
const USER_WORDS = [
  {
    file: "server.mjs",
    text: 'typeof repairText === "string" && repairText.trim() ? `${repairText}\\n\\n<evimed-repair>${dispatchedRun.id}</evimed-repair>` : text',
    count: 2,
    why: "the chat route and a question from a messaging channel: what the researcher typed, or the delivery gate's repair round under its own tag",
  },
  {
    file: "server.mjs",
    text: 'typeof repairText === "string" && repairText.trim() ? `${repairText}\\n\\n<evimed-repair>${dispatchedRun.id}</evimed-repair>` : visibleText',
    count: 1,
    why: "a scheduled task's execution (2026-10-08): the first message is the task's own instruction or the follow-up note the researcher wrote, "
      + "not the platform's brief — the brief and the bounded runtime's episode tag travel in the run context. The memory extractor still refuses "
      + "the dispatch by the request that carried it (`conversationMemorySources`, `dispatchedRequestIds`), so a daily task's instruction is not "
      + "observed again every day",
  },
];

/**
 * Sites another branch tags (2026-09-27): one entry each, and each must still
 * match the untagged expression. When the branch lands, the site is tagged on
 * its own and the entry matches nothing — this file then says to delete it.
 */
/** @type {Array<{ file: string, text: string, why: string }>} */
const AWAITING_TAG = [];

const TAG_ROLES = new Map(PLATFORM_CONTEXT_TAGS.map((entry) => [entry.tag, entry.role]));

/** @param {string} value */
const oneLine = (value) => value.replace(/\s+/g, " ").trim();

/**
 * Read a JavaScript span from `start`, returning the index just past it and
 * the literals it held. A span ends at `stop` (a closing bracket or a top-level
 * separator) when it is met at depth zero. Strings, templates (with nested
 * interpolations) and comments are skipped as units, so a bracket or comma
 * inside one never ends a span.
 * @param {string} source @param {number} start @param {(char: string, depth: number) => boolean} stop
 * @returns {{ end: number, statics: string[], ternary: boolean }}
 */
function scan(source, start, stop) {
  let depth = 0;
  /** @type {string[]} */
  const statics = [];
  let ternary = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") { index = source.indexOf("\n", index); if (index < 0) return { end: source.length, statics, ternary }; continue; }
    if (char === "/" && next === "*") { index = source.indexOf("*/", index + 2) + 1; continue; }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1;
      if (depth === 0) statics.push(source.slice(index + 1, end));
      index = end;
      continue;
    }
    if (char === "`") {
      const template = readTemplate(source, index);
      if (depth === 0) statics.push(template.statics);
      index = template.end;
      continue;
    }
    if (depth === 0 && stop(char, depth)) return { end: index, statics, ternary };
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) return { end: index, statics, ternary };
      depth -= 1;
    } else if (char === "?" && depth === 0 && next !== "." && next !== "?" && source[index - 1] !== "?") ternary = true;
  }
  return { end: source.length, statics, ternary };
}

/** A template literal from its opening backtick: where it ends, and its static text with interpolations left out.
 *  @param {string} source @param {number} start @returns {{ end: number, statics: string }} */
function readTemplate(source, start) {
  let statics = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") { statics += source.slice(index, index + 2); index += 1; continue; }
    if (char === "`") return { end: index, statics };
    if (char === "$" && source[index + 1] === "{") {
      index = scan(source, index + 2, () => false).end;
      continue;
    }
    statics += char;
  }
  return { end: source.length, statics };
}

/**
 * Every `.dispatchPrompt(` call in one file, with the `text` it sends,
 * resolved through one local `const` when the property names a variable.
 * @param {string} file @param {string} source
 */
function dispatchSites(file, source) {
  const sites = [];
  for (const match of source.matchAll(/\.dispatchPrompt\(/g)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*(\/\/|\*)/.test(source.slice(lineStart, match.index))) continue;
    const open = /** @type {number} */ (match.index) + match[0].length;
    // The third argument is the request object.
    let cursor = open;
    for (let argument = 0; argument < 2; argument += 1) cursor = scan(source, cursor, (char) => char === ",").end + 1;
    const brace = source.indexOf("{", cursor);
    const properties = [];
    for (let at = brace + 1; at < source.length;) {
      const part = scan(source, at, (char) => char === ",");
      properties.push(source.slice(at, part.end));
      if (source[part.end] !== ",") break;
      at = part.end + 1;
    }
    const property = properties.map((text) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()).find((text) => /^text\b/.test(text));
    assert.ok(property, `${file}: a dispatchPrompt call sends no text property`);
    let expression = property === "text" ? "text" : property.replace(/^text\s*:\s*/, "");
    if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
      const definitions = [...source.slice(0, match.index).matchAll(new RegExp(`(?:const|let)\\s+${expression}\\s*=\\s*`, "g"))];
      const last = definitions.at(-1);
      if (last) {
        const from = /** @type {number} */ (last.index) + last[0].length;
        expression = source.slice(from, scan(source, from, (char) => char === ";").end);
      }
    }
    const shape = scan(expression, 0, () => false);
    const tags = shape.statics.flatMap((text) => [...text.matchAll(/<(evimed-[a-z][a-z-]*[a-z])[\s>]/g)].map((found) => found[1]));
    sites.push({ file, line: source.slice(0, match.index).split("\n").length, text: oneLine(expression), ternary: shape.ternary, tags });
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

const files = await sourceFiles(sourceRoot);
const sources = await Promise.all(files.map(async (full) => ({ file: path.relative(sourceRoot, full), source: await readFile(full, "utf8") })));
const sites = sources.flatMap(({ file, source }) => dispatchSites(file, source));

/** @param {{ ternary: boolean, tags: string[] }} site @param {string} role */
const carries = (site, role) => !site.ternary && site.tags.some((tag) => TAG_ROLES.get(tag) === role);

test("the walk reads every dispatcher: the control plane's sources, and each file known to send a prompt", () => {
  assert.ok(files.length >= 150, `walked only ${files.length} files; the walk is wrong, not the tree`);
  assert.ok(sites.length >= 9, `found only ${sites.length} dispatch sites; the parse is wrong`);
  for (const file of ["server.mjs", "learningRuntime.mjs", "sourceUnderstandingRuntime.mjs"]) {
    assert.ok(sites.some((site) => site.file === file), `${file} dispatches prompts and no site was found in it`);
  }
  // A dispatcher that opens a run and sends its prompt some other way would
  // escape the walk: every file that opens a run is one the walk found a
  // prompt in.
  for (const { file, source } of sources) {
    if (/agentRuns\.dispatch\(/.test(source)) assert.ok(sites.some((site) => site.file === file), `${file} opens a run but sends no prompt the walk can see`);
  }
});

test("the parse tells a tag on every path from a tag on one branch, and a platform tag from a user wrapper", () => {
  const [tagged] = dispatchSites("fixture", "runtimeManager.dispatchPrompt(p, s, {\n  // a comment, with a comma\n  text: `${brief}\\n\\n<evimed-autopilot-episode>${id}</evimed-autopilot-episode>`, runId });");
  assert.ok(carries(tagged, "injected"));
  const [branch] = dispatchSites("fixture", "const promptText = marker ? `${brief}\\n\\n${marker}` : brief;\nruntimeManager.dispatchPrompt(p, s, { text: promptText });");
  assert.equal(branch.ternary, true);
  assert.deepEqual(branch.tags, []);
  const [wrapped] = dispatchSites("fixture", "await runtimeManager.dispatchPrompt(p, s, { text: `<evimed-correction>${text}</evimed-correction>`, mode: \"steer\" });");
  assert.ok(carries(wrapped, "user-wrapper") && !carries(wrapped, "injected"));
  const [inner] = dispatchSites("fixture", "runtimeManager.dispatchPrompt(p, s, { text: `${a ? `<evimed-brief>x</evimed-brief>` : \"\"}${b}` });");
  assert.deepEqual(inner.tags, [], "a tag inside an interpolation is on one path only");
});

test("every dispatch site carries a registered platform tag on every path, or is named as the researcher's words", () => {
  const unexplained = [];
  const matched = new Map();
  for (const site of sites) {
    if (carries(site, "injected") || carries(site, "user-wrapper")) continue;
    const entry = [...USER_WORDS, ...AWAITING_TAG].find((item) => item.file === site.file && oneLine(item.text) === site.text);
    if (entry) { matched.set(entry, (matched.get(entry) ?? 0) + 1); continue; }
    unexplained.push(`${site.file}:${site.line} sends ${site.text}`);
  }
  assert.deepEqual(unexplained, [],
    "a platform dispatch must tag its text with a registered PLATFORM_CONTEXT_TAGS entry on every path; a site that sends the researcher's own words is named in USER_WORDS");
  for (const entry of USER_WORDS) assert.equal(matched.get(entry) ?? 0, entry.count, `USER_WORDS (${entry.why}) matched ${matched.get(entry) ?? 0} sites`);
  for (const entry of AWAITING_TAG) {
    assert.equal(matched.get(entry) ?? 0, 1, `AWAITING_TAG (${entry.why}) matches no untagged site any more: its site is tagged now, so delete the entry`);
  }
});

test("each tag a dispatcher writes is one the extractor refuses", () => {
  const written = new Set(sites.flatMap((site) => site.tags.filter((tag) => TAG_ROLES.get(tag) === "injected")));
  // `evimed-autopilot-episode` is no longer one of them: a scheduled execution's first message is the researcher's own words, and the
  // tag rides in the run context (`autopilotEpisodeScope.mjs`, held by memoryVocabulary.test.mjs and the execution tests).
  for (const tag of ["evimed-autopilot-verification", "evimed-source-understanding", "evimed-repair"]) {
    assert.ok(written.has(tag), `no dispatch site writes ${tag}`);
  }
  for (const tag of written) {
    assert.equal(carriesPlatformContext(`「循证 GEO」自动运行 · 第 6 步\n\n<${tag}>dispatch-1</${tag}>`), true, tag);
  }
});
