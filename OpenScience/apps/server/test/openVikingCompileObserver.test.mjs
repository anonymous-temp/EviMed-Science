import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createOpenVikingCompileObserver } from "../src/openVikingCompileObserver.mjs";
import { PINNED } from "../src/pinnedVersions.mjs";
import { createRuntimeController } from "../src/runtimeControllerServer.mjs";
import { RuntimeControllerClient } from "../src/runtimeControllerClient.mjs";

function fixture() {
  const calls = [];
  const id = "a".repeat(64), imageId = `sha256:${"b".repeat(64)}`;
  const self = "0123456789ab";
  const engine = { Id: id, Image: imageId, RestartCount: 0,
    State: { Running: true, Restarting: false, Health: { Status: "healthy" }, StartedAt: "2026-10-24T01:00:00Z", Pid: 42 },
    Config: { Entrypoint: ["openviking-entrypoint"], Cmd: null,
      Labels: { "com.docker.compose.project": "production", "com.docker.compose.service": "evimed-openviking" } },
    Mounts: [{ Type: "volume", Destination: "/run/openviking-secrets", Name: "production_evimed-openviking-secrets", RW: false }] };
  const volume = { Labels: { "com.docker.compose.project": "production", "com.docker.compose.volume": "evimed-openviking-secrets" } };
  const image = { Id: imageId, Os: "linux", Architecture: "amd64", RepoDigests: [`${PINNED.openviking.image}@${PINNED.openviking.imageDigest}`] };
  let inventory = id;
  const sample = { configDigest: "c".repeat(64), configPath: "/run/openviking-secrets/ov.conf", backend: "direct",
    allowExec: false, allowCompileExec: false, codeDigest: "d".repeat(64), processDigest: "e".repeat(64) };
  const run = async args => {
    calls.push(args);
    if (args[0] === "ps") return inventory;
    if (args[0] === "exec") return JSON.stringify(sample);
    if (args[0] === "volume") return JSON.stringify(volume);
    if (args[0] === "image") return JSON.stringify(image);
    if (args.at(-1) === self) return JSON.stringify({ Config: { Labels: {
      "com.docker.compose.project": "production", "com.docker.compose.service": "open-science-runtime-controller" } } });
    return JSON.stringify(engine);
  };
  return { engine, volume, image, sample, calls, run, self, setInventory: value => { inventory = value; },
    observe: createOpenVikingCompileObserver({}, { run, self }) };
}

test("observes only the engine in the controller's own Compose stack", async () => {
  const f = fixture();
  const value = await f.observe();
  assert.equal(value.imageDigest, PINNED.openviking.imageDigest);
  assert.ok(f.calls.find(args => args[0] === "ps").includes("label=com.docker.compose.project=production"));
  assert.equal(f.calls.filter(args => args[0] === "exec").length, 1);
  assert.ok(!JSON.stringify(value).includes("Labels"));
  assert.ok(!f.calls.some(args => ["run", "stop", "restart", "rm", "cp"].includes(args[0])));
});

for (const [name, change] of [
  ["multiple engines", f => f.setInventory(`${"a".repeat(64)}\n${"f".repeat(64)}`)],
  ["unqualified image", f => { f.image.RepoDigests = []; }],
  ["foreign secret volume", f => { f.volume.Labels["com.docker.compose.project"] = "acceptance"; }],
  ["writable configuration", f => { f.engine.Mounts[0].RW = true; }],
  ["nested config replacement", f => { f.engine.Mounts.push({ Destination: "/run/openviking-secrets/ov.conf" }); }],
  ["mounted implementation", f => { f.engine.Mounts.push({ Destination: "/app/.venv" }); }],
  ["alternate entrypoint", f => { f.engine.Config.Entrypoint = ["sh", "-c"]; }],
  ["alternate command", f => { f.engine.Config.Cmd = ["vikingbot"]; }],
]) test(`does not qualify ${name}`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(f.observe(), { code: "openviking_compile_unverified" });
  assert.ok(!f.calls.some(args => args[0] === "exec"));
});

test("rejects replacement between Docker inspect calls without exposing Docker diagnostics", async () => {
  const f = fixture();
  const run = async args => {
    const value = await f.run(args);
    if (args[0] === "exec") f.engine.State.Pid++;
    return value;
  };
  await assert.rejects(createOpenVikingCompileObserver({}, { run, self: f.self })(), { code: "runtime_controller_unavailable" });
  await assert.rejects(createOpenVikingCompileObserver({}, { self: f.self, run: async () => { throw new Error("secret-from-docker"); } })(),
    error => error.code === "runtime_controller_unavailable" && !error.message.includes("secret-from-docker"));
});

test("liveness loss is unavailable, while a definite configuration rejection revokes qualification", async () => {
  const f = fixture();
  f.engine.State.Health.Status = "unhealthy";
  await assert.rejects(f.observe(), { code: "runtime_controller_unavailable" });
  assert.ok(!f.calls.some(args => args[0] === "exec"));
  f.engine.State.Health.Status = "healthy";
  const run = async args => {
    if (args[0] === "exec") throw Object.assign(new Error("private error must not escape"),
      { stdout: '{"valid":false,"state":"rejected","code":"configuration_or_code_rejected"}' });
    return f.run(args);
  };
  await assert.rejects(createOpenVikingCompileObserver({}, { run, self: f.self })(),
    error => error.code === "openviking_compile_unverified" && !error.message.includes("private"));
});

test("the fixed Python reader verifies source bytes and rejects config drift without importing the engine", () => {
  const result = spawnSync("python3", ["-B", new URL("./openVikingCompileObserver_test.py", import.meta.url).pathname],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

test("the real controller socket exposes only the parameter-free read-only observation", async t => {
  const root = await realpath(await mkdtemp("/tmp/ovc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const config = { dataDir: root, runtimeControllerSocket: path.join(root, "controller.sock"), production: false };
  const controller = createRuntimeController(config, { openVikingCompileObserver: { run: f.run, self: f.self } });
  t.after(() => controller.close());
  await controller.listen();
  const client = new RuntimeControllerClient(config);
  assert.equal((await client.observeOpenVikingCompile()).instance, f.engine.Id);
  const calls = f.calls.length;
  await assert.rejects(client.request("GET", "/v1/openviking/compile-observation?container=foreign"),
    { code: "runtime_controller_payload_invalid" });
  await assert.rejects(client.request("POST", "/v1/openviking/compile-observation", { container: "foreign" }));
  assert.equal(f.calls.length, calls);
});
