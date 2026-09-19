import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInboundMessage } from "../src/channels/feishu/messages.mjs";
import { CARD_TEXT_LIMIT, MAX_ANSWER_CARDS, answerCards, escapeCardText, noticeCard, progressCard } from "../src/channels/feishu/cards.mjs";
import { FEISHU_MAX_FILE_BYTES, FeishuApiError, FeishuClient, feishuError, messageUuid } from "../src/channels/feishu/client.mjs";
import { SecretScrubber, describeError, sdkLogger } from "../src/channels/feishu/redact.mjs";
import { RegistrationManager, registrationFailure } from "../src/channels/feishu/registration.mjs";
import { FeishuConnections } from "../src/channels/feishu/connection.mjs";
import { FEISHU_CREDENTIAL, FEISHU_TENANT_SCOPES, createFeishuChannel } from "../src/channels/feishu/adapter.mjs";
import { createFakeFeishuSdk, feishuMessageEvent } from "./fakeFeishuSdk.mjs";

const SECRET = "fake-app-secret-0123456789abcdef";
const APP_ID = "cli_a1b2c3d4e5f60718";

// --- messages ---------------------------------------------------------------------

test("an inbound text message keeps who, where and the words, and drops mention placeholders", () => {
  const message = normalizeInboundMessage(feishuMessageEvent({ eventId: "ev1", text: "@_user_1 帮我查一下二甲双胍的剂量",
    chatType: "group", mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "EviMed" }] }), { botOpenId: "ou_bot" });
  assert.equal(message.eventId, "ev1");
  assert.equal(message.chatType, "group");
  assert.equal(message.text, "帮我查一下二甲双胍的剂量");
  assert.equal(message.addressed, true);
  assert.equal(message.supported, true);
});

test("a group message that mentions someone else is not addressed to the bot", () => {
  const message = normalizeInboundMessage(feishuMessageEvent({ chatType: "group", text: "@_user_1 你看下",
    mentions: [{ key: "@_user_1", id: { open_id: "ou_colleague" } }] }), { botOpenId: "ou_bot" });
  assert.equal(message.addressed, false);
});

test("rich text is flattened, other kinds are carried as unsupported, and bots are never a request", () => {
  const post = normalizeInboundMessage(feishuMessageEvent({ messageType: "post", content: JSON.stringify({
    title: "问题", content: [[{ tag: "text", text: "他汀类药物" }, { tag: "a", text: "与糖尿病", href: "https://x" }], [{ tag: "img", image_key: "k" }]],
  }) }));
  assert.equal(post.text, "问题\n他汀类药物与糖尿病");
  const image = normalizeInboundMessage(feishuMessageEvent({ messageType: "image", content: JSON.stringify({ image_key: "k" }) }));
  assert.equal(image.supported, false);
  assert.equal(image.text, "");
  assert.equal(normalizeInboundMessage(feishuMessageEvent({ senderType: "app" })), null);
  assert.equal(normalizeInboundMessage({ message: {} }), null);
});

// --- cards ---------------------------------------------------------------------

test("card text can never form a tag, and comparisons still read as written", () => {
  assert.equal(escapeCardText("p<0.05 且 <at id=all></at>"), "p&#60;0.05 且 &#60;at id=all&#62;&#60;/at&#62;");
  const card = progressCard({ question: "问题 <at id=all></at>", status: "进行中", progress: "<font color='red'>x</font>" });
  assert.equal(card.config.streaming_mode, true);
  const text = JSON.stringify(card.body);
  assert.equal(text.includes("<at"), false);
  assert.equal(text.includes("<font"), false);
  assert.deepEqual(card.body.elements.slice(0, 2).map((element) => element.element_id), ["status", "progress"]);
});

test("a long answer is split into at most three cards, and the last one points to the page", () => {
  const paragraph = "证据".repeat(1_000);
  const text = Array.from({ length: 12 }, () => paragraph).join("\n\n");
  const cards = answerCards({ text, link: "https://science.example.com/app/runs?run=r1" });
  assert.equal(cards.length, MAX_ANSWER_CARDS);
  for (const card of cards) assert.ok(card.body.elements[0].content.length <= CARD_TEXT_LIMIT + 40);
  assert.match(cards.at(-1).body.elements[0].content, /完整内容请在网页中查看/);
  assert.equal(cards.at(-1).body.elements[1].behaviors[0].default_url, "https://science.example.com/app/runs?run=r1");
  assert.equal(cards[0].body.elements.length, 1, "only the last card carries the button");
  assert.deepEqual(answerCards({ text: "   " }), []);
});

test("a pushed notice is coloured by severity and links back", () => {
  const card = noticeCard({ title: "研究已交付，待你复核", body: "已交付。\n请先核对：剂量。", link: "https://x/app/inbox", severity: "safety" });
  assert.equal(card.header.template, "red");
  assert.equal(card.body.elements[1].behaviors[0].type, "open_url");
});

// --- client ------------------------------------------------------------------------

test("provider errors map to our codes, and only transient ones are retryable", () => {
  const scrubber = new SecretScrubber();
  const permission = feishuError("send", { response: { status: 400, data: { code: 99991672, msg: "no scope" } } }, scrubber);
  assert.equal(permission.code, "feishu_permission_missing");
  assert.equal(permission.retryable, false);
  assert.equal(feishuError("send", { response: { status: 400, data: { code: 230020 } } }, scrubber).code, "feishu_rate_limited");
  assert.equal(feishuError("send", { response: { status: 502 } }, scrubber).code, "feishu_unavailable");
  const lost = feishuError("send", new Error("socket hang up"), scrubber, { sent: true });
  assert.equal(lost.code, "feishu_unreachable");
  assert.equal(lost.uncertain, true, "a send that got no answer may have landed");
  assert.match(messageUuid("card:ev1"), /^evm_[0-9a-f]{40}$/);
  assert.equal(messageUuid("card:ev1"), messageUuid("card:ev1"));
});

test("an uncertain send is resent once under the same uuid, and a recalled reply target becomes a plain message", async () => {
  const fake = createFakeFeishuSdk();
  const client = new FeishuClient({ sdk: fake.sdk, appId: APP_ID, appSecret: SECRET });
  fake.fail("message.create", { response: { status: 400, data: { code: 230049, msg: "uncertain" } } });
  const id = await client.send({ to: { type: "open_id", id: "ou_owner" }, msgType: "text", content: { text: "hi" }, uuid: "evm_1" });
  assert.match(id, /^om_/);
  const creates = fake.callsTo("message.create");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].args.data.uuid, creates[1].args.data.uuid);
  fake.fail("message.reply", { response: { status: 400, data: { code: 230011, msg: "recalled" } } });
  await client.send({ to: { type: "chat_id", id: "oc_1" }, replyTo: "om_gone", msgType: "text", content: { text: "x" }, uuid: "evm_2" });
  assert.equal(fake.callsTo("message.create").at(-1).args.params.receive_id_type, "chat_id");
});

test("files are refused by size before any upload, and a file key comes from the inner data", async () => {
  const fake = createFakeFeishuSdk();
  const client = new FeishuClient({ sdk: fake.sdk, appId: APP_ID, appSecret: SECRET });
  await assert.rejects(client.uploadFile({ fileName: "a.md", bytes: Buffer.alloc(0) }), { code: "feishu_file_empty" });
  await assert.rejects(client.uploadFile({ fileName: "a.md", bytes: Buffer.alloc(FEISHU_MAX_FILE_BYTES + 1) }), { code: "feishu_file_too_large" });
  assert.equal(fake.callsTo("file.create").length, 0);
  assert.match(await client.uploadFile({ fileName: "report.md", bytes: Buffer.from("# 报告") }), /^file_/);
  assert.deepEqual(await client.botInfo(), { name: "张三 的 EviMed 研究助手", openId: "ou_bot", activateStatus: 2 });
});

test("the App Secret never reaches a log line, even when the SDK hands the logger the failed request", () => {
  const scrubber = new SecretScrubber();
  scrubber.add(SECRET);
  const lines = [];
  const logger = sdkLogger(scrubber, (line) => lines.push(line));
  // What the SDK's formatErrors passes for a failed tenant-token fetch.
  logger.error([[{ message: "Request failed with status code 400", config: { data: JSON.stringify({ app_id: APP_ID, app_secret: SECRET }) },
    response: { status: 400, data: { code: 10014, msg: `app secret invalid: ${SECRET}` } } }]]);
  logger.info(["receive message, data: 患者姓名 张三"]);
  logger.debug(["anything"]);
  assert.equal(lines.length, 1, "info and debug are dropped: they carry message bodies");
  assert.equal(lines[0].includes(SECRET), false);
  assert.match(lines[0], /status=400/);
  assert.match(lines[0], /provider=10014/);
  assert.equal(describeError({ description: `echo ${SECRET}` }, scrubber).includes(SECRET), false);
});

// --- registration ----------------------------------------------------------------

test("a registration shows the SDK's link, saves through the callback, and never exposes the secret", async () => {
  const fake = createFakeFeishuSdk();
  const saved = [];
  const manager = new RegistrationManager({ registerApp: fake.sdk.registerApp,
    onCredentials: async (result) => { saved.push(result); return { botName: "bot" }; } });
  assert.equal(manager.start({ createOnly: true }).state, "starting");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const waiting = manager.status();
  assert.equal(waiting.state, "polling");
  assert.match(waiting.qrCodeUrl, /tp=sdk/, "the SDK-built link, not the bare verification URI");
  assert.ok(waiting.remainingSeconds > 590);
  fake.scan();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const done = manager.status();
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.result, { botName: "bot" });
  assert.equal(JSON.stringify(done).includes(SECRET), false);
  assert.equal(saved[0].client_secret, SECRET);
  assert.equal(done.qrCodeUrl, undefined, "a spent code is not offered again");
});

test("registration failures read as sentences: denied, expired, a platform refusal, a broken network", async () => {
  assert.equal(registrationFailure({ code: "access_denied" }).message, "你在飞书里拒绝了这次授权。需要时可以重新扫码。");
  assert.equal(registrationFailure({ code: "expired_token" }).message, "二维码已过期，请重新生成。");
  const refused = registrationFailure({ code: "admin_approval_required", description: "需要管理员审批后才能创建应用" });
  assert.match(refused.message, /admin_approval_required/);
  assert.match(refused.message, /需要管理员审批/);
  assert.equal(registrationFailure(new Error(`ECONNRESET ${SECRET}`)).code, "registration_failed");
  assert.equal(registrationFailure(new Error(`ECONNRESET ${SECRET}`)).message.includes(SECRET), false);

  const fake = createFakeFeishuSdk();
  const manager = new RegistrationManager({ registerApp: fake.sdk.registerApp, onCredentials: async () => ({}) });
  manager.start({});
  await new Promise((resolve) => setTimeout(resolve, 5));
  fake.refuse({ code: "access_denied", description: "user denied" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.status().state, "error");
  assert.equal(manager.status().error.code, "access_denied");
  manager.start({});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.cancel().state, "cancelled");
});

test("a save that fails reports the callback's own sentence", async () => {
  const fake = createFakeFeishuSdk({ autoScan: true });
  const manager = new RegistrationManager({ registerApp: fake.sdk.registerApp,
    onCredentials: async () => { throw Object.assign(new Error("x"), { code: "feishu_owner_missing", publicMessage: "请重新扫码。" }); } });
  manager.start({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(manager.status().error, { code: "feishu_owner_missing", message: "请重新扫码。" });
});

// --- connections -----------------------------------------------------------------

/** Timers a test drives by hand. */
function manualTimers() {
  /** @type {{ fn: Function, ms: number, cleared: boolean }[]} */
  const timers = [];
  return {
    timers,
    setTimeout: (/** @type {Function} */ fn, /** @type {number} */ ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (/** @type {any} */ timer) => { if (timer) timer.cleared = true; },
    fire: (/** @type {(timer: any) => boolean} */ pick) => { const timer = timers.find((item) => !item.cleared && pick(item)); timer.cleared = true; timer.fn(); },
  };
}

const binding = { id: "chb_1", userId: "u1", externalId: "ou_owner", credentialRef: FEISHU_CREDENTIAL,
  metadata: { appId: APP_ID, tenantBrand: "feishu", botOpenId: "ou_bot" } };

test("one long connection per bound app, events handed over with their binding, and a failure retried with backoff", async () => {
  const fake = createFakeFeishuSdk();
  const clock = manualTimers();
  const events = [];
  const connections = new FeishuConnections({
    loadSdk: async () => fake.sdk, resolveSecret: async () => SECRET,
    onEvent: async (owner, payload) => { events.push({ owner: owner.id, payload }); },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, write: () => {},
  });
  await connections.sync([binding]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connections.status("chb_1").state, "connected");
  assert.equal(fake.wsClients.length, 1);
  assert.equal(fake.wsClients[0].options.appSecret, SECRET);
  await fake.wsClients[0].deliver(feishuMessageEvent({ eventId: "ev_a" }));
  assert.deepEqual(events.map((event) => [event.owner, event.payload.event_id]), [["chb_1", "ev_a"]]);
  // The SDK gives up: failed, a restart scheduled 30 s out, then a new client.
  fake.wsClients[0].options.onError(new Error("reconnect exhausted"));
  assert.equal(connections.status("chb_1").state, "failed");
  assert.equal(connections.status("chb_1").errorCode, "feishu_connection_failed");
  assert.equal(fake.wsClients[0].closed, true);
  // The restart does not come up either: the watchdog fails it, and a second
  // failure in a row waits twice as long. (A restart that connects resets it.)
  fake.fail("ws.start", new Error("still down"));
  clock.fire((timer) => timer.ms === 30_000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.wsClients.length, 2);
  clock.fire((timer) => timer.ms === 30_000);
  assert.equal(connections.status("chb_1").errorCode, "feishu_connect_timeout");
  assert.ok(clock.timers.some((timer) => !timer.cleared && timer.ms === 60_000));
  // Unbinding stops it.
  await connections.sync([]);
  assert.equal(connections.status("chb_1"), null);
  assert.equal(fake.wsClients[1].closed, true);
});

test("a start that never reports ready is failed by the watchdog, and a Lark bot connects to Lark", async () => {
  const fake = createFakeFeishuSdk();
  fake.fail("ws.start", new Error("never ready"));
  const clock = manualTimers();
  const connections = new FeishuConnections({ loadSdk: async () => fake.sdk, resolveSecret: async () => SECRET,
    onEvent: async () => {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, write: () => {} });
  await connections.sync([{ ...binding, metadata: { ...binding.metadata, tenantBrand: "lark" } }]);
  assert.equal(fake.wsClients[0].options.domain, "https://open.larksuite.com");
  clock.fire((timer) => timer.ms === 30_000);
  assert.equal(connections.status("chb_1").errorCode, "feishu_connect_timeout");
  const missing = new FeishuConnections({ loadSdk: async () => fake.sdk, resolveSecret: async () => null,
    onEvent: async () => {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, write: () => {} });
  await missing.sync([binding]);
  assert.equal(missing.status("chb_1").errorCode, "feishu_secret_missing");
  await connections.closeAll();
  await missing.closeAll();
});

// --- the adapter ---------------------------------------------------------------------

function fakeStore() {
  const bindings = [];
  return {
    bindings,
    async replaceBinding(userId, channel, input) {
      const replaced = bindings.splice(0, bindings.length);
      const created = { id: `chb_${bindings.length + replaced.length + 1}`, userId, channel, externalId: input.externalId,
        credentialRef: input.credentialRef, metadata: input.metadata, status: "active", createdAt: new Date().toISOString() };
      bindings.push(created);
      return { binding: created, replaced };
    },
  };
}

function fakeCredentials() {
  const secrets = new Map();
  return {
    secrets,
    async setChannelSecret(userId, connector, value) { secrets.set(`${userId}:${connector}`, value); },
    async resolveChannelSecret(userId, connector) { return secrets.get(`${userId}:${connector}`) ?? null; },
  };
}

test("binding verifies the bot before anything is kept, and asks for exactly the scopes it uses", async () => {
  const fake = createFakeFeishuSdk();
  const store = fakeStore();
  const credentials = fakeCredentials();
  const channel = createFeishuChannel({ loadSdk: async () => fake.sdk, store, credentials });
  const bound = await channel.bind("u1", { appId: APP_ID, appSecret: SECRET, ownerOpenId: "ou_owner", tenantBrand: "feishu" });
  assert.equal(bound.externalId, "ou_owner");
  assert.equal(bound.metadata.botOpenId, "ou_bot");
  assert.equal(bound.metadata.activateStatus, 2);
  assert.equal(credentials.secrets.get("u1:channel.feishu"), SECRET);
  assert.equal(JSON.stringify(bound).includes(SECRET), false);
  assert.deepEqual([...FEISHU_TENANT_SCOPES].sort(), ["cardkit:card:write", "im:message.group_at_msg:readonly",
    "im:message.p2p_msg:readonly", "im:message:send_as_bot", "im:resource"]);
  fake.fail("request", { response: { status: 400, data: { code: 10014, msg: "invalid secret" } } });
  await assert.rejects(channel.bind("u2", { appId: APP_ID, appSecret: "wrong-secret-0123456789", ownerOpenId: "ou_x" }),
    { code: "feishu_credentials_invalid" });
  assert.equal(credentials.secrets.has("u2:channel.feishu"), false, "an unverified secret is not kept");
  await assert.rejects(channel.bind("u2", { appId: "not-an-app", appSecret: SECRET, ownerOpenId: "ou_x" }), { code: "feishu_grant_invalid" });
});

test("only the owner's addressed messages are accepted, and each is handed to the inbound store", async () => {
  const fake = createFakeFeishuSdk();
  const accepted = [];
  const channel = createFeishuChannel({ loadSdk: async () => fake.sdk, store: fakeStore(), credentials: fakeCredentials(),
    inbound: { accept: async (input) => { accepted.push(input.message.eventId); } } });
  assert.equal((await channel.onInbound({ binding, payload: feishuMessageEvent({ eventId: "e1" }) })).accepted, true);
  assert.equal((await channel.onInbound({ binding, payload: feishuMessageEvent({ eventId: "e2", sender: "ou_stranger" }) })).reason, "not-owner");
  assert.equal((await channel.onInbound({ binding, payload: feishuMessageEvent({ eventId: "e3", chatType: "group", text: "大家好" }) })).reason,
    "not-addressed");
  assert.deepEqual(accepted, ["e1"]);
});

test("the task card is created, shown as a reply, streamed with escaped text, reopened before it closes, and replaced if streaming is refused", async () => {
  const fake = createFakeFeishuSdk();
  const credentials = fakeCredentials();
  await credentials.setChannelSecret("u1", FEISHU_CREDENTIAL, SECRET);
  let now = 1_000_000;
  const channel = createFeishuChannel({ loadSdk: async () => fake.sdk, store: fakeStore(), credentials, now: () => now });
  const card = await channel.conversation.openCard({ binding, chatId: "oc_1", replyTo: "om_q", question: "问题", status: "收到", key: "ev1" });
  assert.equal(fake.callsTo("message.reply")[0].args.path.message_id, "om_q");
  assert.deepEqual(JSON.parse(fake.callsTo("message.reply")[0].args.data.content), { type: "card", data: { card_id: card.cardId } });
  await channel.conversation.updateCard({ binding, card, status: "⏳ 进行中 <b>", progress: "当前：检索" });
  const streamed = fake.callsTo("cardElement.content");
  assert.equal(streamed.length, 2);
  assert.equal(streamed[0].args.data.content, "⏳ 进行中 &#60;b&#62;");
  assert.deepEqual(streamed.map((call) => call.args.data.sequence), [1, 2]);
  now += 9 * 60_000 + 1;
  await channel.conversation.updateCard({ binding, card, status: "⏳ 进行中 · 已用 10 分钟", progress: "当前：检索" });
  assert.equal(fake.callsTo("card.settings").length, 1, "streaming reopened a minute before Feishu closes it");
  fake.fail("cardElement.content", { response: { status: 400, data: { code: 300309, msg: "streaming closed" } } });
  await channel.conversation.updateCard({ binding, card, status: "⏳ 进行中 · 已用 12 分钟", progress: "当前：撰写" });
  assert.equal(fake.callsTo("card.update").length, 1, "a refused stream falls back to one full replace");
  await channel.conversation.closeCard({ binding, card, question: "问题", outcome: "delivered", status: "✅ 研究已完成" });
  const final = JSON.parse(fake.callsTo("card.update").at(-1).args.data.card.data);
  assert.equal(final.config.streaming_mode, false);
  assert.equal(final.header.template, "green");
  const sequences = [...fake.callsTo("cardElement.content"), ...fake.callsTo("card.settings"), ...fake.callsTo("card.update")]
    .map((call) => call.args.data.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [...new Set(sequences)], "every card operation carries its own sequence");
});

test("a push goes to the owner's own chat with the bot, under a uuid derived from the item", async () => {
  const fake = createFakeFeishuSdk();
  const credentials = fakeCredentials();
  await credentials.setChannelSecret("u1", FEISHU_CREDENTIAL, SECRET);
  const channel = createFeishuChannel({ loadSdk: async () => fake.sdk, store: fakeStore(), credentials });
  const outcome = await channel.deliver(binding, { kind: "notification", title: "研究已完成", body: "交付 2 个文件。", link: null,
    linkLabel: null, severity: "info", idempotencyKey: "notification:x:1" });
  assert.equal(outcome.delivered, true);
  const sent = fake.callsTo("message.create")[0].args;
  assert.deepEqual(sent.params, { receive_id_type: "open_id" });
  assert.equal(sent.data.receive_id, "ou_owner");
  assert.equal(sent.data.msg_type, "interactive");
  assert.equal(sent.data.uuid, messageUuid("deliver:chb_1:notification:x:1"));
  fake.fail("message.create", { response: { status: 400, data: { code: 99991672, msg: "no scope" } } });
  await assert.rejects(channel.deliver(binding, { kind: "notification", title: "t", body: "b", severity: "info", idempotencyKey: "k" }),
    (error) => error instanceof FeishuApiError && error.code === "feishu_permission_missing");
});
