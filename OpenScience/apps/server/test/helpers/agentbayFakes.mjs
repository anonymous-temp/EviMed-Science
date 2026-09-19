// A fake AgentBay for the provider's tests: the SDK client's surface, sessions
// that are directories on this machine, Contexts kept by a fake OSS, and the
// link proxy in front of each session's port. What runs inside a fake session
// is as real as this machine allows: the real session bridge, the real
// launcher script's manifest, and a kernel that authenticates the way DSH does
// (a cookie bound to the Host it receives, signed with the secret the control
// plane wrote into the session's credentials file).

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockAcceptsBrowserSession } from "../../src/mockDshRuntime.mjs";
import { createSessionBridge } from "../../../../deploy/runtime-dsh/evimed-session-bridge.mjs";

const launcherScript = fileURLToPath(new URL("../../../../deploy/runtime-dsh/evimed-session.sh", import.meta.url));

/** @param {http.Server} server @returns {Promise<number>} */
export function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server.address()).port)));
}

/** @param {http.Server} server */
export function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

/**
 * A stand-in for AgentBay's session link proxy: `/request_ai/<token>/path/…`
 * reaches the session port with the suffix, `/websocket_ai/<token>[…]` is the
 * WebSocket endpoint and forwards whatever follows the token. The port behind
 * it is asked per request, so a link outlives the kernel restarting behind it;
 * nothing listening there is a 502, and a released session's link is a 404.
 * `strip` models a proxy that drops custom headers, which the path-prefix
 * fallback exists for.
 * @param {{ port: () => number | null, token: string, strip?: boolean, alive?: () => boolean }} options
 */
export async function linkProxy({ port, token, strip = false, alive = () => true }) {
  const sockets = new Set();
  /** @param {http.IncomingHttpHeaders} headers */
  const clean = (headers) => Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !(strip && name.toLowerCase().startsWith("x-evimed-")) && name.toLowerCase() !== "host"));
  const server = http.createServer((req, res) => {
    const prefix = `/request_ai/${token}/path`;
    const target = port();
    if (!alive() || !String(req.url).startsWith(`${prefix}/`)) { res.writeHead(404); res.end("unknown link"); return; }
    if (!target) { res.writeHead(502); res.end("nothing listens on the port"); return; }
    const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method, path: String(req.url).slice(prefix.length),
      headers: { ...clean(req.headers), host: `127.0.0.1:${target}` } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.once("error", () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const prefix = `/websocket_ai/${token}`;
    const target = port();
    if (!alive() || !String(req.url).startsWith(prefix) || !target) { socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    const suffix = String(req.url).slice(prefix.length) || "/";
    const upstream = net.connect({ host: "127.0.0.1", port: target }, () => {
      const lines = [`GET ${suffix} HTTP/1.1`, `Host: 127.0.0.1:${target}`];
      for (const [name, value] of Object.entries(clean(req.headers))) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.once("error", close);
    socket.once("error", close);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const bound = await listen(server);
  return {
    links: { http: `http://127.0.0.1:${bound}/request_ai/${token}/path/`, ws: `ws://127.0.0.1:${bound}/websocket_ai/${token}` },
    /** Cuts every connection in flight, as a proxy restart would. */
    cut() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await closeServer(server); },
  };
}

/** Contexts as a fake OSS: objects by Context id and path, PUT and GET over HTTP. */
export async function fakeOss() {
  /** @type {Map<string, Map<string, { body: Buffer, modified: string }>>} */
  const objects = new Map();
  /** @param {string} id */
  const bucket = (id) => {
    if (!objects.has(id)) objects.set(id, new Map());
    return /** @type {Map<string, { body: Buffer, modified: string }>} */ (objects.get(id));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(String(req.url), "http://oss.local");
    const [, id, ...rest] = url.pathname.split("/");
    const key = `/${rest.map(decodeURIComponent).join("/")}`;
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        bucket(id).set(key, { body: Buffer.concat(chunks), modified: new Date().toISOString() });
        res.writeHead(200);
        res.end();
      });
      return;
    }
    const object = bucket(id).get(key);
    if (!object) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-length": object.body.length });
    res.end(object.body);
  });
  const port = await listen(server);
  return {
    objects,
    bucket,
    /** @param {string} id @param {string} file */
    url: (id, file) => `http://127.0.0.1:${port}/${id}${file.split("/").map(encodeURIComponent).join("/")}`,
    /** Every object's path and text, for assertions about what reached a Context. */
    everything() {
      return [...objects].flatMap(([id, files]) => [...files].map(([file, object]) => ({ id, file, text: object.body.toString("utf8") })));
    },
    close: () => closeServer(server),
  };
}

/** A kernel that authenticates as DSH does and answers what readiness asks. */
async function fakeKernel(secret) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, host: req.headers.host });
    if (!mockAcceptsBrowserSession({ secret, authority: String(req.headers.host ?? ""), cookieHeader: req.headers.cookie })) {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let envelope = {};
      try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { envelope = {}; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "client-response", rpcId: /** @type {any} */ (envelope).rpcId, result: { ok: true, value: { items: [] } } }));
    });
  });
  const port = await listen(server);
  return { port, calls, close: () => closeServer(server) };
}

/** @param {string} root @param {string} file */
function underRoot(root, file) {
  const resolved = path.resolve(root, `.${file}`);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes the fake session: ${file}`);
  return resolved;
}

/** @param {Record<string, any> | undefined} policy */
function excludedNames(policy) {
  return (policy?.bwList?.whiteLists?.[0]?.excludePaths ?? []).map((/** @type {string} */ value) => value.replace(/^\//, ""));
}

/**
 * The SDK client's surface over fake sessions.
 * @param {{ root: string, oss: Awaited<ReturnType<typeof fakeOss>>,
 *   report?: ((envs: Record<string, string>) => Record<string, any>) | null }} options
 *   `report` is what the launcher's `start` prints; by default a guest with
 *   Landlock ABI 6 and the firewall applied
 */
export function fakeAgentBay({ root, oss, report = null }) {
  /** @type {{ create: any[], delete: { sessionId: string, syncContext: boolean }[], commands: any[], writes: any[], keepAlive: number, list: any[] }} */
  const calls = { create: [], delete: [], commands: [], writes: [], keepAlive: 0, list: [] };
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let counter = 0;
  let reportNext = report;

  async function installIncoming(state) {
    const incoming = underRoot(state.dir, "/run/evimed/incoming");
    const names = await fs.readdir(incoming).catch(() => []);
    for (const name of names) {
      const source = path.join(incoming, name);
      const content = await fs.readFile(source, "utf8");
      if (name === "bridge.secret" || name === "kernel.env") {
        await fs.mkdir(underRoot(state.dir, "/run/evimed"), { recursive: true });
        await fs.writeFile(underRoot(state.dir, `/run/evimed/${name}`), content);
      } else if (name === "capsule-methods.json") {
        for (const [rel, text] of Object.entries(JSON.parse(content).files)) {
          const target = underRoot(state.dir, `/run/evimed/capsule-methods/${rel}`);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, String(text));
        }
      } else {
        await fs.mkdir(underRoot(state.dir, "/runtime/dsh-home"), { recursive: true });
        await fs.writeFile(underRoot(state.dir, `/runtime/dsh-home/${name}`), content);
      }
      await fs.rm(source);
    }
  }

  async function startKernel(state, envs) {
    await installIncoming(state);
    const said = reportNext ? reportNext(envs) : { ok: true, kernelRelease: "6.12.0-agentbay", landlockAbi: 6, landlock: "full", firewall: "applied", firewallDetail: "applied" };
    if (!said.ok) return said;
    await stopKernel(state);
    const credentials = await fs.readFile(underRoot(state.dir, "/runtime/dsh-home/.credentials.yaml"), "utf8");
    const browserSecret = /secret: '([^']+)'/.exec(credentials)?.[1];
    const bridgeSecret = (await fs.readFile(underRoot(state.dir, "/run/evimed/bridge.secret"), "utf8")).trim();
    state.kernel = await fakeKernel(browserSecret);
    state.bridge = createSessionBridge({ secret: bridgeSecret, upstreamPort: state.kernel.port });
    state.bridgePort = await listen(state.bridge);
    state.starts += 1;
    return said;
  }

  async function stopKernel(state) {
    if (state.bridge) await closeServer(state.bridge);
    await state.kernel?.close();
    state.bridge = null;
    state.kernel = null;
    state.bridgePort = null;
  }

  function makeSession(state) {
    return {
      sessionId: state.sessionId,
      command: {
        async executeCommand(commandLine, timeoutMs, _cwd, passedEnvs = {}) {
          // A leading `NAME='value' …` is the shell's environment for the
          // command, which is how the provider hands the launcher its settings.
          /** @type {Record<string, string>} */
          const envs = { ...passedEnvs };
          let line = String(commandLine);
          for (let match = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)' /.exec(line); match; match = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)' /.exec(line)) {
            envs[match[1]] = match[2].replace(/'\\''/g, "'");
            line = line.slice(match[0].length);
          }
          calls.commands.push({ sessionId: state.sessionId, line, envs, timeoutMs });
          const args = line.split(" ");
          if (args[0] === "mkdir") {
            const dir = /mkdir -p '?([^' ]+)'?/.exec(line)?.[1] ?? "";
            await fs.mkdir(underRoot(state.dir, dir), { recursive: true });
            return { success: true, exitCode: 0, stdout: "" };
          }
          if (args[0] !== "/usr/local/bin/evimed-session") return { success: false, exitCode: 127, stdout: "", stderr: "unknown" };
          if (args[1] === "start") {
            const said = await startKernel(state, envs);
            return { success: said.ok === true, exitCode: said.ok ? 0 : 3, stdout: `${JSON.stringify(said)}\n` };
          }
          if (args[1] === "install") {
            await installIncoming(state);
            state.installs += 1;
            return { success: true, exitCode: 0, stdout: '{"ok":true}\n' };
          }
          if (args[1] === "manifest") {
            const stdout = execFileSync("bash", [launcherScript, "manifest", underRoot(state.dir, args[2]), ...args.slice(3)], { encoding: "utf8" });
            return { success: true, exitCode: 0, stdout };
          }
          if (args[1] === "log") return { success: true, exitCode: 0, stdout: "the kernel's last words" };
          return { success: false, exitCode: 64, stdout: "" };
        },
      },
      fileSystem: {
        async writeFile(file, content) {
          calls.writes.push({ sessionId: state.sessionId, file, content: String(content) });
          const target = underRoot(state.dir, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
          return { success: true };
        },
        async readFile(file) {
          try {
            return { success: true, content: new Uint8Array(await fs.readFile(underRoot(state.dir, file))) };
          } catch {
            return { success: false, errorMessage: "not found" };
          }
        },
      },
      async getLink(protocol, port) {
        state.linkPorts.push(port);
        return { success: true, data: protocol === "https" ? state.proxy.links.http : state.proxy.links.ws };
      },
      async keepAlive() { calls.keepAlive += 1; return { success: true }; },
      async getMetrics() { return { success: true, data: { memUsed: state.memUsed, memTotal: 8192 } }; },
    };
  }

  /** Contexts downloaded into a new session, the way AgentBay's sync does. */
  async function download(state, contextSync = []) {
    for (const entry of contextSync) {
      const excluded = excludedNames(entry.policy);
      for (const [file, object] of oss.bucket(entry.contextId)) {
        if (excluded.includes(file.split("/")[1])) continue;
        const target = underRoot(state.dir, `${entry.path}${file}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, object.body);
      }
    }
  }

  /** One mount's files into its Context, top-level exclusions skipped. */
  async function uploadTree(target, excluded, dir, rel) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (!rel && excluded.includes(item.name)) continue;
      if (item.isDirectory()) await uploadTree(target, excluded, path.join(dir, item.name), childRel);
      else if (item.isFile()) target.set(`/${childRel}`, { body: await fs.readFile(path.join(dir, item.name)), modified: new Date(Date.now() + 5_000).toISOString() });
    }
  }

  /** A release's upload: upload-enabled Contexts take the session's files. */
  async function upload(state) {
    for (const entry of state.contextSync) {
      if (!entry.policy?.uploadPolicy?.autoUpload) continue;
      await uploadTree(oss.bucket(entry.contextId), excludedNames(entry.policy), underRoot(state.dir, entry.path), "");
    }
  }

  const client = {
    configured: true,
    region: "cn-hangzhou",
    async createSession(input) {
      calls.create.push(input);
      const sessionId = `s-${++counter}`;
      const state = { sessionId, dir: path.join(root, sessionId), contextSync: input.contextSync ?? [], labels: input.labels ?? {}, alive: true,
        kernel: null, bridge: null, bridgePort: null, proxy: null, starts: 0, installs: 0, linkPorts: [], memUsed: 1024 };
      await fs.mkdir(state.dir, { recursive: true });
      await download(state, input.contextSync);
      state.proxy = await linkProxy({ port: () => state.bridgePort, token: `tok-${sessionId}`, alive: () => state.alive });
      state.session = makeSession(state);
      sessions.set(sessionId, state);
      return { sessionId, session: state.session };
    },
    async getSession(sessionId) {
      const state = sessions.get(sessionId);
      return state?.alive ? { sessionId, session: state.session } : null;
    },
    async deleteSession(sessionId, { syncContext = false } = {}) {
      calls.delete.push({ sessionId, syncContext });
      const state = sessions.get(sessionId);
      if (!state?.alive) return { deleted: false, missing: true };
      if (syncContext) await upload(state);
      await stopKernel(state);
      state.alive = false;
      return { deleted: true, missing: false };
    },
    async listSessions({ labels = {} } = {}) {
      calls.list.push(labels);
      return [...sessions.values()]
        .filter((state) => state.alive && Object.entries(labels).every(([key, value]) => state.labels[key] === value))
        .map((state) => ({ sessionId: state.sessionId, status: "RUNNING" }));
    },
    contexts: {
      async get(name) { return { id: `ctx-${name}`, name }; },
      async uploadUrl(id, file) { return oss.url(id, file); },
      async downloadUrl(id, file) { return oss.url(id, file); },
      async listFiles(id, folder) {
        const prefix = folder.endsWith("/") ? folder : `${folder}/`;
        const entries = new Map();
        for (const [file, object] of oss.bucket(id)) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          const cut = rest.indexOf("/");
          if (cut < 0) entries.set(file, { path: file, type: "file", size: object.body.length, modified: object.modified });
          else entries.set(`${prefix}${rest.slice(0, cut)}`, { path: `${prefix}${rest.slice(0, cut)}`, type: "folder", size: null, modified: null });
        }
        return { entries: [...entries.values()], nextToken: null };
      },
      async deleteFile(id, file) { oss.bucket(id).delete(file); return true; },
    },
    guard(_label, operation) { return Promise.resolve().then(operation); },
    async sdkVersion() { return "0.22.0-fake"; },
  };

  return {
    client,
    calls,
    sessions,
    /** What the next `evimed-session start` prints. */
    reportWith(next) { reportNext = next; },
    /** Something happening inside a session, as if the run did it. */
    async writeInSession(sessionId, file, content) {
      const target = underRoot(sessions.get(sessionId).dir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
    async removeInSession(sessionId, file) {
      await fs.rm(underRoot(sessions.get(sessionId).dir, file), { force: true });
    },
    /** @param {string} sessionId @param {string} file */
    sessionFile(sessionId, file) { return underRoot(sessions.get(sessionId).dir, file); },
    async killKernel(sessionId) {
      const state = sessions.get(sessionId);
      await state.kernel?.close();
      state.kernel = null;
    },
    /** AgentBay ending a session on its own clock: the Context upload, then gone. */
    async releaseOnItsOwn(sessionId) {
      const state = sessions.get(sessionId);
      await upload(state);
      await stopKernel(state);
      state.alive = false;
    },
    async closeAll() {
      for (const state of sessions.values()) {
        await stopKernel(state);
        await state.proxy?.close();
      }
    },
  };
}
