import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resultReplayDeployment } from "../../../scripts/ops/result-replay-deployment.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const files = ["docker-compose.yml", "docker-compose.saas.yml", "docker-compose.result-replay.yml"]
  .map(file => path.join(repoRoot, "deploy/web", file));

test("replay deployment selection never implicitly enables native VCR or an unconfigured executor", () => {
  assert.equal(resultReplayDeployment({ OPEN_SCIENCE_VCR_ENABLED: "true" }), null);
  const configured = { OPEN_SCIENCE_RESULT_ENGINE_URL: "http://result-replay:8031", OPEN_SCIENCE_RESULT_REPLAY_IMAGE: "evimed-result-replay:revision" };
  assert.equal(resultReplayDeployment(configured).image, configured.OPEN_SCIENCE_RESULT_REPLAY_IMAGE);
  for (const url of ["https://result-replay:8031", "http://result-replay:8031/path", "http://user:test-only-pass@result-replay:8031", "http://127.0.0.1:8031"]) {
    assert.throws(() => resultReplayDeployment({ ...configured, OPEN_SCIENCE_RESULT_ENGINE_URL: url }));
  }
  for (const image of ["", "replay", "replay@sha256:bad", "replay:latest", "replay:latest@sha256:bad", "replay:version with spaces"]) {
    assert.throws(() => resultReplayDeployment({ ...configured, OPEN_SCIENCE_RESULT_REPLAY_IMAGE: image }));
  }
});

const compose = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
test("actual Compose merge keeps aggregate replay on its own internal network and named project volume", {
  skip: compose.status !== 0 ? "Docker Compose unavailable; this is configuration rendering, not serving qualification" : false,
}, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evimed-replay-compose-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contents = await Promise.all(files.map(file => readFile(file, "utf8")));
  const values = {};
  for (const content of contents) for (const match of content.matchAll(/\$\{([A-Z_0-9]+):\?[^}]*\}/g)) {
    values[match[1]] = match[1].endsWith("_HOST_FILE") ? path.join(dir, "fixture-secret") : "fixture";
  }
  Object.assign(values, {
    OPEN_SCIENCE_RELEASE_ID: "replay-config-fixture",
    OPEN_SCIENCE_SOURCE_REVISION: "a".repeat(40),
    OPEN_SCIENCE_BUILD_CREATED: "2026-10-02T12:00:00.000Z",
    OPEN_SCIENCE_DATA_VOLUME: "evimed-test-existing-data",
    OPEN_SCIENCE_DOCKER_SOCKET_GID: "998",
    OPEN_SCIENCE_RESULT_REPLAY_IMAGE: "evimed-result-replay:fixture-revision",
    OPEN_SCIENCE_VCR_ENABLED: "false",
    OPEN_SCIENCE_BACKUP_EXTERNAL_ACK: "true",
    OPEN_SCIENCE_RESTORE_DRILL_ACK: "true",
  });
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
  const environment = { PATH: process.env.PATH, HOME: dir };
  let command = "docker", prefix = ["compose"];
  // A user-installed CLI plugin may live under the real HOME. Keep private
  // Docker configuration out of this fixture and use the same installed
  // standalone Compose version when the isolated HOME cannot discover it.
  const isolatedCompose = spawnSync(command, [...prefix, "version", "--short"], { encoding: "utf8", env: environment });
  if (isolatedCompose.status !== 0) {
    const standalone = spawnSync("docker-compose", ["version", "--short"], { encoding: "utf8", env: environment });
    assert.equal(standalone.status, 0, standalone.error?.message ?? standalone.stderr);
    assert.equal(standalone.stdout.trim().replace(/^v/, ""), compose.stdout.trim().replace(/^v/, ""));
    command = "docker-compose"; prefix = [];
  }
  const render = selected => {
    const args = [...prefix, "--project-name", "evimed-replay-config-test", "--env-file", envFile];
    for (const file of selected) args.push("-f", file);
    args.push("config", "--format", "json");
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: environment });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const base = render(files.slice(0, 2));
  assert.equal(base.services["result-replay"], undefined);
  const config = render(files);
  const engine = config.services["result-replay"];
  const web = config.services["open-science-web"];
  assert.equal(engine.image, values.OPEN_SCIENCE_RESULT_REPLAY_IMAGE);
  assert.deepEqual(Object.keys(engine.networks), ["result-replay-internal"]);
  assert.equal(config.networks["result-replay-internal"].internal, true);
  assert.equal(engine.ports, undefined);
  assert.equal(engine.network_mode, undefined);
  assert.equal(engine.read_only, true);
  assert.deepEqual(engine.cap_drop, ["ALL"]);
  assert.equal(engine.build.args.SOURCE_REVISION, values.OPEN_SCIENCE_SOURCE_REVISION);
  assert.equal(config.volumes["open-science-data"].name, values.OPEN_SCIENCE_DATA_VOLUME);
  assert.deepEqual(engine.volumes.map(({ type, source, target, read_only }) => ({ type, source, target, read_only })), [
    { type: "volume", source: "open-science-data", target: "/data", read_only: undefined },
    { type: "bind", source: values.OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_HOST_FILE, target: "/run/secrets/workload-signing.secret", read_only: true },
  ]);
  assert.deepEqual(Object.keys(engine.environment).sort(), ["EVIMED_DATA_ROOT", "EVIMED_WORKLOAD_SIGNING_SECRET_FILE"]);
  assert.equal(web.environment.OPEN_SCIENCE_RESULT_ENGINE_URL, "http://result-replay:8031");
  assert.deepEqual(Object.keys(web.networks).sort(), [...Object.keys(base.services["open-science-web"].networks), "result-replay-internal"].sort());
  assert.deepEqual(config.services["vcr-engine"], base.services["vcr-engine"]);
});
