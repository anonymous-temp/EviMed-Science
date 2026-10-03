#!/usr/bin/env node
/** Execute synthetic aggregate fixtures through the built image's owned HTTP protocol. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ResultReplayClient, replayDigest } from "../../apps/server/src/resultReplayClient.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const TERMINAL = ["succeeded", "failed", "canceled", "timed_out"];
const fixtures = [
  { method: "meta.dl", input: { studies: [0, 1, 3].map((yi, i) => ({ id: String(i), label: String(i), yi, vi: .1 })), effectMeasure: "MD", outcome: "synthetic" },
    parameters: {}, expected: { "values.pooled_effect": 4 / 3 } },
  { method: "faers.signals", input: { tables: [{ id: "T1", a: 10, b: 90, c: 20, d: 1880 }] },
    parameters: {}, expected: { "values[0].ror.value": 10.444444444444445, "values[0].prr.value": 9.5 } },
  { method: "bibliometric.network", input: { edges: [{ source: "A", target: "B", weight: 2, source_freq: 8, target_freq: 7 }] },
    parameters: { maxNodes: 2 }, expected: { "values.nodeCount": 2, "values.edgeCount": 1 } },
];

function closed(scope, answer) {
  assert.equal(answer.jobId, scope.jobId);
  assert.equal(answer.recipeDigest, scope.recipeDigest);
  assert.equal(answer.cleanup, "confirmed");
  assert.ok(TERMINAL.includes(answer.state));
}

export function validateReplayImageIsolation(container, network, { imageId, dataVolume }) {
  assert.equal(container.Image, imageId);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
  assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.ok(container.HostConfig.PidsLimit > 0 && container.HostConfig.PidsLimit <= 64);
  assert.ok(container.HostConfig.Memory > 0 && container.HostConfig.Memory <= 768 * 1024 * 1024);
  assert.ok(container.HostConfig.NanoCpus > 0 && container.HostConfig.NanoCpus <= 1e9);
  assert.ok(!container.HostConfig.Privileged);
  assert.ok(!container.HostConfig.PortBindings || Object.keys(container.HostConfig.PortBindings).length === 0);
  assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1);
  assert.equal(network.Internal, true);
  assert.equal(Object.values(container.NetworkSettings.Networks)[0].NetworkID, network.Id);
  assert.equal(container.Mounts.filter(mount => mount.Type !== "tmpfs").length, 2);
  for (const mount of container.Mounts.filter(value => value.Type === "tmpfs")) assert.equal(mount.Destination, "/tmp");
  const data = container.Mounts.find(mount => mount.Destination === "/data");
  assert.equal(data?.Type, "volume"); assert.equal(data.Name, dataVolume); assert.equal(data.RW, true);
  const secret = container.Mounts.find(mount => mount.Destination === "/run/secrets/workload-signing.secret");
  assert.equal(secret?.Type, "bind"); assert.equal(secret.RW, false);
  for (const value of container.Config.Env) {
    assert.ok(!/^(?:.*(?:API_KEY|PROVIDER_KEY|TOKEN)|OPEN_SCIENCE_.*)=/.test(value), "Replay executor received a provider/control-plane credential");
  }
  return { imageId, internalNetwork: true, dataVolume, readOnlyRoot: true, controlSocket: false, providerCredentials: false };
}

/** The caller supplies only inspected release identity; credentials stay in the control plane. */
export async function runResultReplayImageSmoke({ client, dataDir, imageId, sourceRevision, releaseId, timeoutMs = 60000 }) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(releaseId, /^[A-Za-z0-9_.-]{1,160}$/);
  const userId = `replayci_${randomUUID().replaceAll("-", "")}`;
  const projectId = `p_${randomUUID().replaceAll("-", "")}`;
  const userRoot = path.join(dataDir, "users", userId);
  const workspace = path.join(userRoot, "projects", projectId, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const scopes = []; const reports = [];
  let cleanupConfirmed = true;
  try {
    const capabilityScope = { userId, projectId, jobId: randomUUID(), recipeDigest: "0".repeat(64) };
    const capabilities = await client.capabilities(capabilityScope);
    for (const fixture of fixtures) {
      const capability = capabilities.methods?.find(item => item.method === fixture.method && item.available === true);
      assert.ok(capability, `Built replay image lacks ${fixture.method}`);
      assert.match(capability.codeDigest, /^[a-f0-9]{64}$/);
      assert.match(capability.environmentDigest, /^[a-f0-9]{64}$/);
      const jobId = randomUUID(); const inputPath = `result-replays/${jobId}/input.json`;
      const input = Buffer.from(JSON.stringify(fixture.input));
      await mkdir(path.dirname(path.join(workspace, inputPath)), { recursive: true });
      await writeFile(path.join(workspace, inputPath), input, { flag: "wx", mode: 0o600 });
      const recipe = { method: fixture.method, version: "1", input: { path: inputPath, sha256: sha(input) },
        parameters: fixture.parameters, codeDigest: capability.codeDigest, environmentDigest: capability.environmentDigest };
      const scope = { userId, projectId, jobId, recipeDigest: replayDigest(recipe) }; scopes.push(scope);
      let answer = await client.start(scope, recipe);
      const deadline = Date.now() + timeoutMs;
      while (!TERMINAL.includes(answer.state)) {
        assert.ok(Date.now() < deadline, `${fixture.method} did not finish within the image qualification deadline`);
        await delay(50); answer = await client.status(scope);
      }
      closed(scope, answer); assert.equal(answer.state, "succeeded");
      assert.equal(answer.resultPath, `result-replays/${jobId}/output/result.json`);
      assert.ok(answer.artifacts.length > 0 && answer.artifacts.length <= 8);
      let outputBytes;
      for (const artifact of answer.artifacts) {
        assert.ok(artifact.path.startsWith(`result-replays/${jobId}/output/`) && !artifact.path.split("/").includes(".."));
        const bytes = await readFile(path.join(workspace, artifact.path));
        assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes);
        if (artifact.path === answer.resultPath) outputBytes = bytes;
      }
      assert.ok(outputBytes, "The immutable numerical result is absent from the artifact inventory");
      const output = JSON.parse(outputBytes.toString("utf8"));
      assert.deepEqual(output.recipe, recipe);
      assert.equal(output.receipt.recipeDigest, scope.recipeDigest);
      assert.equal(output.receipt.inputDigest, sha(input));
      assert.equal(output.receipt.codeDigest, capability.codeDigest);
      assert.equal(output.receipt.environmentDigest, capability.environmentDigest);
      assert.deepEqual(output.machineValues, answer.machineValues);
      assert.equal(new Set(output.machineValues.map(value => value.key)).size, output.machineValues.length);
      const values = Object.fromEntries(output.machineValues.map(value => [value.key, value.value]));
      for (const [key, expected] of Object.entries(fixture.expected)) {
        assert.ok(Number.isFinite(values[key]) && Math.abs(values[key] - expected) <= 1e-10, `${fixture.method}: unexpected ${key}`);
      }
      assert.deepEqual(await client.start(scope, recipe), answer, "Reusing the owned identity must return the same immutable attempt");
      reports.push({ method: fixture.method, jobId, recipeDigest: scope.recipeDigest, codeDigest: capability.codeDigest,
        environmentDigest: capability.environmentDigest, artifacts: answer.artifacts, machineValues: output.machineValues });
    }
    const canceled = { userId, projectId, jobId: randomUUID(), recipeDigest: "a".repeat(64) }; scopes.push(canceled);
    closed(canceled, await client.cancel(canceled));
    assert.equal((await client.status(canceled)).state, "canceled", "The image must retain its cancellation tombstone");
    return { schemaVersion: 1, kind: "result-replay-image-qualification", imageId, sourceRevision, releaseId,
      methods: reports, cancelBeforeAdmission: "confirmed", executionBoundary: "control_plane_to_built_image_http", scientificApplicability: "not_assessed" };
  } finally {
    for (const scope of scopes) {
      try { closed(scope, await client.cancel(scope)); } catch { cleanupConfirmed = false; }
    }
    // Never erase the only owned scope while physical termination is uncertain.
    if (cleanupConfirmed) await rm(userRoot, { recursive: true, force: true });
    else throw new Error("Replay image qualification could not confirm physical cleanup; its fixture scope was retained.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.env.OPEN_SCIENCE_RESULT_REPLAY_SMOKE_ACK, "disposable-ci-fixtures");
  const { loadConfig } = await import("../../apps/server/src/config.mjs");
  const config = loadConfig();
  assert.equal(config.resultEngineUrl, "http://result-replay:8031");
  const report = await runResultReplayImageSmoke({ client: new ResultReplayClient({ config }), dataDir: config.dataDir,
    imageId: process.env.OPEN_SCIENCE_RESULT_REPLAY_IMAGE_ID, sourceRevision: config.sourceRevision, releaseId: config.releaseId });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
