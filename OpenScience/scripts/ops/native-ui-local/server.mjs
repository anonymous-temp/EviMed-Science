/** Disposable local native UI fixture. Never use this launcher in production. */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWebApiApp } from "../../../apps/server/src/server.mjs";
import { browserSessionCookie, generateBrowserSessionSecret } from "../../../apps/server/src/dshBrowserAuth.mjs";
import { renderCredentialsFile } from "../../../apps/server/src/dshProfilePatch.mjs";
import { DshMux } from "../../../apps/server/src/dshMux.mjs";
import { fixtureConfig, childEnvironment } from "./config.mjs";
import { migrateProfileSeed } from "../../../deploy/runtime-dsh/profile-seed.mjs";

const config = fixtureConfig();
const { shellOrigin, uiOrigin } = config;
const dataDir = path.join(config.root, "state");
const shellPort = Number(new URL(shellOrigin).port);
const uiPort = Number(new URL(uiOrigin).port);
mkdirSync(dataDir, { recursive: true });
const app = createWebApiApp({ production: false, dataDir, port: shellPort, host: "127.0.0.1", devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true,
  runtimeUiPort: uiPort, runtimeUiFrameOff: config.themeOff ? "theme" : "", publicUrl: shellOrigin, runtimeUiPublicOrigin: uiOrigin, staticDir: path.join(config.repo, "apps/web/dist"),
  modelGatewaySigningSecret: randomBytes(32).toString("base64url"), deepseekProviderEnabled: false, llmRoutingEnabled: false,
  runtimeProxyConnectTimeoutMs: 180000, runtimeProxyRequestTimeoutMs: 180000 });
let nextPort = 46000;
const starting = new Map();
const processes = new Set();
async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { processes.delete(child); return; }
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
    child.once("close", () => { clearTimeout(timer); resolve(undefined); });
    child.kill("SIGTERM");
  });
  processes.delete(child);
}
let modelCalls = 0;
writeFileSync(path.join(config.root, "model-calls.json"), JSON.stringify({ count: 0, provider: "deterministic-local-fixture", paidCalls: 0 }));
// Deterministic provider fixture: tests native turn transport/adoption, never model quality.
const provider = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/messages")) { res.writeHead(404); res.end(); return; }
  let bytes = "";
  req.on("data", chunk => { bytes += chunk; if (bytes.length > 2000000) req.destroy(); });
  req.on("end", async () => {
    modelCalls++;
    writeFileSync(path.join(config.root, "model-calls.json"), JSON.stringify({ count: modelCalls, provider: "deterministic-local-fixture", paidCalls: 0 }));
    let request;
    try { request = JSON.parse(bytes); } catch { res.writeHead(400); res.end(); return; }
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "message_start", message: { id: "acceptance-completion", type: "message", role: "assistant", model: "deepseek-v4-flash", content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ACK: native acceptance turn recorded." } });
      for (let line = 1; line <= config.streamLines && !res.destroyed; line++) {
        await new Promise(resolve => setTimeout(resolve, 60));
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `\n\nSynthetic stream paragraph ${line}. This is bounded local acceptance data.` } });
      }
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send({ type: "message_stop" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "acceptance-completion", type: "message", role: "assistant", model: "deepseek-v4-flash", content: [{ type: "text", text: "ACK: native acceptance turn recorded." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    }
  });
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", () => resolve(undefined)));

app.runtimeManager.start = async project => {
  const key = app.runtimeManager.key(project);
  if (app.runtimeManager.runtimes.has(key)) return app.runtimeManager.runtimes.get(key);
  if (starting.has(key)) return starting.get(key);
  const work = (async () => {
    const port = ++nextPort;
    const runtimeHome = path.join(project.runtimeDir, "native-acceptance-home");
    mkdirSync(runtimeHome, { recursive: true });
    migrateProfileSeed(config.seed, runtimeHome, "evimed-runtime");
    const secret = generateBrowserSessionSecret();
    writeFileSync(path.join(runtimeHome, ".credentials.yaml"), renderCredentialsFile({ token: "local-acceptance-reference", browserSessionSecret: secret }), { mode: 0o600 });
    writeFileSync(path.join(runtimeHome, "evimed-workload.token"), "local-acceptance-reference", { mode: 0o600 });
    const patch = [
      { id: "session-persistence-jsonl", config: { root: path.join(runtimeHome, "sessions") } },
      { id: "session-query-sqlite", config: { path: ":memory:" } },
      { id: "evimed-seam-probe", config: { requiredEnforcement: "partial", dshVersion: config.pins.version } },
      { id: "agent-presets", config: { roots: [{ path: path.join(config.socket, "presets"), trust: "system" }], default: "evimed-universal" } },
      { id: "llm-deepseek", config: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKeyEnv: "EVIMED_WORKLOAD_TOKEN", thinking: "disabled", models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } },
      { id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
      { id: "approval", config: { policy: "never" } },
      { id: "permission", config: { presets: { "evimed-hosted": { sandbox: "workspace-write", approval: "never" } }, defaultPreset: "evimed-hosted" } },
    ];
    const patchFile = path.join(runtimeHome, "acceptance.patch.json");
    writeFileSync(patchFile, JSON.stringify(patch));
    const child = spawn(path.join(config.kernelModules, ".bin/dsh"), ["--profile", "evimed-runtime", "--patch", patchFile, "--no-open", "--port", String(port)], {
      cwd: project.workspaceDir, env: childEnvironment({ DSH_HOME: runtimeHome, DSH_TELEMETRY_DISABLED: "1", NARB_DISABLE_NATIVE_CACHE: "1", DSH_PERMISSION_MODE: "workspace-write",
        EVIMED_PRESET_SKILLS_DIR: path.join(config.repo, "runtime/skills"), EVIMED_CAPABILITIES_DIR: path.join(config.repo, "deploy/runtime-dsh/capabilities"), EVIMED_CAPABILITY_SKILLS_DIR: path.join(config.repo, "capability-skills"),
        // Deliberately empty here, and only here. `runtimeManager` materializes the active capsules' work-style methods into
        // the project's runtime root and mounts that directory read-only; this fixture launches the kernel itself, with no
        // product database behind it and therefore no capsule to mount. Empty is the plugin's documented "no capsule" value.
        EVIMED_CAPSULE_METHODS_DIR: "", EVIMED_CAPSULE_GATEWAY_URL: "", EVIMED_WORKLOAD_TOKEN_FILE: path.join(runtimeHome, "evimed-workload.token"), EVIMED_BUNDLE_VERSION: "0.1.0",
        EVIMED_ASK_USER: "0", EVIMED_CAPSULE_ACTIVE: "0", EVIMED_REVIEW_ENABLED: "0", EVIMED_MAX_STEPS: "3", EVIMED_MAX_TOKENS: "10000" }), stdio: ["ignore", "pipe", "pipe"] });
    processes.add(child);
    const log = path.join(config.root, `kernel-${project.id}.log`);
    const record = chunk => appendFileSync(log, chunk.toString().replaceAll(secret, "[redacted]").replace(/https?:\/\/[^\s]+/g, "[runtime-url]"), { mode: 0o600 });
    child.stdout.on("data", record); child.stderr.on("data", record);
    child.on("error", error => record(`Kernel launch failed: ${error.code ?? "spawn_error"}\n`));
    const runtime = { kind: "dsh", url: `http://127.0.0.1:${port}`, cookie: browserSessionCookie({ secret, authority: `127.0.0.1:${port}` }),
      workspaceDir: project.workspaceDir, proxyWorkspaceDir: project.workspaceDir, startedAt: new Date().toISOString(), child, project,
      sandboxMode: "acceptance-container", close: async () => stopChild(child) };
    const deadline = Date.now() + 180000;
    let ready = false;
    while (Date.now() < deadline && child.pid && child.exitCode === null) {
      try {
        const mux = new DshMux(runtime);
        try {
          const signal = AbortSignal.timeout(3000);
          await mux.connect({ signal });
          // Authenticated mux handshake proves this runtime is serving its current wire.
          // session/list is unary in the pinned kernel and cannot use the stream carrier.
          ready = true;
        } finally { mux.close(); }
        if (ready) break;
      } catch { /* The native host has not finished composing yet. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) { await stopChild(child); throw new Error(`Native acceptance runtime did not start for ${project.id}; inspect its redacted log.`); }
    writeFileSync(path.join(config.root, `runtime-ready-${project.id}.json`), JSON.stringify({ kernel: config.pins.version, projectId: project.id, transport: "authenticated-remote-mux", ready: true, provider: "deterministic-local-fixture", paidCalls: 0 }));
    app.runtimeManager.runtimes.set(key, runtime);
    app.runtimeManager.onRuntimeStart(project, runtime);
    return runtime;
  })();
  starting.set(key, work);
  try { return await work; } finally { starting.delete(key); }
};
await app.listen(shellPort, "127.0.0.1");
writeFileSync(path.join(config.root, "server-ready.json"), JSON.stringify({ shellOrigin, uiOrigin, kernel: config.pins.version, provider: "deterministic-local-fixture" }));
console.log("Native acceptance control plane is ready.");
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await Promise.all([...processes].map(stopChild)); await app.close(); await new Promise(resolve => provider.close(resolve)); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
