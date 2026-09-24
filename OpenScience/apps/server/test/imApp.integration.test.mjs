// The IM module inside the real app: routes, the device-token step, the worker
// lifecycle, and the dispatch closure wired in server.mjs — driven against the
// mock kernel, with a fake Feishu SDK standing where the network would be.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createFakeFeishuSdk, feishuMessageEvent } from "./fakeFeishuSdk.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";

/** @param {() => Promise<boolean> | boolean} condition @param {string} label */
async function eventually(condition, label, budgetMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a Feishu message runs through the real dispatch path and comes back as a card and an answer; device tokens open only the run API", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-im-app-"));
  const fake = createFakeFeishuSdk();
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    modelGatewaySigningSecret: "m".repeat(48), runTitlesEnabled: false,
    imEnabled: true, imPollMs: 100, imProgressIntervalMs: 1_000, appApiEnabled: true,
    publicUrl: "https://science.example.com", loadFeishuSdk: async () => fake.sdk });
  const username = `im${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-im-password", "IM fixture");
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-im-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
      "x-open-science-csrf": auth.data.csrfToken };

    // The settings page's view before anything is bound.
    const channels = await (await fetch(`${base}/api/im/channels`, { headers })).json();
    assert.equal(channels.data.enabled, true);
    assert.equal(channels.data.feishu.bound, false);
    assert.equal(channels.data.channels.find((row) => row.id === "wecom").state, "disabled");
    assert.equal((await fetch(`${base}/api/im/channels`)).status, 401);

    // Scan to create.
    assert.equal((await fetch(`${base}/api/im/feishu/registration`, { method: "POST", headers: { cookie: headers.cookie }, body: "{}" })).status, 403,
      "starting a registration is a mutation and needs CSRF");
    const started = await fetch(`${base}/api/im/feishu/registration`, { method: "POST", headers, body: "{}" });
    assert.equal(started.status, 200);
    await eventually(() => fake.waitingForScan, "the QR code");
    const polled = (await (await fetch(`${base}/api/im/feishu/registration`, { headers })).json()).data;
    assert.match(polled.qrCodeUrl, /^https:\/\/open\.feishu\.cn\/page\/launcher/);
    fake.scan();
    await eventually(async () => (await (await fetch(`${base}/api/im/feishu/registration`, { headers })).json()).data.state === "succeeded",
      "the registration");
    await eventually(() => fake.wsClients.length === 1 && Boolean(fake.wsClients[0].dispatcher), "the long connection");

    // One message, dispatched through server.mjs's closure to the mock kernel.
    await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: `ev-${randomUUID()}`, messageId: "om_app_q", chatId: "oc_app",
      text: "二甲双胍的常用剂量是多少？" }));
    await eventually(() => fake.callsTo("message.reply").some((call) => call.args.path.message_id === "om_app_q"
      && JSON.stringify(call.args.data.content).includes("EviMed 测试运行时")), "the answer from the mock kernel");
    const runs = (await (await fetch(`${base}/api/agent-runs`, { headers })).json()).data;
    const run = runs.find((item) => item.question === "二甲双胍的常用剂量是多少？");
    assert.ok(run, "the run is in the project's ledger like any other");
    assert.match(run.sessionId, /^im-/);
    assert.equal(run.effectiveAgentId, "open-domain-answer", "routed the way a question from the page is");
    await eventually(() => fake.callsTo("card.update").length > 0, "the card to close");
    const closed = JSON.parse(fake.callsTo("card.update").at(-1).args.data.card.data);
    assert.match(closed.body.elements[0].content, /✅ 已完成/);
    // The conversation, not the run ledger page, which was deleted on
    // 2026-09-20: the card knows the session it answered in.
    assert.equal(closed.body.elements[2].behaviors[0].default_url,
      `https://science.example.com/app/chat/${encodeURIComponent(run.sessionId)}`);
    const status = (await (await fetch(`${base}/api/im/channels`, { headers })).json()).data;
    assert.equal(status.feishu.chats.length, 1);
    assert.equal(status.feishu.chats[0].chatType, "p2p");
    assert.equal(status.feishu.chats[0].projectId, null, "a one-to-one chat follows the project used most recently");

    // Device tokens: minted from the browser session, then the run API only.
    const minted = await fetch(`${base}/api/im/app/device-tokens`, { method: "POST", headers, body: JSON.stringify({ name: "测试手机" }) });
    assert.equal(minted.status, 201);
    const token = (await minted.json()).data.token;
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const listed = await fetch(`${base}/api/agent-runs`, { headers: bearer });
    assert.equal(listed.status, 200);
    assert.ok((await listed.json()).data.some((item) => item.id === run.id), "the device sees the same ledger");
    assert.equal((await fetch(`${base}/api/runs/${run.id}/usage`, { headers: bearer })).status !== 401, true);
    assert.equal((await fetch(`${base}/api/account`, { method: "DELETE", headers: bearer, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/im/app/device-tokens`, { method: "POST", headers: bearer, body: "{}" })).status, 403,
      "a device token cannot mint its successor");
    assert.equal((await fetch(`${base}/api/agent-runs`, { headers: { authorization: "Bearer evd_forged_token_0123456789" } })).status, 401);

    // The operator metrics carry the module's counters.
    const metrics = app.im.service.metrics();
    assert.ok(metrics.some((sample) => sample.labels.kind === "run_dispatched" && sample.value >= 1));

    // Unbind.
    const unbound = await fetch(`${base}/api/im/feishu`, { method: "DELETE", headers });
    assert.equal(unbound.status, 200);
    assert.equal((await unbound.json()).data.removed, 1);
    assert.equal(fake.wsClients[0].closed, true);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("with the module off nothing channel-shaped runs, the inbox stays in-app, and a bearer header is not read", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-im-off-"));
  const fake = createFakeFeishuSdk();
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    modelGatewaySigningSecret: "m".repeat(48), runTitlesEnabled: false, loadFeishuSdk: async () => fake.sdk });
  const username = `imoff${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    assert.equal(app.im.worker, null, "no worker without the switch");
    user = await app.store.createUser(username, "test-only-im-password", "IM off");
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-im-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
      "x-open-science-csrf": auth.data.csrfToken };
    const channels = (await (await fetch(`${base}/api/im/channels`, { headers })).json()).data;
    assert.equal(channels.enabled, false);
    assert.equal(channels.appApi, false);
    assert.equal((await fetch(`${base}/api/im/feishu/registration`, { method: "POST", headers, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/im/app/device-tokens`, { method: "POST", headers, body: "{}" })).status, 404);
    const preferences = (await (await fetch(`${base}/api/inbox/preferences`, { headers })).json()).data;
    const refused = await fetch(`${base}/api/inbox/preferences`, { method: "PATCH", headers, body: JSON.stringify({
      quietHours: preferences.quietHours, digestTime: preferences.digestTime, switches: preferences.switches,
      channels: ["in-app", "feishu"], expectedRevision: preferences.revision }) });
    assert.equal(refused.status, 400, "with no module the inbox validates in-app only, as it always did");
    assert.equal((await fetch(`${base}/api/agent-runs`, { headers: { authorization: "Bearer evd_anything_at_all_0123456789" } })).status, 401,
      "the header is ignored and the request is simply unauthenticated");
    assert.equal(fake.calls.length, 0, "the SDK is never touched");
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a scan completed after its sign-in ended binds nothing; a bind is told in the inbox and undone from there in one click", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  // Security review 2026-09-20: the bot acts for whoever scanned the code.
  // Through the real routes: the sign-in that started a scan must still hold
  // when it completes, and every bind lands in the inbox with 「解除绑定」.
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-im-bind-"));
  const fake = createFakeFeishuSdk();
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    modelGatewaySigningSecret: "m".repeat(48), runTitlesEnabled: false,
    imEnabled: true, imPollMs: 100, imProgressIntervalMs: 1_000,
    publicUrl: "https://science.example.com", loadFeishuSdk: async () => fake.sdk });
  const username = `imb${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-im-password", "IM bind fixture");
    const address = await app.listen(0, "127.0.0.1");
    listening = true;
    const base = `http://127.0.0.1:${address.port}`;
    const signIn = async () => {
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "test-only-im-password" }) });
      const auth = await login.json();
      return { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    };

    // Started, then signed out before the code was scanned.
    const first = await signIn();
    assert.equal((await fetch(`${base}/api/im/feishu/registration`, { method: "POST", headers: first, body: "{}" })).status, 200);
    await eventually(() => fake.waitingForScan, "the QR code");
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: first, body: "{}" })).status, 200);
    fake.scan();
    const headers = await signIn();
    await eventually(async () => (await (await fetch(`${base}/api/im/feishu/registration`, { headers })).json()).data.state === "error",
      "the refusal");
    const refused = (await (await fetch(`${base}/api/im/feishu/registration`, { headers })).json()).data;
    assert.equal(refused.error.code, "feishu_registration_signed_out");
    assert.equal((await (await fetch(`${base}/api/im/channels`, { headers })).json()).data.feishu.bound, false);

    // Scanned while signed in: bound at once, and the inbox says so.
    assert.equal((await fetch(`${base}/api/im/feishu/registration`, { method: "POST", headers, body: "{}" })).status, 200);
    await eventually(() => fake.waitingForScan, "the second QR code");
    fake.scan();
    await eventually(async () => (await (await fetch(`${base}/api/im/feishu/registration`, { headers })).json()).data.state === "succeeded",
      "the bind");
    assert.equal((await (await fetch(`${base}/api/im/channels`, { headers })).json()).data.feishu.bound, true);
    const inbox = (await (await fetch(`${base}/api/inbox?unresolved=true`, { headers })).json()).data.items;
    const notice = inbox.find((item) => item.title === "飞书机器人已绑定到你的账号");
    assert.ok(notice, "the account is told");
    assert.match(notice.body, /飞书用户 ou_owner/);
    const resolved = await fetch(`${base}/api/inbox/${encodeURIComponent(notice.id)}/resolve`, { method: "POST", headers,
      body: JSON.stringify({ actionId: "unbind-feishu", expectedRevision: notice.revision }) });
    assert.equal(resolved.status, 200);
    assert.equal((await (await fetch(`${base}/api/im/channels`, { headers })).json()).data.feishu.bound, false, "one click unbinds");
    await eventually(() => fake.wsClients.every((client) => client.closed), "the connection to close");
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    if (listening) await app.close();
    else await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
