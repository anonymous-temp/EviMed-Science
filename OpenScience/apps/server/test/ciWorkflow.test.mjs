import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

/** Execute the actual pull step with a Docker spy, never a daemon or registry. */
async function runManifestPullStep(t, pins, environment = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evimed-ci-manifest-pulls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, "node"));
  await writeFile(path.join(bin, "docker"), "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.DOCKER_CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n", { mode: 0o755 });
  await writeFile(path.join(bin, "df"), "#!/bin/sh\nprintf 'Avail\\n1099511627776\\n'\n", { mode: 0o755 });
  await writeFile(path.join(bin, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(directory, "deps-version.json"), JSON.stringify(pins));
  const step = (await workflow("web.yml")).jobs["docker-hosted"].steps
    .find((entry) => entry.name === "Pull the pinned manifest dependencies");
  assert.ok(step?.run);
  const script = path.join(directory, "pull.sh");
  const log = path.join(directory, "docker-calls.jsonl");
  await writeFile(script, step.run);
  let status = 0;
  let stderr = "";
  try {
    execFileSync("/bin/bash", [script], {
      cwd: directory, timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: directory, DOCKER_CALL_LOG: log,
        OPEN_SCIENCE_CADDY_VERSION: "2.10.2", ...environment },
    });
  } catch (error) {
    status = error.status ?? -1;
    stderr = String(error.stderr ?? "");
  }
  const recorded = await readFile(log, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { status, stderr, calls: recorded.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

test("manifest dependencies are all pulled from current pins before manifest generation", async (t) => {
  const pins = JSON.parse(await readFile(new URL("deps-version.json", openScience), "utf8"));
  const result = await runManifestPullStep(t, pins);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["pull", "caddy:2.10.2"],
    ["pull", `${pins.openlist.image}:v${pins.openlist.version}@${pins.openlist.imageDigest}`],
    ["pull", `${pins.openviking.image}:${pins.openviking.imageTag}@${pins.openviking.imageDigest}`],
  ]);
});

for (const [name, damage] of [
  ["missing OpenList", (pins) => { delete pins.openlist; }],
  ["missing OpenViking", (pins) => { delete pins.openviking; }],
  ["missing OpenList version", (pins) => { delete pins.openlist.version; }],
  ["missing OpenViking imageTag", (pins) => { delete pins.openviking.imageTag; }],
  ["malformed repository", (pins) => { pins.openlist.image = "--unexpected-option"; }],
  ["malformed repository path", (pins) => { pins.openviking.image = "ghcr.io//openviking"; }],
  ["malformed tag", (pins) => { pins.openviking.imageTag = "v0.4.19 extra"; }],
  ["malformed digest", (pins) => { pins.openviking.imageDigest = "sha256:incomplete"; }],
]) {
  test(`invalid manifest pins stop before any Docker call: ${name}`, async (t) => {
    const pins = JSON.parse(await readFile(new URL("deps-version.json", openScience), "utf8"));
    damage(pins);
    const result = await runManifestPullStep(t, pins);
    assert.notEqual(result.status, 0, "the dependency producer failure must reach the CI step");
    assert.deepEqual(result.calls, [], "even Caddy must wait until every dependency pin has passed validation");
  });
}

for (const version of ["", "2.10.2 extra"]) {
  test(`invalid Caddy version stops before any Docker call: ${JSON.stringify(version)}`, async (t) => {
    const pins = JSON.parse(await readFile(new URL("deps-version.json", openScience), "utf8"));
    const result = await runManifestPullStep(t, pins, { OPEN_SCIENCE_CADDY_VERSION: version });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  });
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
