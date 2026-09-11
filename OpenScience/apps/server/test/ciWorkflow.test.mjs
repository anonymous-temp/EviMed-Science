import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { productIntegrationTests } from "../../../scripts/ops/test-product-state.mjs";

const root = new URL("../../../../.github/workflows/", import.meta.url);
const openScience = new URL("../../../", import.meta.url);
async function workflow(name) { return parse(await readFile(new URL(name, root), "utf8")); }

/** Every shell script the job runs, in order, as one text. */
function shellScripts(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}

/** Variable names the job assigns, whether into `$GITHUB_ENV` or into `.env.ci`. */
function assignedVariables(script) {
  return new Set([...script.matchAll(/^\s*echo "([A-Z0-9_]+)=/gm)].map((match) => match[1]));
}

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
  assert.match(product.run, /scripts\/ops\/test-product-state\.mjs/);
  const inventory = productIntegrationTests();
  assert.ok(inventory.some((file) => file.endsWith("capsuleTransferService.integration.test.mjs")));
  assert.ok(inventory.some((file) => file.endsWith("productStore.integration.test.mjs")));
  assert.ok(inventory.some((file) => file.endsWith("capsuleProductApp.integration.test.mjs")));
  assert.ok(inventory.every((file) => !file.endsWith("postgresStore.integration.test.mjs")));
});

test("the hosted CI job names the recall index's configuration, its key and the DashScope key", async () => {
  const job = (await workflow("web.yml")).jobs["docker-hosted"];
  const release = job.steps.find((step) => step.name === "Define immutable CI release");
  const environment = job.steps.find((step) => step.name === "Write CI Compose environment");
  assert.ok(release && environment);
  // These three paths are bind-mount sources Compose declares as `${VAR:?...}`,
  // so a missing name is not a missing file: it aborts interpolation, and every
  // `docker compose` call in the job fails before it reads a service.
  for (const name of [
    "OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE",
    "OPEN_SCIENCE_OPENVIKING_CONF_HOST_FILE",
    "OPEN_SCIENCE_OPENVIKING_API_KEY_HOST_FILE",
  ]) {
    const exported = new RegExp(`echo "${name}=\\S+" >> "\\$GITHUB_ENV"`).exec(release.run);
    assert.ok(exported, `${name} is not exported by "Define immutable CI release"`);
    assert.ok(environment.run.includes(`echo "${name}=\${${name}}"`), `${name} is not written into .env.ci`);
  }
  // The DashScope key is the one file nothing generates: the operator supplies
  // it in production and CI fakes it, so the exported path and the written file
  // have to be the same name.
  const keyPath = /OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE=\S+\/(\S+)" >> "\$GITHUB_ENV"/.exec(release.run);
  assert.ok(keyPath);
  assert.ok(environment.run.includes(`> deploy/web/secrets/${keyPath[1]}\n`));
});

// Report-only: the hosted job cannot run on a development machine, so this
// check names the drift instead of blocking on it. Making it fail needs the
// deploy owner to close the one gap it currently reports —
// `OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE`, required by the always-composed web
// service since 2026-08-27 and never given a CI value.
test("Compose variables without a default are reported against the CI environment file", async (t) => {
  const job = (await workflow("web.yml")).jobs["docker-hosted"];
  const script = shellScripts(job);
  const composeFiles = new Set([...script.matchAll(/-f (deploy\/web\/docker-compose[\w.-]*\.yml)/g)].map((match) => match[1]));
  assert.ok(composeFiles.size >= 2, "no Compose files found in the hosted job");
  const required = new Set();
  for (const file of composeFiles) {
    const text = await readFile(new URL(file, openScience), "utf8");
    for (const match of text.matchAll(/\$\{([A-Z0-9_]+):\?/g)) required.add(match[1]);
  }
  const supplied = assignedVariables(script);
  assert.ok(required.size > 0 && supplied.size > 0, "the scan read no variables");
  const missing = [...required].filter((name) => !supplied.has(name)).sort();
  if (missing.length > 0) t.diagnostic(`Compose variables the CI environment does not set: ${missing.join(", ")}`);
});
