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

test("every file the RSI dependency closure reads is in the web image's final stage", async () => {
  // 2026-10-27: the closure reads pnpm-lock.yaml and packages/domain/package.json from the app root; the image carried neither, so every
  // closure was unqualified and no campaign could be imported on the hosted deployment.
  const { RSI_DEPENDENCY_PROFILES, computeRsiDependencyClosure } = await import("../src/rsiDependencyClosure.mjs");
  const sources = await finalStageCopies();
  // `pnpm deploy` copies apps/server as `src` and its manifest (package.json "files"); nothing else of it is in the image.
  const inImage = (/** @type {string} */ wanted) => wanted === "apps/server/package.json" || wanted.startsWith("apps/server/src/") || sources.some((source) => covers(wanted, source));
  const wanted = new Set(/** @type {string[]} */ ([]));
  for (const [surface, profile] of Object.entries(RSI_DEPENDENCY_PROFILES)) {
    for (const file of [...profile.roots, ...(profile.resources ?? [])]) wanted.add(file);
    for (const declaration of Object.values(profile.runtimeFileDependencies ?? {})) for (const resource of declaration.resources) wanted.add(resource);
    // And what the walk actually opens: workspace manifests, the entry of each package it imports.
    const closure = await computeRsiDependencyClosure({ rootDir: repoRoot, surface, settings: { model: "model", provider: "deepseek" } });
    assert.equal(closure.qualified, true, `${surface}: ${closure.issues.join(",")}`);
    for (const entry of closure.entries) wanted.add(entry.path);
  }
  assert.ok(wanted.has("pnpm-lock.yaml") && wanted.has("packages/domain/package.json"), "the scan found the files the closure reads outside the server");
  const missing = [...wanted].filter((file) => !inImage(file)).sort();
  assert.deepEqual(missing, [], "copy these into the web image's final stage (deploy/web/Dockerfile)");
  assert.equal(inImage("packages/contracts/package.json"), false, "negative control");
});
