#!/usr/bin/env node
/**
 * The AgentBay runtime's live bring-up (plan §3.1), one command per phase.
 *
 *   node scripts/ops/agentbay-bringup.mjs [--build-tag <tag> [--base <system image>]]
 *     [--image <imgc-…>] [--base-url https://<domain>] [--deep] [--keep]
 *
 * Stages, in order; each prints the facts it observed, and the first failure
 * stops the run with that stage's name:
 *
 *   build    (--build-tag) scripts/ops/agentbay-image-build.sh --activate: the
 *            image, and its id. Needs docker and the AgentBay CLI (logged in
 *            with the account's AccessKey).
 *   guest    a throwaway session on the image: `uname -r`, the Landlock ABI
 *            and the level DSH will run at, the runtime user, the installed
 *            kernel, whether the egress firewall can be applied; then the
 *            session bridge with a stand-in kernel behind it, probed through
 *            AgentBay's own links in both secret modes — header and path
 *            prefix — for HTTP and for a WebSocket upgrade. The answer is the
 *            value for OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE.
 *   connect  (--base-url) the deployment itself: readiness names the AgentBay
 *            provider and this image; a scratch project's runtime starts
 *            (through the stages the waiting shell shows), reports its guest
 *            kernel and Landlock level, and answers one conversation to a
 *            finished run.
 *   deep     (--deep) one capability run end to end — about forty minutes —
 *            with the runtime checked every minute and its deliverables read
 *            back through the control plane, which proves the sync.
 *
 * Environment. The key: OPEN_SCIENCE_AGENTBAY_API_KEY_FILE — read by the
 * AgentBay client only (apps/server/src/agentbay/client.mjs), never printed,
 * nor its path; every SDK error arrives already scrubbed of it and of link
 * tokens. Also OPEN_SCIENCE_AGENTBAY_REGION / _ENDPOINT / _IMAGE_ID (or
 * --image), and for `connect`: OPEN_SCIENCE_E2E_USERNAME and _PASSWORD (or
 * OPEN_SCIENCE_E2E_SESSION_COOKIE and _CSRF_TOKEN), the same account the
 * hosted E2E uses. `--deep-agent` (default clinical-evidence-synthesis) and
 * `--deep-brief` choose the deep run.
 *
 * Run it from a checkout with its dependencies installed (the AgentBay SDK is
 * a server dependency); the build stage also needs docker, so the build
 * machine is the natural place.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentBayClient, scrubAgentBayText } from "../../apps/server/src/agentbay/client.mjs";
import { createLinkTunnel } from "../../apps/server/src/agentbay/linkTunnel.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE_PORT = 30100;
const STAND_IN_PORT = 4096;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    if (["deep", "keep"].includes(name)) args[name] = true;
    else args[name] = String(argv[++index] ?? "");
  }
  return args;
}

/** One observed fact, one line. */
function fact(stage, label, value) {
  process.stdout.write(`[${stage}] ${label}: ${value}\n`);
}

class StageError extends Error {
  /** @param {string} stage @param {string} message */
  constructor(stage, message) {
    super(`${stage}: ${message}`);
    this.stage = stage;
  }
}

/** Runs the image build script and returns the image id it printed last. */
function buildStage(tag, base) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [path.join(repoRoot, "scripts/ops/agentbay-image-build.sh"), "--tag", tag, "--base", base, "--activate"], {
      cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"],
    });
    let tail = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => reject(new StageError("build", error.message)));
    child.once("exit", (code) => {
      const id = /OPEN_SCIENCE_AGENTBAY_IMAGE_ID=(imgc-[A-Za-z0-9]+)\s*$/.exec(tail)?.[1];
      if (code !== 0 || !id) reject(new StageError("build", `agentbay-image-build.sh exited ${code} without an image id`));
      else resolve(id);
    });
  });
}

/** The stand-in kernel the guest stage puts behind the real session bridge:
 *  it echoes the path and Host it received, and answers a WebSocket upgrade. */
const STAND_IN = `import http from "node:http";
import { createHash } from "node:crypto";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url, host: req.headers.host }));
});
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept
    + "\\r\\nX-Bringup-Path: " + encodeURIComponent(req.url) + "\\r\\nX-Bringup-Host: " + encodeURIComponent(String(req.headers.host)) + "\\r\\n\\r\\n");
  socket.on("data", (chunk) => socket.write(chunk));
});
server.listen(${STAND_IN_PORT}, "127.0.0.1");
`;

/** @param {string} socketPath @param {string} target */
function httpThroughTunnel(socketPath, target) {
  return new Promise((resolve) => {
    const request = http.request({ socketPath, path: target, headers: { host: "dsh.runtime" }, timeout: 20_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.once("timeout", () => request.destroy(new Error("timed out")));
    request.once("error", (error) => resolve({ status: 0, body: null, error: error.message }));
    request.end();
  });
}

/** @param {string} socketPath @param {string} target */
function upgradeThroughTunnel(socketPath, target) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const request = http.request({
      socketPath, path: target, timeout: 20_000,
      headers: { host: "dsh.runtime", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-version": "13" },
    });
    request.once("upgrade", (response, socket) => {
      const accepted = response.statusCode === 101 && response.headers["sec-websocket-accept"] === expected;
      const payload = Buffer.from("bringup");
      socket.once("data", (echo) => {
        socket.destroy();
        resolve({ status: response.statusCode, accepted, echoed: echo.includes(payload), path: decodeURIComponent(String(response.headers["x-bringup-path"] ?? "")), host: decodeURIComponent(String(response.headers["x-bringup-host"] ?? "")) });
      });
      socket.write(payload);
      setTimeout(() => { socket.destroy(); resolve({ status: response.statusCode, accepted, echoed: false }); }, 10_000).unref();
    });
    request.once("response", (response) => { response.resume(); resolve({ status: response.statusCode ?? 0, accepted: false, echoed: false }); });
    request.once("timeout", () => request.destroy(new Error("timed out")));
    request.once("error", (error) => resolve({ status: 0, accepted: false, echoed: false, error: error.message }));
    request.end();
  });
}

/**
 * @param {ReturnType<typeof createAgentBayClient>} client @param {string} imageId @param {string} marker
 * @returns {Promise<{ mode: 'header'|'path'|null, landlock: string }>}
 */
async function guestStage(client, imageId, marker) {
  const stage = "guest";
  const created = await client.createSession({
    imageId, labels: { evimed: "bringup", bringup: marker }, lifecycle: { idleMinutes: 10, maxRuntimeMinutes: 30 },
  });
  const { session, sessionId } = created;
  fact(stage, "session", sessionId);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "evimed-bringup-"));
  try {
    const run = async (line, envs) => {
      const result = await client.guard("bring-up command", () => session.command.executeCommand(line, 50_000, undefined, envs));
      return { ok: Boolean(result?.success), out: String(result?.stdout ?? result?.output ?? "").trim() };
    };
    const kernelRelease = (await run("uname -r")).out;
    fact(stage, "guest kernel", kernelRelease || "unknown");
    const abi = Number((await run(`python3 -c 'import ctypes; l = ctypes.CDLL(None, use_errno=True); a = l.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1)); print(a if a > 0 else 0)'`)).out) || 0;
    const landlock = abi >= 5 ? "full" : abi >= 1 ? "partial" : "none";
    fact(stage, "Landlock", `ABI ${abi} → ${landlock}${landlock === "none" ? " (the provider refuses this guest)" : landlock === "partial" ? " (set OPEN_SCIENCE_AGENTBAY_SANDBOX_ENFORCEMENT=partial to accept it)" : ""}`);
    for (const [label, line] of [
      ["runtime user", "id evimed"],
      ["kernel", "dsh --version"],
      ["node", "node --version"],
      ["launcher", "test -x /usr/local/bin/evimed-session && echo present"],
      ["firewall", "iptables -S OUTPUT >/dev/null && echo 'iptables usable'"],
      ["installation owner", "stat -c '%U %a %n' /opt/evimed /usr/local/lib/node_modules"],
      ["a path the runtime user can write in the installation", "runuser -u evimed -- find /opt/evimed /usr/local/lib/node_modules -writable -print -quit || true"],
    ]) {
      const result = await run(line);
      fact(stage, label, result.out.replace(/\s+/g, " ").slice(0, 200) || (result.ok ? "(none)" : "failed"));
    }
    // Whether the command API hands a command the environment it is given.
    // The provider does not depend on it (its launcher settings travel on the
    // command line), and knowing is cheaper than finding out later.
    const passed = await run("printenv EVIMED_BRINGUP_PROBE || true", { EVIMED_BRINGUP_PROBE: "passed" });
    fact(stage, "command API environment", passed.out === "passed" ? "passed through" : "not passed (the provider does not rely on it)");

    // The bridge, with the stand-in behind it, through AgentBay's own links.
    const secret = randomBytes(32).toString("base64url");
    await run("mkdir -p /run/evimed-bringup && chmod 0700 /run/evimed-bringup");
    await client.guard("bring-up file", () => session.fileSystem.writeFile("/run/evimed-bringup/bridge.secret", `${secret}\n`));
    await client.guard("bring-up file", () => session.fileSystem.writeFile("/run/evimed-bringup/stand-in.mjs", STAND_IN));
    await run("setsid -f node /run/evimed-bringup/stand-in.mjs > /run/evimed-bringup/stand-in.log 2>&1 < /dev/null");
    await run(`OPEN_SCIENCE_SESSION_BRIDGE_PORT=${BRIDGE_PORT} OPEN_SCIENCE_RUNTIME_PORT=${STAND_IN_PORT} OPEN_SCIENCE_SESSION_BRIDGE_SECRET_FILE=/run/evimed-bringup/bridge.secret setsid -f node /usr/local/bin/evimed-session-bridge.mjs > /run/evimed-bringup/bridge.log 2>&1 < /dev/null`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const linkOf = async (protocol) => {
      const answer = await client.guard("bring-up link", () => session.getLink(protocol, BRIDGE_PORT));
      if (!answer?.success || !answer.data) throw new StageError(stage, `no ${protocol} link to port ${BRIDGE_PORT}`);
      return String(answer.data);
    };
    const links = { http: await linkOf("https"), ws: await linkOf("wss") };
    fact(stage, "links", "https and wss obtained (their tokens are not printed)");

    /** @type {'header'|'path'|null} */
    let chosen = null;
    for (const mode of /** @type {const} */ (["header", "path"])) {
      const socketPath = path.join(scratch, `${mode}.sock`);
      const tunnel = createLinkTunnel({ socketPath, secret, mode, links });
      await tunnel.listen();
      try {
        const probe = await tunnel.probe(20_000);
        const plain = await httpThroughTunnel(socketPath, "/api/bringup?x=1&y=%2F");
        const upgrade = await upgradeThroughTunnel(socketPath, "/api/remote.mux");
        const httpOk = plain.status === 200 && plain.body?.path === "/api/bringup?x=1&y=%2F" && plain.body?.host === "dsh.runtime";
        const wsOk = upgrade.status === 101 && upgrade.accepted && upgrade.echoed && upgrade.path === "/api/remote.mux";
        fact(stage, `${mode} mode`, `bridge ${probe.ok ? "reached" : `not reached (HTTP ${probe.status ?? "-"})`}; HTTP ${httpOk ? "ok" : `failed (${plain.status}${plain.body?.path ? `, path ${plain.body.path}` : ""})`}; WebSocket ${wsOk ? "ok" : `failed (${upgrade.status}${upgrade.path ? `, path ${upgrade.path}` : ""})`}`);
        if (!chosen && probe.ok && httpOk && wsOk) chosen = mode;
      } finally {
        await tunnel.close();
      }
    }
    fact(stage, "OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE", chosen ?? "neither mode passed; the link proxy needs a closer look before any runtime can serve");
    return { mode: chosen, landlock };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await client.deleteSession(sessionId, { syncContext: false }).catch(() => {});
  }
}

async function jsonFetch(url, options = {}, expected = null, timeoutMs = 120_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (expected == null ? !response.ok : response.status !== expected) {
    throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} -> ${response.status} (${body?.code ?? "unexpected_status"})`);
  }
  return body;
}

async function authenticate(base) {
  const cookie = String(process.env.OPEN_SCIENCE_E2E_SESSION_COOKIE ?? "").trim();
  const csrf = String(process.env.OPEN_SCIENCE_E2E_CSRF_TOKEN ?? "").trim();
  if (cookie && csrf) return { Cookie: cookie, "X-Open-Science-CSRF": csrf };
  const username = String(process.env.OPEN_SCIENCE_E2E_USERNAME ?? "").trim();
  const password = String(process.env.OPEN_SCIENCE_E2E_PASSWORD ?? "");
  if (!username || !password) throw new Error("OPEN_SCIENCE_E2E_USERNAME and OPEN_SCIENCE_E2E_PASSWORD (or a session cookie and CSRF token) are required");
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`sign-in answered ${response.status}`);
  const body = await response.json();
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((value) => value.split(";")[0]).join("; ");
  const token = body?.data?.csrfToken ?? body?.csrfToken;
  if (!session || !token) throw new Error("sign-in returned no session");
  return { Cookie: session, "X-Open-Science-CSRF": String(token) };
}

async function command(base, name, args, headers, timeoutMs = 120_000) {
  return jsonFetch(`${base}/api/commands/${encodeURIComponent(name)}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(args ?? {}),
  }, null, timeoutMs);
}

async function waitForRun(base, runId, headers, timeoutMs, onMinute = async () => {}) {
  const deadline = Date.now() + timeoutMs;
  let minute = Date.now();
  while (Date.now() < deadline) {
    const listed = await jsonFetch(`${base}/api/agent-runs`, { headers });
    const run = (listed?.data ?? []).find((item) => item.id === runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - minute >= 60_000) {
      minute = Date.now();
      await onMinute(run);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`run ${runId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);
}

/**
 * @param {string} base @param {string} imageId @param {Record<string, any>} args @param {string} marker
 */
async function connectStage(base, imageId, args, marker) {
  const stage = "connect";
  const ready = await jsonFetch(`${base}/api/ready`);
  const runtime = ready?.data?.checks?.runtime ?? {};
  fact(stage, "readiness", `${ready?.data?.ok ? "ok" : "NOT ready"}; provider ${runtime.provider ?? runtime.sandboxMode ?? "?"}; image ${runtime.imageId ?? "?"}; bridge secret mode ${runtime.bridgeSecretMode ?? "?"}; gateway ${runtime.gateway ?? "?"}`);
  if (runtime.provider !== "agentbay") throw new StageError(stage, "the deployment does not run the AgentBay provider (OPEN_SCIENCE_RUNTIME_PROVIDER)");
  if (imageId && runtime.imageId !== imageId) {
    throw new StageError(stage, `the deployment runs image ${runtime.imageId}; set OPEN_SCIENCE_AGENTBAY_IMAGE_ID=${imageId}, restart the web service and rerun with --image ${imageId}`);
  }
  const auth = await authenticate(base);
  const projectId = `bringup-${marker}`;
  await jsonFetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ id: projectId, name: `AgentBay bring-up ${marker}` }),
  });
  const scoped = { ...auth, "X-Open-Science-Project": projectId };
  const cleanup = async () => {
    await command(base, "stop_runtime", {}, scoped).catch(() => {});
    if (!args.keep) await jsonFetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", headers: auth }).catch(() => {});
  };
  try {
    const started = Date.now();
    // A cold session start is a Context push, a VM and a kernel boot; the
    // server's own command deadline (OPEN_SCIENCE_COMMAND_TIMEOUT_MS) is what
    // bounds it, not this client.
    const starting = command(base, "start_runtime", {}, scoped, 600_000);
    let lastStage = null;
    let done = false;
    starting.finally(() => { done = true; }).catch(() => {});
    while (!done) {
      const status = await command(base, "runtime_status", {}, scoped).catch(() => null);
      const stageNow = status?.data?.startStage ?? null;
      if (stageNow && stageNow !== lastStage) {
        fact(stage, "start stage", `${stageNow} at ${Math.round((Date.now() - started) / 1000)} s`);
        lastStage = stageNow;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const runtimeUrl = (await starting)?.data;
    fact(stage, "runtime", `up in ${Math.round((Date.now() - started) / 1000)} s`);
    const status = await command(base, "runtime_status", {}, scoped);
    const sandbox = status?.data?.sandbox ?? {};
    fact(stage, "guest", `kernel ${sandbox.kernelRelease ?? "?"}; Landlock ${sandbox.landlock ?? "?"} (ABI ${sandbox.landlockAbi ?? "?"}); firewall ${sandbox.firewall ?? "?"}; session ${status?.data?.containerName ?? "?"}`);

    const session = await jsonFetch(`${runtimeUrl}/sessions`, { method: "POST", headers: { "Content-Type": "application/json", ...scoped }, body: "{}" });
    const sessionId = session?.data?.id;
    if (!sessionId) throw new StageError(stage, "no research session was created");
    const asked = Date.now();
    const dispatched = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST", headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({ sessionId, dispatchId: `bringup-${marker}-answer`, text: "用两句话说明：阿司匹林抑制血小板聚集的机制是什么？" }),
    }, 202);
    const answered = await waitForRun(base, dispatched?.data?.id, scoped, 10 * 60_000);
    fact(stage, "conversation", `${answered.status} in ${Math.round((Date.now() - asked) / 1000)} s${answered.errorCode ? ` (${answered.errorCode})` : ""}`);
    if (answered.status !== "succeeded") throw new StageError(stage, `the conversation ended as ${answered.status}`);

    if (args.deep) await deepStage(base, runtimeUrl, scoped, args, marker);
  } finally {
    await cleanup();
  }
}

async function deepStage(base, runtimeUrl, scoped, args, marker) {
  const stage = "deep";
  const agentId = String(args["deep-agent"] || "clinical-evidence-synthesis");
  const agents = await jsonFetch(`${base}/api/agents`, { headers: scoped });
  const agent = (agents?.data ?? []).find((item) => item.id === agentId);
  if (!agent) throw new StageError(stage, `the deployment offers no agent ${agentId}`);
  const session = await jsonFetch(`${runtimeUrl}/sessions`, { method: "POST", headers: { "Content-Type": "application/json", ...scoped }, body: "{}" });
  const sessionId = session?.data?.id;
  await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...scoped },
    body: JSON.stringify({ mode: "specialist", agentId: agent.id, agentVersion: agent.version }),
  });
  const brief = String(args["deep-brief"] || "系统评价：二甲双胍用于2型糖尿病合并慢性肾脏病（eGFR 30–60）患者的心血管结局与乳酸酸中毒风险，纳入随机对照试验与大型队列研究，给出证据确定性分级与临床建议。");
  const started = Date.now();
  const dispatched = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST", headers: { "Content-Type": "application/json", ...scoped },
    body: JSON.stringify({ sessionId, dispatchId: `bringup-${marker}-deep`, automated: true, text: brief }),
  }, 202);
  const run = await waitForRun(base, dispatched?.data?.id, scoped, 90 * 60_000, async () => {
    const status = await command(base, "runtime_status", {}, scoped).catch(() => null);
    fact(stage, "minute", `${Math.round((Date.now() - started) / 60_000)} min; runtime ${status?.data?.running ? "up" : `DOWN (${status?.data?.error ?? "?"})`}`);
  });
  fact(stage, "run", `${run.status} in ${Math.round((Date.now() - started) / 60_000)} min; verification ${run.verification ?? "?"}; ${run.artifacts?.length ?? 0} deliverable(s)${run.errorCode ? `; ${run.errorCode}` : ""}`);
  let read = 0;
  for (const artifact of (run.artifacts ?? []).slice(0, 5)) {
    const file = await command(base, "read_artifact", { path: artifact }, scoped).catch(() => null);
    if (file?.data) read += 1;
  }
  fact(stage, "deliverables read back", `${read} of ${Math.min(5, run.artifacts?.length ?? 0)}`);
  if (!["succeeded", "delivered"].includes(run.status) && !run.artifacts?.length) throw new StageError(stage, `the deep run ended as ${run.status} with nothing delivered`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const marker = randomBytes(6).toString("hex");
  let imageId = String(args.image || process.env.OPEN_SCIENCE_AGENTBAY_IMAGE_ID || "").trim();
  if (args["build-tag"]) imageId = await buildStage(String(args["build-tag"]), String(args.base || "code-space-debian-12"));
  if (!imageId) throw new StageError("setup", "no image: pass --image <imgc-…>, set OPEN_SCIENCE_AGENTBAY_IMAGE_ID, or build one with --build-tag");
  fact("setup", "image", imageId);

  const client = createAgentBayClient({
    agentbayApiKeyFile: process.env.OPEN_SCIENCE_AGENTBAY_API_KEY_FILE ?? "",
    agentbayRegion: process.env.OPEN_SCIENCE_AGENTBAY_REGION ?? "cn-hangzhou",
    agentbayEndpoint: process.env.OPEN_SCIENCE_AGENTBAY_ENDPOINT ?? "",
  });
  if (!client.configured) throw new StageError("setup", "OPEN_SCIENCE_AGENTBAY_API_KEY_FILE is not set");
  fact("setup", "AgentBay SDK", await client.sdkVersion());

  await guestStage(client, imageId, marker);
  const base = String(args["base-url"] || "").replace(/\/+$/, "");
  if (base) await connectStage(base, imageId, args, marker);
  else fact("connect", "skipped", "pass --base-url https://<domain> once the deployment runs this image");
  process.stdout.write("bring-up: every stage that ran passed\n");
}

main().catch((error) => {
  // Everything the AgentBay client throws is already scrubbed; this scrubs
  // link tokens once more for anything that came from elsewhere.
  process.stderr.write(`bring-up failed at ${scrubAgentBayText(error?.message ?? String(error))}\n`);
  process.exitCode = 1;
});
