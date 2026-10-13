// Renders ../memory-templates/*.yaml from the sources beside this file: the one never-kept block and the one language
// block are written into every type, so each has a single source and each type's rules read complete on their own (the
// extractor shows a type's description under its own "Memory type rules", and its fixed instruction says nothing about
// what not to keep). The language block exists because the examples and section labels below are partly Chinese: left
// alone, the model copied them into an English user's memories (2 of 3 live runs, 2026-10-13).
// Run after editing anything here: `node deploy/web/openviking/memory-templates-src/build.mjs`.
// `openVikingDeploy.test.mjs` fails when the rendered directory and these sources disagree.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(src, "..", "memory-templates");

/** The rendered text of every type, by file name. */
export function renderMemoryTemplates() {
  const indented = (file) => fs.readFileSync(path.join(src, file), "utf8").trimEnd().split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
  const block = indented("_never-keep.txt");
  const language = indented("_language.txt");
  /** @type {Record<string, string>} */
  const rendered = {};
  for (const name of fs.readdirSync(src).filter((file) => file.endsWith(".yaml")).sort()) {
    const text = fs.readFileSync(path.join(src, name), "utf8");
    if (!text.includes("__NEVER_KEEP__")) throw new Error(`${name} does not carry the never-kept block`);
    if (!text.includes("__LANGUAGE__")) throw new Error(`${name} does not carry the language block`);
    rendered[name] = text.replace("__NEVER_KEEP__", block).replace("__LANGUAGE__", language);
  }
  return rendered;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) if (name.endsWith(".yaml")) fs.rmSync(path.join(out, name));
  for (const [name, text] of Object.entries(renderMemoryTemplates())) {
    fs.writeFileSync(path.join(out, name), text);
    console.log("rendered", name);
  }
}
