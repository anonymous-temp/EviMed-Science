import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DENIED_WIRE_METHODS, WORKSPACE_BIND_METHOD, isAllowedWireMethod } from "../src/dshRuntimeAdapter.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";

// DSH 0.2.1 records a session's workspace only when it creates the session, refuses to reuse one that is not accounted or has a turn, and
// disables the composer of a blank session whose workspace it cannot name. A session the control plane makes by cwd alone is therefore
// a conversation that cannot be typed into (found in the browser, r19-acceptb): the control plane registers the project's directory and
// creates its sessions inside that workspace.

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-session-workspace-"));
  const project = { id: "p-session", userId: "alice", rootDir, baseDir: rootDir, metaDir: path.join(rootDir, ".openscience"),
    workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime") };
  await mkdir(project.workspaceDir);
  const manager = new RuntimeManager({ runtimeMode: "mock", allowMockRuntime: true, production: false, runtimeIdleTimeoutMs: 60_000 });
  t.after(async () => { await manager.closeAll(); await rm(rootDir, { recursive: true, force: true }); });
  /** @type {{ method: string, payload: any }[]} */
  const calls = [];
  const through = manager.callKernel.bind(manager);
  manager.callKernel = async (runtime, owner, method, payload, signal, options) => {
    calls.push({ method, payload });
    if (manager.refuseWorkspace && method === WORKSPACE_BIND_METHOD) throw new Error("kernel without workspaces");
    return through(runtime, owner, method, payload, signal, options);
  };
  return { manager, project, calls };
}

test("a session the control plane creates is made inside the project's workspace, registered first", async (t) => {
  const { manager, project, calls } = await fixture(t);
  const session = await manager.createRuntimeSession(project);
  assert.ok(session.id);
  assert.deepEqual(calls.map((call) => call.method), ["workspace/create", "session/create"]);
  assert.deepEqual(calls[0].payload, { request: { path: project.workspaceDir } });
  const request = calls[1].payload.request;
  assert.ok(typeof request.workspaceId === "string" && request.workspaceId, "the session is created with the workspace's id");
  assert.equal(request.cwd, undefined, "the kernel accepts a workspace or a cwd, never both");
});

test("a kernel that will not register the directory still makes the session, by cwd as before", async (t) => {
  const { manager, project, calls } = await fixture(t);
  manager.refuseWorkspace = true;
  const session = await manager.createRuntimeSession(project);
  assert.ok(session.id);
  assert.deepEqual(calls.map((call) => call.method), ["workspace/create", "session/create"]);
  assert.deepEqual(calls[1].payload.request, { cwd: project.workspaceDir, agentPreset: calls[1].payload.request.agentPreset });
});

test("workspace/create stays closed to everything but the control plane's own bind: the adapter, the deny list and callKernel refuse it", async (t) => {
  const { manager, project } = await fixture(t);
  assert.equal(WORKSPACE_BIND_METHOD, "workspace/create");
  assert.equal(isAllowedWireMethod(WORKSPACE_BIND_METHOD), false);
  assert.ok(DENIED_WIRE_METHODS.has(WORKSPACE_BIND_METHOD));
  const runtime = await manager.start(project);
  await assert.rejects(manager.callKernel(runtime, project, WORKSPACE_BIND_METHOD, { request: { path: "/etc" } }, undefined, {}), { code: "runtime_method_forbidden" });
  await assert.rejects(manager.callKernel(runtime, project, "workspace/delete", { request: { workspaceId: "x" } }, undefined, { workspaceBind: true }), { code: "runtime_method_forbidden" });
});
