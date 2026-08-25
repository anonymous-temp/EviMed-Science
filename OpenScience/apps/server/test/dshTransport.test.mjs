import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

/** The DSH kernel's container entrypoint is the socat bridge script: it seeds
 *  the profile, turns telemetry off and injects the deployment's settings, and
 *  it only runs on the unix transport. The TCP branch launched `dsh` directly
 *  with none of that, and the container died during boot with "profile does not
 *  exist" — a failure nobody could see, because the launch argv is not recorded
 *  anywhere. So the combination is refused where it is chosen, not where it
 *  fails. */
test("the DSH kernel refuses a TCP transport rather than launching a container that cannot work", () => {
  assert.throws(
    () => loadConfig({ runtimeKernel: "dsh", runtimeTransport: "tcp" }),
    /OPEN_SCIENCE_RUNTIME_TRANSPORT must be "unix"/,
  );
});

test("the DSH kernel defaults to the unix transport outside production, where the old default was TCP", () => {
  const dsh = loadConfig({ runtimeKernel: "dsh", production: false });
  assert.equal(dsh.runtimeTransport, "unix");
  // The OpenCode default is unchanged: this is a DSH fact, not a new global.
  const opencode = loadConfig({ runtimeKernel: "opencode", production: false });
  assert.equal(opencode.runtimeTransport, "tcp");
});

test("a control socket path the kernel cannot connect to is refused at plan time", async () => {
  // `sun_path` is 108 bytes. Past that the container still binds its own short
  // path inside the mount and reports itself healthy, while every connect from
  // the control plane fails — which surfaced as "Runtime exited before it
  // became ready" and, once that message carried the container's output, as a
  // container whose log said `dsh web: http://127.0.0.1:<port>` while nothing
  // could reach it.
  const { buildOpenCodeLaunchPlan } = await import("../src/runtimeManager.mjs");
  const deep = `/srv/${"d".repeat(40)}/${"e".repeat(40)}`;
  const config = loadConfig({
    runtimeKernel: "dsh",
    runtimeSandboxMode: "docker",
    runtimeTransport: "unix",
    dataDir: deep,
    production: false,
  });
  const root = `${deep}/users/u/projects/p`;
  const project = {
    userId: "u",
    id: "p",
    rootDir: root,
    workspaceDir: `${root}/workspace`,
    runtimeDir: `${root}/runtime`,
    dataDir: deep,
  };
  assert.throws(
    () => buildOpenCodeLaunchPlan(config, project, 4096, "pw_0123456789abcdef0123"),
    /runtime_socket_path_too_long|108/,
  );
});

test("the DSH profile sync hands the gateway token back, not only to the credentials file", async () => {
  // The gateway authenticates on an *active* jti and only the caller can
  // register one. Returning the token solely by writing `.credentials.yaml`
  // left `activateModelGatewayRuntime` with nothing to register, so the
  // runtime's very first model call came back 401 while the file on disk held
  // a valid token — a failure that looks like a credential problem and is a
  // bookkeeping one.
  const { syncRuntimeDshProfile } = await import("../src/runtimeManager.mjs");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sync-"));
  const config = loadConfig({
    runtimeKernel: "dsh",
    runtimeSandboxMode: "docker",
    runtimeTransport: "unix",
    dataDir: root,
    production: false,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-not-a-real-key",
    deepseekModel: "deepseek-v4-pro",
    modelGatewaySigningSecret: "a".repeat(64),
    evimedWorkloadSigningSecret: "b".repeat(64),
  });
  const project = { userId: "u", id: "p", rootDir: root, workspaceDir: path.join(root, "workspace") };
  await fs.mkdir(project.workspaceDir, { recursive: true });
  const plan = {
    sandboxMode: "docker",
    dshHomeDir: path.join(root, "dsh-home"),
    proxyWorkspaceDir: "/workspace",
  };

  const result = await syncRuntimeDshProfile(config, project, plan);
  assert.equal(result.configured, true);
  assert.ok(result.token, "the caller cannot register a token it was not given");
  assert.ok(result.payload?.jti, "the jti is what the gateway matches on");
  await fs.rm(root, { recursive: true, force: true });
});

test("the runtime's dying words keep the end, and survive the trip through the controller", async () => {
  // Two defects in one fix, both found by auditing it rather than by running
  // it. A head-keeping buffer throws away the cause of a container that boots
  // and *then* dies, and the controller used to collapse the capture to a
  // single 512-character line before sending it — which left the reader's
  // line-based filters unable to fire, and able to delete the whole thing when
  // that one line happened to match.
  const { appendTailOutput, appendCappedOutput } = await import("../src/runtimeManager.mjs");

  let tail = "";
  for (const line of ["boot noise\n".repeat(600), "Error: the actual cause\n"]) {
    tail = appendTailOutput(tail, line, 4096);
  }
  assert.ok(tail.includes("Error: the actual cause"), "the end is what explains the exit");
  assert.ok(Buffer.byteLength(tail, "utf8") <= 4096);

  // The head-keeping helper still exists and still keeps the head: it is right
  // for short-lived processes, and this is why the two are separate.
  let head = "";
  for (const line of ["boot noise\n".repeat(600), "Error: the actual cause\n"]) {
    head = appendCappedOutput(head, line, 4096);
  }
  assert.ok(!head.includes("Error: the actual cause"));
});
