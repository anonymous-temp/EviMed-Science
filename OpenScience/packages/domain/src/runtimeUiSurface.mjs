/**
 * What the kernel's own browser application may reach through the hosted
 * surface, and what it may not.
 *
 * The application is a single-user local product. It ships settings, model,
 * credential, workspace and preset panels because on a laptop the person
 * looking at them owns the machine. Hosted, the person looking at them owns
 * one project inside somebody else's deployment, and the runtime's home
 * directory is a writable volume — so a call it makes is a durable change to
 * the deployment, not a preference. Those panels are hidden in the profile,
 * but hiding a panel hides a button, not a method: the page is JavaScript the
 * browser can call anything from. This list is the part that holds.
 *
 * Derived from a live kernel rather than from a package grep. On 2026-09-04
 * this was probed against a running `@deepseek-ai/dsh@0.1.2-rc.1` booted from
 * the production runtime image, and every method named below answered
 * `gateway/arguments-invalid` or `ok` — that is, it exists and is reachable —
 * **except** the `cordis/` and `agentTeams/`
 * namespaces, which this composition does not export at all (`not found`).
 * Those two are kept as forward bans and are named here as not-yet-real, so
 * nobody later reads this list as uniformly load-bearing: a ban that matches
 * nothing protects nothing, and the way that stays invisible is by not being
 * written down. `settings/describe` is worth singling out — it answered `ok`,
 * so before this list a hosted page could read the deployment's own
 * configuration document.
 *
 * It is a deny list, not an allow list, and that is a deliberate,
 * time-boxed choice. Enumerating what the application legitimately calls means
 * observing it, and no such observation exists yet; an allow list written from
 * a package grep would refuse something real on the first day and read as the
 * product being broken. So the namespaces that can change the deployment are
 * closed now — those are enumerable, from the client packages that exist — and
 * every method that passes is named in the audit row, which is what turns the
 * allow half into observed data instead of a guess. `docs/` records the flip.
 *
 * @module @evimed/domain/runtime-ui-surface
 */

/**
 * Namespaces no hosted browser may enter, whatever the method.
 *
 * Each one is a durable change to the deployment or a way out of the project:
 *
 * - `settings`   the runtime's own configuration document
 * - `credentials`model provider keys — hosted runtimes hold none, and this is
 *                how they would start to
 * - `llm`        provider discovery and configuration; the model a run uses is
 *                certified by the model gateway, not chosen in a page
 * - `directoryPicker` the container's filesystem outside the workspace
 * - `goals`      cross-day scheduling the control plane does not know about
 * - `agentTeams` an execution topology outside the run ledger
 * - `cordis`     dynamic plugin load and retract: arbitrary code into a
 *                running kernel
 * - `messageFeedback` the upstream feedback channel; nothing about a hosted
 *                run leaves this deployment except through the gateways
 *
 * `workspaceFiles` is not here: the kernel's file tree and previews read
 * through it, and the proxy holds its paths to the workspace instead
 * (`runtimeUiWorkspacePathRefusal`).
 */
export const RUNTIME_UI_DENIED_NAMESPACES = Object.freeze([
  "evimedPlugins",
  "settings",
  "credentials",
  "llm",
  "directoryPicker",
  "dynamicCordisRunner",
  "goals",
  "agentTeams",
  // Not exported by the composition the hosted image runs: on 2026-09-04,
  // against a running kernel at 0.1.2-rc.1, every `cordis/*` and
  // `agentTeams/*` name answered `not found`. Kept because both are upstream
  // features that a later
  // composition could mount, and a ban that arrives with the feature is worth
  // more than one written after it ships.
  "cordis",
  "messageFeedback",
  // `sessionFeedback` arrived in 0.1.5 with `fileUploads` and `workspaceFiles`,
  // reachable before anyone had an opinion about it, because this is a deny
  // list and silence is consent. It is `messageFeedback` renamed for the
  // session scope -- the same upstream channel, banned for the same reason.
  //
  // `workspaceFiles` stood beside it until 2026-09-22. It is what the
  // kernel's own file tree and document previews read through, and refusing
  // it wholesale is what took the preview away (「预览也没了」). Its `list`
  // confines the path to the workspace; `read`, `readAll`, `readBytes`,
  // `stat` and `readRelated` resolve it with the workspace as cwd and never
  // confine it ("files outside it are allowed", upstream's own words). So the
  // namespace is open and those five methods are held to the workspace by
  // the proxy instead (`runtimeUiWorkspacePathRefusal`) -- the same shape as
  // the upload route, whose size the proxy holds.
  //
  // `fileUploads` was the third until 2026-09-22 and is the composer's
  // paperclip: a file attached to a message. It writes nowhere a browser can
  // name -- the bytes go to the attachment store under `DSH_HOME` (the
  // project's own data volume, so they count against its quota and leave with
  // it), content-addressed, and the message carries the reference -- which is
  // the ledger a chat attachment needs. The knowledge base stays the intake for
  // material a whole project should cite. Refusing it left the one surface
  // where researchers type with no way to hand over a file (2026-09-22,
  // 「文件上传不了」). The raw route's size is held by the proxy
  // (`maxFileBytes`), not here.
  "sessionFeedback",
]);

/**
 * The file-reading methods whose `path` the kernel resolves against the
 * workspace but never confines to it. The proxy refuses a call whose path
 * would leave the workspace before it reaches the kernel; `list` confines
 * itself upstream and is held here too, so the rule reads the same for the
 * whole namespace.
 */
export const RUNTIME_UI_WORKSPACE_PATH_METHODS = Object.freeze([
  "workspaceFiles/list",
  "workspaceFiles/read",
  "workspaceFiles/readAll",
  "workspaceFiles/readBytes",
  "workspaceFiles/readRelated",
  "workspaceFiles/stat",
]);

const workspacePathMethods = new Set(RUNTIME_UI_WORKSPACE_PATH_METHODS);

/** A path segment that would climb: `..`, in any of the spellings a resolver reads. */
const CLIMBING_SEGMENT = /^(?:\.\.|%2e%2e|%2e\.|\.%2e)$/i;

/**
 * Whether a path the browser named stays inside the workspace root the
 * runtime was started with.
 *
 * Absolute paths must be the root or under it; relative ones are resolved by
 * the kernel against that root, so they only have to avoid climbing. A
 * backslash is refused outright: no path in this container is spelt with
 * one, and a resolver that treated it as a separator would read a different
 * file from the one this checked.
 *
 * @param {unknown} value
 * @param {string} workspaceRoot an absolute path, as the runtime reports it
 * @param {{ relativeOnly?: boolean }} [options] `readRelated`'s second path is
 *   documented relative to the first, so an absolute one there is a disguise
 * @returns {boolean}
 */
export function isRuntimeUiWorkspacePath(value, workspaceRoot, { relativeOnly = false } = {}) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || value.includes("\\")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => CLIMBING_SEGMENT.test(segment))) return false;
  if (!value.startsWith("/")) return true;
  if (relativeOnly) return false;
  const root = typeof workspaceRoot === "string" && workspaceRoot.startsWith("/") ? workspaceRoot.replace(/\/+$/, "") : "";
  if (!root) return false;
  return value === root || value.startsWith(`${root}/`);
}

/**
 * Why a workspace-file call must not be forwarded, or `null` when it may.
 *
 * `payload` is the native RPC's payload on either transport
 * (`{ args: { workspaceFileScopeId, path, ... } }`); a call that does not
 * carry its path in that shape is refused rather than guessed at.
 *
 * @param {string | null | undefined} method
 * @param {unknown} payload
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
export function runtimeUiWorkspacePathRefusal(method, payload, workspaceRoot) {
  if (!method || !workspacePathMethods.has(String(method))) return null;
  const args = payload && typeof payload === "object" && !Array.isArray(payload) ? /** @type {any} */ (payload).args : null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "a workspace-file call must carry its arguments";
  if (!isRuntimeUiWorkspacePath(args.path, workspaceRoot)) return "the path is outside this project's workspace";
  if (method === "workspaceFiles/readRelated" && !isRuntimeUiWorkspacePath(args.relativePath, workspaceRoot, { relativeOnly: true })) {
    return "the related path is outside this project's workspace";
  }
  return null;
}

/**
 * Methods denied one by one, inside namespaces that are otherwise the product.
 *
 * `session/` and `agentPresets/` carry the conversation the product is made of,
 * so they cannot be closed wholesale; these are the members that would step
 * outside the composition or the project.
 */
export const RUNTIME_UI_DENIED_METHODS = Object.freeze([
  // Swapping the agent preset swaps the composition every gate assumes.
  "agentPresets/select",
  "agentPresets/copy",
  "agentPresets/deletePreset",
  // The model is certified per release by the model gateway. A page that
  // chooses one would produce runs whose receipt names a different model.
  "session/selectModel",
  "session/modelCatalog",
  // Opening a workspace path is a host integration: it asks the machine
  // running the kernel to reveal or open a directory.
  "session/openWorkspacePath",
  "session/canOpenWorkspacePath",
  // A project is the isolation unit and it is created by the control plane.
  // These would make, rename and destroy them behind its back.
  "workspace/create",
  "workspace/delete",
  "workspace/rename",
  "workspace/archiveSession",
  "workspace/insertBefore",
  "workspace/insertSessionBefore",
  // `session/uploadFileBinary` stood here until 2026-09-22: the raw-byte half
  // of `fileUploads` (see the namespace list), open again with it.
]);

/**
 * Kernel HTTP routes that are not method calls, and are refused by path.
 *
 * Everything above this classifies `/api/<namespace>/<method>`. That is not the
 * whole surface: a plugin may register any route on the composition's web
 * server, and one that does not start with `/api/` never reaches the method
 * gate at all -- it is forwarded, because that is how the application's own
 * document, assets and plugin bundles load.
 *
 * 0.1.5 is where that stopped being theoretical. `@deepseek-ai/dsh-host-open-in-app`
 * mounts three routes under `/open-in-app/`, and the last of them launches a
 * locally installed application on the machine running the kernel -- which
 * here is the runtime container, from a page in someone's browser.
 *
 * A prefix list and not an allow list, for the same time-boxed reason the
 * method side is a deny list: the legitimate non-API traffic is the web
 * application's own assets, nobody has observed that set, and an allow list
 * written from a guess refuses the product on its first day. What is
 * enumerable today is the routes that are not assets, and this is them.
 *
 * The composition answers this one too -- the hosted profile disables the
 * `open-in-app` row, and a probe against a kernel booted that way gets 404
 * where an unpatched one gets 401. Both halves are kept: the row disable is
 * what removes the capability, and this is what holds if a later composition
 * mounts it again.
 */
export const RUNTIME_UI_DENIED_HOST_ROUTES = Object.freeze([
  "/open-in-app/",
]);

/**
 * Whether the hosted surface refuses this path outright, before any method
 * question is asked.
 *
 * @param {string | null | undefined} pathname
 * @returns {boolean}
 */
export function isDeniedRuntimeUiHostRoute(pathname) {
  const clean = String(pathname ?? "").split("?")[0];
  return RUNTIME_UI_DENIED_HOST_ROUTES.some((prefix) => clean === prefix.replace(/\/$/, "") || clean.startsWith(prefix));
}

const deniedNamespaces = new Set(RUNTIME_UI_DENIED_NAMESPACES);
const deniedMethods = new Set(RUNTIME_UI_DENIED_METHODS);

/** A kernel endpoint name: exactly two slash-separated segments (0.1.2). */
const ENDPOINT_NAME = /^[a-zA-Z][a-zA-Z0-9-]*\/[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * The kernel method a proxied request would invoke, or `null` if the request
 * is not a method call at all (the document, an asset, the socket).
 *
 * The application calls a method by posting to `/api/<namespace>/<name>`, so
 * the path is the method. Nothing here reads the body: a body that disagreed
 * with the path would be a second answer to the same question, and the kernel
 * routes on the path.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function runtimeUiMethodFromPath(pathname) {
  const clean = String(pathname ?? "").split("?")[0];
  if (!clean.startsWith("/api/")) return null;
  const method = clean.slice("/api/".length).replace(/\/+$/, "");
  if (!ENDPOINT_NAME.test(method)) return null;
  return method;
}

/**
 * Whether the hosted surface refuses this method.
 *
 * @param {string | null | undefined} method
 * @returns {boolean}
 */
export function isDeniedRuntimeUiMethod(method) {
  if (!method) return false;
  const name = String(method);
  if (deniedMethods.has(name)) return true;
  return deniedNamespaces.has(name.split("/")[0]);
}
