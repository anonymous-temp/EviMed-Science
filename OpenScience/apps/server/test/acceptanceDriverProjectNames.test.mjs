import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectDisplayName } from "../src/store.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Two release drivers named their throwaway project with more characters than
 * a project name may have, so each stopped on its first request with 400 from
 * 2026-09-18 until 2026-10-03, and no test ran either against a real server.
 */
test("every driver that creates a project gives it a name the store accepts", async () => {
  const capabilities = (await readdir(path.join(repoRoot, "capabilities"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const longestCapability = capabilities.reduce((longest, name) => (name.length > longest.length ? name : longest), "");
  const directory = path.join(repoRoot, "scripts/ops");
  const checked = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".mjs"))) {
    const source = await readFile(path.join(directory, file), "utf8");
    for (const match of source.matchAll(/JSON\.stringify\(\{ id: projectId, name: `([^`]+)` \}\)/g)) {
      const name = match[1].replace(/\$\{(\w+)\}/g, (_, variable) => {
        if (variable === "capabilityId") return longestCapability;
        const random = source.match(new RegExp(`const ${variable} = randomBytes\\((\\d+)\\)\\.toString\\("hex"\\)`));
        if (random) return "f".repeat(Number(random[1]) * 2);
        // A generated id: the smoke's `smoke-<base36 time>`, never longer here.
        if (variable === "projectId") return "smoke-" + Date.now().toString(36);
        throw new Error(`${file}: do not know how long \${${variable}} can be; teach this test`);
      });
      assert.doesNotThrow(() => projectDisplayName(name), `${file} names its project "${name}" (${[...name].length} characters)`);
      checked.push(file);
    }
  }
  for (const expected of ["deployment-smoke.mjs", "session-stream-acceptance.mjs", "hosted-production-e2e.mjs", "capability-acceptance.mjs"]) {
    assert.ok(checked.includes(expected), `${expected} was not checked; the scan no longer matches how drivers create projects`);
  }
});
