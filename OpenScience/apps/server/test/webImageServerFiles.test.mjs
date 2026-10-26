import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The paths the server's sources resolve relative to themselves outside apps/server (`new URL("../../../<path>", import.meta.url)`). */
async function serverRepoReads() {
  const dir = path.join(repoRoot, "apps/server/src");
  const reads = new Map();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = await readFile(path.join(dir, name), "utf8");
    for (const match of text.matchAll(/new URL\("\.\.\/\.\.\/\.\.\/([^"]+)"/g)) reads.set(match[1], name);
  }
  return reads;
}

/** The sources the web image's final stage copies from the build stage, as repository-relative paths (a directory or a glob). */
async function finalStageCopies() {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  const sources = [];
  for (const line of dockerfile.split("\n")) {
    const copy = /^COPY --from=build (.+)$/.exec(line.trim());
    if (!copy) continue;
    const parts = copy[1].split(/\s+/).filter((part) => !part.startsWith("--"));
    for (const source of parts.slice(0, -1)) if (source.startsWith("/app/")) sources.push(source.slice("/app/".length));
  }
  return sources;
}

/** @param {string} wanted @param {string} source */
function covers(wanted, source) {
  // A directory the server lists is covered by anything copied into it.
  if (wanted.endsWith("/")) return source.startsWith(wanted) || wanted.startsWith(`${source.replace(/\/$/, "")}/`);
  if (source.includes("*")) {
    const pattern = new RegExp(`^${source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return pattern.test(wanted);
  }
  return wanted === source || wanted.startsWith(`${source.replace(/\/$/, "")}/`);
}

test("every repository file the server resolves outside apps/server is in the web image's final stage", async () => {
  // 2026-10-26: openVikingCompileExecution.mjs reads packages/contracts/openviking/compile-scope-proof.json when it loads; the
  // image did not carry it, and the runtime controller (same image) exited at start on the release switch.
  const reads = await serverRepoReads();
  assert.ok(reads.size >= 5, "the scan found the server's repository reads");
  const sources = await finalStageCopies();
  const missing = [...reads].filter(([wanted]) => !sources.some((source) => covers(wanted, source))).map(([wanted, file]) => `${wanted} (${file})`);
  assert.deepEqual(missing, [], "copy these into the web image's final stage (deploy/web/Dockerfile)");
  assert.equal(covers("packages/contracts/openviking/compile-scope-proof.json", "packages/contracts/healthflux/candidates.json"), false, "negative control");
});
