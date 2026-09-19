/**
 * The runtime as an Alibaba AgentBay cloud session (plan §3.1): one session per
 * project, a VM of its own with the EviMed runtime image, reached only through
 * its session link.
 *
 * The shape is the Docker provider's, with the container swapped for a
 * session. The kernel starts with today's flags on loopback; the session
 * bridge (deploy/runtime-dsh/evimed-session-bridge.mjs) sits in front of it on
 * the link's port and the link tunnel (./linkTunnel.mjs) is the unix socket the
 * control plane has always dialled. The host directory stays the copy of
 * record (./workspaceSync.mjs). What the session cannot have, it never gets:
 * credentials, the generated profile patch and token files are written through
 * the file API after the session starts, never through a Context, and the
 * provider key never leaves the control plane.
 *
 * Three limits of AgentBay shape the rest (verified against SDK 0.22.0 and
 * the product documentation, 2026-09-19):
 *   - a command call returns within 50 s, so it only ever starts the kernel
 *     (`evimed-session start`) and never carries a run;
 *   - a session's idle clock counts SDK calls, not link traffic, so the
 *     heartbeat keeps it alive while this control plane uses it, and the
 *     control plane's own reaper decides idleness;
 *   - a released session cannot be recovered, and the Context uploaded at its
 *     release is then the newest copy of the project, which the next start
 *     brings home before it pushes anything.
 *
 * @module agentbay/runtimeProvider
 */

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, readTextFileNoFollow, writeJsonFileAtomicNoFollow } from "../security.mjs";
import { runtimeEnvironment } from "../dshProfilePatch.mjs";
import {
  RUNTIME_AUTHORITY,
  appendRuntimeEventForProvider,
  capsuleMethodsHostDir,
  issueEviMedWorkloadToken,
  personalLibraryDir,
  runtimeCompactionSettings,
  syncRuntimeDshProfile,
} from "../runtimeManager.mjs";
import { compactionRuntimeEnv } from "@evimed/harness-port";
import { createLinkTunnel } from "./linkTunnel.mjs";
import { publicRuntimeGatewayUrls } from "../runtimeGatewayEntry.mjs";
import {
  baselineFrom,
  loadSyncManifest,
  manifestFromSignatures,
  mirrorSession,
  parseSessionManifest,
  pushTree,
  recoverTree,
  saveSyncManifest,
} from "./workspaceSync.mjs";

/** Where things are inside a session. The image lays them out (deploy/runtime-dsh). */
export const SESSION_PATHS = Object.freeze({
  workspace: "/workspace",
  knowledgeBase: "/workspace/knowledge-base",
  library: "/workspace/library",
  dshHome: "/runtime/dsh-home",
  sessions: "/runtime/dsh-home/sessions",
  storages: "/runtime/dsh-home/storages",
  incoming: "/run/evimed/incoming",
  capsuleMethods: "/run/evimed/capsule-methods",
  launcher: "/usr/local/bin/evimed-session",
});

/** The kernel's loopback port inside every session. A session is a machine of
 *  its own, so one fixed port serves every project. */
export const SESSION_KERNEL_PORT = 4096;

/** The two top-level workspace directories a session receives download-only. */
const READ_ONLY_VIEWS = ["knowledge-base", "library"];

const COMMAND_TIMEOUT_MS = 50_000;

/** How long the delivery gate waits for the final mirror before reading the
 *  host copy as it is. The gate still runs either way. */
const DELIVERY_MIRROR_DEADLINE_MS = 120_000;

function sha(value, length = 24) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

/** A kernel environment file the launcher sources: one quoted literal a line. */
export function renderKernelEnvironment(values) {
  return `${Object.entries(values)
    .filter(([, value]) => value != null)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new HttpError(500, "agentbay_environment_invalid", `Invalid environment name ${key}.`);
      const text = String(value);
      if (/[\r\n\0]/.test(text)) throw new HttpError(500, "agentbay_environment_invalid", `${key} must be one line.`);
      return `${key}='${text.replace(/'/g, "'\\''")}'`;
    })
    .join("\n")}\n`;
}

/** One JSON object from a command's output: the launcher prints exactly one. */
function launcherReport(output) {
  const line = String(output ?? "").trim().split("\n").reverse().find((candidate) => candidate.startsWith("{"));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/**
 * The process handle the manager watches for a session runtime: no pid, an
 * `exit` when the session or the kernel in it is gone, and the heartbeat that
 * proves the link, keeps the session's idle clock from releasing it under a
 * run, and replaces an expired link.
 */
export class AgentBaySessionProcess extends EventEmitter {
  /**
   * @param {{ provider: AgentBayRuntimeProvider, project: Record<string, any>, sessionId: string, session: any,
   *   tunnel: any, heartbeatMs: number, report: Record<string, any> | null }} input
   */
  constructor({ provider, project, sessionId, session, tunnel, heartbeatMs, report }) {
    super();
    this.provider = provider;
    this.project = project;
    this.sessionId = sessionId;
    this.session = session;
    this.tunnel = tunnel;
    this.report = report;
    this.pid = null;
    this.exitCode = null;
    this.signalCode = null;
    this.exitOutput = "";
    this.failures = 0;
    this.kernelDown = 0;
    this.beating = false;
    this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || 25_000);
    this.timer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  /** One heartbeat. Never throws: a heartbeat that cannot tell leaves the
   *  runtime alone and asks again next time. */
  async beat() {
    if (this.beating || this.exitCode != null) return;
    this.beating = true;
    try {
      const client = this.provider.client;
      await client.guard("session keep-alive", () => this.session.keepAlive?.()).catch(() => {});
      const probe = await this.tunnel.probe();
      if (probe.ok && probe.upstream) {
        this.failures = 0;
        this.kernelDown = 0;
        return;
      }
      if (probe.ok) {
        // The bridge answers and the kernel behind it does not: twice in a row
        // is a kernel that died, and its own last words say why.
        this.kernelDown += 1;
        if (this.kernelDown >= 2) {
          this.exitOutput = await this.provider.kernelLog(this.session).catch(() => "");
          this.markExited(1, null);
        }
        return;
      }
      this.failures += 1;
      if (this.failures < 2) return;
      const found = await client.getSession(this.sessionId).catch(() => undefined);
      if (found === null) {
        this.exitOutput = "The AgentBay session was released.";
        this.markExited(137, "SIGKILL");
        return;
      }
      if (found) {
        // The session is there and its link is not: a link token that expired
        // or a proxy that cut the connection. New links; the relayed sockets
        // on the old ones are dropped, and their owners reconnect.
        this.session = found.session;
        const links = await this.provider.sessionLinks(found.session).catch(() => null);
        if (links) this.tunnel.replaceLinks(links);
      }
    } finally {
      this.beating = false;
    }
  }

  markExited(code = 0, signal = null) {
    if (this.exitCode != null || this.signalCode != null) return;
    clearInterval(this.timer);
    this.exitCode = Number.isSafeInteger(code) ? code : 1;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, this.signalCode);
  }

  async stop(signal = "SIGTERM") {
    clearInterval(this.timer);
    this.markExited(0, signal);
  }

  kill(signal = "SIGTERM") {
    void this.stop(signal);
    return true;
  }

  unref() {
    this.timer?.unref?.();
  }
}

export class AgentBayRuntimeProvider {
  /**
   * @param {any} manager
   * @param {{ client: import("./client.mjs").AgentBayClient }} options
   */
  constructor(manager, { client }) {
    this.manager = manager;
    this.client = client;
    /** @type {'agentbay'} */
    this.name = "agentbay";
    /** Live sessions by project key: the tunnel, the mirror state, the tokens. */
    this.live = new Map();
    /** A session's aftermath still being brought home, by project key: the
     *  next start of that project waits for it rather than pushing over it. */
    this.exiting = new Map();
  }

  /** Resolves once every exited session's aftermath has finished. */
  settled() {
    return Promise.allSettled([...this.exiting.values()]).then(() => undefined);
  }

  get config() { return this.manager.config; }

  /**
   * The settings an AgentBay deployment cannot run without, each refused by
   * name: a runtime that could start and then reach nothing is worse than one
   * that says why it cannot start.
   */
  assertConfigured() {
    const config = this.config;
    if (!this.client.configured) throw new HttpError(503, "agentbay_unconfigured", "OPEN_SCIENCE_AGENTBAY_API_KEY_FILE is empty.");
    if (!config.agentbayImageId) throw new HttpError(503, "agentbay_image_unconfigured", "OPEN_SCIENCE_AGENTBAY_IMAGE_ID is empty.");
    const port = Number(config.agentbayBridgePort);
    if (!Number.isInteger(port) || port < 30100 || port > 30199) {
      throw new HttpError(503, "agentbay_bridge_port_invalid", "OPEN_SCIENCE_AGENTBAY_BRIDGE_PORT must be within 30100–30199, the ports an AgentBay link opens.");
    }
    if (!["header", "path"].includes(String(config.agentbayBridgeSecretMode))) {
      throw new HttpError(503, "agentbay_bridge_secret_mode_invalid", "OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE must be header or path.");
    }
    if (!["full", "partial"].includes(String(config.agentbaySandboxEnforcement))) {
      throw new HttpError(503, "agentbay_sandbox_enforcement_invalid", "OPEN_SCIENCE_AGENTBAY_SANDBOX_ENFORCEMENT must be full or partial; a runtime without Landlock is never served.");
    }
    const gateway = this.gatewayOrigin();
    if (!gateway) {
      throw new HttpError(503, "agentbay_gateway_unconfigured", "OPEN_SCIENCE_RUNTIME_GATEWAY_PUBLIC_URL must be the https prefix a session reaches the gateways through.");
    }
    const ttl = Number(config.agentbayWorkloadTokenTtlSeconds);
    const refresh = Number(config.agentbayWorkloadTokenRefreshSeconds);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900 || !Number.isInteger(refresh) || refresh < 30 || refresh * 2 >= ttl) {
      throw new HttpError(503, "agentbay_workload_token_timing_invalid", "The workload token must outlive two missed renewals: refresh × 2 < TTL ≤ 900 s.");
    }
    return gateway;
  }

  /** Refused by name before a launch writes anything (`assertConfigured`). */
  preflight() {
    this.assertConfigured();
  }

  /** The public gateway prefix as a URL, or null. */
  gatewayOrigin() {
    const value = String(this.config.runtimeGatewayPublicUrl ?? "").trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  /** What readiness reports for this provider; the Docker controller is not asked. */
  async readiness() {
    this.assertConfigured();
    return {
      provider: "agentbay",
      sandboxMode: "agentbay",
      controlPlane: "agentbay_api",
      transport: "wss",
      region: this.client.region,
      imageId: this.config.agentbayImageId,
      bridgePort: Number(this.config.agentbayBridgePort),
      bridgeSecretMode: this.config.agentbayBridgeSecretMode,
      requiredEnforcement: this.config.agentbaySandboxEnforcement,
      firewallRequired: this.config.agentbayFirewallRequired !== false,
      gateway: this.gatewayOrigin()?.origin ?? null,
      lifecycleMinutes: { idle: this.config.agentbayIdleReleaseMinutes, max: this.config.agentbayMaxRuntimeMinutes },
      sdkVersion: await this.client.sdkVersion().catch(() => null),
    };
  }

  labels(project) {
    return {
      evimed: "runtime",
      user: String(project.userId),
      project: String(project.id),
      release: String(this.config.releaseId ?? "untracked"),
    };
  }

  contextName(kind, scope) {
    return `${this.config.agentbayContextPrefix || "evimed"}-${kind}-${sha(scope)}`;
  }

  stateDir(project) { return path.join(project.runtimeDir, "agentbay"); }
  recordFile(project) { return path.join(this.stateDir(project), "session.json"); }
  manifestFile(project, kind) { return path.join(this.stateDir(project), `manifest-${kind}.json`); }
  libraryManifestFile(project) {
    return path.join(this.config.dataDir, "users", String(project.userId), ".agentbay", "manifest-library.json");
  }

  /** The tunnel's socket, beside the Docker runtimes' own control sockets. */
  tunnelSocketPath(project) {
    return path.join(this.config.dataDir, ".runtime-sockets", `ab-${sha(`${project.userId}\0${project.id}`)}`, "dsh.sock");
  }

  async readRecord(project) {
    const text = await readTextFileNoFollow(project.rootDir, this.recordFile(project), "").catch(() => "");
    try {
      const record = JSON.parse(text);
      return record?.version === 1 && typeof record.sessionId === "string" ? record : null;
    } catch {
      return null;
    }
  }

  /** The session's own facts, kept host-side 0600 like a Docker runtime's
   *  credentials file: what a control plane that restarted needs to take the
   *  session back instead of starting over. */
  async writeRecord(project, record) {
    await fs.mkdir(this.stateDir(project), { recursive: true, mode: 0o700 });
    await writeJsonFileAtomicNoFollow(project.rootDir, this.recordFile(project), { version: 1, ...record });
  }

  async removeRecord(project) {
    await fs.rm(this.recordFile(project), { force: true }).catch(() => {});
  }

  /** The host directories a session's Contexts carry, and how. */
  views(project) {
    const inBase = Boolean(project.baseDir) && path.resolve(String(project.workspaceDir)) === path.resolve(String(project.baseDir));
    const hostDshHome = path.join(project.runtimeDir, "container-runtime", "dsh-home");
    return {
      workspace: { host: project.workspaceDir, mount: SESSION_PATHS.workspace, exclude: READ_ONLY_VIEWS, upload: true },
      sessions: { host: path.join(hostDshHome, "sessions"), mount: SESSION_PATHS.sessions, exclude: [], upload: true },
      storages: { host: path.join(hostDshHome, "storages"), mount: SESSION_PATHS.storages, exclude: [], upload: true },
      ...(inBase ? { kb: { host: path.join(project.baseDir, "knowledge-base"), mount: SESSION_PATHS.knowledgeBase, exclude: [], upload: false } } : {}),
      library: { host: personalLibraryDir(this.config, project.userId), mount: SESSION_PATHS.library, exclude: [], upload: false, account: true },
    };
  }

  async ensureContexts(project) {
    /** @type {Record<string, { id: string, name: string }>} */
    const contexts = {};
    for (const [kind, view] of Object.entries(this.views(project))) {
      const scope = view.account ? `${project.userId}` : `${project.userId}\0${project.id}`;
      const found = await this.client.contexts.get(this.contextName(kind, scope), { create: true });
      if (!found) throw new HttpError(502, "agentbay_context_failed", `The ${kind} Context could not be created.`);
      contexts[kind] = found;
    }
    return contexts;
  }

  /**
   * How each Context is attached to a session. The workspace goes both ways
   * except its two read-only views, which are their own download-only
   * Contexts (plan §3.1 #4): a run cannot change the knowledge base or the
   * library, because nothing it writes there is ever carried back.
   */
  contextSyncFor(project, contexts) {
    const policy = ({ upload, exclude }) => ({
      uploadPolicy: { autoUpload: upload, uploadStrategy: "UploadBeforeResourceRelease", uploadMode: "File" },
      downloadPolicy: { autoDownload: true, downloadStrategy: "DownloadAsync" },
      deletePolicy: { syncLocalFile: true },
      bwList: { whiteLists: [{ path: "", excludePaths: exclude.map((name) => `/${name}`) }] },
    });
    return Object.entries(this.views(project)).map(([kind, view]) => ({
      contextId: contexts[kind].id,
      path: view.mount,
      policy: policy(view),
    }));
  }

  /**
   * Host → Contexts before a session starts, after bringing home anything a
   * previous session left newer in them.
   */
  async pushProject(project, contexts) {
    const skipped = [];
    const maxFileBytes = Number(this.config.agentbaySyncMaxFileBytes) || 256 * 1024 * 1024;
    for (const [kind, view] of Object.entries(this.views(project))) {
      const context = contexts[kind];
      const manifestRoot = view.account ? path.join(this.config.dataDir, "users", String(project.userId)) : project.rootDir;
      const manifestFile = view.account ? this.libraryManifestFile(project) : this.manifestFile(project, kind);
      await fs.mkdir(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
      const manifest = await loadSyncManifest(manifestRoot, manifestFile);
      if (view.upload && !manifest.clean) {
        const recovered = await recoverTree({ client: this.client, contextId: context.id, hostRoot: view.host, exclude: view.exclude, manifest, maxFileBytes });
        skipped.push(...recovered.skipped.map((entry) => ({ ...entry, kind })));
      }
      await fs.mkdir(view.host, { recursive: true, mode: 0o700 }).catch(() => {});
      const pushed = await pushTree({ client: this.client, contextId: context.id, hostRoot: view.host, exclude: view.exclude, manifest, maxFileBytes });
      skipped.push(...pushed.skipped.map((entry) => ({ ...entry, kind })));
      // From here until this control plane's final pull, the session may
      // change what the Context holds.
      manifest.clean = !view.upload;
      await saveSyncManifest(manifestRoot, manifestFile, manifest);
    }
    if (skipped.length) {
      await appendRuntimeEventForProvider(project, "agentbay_sync_skipped", {
        files: skipped.slice(0, 20), total: skipped.length, maxFileBytes,
      }, this.config);
    }
  }

  /** The session's two links to the bridge port: HTTP and WebSocket. */
  async sessionLinks(session) {
    const port = Number(this.config.agentbayBridgePort);
    const [http, ws] = await Promise.all([
      this.client.guard("session link", () => session.getLink("https", port)),
      this.client.guard("session link", () => session.getLink("wss", port)),
    ]);
    if (!http?.success || !http.data || !ws?.success || !ws.data) {
      throw new HttpError(502, "agentbay_link_unavailable", "The session did not return a link to its bridge port.");
    }
    return { http: String(http.data), ws: String(ws.data) };
  }

  async command(session, line, envs) {
    const result = await this.client.guard("session command", () => session.command.executeCommand(line, COMMAND_TIMEOUT_MS, undefined, envs));
    return { ok: Boolean(result?.success), exitCode: result?.exitCode ?? null, stdout: String(result?.stdout ?? result?.output ?? ""), stderr: String(result?.stderr ?? "") };
  }

  async writeSessionFile(session, file, content) {
    const result = await this.client.guard("session file write", () => session.fileSystem.writeFile(file, String(content)));
    if (result?.success === false) throw new HttpError(502, "agentbay_file_write_failed", `A session file could not be written (${path.basename(file)}).`);
  }

  async kernelLog(session) {
    const result = await this.command(session, `${SESSION_PATHS.launcher} log`);
    return result.stdout.slice(-4096);
  }

  /** @param {Record<string, any>} project @param {{ port: number, pluginConfig: any, capsuleMethodsMounted: number }} input */
  async prepare(project, { pluginConfig, capsuleMethodsMounted }) {
    this.assertConfigured();
    // A session that just ended may still be coming home; its Context copy
    // and manifests are what this start reads.
    await this.exiting.get(this.manager.key(project));
    const release = String(this.config.releaseId ?? "untracked");
    const record = await this.readRecord(project);
    let existing = null;
    if (record) {
      const found = await this.client.getSession(record.sessionId).catch(() => null);
      if (found && record.release === release && record.imageId === this.config.agentbayImageId && record.bridgeSecret) {
        existing = found;
      } else if (found) {
        // A session of another release or image: bring its work home and
        // release it, rather than running today's control plane against
        // yesterday's runtime.
        await this.releaseSession(project, record.sessionId, found.session, "superseded").catch(() => {});
      }
      if (!existing) await this.removeRecord(project);
    } else {
      await this.releaseStrays(project, "unrecorded");
    }
    const contexts = await this.ensureContexts(project);
    /** @type {Record<string, any>} */
    let agentbay;
    if (existing) {
      agentbay = { sessionId: existing.sessionId, session: existing.session, contexts, bridgeSecret: record.bridgeSecret,
        browserSessionSecret: record.browserSessionSecret ?? null, modelGateway: record.modelGateway ?? null, reattached: true };
    } else {
      this.manager.noteStartStage(project, "sync");
      await this.pushProject(project, contexts);
      const created = await this.client.createSession({
        imageId: this.config.agentbayImageId,
        labels: this.labels(project),
        contextSync: this.contextSyncFor(project, contexts),
        policyId: this.config.agentbayPolicyId || undefined,
        lifecycle: { idleMinutes: this.config.agentbayIdleReleaseMinutes, maxRuntimeMinutes: this.config.agentbayMaxRuntimeMinutes },
      });
      const bridgeSecret = randomBytes(32).toString("base64url");
      await this.writeRecord(project, {
        sessionId: created.sessionId, release, imageId: this.config.agentbayImageId, bridgeSecret,
        contexts, createdAt: new Date().toISOString(),
      });
      agentbay = { sessionId: created.sessionId, session: created.session, contexts, bridgeSecret, browserSessionSecret: null, modelGateway: null, reattached: false };
    }
    return {
      sandboxMode: "agentbay",
      networkMode: "agentbay",
      containerName: agentbay.sessionId,
      runtimeUrl: `http://${RUNTIME_AUTHORITY}`,
      socketPath: this.tunnelSocketPath(project),
      proxyWorkspaceDir: SESSION_PATHS.workspace,
      dshHomeDir: SESSION_PATHS.dshHome,
      capsuleMethodCount: capsuleMethodsMounted,
      capsuleMethodsRuntimeDir: SESSION_PATHS.capsuleMethods,
      pluginConfig,
      gateways: publicRuntimeGatewayUrls(this.config),
      agentbay,
    };
  }

  /**
   * The kernel's bootstrap files, rendered by the same function the Docker
   * provider uses and written into the session through its file API — into a
   * root-only incoming directory the launcher installs them from with the
   * owners and modes the kernel needs.
   */
  async bootstrap(project, plan, { budgetScope = null } = {}) {
    const ab = plan.agentbay;
    /** @type {Map<string, string>} */
    const files = new Map();
    const collect = async (_root, file, content) => { files.set(path.basename(file), String(content)); };
    // A kernel that outlived its control plane holds the model-gateway token
    // it booted with, and nothing says it reads the credentials file again:
    // the same token is rendered (same id, time and scope) so registering it
    // here makes the kernel's own copy valid again.
    const kept = ab.reattached && ab.modelGateway?.jti ? ab.modelGateway : null;
    const sync = await syncRuntimeDshProfile(this.config, project, plan, {
      writeFile: collect,
      hostHome: false,
      budgetScope: kept ? kept.budgetScope ?? null : budgetScope,
      ...(kept ? { jti: kept.jti, modelGatewayIssuedAt: kept.iat } : {}),
      browserSessionSecret: ab.browserSessionSecret ?? undefined,
      workloadTokenTtlSeconds: Number(this.config.agentbayWorkloadTokenTtlSeconds) || 900,
    });
    const payload = sync.payload ?? null;
    const modelGateway = payload ? {
      jti: payload.jti, iat: payload.iat,
      budgetScope: payload.runId ? { runId: payload.runId, dailyLimit: payload.dailyLimit, weeklyLimit: payload.weeklyLimit, runLimit: payload.runLimit } : null,
    } : null;
    if (!ab.browserSessionSecret || JSON.stringify(ab.modelGateway) !== JSON.stringify(modelGateway)) {
      ab.browserSessionSecret = sync.browserSessionSecret;
      ab.modelGateway = modelGateway;
      const record = await this.readRecord(project);
      if (record) await this.writeRecord(project, { ...record, browserSessionSecret: sync.browserSessionSecret, modelGateway });
    }
    files.set("bridge.secret", `${ab.bridgeSecret}\n`);
    files.set("kernel.env", renderKernelEnvironment(this.kernelEnvironment(project, plan)));
    const methods = await this.capsuleMethodsBundle(project);
    if (methods) files.set("capsule-methods.json", methods);
    await this.command(ab.session, `mkdir -p ${SESSION_PATHS.incoming} && chmod 0700 ${SESSION_PATHS.incoming}`);
    for (const [name, content] of files) {
      await this.writeSessionFile(ab.session, `${SESSION_PATHS.incoming}/${name}`, content);
    }
    const workloadToken = files.get("evimed-workload.token")?.trim() || null;
    // Installed by the launcher at start: accepted from then on.
    ab.installedWorkloadToken = workloadToken;
    return {
      ...sync,
      workloadTokenRefreshMs: sync.workloadTokenFile ? (Number(this.config.agentbayWorkloadTokenRefreshSeconds) || 300) * 1000 : null,
      installedWorkloadToken: workloadToken,
    };
  }

  /** The environment the kernel runs with: the same map the Docker launch
   *  passes as `--env`, pointed at this session's paths and public gateways. */
  kernelEnvironment(project, plan) {
    const config = this.config;
    const gateways = plan.gateways;
    return {
      OPEN_SCIENCE_RUNTIME_AUTHORITY: RUNTIME_AUTHORITY,
      ...runtimeEnvironment({
        presetSkillsDir: "/opt/evimed/socket/presets/evimed-universal/skills",
        capabilitiesDir: "/opt/evimed/capabilities",
        answerPersonaDir: "/opt/evimed/skills/evimed/open-domain-answer",
        capabilitySkillsDir: "/opt/evimed/capability-skills",
        capsuleMethodsDir: plan.capsuleMethodCount ? SESSION_PATHS.capsuleMethods : "",
        capsuleGatewayUrl: gateways.capsule,
        revisionGatewayUrl: gateways.revision,
        publicSourceGatewayUrl: gateways.publicSource,
        webSearchGatewayUrl: gateways.webSearch,
        pluginConfig: plan.pluginConfig,
        modelGatewayTokenFile: `${SESSION_PATHS.dshHome}/model-gateway.token`,
        workloadTokenFile: `${SESSION_PATHS.dshHome}/evimed-workload.token`,
        bundleVersion: String(config.socketBundleVersion ?? ""),
        compaction: compactionRuntimeEnv(runtimeCompactionSettings(config)),
        flags: {
          hosted: Boolean(config.production),
          askUser: Boolean(config.runtimeAskUserEnabled),
          review: Boolean(config.runtimeReviewEnabled),
          capsule: Boolean(gateways.capsule),
          operator: Array.isArray(config.operatorUsers) && config.operatorUsers.includes(String(project.userId ?? "")),
          requiredEnforcement: /** @type {'full'|'partial'} */ (config.agentbaySandboxEnforcement),
        },
        limits: {
          deliveryAttemptLimit: config.deliveryAttemptLimit,
          maxChildrenTotal: config.maxChildrenTotal,
          maxConcurrentChildren: config.maxConcurrentChildren,
          maxSteps: config.runMaxSteps,
          maxTokens: config.runMaxTokens,
          evidenceStaleMinutes: config.evidenceStaleMinutes,
          screeningBatchSize: config.screeningBatchSize,
        },
      }),
    };
  }

  /** The project's materialized capsule methods as one text bundle the
   *  launcher unpacks into its root-owned, read-only directory. */
  async capsuleMethodsBundle(project) {
    const root = capsuleMethodsHostDir(project);
    /** @type {Record<string, string>} */
    const files = {};
    async function walk(dir, rel) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile()) files[childRel] = await fs.readFile(path.join(dir, entry.name), "utf8");
      }
    }
    await walk(root, "");
    return Object.keys(files).length ? JSON.stringify({ files }) : null;
  }

  /**
   * Starts the kernel, unless a session that was reattached still has one,
   * and opens the link tunnel the manager's calls go through.
   */
  async launch(project, plan) {
    const ab = plan.agentbay;
    const key = this.manager.key(project);
    const links = await this.sessionLinks(ab.session);
    const tunnel = createLinkTunnel({
      socketPath: plan.socketPath,
      secret: ab.bridgeSecret,
      mode: /** @type {'header'|'path'} */ (this.config.agentbayBridgeSecretMode),
      links,
    });
    await tunnel.listen();
    let report = null;
    try {
      const alive = ab.reattached ? await tunnel.probe() : { ok: false, upstream: false };
      if (ab.reattached && alive.ok && alive.upstream) {
        // The kernel outlived the control plane: only the files it re-reads
        // per request (the credentials and tokens) are renewed.
        await this.command(ab.session, `${SESSION_PATHS.launcher} install`);
      } else {
        const started = await this.command(ab.session, `${SESSION_PATHS.launcher} start`, {
          OPEN_SCIENCE_RUNTIME_PORT: String(SESSION_KERNEL_PORT),
          OPEN_SCIENCE_SESSION_BRIDGE_PORT: String(this.config.agentbayBridgePort),
          EVIMED_REQUIRED_ENFORCEMENT: String(this.config.agentbaySandboxEnforcement),
          EVIMED_GATEWAY_HOST: this.gatewayOrigin()?.hostname ?? "",
          EVIMED_FIREWALL_REQUIRED: this.config.agentbayFirewallRequired === false ? "0" : "1",
        });
        report = launcherReport(started.stdout);
        if (!report?.ok) {
          const code = typeof report?.code === "string" ? report.code : "agentbay_session_start_failed";
          const said = [
            report?.kernelRelease ? `kernel ${report.kernelRelease}` : "",
            report?.landlock ? `Landlock ${report.landlock} (ABI ${report.landlockAbi})` : "",
            typeof report?.detail === "string" ? report.detail : "",
            !report ? started.stderr.slice(-400) : "",
          ].filter(Boolean).join("; ");
          throw new HttpError(503, code, `The AgentBay session cannot serve this runtime: ${code}${said ? ` — ${said}` : ""}.`);
        }
      }
    } catch (error) {
      await tunnel.close().catch(() => {});
      throw error;
    }
    const child = new AgentBaySessionProcess({
      provider: this, project, sessionId: ab.sessionId, session: ab.session, tunnel,
      heartbeatMs: this.config.agentbayHeartbeatMs, report,
    });
    const live = {
      sessionId: ab.sessionId, session: ab.session, tunnel, child, plan,
      seen: new Map(), mirroring: null, mirrorTimer: null,
      installedWorkloadToken: ab.installedWorkloadToken ?? null, previousWorkloadToken: null, pendingWorkloadToken: null,
    };
    this.live.set(key, live);
    if (!ab.reattached) {
      // What the session downloaded is what was just pushed: the baseline the
      // mirror carries changes against.
      const listed = await this.sessionManifest(ab.session, SESSION_PATHS.workspace, READ_ONLY_VIEWS).catch(() => null);
      if (listed) live.seen = baselineFrom(listed);
    }
    const interval = Number(this.config.agentbaySyncIntervalMs);
    if (Number.isFinite(interval) && interval > 0) {
      live.mirrorTimer = setInterval(() => void this.mirror(project).catch(() => {}), interval);
      live.mirrorTimer.unref?.();
    }
    return child;
  }

  async sessionManifest(session, root, exclude = []) {
    const listed = await this.command(session, [SESSION_PATHS.launcher, "manifest", root, ...exclude].join(" "));
    if (!listed.ok) throw new HttpError(502, "agentbay_manifest_failed", "The session did not list its files.");
    return parseSessionManifest(listed.stdout);
  }

  /**
   * Session → host for the workspace: what changed since the last look. One
   * at a time per project; a second request joins the one running.
   * @param {Record<string, any>} project
   */
  mirror(project) {
    const live = this.live.get(this.manager.key(project));
    if (!live) return Promise.resolve(null);
    live.mirroring ??= mirrorSession({
      listSession: () => this.sessionManifest(live.session, SESSION_PATHS.workspace, READ_ONLY_VIEWS),
      readSession: async (rel) => {
        const result = await this.client.guard("session file read", () => live.session.fileSystem.readFile(`${SESSION_PATHS.workspace}/${rel}`, { format: "bytes" }));
        if (!result?.success) throw new HttpError(502, "agentbay_file_read_failed", "A session file could not be read.");
        return Buffer.from(result.content ?? []);
      },
      hostRoot: project.workspaceDir,
      seen: live.seen,
      maxFileBytes: Number(this.config.agentbaySyncMaxFileBytes) || 256 * 1024 * 1024,
    }).finally(() => { live.mirroring = null; });
    return live.mirroring;
  }

  /** Before the delivery gate reads the run's files: one bounded mirror. A
   *  mirror that does not finish leaves the gate the host copy as it is. */
  async beforeDelivery(project) {
    if (!this.live.has(this.manager.key(project))) return;
    let timer;
    await Promise.race([
      this.mirror(project).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(resolve, DELIVERY_MIRROR_DEADLINE_MS); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }

  /**
   * A control-plane write the running kernel must see — the run's context and
   * brief files, the resident capsule profile — written into the session too.
   * The host copy is written first by the caller and stays the record.
   * @param {Record<string, any>} project @param {string} relative @param {string} content
   */
  async mirrorWrite(project, relative, content) {
    const live = this.live.get(this.manager.key(project));
    if (!live) return;
    const target = `${SESSION_PATHS.workspace}/${relative}`;
    await this.command(live.session, `mkdir -p '${path.posix.dirname(target).replace(/'/g, "'\\''")}'`);
    await this.writeSessionFile(live.session, target, content);
  }

  /**
   * The workspace and the kernel's own state brought home in full, the
   * release-time pass (plan §3.1 #4). Returns, per uploading view, what the
   * session held at this pass — which is what its release uploads.
   * @returns {Promise<Record<string, Map<string, string>>>}
   */
  async syncBack(project, live) {
    await this.mirror(project);
    /** @type {Record<string, Map<string, string>>} */
    const held = { workspace: live.seen };
    for (const kind of ["sessions", "storages"]) {
      const view = this.views(project)[kind];
      const seen = new Map();
      await mirrorSession({
        listSession: () => this.sessionManifest(live.session, view.mount),
        readSession: async (rel) => {
          const result = await this.client.guard("session file read", () => live.session.fileSystem.readFile(`${view.mount}/${rel}`, { format: "bytes" }));
          if (!result?.success) throw new HttpError(502, "agentbay_file_read_failed", "A session file could not be read.");
          return Buffer.from(result.content ?? []);
        },
        hostRoot: view.host,
        seen,
        maxFileBytes: Number(this.config.agentbaySyncMaxFileBytes) || 256 * 1024 * 1024,
      });
      held[kind] = seen;
    }
    return held;
  }

  /**
   * After a full pull, each uploading Context is recorded as holding what the
   * session held — its release upload — and the sync as clean. Not the host
   * tree: a file that only the host has (an upload made while the run worked)
   * is not in the Context, and recording it there would keep the next push
   * from carrying it. What the push had put there and the session deleted
   * stays recorded too: whether a release upload deletes it from the Context
   * is AgentBay's policy, and the next push deleting it is ours.
   * @param {Record<string, any>} project @param {Record<string, Map<string, string>>} held
   */
  async markClean(project, held) {
    for (const [kind, view] of Object.entries(this.views(project))) {
      if (!view.upload || !held[kind]) continue;
      const file = this.manifestFile(project, kind);
      const manifest = await loadSyncManifest(project.rootDir, file);
      manifest.files = { ...manifest.files, ...manifestFromSignatures(held[kind]) };
      manifest.clean = true;
      await saveSyncManifest(project.rootDir, file, manifest);
    }
  }

  /** Releases a session: its work home first, then the session, with the
   *  Context upload as the net under a pull that did not finish. */
  async releaseSession(project, sessionId, session, reason) {
    const key = this.manager.key(project);
    const live = this.live.get(key);
    /** @type {Record<string, Map<string, string>> | null} */
    let pulled = null;
    if (live) {
      clearInterval(live.mirrorTimer);
      try {
        pulled = await this.syncBack(project, live);
      } catch (error) {
        await appendRuntimeEventForProvider(project, "agentbay_sync_back_failed", {
          reason, error: typeof error?.code === "string" ? error.code : "agentbay_sync_back_failed",
        }, this.config);
      }
    }
    await this.client.deleteSession(sessionId, { syncContext: true }).catch(async (error) => {
      await appendRuntimeEventForProvider(project, "agentbay_release_failed", {
        reason, error: typeof error?.code === "string" ? error.code : "agentbay_release_failed",
      }, this.config);
    });
    if (live) {
      await live.tunnel.close().catch(() => {});
      this.live.delete(key);
    }
    if (pulled) await this.markClean(project, pulled).catch(() => {});
    await this.removeRecord(project);
    void session;
  }

  /** A launch that failed after the session was prepared: the session is let
   *  go (nothing ran in it, so nothing needs bringing home). */
  async abandon(project, plan) {
    const key = this.manager.key(project);
    const live = this.live.get(key);
    if (live) {
      clearInterval(live.mirrorTimer);
      await live.tunnel.close().catch(() => {});
      this.live.delete(key);
    }
    // A fresh session holds only what was just pushed; one that was taken
    // back may hold a run's work, which its release uploads for the next
    // start to bring home.
    await this.client.deleteSession(plan.agentbay.sessionId, { syncContext: Boolean(plan.agentbay.reattached) }).catch(() => {});
    await this.removeRecord(project);
  }

  /**
   * Sessions labelled as this project's that no record names — a record lost
   * with a host restore, a create whose answer never arrived. None can be
   * taken back (their secrets were in the record), so each is released with
   * its Context upload, which the next push brings home first.
   */
  async releaseStrays(project, reason) {
    const labels = this.labels(project);
    const strays = await this.client.listSessions({ labels: { evimed: labels.evimed, user: labels.user, project: labels.project } }).catch(() => []);
    for (const stray of strays) {
      await this.client.deleteSession(stray.sessionId, { syncContext: true }).catch(() => {});
    }
    if (strays.length) {
      await appendRuntimeEventForProvider(project, "agentbay_strays_released", { reason, sessions: strays.length }, this.config);
    }
    return strays.length;
  }

  async close(project, plan, child) {
    await child?.stop?.();
    await this.releaseSession(project, plan.agentbay.sessionId, plan.agentbay.session, "stopped");
  }

  /** A session or kernel that ended on its own: its tunnel closed, the session
   *  released if it is still there, and the Context's copy brought home. */
  afterExit(project, plan) {
    const key = this.manager.key(project);
    const live = this.live.get(key);
    const settling = (async () => {
      if (live) {
        clearInterval(live.mirrorTimer);
        await live.tunnel.close().catch(() => {});
        this.live.delete(key);
      }
      await this.client.deleteSession(plan.agentbay.sessionId, { syncContext: true }).catch(() => {});
      await this.recoverProject(project).catch(() => {});
      await this.removeRecord(project);
    })().catch(() => {}).finally(() => {
      if (this.exiting.get(key) === settling) this.exiting.delete(key);
    });
    this.exiting.set(key, settling);
  }

  /** Context → host for every uploading view, for a session this control
   *  plane could not bring home itself. */
  async recoverProject(project) {
    const contexts = await this.ensureContexts(project);
    const maxFileBytes = Number(this.config.agentbaySyncMaxFileBytes) || 256 * 1024 * 1024;
    for (const [kind, view] of Object.entries(this.views(project))) {
      if (!view.upload) continue;
      const file = this.manifestFile(project, kind);
      const manifest = await loadSyncManifest(project.rootDir, file);
      await recoverTree({ client: this.client, contextId: contexts[kind].id, hostRoot: view.host, exclude: view.exclude, manifest, maxFileBytes });
      manifest.clean = true;
      await saveSyncManifest(project.rootDir, file, manifest);
    }
  }

  /** What a remote session's metrics say about memory, on the quota monitor's
   *  cycle; a session with no readable metrics is simply not sampled. */
  async sampleResources(project, runtime) {
    const live = this.live.get(this.manager.key(project));
    if (!live?.session?.getMetrics) return;
    const metrics = await this.client.guard("session metrics", () => live.session.getMetrics()).catch(() => null);
    const data = metrics?.data ?? null;
    const used = Number(data?.memUsed ?? data?.memoryUsed ?? data?.mem_used ?? NaN);
    const total = Number(data?.memTotal ?? data?.memoryTotal ?? data?.mem_total ?? NaN);
    if (!Number.isFinite(used)) return;
    runtime.peakMemoryBytes = Math.max(Number(runtime.peakMemoryBytes ?? 0), used);
    if (Number.isFinite(total) && total > 0 && !runtime.memoryPressureReported && used * 5 >= total * 4) {
      runtime.memoryPressureReported = true;
      await appendRuntimeEventForProvider(project, "memory_pressure", {
        kind: runtime.kind, containerName: runtime.containerName, memoryBytes: used, memoryLimitBytes: total,
      }, this.config);
    }
  }

  /**
   * At control-plane startup: a session that outlived the control plane is
   * taken back rather than removed (plan §3.1 #7), so a run in it keeps going.
   * One that is gone is brought home from its Context.
   */
  async cleanupOrphan(project, state) {
    const record = await this.readRecord(project);
    if (record) {
      const found = await this.client.getSession(record.sessionId).catch(() => null);
      if (found) {
        try {
          await this.manager.start(project);
          return { cleaned: false, missing: false, reattached: true };
        } catch (error) {
          return { cleaned: false, missing: false, failed: true, reason: "reattach_failed", error: typeof error?.code === "string" ? error.code : "reattach_failed" };
        }
      }
    }
    const released = record ? 0 : await this.releaseStrays(project, "orphaned");
    await this.recoverProject(project).catch(() => {});
    await this.removeRecord(project);
    void state;
    return released
      ? { cleaned: true, missing: false, failed: false, reason: "session_released_by_label" }
      : { cleaned: false, missing: true, failed: false, reason: "session_released" };
  }

  /**
   * The workload token of a remote runtime (plan §3.1 #4): 900 s of validity,
   * renewed every 300 s through the file API. The token being installed is
   * accepted from the moment it is written, and the one it replaces until it
   * expires, so a request in flight across a renewal is never refused.
   */
  async writeWorkloadToken(project, runtime) {
    const live = this.live.get(this.manager.key(project));
    if (!live) throw new HttpError(409, "runtime_not_running", "The session is not attached.");
    const token = issueEviMedWorkloadToken({
      secret: this.config.evimedWorkloadSigningSecret,
      userId: String(project.userId),
      projectId: String(project.id),
      ttlSeconds: Number(this.config.agentbayWorkloadTokenTtlSeconds) || 900,
    });
    live.pendingWorkloadToken = token;
    try {
      await this.writeSessionFile(live.session, `${SESSION_PATHS.incoming}/evimed-workload.token`, `${token}\n`);
      const installed = await this.command(live.session, `${SESSION_PATHS.launcher} install`);
      if (!installed.ok) throw new HttpError(502, "agentbay_install_failed", "The session did not install the renewed token.");
      live.previousWorkloadToken = live.installedWorkloadToken;
      live.installedWorkloadToken = token;
    } finally {
      live.pendingWorkloadToken = null;
    }
    runtime.workloadTokenInstalledAt = Date.now();
    return token;
  }

  /** The tokens a remote runtime may present right now. */
  acceptedWorkloadTokens(project) {
    const live = this.live.get(this.manager.key(project));
    if (!live) return [];
    return [live.installedWorkloadToken, live.pendingWorkloadToken, live.previousWorkloadToken].filter(Boolean);
  }

  /**
   * Whether a failed renewal can wait for the next one: yes while the
   * installed token outlives that next attempt, which the 900/300 timing
   * gives two chances to.
   */
  tolerateTokenRefreshFailure(runtime) {
    const refreshMs = (Number(this.config.agentbayWorkloadTokenRefreshSeconds) || 300) * 1000;
    const ttlMs = (Number(this.config.agentbayWorkloadTokenTtlSeconds) || 900) * 1000;
    const installedAt = Number(runtime.workloadTokenInstalledAt ?? 0);
    return installedAt > 0 && Date.now() + refreshMs < installedAt + ttlMs;
  }

  /** Records the session's own facts on the runtime record the manager keeps. */
  describe(child) {
    const report = child?.report ?? null;
    return report ? {
      kernelRelease: report.kernelRelease ?? null,
      landlockAbi: Number.isSafeInteger(report.landlockAbi) ? report.landlockAbi : null,
      landlock: report.landlock ?? null,
      firewall: report.firewall ?? null,
    } : null;
  }
}
