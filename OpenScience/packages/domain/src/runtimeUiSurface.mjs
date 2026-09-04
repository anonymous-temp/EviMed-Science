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
 */
export const RUNTIME_UI_DENIED_NAMESPACES = Object.freeze([
  "settings",
  "credentials",
  "llm",
  "directoryPicker",
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
]);

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
]);

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
