/** Disposable local native UI fixture. Never use this launcher in production. */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWebApiApp } from "../../../apps/server/src/server.mjs";
import { browserSessionCookie, generateBrowserSessionSecret } from "../../../apps/server/src/dshBrowserAuth.mjs";
import { renderCredentialsFile } from "../../../apps/server/src/dshProfilePatch.mjs";
import { requestRuntime } from "../../../apps/server/src/runtimeManager.mjs";
import { migrateProfileSeed } from "../../../deploy/runtime-dsh/profile-seed.mjs";

if (process.env.EVIMED_LOCAL_NATIVE_ACCEPTANCE !== "1") throw new Error("Explicit local acceptance opt-in is required.");
const shellOrigin = process.env.EVIMED_ACCEPTANCE_SHELL_ORIGIN;
const uiOrigin = process.env.EVIMED_ACCEPTANCE_UI_ORIGIN;
if (![shellOrigin, uiOrigin].every(value => /^http:\/\/127\.0\.0\.1:\d+$/.test(value ?? ""))) throw new Error("Only local loopback acceptance origins are allowed.");
const dataDir = "/acceptance/state";
mkdirSync(dataDir, { recursive: true });
const app = createWebApiApp({ production: false, dataDir, port: 8787, host: "0.0.0.0", devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true,
  runtimeUiPort: 8443, publicUrl: shellOrigin, runtimeUiPublicOrigin: uiOrigin, staticDir: "/repo/apps/web/dist",
  modelGatewaySigningSecret: randomBytes(32).toString("base64url"), deepseekProviderEnabled: false, llmRoutingEnabled: false,
  runtimeProxyConnectTimeoutMs: 180000, runtimeProxyRequestTimeoutMs: 180000 });
let nextPort = 46000;
const starting = new Map();
const processes = new Set();
let modelCalls = 0;
// Deterministic provider fixture: tests native turn transport/adoption, never model quality.
const provider = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
  let bytes = "";
  req.on("data", chunk => { bytes += chunk; if (bytes.length > 2000000) req.destroy(); });
  req.on("end", () => {
    modelCalls++;
    writeFileSync("/acceptance/model-calls.json", JSON.stringify({ count: modelCalls, provider: "deterministic-local-fixture", paidCalls: 0 }));
    const request = JSON.parse(bytes);
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const common = { id: "acceptance-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deepseek-v4-flash" };
      for (const choice of [{ delta: { role: "assistant", content: "ACK: native acceptance turn recorded." }, finish_reason: null }, { delta: {}, finish_reason: "stop" }]) {
        res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "acceptance-completion", object: "chat.completion", model: "deepseek-v4-flash", choices: [{ index: 0, message: { role: "assistant", content: "ACK: native acceptance turn recorded." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
});
await new Promise(resolve => provider.listen(45990, "127.0.0.1", () => resolve(undefined)));

app.runtimeManager.start = async project => {
  const key = app.runtimeManager.key(project);
  if (app.runtimeManager.runtimes.has(key)) return app.runtimeManager.runtimes.get(key);
  if (starting.has(key)) return starting.get(key);
  const work = (async () => {
    const port = ++nextPort;
    const runtimeHome = path.join(project.runtimeDir, "native-acceptance-home");
    mkdirSync(runtimeHome, { recursive: true });
    migrateProfileSeed("/opt/evimed/seed", runtimeHome, "evimed-runtime");
    const secret = generateBrowserSessionSecret();
    writeFileSync(path.join(runtimeHome, ".credentials.yaml"), renderCredentialsFile({ token: "local-acceptance-reference", browserSessionSecret: secret }), { mode: 0o600 });
    writeFileSync(path.join(runtimeHome, "evimed-workload.token"), "local-acceptance-reference", { mode: 0o600 });
    const patch = [
      { id: "session-persistence-jsonl", config: { root: path.join(runtimeHome, "sessions") } },
      { id: "session-query-sqlite", config: { path: ":memory:" } },
      { id: "evimed-seam-probe", config: { requiredEnforcement: "partial", dshVersion: "0.1.2-rc.1" } },
      { id: "agent-presets", config: { roots: [{ path: "/opt/evimed/socket-source/presets", trust: "system" }], default: "evimed-universal" } },
      { id: "llm-deepseek", config: { baseURL: "http://127.0.0.1:45990/v1", apiKeyEnv: "EVIMED_WORKLOAD_TOKEN", thinking: "disabled", models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } },
      { id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
      { id: "approval", config: { policy: "never" } },
      { id: "permission", config: { presets: { "evimed-hosted": { sandbox: "workspace-write", approval: "never" } }, defaultPreset: "evimed-hosted" } },
    ];
    const patchFile = path.join(runtimeHome, "acceptance.patch.json");
    writeFileSync(patchFile, JSON.stringify(patch));
    const child = spawn("/app/harness/node_modules/.bin/dsh", ["--profile", "evimed-runtime", "--patch", patchFile, "--no-open", "--port", String(port)], {
      cwd: project.workspaceDir, env: { ...process.env, DSH_HOME: runtimeHome, DSH_TELEMETRY_DISABLED: "1", NARB_DISABLE_NATIVE_CACHE: "1", DSH_PERMISSION_MODE: "workspace-write",
        EVIMED_PRESET_SKILLS_DIR: "/opt/evimed/skills", EVIMED_CAPABILITIES_DIR: "/opt/evimed/capabilities", EVIMED_CAPABILITY_SKILLS_DIR: "/opt/evimed/capability-skills",
        // Deliberately empty here, and only here. `runtimeManager` materializes the active capsules' work-style methods into
        // the project's runtime root and mounts that directory read-only; this fixture launches the kernel itself, with no
        // product database behind it and therefore no capsule to mount. Empty is the plugin's documented "no capsule" value.
        EVIMED_CAPSULE_METHODS_DIR: "", EVIMED_CAPSULE_GATEWAY_URL: "", EVIMED_WORKLOAD_TOKEN_FILE: path.join(runtimeHome, "evimed-workload.token"), EVIMED_BUNDLE_VERSION: "0.1.0",
        EVIMED_ASK_USER: "0", EVIMED_CAPSULE_ACTIVE: "0", EVIMED_REVIEW_ENABLED: "0", EVIMED_MAX_STEPS: "3", EVIMED_MAX_TOKENS: "10000" }, stdio: ["ignore", "pipe", "pipe"] });
    processes.add(child);
    const log = `/acceptance/kernel-${project.id}.log`;
    const record = chunk => appendFileSync(log, chunk.toString().replaceAll(secret, "[redacted]").replace(/https?:\/\/[^\s]+/g, "[runtime-url]"), { mode: 0o600 });
    child.stdout.on("data", record); child.stderr.on("data", record);
    const runtime = { kind: "dsh", url: `http://127.0.0.1:${port}`, cookie: browserSessionCookie({ secret, authority: `127.0.0.1:${port}` }),
      workspaceDir: project.workspaceDir, proxyWorkspaceDir: project.workspaceDir, startedAt: new Date().toISOString(), child, project,
      sandboxMode: "acceptance-container", close: async () => { child.kill("SIGTERM"); processes.delete(child); } };
    const deadline = Date.now() + 180000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await requestRuntime(runtime, "/api/session/list", { method: "POST", headers: { cookie: runtime.cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "acceptance-start", method: "session/list", payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(3000) });
        ready = response.status === 200; await response.body?.cancel(); if (ready) break;
      } catch { /* The native host has not finished composing yet. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) { child.kill("SIGTERM"); throw new Error(`Native acceptance runtime did not start for ${project.id}; inspect its redacted log.`); }
    app.runtimeManager.runtimes.set(key, runtime);
    app.runtimeManager.onRuntimeStart(project, runtime);
    return runtime;
  })();
  starting.set(key, work);
  try { return await work; } finally { starting.delete(key); }
};
await app.listen(8787, "0.0.0.0");
writeFileSync("/acceptance/server-ready.json", JSON.stringify({ shellOrigin, uiOrigin, kernel: "0.1.2-rc.1", provider: "deterministic-local-fixture" }));
console.log("Native acceptance control plane is ready.");
const stop = async () => { for (const child of processes) child.kill("SIGTERM"); await app.close(); provider.close(); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
