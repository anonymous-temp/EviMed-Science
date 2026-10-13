// Renders ../memory-templates/*.yaml from the sources beside this file: the one never-kept block is written into every
// type, so the policy has a single source and each type's rules read complete on their own (the extractor shows a type's
// description under its own "Memory type rules", and its fixed instruction says nothing about what not to keep).
// Run after editing anything here: `node deploy/web/openviking/memory-templates-src/build.mjs`.
// `openVikingDeploy.test.mjs` fails when the rendered directory and these sources disagree.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(src, "..", "memory-templates");

/** The rendered text of every type, by file name. */
export function renderMemoryTemplates() {
  const block = fs.readFileSync(path.join(src, "_never-keep.txt"), "utf8").trimEnd().split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
  /** @type {Record<string, string>} */
  const rendered = {};
  for (const name of fs.readdirSync(src).filter((file) => file.endsWith(".yaml")).sort()) {
    const text = fs.readFileSync(path.join(src, name), "utf8");
    if (!text.includes("__NEVER_KEEP__")) throw new Error(`${name} does not carry the never-kept block`);
    rendered[name] = text.replace("__NEVER_KEEP__", block);
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
