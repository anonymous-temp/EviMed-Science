import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/store.mjs";
import { DEVICE_REQUEST, DEVICE_TOKEN_ROUTES, createDeviceAuthentication, deviceTokenRouteAllowed } from "../src/channels/deviceTokens.mjs";
import { HttpError } from "../src/security.mjs";

const VALID = "evd_valid_token_for_tests_0123456789";

/** A token store that knows one token. */
const tokens = {
  async resolve(token) {
    if (token === VALID) return { userId: "alice", tokenId: "dvt_1" };
    throw new HttpError(401, "device_token_invalid", "The device token is not valid.");
  },
};

async function fixture(t, { appApiEnabled }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-device-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ dataDir, stateStore: "file", devAuth: false, bootstrapUser: "", bootstrapPassword: "", appApiEnabled });
  const store = createStore(config);
  await store.createUser("alice", "alice-password-1234", "Alice");
  const authenticate = createDeviceAuthentication({ config, tokens, userById: (id) => store.userById(id) });
  return { store, authenticate };
}

/** @param {string} method @param {string} token */
function request(method, token) {
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test("with the switch off the Authorization header is never read, and the API is cookie-only as before", async (t) => {
  const { store, authenticate } = await fixture(t, { appApiEnabled: false });
  const req = request("POST", VALID);
  assert.equal(await authenticate(req, "/api/agent-runs/dispatch"), null);
  assert.equal(req[DEVICE_REQUEST], undefined);
  await assert.rejects(store.ensureSessionUser(req, {}), { code: "unauthorized" });
  await assert.rejects(store.assertCsrf(req, "/api/agent-runs/dispatch"), { code: "unauthorized" });
});

test("with the switch on a device token is the account on the run API, with no CSRF because there is no cookie", async (t) => {
  const { store, authenticate } = await fixture(t, { appApiEnabled: true });
  const req = request("POST", VALID);
  const user = await authenticate(req, "/api/agent-runs/dispatch");
  assert.equal(user.id, "alice");
  const { user: seen, session } = await store.ensureSessionUser(req, {});
  assert.equal(seen.id, "alice");
  assert.equal(session.csrfToken, null);
  assert.equal(session.device, true);
  await store.assertCsrf(req, "/api/agent-runs/dispatch");
  const events = request("GET", VALID);
  await authenticate(events, "/api/runs/run_1/events");
  assert.equal((await store.ensureUser(events, {})).id, "alice");
});

test("a device token is refused by name off its route list and when it is not valid", async (t) => {
  const { authenticate } = await fixture(t, { appApiEnabled: true });
  for (const [method, pathname] of [["DELETE", "/api/account"], ["PUT", "/api/connectors/opengwas"],
    ["POST", "/api/im/app/device-tokens"], ["POST", "/api/agent-keys"], ["GET", "/api/account/export"]]) {
    await assert.rejects(authenticate(request(method, VALID), pathname), { code: "device_token_route_forbidden", status: 403 },
      `${method} ${pathname}`);
  }
  await assert.rejects(authenticate(request("GET", "evd_not_a_real_token_0123"), "/api/agent-runs"), { code: "device_token_invalid", status: 401 });
  // An agent memory key is not a device token: left to the route that owns it.
  assert.equal(await authenticate(request("GET", "evk_agent_memory_key_0123456789"), "/api/agent-runs"), null);
  assert.equal(await authenticate(request("GET", ""), "/api/agent-runs"), null);
});

test("the route list is the run API, the event stream, delivered files, the inbox and push intake — nothing that manages the account", () => {
  // The table is walked: it has to hold the entries a phone app needs.
  assert.ok(DEVICE_TOKEN_ROUTES.length >= 12, `only ${DEVICE_TOKEN_ROUTES.length} routes`);
  for (const [method, pathname] of [["GET", "/api/me"], ["GET", "/api/projects"], ["PUT", "/api/research-sessions/app-1"],
    ["POST", "/api/agent-runs/dispatch"], ["POST", "/api/agent-runs/run_1/steer"], ["POST", "/api/agent-runs/run_1/cancel"],
    ["GET", "/api/runs/run_1/events"], ["GET", "/api/files/download/deliverables/x/report.md"], ["GET", "/api/inbox"],
    ["POST", "/api/im/app/push-tokens"]]) {
    assert.equal(deviceTokenRouteAllowed(method, pathname), true, `${method} ${pathname}`);
  }
  for (const [method, pathname] of [["POST", "/api/auth/logout"], ["DELETE", "/api/projects/default"], ["POST", "/api/projects"],
    ["GET", "/api/runs/run_1/events/extra"], ["POST", "/api/memory/records"], ["DELETE", "/api/im/feishu"]]) {
    assert.equal(deviceTokenRouteAllowed(method, pathname), false, `${method} ${pathname}`);
  }
});
