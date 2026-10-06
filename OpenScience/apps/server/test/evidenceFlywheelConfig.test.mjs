// The flywheel's figures' switch (evidence-flywheel plan §11, 2026-10-06): off by default, carried by .env.example and compose, kept off by the
// api-only shape, and visible on the operator metrics whichever way it is set; the route answers 404 by name, behind the metrics token, while off.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createWebApiApp } from "../src/server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAME = "OPEN_SCIENCE_EVIDENCE_FLYWHEEL_METRICS_ENABLED";

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: repoRoot })); } finally { process.env = saved; }
}

test("the switch is off by default, read from the environment, and an empty value reads as unset", () => {
  assert.equal(configUnder({}).evidenceFlywheelMetricsEnabled, false);
  assert.equal(configUnder({ [NAME]: "true" }).evidenceFlywheelMetricsEnabled, true);
  assert.equal(configUnder({ [NAME]: "" }).evidenceFlywheelMetricsEnabled, false);
});

test("the lever is documented in .env.example at the code's default, handed to the web service value-less by compose, and kept off by the api-only shape", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const apiOnly = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  const lines = [...example.matchAll(new RegExp(`^${NAME}=(.*)$`, "gm"))];
  assert.equal(lines.length, 1);
  assert.equal(lines[0][1], "false");
  assert.match(compose, new RegExp(`^\\s+${NAME}:\\s*$`, "m"));
  assert.match(apiOnly, new RegExp(`${NAME}: \\$\\{${NAME}:-false\\}`));
});

test("the community column's two levers: off and twenty by default, read from the environment, and a count outside 1 to 50 stops the start by its name", async () => {
  const defaults = configUnder({});
  assert.deepEqual([defaults.evidenceCommunityCardsEnabled, defaults.evidenceCommunityMaxCards], [false, 20]);
  const set = configUnder({ OPEN_SCIENCE_EVIDENCE_COMMUNITY_CARDS_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS: "8" });
  assert.deepEqual([set.evidenceCommunityCardsEnabled, set.evidenceCommunityMaxCards], [true, 8]);
  assert.equal(configUnder({ OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS: "" }).evidenceCommunityMaxCards, 20, "an empty value is the default, not 0");
  for (const value of ["0", "51", "1.5", "many"]) assert.throws(() => configUnder({ OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS: value }), /OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS/, value);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const apiOnly = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  for (const [name, value] of [["OPEN_SCIENCE_EVIDENCE_COMMUNITY_CARDS_ENABLED", "false"], ["OPEN_SCIENCE_EVIDENCE_COMMUNITY_MAX_CARDS", "20"]]) {
    assert.deepEqual([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((line) => line[1]), [value], name);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), name);
  }
  assert.match(apiOnly, /OPEN_SCIENCE_EVIDENCE_COMMUNITY_CARDS_ENABLED: \$\{OPEN_SCIENCE_EVIDENCE_COMMUNITY_CARDS_ENABLED:-false\}/);
});

test("the outcome consumer's two levers: off and 25 by default, read from the environment, a batch outside 1 to 200 stops the start by its name, carried by .env.example and compose", async () => {
  const defaults = configUnder({});
  assert.deepEqual([defaults.learningEvidenceOutcomesEnabled, defaults.learningEvidenceOutcomesBatch], [false, 25]);
  const set = configUnder({ OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED: "true", OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_BATCH: "50" });
  assert.deepEqual([set.learningEvidenceOutcomesEnabled, set.learningEvidenceOutcomesBatch], [true, 50]);
  assert.equal(configUnder({ OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_BATCH: "" }).learningEvidenceOutcomesBatch, 25);
  for (const value of ["0", "201", "1.5", "lots"]) assert.throws(() => configUnder({ OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_BATCH: value }), /OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_BATCH/, value);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const apiOnly = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  for (const [name, value] of [["OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED", "false"], ["OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_BATCH", "25"]]) {
    assert.deepEqual([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((line) => line[1]), [value], name);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), name);
  }
  assert.match(apiOnly, /OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED: \$\{OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED:-false\}/);
});

test("off, the route answers 404 by name once the token is checked and the metrics say 0 with no family; without the token it is refused first", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-flywheel-config-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: "test-only-metrics-token" });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer test-only-metrics-token" };
  try {
    const refused = await fetch(`${base}/api/ops/evidence-flywheel`);
    assert.equal(refused.status, 401);
    const off = await fetch(`${base}/api/ops/evidence-flywheel`, { headers });
    assert.equal(off.status, 404);
    assert.equal((await off.json()).code, "evidence_flywheel_not_enabled");
    const scrape = await (await fetch(`${base}/api/ops/metrics`, { headers })).text();
    assert.match(scrape, /^open_science_evidence_flywheel_enabled 0$/m);
    assert.doesNotMatch(scrape, /open_science_evidence_flywheel_guardrail/);
    assert.doesNotMatch(scrape, /open_science_evidence_community_/, "a column that is not composed exports nothing");
    assert.doesNotMatch(scrape, /open_science_learning_evidence_/, "a consumer that is not composed exports nothing");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
