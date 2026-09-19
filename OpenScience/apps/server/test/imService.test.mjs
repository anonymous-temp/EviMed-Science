import assert from "node:assert/strict";
import test from "node:test";
import { FEISHU_UNBIND_ACTION, ImService, appLink, finalReplyText, noticeLink, progressView, pushNotBefore, runFileLink, runLink } from "../src/imService.mjs";

/** A moment given in China Standard Time. @param {string} local "YYYY-MM-DDTHH:MM" */
const cst = (local) => new Date(`${local}:00+08:00`);
const preferences = { quietHours: { start: "22:00", end: "08:00" }, digestTime: "08:30" };

test("a push waits out the researcher's quiet hours, read in China Standard Time", () => {
  const notice = { severity: "info", source: { type: "run", id: "r1" } };
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-20T15:00")).toISOString(), cst("2026-09-20T15:00").toISOString());
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-21T08:00").toISOString());
  assert.equal(pushNotBefore(notice, preferences, cst("2026-09-21T03:00")).toISOString(), cst("2026-09-21T08:00").toISOString());
  // A window that does not wrap midnight, and one that is empty.
  assert.equal(pushNotBefore(notice, { quietHours: { start: "12:00", end: "14:00" } }, cst("2026-09-20T13:00")).toISOString(),
    cst("2026-09-20T14:00").toISOString());
  assert.equal(pushNotBefore(notice, { quietHours: { start: "00:00", end: "00:00" } }, cst("2026-09-20T03:00")).toISOString(),
    cst("2026-09-20T03:00").toISOString());
});

test("a clinical-safety finding interrupts; a digest waits for the morning", () => {
  assert.equal(pushNotBefore({ severity: "safety" }, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-20T23:10").toISOString());
  const digest = { severity: "info", source: { type: "digest", id: "d1" } };
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-21T03:00")).toISOString(), cst("2026-09-21T08:30").toISOString(),
    "written during the night, sent at the digest time");
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-20T23:10")).toISOString(), cst("2026-09-21T08:30").toISOString(),
    "written after the evening's quiet start, sent the next morning");
  assert.equal(pushNotBefore(digest, preferences, cst("2026-09-20T14:00")).toISOString(), cst("2026-09-20T14:00").toISOString(),
    "written in the afternoon, sent now");
});

test("the progress card says how long, which line, and what the run observed — nothing it did not", () => {
  const now = Date.parse("2026-09-20T10:15:00Z");
  const plain = progressView({ startedAt: "2026-09-20T10:14:30Z", effectiveAgentId: "open-domain-answer" }, now);
  assert.equal(plain.status, "⏳ 进行中 · 普通问答 · 已用 1 分钟");
  assert.equal(plain.progress, "", "a plain question that made no tool call shows no phase");
  const deep = progressView({
    startedAt: "2026-09-20T10:00:00Z", effectiveAgentId: "clinical-evidence-synthesis", estimatedMinutes: { min: 15, max: 30 },
    progress: {
      currentPhase: "search", sources: { searched: 42, included: 12, fullText: 5 }, claims: { total: 8, verified: 6 },
      deliverables: [{ id: "d1", title: "临床证据报告", status: "accepted" }, { id: "d2", title: "证据矩阵", status: "planned" }],
    },
  }, now);
  assert.match(deep.status, /^⏳ 进行中 · .+ · 已用 15 分钟 · 通常 15–30 分钟$/);
  assert.equal(deep.progress, ["当前：检索", "文献：检索 42 · 纳入 12 · 全文 5", "结论核验：6/8", "✓ 临床证据报告", "· 证据矩阵"].join("\n"));
});

test("the answer is the run's last assistant text inside its own window", () => {
  const run = { startedAt: "2026-09-20T10:00:00Z", finishedAt: "2026-09-20T10:05:00Z" };
  const at = (iso) => Date.parse(iso);
  const messages = [
    { role: "assistant", time: at("2026-09-20T09:00:00Z"), parts: [{ type: "text", text: "上一轮的回答" }] },
    { role: "user", time: at("2026-09-20T10:00:01Z"), parts: [{ type: "text", text: "问题" }] },
    { role: "assistant", time: at("2026-09-20T10:04:00Z"), parts: [{ type: "reasoning", text: "思考" }, { type: "text", text: "这一轮的回答" }] },
    { role: "assistant", time: at("2026-09-20T10:04:30Z"), parts: [{ type: "tool", tool: "write" }] },
    { role: "assistant", time: at("2026-09-20T10:20:00Z"), parts: [{ type: "text", text: "下一轮的回答" }] },
  ];
  assert.equal(finalReplyText(messages, run), "这一轮的回答");
  assert.equal(finalReplyText(messages.slice(0, 2), run), null, "an earlier turn's answer is not this run's");
});

test("links go to the web app's own routes, and there are none without a public URL", () => {
  const config = { publicUrl: "https://science.example.com/" };
  assert.equal(appLink(config, "/app/chat"), "https://science.example.com/app/chat");
  assert.equal(runLink(config, "run_1"), "https://science.example.com/app/runs?run=run_1");
  assert.equal(runFileLink(config, "run_1", "deliverables/报告/report 1.md"),
    "https://science.example.com/app/runs/run_1/files/deliverables/%E6%8A%A5%E5%91%8A/report%201.md");
  assert.equal(noticeLink(config, { source: { type: "digest", id: "d 1" } }), "https://science.example.com/app/autopilot?digest=d%201");
  assert.equal(noticeLink(config, { source: null }), "https://science.example.com/app/inbox");
  assert.equal(runLink({ publicUrl: "" }, "run_1"), null);
  assert.equal(runLink({ publicUrl: "science.example.com" }, "run_1"), null);
});

// --- scan to create: the bot acts for whoever scanned --------------------------------

/** @param {number} ms */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {() => boolean} condition @param {string} label */
async function eventually(condition, label) {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (condition()) return;
    await tick(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * The IM service with Feishu's device flow completed by `scanner` when the
 * test says (`scan()`), and the bot lookup `bind` runs before it keeps
 * anything held until the test releases it (`releaseBot()`) — the window in
 * which the security review (2026-09-20) cancelled a save and got a bound bot.
 * @param {{ scanner?: string, now?: () => number }} [options]
 */
function scanRig({ scanner = "ou_scanner_0000001", now = Date.now } = {}) {
  /** @type {() => void} */ let releaseBot = () => {};
  const botReady = new Promise((resolve) => { releaseBot = () => resolve(undefined); });
  /** @type {() => void} */ let scan = () => {};
  const scanned = new Promise((resolve) => { scan = () => resolve(undefined); });
  /** @type {any[]} */ const sent = [];
  class Client {
    request = async () => { await botReady; return { code: 0, bot: { app_name: "Mallory 的 EviMed 研究助手", open_id: "ou_bot", activate_status: 2 } }; };
    im = { v1: { message: { create: async (/** @type {any} */ payload) => { sent.push(payload); return { code: 0, data: { message_id: `om_${sent.length}` } }; } } } };
  }
  const sdk = {
    Client, Domain: {}, LoggerLevel: {}, defaultHttpInstance: null,
    EventDispatcher: class { register() { return this; } },
    WSClient: class { async start() {} close() {} },
    registerApp: async (/** @type {any} */ { onQRCodeReady }) => {
      onQRCodeReady({ url: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH&tp=sdk", expireIn: 600 });
      await scanned;
      return { client_id: "cli_a1b2c3d4e5f6", client_secret: "S".repeat(32), user_info: { open_id: scanner, tenant_brand: "feishu" } };
    },
  };
  /** @type {any[]} */ const bindings = [];
  /** @type {any[]} */ const notices = [];
  /** @type {any[]} */ const preferenceChanges = [];
  /** @type {any[]} */ const deliveries = [];
  const secrets = new Map();
  let created = 0;
  const store = {
    replaceBinding: async (/** @type {string} */ userId, /** @type {string} */ channel, /** @type {any} */ input) => {
      const binding = { id: `chb_${++created}`, userId, channel, externalId: input.externalId, credentialRef: input.credentialRef,
        metadata: input.metadata, status: "active", createdAt: new Date(now() - 1_000).toISOString() };
      const replaced = bindings.splice(0);
      bindings.push(binding);
      return { binding, replaced };
    },
    activeBindings: async () => bindings.filter((binding) => binding.status === "active"),
    bindingsFor: async (/** @type {string} */ userId, /** @type {string} */ channel) => bindings.filter((binding) => binding.userId === userId && binding.channel === channel),
    deleteBinding: async (/** @type {string} */ userId, /** @type {string} */ id) => {
      const index = bindings.findIndex((binding) => binding.userId === userId && binding.id === id);
      return index < 0 ? null : bindings.splice(index, 1)[0];
    },
    taskForRun: async () => null,
    enqueueDelivery: async (/** @type {any} */ row) => { deliveries.push(row); return row; },
  };
  const service = new ImService({
    config: { imEnabled: true, publicUrl: "https://science.example.com" }, database: null,
    credentials: {
      setChannelSecret: async (/** @type {string} */ userId, /** @type {string} */ ref, /** @type {string} */ value) => { secrets.set(`${userId}:${ref}`, value); },
      resolveChannelSecret: async (/** @type {string} */ userId, /** @type {string} */ ref) => secrets.get(`${userId}:${ref}`) ?? null,
      removeChannelSecret: async (/** @type {string} */ userId, /** @type {string} */ ref) => secrets.delete(`${userId}:${ref}`),
    },
    notifications: {
      setPreferenceChannel: async (/** @type {string} */ userId, /** @type {string} */ channel, /** @type {boolean} */ enabled) => { preferenceChanges.push([userId, channel, enabled]); },
      create: async (/** @type {string} */ userId, /** @type {any} */ input) => { const item = { id: `n${notices.length + 1}`, userId, ...input }; notices.push(item); return item; },
      preferences: async () => ({ channels: ["in-app", "feishu"] }),
    },
    users: { userById: async (/** @type {string} */ id) => ({ id, name: "Alice" }) },
    agentRuns: {}, runtimeManager: {}, dispatchRun: async () => {}, steerRun: async () => {},
    loadSdk: async () => sdk, store: /** @type {any} */ (store), classifier: { classify: async () => ({}) }, write: () => {}, now,
  });
  return { service, bindings, notices, preferenceChanges, deliveries, secrets, sent, scan, releaseBot };
}

const alice = { id: "alice", name: "Alice" };

test("cancelling while a scan is being saved binds nothing", async () => {
  const rig = scanRig();
  try {
    rig.service.startRegistration(alice);
    await eventually(() => rig.service.registration(alice).state === "qr_ready", "the QR code");
    rig.scan();
    await eventually(() => rig.service.registration(alice).state === "saving", "the save");
    assert.equal(rig.service.cancelRegistration(alice).state, "cancelled");
    rig.releaseBot();
    await tick(20);
    assert.equal(rig.service.registration(alice).state, "cancelled");
    assert.deepEqual(rig.bindings, [], "the scanner's bot is not bound");
    assert.equal(rig.secrets.size, 0, "nor its secret kept");
    assert.deepEqual(rig.preferenceChanges, [], "nor pushes turned on");
    assert.deepEqual(rig.notices, []);
  } finally { await rig.service.close(); }
});

test("a scan completed after the sign-in that started it has ended binds nothing, and says why", async () => {
  const rig = scanRig();
  let signedIn = true;
  try {
    rig.service.startRegistration(alice, { signedIn: async () => signedIn });
    await eventually(() => rig.service.registration(alice).state === "qr_ready", "the QR code");
    signedIn = false;
    rig.scan();
    rig.releaseBot();
    await eventually(() => rig.service.registration(alice).state === "error", "the refusal");
    const { error } = rig.service.registration(alice);
    assert.equal(error.code, "feishu_registration_signed_out");
    assert.match(error.message, /登录已经退出，没有绑定/);
    assert.deepEqual(rig.bindings, []);
    assert.equal(rig.secrets.size, 0);
  } finally { await rig.service.close(); }
});

test("credentials that arrive after the code expired bind nothing, even before the expiry timer fires", async () => {
  let clock = Date.parse("2026-09-20T08:00:00.000Z");
  const rig = scanRig({ now: () => clock });
  try {
    rig.service.startRegistration(alice);
    await tick(5);
    clock += 601_000;
    rig.scan();
    rig.releaseBot();
    await tick(20);
    assert.equal(rig.service.registration(alice).state, "expired");
    assert.deepEqual(rig.bindings, []);
  } finally { await rig.service.close(); }
});

test("every bind is said on both sides, and a notice's 「解除绑定」 takes away that binding and never a later one", async () => {
  const rig = scanRig({ scanner: "ou_mallory_0000001" });
  try {
    rig.service.startRegistration(alice, { signedIn: async () => true });
    await tick(5);
    rig.scan();
    rig.releaseBot();
    await eventually(() => rig.service.registration(alice).state === "succeeded", "the bind");
    const [first] = rig.bindings;
    assert.equal(first.externalId, "ou_mallory_0000001");
    // The account's side: who is bound, and one click to undo it.
    const [notice] = rig.notices;
    assert.equal(notice.userId, "alice");
    assert.equal(notice.severity, "attention");
    assert.match(notice.body, /绑定的飞书身份：机器人「Mallory 的 EviMed 研究助手」的创建人，飞书用户 ou_mall…0001/);
    assert.deepEqual(notice.actions, [{ id: FEISHU_UNBIND_ACTION, label: "解除绑定", style: "danger" }]);
    assert.deepEqual(notice.source, { type: "system", id: `feishu-binding:${first.id}` });
    // The bot's side: whoever scanned is told which account it now works for.
    const welcome = JSON.parse(rig.sent.find((payload) => payload.params?.receive_id_type === "open_id").data.content).text;
    assert.match(welcome, /这个机器人绑定的是 EviMed 账号「Alice」/);
    assert.match(welcome, /https:\/\/science\.example\.com\/app\/account\?tab=phone/);
    // Said to the bot already, so the notice is not pushed to it a second time; other news is.
    await rig.service.notificationChanged({ ...notice, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await rig.service.notificationChanged({ id: "n-other", userId: "alice", noticeType: "notify", source: { type: "run", id: "r1" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    assert.deepEqual(rig.deliveries.map((row) => row.notificationId), ["n-other"]);

    // A second scan replaces the binding: the first notice's 「解除绑定」 leaves it alone.
    rig.service.startRegistration(alice, { signedIn: async () => true });
    await eventually(() => rig.service.registration(alice).state === "succeeded" && rig.notices.length === 2, "the second bind");
    const [second] = rig.bindings;
    assert.notEqual(second.id, first.id);
    await rig.service.inboxAction(rig.notices[0], FEISHU_UNBIND_ACTION);
    assert.deepEqual(rig.bindings.map((binding) => binding.id), [second.id]);
    assert.equal(rig.secrets.size, 1);
    await rig.service.inboxAction(rig.notices[1], "open");
    assert.equal(rig.bindings.length, 1, "only its own action does anything");
    await rig.service.inboxAction(rig.notices[1], FEISHU_UNBIND_ACTION);
    assert.deepEqual(rig.bindings, []);
    assert.equal(rig.secrets.size, 0);
    assert.deepEqual(rig.preferenceChanges.at(-1), ["alice", "feishu", false]);
  } finally { await rig.service.close(); }
});
