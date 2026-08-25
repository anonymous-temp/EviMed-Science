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
