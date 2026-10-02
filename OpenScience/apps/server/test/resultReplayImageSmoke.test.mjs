import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { runResultReplayImageSmoke, validateReplayImageIsolation } from "../../../scripts/ops/result-replay-image-smoke.mjs";

const imageId = `sha256:${"a".repeat(64)}`;
const identity = { imageId, sourceRevision: "b".repeat(40), releaseId: "synthetic-ci" };
const sha = value => createHash("sha256").update(value).digest("hex");

function containerFixture() {
  return { Image: imageId, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 64, Memory: 768 * 1024 * 1024, NanoCpus: 1e9, Privileged: false, PortBindings: {} },
  NetworkSettings: { Networks: { "ci-replay-internal": { NetworkID: "owned-network" } } },
  Mounts: [{ Type: "volume", Name: "owned-data", Destination: "/data", RW: true },
    { Type: "bind", Destination: "/run/secrets/workload-signing.secret", RW: false }],
  Config: { Env: ["PATH=/usr/bin", "EVIMED_DATA_ROOT=/data", "EVIMED_WORKLOAD_SIGNING_SECRET_FILE=/run/secrets/workload-signing.secret"] } };
}

test("the actual image isolation validator refuses extra networks, mounts, privileges and provider credentials", () => {
  const valid = containerFixture(); const network = { Internal: true, Id: "owned-network" };
  assert.equal(validateReplayImageIsolation(valid, network, { imageId, dataVolume: "owned-data" }).internalNetwork, true);
  const mutations = [value => { value.Image = `sha256:${"c".repeat(64)}`; },
    value => { value.HostConfig.Privileged = true; }, value => { value.HostConfig.ReadonlyRootfs = false; },
    value => { value.NetworkSettings.Networks.public = { NetworkID: "public" }; },
    value => { value.Mounts.push({ Destination: "/var/run/docker.sock" }); },
    value => { value.Config.Env.push("DEEPSEEK_API_KEY=forbidden-fixture"); },
    value => { value.HostConfig.PortBindings["8031/tcp"] = [{ HostPort: "8031" }]; }];
  for (const mutate of mutations) { const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => validateReplayImageIsolation(changed, network, { imageId, dataVolume: "owned-data" })); }
  assert.throws(() => validateReplayImageIsolation(valid, { ...network, Internal: false }, { imageId, dataVolume: "owned-data" }));
});

async function fixture(t, { tamper = false, uncertain = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "replay-image-smoke-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const methods = ["meta.dl", "faers.signals", "bibliometric.network"].map(method => ({ method, available: true,
    codeDigest: "c".repeat(64), environmentDigest: "d".repeat(64) }));
  const attempts = new Map();
  const client = {
    capabilities: async () => ({ methods }),
    start: async (scope, recipe) => {
      if (attempts.has(scope.jobId)) return attempts.get(scope.jobId);
      const workspace = path.join(dataDir, "users", scope.userId, "projects", scope.projectId, "workspace");
      const input = await readFile(path.join(workspace, recipe.input.path)); assert.equal(sha(input), recipe.input.sha256);
      const values = recipe.method === "meta.dl" ? [{ key: "values.pooled_effect", value: 4 / 3 }]
        : recipe.method === "faers.signals" ? [{ key: "values[0].ror.value", value: 10.444444444444445 }, { key: "values[0].prr.value", value: 9.5 }]
          : [{ key: "values.nodeCount", value: 2 }, { key: "values.edgeCount", value: 1 }];
      const resultPath = `result-replays/${scope.jobId}/output/result.json`;
      const output = Buffer.from(JSON.stringify({ recipe, machineValues: values,
        receipt: { recipeDigest: tamper ? "e".repeat(64) : scope.recipeDigest, inputDigest: sha(input),
          codeDigest: recipe.codeDigest, environmentDigest: recipe.environmentDigest } }));
      await mkdir(path.dirname(path.join(workspace, resultPath)), { recursive: true });
      await writeFile(path.join(workspace, resultPath), output);
      const answer = { jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "succeeded", cleanup: "confirmed", resultPath,
        machineValues: values, artifacts: [{ path: resultPath, sha256: sha(output), bytes: output.length }] };
      attempts.set(scope.jobId, answer); return answer;
    },
    status: async scope => attempts.get(scope.jobId),
    cancel: async scope => { const answer = { jobId: scope.jobId, recipeDigest: scope.recipeDigest, state: "canceled", cleanup: uncertain ? "unknown" : "confirmed" };
      attempts.set(scope.jobId, answer); return answer; },
  };
  return { client, dataDir };
}

test("image smoke binds HTTP recipe, retained bytes and machine values, and joins fixtures before removing them", async t => {
  const f = await fixture(t); const report = await runResultReplayImageSmoke({ ...f, ...identity });
  assert.equal(report.methods.length, 3); assert.equal(report.imageId, imageId);
  assert.deepEqual(await readdir(path.join(f.dataDir, "users")), []);
  const changed = await fixture(t, { tamper: true });
  await assert.rejects(runResultReplayImageSmoke({ ...changed, ...identity }), /Expected values to be strictly equal/);
  assert.deepEqual(await readdir(path.join(changed.dataDir, "users")), []);
});

test("uncertain physical cleanup retains its fixture identity and cannot publish image qualification", async t => {
  const f = await fixture(t, { uncertain: true });
  await assert.rejects(runResultReplayImageSmoke({ ...f, ...identity }), /could not confirm physical cleanup/);
  assert.equal((await readdir(path.join(f.dataDir, "users"))).length, 1);
});

test("Docker CI enables and qualifies the replay image and exports exactly that image with its release manifest", async () => {
  const workflow = parse(await readFile(new URL("../../../../.github/workflows/web.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs["docker-hosted"].steps;
  const find = name => { const step = steps.find(value => value.name === name); assert.ok(step, name); return step; };
  assert.match(find("Define immutable CI release").run, /OPEN_SCIENCE_RESULT_REPLAY_IMAGE=evimed-result-replay:ci-/);
  assert.match(find("Define immutable CI release").run, /OPEN_SCIENCE_RESULT_ENGINE_URL=http:\/\/result-replay:8031/);
  for (const step of steps.filter(value => value.run?.split("\n").some(line => !line.trimStart().startsWith("#") && line.includes("docker compose")))) {
    assert.match(step.run, /docker-compose\.result-replay\.yml/, `${step.name} omitted the qualified executor overlay`);
  }
  const smoke = find("Verify built replay image isolation and signed numerical HTTP jobs");
  assert.match(smoke.run, /open-science-web node scripts\/ops\/result-replay-image-smoke\.mjs/);
  assert.match(smoke.run, /validateReplayImageIsolation/);
  assert.equal(find("Preserve built replay image qualification").if, "always()");
  const manifest = find("Generate and verify deployment release manifest").run;
  assert.match(manifest, /org\.opencontainers\.image\.revision/);
  assert.match(manifest, /replay\.imageId/);
  const archive = find("Package verified full-release images").run;
  assert.match(archive, /grep -Fx "\$OPEN_SCIENCE_RESULT_REPLAY_IMAGE"/);
  assert.match(archive, /replay\.configDigest/);
  assert.match(archive, /cp deploy\/web\/release-manifest\.json/);
  assert.match(archive, /result-replay-image-qualification\.json/);
  assert.match(find("Build hosted Web, agent runtime and deterministic replay images").run, /--profile vcr build/);
  assert.match(archive, /grep -Fx "\$EVIMED_VCR_ENGINE_IMAGE"/);
  assert.match(archive, /vcr\.configDigest/);
  const subsets = find("Package bounded core and isolated VCR image subsets");
  assert.match(subsets.if, /\[full-release\]/);
  assert.match(subsets.run, /for subset in core vcr/);
  assert.match(subsets.run, /inspected\.Id, recorded\.configDigest/);
  assert.match(subsets.run, /images\.some\(image => image\.imageId === inspected\.Id\)/);
  assert.match(subsets.run, /module\.measure_archive/);
  assert.match(subsets.run, /overlayfs snapshots and temporary peak/);
  assert.doesNotMatch(subsets.run, /docker (?:build|image rm|system prune)/);
  assert.match(find("Upload exact candidate core image subset").with.name, /evimed-core-release-/);
  assert.match(find("Upload isolated candidate VCR image subset").with.name, /evimed-vcr-release-/);
  const vcr = find("Qualify isolated VCR candidate image without enabling the module");
  assert.match(vcr.run, /numerical_source_digest/);
  assert.match(vcr.run, /'--network', 'none'/);
  assert.match(find("Write CI Compose environment").run, /OPEN_SCIENCE_VCR_ENABLED=false/);
  assert.doesNotMatch(find("Start production Compose stack").run, /--profile vcr/);
  assert.equal(find("Preserve isolated VCR candidate image qualification").if, "always()");
});
