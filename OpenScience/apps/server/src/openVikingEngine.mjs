import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILLS_ROOT, OPENVIKING_SKILL_NAMES, skillUri,
} from "./openVikingLayout.mjs";

/**
 * What must be true of the OpenViking engine before anything built on it can work, read off the running service.
 *
 * Hidden knowledge: every one of these fails silently upstream.
 *
 *  - A server of another version starts healthy on the same configuration (from v0.4.22 an unknown key only warns),
 *    and the routes the knowledge and memory modules call simply answer 404.
 *  - A memory-template directory that is not mounted where `memory.custom_templates_dir` points makes the server fall
 *    back to its built-in types without a word; the type allowlist then names types that do not exist, and what it
 *    extracts is upstream's policy — which copies quoted messages into memory files — not ours.
 *  - `GET /compile/capabilities` says `can_create: true` from configuration alone. A Compile runtime that does not
 *    receive the caller's identity accepts a submission and fails it afterwards (v0.5.0 behind no shim: 401 from the
 *    bot), so the one proof is a real submission.
 *  - A skill that was never installed is a compile that fails at `loading_skill`; one whose bytes differ from the pin
 *    is a compile that follows instructions nobody reviewed.
 *
 * So the control plane asks. Each fact is one cheap, no-spend exchange with the engine, the answers are kept and
 * reported under `memoryIndex.engine` in `/api/ready`, and the two modules built on the engine ask `ready(feature)`
 * before they depend on it. A failed fact degrades the feature it belongs to and is named; it never fails readiness
 * and never touches a conversation (root `CLAUDE.md`, principle 18: an optional memory or knowledge service being
 * down returns a status and the conversation continues).
 *
 * The one write this makes: a skill that is missing is installed from the pinned bytes this repository ships
 * (`openVikingSkills/`), as the engine's install identity. A skill that is present with other bytes is reported and
 * left alone — replacing it is an operator's decision, because somebody put it there.
 *
 * Build to delete: the template fact goes if upstream ever reports the loaded template directory in `/health`. (The
 * shim fact that stood beside it went with the identity shim, on the pin that moved to v0.5.1.1, whose Compile
 * forwards identity itself.)
 *
 * @module openVikingEngine
 */

/** The facts, in the order they are read. Their names are the keys of `memoryIndex.engine.facts` in `/api/ready`. */
export const OPENVIKING_ENGINE_FACTS = Object.freeze(["version", "modelKey", "memoryTemplates", "skills", "compileIdentity"]);

/** Which facts each feature built on the engine needs. `ready(feature)` answers from these. */
export const OPENVIKING_ENGINE_FEATURES = Object.freeze({
  /** Sessions, the engine's own extraction, the memory plugin (`OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED`). */
  nativeMemory: Object.freeze(["version", "modelKey", "memoryTemplates"]),
  /** Resources, Compile, the wiki and the graph (`OPEN_SCIENCE_OV_KNOWLEDGE_ENABLED`). */
  knowledge: Object.freeze(["version", "modelKey", "skills", "compileIdentity"]),
});

/**
 * The identity the control plane installs skills and probes as. Not a person and not derivable from one: every
 * account's engine id is `u-<24 hex>` (`openVikingUserId`), which this can never equal.
 */
export const OPENVIKING_ENGINE_USER = "evimed-engine";

/**
 * The Compile probe's whole footprint: an empty directory to read from and a directory it would write to, both under
 * the engine identity's own root. The compile fails on "no files" before any model is called, so nothing is written
 * to the second and no money is spent.
 */
const COMPILE_PROBE_ROOT = `viking://user/${OPENVIKING_ENGINE_USER}/resources/evimed-compile-probe`;
/** How long the probe waits for its submission to end. The server looks at its Compile runtime every 30 s, so an
 *  empty compile that the bot fails at once is still seen as failed up to about 31 s after it was submitted. */
const COMPILE_PROBE_WAIT_MS = 75_000;
const COMPILE_PROBE_POLL_MS = 1_000;

const sha256 = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const codeOf = (/** @type {any} */ error) => (typeof error?.code === "string" && error.code ? error.code : "memory_index_unavailable");
// Not unref'd: this wait is awaited, and a process whose only pending work is an unref'd timer ends in the middle of it.
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/**
 * Whether an admin route refused because the account or the user is not in the engine's registry yet. In trusted mode
 * identities are registered in batches, up to five minutes after their first data request, and until then every admin
 * route answers 404 about the account — on a new volume, that is the first minutes after the first start.
 */
const notRegisteredYet = (/** @type {any} */ error) => error?.upstreamStatus === 404 && ["account", "user"].includes(String(error?.upstreamDetails?.type ?? ""));

/** @typedef {{ ok: boolean, code?: string, [detail: string]: unknown }} EngineFact */

/** The pinned bytes of one official skill, as this repository ships them. @param {string} name */
export async function readPinnedSkill(name) {
  return readFile(new URL(`./openVikingSkills/${name}.skill.md`, import.meta.url), "utf8");
}

export class OpenVikingEngine {
  /**
   * @param {{ client: any, config: Record<string, any>, pin: any, readSkill?: (name: string) => Promise<string>,
   *   now?: () => Date, wait?: (ms: number) => Promise<unknown>, report?: (line: string) => void }} dependencies
   *   `pin` is `deps-version.json`'s `openviking` entry; `client` an `OpenVikingClient`.
   */
  constructor({ client, config, pin, readSkill = readPinnedSkill, now = () => new Date(), wait = sleep, report = () => {} }) {
    this.client = client;
    this.config = config ?? {};
    this.pin = pin ?? {};
    this.readSkill = readSkill;
    this.now = now;
    this.wait = wait;
    this.report = report;
    /** @type {{ checkedAt: string, facts: Record<string, EngineFact> } | null} */
    this.last = null;
    /** Observable counters (principle 15). */
    this.counters = { checks: 0, failedChecks: 0, skillInstalls: 0, compileProbes: 0 };
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<unknown> | null} */
    this.running = null;
  }

  /** Whether there is an engine to ask at all. */
  get applicable() {
    return Boolean(this.client?.configured);
  }

  /** Read every fact once, now. Never throws: a fact that could not be read is a failed fact with the reason. */
  async check() {
    if (this.running) return this.running;
    this.running = this.#check().finally(() => { this.running = null; });
    return this.running;
  }

  async #check() {
    /** @type {Record<string, EngineFact>} */
    const facts = {};
    const read = async (/** @type {string} */ name, /** @type {() => Promise<EngineFact>} */ fn) => {
      try {
        facts[name] = await fn();
      } catch (error) {
        facts[name] = { ok: false, code: codeOf(error) };
      }
    };
    await read("version", () => this.#version());
    await read("modelKey", async () => this.#modelKey());
    // With no answer on /health nothing below can be read; say that once per fact rather than time out four times.
    if (facts.version.code && /^memory_index_(?:unavailable|timeout|url_|auth)|_api_key_/.test(facts.version.code)) {
      for (const name of ["memoryTemplates", "skills", "compileIdentity"]) facts[name] = { ok: false, code: facts.version.code };
    } else {
      await read("memoryTemplates", () => this.#memoryTemplates());
      await read("skills", () => this.#skills());
      // The probe names an installed skill as its source, so it is only meaningful once the skills are there.
      if (facts.skills.ok) await read("compileIdentity", () => this.#compileIdentity());
      else facts.compileIdentity = { ok: false, code: "openviking_compile_unprobed" };
    }
    this.last = { checkedAt: this.now().toISOString(), facts };
    this.counters.checks += 1;
    const failed = OPENVIKING_ENGINE_FACTS.filter((name) => !facts[name]?.ok);
    if (failed.length) {
      this.counters.failedChecks += 1;
      this.report(`openviking engine check: ${failed.map((name) => `${name}=${facts[name]?.code ?? "failed"}`).join(" ")}`);
    }
    return this.status();
  }

  /** The pinned release is the one answering. */
  async #version() {
    const status = await this.client.status();
    const expected = `v${this.pin.version}`;
    if (!status.connected) return { ok: false, code: status.code ?? "memory_index_unavailable", expected };
    return status.version === expected
      ? { ok: true, version: status.version }
      : { ok: false, code: "openviking_version_mismatch", expected, version: status.version ?? null };
  }

  /** The bearer the engine's own model calls arrive with is loaded here; without it every one of them is refused. */
  #modelKey() {
    if (this.config.openVikingModelKeyError) return { ok: false, code: String(this.config.openVikingModelKeyError) };
    return this.config.openVikingModelKey ? { ok: true } : { ok: false, code: "openviking_model_key_missing" };
  }

  /**
   * The template directory is in effect and the allowlist is the deployment's.
   *
   * Two readings, because they fail apart. The types this deployment adds exist in the server's registry only when the
   * directory was loaded: asking for one answers 400 `not editable` when it is there and 404 when it is not. And the
   * allowlist is what a registered user's settings read back: without `server.user_config_defaults` that list is every
   * registered type, upstream's included.
   */
  async #memoryTemplates() {
    const account = this.client.account;
    const missing = [];
    for (const type of OPENVIKING_MEMORY_TYPES) {
      try {
        await this.client.request({ path: `/api/v1/admin/accounts/${account}/memory-templates/${type}`, openVikingUser: OPENVIKING_ENGINE_USER });
      } catch (error) {
        if (notRegisteredYet(error)) return { ok: false, code: "openviking_registration_pending" };
        if (/** @type {any} */ (error)?.upstreamStatus === 404) missing.push(type);
        else if (/** @type {any} */ (error)?.upstreamStatus !== 400) throw error;
      }
    }
    if (missing.length) return { ok: false, code: "openviking_memory_templates_missing", missing };
    try {
      await this.#registerEngineUser();
    } catch (error) {
      if (notRegisteredYet(error)) return { ok: false, code: "openviking_registration_pending" };
      throw error;
    }
    const settings = await this.client.request({
      path: `/api/v1/admin/accounts/${account}/users/${OPENVIKING_ENGINE_USER}/settings`, openVikingUser: OPENVIKING_ENGINE_USER,
    });
    const types = Array.isArray(settings?.result?.memory_policy?.memory_types) ? [...settings.result.memory_policy.memory_types].sort() : [];
    const expected = [...OPENVIKING_MEMORY_TYPES].sort();
    return types.length === expected.length && types.every((type, index) => type === expected[index])
      ? { ok: true, types }
      : { ok: false, code: "openviking_memory_types_mismatch", types };
  }

  /** The admin routes do not know a trusted user until it is registered; a second registration answers 409. */
  async #registerEngineUser() {
    try {
      await this.client.request({
        method: "POST", path: `/api/v1/admin/accounts/${this.client.account}/users`, openVikingUser: OPENVIKING_ENGINE_USER,
        body: { user_id: OPENVIKING_ENGINE_USER, role: "user" },
      });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "memory_index_conflict") throw error;
    }
  }

  /** The stored bytes of one installed skill, or null when it is not installed. @param {string} name */
  async #installedSkillDigest(name) {
    try {
      const file = await this.client.request({
        path: "/api/v1/content/download", query: { uri: `${skillUri(name)}/SKILL.md` }, openVikingUser: OPENVIKING_ENGINE_USER, responseType: "bytes",
      });
      return sha256(file.bytes);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /**
   * The two official skills are installed with the pinned bytes; one that is missing is installed here.
   *
   * Two digests per skill, because the server rewrites what it stores (it re-wraps the frontmatter `description` and
   * drops the final newline): the upstream file's, which the shipped copy is held to, and the installed file's, which
   * this compares with.
   */
  async #skills() {
    /** @type {Record<string, { state: string, sha256?: string }>} */
    const skills = {};
    let ok = true;
    let code = "";
    for (const name of OPENVIKING_SKILL_NAMES) {
      const pinned = String(this.pin.skills?.[name]?.installedSha256 ?? "");
      let installed = await this.#installedSkillDigest(name);
      let state = "installed";
      if (installed == null) {
        const text = await this.readSkill(name);
        if (sha256(text) !== String(this.pin.skills?.[name]?.upstreamSha256 ?? "")) {
          skills[name] = { state: "source-drifted" };
          ok = false; code ||= "openviking_skill_source_drifted";
          continue;
        }
        await this.client.request({
          method: "POST", path: "/api/v1/skills", openVikingUser: OPENVIKING_ENGINE_USER,
          body: { data: text, target_uri: OPENVIKING_SKILLS_ROOT, wait: true }, timeoutMs: 60_000,
        });
        this.counters.skillInstalls += 1;
        installed = await this.#installedSkillDigest(name);
        state = "installed-now";
      }
      if (installed == null) { skills[name] = { state: "missing" }; ok = false; code ||= "openviking_skill_missing"; continue; }
      if (installed !== pinned) { skills[name] = { state: "drifted", sha256: installed }; ok = false; code ||= "openviking_skill_drifted"; continue; }
      skills[name] = { state, sha256: installed };
    }
    return ok ? { ok: true, skills } : { ok: false, code, skills };
  }

  /**
   * Compile is configured and runs as the caller, asked through the path a real compile takes.
   *
   * Two readings, because they fail apart. `GET /compile/capabilities` says whether the server has a Compile runtime
   * at all (`configured`, `can_create`). It says so from configuration alone, so it proves nothing about what the
   * runtime does with a request: the second reading is one real submission whose source is an empty directory. The
   * server forwards the caller's account and user to the bot, which lists the directory as that user and ends the
   * task with "Compile sources contain no files" before any model is called — measured on v0.5.1.1, in about 31 s
   * because the server looks at the bot every 30 s. A runtime that did not receive the identity ends it with a
   * refusal of its own instead (what v0.5.0 did without the shim). Each probe leaves one failed task record, which the
   * engine keeps for seven days — the reason this is read on a slow cadence and not on every readiness request.
   */
  async #compileIdentity() {
    this.counters.compileProbes += 1;
    const capabilities = (await this.client.request({ path: "/api/v1/compile/capabilities", openVikingUser: OPENVIKING_ENGINE_USER }))?.result ?? {};
    if (capabilities.configured !== true || capabilities.can_create !== true) {
      return { ok: false, code: "openviking_compile_unconfigured", reason: String(capabilities.reason_code ?? "").slice(0, 120) };
    }
    const sources = `${COMPILE_PROBE_ROOT}/sources`;
    try {
      await this.client.request({ method: "POST", path: "/api/v1/fs/mkdir", openVikingUser: OPENVIKING_ENGINE_USER, body: { uri: sources } });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "memory_index_conflict") throw error;
    }
    let submitted;
    try {
      submitted = await this.client.request({
        method: "POST", path: "/api/v1/compile", openVikingUser: OPENVIKING_ENGINE_USER,
        idempotencyKey: `evimed-compile-probe-${randomBytes(12).toString("hex")}`,
        body: { from: [sources], to: `${COMPILE_PROBE_ROOT}/wiki`, skill: skillUri(OPENVIKING_SKILL_NAMES[0]) },
      });
    } catch (error) {
      // 503 UNAVAILABLE at submission is the server saying it has no Compile runtime at all.
      if (/** @type {any} */ (error)?.upstreamStatus === 503 && /** @type {any} */ (error)?.upstreamCode === "UNAVAILABLE") {
        return { ok: false, code: "openviking_compile_unconfigured", reason: "UNAVAILABLE" };
      }
      throw error;
    }
    const taskId = String(submitted?.result?.task_id ?? "");
    if (!taskId) return { ok: false, code: "openviking_compile_probe_unreadable" };
    for (let waited = 0; waited <= COMPILE_PROBE_WAIT_MS; waited += COMPILE_PROBE_POLL_MS) {
      const task = (await this.client.request({ path: `/api/v1/tasks/${taskId}`, openVikingUser: OPENVIKING_ENGINE_USER }))?.result ?? {};
      if (task.status === "failed") {
        return /no files/i.test(String(task.error ?? ""))
          ? { ok: true }
          : { ok: false, code: "openviking_compile_probe_unexpected", reason: String(task.error ?? "").slice(0, 200) };
      }
      // An empty source that is accepted and runs on means the runtime no longer ends it at once: stop it, and say so.
      if (task.status === "completed" || /^compile: (?:agent|writing)/.test(String(task.stage ?? ""))) {
        await this.client.request({ method: "POST", path: `/api/v1/tasks/${taskId}/cancel`, openVikingUser: OPENVIKING_ENGINE_USER }).catch(() => {});
        return { ok: false, code: "openviking_compile_probe_unexpected", reason: `the probe ${task.status === "completed" ? "completed" : "ran"} on an empty source` };
      }
      await this.wait(COMPILE_PROBE_POLL_MS);
    }
    return { ok: false, code: "openviking_compile_probe_unexpected", reason: "the probe did not end" };
  }

  /**
   * What readiness reports (`memoryIndex.engine`): when the facts were last read, each fact, and which features a
   * failed fact degrades. Before the first read every fact is `openviking_engine_unchecked`.
   */
  status() {
    const facts = Object.fromEntries(OPENVIKING_ENGINE_FACTS.map((name) => [
      name, this.last?.facts[name] ?? { ok: false, code: "openviking_engine_unchecked" },
    ]));
    const degraded = Object.keys(OPENVIKING_ENGINE_FEATURES).filter((feature) => !this.ready(feature).ok);
    return { checkedAt: this.last?.checkedAt ?? null, ok: degraded.length === 0, facts, degraded, counters: { ...this.counters } };
  }

  /**
   * Whether a feature built on the engine can be relied on now, and the first fact that says it cannot.
   * @param {keyof typeof OPENVIKING_ENGINE_FEATURES | string} feature
   * @returns {{ ok: boolean, code: string | null, fact: string | null }}
   */
  ready(feature) {
    const needed = /** @type {Record<string, readonly string[]>} */ (OPENVIKING_ENGINE_FEATURES)[feature];
    if (!needed) return { ok: false, code: "openviking_feature_unknown", fact: null };
    for (const name of needed) {
      const fact = this.last?.facts[name];
      if (!fact?.ok) return { ok: false, code: String(fact?.code ?? "openviking_engine_unchecked"), fact: name };
    }
    return { ok: true, code: null, fact: null };
  }

  /** Read the facts now and again every `openVikingEngineCheckMs`; a failed read is retried sooner. */
  start() {
    if (this.timer || !this.applicable) return;
    const every = Math.max(60_000, Number(this.config.openVikingEngineCheckMs) || 1_800_000);
    let since = 0;
    const tick = () => {
      since += 60_000;
      // While something is failing the check runs every five minutes, so a restarted engine is noticed without a
      // deploy; a healthy engine is asked on the configured cadence.
      if (since >= (this.last && this.status().ok ? every : Math.min(every, 300_000))) {
        since = 0;
        void this.check();
      }
    };
    void this.check();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
