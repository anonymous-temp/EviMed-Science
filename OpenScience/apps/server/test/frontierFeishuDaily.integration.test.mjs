// The 07:30 daily reaches a reader's bound Feishu (2026-10-22, owner: the Feishu daily push is on): the issue is composed through
// its job, pushed to the reader's inbox at their digest time, queued for their Feishu binding by the inbox hook under the
// frontier delivery policy, and sent by the IM worker as one card that opens the issue. Real PostgreSQL, the real inbox, IM
// service and frontier modules; the Feishu SDK is the fake the IM tests use.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ConnectorCredentialStore } from "../src/connectorCredentials.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierDaily } from "../src/frontierDaily.mjs";
import { FrontierNotifications } from "../src/frontierNotifications.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { ImService } from "../src/imService.mjs";
import { FRONTIER_PROJECT_ID } from "../src/internalProjects.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { createFakeFeishuSdk } from "./fakeFeishuSdk.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, resetFrontier } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const operator = `feishu_op_${suffix}`;
const reader = { id: `feishu_reader_${suffix}`, name: "读者" };
const DAY = "2026-09-22";
/** 07:31 and 08:05 in Beijing on the issue's day. */
const COMPOSED = new Date("2026-09-21T23:31:00Z");
const PUSHED = new Date("2026-09-22T00:05:00Z");
let clock = COMPOSED;
/** @type {any} */ let database;
/** @type {any} */ let im;
/** @type {any} */ let notifications;
/** @type {any} */ let fake;
/** @type {string} */ let workspace;

/** Until the condition holds or the budget runs out. @param {() => Promise<boolean>} condition @param {string} label */
async function eventually(condition, label, budgetMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const config = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [operator], frontierPreviewUsers: [], frontierDailyTime: "07:30",
  frontierTimeZone: "Asia/Shanghai", imEnabled: true, imLeaseMs: 60_000, publicUrl: "https://science.example.com", channelEnabled: {} };

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateProductStore(database);
  for (const [id, name] of [[operator, "运营"], [reader.id, reader.name]]) {
    await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $2, 'development')", [id, name]);
  }
  await database.query("INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, 'EviMed 前沿动态', 1000000)", [operator, FRONTIER_PROJECT_ID]);
  workspace = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "fr-feishu-"));
  const credentials = new ConnectorCredentialStore({ database, secret: "s".repeat(40), config: {} });
  await credentials.migrate();
  notifications = new NotificationService(database);
  fake = createFakeFeishuSdk();
  const frontierNotifications = new FrontierNotifications({ database, notifications, config, now: () => clock });
  im = new ImService({
    config, database, credentials, notifications, now: () => clock.getTime(),
    users: { userById: async (id) => (id === reader.id ? reader : null), listProjects: async () => [], requireProject: async () => null, defaultProject: async () => null },
    agentRuns: { activitySummary: async () => ({ runCount: 0 }), list: async () => [], withPlanProgress: async (_project, list) => list },
    runtimeManager: {}, dispatchRun: async () => null, steerRun: async () => null,
    classifier: { classify: async () => ({ switchTo: null, hasRequest: false, continuesRunningTask: false, source: "skipped" }) },
    loadSdk: async () => fake.sdk, write: () => {},
    // What production composes (server.mjs): a frontier notice goes out only while the reader may still be told it.
    frontierDeliveryPolicy: (item) => frontierNotifications.deliveryAllowed(item),
  });
  notifications.attachChannels({ registry: im.registry, onChange: (item) => { void im.notificationChanged(item); } });
});

after(async () => {
  if (!database) return;
  await im.close();
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = $1", [operator]);
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[operator, reader.id]]);
  await resetFrontier(database);
  await database.close();
  await rm(workspace, { recursive: true, force: true });
});

test("the daily reaches a bound Feishu reader once, as a card that opens the issue, at their digest time", options, async () => {
  // The reader scans once (设置 → 通知 → 飞书): a bot of their own, pushes on.
  im.startRegistration(reader);
  await eventually(async () => fake.waitingForScan, "the QR code");
  fake.scan();
  await eventually(async () => im.registration(reader).state === "succeeded", "the registration");
  assert.equal((await notifications.preferences(reader.id)).channels.join(","), "in-app,feishu");
  // News from before a binding existed is never pushed: the binding is older than this test's fixed clock.
  await database.query("UPDATE evimed_channels.bindings SET created_at = '2026-01-01T00:00:00Z' WHERE user_id = $1", [reader.id]);
  const prefs = await notifications.preferences(reader.id);
  await notifications.updatePreferences(reader.id, { quietHours: { start: "00:00", end: "00:00" }, digestTime: "08:00", switches: prefs.switches,
    channels: prefs.channels }, prefs.revision);

  await resetFrontier(database);
  await insertSource(database, "nejm", { authority: 5 });
  await insertComposedItem(database, { title: "Semaglutide trial", titleZh: "司美格鲁肽降低心血管事件", summaryZh: "导读。", selected: true,
    selectedRule: "threshold", scoreTotal: 90, visibleAt: "2026-09-21T03:00:00Z", timelineAt: "2026-09-21T03:00:00Z" });
  // The reader opened the feed this week: the daily is for them.
  await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [reader.id, new Date("2026-09-21T10:00:00Z")]);

  const jobs = new ProductJobs(database);
  const daily = new FrontierDaily({ database, jobs, notifications, editor: null, config, owner: () => ({ userId: operator, projectId: FRONTIER_PROJECT_ID }),
    now: () => clock, workerId: "test-feishu-daily" });
  clock = COMPOSED;
  assert.equal((await daily.runDue()).ran, true);
  assert.equal((await daily.pushDue()).pushed, 0, "before the reader's 08:00 nothing is pushed");

  clock = PUSHED;
  assert.equal((await daily.pushDue()).pushed, 1);
  const delivery = async () => (await database.query(`SELECT d.status, d.channel FROM evimed_channels.deliveries d
    JOIN evimed_inbox.notifications n ON n.id = d.notification_id WHERE n.user_id = $1 AND n.source->>'id' = $2`, [reader.id, `frontier-daily:${DAY}`])).rows;
  await eventually(async () => (await delivery()).length === 1, "the inbox hook to queue the Feishu push");
  const before = fake.callsTo("message.create").length;
  await im.processDeliveries();
  const sent = fake.callsTo("message.create").slice(before);
  assert.equal(sent.length, 1, "one card");
  const card = JSON.parse(sent[0].args.data.content);
  assert.equal(card.header.title.content, "今日前沿 · 9月22日 · 1 条精选");
  assert.match(JSON.stringify(card), /司美格鲁肽降低心血管事件/, "the lead's title is the card's body");
  assert.equal(card.body.elements[1].behaviors[0].default_url, `https://science.example.com/app/frontier?view=daily&day=${DAY}`);
  assert.equal(sent[0].args.data.receive_id, "ou_owner", "the person who scanned");
  assert.deepEqual((await delivery()).map((row) => row.status), ["sent"]);
  // Once a day: a second scan pushes nothing, and the IM worker has nothing left to send.
  assert.equal((await daily.pushDue()).pushed, 0);
  await im.processDeliveries();
  assert.equal(fake.callsTo("message.create").length, before + 1);
});
