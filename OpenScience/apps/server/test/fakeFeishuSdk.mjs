/**
 * A stand-in for `@larksuiteoapi/node-sdk` with the members the channel uses:
 * `registerApp`, `Client` (messages, files, CardKit, bot info), `WSClient`,
 * `EventDispatcher`, `Domain`, `LoggerLevel`. Every call is recorded; a call
 * can be told to fail; a "scan" completes a registration when the test says.
 *
 * Shapes follow the SDK 1.74.0 source: `message.create` answers the envelope
 * `{ code, msg, data: { message_id } }`, `file.create` answers the inner
 * `{ file_key }`, `request()` answers the raw body, and the WSClient calls
 * `onReady` after `start()`.
 */

/** @param {number} [ms] */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ credentials?: Record<string, any>, bot?: Record<string, any>, autoScan?: boolean }} [options]
 */
export function createFakeFeishuSdk({
  credentials = {
    client_id: "cli_a1b2c3d4e5f60718",
    client_secret: "fake-app-secret-0123456789abcdef",
    user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
  },
  bot = { app_name: "张三 的 EviMed 研究助手", open_id: "ou_bot", activate_status: 2 },
  autoScan = false,
} = {}) {
  /** @type {{ api: string, args: any }[]} */
  const calls = [];
  /** @type {Map<string, { error: any, times: number }>} */
  const failures = new Map();
  /** @type {any[]} */
  const wsClients = [];
  /** @type {{ options: any, resolve: (value: any) => void, reject: (error: any) => void } | null} */
  let pendingScan = null;
  let seq = 0;

  /** @param {string} api @param {any} args @param {() => any} answer */
  async function record(api, args, answer) {
    calls.push({ api, args });
    await tick();
    const failure = failures.get(api);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw typeof failure.error === "function" ? failure.error() : failure.error;
    }
    return answer();
  }

  class Client {
    /** @param {any} options */
    constructor(options) {
      this.options = options;
      calls.push({ api: "client", args: { appId: options.appId, domain: options.domain, hasSecret: Boolean(options.appSecret) } });
      this.im = {
        v1: {
          message: {
            create: (/** @type {any} */ payload) => record("message.create", payload, () => ({ code: 0, msg: "ok", data: { message_id: `om_${++seq}` } })),
            reply: (/** @type {any} */ payload) => record("message.reply", payload, () => ({ code: 0, msg: "ok", data: { message_id: `om_${++seq}` } })),
          },
          file: {
            create: (/** @type {any} */ payload) => record("file.create", payload, () => ({ file_key: `file_${++seq}` })),
          },
        },
      };
      this.cardkit = {
        v1: {
          card: {
            create: (/** @type {any} */ payload) => record("card.create", payload, () => ({ code: 0, data: { card_id: `card_${++seq}` } })),
            update: (/** @type {any} */ payload) => record("card.update", payload, () => ({ code: 0 })),
            settings: (/** @type {any} */ payload) => record("card.settings", payload, () => ({ code: 0 })),
          },
          cardElement: {
            content: (/** @type {any} */ payload) => record("cardElement.content", payload, () => ({ code: 0 })),
          },
        },
      };
    }

    /** @param {any} payload */
    request(payload) {
      return record("request", payload, () => ({ code: 0, msg: "ok", bot }));
    }
  }

  class EventDispatcher {
    constructor() { /** @type {Map<string, Function>} */ this.handles = new Map(); }
    /** @param {Record<string, Function>} handles */
    register(handles) {
      for (const [key, handle] of Object.entries(handles)) this.handles.set(key, handle);
      return this;
    }
  }

  class WSClient {
    /** @param {any} options */
    constructor(options) {
      this.options = options;
      this.closed = false;
      this.dispatcher = null;
      wsClients.push(this);
      calls.push({ api: "ws.construct", args: { appId: options.appId, domain: options.domain } });
    }
    /** @param {{ eventDispatcher: any }} input */
    async start({ eventDispatcher }) {
      this.dispatcher = eventDispatcher;
      if (!failures.has("ws.start")) setTimeout(() => { if (!this.closed) this.options.onReady?.(); }, 0);
    }
    /** @param {any} [options] */
    close(options) { this.closed = true; calls.push({ api: "ws.close", args: options }); }
    /** Deliver one event the way the SDK does: await the handler, then ack.
     *  @param {any} payload */
    async deliver(payload) {
      const handle = this.dispatcher?.handles.get("im.message.receive_v1");
      if (!handle) throw new Error("no im.message.receive_v1 handler registered");
      return handle(payload);
    }
  }

  /** @param {any} options */
  async function registerApp(options) {
    calls.push({ api: "registerApp", args: { ...options, onQRCodeReady: undefined, onStatusChange: undefined, signal: undefined } });
    options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH&from=sdk&source=node-sdk%2Fevimed&tp=sdk", expireIn: 600 });
    options.onStatusChange?.({ status: "polling" });
    if (autoScan) { await tick(); return credentials; }
    return new Promise((resolve, reject) => {
      pendingScan = { options, resolve, reject };
      options.signal?.addEventListener("abort", () => reject({ code: "abort", description: "Registration was aborted" }), { once: true });
    });
  }

  return {
    sdk: {
      registerApp, Client, WSClient, EventDispatcher,
      Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
      LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
    },
    calls,
    wsClients,
    /** Every recorded call to one API. @param {string} api */
    callsTo: (api) => calls.filter((call) => call.api === api),
    /** Make the next `times` calls to `api` throw `error`. @param {string} api @param {any} error @param {number} [times] */
    fail(api, error, times = 1) { failures.set(api, { error, times }); },
    /** The person scans and confirms: the pending registration resolves. @param {Record<string, any>} [override] */
    scan(override) {
      if (!pendingScan) throw new Error("no registration is waiting for a scan");
      const scan = pendingScan;
      pendingScan = null;
      scan.resolve(override ?? credentials);
    },
    /** The poll ends with a platform error. @param {{ code: string, description?: string }} error */
    refuse(error) {
      if (!pendingScan) throw new Error("no registration is waiting for a scan");
      const scan = pendingScan;
      pendingScan = null;
      scan.reject(error);
    },
    get waitingForScan() { return pendingScan !== null; },
  };
}

/**
 * One `im.message.receive_v1` event as the SDK's dispatcher hands it over.
 * @param {{ eventId?: string, messageId?: string, chatId?: string, chatType?: 'p2p' | 'group', sender?: string,
 *   text?: string, messageType?: string, content?: any, mentions?: any[], senderType?: string }} [input]
 */
export function feishuMessageEvent({
  eventId = `ev_${Math.random().toString(16).slice(2)}`, messageId = `om_in_${Math.random().toString(16).slice(2)}`,
  chatId = "oc_p2p_chat", chatType = "p2p", sender = "ou_owner", text = "阿司匹林一级预防的最新证据是什么？",
  messageType = "text", content, mentions = [], senderType = "user",
} = {}) {
  return {
    event_type: "im.message.receive_v1",
    event_id: eventId,
    app_id: "cli_a1b2c3d4e5f60718",
    sender: { sender_id: { open_id: sender }, sender_type: senderType, tenant_key: "t1" },
    message: {
      message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: messageType,
      content: content ?? JSON.stringify({ text }), mentions, create_time: String(Date.now()),
    },
  };
}
