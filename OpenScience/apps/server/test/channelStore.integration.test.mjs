import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ConnectorCredentialStore, channelCredentialConnector } from "../src/connectorCredentials.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ChannelStore, migrateChannels } from "../src/channels/store.mjs";
import { DeviceTokenStore } from "../src/channels/deviceTokens.mjs";
import { createAppChannel } from "../src/channels/app.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `chan_${randomUUID()}`;
const other = `chan_${randomUUID()}`;
/** @type {any} */
let database;
/** @type {ChannelStore} */
let store;
/** @type {ConnectorCredentialStore} */
let credentials;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Channel owner','development'),($2,'Other','development')", [owner, other]);
  await database.query(`INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes)
    VALUES($1,'default','Default',1048576),($1,'second','Second',1048576),($2,'default','Other',1048576)`, [owner, other]);
  store = new ChannelStore(database);
  credentials = new ConnectorCredentialStore({ database, secret: "x".repeat(40), config: {} });
  await credentials.migrate();
  await migrateChannels(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
  await database.close();
});

test("one Feishu binding per account: a re-scan replaces the previous bot and says which", options, async () => {
  const first = await store.replaceBinding(owner, "feishu", { externalId: "ou_owner", credentialRef: "channel.feishu",
    metadata: { appId: `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`, tenantBrand: "feishu" } });
  assert.equal(first.replaced.length, 0);
  const appId = `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const second = await store.replaceBinding(owner, "feishu", { externalId: "ou_owner", credentialRef: "channel.feishu",
    metadata: { appId, tenantBrand: "feishu" } });
  assert.deepEqual(second.replaced.map((binding) => binding.id), [first.binding.id]);
  assert.equal((await store.bindingsFor(owner, "feishu")).length, 1);
  assert.equal((await store.feishuBindingByAppId(appId)).id, second.binding.id);
  assert.ok((await store.activeBindings("feishu")).some((binding) => binding.id === second.binding.id));
  // The same app cannot belong to two accounts.
  await assert.rejects(store.replaceBinding(other, "feishu", { externalId: "ou_other", metadata: { appId } }), { code: "23505" });
});

test("channel secrets share the credential store and stay invisible to the connector list", options, async () => {
  await credentials.setChannelSecret(owner, channelCredentialConnector("feishu"), "app-secret-value-0123456789");
  assert.equal(await credentials.resolveChannelSecret(owner, "channel.feishu"), "app-secret-value-0123456789");
  // Bound to its owner: the same row does not open for another account.
  assert.equal(await credentials.resolveChannelSecret(other, "channel.feishu"), null);
  assert.equal((await credentials.status(owner)).some((entry) => entry.id.startsWith("channel.")), false);
  await assert.rejects(credentials.setChannelSecret(owner, "opengwas", "x"), { code: "channel_connector_invalid" });
  await assert.rejects(credentials.setChannelSecret(owner, "channel.feishu", "line\nbreak"), { code: "channel_secret_invalid" });
  assert.equal(await credentials.removeChannelSecret(owner, "channel.feishu"), true);
  assert.equal(await credentials.resolveChannelSecret(owner, "channel.feishu"), null);
});

test("a device's push token moves with the device, and the previous owner's copy goes", options, async () => {
  const app = createAppChannel({ store, credentials });
  const token = `push-${randomUUID()}`;
  const mine = await app.bind(owner, { platform: "ios", token, deviceName: "iPhone" });
  assert.equal(mine.metadata.platform, "ios");
  assert.equal(await credentials.resolveChannelSecret(owner, mine.credentialRef), token);
  // Idempotent per token.
  assert.equal((await app.bind(owner, { platform: "ios", token })).id, mine.id);
  const theirs = await app.bind(other, { platform: "ios", token });
  assert.equal((await store.bindingsFor(owner, "app")).length, 0);
  assert.equal((await store.bindingsFor(other, "app"))[0].id, theirs.id);
  assert.equal(await credentials.resolveChannelSecret(owner, mine.credentialRef), null);
  await assert.rejects(app.bind(owner, { platform: "symbian", token }), { code: "push_token_invalid" });
  await assert.rejects(app.bind(owner, { platform: "ios", token: "has space" }), { code: "push_token_invalid" });
});

test("removing a device takes an app binding only: another channel's binding named by its id stays", options, async () => {
  // Security review 2026-09-20: DELETE /api/im/app/push-tokens/:id deleted
  // whatever binding of the account the id named, then answered 404 when it
  // was not a device — a Feishu bot went with it.
  const { ImService } = await import("../src/imService.mjs");
  const { binding: bot } = await store.replaceBinding(owner, "feishu", { externalId: "ou_keep", credentialRef: "channel.feishu",
    metadata: { appId: `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`, tenantBrand: "feishu" } });
  const app = createAppChannel({ store, credentials });
  const device = await app.bind(owner, { platform: "android", token: `push-${randomUUID()}` });
  const tablet = await app.bind(owner, { platform: "android", token: `push-${randomUUID()}` });
  const service = new ImService({ config: { imEnabled: true, channelEnabled: { app: true } }, database, credentials, notifications: null,
    users: {}, agentRuns: {}, runtimeManager: {}, dispatchRun: async () => {}, steerRun: async () => {},
    store, classifier: { classify: async () => ({}) }, write: () => {} });
  try {
    await assert.rejects(service.removePushToken({ id: owner }, bot.id), { status: 404, code: "push_token_not_found" });
    assert.equal((await store.bindingById(bot.id))?.channel, "feishu", "the bot is still bound");
    await assert.rejects(service.removePushToken({ id: other }, device.id), { code: "push_token_not_found" }, "and never another account's device");
    assert.deepEqual(await service.removePushToken({ id: owner }, device.id), { removed: true });
    assert.equal(await store.bindingById(device.id), null);
    assert.equal(await store.deleteBinding(owner, bot.id, { channel: "app" }), null);
    assert.equal((await store.deleteBinding(owner, tablet.id, { channel: "app" }))?.id, tablet.id);
    assert.equal((await store.bindingById(bot.id))?.channel, "feishu");
  } finally { await service.close(); }
});

test("chats remember a project, lose it when the project goes, and keep one session per project", options, async () => {
  const [binding] = await store.bindingsFor(owner, "feishu");
  const chat = await store.ensureChat({ bindingId: binding.id, chatId: "oc_group", userId: owner, chatType: "group" });
  assert.equal(chat.projectId, null);
  const selected = await store.selectChatProject(binding.id, "oc_group", "second", new Date("2026-09-20T01:00:00Z"));
  assert.equal(selected.projectId, "second");
  assert.equal(selected.projectSelectedAt, "2026-09-20T01:00:00.000Z");
  await store.touchChatSession({ bindingId: binding.id, chatId: "oc_group", userId: owner, projectId: "second", sessionId: "im-aaa" });
  assert.equal((await store.chatSession(binding.id, "oc_group", "second")).sessionId, "im-aaa");
  await store.touchChatSession({ bindingId: binding.id, chatId: "oc_group", userId: owner, projectId: "second", sessionId: "im-bbb" });
  assert.equal((await store.chatSession(binding.id, "oc_group", "second")).sessionId, "im-bbb");
  await database.query("DELETE FROM evimed_control.projects WHERE user_id=$1 AND id='second'", [owner]);
  assert.equal((await store.chat(binding.id, "oc_group")).projectId, null, "a deleted project leaves the chat without a selection");
  assert.equal(await store.chatSession(binding.id, "oc_group", "second"), null);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'second','Second',1048576)", [owner]);
});

test("an inbound event is recorded once, handled under a lease, and loses its text when done", options, async () => {
  const [binding] = await store.bindingsFor(owner, "feishu");
  const eventKey = `ev_${randomUUID()}`;
  const payload = { eventId: eventKey, chatId: "oc_p2p", text: "阿司匹林的剂量？" };
  const first = await store.recordInbound({ channel: "feishu", eventKey, bindingId: binding.id, userId: owner, payload });
  const again = await store.recordInbound({ channel: "feishu", eventKey, bindingId: binding.id, userId: owner, payload });
  assert.equal(first.inserted, true);
  assert.equal(again.inserted, false, "a re-push is a duplicate");
  const [claimed] = await store.claimInbound({ owner: "worker-a", leaseMs: 60_000 });
  assert.equal(claimed.id, first.event.id);
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(await store.claimInbound({ owner: "worker-b", leaseMs: 60_000 }), [], "a leased event is not claimed twice");
  assert.equal(await store.checkpointInbound(claimed.id, "worker-b", { card: { cardId: "x" } }), false, "only the holder checkpoints");
  assert.equal(await store.checkpointInbound(claimed.id, "worker-a", { card: { cardId: "c1" } }), true);
  assert.equal(await store.finishInbound(claimed.id, "worker-a", { status: "done", outcome: { action: "dispatch" } }), true);
  const { rows } = await database.query("SELECT payload,status,outcome FROM evimed_channels.inbound_events WHERE id=$1", [claimed.id]);
  assert.deepEqual(rows[0].payload, {});
  assert.equal(rows[0].status, "done");
  assert.deepEqual(rows[0].outcome, { action: "dispatch" });
  assert.equal(await store.pruneInbound(new Date(Date.now() + 60_000)) >= 1, true);
});

test("an event whose attempts ran out is closed rather than claimed forever", options, async () => {
  const [binding] = await store.bindingsFor(owner, "feishu");
  const eventKey = `ev_${randomUUID()}`;
  await store.recordInbound({ channel: "feishu", eventKey, bindingId: binding.id, userId: owner, payload: { eventId: eventKey } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [claimed] = await store.claimInbound({ owner: "worker-a", leaseMs: 60_000, maxAttempts: 2 });
    assert.ok(claimed);
    await store.releaseInbound(claimed.id, "worker-a");
  }
  assert.deepEqual(await store.claimInbound({ owner: "worker-a", leaseMs: 60_000, maxAttempts: 2 }), []);
  const closed = await store.closeExhaustedInbound(2);
  assert.ok(closed.some((event) => event.eventKey === eventKey && event.status === "failed"));
});

test("claims are fair: one message per chat at a time, the chat served least recently first, each chat in arrival order", options, async () => {
  // Security review 2026-09-20: the claim was first come across every account,
  // so one chat's burst — each message an intent call of up to 30 s — was
  // handled ahead of every other account's messages.
  const [busy] = await store.bindingsFor(owner, "feishu");
  const { binding: quiet } = await store.replaceBinding(other, "feishu", { externalId: "ou_quiet", credentialRef: "channel.feishu",
    metadata: { appId: `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}`, tenantBrand: "feishu" } });
  // Apart by a few milliseconds: arrival order is `received_at`, kept to the millisecond.
  const record = async (/** @type {any} */ binding, /** @type {string} */ userId, /** @type {string} */ label) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return (await store.recordInbound({ channel: "feishu", eventKey: `ev_fair_${randomUUID()}`, bindingId: binding.id, userId, payload: { label } })).event;
  };
  const claim = async (/** @type {number} */ limit) => (await store.claimInbound({ owner: "worker-a", leaseMs: 60_000, limit }))
    .map((event) => event.payload.label).sort();
  const finish = async (/** @type {string} */ label) => {
    const { rows } = await database.query("SELECT id FROM evimed_channels.inbound_events WHERE payload->>'label'=$1", [label]);
    assert.equal(await store.finishInbound(rows[0].id, "worker-a", { status: "done" }), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  for (const label of ["a0", "a1", "a2", "a3"]) await record(busy, owner, label);
  await record(quiet, other, "b0");
  assert.deepEqual(await claim(5), ["a0", "b0"], "one of the burst, and the other chat's message beside it");
  assert.deepEqual(await claim(5), [], "a chat with a message in hand gets no second");
  await finish("a0");
  await finish("b0");
  await record(quiet, other, "b1");
  assert.deepEqual(await claim(1), ["a1"], "the burst's chat was served longer ago");
  await finish("a1");
  assert.deepEqual(await claim(1), ["b1"], "now the other chat goes first, though a2 arrived before b1");
  await finish("b1");
  assert.deepEqual(await claim(5), ["a2"], "a chat's own messages in the order they came");
  await finish("a2");
  assert.deepEqual(await claim(5), ["a3"]);
  await finish("a3");
});

test("a task is one per run, leased, checkpointed by its holder and settled", options, async () => {
  const [binding] = await store.bindingsFor(owner, "feishu");
  const runId = `run_${randomUUID()}`;
  const task = await store.createTask({ bindingId: binding.id, userId: owner, projectId: "default", chatId: "oc_p2p",
    replyTo: "om_1", sessionId: "im-ccc", runId, card: { cardId: "c1", sequence: 0 } });
  assert.equal((await store.createTask({ bindingId: binding.id, userId: owner, projectId: "default", chatId: "oc_p2p",
    sessionId: "im-ccc", runId })).id, task.id, "idempotent per run");
  assert.equal((await store.openTaskForChat(binding.id, "oc_p2p")).id, task.id);
  const claimed = (await store.claimTasks({ owner: "worker-a", leaseMs: 60_000 })).find((item) => item.id === task.id);
  assert.ok(claimed);
  assert.equal(await store.checkpointTask(task.id, "worker-b", { result: { answered: true } }), false);
  assert.equal(await store.checkpointTask(task.id, "worker-a", { result: { answered: true }, status: "delivering" }), true);
  assert.equal(await store.settleTask(task.id, "worker-a", { status: "done", finished: true }), true);
  const done = await store.taskForRun(owner, "default", runId);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { answered: true });
  assert.ok(done.finishedAt);
  assert.equal(await store.openTaskForChat(binding.id, "oc_p2p"), null);
});

test("a push is queued once per item event and binding, and settled by its holder", options, async () => {
  const [binding] = await store.bindingsFor(owner, "feishu");
  const notifications = new NotificationService(database);
  const item = await notifications.create(owner, { noticeType: "notify", title: "研究已完成", body: "交付 2 个文件。", projectId: "default" });
  const queued = await store.enqueueDelivery({ userId: owner, channel: "feishu", bindingId: binding.id, notificationId: item.id,
    eventCount: 1, notBefore: new Date(Date.now() - 1_000) });
  assert.ok(queued);
  assert.equal(await store.enqueueDelivery({ userId: owner, channel: "feishu", bindingId: binding.id, notificationId: item.id,
    eventCount: 1, notBefore: new Date() }), null);
  assert.equal(await store.hasDelivery(item.id, binding.id, 1), true);
  const [claimed] = (await store.claimDeliveries({ owner: "worker-a", leaseMs: 60_000 })).filter((row) => row.id === queued.id);
  assert.equal(claimed.attempts, 1);
  assert.equal(await store.settleDelivery(queued.id, "worker-b", { status: "sent", messageId: "om_x" }), false);
  assert.equal(await store.settleDelivery(queued.id, "worker-a", { status: "sent", messageId: "om_x" }), true);
  await notifications.recordChannelSent(owner, item.id, "feishu", new Date("2026-09-20T02:00:00Z"));
  const reread = await notifications.get(owner, item.id);
  assert.equal(reread.channelsSent.feishu, "2026-09-20T02:00:00.000Z");
  assert.equal(reread.revision, item.revision, "recording a push does not move the item's revision");
});

test("a device token is shown once, resolves to its account, and every refusal reads the same", options, async () => {
  const tokens = new DeviceTokenStore(database);
  const issued = await tokens.issue(owner, { name: "我的手机", expiresInDays: 30 });
  assert.match(issued.token, /^evd_/);
  assert.equal(issued.tokenPrefix, issued.token.slice(0, 12));
  assert.equal((await tokens.list(owner)).some((row) => "token" in row), false, "the list never carries the secret");
  assert.deepEqual((await tokens.resolve(issued.token)).userId, owner);
  await assert.rejects(tokens.resolve(`${issued.token}x`), { code: "device_token_invalid" });
  await assert.rejects(tokens.resolve("evk_not_a_device_token_at_all"), { code: "device_token_invalid" });
  await tokens.revoke(owner, issued.id);
  await assert.rejects(tokens.resolve(issued.token), { code: "device_token_invalid" });
  await assert.rejects(tokens.revoke(other, issued.id), { code: "device_token_not_found" });
  await assert.rejects(tokens.issue(owner, { name: "x", expiresInDays: 400 }), { code: "device_token_expiry_invalid" });
  const expiring = new DeviceTokenStore(database, { now: () => new Date(Date.now() - 2 * 86_400_000) });
  const stale = await expiring.issue(owner, { name: "旧设备", expiresInDays: 1 });
  await assert.rejects(tokens.resolve(stale.token), { code: "device_token_invalid" });
});

test("deleting the account removes every channel row with it", options, async () => {
  const doomed = `chan_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Doomed','development')", [doomed]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','D',1048576)", [doomed]);
  const { binding } = await store.replaceBinding(doomed, "feishu", { externalId: "ou_d", metadata: { appId: `cli_${randomUUID().replaceAll("-", "").slice(0, 16)}` } });
  await store.ensureChat({ bindingId: binding.id, chatId: "oc_d", userId: doomed, chatType: "p2p" });
  await new DeviceTokenStore(database).issue(doomed, { name: "phone" });
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [doomed]);
  for (const table of ["bindings", "chats", "device_tokens"]) {
    const { rows } = await database.query(`SELECT count(*)::integer AS n FROM evimed_channels.${table} WHERE user_id=$1`, [doomed]);
    assert.equal(rows[0].n, 0, `${table} kept a deleted account's row`);
  }
});
