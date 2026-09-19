/**
 * The IM module: a researcher's phone, through Feishu (plan §3.6).
 *
 * A layer-2 feature module like the inbox or autopilot: this service, its
 * routes (`imRoutes.mjs`), its leased worker (`imWorker.mjs`) and one switch
 * (`OPEN_SCIENCE_IM_ENABLED`). It is never a DSH plugin and never runs in a
 * runtime. The reason is the runtime's shape: a per-project container started
 * on demand, capped per account, stopped after 30 idle minutes, holding no
 * provider key and no egress — a bot living there is offline whenever the
 * container is. So the bot lives here, and it reaches the kernel exactly the
 * way the page does: a research session bound open-domain, the same routing,
 * one `session/prompt` through `runtimeManager.dispatchPrompt`, progress read
 * back from the run ledger. No new contact point with the kernel exists.
 *
 * What a message can do: start work, add to the work already running (a
 * correction, principle 17), or move the chat to another project. The last
 * two are language judgements a model makes (`channels/intent.mjs`); nothing
 * is parsed as a command, and nothing a chat says can change a model, a
 * preset, a path or a permission — those are the control plane's.
 *
 * @module imService
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { RUN_ACTIVITY_PHASE_LABELS_ZH, capabilityTitle, errorCodeMessage } from "@evimed/domain";
import { HttpError, openScopedFileNoFollow, resolveScopedPath } from "./security.mjs";
import { readRunTranscript } from "./runTranscripts.mjs";
import { runFinishedNotice } from "./notificationService.mjs";
import { IN_APP_CHANNEL, channelMessage, deliveryOutcome } from "./channels/port.mjs";
import { ChannelRegistry, channelSwitches } from "./channels/registry.mjs";
import { ChannelStore } from "./channels/store.mjs";
import { ChannelIntentClassifier } from "./channels/intent.mjs";
import { createAppChannel } from "./channels/app.mjs";
import { createWechatServiceChannel } from "./channels/wechatService.mjs";
import { createWechatClawbotChannel } from "./channels/wechatClawbot.mjs";
import { createEmailChannel } from "./channels/email.mjs";
import { createDingtalkChannel } from "./channels/dingtalk.mjs";
import { createWecomChannel } from "./channels/wecom.mjs";
import { FEISHU_CREDENTIAL, FEISHU_DISABLED_ACTIVATION, FEISHU_EVENTS, FEISHU_PENDING_ACTIVATION, FEISHU_TENANT_SCOPES,
  createFeishuChannel } from "./channels/feishu/adapter.mjs";
import { FEISHU_MAX_FILE_BYTES, FeishuApiError } from "./channels/feishu/client.mjs";
import { FeishuConnections } from "./channels/feishu/connection.mjs";
import { RegistrationManager } from "./channels/feishu/registration.mjs";
import { SecretScrubber, describeError } from "./channels/feishu/redact.mjs";
import { loadFeishuSdk } from "./channels/feishu/sdk.mjs";
import { DeviceTokenStore, createDeviceAuthentication } from "./channels/deviceTokens.mjs";
import { ImWorker } from "./imWorker.mjs";
import { createImRoutes } from "./imRoutes.mjs";

/** How many times an inbound message is tried before the chat is told it
 *  could not be handled. */
const INBOUND_MAX_ATTEMPTS = 3;
/** Handled inbound rows are kept this long, for dedupe: Feishu re-pushes an
 *  unacknowledged event for up to a few hours. */
const INBOUND_RETENTION_MS = 48 * 3_600_000;
/** Settled pushes are kept this long, then swept. */
const DELIVERY_RETENTION_MS = 30 * 86_400_000;
/** A task still running after this long stops being tracked in the chat;
 *  the run itself is untouched and stays on the page. */
const TASK_TRACK_LIMIT_MS = 24 * 3_600_000;
/** Explicit delivery failures are retried this many times, spaced by this
 *  base doubled per attempt (dsh-im's "at most three" resend rule). */
const DELIVERY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
/** How far back the reconcile pass looks for inbox items a crash left
 *  unpushed. Older news is on the page, not worth a buzz. */
const RECONCILE_WINDOW_MS = 24 * 3_600_000;
/** China Standard Time has one offset since 1991 (see notificationService). */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** @param {string} value */
function digestHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * An absolute link into the web app, or null when this deployment has no
 * public URL to give (links are an extra, never a reason to fail).
 * @param {Record<string, any>} config @param {string} pathAndQuery
 */
export function appLink(config, pathAndQuery) {
  const base = String(config?.publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/.test(base)) return null;
  return `${base}${pathAndQuery}`;
}

/** @param {string} runId */
export function runLink(config, runId) {
  return appLink(config, `/app/runs?run=${encodeURIComponent(runId)}`);
}

/** @param {string} runId @param {string} filePath */
export function runFileLink(config, runId, filePath) {
  const encoded = String(filePath).split("/").map(encodeURIComponent).join("/");
  return appLink(config, `/app/runs/${encodeURIComponent(runId)}/files/${encoded}`);
}

/** Where an inbox item opens, the same routes the inbox page uses.
 *  @param {Record<string, any>} config @param {any} item */
export function noticeLink(config, item) {
  const source = item?.source;
  if (source?.type === "run") return runLink(config, source.id);
  if (source?.type === "digest") return appLink(config, `/app/autopilot?digest=${encodeURIComponent(source.id)}`);
  if (source?.type === "memory") return appLink(config, `/app/memory?record=${encodeURIComponent(source.id)}`);
  return appLink(config, "/app/inbox");
}

/** Minutes between two moments, rounded, at least 1. @param {unknown} from @param {number} to */
function elapsedMinutes(from, to) {
  const start = Date.parse(String(from ?? ""));
  if (!Number.isFinite(start)) return null;
  return Math.max(1, Math.round((to - start) / 60_000));
}

/** "HH:MM" as minutes after midnight. @param {unknown} value */
function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * When a push may go out, by the researcher's own preferences read in China
 * Standard Time: a clinical-safety finding at once (the one class allowed to
 * interrupt, C1); a proactive-research digest at their digest time; anything
 * else at once, unless it falls inside their quiet hours, then when those end.
 * @param {any} item @param {any} preferences @param {Date} now
 * @returns {Date}
 */
export function pushNotBefore(item, preferences, now) {
  if (item?.severity === "safety") return now;
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const midnight = now.getTime() - (minute * 60_000 + local.getUTCSeconds() * 1000 + local.getUTCMilliseconds());
  /** @param {number} target minutes after local midnight @param {boolean} [tomorrow] */
  const at = (target, tomorrow = false) => new Date(midnight + (tomorrow ? 86_400_000 : 0) + target * 60_000);
  const start = clockMinutes(preferences?.quietHours?.start);
  const end = clockMinutes(preferences?.quietHours?.end);
  const hasQuiet = start != null && end != null && start !== end;
  const quiet = hasQuiet && (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  if (item?.source?.type === "digest") {
    // The morning digest: a digest the night's autopilot wrote waits for the
    // researcher's digest time — today's if it is still ahead, tomorrow's if
    // the night has already passed it.
    const digest = clockMinutes(preferences?.digestTime);
    if (digest != null && minute < digest) return at(digest);
    if (digest != null && quiet) return at(digest, true);
  }
  if (!quiet) return now;
  return at(/** @type {number} */ (end), /** @type {number} */ (start) > /** @type {number} */ (end) && minute >= /** @type {number} */ (start));
}

/**
 * What the progress card says while a run works: how long, which line, and
 * what the run's own progress aggregate observed — never a sentence the model
 * wrote about itself, and nothing at all for a plain question that made no
 * tool call (principle 12).
 * @param {Record<string, any>} run @param {number} now
 * @returns {{ status: string, progress: string }}
 */
export function progressView(run, now) {
  const minutes = elapsedMinutes(run?.startedAt, now);
  const line = run?.effectiveAgentId && run.effectiveAgentId !== "open-domain-answer"
    ? capabilityTitle(run.effectiveAgentId) ?? "专项研究" : "普通问答";
  const estimate = run?.estimatedMinutes && Number.isFinite(run.estimatedMinutes.min) && Number.isFinite(run.estimatedMinutes.max)
    ? `通常 ${run.estimatedMinutes.min}–${run.estimatedMinutes.max} 分钟` : null;
  const status = [`⏳ 进行中 · ${line}`, minutes ? `已用 ${minutes} 分钟` : null, estimate].filter(Boolean).join(" · ");
  const progress = run?.progress ?? {};
  const lines = [];
  const phase = progress.currentPhase ? RUN_ACTIVITY_PHASE_LABELS_ZH[/** @type {keyof typeof RUN_ACTIVITY_PHASE_LABELS_ZH} */ (progress.currentPhase)] : null;
  if (phase) lines.push(`当前：${phase}`);
  const sources = progress.sources ?? {};
  if (Number(sources.searched) > 0 || Number(sources.included) > 0) {
    lines.push(`文献：检索 ${Number(sources.searched) || 0} · 纳入 ${Number(sources.included) || 0} · 全文 ${Number(sources.fullText) || 0}`);
  }
  const claims = progress.claims ?? {};
  if (Number(claims.total) > 0) lines.push(`结论核验：${Number(claims.verified) || 0}/${Number(claims.total)}`);
  const deliverables = Array.isArray(progress.deliverables) ? progress.deliverables : Array.isArray(run?.deliverables) ? run.deliverables : [];
  for (const item of deliverables.slice(0, 5)) {
    const done = ["accepted", "delivered", "submitted"].includes(item?.status);
    lines.push(`${done ? "✓" : "·"} ${String(item?.title ?? item?.id ?? "").slice(0, 60)}`);
  }
  return { status, progress: lines.join("\n") };
}

/** The four endings a card can show. @param {string} outcome */
function cardOutcome(outcome) {
  if (outcome === "delivered" || outcome === "qualified" || outcome === "stopped") return outcome;
  return "failed";
}

/**
 * The last thing the run said: its final assistant text inside the run's own
 * time window, from a transcript's messages.
 * @param {readonly any[]} messages @param {Record<string, any>} run
 */
export function finalReplyText(messages, run) {
  const started = Date.parse(String(run?.startedAt ?? "")) - 5_000;
  const finished = Date.parse(String(run?.finishedAt ?? "")) + 5_000;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const time = Number(message.time);
    if (Number.isFinite(finished) && Number.isFinite(time) && time > finished) continue;
    if (Number.isFinite(started) && Number.isFinite(time) && time < started) break;
    const text = (Array.isArray(message.parts) ? message.parts : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim();
    if (text) return text;
  }
  return null;
}

/** @param {unknown} error */
function errorCode(error) {
  return typeof (/** @type {any} */ (error)?.code) === "string" ? /** @type {any} */ (error).code : "im_failed";
}

/** A refusal the person should read, rather than one to retry.
 *  @param {unknown} error */
function isRefusal(error) {
  return error instanceof HttpError && error.status >= 400 && error.status < 500;
}

export class ImService {
  /**
   * @param {{ config: Record<string, any>, database: any, credentials: any, notifications: any,
   *   users: any, agentRuns: any, runtimeManager: any, usageLedger?: any,
   *   dispatchRun: (input: { user: any, project: any, sessionId: string, dispatchId: string, text: string }) => Promise<any>,
   *   steerRun: (input: { user: any, project: any, runId: string, text: string }) => Promise<any>,
   *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<void>,
   *   loadSdk?: () => Promise<any>, fetchImpl?: typeof fetch, classifier?: any, store?: ChannelStore,
   *   now?: () => number, write?: (line: string) => void, pushProvider?: any }} dependencies
   */
  constructor({ config, database, credentials, notifications, users, agentRuns, runtimeManager, usageLedger = null,
    dispatchRun, steerRun, audit = async () => {}, loadSdk = loadFeishuSdk, fetchImpl = globalThis.fetch,
    classifier = null, store = null, now = Date.now, write = (line) => { process.stderr.write(line); }, pushProvider = null }) {
    this.config = config;
    this.store = store ?? new ChannelStore(database, { now: () => new Date(now()) });
    this.credentials = credentials;
    this.notifications = notifications;
    this.users = users;
    this.agentRuns = agentRuns;
    this.runtimeManager = runtimeManager;
    this.dispatchRun = dispatchRun;
    this.steerRun = steerRun;
    this.audit = audit;
    this.loadSdk = loadSdk;
    this.now = now;
    this.write = write;
    this.workerId = `im-${randomUUID()}`;
    this.scrubber = new SecretScrubber();
    this.classifier = classifier ?? new ChannelIntentClassifier(config, { usageLedger, fetchImpl });
    this.feishu = createFeishuChannel({
      loadSdk, store: this.store, credentials, scrubber: this.scrubber, now,
      inbound: { accept: (input) => this.acceptInbound({ ...input, channel: "feishu" }) },
    });
    this.registry = new ChannelRegistry({
      adapters: [
        this.feishu,
        createWechatServiceChannel(),
        createWechatClawbotChannel(),
        createEmailChannel(),
        createAppChannel({ store: this.store, credentials, pushProvider }),
        createDingtalkChannel(),
        createWecomChannel(),
      ],
      enabled: channelSwitches(config),
    });
    this.connections = new FeishuConnections({
      loadSdk,
      resolveSecret: (binding) => credentials.resolveChannelSecret(binding.userId, binding.credentialRef ?? FEISHU_CREDENTIAL),
      onEvent: (binding, payload) => this.handleFeishuEvent(binding, payload),
      scrubber: this.scrubber,
      now,
      write,
    });
    /** @type {Map<string, { manager: RegistrationManager, touchedAt: number }>} */
    this.registrations = new Map();
    /** Counted, exported with the operator metrics (principle 15). */
    this.counters = new Map();
    /** Called when there is work for the worker sooner than its next tick. */
    this.wake = () => {};
  }

  /** @param {string} kind @param {number} [by] */
  count(kind, by = 1) {
    this.counters.set(kind, (this.counters.get(kind) ?? 0) + by);
  }

  /** Every counter, for `/api/ops/metrics`. */
  metrics() {
    return [...this.counters].map(([kind, value]) => ({ labels: { kind }, value }));
  }

  get enabled() {
    return this.config?.imEnabled === true;
  }

  #requireEnabled() {
    if (!this.enabled) throw new HttpError(404, "im_disabled", "The IM module is not enabled on this deployment.");
  }

  // --- the settings page ------------------------------------------------------

  /** @param {any} user */
  async status(user) {
    const channels = this.registry.describe();
    if (!this.enabled) return { enabled: false, channels, feishu: null, registration: null };
    const [binding] = await this.store.bindingsFor(user.id, "feishu");
    const registration = this.registrations.get(user.id)?.manager.status() ?? null;
    if (!binding) return { enabled: true, channels, feishu: { bound: false }, registration };
    const preferences = await this.notifications?.preferences(user.id).catch(() => null);
    const projects = await this.#projects(user).catch(() => []);
    const names = new Map(projects.map((project) => /** @type {[string, string]} */ ([project.id, project.name])));
    const chats = await this.store.chatsFor(binding.id);
    const appId = String(binding.metadata.appId ?? "");
    const activate = Number(binding.metadata.activateStatus);
    return {
      enabled: true,
      channels,
      registration,
      feishu: {
        bound: true,
        botName: binding.metadata.botName ?? null,
        appId: appId.length > 12 ? `${appId.slice(0, 8)}••••${appId.slice(-4)}` : "cli_••••",
        tenantBrand: binding.metadata.tenantBrand ?? "feishu",
        boundAt: binding.createdAt,
        activation: FEISHU_PENDING_ACTIVATION.includes(activate) ? "pending"
          : FEISHU_DISABLED_ACTIVATION.includes(activate) ? "disabled" : "active",
        connection: this.connections.status(binding.id),
        notifications: Array.isArray(preferences?.channels) && preferences.channels.includes("feishu"),
        chats: chats.map((chat) => ({
          chatType: chat.chatType,
          projectId: chat.projectId,
          projectName: chat.projectId ? names.get(chat.projectId) ?? null : null,
          updatedAt: chat.updatedAt,
        })),
      },
    };
  }

  // --- scan to create --------------------------------------------------------------

  /**
   * Start (or restart) one account's scan-to-create. The SDK builds the link;
   * the page shows it as a QR code and polls `registration(user)`.
   * @param {any} user
   */
  startRegistration(user) {
    this.#requireEnabled();
    let entry = this.registrations.get(user.id);
    if (!entry) {
      const manager = new RegistrationManager({
        registerApp: async (options) => (await this.loadSdk()).registerApp(options),
        onCredentials: (result) => this.#completeRegistration(user, result),
        now: this.now,
      });
      entry = { manager, touchedAt: this.now() };
      this.registrations.set(user.id, entry);
    }
    entry.touchedAt = this.now();
    const home = appLink(this.config, "/app/chat");
    const avatar = appLink(this.config, "/icons/evimed-512.png");
    return entry.manager.start({
      source: "evimed",
      // Only a new app: selecting an existing one on the confirmation page
      // would overwrite that app's own configuration.
      createOnly: true,
      appPreset: {
        name: "{user} 的 EviMed 研究助手",
        desc: home ? `在飞书里向 EviMed 提问、派发研究任务并接收完成通知。网页版：${home}`
          : "在飞书里向 EviMed 提问、派发研究任务并接收完成通知。",
        ...(avatar ? { avatar } : {}),
      },
      addons: {
        preset: false,
        scopes: { tenant: [...FEISHU_TENANT_SCOPES] },
        events: { items: { tenant: [...FEISHU_EVENTS] } },
      },
    });
  }

  /** @param {any} user */
  registration(user) {
    this.#requireEnabled();
    const entry = this.registrations.get(user.id);
    if (entry) entry.touchedAt = this.now();
    return entry?.manager.status() ?? { state: "idle" };
  }

  /** @param {any} user */
  cancelRegistration(user) {
    this.#requireEnabled();
    return this.registrations.get(user.id)?.manager.cancel() ?? { state: "idle" };
  }

  /**
   * A completed scan: verify, store, connect, say hello. Any failure here is
   * reported through the registration state with a sentence for the person
   * (`publicMessage`); the secret itself is never in it.
   * @param {any} user @param {{ client_id: string, client_secret: string, user_info?: Record<string, any> }} result
   */
  async #completeRegistration(user, result) {
    const ownerOpenId = typeof result.user_info?.open_id === "string" ? result.user_info.open_id : "";
    if (!ownerOpenId) {
      throw Object.assign(new Error("owner missing"), {
        code: "feishu_owner_missing", publicMessage: "飞书没有告诉我们是谁扫的码，请重新扫码。",
      });
    }
    let binding;
    try {
      binding = await this.feishu.bind(user.id, {
        appId: result.client_id, appSecret: result.client_secret, ownerOpenId,
        tenantBrand: result.user_info?.tenant_brand === "lark" ? "lark" : "feishu",
      });
    } catch (error) {
      this.write(`im feishu bind failed for ${user.id}: ${describeError(error, this.scrubber)}\n`);
      throw Object.assign(new Error("bind failed"), {
        code: errorCode(error),
        publicMessage: error instanceof FeishuApiError && error.code === "feishu_credentials_invalid"
          ? "飞书返回的凭据无法使用，请重新扫码。" : "机器人已在飞书创建，但 EviMed 暂时没能连上它。请稍后重新扫码。",
      });
    }
    for (const previous of binding.replaced ?? []) {
      await this.connections.stop(previous.id);
      this.feishu.forget(previous.id);
    }
    this.count("feishu_bound");
    await this.audit("im.feishu.bind", "completed", { userId: user.id, code: binding.metadata.tenantBrand });
    // Binding a bot is asking to hear from it: pushes start without a second
    // switch to find (the owner's rule — no confirmation the system can make).
    await this.notifications?.setPreferenceChannel(user.id, "feishu", true).catch((/** @type {any} */ error) =>
      this.audit("im.preferences.feishu", "failed", { userId: user.id, code: errorCode(error) }));
    await this.connections.sync(await this.store.activeBindings("feishu"));
    const pending = FEISHU_PENDING_ACTIVATION.includes(Number(binding.metadata.activateStatus));
    if (!pending) {
      await this.feishu.conversation.sendText({
        binding, chatId: null, replyTo: null, key: `welcome:${binding.id}`,
        text: "你好，我是你的 EviMed 研究助手。直接把问题发给我就行：简单的问题当场回答，深度任务会在这里显示进度，完成后把结果和报告文件发给你。说一句「换到某某项目」就能切换项目。",
      }).catch((/** @type {any} */ error) => this.write(`im welcome failed: ${describeError(error, this.scrubber)}\n`));
    }
    return { botName: binding.metadata.botName ?? null, pendingApproval: pending, tenantBrand: binding.metadata.tenantBrand };
  }

  /**
   * Unbind: stop the connection, forget the secret, drop the binding (its
   * chats, tasks and pushes go with it), and stop routing pushes to it. The
   * app itself stays in the person's Feishu; only they can delete it there.
   * @param {any} user
   */
  async unbind(user) {
    this.#requireEnabled();
    this.registrations.get(user.id)?.manager.cancel();
    const bindings = await this.store.bindingsFor(user.id, "feishu");
    for (const binding of bindings) {
      await this.connections.stop(binding.id);
      this.feishu.forget(binding.id);
      await this.store.deleteBinding(user.id, binding.id);
    }
    await this.credentials?.removeChannelSecret(user.id, FEISHU_CREDENTIAL);
    await this.notifications?.setPreferenceChannel(user.id, "feishu", false).catch(() => null);
    await this.audit("im.feishu.unbind", "completed", { userId: user.id, code: `bindings:${bindings.length}` });
    return { removed: bindings.length };
  }

  // --- the own app's push tokens ---------------------------------------------------

  /** @param {any} user @param {Record<string, any>} input */
  async registerPushToken(user, input) {
    if (!this.registry.isEnabled("app")) throw new HttpError(404, "channel_disabled", "The app channel is not enabled on this deployment.");
    const binding = await this.registry.get("app").bind(user.id, input);
    return { id: binding.id, platform: binding.metadata.platform, deviceName: binding.metadata.deviceName ?? null, createdAt: binding.createdAt };
  }

  /** @param {any} user */
  async listPushTokens(user) {
    if (!this.registry.isEnabled("app")) throw new HttpError(404, "channel_disabled", "The app channel is not enabled on this deployment.");
    return (await this.store.bindingsFor(user.id, "app")).map((binding) => ({
      id: binding.id, platform: binding.metadata.platform ?? null, deviceName: binding.metadata.deviceName ?? null,
      createdAt: binding.createdAt,
    }));
  }

  /** @param {any} user @param {string} id */
  async removePushToken(user, id) {
    if (!this.registry.isEnabled("app")) throw new HttpError(404, "channel_disabled", "The app channel is not enabled on this deployment.");
    const removed = await this.store.deleteBinding(user.id, id);
    if (!removed || removed.channel !== "app") throw new HttpError(404, "push_token_not_found", "No such device.");
    if (removed.credentialRef) await this.credentials?.removeChannelSecret(user.id, removed.credentialRef).catch(() => false);
    return { removed: true };
  }

  // --- inbound ---------------------------------------------------------------------

  /**
   * One event off a long connection: hand it to the adapter, which records it
   * (or declines it) — nothing slower happens before Feishu is acknowledged.
   * @param {any} binding @param {any} payload
   */
  async handleFeishuEvent(binding, payload) {
    const outcome = await this.feishu.onInbound({ binding, payload });
    if (!outcome.accepted) this.count(`inbound_${String(outcome.reason).replaceAll("-", "_")}`);
  }

  /**
   * The durable inbox for inbound messages: one insert, deduplicated on the
   * platform's event id; the worker takes it from here.
   * @param {{ channel: string, binding: any, message: Record<string, any> }} input
   */
  async acceptInbound({ channel, binding, message }) {
    const { inserted } = await this.store.recordInbound({
      channel, eventKey: String(message.eventId), bindingId: binding.id, userId: binding.userId, payload: message,
    });
    this.count(inserted ? "inbound_received" : "inbound_duplicate");
    if (inserted) this.wake();
  }

  /** Claim and handle what has arrived. @param {number} [limit] */
  async processInbound(limit = 5) {
    if (!this.enabled) return 0;
    const events = await this.store.claimInbound({
      owner: this.workerId, leaseMs: Number(this.config.imLeaseMs) || 300_000, limit, maxAttempts: INBOUND_MAX_ATTEMPTS,
    });
    for (const event of events) {
      /** @type {{ status: 'done' | 'ignored' | 'failed', outcome: Record<string, any> }} */
      let result;
      try {
        result = await this.#handleInbound(event);
      } catch (error) {
        this.write(`im inbound ${event.id} failed (attempt ${event.attempts}): ${describeError(error, this.scrubber)}\n`);
        if (event.attempts >= INBOUND_MAX_ATTEMPTS) {
          await this.#tellChatFailed(event, error);
          result = { status: "failed", outcome: { code: errorCode(error) } };
        } else {
          await this.store.releaseInbound(event.id, this.workerId);
          continue;
        }
      }
      await this.store.finishInbound(event.id, this.workerId, result);
    }
    return events.length;
  }

  /** The last attempt failed: say so in the chat instead of going silent.
   *  @param {any} event @param {unknown} error */
  async #tellChatFailed(event, error) {
    const binding = await this.store.bindingById(event.bindingId).catch(() => null);
    if (!binding || !event.payload?.chatId) return;
    this.count("inbound_failed");
    const card = event.outcome?.card;
    const text = `这条消息没能处理（${errorCode(error)}），请稍后再发一次。`;
    try {
      if (card?.cardId && card.messageId) {
        await this.feishu.conversation.closeCard({ binding, card, question: event.payload.text ?? "", outcome: "failed", status: `❌ ${text}` });
      } else {
        await this.feishu.conversation.sendText({ binding, chatId: event.payload.chatId, replyTo: event.payload.messageId ?? null,
          text, key: `failed:${event.id}` });
      }
    } catch (sendError) {
      this.write(`im failure notice ${event.id} not sent: ${describeError(sendError, this.scrubber)}\n`);
    }
  }

  /**
   * One message, handled: attribute it to a project, let the model say whether
   * it moves the chat or adds to the running task, then act.
   * @param {any} event
   * @returns {Promise<{ status: 'done' | 'ignored', outcome: Record<string, any> }>}
   */
  async #handleInbound(event) {
    const message = event.payload;
    const binding = await this.store.bindingById(event.bindingId);
    if (!binding || binding.status !== "active") return { status: "ignored", outcome: { reason: "binding-gone" } };
    const conversation = this.registry.get(binding.channel)?.conversation;
    if (!conversation) return { status: "ignored", outcome: { reason: "no-conversation" } };
    const user = await this.users.userById(binding.userId);
    if (!user) return { status: "ignored", outcome: { reason: "account-gone" } };
    const chat = await this.store.ensureChat({ bindingId: binding.id, chatId: message.chatId, userId: user.id, chatType: message.chatType });
    const checkpoint = { ...(event.outcome ?? {}) };
    const reply = (/** @type {string} */ text, /** @type {string} */ suffix) => conversation.sendText({
      binding, chatId: message.chatId, replyTo: message.messageId, text, key: `${event.id}:${suffix}`,
    });

    if (!message.supported || !String(message.text ?? "").trim()) {
      await reply("目前只能处理文字消息。请把问题用文字发给我；文件可以在网页的「文件」里上传后再提问。", "unsupported");
      this.count("inbound_unsupported");
      return { status: "done", outcome: { action: "unsupported" } };
    }

    const projects = await this.#projects(user);
    let projectId = checkpoint.projectId ?? await this.#currentProject(user, chat, projects);
    const openTask = await this.store.openTaskForChat(binding.id, chat.chatId);
    const running = openTask?.status === "running";
    if (!checkpoint.projectId) {
      const intent = await this.classifier.classify({
        userId: user.id, projectId, text: message.text, projects,
        runningTask: running ? { question: openTask?.card?.question ?? "" } : null,
      });
      if (intent.source === "fallback") this.count(`intent_fallback_${intent.failure ?? "unknown"}`);
      if (intent.switchTo) {
        await this.store.selectChatProject(binding.id, chat.chatId, intent.switchTo, new Date(this.now()));
        projectId = intent.switchTo;
        this.count("chat_switched");
        if (!intent.hasRequest) {
          const name = projects.find((project) => project.id === projectId)?.name ?? projectId;
          await reply(`好的，之后在这里发的问题都放进「${name}」项目。`, "switch");
          return { status: "done", outcome: { action: "switch", projectId } };
        }
      } else if (intent.continuesRunningTask && running && openTask) {
        const steered = await this.#steer(user, openTask, message.text);
        if (steered) {
          await reply(steered, "steer");
          return { status: "done", outcome: { action: "steer", runId: openTask.runId } };
        }
      }
      if (chat.chatType === "group" && !chat.projectId) {
        // One group, one project: the first message fixes it, and only an
        // explicit switch moves it afterwards.
        await this.store.selectChatProject(binding.id, chat.chatId, projectId, new Date(this.now()));
      }
      checkpoint.projectId = projectId;
      await this.store.checkpointInbound(event.id, this.workerId, { projectId });
    }
    return this.#startTask({ event, binding, user, chat, message, projectId, checkpoint, openTask, conversation });
  }

  /**
   * A correction to the running task, through the same route the page's
   * 「补充」 uses. Returns the sentence for the chat, or null when the run had
   * already ended and the message should start new work instead.
   * @param {any} user @param {any} task @param {string} text
   */
  async #steer(user, task, text) {
    try {
      const project = await this.users.requireProject(user, task.projectId);
      await this.steerRun({ user, project, runId: task.runId, text });
      this.count("run_steered");
      return "已收到补充，正在进行的任务会把它一并考虑进去。";
    } catch (error) {
      if (error instanceof HttpError && error.code === "agent_run_not_running") return null;
      if (error instanceof HttpError && error.code === "agent_run_correction_limit") {
        return "这个任务已经收到很多条补充了，等它完成后再发新的要求吧。";
      }
      throw error;
    }
  }

  /**
   * Open the card, dispatch the run, and hand it to the task tracker. Each
   * step is checkpointed, so a retry after a crash reuses the card it already
   * showed and the run it already started (the dispatch id is derived from
   * the event, and the ledger answers a known dispatch id with its run).
   */
  /** @returns {Promise<{ status: 'done' | 'ignored', outcome: Record<string, any> }>} */
  async #startTask(/** @type {any} */ { event, binding, user, chat, message, projectId, checkpoint, openTask, conversation }) {
    const project = await this.users.requireProject(user, projectId);
    let card = checkpoint.card ?? null;
    if (!card) {
      card = await conversation.openCard({
        binding, chatId: message.chatId, replyTo: message.messageId, question: message.text,
        status: "收到，正在安排…", key: event.id, link: null,
      });
      checkpoint.card = card;
      await this.store.checkpointInbound(event.id, this.workerId, { card });
    }
    const sessionId = checkpoint.sessionId ?? await this.#sessionFor(binding, chat, projectId, openTask);
    if (!checkpoint.sessionId) {
      checkpoint.sessionId = sessionId;
      await this.store.checkpointInbound(event.id, this.workerId, { sessionId });
    }
    const dispatchId = `im-${digestHex(`${event.channel}\u0000${event.eventKey}`).slice(0, 32)}`;
    let run;
    try {
      run = await this.dispatchRun({ user, project, sessionId, dispatchId, text: message.text });
    } catch (error) {
      if (!isRefusal(error)) throw error;
      // Refused before any work started (a spend cap, the runtime limit, a
      // provider this deployment has not configured): said in the card, in
      // the domain's own sentence, and not retried.
      const code = errorCode(error);
      this.count("dispatch_refused");
      await conversation.closeCard({
        binding, card, question: message.text, outcome: "failed",
        status: `❌ 没有开始：${errorCodeMessage(code)}`,
      });
      return { status: "done", outcome: { action: "refused", code } };
    }
    const link = runLink(this.config, run.id);
    const task = await this.store.createTask({
      bindingId: binding.id, userId: user.id, projectId, chatId: message.chatId, replyTo: message.messageId,
      sessionId, runId: run.id, card: { ...card, link: link ?? null, lastUpdatedAt: 0 },
    });
    await this.store.touchChatSession({ bindingId: binding.id, chatId: chat.chatId, userId: user.id, projectId, sessionId,
      at: new Date(this.now()) });
    this.count("run_dispatched");
    this.wake();
    return { status: "done", outcome: { action: "dispatch", runId: run.id, taskId: task.id } };
  }

  /**
   * The conversation a message continues: this chat's session in this
   * project if it spoke within the idle window and nothing is running in it,
   * else a new one (a session holds one run at a time, and a quiet day is a
   * new question).
   */
  async #sessionFor(/** @type {any} */ binding, /** @type {any} */ chat, /** @type {string} */ projectId, /** @type {any} */ openTask) {
    const existing = await this.store.chatSession(binding.id, chat.chatId, projectId);
    const idleMs = Math.max(1, Number(this.config.imConversationIdleMinutes) || 360) * 60_000;
    const fresh = existing && this.now() - Date.parse(existing.lastMessageAt ?? "") < idleMs;
    const busy = openTask && openTask.status === "running" && openTask.sessionId === existing?.sessionId;
    if (fresh && !busy) return existing.sessionId;
    return `im-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  }

  /**
   * The account's live projects, with when each was last worked in.
   * @param {any} user @returns {Promise<{ id: string, name: string, lastActivityAt: string | null }[]>}
   */
  async #projects(user) {
    const listed = await this.users.listProjects(user);
    const live = listed.filter((/** @type {any} */ project) => !project.archivedAt);
    return Promise.all(live.map(async (/** @type {any} */ project) => {
      let lastActivityAt = null;
      try {
        lastActivityAt = (await this.agentRuns.activitySummary(await this.users.requireProject(user, project.id))).lastActivityAt ?? null;
      } catch { /* an unreadable ledger is unknown activity, not a failed message */ }
      return { id: project.id, name: project.name, lastActivityAt };
    }));
  }

  /**
   * Which project this message is about. A group keeps the project it was
   * given. A one-to-one chat follows the researcher: the project they worked
   * in most recently, unless they told this chat otherwise more recently than
   * that.
   * @param {any} user @param {any} chat @param {readonly { id: string, lastActivityAt: string | null }[]} projects
   */
  async #currentProject(user, chat, projects) {
    const known = new Set(projects.map((project) => project.id));
    if (chat.chatType === "group" && chat.projectId && known.has(chat.projectId)) return chat.projectId;
    let recent = null;
    for (const project of projects) {
      if (project.lastActivityAt && (!recent || project.lastActivityAt > recent.lastActivityAt)) recent = project;
    }
    const chosen = chat.projectId && known.has(chat.projectId) ? chat.projectId : null;
    if (chosen && (!recent || !chat.projectSelectedAt || chat.projectSelectedAt >= /** @type {string} */ (recent.lastActivityAt))) {
      return chosen;
    }
    if (recent) return recent.id;
    if (chosen) return chosen;
    return (await this.users.defaultProject(user)).id;
  }

  // --- tasks: the card in place, the result into the chat ---------------------------

  /** Claim tasks that are due and move each one forward. @param {number} [limit] */
  async processTasks(limit = 10) {
    if (!this.enabled) return 0;
    const tasks = await this.store.claimTasks({ owner: this.workerId, leaseMs: Number(this.config.imLeaseMs) || 300_000, limit });
    for (const task of tasks) {
      try {
        await this.#advanceTask(task);
      } catch (error) {
        const attempts = task.attempts + 1;
        const retryable = !(error instanceof FeishuApiError) || error.retryable;
        this.write(`im task ${task.id} step failed (attempt ${attempts}): ${describeError(error, this.scrubber)}\n`);
        await this.store.settleTask(task.id, this.workerId, retryable && attempts < DELIVERY_MAX_ATTEMPTS
          ? { attempts, nextCheckAt: new Date(this.now() + RETRY_BASE_MS * 2 ** (attempts - 1)) }
          : { attempts, status: "failed", finished: true, result: { ...task.result, error: errorCode(error) } });
        if (!(retryable && attempts < DELIVERY_MAX_ATTEMPTS)) this.count("task_failed");
      }
    }
    return tasks.length;
  }

  /** @param {any} task */
  async #advanceTask(task) {
    const binding = await this.store.bindingById(task.bindingId);
    const conversation = binding ? this.registry.get(binding.channel)?.conversation : null;
    const user = binding ? await this.users.userById(task.userId) : null;
    if (!binding || !conversation || !user) {
      await this.store.settleTask(task.id, this.workerId, { status: "failed", finished: true, result: { ...task.result, error: "binding_gone" } });
      return;
    }
    const project = await this.users.requireProject(user, task.projectId);
    const listed = (await this.agentRuns.list(project)).find((/** @type {any} */ run) => run.id === task.runId);
    const [run] = listed ? await this.agentRuns.withPlanProgress(project, [listed]) : [null];
    const card = { ...task.card };
    const now = this.now();
    if (!run) {
      await conversation.closeCard({ binding, card, question: card.question ?? "", outcome: "failed",
        status: "❌ 找不到这次运行的记录。" });
      await this.store.settleTask(task.id, this.workerId, { status: "failed", finished: true, card, result: { ...task.result, error: "run_missing" } });
      return;
    }
    if (run.status === "running") {
      if (now - Date.parse(task.createdAt ?? "") > TASK_TRACK_LIMIT_MS) {
        await conversation.closeCard({ binding, card, question: card.question ?? "", outcome: "stopped",
          status: "⏸ 任务运行超过一天，这里不再跟踪进度；结果请在网页中查看。", link: card.link ?? null });
        await this.store.settleTask(task.id, this.workerId, { status: "failed", finished: true, card, result: { ...task.result, error: "tracking_expired" } });
        return;
      }
      const interval = Math.max(1_000, Number(this.config.imProgressIntervalMs) || 15_000);
      const view = progressView(run, now);
      if (now - Number(card.lastUpdatedAt ?? 0) >= interval && (view.status !== card.status || view.progress !== card.progress)) {
        await conversation.updateCard({ binding, card, status: view.status, progress: view.progress });
        card.lastUpdatedAt = now;
        this.count("card_updated");
      }
      await this.store.settleTask(task.id, this.workerId, { card, attempts: 0, nextCheckAt: new Date(now + interval) });
      return;
    }
    if (task.status !== "delivering") await this.store.checkpointTask(task.id, this.workerId, { status: "delivering" });
    await this.#deliverResult({ task, binding, conversation, project, run, card });
  }

  /**
   * The run ended: close the card, send the answer, send the files — each step
   * recorded as it completes, each message under its own stable uuid, so a
   * retry resends nothing the chat already has (dsh-im's timeout resend,
   * made durable).
   */
  async #deliverResult(/** @type {any} */ { task, binding, conversation, project, run, card }) {
    const result = { ...task.result };
    const question = card.question ?? run.question ?? "";
    const link = card.link ?? runLink(this.config, run.id);
    const notice = runFinishedNotice(run);
    const minutes = elapsedMinutes(run.startedAt, Date.parse(run.finishedAt ?? "") || this.now());
    if (!result.cardClosed) {
      const icon = { delivered: "✅", qualified: "⚠️", stopped: "⏹" }[cardOutcome(notice.outcome)] ?? "❌";
      await conversation.closeCard({
        binding, card, question, outcome: cardOutcome(notice.outcome),
        status: `${icon} ${notice.title}${minutes ? ` · 用时 ${minutes} 分钟` : ""}`,
        lines: notice.body.split("\n").filter(Boolean), link,
      });
      result.cardClosed = true;
      await this.store.checkpointTask(task.id, this.workerId, { card, result });
    }
    if (!result.answered) {
      const text = await this.#finalReply(project, run);
      if (text) {
        result.answerMessageIds = await conversation.sendAnswer({ binding, chatId: task.chatId, replyTo: task.replyTo,
          text, link, key: task.id });
      }
      result.answered = true;
      await this.store.checkpointTask(task.id, this.workerId, { result });
    }
    const files = this.#deliverableFiles(run);
    result.files = result.files ?? {};
    const linkLines = [];
    for (const [index, filePath] of files.entries()) {
      if (result.files[filePath]) continue;
      if (index >= Math.max(0, Number(this.config.imMaxResultFiles) || 5)) {
        result.files[filePath] = { link: runFileLink(this.config, run.id, filePath) };
        continue;
      }
      const file = await this.#readDeliverable(project, filePath);
      if (!file || "tooLarge" in file) {
        result.files[filePath] = { link: runFileLink(this.config, run.id, filePath), reason: file ? "too_large" : "unreadable" };
      } else {
        try {
          const messageId = await conversation.sendFile({ binding, chatId: task.chatId, replyTo: null, fileName: file.name,
            bytes: file.bytes, key: `${task.id}:${filePath}` });
          result.files[filePath] = { messageId };
          this.count("file_sent");
        } catch (error) {
          if (!(error instanceof FeishuApiError) || error.retryable) throw error;
          result.files[filePath] = { link: runFileLink(this.config, run.id, filePath), reason: error.code };
        }
      }
      await this.store.checkpointTask(task.id, this.workerId, { result });
    }
    for (const [filePath, entry] of Object.entries(result.files)) {
      if (entry?.link) linkLines.push(`· ${path.basename(filePath)}：${entry.link}`);
    }
    if (linkLines.length && !result.linksSent) {
      await conversation.sendText({ binding, chatId: task.chatId, replyTo: null, key: `${task.id}:links`,
        text: `以下文件较大或较多，请在网页中打开：\n${linkLines.join("\n")}` });
      result.linksSent = true;
    }
    await this.store.settleTask(task.id, this.workerId, { status: "done", finished: true, result, card, attempts: 0 });
    this.count("result_delivered");
  }

  /**
   * The run's last words: from the live runtime while it is still up (the
   * common case, minutes after the finish), else from the transcript the
   * run-finished hook wrote to disk. Null when neither can be read — the card
   * and its link still say where the answer is.
   * @param {any} project @param {any} run
   */
  async #finalReply(project, run) {
    try {
      const live = await this.runtimeManager.sessionTranscript(project, run.sessionId, { wake: false });
      const text = finalReplyText(live?.messages ?? [], run);
      if (text) return text;
    } catch { /* the runtime has stopped; the stored transcript is next */ }
    try {
      const stored = await readRunTranscript(project, run.id);
      if (stored) return finalReplyText(stored.messages.filter((/** @type {any} */ message) => message.sessionId === run.sessionId), run);
    } catch { /* unreadable: the card's link carries the answer */ }
    return null;
  }

  /** The files the run delivered, in the order the record lists them.
   *  @param {any} run @returns {string[]} */
  #deliverableFiles(run) {
    const kinds = run.artifactKinds && typeof run.artifactKinds === "object" ? run.artifactKinds : null;
    const paths = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])])]
      .filter((value) => typeof value === "string" && value);
    return kinds ? paths.filter((value) => kinds[value] === "deliverable") : [];
  }

  /**
   * One delivered file's bytes, read the way the download route reads it:
   * scoped to the workspace, no symlink followed, a regular file only.
   * @param {any} project @param {string} relative
   * @returns {Promise<{ bytes: Buffer, name: string } | { tooLarge: true } | null>}
   */
  async #readDeliverable(project, relative) {
    let opened;
    try {
      const full = resolveScopedPath(project.workspaceDir, relative);
      opened = await openScopedFileNoFollow(project.workspaceDir, full);
      if (opened.stat.size > FEISHU_MAX_FILE_BYTES) return { tooLarge: true };
      if (opened.stat.size === 0) return null;
      return { bytes: await opened.handle.readFile(), name: path.basename(full) };
    } catch {
      return null;
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }

  // --- inbox pushes --------------------------------------------------------------

  /**
   * An inbox item was created or grew: queue a push to every enabled channel
   * the researcher chose, timed by their quiet hours and digest time.
   * Called after the inbox's own commit, never inside it.
   * @param {any} item
   */
  async notificationChanged(item) {
    if (!this.enabled || !item || item.silent || item.readAt) return;
    try {
      const preferences = await this.notifications.preferences(item.userId);
      await this.#enqueuePushes(item, preferences);
    } catch (error) {
      this.count("notice_enqueue_failed");
      this.write(`im notice ${item.id} not queued: ${describeError(error, this.scrubber)}\n`);
    }
  }

  /** @param {any} item @param {any} preferences */
  async #enqueuePushes(item, preferences) {
    const channels = (Array.isArray(preferences?.channels) ? preferences.channels : [])
      .filter((/** @type {string} */ id) => id !== IN_APP_CHANNEL && this.registry.isEnabled(id));
    if (!channels.length) return 0;
    if (preferences?.switches && preferences.switches[item.noticeType] === false) return 0;
    // A run a chat started reports into that chat already; the inbox item is
    // the record, not a second buzz.
    if (item.source?.type === "run" && item.projectId && await this.store.taskForRun(item.userId, item.projectId, item.source.id)) {
      return 0;
    }
    const notBefore = pushNotBefore(item, preferences, new Date(this.now()));
    let queued = 0;
    for (const channel of channels) {
      for (const binding of await this.store.bindingsFor(item.userId, channel)) {
        if (binding.status !== "active") continue;
        // News from before the binding existed is on the page, not a buzz.
        if (Date.parse(item.updatedAt ?? item.createdAt ?? "") < Date.parse(binding.createdAt ?? "")) continue;
        const row = await this.store.enqueueDelivery({ userId: item.userId, channel, bindingId: binding.id,
          notificationId: item.id, eventCount: Number(item.count) || 1, notBefore });
        if (row) queued += 1;
      }
    }
    if (queued) this.wake();
    return queued;
  }

  /** Push what is due. @param {number} [limit] */
  async processDeliveries(limit = 20) {
    if (!this.enabled) return 0;
    const deliveries = await this.store.claimDeliveries({ owner: this.workerId, leaseMs: Number(this.config.imLeaseMs) || 300_000, limit });
    for (const delivery of deliveries) {
      try {
        await this.#deliver(delivery);
      } catch (error) {
        const retryable = !(error instanceof FeishuApiError) || error.retryable;
        const again = retryable && delivery.attempts < DELIVERY_MAX_ATTEMPTS;
        await this.store.settleDelivery(delivery.id, this.workerId, again
          ? { status: "pending", reason: errorCode(error), retryAt: new Date(this.now() + RETRY_BASE_MS * 2 ** (delivery.attempts - 1)) }
          : { status: "failed", reason: errorCode(error) });
        if (!again) this.count("push_failed");
      }
    }
    return deliveries.length;
  }

  /** @param {any} delivery */
  async #deliver(delivery) {
    const skip = async (/** @type {string} */ reason) => {
      await this.store.settleDelivery(delivery.id, this.workerId, { status: "skipped", reason });
      this.count(`push_skipped_${reason.replaceAll("-", "_")}`);
    };
    if (!this.registry.isEnabled(delivery.channel)) return skip("channel-disabled");
    const binding = await this.store.bindingById(delivery.bindingId);
    if (!binding || binding.status !== "active") return skip("binding-gone");
    let item;
    try {
      item = await this.notifications.get(delivery.userId, delivery.notificationId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return skip("notice-gone");
      throw error;
    }
    if (item.readAt) return skip("already-read");
    // A grouped item that grew again has a newer push queued; that one says
    // the current total, this one would say an old one.
    if (Number(item.count) !== delivery.eventCount) return skip("superseded");
    const message = channelMessage({
      kind: "notification", title: item.title, body: item.body, link: noticeLink(this.config, item),
      linkLabel: "在网页中查看", severity: item.severity, idempotencyKey: `${item.id}:${delivery.eventCount}`,
    });
    const outcome = deliveryOutcome(await this.registry.get(delivery.channel).deliver(binding, message));
    if (!outcome.delivered) return skip(outcome.reason ?? "not-delivered");
    await this.store.settleDelivery(delivery.id, this.workerId, { status: "sent", messageId: outcome.messageId });
    await this.notifications.recordChannelSent(delivery.userId, item.id, delivery.channel, new Date(this.now()))
      .catch(() => null);
    this.count("push_sent");
  }

  /**
   * Re-derive pushes a crash between the inbox's commit and the hook dropped:
   * unread items of the last day, for every account with an active binding.
   */
  async reconcilePushes() {
    if (!this.enabled || !this.notifications) return 0;
    let queued = 0;
    const seen = new Set();
    for (const channel of this.registry.enabledIds()) {
      for (const binding of await this.store.activeBindings(channel)) {
        if (seen.has(binding.userId)) continue;
        seen.add(binding.userId);
        const preferences = await this.notifications.preferences(binding.userId).catch(() => null);
        if (!preferences) continue;
        const page = await this.notifications.list(binding.userId, { unreadOnly: true, limit: 50 }).catch(() => null);
        for (const item of page?.items ?? []) {
          if (item.silent || this.now() - Date.parse(item.updatedAt ?? "") > RECONCILE_WINDOW_MS) continue;
          queued += await this.#enqueuePushes(item, preferences);
        }
      }
    }
    return queued;
  }

  // --- housekeeping ----------------------------------------------------------------

  /** Keep the long connections matching the bindings. */
  async syncConnections() {
    if (!this.enabled) {
      await this.connections.sync([]);
      return;
    }
    await this.connections.sync(await this.store.activeBindings("feishu"));
  }

  /**
   * A bot created in an enterprise tenant may wait for an administrator to
   * enable it. Its status is re-read until it is enabled, and the welcome
   * message goes out then — the person should not have to scan again.
   */
  async refreshPendingBots() {
    if (!this.enabled) return;
    for (const binding of await this.store.activeBindings("feishu")) {
      if (!FEISHU_PENDING_ACTIVATION.includes(Number(binding.metadata.activateStatus))) continue;
      try {
        const bot = await this.feishu.refresh(binding);
        await this.store.patchBindingMetadata(binding.id, { activateStatus: bot.activateStatus, botName: bot.name, botOpenId: bot.openId });
        if (!FEISHU_PENDING_ACTIVATION.includes(Number(bot.activateStatus)) && !FEISHU_DISABLED_ACTIVATION.includes(Number(bot.activateStatus))) {
          await this.feishu.conversation.sendText({
            binding, chatId: null, replyTo: null, key: `welcome:${binding.id}`,
            text: "你的 EviMed 研究助手已经启用。直接把问题发给我就行。",
          }).catch(() => null);
        }
      } catch (error) {
        this.write(`im bot refresh ${binding.id}: ${describeError(error, this.scrubber)}\n`);
      }
    }
  }

  /** Sweep what nothing reads any more: handled inbound rows past the dedupe
   *  window, settled pushes, finished registrations. */
  async prune() {
    const now = this.now();
    await this.store.closeExhaustedInbound(INBOUND_MAX_ATTEMPTS);
    await this.store.pruneInbound(new Date(now - INBOUND_RETENTION_MS));
    await this.store.pruneDeliveries(new Date(now - DELIVERY_RETENTION_MS));
    for (const [userId, entry] of this.registrations) {
      if (!entry.manager.active && now - entry.touchedAt > 15 * 60_000) this.registrations.delete(userId);
    }
  }

  async close() {
    for (const entry of this.registrations.values()) entry.manager.cancel();
    await this.connections.closeAll();
  }
}

/**
 * The whole module, composed: what `createWebApiApp` registers with one call
 * and a handful of one-line hooks (routes, worker lifecycle, device step).
 *
 * Without the product database there is no module — the routes answer 503 by
 * name and the device step answers nothing. With the database but the switch
 * off, the routes still describe the channels (all off) and the device-token
 * routes follow their own switch; no connection, worker or push exists, and
 * the inbox is not touched.
 *
 * @param {{ config: Record<string, any>, database: any, credentials: any, notifications: any, users: any, agentRuns: any,
 *   runtimeManager: any, usageLedger?: any, maxJsonBytes: number,
 *   dispatchRun: (input: any) => Promise<any>, steerRun: (input: any) => Promise<any>,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<void>,
 *   loadSdk?: () => Promise<any>, fetchImpl?: typeof fetch }} dependencies
 */
export function createImModule({ config, database, credentials, notifications, users, agentRuns, runtimeManager,
  usageLedger = null, maxJsonBytes, dispatchRun, steerRun, audit = async () => {}, loadSdk, fetchImpl }) {
  const deviceTokens = database ? new DeviceTokenStore(database) : null;
  const authenticateDevice = createDeviceAuthentication({
    config, tokens: deviceTokens, userById: (id) => users.userById(id),
  });
  const service = database && credentials
    ? new ImService({ config, database, credentials, notifications, users, agentRuns, runtimeManager, usageLedger,
      dispatchRun, steerRun, audit, loadSdk, fetchImpl })
    : null;
  // The inbox learns about channels only when the module is on: off, it
  // validates and delivers exactly what it did before (X6).
  if (service && config.imEnabled === true && notifications) {
    notifications.attachChannels({ registry: service.registry, onChange: (item) => { void service.notificationChanged(item); } });
  }
  const worker = service && config.imEnabled === true ? new ImWorker({ service, pollMs: config.imPollMs }) : null;
  const routes = createImRoutes({ config, store: users, service, deviceTokens, maxJsonBytes, audit });
  return { service, worker, routes, authenticateDevice, deviceTokens };
}
