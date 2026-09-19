import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ConnectorCredentialStore } from "../src/connectorCredentials.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ImService } from "../src/imService.mjs";
import { HttpError } from "../src/security.mjs";
import { createFakeFeishuSdk, feishuMessageEvent } from "./fakeFeishuSdk.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `im_${randomUUID()}`;
const user = { id: userId, name: "张三" };

/** @type {any} */ let database;
/** @type {ImService} */ let service;
/** @type {NotificationService} */ let notifications;
/** @type {ReturnType<typeof createFakeFeishuSdk>} */ let fake;
/** @type {string} */ let workspace;
const runs = new Map();
const transcripts = new Map();
const dispatched = [];
const steered = [];
/** @type {any[]} */ const intents = [];

// Worked in an hour ago, and two days ago: "most recently used" is the first.
const projects = {
  default: { id: "default", name: "我的研究", userId, lastActivityAt: new Date(Date.now() - 3_600_000).toISOString() },
  "p-onc": { id: "p-onc", name: "肿瘤免疫", userId, lastActivityAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
};

/** Until the condition holds or the budget runs out. @param {() => Promise<boolean> | boolean} condition */
async function eventually(condition, label, budgetMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'张三','development')", [userId]);
  await database.query(`INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes)
    VALUES($1,'default','我的研究',1048576),($1,'p-onc','肿瘤免疫',1048576)`, [userId]);
  workspace = await mkdtemp(path.join(tmpdir(), "evimed-im-"));
  const credentials = new ConnectorCredentialStore({ database, secret: "s".repeat(40), config: {} });
  await credentials.migrate();
  notifications = new NotificationService(database);
  fake = createFakeFeishuSdk();
  const config = {
    imEnabled: true, imLeaseMs: 60_000, imProgressIntervalMs: 1, imConversationIdleMinutes: 360, imMaxResultFiles: 1,
    publicUrl: "https://science.example.com", channelEnabled: {},
  };
  service = new ImService({
    config, database, credentials, notifications,
    users: {
      userById: async (id) => (id === userId ? user : null),
      listProjects: async () => Object.values(projects).map(({ id, name }) => ({ id, name, archivedAt: null })),
      requireProject: async (_user, id) => ({ ...projects[id], workspaceDir: path.join(workspace, id) }),
      defaultProject: async () => projects.default,
    },
    agentRuns: {
      activitySummary: async (project) => ({ runCount: 1, lastActivityAt: projects[project.id].lastActivityAt }),
      list: async (project) => [...runs.values()].filter((run) => run.projectId === project.id),
      withPlanProgress: async (_project, list) => list,
    },
    runtimeManager: {
      sessionTranscript: async (_project, sessionId) => {
        if (!transcripts.has(sessionId)) throw new HttpError(409, "runtime_not_running", "not running");
        return { sessionId, messages: transcripts.get(sessionId) };
      },
    },
    dispatchRun: async ({ project, sessionId, dispatchId, text }) => {
      dispatched.push({ projectId: project.id, sessionId, dispatchId, text });
      const existing = [...runs.values()].find((run) => run.dispatchId === dispatchId);
      if (existing) return existing;
      const run = { id: `run_${randomUUID().slice(0, 8)}`, projectId: project.id, sessionId, dispatchId, question: text,
        status: "running", startedAt: new Date().toISOString(), effectiveAgentId: "open-domain-answer" };
      runs.set(run.id, run);
      return run;
    },
    steerRun: async ({ runId, text }) => { steered.push({ runId, text }); return { corrections: 1 }; },
    classifier: { classify: async () => intents.shift() ?? { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "skipped" } },
    loadSdk: async () => fake.sdk,
    write: () => {},
  });
  notifications.attachChannels({ registry: service.registry, onChange: (item) => { void service.notificationChanged(item); } });
});

after(async () => {
  if (!database) return;
  await service.close();
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  await database.close();
  await rm(workspace, { recursive: true, force: true });
});

test("scanning creates the bot, keeps its secret, turns pushes on, connects, and says hello", options, async () => {
  const started = service.startRegistration(user);
  assert.equal(started.state, "starting");
  await eventually(() => fake.waitingForScan, "the QR code");
  const waiting = service.registration(user);
  assert.match(waiting.qrCodeUrl, /tp=sdk/);
  const asked = fake.callsTo("registerApp")[0].args;
  assert.equal(asked.createOnly, true);
  assert.equal(asked.appPreset.avatar, "https://science.example.com/icons/evimed-512.png");
  assert.match(asked.appPreset.desc, /https:\/\/science\.example\.com\/app\/chat/);
  assert.deepEqual(asked.addons.events.items.tenant, ["im.message.receive_v1"]);
  fake.scan();
  await eventually(() => service.registration(user).state === "succeeded", "registration to finish");
  const status = await service.status(user);
  assert.equal(status.feishu.bound, true);
  assert.equal(status.feishu.activation, "active");
  assert.equal(status.feishu.notifications, true);
  assert.equal(JSON.stringify(status).includes("fake-app-secret"), false, "the status never carries the secret");
  assert.equal((await notifications.preferences(userId)).channels.join(","), "in-app,feishu");
  const [binding] = await service.store.bindingsFor(userId, "feishu");
  await eventually(() => service.connections.status(binding.id)?.state === "connected", "the long connection");
  assert.equal(fake.wsClients.length, 1);
  const welcome = fake.callsTo("message.create").find((call) => call.args.params.receive_id_type === "open_id");
  assert.match(JSON.parse(welcome.args.data.content).text, /EviMed 研究助手/);
});

test("a message becomes a run in the most recent project, with a card that tracks it and a result that follows it", options, async () => {
  const inbound = feishuMessageEvent({ eventId: "ev-dispatch", messageId: "om_q1", chatId: "oc_p2p", text: "阿司匹林一级预防的最新证据？" });
  await fake.wsClients[0].deliver(inbound);
  await fake.wsClients[0].deliver(inbound);
  assert.equal(service.counters.get("inbound_duplicate"), 1, "a re-push is recorded once");
  await service.processInbound();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].projectId, "default", "the project worked in most recently");
  assert.match(dispatched[0].sessionId, /^im-[0-9a-f]{24}$/);
  assert.match(dispatched[0].dispatchId, /^im-[0-9a-f]{32}$/);
  const reply = fake.callsTo("message.reply").find((call) => call.args.path.message_id === "om_q1");
  assert.equal(JSON.parse(reply.args.data.content).type, "card", "the acknowledgement is the task's card, as a reply");
  const run = runs.get([...runs.keys()][0]);

  await eventually(async () => { await service.processTasks(); return fake.callsTo("cardElement.content").length > 0; },
    "the first progress update");
  const streamed = fake.callsTo("cardElement.content").map((call) => call.args.data.content);
  assert.ok(streamed.some((content) => content.startsWith("⏳ 进行中 · 普通问答")), streamed.join(" | "));

  // The run ends with an answer and two delivered files: the first is sent,
  // the second is past this deployment's per-task file count and is linked.
  await mkdir(path.join(workspace, "default", "deliverables", "report"), { recursive: true });
  await writeFile(path.join(workspace, "default", "deliverables", "report", "report.md"), "# 阿司匹林一级预防\n\n结论。");
  await writeFile(path.join(workspace, "default", "deliverables", "report", "matrix.xlsx"), "x");
  Object.assign(run, {
    status: "succeeded", finishedAt: new Date(Date.now() + 1_000).toISOString(),
    artifacts: ["deliverables/report/report.md", "deliverables/report/matrix.xlsx"],
    artifactKinds: { "deliverables/report/report.md": "deliverable", "deliverables/report/matrix.xlsx": "deliverable" },
    artifactCounts: { deliverable: 2, revisionNotes: 0, work: 0, superseded: 0 },
  });
  transcripts.set(run.sessionId, [{ role: "assistant", time: Date.now(), parts: [{ type: "text", text: "结论：70 岁以上人群一级预防获益有限。" }] }]);
  // The tracker looks again once its progress interval has passed.
  await eventually(async () => { await service.processTasks(); return (await service.store.taskForRun(userId, "default", run.id)).status === "done"; },
    "the result to be delivered");
  const closing = JSON.parse(fake.callsTo("card.update").at(-1).args.data.card.data);
  assert.equal(closing.header.template, "green");
  assert.match(closing.body.elements[0].content, /研究已完成/);
  const answer = fake.callsTo("message.reply").find((call) => call.args.path.message_id === "om_q1"
    && JSON.parse(call.args.data.content).body?.elements?.[0]?.content?.includes("获益有限"));
  assert.ok(answer, "the answer replies to the question");
  assert.equal(fake.callsTo("file.create").length, 1);
  assert.equal(fake.callsTo("file.create")[0].args.data.file_name, "report.md");
  const links = fake.callsTo("message.create").map((call) => call.args.data.content).find((content) => content.includes("matrix.xlsx"));
  assert.match(links, /https:\/\/science\.example\.com\/app\/runs\/run_[^/]+\/files\/deliverables\/report\/matrix\.xlsx/);
  const task = await service.store.taskForRun(userId, "default", run.id);
  assert.equal(task.status, "done");
  assert.equal(task.result.answered, true);

  // The inbox's own notice about this run is the record, not a second buzz.
  const item = await notifications.create(userId, { noticeType: "notify", title: "研究已完成", body: "交付 2 个文件。",
    projectId: "default", source: { type: "run", id: run.id } });
  await service.notificationChanged(item);
  assert.equal(await service.store.hasDelivery(item.id, task.bindingId, 1), false);
});

test("a follow-up continues the chat's conversation; a supplement to a running task is steered into it", options, async () => {
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-follow", messageId: "om_q2", chatId: "oc_p2p", text: "那剂量呢？" }));
  await service.processInbound();
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].sessionId, dispatched[0].sessionId, "within the idle window the same conversation continues");
  intents.push({ switchTo: null, hasRequest: true, continuesRunningTask: true, source: "model" });
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-steer", messageId: "om_q3", chatId: "oc_p2p", text: "再加上老年人群" }));
  await service.processInbound();
  assert.equal(dispatched.length, 2, "a supplement starts no new run");
  assert.equal(steered.length, 1);
  assert.equal(steered[0].text, "再加上老年人群");
  const said = fake.callsTo("message.reply").filter((call) => call.args.path.message_id === "om_q3").map((call) => JSON.parse(call.args.data.content).text);
  assert.deepEqual(said, ["已收到补充，正在进行的任务会把它一并考虑进去。"]);
});

test("\"换到肿瘤项目\" moves the chat; the next question runs there", options, async () => {
  intents.push({ switchTo: "p-onc", hasRequest: false, continuesRunningTask: false, source: "model" });
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-switch", messageId: "om_q4", chatId: "oc_p2p", text: "换到肿瘤免疫项目" }));
  await service.processInbound();
  const said = fake.callsTo("message.reply").filter((call) => call.args.path.message_id === "om_q4").map((call) => JSON.parse(call.args.data.content).text);
  assert.deepEqual(said, ["好的，之后在这里发的问题都放进「肿瘤免疫」项目。"]);
  // The newest running task is still the earlier one; this question is separate.
  intents.push({ switchTo: null, hasRequest: true, continuesRunningTask: false, source: "model" });
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-onc", messageId: "om_q5", chatId: "oc_p2p", text: "PD-1 抑制剂的心肌炎发生率？" }));
  await service.processInbound();
  assert.equal(dispatched.at(-1).projectId, "p-onc");
  assert.notEqual(dispatched.at(-1).sessionId, dispatched[0].sessionId, "another project is another conversation");
});

test("a refused dispatch is said in the card in the domain's words, and a picture gets an honest reply", options, async () => {
  const original = service.dispatchRun;
  service.dispatchRun = async () => { throw new HttpError(429, "usage_budget_exceeded", "cap"); };
  try {
    await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-cap", messageId: "om_q6", chatId: "oc_p2p", text: "再做一份报告" }));
    await service.processInbound();
  } finally {
    service.dispatchRun = original;
  }
  const closed = JSON.parse(fake.callsTo("card.update").at(-1).args.data.card.data);
  assert.equal(closed.header.template, "red");
  assert.match(closed.body.elements[0].content, /没有开始：这次请求会超出账户设定的用量上限/);
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev-img", messageId: "om_q7", chatId: "oc_p2p", messageType: "image",
    content: JSON.stringify({ image_key: "img_1" }) }));
  await service.processInbound();
  const said = fake.callsTo("message.reply").filter((call) => call.args.path.message_id === "om_q7").map((call) => JSON.parse(call.args.data.content).text);
  assert.match(said[0], /目前只能处理文字消息/);
});

test("an inbox item reaches the owner's chat once, recorded on the item, and a grown group sends only its newest total", options, async () => {
  const current = await notifications.preferences(userId);
  // No quiet hours for this test: it must not depend on the hour it runs at.
  await notifications.updatePreferences(userId, { quietHours: { start: "00:00", end: "00:00" }, digestTime: "08:00",
    switches: current.switches, channels: current.channels }, current.revision);
  const item = await notifications.create(userId, { noticeType: "notify", title: "记忆有更新", body: "一条偏好被修改。",
    source: { type: "memory", id: "rec_1" }, groupKey: "memory-change" });
  await eventually(async () => (await service.store.query("SELECT 1 FROM evimed_channels.deliveries WHERE notification_id=$1", [item.id])).rowCount === 1,
    "the push to be queued by the inbox hook");
  const grown = await notifications.create(userId, { noticeType: "notify", title: "记忆有两处更新", body: "两条偏好被修改。",
    source: { type: "memory", id: "rec_1" }, groupKey: "memory-change" });
  assert.equal(grown.count, 2);
  await eventually(async () => (await service.store.query("SELECT 1 FROM evimed_channels.deliveries WHERE notification_id=$1", [item.id])).rowCount === 2,
    "the grown group to be queued");
  const before = fake.callsTo("message.create").length;
  await service.processDeliveries();
  const pushes = fake.callsTo("message.create").slice(before);
  assert.equal(pushes.length, 1, "the older total is superseded, the newest is sent");
  const card = JSON.parse(pushes[0].args.data.content);
  assert.equal(card.header.title.content, "记忆有两处更新");
  assert.equal(card.body.elements[1].behaviors[0].default_url, "https://science.example.com/app/memory?record=rec_1");
  assert.equal(pushes[0].args.data.receive_id, "ou_owner");
  assert.ok((await notifications.get(userId, item.id)).channelsSent.feishu);
  // Read on the page before its push went: nothing is sent.
  const read = await notifications.create(userId, { noticeType: "notify", title: "另一条", body: "已在网页读过。" });
  await eventually(async () => (await service.store.query("SELECT 1 FROM evimed_channels.deliveries WHERE notification_id=$1", [read.id])).rowCount === 1,
    "the third push to be queued");
  await notifications.markRead(userId, read.id, read.revision);
  const count = fake.callsTo("message.create").length;
  await service.processDeliveries();
  assert.equal(fake.callsTo("message.create").length, count);
  assert.equal(service.counters.get("push_skipped_already_read"), 1);
});

test("a crash between the inbox's commit and the hook is repaired by the reconcile pass", options, async () => {
  notifications.attachChannels({ registry: service.registry, onChange: () => {} });
  const missed = await notifications.create(userId, { noticeType: "notify", title: "错过的通知", body: "钩子没有运行。" });
  notifications.attachChannels({ registry: service.registry, onChange: (item) => { void service.notificationChanged(item); } });
  const [binding] = await service.store.bindingsFor(userId, "feishu");
  assert.equal(await service.store.hasDelivery(missed.id, binding.id, 1), false);
  assert.ok(await service.reconcilePushes() >= 1);
  assert.equal(await service.store.hasDelivery(missed.id, binding.id, 1), true);
});

test("a file too large for Feishu is linked instead, and unbinding takes the bot, its secret and its pushes away", options, async () => {
  const run = { id: `run_big_${randomUUID().slice(0, 6)}`, projectId: "default", sessionId: "im-bigfile", dispatchId: "im-big", question: "大文件",
    status: "succeeded", startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(),
    artifacts: ["deliverables/big/data.csv"], artifactKinds: { "deliverables/big/data.csv": "deliverable" } };
  runs.set(run.id, run);
  await mkdir(path.join(workspace, "default", "deliverables", "big"), { recursive: true });
  const big = path.join(workspace, "default", "deliverables", "big", "data.csv");
  await writeFile(big, "");
  await truncate(big, 31 * 1024 * 1024);
  const [binding] = await service.store.bindingsFor(userId, "feishu");
  await service.store.createTask({ bindingId: binding.id, userId, projectId: "default", chatId: "oc_p2p", sessionId: run.sessionId,
    runId: run.id, card: { cardId: "card_existing", messageId: "om_card", sequence: 3, question: "大文件" } });
  const uploads = fake.callsTo("file.create").length;
  await service.processTasks();
  assert.equal(fake.callsTo("file.create").length, uploads, "nothing over 30 MB is uploaded");
  const linked = fake.callsTo("message.create").map((call) => call.args.data.content).find((content) => content.includes("data.csv"));
  assert.ok(linked);

  const removed = await service.unbind(user);
  assert.equal(removed.removed, 1);
  assert.equal((await service.store.bindingsFor(userId, "feishu")).length, 0);
  assert.equal(await service.credentials.resolveChannelSecret(userId, "channel.feishu"), null);
  assert.equal((await notifications.preferences(userId)).channels.join(","), "in-app");
  assert.equal(fake.wsClients[0].closed, true);
  assert.equal((await service.status(user)).feishu.bound, false);
});
