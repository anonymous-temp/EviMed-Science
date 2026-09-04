// The runtime pass-through was retired when the browser stopped speaking a
// kernel's vocabulary. server.mjs answers it with a message saying so.
//
// Nothing enforced that the repo stopped calling it. evals/title-to-paper's
// batch harness kept POSTing to `${runtimeUrl}/session` and reading
// `${runtimeUrl}/session/:id/message`, so the batch that four release gates
// depend on could not run against the DSH kernel at all — and nobody found out
// until it was time to run it.
//
// A retired route with a caller is worse than a deleted one: the caller looks
// maintained.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every .mjs/.js/.ts under these roots, which is where a caller could live. */
async function sourceFiles(root, found = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "runs" || entry.name === "results") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, found);
    else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test("nothing calls the retired runtime pass-through", async () => {
  const roots = ["apps/server/src", "apps/web/src", "evals", "scripts", "packages"]
    .map((rel) => path.join(repoRoot, rel));
  for (const root of roots) await stat(root); // a missing root would silently shrink the sweep

  const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat();
  // Without this, a broken walk reports a clean repo.
  assert.ok(files.length > 200, `only ${files.length} source files scanned; the walk, not the repo, is wrong`);

  const offenders = [];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    // The shape a caller has: a runtime URL with the kernel's own session path
    // appended. server.mjs itself names the route in its retirement message,
    // which is not a call.
    // `/session` singular, which is the kernel's route. `${runtimeUrl}/sessions`
    // is the control plane's own and must not match: a guard that cries wolf
    // teaches people to add exceptions to it, and this one did — it flagged
    // deployment-smoke.mjs, which had already been ported correctly.
    if (/\$\{\s*(?:context\.)?runtimeUrl\s*\}\/session(?![s\w])/.test(body)) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  // Empty, and it has to stay empty. A caller of this route cannot run against
  // the DSH kernel at all, and the ones that had it were release-gate tooling:
  // they worked only because production still ran OpenCode, and would have
  // failed in the same hour the default is flipped.
  assert.deepEqual(
    offenders.sort(),
    [],
    "the set of callers of the retired pass-through changed; a new one cannot run against the "
    + "DSH kernel at all. Sessions come from POST /api/runtime/sessions and transcripts from "
    + "GET /api/runtime/sessions/:id/transcript",
  );
});

// A gate that waits less than the thing it waits for reports a timing accident
// as a content verdict.
//
// The hosted e2e allowed the memory extraction 90 seconds; the server allows
// that extraction 120 (`memoryExtractionTimeoutMs`). A slow-but-successful
// extraction therefore always lost, and the gate said the conversation had
// produced no structured memory. The batch harness had the same inversion at a
// different scale — a 30-minute ceiling over runs that take forty.
test("the e2e waits longer than the work it is waiting for", async () => {
  const e2e = await readFile(path.join(repoRoot, "apps/server/../../scripts/ops/hosted-production-e2e.mjs"), "utf8")
    .catch(() => readFile(path.join(repoRoot, "scripts/ops/hosted-production-e2e.mjs"), "utf8"));
  const config = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");

  const waited = Number(/OPEN_SCIENCE_E2E_MEMORY_TIMEOUT_MS \?\? ([0-9_]+)/.exec(e2e)?.[1].replace(/_/g, ""));
  const budget = Number(/memoryExtractionTimeoutMs \?\? [\s\S]{0,120}?([0-9_]+),/.exec(config)?.[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(waited), "could not read the e2e memory wait");
  assert.ok(Number.isFinite(budget), "could not read the server extraction budget");
  assert.ok(
    waited > budget,
    `the e2e waits ${waited}ms for an extraction the server gives ${budget}ms; a slow success would be reported as no memory at all`,
  );
});
