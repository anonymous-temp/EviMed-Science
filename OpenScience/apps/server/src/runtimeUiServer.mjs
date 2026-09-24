/** The native browser application on an isolated origin, with immutable per-frame project bindings. */
import { createServer } from "node:http";
import { SEAMS } from "@evimed/harness-port";

import { CAPABILITY_DISPLAY, capabilityBrief, errorCodeMessage, isDeniedRuntimeUiHostRoute, isDeniedRuntimeUiMethod, RUNTIME_UI_WORKSPACE_PATH_METHODS, runtimeUiMethodFromPath, runtimeUiWorkspacePathRefusal } from "@evimed/domain";
import { assertSpendWithinLimits } from "./usageMetering.mjs";

import { HttpError, readBody } from "./security.mjs";
import { RUNTIME_UI_FRAME_COOKIE, parseRuntimeUiFramePath, runtimeUiCookie, runtimeUiOrigins, validateRuntimeUiFrame } from "./runtimeUiFrames.mjs";
import { runtimeUiBootstrapSource } from "./runtimeUiDocument.mjs";
import { IMMUTABLE_UI_CACHE, SHARED_UI_ASSET_PREFIX, isImmutableRuntimeUiAsset } from "./runtimeManager.mjs";

/**
 * The methods that make the deployment spend money.
 *
 * Only prompting does: everything else the application calls reads state,
 * navigates or renders. Refusing those on a spend cap would lock someone out
 * of work they have already paid for.
 */
export const RUNTIME_UI_SPENDING_METHODS = new Set(["session/prompt"]);

/** The composer's raw-byte attachment route (`dsh-client-file-upload`). */
export const RUNTIME_UI_UPLOAD_METHOD = "session/uploadFileBinary";

/**
 * How long a frame's release waits for its connections to report closed. A
 * destroyed socket closes within a tick; the bound is for one that never says
 * so, which must not hold the release — and the shell's next start behind
 * it — open.
 */
const FRAME_RELEASE_WAIT_MS = 2_000;

/** Browser cookies are accepted only from these explicit deployment origins.
 * Origin-less automation must use the control plane's authenticated API; this
 * browser surface deliberately has no implicit internal-client exception.
 * @param {any} req @param {Record<string, any>} config
 */
function assertBrowserOrigin(req, config) {
  const origin = req.headers.origin;
  const allowed = [config.runtimeUiPublicOrigin, config.publicUrl].some((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.origin === origin;
    } catch { return false; }
  });
  if (typeof origin !== "string" || !allowed) {
    throw new HttpError(403, "runtime_ui_origin_denied", "The runtime UI requires an allowed browser Origin.");
  }
}

/** @param {Record<string, any>} config @param {any} project @param {string} method */
async function authorizeMethod(config, project, method, boundWorkspace = false, usageLedger = null, runtimeManager = null) {
  if (isDeniedRuntimeUiMethod(method) && !(method === "workspace/create" && boundWorkspace)) {
    throw new HttpError(403, "runtime_ui_method_denied", `${method} is not available in the hosted surface.`);
  }
  if (RUNTIME_UI_SPENDING_METHODS.has(method)) {
    runtimeManager?.assertInteractiveRuntimeAvailable(project);
    if (usageLedger) await usageLedger.assertWithinLimits(project.userId, {
      dailyLimit: Number(config.userDailySpendLimit) || 0,
      weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
    });
    else await assertSpendWithinLimits(config, project.userId);
  }
}

/**
 * A workspace-file read is held to this project's workspace before it is
 * forwarded. The kernel resolves the path against the workspace and, for the
 * five reading methods, never confines it (see `RUNTIME_UI_WORKSPACE_PATH_METHODS`
 * in `@evimed/domain`); this is the confinement, on both transports, with
 * the same refusal the method deny list gives.
 * @param {string | null} method @param {unknown} payload @param {string} workspaceRoot
 */
function assertWorkspacePath(method, payload, workspaceRoot) {
  const refusal = runtimeUiWorkspacePathRefusal(method, payload, workspaceRoot);
  if (refusal) throw new HttpError(403, "runtime_ui_method_denied", `${method} refused: ${refusal}.`);
}

const WORKSPACE_PATH_METHODS = new Set(RUNTIME_UI_WORKSPACE_PATH_METHODS);

const exactFields = (value, fields) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

/** Only register the directory already selected and isolated by this frame's runtime. */
function isBoundWorkspaceRegistration(body, cwd) {
  return exactFields(body, ["type", "rpcId", "method", "payload"]) && body.type === "client-request"
    && typeof body.rpcId === "string" && body.rpcId.length > 0 && body.rpcId.length <= 128
    && body.method === "workspace/create" && exactFields(body.payload, ["args"])
    && exactFields(body.payload.args, ["request"]) && exactFields(body.payload.args.request, ["path"])
    && typeof cwd === "string" && cwd.startsWith("/") && body.payload.args.request.path === cwd;
}

/** @param {unknown} value @returns {string} HTML-safe text */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char
  ));
}

/**
 * What a reader should be told a raw code means.
 *
 * The page used to print the code itself as its whole explanation, so the
 * first thing a researcher saw when the deployment was at its runtime ceiling
 * was the words `runtime_limit_exceeded` (2026-09-15 walk, A4/D5). Every code
 * the control plane raises already has a Simplified Chinese sentence in
 * `@evimed/domain`; this routes through it, and adds the one sentence the
 * table cannot carry because it is about this surface rather than the code:
 * a conversation that cannot start because another is running is waited out or
 * freed, not retried. The same words as the shell's own (`RuntimeUiFrame`).
 *
 * @param {string} code
 */
function noticeDetail(code) {
  if (code === "runtime_limit_exceeded") return "同时进行的研究已达上限，先结束一个再试。";
  return errorCodeMessage(code);
}

/**
 * A page, not JSON, because everything served here is loaded by a browser as a
 * frame or a navigation: JSON would render as text the person cannot act on.
 *
 * @param {any} res @param {number} status @param {string} title
 * @param {string} detail a second line, or "" when the title says it all —
 *   the shell then shows the title
 * @param {{ code?: string, shellOrigin?: string }} [context] What to tell the
 *   embedding shell. Without it the shell learns nothing until its own 30 s
 *   deadline fires and blames a slow cold start for a refusal the server
 *   already named — which is exactly what the walk recorded (A8).
 */
function sendNotice(res, status, title, detail, context = {}) {
  const { code, shellOrigin } = context;
  // The bridge is not loaded on this page: it ships with the kernel's own
  // application, and this page is served instead of it. So the notice posts
  // for itself, with no frame claims and no sequence — the shell accepts it on
  // origin and source alone, and it selects a message rather than granting
  // anything.
  const announce = shellOrigin
    ? `<script>try{parent.postMessage({type:"evimed.runtime-ui.notice",version:1,`
      + `code:${JSON.stringify(String(code ?? ""))},title:${JSON.stringify(title)},`
      + `detail:${JSON.stringify(detail)}},${JSON.stringify(shellOrigin)})}catch(e){}</script>`
    : "";
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + `<body style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;`
    + `display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#3f3a36">`
    + `<div style="text-align:center;max-width:36rem;padding:0 1.5rem">`
    + `<p style="font-weight:600;margin:0 0 8px">${escapeHtml(title)}</p>`
    + (detail ? `<p style="margin:0;color:#8a8178;font-size:14px;line-height:1.6">${escapeHtml(detail)}</p>` : "")
    + `</div>`
    + `</body>${announce}`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/**
 * A refusal the calling page can read, and the audit row can name.
 *
 * JSON rather than {@link sendNotice}'s page: these are reached by the
 * application's own `fetch`, not by a navigation, so a rendered notice would
 * arrive as a body no error surface can act on. Shared by the two refusals --
 * the method one and the route one -- because they answer the same question
 * about different halves of the surface, and a second copy of the shape is how
 * one of them quietly stops matching the other.
 *
 * @param {any} res @param {string} subject
 */
function sendDenied(res, subject) {
  const payload = JSON.stringify({
    error: { code: "runtime_ui_method_denied", message: `${subject} is not available in the hosted surface.` },
  });
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** @param {any} socket @param {number} status @param {string} code */
function destroyUpgrade(socket, status, code) {
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* the peer may already be gone */ }
  socket.destroy();
}

/**
 * @param {{ config: Record<string, any>, store: any, runtimeManager: any, agentRegistry?: any, usageLedger?: any, authorizePrompt?:(project:any,sessionId:string)=>Promise<void>, authorizeMutation?:((operation:()=>Promise<any>)=>Promise<any>)|null }} deps
 * @returns {{ server: import('node:http').Server, releaseFrame: (frameId: string, userId: string) => Promise<number>, refreshFrameBinding: (renewed: any) => number, listen: (port?: number, host?: string) => Promise<any>, address: () => any, close: () => Promise<void> }}
 */
export function createRuntimeUiServer({ config, store, runtimeManager, agentRegistry = null, usageLedger = null, authorizePrompt = null, authorizeMutation = null }) {
  async function authorizePromptSession(project, payload) {
    if (!authorizePrompt) return;
    // The existing native wire uses payload.args.request on both HTTP RPC and
    // mux opens, exactly as DshRuntimeAdapter.prompt and callKernel produce.
    const sessionId = payload?.args?.request?.sessionId;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
      throw new HttpError(400, "runtime_ui_prompt_invalid", "A native prompt must name its session.");
    }
    await authorizePrompt(project, sessionId);
  }
  const upgradeSockets = new Set();
  /** Only live transports are indexed. Renewal updates their short ticket, never their login. */
  const frameConnections = new Map();
  function trackFrame(snapshot, claims, transport) {
    const connections = frameConnections.get(claims.frameId) ?? new Set();
    const connection = { snapshot, claims, transport };
    connections.add(connection);
    frameConnections.set(claims.frameId, connections);
    const remove = () => {
      connections.delete(connection);
      if (!connections.size && frameConnections.get(claims.frameId) === connections) frameConnections.delete(claims.frameId);
      transport.removeListener("close", remove);
      transport.removeListener("finish", remove);
    };
    transport.once("close", remove);
    transport.once("finish", remove);
    if (transport.destroyed || transport.writableFinished) remove();
  }
  /**
   * Where a notice page may announce itself, or "" when this deployment has no
   * valid pair of origins.
   *
   * `runtimeUiOrigins` THROWS on an unconfigured or malformed pair — it is the
   * validator, not a getter — so reading it eagerly here threw during server
   * construction for every deployment that does not serve this surface, and
   * `createWebApiApp` never finished listening. Caught rather than hoisted out
   * of the constructor because a notice page that cannot name its parent is
   * still a notice page: it renders, it just does not post.
   */
  const noticeShellOrigin = () => {
    try { return runtimeUiOrigins(config).shellOrigin; } catch { return ""; }
  };
  const shellOrigin = noticeShellOrigin();

  /**
   * The capability cards the kernel's blank-session hero offers, resolved once.
   *
   * Carried in the frame's bootstrap object rather than fetched by the frame:
   * the hero renders on first paint, and a card grid that arrives a round-trip
   * later is a start screen that changes under the reader. It is also the only
   * way the plugin can have them at all — its body is serialized with
   * `toString()` into a browser bundle that may import nothing, and it sits on
   * an origin with no session of ours.
   *
   * Names come from `@evimed/domain`'s display table, so the cards inside the
   * frame and the 「科研能力」 page outside it say the same words. A capability
   * the table has no name for is left out rather than shown by its id: a start
   * screen is the wrong place to meet `dataset-research-scoping`.
   *
   * Each card also carries the display table's one-line description and the
   * manifest's typical duration, which the frame's `/能力` command shows beside
   * the title (2026-09-18 plan, §7.3).
   *
   * @returns {Promise<{ id: string, title: string, category: string, brief: string, summary: string, minutes: readonly number[] }[]>}
   */
  let capabilityCards = null;
  async function heroCapabilities() {
    if (capabilityCards) return capabilityCards;
    if (!agentRegistry) return (capabilityCards = []);
    try {
      const registry = await agentRegistry;
      capabilityCards = registry.list()
        .map((agent) => ({ agent, display: CAPABILITY_DISPLAY[agent.id] }))
        .filter((entry) => entry.display)
        .map(({ agent, display }) => ({
          id: agent.id,
          title: display.title,
          category: display.category,
          brief: capabilityBrief(display.title, display.starterPrompts[0] ?? ""),
          summary: display.description,
          minutes: agent.estimatedMinutes,
          // What the tool's own page shows above the composer: the three
          // example questions, what the run hands back, and whether it needs
          // material of the researcher's before it can start.
          starters: display.starterPrompts.slice(0, 3),
          outputs: (display.outputs ?? []).slice(0, 4),
          limits: (display.knownLimits ?? []).slice(0, 4),
          materials: typeof display.materials === "string" ? display.materials : "",
        }))
        .sort((left, right) => left.category.localeCompare(right.category, "zh") || left.title.localeCompare(right.title, "zh"));
    } catch {
      // A catalogue that cannot be read costs the cards, never the session.
      capabilityCards = [];
    }
    return capabilityCards;
  }

  /**
   * @param {any} req @param {any} res
   * @returns {Promise<Record<string, any>>} the project this request addresses
   */
  async function resolveFrame(req, res) {
    const frame = parseRuntimeUiFramePath(req.url ?? "/");
    const { user, session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    const claims = validateRuntimeUiFrame({ config, req, user, session, frameId: frame.frameId });
    const project = await store.requireProject(user, claims.projectId);
    return { user, session, project, claims, frame };
  }

  /**
   * The kernel application's build assets, under a path that does not change
   * from one frame to the next (`/__evimed/a/<projectId>/assets/<file>`), so a
   * browser that opened a session a minute ago does not download the whole
   * application again for the next one (2026-09-18 plan, session open). The
   * document is rewritten to reference them here (`rebaseRuntimeUiDocument`).
   *
   * Authorized by the login and the project it names, not by a frame: the
   * files are the kernel's published application, the same for every
   * researcher, and a frame cookie is scoped to its own path and is not sent
   * here. Read-only, and only files: nothing under this path reaches a method.
   * @returns {Promise<boolean>} whether the request was this route's
   */
  async function serveProjectAsset(req, res) {
    const target = String(req.url ?? "");
    if (target.startsWith(SHARED_UI_ASSET_PREFIX)) {
      await serveSharedAsset(req, res, target.slice(SHARED_UI_ASSET_PREFIX.length - 1));
      return true;
    }
    const match = /^\/__evimed\/a\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(assets\/[A-Za-z0-9._-]+)$/.exec(target.split("?")[0]);
    if (!target.startsWith("/__evimed/a/")) return false;
    if (!match || !["GET", "HEAD"].includes(String(req.method).toUpperCase())) {
      throw new HttpError(404, "runtime_ui_asset_not_found", "No such application file.");
    }
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    const project = await store.requireProject(user, match[1]);
    const suffix = `/${match[2]}`;
    await runtimeManager.proxy(req, res, project, suffix, {
      surface: "ui",
      uiBasePath: `/__evimed/a/${project.id}/`,
      immutable: isImmutableRuntimeUiAsset(suffix),
      rebaseDocument: false,
    });
    return true;
  }

  /**
   * The kernel application's files at the one address every frame shares
   * (`SHARED_UI_ASSET_PREFIX`): build assets by hashed name, plugin bundles
   * by revision. Authorized by the login alone, like the per-project route
   * above, and read-only; served from the control plane's memory after the
   * first fetch, gzipped when the browser accepts it, so neither a reverse
   * proxy's configuration nor a runtime round trip decides how fast a
   * session opens.
   * @param {any} req @param {any} res @param {string} suffix what follows the prefix, with its leading `/`
   */
  async function serveSharedAsset(req, res, suffix) {
    const asset = /^\/assets\/[A-Za-z0-9._-]+$/.test(suffix)
      || /^\/plugins\/\?\?[A-Za-z0-9@/._,-]{1,8192}&rev=[A-Za-z0-9._-]{6,64}$/.test(suffix);
    if (!asset || suffix.includes("..") || !["GET", "HEAD"].includes(String(req.method).toUpperCase())) {
      throw new HttpError(404, "runtime_ui_asset_not_found", "No such application file.");
    }
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    const file = await runtimeManager.sharedUiAsset(String(user.id), suffix);
    const gzip = file.gzip && /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? "")) ? file.gzip : null;
    const body = gzip ?? file.body;
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": file.contentType,
      "Content-Length": String(body.length),
      "Cache-Control": file.immutable ? IMMUTABLE_UI_CACHE : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
    };
    if (gzip) headers["Content-Encoding"] = "gzip";
    res.writeHead(file.status, headers);
    res.end(String(req.method).toUpperCase() === "HEAD" ? undefined : body);
  }

  async function handle(req, res) {
    if (!config.runtimeUiProxyEnabled) {
      sendNotice(res, 404, "对话暂不可用", "", { code: "runtime_ui_not_enabled", shellOrigin });
      return;
    }
    // An unauthenticated frame must not be handed a session: the cookie it
    // would receive is this deployment's, and minting one here would make a
    // frame a way in. It is told to log in, in the surface it is displayed in.
    if (!runtimeUiCookie(req, config.sessionCookieName)) {
      sendNotice(res, 401, "请先登录", "请在 EviMed 中登录后重新打开。", { code: "unauthorized", shellOrigin });
      return;
    }
    if (await serveProjectAsset(req, res)) return;

    if (!["GET", "HEAD", "OPTIONS"].includes(String(req.method).toUpperCase())) assertBrowserOrigin(req, config);
    const { user, project, frame, claims } = await resolveFrame(req, res);
    const pathname = new URL(frame.suffix, "http://runtime.local").pathname;
    const hostResult = SEAMS.wire.gatewayEndpoints.hostInteractionResult;
    const method = pathname === `/api/${hostResult}` ? hostResult : runtimeUiMethodFromPath(pathname);
    // Only canonical native API method names enter the policy. Decode solely
    // to detect a disguised /api namespace, never to rewrite or forward it.
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); } catch { throw new HttpError(400, "runtime_ui_endpoint_invalid", "A canonical runtime path is required."); }
    if ((pathname.startsWith("/api/") || decodedPath.startsWith("/api/"))
      && (!method || pathname !== `/api/${method}` || pathname !== decodedPath)) {
      throw new HttpError(400, "runtime_ui_endpoint_invalid", "A canonical native API method is required.");
    }
    // Not every kernel route is a method call. A path outside `/api/` never
    // reaches the method gate below -- it is forwarded, because that is how the
    // application's document, assets and plugin bundles load. 0.1.5 mounted
    // `/open-in-app/{apps,icon,open}` there, and `open` launches an application
    // on the machine running the kernel. Refused by path, here, because there
    // is no method to refuse.
    // Both spellings, for the reason the `/api/` check above decodes: a percent
    // escape is a disguise, and which of the two a downstream normalizer acts
    // on is not ours to assume.
    if (isDeniedRuntimeUiHostRoute(pathname) || isDeniedRuntimeUiHostRoute(decodedPath)) {
      sendDenied(res, pathname);
      return;
    }
    let workspaceBody = null;
    let promptBody = null;
    if (method === "session/prompt" && authorizePrompt) {
      const raw = await readBody(req, config.maxJsonBytes);
      req.__openScienceProxyBody = raw;
      try { promptBody = JSON.parse(raw.toString("utf8")); } catch { /* Rejected below as an invalid native RPC. */ }
      if (promptBody?.type !== "client-request" || promptBody.method !== "session/prompt") {
        throw new HttpError(400, "runtime_ui_prompt_invalid", "A native prompt RPC is required.");
      }
    }
    if (method === "workspace/create" && req.method === "POST") {
      const raw = await readBody(req, Math.min(Number(config.maxJsonBytes), 16384));
      req.__openScienceProxyBody = raw;
      try { workspaceBody = JSON.parse(raw.toString("utf8")); } catch { /* Remains a denied workspace mutation. */ }
    }
    if (method && WORKSPACE_PATH_METHODS.has(method) && req.method === "POST") {
      // The path is in the body, so the body is read here and handed on with
      // the request, as the prompt's is. A call this cannot parse carries no
      // path this can check, and is refused rather than forwarded.
      const raw = await readBody(req, Math.min(Number(config.maxJsonBytes), 16384));
      req.__openScienceProxyBody = raw;
      let fileBody = null;
      try { fileBody = JSON.parse(raw.toString("utf8")); } catch { /* refused below */ }
      const refusal = runtimeUiWorkspacePathRefusal(method, fileBody?.payload, runtimeManager.runtimeWorkspaceRoot(project));
      if (refusal) {
        // The same JSON refusal the deny list gives, not the notice page a
        // thrown error becomes: the caller is the kernel's own file panel,
        // which reads the code and says so in its own words.
        sendDenied(res, `${method} (${refusal})`);
        return;
      }
    }
    const boundWorkspace = method === "workspace/create"
      && isBoundWorkspaceRegistration(workspaceBody, runtimeManager.runtimeWorkspaceRoot(project));
    const snapshot = { url: req.url, headers: { cookie: req.headers.cookie } };
    trackFrame(snapshot, claims, res);
    const revalidate = async () => {
      await resolveFrame(snapshot, null);
      if (boundWorkspace && !isBoundWorkspaceRegistration(workspaceBody, runtimeManager.runtimeWorkspaceRoot(project))) {
        throw new HttpError(403, "runtime_ui_method_denied", "The runtime workspace binding changed.");
      }
    };
    if (pathname === "/__evimed_bootstrap.js" && ["GET", "HEAD"].includes(req.method)) {
      const { installRuntimeUiTransport } = await import("@evimed/harness-port/runtime-ui-transport");
      await revalidate();
      // `operator` releases the rows a researcher's page hides (the assembled
      // system prompt, injected context) to an operator diagnosing a run — the
      // same id allowlist the operations page reads. `off` names the frame
      // bodies this deployment switched off.
      const source = runtimeUiBootstrapSource({
        version: 1, frameId: frame.frameId, projectId: project.id, prefix: frame.prefix, assets: SHARED_UI_ASSET_PREFIX,
        shellOrigin: runtimeUiOrigins(config).shellOrigin, cwd: runtimeManager.runtimeWorkspaceRoot(project),
        capabilities: await heroCapabilities(),
        operator: Array.isArray(config.operatorUsers) && config.operatorUsers.includes(String(user?.id ?? "")),
        off: Array.isArray(config.runtimeUiFrameOff) ? config.runtimeUiFrameOff : [],
      }, installRuntimeUiTransport);
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(Buffer.byteLength(source)), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : source);
      return;
    }
    if (isDeniedRuntimeUiMethod(method) && !boundWorkspace) {
      // Named in the body so the page's own error surface says which one, and
      // named in the audit row by the proxy's target — the panels that call
      // these are hidden, so a call arriving here is worth seeing.
      sendDenied(res, method);
      return;
    }

    // Where a turn begins on this surface. A run started inside the kernel's
    // application never passes through `/api/agent-runs/dispatch`, so a spend
    // cap that only guarded dispatch would be one the primary surface walks
    // around. It is this method and not the runtime's start, because starting
    // a runtime is what reading a transcript also does, and reading your own
    // finished work is not spending.
    await authorizeMethod(config, project, method, boundWorkspace, usageLedger, runtimeManager);
    const forward = () => runtimeManager.proxy(req, res, project, frame.suffix, {
      surface: "ui",
      uiBasePath: frame.prefix,
      revalidate,
      // Build assets and revisioned bundles the document names are served
      // from the path every project shares; a file whose URL names its
      // content is kept by the browser, across sessions and projects.
      uiAssetPrefix: SHARED_UI_ASSET_PREFIX,
      immutable: isImmutableRuntimeUiAsset(frame.suffix),
      // A composer attachment is a file, not an RPC: held to the deployment's
      // file ceiling rather than the JSON one, and forwarded as bytes.
      ...(method === RUNTIME_UI_UPLOAD_METHOD ? { fileBody: true } : {}),
    });
    const forwardPrompt = async () => {
      await authorizePromptSession(project, promptBody?.payload);
      return runtimeManager.pluginService
        ? runtimeManager.pluginService.withAdmission(project, forward, { prompt: true })
        : forward();
    };
    if (method === "session/prompt") {
      if (authorizeMutation) await authorizeMutation(forwardPrompt);
      else await forwardPrompt();
    } else await forward();
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 502;
      const code = error?.code ?? "runtime_ui_failed";
      if (code === "runtime_reserved_for_autopilot") {
        sendNotice(res, status, "项目正忙，请稍后再试", "", { code, shellOrigin });
        return;
      }
      if (code === "agent_background_only") {
        sendNotice(res, status, "请在知识库中处理这份资料", "", { code, shellOrigin });
        return;
      }
      sendNotice(res, status, "对话暂时打不开", noticeDetail(String(code)), { code: String(code), shellOrigin });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    void (async () => {
      try {
        if (!config.runtimeUiProxyEnabled) return destroyUpgrade(socket, 404, "not_found");
        if (!runtimeUiCookie(req, config.sessionCookieName)) return destroyUpgrade(socket, 401, "unauthorized");
        assertBrowserOrigin(req, config);
        const { project, frame, claims } = await resolveFrame(req, null);
        // Revalidation keeps the handshake login; only a validated renewal may replace its ticket.
        const snapshot = { url: req.url, headers: { cookie: req.headers.cookie } };
        trackFrame(snapshot, claims, socket);
        const revalidate = async () => { await resolveFrame(snapshot, null); };
        const authorize = async (endpoint, payload = null) => {
          if (typeof endpoint !== "string" || (endpoint !== "$events" && runtimeUiMethodFromPath(`/api/${endpoint}`) !== endpoint)) {
            throw new HttpError(400, "runtime_ui_endpoint_invalid", "A valid mux endpoint is required.");
          }
          await authorizeMethod(config, project, endpoint, false, usageLedger, runtimeManager);
          assertWorkspacePath(endpoint, payload, runtimeManager.runtimeWorkspaceRoot(project));
          if (endpoint === "session/prompt") {
            // The mux's plugin admission owns the full upstream operation. This
            // short maintenance admission serializes its start with an expiring
            // drain request; the run ledger then keeps accepted work visible.
            const check = async () => authorizePromptSession(project, payload);
            if (authorizeMutation) await authorizeMutation(check);
            else await check();
          }
        };
        await runtimeManager.proxyUpgrade(req, socket, head, project, frame.suffix, { revalidate, authorize });
      } catch (error) {
        destroyUpgrade(socket, error?.status ?? 502, error?.code ?? "runtime_ui_upgrade_failed");
      }
    })();
  });

  return {
    server,
    /**
     * Close one frame's live connections — its multiplexed socket and any
     * request still in flight — and resolve once they have closed, or after
     * `FRAME_RELEASE_WAIT_MS`. Only the caller's own: a frame id never closes
     * another login's connections.
     *
     * The shell releases a frame when it lets that conversation go, and a
     * connection the server still counts holds its runtime's slot
     * (`makeRoomFor`). Closed here, before the release answers, the next
     * project's start finds the slot free — the order the shell now waits for
     * (2026-09-23 UI plan §2.2). The browser closes them as well once the
     * frame leaves the page; this makes the answer mean it has happened.
     * @param {string} frameId @param {string} userId
     * @returns {Promise<number>} how many connections were closed
     */
    async releaseFrame(frameId, userId) {
      const closing = [];
      for (const connection of frameConnections.get(frameId) ?? []) {
        if (connection.claims.userId !== userId) continue;
        const { transport } = connection;
        closing.push(new Promise((resolve) => { transport.once("close", resolve); }));
        transport.destroy();
      }
      if (!closing.length) return 0;
      /** @type {NodeJS.Timeout | undefined} */
      let bound;
      await Promise.race([
        Promise.all(closing),
        new Promise((resolve) => { bound = setTimeout(resolve, FRAME_RELEASE_WAIT_MS); bound.unref(); }),
      ]);
      clearTimeout(bound);
      return closing.length;
    },
    /** Called only after renewal proof, live login, CSRF and project access are validated. */
    refreshFrameBinding(renewed) {
      let updated = 0;
      for (const connection of frameConnections.get(renewed.frameId) ?? []) {
        if (!["frameId", "userId", "projectId", "authSessionHash", "audience"].every((key) => connection.claims[key] === renewed.claims[key])) continue;
        if (renewed.expiresAt <= connection.claims.expiresAt) continue;
        const name = `${RUNTIME_UI_FRAME_COOKIE}=`;
        const preserved = String(connection.snapshot.headers.cookie ?? "").split(";").map((value) => value.trim()).filter((value) => !value.startsWith(name));
        connection.snapshot.headers.cookie = [...preserved, renewed.cookie.split(";")[0]].join("; ");
        connection.claims = renewed.claims;
        updated++;
      }
      return updated;
    },
    /**
     * Bound when the deployment serves this surface, and not otherwise. The
     * switch decides, not the port: a port of 0 means "any free one", which is
     * what a test wants and what a production deployment must never be left
     * with -- readiness refuses that pair rather than binding somewhere nobody
     * can reach.
     */
    async listen(port = config.runtimeUiPort, host = config.host) {
      if (!config.runtimeUiProxyEnabled) return null;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    address() {
      return server.listening ? server.address() : null;
    },
    async close() {
      for (const socket of upgradeSockets) socket.destroy();
      frameConnections.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
