import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../../../.github/workflows/", import.meta.url);
async function workflow(name) { return parse(await readFile(new URL(name, root), "utf8")); }

test("GitHub discovers the workflows at repository root with monorepo tools and paths", async () => {
  for (const name of ["web.yml", "upstream-matrix.yml"]) {
    const value = await workflow(name);
    assert.equal(value.defaults.run["working-directory"], "OpenScience");
    for (const job of Object.values(value.jobs)) {
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          const version = String(step.with["node-version"]).split(".").map(Number);
          assert.ok(version[0] > 22 || (version[0] === 22 && version[1] >= 22));
          if (step.with.cache) assert.equal(step.with["cache-dependency-path"], "OpenScience/pnpm-lock.yaml");
        }
        if (step.uses?.startsWith("pnpm/action-setup@")) assert.equal(step.with["package_json_file"], "OpenScience/package.json");
      }
    }
  }
});

test("PostgreSQL auth and product tests execute against different disposable databases", async () => {
  const value = await workflow("web.yml");
  const job = value.jobs.web;
  assert.match(job.services.postgres.image, /^postgres:16\./);
  const auth = job.steps.find((step) => step.name === "Test shared authentication state");
  const product = job.steps.find((step) => step.name === "Test durable product state");
  assert.ok(auth && product);
  assert.notEqual(auth.env.OPEN_SCIENCE_TEST_POSTGRES_URL, product.env.OPEN_SCIENCE_TEST_POSTGRES_URL);
  assert.match(auth.run, /postgresStore\.integration/);
  assert.match(product.run, /productStore\.integration/);
  assert.match(product.run, /capsuleProductApp\.integration/);
});
