import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import {
  CHANNEL_IDS, IN_APP_CHANNEL, RESERVED_CHANNEL_IDS, assertChannelAdapter, channelMessage, channelSwitchName, deliveryOutcome,
} from "../src/channels/port.mjs";
import { ChannelRegistry, channelSwitches } from "../src/channels/registry.mjs";
import { createWechatServiceChannel } from "../src/channels/wechatService.mjs";
import { createWechatClawbotChannel } from "../src/channels/wechatClawbot.mjs";
import { createEmailChannel } from "../src/channels/email.mjs";
import { createDingtalkChannel } from "../src/channels/dingtalk.mjs";
import { createWecomChannel } from "../src/channels/wecom.mjs";
import { createAppChannel } from "../src/channels/app.mjs";

const reservedFactories = [createWechatServiceChannel, createWechatClawbotChannel, createEmailChannel, createDingtalkChannel, createWecomChannel];

/** A registry built the way the IM service builds it, with a stand-in Feishu. */
function registry(config) {
  const feishu = { id: "feishu", title: "飞书", status: () => ({ state: "ready" }), bind: async () => ({}),
    deliver: async () => ({ delivered: true, messageId: "om_1" }), onInbound: async () => ({ accepted: true }) };
  return new ChannelRegistry({ adapters: [feishu, ...reservedFactories.map((make) => make()), createAppChannel()], enabled: channelSwitches(config) });
}

test("the channel ids are one closed list, and every reserved id has its switch name", () => {
  assert.deepEqual(CHANNEL_IDS, ["feishu", "wechat-service", "wechat-clawbot", "email", "app", "dingtalk", "wecom"]);
  assert.deepEqual(RESERVED_CHANNEL_IDS, ["wechat-service", "wechat-clawbot", "email", "app", "dingtalk", "wecom"]);
  assert.equal(channelSwitchName("wechat-service"), "OPEN_SCIENCE_CHANNEL_WECHAT_SERVICE_ENABLED");
  assert.equal(channelSwitchName("app"), "OPEN_SCIENCE_CHANNEL_APP_ENABLED");
});

test("each reserved channel is its own adapter file, and each answers not-configured by name", async () => {
  // The walk proves it walked: the directory holds the six reserved files.
  const files = await readdir(new URL("../src/channels/", import.meta.url));
  for (const name of ["wechatService.mjs", "wechatClawbot.mjs", "email.mjs", "app.mjs", "dingtalk.mjs", "wecom.mjs"]) {
    assert.ok(files.includes(name), `${name} is missing from src/channels/`);
  }
  const adapters = [...reservedFactories.map((make) => make()), createAppChannel()];
  assert.deepEqual(adapters.map((adapter) => adapter.id).sort(), [...RESERVED_CHANNEL_IDS].sort());
  for (const adapter of adapters) {
    assert.equal(adapter.status().state, "not-configured", adapter.id);
    assert.deepEqual(await adapter.deliver({}, channelMessage({ title: "t", body: "b" })), { delivered: false, reason: "not-configured" });
    assert.equal((await adapter.onInbound({})).accepted, false);
    if (adapter.id !== "app") {
      await assert.rejects(adapter.bind("u1", {}), { code: "channel_not_configured", status: 409 });
    }
  }
});

test("a delivery without a message id is not a delivery", () => {
  assert.deepEqual(deliveryOutcome({ delivered: true, messageId: "om_1" }), { delivered: true, messageId: "om_1", reason: null });
  assert.deepEqual(deliveryOutcome({ delivered: true }), { delivered: false, messageId: null, reason: "message_id_missing" });
  assert.deepEqual(deliveryOutcome({ delivered: true, messageId: "  " }), { delivered: false, messageId: null, reason: "message_id_missing" });
  assert.deepEqual(deliveryOutcome(null), { delivered: false, messageId: null, reason: "not_delivered" });
  assert.equal(deliveryOutcome({ delivered: false, reason: "not-configured" }).reason, "not-configured");
});

test("a channel message is validated once, before any adapter sees it", () => {
  const message = channelMessage({ title: "  研究已完成 ", body: "交付 2 个文件", link: "https://science.example.com/app/runs?run=r1", severity: "attention" });
  assert.equal(message.title, "研究已完成");
  assert.equal(message.linkLabel, "在网页中查看");
  assert.equal(message.severity, "attention");
  assert.throws(() => channelMessage({ title: "", body: "" }), /title or a body/);
  assert.throws(() => channelMessage({ title: "t", link: "javascript:alert(1)" }), /http/);
  assert.throws(() => channelMessage({ title: "t", link: "/relative" }), /absolute/);
  assert.equal(channelMessage({ title: "t", severity: "loud" }).severity, "info");
});

test("an adapter without the port's shape is refused at composition", () => {
  assert.throws(() => assertChannelAdapter({ id: "pager", status() {}, bind() {}, deliver() {}, onInbound() {} }), /unknown channel/);
  assert.throws(() => assertChannelAdapter({ id: "email", status() {}, bind() {}, deliver() {} }), /onInbound/);
});

test("every channel is off until the IM module is on, and each reserved channel follows its own switch", () => {
  const off = registry({ imEnabled: false, channelEnabled: { email: true } });
  assert.deepEqual(off.enabledIds(), []);
  const on = registry({ imEnabled: true, channelEnabled: { email: true } });
  assert.deepEqual(on.enabledIds(), ["feishu", "email"]);
  const described = on.describe();
  assert.equal(described.length, CHANNEL_IDS.length);
  assert.deepEqual(described.find((row) => row.id === "email"), {
    id: "email", title: "邮件", enabled: true, reserved: true, state: "not-configured", reason: "邮件渠道尚未配置。",
  });
  assert.equal(described.find((row) => row.id === "wecom").state, "disabled");
});

test("preferences take the inbox first plus enabled channels only", () => {
  const on = registry({ imEnabled: true, channelEnabled: {} });
  assert.deepEqual(on.preferenceChannels([IN_APP_CHANNEL]), ["in-app"]);
  assert.deepEqual(on.preferenceChannels(["in-app", "feishu"]), ["in-app", "feishu"]);
  for (const refused of [["feishu"], ["feishu", "in-app"], ["in-app", "email"], ["in-app", "feishu", "feishu"], [], "in-app", ["in-app", 3]]) {
    assert.throws(() => on.preferenceChannels(refused), { code: "notification_preferences_invalid" }, JSON.stringify(refused));
  }
});

test("the module's switches default off and are read from their own variables", () => {
  const saved = {};
  const names = ["OPEN_SCIENCE_IM_ENABLED", "OPEN_SCIENCE_APP_API_ENABLED", ...RESERVED_CHANNEL_IDS.map(channelSwitchName)];
  for (const name of names) { saved[name] = process.env[name]; delete process.env[name]; }
  try {
    const defaults = loadConfig({});
    assert.equal(defaults.imEnabled, false);
    assert.equal(defaults.appApiEnabled, false);
    assert.deepEqual(Object.values(defaults.channelEnabled), [false, false, false, false, false, false]);
    assert.equal(defaults.imProgressIntervalMs, 15_000);
    assert.equal(defaults.imConversationIdleMinutes, 360);
    process.env.OPEN_SCIENCE_IM_ENABLED = "true";
    process.env.OPEN_SCIENCE_CHANNEL_WECHAT_CLAWBOT_ENABLED = "1";
    process.env.OPEN_SCIENCE_APP_API_ENABLED = "yes";
    const set = loadConfig({});
    assert.equal(set.imEnabled, true);
    assert.equal(set.channelEnabled["wechat-clawbot"], true);
    assert.equal(set.channelEnabled.email, false);
    assert.equal(set.appApiEnabled, true);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

/** The smallest database the inbox's preference write needs. */
function preferenceDatabase() {
  const writes = [];
  const row = { quiet_start: "22:00", quiet_end: "08:00", digest_time: "08:00",
    switches: { notify: true, question: true, review: true }, channels: ["in-app"], revision: 2, updated_at: new Date() };
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  return {
    writes,
    transaction: async (operation) => operation(client),
    query: async (sql, values) => {
      writes.push({ sql, values });
      return { rows: [{ ...row, channels: values?.[6] ? JSON.parse(values[6]) : row.channels }], rowCount: 1 };
    },
  };
}

const preferences = { quietHours: { start: "22:00", end: "08:00" }, digestTime: "08:00",
  switches: { notify: true, question: true, review: true } };

test("without the IM module the inbox validates exactly what it always did", async () => {
  const service = new NotificationService(preferenceDatabase());
  assert.deepEqual((await service.updatePreferences("u1", { ...preferences, channels: ["in-app"] }, 1)).channels, ["in-app"]);
  await assert.rejects(service.updatePreferences("u1", { ...preferences, channels: ["in-app", "feishu"] }, 1),
    { code: "notification_preferences_invalid" });
});

test("with the IM module attached a preference may add an enabled channel, and only that", async () => {
  const database = preferenceDatabase();
  const service = new NotificationService(database);
  const changes = [];
  service.attachChannels({ registry: registry({ imEnabled: true, channelEnabled: {} }), onChange: (item) => changes.push(item) });
  const saved = await service.updatePreferences("u1", { ...preferences, channels: ["in-app", "feishu"] }, 1);
  assert.deepEqual(saved.channels, ["in-app", "feishu"]);
  await assert.rejects(service.updatePreferences("u1", { ...preferences, channels: ["in-app", "wecom"] }, 1),
    { code: "notification_preferences_invalid" });
  assert.deepEqual((await service.health()).channels, ["in-app", "feishu"]);
});
