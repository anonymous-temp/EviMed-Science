import { createHash, createHmac } from "node:crypto";

/**
 * Where things are in the OpenViking engine: the paths inside its container and
 * the `viking://` roots every module of ours addresses.
 *
 * Hidden knowledge: these values are written in four places that cannot import
 * each other — the compose file (mounts, the entrypoint, the health check), the
 * rendered `ov.conf` (`scripts/ops/configure-production-state.mjs`), the control
 * plane's startup self-check and the two modules built on the client (resources
 * and sessions). A path that differed in one of them is the silent kind of
 * failure: a template directory mounted where the server does not look makes it
 * fall back to its built-in memory types without a word, and the type allowlist
 * then names types that do not exist. So each value is stated once here, the
 * renderer and the self-check import it, and `openVikingDeploy.test.mjs` holds
 * the compose file to it.
 *
 * Dependency-free on purpose: the renderer runs on a host before anything is
 * installed into a container.
 *
 * @module openVikingLayout
 */

/** `memory.custom_templates_dir`: the eight memory types' templates, mounted read-only. */
export const OPENVIKING_MEMORY_TEMPLATES_DIR = "/app/memory-templates";

/**
 * The memory types a user's settings read back, and the file names (`<type>.yaml`)
 * of `deploy/web/openviking/memory-templates/`. Upstream's `identity`, `soul`,
 * `events`, `cases`, `trajectories`, `experiences`, `tools` and `skills` are left
 * out deliberately: `events` copies the quoted messages verbatim into the memory
 * file, which is how a phone number reached a memory in the control arm
 * (lab/memory/RESULTS.md, part 二).
 */
export const OPENVIKING_MEMORY_TYPES = Object.freeze([
  "profile", "preferences", "entities", "corrections", "project_context", "decisions", "follow_ups", "project_facts",
]);

/** The identity shim the entrypoint starts beside the server, and the loopback port `compile_api.base_url` names. */
export const OPENVIKING_SHIM_PATH = "/opt/evimed-shim/identity_shim.py";
export const OPENVIKING_SHIM_PORT = 18791;
/** The entrypoint wrapper: the shim, then the image's own entrypoint as PID 1. */
export const OPENVIKING_ENTRYPOINT_PATH = "/opt/evimed-shim/entrypoint.sh";

/** Where the account-shared skills are installed; a compile names one as `<root>/<name>`. */
export const OPENVIKING_SKILLS_ROOT = "viking://agent/skills";

/** The two official skills this deployment installs and pins (`deps-version.json` `openviking.skills`). */
export const OPENVIKING_SKILL_NAMES = Object.freeze(["llm-wiki", "knowledge-graph"]);

// A single path segment per identity, and no user id in a stored path. The
// service is one more place a support engineer may read a directory listing;
// the memo namespace has hashed for the same reason since it was introduced.
// It is also what reaches the model provider: an extraction prompt lists the
// user's existing memory URIs, so this id must stay an opaque hash and never
// become an account name or an e-mail address.
function scopedId(prefix, value, purpose) {
  const digest = createHash("sha256").update(`evimed/openviking/${purpose}/v1:${value}`).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

/** The account is one tenant for the whole deployment; users divide it. */
export function openVikingUserId(userId) {
  return scopedId("u", String(userId ?? ""), "user");
}

/** A project's segment inside one user: the recall index's peer and the `p/<pidHash>` of the resources layout. */
export function openVikingPeerId(projectId) {
  return scopedId("p", String(projectId ?? ""), "peer");
}

/** A capsule's segment (`capsuleSegment` in the client validates its inputs). */
export function openVikingScopedId(prefix, value, purpose) {
  return scopedId(prefix, value, purpose);
}

/** Everything one account holds in the engine. */
export function userRootUri(userId) {
  return `viking://user/${openVikingUserId(userId)}`;
}

/** The engine's own memory tree of one account (native memory): `…/memories/<type>/…`. The derived recall index of the
 *  records PostgreSQL holds lives beside it, under `…/memories/evimed/` (`userMemoryRoot` in the client). */
export function nativeMemoryRoot(userId) {
  return `${userRootUri(userId)}/memories`;
}

/** The documents an account pushed, and what was compiled from them. */
export function resourcesRoot(userId) {
  return `${userRootUri(userId)}/resources`;
}

/** The account's cross-project library: `<srcId>.md` files, a compile source beside a project's own. */
export function libraryResourcesUri(userId) {
  return `${resourcesRoot(userId)}/library`;
}

/** One project's subtree: `sources/` (what the control plane pushed), `wiki/` (the `llm-wiki` target), `kg/` (the
 *  `knowledge-graph` target). Every find, grep and compile over a project names one of these explicitly — a `find`
 *  with no target searches everything the user can see. */
export function projectResourcesRoot(userId, projectId) {
  return `${resourcesRoot(userId)}/p/${openVikingPeerId(projectId)}`;
}

/** @param {string} userId @param {string} projectId */
export function projectSourcesUri(userId, projectId) {
  return `${projectResourcesRoot(userId, projectId)}/sources`;
}

/** @param {string} userId @param {string} projectId */
export function projectWikiUri(userId, projectId) {
  return `${projectResourcesRoot(userId, projectId)}/wiki`;
}

/** @param {string} userId @param {string} projectId */
export function projectGraphUri(userId, projectId) {
  return `${projectResourcesRoot(userId, projectId)}/kg`;
}

/** @param {string} name one of `OPENVIKING_SKILL_NAMES` */
export function skillUri(name) {
  return `${OPENVIKING_SKILLS_ROOT}/${name}`;
}

/**
 * The second bearer of the engine's model path: the one its Compile agent (`bot.agents.api_key`) calls the model
 * gateway with, derived from the service key the rest of the engine (`vlm.api_key`: extraction and summaries) uses.
 *
 * Nothing in an engine model request says what it is for, so the purpose a call is booked under can only come from
 * which credential it carries. One key file, two bearers: the renderer writes both into `ov.conf`, the gateway
 * recomputes this one, and a deployment has one secret to generate, mount and rotate.
 * @param {string} serviceKey the content of `OPEN_SCIENCE_OPENVIKING_MODEL_KEY_FILE`
 */
export function openVikingKnowledgeModelKey(serviceKey) {
  return createHmac("sha256", String(serviceKey)).update("evimed/openviking/model-key/knowledge/v1").digest("base64url");
}
