#!/usr/bin/env node
/**
 * Record the Chinese dictionaries of the pinned kernel's browser packages.
 *
 * The product rephrases some of the kernel's own strings through a private-use
 * language (`packages/harness-port/src/runtimeUiLocale.mjs`), keyed by the
 * kernel's namespaces and keys. Those keys live only in the kernel's client
 * bundles, which this repository does not install (the runtime image does), so
 * nothing noticed when the 0.1.7 upgrade drew its working indicator from a new
 * key, `message.turnProcess.deepDivingFor` — 「深度求索中，用时 N 秒」 went back on
 * every live conversation while the override of the old key, `chat.deepDiving`,
 * still passed its tests (live walk 2026-10-10). This file is what the kernel
 * says, recorded from the pinned packages, so a test can hold the override to it.
 *
 *   mkdir /tmp/dsh-client-locale && cd /tmp/dsh-client-locale
 *   for p in chat conversation subagent workspace commands trajectory input-trigger; do
 *     npm pack "@deepseek-ai/dsh-client-ui-$p@<pin>" && mkdir $p && tar -xzf deepseek-ai-dsh-client-ui-$p-<pin>.tgz -C $p
 *   done
 *   node packages/contracts/dsh/record-client-locale.mjs /tmp/dsh-client-locale
 *
 * Each package's bundle declares `const zh = { … }` and registers it with
 * `ctx.locale.register(<namespace>, { zh, en })`; the namespace is a string
 * literal or a constant declared in the same bundle.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
if (!root) {
  console.error("usage: record-client-locale.mjs <directory holding <package>/package/lib/client.js>");
  process.exit(2);
}

/** The object literal that starts at `start` (its `{`), string-aware. @param {string} text @param {number} start */
function objectAt(text, start) {
  let depth = 0;
  let quote = "";
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return text.slice(start, at + 1);
  }
  throw new Error("unterminated object literal");
}

/**
 * The flat `"key": value` pairs of a dictionary literal. A value is a string literal, or a constant declared
 * as one in the same bundle (`"hint.plan": PLAN_NEXT_ACTION_ZH`); anything else is recorded as null.
 * @param {string} literal @param {string} text
 */
function pairsOf(literal, text) {
  /** @type {Record<string, string | null>} */
  const pairs = {};
  const pair = /"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)/g;
  for (const match of literal.matchAll(pair)) {
    const key = JSON.parse(`"${match[1]}"`);
    if (match[2].startsWith('"')) { pairs[key] = JSON.parse(match[2]); continue; }
    const declared = new RegExp(`const ${match[2].replace(/\$/g, "\\$")} = ("(?:[^"\\\\]|\\\\.)*")`).exec(text);
    pairs[key] = declared ? JSON.parse(declared[1]) : null;
  }
  return pairs;
}

/** @param {string} text */
function namespaceOf(text, after) {
  const register = /locale\.register\(\s*([A-Za-z_$][\w$]*|"[^"]+")\s*,\s*\{\s*zh\b/g;
  register.lastIndex = after;
  const match = register.exec(text);
  if (!match) return null;
  if (match[1].startsWith('"')) return JSON.parse(match[1]);
  const declared = new RegExp(`const ${match[1].replace(/\$/g, "\\$")} = ("[^"]+")`).exec(text);
  return declared ? JSON.parse(declared[1]) : null;
}

/** @type {Record<string, Record<string, string>>} */
const namespaces = {};
/** @type {string[]} */
const recordedFrom = [];
let pin = null;
for (const name of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  const packageDir = path.join(root, name, "package");
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const text = await readFile(path.join(packageDir, "lib", "client.js"), "utf8");
  const start = text.indexOf("const zh = {");
  if (start < 0) continue;
  const literal = objectAt(text, start + "const zh = ".length);
  const dictionary = pairsOf(literal, text);
  const namespace = namespaceOf(text, start);
  if (!namespace) throw new Error(`${manifest.name}: no locale.register for its zh dictionary`);
  if (pin && pin !== manifest.version) throw new Error(`mixed versions: ${pin} and ${manifest.name}@${manifest.version}`);
  pin = manifest.version;
  namespaces[namespace] = Object.fromEntries(Object.entries(dictionary).sort(([a], [b]) => a.localeCompare(b)));
  recordedFrom.push(`${manifest.name}@${manifest.version}`);
}
const out = path.join(here, "client-locale.json");
await writeFile(out, `${JSON.stringify({
  $comment: "The pinned kernel client's Chinese dictionaries for the namespaces the product rephrases. Generated by record-client-locale.mjs; re-record on every DSH pin change.",
  pin,
  recordedFrom,
  namespaces: Object.fromEntries(Object.entries(namespaces).sort(([a], [b]) => a.localeCompare(b))),
}, null, 1)}\n`);
console.log(`recorded ${Object.keys(namespaces).length} namespaces from ${recordedFrom.length} packages at ${pin} → ${path.relative(process.cwd(), out)}`);
